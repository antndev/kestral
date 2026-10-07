use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

use russh::client;
use russh::keys::ssh_key;
use russh::keys::{decode_secret_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::Serialize;

use crate::agent::AgentContext;
use crate::audit::AuditLog;
use crate::error::{AppError, Result};
use crate::hostkey;
use crate::hosts::HostStore;
use crate::identities::IdentityStore;
use crate::known_hosts::{self, Verdict};
use crate::model::{AuthMethod, Host};
use crate::util::blocking;
use crate::vault::{SecretStore, Vault};

#[derive(Debug, Clone, Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_status: Option<i32>,
    pub exit_signal: Option<String>,
}

/// Why the host key check refused a connection, so connect can report it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum KeyOutcome {
    Pending = 0,
    Trusted,
    Changed,
    Rejected,
    Revoked,
    Unreadable,
}

impl KeyOutcome {
    fn from_u8(v: u8) -> Self {
        match v {
            1 => Self::Trusted,
            2 => Self::Changed,
            3 => Self::Rejected,
            4 => Self::Revoked,
            5 => Self::Unreadable,
            _ => Self::Pending,
        }
    }
}

const PROMPT_IDLE: u8 = 0;
const PROMPT_OPEN: u8 = 1;
const PROMPT_DONE: u8 = 2;
/// `connect_progress` gave up (timeout or its future was dropped). russh keeps
/// the handshake running in its own task, so a late host key check must not ask
/// the user or save anything for a connection that already failed.
const PROMPT_ABANDONED: u8 = 3;

/// State shared between the handshake's host key check and `connect_progress`.
#[derive(Default)]
struct KeyCheck {
    outcome: AtomicU8,
    prompt: AtomicU8,
}

impl KeyCheck {
    fn set(&self, outcome: KeyOutcome) {
        self.outcome.store(outcome as u8, Ordering::SeqCst);
    }
    fn outcome(&self) -> KeyOutcome {
        KeyOutcome::from_u8(self.outcome.load(Ordering::SeqCst))
    }
    fn abandoned(&self) -> bool {
        self.prompt.load(Ordering::SeqCst) == PROMPT_ABANDONED
    }
    fn advance(&self, from: u8, to: u8) -> bool {
        self.prompt
            .compare_exchange(from, to, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }
}

/// Marks the key check abandoned when `connect_progress` stops waiting for the
/// handshake without a result (timeout, or the caller dropped the future). A
/// question that is already on screen stays answerable.
struct AbandonGuard(Option<Arc<KeyCheck>>);

impl Drop for AbandonGuard {
    fn drop(&mut self) {
        if let Some(check) = self.0.take() {
            let _ = check.advance(PROMPT_IDLE, PROMPT_ABANDONED)
                || check.advance(PROMPT_DONE, PROMPT_ABANDONED);
        }
    }
}

pub struct ClientHandler {
    host: String,
    port: u16,
    check: Arc<KeyCheck>,
    agent: Option<Arc<AgentContext>>,
    _via: Option<Arc<client::Handle<ClientHandler>>>,
    forwarded: Option<ForwardedTx>,
}

pub struct ForwardedChannel {
    pub channel: russh::Channel<client::Msg>,
    pub address: String,
    pub port: u32,
}

pub type ForwardedTx = tokio::sync::mpsc::UnboundedSender<ForwardedChannel>;

impl ClientHandler {
    async fn save_key(&self, key: &ssh_key::PublicKey) {
        let (host, port, key) = (self.host.clone(), self.port, key.clone());
        let (h, p) = (host.clone(), port);
        if let Err(e) = blocking(move || known_hosts::append(&host, port, &key)).await {
            tracing::warn!("saving the host key failed: {e}");
            hostkey::notify_save_failed(&h, p, &e.to_string());
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        if self.check.abandoned() {
            return Ok(false);
        }
        let (host, port) = (self.host.clone(), self.port);
        let fp = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        let key_type = server_public_key.algorithm().as_str().to_string();

        let verified = {
            let (host, key) = (host.clone(), server_public_key.clone());
            blocking(move || known_hosts::verify(&host, port, &key)).await
        };
        let verdict = match verified {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("reading known hosts failed for {host}:{port}: {e}, refused");
                self.check.set(KeyOutcome::Unreadable);
                return Ok(false);
            }
        };

        match verdict {
            Verdict::Trusted => {
                self.check.set(KeyOutcome::Trusted);
                Ok(true)
            }
            Verdict::Changed(saved) => {
                // Covers a same-algorithm mismatch and a known host suddenly
                // offering another algorithm (possible downgrade MITM).
                let lines: Vec<usize> = saved.iter().map(|e| e.line).collect();
                tracing::error!(
                    "Host key CHANGED for {host}:{port} (known_hosts lines {lines:?}), fingerprint {fp}, refused"
                );
                self.check.set(KeyOutcome::Changed);
                if !self.check.abandoned() {
                    hostkey::notify_changed(&host, port, &key_type, &fp, &saved);
                }
                Ok(false)
            }
            Verdict::Revoked => {
                tracing::error!("Host key of {host}:{port} ({fp}) is marked @revoked, refused");
                self.check.set(KeyOutcome::Revoked);
                Ok(false)
            }
            Verdict::Unknown => {
                if !self.check.advance(PROMPT_IDLE, PROMPT_OPEN) {
                    tracing::info!(
                        "connect to {host}:{port} was abandoned, the new host key is not asked about"
                    );
                    return Ok(false);
                }
                let decision = hostkey::ask(&host, port, &key_type, &fp).await;
                self.check.advance(PROMPT_OPEN, PROMPT_DONE);
                match decision {
                    None => {
                        tracing::info!("TOFU: new host {host}:{port} accepted, fingerprint {fp}");
                        self.save_key(server_public_key).await;
                        self.check.set(KeyOutcome::Trusted);
                        Ok(true)
                    }
                    Some(d) if d.accept => {
                        tracing::info!(
                            "user trusted new host {host}:{port} ({fp}){}",
                            if d.save {
                                ", saved to known_hosts"
                            } else {
                                " for this connection"
                            }
                        );
                        if d.save {
                            self.save_key(server_public_key).await;
                        }
                        self.check.set(KeyOutcome::Trusted);
                        Ok(true)
                    }
                    Some(_) => {
                        tracing::warn!("user did not trust new host {host}:{port} ({fp})");
                        self.check.set(KeyOutcome::Rejected);
                        Ok(false)
                    }
                }
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        if let Some(tx) = &self.forwarded {
            let _ = tx.send(ForwardedChannel {
                channel,
                address: connected_address.to_string(),
                port: connected_port,
            });
        }
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        if let Some(ctx) = &self.agent {
            tokio::spawn(crate::agent::serve(channel.into_stream(), ctx.clone()));
        }
        Ok(())
    }
}

pub struct SshManager {
    audit: Arc<AuditLog>,
    hosts: Arc<HostStore>,
    identities: Arc<IdentityStore>,
}

pub struct Connected {
    pub session: client::Handle<ClientHandler>,
    pub auth: String,
}

type ConnectFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = std::result::Result<client::Handle<ClientHandler>, russh::Error>> + Send>,
>;

const MAX_JUMPS: usize = 5;

fn key_family(a: &ssh_key::Algorithm) -> String {
    if matches!(a, ssh_key::Algorithm::Rsa { .. }) {
        "rsa".into()
    } else {
        a.as_str().to_string()
    }
}

impl SshManager {
    pub fn new(audit: Arc<AuditLog>, hosts: Arc<HostStore>, identities: Arc<IdentityStore>) -> Self {
        Self { audit, hosts, identities }
    }

    pub async fn connect(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
    ) -> Result<client::Handle<ClientHandler>> {
        Ok(self.connect_info(host, vault, &|_, _| {}, None).await?.session)
    }

    pub async fn connect_info(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        on_stage: &(dyn Fn(&str, &str) + Sync),
        password: Option<&str>,
    ) -> Result<Connected> {
        self.connect_chain(host, vault, on_stage, None, password).await
    }

    pub async fn connect_forwarding(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        tx: ForwardedTx,
    ) -> Result<client::Handle<ClientHandler>> {
        Ok(self.connect_chain(host, vault, &|_, _| {}, Some(tx), None).await?.session)
    }

    async fn connect_chain(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        on_stage: &(dyn Fn(&str, &str) + Sync),
        forwarded: Option<ForwardedTx>,
        password: Option<&str>,
    ) -> Result<Connected> {
        let chain = self.jump_chain(host)?;
        let mut via: Option<Arc<client::Handle<ClientHandler>>> = None;
        for jump in &chain {
            on_stage("jumping", &jump.name);
            let hop = self
                .connect_one(jump, vault, via.take(), &|_, _| {}, None, None)
                .await
                .map_err(|e| match e {
                    AppError::AuthFailed { .. } | AppError::Canceled => e,
                    other => AppError::Ssh(format!("Jump host {}: {other}", jump.name)),
                })?;
            on_stage("jumped", &jump.name);
            via = Some(Arc::new(hop.session));
        }
        self.connect_one(host, vault, via, on_stage, forwarded, password).await
    }

    pub fn jump_chain(&self, host: &Host) -> Result<Vec<Host>> {
        let mut chain = Vec::new();
        let mut seen = vec![host.id];
        let mut next = host.jump_host_id;
        while let Some(id) = next {
            if seen.contains(&id) {
                return Err(AppError::Ssh("The jump hosts form a loop. Check the jump host of each host in the chain.".into()));
            }
            if chain.len() >= MAX_JUMPS {
                return Err(AppError::Ssh(format!("More than {MAX_JUMPS} jump hosts in a row are not supported.")));
            }
            seen.push(id);
            let jump = self
                .hosts
                .get(id)
                .map_err(|_| AppError::Ssh(format!("The jump host of {} no longer exists.", host.name)))?;
            next = jump.jump_host_id;
            chain.push(jump);
        }
        chain.reverse();
        Ok(chain)
    }

    async fn preferred_for(&self, host: &Host) -> russh::Preferred {
        let mut preferred = russh::Preferred::default();
        let (h, port) = (host.hostname.clone(), host.port);
        let known = blocking(move || Ok(known_hosts::known_algorithms(&h, port)))
            .await
            .unwrap_or_default();
        if known.is_empty() {
            return preferred;
        }
        let families: Vec<String> = known.iter().map(key_family).collect();
        let (mut first, rest): (Vec<_>, Vec<_>) = preferred
            .key
            .iter()
            .cloned()
            .partition(|a| families.contains(&key_family(a)));
        first.extend(rest);
        preferred.key = std::borrow::Cow::Owned(first);
        preferred
    }

    #[allow(clippy::too_many_arguments)]
    async fn connect_one(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        via: Option<Arc<client::Handle<ClientHandler>>>,
        on_stage: &(dyn Fn(&str, &str) + Sync),
        forwarded: Option<ForwardedTx>,
        password: Option<&str>,
    ) -> Result<Connected> {
        let budget = std::time::Duration::from_secs(u64::from(host.options.connect_timeout_secs.unwrap_or(15).clamp(3, 300)));
        let keepalive = match host.options.keepalive_secs {
            Some(0) => None,
            Some(n) => Some(std::time::Duration::from_secs(u64::from(n.clamp(5, 3600)))),
            None => Some(std::time::Duration::from_secs(15)),
        };
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: keepalive,
            keepalive_max: 8,
            nodelay: true,
            preferred: self.preferred_for(host).await,
            ..Default::default()
        });

        let check = Arc::new(KeyCheck::default());
        let handler = ClientHandler {
            host: host.hostname.clone(),
            port: host.port,
            check: check.clone(),
            agent: AgentContext::build(host, vault, self.audit.clone()),
            _via: via.clone(),
            forwarded,
        };

        let mut abandon = AbandonGuard(Some(check.clone()));
        let connect_fut: ConnectFuture = match via {
            Some(jump) => {
                on_stage("connecting", &format!("{}:{}", host.hostname, host.port));
                let channel = tokio::time::timeout(
                    budget,
                    jump.channel_open_direct_tcpip(host.hostname.clone(), u32::from(host.port), "127.0.0.1", 0),
                )
                .await
                .map_err(|_| AppError::Ssh(format!("The jump host could not reach {}:{} in time", host.hostname, host.port)))?
                .map_err(|e| AppError::Ssh(format!("The jump host could not reach {}:{}: {e}", host.hostname, host.port)))?;
                Box::pin(client::connect_stream(config, channel.into_stream(), handler))
            }
            None => {
                on_stage("resolving", &host.hostname);
                let addrs: Vec<std::net::SocketAddr> = tokio::time::timeout(budget, tokio::net::lookup_host((host.hostname.as_str(), host.port)))
                    .await
                    .map_err(|_| AppError::Ssh(format!("Looking up {} took too long", host.hostname)))?
                    .map_err(|e| AppError::Ssh(format!("Could not find {}: {e}", host.hostname)))?
                    .collect();
                let first = addrs
                    .first()
                    .copied()
                    .ok_or_else(|| AppError::Ssh(format!("Could not find {}", host.hostname)))?;
                on_stage("resolved", &first.ip().to_string());
                on_stage("connecting", &first.to_string());
                let stream = tokio::time::timeout(budget, tokio::net::TcpStream::connect(&addrs[..]))
                    .await
                    .map_err(|_| AppError::Ssh(format!("Connection timed out after {}s", budget.as_secs())))?
                    .map_err(|e| AppError::Ssh(format!("Could not connect to {first}: {e}")))?;
                let _ = stream.set_nodelay(true);
                Box::pin(client::connect_stream(config, stream, handler))
            }
        };
        tokio::pin!(connect_fut);
        // The 15 s budget is for the network. While the user is looking at the
        // host key question it is paused, and after the answer the handshake
        // gets one fresh budget to finish.
        let mut deadline = tokio::time::Instant::now() + budget;
        let mut grace_used = false;
        let result = loop {
            tokio::select! {
                r = &mut connect_fut => break Some(r),
                _ = tokio::time::sleep_until(deadline) => {
                    match check.prompt.load(Ordering::SeqCst) {
                        PROMPT_OPEN => {}
                        PROMPT_DONE if !grace_used => grace_used = true,
                        _ => break None,
                    }
                    deadline = tokio::time::Instant::now() + budget;
                }
            }
        };
        if result.is_some() {
            abandon.0 = None;
        }
        drop(abandon);
        let target = format!("{}:{}", host.hostname, host.port);
        let mut session = match result {
            Some(Ok(session)) => session,
            Some(Err(e)) => {
                return Err(match check.outcome() {
                    KeyOutcome::Changed => AppError::HostKeyChanged(target),
                    KeyOutcome::Rejected => AppError::HostKeyRejected(target),
                    KeyOutcome::Revoked => AppError::HostKeyRevoked(target),
                    KeyOutcome::Unreadable => AppError::Ssh(format!(
                        "The host key of {target} could not be checked because the known hosts could not be read"
                    )),
                    KeyOutcome::Pending | KeyOutcome::Trusted => {
                        AppError::Ssh(format!("Connection failed: {e}"))
                    }
                });
            }
            None => {
                return Err(AppError::Ssh(format!(
                    "Connection timed out after {}s",
                    budget.as_secs()
                )))
            }
        };

        let (user, auth) = self.identities.resolve(host)?;
        let (method, credential) = match (&auth, password) {
            (_, Some(_)) => ("password", String::new()),
            (AuthMethod::Password { secret_id }, None) => ("password", secret_id.clone()),
            (AuthMethod::Key { secret_id }, None) => ("key", secret_id.clone()),
            _ => ("agent", String::new()),
        };
        let label = match (method, credential.as_str()) {
            ("password", "") => "the password you entered".to_string(),
            ("password", c) => format!("the password {c}"),
            ("key", c) => c.to_string(),
            _ => "your SSH agent".to_string(),
        };
        on_stage("authenticating", &label);
        let (result, summary) = match password {
            Some(pw) => self.authenticate_password(&mut session, &user, pw).await?,
            None => self.authenticate(&mut session, &user, &auth, vault).await?,
        };
        if let client::AuthResult::Failure { remaining_methods, .. } = &result {
            let names: Vec<&str> = remaining_methods.iter().map(<&str>::from).filter(|m| *m != "none").collect();
            let message = if names.is_empty() { "Permission denied".to_string() } else { format!("Permission denied ({})", names.join(",")) };
            return Err(AppError::AuthFailed { user, method: method.into(), credential, message });
        }
        Ok(Connected { session, auth: summary })
    }

    async fn authenticate_password(
        &self,
        session: &mut client::Handle<ClientHandler>,
        user: &str,
        password: &str,
    ) -> Result<(russh::client::AuthResult, String)> {
        let first = session
            .authenticate_password(user.to_string(), password)
            .await
            .map_err(|e| AppError::Ssh(format!("Auth (password): {e}")))?;
        let offers_kbd = matches!(&first, client::AuthResult::Failure { remaining_methods, .. } if remaining_methods.iter().any(|m| matches!(m, russh::MethodKind::KeyboardInteractive)));
        if first.success() || !offers_kbd {
            return Ok((first, "Password".into()));
        }
        let mut reply = session
            .authenticate_keyboard_interactive_start(user.to_string(), None::<String>)
            .await
            .map_err(|e| AppError::Ssh(format!("Auth (keyboard-interactive): {e}")))?;
        for _ in 0..4 {
            match reply {
                client::KeyboardInteractiveAuthResponse::Success => return Ok((client::AuthResult::Success, "Password".into())),
                client::KeyboardInteractiveAuthResponse::Failure { remaining_methods, partial_success } => {
                    return Ok((client::AuthResult::Failure { remaining_methods, partial_success }, "Password".into()));
                }
                client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let answers = prompts.iter().map(|p| if p.echo { String::new() } else { password.to_string() }).collect();
                    reply = session
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                        .map_err(|e| AppError::Ssh(format!("Auth (keyboard-interactive): {e}")))?;
                }
            }
        }
        Ok((first, "Password".into()))
    }

    pub async fn run_command(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        command: &str,
    ) -> Result<CommandOutput> {
        self.run_command_opts(host, vault, command, false).await
    }

    pub async fn run_command_opts(
        &self,
        host: &Host,
        vault: &Arc<Vault>,
        command: &str,
        pty: bool,
    ) -> Result<CommandOutput> {
        let session = self.connect(host, vault).await?;

        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("Channel: {e}")))?;
        if host.forward_agent {
            if let Err(e) = channel.agent_forward(true).await {
                tracing::warn!("requesting agent forwarding failed: {e}");
            }
        }
        if pty {
            channel
                .request_pty(true, "xterm-256color", 120, 34, 0, 0, &[])
                .await
                .map_err(|e| AppError::Ssh(format!("PTY: {e}")))?;
        }
        channel
            .exec(true, command)
            .await
            .map_err(|e| AppError::Ssh(format!("exec: {e}")))?;

        const MAX_OUTPUT: usize = 16 * 1024 * 1024;

        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut exit_status: Option<i32> = None;
        let mut exit_signal: Option<String> = None;
        let mut truncated = false;

        let collect = async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { ref data } => {
                        append_capped(&mut stdout, data, MAX_OUTPUT, &mut truncated)
                    }
                    ChannelMsg::ExtendedData { ref data, ext } => {
                        if ext == 1 {
                            append_capped(&mut stderr, data, MAX_OUTPUT, &mut truncated)
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status: code } => {
                        exit_status = Some(code as i32);
                    }
                    ChannelMsg::ExitSignal {
                        signal_name,
                        core_dumped,
                        error_message,
                        ..
                    } => {
                        let mut s = format!("{signal_name:?}");
                        if core_dumped {
                            s.push_str(" (core dumped)");
                        }
                        if !error_message.is_empty() {
                            s.push_str(&format!(": {error_message}"));
                        }
                        exit_signal = Some(s);
                    }
                    _ => {}
                }
            }
        };

        // Bound the run: a runaway command (e.g. `yes`) must not hang the request
        // or grow the buffer without limit and OOM the whole app.
        if tokio::time::timeout(std::time::Duration::from_secs(300), collect)
            .await
            .is_err()
        {
            exit_signal.get_or_insert_with(|| "timed out after 300s".to_string());
        }

        let mut stdout = String::from_utf8_lossy(&stdout).into_owned();
        if truncated {
            stdout.push_str("\n[output truncated at 16 MB]");
        }
        Ok(CommandOutput {
            stdout,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_status,
            exit_signal,
        })
    }

    async fn authenticate(
        &self,
        session: &mut client::Handle<ClientHandler>,
        user: &str,
        auth: &AuthMethod,
        vault: &Arc<Vault>,
    ) -> Result<(russh::client::AuthResult, String)> {
        match auth {
            AuthMethod::Password { secret_id } => {
                let bytes = vault.get_secret(secret_id)?;
                let password = zeroize::Zeroizing::new(
                    std::str::from_utf8(&bytes)
                        .map_err(|_| AppError::Ssh("Password is not valid UTF-8".into()))?
                        .to_owned(),
                );
                self.authenticate_password(session, user, password.as_str()).await
            }
            AuthMethod::Key { secret_id } => {
                let bytes = vault.get_secret(secret_id)?;
                let key_str = std::str::from_utf8(&bytes)
                    .map_err(|_| AppError::Ssh("Key is not valid UTF-8".into()))?;
                let key = decode_secret_key(key_str, None)
                    .map_err(|e| AppError::Ssh(format!("Load key: {e}")))?;
                let summary = format!("{} key", crate::local_agent::algorithm_label(key.public_key()));
                let hash = if key.algorithm().is_rsa() {
                    session
                        .best_supported_rsa_hash()
                        .await
                        .map_err(|e| AppError::Ssh(format!("RSA-Hash: {e}")))?
                        .flatten()
                } else {
                    None
                };
                let r = session
                    .authenticate_publickey(
                        user.to_string(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(|e| AppError::Ssh(format!("Auth (key): {e}")))?;
                Ok((r, summary))
            }
            AuthMethod::Agent => {
                let (_, mut agent) = crate::local_agent::connect().await?;
                let identities = agent
                    .request_identities()
                    .await
                    .map_err(|e| AppError::Ssh(format!("The SSH agent did not answer: {e}")))?;
                if identities.is_empty() {
                    return Err(AppError::Ssh("Your SSH agent has no keys loaded. Add one with ssh-add.".into()));
                }
                let mut rsa_hash: Option<Option<ssh_key::HashAlg>> = None;
                let mut last = None;
                for identity in &identities {
                    let key = identity.public_key().into_owned();
                    let hash = if key.algorithm().is_rsa() {
                        if rsa_hash.is_none() {
                            rsa_hash = Some(
                                session
                                    .best_supported_rsa_hash()
                                    .await
                                    .map_err(|e| AppError::Ssh(format!("RSA-Hash: {e}")))?
                                    .flatten(),
                            );
                        }
                        rsa_hash.flatten()
                    } else {
                        None
                    };
                    let label = crate::local_agent::algorithm_label(&key);
                    let r = session
                        .authenticate_publickey_with(user.to_string(), key, hash, &mut agent)
                        .await
                        .map_err(|e| AppError::Ssh(format!("Auth (agent): {e}")))?;
                    if r.success() {
                        return Ok((r, format!("{label} via agent")));
                    }
                    last = Some(r);
                }
                Ok((last.expect("identities is not empty"), "SSH agent".into()))
            }
            AuthMethod::Identity { .. } => Err(AppError::Ssh("An identity cannot point to another identity".into())),
        }
    }
}

/// Append `data` to `buf` up to `cap` bytes total, setting `truncated` if any
/// bytes had to be dropped.
fn append_capped(buf: &mut Vec<u8>, data: &[u8], cap: usize, truncated: &mut bool) {
    if buf.len() >= cap {
        *truncated = true;
        return;
    }
    let take = (cap - buf.len()).min(data.len());
    buf.extend_from_slice(&data[..take]);
    if take < data.len() {
        *truncated = true;
    }
}
