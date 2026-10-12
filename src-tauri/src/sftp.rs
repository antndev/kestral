
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use russh::client;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::error::{AppError, Result};
use crate::model::Host;
use crate::ssh::{ClientHandler, SshManager};
use crate::vault::Vault;

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: Option<i64>,
    pub permissions: Option<u32>,
    pub hidden: bool,
}

fn ferr<E: std::fmt::Display>(ctx: &str, e: E) -> AppError {
    AppError::Ssh(format!("SFTP {ctx}: {e}"))
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

fn is_safe_component(name: &str) -> bool {
    let mut comps = Path::new(name).components();
    let single = matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    );
    single && (!cfg!(windows) || windows_safe(name))
}

fn windows_safe(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    !reserved
        && !name.ends_with(['.', ' '])
        && !name.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c))
}

#[cfg(unix)]
fn local_mode(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode() & 0o777)
}

#[cfg(not(unix))]
fn local_mode(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

async fn open_subsystem(session: &client::Handle<ClientHandler>) -> Result<SftpSession> {
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| ferr("channel", e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| ferr("Subsystem", e))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| ferr("Init", e))
}

async fn list(sftp: &SftpSession, path: &str) -> Result<Vec<FileEntry>> {
    let dir = sftp.read_dir(path).await.map_err(|e| ferr("read_dir", e))?;
    let mut out = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            continue;
        }
        let meta = entry.metadata();
        let hidden = name.starts_with('.');
        out.push(FileEntry {
            path: join(path, &name),
            name,
            is_dir: meta.is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.map(|m| m as i64),
            permissions: meta.permissions,
            hidden,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

pub(crate) const MAX_AI_DOWNLOAD: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct Xfer {
    pub done: Arc<AtomicU64>,
    pub cancel: CancellationToken,
    pub limit: Option<u64>,
}

impl Xfer {
    pub fn limited(limit: u64) -> Self {
        Self { limit: Some(limit), ..Default::default() }
    }
}

fn cancelled() -> AppError {
    AppError::Other("Cancelled".into())
}

fn part_name(name: &str) -> String {
    format!(".{}.{}.part", &name[..name.floor_char_boundary(64)], uuid::Uuid::new_v4().simple())
}

fn remote_part(path: &str) -> String {
    match path.rsplit_once('/') {
        Some((dir, name)) => format!("{dir}/{}", part_name(name)),
        None => part_name(path),
    }
}

struct Part {
    tmp: String,
    target: String,
    permissions: Option<u32>,
}

async fn create_part(
    sftp: &SftpSession,
    path: &str,
    source_mode: Option<u32>,
) -> Result<(russh_sftp::client::fs::File, Option<Part>)> {
    let mut target = path.to_string();
    let mut existing = sftp.symlink_metadata(path).await.ok();
    if existing.as_ref().is_some_and(|m| m.file_type().is_symlink()) {
        if let Ok(real) = sftp.canonicalize(path).await {
            existing = sftp.metadata(real.as_str()).await.ok();
            target = real;
        }
    }
    let tmp = remote_part(&target);
    let permissions = existing.and_then(|m| m.permissions).or(source_mode);
    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
    if permissions.is_some() {
        attrs.permissions = Some(0o600);
    }
    let flags = russh_sftp::protocol::OpenFlags::CREATE
        | russh_sftp::protocol::OpenFlags::TRUNCATE
        | russh_sftp::protocol::OpenFlags::WRITE;
    match sftp.open_with_flags_and_attributes(tmp.as_str(), flags, attrs).await {
        Ok(f) => Ok((f, Some(Part { tmp, target, permissions }))),
        Err(_) => {
            let f = sftp.create(path).await.map_err(|e| ferr("create", e))?;
            Ok((f, None))
        }
    }
}

async fn finish_part(sftp: &SftpSession, part: Option<Part>, result: Result<u64>) -> Result<u64> {
    let Some(part) = part else {
        return result;
    };
    let n = match result {
        Ok(n) => n,
        Err(e) => {
            let _ = sftp.remove_file(part.tmp.as_str()).await;
            return Err(e);
        }
    };
    if let Some(mode) = part.permissions {
        let mut attrs = russh_sftp::protocol::FileAttributes::empty();
        attrs.permissions = Some(mode & 0o7777);
        let _ = sftp.set_metadata(part.tmp.as_str(), attrs).await;
    }
    let Err(e) = sftp.rename(part.tmp.as_str(), part.target.as_str()).await else {
        return Ok(n);
    };
    if sftp.symlink_metadata(part.target.as_str()).await.is_err() {
        let _ = sftp.remove_file(part.tmp.as_str()).await;
        return Err(ferr("rename", e));
    }
    match sftp.open_with_flags(part.target.as_str(), russh_sftp::protocol::OpenFlags::WRITE).await {
        Ok(mut f) => {
            let _ = f.shutdown().await;
        }
        Err(e) => {
            let _ = sftp.remove_file(part.tmp.as_str()).await;
            return Err(ferr("create", e));
        }
    }
    if let Err(e) = sftp.remove_file(part.target.as_str()).await {
        let _ = sftp.remove_file(part.tmp.as_str()).await;
        return Err(ferr("replace", e));
    }
    sftp.rename(part.tmp.as_str(), part.target.as_str())
        .await
        .map_err(|e| AppError::Ssh(format!("SFTP rename: {e}. The new content is in {}", part.tmp)))?;
    Ok(n)
}

async fn pump<R, W>(reader: &mut R, writer: &mut W, x: &Xfer) -> Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = tokio::select! {
            _ = x.cancel.cancelled() => return Err(cancelled()),
            r = reader.read(&mut buf) => r.map_err(|e| ferr("read", e))?,
        };
        if n == 0 {
            break;
        }
        total += n as u64;
        if let Some(limit) = x.limit {
            if total > limit {
                return Err(AppError::Ssh(format!(
                    "remote file exceeds the {} MiB download limit",
                    limit / (1024 * 1024)
                )));
            }
        }
        writer.write_all(&buf[..n]).await.map_err(|e| ferr("write", e))?;
        x.done.fetch_add(n as u64, Ordering::Relaxed);
    }
    writer.flush().await.map_err(|e| ferr("flush", e))?;
    Ok(total)
}

async fn download(sftp: &SftpSession, remote: &str, local: &Path, x: &Xfer) -> Result<u64> {
    let mut rf = sftp.open(remote).await.map_err(|e| ferr("open", e))?;
    let target = tokio::fs::canonicalize(local).await.unwrap_or_else(|_| local.to_path_buf());
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let part = target.with_file_name(part_name(&name));
    let mut opts = tokio::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    #[cfg(unix)]
    let remote_mode = rf.metadata().await.ok().and_then(|m| m.permissions).map(|m| m & 0o777);
    let mut lf = opts.open(&part).await.map_err(|e| ferr("create local file", e))?;
    let pumped = pump(&mut rf, &mut lf, x).await;
    drop(lf);
    let result = match pumped {
        Ok(n) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = tokio::fs::metadata(&target).await {
                    let _ = tokio::fs::set_permissions(&part, meta.permissions()).await;
                } else if let Some(mode) = remote_mode {
                    let _ = tokio::fs::set_permissions(&part, std::fs::Permissions::from_mode(mode)).await;
                }
            }
            tokio::fs::rename(&part, &target)
                .await
                .map(|_| n)
                .map_err(|e| ferr("save local file", e))
        }
        Err(e) => Err(e),
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(&part).await;
    }
    result
}

fn download_dir<'a>(
    sftp: &'a SftpSession,
    remote: String,
    local: std::path::PathBuf,
    x: &'a Xfer,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64>> + Send + 'a>> {
    Box::pin(async move {
        tokio::fs::create_dir_all(&local)
            .await
            .map_err(|e| ferr("create local dir", e))?;
        let entries = list(sftp, &remote).await?;
        let mut total = 0u64;
        for e in entries {
            if !is_safe_component(&e.name) || (e.is_symlink && !links_to_file(sftp, &e.path).await) {
                continue;
            }
            let child = local.join(&e.name);
            if e.is_dir && !e.is_symlink {
                total += download_dir(sftp, e.path, child, x).await?;
            } else {
                total += download(sftp, &e.path, &child, x).await?;
            }
        }
        Ok(total)
    })
}

async fn links_to_file(sftp: &SftpSession, path: &str) -> bool {
    sftp.metadata(path).await.is_ok_and(|m| m.file_type().is_file())
}

async fn upload(sftp: &SftpSession, local: &Path, remote: &str, x: &Xfer) -> Result<u64> {
    let mut lf = tokio::fs::File::open(local)
        .await
        .map_err(|e| ferr("read local file", e))?;
    let mode = lf.metadata().await.ok().as_ref().and_then(local_mode);
    let (mut wf, part) = create_part(sftp, remote, mode).await?;
    let result = match pump(&mut lf, &mut wf, x).await {
        Ok(n) => wf.shutdown().await.map(|_| n).map_err(|e| ferr("close", e)),
        Err(e) => {
            let _ = wf.shutdown().await;
            Err(e)
        }
    };
    finish_part(sftp, part, result).await
}

fn upload_dir<'a>(
    sftp: &'a SftpSession,
    local: std::path::PathBuf,
    remote: String,
    x: &'a Xfer,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64>> + Send + 'a>> {
    Box::pin(async move {
        let _ = sftp.create_dir(&remote).await;
        let mut rd = tokio::fs::read_dir(&local)
            .await
            .map_err(|e| ferr("read local dir", e))?;
        let mut total = 0u64;
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| ferr("read local dir", e))?
        {
            let ft = entry.file_type().await.map_err(|e| ferr("local type", e))?;
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            let child_remote = join(&remote, &name);
            let file = ft.is_file()
                || (ft.is_symlink() && tokio::fs::metadata(entry.path()).await.is_ok_and(|m| m.is_file()));
            if ft.is_dir() {
                total += upload_dir(sftp, entry.path(), child_remote, x).await?;
            } else if file {
                total += upload(sftp, &entry.path(), &child_remote, x).await?;
            }
        }
        Ok(total)
    })
}

async fn copy_file(src: &SftpSession, from: &str, dst: &SftpSession, to: &str, x: &Xfer) -> Result<u64> {
    let mut rf = src.open(from).await.map_err(|e| ferr("open", e))?;
    let mode = rf.metadata().await.ok().and_then(|m| m.permissions).map(|m| m & 0o777);
    let (mut wf, part) = create_part(dst, to, mode).await?;
    let result = match pump(&mut rf, &mut wf, x).await {
        Ok(n) => wf.shutdown().await.map(|_| n).map_err(|e| ferr("close", e)),
        Err(e) => {
            let _ = wf.shutdown().await;
            Err(e)
        }
    };
    finish_part(dst, part, result).await
}

fn copy_dir<'a>(
    src: &'a SftpSession,
    from: String,
    dst: &'a SftpSession,
    to: String,
    x: &'a Xfer,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<u64>> + Send + 'a>> {
    Box::pin(async move {
        let _ = dst.create_dir(&to).await;
        let mut total = 0u64;
        for e in list(src, &from).await? {
            if !is_safe_component(&e.name) || (e.is_symlink && !links_to_file(src, &e.path).await) {
                continue;
            }
            let child = join(&to, &e.name);
            if e.is_dir && !e.is_symlink {
                total += copy_dir(src, e.path, dst, child, x).await?;
            } else {
                total += copy_file(src, &e.path, dst, &child, x).await?;
            }
        }
        Ok(total)
    })
}

fn remote_size<'a>(
    sftp: &'a SftpSession,
    path: String,
    is_dir: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = u64> + Send + 'a>> {
    Box::pin(async move {
        if !is_dir {
            return sftp.metadata(&path).await.ok().and_then(|m| m.size).unwrap_or(0);
        }
        let mut total = 0;
        if let Ok(entries) = list(sftp, &path).await {
            for e in entries {
                total += if e.is_symlink {
                    sftp.metadata(e.path.as_str()).await.ok().filter(|m| m.file_type().is_file()).map_or(0, |m| m.len())
                } else if e.is_dir {
                    remote_size(sftp, e.path, true).await
                } else {
                    e.size
                };
            }
        }
        total
    })
}

pub fn local_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_symlink() {
        return std::fs::metadata(path).ok().filter(|m| m.is_file()).map_or(0, |m| m.len());
    }
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(path)
        .map(|rd| rd.flatten().map(|e| local_size(&e.path())).sum())
        .unwrap_or(0)
}

pub struct SftpHandle {
    _conn: Arc<client::Handle<ClientHandler>>,
    sftp: SftpSession,
}

impl SftpHandle {
    pub async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        list(&self.sftp, path).await
    }
    pub async fn home(&self) -> Result<String> {
        self.sftp
            .canonicalize(".")
            .await
            .map_err(|e| ferr("home", e))
    }
    pub async fn download(&self, remote: &str, local: &Path, x: &Xfer) -> Result<u64> {
        download(&self.sftp, remote, local, x).await
    }
    pub async fn download_dir(&self, remote: &str, local: &Path, x: &Xfer) -> Result<u64> {
        download_dir(&self.sftp, remote.to_string(), local.to_path_buf(), x).await
    }
    pub async fn upload(&self, local: &Path, remote: &str, x: &Xfer) -> Result<u64> {
        upload(&self.sftp, local, remote, x).await
    }
    pub async fn upload_dir(&self, local: &Path, remote: &str, x: &Xfer) -> Result<u64> {
        upload_dir(&self.sftp, local.to_path_buf(), remote.to_string(), x).await
    }
    pub async fn size(&self, path: &str, is_dir: bool) -> u64 {
        remote_size(&self.sftp, path.to_string(), is_dir).await
    }
    pub async fn copy_to(&self, from: &str, dst: &SftpHandle, to: &str, is_dir: bool, x: &Xfer) -> Result<u64> {
        if is_dir {
            copy_dir(&self.sftp, from.to_string(), &dst.sftp, to.to_string(), x).await
        } else {
            copy_file(&self.sftp, from, &dst.sftp, to, x).await
        }
    }
    pub async fn read_text(&self, path: &str) -> Result<String> {
        // Same 1 MiB cap and message as local_read_text; the SFTP view treats it
        // as "too large, transfer instead". The size is checked before reading and
        // the read itself is bounded, because a symlink's listed size is its own.
        const MAX_TEXT: u64 = 1024 * 1024;
        let too_big =
            || AppError::Ssh("The file is larger than 1 MiB and cannot be opened as text".into());
        if let Ok(meta) = self.sftp.metadata(path).await {
            if meta.size.is_some_and(|s| s > MAX_TEXT) {
                return Err(too_big());
            }
        }
        let f = self.sftp.open(path).await.map_err(|e| ferr("open", e))?;
        let mut buf = Vec::new();
        f.take(MAX_TEXT + 1)
            .read_to_end(&mut buf)
            .await
            .map_err(|e| ferr("read", e))?;
        if buf.len() as u64 > MAX_TEXT {
            return Err(too_big());
        }
        String::from_utf8(buf).map_err(|_| AppError::Ssh("Not a UTF-8 text file".into()))
    }
    pub async fn write_text(&self, path: &str, content: &str) -> Result<()> {
        let (mut f, part) = create_part(&self.sftp, path, None).await?;
        let written = async {
            f.write_all(content.as_bytes()).await.map_err(|e| ferr("write", e))?;
            f.flush().await.map_err(|e| ferr("flush", e))
        }
        .await;
        let closed = f.shutdown().await.map_err(|e| ferr("close", e));
        finish_part(&self.sftp, part, written.and(closed).map(|()| content.len() as u64)).await?;
        Ok(())
    }
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.sftp.create_dir(path).await.map_err(|e| ferr("mkdir", e))
    }
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.sftp
            .rename(from.to_string(), to.to_string())
            .await
            .map_err(|e| ferr("rename", e))
    }
    pub async fn remove(&self, path: &str, is_dir: bool) -> Result<()> {
        if is_dir {
            self.sftp
                .remove_dir(path)
                .await
                .map_err(|e| ferr("remove_dir", e))
        } else {
            self.sftp
                .remove_file(path)
                .await
                .map_err(|e| ferr("remove_file", e))
        }
    }
}

pub async fn connect(ssh: &SshManager, vault: &Arc<Vault>, host: &Host) -> Result<SftpHandle> {
    let conn = ssh.connect(host, vault).await?;
    on_session(Arc::new(conn)).await
}

pub async fn on_session(conn: Arc<client::Handle<ClientHandler>>) -> Result<SftpHandle> {
    let sftp = open_subsystem(&conn).await?;
    Ok(SftpHandle { _conn: conn, sftp })
}

#[derive(Default)]
pub struct SftpSessions(Mutex<HashMap<String, Arc<SftpHandle>>>);

impl SftpSessions {
    pub fn get(&self, id: &str) -> Option<Arc<SftpHandle>> {
        self.0.lock().unwrap().get(id).cloned()
    }
    pub fn insert(&self, id: String, handle: Arc<SftpHandle>) {
        self.0.lock().unwrap().insert(id, handle);
    }
    pub fn remove(&self, id: &str) -> Option<Arc<SftpHandle>> {
        self.0.lock().unwrap().remove(id)
    }
    pub fn clear(&self) {
        let all: Vec<_> = self.0.lock().unwrap().drain().collect();
        drop(all);
    }
}

#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, CancellationToken>>);

impl Transfers {
    pub fn register(&self, id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.0.lock().unwrap().insert(id.to_string(), token.clone());
        token
    }
    pub fn finish(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    pub fn cancel(&self, id: &str) {
        if let Some(t) = self.0.lock().unwrap().remove(id) {
            t.cancel();
        }
    }
    pub fn cancel_all(&self) {
        let all: Vec<_> = self.0.lock().unwrap().drain().collect();
        for (_, t) in all {
            t.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::windows_safe;

    #[test]
    fn windows_rejects_names_ntfs_cannot_hold() {
        for bad in ["1234.M1P2.host:2,S", "notes.", "trailing ", "CON", "con.txt", "COM1", "lpt9.log", "a?b", "tab\tname"] {
            assert!(!windows_safe(bad), "{bad}");
        }
        for good in ["report.pdf", "computer", "com10", "console.log", ".env"] {
            assert!(windows_safe(good), "{good}");
        }
    }
}
