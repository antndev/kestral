use std::sync::OnceLock;

use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn data_changed(kind: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("data-changed", kind);
    }
}
