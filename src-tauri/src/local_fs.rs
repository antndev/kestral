//! Local filesystem access for the two-pane SFTP view and file imports.

use std::io::Read;
use std::path::Path;

use crate::error::{AppError, Result};
use crate::sftp::FileEntry;
use crate::util::blocking;

const MAX_TEXT: u64 = 1024 * 1024;

fn fs_err(action: &str, path: &str, e: std::io::Error) -> AppError {
    AppError::Other(format!("Could not {action} {path}: {e}"))
}

fn mtime(meta: &std::fs::Metadata) -> Option<i64> {
    let modified = meta.modified().ok()?;
    match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).ok(),
        Err(e) => i64::try_from(e.duration().as_secs()).ok().map(|s| -s),
    }
}

#[cfg(unix)]
fn permissions(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode())
}

#[cfg(not(unix))]
fn permissions(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

#[cfg(windows)]
fn hidden_attr(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x6 != 0
}

#[cfg(not(windows))]
fn hidden_attr(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Lists a directory: directories first, then case-insensitive by name.
/// Entries that cannot be inspected are skipped instead of failing the listing.
pub fn list(path: &str) -> Result<Vec<FileEntry>> {
    let dir = std::fs::read_dir(path).map_err(|e| fs_err("open", path, e))?;
    let mut out = Vec::new();
    for entry in dir.flatten() {
        let Ok(link_meta) = entry.metadata() else {
            continue;
        };
        let is_symlink = link_meta.file_type().is_symlink();
        let name = entry.file_name().to_string_lossy().into_owned();
        let hidden = name.starts_with('.') || hidden_attr(&link_meta);
        let meta = if is_symlink {
            std::fs::metadata(entry.path()).unwrap_or(link_meta)
        } else {
            link_meta
        };
        let is_dir = meta.is_dir();
        out.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            size: if is_dir { 0 } else { meta.len() },
            mtime: mtime(&meta),
            permissions: permissions(&meta),
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

pub fn read_text(path: &str) -> Result<String> {
    // Checked before opening: on Windows opening a folder fails with a bare
    // "Access is denied".
    let meta = std::fs::metadata(path).map_err(|e| fs_err("open", path, e))?;
    if meta.is_dir() {
        return Err(AppError::Other(format!("{path} is a folder, not a file")));
    }
    let too_big =
        || AppError::Other("The file is larger than 1 MiB and cannot be opened as text".into());
    if meta.len() > MAX_TEXT {
        return Err(too_big());
    }
    let file = std::fs::File::open(path).map_err(|e| fs_err("open", path, e))?;
    let mut buf = Vec::new();
    file.take(MAX_TEXT + 1)
        .read_to_end(&mut buf)
        .map_err(|e| fs_err("read", path, e))?;
    if buf.len() as u64 > MAX_TEXT {
        return Err(too_big());
    }
    String::from_utf8(buf).map_err(|_| AppError::Other("Not a UTF-8 text file".into()))
}

pub fn rename(from: &str, to: &str) -> Result<()> {
    let target = Path::new(to);
    // std::fs::rename silently replaces an existing file. Refuse that, but allow
    // a case-only rename on case-insensitive filesystems (same file both ways).
    if target.exists() {
        let same = match (std::fs::canonicalize(from), std::fs::canonicalize(target)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !same {
            return Err(AppError::Other(format!("{to} already exists")));
        }
    }
    std::fs::rename(from, to).map_err(|e| fs_err("rename", from, e))
}

pub fn home() -> Result<String> {
    crate::util::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Other("No home directory found".into()))
}

#[tauri::command]
pub async fn local_home() -> Result<String> {
    home()
}

#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<FileEntry>> {
    blocking(move || list(&path)).await
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<()> {
    blocking(move || std::fs::create_dir(&path).map_err(|e| fs_err("create", &path, e))).await
}

#[tauri::command]
pub async fn local_remove(path: String, is_dir: bool) -> Result<()> {
    blocking(move || {
        if is_dir {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        }
        .map_err(|e| fs_err("delete", &path, e))
    })
    .await
}

#[tauri::command]
pub async fn local_rename(from: String, to: String) -> Result<()> {
    blocking(move || rename(&from, &to)).await
}

#[tauri::command]
pub async fn local_read_text(path: String) -> Result<String> {
    blocking(move || read_text(&path)).await
}

#[tauri::command]
pub async fn local_write_text(path: String, content: String) -> Result<()> {
    blocking(move || {
        crate::util::replace_file(Path::new(&path), content.as_bytes())
            .map_err(|e| fs_err("save", &path, e))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kestral_fs_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_dirs_first_then_by_name() {
        let dir = tmp();
        std::fs::write(dir.join("b.txt"), "hi").unwrap();
        std::fs::write(dir.join("A.txt"), "").unwrap();
        std::fs::create_dir(dir.join("zdir")).unwrap();
        let names: Vec<_> = list(dir.to_str().unwrap())
            .unwrap()
            .into_iter()
            .map(|e| (e.name, e.is_dir, e.size))
            .collect();
        assert_eq!(
            names,
            vec![
                ("zdir".to_string(), true, 0),
                ("A.txt".to_string(), false, 0),
                ("b.txt".to_string(), false, 2),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_text_limits_and_rename_guard() {
        let dir = tmp();
        let small = dir.join("s.txt");
        std::fs::write(&small, "héllo").unwrap();
        assert_eq!(read_text(small.to_str().unwrap()).unwrap(), "héllo");

        let big = dir.join("big.bin");
        std::fs::write(&big, vec![b'a'; MAX_TEXT as usize + 1]).unwrap();
        assert!(read_text(big.to_str().unwrap()).is_err());

        let bin = dir.join("bin.dat");
        std::fs::write(&bin, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_text(bin.to_str().unwrap()).is_err());

        let folder = read_text(dir.to_str().unwrap()).unwrap_err().to_string();
        assert!(folder.contains("is a folder"), "{folder}");

        assert!(rename(small.to_str().unwrap(), big.to_str().unwrap()).is_err());
        let moved = dir.join("moved.txt");
        rename(small.to_str().unwrap(), moved.to_str().unwrap()).unwrap();
        assert!(moved.exists() && !small.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_replaces_content_and_leaves_no_temp_file() {
        let dir = tmp();
        let file = dir.join("notes.txt");
        std::fs::write(&file, "old content that is longer").unwrap();
        crate::util::replace_file(&file, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("notes.txt")]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
