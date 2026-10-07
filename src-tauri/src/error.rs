use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Vault is locked")]
    VaultLocked,
    #[error("Vault already exists")]
    VaultExists,
    #[error("Vault does not exist yet")]
    VaultMissing,
    #[error("Wrong master password or corrupted vault")]
    VaultAuth,
    #[error("Not found: {0}")]
    NotFound(String),
    #[allow(dead_code)]
    #[error("AI access is off")]
    AiDisabled,
    #[allow(dead_code)]
    #[error("Host is blocked for the AI")]
    HostLocked,
    #[allow(dead_code)]
    #[error("Approval denied")]
    ApprovalDenied,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("Crypto error")]
    Crypto,
    #[error("Host key changed for {0}. Refused. If this is expected, remove the old key from known_hosts.")]
    HostKeyChanged(String),
    #[error("The host key of {0} was not trusted, so the connection was refused.")]
    HostKeyRejected(String),
    #[error("The host key of {0} is marked as revoked in known_hosts. Connection refused.")]
    HostKeyRevoked(String),
    #[error("Path not allowed: {0}")]
    PathNotAllowed(String),
    #[error("SSH: {0}")]
    Ssh(String),
    #[error("Authentication failed for {user}. {message}")]
    AuthFailed {
        user: String,
        method: String,
        credential: String,
        message: String,
    },
    #[error("Connection canceled")]
    Canceled,
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
