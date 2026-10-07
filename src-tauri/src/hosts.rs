use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use uuid::Uuid;

use crate::error::AppError;
use crate::error::Result;
use crate::model::{AiPolicy, Host, NewHost};
use crate::vault::Vault;

pub struct HostStore {
    path: PathBuf,
    vault: Arc<Vault>,
    warning: Mutex<Option<String>>,
    hosts: Mutex<Vec<Host>>,
}

fn check_jump(hosts: &[Host], host: &Host) -> Result<()> {
    let Some(first) = host.jump_host_id else {
        return Ok(());
    };
    let mut seen = vec![host.id];
    let mut next = Some(first);
    while let Some(id) = next {
        if seen.contains(&id) {
            return Err(AppError::Other("This jump host would create a loop".into()));
        }
        if seen.len() > 5 {
            return Err(AppError::Other("More than 5 jump hosts in a row are not supported".into()));
        }
        seen.push(id);
        let jump = hosts
            .iter()
            .find(|h| h.id == id)
            .ok_or_else(|| AppError::Other("The jump host no longer exists".into()))?;
        next = jump.jump_host_id;
    }
    Ok(())
}

fn name_taken(hosts: &[Host], name: &str, self_id: Uuid) -> bool {
    let needle = name.trim().to_lowercase();
    hosts
        .iter()
        .any(|h| h.id != self_id && h.name.trim().to_lowercase() == needle)
}

impl HostStore {
    pub fn new(path: PathBuf, vault: Arc<Vault>) -> Self {
        Self {
            path,
            vault,
            warning: Mutex::new(None),
            hosts: Mutex::new(Vec::new()),
        }
    }

    pub fn load(&self) -> Result<()> {
        if let Some(bytes) = self.vault.get_blob(Vault::hosts_blob_id())? {
            match serde_json::from_slice::<Vec<Host>>(&bytes) {
                Ok(items) => {
                    *self.warning.lock().unwrap() = None;
                    *self.hosts.lock().unwrap() = items;
                }
                Err(e) => {
                    *self.warning.lock().unwrap() = Some(format!(
                        "Hosts in the vault could not be read ({e}). Nothing was changed."
                    ));
                    *self.hosts.lock().unwrap() = Vec::new();
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
        *self.hosts.lock().unwrap() = items.clone();

        if had_file {
            self.save(&items)?;
            let bak = self.path.with_extension("json.migrated.bak");
            let _ = std::fs::rename(&self.path, &bak);
            tracing::info!(
                "hosts migrated into the vault, old file kept as {}",
                bak.display()
            );
        }
        Ok(())
    }

    fn decode_legacy(&self, raw: &[u8]) -> Result<Vec<Host>> {
        match raw.iter().find(|b| !b.is_ascii_whitespace()).copied() {
            Some(b'[') => Ok(serde_json::from_slice(raw).unwrap_or_default()),
            Some(b'{') => match self.vault.open_envelope(raw) {
                Ok((plain, _)) => Ok(serde_json::from_slice(&plain)?),
                Err(e) => {
                    *self.warning.lock().unwrap() = Some(format!(
                        "Hosts could not be decrypted ({e}). The old file is left untouched."
                    ));
                    tracing::error!("hosts could not be decrypted ({e}), starting empty");
                    Ok(Vec::new())
                }
            },
            _ => Ok(Vec::new()),
        }
    }

    pub fn warning(&self) -> Option<String> {
        self.warning.lock().unwrap().clone()
    }

    pub fn clear(&self) {
        *self.hosts.lock().unwrap() = Vec::new();
    }

    fn save(&self, items: &[Host]) -> Result<()> {
        let bytes = serde_json::to_vec(items)?;
        self.vault.put_blob(Vault::hosts_blob_id(), &bytes)
    }

    pub fn list(&self) -> Vec<Host> {
        self.hosts.lock().unwrap().clone()
    }

    pub fn get(&self, id: Uuid) -> Result<Host> {
        self.hosts
            .lock()
            .unwrap()
            .iter()
            .find(|h| h.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(id.to_string()))
    }

    pub fn add(&self, new_host: NewHost) -> Result<Host> {
        let host = new_host.into_host();
        let mut hosts = self.hosts.lock().unwrap();
        if name_taken(&hosts, &host.name, host.id) {
            return Err(AppError::Other(format!(
                "A host named '{}' already exists",
                host.name
            )));
        }
        check_jump(&hosts, &host)?;
        hosts.push(host.clone());
        self.save(&hosts)?;
        Ok(host)
    }

    /// Merge imported hosts in additively. A host is skipped when its id or its
    /// name (case-insensitive) already exists, so an import never clobbers or
    /// duplicates. Returns (added, skipped).
    pub fn import(&self, incoming: Vec<Host>) -> Result<(usize, usize)> {
        let mut hosts = self.hosts.lock().unwrap();
        let mut added = 0;
        let mut skipped = 0;
        for host in incoming {
            let clash = hosts.iter().any(|h| h.id == host.id)
                || name_taken(&hosts, &host.name, host.id);
            if clash {
                skipped += 1;
                continue;
            }
            hosts.push(host);
            added += 1;
        }
        if added > 0 {
            self.save(&hosts)?;
        }
        Ok((added, skipped))
    }

    pub fn update(&self, mut host: Host) -> Result<()> {
        host.normalize();
        let mut hosts = self.hosts.lock().unwrap();
        if name_taken(&hosts, &host.name, host.id) {
            return Err(AppError::Other(format!(
                "A host named '{}' already exists",
                host.name
            )));
        }
        check_jump(&hosts, &host)?;
        let slot = hosts
            .iter_mut()
            .find(|h| h.id == host.id)
            .ok_or_else(|| AppError::NotFound(host.id.to_string()))?;
        *slot = host;
        self.save(&hosts)
    }

    pub fn remove(&self, id: Uuid) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let before = hosts.len();
        hosts.retain(|h| h.id != id);
        if hosts.len() == before {
            return Err(AppError::NotFound(id.to_string()));
        }
        for h in hosts.iter_mut() {
            if h.jump_host_id == Some(id) {
                h.jump_host_id = None;
            }
        }
        self.save(&hosts)
    }

    pub fn set_policy(&self, id: Uuid, policy: AiPolicy) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let host = hosts
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        host.ai_policy = policy;
        self.save(&hosts)
    }

    pub fn set_file_policy(&self, id: Uuid, policy: AiPolicy) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let host = hosts
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        host.ai_file_policy = policy;
        self.save(&hosts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{random_token, SecretStore};

    fn tmp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("kestral_hosts_test_{tag}_{}", random_token()))
    }

    #[test]
    fn migrates_old_file_into_vault_and_needs_unlock() {
        let dir = tmp_dir("m");
        std::fs::create_dir_all(&dir).unwrap();
        let hosts_path = dir.join("hosts.json");
        let vault_path = dir.join("vault.json");

        let plaintext = r#"[{"id":"11111111-1111-1111-1111-111111111111","name":"h1","hostname":"1.2.3.4","port":22,"username":"root","auth":{"kind":"password","secret_id":"s1"},"ai_policy":"locked","ai_file_policy":"locked"}]"#;
        std::fs::write(&hosts_path, plaintext).unwrap();

        let vault = Arc::new(Vault::new(vault_path));
        vault.create("pw").unwrap();
        let store = HostStore::new(hosts_path.clone(), vault.clone());

        store.load().unwrap();
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].name, "h1");
        assert!(!hosts_path.exists(), "old file was renamed");
        assert!(
            hosts_path.with_extension("json.migrated.bak").exists(),
            "als Backup erhalten"
        );

        store.clear();
        store.load().unwrap();
        assert_eq!(store.list()[0].name, "h1");

        store
            .set_policy(store.list()[0].id, crate::model::AiPolicy::Free)
            .unwrap();
        store.clear();
        store.load().unwrap();
        assert_eq!(store.list()[0].ai_policy, crate::model::AiPolicy::Free);

        vault.lock();
        assert!(store.load().is_err(), "no read without the key");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_duplicate_host_names() {
        let dir = tmp_dir("dup");
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Arc::new(Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();
        let store = HostStore::new(dir.join("hosts.json"), vault.clone());
        store.load().unwrap();

        let mk = |name: &str| NewHost {
            name: name.to_string(),
            hostname: "h".into(),
            port: 22,
            username: "root".into(),
            auth: crate::model::AuthMethod::Password {
                secret_id: "s".into(),
            },
            ai_policy: AiPolicy::Locked,
            ai_file_policy: AiPolicy::Locked,
            forward_agent: false,
            agent_keys: Vec::new(),
            forwards: Vec::new(),
            group: String::new(),
            tags: Vec::new(),
            jump_host_id: None,
            options: Default::default(),
        };

        store.add(mk("prod")).unwrap();
        assert!(store.add(mk("PROD")).is_err(), "no second identical name");
        assert_eq!(store.list().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
