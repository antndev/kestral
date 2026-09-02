use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use uuid::Uuid;

use crate::approval::ApprovalBroker;
use crate::audit::AuditLog;
use crate::error::{AppError, Result};
use crate::hosts::HostStore;
use crate::model::Host;
use crate::policy::{DeniedReason, Gate, PolicyEngine};
use crate::sftp::{self, FileEntry};
use crate::snippets::SnippetStore;
use crate::ssh::{CommandOutput, SshManager};
use crate::vault::Vault;

#[derive(Debug, Clone, Serialize)]
pub struct McpInfo {
    pub url: String,
    pub token: String,
    pub running: bool,
}

#[derive(Clone)]
pub struct Services {
    pub vault: Arc<Vault>,
    pub hosts: Arc<HostStore>,
    pub policy: Arc<PolicyEngine>,
    pub approval: Arc<ApprovalBroker>,
    pub audit: Arc<AuditLog>,
    pub ssh: Arc<SshManager>,
    pub snippets: Arc<SnippetStore>,
}

// Turn a local path the AI named into a real path: expand a leading ~ to the
// user's home, otherwise take it as given. The AI can name any local file
// directly; the protected-path kill switch (checked separately, for local paths
// too) is what keeps sensitive files off limits.
fn resolve_local(path: &str) -> PathBuf {
    let home = || std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    if path == "~" {
        if let Some(h) = home() {
            return PathBuf::from(h);
        }
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(h) = home() {
            return PathBuf::from(h).join(rest);
        }
    }
    PathBuf::from(path)
}

impl Services {
    pub async fn ai_run_command(&self, host_id: Uuid, command: &str) -> Result<CommandOutput> {
        let host = self.hosts.get(host_id)?;
        let host_id_s = host.id.to_string();

        // Gate the kill switch on is_active so a stale MCP client cannot fire the
        // 'AI stopped' alarm and spam the audit while AI is already off; when off,
        // the gate below denies with AiInactive instead.
        if self.policy.is_active() && self.policy.mentions_protected(command) {
            self.trip_protected(&host.name, &host_id_s, command, command).await;
            return Err(AppError::PathNotAllowed(
                "this command refers to a protected path. AI access has been stopped; re-enable it yourself to continue."
                    .into(),
            ));
        }

        match self.policy.gate(host.ai_policy) {
            Gate::Denied(reason) => {
                self.record_denied(&host_id_s, &host.name, command, reason);
                Err(reason_to_err(reason))
            }
            Gate::NeedsApproval => {
                let approved = self
                    .approval
                    .request(host_id_s.clone(), host.name.clone(), command.to_string())
                    .await;
                if !approved {
                    self.audit.record(
                        host_id_s,
                        host.name.clone(),
                        command.to_string(),
                        "denied",
                        None,
                        false,
                        Some("declined by the user".to_string()),
                    );
                    return Err(AppError::ApprovalDenied);
                }
                let host = self.hosts.get(host_id)?;
                match self.policy.gate(host.ai_policy) {
                    Gate::Denied(reason) => {
                        self.record_denied(&host_id_s, &host.name, command, reason);
                        Err(reason_to_err(reason))
                    }
                    _ => self.execute_and_record(&host, command, "approved").await,
                }
            }
            Gate::Allowed => self.execute_and_record(&host, command, "allowed").await,
        }
    }

    /// Kill switch: the AI tried to touch a protected path. Turn AI access off
    /// entirely (so it cannot try another route), tell the user, and record it.
    /// The user has to turn AI back on by hand.
    async fn trip_protected(&self, host_name: &str, host_id: &str, action: &str, offending: &str) {
        self.policy.disable();
        self.approval
            .notify_stopped(host_name.to_string(), offending.to_string());
        self.audit.record(
            host_id.to_string(),
            host_name.to_string(),
            action.to_string(),
            "blocked",
            None,
            false,
            Some("protected path; AI access stopped".to_string()),
        );
    }

    fn record_denied(&self, host_id: &str, host_name: &str, command: &str, reason: DeniedReason) {
        let text = match reason {
            DeniedReason::HostLocked => "host locked",
            DeniedReason::AiInactive => "AI off",
        };
        self.audit.record(
            host_id.to_string(),
            host_name.to_string(),
            command.to_string(),
            "denied",
            None,
            false,
            Some(text.to_string()),
        );
    }

    async fn execute_and_record(
        &self,
        host: &crate::model::Host,
        command: &str,
        decision: &str,
    ) -> Result<CommandOutput> {
        let result = self.ssh.run_command(host, &self.vault, command).await;
        match &result {
            Ok(out) => {
                let success = out.exit_signal.is_none() && out.exit_status == Some(0);
                let detail = out
                    .exit_signal
                    .as_ref()
                    .map(|s| format!("terminated by signal {s}"));
                self.audit.record(
                    host.id.to_string(),
                    host.name.clone(),
                    command.to_string(),
                    decision,
                    out.exit_status,
                    success,
                    detail,
                );
            }
            Err(e) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                command.to_string(),
                "error",
                None,
                false,
                Some(e.to_string()),
            ),
        }
        result
    }

    /// Gate a file action purely by the host's Files policy: Free runs without
    /// asking, Ask prompts for approval, Blocked is denied.
    async fn authorize_file(
        &self,
        host_id: Uuid,
        action: &str,
    ) -> Result<(Host, &'static str)> {
        let host = self.hosts.get(host_id)?;
        let hid = host.id.to_string();
        let gate = self.policy.gate(host.ai_file_policy);
        if let Gate::Denied(reason) = gate {
            self.record_denied(&hid, &host.name, action, reason);
            return Err(reason_to_err(reason));
        }
        let needs_approval = matches!(gate, Gate::NeedsApproval);
        if !needs_approval {
            return Ok((host, "allowed"));
        }
        let approved = self
            .approval
            .request(hid.clone(), host.name.clone(), action.to_string())
            .await;
        if !approved {
            self.audit.record(
                hid,
                host.name.clone(),
                action.to_string(),
                "denied",
                None,
                false,
                Some("declined by the user".to_string()),
            );
            return Err(AppError::ApprovalDenied);
        }
        let host = self.hosts.get(host_id)?;
        match self.policy.gate(host.ai_file_policy) {
            Gate::Denied(reason) => {
                self.record_denied(&hid, &host.name, action, reason);
                Err(reason_to_err(reason))
            }
            _ => Ok((host, "approved")),
        }
    }

    fn audit_file(&self, host: &Host, action: &str, decision: &str, result: &Result<u64>) {
        match result {
            Ok(bytes) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                action.to_string(),
                decision,
                None,
                true,
                Some(format!("{bytes} bytes")),
            ),
            Err(e) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                action.to_string(),
                "error",
                None,
                false,
                Some(e.to_string()),
            ),
        }
    }

    pub async fn ai_sftp_list(&self, host_id: Uuid, path: &str) -> Result<Vec<FileEntry>> {
        let action = format!("sftp list {path}");
        self.guard_protected(host_id, &action, path).await?;
        let (host, decision) = self.authorize_file(host_id, &action).await?;
        let result = sftp::one_shot_list(&self.ssh, &self.vault, &host, path).await;
        match &result {
            Ok(entries) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                action,
                decision,
                None,
                true,
                Some(format!("{} entries", entries.len())),
            ),
            Err(e) => self.audit.record(
                host.id.to_string(),
                host.name.clone(),
                action,
                "error",
                None,
                false,
                Some(e.to_string()),
            ),
        }
        result
    }

    /// If AI is active and the remote path is protected, trip the kill switch and
    /// return an error; otherwise Ok. Protected paths are off-limits to the AI for
    /// both reads and writes. Gated on is_active so a stale MCP client cannot fire
    /// the kill switch while AI is already off.
    async fn guard_protected(&self, host_id: Uuid, action: &str, remote: &str) -> Result<()> {
        if self.policy.is_active() && self.policy.is_protected(remote) {
            let (hid, hname) = match self.hosts.get(host_id) {
                Ok(h) => (h.id.to_string(), h.name),
                Err(_) => (host_id.to_string(), "unknown host".to_string()),
            };
            self.trip_protected(&hname, &hid, action, remote).await;
            return Err(AppError::PathNotAllowed(format!(
                "'{remote}' is protected. AI access has been stopped; re-enable it yourself to continue."
            )));
        }
        Ok(())
    }

    pub async fn ai_sftp_download(&self, host_id: Uuid, remote: &str, local: &str) -> Result<u64> {
        let action = format!("sftp download {remote} -> {local}");
        // The local target is unconstrained, but a protected path on either side
        // (e.g. writing onto a local authorized_keys) still trips the kill switch.
        self.guard_protected(host_id, &action, remote).await?;
        self.guard_protected(host_id, &action, local).await?;
        let local_path = resolve_local(local);
        if let Some(parent) = local_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let (host, decision) = self.authorize_file(host_id, &action).await?;
        let result =
            sftp::one_shot_download(&self.ssh, &self.vault, &host, remote, &local_path).await;
        self.audit_file(&host, &action, decision, &result);
        result
    }

    pub async fn ai_sftp_upload(&self, host_id: Uuid, local: &str, remote: &str) -> Result<u64> {
        let action = format!("sftp upload {local} -> {remote}");
        self.guard_protected(host_id, &action, remote).await?;
        self.guard_protected(host_id, &action, local).await?;
        let local_path = resolve_local(local);
        let (host, decision) = self.authorize_file(host_id, &action).await?;
        let result =
            sftp::one_shot_upload(&self.ssh, &self.vault, &host, &local_path, remote).await;
        self.audit_file(&host, &action, decision, &result);
        result
    }
}

fn reason_to_err(reason: DeniedReason) -> AppError {
    match reason {
        DeniedReason::HostLocked => AppError::HostLocked,
        DeniedReason::AiInactive => AppError::AiDisabled,
    }
}

pub struct AppState {
    pub services: Services,
    pub mcp: Mutex<McpInfo>,
    pub mcp_cancel: tokio_util::sync::CancellationToken,
    pub mcp_bearer: crate::mcp::Bearer,
    pub mcp_token_path: std::path::PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_local_expands_home_and_passes_through() {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from);

        if let Some(h) = home {
            assert_eq!(resolve_local("~"), h);
            assert_eq!(resolve_local("~/notes/a.txt"), h.join("notes/a.txt"));
        }
        // Anything without a leading ~ is taken verbatim, absolute or relative.
        assert_eq!(resolve_local("/etc/hosts"), PathBuf::from("/etc/hosts"));
        assert_eq!(resolve_local("relative/x"), PathBuf::from("relative/x"));
    }
}
