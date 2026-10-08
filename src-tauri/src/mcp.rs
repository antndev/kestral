
use std::sync::Arc;

use axum::{
    body::Body,
    http::{header, HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    Router,
};
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars, tool, tool_handler, tool_router,
    ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::model::{AiPolicy, AuthMethod, Host, NewHost, NewSnippet, Snippet};
use crate::state::Services;
use crate::vault::SecretStore;

#[derive(Serialize)]
struct HostView {
    id: String,
    name: String,
    hostname: String,
    port: u16,
    username: String,
    ai_policy: AiPolicy,
    ai_file_policy: AiPolicy,
    group: String,
    tags: Vec<String>,
}

fn build_auth(kind: &str, secret_id: Option<String>) -> std::result::Result<AuthMethod, String> {
    match kind {
        "password" => secret_id
            .map(|s| AuthMethod::Password { secret_id: s })
            .ok_or_else(|| "secret_id is required for auth_kind=password".to_string()),
        "key" => secret_id
            .map(|s| AuthMethod::Key { secret_id: s })
            .ok_or_else(|| "secret_id is required for auth_kind=key".to_string()),
        "agent" => Ok(AuthMethod::Agent),
        other => Err(format!("unknown auth_kind '{other}', use password, key or agent")),
    }
}

fn parse_host_ids(ids: &[String]) -> std::result::Result<Vec<Uuid>, String> {
    ids.iter()
        .map(|s| Uuid::parse_str(s).map_err(|_| format!("invalid host id: {s}")))
        .collect()
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RunCommandArgs {
    host_id: String,
    command: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreateHostArgs {
    name: String,
    hostname: String,
    port: u16,
    username: String,
    auth_kind: String,
    #[serde(default)]
    secret_id: Option<String>,
    /// Group name for the host list. Omit or leave empty for no group.
    #[serde(default)]
    group: Option<String>,
    /// Free-form tags shown on the host.
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct UpdateHostArgs {
    host_id: String,
    name: String,
    hostname: String,
    port: u16,
    username: String,
    auth_kind: String,
    #[serde(default)]
    secret_id: Option<String>,
    /// New group name. Omit to keep the current group, empty string to ungroup.
    #[serde(default)]
    group: Option<String>,
    /// New tag list. Omit to keep the current tags.
    #[serde(default)]
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreateSnippetArgs {
    label: String,
    script: String,
    #[serde(default)]
    target_host_ids: Vec<String>,
    /// Folder name for the snippet list. Omit or leave empty for no folder.
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct UpdateSnippetArgs {
    snippet_id: String,
    label: String,
    script: String,
    #[serde(default)]
    target_host_ids: Vec<String>,
    /// New folder name. Omit to keep the current folder, empty string for none.
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct DeleteSnippetArgs {
    snippet_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SftpListArgs {
    host_id: String,
    path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SftpDownloadArgs {
    host_id: String,
    remote_path: String,
    local_path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SftpUploadArgs {
    host_id: String,
    local_path: String,
    remote_path: String,
}

#[derive(Clone)]
pub struct KestralMcp {
    services: Services,
    tool_router: ToolRouter<KestralMcp>,
}

#[tool_router]
impl KestralMcp {
    pub fn new(services: Services) -> Self {
        Self {
            services,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(description = "List the configured SSH hosts (id, name, address, user, ai policy, group, tags) as JSON.")]
    async fn list_hosts(&self) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().list_hosts {
            return Ok(Self::cap_denied("listing hosts"));
        }
        let views = host_views(&self.services);
        let json = serde_json::to_string_pretty(&views).unwrap_or_else(|_| "[]".into());
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        description = "Run a shell command on a host. Subject to the global AI switch and the per-host policy (may require user approval). Returns stdout, stderr and exit code."
    )]
    async fn run_command(
        &self,
        Parameters(RunCommandArgs { host_id, command }): Parameters<RunCommandArgs>,
    ) -> Result<CallToolResult, McpError> {
        let id = match self.resolve_host(&host_id) {
            Some(id) => id,
            None => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Unknown host: {host_id}"
                ))]))
            }
        };
        match self.services.ai_run_command(id, &command).await {
            Ok(out) => {
                let status = match (&out.exit_signal, out.exit_status) {
                    (Some(sig), _) => format!("signal {sig}"),
                    (None, Some(code)) => code.to_string(),
                    (None, None) => "?".into(),
                };
                let text = format!(
                    "exit: {status}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                    out.stdout, out.stderr
                );
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(description = "Return the audit log of AI-issued actions as JSON.")]
    async fn get_audit_log(&self) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().audit_log {
            return Ok(Self::cap_denied("reading the audit log"));
        }
        let entries = self.services.audit.list_ai();
        let json = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into());
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(description = "List saved snippets (id, label, script, target host ids, folder) as JSON.")]
    async fn list_snippets(&self) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().list_snippets {
            return Ok(Self::cap_denied("listing scripts"));
        }
        let items = self.services.snippets.list();
        let json = serde_json::to_string_pretty(&items).unwrap_or_else(|_| "[]".into());
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }

    #[tool(
        description = "List credential ids and kinds. Never returns secret values. Use an id to wire a host to an existing credential."
    )]
    async fn list_secrets(&self) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().list_secrets {
            return Ok(Self::cap_denied("listing credentials"));
        }
        match self.services.vault.list_secrets() {
            Ok(metas) => {
                let json = serde_json::to_string_pretty(&metas).unwrap_or_else(|_| "[]".into());
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Create a new SSH host. AI access stays locked by default; only the user can grant it. The AI never sets a secret value, it only references an existing credential id."
    )]
    async fn create_host(
        &self,
        Parameters(a): Parameters<CreateHostArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().manage_hosts {
            return Ok(Self::cap_denied("creating or changing hosts"));
        }
        let auth = match build_auth(&a.auth_kind, a.secret_id) {
            Ok(au) => au,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let new = NewHost {
            name: a.name,
            hostname: a.hostname,
            port: a.port,
            username: a.username,
            auth,
            ai_policy: AiPolicy::Locked,
            ai_file_policy: AiPolicy::Locked,
            forward_agent: false,
            agent_keys: Vec::new(),
            forwards: Vec::new(),
            group: a.group.unwrap_or_default(),
            tags: a.tags.unwrap_or_default(),
            jump_host_id: None,
            options: Default::default(),
        };
        match self.services.hosts.add(new) {
            Ok(h) => {
                crate::events::data_changed("hosts");
                self.services.audit.record(
                    h.id.to_string(),
                    h.name.clone(),
                    format!("create host {}@{}:{}", h.username, h.hostname, h.port),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Created host '{}' with id {}. AI access is locked until the user enables it.",
                    h.name, h.id
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Update an existing host's connection fields. If the hostname, port, username or sign-in (auth_kind, secret_id, identity) changes, the per-host AI policies are reset to locked so the user has to re-grant access. The AI can never widen a policy."
    )]
    async fn update_host(
        &self,
        Parameters(a): Parameters<UpdateHostArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().manage_hosts {
            return Ok(Self::cap_denied("creating or changing hosts"));
        }
        let id = match self.resolve_host(&a.host_id) {
            Some(i) => i,
            None => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Unknown host: {}",
                    a.host_id
                ))]))
            }
        };
        let existing = match self.services.hosts.get(id) {
            Ok(h) => h,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        };
        let auth = match build_auth(&a.auth_kind, a.secret_id) {
            Ok(au) => au,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let target_changed = a.hostname != existing.hostname
            || a.port != existing.port
            || a.username != existing.username
            || auth != existing.auth;
        let updated = Host {
            id,
            name: a.name,
            hostname: a.hostname,
            port: a.port,
            username: a.username,
            auth,
            ai_policy: if target_changed {
                AiPolicy::Locked
            } else {
                existing.ai_policy
            },
            ai_file_policy: if target_changed {
                AiPolicy::Locked
            } else {
                existing.ai_file_policy
            },
            // If the target changed, drop the forwarding config too, so the AI
            // cannot repoint a host to a server it controls while keeping the
            // vault-agent keys exposed. The user must re-enable it for the new
            // target, exactly as the AI policy is reset.
            forward_agent: if target_changed {
                false
            } else {
                existing.forward_agent
            },
            agent_keys: if target_changed {
                Vec::new()
            } else {
                existing.agent_keys
            },
            forwards: if target_changed {
                Vec::new()
            } else {
                existing.forwards
            },
            group: a.group.unwrap_or(existing.group),
            tags: a.tags.unwrap_or(existing.tags),
            jump_host_id: existing.jump_host_id,
            options: existing.options,
        };
        match self.services.hosts.update(updated.clone()) {
            Ok(()) => {
                let mut dependents = Vec::new();
                if target_changed {
                    dependents = self.services.hosts.lock_dependents(id).unwrap_or_default();
                    for d in &dependents {
                        self.services.ai_pool.forget(*d).await;
                    }
                }
                crate::events::data_changed("hosts");
                let note = if !target_changed {
                    String::new()
                } else if dependents.is_empty() {
                    " Connection target or sign-in changed, so AI access was reset to locked; the user must re-enable it.".to_string()
                } else {
                    format!(" Connection target or sign-in changed, so AI access was reset to locked for this host and the {} host(s) that connect through it; the user must re-enable it.", dependents.len())
                };
                self.services.audit.record(
                    id.to_string(),
                    updated.name.clone(),
                    format!(
                        "update host {}@{}:{}{}",
                        updated.username,
                        updated.hostname,
                        updated.port,
                        if target_changed { " (relocked)" } else { "" }
                    ),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Updated host '{}'.{note}",
                    updated.name
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(description = "Create a snippet (named script), optionally tied to target hosts.")]
    async fn create_snippet(
        &self,
        Parameters(a): Parameters<CreateSnippetArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().manage_snippets {
            return Ok(Self::cap_denied("creating or changing scripts"));
        }
        let targets = match parse_host_ids(&a.target_host_ids) {
            Ok(t) => t,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let new = NewSnippet {
            label: a.label,
            script: a.script,
            target_host_ids: targets,
            folder: a.folder.unwrap_or_default(),
            vars: Default::default(),
            parallel: true,
            open_tabs: false,
        };
        let added = self.services.snippets.add(new).and_then(|mut s| {
            s.ai_edited = true;
            self.services.snippets.update(s.clone()).map(|()| s)
        });
        match added {
            Ok(s) => {
                crate::events::data_changed("snippets");
                self.services.audit.record(
                    s.id.to_string(),
                    s.label.clone(),
                    format!("create snippet '{}'", s.label),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Created snippet '{}' with id {}.",
                    s.label, s.id
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(description = "Update an existing snippet by id.")]
    async fn update_snippet(
        &self,
        Parameters(a): Parameters<UpdateSnippetArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().manage_snippets {
            return Ok(Self::cap_denied("creating or changing scripts"));
        }
        let id = match Uuid::parse_str(&a.snippet_id) {
            Ok(i) => i,
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid snippet_id: {}",
                    a.snippet_id
                ))]))
            }
        };
        let targets = match parse_host_ids(&a.target_host_ids) {
            Ok(t) => t,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e)])),
        };
        let existing = match self.services.snippets.get(id) {
            Ok(s) => s,
            Err(e) => return Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        };
        let updated = Snippet {
            id,
            label: a.label,
            script: a.script,
            target_host_ids: targets,
            folder: a.folder.unwrap_or(existing.folder),
            vars: existing.vars,
            parallel: existing.parallel,
            open_tabs: existing.open_tabs,
            ai_edited: true,
        };
        match self.services.snippets.update(updated.clone()) {
            Ok(()) => {
                crate::events::data_changed("snippets");
                self.services.audit.record(
                    id.to_string(),
                    updated.label.clone(),
                    format!("update snippet '{}'", updated.label),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Updated snippet '{}'.",
                    updated.label
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Delete a saved script. Irreversible, so name the script to the user before calling this."
    )]
    async fn delete_snippet(
        &self,
        Parameters(a): Parameters<DeleteSnippetArgs>,
    ) -> Result<CallToolResult, McpError> {
        if !self.services.policy.is_active() {
            return Ok(Self::disabled());
        }
        if !self.services.policy.caps().manage_snippets {
            return Ok(Self::cap_denied("deleting scripts"));
        }
        let id = match Uuid::parse_str(&a.snippet_id) {
            Ok(i) => i,
            Err(_) => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Invalid snippet_id: {}",
                    a.snippet_id
                ))]))
            }
        };
        let label = self
            .services
            .snippets
            .list()
            .into_iter()
            .find(|s| s.id == id)
            .map(|s| s.label)
            .unwrap_or_else(|| a.snippet_id.clone());

        match self.services.snippets.remove(id) {
            Ok(()) => {
                crate::events::data_changed("snippets");
                self.services.audit.record(
                    id.to_string(),
                    label.clone(),
                    format!("delete snippet '{label}'"),
                    "config",
                    None,
                    true,
                    None,
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Deleted snippet '{label}'."
                ))]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "List a remote directory over SFTP. Subject to the per-host file policy (may require approval)."
    )]
    async fn sftp_list(
        &self,
        Parameters(a): Parameters<SftpListArgs>,
    ) -> Result<CallToolResult, McpError> {
        let id = match self.resolve_host(&a.host_id) {
            Some(i) => i,
            None => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Unknown host: {}",
                    a.host_id
                ))]))
            }
        };
        match self.services.ai_sftp_list(id, &a.path).await {
            Ok(entries) => {
                let json = serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".into());
                Ok(CallToolResult::success(vec![Content::text(json)]))
            }
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Download a remote file to a local path over SFTP. Subject to the per-host file policy (may require approval)."
    )]
    async fn sftp_download(
        &self,
        Parameters(a): Parameters<SftpDownloadArgs>,
    ) -> Result<CallToolResult, McpError> {
        let id = match self.resolve_host(&a.host_id) {
            Some(i) => i,
            None => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Unknown host: {}",
                    a.host_id
                ))]))
            }
        };
        match self
            .services
            .ai_sftp_download(id, &a.remote_path, &a.local_path)
            .await
        {
            Ok(n) => Ok(CallToolResult::success(vec![Content::text(format!(
                "Downloaded {n} bytes to {}",
                a.local_path
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    #[tool(
        description = "Upload a local file to a remote path over SFTP. Subject to the per-host file policy (may require approval)."
    )]
    async fn sftp_upload(
        &self,
        Parameters(a): Parameters<SftpUploadArgs>,
    ) -> Result<CallToolResult, McpError> {
        let id = match self.resolve_host(&a.host_id) {
            Some(i) => i,
            None => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Unknown host: {}",
                    a.host_id
                ))]))
            }
        };
        match self
            .services
            .ai_sftp_upload(id, &a.local_path, &a.remote_path)
            .await
        {
            Ok(n) => Ok(CallToolResult::success(vec![Content::text(format!(
                "Uploaded {n} bytes to {}",
                a.remote_path
            ))])),
            Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
        }
    }

    fn disabled() -> CallToolResult {
        CallToolResult::error(vec![Content::text(
            "AI access is disabled. Enable it in Kestral first.",
        )])
    }

    fn cap_denied(what: &str) -> CallToolResult {
        CallToolResult::error(vec![Content::text(format!(
            "Not allowed: {what} is disabled in Kestral's AI permissions."
        ))])
    }

    fn resolve_host(&self, id_or_name: &str) -> Option<Uuid> {
        resolve_host_in(&self.services, id_or_name)
    }
}

fn host_views(services: &Services) -> Vec<HostView> {
    services
        .hosts
        .list()
        .into_iter()
        .map(|h| HostView {
            id: h.id.to_string(),
            name: h.name,
            hostname: h.hostname,
            port: h.port,
            username: h.username,
            ai_policy: h.ai_policy,
            ai_file_policy: h.ai_file_policy,
            group: h.group,
            tags: h.tags,
        })
        .collect()
}

fn resolve_host_in(services: &Services, id_or_name: &str) -> Option<Uuid> {
    if let Ok(id) = Uuid::parse_str(id_or_name) {
        return Some(id);
    }
    let needle = id_or_name.trim().to_lowercase();
    services
        .hosts
        .list()
        .into_iter()
        .find(|h| h.name.to_lowercase() == needle)
        .map(|h| h.id)
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for KestralMcp {}

pub type Bearer = Arc<std::sync::RwLock<String>>;

#[derive(Clone)]
struct AuthState {
    bearer: Bearer,
}

async fn auth_middleware(
    axum::extract::State(state): axum::extract::State<AuthState>,
    headers: HeaderMap,
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let expected = {
        let b = state.bearer.read().unwrap();
        format!("Bearer {}", *b)
    };
    let provided = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    use subtle::ConstantTimeEq;
    if bool::from(provided.as_bytes().ct_eq(expected.as_bytes())) {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

fn build_router(services: Services, bearer: Bearer, port: u16, ct: CancellationToken) -> Router {
    let service: StreamableHttpService<KestralMcp, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(KestralMcp::new(services.clone())),
            LocalSessionManager::default().into(),
            StreamableHttpServerConfig::default()
                .with_allowed_hosts([
                    "127.0.0.1".to_string(),
                    format!("127.0.0.1:{port}"),
                    "localhost".to_string(),
                    format!("localhost:{port}"),
                ])
                .with_allowed_origins([
                    format!("http://127.0.0.1:{port}"),
                    format!("http://localhost:{port}"),
                ])
                .with_cancellation_token(ct),
        );

    let auth = AuthState { bearer };

    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(auth, auth_middleware))
}

pub async fn serve(
    app: tauri::AppHandle,
    services: Services,
    bearer: Bearer,
    port: u16,
    ct: CancellationToken,
) -> std::io::Result<()> {
    let router = build_router(services, bearer, port, ct.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;

    {
        use tauri::Manager;
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            if let Ok(mut info) = state.mcp.lock() {
                info.running = true;
            }
        }
    }

    tracing::info!("Kestral MCP listening on http://127.0.0.1:{port}/mcp");
    axum::serve(listener, router)
        .with_graceful_shutdown(async move { ct.cancelled().await })
        .await
}
