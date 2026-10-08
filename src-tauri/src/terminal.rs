
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use russh::{client, ChannelMsg};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{Emitter, State};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::ssh::ClientHandler;
use crate::state::AppState;

#[derive(Serialize, Clone)]
struct SessionStatus<'a> {
    id: &'a str,
    stage: &'a str,
    detail: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

#[derive(Serialize, Clone)]
struct SessionClosed {
    id: String,
    exit_status: Option<u32>,
    signal: Option<String>,
    lost: bool,
}

#[derive(Serialize, Clone)]
struct SessionInfo {
    id: String,
    shell: String,
}

type Session = client::Handle<ClientHandler>;
type WriteHalf = russh::ChannelWriteHalf<client::Msg>;
type SessionMap = Arc<Mutex<HashMap<String, SessionHandle>>>;

struct SessionHandle {
    write: Arc<AsyncMutex<WriteHalf>>,
    session: Arc<Session>,
    reader: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
pub struct Sessions(SessionMap, Mutex<HashMap<String, (u64, tokio_util::sync::CancellationToken)>>);

static ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

async fn teardown(h: SessionHandle) {
    {
        let w = h.write.lock().await;
        let _ = w.eof().await;
        let _ = w.close().await;
    }
    let _ = h
        .session
        .disconnect(russh::Disconnect::ByApplication, "", "")
        .await;
    if let Some(reader) = h.reader {
        reader.abort();
    }
}

async fn close_dead(app: &tauri::AppHandle, sessions: &Sessions, id: &str) {
    let removed = { sessions.0.lock().unwrap().remove(id) };
    if let Some(h) = removed {
        teardown(h).await;
        let _ = app.emit("session-closed", SessionClosed { id: id.to_string(), exit_status: None, signal: None, lost: true });
    }
}

async fn shell_name(session: Arc<Session>) -> Option<String> {
    let mut channel = session.channel_open_session().await.ok()?;
    channel.exec(true, "printf '%s' \"${SHELL##*/}\"").await.ok()?;
    let mut out = Vec::new();
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    out.extend_from_slice(data);
                    if out.len() > 256 {
                        break;
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    let done = tokio::time::timeout(std::time::Duration::from_secs(10), read).await;
    let _ = channel.close().await;
    done.ok()?;
    let name = String::from_utf8_lossy(&out).trim().to_string();
    (!name.is_empty() && name.len() < 40 && !name.contains(char::is_whitespace)).then_some(name)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_open_shell(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sessions: State<'_, Sessions>,
    id: String,
    host_id: String,
    cols: u32,
    rows: u32,
    on_output: Channel<InvokeResponseBody>,
    password: Option<String>,
) -> Result<()> {
    let prev = { sessions.0.lock().unwrap().remove(&id) };
    if let Some(h) = prev {
        teardown(h).await;
    }

    let hid = Uuid::parse_str(&host_id).map_err(|_| AppError::NotFound(host_id.clone()))?;
    let host = state.services.hosts.get(hid)?;
    let password = password.map(zeroize::Zeroizing::new).filter(|p| !p.is_empty());

    let notify_with = |stage: &str, detail: &str, data: Option<serde_json::Value>| {
        let _ = app.emit("session-status", SessionStatus { id: &id, stage, detail, data });
    };
    let notify = |stage: &str, detail: &str| notify_with(stage, detail, None);

    let cancel = tokio_util::sync::CancellationToken::new();
    let attempt_no = ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    {
        let old = sessions.1.lock().unwrap().insert(id.clone(), (attempt_no, cancel.clone()));
        if let Some((_, old)) = old {
            old.cancel();
        }
    }
    let on_stage = |stage: &str, detail: &str| notify(stage, detail);
    let attempt = state.services.ssh.connect_info(&host, &state.services.vault, &on_stage, password.as_ref().map(|p| p.as_str()));
    let outcome = tokio::select! {
        r = attempt => r,
        _ = cancel.cancelled() => Err(AppError::Canceled),
    };
    {
        let mut pending = sessions.1.lock().unwrap();
        if pending.get(&id).is_some_and(|(n, _)| *n == attempt_no) {
            pending.remove(&id);
        }
    }
    let connected = match outcome {
        Ok(s) => s,
        Err(e) => {
            match &e {
                AppError::AuthFailed { user, method, credential, message } => notify_with(
                    "auth-failed",
                    message,
                    Some(serde_json::json!({ "user": user, "method": method, "credential": credential })),
                ),
                AppError::Canceled => notify("canceled", ""),
                other => notify("error", &other.to_string()),
            }
            return Err(e);
        }
    };

    let auth_summary = connected.auth;
    let session = connected.session;
    notify("opening-shell", "");
    let channel = match session.channel_open_session().await {
        Ok(c) => c,
        Err(e) => {
            let err = AppError::Ssh(format!("Channel: {e}"));
            notify("error", &err.to_string());
            return Err(err);
        }
    };
    if host.forward_agent {
        if let Err(e) = channel.agent_forward(true).await {
            tracing::warn!("requesting agent forwarding failed: {e}");
        }
    }
    for var in &host.options.env {
        if let Err(e) = channel.set_env(false, var.name.clone(), var.value.clone()).await {
            tracing::warn!("setting {} failed: {e}", var.name);
        }
    }
    if let Err(e) = channel
        .request_pty(true, "xterm-256color", cols.max(1), rows.max(1), 0, 0, &[])
        .await
    {
        let err = AppError::Ssh(format!("PTY: {e}"));
        notify("error", &err.to_string());
        return Err(err);
    }
    if let Err(e) = channel.request_shell(true).await {
        let err = AppError::Ssh(format!("Shell: {e}"));
        notify("error", &err.to_string());
        return Err(err);
    }
    notify("connected", &auth_summary);

    let (mut read_half, write_half) = channel.split();

    let displaced = {
        sessions.0.lock().unwrap().insert(
            id.clone(),
            SessionHandle {
                write: Arc::new(AsyncMutex::new(write_half)),
                session: Arc::new(session),
                reader: None,
            },
        )
    };
    if let Some(h) = displaced {
        teardown(h).await;
    }

    let map = sessions.0.clone();
    let task_id = id.clone();
    let app_for_reader = app.clone();
    let reader = tokio::spawn(async move {
        let mut exit_status: Option<u32> = None;
        let mut signal: Option<String> = None;
        let mut ended = false;
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    let _ = on_output.send(InvokeResponseBody::Raw(data.to_vec()));
                }
                ChannelMsg::ExtendedData { ref data, ext } => {
                    if ext == 1 {
                        let _ = on_output.send(InvokeResponseBody::Raw(data.to_vec()));
                    }
                }
                ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                ChannelMsg::ExitSignal { signal_name, .. } => signal = Some(format!("{signal_name:?}")),
                ChannelMsg::Eof | ChannelMsg::Close => {
                    ended = true;
                    break;
                }
                _ => {}
            }
        }
        let removed = { map.lock().unwrap().remove(&task_id) };
        let lost = !ended && exit_status.is_none() && signal.is_none();
        if removed.is_some() {
            drop(removed);
            let _ = app_for_reader.emit("session-closed", SessionClosed { id: task_id, exit_status, signal, lost });
        }
    });

    {
        let mut map = sessions.0.lock().unwrap();
        match map.get_mut(&id) {
            Some(h) => h.reader = Some(reader),
            None => reader.abort(),
        }
    }
    if host.forwards.iter().any(|f| f.start_on_connect) {
        let app = app.clone();
        let host = host.clone();
        tokio::spawn(async move { crate::forward::start_on_connect(&app, &host).await });
    }
    let session = { sessions.0.lock().unwrap().get(&id).map(|h| h.session.clone()) };
    if let Some(session) = session {
        let app = app.clone();
        let id = id.clone();
        tokio::spawn(async move {
            if let Some(shell) = shell_name(session).await {
                let _ = app.emit("session-info", SessionInfo { id, shell });
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_write_bytes(
    app: tauri::AppHandle,
    sessions: State<'_, Sessions>,
    id: String,
    data: Vec<u8>,
) -> Result<()> {
    let writer = {
        let map = sessions.0.lock().unwrap();
        map.get(&id).map(|h| h.write.clone())
    };
    if let Some(writer) = writer {
        if writer.lock().await.data(&data[..]).await.is_err() {
            close_dead(&app, &sessions, &id).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_ping(sessions: State<'_, Sessions>, id: String) -> Result<Option<u32>> {
    let session = {
        let map = sessions.0.lock().unwrap();
        map.get(&id).map(|h| h.session.clone())
    };
    let Some(session) = session else {
        return Ok(None);
    };
    let started = std::time::Instant::now();
    match tokio::time::timeout(std::time::Duration::from_secs(10), session.send_ping()).await {
        Ok(Ok(())) => Ok(Some(started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32)),
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn ssh_write(
    app: tauri::AppHandle,
    sessions: State<'_, Sessions>,
    id: String,
    data: String,
) -> Result<()> {
    let writer = {
        let map = sessions.0.lock().unwrap();
        map.get(&id).map(|h| h.write.clone())
    };
    if let Some(writer) = writer {
        let bytes = data.into_bytes();
        if writer.lock().await.data(&bytes[..]).await.is_err() {
            close_dead(&app, &sessions, &id).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_resize(
    app: tauri::AppHandle,
    sessions: State<'_, Sessions>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    let writer = {
        let map = sessions.0.lock().unwrap();
        map.get(&id).map(|h| h.write.clone())
    };
    if let Some(writer) = writer {
        if writer
            .lock()
            .await
            .window_change(cols.max(1), rows.max(1), 0, 0)
            .await
            .is_err()
        {
            close_dead(&app, &sessions, &id).await;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_close(sessions: State<'_, Sessions>, id: String) -> Result<()> {
    if let Some((_, token)) = sessions.1.lock().unwrap().remove(&id) {
        token.cancel();
    }
    let removed = { sessions.0.lock().unwrap().remove(&id) };
    if let Some(h) = removed {
        teardown(h).await;
    }
    Ok(())
}
