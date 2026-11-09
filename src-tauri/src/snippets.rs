use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::model::{NewSnippet, Snippet};
use crate::vault::Vault;

pub struct SnippetStore {
    path: PathBuf,
    vault: Arc<Vault>,
    warning: Mutex<Option<String>>,
    unreadable: AtomicBool,
    items: Mutex<Vec<Snippet>>,
}

impl SnippetStore {
    pub fn new(path: PathBuf, vault: Arc<Vault>) -> Self {
        Self {
            path,
            vault,
            warning: Mutex::new(None),
            unreadable: AtomicBool::new(true),
            items: Mutex::new(Vec::new()),
        }
    }

    pub fn load(&self) -> Result<()> {
        let mut current = self.items.lock().unwrap();
        if let Some(bytes) = self.vault.get_blob(Vault::snippets_blob_id())? {
            match serde_json::from_slice::<Vec<Snippet>>(&bytes) {
                Ok(items) => {
                    *self.warning.lock().unwrap() = None;
                    self.unreadable.store(false, Ordering::SeqCst);
                    *current = items;
                }
                Err(e) => {
                    *self.warning.lock().unwrap() = Some(format!(
                        "Scripts in the vault could not be read ({e}). Nothing was changed."
                    ));
                    self.unreadable.store(true, Ordering::SeqCst);
                    *current = Vec::new();
                }
            }
            return Ok(());
        }

        let had_file = self.path.exists();
        let items = match std::fs::read(&self.path) {
            Ok(raw) => self.decode_legacy(&raw)?,
            Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        *self.warning.lock().unwrap() = None;
        self.unreadable.store(false, Ordering::SeqCst);
        *current = items.clone();

        if had_file {
            self.save(&items)?;
            let bak = self.path.with_extension("json.migrated.bak");
            let _ = std::fs::rename(&self.path, &bak);
            tracing::info!(
                "snippets migrated into the vault, old file kept as {}",
                bak.display()
            );
        }
        Ok(())
    }

    fn decode_legacy(&self, raw: &[u8]) -> Result<Vec<Snippet>> {
        match raw.iter().find(|b| !b.is_ascii_whitespace()).copied() {
            Some(b'[') => Ok(serde_json::from_slice(raw).unwrap_or_default()),
            Some(b'{') => match self.vault.open_envelope(raw) {
                Ok((plain, _)) => Ok(serde_json::from_slice(&plain)?),
                Err(e) => {
                    *self.warning.lock().unwrap() = Some(format!(
                        "Scripts could not be decrypted ({e}). The old file is left untouched."
                    ));
                    tracing::error!("items could not be decrypted ({e}), old file left untouched");
                    Err(e)
                }
            },
            _ => Ok(Vec::new()),
        }
    }

    pub fn warning(&self) -> Option<String> {
        self.warning.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        let mut items = self.items.lock().unwrap();
        self.unreadable.store(true, Ordering::SeqCst);
        *items = Vec::new();
    }

    fn save(&self, items: &[Snippet]) -> Result<()> {
        if self.unreadable.load(Ordering::SeqCst) {
            if self.warning().is_none() {
                return Err(AppError::VaultLocked);
            }
            return Err(AppError::Other(
                "Scripts in the vault could not be read, so no changes are saved until that is fixed.".into(),
            ));
        }
        let bytes = serde_json::to_vec(items)?;
        self.vault.put_blob(Vault::snippets_blob_id(), &bytes)
    }

    pub fn list(&self) -> Vec<Snippet> {
        self.items.lock().unwrap().clone()
    }

    fn change<T>(&self, f: impl FnOnce(&mut Vec<Snippet>) -> Result<(T, bool)>) -> Result<T> {
        let mut items = self.items.lock().unwrap();
        let mut next = items.clone();
        let (out, dirty) = f(&mut next)?;
        if dirty {
            self.save(&next)?;
            *items = next;
        }
        Ok(out)
    }

    pub fn add(&self, new: NewSnippet) -> Result<Snippet> {
        let snippet = new.into_snippet();
        self.change(|items| {
            items.push(snippet.clone());
            Ok((snippet, true))
        })
    }

    /// Merge imported snippets in additively, skipping any whose id already
    /// exists. Returns (added, skipped).
    pub fn import(&self, incoming: Vec<Snippet>) -> Result<(usize, usize)> {
        self.change(|items| {
            let mut added = 0;
            let mut skipped = 0;
            for snippet in incoming {
                if items.iter().any(|s| s.id == snippet.id) {
                    skipped += 1;
                    continue;
                }
                items.push(snippet);
                added += 1;
            }
            Ok(((added, skipped), added > 0))
        })
    }

    pub fn get(&self, id: Uuid) -> Result<Snippet> {
        self.items
            .lock()
            .unwrap()
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(id.to_string()))
    }

    pub fn update(&self, mut snippet: Snippet) -> Result<()> {
        snippet.normalize();
        self.change(|items| {
            let slot = items
                .iter_mut()
                .find(|s| s.id == snippet.id)
                .ok_or_else(|| AppError::NotFound(snippet.id.to_string()))?;
            *slot = snippet;
            Ok(((), true))
        })
    }

    pub fn folders(&self) -> Vec<String> {
        self.items.lock().unwrap().iter().map(|s| s.folder.clone()).collect()
    }

    pub fn set_folder(&self, from: &str, to: &str) -> Result<usize> {
        self.change(|items| {
            let mut n = 0;
            for s in items.iter_mut() {
                if !s.folder.trim().is_empty() && crate::collections::same(&s.folder, from) {
                    s.folder = to.to_string();
                    n += 1;
                }
            }
            Ok((n, n > 0))
        })
    }

    pub fn remove_host(&self, host_id: Uuid) -> Result<()> {
        self.change(|items| {
            let mut changed = false;
            for s in items.iter_mut() {
                let before = s.target_host_ids.len();
                s.target_host_ids.retain(|h| *h != host_id);
                if s.target_host_ids.len() != before {
                    changed = true;
                }
            }
            Ok(((), changed))
        })
    }

    pub fn remove(&self, id: Uuid) -> Result<()> {
        self.change(|items| {
            let before = items.len();
            items.retain(|s| s.id != id);
            if items.len() == before {
                return Err(AppError::NotFound(id.to_string()));
            }
            Ok(((), true))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::random_token;

    fn new_snippet(label: &str) -> NewSnippet {
        NewSnippet {
            label: label.to_string(),
            script: "uptime".into(),
            target_host_ids: Vec::new(),
            folder: String::new(),
            vars: Default::default(),
            parallel: true,
            open_tabs: false,
        }
    }

    fn open_store(tag: &str) -> (PathBuf, Arc<Vault>, SnippetStore) {
        let dir = std::env::temp_dir().join(format!("kestral_snippets_test_{tag}_{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Arc::new(Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();
        let store = SnippetStore::new(dir.join("snippets.json"), vault.clone());
        (dir, vault, store)
    }

    #[test]
    fn failed_save_leaves_the_list_unchanged() {
        let (dir, _vault, store) = open_store("failsave");
        store.load().unwrap();
        let s = store.add(new_snippet("a")).unwrap();
        let blocker = dir.join("vault.tmp");
        std::fs::create_dir_all(&blocker).unwrap();

        assert!(store.update(Snippet { label: "changed".into(), ..s.clone() }).is_err());
        assert!(store.add(new_snippet("b")).is_err());
        assert!(store.import(vec![Snippet { id: Uuid::new_v4(), ..s.clone() }]).is_err());
        assert!(store.remove(s.id).is_err());
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.get(s.id).unwrap().label, "a");

        std::fs::remove_dir_all(&blocker).unwrap();
        store.add(new_snippet("c")).unwrap();
        store.clear();
        store.load().unwrap();
        let back: Vec<String> = store.list().into_iter().map(|s| s.label).collect();
        assert_eq!(back, vec!["a".to_string(), "c".to_string()], "the failed changes never reach the disk");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_saved_before_load() {
        let (dir, vault, store) = open_store("preload");
        assert!(store.add(new_snippet("early")).is_err());
        assert!(vault.get_blob(Vault::snippets_blob_id()).unwrap().is_none());

        store.load().unwrap();
        store.add(new_snippet("a")).unwrap();
        store.clear();
        assert!(store.add(new_snippet("b")).is_err());
        store.load().unwrap();
        assert_eq!(store.list().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
