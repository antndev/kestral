import { CSSProperties, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../api";
import type { AuthMethod, Host, SecretKind, SecretMeta, SshConfigHost } from "../../api";
import { MONO, errText } from "../mock";
import { FileIcon, HostsIcon, KeyIcon, LockIcon } from "../icons";
import { DialogActions, Modal, btnPrimary, btnSecondary, inputStyle, useAlive, withDisabled } from "./SettingsScreen";
import { NEW_HOST_EXTRAS, linkProxyJumps } from "../hostImport";
import { Stable } from "../Stable";
import { parseTarget, type QuickConnect, type Target } from "../target";

const SSH_DIR_LABEL = "~/.ssh";
const SSH_CONFIG_LABEL = "~/.ssh/config";
const KEY_FILE_LIMIT = 64 * 1024;
const NOT_KEY_FILES = /^(config|known_hosts(\..*)?|authorized_keys2?|environment|rc)$/i;

const card: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, padding: 16, border: "1px solid var(--line)", borderRadius: 10 };
const cardTitle: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };
const cardText: CSSProperties = { margin: 0, height: 36, fontSize: 12.5, lineHeight: "18px", color: "var(--text-2)", overflow: "hidden", overflowWrap: "anywhere", display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 };
const cardFoot: CSSProperties = { display: "flex", height: 28, marginTop: "auto" };
const cardBtn: CSSProperties = { height: 28, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", boxSizing: "border-box" };
const code: CSSProperties = { fontFamily: MONO, fontSize: 12 };
const oneLine: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const errLine: CSSProperties = { ...oneLine, flex: 1, minWidth: 0, margin: 0, fontSize: 12, color: "var(--err)" };
const listBox: CSSProperties = { display: "flex", flexDirection: "column", maxHeight: 340, overflow: "auto", border: "1px solid var(--line)", borderRadius: 8 };
const linkBtn: CSSProperties = { padding: 0, border: 0, background: "transparent", color: "var(--link)", textDecoration: "underline", textUnderlineOffset: 2, fontSize: 12, cursor: "pointer" };

const TerminalGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="m5 7 2 1.5L5 10M8.5 10.5H11" />
  </svg>
);

function isMissing(e: unknown) {
  return /not found|no such file|cannot find|os error [23]\b/i.test(errText(e));
}

function joinPath(base: string, ...parts: string[]) {
  const sep = base.includes("\\") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

function expandHome(path: string, home: string) {
  const sep = home.includes("\\") ? "\\" : "/";
  let p = path.trim().replace(/^"(.*)"$/, "$1");
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = home + p.slice(1);
  p = p.replace(/^%USERPROFILE%/i, home).replace(/^\$HOME\b/, home);
  return sep === "\\" ? p.replace(/\//g, "\\") : p;
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function keyTypeLabel(publicKey: string) {
  const t = publicKey.split(" ")[0] ?? "";
  if (t.includes("ed25519")) return "ED25519";
  if (t.includes("ecdsa")) return "ECDSA";
  if (t.includes("rsa")) return "RSA";
  if (t.includes("dss")) return "DSA";
  return t.toUpperCase();
}

/** True for passphrase protected keys, which the backend can't load. */
function isEncrypted(pem: string) {
  if (/ENCRYPTED/.test(pem)) return true;
  const m = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END/);
  if (!m) return false;
  try {
    const bin = atob(m[1].replace(/\s+/g, ""));
    const magic = "openssh-key-v1\0";
    if (!bin.startsWith(magic)) return false;
    const o = magic.length;
    const len = (bin.charCodeAt(o) << 24) | (bin.charCodeAt(o + 1) << 16) | (bin.charCodeAt(o + 2) << 8) | bin.charCodeAt(o + 3);
    return bin.slice(o + 4, o + 4 + len) !== "none";
  } catch {
    return false;
  }
}

function looksLikePrivateKey(text: string) {
  const head = text.trimStart();
  return head.startsWith("-----BEGIN") && head.split("\n", 1)[0].includes("PRIVATE KEY");
}

/** Free secret id: the file name, or the file name with a number when that id is taken by something else. */
function freeSecretId(base: string, taken: Map<string, SecretKind>) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

type FoundKey = { name: string; path: string; keyType: string; fingerprint: string; locked?: boolean; problem?: string };
const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];
const SSH_DIR_KEY = "\tsshdir";
type Scan<T> = { kind: "loading" } | { kind: "ready"; items: T[] } | { kind: "missing" } | { kind: "error"; message: string };

/** The backend returns an empty list when the file is missing, so an empty result checks whether the file exists. */
async function scanConfig(): Promise<Scan<SshConfigHost>> {
  const list = await api.sshConfigHosts();
  const items = list.filter((h) => h.alias.trim() && !/[*?!]/.test(h.alias));
  if (list.length > 0) return { kind: "ready", items };
  try {
    const entries = await api.localList(joinPath(await api.localHome(), ".ssh"));
    return entries.some((e) => !e.is_dir && e.name.toLowerCase() === "config") ? { kind: "ready", items } : { kind: "missing" };
  } catch (e) {
    return isMissing(e) ? { kind: "missing" } : { kind: "ready", items };
  }
}

async function scanKeys(): Promise<FoundKey[]> {
  const dir = joinPath(await api.localHome(), ".ssh");
  const entries = await api.localList(dir);
  const found: FoundKey[] = [];
  for (const e of entries) {
    if (e.is_dir || e.size === 0 || e.size > KEY_FILE_LIMIT) continue;
    if (e.name.toLowerCase().endsWith(".pub") || NOT_KEY_FILES.test(e.name)) continue;
    let text: string;
    try {
      text = await api.localReadText(e.path);
    } catch {
      continue;
    }
    if (!looksLikePrivateKey(text)) continue;
    try {
      const info = await api.derivePubkey(text);
      found.push({ name: e.name, path: e.path, keyType: keyTypeLabel(info.public_key), fingerprint: info.fingerprint, locked: info.encrypted });
    } catch (err) {
      if (api.isPassphraseError(err) || isEncrypted(text)) found.push({ name: e.name, path: e.path, keyType: "", fingerprint: "", locked: true });
      else found.push({ name: e.name, path: e.path, keyType: "", fingerprint: "", problem: "This key format isn't supported" });
    }
  }
  return found;
}

function Check({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return <input type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ margin: "2px 0 0", flex: "none", cursor: disabled ? "default" : "pointer" }} />;
}

function PickRow({ children, disabled, last }: { children: ReactNode; disabled?: boolean; last: boolean }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px", borderBottom: last ? 0 : "1px solid var(--line-soft)", opacity: disabled ? 0.6 : 1, cursor: disabled ? "default" : "pointer" }}>
      {children}
    </label>
  );
}

function SelectAll({ total, selected, onAll, onNone }: { total: number; selected: number; onAll: () => void; onNone: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "var(--text-2)" }}>
      <span>{selected} of {total} selected</span>
      <span style={{ display: "flex", gap: 12 }}>
        <button type="button" onClick={onAll} style={linkBtn}>Select all</button>
        <button type="button" onClick={onNone} style={linkBtn}>Select none</button>
      </span>
    </div>
  );
}

type RowResult = { ok: boolean; message: string };

/**
 * onProgress runs after each import so the screen can reload its vault data.
 * onClose(added) runs when the dialog closes, by the user or after a clean run, with the total added;
 * the parent refreshes the app only then, so per row results stay visible until the dialog closes.
 */
function ConfigImportDialog({ entries, existingNames, secrets, onProgress, onClose }: { entries: SshConfigHost[]; existingNames: Set<string>; secrets: SecretMeta[]; onProgress: () => void; onClose: (added: number) => void }) {
  const alive = useAlive();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const addedRef = useRef(0);
  const taken = (h: SshConfigHost) => existingNames.has(h.alias.trim().toLowerCase());
  const [sel, setSel] = useState<Set<string>>(() => new Set(entries.filter((h) => !taken(h)).map((h) => h.alias)));
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const selectable = entries.filter((h) => !taken(h) && !results[h.alias]?.ok);
  const count = selectable.filter((h) => sel.has(h.alias)).length;

  const toggle = (alias: string, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(alias);
      else n.delete(alias);
      return n;
    });

  async function run() {
    const todo = selectable.filter((h) => sel.has(h.alias));
    if (!todo.length) return;
    setBusy(true);
    setErr("");
    let home: string;
    try {
      home = await api.localHome();
    } catch (e) {
      if (alive.current) {
        setErr(errText(e));
        setBusy(false);
      }
      return;
    }
    const known = new Map<string, SecretKind>(secrets.map((s) => [s.id, s.kind]));
    // One vault secret per key file for the whole run, however many hosts name it (null = couldn't import).
    const byPath = new Map<string, string | null>();
    const lockedPaths = new Set<string>();
    const created: { host: Host; config: SshConfigHost }[] = [];
    const out: Record<string, RowResult> = {};
    let added = 0;
    for (const h of todo) {
      let auth: AuthMethod = { kind: "agent" };
      let keyNote = "";
      if (h.identity_file) {
        const path = expandHome(h.identity_file, home);
        const pathKey = path.includes("\\") ? path.toLowerCase() : path;
        const id = baseName(path);
        if (!byPath.has(pathKey)) {
          try {
            const text = await api.localReadText(path);
            const info = await api.derivePubkey(text);
            const same = known.get(id) === "private_key" && (await api.derivePubkey(await api.secretReveal(id)).then((v) => v.fingerprint === info.fingerprint, () => false));
            if (same) byPath.set(pathKey, id);
            else {
              const sid = freeSecretId(id, known);
              await api.secretPut(sid, "private_key", text);
              known.set(sid, "private_key");
              byPath.set(pathKey, sid);
            }
          } catch (err) {
            if (api.isPassphraseError(err)) lockedPaths.add(pathKey);
            byPath.set(pathKey, null);
          }
        }
        const sid = byPath.get(pathKey);
        if (sid) auth = { kind: "key", secret_id: sid };
        else if (lockedPaths.has(pathKey)) keyNote = `Key ${id} has a passphrase, so this host signs in with your SSH agent. Import the key under Import keys to use it directly.`;
        else keyNote = `Key ${id} couldn't be imported, uses the SSH agent instead.`;
      }
      try {
        const host = await api.hostAdd({
          name: h.alias.trim(),
          hostname: h.hostname || h.alias,
          port: h.port || 22,
          username: h.user,
          auth,
          ai_policy: "locked",
          ai_file_policy: "locked",
          forward_agent: false,
          agent_keys: [],
          forwards: [],
          group: "",
          tags: [],
          ...NEW_HOST_EXTRAS,
        });
        created.push({ host, config: h });
        added++;
        out[h.alias] = { ok: true, message: keyNote || "Added" };
      } catch (e) {
        out[h.alias] = { ok: false, message: errText(e) };
      }
    }
    for (const problem of await linkProxyJumps(created).catch((e) => [errText(e)])) {
      const alias = created.find((c) => problem.startsWith(`${c.host.name}:`))?.config.alias;
      if (alias && out[alias]) {
        const extra = problem.slice(problem.indexOf(":") + 2);
        out[alias] = { ...out[alias], message: out[alias].message === "Added" ? `Added. ${extra}` : `${out[alias].message} ${extra}` };
      }
    }
    addedRef.current += added;
    if (!alive.current) {
      if (addedRef.current) onClose(addedRef.current);
      return;
    }
    setResults((r) => ({ ...r, ...out }));
    setBusy(false);
    onProgress();
    if (Object.values(out).every((r) => r.ok && r.message === "Added")) onClose(addedRef.current);
  }

  return (
    <Modal title="Import SSH config" width={560} description={<>Hosts found in <code style={code}>{SSH_CONFIG_LABEL}</code>. Keys named in IdentityFile are copied into your vault; hosts without one use the SSH agent.</>} busy={busy} initialFocus={primaryRef} onClose={() => onClose(addedRef.current)}>
      <SelectAll total={selectable.length} selected={count} onAll={() => setSel(new Set(selectable.map((h) => h.alias)))} onNone={() => setSel(new Set())} />
      <div style={listBox}>
        {entries.map((h, i) => {
          const res = results[h.alias];
          const already = taken(h) && !res;
          const disabled = already || !!res?.ok || busy;
          return (
            <PickRow key={h.alias + i} disabled={already || !!res?.ok} last={i === entries.length - 1}>
              <Check label={`Import ${h.alias}`} checked={!already && !res?.ok && sel.has(h.alias)} disabled={disabled} onChange={(v) => toggle(h.alias, v)} />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.alias}</span>
                  {already && <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-3)", whiteSpace: "nowrap" }}>Already added</span>}
                </span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.user ? `${h.user}@` : ""}{h.hostname || h.alias}:{h.port || 22}
                </span>
                {!h.user && <span style={{ fontSize: 12, color: "var(--warn)" }}>No user set. Add one in the host editor after importing.</span>}
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, fontSize: 12, color: "var(--text-2)" }}>
                  <span style={{ display: "flex", flex: "none", color: "var(--text-3)" }}><KeyIcon size={12} /></span>
                  {h.identity_file ? <span style={{ fontFamily: MONO, fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.identity_file}</span> : <span>SSH agent</span>}
                </span>
                {res && <span style={{ fontSize: 12, color: res.ok ? (res.message === "Added" ? "var(--ok)" : "var(--warn)") : "var(--err)" }}>{res.ok && res.message !== "Added" ? `Added. ${res.message}` : res.message}</span>}
              </span>
            </PickRow>
          );
        })}
      </div>
      <ErrorActions
        err={err}
        primary={
          <button ref={primaryRef} type="button" disabled={!count || busy} onClick={() => void run()} style={withDisabled(btnPrimary, !count || busy)}>
            <Stable text={busy ? "Importing…" : `Import ${count === 1 ? "1 host" : `${count} hosts`}`} alts={[`Import ${count === 1 ? "1 host" : `${count} hosts`}`, "Importing…"]} />
          </button>
        }
        cancel={<button type="button" disabled={busy} onClick={() => onClose(addedRef.current)} style={withDisabled(btnSecondary, busy)}>{Object.keys(results).length ? "Close" : "Cancel"}</button>}
      />
    </Modal>
  );
}

function ErrorActions({ err, primary, cancel }: { err: string; primary: ReactNode; cancel: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <p role="alert" title={err || undefined} style={errLine}>{err}</p>
      <DialogActions primary={primary} cancel={cancel} />
    </div>
  );
}

/** Same close contract as ConfigImportDialog. */
function KeyImportDialog({ keys, secrets, onProgress, onClose }: { keys: FoundKey[]; secrets: SecretMeta[]; onProgress: () => void; onClose: (added: number) => void }) {
  const alive = useAlive();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const addedRef = useRef(0);
  const inVault = new Map(secrets.map((s) => [s.id, s.kind]));
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const blocked = (k: FoundKey) => !!k.problem || inVault.has(k.name) || !!results[k.name]?.ok;
  const selectable = keys.filter((k) => !blocked(k));
  const [sel, setSel] = useState<Set<string>>(() => new Set(selectable.filter((k) => !k.locked).map((k) => k.name)));
  const [passes, setPasses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const count = selectable.filter((k) => sel.has(k.name)).length;

  async function run() {
    const todo = selectable.filter((k) => sel.has(k.name));
    if (!todo.length) return;
    setBusy(true);
    const out: Record<string, RowResult> = {};
    let added = 0;
    for (const k of todo) {
      try {
        let text = await api.localReadText(k.path);
        if (k.locked) {
          const pass = passes[k.name] ?? "";
          if (!pass) throw new Error("Enter the passphrase of this key.");
          text = await api.decryptKey(text, pass);
        }
        await api.secretPut(k.name, "private_key", text);
        added++;
        out[k.name] = { ok: true, message: "Added" };
      } catch (e) {
        out[k.name] = { ok: false, message: errText(e) };
      }
    }
    addedRef.current += added;
    if (!alive.current) {
      if (addedRef.current) onClose(addedRef.current);
      return;
    }
    setResults((r) => ({ ...r, ...out }));
    setBusy(false);
    onProgress();
    if (Object.values(out).every((r) => r.ok)) onClose(addedRef.current);
  }

  return (
    <Modal title="Import keys" width={560} description={<>Private keys found in <code style={code}>{SSH_DIR_LABEL}</code>. They are copied into your encrypted vault; the files stay where they are.</>} busy={busy} initialFocus={primaryRef} onClose={() => onClose(addedRef.current)}>
      <SelectAll total={selectable.length} selected={count} onAll={() => setSel(new Set(selectable.map((k) => k.name)))} onNone={() => setSel(new Set())} />
      <div style={listBox}>
        {keys.map((k, i) => {
          const res = results[k.name];
          const clash = res ? undefined : inVault.get(k.name);
          const off = blocked(k);
          return (
            <PickRow key={k.path} disabled={off} last={i === keys.length - 1}>
              <Check label={`Import ${k.name}`} checked={!off && sel.has(k.name)} disabled={off || busy} onChange={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(k.name); else n.delete(k.name); return n; })} />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.name}</span>
                  {k.keyType && <span style={{ fontSize: 12, color: "var(--text-2)" }}>{k.keyType}</span>}
                  {clash && <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-3)", whiteSpace: "nowrap" }}>{clash === "private_key" ? "Already in vault" : "Name used by a password"}</span>}
                </span>
                {k.fingerprint && <span style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.fingerprint}</span>}
                {k.problem && <span style={{ fontSize: 12, color: "var(--warn)" }}>{k.problem}</span>}
                {k.locked && !off && (
                  <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 12, color: "var(--text-2)" }}>Protected by a passphrase. Enter it once, the key is kept unlocked in your encrypted vault.</span>
                    <input
                      type="password"
                      aria-label={`Passphrase for ${k.name}`}
                      placeholder="Passphrase"
                      value={passes[k.name] ?? ""}
                      disabled={busy}
                      onClick={(e) => e.preventDefault()}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPasses((m) => ({ ...m, [k.name]: v }));
                        setSel((cur) => {
                          const n = new Set(cur);
                          if (v) n.add(k.name);
                          return n;
                        });
                      }}
                      style={{ width: 240, maxWidth: "100%", height: 28, padding: "0 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", boxSizing: "border-box" }}
                    />
                  </span>
                )}
                {res && <span style={{ fontSize: 12, color: res.ok ? "var(--ok)" : "var(--err)" }}>{res.message}</span>}
              </span>
            </PickRow>
          );
        })}
      </div>
      <DialogActions
        primary={
          <button ref={primaryRef} type="button" disabled={!count || busy} onClick={() => void run()} style={withDisabled(btnPrimary, !count || busy)}>
            <Stable text={busy ? "Importing…" : `Import ${count === 1 ? "1 key" : `${count} keys`}`} alts={[`Import ${count === 1 ? "1 key" : `${count} keys`}`, "Importing…"]} />
          </button>
        }
        cancel={<button type="button" disabled={busy} onClick={() => onClose(addedRef.current)} style={withDisabled(btnSecondary, busy)}>{Object.keys(results).length ? "Close" : "Cancel"}</button>}
      />
    </Modal>
  );
}

function DirKeyDialog({ found, onImport, onClose }: { found: FoundKey; onImport: (passphrase: string) => Promise<void>; onClose: () => void }) {
  const alive = useAlive();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await onImport(pass);
    } catch (x) {
      if (alive.current) {
        setErr(errText(x));
        setBusy(false);
      }
    }
  }

  return (
    <Modal
      title="Import key"
      width={460}
      description={
        <>
          Kestral signs in with keys from its encrypted vault. This copies <code style={code}>{found.name}</code> from <code style={code}>{SSH_DIR_LABEL}</code> into the vault; the file stays where it is.
          {found.locked && " Enter its passphrase once, the vault keeps the key unlocked."}
        </>
      }
      busy={busy}
      initialFocus={found.locked ? passRef : primaryRef}
      onClose={onClose}
    >
      <form onSubmit={run} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {found.locked && (
          <input
            ref={passRef}
            type="password"
            aria-label={`Passphrase for ${found.name}`}
            placeholder="Passphrase"
            value={pass}
            disabled={busy}
            onChange={(e) => {
              setPass(e.target.value);
              setErr("");
            }}
            style={inputStyle}
          />
        )}
        <ErrorActions
          err={err}
          primary={
            <button ref={primaryRef} type="submit" disabled={busy} style={withDisabled(btnPrimary, busy)}>
              <Stable text={busy ? "Importing…" : "Import and connect"} alts={["Import and connect", "Importing…"]} />
            </button>
          }
          cancel={<button type="button" disabled={busy} onClick={onClose} style={withDisabled(btnSecondary, busy)}>Cancel</button>}
        />
      </form>
    </Modal>
  );
}

export function WelcomeScreen({ onQuickConnect, onNewHost, onImported }: { onQuickConnect(q: QuickConnect): void; onNewHost(): void; onImported(): void }) {
  const alive = useAlive();
  const [target, setTarget] = useState("");
  const [identity, setIdentity] = useState("password");
  const [formErr, setFormErr] = useState("");
  const [checking, setChecking] = useState(false);
  const [keyAsk, setKeyAsk] = useState<{ target: Target; key: FoundKey } | null>(null);

  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [hostNames, setHostNames] = useState<Set<string>>(new Set());
  const [cfg, setCfg] = useState<Scan<SshConfigHost>>({ kind: "loading" });
  const [keys, setKeys] = useState<Scan<FoundKey>>({ kind: "loading" });
  const [dialog, setDialog] = useState<null | "config" | "keys">(null);
  const [cfgNote, setCfgNote] = useState("");
  const [keysNote, setKeysNote] = useState("");
  const [hello, setHello] = useState<api.HelloStatus | null>(null);
  const [helloOffer, setHelloOffer] = useState(false);
  const [helloBusy, setHelloBusy] = useState(false);
  const [helloErr, setHelloErr] = useState("");
  useEffect(() => {
    let live = true;
    api
      .helloStatus()
      .then((s) => {
        if (!live) return;
        setHello(s);
        setHelloOffer(s.supported && !s.enabled);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  async function toggleHello() {
    if (!hello || helloBusy) return;
    setHelloBusy(true);
    setHelloErr("");
    try {
      if (hello.enabled) await api.helloDisable();
      else await api.helloEnable();
      const s = await api.helloStatus();
      if (alive.current) setHello(s);
    } catch (e) {
      if (alive.current) setHelloErr(errText(e));
    } finally {
      if (alive.current) setHelloBusy(false);
    }
  }

  const loadVault = useCallback(async () => {
    const [s, h] = await Promise.allSettled([api.secretList(), api.hostList()]);
    if (!alive.current) return;
    if (s.status === "fulfilled") setSecrets(s.value);
    if (h.status === "fulfilled") setHostNames(new Set(h.value.map((x) => x.name.trim().toLowerCase())));
  }, [alive]);

  useEffect(() => {
    void loadVault();
    scanConfig()
      .then((r) => alive.current && setCfg(r))
      .catch((e) => alive.current && setCfg(isMissing(e) ? { kind: "missing" } : { kind: "error", message: errText(e) }));
    scanKeys()
      .then((list) => alive.current && setKeys({ kind: "ready", items: list }))
      .catch((e) => alive.current && setKeys(isMissing(e) ? { kind: "missing" } : { kind: "error", message: errText(e) }));
  }, [alive, loadVault]);

  const keySecrets = useMemo(() => secrets.filter((s) => s.kind === "private_key").sort((a, b) => a.id.localeCompare(b.id)), [secrets]);
  const [identities, setIdentities] = useState<api.Identity[]>([]);
  useEffect(() => {
    let live = true;
    api.identityList().then((l) => live && setIdentities(l), () => undefined);
    return () => {
      live = false;
    };
  }, [secrets]);
  const dirKey = useMemo(() => {
    if (keys.kind !== "ready") return null;
    for (const name of DEFAULT_KEYS) {
      const k = keys.items.find((x) => x.name === name && !x.problem);
      if (k) return k;
    }
    return keys.items.find((x) => !x.problem) ?? null;
  }, [keys]);
  const sshDirKey = dirKey && !secrets.some((s) => s.id === dirKey.name) ? dirKey : null;
  useEffect(() => {
    if (identity === SSH_DIR_KEY) {
      if (!sshDirKey && keys.kind !== "loading") setIdentity(dirKey && keySecrets.some((s) => s.id === dirKey.name) ? dirKey.name : "password");
      return;
    }
    if (identity === "password" || identity === "agent") return;
    const ok = identity.startsWith("identity:") ? identities.some((i) => `identity:${i.id}` === identity) : keySecrets.some((s) => s.id === identity);
    if (!ok) setIdentity("password");
  }, [identity, keySecrets, identities, dirKey, sshDirKey, keys.kind]);

  async function vaultTwin(fingerprint: string): Promise<string | null> {
    if (!fingerprint) return null;
    for (const s of secrets.filter((x) => x.kind === "private_key")) {
      const same = await api
        .secretReveal(s.id)
        .then((pem) => api.derivePubkey(pem))
        .then((v) => v.fingerprint === fingerprint, () => false);
      if (same) return s.id;
    }
    return null;
  }

  async function importDirKey(k: FoundKey, passphrase: string): Promise<string> {
    let text = await api.localReadText(k.path);
    if (k.locked) {
      if (!passphrase) throw new Error(`Enter the passphrase of ${k.name}.`);
      text = await api.decryptKey(text, passphrase);
    }
    const twin = await vaultTwin((await api.derivePubkey(text)).fingerprint);
    if (twin) return twin;
    const id = freeSecretId(k.name, new Map(secrets.map((s) => [s.id, s.kind])));
    await api.secretPut(id, "private_key", text);
    await loadVault();
    return id;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (checking) return;
    const r = parseTarget(target);
    if (!r.ok) {
      setFormErr(r.error);
      return;
    }
    setFormErr("");
    if (identity !== SSH_DIR_KEY) {
      onQuickConnect({ ...r.value, identity });
      return;
    }
    if (!sshDirKey) return;
    setChecking(true);
    const twin = await vaultTwin(sshDirKey.fingerprint);
    if (!alive.current) return;
    setChecking(false);
    if (!twin) {
      setKeyAsk({ target: r.value, key: sshDirKey });
      return;
    }
    setIdentity(twin);
    onQuickConnect({ ...r.value, identity: twin });
  }

  const cfgCount = cfg.kind === "ready" ? cfg.items.length : 0;
  const keyCount = keys.kind === "ready" ? keys.items.filter((k) => !k.problem && !secrets.some((x) => x.id === k.name)).length : 0;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const path = (p: string) => <code style={code}>{p}</code>;
  const cfgText: ReactNode =
    cfgNote ? cfgNote
    : cfg.kind === "loading" ? <>Looking for {path(SSH_CONFIG_LABEL)}…</>
    : cfg.kind === "missing" ? <>No {path(SSH_CONFIG_LABEL)} found</>
    : cfg.kind === "error" ? <>Couldn't read {path(SSH_CONFIG_LABEL)}</>
    : cfgCount === 0 ? <>No hosts in {path(SSH_CONFIG_LABEL)}</>
    : <>Found {plural(cfgCount, "host")} in {path(SSH_CONFIG_LABEL)}</>;
  const keysText: ReactNode =
    keysNote ? keysNote
    : keys.kind === "loading" ? <>Looking in {path(SSH_DIR_LABEL)}…</>
    : keys.kind === "error" ? <>Couldn't read {path(SSH_DIR_LABEL)}</>
    : keyCount > 0 ? <>Found {plural(keyCount, "key")} in {path(SSH_DIR_LABEL)}</>
    : keys.kind === "ready" && keys.items.some((k) => !k.problem) ? <>Your keys from {path(SSH_DIR_LABEL)} are in the vault</>
    : keys.kind === "ready" && keys.items.length > 0 ? <>No supported keys in {path(SSH_DIR_LABEL)}</>
    : <>No keys in {path(SSH_DIR_LABEL)}</>;
  const helloText = !hello ? "" : helloErr || (hello.enabled ? `${hello.method} is set up. Use it the next time you unlock.` : `Unlock with ${hello.method} instead of typing your master password.`);

  return (
    <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", overflow: "auto" }}>
      <div style={{ width: "100%", maxWidth: 780, display: "flex", flexDirection: "column", gap: 22, padding: "52px 28px 32px", boxSizing: "border-box" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
          <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 48, height: 48, borderRadius: 12, background: "var(--bg-raised)", color: "var(--text)" }}><TerminalGlyph /></span>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>Welcome to Kestral</h1>
          <p style={{ margin: 0, fontSize: 14, color: "var(--text-2)" }}>Connect to a server right away, or bring in the hosts and keys you already have.</p>
        </div>

        <form noValidate onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: 16, border: "1px solid var(--line)", borderRadius: 10, background: "var(--bg-sunken)" }}>
          <div style={{ flex: "1 1 100%", minWidth: 0, display: "flex", alignItems: "baseline", gap: 12 }}>
            <label htmlFor="wl-connect" style={{ flex: "none", fontWeight: 600 }}>Connect to a server</label>
            <p id="wl-connect-err" role="alert" title={formErr || undefined} style={errLine}>{formErr}</p>
          </div>
          <input
            id="wl-connect"
            type="text"
            placeholder="user@host:port"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={target}
            aria-invalid={!!formErr}
            aria-describedby={formErr ? "wl-connect-err" : undefined}
            onChange={(e) => { setTarget(e.target.value); setFormErr(""); }}
            style={{ flex: "1 1 260px", minWidth: 0, height: 34, padding: "0 10px", border: `1px solid ${formErr ? "var(--err)" : "var(--line)"}`, borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontFamily: MONO, fontSize: 12.5, boxSizing: "border-box" }}
          />
          <label htmlFor="wl-auth" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>Sign in with</label>
          <select id="wl-auth" value={identity} onChange={(e) => { setIdentity(e.target.value); setFormErr(""); }} style={{ flex: "none", width: 220, height: 34, padding: "0 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)" }}>
            <option value="password">Password</option>
            {sshDirKey && <option value={SSH_DIR_KEY}>Key from {SSH_DIR_LABEL} ({sshDirKey.name})</option>}
            <option value="agent">SSH agent</option>
            {keySecrets.length > 0 && (
              <optgroup label="Keys in your vault">
                {keySecrets.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
              </optgroup>
            )}
            {identities.length > 0 && (
              <optgroup label="Identities">
                {identities.map((i) => <option key={i.id} value={`identity:${i.id}`}>{i.name}</option>)}
              </optgroup>
            )}
          </select>
          <button type="submit" disabled={checking} style={{ height: 34, padding: "0 16px", border: "1px solid var(--btn-line)", borderRadius: 6, background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500, cursor: checking ? "default" : "pointer", opacity: checking ? 0.6 : 1 }}>Connect</button>
        </form>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <article style={card}>
            <span style={{ color: "var(--text-2)", display: "flex" }}><FileIcon size={18} /></span>
            <h2 style={cardTitle}>Import SSH config</h2>
            <p title={cfg.kind === "error" ? cfg.message : undefined} style={cfgNote ? { ...cardText, color: "var(--ok)" } : cardText}>{cfgText}</p>
            <div style={cardFoot}>{cfgCount > 0 && <button type="button" onClick={() => setDialog("config")} style={cardBtn}>Review and import</button>}</div>
          </article>
          <article style={card}>
            <span style={{ color: "var(--text-2)", display: "flex" }}><KeyIcon size={18} /></span>
            <h2 style={cardTitle}>Import keys</h2>
            <p title={keys.kind === "error" ? keys.message : undefined} style={keysNote ? { ...cardText, color: "var(--ok)" } : cardText}>{keysText}</p>
            <div style={cardFoot}>{keyCount > 0 && <button type="button" onClick={() => setDialog("keys")} style={cardBtn}>Choose keys</button>}</div>
          </article>
          <article style={card}>
            <span style={{ color: "var(--text-2)", display: "flex" }}><HostsIcon size={18} /></span>
            <h2 style={cardTitle}>Add a host</h2>
            <p style={cardText}>Enter address, user and key by hand.</p>
            <div style={cardFoot}><button type="button" onClick={onNewHost} style={cardBtn}>New host</button></div>
          </article>
        </div>

        {helloOffer && hello && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 16, border: "1px solid var(--line)", borderRadius: 10 }}>
            <span aria-hidden="true" style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: 8, background: "var(--bg-raised)", color: "var(--text)" }}><LockIcon size={18} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={cardTitle}>Protect your vault</h2>
              <p role={helloErr ? "alert" : "status"} title={helloText} style={{ ...oneLine, margin: "4px 0 0", fontSize: 12.5, color: helloErr ? "var(--err)" : hello.enabled ? "var(--ok)" : "var(--text-2)" }}>{helloText}</p>
            </div>
            <button type="button" disabled={helloBusy} onClick={() => void toggleHello()} style={{ flex: "none", height: 32, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: helloBusy ? "default" : "pointer", opacity: helloBusy ? 0.6 : 1 }}>
              <Stable text={helloBusy ? "Waiting…" : hello.enabled ? "Turn off" : "Set up"} alts={["Set up", "Turn off", "Waiting…"]} />
            </button>
          </div>
        )}
      </div>

      {dialog === "config" && cfg.kind === "ready" && (
        <ConfigImportDialog
          entries={cfg.items}
          existingNames={hostNames}
          secrets={secrets}
          onProgress={() => void loadVault()}
          onClose={(added) => {
            setDialog(null);
            if (!added) return;
            setCfgNote(`Added ${plural(added, "host")}`);
            onImported();
          }}
        />
      )}
      {dialog === "keys" && keys.kind === "ready" && (
        <KeyImportDialog
          keys={keys.items}
          secrets={secrets}
          onProgress={() => void loadVault()}
          onClose={(added) => {
            setDialog(null);
            if (!added) return;
            setKeysNote(`Added ${plural(added, "key")} to your vault`);
            onImported();
          }}
        />
      )}
      {keyAsk && (
        <DirKeyDialog
          found={keyAsk.key}
          onClose={() => setKeyAsk(null)}
          onImport={async (passphrase) => {
            const id = await importDirKey(keyAsk.key, passphrase);
            if (!alive.current) return;
            setKeyAsk(null);
            setIdentity(id);
            onQuickConnect({ ...keyAsk.target, identity: id });
          }}
        />
      )}
    </main>
  );
}
