use std::path::PathBuf;

use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::util::blocking;

const AAD: &[u8] = b"kestral-hello-v1";

pub struct Hello {
    path: PathBuf,
}

impl Hello {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn forget(&self) {
        let _ = std::fs::remove_file(&self.path);
        #[cfg(windows)]
        win::delete();
    }
}

#[derive(Serialize, Deserialize)]
struct HelloFile {
    version: u8,
    challenge: String,
    nonce: String,
    wrapped: String,
}

#[derive(Serialize)]
pub struct HelloStatus {
    supported: bool,
    enabled: bool,
    method: &'static str,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn wrap_key(signature: &[u8]) -> Zeroizing<[u8; 32]> {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(AAD);
    h.update(signature);
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&h.finalize());
    out
}

#[cfg(windows)]
mod win {
    use windows::core::{w, HSTRING};
    use windows::Security::Credentials::{KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus};
    use windows::Security::Cryptography::CryptographicBuffer;

    use crate::error::{AppError, Result};

    const NAME: &str = "Kestral vault";

    fn init() {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED);
        }
    }

    fn err(e: windows::core::Error) -> AppError {
        AppError::Other(format!("Windows Hello failed: {}", e.message()))
    }

    fn check(s: KeyCredentialStatus) -> Result<()> {
        match s {
            KeyCredentialStatus::Success => Ok(()),
            KeyCredentialStatus::UserCanceled => Err(AppError::Other("Windows Hello was canceled.".into())),
            KeyCredentialStatus::UserPrefersPassword => Err(AppError::Other("Use your master password instead.".into())),
            KeyCredentialStatus::NotFound => Err(AppError::Other("The Windows Hello key for Kestral is missing. Unlock with your master password and set it up again.".into())),
            KeyCredentialStatus::SecurityDeviceLocked => Err(AppError::Other("The security device is locked for now. Try again later or use your master password.".into())),
            _ => Err(AppError::Other("Windows Hello did not finish. Try again or use your master password.".into())),
        }
    }

    fn raise_prompt() {
        std::thread::spawn(|| {
            use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if let Ok(hwnd) = unsafe { FindWindowW(w!("Credential Dialog Xaml Host"), None) } {
                    if !hwnd.is_invalid() {
                        unsafe {
                            let _ = SetForegroundWindow(hwnd);
                        }
                        return;
                    }
                }
            }
        });
    }

    pub fn supported() -> bool {
        init();
        KeyCredentialManager::IsSupportedAsync().and_then(|op| op.get()).unwrap_or(false)
    }

    pub fn sign(challenge: &[u8], create: bool) -> Result<Vec<u8>> {
        init();
        let name = HSTRING::from(NAME);
        raise_prompt();
        let credential = if create {
            let r = KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::ReplaceExisting)
                .map_err(err)?
                .get()
                .map_err(err)?;
            check(r.Status().map_err(err)?)?;
            r.Credential().map_err(err)?
        } else {
            let r = KeyCredentialManager::OpenAsync(&name).map_err(err)?.get().map_err(err)?;
            check(r.Status().map_err(err)?)?;
            r.Credential().map_err(err)?
        };
        let buffer = CryptographicBuffer::CreateFromByteArray(challenge).map_err(err)?;
        raise_prompt();
        let r = credential.RequestSignAsync(&buffer).map_err(err)?.get().map_err(err)?;
        check(r.Status().map_err(err)?)?;
        let signed = r.Result().map_err(err)?;
        let mut out = windows::core::Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(&signed, &mut out).map_err(err)?;
        Ok(out.to_vec())
    }

    pub fn delete() {
        init();
        if let Ok(op) = KeyCredentialManager::DeleteAsync(&HSTRING::from(NAME)) {
            let _ = op.get();
        }
    }
}

#[cfg(windows)]
fn supported() -> bool {
    win::supported()
}

#[cfg(not(windows))]
fn supported() -> bool {
    false
}

#[cfg(windows)]
fn sign(challenge: &[u8], create: bool) -> Result<Vec<u8>> {
    win::sign(challenge, create)
}

#[cfg(not(windows))]
fn sign(_challenge: &[u8], _create: bool) -> Result<Vec<u8>> {
    Err(AppError::Other("Quick unlock is not available on this system".into()))
}

#[tauri::command]
pub async fn hello_status(hello: State<'_, Hello>) -> Result<HelloStatus> {
    let enabled = hello.path.exists();
    let supported = blocking(|| Ok(supported())).await?;
    Ok(HelloStatus { supported, enabled: enabled && supported, method: if cfg!(windows) { "Windows Hello" } else { "Touch ID" } })
}

#[tauri::command]
pub async fn hello_enable(state: State<'_, AppState>, hello: State<'_, Hello>) -> Result<()> {
    let file_key = state.services.vault.file_key()?;
    let path = hello.path.clone();
    blocking(move || {
        let mut challenge = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut challenge);
        let signature = Zeroizing::new(sign(&challenge, true)?);
        let key = wrap_key(&signature);
        let mut nonce = [0u8; 24];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| AppError::Crypto)?;
        let wrapped = cipher
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: file_key.as_slice(), aad: AAD })
            .map_err(|_| AppError::Crypto)?;
        let file = HelloFile { version: 1, challenge: b64().encode(challenge), nonce: b64().encode(nonce), wrapped: b64().encode(wrapped) };
        crate::util::replace_file(&path, &serde_json::to_vec_pretty(&file)?)?;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn hello_disable(hello: State<'_, Hello>) -> Result<()> {
    let hello = Hello::new(hello.path.clone());
    blocking(move || {
        hello.forget();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn hello_unlock(state: State<'_, AppState>, hello: State<'_, Hello>) -> Result<()> {
    let path = hello.path.clone();
    let vault = state.services.vault.clone();
    let hosts = state.services.hosts.clone();
    let snippets = state.services.snippets.clone();
    let audit = state.services.audit.clone();
    blocking(move || {
        let raw = std::fs::read(&path).map_err(|_| AppError::Other("Windows Hello is not set up for this vault.".into()))?;
        let file: HelloFile = serde_json::from_slice(&raw)?;
        let challenge = b64().decode(&file.challenge).map_err(|_| AppError::Crypto)?;
        let nonce = b64().decode(&file.nonce).map_err(|_| AppError::Crypto)?;
        let wrapped = b64().decode(&file.wrapped).map_err(|_| AppError::Crypto)?;
        if nonce.len() != 24 {
            return Err(AppError::Crypto);
        }
        let signature = Zeroizing::new(sign(&challenge, false)?);
        let key = wrap_key(&signature);
        let cipher = XChaCha20Poly1305::new_from_slice(key.as_slice()).map_err(|_| AppError::Crypto)?;
        let stale = || {
            let _ = std::fs::remove_file(&path);
            AppError::Other("Windows Hello no longer matches this vault, for example after a master password change. Unlock with your master password and set it up again.".into())
        };
        let plain = Zeroizing::new(cipher.decrypt(XNonce::from_slice(&nonce), Payload { msg: &wrapped, aad: AAD }).map_err(|_| stale())?);
        if plain.len() != 32 {
            return Err(stale());
        }
        let mut file_key = Zeroizing::new([0u8; 32]);
        file_key.copy_from_slice(&plain);
        match vault.unlock_with_key(&file_key) {
            Err(AppError::VaultAuth) => return Err(stale()),
            other => other?,
        }
        if let Err(e) = hosts.load() {
            tracing::error!("Loading hosts after unlock failed: {e}");
        }
        if let Err(e) = snippets.load() {
            tracing::error!("Loading snippets after unlock failed: {e}");
        }
        audit.load();
        Ok(())
    })
    .await
}
