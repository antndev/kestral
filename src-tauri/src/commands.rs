use russh::ChannelMsg;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use std::sync::Arc;

use crate::audit::AuditEntry;
use crate::error::{AppError, Result};
use crate::forward::ForwardManager;
use crate::model::{AiPolicy, Host, NewHost, NewSnippet, Snippet};
use crate::policy::AiStatus;
use crate::sftp::{FileEntry, SftpSessions};
use crate::ssh::CommandOutput;
use crate::state::{AppState, McpInfo};
use crate::vault::{SecretKind, SecretMeta, SecretStore};

fn parse_id(id: &str) -> Result<Uuid> {
    Uuid::parse_str(id).map_err(|_| AppError::NotFound(id.to_string()))
}

#[tauri::command]
pub async fn vault_exists(state: State<'_, AppState>) -> Result<bool> {
    Ok(state.services.vault.exists())
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<bool> {
    Ok(state.services.vault.is_unlocked())
}

#[tauri::command]
pub async fn vault_create(state: State<'_, AppState>, master: String) -> Result<()> {
    let vault = state.services.vault.clone();
    let hosts = state.services.hosts.clone();
    let snippets = state.services.snippets.clone();
    let master = Zeroizing::new(master);
    tokio::task::spawn_blocking(move || -> Result<()> {
        vault.create(master.as_str())?;
        if let Err(e) = hosts.load() {
            tracing::error!("Loading hosts after vault creation failed: {e}");
        }
        if let Err(e) = snippets.load() {
            tracing::error!("Loading snippets after vault creation failed: {e}");
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, AppState>, master: String) -> Result<()> {
    let vault = state.services.vault.clone();
    let hosts = state.services.hosts.clone();
    let snippets = state.services.snippets.clone();
    let audit = state.services.audit.clone();
    let master = Zeroizing::new(master);
    tokio::task::spawn_blocking(move || -> Result<()> {
        let started = std::time::Instant::now();
        vault.unlock(master.as_str())?;
        let kdf = started.elapsed();
        if let Err(e) = hosts.load() {
            tracing::error!("Loading hosts after unlock failed: {e}");
        }
        if let Err(e) = snippets.load() {
            tracing::error!("Loading snippets after unlock failed: {e}");
        }
        let lists = started.elapsed();
        audit.load();
        tracing::info!(
            "unlock took {} ms (vault {} ms, hosts and snippets {} ms, audit {} ms)",
            started.elapsed().as_millis(),
            kdf.as_millis(),
            (lists - kdf).as_millis(),
            (started.elapsed() - lists).as_millis()
        );
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_lock(
    state: State<'_, AppState>,
    sessions: State<'_, SftpSessions>,
    transfers: State<'_, crate::sftp::Transfers>,
) -> Result<()> {
    transfers.cancel_all();
    sessions.clear();
    state.services.ai_pool.clear();
    state.services.vault.lock();
    state.services.hosts.clear();
    state.services.snippets.clear();
    state.services.audit.clear();
    Ok(())
}

#[tauri::command]
pub async fn vault_change_master(
    state: State<'_, AppState>,
    hello: State<'_, crate::hello::Hello>,
    current: String,
    new: String,
) -> Result<()> {
    let vault = state.services.vault.clone();
    let current = Zeroizing::new(current);
    let new = Zeroizing::new(new);
    tokio::task::spawn_blocking(move || -> Result<()> {
        vault.change_master(current.as_str(), new.as_str())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    hello.forget();
    Ok(())
}

#[tauri::command]
pub async fn vault_export(
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<()> {
    let services = state.services.clone();
    let password = Zeroizing::new(password);
    tokio::task::spawn_blocking(move || -> Result<()> {
        let bytes = crate::portable::export(&services, password.as_str())?;
        crate::util::atomic_write(std::path::Path::new(&path), &bytes)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn vault_import(
    state: State<'_, AppState>,
    path: String,
    password: String,
) -> Result<crate::portable::ImportReport> {
    let services = state.services.clone();
    let password = Zeroizing::new(password);
    tokio::task::spawn_blocking(move || -> Result<crate::portable::ImportReport> {
        let bytes = std::fs::read(&path)?;
        crate::portable::import(&services, &bytes, password.as_str())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn secret_put(
    state: State<'_, AppState>,
    id: String,
    kind: SecretKind,
    value: String,
) -> Result<()> {
    let value = Zeroizing::new(value);
    state.services.vault.put_secret(&id, kind, value.as_bytes())
}

#[tauri::command]
pub async fn secret_list(state: State<'_, AppState>) -> Result<Vec<SecretMeta>> {
    state.services.vault.list_secrets()
}

#[derive(Serialize)]
pub struct PubkeyInfo {
    pub public_key: String,
    pub fingerprint: String,
    pub algorithm: String,
    pub bits: Option<u32>,
    pub encrypted: bool,
}

struct SysRng;

impl russh::keys::ssh_key::rand_core::TryRng for SysRng {
    type Error = std::convert::Infallible;
    fn try_next_u32(&mut self) -> std::result::Result<u32, Self::Error> {
        Ok(rand::RngCore::next_u32(&mut rand::rngs::OsRng))
    }
    fn try_next_u64(&mut self) -> std::result::Result<u64, Self::Error> {
        Ok(rand::RngCore::next_u64(&mut rand::rngs::OsRng))
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> std::result::Result<(), Self::Error> {
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, dst);
        Ok(())
    }
}

impl russh::keys::ssh_key::rand_core::TryCryptoRng for SysRng {}

fn pubkey_info(public: &russh::keys::ssh_key::PublicKey, encrypted: bool) -> Result<PubkeyInfo> {
    Ok(PubkeyInfo {
        public_key: public.to_openssh().map_err(|e| AppError::Ssh(format!("Public key: {e}")))?,
        fingerprint: public.fingerprint(russh::keys::ssh_key::HashAlg::Sha256).to_string(),
        algorithm: crate::local_agent::algorithm_label(public),
        bits: crate::local_agent::key_bits(public),
        encrypted,
    })
}

fn wrong_passphrase(e: impl std::fmt::Display) -> AppError {
    let text = e.to_string();
    if text.to_lowercase().contains("crypto") || text.to_lowercase().contains("decrypt") || text.to_lowercase().contains("padding") {
        AppError::Other("The passphrase is wrong.".into())
    } else {
        AppError::Ssh(format!("Load key: {text}"))
    }
}

fn open_private(private_key: &str, passphrase: Option<&str>) -> Result<russh::keys::PrivateKey> {
    if let Ok(parsed) = russh::keys::ssh_key::PrivateKey::from_openssh(private_key) {
        if !parsed.is_encrypted() {
            return Ok(parsed);
        }
        let Some(pass) = passphrase.filter(|p| !p.is_empty()) else {
            return Err(AppError::Other("This key is protected by a passphrase. Enter it to continue.".into()));
        };
        return parsed.decrypt(pass).map_err(wrong_passphrase);
    }
    match russh::keys::decode_secret_key(private_key, passphrase.filter(|p| !p.is_empty())) {
        Ok(k) => Ok(k),
        Err(e) if passphrase.is_none() && e.to_string().to_lowercase().contains("encrypt") => {
            Err(AppError::Other("This key is protected by a passphrase. Enter it to continue.".into()))
        }
        Err(e) => Err(wrong_passphrase(e)),
    }
}

#[tauri::command]
pub async fn derive_pubkey(private_key: String, passphrase: Option<String>) -> Result<PubkeyInfo> {
    let pk = Zeroizing::new(private_key);
    let pass = passphrase.map(Zeroizing::new);
    if let Ok(parsed) = russh::keys::ssh_key::PrivateKey::from_openssh(pk.as_str()) {
        if parsed.is_encrypted() && pass.as_ref().is_none_or(|p| p.is_empty()) {
            return pubkey_info(parsed.public_key(), true);
        }
    }
    let key = open_private(pk.as_str(), pass.as_ref().map(|p| p.as_str()))?;
    pubkey_info(key.public_key(), false)
}

#[tauri::command]
pub async fn decrypt_key(private_key: String, passphrase: String) -> Result<String> {
    let pk = Zeroizing::new(private_key);
    let pass = Zeroizing::new(passphrase);
    let key = open_private(pk.as_str(), Some(pass.as_str()))?;
    let pem = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(|e| AppError::Ssh(format!("Encode key: {e}")))?;
    Ok(pem.to_string())
}

#[tauri::command]
pub async fn export_private_key(
    state: State<'_, AppState>,
    id: String,
    path: String,
    passphrase: Option<String>,
) -> Result<()> {
    let bytes = state.services.vault.get_secret(&id)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| AppError::Other("This key is not valid text".into()))?;
    let key = open_private(text, None)?;
    let pass = passphrase.map(Zeroizing::new).filter(|p| !p.is_empty());
    let key = match &pass {
        Some(p) => key
            .encrypt(&mut SysRng, p.as_bytes())
            .map_err(|e| AppError::Ssh(format!("Encrypt key: {e}")))?,
        None => key,
    };
    let pem = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(|e| AppError::Ssh(format!("Encode key: {e}")))?;
    let target = std::path::PathBuf::from(path);
    let content = pem.as_bytes().to_vec();
    crate::util::blocking(move || Ok(crate::util::replace_file(&target, &content)?)).await
}

#[tauri::command]
pub async fn secret_reveal(state: State<'_, AppState>, id: String) -> Result<String> {
    let bytes = state.services.vault.get_secret(&id)?;
    String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::Other("This credential is not valid UTF-8 text".into()))
}

#[tauri::command]
pub async fn key_set_comment(state: State<'_, AppState>, id: String, comment: String) -> Result<()> {
    use russh::keys::ssh_key::{LineEnding, PrivateKey};
    let bytes = state.services.vault.get_secret(&id)?;
    let text = Zeroizing::new(
        String::from_utf8(bytes.to_vec()).map_err(|_| AppError::Other("This key is not valid text".into()))?,
    );
    let mut key = PrivateKey::from_openssh(text.trim()).map_err(|e| AppError::Ssh(format!("Read key: {e}")))?;
    if key.is_encrypted() {
        return Err(AppError::Other("This key has a passphrase, so its comment cannot be changed here".into()));
    }
    key.set_comment(comment.trim());
    let pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| AppError::Ssh(format!("Encode key: {e}")))?;
    state.services.vault.put_secret(&id, SecretKind::PrivateKey, pem.as_bytes())
}

#[tauri::command]
pub async fn generate_key(algorithm: Option<String>, comment: Option<String>) -> Result<String> {
    use russh::keys::ssh_key::private::{KeypairData, PrivateKey, RsaKeypair};
    use russh::keys::ssh_key::{Algorithm, EcdsaCurve, LineEnding};

    let algo = algorithm.unwrap_or_else(|| "ed25519".into());
    let comment = comment.unwrap_or_default();
    let pem = tokio::task::spawn_blocking(move || -> Result<String> {
        let mut rng = SysRng;
        let fail = |e: russh::keys::ssh_key::Error| AppError::Ssh(format!("Generate key: {e}"));
        let mut key = match algo.as_str() {
            "ed25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519).map_err(fail)?,
            "ecdsa" | "ecdsa-p256" => PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 }).map_err(fail)?,
            "ecdsa-p384" => PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 }).map_err(fail)?,
            "ecdsa-p521" => PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 }).map_err(fail)?,
            "rsa" | "rsa-4096" | "rsa-3072" => {
                let bits = if algo == "rsa-3072" { 3072 } else { 4096 };
                let pair = RsaKeypair::random(&mut rng, bits).map_err(fail)?;
                PrivateKey::new(KeypairData::Rsa(pair), "").map_err(fail)?
            }
            other => return Err(AppError::Ssh(format!("Unsupported key type: {other}"))),
        };
        key.set_comment(comment);
        let pem = key
            .to_openssh(LineEnding::LF)
            .map_err(|e| AppError::Ssh(format!("Encode key: {e}")))?;
        Ok(pem.to_string())
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    Ok(pem)
}

#[tauri::command]
pub fn app_changelog() -> String {
    include_str!("../../CHANGELOG.md").to_string()
}

#[tauri::command]
pub fn drag_icon_path() -> std::result::Result<String, String> {
    let path = std::env::temp_dir().join("kestral-drag-icon.png");
    if !path.exists() {
        let bytes = include_bytes!("../icons/32x32.png");
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn secret_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.services.vault.delete_secret(&id)
}

#[tauri::command]
pub async fn secret_copy(state: State<'_, AppState>, from: String, to: String) -> Result<()> {
    state.services.vault.copy_secret(&from, &to)
}

#[derive(Serialize)]
pub struct HostTestResult {
    pub ok: bool,
    pub message: String,
    pub auth: String,
    pub elapsed_ms: u64,
}

#[tauri::command]
pub async fn host_test(state: State<'_, AppState>, mut host: Host, password: Option<String>) -> Result<HostTestResult> {
    host.normalize();
    let temp = match password.map(Zeroizing::new) {
        Some(pw) => {
            let id = format!("kestral-test-{}", Uuid::new_v4());
            state.services.vault.put_secret(&id, crate::vault::SecretKind::Password, pw.as_bytes())?;
            host.auth = crate::model::AuthMethod::Password { secret_id: id.clone() };
            Some(id)
        }
        None => None,
    };
    let started = std::time::Instant::now();
    let result = state.services.ssh.connect_info(&host, &state.services.vault, &|_, _| {}, None).await;
    if let Some(id) = temp {
        let _ = state.services.vault.delete_secret(&id);
    }
    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    Ok(match result {
        Ok(c) => {
            let _ = c.session.disconnect(russh::Disconnect::ByApplication, "", "").await;
            HostTestResult { ok: true, message: "Connected and signed in".into(), auth: c.auth, elapsed_ms }
        }
        Err(e) => HostTestResult { ok: false, message: e.to_string(), auth: String::new(), elapsed_ms },
    })
}

#[tauri::command]
pub async fn identity_list(state: State<'_, AppState>) -> Result<Vec<crate::model::Identity>> {
    state.services.identities.list()
}

#[tauri::command]
pub async fn identity_add(state: State<'_, AppState>, identity: crate::model::NewIdentity) -> Result<crate::model::Identity> {
    state.services.identities.add(identity)
}

#[tauri::command]
pub async fn identity_update(state: State<'_, AppState>, identity: crate::model::Identity) -> Result<()> {
    state.services.identities.update(identity)
}

#[tauri::command]
pub async fn identity_remove(state: State<'_, AppState>, id: String) -> Result<()> {
    let id = parse_id(&id)?;
    state.services.identities.remove(id, &state.services.hosts.list())
}

#[tauri::command]
pub async fn host_list(state: State<'_, AppState>) -> Result<Vec<Host>> {
    Ok(state.services.hosts.list())
}

#[tauri::command]
pub async fn host_add(state: State<'_, AppState>, host: NewHost) -> Result<Host> {
    state.services.hosts.add(host)
}

#[tauri::command]
pub async fn host_update(state: State<'_, AppState>, host: Host) -> Result<()> {
    let id = host.id;
    let agent = (host.forward_agent, host.agent_keys.clone());
    let before = state.services.hosts.get(id).ok();
    state.services.hosts.update(host)?;
    if before.is_some_and(|b| (b.forward_agent, b.agent_keys) != agent) {
        let ssh = &state.services.ssh;
        for h in state.services.hosts.list() {
            if h.id == id || ssh.jump_chain(&h).is_ok_and(|chain| chain.iter().any(|j| j.id == id)) {
                state.services.ai_pool.forget(h.id).await;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn host_remove(
    state: State<'_, AppState>,
    forwards: State<'_, ForwardManager>,
    id: String,
) -> Result<()> {
    let hid = parse_id(&id)?;
    // Stop any running port forwards first, or their listeners and SSH sessions
    // would keep running with no card left to stop them.
    forwards.stop_host(hid).await;
    state.services.ai_pool.forget(hid).await;
    state.services.hosts.remove(hid)?;
    state.services.snippets.remove_host(hid)?;
    Ok(())
}

#[tauri::command]
pub async fn host_set_policy(
    state: State<'_, AppState>,
    id: String,
    policy: AiPolicy,
) -> Result<()> {
    state.services.hosts.set_policy(parse_id(&id)?, policy)
}

#[tauri::command]
pub async fn host_set_file_policy(
    state: State<'_, AppState>,
    id: String,
    policy: AiPolicy,
) -> Result<()> {
    state.services.hosts.set_file_policy(parse_id(&id)?, policy)
}

#[tauri::command]
pub async fn ai_status(state: State<'_, AppState>) -> Result<AiStatus> {
    Ok(state.services.policy.status())
}

#[tauri::command]
pub async fn ai_enable(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    minutes: Option<i64>,
) -> Result<()> {
    state.services.policy.enable(minutes);
    crate::refresh_tray_ai(&app);
    Ok(())
}

#[tauri::command]
pub async fn ai_disable(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<()> {
    state.services.policy.disable();
    state.services.ai_pool.clear();
    crate::refresh_tray_ai(&app);
    Ok(())
}

#[tauri::command]
pub async fn ai_caps(state: State<'_, AppState>) -> Result<crate::policy::AiCaps> {
    Ok(state.services.policy.caps())
}

#[tauri::command]
pub async fn ai_set_caps(state: State<'_, AppState>, caps: crate::policy::AiCaps) -> Result<()> {
    state.services.policy.set_caps(caps);
    Ok(())
}

#[tauri::command]
pub async fn ai_protected_list(state: State<'_, AppState>) -> Result<Vec<String>> {
    Ok(state.services.policy.protected_paths())
}

#[tauri::command]
pub async fn ai_set_protected(state: State<'_, AppState>, paths: Vec<String>) -> Result<()> {
    state.services.policy.set_protected_paths(paths);
    Ok(())
}

#[tauri::command]
pub async fn approval_respond(
    state: State<'_, AppState>,
    id: String,
    approved: bool,
) -> Result<()> {
    state.services.approval.resolve(&id, approved);
    Ok(())
}

#[tauri::command]
pub async fn audit_list(state: State<'_, AppState>) -> Result<Vec<AuditEntry>> {
    Ok(state.services.audit.list())
}

#[derive(serde::Serialize)]
pub struct AuditDelta {
    full: bool,
    entries: Vec<AuditEntry>,
}

#[tauri::command]
pub async fn audit_since(
    state: State<'_, AppState>,
    after: Option<String>,
    limit: Option<usize>,
) -> Result<AuditDelta> {
    let (full, entries) = state.services.audit.since(after.as_deref(), limit);
    Ok(AuditDelta { full, entries })
}

#[tauri::command]
pub async fn audit_user_command(
    state: State<'_, AppState>,
    host_id: String,
    command: String,
) -> Result<()> {
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    state.services.audit.record(
        host.id.to_string(),
        host.name,
        command,
        "user",
        None,
        true,
        None,
    );
    Ok(())
}

#[tauri::command]
pub async fn snippet_list(state: State<'_, AppState>) -> Result<Vec<Snippet>> {
    Ok(state.services.snippets.list())
}

#[tauri::command]
pub async fn snippet_add(state: State<'_, AppState>, snippet: NewSnippet) -> Result<Snippet> {
    state.services.snippets.add(snippet)
}

#[tauri::command]
pub async fn snippet_update(state: State<'_, AppState>, mut snippet: Snippet) -> Result<()> {
    snippet.ai_edited = false;
    state.services.snippets.update(snippet)
}

#[tauri::command]
pub async fn snippet_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    state.services.snippets.remove(parse_id(&id)?)
}

#[tauri::command]
pub async fn mcp_info(state: State<'_, AppState>) -> Result<McpInfo> {
    Ok(state.mcp.lock().unwrap().clone())
}

#[derive(Serialize)]
pub struct RotateResult {
    pub info: McpInfo,
    pub reconnected: bool,
    pub message: String,
}

#[tauri::command]
pub async fn mcp_rotate_token(state: State<'_, AppState>, name: String) -> Result<RotateResult> {
    let new_token = crate::vault::random_token();
    crate::util::atomic_write(&state.mcp_token_path, new_token.as_bytes())?;
    {
        let mut b = state
            .mcp_bearer
            .write()
            .map_err(|_| AppError::Other("Token lock poisoned".into()))?;
        *b = new_token.clone();
    }
    let info = {
        let mut i = state.mcp.lock().unwrap();
        i.token = new_token.clone();
        i.clone()
    };

    let name = server_name(name);
    let url = info.url.clone();
    let (reconnected, message) = tokio::task::spawn_blocking(move || {
        if !is_registered(&name) {
            return (
                false,
                "New token active. No Claude Code registration found, nothing to update.".to_string(),
            );
        }
        match register_claude_code(&name, &url, &new_token) {
            Ok(_) => (
                true,
                "New token active and Claude Code re-registered. Start a new Claude session."
                    .to_string(),
            ),
            Err(e) => (
                false,
                format!("New token active, but updating Claude Code failed: {e}"),
            ),
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?;

    Ok(RotateResult {
        info,
        reconnected,
        message,
    })
}

#[derive(Serialize)]
pub struct ConnectResult {
    pub ok: bool,
    pub message: String,
}

#[tauri::command]
pub async fn mcp_connect_claude_code(state: State<'_, AppState>, name: String) -> Result<ConnectResult> {
    let (url, token) = {
        let info = state.mcp.lock().unwrap();
        (info.url.clone(), info.token.clone())
    };
    let name = server_name(name);

    let out = tokio::task::spawn_blocking(move || register_claude_code(&name, &url, &token))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?;

    Ok(match out {
        Ok(text) => ConnectResult {
            ok: true,
            message: format!(
                "{}\nStart a new Claude session so the tools get loaded.",
                text.trim()
            ),
        },
        Err(e) => ConnectResult {
            ok: false,
            message: e,
        },
    })
}

#[tauri::command]
pub async fn install_skill(state: State<'_, AppState>) -> Result<crate::skill::InstallResult> {
    let _ = state;
    tokio::task::spawn_blocking(crate::skill::install)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn uninstall_skill() -> Result<String> {
    tokio::task::spawn_blocking(crate::skill::uninstall)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn skill_installed() -> Result<bool> {
    Ok(crate::skill::installed())
}

#[derive(Serialize)]
pub struct Registration {
    pub name: String,
    pub url: String,
    pub connected: bool,
    pub is_this_app: bool,
}

#[tauri::command]
pub async fn mcp_list_registrations(state: State<'_, AppState>) -> Result<Vec<Registration>> {
    let my_url = state.mcp.lock().unwrap().url.clone();
    let text = tokio::task::spawn_blocking(|| run_claude(&["mcp", "list"]))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .unwrap_or_default();

    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((name, rest)) = line.split_once(": ") else {
            continue;
        };
        if name.is_empty() || name.contains(' ') {
            continue;
        }
        let url = rest.split_whitespace().next().unwrap_or("").to_string();
        if !url.starts_with("http") {
            continue;
        }
        out.push(Registration {
            is_this_app: url == my_url,
            connected: rest.contains("Connected") && !rest.contains("Failed"),
            name: name.to_string(),
            url,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn mcp_remove_registration(name: String) -> Result<String> {
    tokio::task::spawn_blocking(move || {
        run_claude(&["mcp", "remove", name.as_str(), "--scope", "user"])
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
    .map_err(AppError::Other)
}

#[tauri::command]
pub async fn data_warnings(state: State<'_, AppState>) -> Result<Vec<String>> {
    Ok([
        state.services.hosts.warning(),
        state.services.snippets.warning(),
    ]
    .into_iter()
    .flatten()
    .collect())
}

fn server_name(name: String) -> String {
    let n = name.trim();
    if n.is_empty() {
        "kestral".to_string()
    } else {
        n.to_string()
    }
}

fn is_registered(name: &str) -> bool {
    run_claude(&["mcp", "get", name]).is_ok()
}

fn register_claude_code(name: &str, url: &str, token: &str) -> std::result::Result<String, String> {
    let header = format!("Authorization: Bearer {token}");
    let _ = run_claude(&["mcp", "remove", name, "--scope", "user"]);
    run_claude(&[
        "mcp",
        "add",
        "--transport",
        "http",
        name,
        url,
        "--header",
        header.as_str(),
        "--scope",
        "user",
    ])
}

fn run_claude(args: &[&str]) -> std::result::Result<String, String> {
    let mut cmd = std::process::Command::new("claude");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.args(args).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "The Claude CLI was not found. Is `claude` installed and on PATH?".to_string()
        } else {
            format!("The Claude CLI could not be started: {e}")
        }
    })?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let so = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Err(if err.is_empty() { so } else { err })
    }
}

#[tauri::command]
pub async fn run_command_ui(
    state: State<'_, AppState>,
    host_id: String,
    command: String,
    pty: Option<bool>,
) -> Result<CommandOutput> {
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    let out = state
        .services
        .ssh
        .run_command_opts(&host, &state.services.vault, &command, pty.unwrap_or(false))
        .await;

    match &out {
        Ok(o) => state.services.audit.record(
            host.id.to_string(),
            host.name.clone(),
            command.clone(),
            "user",
            o.exit_status,
            o.exit_signal.is_none() && o.exit_status == Some(0),
            None,
        ),
        Err(e) => state.services.audit.record(
            host.id.to_string(),
            host.name.clone(),
            command.clone(),
            "user",
            None,
            false,
            Some(e.to_string()),
        ),
    }
    out
}

#[derive(Serialize)]
pub struct StreamExit {
    pub exit_status: Option<i32>,
    pub exit_signal: Option<String>,
}

/// Run a command and stream its output live to the frontend over `on_output`,
/// the same way the interactive terminal does, then return the exit status. A
/// PTY is requested so output looks exactly like a normal session.
#[tauri::command]
pub async fn run_command_stream(
    state: State<'_, AppState>,
    host_id: String,
    command: String,
    on_output: Channel<InvokeResponseBody>,
) -> Result<StreamExit> {
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    let session = state
        .services
        .ssh
        .connect(&host, &state.services.vault)
        .await?;
    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("Channel: {e}")))?;
    let _ = channel
        .request_pty(true, "xterm-256color", 120, 34, 0, 0, &[])
        .await;
    channel
        .exec(true, command.as_str())
        .await
        .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

    let mut exit_status: Option<i32> = None;
    let mut exit_signal: Option<String> = None;
    let pump = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    let _ = on_output.send(InvokeResponseBody::Raw(data.to_vec()));
                }
                ChannelMsg::ExtendedData { ref data, ext } => {
                    if ext == 1 {
                        let _ = on_output.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                }
                ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code as i32),
                ChannelMsg::ExitSignal { signal_name, .. } => {
                    exit_signal = Some(format!("{signal_name:?}"));
                }
                _ => {}
            }
        }
    };
    // Bound a streamed run too, so a runaway command (a stray `yes`) cannot stream
    // forever. 30 minutes is generous for a real script; the frontend also caps
    // how much output it keeps.
    if tokio::time::timeout(std::time::Duration::from_secs(1800), pump)
        .await
        .is_err()
    {
        exit_signal.get_or_insert_with(|| "timed out after 30 min".to_string());
    }

    let success = exit_signal.is_none() && exit_status == Some(0);
    state.services.audit.record(
        host.id.to_string(),
        host.name.clone(),
        command.clone(),
        "user",
        exit_status,
        success,
        exit_signal.clone(),
    );
    Ok(StreamExit {
        exit_status,
        exit_signal,
    })
}

#[tauri::command]
pub async fn forward_start(
    state: State<'_, AppState>,
    forwards: State<'_, ForwardManager>,
    host_id: String,
    forward_id: String,
) -> Result<()> {
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    let fid = parse_id(&forward_id)?;
    let fwd = host
        .forwards
        .iter()
        .find(|f| f.id == fid)
        .cloned()
        .ok_or_else(|| AppError::NotFound(forward_id.clone()))?;
    forwards
        .start(&state.services.ssh, &host, &state.services.vault, &fwd)
        .await
}

#[tauri::command]
pub async fn forward_stop(
    forwards: State<'_, ForwardManager>,
    host_id: String,
    forward_id: String,
) -> Result<()> {
    forwards
        .stop(parse_id(&host_id)?, parse_id(&forward_id)?)
        .await;
    Ok(())
}

#[tauri::command]
pub async fn forward_stats(forwards: State<'_, ForwardManager>) -> Result<std::collections::HashMap<String, u32>> {
    Ok(forwards.stats())
}

#[tauri::command]
pub async fn forward_active(forwards: State<'_, ForwardManager>) -> Result<Vec<String>> {
    Ok(forwards
        .active_ids()
        .iter()
        .map(|f| f.to_string())
        .collect())
}

fn sftp_handle(
    sessions: &SftpSessions,
    id: &str,
) -> Result<Arc<crate::sftp::SftpHandle>> {
    sessions
        .get(id)
        .ok_or_else(|| AppError::Other("SFTP session not found".into()))
}

#[tauri::command]
pub async fn sftp_open(
    state: State<'_, AppState>,
    sessions: State<'_, SftpSessions>,
    id: String,
    host_id: String,
) -> Result<String> {
    sessions.remove(&id);
    let host = state.services.hosts.get(parse_id(&host_id)?)?;
    let handle = crate::sftp::connect(&state.services.ssh, &state.services.vault, &host).await?;
    let home = handle.home().await.unwrap_or_else(|_| "/".to_string());
    sessions.insert(id, Arc::new(handle));
    Ok(home)
}

#[tauri::command]
pub async fn sftp_list(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
) -> Result<Vec<FileEntry>> {
    sftp_handle(&sessions, &id)?.list(&path).await
}

#[tauri::command]
pub async fn sftp_download(
    sessions: State<'_, SftpSessions>,
    id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    sftp_handle(&sessions, &id)?
        .download(&remote, std::path::Path::new(&local), &crate::sftp::Xfer::default())
        .await
}

#[tauri::command]
pub async fn sftp_download_dir(
    sessions: State<'_, SftpSessions>,
    id: String,
    remote: String,
    local: String,
) -> Result<u64> {
    sftp_handle(&sessions, &id)?
        .download_dir(&remote, std::path::Path::new(&local), &crate::sftp::Xfer::default())
        .await
}

#[tauri::command]
pub async fn sftp_upload(
    sessions: State<'_, SftpSessions>,
    id: String,
    local: String,
    remote: String,
) -> Result<u64> {
    sftp_handle(&sessions, &id)?
        .upload(std::path::Path::new(&local), &remote, &crate::sftp::Xfer::default())
        .await
}

#[tauri::command]
pub async fn sftp_upload_dir(
    sessions: State<'_, SftpSessions>,
    id: String,
    local: String,
    remote: String,
) -> Result<u64> {
    sftp_handle(&sessions, &id)?
        .upload_dir(std::path::Path::new(&local), &remote, &crate::sftp::Xfer::default())
        .await
}

#[tauri::command]
pub async fn sftp_read_text(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
) -> Result<String> {
    sftp_handle(&sessions, &id)?.read_text(&path).await
}

#[tauri::command]
pub async fn sftp_write_text(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
    content: String,
) -> Result<()> {
    sftp_handle(&sessions, &id)?.write_text(&path, &content).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
) -> Result<()> {
    sftp_handle(&sessions, &id)?.mkdir(&path).await
}

#[tauri::command]
pub async fn sftp_remove(
    sessions: State<'_, SftpSessions>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    sftp_handle(&sessions, &id)?.remove(&path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename(
    sessions: State<'_, SftpSessions>,
    id: String,
    from: String,
    to: String,
) -> Result<()> {
    sftp_handle(&sessions, &id)?.rename(&from, &to).await
}

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub done: u64,
    pub total: Option<u64>,
}

async fn run_transfer<F>(
    transfers: &crate::sftp::Transfers,
    transfer_id: &str,
    cancel: tokio_util::sync::CancellationToken,
    total: Option<u64>,
    on_progress: tauri::ipc::Channel<TransferProgress>,
    work: impl FnOnce(crate::sftp::Xfer) -> F,
) -> Result<u64>
where
    F: std::future::Future<Output = Result<u64>>,
{
    if cancel.is_cancelled() {
        transfers.finish(transfer_id);
        return Err(AppError::Other("Cancelled".into()));
    }
    let x = crate::sftp::Xfer { cancel, ..Default::default() };
    let done = x.done.clone();
    let stop = tokio_util::sync::CancellationToken::new();
    let ticker = {
        let stop = stop.clone();
        let done = done.clone();
        let channel = on_progress.clone();
        tokio::spawn(async move {
            loop {
                let _ = channel.send(TransferProgress { done: done.load(std::sync::atomic::Ordering::Relaxed), total });
                tokio::select! {
                    _ = stop.cancelled() => break,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
                }
            }
        })
    };
    let result = work(x).await;
    stop.cancel();
    let _ = ticker.await;
    transfers.finish(transfer_id);
    if let Ok(n) = &result {
        let _ = on_progress.send(TransferProgress { done: *n, total: total.map(|t| t.max(*n)) });
    }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_transfer(
    sessions: State<'_, SftpSessions>,
    transfers: State<'_, crate::sftp::Transfers>,
    id: String,
    transfer_id: String,
    upload: bool,
    is_dir: bool,
    local: String,
    remote: String,
    on_progress: tauri::ipc::Channel<TransferProgress>,
) -> Result<u64> {
    let h = sftp_handle(&sessions, &id)?;
    let cancel = transfers.register(&transfer_id);
    let local_path = std::path::PathBuf::from(&local);
    let total = if upload {
        let p = local_path.clone();
        crate::util::blocking(move || Ok(crate::sftp::local_size(&p))).await.ok()
    } else {
        Some(h.size(&remote, is_dir).await)
    };
    run_transfer(&transfers, &transfer_id, cancel, total, on_progress, |x| async move {
        match (upload, is_dir) {
            (true, true) => h.upload_dir(&local_path, &remote, &x).await,
            (true, false) => h.upload(&local_path, &remote, &x).await,
            (false, true) => h.download_dir(&remote, &local_path, &x).await,
            (false, false) => h.download(&remote, &local_path, &x).await,
        }
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_copy_remote(
    sessions: State<'_, SftpSessions>,
    transfers: State<'_, crate::sftp::Transfers>,
    src_id: String,
    dst_id: String,
    transfer_id: String,
    src_path: String,
    dst_path: String,
    is_dir: bool,
    on_progress: tauri::ipc::Channel<TransferProgress>,
) -> Result<u64> {
    let src = sftp_handle(&sessions, &src_id)?;
    let dst = sftp_handle(&sessions, &dst_id)?;
    let cancel = transfers.register(&transfer_id);
    let total = Some(src.size(&src_path, is_dir).await);
    run_transfer(&transfers, &transfer_id, cancel, total, on_progress, |x| async move {
        src.copy_to(&src_path, &dst, &dst_path, is_dir, &x).await
    })
    .await
}

#[tauri::command]
pub async fn sftp_cancel(transfers: State<'_, crate::sftp::Transfers>, transfer_id: String) -> Result<()> {
    transfers.cancel(&transfer_id);
    Ok(())
}

#[tauri::command]
pub async fn sftp_close(sessions: State<'_, SftpSessions>, id: String) -> Result<()> {
    sessions.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn data_dir(state: State<'_, AppState>) -> Result<String> {
    Ok(state
        .mcp_token_path
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn settings_get(
    settings: State<'_, Arc<crate::settings::SettingsStore>>,
) -> Result<crate::settings::AppSettings> {
    Ok(settings.get())
}

#[tauri::command]
pub async fn settings_set_minimize_to_tray(
    settings: State<'_, Arc<crate::settings::SettingsStore>>,
    enabled: bool,
) -> Result<()> {
    settings.set_minimize_to_tray(enabled);
    Ok(())
}

#[tauri::command]
pub async fn settings_set_onboarded(
    settings: State<'_, Arc<crate::settings::SettingsStore>>,
) -> Result<()> {
    settings.set_onboarded();
    Ok(())
}

#[tauri::command]
pub async fn snippet_folder_list(state: State<'_, AppState>) -> Result<Vec<String>> {
    let s = &state.services;
    s.collections.list(s.snippets.folders())
}

#[tauri::command]
pub async fn snippet_folder_add(state: State<'_, AppState>, name: String) -> Result<String> {
    let s = &state.services;
    s.collections.add(&name, s.snippets.folders())
}

#[tauri::command]
pub async fn snippet_folder_rename(state: State<'_, AppState>, from: String, to: String) -> Result<String> {
    let s = &state.services;
    let to = s.collections.rename(&from, &to, s.snippets.folders())?;
    s.snippets.set_folder(&from, &to)?;
    Ok(to)
}

#[tauri::command]
pub async fn snippet_folder_remove(state: State<'_, AppState>, name: String) -> Result<usize> {
    let s = &state.services;
    let moved = s.snippets.set_folder(&name, "")?;
    s.collections.remove(&name, s.snippets.folders())?;
    Ok(moved)
}

#[tauri::command]
pub async fn snippet_folder_reorder(state: State<'_, AppState>, order: Vec<String>) -> Result<()> {
    let s = &state.services;
    s.collections.reorder(order, s.snippets.folders())
}
