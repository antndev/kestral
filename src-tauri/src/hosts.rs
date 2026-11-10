use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
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
    unreadable: AtomicBool,
    hosts: Mutex<Vec<Host>>,
}

fn check_address(host: &Host) -> Result<()> {
    if !crate::util::valid_hostname(&host.hostname) {
        return Err(AppError::Other(format!(
            "'{}' is not a valid host name or address. Use letters, digits, dots, dashes and colons only.",
            host.hostname
        )));
    }
    if !crate::util::valid_username(&host.username) {
        return Err(AppError::Other(format!(
            "'{}' is not a valid user name. Spaces and shell characters are not allowed.",
            host.username
        )));
    }
    Ok(())
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

fn lock_chained(hosts: &mut [Host], jump: Uuid) -> Vec<Uuid> {
    let parents: std::collections::HashMap<Uuid, Option<Uuid>> =
        hosts.iter().map(|h| (h.id, h.jump_host_id)).collect();
    let mut locked = Vec::new();
    for h in hosts.iter_mut() {
        let mut next = h.jump_host_id;
        let mut hops = 0;
        while let Some(id) = next {
            if id == jump {
                h.ai_policy = AiPolicy::Locked;
                h.ai_file_policy = AiPolicy::Locked;
                locked.push(h.id);
                break;
            }
            hops += 1;
            if hops > 8 {
                break;
            }
            next = parents.get(&id).copied().flatten();
        }
    }
    locked
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
            unreadable: AtomicBool::new(true),
            hosts: Mutex::new(Vec::new()),
        }
    }

    pub fn load(&self) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        if let Some(bytes) = self.vault.get_blob(Vault::hosts_blob_id())? {
            match serde_json::from_slice::<Vec<Host>>(&bytes) {
                Ok(items) => {
                    *self.warning.lock().unwrap() = None;
                    self.unreadable.store(false, Ordering::SeqCst);
                    *hosts = items;
                }
                Err(e) => {
                    *self.warning.lock().unwrap() = Some(format!(
                        "Hosts in the vault could not be read ({e}). Nothing was changed."
                    ));
                    self.unreadable.store(true, Ordering::SeqCst);
                    *hosts = Vec::new();
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
        *hosts = items.clone();

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
                    tracing::error!("hosts could not be decrypted ({e}), old file left untouched");
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
        let mut hosts = self.hosts.lock().unwrap();
        self.unreadable.store(true, Ordering::SeqCst);
        *hosts = Vec::new();
    }

    fn save(&self, items: &[Host]) -> Result<()> {
        if self.unreadable.load(Ordering::SeqCst) {
            if self.warning().is_none() {
                return Err(AppError::VaultLocked);
            }
            return Err(AppError::Other(
                "Hosts in the vault could not be read, so no changes are saved until that is fixed.".into(),
            ));
        }
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
        self.add_host(new_host.into_host())
    }

    pub fn add_host(&self, host: Host) -> Result<Host> {
        check_address(&host)?;
        let mut hosts = self.hosts.lock().unwrap();
        if name_taken(&hosts, &host.name, host.id) {
            return Err(AppError::Other(format!(
                "A host named '{}' already exists",
                host.name
            )));
        }
        check_jump(&hosts, &host)?;
        let mut next = hosts.clone();
        next.push(host.clone());
        self.save(&next)?;
        *hosts = next;
        Ok(host)
    }

    /// Merge imported hosts in additively. A host is skipped when its id or its
    /// name (case-insensitive) already exists, so an import never clobbers or
    /// duplicates. Returns (added, skipped).
    /// Returns the ids of the hosts added, how many were skipped and how many
    /// port forwards came in. A host that is already here is skipped, but gains
    /// the forwards it lacks.
    pub fn import(&self, incoming: Vec<Host>) -> Result<(Vec<Uuid>, usize, usize)> {
        let mut hosts = self.hosts.lock().unwrap();
        let mut next = hosts.clone();
        let offered: Vec<Uuid> = incoming.iter().map(|h| h.id).collect();
        let mut added = Vec::new();
        let mut skipped = 0;
        let mut forwards = 0;
        for host in incoming {
            if let Some(cur) = next.iter_mut().find(|h| h.id == host.id) {
                for f in host.forwards {
                    if !cur.forwards.iter().any(|c| c.id == f.id || c.same_tunnel(&f)) {
                        cur.forwards.push(f);
                        forwards += 1;
                    }
                }
                skipped += 1;
                continue;
            }
            if name_taken(&next, &host.name, host.id) || check_address(&host).is_err() {
                skipped += 1;
                continue;
            }
            forwards += host.forwards.len();
            added.push(host.id);
            next.push(host);
        }
        let known: Vec<Uuid> = next.iter().map(|h| h.id).filter(|id| offered.contains(id)).collect();
        for h in next.iter_mut().filter(|h| added.contains(&h.id)) {
            if h.jump_host_id.is_some_and(|j| !known.contains(&j)) {
                h.jump_host_id = None;
            }
        }
        if !added.is_empty() || forwards > 0 {
            self.save(&next)?;
            *hosts = next;
        }
        Ok((added, skipped, forwards))
    }

    pub fn update(&self, host: Host) -> Result<()> {
        self.update_relocking(host, false).map(|_| ())
    }

    pub fn update_relocking(&self, mut host: Host, relock: bool) -> Result<Vec<Uuid>> {
        host.normalize();
        check_address(&host)?;
        let mut hosts = self.hosts.lock().unwrap();
        if name_taken(&hosts, &host.name, host.id) {
            return Err(AppError::Other(format!(
                "A host named '{}' already exists",
                host.name
            )));
        }
        check_jump(&hosts, &host)?;
        let id = host.id;
        let mut next = hosts.clone();
        let slot = next
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        *slot = host;
        let locked = if relock { lock_chained(&mut next, id) } else { Vec::new() };
        self.save(&next)?;
        *hosts = next;
        Ok(locked)
    }

    pub fn remove(&self, id: Uuid) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let mut next = hosts.clone();
        next.retain(|h| h.id != id);
        if next.len() == hosts.len() {
            return Err(AppError::NotFound(id.to_string()));
        }
        for h in next.iter_mut() {
            if h.jump_host_id == Some(id) {
                h.jump_host_id = None;
            }
        }
        self.save(&next)?;
        *hosts = next;
        Ok(())
    }

    pub fn set_policy(&self, id: Uuid, policy: AiPolicy) -> Result<()> {
        self.change(id, |h| h.ai_policy = policy)
    }

    pub fn set_file_policy(&self, id: Uuid, policy: AiPolicy) -> Result<()> {
        self.change(id, |h| h.ai_file_policy = policy)
    }

    fn change(&self, id: Uuid, f: impl FnOnce(&mut Host)) -> Result<()> {
        let mut hosts = self.hosts.lock().unwrap();
        let mut next = hosts.clone();
        let host = next
            .iter_mut()
            .find(|h| h.id == id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        f(host);
        self.save(&next)?;
        *hosts = next;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::random_token;

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

    fn host(name: &str, jump: Option<Uuid>) -> Host {
        let mut h = NewHost {
            name: name.to_string(),
            hostname: "h".into(),
            port: 22,
            username: "root".into(),
            auth: crate::model::AuthMethod::Agent,
            ai_policy: AiPolicy::Free,
            ai_file_policy: AiPolicy::Free,
            forward_agent: false,
            agent_keys: Vec::new(),
            forwards: Vec::new(),
            group: String::new(),
            tags: Vec::new(),
            jump_host_id: None,
            options: Default::default(),
        }
        .into_host();
        h.jump_host_id = jump;
        h
    }

    fn open_store(tag: &str) -> (PathBuf, Arc<Vault>, HostStore) {
        let dir = tmp_dir(tag);
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Arc::new(Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();
        let store = HostStore::new(dir.join("hosts.json"), vault.clone());
        store.load().unwrap();
        (dir, vault, store)
    }

    #[test]
    fn relocking_update_locks_dependents_in_the_same_save() {
        let (dir, _vault, store) = open_store("relock");
        let jump = store.add_host(host("jump", None)).unwrap();
        let mid = store.add_host(host("mid", Some(jump.id))).unwrap();
        let leaf = store.add_host(host("leaf", Some(mid.id))).unwrap();
        let other = store.add_host(host("other", None)).unwrap();

        let mut moved = jump.clone();
        moved.hostname = "evil".into();
        moved.ai_policy = AiPolicy::Locked;
        let locked = store.update_relocking(moved, true).unwrap();
        assert_eq!(locked, vec![mid.id, leaf.id]);

        store.clear();
        store.load().unwrap();
        assert_eq!(store.get(jump.id).unwrap().hostname, "evil");
        assert_eq!(store.get(leaf.id).unwrap().ai_policy, AiPolicy::Locked);
        assert_eq!(store.get(mid.id).unwrap().ai_file_policy, AiPolicy::Locked);
        assert_eq!(store.get(other.id).unwrap().ai_policy, AiPolicy::Free);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_save_leaves_the_list_unchanged() {
        let (dir, _vault, store) = open_store("failsave");
        let h = store.add_host(host("a", None)).unwrap();
        let blocker = dir.join("vault.tmp");
        std::fs::create_dir_all(&blocker).unwrap();

        assert!(store.set_policy(h.id, AiPolicy::Locked).is_err());
        assert!(store.add_host(host("b", None)).is_err());
        assert!(store.remove(h.id).is_err());
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.get(h.id).unwrap().ai_policy, AiPolicy::Free);

        std::fs::remove_dir_all(&blocker).unwrap();
        store.set_file_policy(h.id, AiPolicy::Confirm).unwrap();
        store.clear();
        store.load().unwrap();
        let back = store.list();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].ai_policy, AiPolicy::Free, "the failed change never reaches the disk");
        assert_eq!(back[0].ai_file_policy, AiPolicy::Confirm);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_saved_before_load() {
        let dir = tmp_dir("preload");
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Arc::new(Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();
        let store = HostStore::new(dir.join("hosts.json"), vault.clone());
        assert!(store.add_host(host("early", None)).is_err());
        assert!(vault.get_blob(Vault::hosts_blob_id()).unwrap().is_none());

        store.load().unwrap();
        let a = store.add_host(host("a", None)).unwrap();
        store.clear();
        assert!(store.add_host(host("b", None)).is_err());
        store.load().unwrap();
        assert_eq!(store.list().iter().map(|h| h.id).collect::<Vec<_>>(), vec![a.id]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_hosts_are_never_overwritten() {
        let (dir, vault, store) = open_store("unreadable");
        vault.put_blob(Vault::hosts_blob_id(), b"not json").unwrap();
        store.load().unwrap();
        assert!(store.warning().is_some());
        assert!(store.list().is_empty());
        assert!(store.add_host(host("a", None)).is_err());
        assert_eq!(vault.get_blob(Vault::hosts_blob_id()).unwrap().unwrap().as_slice(), b"not json");

        vault.put_blob(Vault::hosts_blob_id(), b"[]").unwrap();
        store.load().unwrap();
        store.add_host(host("a", None)).unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_keeps_jump_hosts_only_within_the_imported_set() {
        let (dir, _vault, store) = open_store("import");
        let existing = store.add_host(host("existing", None)).unwrap();
        let a = host("a", None);
        let b = host("b", Some(a.id));
        let c = host("c", Some(existing.id));
        let clash = host("EXISTING", None);
        let d = host("d", Some(clash.id));

        let (added, skipped, _) = store
            .import(vec![a.clone(), b.clone(), c.clone(), clash.clone(), d.clone()])
            .unwrap();
        assert_eq!(added, vec![a.id, b.id, c.id, d.id]);
        assert_eq!(skipped, 1);
        assert_eq!(store.get(b.id).unwrap().jump_host_id, Some(a.id));
        assert_eq!(store.get(c.id).unwrap().jump_host_id, None);
        assert_eq!(store.get(d.id).unwrap().jump_host_id, None);
        assert!(store.get(clash.id).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_gives_a_known_host_only_the_forwards_it_lacks() {
        let (dir, _vault, store) = open_store("import-forwards");
        let fwd = |port: u16| crate::model::PortForward {
            id: Uuid::new_v4(),
            name: String::new(),
            local_host: "127.0.0.1".into(),
            local_port: port,
            remote_host: "localhost".into(),
            remote_port: 80,
            autostart: true,
            kind: Default::default(),
            start_on_connect: false,
            ai_edited: false,
        };
        let mut mine = host("mine", None);
        mine.forwards = vec![fwd(8080)];
        let mine = store.add_host(mine).unwrap();

        let mut newer = mine.clone();
        newer.name = "renamed elsewhere".into();
        newer.forwards.push(fwd(8080));
        newer.forwards.push(fwd(9090));
        let via = host("via", Some(mine.id));

        let (added, skipped, forwards) = store.import(vec![newer, via.clone()]).unwrap();
        assert_eq!((added, skipped, forwards), (vec![via.id], 1, 1));
        let stored = store.get(mine.id).unwrap();
        assert_eq!(stored.name, "mine");
        assert_eq!(stored.forwards.iter().map(|f| f.local_port).collect::<Vec<_>>(), vec![8080, 9090]);
        assert!(stored.forwards[1].autostart);
        assert_eq!(store.get(via.id).unwrap().jump_host_id, Some(mine.id));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
