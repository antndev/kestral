
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
const DENIAL_WINDOW: Duration = Duration::from_secs(60);

pub struct AuditLog {
    entries: Mutex<Vec<AuditEntry>>,
    pending: Mutex<Vec<AuditEntry>>,
    path: PathBuf,
    vault: Arc<Vault>,
    // Approximate on-disk line count, so we can compact a long-running session
    // instead of only trimming the file at the next startup.
    line_count: AtomicUsize,
    // Serializes all disk mutation, so a concurrent append can never interleave
    // with a compaction's rewrite-and-rename and be lost.
    disk_lock: Mutex<()>,
    denials: Mutex<HashMap<(String, String), (Instant, u32)>>,
}

impl AuditLog {
    pub fn new(path: PathBuf, vault: Arc<Vault>) -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            pending: Mutex::new(Vec::new()),
            path,
            vault,
            line_count: AtomicUsize::new(0),
            disk_lock: Mutex::new(()),
            denials: Mutex::new(HashMap::new()),
        }
    }

    pub fn load(&self) {
        let _disk = self.disk_lock.lock().unwrap();
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
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

        let pending = std::mem::take(&mut *self.pending.lock().unwrap());
        let mut total = total;
        for entry in pending {
            if self.append(&entry) {
                total += 1;
            } else {
                self.defer(entry.clone());
            }
            out.push(entry);
        }
        let len = out.len();
        if len > MAX_ENTRIES {
            out.drain(0..len - MAX_ENTRIES);
        }
        *self.entries.lock().unwrap() = out;

        self.line_count.store(total, Ordering::SeqCst);
        if total > MAX_LINES {
            self.compact_locked();
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
        let written = self.append(&entry);
        if !written {
            self.defer(entry.clone());
        }

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
        if written && self.line_count.fetch_add(1, Ordering::SeqCst) + 1 > MAX_LINES {
            self.compact_locked();
        }
    }

    pub fn record_denied(&self, scope: &str, host_id: &str, host_name: &str, command: &str, reason: &str) {
        let suppressed = {
            let mut denials = self.denials.lock().unwrap();
            let key = (scope.to_string(), reason.to_string());
            if let Some((at, count)) = denials.get_mut(&key) {
                if at.elapsed() < DENIAL_WINDOW {
                    *count += 1;
                    return;
                }
            }
            denials.retain(|_, (at, count)| *count > 0 || at.elapsed() < DENIAL_WINDOW);
            denials.insert(key, (Instant::now(), 0)).map_or(0, |(_, n)| n)
        };
        let detail = if suppressed > 0 {
            format!("{reason}, {suppressed} more not logged")
        } else {
            reason.to_string()
        };
        self.record(
            host_id.to_string(),
            host_name.to_string(),
            command.to_string(),
            "denied",
            None,
            false,
            Some(detail),
        );
    }

    fn defer(&self, entry: AuditEntry) {
        let mut pending = self.pending.lock().unwrap();
        pending.push(entry);
        let len = pending.len();
        if len > MAX_ENTRIES {
            pending.drain(0..len - MAX_ENTRIES);
        }
    }

    fn append(&self, entry: &AuditEntry) -> bool {
        use std::io::Write;
        let line = match self.seal_line(entry) {
            Some(l) => l,
            None => return false,
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
                    return false;
                }
                true
            }
            Err(e) => {
                tracing::error!("Audit log could not be opened: {e}");
                false
            }
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
                tracing::warn!("Audit entry could not be encrypted ({e}), written after the next unlock");
                None
            }
        }
    }

    // Caller must hold disk_lock.
    fn compact_locked(&self) {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Compacting the audit log failed: {e}");
                return;
            }
        };
        let lines: Vec<&str> = raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let keep = &lines[lines.len().saturating_sub(MAX_ENTRIES)..];
        let mut buf = String::with_capacity(raw.len());
        for line in keep {
            buf.push_str(line);
            buf.push('\n');
        }
        if let Err(e) = crate::util::atomic_write(&self.path, buf.as_bytes()) {
            tracing::error!("Compacting the audit log failed: {e}");
        } else {
            self.line_count.store(keep.len(), Ordering::SeqCst);
            tracing::info!("audit log compacted to {} entries", keep.len());
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

    #[test]
    fn locked_vault_never_loses_or_truncates_entries() {
        let dir = std::env::temp_dir().join(format!("kestral_audit_{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let log_path = dir.join("audit.log");
        let vault = Arc::new(crate::vault::Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();
        let lines = || std::fs::read_to_string(&log_path).unwrap().lines().count();

        let log = AuditLog::new(log_path.clone(), vault.clone());
        log.record("h1".into(), "homelab".into(), "uptime".into(), "allowed", Some(0), true, None);
        log.record("h1".into(), "homelab".into(), "df -h".into(), "allowed", Some(0), true, None);
        assert_eq!(lines(), 2);

        vault.lock();
        log.clear();
        log.compact_locked();
        assert_eq!(lines(), 2, "compaction while locked keeps the file");

        log.line_count.store(MAX_LINES, Ordering::SeqCst);
        log.record("h1".into(), "homelab".into(), "reboot".into(), "agent", None, true, None);
        assert_eq!(lines(), 2, "nothing written while locked");
        assert_eq!(log.line_count.load(Ordering::SeqCst), MAX_LINES, "no count for an unwritten line");

        vault.unlock("pw").unwrap();
        log.load();
        assert_eq!(lines(), 3, "written after the unlock");
        assert_eq!(log.list().len(), 3);
        assert_eq!(log.list()[2].command, "reboot");
        assert!(log.pending.lock().unwrap().is_empty());

        let again = AuditLog::new(log_path.clone(), vault.clone());
        again.load();
        assert_eq!(again.list().len(), 3);
        assert_eq!(again.list()[2].command, "reboot");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn repeated_denials_are_throttled() {
        let dir = std::env::temp_dir().join(format!("kestral_audit_{}", random_token()));
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Arc::new(crate::vault::Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();
        let log = AuditLog::new(dir.join("audit.log"), vault.clone());

        for _ in 0..50 {
            log.record_denied("", "h1", "homelab", "uptime", "AI off");
        }
        log.record_denied("", "h2", "other", "ls", "AI off");
        log.record_denied("h2", "h2", "other", "ls", "host locked");
        log.record_denied("h2", "h2", "other", "ls", "host locked");
        assert_eq!(log.list().len(), 2);

        let past = Instant::now().checked_sub(DENIAL_WINDOW + Duration::from_secs(1)).unwrap();
        for (at, _) in log.denials.lock().unwrap().values_mut() {
            *at = past;
        }
        log.record_denied("", "h1", "homelab", "uptime", "AI off");
        let entries = log.list();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[2].detail.as_deref(), Some("AI off, 50 more not logged"));
        assert_eq!(entries[2].decision, "denied");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
