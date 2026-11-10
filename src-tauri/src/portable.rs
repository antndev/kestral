use std::collections::{BTreeMap, HashMap, HashSet};

use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::{AppError, Result};
use crate::model::{AuthMethod, Host, Identity, Snippet};
use crate::state::Services;
use crate::vault::SecretKind;

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

#[derive(Clone, Copy, Deserialize)]
pub struct Parts {
    pub hosts: bool,
    pub snippets: bool,
    pub settings: bool,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub prefs: BTreeMap<String, String>,
    #[serde(default)]
    pub minimize_to_tray: bool,
    #[serde(default)]
    pub ai_caps: Option<crate::policy::AiCaps>,
    #[serde(default)]
    pub protected_paths: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Bundle {
    version: u8,
    #[serde(default)]
    secrets: Vec<ExportedSecret>,
    #[serde(default)]
    hosts: Vec<Host>,
    #[serde(default)]
    snippets: Vec<Snippet>,
    #[serde(default)]
    identities: Vec<Identity>,
    #[serde(default)]
    collections: crate::collections::Collections,
    #[serde(default)]
    known_hosts: String,
    #[serde(default)]
    settings: Option<Settings>,
}

#[derive(Default, Serialize)]
pub struct ImportReport {
    pub hosts_added: usize,
    pub hosts_skipped: usize,
    pub forwards_added: usize,
    pub secrets_added: usize,
    pub secrets_skipped: usize,
    pub snippets_added: usize,
    pub snippets_skipped: usize,
    pub identities_added: usize,
    pub identities_skipped: usize,
    pub settings: Option<Settings>,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Gather the chosen parts of the unlocked vault into one bundle and encrypt it
/// under a standalone password (independent of the vault's own). `local` brings
/// the settings that live outside the vault; the AI options are added here.
pub fn export(services: &Services, password: &str, parts: Parts, mut local: Settings) -> Result<Vec<u8>> {
    if !services.vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }

    let mut bundle = Bundle {
        version: BUNDLE_VERSION,
        secrets: Vec::new(),
        hosts: Vec::new(),
        snippets: Vec::new(),
        identities: Vec::new(),
        collections: Default::default(),
        known_hosts: String::new(),
        settings: None,
    };
    if parts.hosts {
        for meta in services.vault.list_secrets()? {
            let value = services.vault.get_secret(&meta.id)?;
            bundle.secrets.push(ExportedSecret {
                id: meta.id,
                kind: meta.kind,
                value: b64().encode(value.as_slice()),
            });
        }
        bundle.hosts = services.hosts.list();
        bundle.identities = services.identities.list()?;
        bundle.known_hosts = String::from_utf8_lossy(&crate::known_hosts::export_content()?).into_owned();
    }
    if parts.snippets {
        bundle.snippets = services.snippets.list();
        bundle.collections = services.collections.read()?;
    }
    if parts.settings {
        local.ai_caps = Some(services.policy.caps());
        local.protected_paths = services.policy.protected_paths();
        bundle.settings = Some(local);
    }

    let plaintext = Zeroizing::new(serde_json::to_vec(&bundle)?);
    crate::vault::seal_with_password(&plaintext, password)
}

/// Decrypt a bundle and merge the chosen parts into the unlocked target vault.
/// Additive: existing entries are never overwritten, a host that is already
/// here only gains the port forwards it lacks. Hosts keep everything they were
/// exported with (AI rules, agent forwarding, forwards and their autostart).
///
/// Secret ids are user-chosen strings, so the same id can mean different things on
/// two machines. When an incoming secret's id already exists in the target with a
/// *different* value, the incoming one is given a fresh id and the hosts that
/// referenced it are rewritten to match, so an imported host can never silently
/// bind to the target's unrelated credential. Agent keys follow the same rule: a
/// host only keeps the ones that came in the same file.
pub fn import(services: &Services, file_bytes: &[u8], password: &str, parts: Parts) -> Result<ImportReport> {
    if !services.vault.is_unlocked() {
        return Err(AppError::VaultLocked);
    }

    let plaintext = crate::vault::open_with_password(file_bytes, password).map_err(|e| match e {
        AppError::VaultAuth => AppError::Other("Wrong password for this export file, or the file is damaged.".into()),
        other => other,
    })?;
    let bundle: Bundle = serde_json::from_slice(&plaintext)?;
    if bundle.version != BUNDLE_VERSION {
        return Err(AppError::Other(format!(
            "this export was written by a different Kestral version (format {})",
            bundle.version
        )));
    }

    let mut report = ImportReport::default();
    if parts.hosts {
        import_hosts(services, &bundle, &mut report)?;
    }
    if parts.snippets {
        let known: HashSet<uuid::Uuid> = services.hosts.list().iter().map(|h| h.id).collect();
        let snippets: Vec<Snippet> = bundle
            .snippets
            .iter()
            .cloned()
            .map(|mut s| {
                s.target_host_ids.retain(|id| known.contains(id));
                s
            })
            .collect();
        (report.snippets_added, report.snippets_skipped) = services.snippets.import(snippets)?;
        services.collections.import(bundle.collections.clone())?;
    }
    if let Some(settings) = bundle.settings.filter(|_| parts.settings) {
        if let Some(caps) = settings.ai_caps {
            services.policy.set_caps(caps)?;
        }
        let mut paths = services.policy.protected_paths();
        for p in &settings.protected_paths {
            if !paths.contains(p) {
                paths.push(p.clone());
            }
        }
        services.policy.set_protected_paths(paths)?;
        report.settings = Some(settings);
    }
    Ok(report)
}

fn import_hosts(services: &Services, bundle: &Bundle, report: &mut ImportReport) -> Result<()> {
    // Snapshot the target's secrets so a genuine duplicate can be told apart from
    // an id that merely collides with a different value.
    let mut existing: HashMap<String, Zeroizing<Vec<u8>>> = HashMap::new();
    for meta in services.vault.list_secrets()? {
        existing.insert(meta.id.clone(), services.vault.get_secret(&meta.id)?);
    }
    let (to_add, remap, secrets_skipped) = plan_secrets(&bundle.secrets, &existing)?;
    report.secrets_added = to_add.len();
    report.secrets_skipped = secrets_skipped;

    let bundled: HashSet<&str> = bundle.secrets.iter().map(|s| s.id.as_str()).collect();
    let own_secrets = |auth: &AuthMethod| match auth {
        AuthMethod::Password { secret_id } | AuthMethod::Key { secret_id } => bundled.contains(secret_id.as_str()),
        _ => true,
    };

    let current_identities = services.identities.list()?;
    let mut identity_remap: HashMap<String, String> = HashMap::new();
    let mut identity_ids: HashSet<String> = HashSet::new();
    let mut identities: Vec<Identity> = Vec::new();
    for mut i in bundle.identities.iter().cloned() {
        if !own_secrets(&i.auth) {
            continue;
        }
        i.auth = remap_auth(i.auth, &remap, &HashMap::new());
        let old = i.id.to_string();
        if let Some(cur) = current_identities.iter().find(|c| c.id == i.id) {
            if cur.name == i.name && cur.username == i.username && cur.auth == i.auth {
                identity_ids.insert(old);
                continue;
            }
            i.id = uuid::Uuid::new_v4();
            identity_remap.insert(old.clone(), i.id.to_string());
        }
        identity_ids.insert(old);
        identities.push(i);
    }

    let mut hosts_dropped = 0;
    let hosts: Vec<Host> = bundle
        .hosts
        .iter()
        .filter(|h| {
            let ok = own_secrets(&h.auth)
                && match &h.auth {
                    AuthMethod::Identity { identity_id } => identity_ids.contains(identity_id),
                    _ => true,
                };
            if !ok {
                hosts_dropped += 1;
            }
            ok
        })
        .cloned()
        .map(|mut h| {
            h.auth = remap_auth(h.auth, &remap, &identity_remap);
            h.agent_keys = bundled_keys(h.agent_keys, &bundled, &remap);
            h
        })
        .collect();

    services.vault.put_secrets(to_add)?;
    (report.identities_added, report.identities_skipped) = services.identities.import(identities)?;
    let (added, skipped, forwards) = services.hosts.import(hosts)?;
    report.hosts_added = added.len();
    report.hosts_skipped = skipped + hosts_dropped;
    report.forwards_added = forwards;
    if !bundle.known_hosts.is_empty() {
        crate::known_hosts::import_content(bundle.known_hosts.as_bytes())?;
    }
    Ok(())
}

fn bundled_keys(keys: Vec<String>, bundled: &HashSet<&str>, remap: &HashMap<String, String>) -> Vec<String> {
    keys.into_iter()
        .filter(|k| bundled.contains(k.as_str()))
        .map(|k| remap.get(&k).cloned().unwrap_or(k))
        .collect()
}

enum SecretAction {
    Skip,
    Add(String),
}

type SecretPlan = (Vec<(String, SecretKind, Vec<u8>)>, HashMap<String, String>, usize);

fn plan_secrets(secrets: &[ExportedSecret], existing: &HashMap<String, Zeroizing<Vec<u8>>>) -> Result<SecretPlan> {
    let mut used: HashSet<String> = existing.keys().cloned().collect();
    used.extend(secrets.iter().map(|s| s.id.clone()));
    let mut to_add = Vec::new();
    let mut remap = HashMap::new();
    let mut skipped = 0;
    for s in secrets {
        let raw = Zeroizing::new(b64().decode(&s.value).map_err(|_| AppError::Crypto)?);
        let existing_val = existing.get(&s.id).map(|z| z.as_slice());
        match plan_secret(&s.id, raw.as_slice(), existing_val, &mut used) {
            SecretAction::Skip => skipped += 1,
            SecretAction::Add(final_id) => {
                if final_id != s.id {
                    remap.insert(s.id.clone(), final_id.clone());
                }
                to_add.push((final_id, s.kind, raw.to_vec()));
            }
        }
    }
    Ok((to_add, remap, skipped))
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

fn remap_auth(auth: AuthMethod, remap: &HashMap<String, String>, identities: &HashMap<String, String>) -> AuthMethod {
    let swap = |id: String| remap.get(&id).cloned().unwrap_or(id);
    match auth {
        AuthMethod::Password { secret_id } => AuthMethod::Password { secret_id: swap(secret_id) },
        AuthMethod::Key { secret_id } => AuthMethod::Key { secret_id: swap(secret_id) },
        AuthMethod::Agent => AuthMethod::Agent,
        AuthMethod::Identity { identity_id } => AuthMethod::Identity {
            identity_id: identities.get(&identity_id).cloned().unwrap_or(identity_id),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn used_of(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_host_keeps_only_agent_keys_from_the_same_file() {
        let bundled: HashSet<&str> = ["a", "b"].into_iter().collect();
        let remap: HashMap<String, String> = [("b".to_string(), "b-2".to_string())].into_iter().collect();
        let keys = vec!["a".to_string(), "b".to_string(), "mine".to_string()];
        assert_eq!(bundled_keys(keys, &bundled, &remap), ["a", "b-2"]);
    }

    #[test]
    fn a_file_without_some_parts_still_loads() {
        let only_settings = br#"{"version":1,"settings":{"prefs":{"kestral-theme":"dark"},"minimize_to_tray":true,"protected_paths":["/etc/shadow"]}}"#;
        let bundle: Bundle = serde_json::from_slice(only_settings).unwrap();
        assert!(bundle.hosts.is_empty() && bundle.secrets.is_empty() && bundle.snippets.is_empty());
        let settings = bundle.settings.unwrap();
        assert_eq!(settings.prefs["kestral-theme"], "dark");
        assert!(settings.minimize_to_tray && settings.ai_caps.is_none());
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
    fn renamed_clash_never_lands_on_an_id_the_bundle_still_uses() {
        let secret = |id: &str, value: &[u8]| ExportedSecret {
            id: id.into(),
            kind: SecretKind::Password,
            value: b64().encode(value),
        };
        let mut existing = HashMap::new();
        existing.insert("x".to_string(), Zeroizing::new(b"TARGET".to_vec()));
        let bundle = [secret("x", b"A1"), secret("x-2", b"A2")];

        let (to_add, remap, skipped) = plan_secrets(&bundle, &existing).unwrap();

        assert_eq!(skipped, 0);
        let ids: HashSet<&str> = to_add.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        let a1 = remap.get("x").expect("the clashing id must be renamed");
        assert_ne!(a1, "x-2");
        let value_of = |id: &str| to_add.iter().find(|(i, _, _)| i == id).map(|(_, _, v)| v.clone()).unwrap();
        assert_eq!(value_of(a1), b"A1");
        assert_eq!(value_of("x-2"), b"A2");
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
            &HashMap::new(),
        );
        assert!(matches!(rewritten, AuthMethod::Password { secret_id } if secret_id == "admin@server-2"));

        let untouched = remap_auth(AuthMethod::Key { secret_id: "other".into() }, &remap, &HashMap::new());
        assert!(matches!(untouched, AuthMethod::Key { secret_id } if secret_id == "other"));

        assert!(matches!(remap_auth(AuthMethod::Agent, &remap, &HashMap::new()), AuthMethod::Agent));
    }
}
