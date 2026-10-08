use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiPolicy {
    #[default]
    Locked,
    Confirm,
    Free,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AuthMethod {
    Password { secret_id: String },
    Key { secret_id: String },
    Agent,
    Identity { identity_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub id: Uuid,
    pub name: String,
    #[serde(default)]
    pub username: String,
    pub auth: AuthMethod,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewIdentity {
    pub name: String,
    #[serde(default)]
    pub username: String,
    pub auth: AuthMethod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForwardKind {
    #[default]
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvVar {
    pub name: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HostOptions {
    #[serde(default)]
    pub keepalive_secs: Option<u32>,
    #[serde(default)]
    pub connect_timeout_secs: Option<u32>,
    #[serde(default)]
    pub terminal_theme: String,
    #[serde(default)]
    pub encoding: String,
    #[serde(default)]
    pub startup_command: String,
    #[serde(default)]
    pub env: Vec<EnvVar>,
}

fn default_local_host() -> String {
    "127.0.0.1".to_string()
}

/// A local port forward (like `ssh -L`). Kestral listens on `local_host:local_port`
/// and tunnels each connection to `remote_host:remote_port` as seen from the SSH
/// host. `local_host` defaults to loopback; set it to 0.0.0.0 or a LAN address to
/// let other devices on the network reach the tunnel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub id: Uuid,
    /// Optional label shown in the port forwarding list.
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_local_host")]
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub kind: ForwardKind,
    #[serde(default)]
    pub start_on_connect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    pub id: Uuid,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub ai_policy: AiPolicy,
    #[serde(default)]
    pub ai_file_policy: AiPolicy,
    #[serde(default)]
    pub forward_agent: bool,
    /// Vault secret IDs exposed to the in-process agent when forward_agent is on.
    #[serde(default)]
    pub agent_keys: Vec<String>,
    #[serde(default)]
    pub forwards: Vec<PortForward>,
    /// Group shown in the sidebar and host list. Empty means ungrouped.
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub jump_host_id: Option<Uuid>,
    #[serde(default)]
    pub options: HostOptions,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewHost {
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub ai_policy: AiPolicy,
    #[serde(default)]
    pub ai_file_policy: AiPolicy,
    #[serde(default)]
    pub forward_agent: bool,
    #[serde(default)]
    pub agent_keys: Vec<String>,
    #[serde(default)]
    pub forwards: Vec<PortForward>,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub jump_host_id: Option<Uuid>,
    #[serde(default)]
    pub options: HostOptions,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SnippetVar {
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub ask: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: Uuid,
    pub label: String,
    pub script: String,
    #[serde(default)]
    pub target_host_ids: Vec<Uuid>,
    /// Folder shown in the snippet list. Empty means no folder.
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub vars: std::collections::BTreeMap<String, SnippetVar>,
    #[serde(default = "default_true")]
    pub parallel: bool,
    #[serde(default)]
    pub open_tabs: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewSnippet {
    pub label: String,
    pub script: String,
    #[serde(default)]
    pub target_host_ids: Vec<Uuid>,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub vars: std::collections::BTreeMap<String, SnippetVar>,
    #[serde(default = "default_true")]
    pub parallel: bool,
    #[serde(default)]
    pub open_tabs: bool,
}

/// Trims tags, drops empty ones and removes case-insensitive duplicates while
/// keeping the first spelling and the original order.
pub fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(tags.len());
    for tag in tags {
        let tag = tag.trim();
        if tag.is_empty() || out.iter().any(|t| t.eq_ignore_ascii_case(tag)) {
            continue;
        }
        out.push(tag.to_string());
    }
    out
}

impl Host {
    pub fn normalize(&mut self) {
        self.group = self.group.trim().to_string();
        self.tags = normalize_tags(std::mem::take(&mut self.tags));
        for fwd in &mut self.forwards {
            fwd.name = fwd.name.trim().to_string();
        }
        if self.jump_host_id == Some(self.id) {
            self.jump_host_id = None;
        }
        let o = &mut self.options;
        o.terminal_theme = o.terminal_theme.trim().to_string();
        o.encoding = o.encoding.trim().to_lowercase();
        o.startup_command = o.startup_command.trim_end().to_string();
        o.env.retain(|v| !v.name.trim().is_empty());
        for v in &mut o.env {
            v.name = v.name.trim().to_string();
        }
    }
}

impl Snippet {
    pub fn normalize(&mut self) {
        self.folder = self.folder.trim().to_string();
    }
}

impl NewSnippet {
    pub fn into_snippet(self) -> Snippet {
        let mut snippet = Snippet {
            id: Uuid::new_v4(),
            label: self.label,
            script: self.script,
            target_host_ids: self.target_host_ids,
            folder: self.folder,
            vars: self.vars,
            parallel: self.parallel,
            open_tabs: self.open_tabs,
        };
        snippet.normalize();
        snippet
    }
}

impl NewHost {
    pub fn into_host(self) -> Host {
        let mut host = Host {
            id: Uuid::new_v4(),
            name: self.name,
            hostname: self.hostname,
            port: self.port,
            username: self.username,
            auth: self.auth,
            ai_policy: self.ai_policy,
            ai_file_policy: self.ai_file_policy,
            forward_agent: self.forward_agent,
            agent_keys: self.agent_keys,
            forwards: self.forwards,
            group: self.group,
            tags: self.tags,
            jump_host_id: self.jump_host_id,
            options: self.options,
        };
        host.normalize();
        host
    }
}
