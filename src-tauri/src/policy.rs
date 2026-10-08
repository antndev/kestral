use std::path::PathBuf;
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::model::AiPolicy;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AiCaps {
    pub list_hosts: bool,
    pub manage_hosts: bool,
    pub list_snippets: bool,
    pub manage_snippets: bool,
    pub list_secrets: bool,
    pub audit_log: bool,
}

impl Default for AiCaps {
    fn default() -> Self {
        Self {
            list_hosts: true,
            manage_hosts: false,
            list_snippets: true,
            manage_snippets: false,
            list_secrets: true,
            audit_log: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeniedReason {
    AiInactive,
    HostLocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Allowed,
    NeedsApproval,
    Denied(DeniedReason),
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStatus {
    pub active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub default_minutes: i64,
}

struct Inner {
    enabled: bool,
    expires_at: Option<DateTime<Utc>>,
    default_minutes: i64,
    caps: AiCaps,
    protected: Vec<String>,
}

pub struct PolicyEngine {
    inner: Mutex<Inner>,
    state_path: PathBuf,
    protected_path: PathBuf,
    caps_path: PathBuf,
}

/// Paths the AI must never write to, unless the user changes the list. These
/// are the classic footholds: adding a key to authorized_keys or rewriting the
/// SSH client config.
fn default_protected() -> Vec<String> {
    vec![
        ".ssh/authorized_keys".to_string(),
        ".ssh/authorized_keys2".to_string(),
        "administrators_authorized_keys".to_string(),
        ".ssh/config".to_string(),
    ]
}

const PROTECTED_VERSION: u32 = 2;
const ADDED_IN_V2: [&str; 2] = [".ssh/authorized_keys2", "administrators_authorized_keys"];

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredProtected {
    Versioned { version: u32, paths: Vec<String> },
    Legacy(Vec<String>),
}

#[derive(Serialize)]
struct SavedProtected<'a> {
    version: u32,
    paths: &'a [String],
}

fn load_protected(path: &std::path::Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return default_protected();
    };
    let (version, mut paths) = match serde_json::from_str::<StoredProtected>(&raw) {
        Ok(StoredProtected::Versioned { version, paths }) => (version, paths),
        Ok(StoredProtected::Legacy(paths)) => (1, paths),
        Err(_) => return default_protected(),
    };
    if version < PROTECTED_VERSION {
        for added in ADDED_IN_V2 {
            if !paths.iter().any(|p| p.trim().eq_ignore_ascii_case(added)) {
                paths.push(added.to_string());
            }
        }
        save_protected(path, &paths);
    }
    paths
}

fn save_protected(path: &std::path::Path, paths: &[String]) {
    if let Ok(json) = serde_json::to_string_pretty(&SavedProtected { version: PROTECTED_VERSION, paths }) {
        let _ = std::fs::write(path, json);
    }
}

/// Canonicalize a path the way the SFTP/OpenSSH server would before it opens the
/// file: forward slashes, no leading `~/`, and no empty / `.` / `..` segments.
/// Without this an AI could dodge the guard with `.ssh//authorized_keys` or
/// `.ssh/./authorized_keys`, which still resolve to the real file on the host.
fn normalize_path(p: &str) -> String {
    let p = p.replace('\\', "/");
    let body = p.strip_prefix("~/").unwrap_or(&p);
    let absolute = body.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in body.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Collapse `\` to `/` and repeated `/` and `/./` segments, so slash-variant
/// paths in free command text still match a protected pattern.
fn collapse_slashes(text: &str) -> String {
    let mut out = text.replace('\\', "/");
    loop {
        let next = out.replace("/./", "/").replace("//", "/");
        if next == out {
            return next;
        }
        out = next;
    }
}

/// True if `path` is covered by the protection `pattern` (both normalized). A
/// `/`-anchored pattern matches from the root; otherwise it matches as a trailing
/// path segment, and a directory pattern protects everything inside it.
fn path_matches(path: &str, pattern: &str) -> bool {
    let path = normalize_path(path).to_lowercase();
    let pat = normalize_path(pattern.trim()).to_lowercase();
    if pat.is_empty() {
        return false;
    }
    if let Some(abs) = pat.strip_prefix('/') {
        let abs = format!("/{abs}");
        path == abs || path.starts_with(&format!("{abs}/"))
    } else {
        path == pat
            || path.ends_with(&format!("/{pat}"))
            || path.starts_with(&format!("{pat}/"))
            || path.contains(&format!("/{pat}/"))
    }
}

impl PolicyEngine {
    const MAX_MINUTES: i64 = 24 * 60;

    pub fn new(state_path: PathBuf, protected_path: PathBuf, caps_path: PathBuf) -> Self {
        // Persisted as an absolute expiry ("until <RFC3339>"), "forever" for no
        // limit, or "off". Storing an absolute time means a restart neither
        // resets the countdown nor revives an already-elapsed grant.
        let raw = std::fs::read_to_string(&state_path).unwrap_or_default();
        let saved = raw.trim();
        let (enabled, expires_at) = if saved == "forever" {
            (true, None)
        } else if let Some(ts) = saved.strip_prefix("until ") {
            match DateTime::parse_from_rfc3339(ts.trim()) {
                Ok(dt) if dt.with_timezone(&Utc) > Utc::now() => (true, Some(dt.with_timezone(&Utc))),
                _ => (false, None),
            }
        } else if let Some(rest) = saved.strip_prefix("on") {
            // Back-compat with the earlier "on <minutes>" format.
            let mins = rest.trim().parse::<i64>().unwrap_or(30);
            if mins <= 0 {
                (true, None)
            } else {
                (true, Some(Utc::now() + Duration::minutes(mins.clamp(1, Self::MAX_MINUTES))))
            }
        } else {
            (false, None)
        };
        let protected = load_protected(&protected_path);
        // Persisted like the rest of the policy, so a user narrowing what the AI
        // may read is not silently widened back to the permissive defaults on
        // the next restart.
        let caps = match std::fs::read_to_string(&caps_path) {
            Ok(s) => serde_json::from_str::<AiCaps>(&s).unwrap_or_default(),
            Err(_) => AiCaps::default(),
        };
        Self {
            inner: Mutex::new(Inner {
                enabled,
                expires_at,
                default_minutes: 30,
                caps,
                protected,
            }),
            state_path,
            protected_path,
            caps_path,
        }
    }

    pub fn protected_paths(&self) -> Vec<String> {
        self.inner.lock().unwrap().protected.clone()
    }

    pub fn set_protected_paths(&self, paths: Vec<String>) {
        let cleaned: Vec<String> = paths
            .into_iter()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();
        save_protected(&self.protected_path, &cleaned);
        self.inner.lock().unwrap().protected = cleaned;
    }

    /// True if AI writes to `path` are blocked by the protection list.
    pub fn is_app_data(&self, path: &std::path::Path) -> bool {
        let Some(dir) = self.state_path.parent() else {
            return false;
        };
        let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let dir = dir.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
        let p = path.to_string_lossy().replace('\\', "/").to_lowercase();
        !dir.is_empty() && (p == dir || p.starts_with(&format!("{dir}/")))
    }

    pub fn is_protected(&self, path: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.protected.iter().any(|pat| path_matches(path, pat))
    }

    /// Best-effort tripwire for commands: true if a protected path appears in
    /// the command text. Catches the obvious `>> ~/.ssh/authorized_keys` route;
    /// a command is arbitrary, so this is a guardrail, not a sandbox. The text is
    /// slash-normalised first so `//` and `/./` variants (which the SFTP guard
    /// already blocks) cannot slip a protected path past it.
    pub fn mentions_protected(&self, text: &str) -> bool {
        let normalized = collapse_slashes(text).to_lowercase();
        let inner = self.inner.lock().unwrap();
        inner
            .protected
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .any(|p| normalized.contains(&collapse_slashes(p).to_lowercase()))
    }

    fn persist_state(&self, inner: &Inner) {
        let s = if !inner.enabled {
            "off".to_string()
        } else if inner.expires_at.is_none() {
            "forever".to_string()
        } else {
            format!("until {}", inner.expires_at.unwrap().to_rfc3339())
        };
        let _ = std::fs::write(&self.state_path, s);
    }

    pub fn enable(&self, minutes: Option<i64>) {
        let mut inner = self.inner.lock().unwrap();
        let mins = minutes.unwrap_or(inner.default_minutes);
        inner.enabled = true;
        // 0 or less means no automatic time limit.
        if mins <= 0 {
            inner.expires_at = None;
        } else {
            inner.expires_at = Some(Utc::now() + Duration::minutes(mins.clamp(1, Self::MAX_MINUTES)));
        }
        self.persist_state(&inner);
    }

    pub fn disable(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.enabled = false;
        inner.expires_at = None;
        self.persist_state(&inner);
    }

    fn check_active(inner: &mut Inner) -> bool {
        if !inner.enabled {
            return false;
        }
        match inner.expires_at {
            None => true, // no time limit, stays on until turned off
            Some(exp) if Utc::now() < exp => true,
            Some(_) => {
                inner.enabled = false;
                inner.expires_at = None;
                false
            }
        }
    }

    /// Check whether AI is active, and if the grant just lapsed, write the off
    /// state to disk so a restart cannot revive it.
    fn tick(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let was_enabled = inner.enabled;
        let active = Self::check_active(&mut inner);
        if was_enabled && !active {
            self.persist_state(&inner);
        }
        active
    }

    pub fn is_active(&self) -> bool {
        self.tick()
    }

    pub fn caps(&self) -> AiCaps {
        self.inner.lock().unwrap().caps
    }

    pub fn set_caps(&self, caps: AiCaps) {
        self.inner.lock().unwrap().caps = caps;
        if let Ok(json) = serde_json::to_string_pretty(&caps) {
            let _ = std::fs::write(&self.caps_path, json);
        }
    }

    pub fn status(&self) -> AiStatus {
        let active = self.tick();
        let inner = self.inner.lock().unwrap();
        AiStatus {
            active,
            expires_at: inner.expires_at,
            default_minutes: inner.default_minutes,
        }
    }

    pub fn gate(&self, host_policy: AiPolicy) -> Gate {
        if !self.is_active() {
            return Gate::Denied(DeniedReason::AiInactive);
        }
        match host_policy {
            AiPolicy::Locked => Gate::Denied(DeniedReason::HostLocked),
            AiPolicy::Confirm => Gate::NeedsApproval,
            AiPolicy::Free => Gate::Allowed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine(protected: &[&str]) -> PolicyEngine {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pp = dir.join("protected.json");
        std::fs::write(&pp, serde_json::to_string(protected).unwrap()).unwrap();
        PolicyEngine::new(dir.join("ai_state"), pp, dir.join("caps.json"))
    }

    #[test]
    fn legacy_list_gains_new_defaults_once() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pp = dir.join("protected.json");
        std::fs::write(&pp, r#"[".ssh/authorized_keys", "/srv/secret"]"#).unwrap();
        let p = PolicyEngine::new(dir.join("ai_state"), pp.clone(), dir.join("caps.json"));
        assert!(p.is_protected("/home/x/.ssh/authorized_keys2"));
        assert!(p.is_protected("/srv/secret"));
        p.set_protected_paths(vec![".ssh/authorized_keys".into()]);
        let p2 = PolicyEngine::new(dir.join("ai_state"), pp, dir.join("caps.json"));
        assert_eq!(p2.protected_paths(), vec![".ssh/authorized_keys".to_string()]);
    }

    #[test]
    fn protects_ssh_files_across_home_directories() {
        let p = engine(&[".ssh/authorized_keys", ".ssh/config"]);
        assert!(p.is_protected("/home/anton/.ssh/authorized_keys"));
        assert!(p.is_protected("/root/.ssh/authorized_keys"));
        assert!(p.is_protected("~/.ssh/config"));
        assert!(p.is_protected(".ssh/config"));
        // Unrelated files and look-alikes are not protected.
        assert!(!p.is_protected("/home/anton/.ssh/known_hosts"));
        assert!(!p.is_protected("/etc/myssh/config"));
    }

    #[test]
    fn absolute_and_directory_patterns() {
        let p = engine(&["/etc/passwd", ".ssh"]);
        assert!(p.is_protected("/etc/passwd"));
        assert!(!p.is_protected("/etc/passwd.bak"));
        assert!(p.is_protected("/home/x/.ssh"));
        assert!(p.is_protected("/home/x/.ssh/id_ed25519"));
    }

    #[test]
    fn command_tripwire_matches_written_paths() {
        let p = engine(&[".ssh/authorized_keys"]);
        assert!(p.mentions_protected("echo key >> ~/.ssh/authorized_keys"));
        assert!(p.mentions_protected("tee -a /root/.ssh/authorized_keys"));
        assert!(!p.mentions_protected("cat /etc/hostname"));
    }

    #[test]
    fn command_tripwire_survives_slash_variants() {
        let p = engine(&[".ssh/authorized_keys"]);
        assert!(p.mentions_protected("echo k >> ~/.ssh//authorized_keys"));
        assert!(p.mentions_protected("tee ~/.ssh/./authorized_keys"));
        assert!(p.mentions_protected(r"type C:\Users\x\.ssh\authorized_keys"));
        assert!(!p.mentions_protected("echo hello world"));
    }

    #[test]
    fn normalized_path_variants_do_not_bypass_protection() {
        let p = engine(&[".ssh/authorized_keys"]);
        assert!(p.is_protected("/home/x/.ssh//authorized_keys"));
        assert!(p.is_protected("/home/x/.ssh/./authorized_keys"));
        assert!(p.is_protected("~/.ssh/authorized_keys"));
        assert!(p.is_protected("/home/x/.ssh/../.ssh/authorized_keys"));
        assert!(p.is_protected(".ssh/authorized_keys"));
        assert!(!p.is_protected("/home/x/.ssh/known_hosts"));
    }

    #[test]
    fn bounded_grant_persists_absolute_expiry() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join("ai_state");
        let prot = dir.join("protected.json");

        let p = PolicyEngine::new(state.clone(), prot.clone(), dir.join("caps.json"));
        p.enable(Some(30));
        let exp = p.status().expires_at.expect("bounded grant has an expiry");

        // Reopening restores the same expiry, not a fresh full window.
        let p2 = PolicyEngine::new(state.clone(), prot.clone(), dir.join("caps.json"));
        assert!(p2.is_active());
        assert_eq!(exp, p2.status().expires_at.expect("expiry restored"));

        // An already-elapsed grant restores as off, never revived.
        std::fs::write(
            &state,
            format!("until {}", (Utc::now() - Duration::minutes(1)).to_rfc3339()),
        )
        .unwrap();
        let p3 = PolicyEngine::new(state, prot, dir.join("caps.json"));
        assert!(!p3.is_active());
    }

    #[test]
    fn no_time_limit_stays_active_and_persists() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join("ai_state");
        let prot = dir.join("protected.json");

        let p = PolicyEngine::new(state.clone(), prot.clone(), dir.join("caps.json"));
        p.enable(Some(0));
        assert!(p.is_active());
        assert!(p.status().expires_at.is_none());

        // Restored as no-limit after a restart.
        let p2 = PolicyEngine::new(state, prot, dir.join("caps.json"));
        assert!(p2.is_active());
        assert!(p2.status().expires_at.is_none());

        // Turning it off by hand still works.
        p2.disable();
        assert!(!p2.is_active());
    }

    #[test]
    fn defaults_apply_when_no_file_exists() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = PolicyEngine::new(dir.join("ai_state"), dir.join("missing.json"), dir.join("caps.json"));
        assert!(p.is_protected("/root/.ssh/authorized_keys"));
        assert!(p.is_protected("/home/u/.ssh/config"));
    }

    #[test]
    fn defaults_cover_alternate_key_files() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = PolicyEngine::new(dir.join("ai_state"), dir.join("missing.json"), dir.join("caps.json"));
        assert!(p.is_protected("/root/.ssh/authorized_keys2"));
        assert!(p.is_protected("~/.ssh/authorized_keys2"));
        assert!(p.is_protected("/C:/ProgramData/ssh/administrators_authorized_keys"));
        assert!(p.is_protected(r"C:\PROGRA~3\ssh\Administrators_Authorized_Keys"));
        assert!(p.mentions_protected(r"Add-Content C:\ProgramData\ssh\Administrators_Authorized_Keys key"));
        assert!(!p.is_protected("/home/u/.ssh/known_hosts"));
    }
}
