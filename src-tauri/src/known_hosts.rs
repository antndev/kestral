//! Trusted host keys, kept encrypted in the vault in OpenSSH `known_hosts`
//! format. On first use the user's `~/.ssh/known_hosts` is copied in.
//!
//! This is the single source of truth for host key verification during connect
//! and for the Known hosts screen. We parse the format ourselves instead of using
//! russh's helper: that one miscounts line numbers after comment lines (it would
//! make us delete the wrong entry) and fails the whole lookup on
//! `@cert-authority` / `@revoked` lines.
//!
//! The file is handled as bytes and only the fields we need are decoded, so a
//! rewrite reproduces every untouched line byte for byte, even lines that are
//! not valid UTF-8.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::ssh_key::{self, HashAlg, PublicKey};
use serde::{Deserialize, Serialize};
use sha1::Sha1;

use crate::error::{AppError, Result};
use crate::util::blocking;
use crate::vault::Vault;

/// Serialises every read-modify-write of the file inside this process, so two
/// connections saving a key at the same moment cannot drop each other's line.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn known_hosts_path() -> Option<PathBuf> {
    crate::util::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}


#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KnownHostEntry {
    pub line: usize,
    pub hosts: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub hashed: bool,
    pub added: Option<String>,
}

/// What the caller saw on a line when it listed the file. Extra fields (for
/// example a whole `KnownHostEntry` sent back) are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct ExpectedEntry {
    pub line: usize,
    pub hosts: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Marker {
    CertAuthority,
    Revoked,
}

#[derive(Debug, Clone)]
struct Record {
    line: usize,
    marker: Option<Marker>,
    hosts: String,
    key_type: String,
    key_b64: String,
}

impl Record {
    fn key(&self) -> Option<PublicKey> {
        russh::keys::parse_public_key_base64(&self.key_b64).ok()
    }

    fn identity(&self) -> (Option<Marker>, String, String, String) {
        (
            self.marker,
            self.hosts.clone(),
            self.key_type.clone(),
            self.key_b64.clone(),
        )
    }

    /// The entry as the Known hosts screen shows it. Marker lines and lines
    /// with an unreadable key are never shown, so they are never edited either.
    fn entry(&self) -> Option<KnownHostEntry> {
        if self.marker.is_some() {
            return None;
        }
        let key = self.key()?;
        Some(self.entry_with(&key))
    }

    fn entry_with(&self, key: &PublicKey) -> KnownHostEntry {
        let first = self.hosts.split(',').next().unwrap_or_default();
        let hashed = first.starts_with("|1|");
        let (host, port) = if hashed {
            (String::new(), 22)
        } else {
            split_host_port(first)
        };
        KnownHostEntry {
            line: self.line,
            hosts: self.hosts.clone(),
            host,
            port,
            key_type: self.key_type.clone(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            hashed,
            added: None,
        }
    }
}

fn parse_record(line: usize, raw: &[u8]) -> Option<Record> {
    let text = String::from_utf8_lossy(raw);
    let text = text.trim().trim_start_matches('\u{feff}').trim();
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    let mut fields = text.split_whitespace();
    let mut first = fields.next()?;
    let marker = if first.starts_with('@') {
        let m = match first {
            "@cert-authority" => Marker::CertAuthority,
            "@revoked" => Marker::Revoked,
            _ => return None,
        };
        first = fields.next()?;
        Some(m)
    } else {
        None
    };
    let key_type = fields.next()?;
    let key_b64 = fields.next()?;
    Some(Record {
        line,
        marker,
        hosts: first.to_string(),
        key_type: key_type.to_string(),
        key_b64: key_b64.to_string(),
    })
}

/// Lines with their original endings. Line numbers are 1-based.
fn raw_lines(content: &[u8]) -> impl Iterator<Item = (usize, &[u8])> {
    content
        .split_inclusive(|&b| b == b'\n')
        .enumerate()
        .map(|(i, l)| (i + 1, l))
}

fn records(content: &[u8]) -> impl Iterator<Item = Record> + '_ {
    raw_lines(content).filter_map(|(n, l)| parse_record(n, l))
}

fn host_field(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}

fn split_host_port(entry: &str) -> (String, u16) {
    if let Some(rest) = entry.strip_prefix('[') {
        if let Some((host, port)) = rest.split_once("]:") {
            if let Ok(port) = port.parse() {
                return (host.to_string(), port);
            }
        }
        if let Some(host) = rest.strip_suffix(']') {
            return (host.to_string(), 22);
        }
    }
    (entry.to_string(), 22)
}

fn hashed_match(entry: &str, candidates: &[&str]) -> bool {
    let mut parts = entry.split('|').skip(2);
    let engine = base64::engine::general_purpose::STANDARD;
    let (Some(salt), Some(hash)) = (parts.next(), parts.next()) else {
        return false;
    };
    let (Ok(salt), Ok(hash)) = (engine.decode(salt), engine.decode(hash)) else {
        return false;
    };
    candidates.iter().any(|c| {
        Hmac::<Sha1>::new_from_slice(&salt)
            .map(|mac| mac.chain_update(c.as_bytes()).verify_slice(&hash).is_ok())
            .unwrap_or(false)
    })
}

/// Whether a known_hosts host field (comma list of names, wildcards, negations
/// or `|1|` hashes) covers `host:port`, following OpenSSH's rules.
fn hosts_match(field: &str, host: &str, port: u16) -> bool {
    let target = host_field(host, port);
    let lower = target.to_lowercase();
    let mut matched = false;
    for entry in field.split(',') {
        if entry.starts_with("|1|") {
            matched |= hashed_match(entry, &[&target, &lower]);
            continue;
        }
        let (negated, pattern) = match entry.strip_prefix('!') {
            Some(p) => (true, p),
            None => (false, entry),
        };
        if crate::util::glob_match(&pattern.to_lowercase(), &lower) {
            if negated {
                return false;
            }
            matched = true;
        }
    }
    matched
}

fn read(path: &Path) -> std::io::Result<Vec<u8>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

fn with_trailing_newline(mut content: Vec<u8>) -> Vec<u8> {
    if content.last().is_some_and(|&b| b != b'\n') {
        content.push(b'\n');
    }
    content
}

pub fn list_in(content: &[u8]) -> Vec<KnownHostEntry> {
    records(content).filter_map(|r| r.entry()).collect()
}

/// Drops the given lines, but only lines the Known hosts screen shows: a stale
/// line number can never delete a comment, a marker line or anything else the
/// user could not see. Returns the new content and how many lines were removed.
fn remove_lines_in(content: &[u8], lines: &HashSet<usize>) -> (Vec<u8>, u32) {
    let mut out = Vec::with_capacity(content.len());
    let mut removed = 0;
    for (n, raw) in raw_lines(content) {
        let listed =
            lines.contains(&n) && parse_record(n, raw).is_some_and(|r| r.entry().is_some());
        if listed {
            removed += 1;
        } else {
            out.extend_from_slice(raw);
        }
    }
    (out, removed)
}

/// Fails when a line no longer holds what the caller listed, because the store
/// changed in between (another removal, a new connection).
fn check_expected(content: &[u8], expected: &[ExpectedEntry]) -> Result<()> {
    let current: HashMap<usize, KnownHostEntry> =
        list_in(content).into_iter().map(|e| (e.line, e)).collect();
    let stale = expected.iter().any(|x| {
        current
            .get(&x.line)
            .is_none_or(|e| e.hosts != x.hosts || e.fingerprint != x.fingerprint)
    });
    if stale {
        return Err(AppError::Other(
            "Known hosts changed since they were listed. Nothing was removed, refresh and try again."
                .into(),
        ));
    }
    Ok(())
}

fn forget_lines_in(content: &[u8], host: &str, port: u16) -> HashSet<usize> {
    records(content)
        .filter(|r| r.marker.is_none() && hosts_match(&r.hosts, host, port))
        .map(|r| r.line)
        .collect()
}

/// Lines of `incoming` that are host entries not yet present in `existing`.
/// `@cert-authority` and `@revoked` lines are skipped: the Known hosts screen
/// cannot show them, so importing them would change trust invisibly.
fn import_lines<'a>(existing: &[u8], incoming: &'a [u8]) -> Vec<&'a [u8]> {
    let mut seen: HashSet<_> = records(existing).map(|r| r.identity()).collect();
    let mut out = Vec::new();
    for (n, raw) in raw_lines(incoming) {
        let Some(rec) = parse_record(n, raw) else {
            continue;
        };
        if rec.entry().is_none() || !seen.insert(rec.identity()) {
            continue;
        }
        out.push(raw.trim_ascii());
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Trusted,
    Unknown,
    /// The host is known but presented a different key. Holds the saved
    /// entries that cover it, so the user can compare them.
    Changed(Vec<KnownHostEntry>),
    Revoked,
}

fn verify_in(content: &[u8], host: &str, port: u16, key: &PublicKey) -> Verdict {
    let mut trusted = false;
    let mut saved = Vec::new();
    for rec in records(content) {
        match rec.marker {
            Some(Marker::Revoked) => {
                if rec.key().is_some_and(|k| k.key_data() == key.key_data()) {
                    return Verdict::Revoked;
                }
            }
            Some(Marker::CertAuthority) => {}
            None => {
                if !hosts_match(&rec.hosts, host, port) {
                    continue;
                }
                match rec.key() {
                    Some(k) if k.key_data() == key.key_data() => trusted = true,
                    Some(k) => saved.push(rec.entry_with(&k)),
                    None => tracing::warn!(
                        "known hosts line {} has an unreadable key, ignored",
                        rec.line
                    ),
                }
            }
        }
    }
    // Decide only after the whole store: a @revoked line anywhere wins.
    if trusted {
        Verdict::Trusted
    } else if saved.is_empty() {
        Verdict::Unknown
    } else {
        Verdict::Changed(saved)
    }
}

mod b64 {
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(text)
            .map_err(serde::de::Error::custom)
    }
}

/// The trusted host keys, kept encrypted in the vault in OpenSSH known_hosts
/// format, with the time each line was added.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Store {
    #[serde(with = "b64", default)]
    content: Vec<u8>,
    #[serde(default)]
    added: BTreeMap<String, String>,
}

fn identity_key(r: &Record) -> String {
    let marker = match r.marker {
        Some(Marker::CertAuthority) => "@cert-authority ",
        Some(Marker::Revoked) => "@revoked ",
        None => "",
    };
    format!("{marker}{} {} {}", r.hosts, r.key_type, r.key_b64)
}

fn now_stamp() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl Store {
    pub fn from_content(content: Vec<u8>, stamp: &str) -> Self {
        let added = records(&content).map(|r| (identity_key(&r), stamp.to_string())).collect();
        Self { content, added }
    }

    fn added_by_line(&self) -> HashMap<usize, String> {
        records(&self.content)
            .filter_map(|r| self.added.get(&identity_key(&r)).map(|a| (r.line, a.clone())))
            .collect()
    }

    fn prune(&mut self) {
        let present: HashSet<String> = records(&self.content).map(|r| identity_key(&r)).collect();
        self.added.retain(|k, _| present.contains(k));
    }

    pub fn list(&self) -> Vec<KnownHostEntry> {
        let added = self.added_by_line();
        list_in(&self.content)
            .into_iter()
            .map(|mut e| {
                e.added = added.get(&e.line).cloned();
                e
            })
            .collect()
    }

    pub fn verify(&self, host: &str, port: u16, key: &PublicKey) -> Verdict {
        match verify_in(&self.content, host, port, key) {
            Verdict::Changed(saved) => {
                let added = self.added_by_line();
                Verdict::Changed(
                    saved
                        .into_iter()
                        .map(|mut e| {
                            e.added = added.get(&e.line).cloned();
                            e
                        })
                        .collect(),
                )
            }
            other => other,
        }
    }

    pub fn known_algorithms(&self, host: &str, port: u16) -> Vec<ssh_key::Algorithm> {
        let mut out: Vec<ssh_key::Algorithm> = Vec::new();
        for rec in records(&self.content) {
            if rec.marker.is_some() || !hosts_match(&rec.hosts, host, port) {
                continue;
            }
            if let Some(k) = rec.key() {
                let a = k.algorithm();
                if !out.contains(&a) {
                    out.push(a);
                }
            }
        }
        out
    }

    /// Records `host:port` with `key`, unless that exact entry is already present.
    pub fn append(&mut self, host: &str, port: u16, key: &PublicKey, stamp: &str) -> Result<bool> {
        if verify_in(&self.content, host, port, key) == Verdict::Trusted {
            return Ok(false);
        }
        let openssh = key
            .to_openssh()
            .map_err(|e| AppError::Other(format!("Encode host key: {e}")))?;
        let line = format!("{} {}", host_field(host, port), openssh.trim());
        let mut content = with_trailing_newline(std::mem::take(&mut self.content));
        content.extend_from_slice(line.as_bytes());
        content.push(b'\n');
        self.content = content;
        if let Some(rec) = parse_record(0, line.as_bytes()) {
            self.added.insert(identity_key(&rec), stamp.to_string());
        }
        Ok(true)
    }

    pub fn remove(&mut self, lines: &[usize], expected: &[ExpectedEntry]) -> Result<u32> {
        check_expected(&self.content, expected)?;
        let (out, removed) = remove_lines_in(&self.content, &lines.iter().copied().collect());
        if removed > 0 {
            self.content = out;
            self.prune();
        }
        Ok(removed)
    }

    pub fn forget(&mut self, host: &str, port: u16) -> Result<u32> {
        // A hashed entry lists an empty host; forgetting "" would match every
        // catch-all `*` line instead. Hashed rows are removed by line.
        if host.is_empty() {
            return Err(AppError::Other(
                "Host is empty. Remove hashed entries by line instead.".into(),
            ));
        }
        let lines = forget_lines_in(&self.content, host, port);
        let (out, removed) = remove_lines_in(&self.content, &lines);
        if removed > 0 {
            self.content = out;
            self.prune();
        }
        Ok(removed)
    }

    /// Appends host entries from another known_hosts file that are not present
    /// yet and returns how many were added (each one is a new row on the screen).
    pub fn import(&mut self, incoming: &[u8], stamp: &str) -> u32 {
        let new_lines = import_lines(&self.content, incoming);
        if new_lines.is_empty() {
            return 0;
        }
        let mut out = with_trailing_newline(std::mem::take(&mut self.content));
        for line in &new_lines {
            out.extend_from_slice(line);
            out.push(b'\n');
            if let Some(rec) = parse_record(0, line) {
                self.added.entry(identity_key(&rec)).or_insert_with(|| stamp.to_string());
            }
        }
        self.content = out;
        new_lines.len() as u32
    }

    pub fn content(&self) -> &[u8] {
        &self.content
    }
}

static VAULT: OnceLock<Arc<Vault>> = OnceLock::new();

pub fn init(vault: Arc<Vault>) {
    let _ = VAULT.set(vault);
}

fn vault() -> Result<Arc<Vault>> {
    VAULT.get().cloned().ok_or_else(|| AppError::Other("Known hosts are not ready yet".into()))
}

fn save(v: &Vault, store: &Store) -> Result<()> {
    v.put_blob(Vault::known_hosts_blob_id(), &serde_json::to_vec(store)?)
}

/// The store from the vault. On first use the user's ~/.ssh/known_hosts is
/// copied in, so hosts trusted before keep their keys. A store that cannot be
/// read is an error, so connections fail closed instead of asking again.
fn load() -> Result<Store> {
    let v = vault()?;
    if let Some(bytes) = v.get_blob(Vault::known_hosts_blob_id())? {
        return serde_json::from_slice(&bytes).map_err(|e| {
            AppError::Other(format!("Known hosts in the vault could not be read ({e}). Connections are refused until this is fixed."))
        });
    }
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(bytes) = v.get_blob(Vault::known_hosts_blob_id())? {
        return serde_json::from_slice(&bytes).map_err(|e| AppError::Other(format!("Known hosts in the vault could not be read ({e})")));
    }
    let content = match known_hosts_path() {
        Some(path) => read(&path).map_err(|e| AppError::Other(format!("{} could not be read for the first import ({e})", path.display())))?,
        None => Vec::new(),
    };
    let store = Store::from_content(content, &now_stamp());
    save(&v, &store)?;
    Ok(store)
}

fn update<T>(f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let current = load()?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let v = vault()?;
    let mut store = match v.get_blob(Vault::known_hosts_blob_id())? {
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::Other(format!("Known hosts in the vault could not be read ({e})")))?,
        None => current,
    };
    let before = store.clone();
    let out = f(&mut store)?;
    if store != before {
        save(&v, &store)?;
    }
    Ok(out)
}

pub fn verify(host: &str, port: u16, key: &PublicKey) -> Result<Verdict> {
    Ok(load()?.verify(host, port, key))
}

pub fn known_algorithms(host: &str, port: u16) -> Vec<ssh_key::Algorithm> {
    load().map(|s| s.known_algorithms(host, port)).unwrap_or_default()
}

pub fn append(host: &str, port: u16, key: &PublicKey) -> Result<()> {
    let stamp = now_stamp();
    update(|s| s.append(host, port, key, &stamp)).map(|_| ())
}

pub fn export_content() -> Result<Vec<u8>> {
    Ok(load()?.content().to_vec())
}

pub fn import_content(incoming: &[u8]) -> Result<u32> {
    let stamp = now_stamp();
    update(|s| Ok(s.import(incoming, &stamp)))
}

#[tauri::command]
pub async fn known_hosts_list() -> Result<Vec<KnownHostEntry>> {
    blocking(|| Ok(load()?.list())).await
}

/// `expected` (optional) holds what the caller listed for those lines; when the
/// store no longer matches it, nothing is removed and an error is returned.
#[tauri::command]
pub async fn known_hosts_remove(
    lines: Vec<usize>,
    expected: Option<Vec<ExpectedEntry>>,
) -> Result<u32> {
    blocking(move || update(|s| s.remove(&lines, &expected.unwrap_or_default()))).await
}

#[tauri::command]
pub async fn known_hosts_forget(host: String, port: u16) -> Result<u32> {
    blocking(move || update(|s| s.forget(host.trim(), port))).await
}

#[tauri::command]
pub async fn known_hosts_import(path: String) -> Result<u32> {
    blocking(move || {
        let incoming = std::fs::read(&path)
            .map_err(|e| AppError::Other(format!("Could not read {path}: {e}")))?;
        import_content(&incoming)
    })
    .await
}

#[tauri::command]
pub async fn known_hosts_export(path: String) -> Result<u32> {
    blocking(move || {
        let store = load()?;
        let target = PathBuf::from(&path);
        let existing = read(&target)?;
        let new_lines = import_lines(&existing, store.content());
        if new_lines.is_empty() {
            return Ok(0);
        }
        let mut out = with_trailing_newline(existing);
        for line in &new_lines {
            out.extend_from_slice(line);
            out.push(b'\n');
        }
        let target = std::fs::canonicalize(&target).unwrap_or(target);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::util::replace_file(&target, &out)?;
        Ok(new_lines.len() as u32)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    const ED_A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const ED_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";
    // Hash of "example.com", key ED_C (from the russh test suite).
    const HASHED: &str = "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak=";
    const ED_C: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    fn key(b64: &str) -> PublicKey {
        russh::keys::parse_public_key_base64(b64).unwrap()
    }

    fn fp(b64: &str) -> String {
        key(b64).fingerprint(HashAlg::Sha256).to_string()
    }

    fn sample() -> Vec<u8> {
        format!(
            "# my hosts\r\n\
             \r\n\
             [localhost]:2222 ssh-ed25519 {ED_A}\r\n\
             pijul.org,37.120.161.53 ssh-ed25519 {ED_B} comment here\n\
             @cert-authority *.corp ssh-ed25519 {ED_A}\n\
             {HASHED} ssh-ed25519 {ED_C}\n\
             garbage\n\
             plain\tssh-ed25519\t{ED_A}"
        )
        .into_bytes()
    }

    fn lines_of(v: &Verdict) -> Vec<usize> {
        match v {
            Verdict::Changed(saved) => saved.iter().map(|e| e.line).collect(),
            _ => Vec::new(),
        }
    }


    #[test]
    fn lists_entries_with_real_line_numbers() {
        let entries = list_in(&sample());
        let summary: Vec<_> = entries
            .iter()
            .map(|e| (e.line, e.host.as_str(), e.port, e.hashed))
            .collect();
        assert_eq!(
            summary,
            vec![
                (3, "localhost", 2222, false),
                (4, "pijul.org", 22, false),
                (6, "", 22, true),
                (8, "plain", 22, false),
            ]
        );
        assert_eq!(entries[1].hosts, "pijul.org,37.120.161.53");
        assert_eq!(entries[0].key_type, "ssh-ed25519");
        assert_eq!(entries[0].fingerprint, fp(ED_A));
        assert!(entries[0].fingerprint.starts_with("SHA256:"));
    }

    #[test]
    fn verifies_plain_bracketed_hashed_and_changed_keys() {
        let s = sample();
        assert_eq!(
            verify_in(&s, "localhost", 2222, &key(ED_A)),
            Verdict::Trusted
        );
        assert_eq!(verify_in(&s, "localhost", 22, &key(ED_A)), Verdict::Unknown);
        assert_eq!(
            verify_in(&s, "37.120.161.53", 22, &key(ED_B)),
            Verdict::Trusted
        );
        assert_eq!(verify_in(&s, "PIJUL.org", 22, &key(ED_B)), Verdict::Trusted);
        assert_eq!(
            verify_in(&s, "example.com", 22, &key(ED_C)),
            Verdict::Trusted
        );
        assert_eq!(verify_in(&s, "nowhere", 22, &key(ED_A)), Verdict::Unknown);

        // The saved entries come with the verdict, also for hashed lines and
        // for a comma list where the address is not the first name.
        let hashed = verify_in(&s, "example.com", 22, &key(ED_A));
        assert_eq!(lines_of(&hashed), vec![6]);
        let Verdict::Changed(saved) = &hashed else {
            unreachable!()
        };
        assert!(saved[0].hashed);
        assert_eq!(saved[0].fingerprint, fp(ED_C));
        assert_eq!(
            lines_of(&verify_in(&s, "37.120.161.53", 22, &key(ED_A))),
            vec![4]
        );

        let two = format!("a ssh-ed25519 {ED_B}\n*.x,a ssh-ed25519 {ED_C}\n");
        assert_eq!(
            lines_of(&verify_in(two.as_bytes(), "a", 22, &key(ED_A))),
            vec![1, 2]
        );

        let mut revoked = s.clone();
        revoked.extend_from_slice(format!("\n@revoked * ssh-ed25519 {ED_B}\n").as_bytes());
        assert_eq!(
            verify_in(&revoked, "pijul.org", 22, &key(ED_B)),
            Verdict::Revoked
        );
    }

    #[test]
    fn negated_and_wildcard_patterns() {
        let s = format!("*.lan,!bad.lan ssh-ed25519 {ED_A}\n");
        assert_eq!(
            verify_in(s.as_bytes(), "nas.lan", 22, &key(ED_A)),
            Verdict::Trusted
        );
        assert_eq!(
            verify_in(s.as_bytes(), "bad.lan", 22, &key(ED_A)),
            Verdict::Unknown
        );
    }

    #[test]
    fn removes_only_listed_lines_and_preserves_the_rest_exactly() {
        let s = sample();
        let (out, removed) = remove_lines_in(&s, &[1, 2, 4, 5, 6, 7, 99].into_iter().collect());
        assert_eq!(removed, 2);
        let expected = format!(
            "# my hosts\r\n\
             \r\n\
             [localhost]:2222 ssh-ed25519 {ED_A}\r\n\
             @cert-authority *.corp ssh-ed25519 {ED_A}\n\
             garbage\n\
             plain\tssh-ed25519\t{ED_A}"
        );
        assert_eq!(out, expected.into_bytes());

        let broken = b"bad ssh-ed25519 !!!\n".to_vec();
        assert_eq!(remove_lines_in(&broken, &HashSet::from([1])).1, 0);
    }

    #[test]
    fn non_utf8_lines_survive_a_rewrite() {
        let latin_line = |name: &str, key: &str| {
            let mut l = format!("{name} ssh-ed25519 {key} ").into_bytes();
            l.extend_from_slice(b"m\xfcller\n");
            l
        };
        let latin = latin_line("b", ED_B);
        let mut s = b"# caf\xe9 latin-1\n".to_vec();
        s.extend_from_slice(&latin_line("a", ED_A));
        s.extend_from_slice(&latin);
        assert_eq!(list_in(&s).len(), 2);
        let (out, removed) = remove_lines_in(&s, &HashSet::from([2]));
        assert_eq!(removed, 1);
        let mut expected = b"# caf\xe9 latin-1\n".to_vec();
        expected.extend_from_slice(&latin);
        assert_eq!(out, expected);
    }

    #[test]
    fn stale_expectations_remove_nothing() {
        let mut store = Store::from_content(sample(), "t0");
        let listed = store.list();
        assert!(listed[0].hosts != listed[1].hosts);
        let expect = |e: &KnownHostEntry| ExpectedEntry {
            line: e.line,
            hosts: e.hosts.clone(),
            fingerprint: e.fingerprint.clone(),
        };

        let wrong = ExpectedEntry {
            line: listed[0].line,
            hosts: listed[1].hosts.clone(),
            fingerprint: listed[0].fingerprint.clone(),
        };
        assert!(store.remove(&[listed[0].line], &[wrong]).is_err());
        assert_eq!(store.list(), listed);

        assert_eq!(store.remove(&[listed[0].line], &[expect(&listed[0])]).unwrap(), 1);
        // The same request again now points at a line that moved.
        assert!(store.remove(&[listed[1].line], &[expect(&listed[1])]).is_err());
    }

    #[test]
    fn forget_handles_hashed_and_bracketed_entries() {
        let s = sample();
        assert_eq!(forget_lines_in(&s, "example.com", 22), HashSet::from([6]));
        assert_eq!(forget_lines_in(&s, "localhost", 2222), HashSet::from([3]));
        assert_eq!(forget_lines_in(&s, "37.120.161.53", 22), HashSet::from([4]));
        assert!(forget_lines_in(&s, "localhost", 22).is_empty());
    }

    #[test]
    fn forget_refuses_an_empty_host() {
        let mut store = Store::from_content(format!("* ssh-ed25519 {ED_A}\n").into_bytes(), "t0");
        assert!(store.forget("", 22).is_err());
        assert_eq!(store.list().len(), 1);
    }

    #[test]
    fn store_operations_round_trip() {
        let mut store = Store::from_content(sample(), "t0");

        assert_eq!(store.forget("example.com", 22).unwrap(), 1);
        assert_eq!(store.list().len(), 3);

        assert!(store.append("new.host", 2200, &key(ED_B), "t1").unwrap());
        assert!(!store.append("new.host", 2200, &key(ED_B), "t2").unwrap());
        let content = String::from_utf8(store.content().to_vec()).unwrap();
        assert!(content.starts_with("# my hosts\r\n\r\n"));
        assert!(content.ends_with(&format!(
            "plain\tssh-ed25519\t{ED_A}\n[new.host]:2200 ssh-ed25519 {ED_B}\n"
        )));
        assert_eq!(store.verify("new.host", 2200, &key(ED_B)), Verdict::Trusted);
        let newest = store.list().pop().unwrap();
        assert_eq!(newest.added.as_deref(), Some("t1"));
        assert_eq!(store.list()[0].added.as_deref(), Some("t0"));

        let other = format!(
            "# other\n[new.host]:2200 ssh-ed25519 {ED_B}\nfresh ssh-ed25519 {ED_C}\nfresh ssh-ed25519 {ED_C}\nbroken ssh-ed25519 !!!\n@revoked * ssh-ed25519 {ED_A}\n@cert-authority *.x ssh-ed25519 {ED_A}\n"
        );
        assert_eq!(store.import(other.as_bytes(), "t3"), 1);
        assert_eq!(store.import(other.as_bytes(), "t4"), 0);
        let content = String::from_utf8(store.content().to_vec()).unwrap();
        assert!(!content.contains("@revoked"));
        assert_eq!(content.matches("@cert-authority").count(), 1);
        let last = store.list().pop().unwrap();
        assert_eq!(last.host, "fresh");
        assert_eq!(last.added.as_deref(), Some("t3"));

        let lines: Vec<usize> = store.list().iter().map(|e| e.line).collect();
        assert_eq!(store.remove(&lines, &[]).unwrap(), lines.len() as u32);
        assert!(store.list().is_empty());
        let content = String::from_utf8(store.content().to_vec()).unwrap();
        assert!(content.starts_with("# my hosts\r\n"));
        assert!(content.contains("@cert-authority"));
        assert_eq!(store.added.len(), 1);
    }

    #[test]
    fn empty_store_appends_and_survives_serialization() {
        let mut store = Store::default();
        assert!(store.list().is_empty());
        assert_eq!(store.forget("x", 22).unwrap(), 0);
        store.append("x", 22, &key(ED_A), "t1").unwrap();
        assert_eq!(store.content(), format!("x ssh-ed25519 {ED_A}\n").as_bytes());

        let mut latin = b"# caf\xe9\n".to_vec();
        latin.extend_from_slice(store.content());
        let store = Store::from_content(latin, "t2");
        let json = serde_json::to_vec(&store).unwrap();
        let back: Store = serde_json::from_slice(&json).unwrap();
        assert_eq!(back, store);
        assert_eq!(back.verify("x", 22, &key(ED_A)), Verdict::Trusted);
        assert_eq!(back.verify("x", 22, &key(ED_B)).clone(), Verdict::Changed(vec![KnownHostEntry { added: Some("t2".into()), ..list_in(back.content())[0].clone() }]));
    }
}
