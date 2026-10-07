use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::ssh_key::{self, public::KeyData, EcdsaCurve};
use serde::Serialize;

use crate::error::{AppError, Result};

pub type Agent = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

#[cfg(windows)]
const OPENSSH_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

pub async fn connect() -> Result<(&'static str, Agent)> {
    #[cfg(windows)]
    {
        if let Ok(sock) = std::env::var("SSH_AUTH_SOCK") {
            if sock.starts_with(r"\\.\pipe\") {
                if let Ok(c) = AgentClient::connect_named_pipe(&sock).await {
                    return Ok(("openssh", AgentClient::connect(c.into_inner())));
                }
            }
        }
        if let Ok(c) = AgentClient::connect_named_pipe(OPENSSH_PIPE).await {
            return Ok(("openssh", AgentClient::connect(c.into_inner())));
        }
        if let Ok(c) = AgentClient::connect_pageant().await {
            return Ok(("pageant", AgentClient::connect(c.into_inner())));
        }
        Err(AppError::Ssh(
            "No SSH agent is running. Start the OpenSSH Authentication Agent service or Pageant, then try again.".into(),
        ))
    }
    #[cfg(not(windows))]
    {
        match AgentClient::connect_env().await {
            Ok(c) => Ok(("unix", AgentClient::connect(c.into_inner()))),
            Err(_) => Err(AppError::Ssh(
                "No SSH agent is running. Start ssh-agent and make sure SSH_AUTH_SOCK is set, then try again.".into(),
            )),
        }
    }
}

pub fn algorithm_label(key: &ssh_key::PublicKey) -> String {
    match key.key_data() {
        KeyData::Ed25519(_) => "ED25519".into(),
        KeyData::SkEd25519(_) => "ED25519-SK".into(),
        KeyData::Rsa(_) => "RSA".into(),
        KeyData::Ecdsa(_) => "ECDSA".into(),
        KeyData::SkEcdsaSha2NistP256(_) => "ECDSA-SK".into(),
        KeyData::Dsa(_) => "DSA".into(),
        _ => key.algorithm().as_str().to_uppercase(),
    }
}

pub fn key_bits(key: &ssh_key::PublicKey) -> Option<u32> {
    match key.key_data() {
        KeyData::Ed25519(_) | KeyData::SkEd25519(_) => Some(256),
        KeyData::Rsa(k) => Some(k.key_size()),
        KeyData::Ecdsa(k) => Some(match k.curve() {
            EcdsaCurve::NistP256 => 256,
            EcdsaCurve::NistP384 => 384,
            EcdsaCurve::NistP521 => 521,
        }),
        KeyData::SkEcdsaSha2NistP256(_) => Some(256),
        KeyData::Dsa(_) => Some(1024),
        _ => None,
    }
}

#[derive(Serialize)]
pub struct AgentKeyInfo {
    pub comment: String,
    pub algorithm: String,
    pub bits: Option<u32>,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Serialize)]
pub struct LocalAgentInfo {
    pub agent: Option<String>,
    pub keys: Vec<AgentKeyInfo>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn local_agent_identities() -> LocalAgentInfo {
    let (kind, mut agent) = match connect().await {
        Ok(v) => v,
        Err(e) => {
            return LocalAgentInfo { agent: None, keys: Vec::new(), error: Some(e.to_string()) };
        }
    };
    match agent.request_identities().await {
        Ok(ids) => LocalAgentInfo {
            agent: Some(kind.to_string()),
            keys: ids
                .iter()
                .map(|id| {
                    let key = id.public_key();
                    AgentKeyInfo {
                        comment: id.comment().to_string(),
                        algorithm: algorithm_label(&key),
                        bits: key_bits(&key),
                        fingerprint: key.fingerprint(ssh_key::HashAlg::Sha256).to_string(),
                        public_key: key.to_openssh().unwrap_or_default(),
                    }
                })
                .collect(),
            error: None,
        },
        Err(e) => LocalAgentInfo {
            agent: Some(kind.to_string()),
            keys: Vec::new(),
            error: Some(format!("The SSH agent did not answer: {e}")),
        },
    }
}
