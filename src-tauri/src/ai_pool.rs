use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client;
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::error::Result;
use crate::model::Host;
use crate::ssh::{ClientHandler, SshManager};
use crate::vault::Vault;

pub const IDLE: Duration = Duration::from_secs(600);

type Session = Arc<client::Handle<ClientHandler>>;

struct Live {
    session: Session,
    target: String,
    last_used: Instant,
}

impl Live {
    fn idle(&self) -> bool {
        self.last_used.elapsed() >= IDLE && Arc::strong_count(&self.session) == 1
    }
}

#[derive(Default)]
pub struct AiPool {
    slots: Mutex<HashMap<Uuid, Arc<AsyncMutex<Option<Live>>>>>,
}

fn close(session: Session) {
    tokio::spawn(async move {
        let _ = session.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    });
}

fn retire(session: Session) {
    if Arc::strong_count(&session) == 1 {
        close(session);
    }
}

impl AiPool {
    fn slot(&self, id: Uuid) -> Arc<AsyncMutex<Option<Live>>> {
        self.slots.lock().unwrap().entry(id).or_default().clone()
    }

    pub async fn session(
        &self,
        ssh: &SshManager,
        vault: &Arc<Vault>,
        host: &Host,
        allowed: &(dyn Fn() -> Result<()> + Sync),
    ) -> Result<Session> {
        let slot = self.slot(host.id);
        let mut live = slot.lock().await;
        let chain = ssh.jump_chain(host);
        let target = ssh.route_key(host, chain.as_deref().unwrap_or_default());
        if let Some(l) = live.as_mut() {
            if l.target == target && !l.session.is_closed() && !l.idle() {
                l.last_used = Instant::now();
                return Ok(l.session.clone());
            }
        }
        if let Some(old) = live.take() {
            retire(old.session);
        }
        let chain = chain?;
        allowed()?;
        let session = Arc::new(ssh.connect_route(host, &chain, vault).await?);
        *live = Some(Live { session: session.clone(), target, last_used: Instant::now() });
        Ok(session)
    }

    pub async fn discard(&self, id: Uuid, session: Session) {
        let slot = self.slots.lock().unwrap().get(&id).cloned();
        if let Some(slot) = slot {
            let mut live = slot.lock().await;
            if live.as_ref().is_some_and(|l| Arc::ptr_eq(&l.session, &session)) {
                *live = None;
            }
        }
        retire(session);
    }

    pub async fn forget(&self, id: Uuid) {
        let slot = self.slots.lock().unwrap().remove(&id);
        if let Some(slot) = slot {
            if let Some(l) = slot.lock().await.take() {
                close(l.session);
            }
        }
    }

    pub fn clear(&self) {
        let slots: Vec<_> = self.slots.lock().unwrap().drain().map(|(_, s)| s).collect();
        for slot in slots {
            let taken = slot.try_lock().ok().map(|mut live| live.take());
            match taken {
                Some(Some(l)) => close(l.session),
                Some(None) => {}
                None => {
                    tokio::spawn(async move {
                        if let Some(l) = slot.lock().await.take() {
                            close(l.session);
                        }
                    });
                }
            }
        }
    }

    pub fn prune(&self, ai_active: bool) {
        if !ai_active {
            self.clear();
            return;
        }
        let mut slots = self.slots.lock().unwrap();
        slots.retain(|_, slot| {
            let Ok(mut live) = slot.try_lock() else {
                return true;
            };
            let stale = live.as_ref().is_none_or(|l| l.session.is_closed() || l.idle());
            if stale {
                if let Some(l) = live.take() {
                    close(l.session);
                }
            }
            !stale
        });
    }
}
