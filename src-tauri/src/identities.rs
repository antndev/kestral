use std::sync::{Arc, Mutex};

use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::model::{AuthMethod, Host, Identity, NewIdentity};
use crate::vault::Vault;

pub struct IdentityStore {
    vault: Arc<Vault>,
    lock: Mutex<()>,
}

fn validate(name: &str, auth: &AuthMethod) -> Result<()> {
    if name.trim().is_empty() {
        return Err(AppError::Other("Give the identity a name".into()));
    }
    match auth {
        AuthMethod::Identity { .. } => Err(AppError::Other("An identity cannot point to another identity".into())),
        AuthMethod::Password { secret_id } | AuthMethod::Key { secret_id } if secret_id.trim().is_empty() => {
            Err(AppError::Other("Choose a key or password for the identity".into()))
        }
        _ => Ok(()),
    }
}

impl IdentityStore {
    pub fn new(vault: Arc<Vault>) -> Self {
        Self { vault, lock: Mutex::new(()) }
    }

    pub fn list(&self) -> Result<Vec<Identity>> {
        match self.vault.get_blob(Vault::identities_blob_id())? {
            Some(bytes) => serde_json::from_slice(&bytes).map_err(|e| AppError::Other(format!("Identities could not be read: {e}"))),
            None => Ok(Vec::new()),
        }
    }

    fn save(&self, items: &[Identity]) -> Result<()> {
        let bytes = serde_json::to_vec(items)?;
        self.vault.put_blob(Vault::identities_blob_id(), &bytes)
    }

    pub fn get(&self, id: &str) -> Result<Identity> {
        let id = Uuid::parse_str(id).map_err(|_| AppError::NotFound(id.to_string()))?;
        self.list()?
            .into_iter()
            .find(|i| i.id == id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))
    }

    pub fn add(&self, new: NewIdentity) -> Result<Identity> {
        validate(&new.name, &new.auth)?;
        let _g = self.lock.lock().unwrap();
        let mut items = self.list()?;
        let name = new.name.trim().to_string();
        if items.iter().any(|i| i.name.eq_ignore_ascii_case(&name)) {
            return Err(AppError::Other(format!("An identity named {name} already exists")));
        }
        let ident = Identity { id: Uuid::new_v4(), name, username: new.username.trim().to_string(), auth: new.auth };
        items.push(ident.clone());
        self.save(&items)?;
        Ok(ident)
    }

    pub fn update(&self, mut ident: Identity) -> Result<()> {
        validate(&ident.name, &ident.auth)?;
        ident.name = ident.name.trim().to_string();
        ident.username = ident.username.trim().to_string();
        let _g = self.lock.lock().unwrap();
        let mut items = self.list()?;
        if items.iter().any(|i| i.id != ident.id && i.name.eq_ignore_ascii_case(&ident.name)) {
            return Err(AppError::Other(format!("An identity named {} already exists", ident.name)));
        }
        let slot = items
            .iter_mut()
            .find(|i| i.id == ident.id)
            .ok_or_else(|| AppError::NotFound(ident.id.to_string()))?;
        *slot = ident;
        self.save(&items)
    }

    pub fn remove(&self, id: Uuid, hosts: &[Host]) -> Result<()> {
        let users: Vec<&str> = hosts
            .iter()
            .filter(|h| matches!(&h.auth, AuthMethod::Identity { identity_id } if identity_id == &id.to_string()))
            .map(|h| h.name.as_str())
            .collect();
        if !users.is_empty() {
            return Err(AppError::Other(format!("Still used by {}. Pick another sign-in method there first.", users.join(", "))));
        }
        let _g = self.lock.lock().unwrap();
        let mut items = self.list()?;
        let before = items.len();
        items.retain(|i| i.id != id);
        if items.len() == before {
            return Err(AppError::NotFound(id.to_string()));
        }
        self.save(&items)
    }

    pub fn import(&self, incoming: Vec<Identity>) -> Result<(usize, usize)> {
        let _g = self.lock.lock().unwrap();
        let mut items = self.list()?;
        let (mut added, mut skipped) = (0, 0);
        for ident in incoming {
            if items.iter().any(|i| i.id == ident.id) {
                skipped += 1;
                continue;
            }
            items.push(ident);
            added += 1;
        }
        if added > 0 {
            self.save(&items)?;
        }
        Ok((added, skipped))
    }

    pub fn resolve(&self, host: &Host) -> Result<(String, AuthMethod)> {
        match &host.auth {
            AuthMethod::Identity { identity_id } => {
                let ident = self
                    .get(identity_id)
                    .map_err(|_| AppError::Ssh(format!("The identity used by {} no longer exists. Pick another sign-in method.", host.name)))?;
                let user = if ident.username.is_empty() { host.username.clone() } else { ident.username };
                Ok((user, ident.auth))
            }
            other => Ok((host.username.clone(), other.clone())),
        }
    }
}
