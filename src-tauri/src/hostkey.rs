//! Interactive host key verification: asks the user (through the frontend) before
//! trusting a host that is not in known_hosts yet, and tells the frontend when a
//! known host presents a different key.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::Result;
use crate::known_hosts::KnownHostEntry;

const ANSWER_TIMEOUT: Duration = Duration::from_secs(120);
/// Split panes, SFTP next to a terminal or autostarted forwards hit a changed
/// host at nearly the same moment; within this window it is reported once.
const CHANGED_DEDUP: Duration = Duration::from_secs(5);

static APP: OnceLock<AppHandle> = OnceLock::new();
static PENDING: Mutex<Vec<Pending>> = Mutex::new(Vec::new());
static RECENT_CHANGED: Mutex<Vec<(String, u16, String, Instant)>> = Mutex::new(Vec::new());

/// Set once during app setup. Without it (unit tests, headless use) new hosts
/// are trusted on first use like before.
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub accept: bool,
    pub save: bool,
}

const REFUSE: Decision = Decision {
    accept: false,
    save: false,
};

/// One open question to the user. Concurrent connects to the same host with the
/// same key (split panes, SFTP next to a terminal) share it, so the user is
/// asked once and every waiter gets the same answer.
struct Pending {
    id: String,
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
    waiters: Vec<oneshot::Sender<Decision>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingRequest {
    id: String,
    host: String,
    port: u16,
    key_type: String,
    fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
struct SaveFailed<'a> {
    host: &'a str,
    port: u16,
    error: &'a str,
}

#[derive(Debug, Clone, Serialize)]
struct HostKeyRequest<'a> {
    id: &'a str,
    host: &'a str,
    port: u16,
    key_type: &'a str,
    fingerprint: &'a str,
}

/// `key_type` and `fingerprint` describe the key the server presented now;
/// `saved` holds the known_hosts entries that recorded a different key for it
/// (also hashed lines and comma lists, which a search by host name misses).
#[derive(Debug, Clone, Serialize)]
struct HostKeyChanged<'a> {
    host: &'a str,
    port: u16,
    key_type: &'a str,
    fingerprint: &'a str,
    saved: &'a [KnownHostEntry],
}

fn pending() -> std::sync::MutexGuard<'static, Vec<Pending>> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

fn take(id: &str) -> Option<Pending> {
    let mut list = pending();
    let idx = list.iter().position(|p| p.id == id)?;
    Some(list.remove(idx))
}

fn settle(id: &str, decision: Decision) -> bool {
    match take(id) {
        Some(p) => {
            for tx in p.waiters {
                let _ = tx.send(decision);
            }
            true
        }
        None => false,
    }
}

/// Asks the user whether to trust a new host key. Returns None when no UI is
/// attached; a request that is not answered within 120 s counts as refused.
pub async fn ask(host: &str, port: u16, key_type: &str, fingerprint: &str) -> Option<Decision> {
    let app = APP.get()?;
    let (tx, rx) = oneshot::channel();
    let (id, first) = {
        let mut list = pending();
        match list
            .iter_mut()
            .find(|p| p.host == host && p.port == port && p.fingerprint == fingerprint)
        {
            Some(p) => {
                p.waiters.push(tx);
                (p.id.clone(), false)
            }
            None => {
                let id = Uuid::new_v4().to_string();
                list.push(Pending {
                    id: id.clone(),
                    host: host.to_string(),
                    port,
                    key_type: key_type.to_string(),
                    fingerprint: fingerprint.to_string(),
                    waiters: vec![tx],
                });
                (id, true)
            }
        }
    };

    if first {
        let payload = HostKeyRequest {
            id: &id,
            host,
            port,
            key_type,
            fingerprint,
        };
        if let Err(e) = app.emit("hostkey-request", payload) {
            tracing::error!("could not ask about the host key of {host}:{port}: {e}");
            settle(&id, REFUSE);
        }
    }

    match tokio::time::timeout(ANSWER_TIMEOUT, rx).await {
        Ok(Ok(decision)) => Some(decision),
        _ => {
            if settle(&id, REFUSE) {
                tracing::warn!("host key question for {host}:{port} expired, refused");
                let _ = app.emit("hostkey-expired", &id);
            }
            Some(REFUSE)
        }
    }
}

/// True the first time `host:port` with this fingerprint is reported within
/// `CHANGED_DEDUP`.
fn first_report(host: &str, port: u16, fingerprint: &str) -> bool {
    let now = Instant::now();
    let mut recent = RECENT_CHANGED.lock().unwrap_or_else(|e| e.into_inner());
    recent.retain(|(.., at)| now.duration_since(*at) < CHANGED_DEDUP);
    if recent
        .iter()
        .any(|(h, p, f, _)| h == host && *p == port && f == fingerprint)
    {
        return false;
    }
    recent.push((host.to_string(), port, fingerprint.to_string(), now));
    true
}

pub fn notify_changed(
    host: &str,
    port: u16,
    key_type: &str,
    fingerprint: &str,
    saved: &[KnownHostEntry],
) {
    let Some(app) = APP.get() else {
        return;
    };
    if !first_report(host, port, fingerprint) {
        return;
    }
    let payload = HostKeyChanged {
        host,
        port,
        key_type,
        fingerprint,
        saved,
    };
    if let Err(e) = app.emit("hostkey-changed", payload) {
        tracing::error!("could not report the changed host key of {host}:{port}: {e}");
    }
}

pub fn notify_save_failed(host: &str, port: u16, error: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("hostkey-save-failed", SaveFailed { host, port, error });
    }
}

#[tauri::command]
pub fn hostkey_pending() -> Vec<PendingRequest> {
    pending()
        .iter()
        .map(|p| PendingRequest {
            id: p.id.clone(),
            host: p.host.clone(),
            port: p.port,
            key_type: p.key_type.clone(),
            fingerprint: p.fingerprint.clone(),
        })
        .collect()
}

#[tauri::command]
pub async fn hostkey_respond(id: String, accept: bool, save: bool) -> Result<()> {
    if !settle(&id, Decision { accept, save }) {
        tracing::info!("host key answer for {id} arrived after the request ended");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn without_ui_nobody_is_asked() {
        assert_eq!(ask("h", 22, "ssh-ed25519", "SHA256:x").await, None);
    }

    #[test]
    fn settle_answers_every_waiter_once() {
        let (tx1, mut rx1) = oneshot::channel();
        let (tx2, mut rx2) = oneshot::channel();
        pending().push(Pending {
            id: "t1".into(),
            host: "h".into(),
            port: 22,
            key_type: "ssh-ed25519".into(),
            fingerprint: "fp".into(),
            waiters: vec![tx1, tx2],
        });
        let yes = Decision {
            accept: true,
            save: false,
        };
        assert!(settle("t1", yes));
        assert!(!settle("t1", REFUSE));
        assert_eq!(rx1.try_recv().unwrap(), yes);
        assert_eq!(rx2.try_recv().unwrap(), yes);
    }

    #[test]
    fn changed_keys_are_reported_once_per_window() {
        assert!(first_report("dedup.test", 22, "fp1"));
        assert!(!first_report("dedup.test", 22, "fp1"));
        assert!(first_report("dedup.test", 22, "fp2"));
        assert!(first_report("dedup.test", 2222, "fp1"));
    }
}
