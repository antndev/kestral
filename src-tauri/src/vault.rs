
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::{AppError, Result};

const KDF_M_COST: u32 = 65_536;
const KDF_T_COST: u32 = 2;
const KDF_P_COST: u32 = 1;
const VAULT_VERSION: u8 = 1;

const ENVELOPE_AAD: &[u8] = b"kestral-metadata-v1";

const DEK_ID: &str = "__kestral_dek__";

const HOSTS_ID: &str = "__kestral_hosts__";
const SNIPPETS_ID: &str = "__kestral_snippets__";
const IDENTITIES_ID: &str = "__kestral_identities__";
const COLLECTIONS_ID: &str = "__kestral_collections__";
const KNOWN_HOSTS_ID: &str = "__kestral_known_hosts__";

fn is_reserved(id: &str) -> bool {
    id == DEK_ID || id == HOSTS_ID || id == SNIPPETS_ID || id == IDENTITIES_ID || id == COLLECTIONS_ID || id == KNOWN_HOSTS_ID
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretKind {
    Password,
    PrivateKey,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecretMeta {
    pub id: String,
    pub kind: SecretKind,
    pub created_at: Option<String>,
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct Record {
    #[zeroize(skip)]
    kind: SecretKind,
    value: Vec<u8>,
    #[zeroize(skip)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created: Option<String>,
}

fn now_stamp() -> Option<String> {
    Some(chrono::Utc::now().to_rfc3339())
}

#[derive(Serialize, Deserialize)]
struct Header {
    version: u8,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: String,
    nonce: String,
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    header: Header,
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    enc: u8,
    nonce: String,
    ciphertext: String,
}

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
    data: BTreeMap<String, Record>,
}

/// What decrypting the vault file yields: data key, salt, the records, and a flag
/// for whether the file was in an older format and should be re-sealed.
type DecryptedVault = (Zeroizing<[u8; 32]>, [u8; 16], BTreeMap<String, Record>, bool);

pub trait SecretStore: Send + Sync {
    fn is_unlocked(&self) -> bool;
    fn exists(&self) -> bool;
    fn create(&self, master: &str) -> Result<()>;
    fn unlock(&self, master: &str) -> Result<()>;
    fn lock(&self);
    fn put_secret(&self, id: &str, kind: SecretKind, value: &[u8]) -> Result<()>;
    fn get_secret(&self, id: &str) -> Result<Zeroizing<Vec<u8>>>;
    fn delete_secret(&self, id: &str) -> Result<()>;
    fn list_secrets(&self) -> Result<Vec<SecretMeta>>;
}

pub struct Vault {
    path: PathBuf,
    state: Mutex<Option<Unlocked>>,
}

impl Vault {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Mutex::new(None),
        }
    }

    fn derive_key(master: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
        let params = argon2::Params::new(KDF_M_COST, KDF_T_COST, KDF_P_COST, Some(32))
            .map_err(|_| AppError::Crypto)?;
        let argon = argon2::Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            params,
        );
        let mut key = Zeroizing::new([0u8; 32]);
        argon
            .hash_password_into(master.as_bytes(), salt, key.as_mut_slice())
            .map_err(|_| AppError::Crypto)?;
        Ok(key)
    }

    fn persist(&self, unlocked: &Unlocked) -> Result<()> {
        self.persist_with(&unlocked.key, &unlocked.salt, &unlocked.data)
    }

    fn persist_with(&self, key: &[u8; 32], salt: &[u8; 16], data: &BTreeMap<String, Record>) -> Result<()> {
        let plaintext = Zeroizing::new(serde_json::to_vec(data)?);

        let mut nonce_bytes = [0u8; 24];
        OsRng.fill_bytes(&mut nonce_bytes);

        let header = Header {
            version: VAULT_VERSION,
            m_cost: KDF_M_COST,
            t_cost: KDF_T_COST,
            p_cost: KDF_P_COST,
            salt: b64().encode(salt),
            nonce: b64().encode(nonce_bytes),
        };
        let aad = serde_json::to_vec(&header)?;

        let cipher =
            XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| AppError::Crypto)?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext.as_slice(),
                    aad: &aad,
                },
            )
            .map_err(|_| AppError::Crypto)?;

        let file = VaultFile {
            header,
            ciphertext: b64().encode(ciphertext),
        };
        let bytes = serde_json::to_vec_pretty(&file)?;
        crate::util::atomic_write(&self.path, &bytes)?;
        Ok(())
    }

    fn decrypt_file(path: &std::path::Path, master: &str) -> Result<DecryptedVault> {
        let raw = std::fs::read(path)?;
        let file: VaultFile = serde_json::from_slice(&raw)?;

        let salt_vec = b64().decode(&file.header.salt).map_err(|_| AppError::Crypto)?;
        let nonce_vec = b64().decode(&file.header.nonce).map_err(|_| AppError::Crypto)?;
        let ct = b64()
            .decode(&file.ciphertext)
            .map_err(|_| AppError::Crypto)?;
        if salt_vec.len() != 16 || nonce_vec.len() != 24 {
            return Err(AppError::Crypto);
        }
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&salt_vec);

        if file.header.m_cost > 1_048_576 || file.header.t_cost > 10 || file.header.p_cost > 4 {
            return Err(AppError::Crypto);
        }
        let params = argon2::Params::new(
            file.header.m_cost,
            file.header.t_cost,
            file.header.p_cost,
            Some(32),
        )
        .map_err(|_| AppError::Crypto)?;
        let argon = argon2::Argon2::new(
            argon2::Algorithm::Argon2id,
            argon2::Version::V0x13,
            params,
        );
        let mut key = Zeroizing::new([0u8; 32]);
        argon
            .hash_password_into(master.as_bytes(), &salt, key.as_mut_slice())
            .map_err(|_| AppError::Crypto)?;

        let aad = serde_json::to_vec(&file.header)?;
        let cipher =
            XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| AppError::Crypto)?;
        let plaintext = cipher
            .decrypt(
                XNonce::from_slice(&nonce_vec),
                Payload {
                    msg: &ct,
                    aad: &aad,
                },
            )
            .map_err(|_| AppError::VaultAuth)?;
        let plaintext = Zeroizing::new(plaintext);
        let data: BTreeMap<String, Record> = serde_json::from_slice(&plaintext)?;

        let outdated = file.header.m_cost != KDF_M_COST
            || file.header.t_cost != KDF_T_COST
            || file.header.p_cost != KDF_P_COST;
        Ok((key, salt, data, outdated))
    }

    fn decrypt_file_with_key(path: &std::path::Path, key: &[u8; 32]) -> Result<([u8; 16], BTreeMap<String, Record>)> {
        let raw = std::fs::read(path)?;
        let file: VaultFile = serde_json::from_slice(&raw)?;
        let salt_vec = b64().decode(&file.header.salt).map_err(|_| AppError::Crypto)?;
        let nonce_vec = b64().decode(&file.header.nonce).map_err(|_| AppError::Crypto)?;
        let ct = b64().decode(&file.ciphertext).map_err(|_| AppError::Crypto)?;
        if salt_vec.len() != 16 || nonce_vec.len() != 24 {
            return Err(AppError::Crypto);
        }
        let mut salt = [0u8; 16];
        salt.copy_from_slice(&salt_vec);
        let aad = serde_json::to_vec(&file.header)?;
        let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|_| AppError::Crypto)?;
        let plaintext = cipher
            .decrypt(XNonce::from_slice(&nonce_vec), Payload { msg: &ct, aad: &aad })
            .map_err(|_| AppError::VaultAuth)?;
        let plaintext = Zeroizing::new(plaintext);
        let data: BTreeMap<String, Record> = serde_json::from_slice(&plaintext)?;
        Ok((salt, data))
    }

    /// The key that encrypts the vault file, for wrapping by a quick unlock method.
    pub fn file_key(&self) -> Result<Zeroizing<[u8; 32]>> {
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;
        Ok(unlocked.key.clone())
    }

    pub fn unlock_with_key(&self, key: &[u8; 32]) -> Result<()> {
        if !self.exists() {
            return Err(AppError::VaultMissing);
        }
        let (salt, data) = Vault::decrypt_file_with_key(&self.path, key)?;
        let mut unlocked = Unlocked { key: Zeroizing::new(*key), salt, data };
        if Self::ensure_dek(&mut unlocked) {
            self.persist(&unlocked)?;
        }
        *self.state.lock().unwrap() = Some(unlocked);
        Ok(())
    }

    pub fn change_master(&self, current: &str, new: &str) -> Result<()> {
        let mut guard = self.state.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::VaultLocked)?;

        let check = Vault::derive_key(current, &unlocked.salt)?;
        if !bool::from(check.as_slice().ct_eq(unlocked.key.as_slice())) {
            return Err(AppError::VaultAuth);
        }

        let mut new_salt = [0u8; 16];
        OsRng.fill_bytes(&mut new_salt);
        let new_key = Vault::derive_key(new, &new_salt)?;
        self.persist_with(&new_key, &new_salt, &unlocked.data)?;
        unlocked.key = new_key;
        unlocked.salt = new_salt;
        Ok(())
    }

    fn apply(&self, unlocked: &mut Unlocked, changes: Vec<(String, Option<Record>)>) -> Result<()> {
        let mut undo = Vec::with_capacity(changes.len());
        for (id, rec) in changes {
            let prev = match rec {
                Some(r) => unlocked.data.insert(id.clone(), r),
                None => unlocked.data.remove(&id),
            };
            undo.push((id, prev));
        }
        let result = self.persist(unlocked);
        if result.is_err() {
            for (id, prev) in undo.into_iter().rev() {
                match prev {
                    Some(p) => unlocked.data.insert(id, p),
                    None => unlocked.data.remove(&id),
                };
            }
        }
        result
    }

    pub fn secret_kind(&self, id: &str) -> Result<SecretKind> {
        if is_reserved(id) {
            return Err(AppError::NotFound(id.to_string()));
        }
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;
        unlocked
            .data
            .get(id)
            .map(|rec| rec.kind)
            .ok_or_else(|| AppError::NotFound(id.to_string()))
    }

    fn ensure_dek(unlocked: &mut Unlocked) -> bool {
        if unlocked.data.contains_key(DEK_ID) {
            return false;
        }
        let mut dek = [0u8; 32];
        OsRng.fill_bytes(&mut dek);
        unlocked.data.insert(
            DEK_ID.to_string(),
            Record {
                kind: SecretKind::Password,
                value: dek.to_vec(),
                created: None,
            },
        );
        true
    }

    fn dek_of(unlocked: &Unlocked) -> Option<Zeroizing<[u8; 32]>> {
        let rec = unlocked.data.get(DEK_ID)?;
        if rec.value.len() != 32 {
            return None;
        }
        let mut k = Zeroizing::new([0u8; 32]);
        k.copy_from_slice(&rec.value);
        Some(k)
    }

    pub const fn hosts_blob_id() -> &'static str {
        HOSTS_ID
    }

    pub const fn snippets_blob_id() -> &'static str {
        SNIPPETS_ID
    }

    pub const fn identities_blob_id() -> &'static str {
        IDENTITIES_ID
    }

    pub const fn collections_blob_id() -> &'static str {
        COLLECTIONS_ID
    }

    pub const fn known_hosts_blob_id() -> &'static str {
        KNOWN_HOSTS_ID
    }

    pub fn get_blob(&self, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;
        Ok(unlocked
            .data
            .get(id)
            .map(|rec| Zeroizing::new(rec.value.clone())))
    }

    pub fn put_blob(&self, id: &str, bytes: &[u8]) -> Result<()> {
        let mut guard = self.state.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::VaultLocked)?;
        let rec = Record {
            kind: SecretKind::Password,
            value: bytes.to_vec(),
            created: None,
        };
        self.apply(unlocked, vec![(id.to_string(), Some(rec))])
    }

    /// Insert several secrets and persist once, instead of rewriting and fsyncing
    /// the whole vault per secret. Reserved ids are skipped. Used by the importer.
    pub fn put_secrets(&self, items: Vec<(String, SecretKind, Vec<u8>)>) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let mut guard = self.state.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::VaultLocked)?;
        let mut changes = Vec::new();
        for (id, kind, value) in items {
            if is_reserved(&id) {
                continue;
            }
            let created = unlocked.data.get(&id).and_then(|r| r.created.clone()).or_else(now_stamp);
            changes.push((id, Some(Record { kind, value, created })));
        }
        self.apply(unlocked, changes)
    }

    pub fn copy_secret(&self, from: &str, to: &str) -> Result<()> {
        if is_reserved(from) {
            return Err(AppError::NotFound(from.to_string()));
        }
        if is_reserved(to) {
            return Err(AppError::Other("Names starting with __kestral_ are reserved".into()));
        }
        let mut guard = self.state.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::VaultLocked)?;
        if unlocked.data.contains_key(to) {
            return Err(AppError::Other("Something in your vault already has this name".into()));
        }
        let rec = unlocked.data.get(from).ok_or_else(|| AppError::NotFound(from.to_string()))?;
        let copy = Record { kind: rec.kind, value: rec.value.clone(), created: rec.created.clone() };
        self.apply(unlocked, vec![(to.to_string(), Some(copy))])
    }

    pub fn seal_envelope(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;
        let dek = Self::dek_of(unlocked).ok_or(AppError::Crypto)?;

        let mut nonce_bytes = [0u8; 24];
        OsRng.fill_bytes(&mut nonce_bytes);
        let cipher =
            XChaCha20Poly1305::new_from_slice(dek.as_slice()).map_err(|_| AppError::Crypto)?;
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: ENVELOPE_AAD,
                },
            )
            .map_err(|_| AppError::Crypto)?;

        let env = Envelope {
            enc: 1,
            nonce: b64().encode(nonce_bytes),
            ciphertext: b64().encode(ciphertext),
        };
        Ok(serde_json::to_vec_pretty(&env)?)
    }

    pub fn open_envelope(&self, data: &[u8]) -> Result<(Zeroizing<Vec<u8>>, bool)> {
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;

        let env: Envelope = serde_json::from_slice(data)?;
        let nonce = b64().decode(&env.nonce).map_err(|_| AppError::Crypto)?;
        let ct = b64().decode(&env.ciphertext).map_err(|_| AppError::Crypto)?;
        if nonce.len() != 24 {
            return Err(AppError::Crypto);
        }

        let try_key = |key: &[u8]| -> Option<Vec<u8>> {
            let cipher = XChaCha20Poly1305::new_from_slice(key).ok()?;
            cipher
                .decrypt(
                    XNonce::from_slice(&nonce),
                    Payload {
                        msg: &ct,
                        aad: ENVELOPE_AAD,
                    },
                )
                .ok()
        };

        if let Some(dek) = Self::dek_of(unlocked) {
            if let Some(plain) = try_key(dek.as_slice()) {
                return Ok((Zeroizing::new(plain), false));
            }
        }
        match try_key(unlocked.key.as_slice()) {
            Some(plain) => Ok((Zeroizing::new(plain), true)),
            None => Err(AppError::VaultAuth),
        }
    }
}

impl SecretStore for Vault {
    fn is_unlocked(&self) -> bool {
        self.state.lock().unwrap().is_some()
    }

    fn exists(&self) -> bool {
        self.path.exists()
    }

    fn create(&self, master: &str) -> Result<()> {
        if self.exists() {
            return Err(AppError::VaultExists);
        }
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let key = Vault::derive_key(master, &salt)?;
        let mut unlocked = Unlocked {
            key,
            salt,
            data: BTreeMap::new(),
        };
        Self::ensure_dek(&mut unlocked);
        self.persist(&unlocked)?;
        *self.state.lock().unwrap() = Some(unlocked);
        Ok(())
    }

    fn unlock(&self, master: &str) -> Result<()> {
        if !self.exists() {
            return Err(AppError::VaultMissing);
        }
        let (key, salt, data, outdated) = Vault::decrypt_file(&self.path, master)?;
        let mut unlocked = Unlocked { key, salt, data };
        let fresh_dek = Self::ensure_dek(&mut unlocked);

        if outdated {
            let mut new_salt = [0u8; 16];
            OsRng.fill_bytes(&mut new_salt);
            unlocked.key = Vault::derive_key(master, &new_salt)?;
            unlocked.salt = new_salt;
            self.persist(&unlocked)?;
        } else if fresh_dek {
            self.persist(&unlocked)?;
        }

        *self.state.lock().unwrap() = Some(unlocked);
        Ok(())
    }

    fn lock(&self) {
        *self.state.lock().unwrap() = None;
    }

    fn put_secret(&self, id: &str, kind: SecretKind, value: &[u8]) -> Result<()> {
        if is_reserved(id) {
            return Err(AppError::NotFound(id.to_string()));
        }
        let mut guard = self.state.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::VaultLocked)?;
        let created = unlocked.data.get(id).and_then(|r| r.created.clone()).or_else(now_stamp);
        let rec = Record {
            kind,
            value: value.to_vec(),
            created,
        };
        self.apply(unlocked, vec![(id.to_string(), Some(rec))])
    }

    fn get_secret(&self, id: &str) -> Result<Zeroizing<Vec<u8>>> {
        if is_reserved(id) {
            return Err(AppError::NotFound(id.to_string()));
        }
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;
        let rec = unlocked
            .data
            .get(id)
            .ok_or_else(|| AppError::NotFound(id.to_string()))?;
        Ok(Zeroizing::new(rec.value.clone()))
    }

    fn delete_secret(&self, id: &str) -> Result<()> {
        if is_reserved(id) {
            return Err(AppError::NotFound(id.to_string()));
        }
        let mut guard = self.state.lock().unwrap();
        let unlocked = guard.as_mut().ok_or(AppError::VaultLocked)?;
        self.apply(unlocked, vec![(id.to_string(), None)])
    }

    fn list_secrets(&self) -> Result<Vec<SecretMeta>> {
        let guard = self.state.lock().unwrap();
        let unlocked = guard.as_ref().ok_or(AppError::VaultLocked)?;
        Ok(unlocked
            .data
            .iter()
            .filter(|(id, _)| !is_reserved(id))
            .map(|(id, rec)| SecretMeta {
                id: id.clone(),
                kind: rec.kind,
                created_at: rec.created.clone(),
            })
            .collect())
    }
}

/// Encrypt arbitrary bytes under a password, in the same on-disk shape as a vault
/// file (Argon2id KEK, XChaCha20-Poly1305, header as AAD). Used for the portable
/// vault export, whose password is independent of any live vault.
pub fn seal_with_password(plaintext: &[u8], password: &str) -> Result<Vec<u8>> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let key = Vault::derive_key(password, &salt)?;

    let mut nonce_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut nonce_bytes);

    let header = Header {
        version: VAULT_VERSION,
        m_cost: KDF_M_COST,
        t_cost: KDF_T_COST,
        p_cost: KDF_P_COST,
        salt: b64().encode(salt),
        nonce: b64().encode(nonce_bytes),
    };
    let aad = serde_json::to_vec(&header)?;

    let cipher =
        XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| AppError::Crypto)?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::Crypto)?;

    let file = VaultFile {
        header,
        ciphertext: b64().encode(ciphertext),
    };
    Ok(serde_json::to_vec_pretty(&file)?)
}

/// Decrypt bytes produced by [`seal_with_password`]. A wrong password surfaces as
/// `VaultAuth`; a malformed or tampered file as `Crypto`.
pub fn open_with_password(bytes: &[u8], password: &str) -> Result<Zeroizing<Vec<u8>>> {
    let file: VaultFile = serde_json::from_slice(bytes)?;

    let salt = b64().decode(&file.header.salt).map_err(|_| AppError::Crypto)?;
    let nonce = b64().decode(&file.header.nonce).map_err(|_| AppError::Crypto)?;
    let ct = b64().decode(&file.ciphertext).map_err(|_| AppError::Crypto)?;
    if salt.len() != 16 || nonce.len() != 24 {
        return Err(AppError::Crypto);
    }
    if file.header.m_cost > 1_048_576 || file.header.t_cost > 10 || file.header.p_cost > 4 {
        return Err(AppError::Crypto);
    }

    let params =
        argon2::Params::new(file.header.m_cost, file.header.t_cost, file.header.p_cost, Some(32))
            .map_err(|_| AppError::Crypto)?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), &salt, key.as_mut_slice())
        .map_err(|_| AppError::Crypto)?;

    let aad = serde_json::to_vec(&file.header)?;
    let cipher =
        XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| AppError::Crypto)?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: &aad,
            },
        )
        .map_err(|_| AppError::VaultAuth)?;
    Ok(Zeroizing::new(plaintext))
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 24];
    OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn load_or_create_token(path: &std::path::Path) -> String {
    if let Ok(existing) = std::fs::read_to_string(path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let token = random_token();
    if let Err(e) = crate::util::write_private(path, token.as_bytes()) {
        tracing::error!(
            "MCP token could not be saved at {}: {e}. The one-time \
             `claude mcp add` registration will not survive a restart.",
            path.display()
        );
    }
    token
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_vault_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("kestral_test_{tag}_{}.json", random_token()))
    }

    #[test]
    fn unlock_roundtrip_keeps_secrets() {
        let master = "correct horse battery";
        let path = tmp_vault_path("rt");
        let v = Vault::new(path.clone());
        v.create(master).unwrap();
        v.put_secret("shared", SecretKind::Password, b"val").unwrap();
        v.put_secret("only", SecretKind::PrivateKey, b"key").unwrap();

        v.lock();
        assert!(!v.is_unlocked());
        v.unlock(master).unwrap();
        assert_eq!(v.get_secret("shared").unwrap().to_vec(), b"val".to_vec());
        assert_eq!(v.get_secret("only").unwrap().to_vec(), b"key".to_vec());

        v.lock();
        assert!(v.unlock("wrong").is_err());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn seal_open_roundtrip_requires_unlock() {
        let master = "pw-seal";
        let path = tmp_vault_path("seal");
        let v = Vault::new(path.clone());
        v.create(master).unwrap();

        let msg = br#"[{"name":"opnsense","ip":"10.0.0.1"}]"#;
        let env = v.seal_envelope(msg).unwrap();
        assert_eq!(
            env.iter().find(|b| !b.is_ascii_whitespace()).copied(),
            Some(b'{')
        );
        let (plain, legacy) = v.open_envelope(&env).unwrap();
        assert_eq!(plain.to_vec(), msg.to_vec());
        assert!(!legacy, "frisch versiegelt haengt am Datenschluessel");

        v.lock();
        assert!(v.seal_envelope(msg).is_err());
        assert!(v.open_envelope(&env).is_err());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn envelope_survives_password_change() {
        let path = tmp_vault_path("dek");
        let v = Vault::new(path.clone());
        v.create("erstes-pw").unwrap();

        let msg = br#"[{"name":"homelab","hostname":"10.0.0.5"}]"#;
        let env = v.seal_envelope(msg).unwrap();

        v.change_master("erstes-pw", "zweites-pw").unwrap();
        let (plain, _) = v.open_envelope(&env).unwrap();
        assert_eq!(plain.to_vec(), msg.to_vec(), "direkt nach dem Wechsel lesbar");

        v.lock();
        v.unlock("zweites-pw").unwrap();
        let (plain, _) = v.open_envelope(&env).unwrap();
        assert_eq!(plain.to_vec(), msg.to_vec(), "still readable after restart");

        let env2 = v.seal_envelope(b"zweiter inhalt").unwrap();
        assert_eq!(v.open_envelope(&env2).unwrap().0.to_vec(), b"zweiter inhalt".to_vec());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn change_master_switches_password_and_keeps_data() {
        let old = "old-pw";
        let new = "new-pw";
        let path = tmp_vault_path("chg");
        let v = Vault::new(path.clone());
        v.create(old).unwrap();
        v.put_secret("k", SecretKind::Password, b"val").unwrap();

        assert!(v.change_master("wrong", new).is_err());

        v.change_master(old, new).unwrap();
        assert_eq!(v.get_secret("k").unwrap().to_vec(), b"val".to_vec());

        v.lock();
        assert!(v.unlock(old).is_err());
        v.unlock(new).unwrap();
        assert_eq!(v.get_secret("k").unwrap().to_vec(), b"val".to_vec());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn failed_persist_changes_nothing_in_memory() {
        let path = tmp_vault_path("failpersist");
        let v = Vault::new(path.clone());
        v.create("old").unwrap();
        v.put_secret("k", SecretKind::Password, b"val").unwrap();
        let blocker = path.with_extension("tmp");
        std::fs::create_dir_all(&blocker).unwrap();

        assert!(v.change_master("old", "new").is_err());
        assert!(v.delete_secret("k").is_err());
        assert!(v.put_secret("lost", SecretKind::PrivateKey, b"x").is_err());
        assert!(v.put_blob(HOSTS_ID, b"[1]").is_err());
        assert_eq!(v.get_secret("k").unwrap().to_vec(), b"val".to_vec());
        assert!(v.get_secret("lost").is_err());
        assert!(v.get_blob(HOSTS_ID).unwrap().is_none());

        std::fs::remove_dir_all(&blocker).unwrap();
        v.put_secret("later", SecretKind::Password, b"y").unwrap();
        v.lock();
        assert!(v.unlock("new").is_err());
        v.unlock("old").unwrap();
        assert_eq!(v.get_secret("k").unwrap().to_vec(), b"val".to_vec());
        assert!(v.get_secret("lost").is_err());
        assert_eq!(v.secret_kind("later").unwrap(), SecretKind::Password);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reserved_ids_are_not_reachable_through_secret_api() {
        let path = tmp_vault_path("reserved");
        let v = Vault::new(path.clone());
        v.create("pw").unwrap();

        assert!(v.get_secret(DEK_ID).is_err());
        assert!(v.get_secret(HOSTS_ID).is_err());
        assert!(v.put_secret(DEK_ID, SecretKind::Password, b"x").is_err());
        assert!(v.delete_secret(DEK_ID).is_err());

        v.put_blob(HOSTS_ID, b"[]").unwrap();
        v.seal_envelope(b"still works").unwrap();

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn absurd_kdf_cost_in_header_is_rejected_not_allocated() {
        let path = tmp_vault_path("kdf");
        let v = Vault::new(path.clone());
        v.create("pw").unwrap();
        v.lock();

        let raw = std::fs::read(&path).unwrap();
        let mut file: VaultFile = serde_json::from_slice(&raw).unwrap();
        file.header.m_cost = 4_194_304;
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();

        assert!(matches!(v.unlock("pw"), Err(AppError::Crypto)));

        let _ = std::fs::remove_file(&path);
    }
}
