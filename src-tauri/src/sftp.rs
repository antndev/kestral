
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
    matches!(
        (comps.next(), comps.next()),
        (Some(std::path::Component::Normal(_)), None)
    )
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
        if name == "." || name == ".." {
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

const MAX_AI_DOWNLOAD: u64 = 2 * 1024 * 1024 * 1024;

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

fn is_cancelled(e: &AppError) -> bool {
    matches!(e, AppError::Other(m) if m == "Cancelled")
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
    let mut lf = tokio::fs::File::create(local)
        .await
        .map_err(|e| ferr("create local file", e))?;
    match pump(&mut rf, &mut lf, x).await {
        Ok(n) => Ok(n),
        Err(e) => {
            drop(lf);
            let _ = tokio::fs::remove_file(local).await;
            Err(e)
        }
    }
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
            if e.is_symlink || !is_safe_component(&e.name) {
                continue;
            }
            let child = local.join(&e.name);
            if e.is_dir {
                total += download_dir(sftp, e.path, child, x).await?;
            } else {
                total += download(sftp, &e.path, &child, x).await?;
            }
        }
        Ok(total)
    })
}

async fn upload(sftp: &SftpSession, local: &Path, remote: &str, x: &Xfer) -> Result<u64> {
    let mut lf = tokio::fs::File::open(local)
        .await
        .map_err(|e| ferr("read local file", e))?;
    let mut wf = sftp.create(remote).await.map_err(|e| ferr("create", e))?;
    match pump(&mut lf, &mut wf, x).await {
        Ok(n) => {
            wf.shutdown().await.map_err(|e| ferr("close", e))?;
            Ok(n)
        }
        Err(e) => {
            let _ = wf.shutdown().await;
            if is_cancelled(&e) {
                let _ = sftp.remove_file(remote).await;
            }
            Err(e)
        }
    }
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
            if ft.is_dir() {
                total += upload_dir(sftp, entry.path(), child_remote, x).await?;
            } else if ft.is_file() {
                total += upload(sftp, &entry.path(), &child_remote, x).await?;
            }
        }
        Ok(total)
    })
}

async fn copy_file(src: &SftpSession, from: &str, dst: &SftpSession, to: &str, x: &Xfer) -> Result<u64> {
    let mut rf = src.open(from).await.map_err(|e| ferr("open", e))?;
    let mut wf = dst.create(to).await.map_err(|e| ferr("create", e))?;
    match pump(&mut rf, &mut wf, x).await {
        Ok(n) => {
            wf.shutdown().await.map_err(|e| ferr("close", e))?;
            Ok(n)
        }
        Err(e) => {
            let _ = wf.shutdown().await;
            let _ = dst.remove_file(to).await;
            Err(e)
        }
    }
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
            if e.is_symlink || !is_safe_component(&e.name) {
                continue;
            }
            let child = join(&to, &e.name);
            if e.is_dir {
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
                if e.is_symlink {
                    continue;
                }
                total += if e.is_dir { remote_size(sftp, e.path, true).await } else { e.size };
            }
        }
        total
    })
}

pub fn local_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
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
    _conn: client::Handle<ClientHandler>,
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
        let mut f = self.sftp.create(path).await.map_err(|e| ferr("create", e))?;
        f.write_all(content.as_bytes()).await.map_err(|e| ferr("write", e))?;
        f.flush().await.map_err(|e| ferr("flush", e))?;
        f.shutdown().await.map_err(|e| ferr("close", e))?;
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
    let sftp = open_subsystem(&conn).await?;
    Ok(SftpHandle { _conn: conn, sftp })
}

pub async fn one_shot_list(
    ssh: &SshManager,
    vault: &Arc<Vault>,
    host: &Host,
    path: &str,
) -> Result<Vec<FileEntry>> {
    connect(ssh, vault, host).await?.list(path).await
}

pub async fn one_shot_download(
    ssh: &SshManager,
    vault: &Arc<Vault>,
    host: &Host,
    remote: &str,
    local: &Path,
) -> Result<u64> {
    connect(ssh, vault, host).await?.download(remote, local, &Xfer::limited(MAX_AI_DOWNLOAD)).await
}

pub async fn one_shot_upload(
    ssh: &SshManager,
    vault: &Arc<Vault>,
    host: &Host,
    local: &Path,
    remote: &str,
) -> Result<u64> {
    connect(ssh, vault, host).await?.upload(local, remote, &Xfer::default()).await
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
}
