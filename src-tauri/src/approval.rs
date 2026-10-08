use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalKind {
    Command,
    File,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub kind: ApprovalKind,
    pub host_id: String,
    pub host_name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStopped {
    pub host_name: String,
    pub path: String,
}

pub struct ApprovalBroker {
    app: AppHandle,
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl ApprovalBroker {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub async fn request(&self, kind: ApprovalKind, host_id: String, host_name: String, command: String) -> bool {
        let id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);

        let req = ApprovalRequest {
            id: id.clone(),
            kind,
            host_id,
            host_name,
            command,
        };
        if self.app.emit("approval-request", req).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return false;
        }

        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(approved)) => approved,
            Ok(Err(_)) => false,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                let _ = self.app.emit("approval-expired", &id);
                false
            }
        }
    }

    pub fn resolve(&self, id: &str, approved: bool) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(approved);
        }
    }

    /// Tell the UI that AI access was stopped because it tried to touch a
    /// protected path.
    pub fn notify_stopped(&self, host_name: String, path: String) {
        let _ = self.app.emit("ai-stopped", AiStopped { host_name, path });
    }
}
