// Local port forwarding (like `ssh -L`). Kestral binds a loopback port and
// tunnels every connection through a direct-tcpip channel on the host's SSH
// session, so a service that only listens locally on the remote (a web UI on
// 127.0.0.1, say) becomes reachable in the local browser. Each active forward
// keeps its own SSH session alive until it is stopped.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use russh::client;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::model::{ForwardKind, Host, PortForward};
use crate::ssh::{ClientHandler, ForwardedChannel, SshManager};
use crate::vault::Vault;

struct Active {
    task: tokio::task::JoinHandle<()>,
    session: Arc<client::Handle<ClientHandler>>,
    conns: Arc<AtomicU32>,
    remote_bind: Option<(String, u32)>,
}

type ActiveMap = Arc<Mutex<HashMap<(Uuid, Uuid), Option<Active>>>>;

#[derive(Default)]
pub struct ForwardManager {
    // A present key means the forward is running or in the middle of starting.
    // `None` is a reservation held while start() binds and connects, so a second
    // start (autostart racing a click, a double tap) sees it and backs off
    // instead of trying to bind the same port twice. Shared (Arc) so the accept
    // loop can drop its own entry when the SSH session dies.
    active: ActiveMap,
}

impl ForwardManager {
    /// IDs of every forward that is running or starting.
    pub fn active_ids(&self) -> Vec<Uuid> {
        self.active
            .lock()
            .unwrap()
            .keys()
            .map(|(_, f)| *f)
            .collect()
    }

    pub async fn start(
        &self,
        ssh: &SshManager,
        host: &Host,
        vault: &Arc<Vault>,
        fwd: &PortForward,
    ) -> Result<()> {
        let key = (host.id, fwd.id);

        // Reserve the slot atomically. If it is already taken, this start is a
        // no-op, which is exactly what a duplicate request should do.
        {
            let mut map = self.active.lock().unwrap();
            if map.contains_key(&key) {
                return Ok(());
            }
            map.insert(key, None);
        }

        match self.spawn(ssh, host, vault, fwd, key).await {
            Ok(()) => Ok(()),
            Err(e) => {
                // Bind or connect failed: drop the reservation so a retry works.
                self.active.lock().unwrap().remove(&key);
                Err(e)
            }
        }
    }

    async fn spawn(
        &self,
        ssh: &SshManager,
        host: &Host,
        vault: &Arc<Vault>,
        fwd: &PortForward,
        key: (Uuid, Uuid),
    ) -> Result<()> {
        let conns = Arc::new(AtomicU32::new(0));
        let (task, session, remote_bind) = match fwd.kind {
            ForwardKind::Local | ForwardKind::Dynamic => {
                let listener = bind_local(fwd).await?;
                let session = Arc::new(ssh.connect(host, vault).await?);
                let task = if fwd.kind == ForwardKind::Local {
                    spawn_local(listener, session.clone(), fwd.remote_host.clone(), fwd.remote_port, conns.clone(), self.active.clone(), key)
                } else {
                    spawn_dynamic(listener, session.clone(), conns.clone(), self.active.clone(), key)
                };
                (task, session, None)
            }
            ForwardKind::Remote => {
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
                let session = Arc::new(ssh.connect_forwarding(host, vault, tx).await?);
                let bind = remote_bind_host(fwd);
                let port = session
                    .tcpip_forward(bind.clone(), u32::from(fwd.remote_port))
                    .await
                    .map_err(|e| AppError::Ssh(format!("{} refused to listen on {bind}:{}: {e}", host.name, fwd.remote_port)))?;
                let port = if port == 0 { u32::from(fwd.remote_port) } else { port };
                let target_host = local_target_host(fwd);
                let task = spawn_remote(rx, session.clone(), target_host, fwd.local_port, conns.clone(), self.active.clone(), key);
                (task, session, Some((bind, port)))
            }
        };

        let active = Active { task, session, conns, remote_bind };
        let orphan = {
            let mut map = self.active.lock().unwrap();
            match map.get_mut(&key) {
                Some(slot) => {
                    *slot = Some(active);
                    None
                }
                None => Some(active),
            }
        };
        if let Some(a) = orphan {
            shutdown(a).await;
        }
        Ok(())
    }

    pub fn stats(&self) -> HashMap<String, u32> {
        self.active
            .lock()
            .unwrap()
            .iter()
            .filter_map(|((_, f), a)| a.as_ref().map(|a| (f.to_string(), a.conns.load(Ordering::Relaxed))))
            .collect()
    }

    /// Stop every forward for a host (used when the host is deleted).
    pub async fn stop_host(&self, host_id: Uuid) {
        let ids: Vec<Uuid> = {
            let map = self.active.lock().unwrap();
            map.keys()
                .filter(|(h, _)| *h == host_id)
                .map(|(_, f)| *f)
                .collect()
        };
        for fid in ids {
            self.stop(host_id, fid).await;
        }
    }

    pub async fn stop(&self, host_id: Uuid, forward_id: Uuid) {
        let removed = self.active.lock().unwrap().remove(&(host_id, forward_id));
        // Some(Some(_)): running, tear it down. Some(None): still starting, and
        // removing the reservation tells spawn() to clean up after itself.
        if let Some(Some(a)) = removed {
            // Wait for the accept loop to finish so its listener is dropped and
            // the local port is free before we return; otherwise an immediate
            // restart could hit "address already in use".
            shutdown(a).await;
        }
    }
}

type Session = Arc<client::Handle<ClientHandler>>;

struct ConnGuard(Arc<AtomicU32>);

impl ConnGuard {
    fn new(c: &Arc<AtomicU32>) -> Self {
        c.fetch_add(1, Ordering::Relaxed);
        Self(c.clone())
    }
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

fn bind_host(fwd: &PortForward) -> &str {
    let h = fwd.local_host.trim();
    if h.is_empty() {
        "127.0.0.1"
    } else {
        h
    }
}

fn remote_bind_host(fwd: &PortForward) -> String {
    let h = fwd.remote_host.trim();
    if h.is_empty() {
        "localhost".into()
    } else {
        h.to_string()
    }
}

fn local_target_host(fwd: &PortForward) -> String {
    let h = fwd.local_host.trim();
    if h.is_empty() || h == "0.0.0.0" || h == "::" {
        "127.0.0.1".into()
    } else {
        h.to_string()
    }
}

async fn bind_local(fwd: &PortForward) -> Result<TcpListener> {
    let host = bind_host(fwd);
    TcpListener::bind((host, fwd.local_port)).await.map_err(|e| {
        use std::io::ErrorKind;
        match e.kind() {
            ErrorKind::AddrInUse => AppError::Ssh(format!(
                "{host}:{} is already in use. Close whatever is using it, or pick a different local port.",
                fwd.local_port
            )),
            ErrorKind::AddrNotAvailable => AppError::Ssh(format!(
                "{host} is not an address on this machine. Kestral listens here, so use 127.0.0.1 (or 0.0.0.0)."
            )),
            _ => AppError::Ssh(format!("cannot bind {host}:{}: {e}", fwd.local_port)),
        }
    })
}

fn watch_closed(session: &Session, active: &ActiveMap, key: (Uuid, Uuid)) -> bool {
    if session.is_closed() {
        tracing::info!("forward SSH session closed; freeing the forward");
        release(session, active, key);
        true
    } else {
        false
    }
}

fn release(session: &Session, active: &ActiveMap, key: (Uuid, Uuid)) {
    let mut map = active.lock().unwrap();
    if matches!(map.get(&key), Some(Some(a)) if Arc::ptr_eq(&a.session, session)) {
        map.remove(&key);
    }
}

async fn accept_failed(e: std::io::Error) {
    tracing::warn!("accepting a forwarded connection failed: {e}");
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
}

fn watch_interval() -> tokio::time::Interval {
    let every = std::time::Duration::from_secs(15);
    tokio::time::interval_at(tokio::time::Instant::now() + every, every)
}

fn spawn_local(
    listener: TcpListener,
    session: Session,
    remote_host: String,
    remote_port: u16,
    conns: Arc<AtomicU32>,
    active: ActiveMap,
    key: (Uuid, Uuid),
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut watch = watch_interval();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (mut socket, peer) = match accepted {
                        Ok(a) => a,
                        Err(e) => {
                            accept_failed(e).await;
                            continue;
                        }
                    };
                    let session = session.clone();
                    let rhost = remote_host.clone();
                    let guard = ConnGuard::new(&conns);
                    tokio::spawn(async move {
                        let _guard = guard;
                        let channel = match session
                            .channel_open_direct_tcpip(rhost, u32::from(remote_port), peer.ip().to_string(), u32::from(peer.port()))
                            .await
                        {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::warn!("opening forward channel failed: {e}");
                                return;
                            }
                        };
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    });
                }
                _ = watch.tick() => {
                    if watch_closed(&session, &active, key) {
                        break;
                    }
                }
            }
        }
    })
}

const SOCKS_OK: u8 = 0;
const SOCKS_FAILURE: u8 = 1;
const SOCKS_HOST_UNREACHABLE: u8 = 4;
const SOCKS_COMMAND_UNSUPPORTED: u8 = 7;
const SOCKS_ADDRESS_UNSUPPORTED: u8 = 8;

async fn socks_reply(sock: &mut TcpStream, code: u8) {
    let _ = sock.write_all(&[5, code, 0, 1, 0, 0, 0, 0, 0, 0]).await;
}

async fn socks_request(sock: &mut TcpStream) -> std::io::Result<Option<(String, u16)>> {
    let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidData, "not a SOCKS5 request");
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Err(invalid());
    }
    let mut methods = vec![0u8; usize::from(head[1])];
    sock.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        sock.write_all(&[5, 0xFF]).await?;
        return Ok(None);
    }
    sock.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await?;
    if req[0] != 5 {
        return Err(invalid());
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            sock.read_exact(&mut len).await?;
            let mut name = vec![0u8; usize::from(len[0])];
            sock.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| invalid())?
        }
        4 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            socks_reply(sock, SOCKS_ADDRESS_UNSUPPORTED).await;
            return Ok(None);
        }
    };
    let mut port = [0u8; 2];
    sock.read_exact(&mut port).await?;
    if req[1] != 1 {
        socks_reply(sock, SOCKS_COMMAND_UNSUPPORTED).await;
        return Ok(None);
    }
    Ok(Some((host, u16::from_be_bytes(port))))
}

fn spawn_dynamic(
    listener: TcpListener,
    session: Session,
    conns: Arc<AtomicU32>,
    active: ActiveMap,
    key: (Uuid, Uuid),
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut watch = watch_interval();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (mut socket, peer) = match accepted {
                        Ok(a) => a,
                        Err(e) => {
                            accept_failed(e).await;
                            continue;
                        }
                    };
                    let session = session.clone();
                    let guard = ConnGuard::new(&conns);
                    tokio::spawn(async move {
                        let _guard = guard;
                        let target = match tokio::time::timeout(std::time::Duration::from_secs(30), socks_request(&mut socket)).await {
                            Ok(Ok(Some(t))) => t,
                            Ok(Ok(None)) => return,
                            _ => {
                                socks_reply(&mut socket, SOCKS_FAILURE).await;
                                return;
                            }
                        };
                        let channel = match session
                            .channel_open_direct_tcpip(target.0.clone(), u32::from(target.1), peer.ip().to_string(), u32::from(peer.port()))
                            .await
                        {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::debug!("SOCKS target {}:{} failed: {e}", target.0, target.1);
                                socks_reply(&mut socket, SOCKS_HOST_UNREACHABLE).await;
                                return;
                            }
                        };
                        socks_reply(&mut socket, SOCKS_OK).await;
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    });
                }
                _ = watch.tick() => {
                    if watch_closed(&session, &active, key) {
                        break;
                    }
                }
            }
        }
    })
}

fn spawn_remote(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<ForwardedChannel>,
    session: Session,
    target_host: String,
    target_port: u16,
    conns: Arc<AtomicU32>,
    active: ActiveMap,
    key: (Uuid, Uuid),
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut watch = watch_interval();
        loop {
            tokio::select! {
                incoming = rx.recv() => {
                    let Some(fc) = incoming else {
                        tracing::info!("forward SSH session ended; freeing the forward");
                        release(&session, &active, key);
                        break;
                    };
                    let host = target_host.clone();
                    let guard = ConnGuard::new(&conns);
                    tokio::spawn(async move {
                        let _guard = guard;
                        let mut local = match TcpStream::connect((host.as_str(), target_port)).await {
                            Ok(s) => s,
                            Err(e) => {
                                tracing::warn!("remote forward from {}:{} could not reach {host}:{target_port}: {e}", fc.address, fc.port);
                                let _ = fc.channel.close().await;
                                return;
                            }
                        };
                        let mut stream = fc.channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut local, &mut stream).await;
                    });
                }
                _ = watch.tick() => {
                    if watch_closed(&session, &active, key) {
                        break;
                    }
                }
            }
        }
    })
}

async fn shutdown(a: Active) {
    a.task.abort();
    let _ = a.task.await;
    if let Some((bind, port)) = &a.remote_bind {
        let _ = a.session.cancel_tcpip_forward(bind.clone(), *port).await;
    }
    let _ = a.session.disconnect(russh::Disconnect::ByApplication, "", "").await;
}

#[derive(Serialize, Clone)]
struct ForwardFailed {
    host: String,
    name: String,
    error: String,
}

pub async fn start_on_connect(app: &tauri::AppHandle, host: &Host) {
    let forwards = app.state::<ForwardManager>();
    let state = app.state::<crate::state::AppState>();
    let running = forwards.active_ids();
    for f in host.forwards.iter().filter(|f| f.start_on_connect && !running.contains(&f.id)) {
        if let Err(e) = forwards.start(&state.services.ssh, host, &state.services.vault, f).await {
            let name = if f.name.trim().is_empty() { format!("port {}", f.local_port) } else { f.name.clone() };
            let _ = app.emit("forward-failed", ForwardFailed { host: host.name.clone(), name, error: e.to_string() });
        }
    }
}
