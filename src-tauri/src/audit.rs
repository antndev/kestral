
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::vault::Vault;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub host_id: String,
    pub host_name: String,
    pub command: String,
    pub decision: String,
    pub exit_status: Option<i32>,
    pub success: bool,
    pub detail: Option<String>,
}

const MAX_ENTRIES: usize = 5000;
const MAX_LINES: usize = 20_000;

pub struct AuditLog {
    entries: Mutex<Vec<AuditEntry>>,
    path: PathBuf,
    vault: Arc<Vault>,
    // Approximate on-disk line count, so we can compact a long-running session
    // instead of only trimming the file at the next startup.
    line_count: AtomicUsize,
    // Serializes all disk mutation, so a concurrent append can never interleave
    // with a compaction's rewrite-and-rename and be lost.
    disk_lock: Mutex<()>,
}

impl AuditLog {
    pub fn new(path: PathBuf, vault: Arc<Vault>) -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            path,
            vault,
            line_count: AtomicUsize::new(0),
            disk_lock: Mutex::new(()),
        }
    }

    pub fn load(&self) {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => {
                tracing::error!("Audit log not readable: {e}");
                return;
            }
        };

        let lines: Vec<&str> = raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let total = lines.len();
        let mut out = Vec::with_capacity(total.min(MAX_ENTRIES));
        let mut broken = 0usize;
        for line in &lines[total.saturating_sub(MAX_ENTRIES)..] {
            match self.vault.open_envelope(line.as_bytes()) {
                Ok((plain, _)) => match serde_json::from_slice::<AuditEntry>(&plain) {
                    Ok(entry) => out.push(entry),
                    Err(_) => broken += 1,
                },
                Err(_) => broken += 1,
            }
        }
        if broken > 0 {
            tracing::warn!("{broken} audit lines could not be read");
        }

        tracing::info!("{} audit entries loaded", out.len());
        *self.entries.lock().unwrap() = out;

        self.line_count.store(total, Ordering::SeqCst);
        if total > MAX_LINES {
            self.compact();
        }
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &self,
        host_id: String,
        host_name: String,
        command: String,
        decision: &str,
        exit_status: Option<i32>,
        success: bool,
        detail: Option<String>,
    ) {
        let entry = AuditEntry {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            host_id,
            host_name,
            command,
            decision: decision.to_string(),
            exit_status,
            success,
            detail,
        };
        tracing::info!(
            target: "audit",
            id = %entry.id,
            host = %entry.host_name,
            decision = %entry.decision,
            success = entry.success,
            "audit entry"
        );

        // Hold the disk lock across the append and any compaction, so no other
        // thread's append lands between a compaction's snapshot and its rename.
        let _disk = self.disk_lock.lock().unwrap();
        self.append(&entry);

        {
            let mut entries = self.entries.lock().unwrap();
            entries.push(entry);
            let len = entries.len();
            if len > MAX_ENTRIES {
                entries.drain(0..len - MAX_ENTRIES);
            }
        }

        // Keep the on-disk file bounded during a long-running session, not only
        // at the next startup.
        if self.line_count.fetch_add(1, Ordering::SeqCst) + 1 > MAX_LINES {
            self.compact_locked();
        }
    }

    fn append(&self, entry: &AuditEntry) {
        use std::io::Write;
        let line = match self.seal_line(entry) {
            Some(l) => l,
            None => return,
        };
        let mut opts = std::fs::OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let opened = opts.open(&self.path);
        match opened {
            Ok(mut f) => {
                let _ = crate::util::restrict(&f);
                if let Err(e) = f.write_all(line.as_bytes()) {
                    tracing::error!("Audit entry not written: {e}");
                }
            }
            Err(e) => tracing::error!("Audit log could not be opened: {e}"),
        }
    }

    fn seal_line(&self, entry: &AuditEntry) -> Option<String> {
        let json = serde_json::to_vec(entry).ok()?;
        match self.vault.seal_envelope(&json) {
            Ok(sealed) => {
                let compact: String = String::from_utf8_lossy(&sealed)
                    .split_whitespace()
                    .collect();
                Some(format!("{compact}\n"))
            }
            Err(e) => {
                tracing::warn!("Audit entry could not be encrypted ({e}), kept in memory only");
                None
            }
        }
    }

    fn compact(&self) {
        let _disk = self.disk_lock.lock().unwrap();
        self.compact_locked();
    }

    // Caller must hold disk_lock.
    fn compact_locked(&self) {
        let entries = self.entries.lock().unwrap().clone();
        let mut buf = String::new();
        for e in &entries {
            if let Some(line) = self.seal_line(e) {
                buf.push_str(&line);
            }
        }
        if let Err(e) = crate::util::atomic_write(&self.path, buf.as_bytes()) {
            tracing::error!("Compacting the audit log failed: {e}");
        } else {
            self.line_count.store(entries.len(), Ordering::SeqCst);
            tracing::info!("audit log compacted to {} entries", entries.len());
        }
    }

    pub fn list(&self) -> Vec<AuditEntry> {
        self.entries.lock().unwrap().clone()
    }

    pub fn since(&self, after: Option<&str>, limit: Option<usize>) -> (bool, Vec<AuditEntry>) {
        let entries = self.entries.lock().unwrap();
        match after.and_then(|id| entries.iter().rposition(|e| e.id == id)) {
            Some(i) => (false, entries[i + 1..].to_vec()),
            None => {
                let from = limit.map_or(0, |n| entries.len().saturating_sub(n));
                (true, entries[from..].to_vec())
            }
        }
    }

    pub fn list_ai(&self) -> Vec<AuditEntry> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.decision != "user")
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{random_token, SecretStore};

    #[test]
    fn survives_restart_and_password_change() {
        let dir = std::env::temp_dir().join(format!("kestral_audit_{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let log_path = dir.join("audit.log");
        let vault = Arc::new(crate::vault::Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();

        let log = AuditLog::new(log_path.clone(), vault.clone());
        log.record("h1".into(), "homelab".into(), "uptime".into(), "allowed", Some(0), true, None);
        log.record("h1".into(), "homelab".into(), "rm -rf /".into(), "denied", None, false, None);
        assert_eq!(log.list().len(), 2);

        let again = AuditLog::new(log_path.clone(), vault.clone());
        assert!(again.list().is_empty(), "vor dem Entsperren leer");
        again.load();
        assert_eq!(again.list().len(), 2, "nach dem Entsperren wieder da");
        assert_eq!(again.list()[1].command, "rm -rf /");

        vault.change_master("pw", "neu").unwrap();
        let third = AuditLog::new(log_path.clone(), vault.clone());
        third.load();
        assert_eq!(third.list().len(), 2, "survives the password change");

        third.clear();
        assert!(third.list().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
