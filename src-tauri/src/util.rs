use std::path::Path;

pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    {
        let mut file = std::fs::File::create(&tmp)?;
        restrict(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Replaces a user file without ever leaving it half written: the content goes
/// to a uniquely named sibling first and is then renamed over the target. A
/// symlinked target is written through to the file it points at, and on Unix the
/// target keeps its permission bits.
pub fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = target
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&target) {
                file.set_permissions(meta.permissions())?;
            } else if looks_like_private_key(bytes) {
                // ssh refuses private keys readable by others, so a freshly
                // exported key is created owner-only.
                file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
            }
        }
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// True for PEM / OpenSSH private key text ("-----BEGIN ... PRIVATE KEY-----").
#[cfg_attr(not(unix), allow(dead_code))]
fn looks_like_private_key(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(100)];
    let head = String::from_utf8_lossy(head);
    head.trim_start().starts_with("-----BEGIN") && head.contains("PRIVATE KEY")
}

/// Runs blocking file work off the async runtime.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> crate::error::Result<T> + Send + 'static,
) -> crate::error::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?
}

/// The current user's home directory (USERPROFILE on Windows, HOME elsewhere).
pub fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|h| !h.is_empty())
        .map(std::path::PathBuf::from)
}

/// OpenSSH-style wildcard match: `*` matches any run of characters, `?` exactly one.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    restrict(&file)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub fn restrict(_file: &std::fs::File) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        _file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn restrict_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Best-effort, one-time hardening of the data directory on Windows: strip
/// inherited ACEs and grant only the current user full control, inherited by
/// everything created inside (vault, audit log, MCP token). On Unix the per-file
/// 0600/0700 modes already handle this, so this is a no-op there. Errors are
/// ignored: %USERPROFILE% is already user-scoped, this is defense in depth.
pub fn harden_dir(path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(user) = std::env::var_os("USERNAME") {
            let user = user.to_string_lossy();
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("icacls")
                .arg(path)
                .args(["/inheritance:r", "/grant:r"])
                .arg(format!("{user}:(OI)(CI)F"))
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }
    #[cfg(not(windows))]
    let _ = path;
}

const DATA_README: &str = "Kestral data folder

Everything Kestral stores on this computer lives here. Do not delete this
folder: without vault.json your hosts, keys and passwords are gone.

vault.json            Your vault. Hosts, keys, passwords, snippets and known
                      hosts, encrypted with your master password.
audit.log             Encrypted log of what you and the AI ran on your servers.
hello.json            Windows Hello unlock, only when you turned it on.
mcp_token             Access token for the local AI connection.
ai_state              Whether AI access is on, and until when.
ai_caps.json          What the AI may do, only when you changed the defaults.
protected_paths.json  Paths the AI must never touch.
app_settings.json     Tray and first start preferences.

To move Kestral to another computer, use Settings, Sync, Export vault
instead of copying this folder.
";

/// Keeps the data directory tidy on start: drops the obsolete, empty AI transfer
/// folder and half written temp files, and leaves a README that says what the
/// files are.
pub fn tidy_data_dir(dir: &Path) {
    let _ = std::fs::remove_dir(dir.join("ai-transfers"));
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().is_some_and(|x| x == "tmp") {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    let readme = dir.join("README.txt");
    if std::fs::read_to_string(&readme).ok().as_deref() != Some(DATA_README) {
        let _ = std::fs::write(&readme, DATA_README);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidy_data_dir_cleans_leftovers_and_keeps_data() {
        let dir = std::env::temp_dir().join(format!("kestral-tidy-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("ai-transfers")).unwrap();
        std::fs::write(dir.join("vault.json"), b"{}").unwrap();
        std::fs::write(dir.join("vault.tmp"), b"half").unwrap();
        tidy_data_dir(&dir);
        assert!(!dir.join("ai-transfers").exists());
        assert!(!dir.join("vault.tmp").exists());
        assert!(dir.join("vault.json").exists());
        assert_eq!(std::fs::read_to_string(dir.join("README.txt")).unwrap(), DATA_README);

        std::fs::create_dir_all(dir.join("ai-transfers")).unwrap();
        std::fs::write(dir.join("ai-transfers").join("keep.txt"), b"user file").unwrap();
        tidy_data_dir(&dir);
        assert!(dir.join("ai-transfers").join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
