// Vault-backed SSH agent. When a host has agent forwarding enabled, the remote
// side opens an auth-agent channel and Kestral answers it here instead of
// forwarding to the operating system's agent. Only the two operations a remote
// client needs for public-key auth are served: list identities and sign.
// Everything else is refused. The private key material never leaves this
// process, and every signature is written to the audit log.

use std::sync::Arc;

use russh::keys::decode_secret_key;
use russh::keys::ssh_key::encoding::Encode;
use russh::keys::ssh_key::PrivateKey;
use signature::Signer;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::audit::AuditLog;
use crate::error::{AppError, Result};
use crate::model::Host;
use crate::vault::{SecretStore, Vault};

// ssh-agent protocol message numbers (see PROTOCOL.agent).
const SSH_AGENT_FAILURE: u8 = 5;
const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
const SSH_AGENT_SIGN_RESPONSE: u8 = 14;

// Refuse absurd frames before allocating for them.
const MAX_FRAME: usize = 256 * 1024;

struct ExposedKey {
    id: String,
    blob: Vec<u8>,
    key: PrivateKey,
}

pub struct AgentContext {
    keys: Vec<ExposedKey>,
    audit: Arc<AuditLog>,
    host_id: String,
    host_name: String,
}

impl AgentContext {
    /// Load the vault keys a host exposes to the agent. Returns None when the
    /// host has forwarding off, selects no keys, or none of them could be
    /// decoded, so callers can simply not serve an agent in that case.
    pub fn build(host: &Host, vault: &Arc<Vault>, audit: Arc<AuditLog>) -> Option<Arc<Self>> {
        if !host.forward_agent || host.agent_keys.is_empty() {
            return None;
        }
        let mut keys = Vec::new();
        for id in &host.agent_keys {
            match load_key(vault, id) {
                Ok(k) => keys.push(k),
                Err(e) => tracing::warn!("agent key '{id}' not exposed: {e}"),
            }
        }
        if keys.is_empty() {
            return None;
        }
        Some(Arc::new(Self {
            keys,
            audit,
            host_id: host.id.to_string(),
            host_name: host.name.clone(),
        }))
    }
}

fn load_key(vault: &Arc<Vault>, id: &str) -> Result<ExposedKey> {
    let bytes = vault.get_secret(id)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| AppError::Ssh("key is not valid UTF-8".into()))?;
    let key =
        decode_secret_key(text, None).map_err(|e| AppError::Ssh(format!("load key: {e}")))?;
    let blob = key
        .public_key()
        .to_bytes()
        .map_err(|e| AppError::Ssh(format!("encode public key: {e}")))?;
    Ok(ExposedKey {
        id: id.to_string(),
        blob,
        key,
    })
}

/// Run the agent protocol over one forwarded channel until it closes.
pub async fn serve<S>(mut stream: S, ctx: Arc<AgentContext>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let mut len_buf = [0u8; 4];
        if stream.read_exact(&mut len_buf).await.is_err() {
            break;
        }
        let len = u32::from_be_bytes(len_buf) as usize;
        if len == 0 || len > MAX_FRAME {
            break;
        }
        let mut msg = vec![0u8; len];
        if stream.read_exact(&mut msg).await.is_err() {
            break;
        }
        let reply = handle(&msg, &ctx);
        let mut framed = Vec::with_capacity(reply.len() + 4);
        framed.extend_from_slice(&(reply.len() as u32).to_be_bytes());
        framed.extend_from_slice(&reply);
        if stream.write_all(&framed).await.is_err() || stream.flush().await.is_err() {
            break;
        }
    }
}

fn handle(msg: &[u8], ctx: &AgentContext) -> Vec<u8> {
    match msg.split_first() {
        Some((&SSH_AGENTC_REQUEST_IDENTITIES, _)) => identities(ctx),
        Some((&SSH_AGENTC_SIGN_REQUEST, body)) => {
            sign(body, ctx).unwrap_or_else(|| vec![SSH_AGENT_FAILURE])
        }
        _ => vec![SSH_AGENT_FAILURE],
    }
}

fn identities(ctx: &AgentContext) -> Vec<u8> {
    let mut out = vec![SSH_AGENT_IDENTITIES_ANSWER];
    put_u32(&mut out, ctx.keys.len() as u32);
    for k in &ctx.keys {
        put_string(&mut out, &k.blob);
        put_string(&mut out, k.id.as_bytes());
    }
    out
}

fn sign(body: &[u8], ctx: &AgentContext) -> Option<Vec<u8>> {
    let mut rest = body;
    let key_blob = take_string(&mut rest)?;
    let data = take_string(&mut rest)?;
    let flags = if rest.len() >= 4 { u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) } else { 0 };
    let key = ctx.keys.iter().find(|k| k.blob == key_blob)?;
    let signed = match key.key.key_data().rsa() {
        Some(rsa) => {
            let hash = if flags & SSH_AGENT_RSA_SHA2_512 != 0 {
                Some(russh::keys::ssh_key::HashAlg::Sha512)
            } else if flags & SSH_AGENT_RSA_SHA2_256 != 0 {
                Some(russh::keys::ssh_key::HashAlg::Sha256)
            } else {
                None
            };
            (rsa, hash).try_sign(data)
        }
        None => key.key.try_sign(data),
    };
    match signed {
        Ok(sig) => {
            let wire = sig.encode_vec().ok()?;
            ctx.audit.record(
                ctx.host_id.clone(),
                ctx.host_name.clone(),
                format!("agent sign with key '{}'", key.id),
                "agent",
                None,
                true,
                None,
            );
            let mut out = vec![SSH_AGENT_SIGN_RESPONSE];
            put_string(&mut out, &wire);
            Some(out)
        }
        Err(e) => {
            ctx.audit.record(
                ctx.host_id.clone(),
                ctx.host_name.clone(),
                format!("agent sign with key '{}'", key.id),
                "agent",
                None,
                false,
                Some(e.to_string()),
            );
            None
        }
    }
}

const SSH_AGENT_RSA_SHA2_256: u32 = 2;
const SSH_AGENT_RSA_SHA2_512: u32 = 4;

fn take_string<'a>(buf: &mut &'a [u8]) -> Option<&'a [u8]> {
    if buf.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let rest = &buf[4..];
    if rest.len() < len {
        return None;
    }
    let (s, tail) = rest.split_at(len);
    *buf = tail;
    Some(s)
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn put_string(out: &mut Vec<u8>, s: &[u8]) {
    put_u32(out, s.len() as u32);
    out.extend_from_slice(s);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AuthMethod;
    use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
    use russh::keys::ssh_key::LineEnding;
    use uuid::Uuid;

    fn framed(kind: u8, body: &[u8]) -> Vec<u8> {
        let mut m = vec![kind];
        m.extend_from_slice(body);
        m
    }

    fn make_key() -> String {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        PrivateKey::new(KeypairData::Ed25519(Ed25519Keypair::from_seed(&seed)), "test")
            .unwrap()
            .to_openssh(LineEnding::LF)
            .unwrap()
            .to_string()
    }

    // The agent runs a wire protocol we cannot exercise against a real host from
    // here, so this pins the two messages a client needs and proves the produced
    // signature is exactly what the key would sign.
    #[test]
    fn answers_identities_and_signs_with_the_right_wire_format() {
        let dir = std::env::temp_dir().join(format!("kestral_agent_{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Arc::new(Vault::new(dir.join("vault.json")));
        vault.create("pw").unwrap();
        let pem = make_key();
        vault
            .put_secret("k", crate::vault::SecretKind::PrivateKey, pem.as_bytes())
            .unwrap();
        let audit = Arc::new(AuditLog::new(dir.join("audit.log"), vault.clone()));

        let host = Host {
            id: Uuid::new_v4(),
            name: "h".into(),
            hostname: "h".into(),
            port: 22,
            username: "root".into(),
            auth: AuthMethod::Agent,
            ai_policy: Default::default(),
            ai_file_policy: Default::default(),
            forward_agent: true,
            agent_keys: vec!["k".into()],
            forwards: vec![],
            group: String::new(),
            tags: vec![],
            jump_host_id: None,
            options: Default::default(),
            ai_changed: false,
        };
        let ctx = AgentContext::build(&host, &vault, audit).expect("agent context");

        let key = decode_secret_key(&pem, None).unwrap();
        let blob = key.public_key().to_bytes().unwrap();

        // REQUEST_IDENTITIES lists the one exposed key.
        let answer = handle(&framed(SSH_AGENTC_REQUEST_IDENTITIES, &[]), &ctx);
        assert_eq!(answer[0], SSH_AGENT_IDENTITIES_ANSWER);
        let mut r = &answer[1..];
        assert_eq!(u32::from_be_bytes([r[0], r[1], r[2], r[3]]), 1);
        r = &r[4..];
        assert_eq!(take_string(&mut r).unwrap(), &blob[..]);
        assert_eq!(take_string(&mut r).unwrap(), b"k");

        // SIGN_REQUEST returns a valid, deterministic ed25519 signature.
        let data = b"session-id and userauth request";
        let mut body = Vec::new();
        put_string(&mut body, &blob);
        put_string(&mut body, data);
        put_u32(&mut body, 0);
        let resp = handle(&framed(SSH_AGENTC_SIGN_REQUEST, &body), &ctx);
        assert_eq!(resp[0], SSH_AGENT_SIGN_RESPONSE);
        let mut rr = &resp[1..];
        let sig_wire = take_string(&mut rr).unwrap();
        let expected = key.try_sign(data.as_slice()).unwrap().encode_vec().unwrap();
        assert_eq!(sig_wire, &expected[..], "signature wire format");

        // Unknown requests and unknown keys are refused.
        assert_eq!(handle(&framed(99, &[]), &ctx), vec![SSH_AGENT_FAILURE]);
        let mut bad = Vec::new();
        put_string(&mut bad, b"unknown-blob");
        put_string(&mut bad, data);
        put_u32(&mut bad, 0);
        assert_eq!(
            handle(&framed(SSH_AGENTC_SIGN_REQUEST, &bad), &ctx),
            vec![SSH_AGENT_FAILURE]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
