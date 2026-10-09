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
    vec![".ssh/authorized_keys".to_string(), ".ssh/config".to_string()]
}

const PROTECTED_VERSION: u32 = 3;
const KEY_FILE_COMPANIONS: [&str; 2] = [".ssh/authorized_keys2", "administrators_authorized_keys"];

fn with_companions(pattern: &str) -> Vec<&str> {
    let norm = collapse_slashes(pattern.trim()).to_lowercase();
    if norm.trim_start_matches("~/").trim_start_matches('/') == ".ssh/authorized_keys" {
        let mut out = vec![pattern];
        out.extend(KEY_FILE_COMPANIONS);
        out
    } else {
        vec![pattern]
    }
}

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
        if version == 2 {
            paths.retain(|p| !KEY_FILE_COMPANIONS.iter().any(|c| p.trim().eq_ignore_ascii_case(c)));
        }
        save_protected(path, &paths);
    }
    paths
}

fn save_protected(path: &std::path::Path, paths: &[String]) {
    if let Ok(json) = serde_json::to_string_pretty(&SavedProtected { version: PROTECTED_VERSION, paths }) {
        let _ = crate::util::atomic_write(path, json.as_bytes());
    }
}

/// Canonicalize a path the way the SFTP/OpenSSH server would before it opens the
/// file: forward slashes, no leading `~/`, and no empty / `.` / `..` segments.
/// Without this an AI could dodge the guard with `.ssh//authorized_keys` or
/// `.ssh/./authorized_keys`, which still resolve to the real file on the host.
fn normalize_path(p: &str) -> String {
    let (absolute, segs) = path_segments(p, true);
    let joined = segs.join("/");
    if absolute {
        format!("/{joined}")
    } else {
        joined
    }
}

fn path_segments(p: &str, dotted_parent: bool) -> (bool, Vec<String>) {
    let p = p.replace('\\', "/");
    let body = p.strip_prefix("~/").unwrap_or(&p);
    let absolute = body.starts_with('/');
    let mut out: Vec<String> = Vec::new();
    for seg in body.split('/') {
        let clean = seg.split(':').next().unwrap_or("").trim_end_matches(['.', ' ']);
        match (seg, clean) {
            ("" | ".", _) => {}
            ("..", _) => {
                out.pop();
            }
            (s, "") if dotted_parent && s.starts_with("..") => {
                out.pop();
            }
            (_, "") => {}
            (_, c) => out.push(c.to_string()),
        }
    }
    (absolute, out)
}

fn short_base(name: &str) -> String {
    let name = name.trim_start_matches('.');
    let stem = match name.rfind('.') {
        Some(i) if i > 0 => &name[..i],
        _ => name,
    };
    stem.chars().filter(|c| *c != '.' && *c != ' ').collect()
}

fn short_name_of(seg: &str, name: &str) -> bool {
    let Some((prefix, rest)) = seg.split_once('~') else {
        return false;
    };
    let digits = rest.split('.').next().unwrap_or("");
    if prefix.is_empty() || prefix.len() > 6 || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let base = short_base(name);
    base.starts_with(prefix)
        || (prefix.len() == 6
            && prefix.is_char_boundary(2)
            && base.starts_with(&prefix[..2])
            && prefix[2..].bytes().all(|b| b.is_ascii_hexdigit()))
}

fn segment_matches(seg: &str, pat: &str) -> bool {
    seg == pat || short_name_of(seg, pat)
}

fn segments_match(path: &[String], pat: &[String], anchored: bool) -> bool {
    if path.len() < pat.len() {
        return false;
    }
    let at = |i: usize| path[i..i + pat.len()].iter().zip(pat).all(|(s, p)| segment_matches(s, p));
    if anchored {
        at(0)
    } else {
        (0..=path.len() - pat.len()).any(at)
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
    let (anchored, pat) = path_segments(&pattern.trim().to_lowercase(), true);
    if pat.is_empty() {
        return anchored && normalize_path(path) == "/";
    }
    let lower = path.to_lowercase();
    [true, false].into_iter().any(|dotted_parent| {
        let (absolute, segs) = path_segments(&lower, dotted_parent);
        (absolute || !anchored) && segments_match(&segs, &pat, anchored)
    })
}

#[cfg(unix)]
fn file_id(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(windows)]
fn file_id(path: &std::path::Path) -> Option<(u64, u64)> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetFileInformationByHandle(file: *mut std::ffi::c_void, info: *mut [u32; 13]) -> i32;
    }
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    let mut info = [0u32; 13];
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return None;
    }
    Some((u64::from(info[7]), (u64::from(info[11]) << 32) | u64::from(info[12])))
}

#[cfg(not(any(unix, windows)))]
fn file_id(_path: &std::path::Path) -> Option<(u64, u64)> {
    None
}

fn path_text(path: &std::path::Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text);
    text.trim_end_matches('/').to_lowercase()
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
        let mut inner = self.inner.lock().unwrap();
        save_protected(&self.protected_path, &cleaned);
        inner.protected = cleaned;
    }

    /// True if AI writes to `path` are blocked by the protection list.
    pub fn is_app_data(&self, path: &std::path::Path) -> bool {
        let Some(dir) = self.state_path.parent().filter(|d| !d.as_os_str().is_empty()) else {
            return false;
        };
        let canon = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let dir_text = path_text(&canon);
        let p = path_text(path);
        if !dir_text.is_empty() && (p == dir_text || p.starts_with(&format!("{dir_text}/"))) {
            return true;
        }
        let Some(dir_id) = file_id(dir) else {
            return false;
        };
        if path.ancestors().any(|a| !a.as_os_str().is_empty() && file_id(a) == Some(dir_id)) {
            return true;
        }
        let Some(target) = file_id(path) else {
            return false;
        };
        std::fs::read_dir(dir).is_ok_and(|entries| entries.flatten().any(|e| file_id(&e.path()) == Some(target)))
    }

    pub fn is_protected(&self, path: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        inner.protected.iter().flat_map(|p| with_companions(p)).any(|pat| path_matches(path, pat))
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
            .flat_map(with_companions)
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
        let _ = crate::util::atomic_write(&self.state_path, s.as_bytes());
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
        let mut inner = self.inner.lock().unwrap();
        inner.caps = caps;
        if let Ok(json) = serde_json::to_string_pretty(&caps) {
            let _ = crate::util::atomic_write(&self.caps_path, json.as_bytes());
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
    fn v2_list_drops_the_auto_added_companions_once() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pp = dir.join("protected.json");
        std::fs::write(&pp, r#"{"version":2,"paths":[".ssh/authorized_keys",".ssh/config",".ssh/authorized_keys2","administrators_authorized_keys","/srv/secret"]}"#).unwrap();
        let p = PolicyEngine::new(dir.join("ai_state"), pp.clone(), dir.join("caps.json"));
        assert_eq!(p.protected_paths(), vec![".ssh/authorized_keys".to_string(), ".ssh/config".to_string(), "/srv/secret".to_string()]);
        assert!(p.is_protected("/home/x/.ssh/authorized_keys2"));
        assert!(p.is_protected("C:/ProgramData/ssh/administrators_authorized_keys"));
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn windows_spellings_of_protected_files_still_match() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = PolicyEngine::new(dir.join("ai_state"), dir.join("missing.json"), dir.join("caps.json"));
        for path in [
            "/home/x/.ssh/authorized_keys.",
            "/home/x/.ssh/authorized_keys ",
            "/home/x/.ssh/authorized_keys. .",
            "C:/Users/x/.ssh/authorized_keys::$DATA",
            "C:/Users/x/.ssh/authorized_keys:evil:$DATA",
            r"C:\Users\x\.ssh.\authorized_keys",
            r"C:\Users\x\SSH~1\AUTHOR~1",
            r"C:\Users\x\.ssh\AUTHOR~2.",
            r"C:\ProgramData\ssh\ADMINI~1",
            r"C:\ProgramData\ssh\AD3F2A~1",
            r"C:\Users\x\.ssh\foo\.. \authorized_keys",
            r"C:\Users\x\.ssh\...\authorized_keys",
            r"C:\Users\x\SSH~1\config",
        ] {
            assert!(p.is_protected(path), "{path}");
        }
        for path in [
            "/home/x/.ssh/known_hosts",
            r"C:\Users\x\SSH~1\KNOWN_~1",
            r"C:\Users\x\DOCUME~1\notes.txt",
            r"C:\Users\x\.ssh\ZZ3F2A~1",
            "/etc/myssh/config",
        ] {
            assert!(!p.is_protected(path), "{path}");
        }
        let abs = engine(&["/etc/passwd"]);
        assert!(abs.is_protected("/etc/passwd:x"));
        assert!(abs.is_protected("/etc/x/.. /passwd"));
        assert!(!abs.is_protected("etc/passwd"));
    }

    #[test]
    fn app_data_is_found_by_file_identity() {
        let root = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        let other = root.join("other");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(data.join("vault.json"), b"{}").unwrap();
        let p = PolicyEngine::new(data.join("ai_state"), data.join("protected.json"), data.join("caps.json"));

        assert!(p.is_app_data(&data.join("vault.json")));
        assert!(p.is_app_data(&data.join("new.json")));
        assert!(!p.is_app_data(&other.join("vault.json")));

        let link = other.join("linked.json");
        std::fs::hard_link(data.join("vault.json"), &link).unwrap();
        assert!(p.is_app_data(&link));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn policy_files_are_replaced_atomically() {
        let dir = std::env::temp_dir().join(format!("kestral_pol_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let open = || PolicyEngine::new(dir.join("ai_state"), dir.join("protected.json"), dir.join("caps.json"));
        let p = open();
        p.set_caps(AiCaps { list_secrets: false, ..AiCaps::default() });
        p.set_protected_paths(vec!["/srv/secret".into()]);
        p.enable(Some(0));

        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
            .count();
        assert_eq!(leftovers, 0);
        let again = open();
        assert!(!again.caps().list_secrets);
        assert_eq!(again.protected_paths(), vec!["/srv/secret".to_string()]);
        assert!(again.is_active());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
