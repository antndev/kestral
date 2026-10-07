use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::vault::Vault;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct Collections {
    #[serde(default)]
    pub snippet_folders: Vec<String>,
}

pub struct CollectionStore {
    vault: Arc<Vault>,
    lock: Mutex<()>,
}

pub fn clean_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::Other("Enter a name for the folder".into()));
    }
    if n.chars().any(|c| c.is_control()) {
        return Err(AppError::Other("The name cannot contain line breaks or tabs".into()));
    }
    if n.chars().count() > 64 {
        return Err(AppError::Other("Use at most 64 characters".into()));
    }
    Ok(n.to_string())
}

pub fn same(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

pub fn merged(stored: &[String], used: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in stored.iter().cloned().chain(used) {
        let name = name.trim().to_string();
        if name.is_empty() || out.iter().any(|x| same(x, &name)) {
            continue;
        }
        out.push(name);
    }
    out
}

impl CollectionStore {
    pub fn new(vault: Arc<Vault>) -> Self {
        Self { vault, lock: Mutex::new(()) }
    }

    pub fn read(&self) -> Result<Collections> {
        match self.vault.get_blob(Vault::collections_blob_id())? {
            Some(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| AppError::Other(format!("Snippet folders could not be read: {e}"))),
            None => Ok(Collections::default()),
        }
    }

    fn write(&self, c: &Collections) -> Result<()> {
        let bytes = serde_json::to_vec(c)?;
        self.vault.put_blob(Vault::collections_blob_id(), &bytes)
    }

    pub fn list(&self, used: Vec<String>) -> Result<Vec<String>> {
        Ok(merged(&self.read()?.snippet_folders, used))
    }

    pub fn add(&self, name: &str, used: Vec<String>) -> Result<String> {
        let name = clean_name(name)?;
        let _g = self.lock.lock().unwrap();
        let mut c = self.read()?;
        let list = &mut c.snippet_folders;
        let all = merged(list, used);
        if let Some(existing) = all.iter().find(|x| same(x, &name)) {
            return Err(AppError::Other(format!("A folder named {existing} already exists")));
        }
        *list = all;
        list.push(name.clone());
        self.write(&c)?;
        Ok(name)
    }

    pub fn rename(&self, from: &str, to: &str, used: Vec<String>) -> Result<String> {
        let to = clean_name(to)?;
        let _g = self.lock.lock().unwrap();
        let mut c = self.read()?;
        let list = &mut c.snippet_folders;
        let mut all = merged(list, used);
        if !all.iter().any(|x| same(x, from)) {
            return Err(AppError::Other(format!("The folder {} no longer exists", from.trim())));
        }
        if let Some(existing) = all.iter().find(|x| same(x, &to) && !same(x, from)) {
            return Err(AppError::Other(format!("A folder named {existing} already exists")));
        }
        for x in all.iter_mut() {
            if same(x, from) {
                *x = to.clone();
            }
        }
        *list = all;
        self.write(&c)?;
        Ok(to)
    }

    pub fn remove(&self, name: &str, used: Vec<String>) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut c = self.read()?;
        let list = &mut c.snippet_folders;
        let mut all = merged(list, used);
        all.retain(|x| !same(x, name));
        *list = all;
        self.write(&c)
    }

    pub fn reorder(&self, order: Vec<String>, used: Vec<String>) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut c = self.read()?;
        let list = &mut c.snippet_folders;
        let current = merged(list, used);
        let mut next: Vec<String> = Vec::new();
        for name in order {
            if let Some(x) = current.iter().find(|x| same(x, &name)) {
                if !next.iter().any(|y| same(y, x)) {
                    next.push(x.clone());
                }
            }
        }
        for x in current {
            if !next.iter().any(|y| same(y, &x)) {
                next.push(x);
            }
        }
        *list = next;
        self.write(&c)
    }

    pub fn import(&self, incoming: Collections) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut c = self.read()?;
        let next = Collections {
            snippet_folders: merged(&c.snippet_folders, incoming.snippet_folders),
        };
        if next != c {
            c = next;
            self.write(&c)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::SecretStore;

    #[test]
    fn merge_keeps_stored_order_and_casing() {
        let stored = vec!["Production".to_string(), "Staging".to_string()];
        let used = vec!["staging".to_string(), "Homelab".to_string(), "".to_string(), "production".to_string()];
        assert_eq!(merged(&stored, used), vec!["Production", "Staging", "Homelab"]);
    }

    #[test]
    fn legacy_collections_still_load() {
        let legacy = br#"{"groups":["Production","Staging"],"snippet_folders":["Docker","Logs"],"pinned":["a","b"],"recent":[{"host_id":"a","at":"2026-10-01T10:00:00Z"}]}"#;
        let parsed: Collections = serde_json::from_slice(legacy).unwrap();
        assert_eq!(parsed.snippet_folders, vec!["Docker", "Logs"]);

        let dir = std::env::temp_dir().join(format!("kestral-collections-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Arc::new(Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();
        vault.put_blob(Vault::collections_blob_id(), legacy).unwrap();
        let store = CollectionStore::new(vault);

        assert_eq!(store.read().unwrap(), parsed);
        assert_eq!(store.list(vec!["System".into()]).unwrap(), vec!["Docker", "Logs", "System"]);
        store.add("Backups", Vec::new()).unwrap();
        assert_eq!(store.list(Vec::new()).unwrap(), vec!["Docker", "Logs", "Backups"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_are_checked() {
        assert!(clean_name("  ").is_err());
        assert!(clean_name("a\tb").is_err());
        assert!(clean_name(&"x".repeat(65)).is_err());
        assert_eq!(clean_name("  Docker ").unwrap(), "Docker");
    }
}
