use std::collections::{HashMap, HashSet};

use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::{AppError, Result};
use crate::model::{AuthMethod, Host, Identity, Snippet};
use crate::state::Services;
use crate::vault::{SecretKind, SecretStore};

const BUNDLE_VERSION: u8 = 1;

// value holds a base64 copy of a private key or password, so wipe it on drop the
// way the rest of the vault code wipes its plaintext. id and kind are not secret.
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct ExportedSecret {
    #[zeroize(skip)]
    id: String,
    #[zeroize(skip)]
    kind: SecretKind,
    value: String,
}

#[derive(Serialize, Deserialize)]
struct Bundle {
    version: u8,
    secrets: Vec<ExportedSecret>,
    hosts: Vec<Host>,
    snippets: Vec<Snippet>,
    #[serde(default)]
    identities: Vec<Identity>,
    #[serde(default)]
    collections: crate::collections::Collections,
    #[serde(default)]
    known_hosts: String,
}

#[derive(Serialize)]
pub struct ImportReport {
    pub hosts_added: usize,
    pub hosts_skipped: usize,
    pub secrets_added: usize,
    pub secrets_skipped: usize,
    pub snippets_added: usize,
    pub snippets_skipped: usize,
    pub identities_added: usize,
    pub identities_skipped: usize,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Gather every host, snippet and secret from the unlocked vault into one bundle
/// and encrypt it under a standalone password (independent of the vault's own).
/// The result is a portable file the user can carry to another machine.
pub fn export(services: &Services, password: &str) -> Result<Vec<u8>> {
    if !services.vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }

    let mut secrets = Vec::new();
    for meta in services.vault.list_secrets()? {
        let value = services.vault.get_secret(&meta.id)?;
        secrets.push(ExportedSecret {
            id: meta.id,
            kind: meta.kind,
            value: b64().encode(value.as_slice()),
        });
    }

    let bundle = Bundle {
        version: BUNDLE_VERSION,
        secrets,
        hosts: services.hosts.list(),
        snippets: services.snippets.list(),
        identities: services.identities.list()?,
        collections: services.collections.read()?,
        known_hosts: String::from_utf8_lossy(&crate::known_hosts::export_content()?).into_owned(),
    };

    let plaintext = Zeroizing::new(serde_json::to_vec(&bundle)?);
    crate::vault::seal_with_password(&plaintext, password)
}

/// Decrypt a bundle and merge it into the unlocked target vault. Additive and
/// non-destructive: existing entries are never overwritten. Everything ends up
/// sealed under the target vault's own password.
///
/// Secret ids are user-chosen strings, so the same id can mean different things on
/// two machines. When an incoming secret's id already exists in the target with a
/// *different* value, the incoming one is given a fresh id and the hosts that
/// referenced it are rewritten to match, so an imported host can never silently
/// bind to the target's unrelated credential.
pub fn import(services: &Services, file_bytes: &[u8], password: &str) -> Result<ImportReport> {
    if !services.vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }

    let plaintext = crate::vault::open_with_password(file_bytes, password)?;
    let bundle: Bundle = serde_json::from_slice(&plaintext)?;
    if bundle.version != BUNDLE_VERSION {
        return Err(AppError::Other(format!(
            "this export was written by a different Kestral version (format {})",
            bundle.version
        )));
    }

    // Snapshot the target's secrets so a genuine duplicate can be told apart from
    // an id that merely collides with a different value.
    let mut existing: HashMap<String, Zeroizing<Vec<u8>>> = HashMap::new();
    for meta in services.vault.list_secrets()? {
        existing.insert(meta.id.clone(), services.vault.get_secret(&meta.id)?);
    }
    let mut used: HashSet<String> = existing.keys().cloned().collect();

    let mut to_add: Vec<(String, SecretKind, Vec<u8>)> = Vec::new();
    let mut remap: HashMap<String, String> = HashMap::new();
    let mut secrets_added = 0;
    let mut secrets_skipped = 0;

    for s in &bundle.secrets {
        let raw = Zeroizing::new(b64().decode(&s.value).map_err(|_| AppError::Crypto)?);
        let existing_val = existing.get(&s.id).map(|z| z.as_slice());
        match plan_secret(&s.id, raw.as_slice(), existing_val, &mut used) {
            SecretAction::Skip => secrets_skipped += 1,
            SecretAction::Add(final_id) => {
                if final_id != s.id {
                    remap.insert(s.id.clone(), final_id.clone());
                }
                to_add.push((final_id, s.kind, raw.to_vec()));
                secrets_added += 1;
            }
        }
    }

    let hosts: Vec<Host> = bundle
        .hosts
        .iter()
        .cloned()
        .map(|mut h| {
            h.auth = remap_auth(h.auth, &remap);
            h.agent_keys = h
                .agent_keys
                .into_iter()
                .map(|k| remap.get(&k).cloned().unwrap_or(k))
                .collect();
            h
        })
        .collect();

    let identities: Vec<Identity> = bundle
        .identities
        .iter()
        .cloned()
        .map(|mut i| {
            i.auth = remap_auth(i.auth, &remap);
            i
        })
        .collect();

    services.vault.put_secrets(to_add)?;
    let (identities_added, identities_skipped) = services.identities.import(identities)?;
    let (hosts_added, hosts_skipped) = services.hosts.import(hosts)?;
    let (snippets_added, snippets_skipped) = services.snippets.import(bundle.snippets.clone())?;
    services.collections.import(bundle.collections.clone())?;
    if !bundle.known_hosts.is_empty() {
        crate::known_hosts::import_content(bundle.known_hosts.as_bytes())?;
    }

    Ok(ImportReport {
        hosts_added,
        hosts_skipped,
        secrets_added,
        secrets_skipped,
        snippets_added,
        snippets_skipped,
        identities_added,
        identities_skipped,
    })
}

enum SecretAction {
    Skip,
    Add(String),
}

// Decide how one incoming secret is merged: an identical secret already present is
// skipped; an id that clashes with a *different* value gets a fresh id (so the
// hosts pointing at it can be rewritten instead of silently inheriting the
// target's unrelated credential); a new id is kept as is.
fn plan_secret(
    id: &str,
    value: &[u8],
    existing: Option<&[u8]>,
    used: &mut HashSet<String>,
) -> SecretAction {
    match existing {
        Some(cur) if cur == value => SecretAction::Skip,
        Some(_) => SecretAction::Add(free_id(id, used)),
        None => {
            used.insert(id.to_string());
            SecretAction::Add(id.to_string())
        }
    }
}

// Find an id derived from `base` that is not already taken, and reserve it.
fn free_id(base: &str, used: &mut HashSet<String>) -> String {
    let mut n = 2;
    loop {
        let cand = format!("{base}-{n}");
        if !used.contains(&cand) {
            used.insert(cand.clone());
            return cand;
        }
        n += 1;
    }
}

fn remap_auth(auth: AuthMethod, remap: &HashMap<String, String>) -> AuthMethod {
    let swap = |id: String| remap.get(&id).cloned().unwrap_or(id);
    match auth {
        AuthMethod::Password { secret_id } => AuthMethod::Password { secret_id: swap(secret_id) },
        AuthMethod::Key { secret_id } => AuthMethod::Key { secret_id: swap(secret_id) },
        AuthMethod::Agent => AuthMethod::Agent,
        AuthMethod::Identity { identity_id } => AuthMethod::Identity { identity_id },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn used_of(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn new_secret_keeps_its_id() {
        let mut used = used_of(&["a"]);
        match plan_secret("b", b"val", None, &mut used) {
            SecretAction::Add(id) => assert_eq!(id, "b"),
            SecretAction::Skip => panic!("a new secret must be added"),
        }
        assert!(used.contains("b"));
    }

    #[test]
    fn identical_secret_is_skipped() {
        let mut used = used_of(&["a"]);
        assert!(matches!(
            plan_secret("a", b"same", Some(b"same"), &mut used),
            SecretAction::Skip
        ));
    }

    #[test]
    fn id_clash_with_different_value_gets_a_fresh_id() {
        // The security case: same id, different secret. The incoming one must not
        // reuse the target's id, or a host would bind to the wrong credential.
        let mut used = used_of(&["admin@server"]);
        let new_id = match plan_secret("admin@server", b"DC-PW", Some(b"OFFICE-PW"), &mut used) {
            SecretAction::Add(id) => id,
            SecretAction::Skip => panic!("a differing secret must be added under a new id"),
        };
        assert_ne!(new_id, "admin@server");
        assert!(used.contains(&new_id));
    }

    #[test]
    fn legacy_bundle_collections_still_load() {
        let json = r#"{"version":1,"secrets":[],"hosts":[],"snippets":[],"collections":{"groups":["Production"],"snippet_folders":["Docker"],"pinned":["a"],"recent":[{"host_id":"a","at":"2026-10-01T10:00:00Z"}]}}"#;
        let bundle: Bundle = serde_json::from_str(json).unwrap();
        assert_eq!(bundle.collections.snippet_folders, vec!["Docker"]);
    }

    #[test]
    fn free_id_walks_past_taken_suffixes() {
        let mut used = used_of(&["k", "k-2", "k-3"]);
        assert_eq!(free_id("k", &mut used), "k-4");
    }

    #[test]
    fn remap_rewrites_only_the_clashing_reference() {
        let mut remap = HashMap::new();
        remap.insert("admin@server".to_string(), "admin@server-2".to_string());

        let rewritten = remap_auth(
            AuthMethod::Password { secret_id: "admin@server".into() },
            &remap,
        );
        assert!(matches!(rewritten, AuthMethod::Password { secret_id } if secret_id == "admin@server-2"));

        let untouched = remap_auth(AuthMethod::Key { secret_id: "other".into() }, &remap);
        assert!(matches!(untouched, AuthMethod::Key { secret_id } if secret_id == "other"));

        assert!(matches!(remap_auth(AuthMethod::Agent, &remap), AuthMethod::Agent));
    }
}
