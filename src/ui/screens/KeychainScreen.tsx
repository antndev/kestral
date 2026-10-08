import { CSSProperties, ReactNode, RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readText as clipRead, writeText as clipWrite } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "../../api";
import type { AuthMethod, Host, Identity, KeyAlgorithm, SecretKind, SecretMeta } from "../../api";
import { IS_MAC, MONO, errText } from "../mock";
import { CheckIcon, CopyIcon, DownloadIcon, KeyIcon, LockIcon, PlusIcon, RefreshIcon, SearchIcon, ShieldIcon, TrashIcon, WarningIcon } from "../icons";
import { Overlay, useModalLayer } from "../overlays/Dialogs";
import { Stable } from "../Stable";
import { SegGroup, segItem } from "../SegGroup";

/* ---------- styles (from the design) ---------- */

const fieldLabel: CSSProperties = { display: "block", marginBottom: 6, fontSize: 12, fontWeight: 500, color: "var(--text-2)" };
const field: CSSProperties = { width: "100%", height: 32, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text)", boxSizing: "border-box" };
const h3: CSSProperties = { margin: "0 0 6px", fontSize: 12, fontWeight: 500, color: "var(--text-2)" };
const outlineBtn: CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
const pageBtn: CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
const primaryBtn: CSSProperties = { ...pageBtn, border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500 };
const dangerOutlineBtn: CSSProperties = { ...pageBtn, border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)", background: "color-mix(in srgb, var(--err) 10%, transparent)", color: "var(--err)" };
const iconBtn: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", cursor: "pointer", flex: "none" };
const th: CSSProperties = { height: 32, padding: "0 12px", fontWeight: 500, textAlign: "left", color: "var(--text-2)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
const cell: CSSProperties = { padding: "0 12px", borderBottom: "1px solid var(--line-soft)" };
const chip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, height: 24, padding: "0 10px", border: 0, borderRadius: 12, background: "var(--bg-raised)", color: "var(--text)", fontSize: 12, boxSizing: "border-box" };
const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
const errLine: CSSProperties = { margin: 0, fontSize: 12, color: "var(--err)", overflowWrap: "anywhere" };
const sectionTitle: CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600 };
const warnText: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--warn)" };
const oneLine: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const errSlot: CSSProperties = { flex: "1 1 0", minWidth: 0, margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--err)", overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" };

function disabledLook(disabled: boolean): CSSProperties {
  return disabled ? { opacity: 0.55, cursor: "default" } : {};
}

/* ---------- helpers ---------- */

type Tab = "keys" | "identities" | "agent";
type PubInfo = { pub: string; fp: string; algo: string; comment: string; encrypted: boolean };
/**
 * Derived public half of a vault key. `gen` is the vault generation it was read in;
 * `transient` marks a vault read failure (worth retrying) as opposed to a key that cannot be parsed.
 */
type KeyInfo = ({ ok: true; gen: number } & PubInfo) | { ok: false; error: string; transient: boolean; gen: number };
type Notice = { tone: "ok" | "err"; text: string } | null;

type Family = "ed25519" | "ecdsa" | "rsa";
const FAMILIES: { id: Family; label: string; sizes: { id: KeyAlgorithm; label: string }[] }[] = [
  { id: "ed25519", label: "ED25519", sizes: [{ id: "ed25519", label: "256 bit" }] },
  {
    id: "ecdsa",
    label: "ECDSA",
    sizes: [
      { id: "ecdsa-p256", label: "P-256" },
      { id: "ecdsa-p384", label: "P-384" },
      { id: "ecdsa-p521", label: "P-521" },
    ],
  },
  {
    id: "rsa",
    label: "RSA",
    sizes: [
      { id: "rsa-4096", label: "4096 bit" },
      { id: "rsa-3072", label: "3072 bit" },
    ],
  },
];
type DirectAuth = Exclude<AuthMethod, { kind: "identity" }>;

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/** True for a short moment after trigger() was called, for "Copied" feedback. */
function useFlash(ms = 1400): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const trigger = useCallback(() => {
    setOn(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, trigger];
}

function useNotice(): [Notice, (n: Notice) => void] {
  const [notice, set] = useState<Notice>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = useCallback((n: Notice) => {
    window.clearTimeout(timer.current);
    set(n);
    if (n) timer.current = window.setTimeout(() => set(null), n.tone === "err" ? 8000 : 4000);
  }, []);
  return [notice, show];
}

function StatusText({ notice, style }: { notice: Notice; style?: CSSProperties }) {
  const last = useRef<Notice>(null);
  if (notice) last.current = notice;
  const n = notice ?? last.current;
  return (
    <span role="status" aria-hidden={notice ? undefined : true} title={n?.text} style={{ ...oneLine, fontSize: 12, color: n?.tone === "err" ? "var(--err)" : "var(--text-2)", opacity: notice ? 1 : 0, transition: "opacity 160ms ease-out", ...style }}>
      {n?.text}
    </span>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function names(hosts: Host[]): string {
  return hosts.map((h) => h.name).join(", ");
}

// Zero-width and no-break spaces that sneak in when keys or passwords are copied from web pages.
const INVISIBLE = new RegExp(`[${String.fromCharCode(0xfeff, 0x200b, 0x200c, 0x200d, 0x2060)}]`, "g");
const NBSP = new RegExp(String.fromCharCode(0xa0), "g");

function cleanText(text: string): string {
  return text.replace(INVISIBLE, "").replace(NBSP, " ").replace(/\r\n?/g, "\n");
}

/** ~/.ssh on this machine, as a starting folder for file dialogs. Undefined when unknown. */
async function sshDir(): Promise<string | undefined> {
  try {
    const home = await api.localHome();
    const sep = home.includes("\\") ? "\\" : "/";
    return `${home.replace(/[\\/]+$/, "")}${sep}.ssh`;
  } catch {
    return undefined;
  }
}

function inDir(dir: string | undefined, file: string): string {
  if (!dir) return file;
  return `${dir}${dir.includes("\\") ? "\\" : "/"}${file}`;
}

function rsaBits(b64: string): number | null {
  try {
    const bin = atob(b64);
    let p = 0;
    const next = (): [number, number] => {
      const n = ((bin.charCodeAt(p) << 24) | (bin.charCodeAt(p + 1) << 16) | (bin.charCodeAt(p + 2) << 8) | bin.charCodeAt(p + 3)) >>> 0;
      const start = p + 4;
      p = start + n;
      return [start, n];
    };
    next();
    next();
    const [start, n] = next();
    let i = start;
    while (i < start + n && bin.charCodeAt(i) === 0) i++;
    if (i >= start + n) return null;
    return (start + n - i - 1) * 8 + (32 - Math.clz32(bin.charCodeAt(i)));
  } catch {
    return null;
  }
}

function keyAlgo(pub: string): string {
  const [type = "", b64 = ""] = pub.trim().split(/\s+/);
  if (type === "ssh-ed25519") return "ED25519";
  if (type === "sk-ssh-ed25519@openssh.com") return "ED25519-SK";
  if (type === "ssh-dss") return "DSA";
  if (type === "ssh-rsa") {
    const bits = rsaBits(b64);
    return bits ? `RSA ${bits}` : "RSA";
  }
  if (type.startsWith("ecdsa-sha2-nistp")) return `ECDSA P-${type.slice("ecdsa-sha2-nistp".length)}`;
  if (type.startsWith("sk-ecdsa-sha2-")) return "ECDSA-SK";
  return type.toUpperCase() || "Key";
}

function keyBits(pub: string): number | null {
  const [type = "", b64 = ""] = pub.trim().split(/\s+/);
  if (type === "ssh-ed25519" || type === "sk-ssh-ed25519@openssh.com") return 256;
  if (type === "ssh-rsa") return rsaBits(b64);
  if (type === "ssh-dss") return 1024;
  const m = /nistp(\d+)/.exec(type);
  return m ? Number(m[1]) : null;
}

async function freeExportPath(file: string): Promise<string> {
  const dir = await sshDir();
  if (!dir) return file;
  let names: Set<string>;
  try {
    names = new Set((await api.localList(dir)).map((e) => e.name.toLowerCase()));
  } catch {
    return inDir(dir, file);
  }
  const dot = file.endsWith(".pub") ? file.length - 4 : file.length;
  const base = file.slice(0, dot);
  const ext = file.slice(dot);
  let candidate = `${base}-kestral${ext}`;
  for (let i = 2; names.has(candidate.toLowerCase()); i++) candidate = `${base}-kestral-${i}${ext}`;
  return inDir(dir, names.has(file.toLowerCase()) ? candidate : file);
}

function toInfo(d: api.PubkeyInfo): PubInfo {
  const pub = d.public_key.trim();
  return { pub, fp: d.fingerprint, algo: keyAlgo(pub), comment: pub.split(/\s+/).slice(2).join(" "), encrypted: d.encrypted };
}

async function readKey(id: string, gen: number): Promise<KeyInfo> {
  let value: string;
  try {
    value = await api.secretReveal(id);
  } catch (e) {
    return { ok: false, error: errText(e), transient: true, gen };
  }
  try {
    return { ok: true, gen, ...toInfo(await api.derivePubkey(value)) };
  } catch (e) {
    return { ok: false, error: errText(e), transient: false, gen };
  }
}

function nameError(name: string, taken: string[]): string {
  if (!name) return "Enter a name.";
  if (/[\r\n\t]/.test(name)) return "No line breaks or tabs.";
  if (name.startsWith("__kestral_")) return "The __kestral_ prefix is reserved.";
  if (/PRIVATE KEY|-----BEGIN/.test(name)) return "This looks like a key, not a name.";
  if (taken.includes(name)) return "This name is already taken.";
  return "";
}

function freeName(base: string, taken: string[]): string {
  const b = base.trim() || "key";
  if (!taken.includes(b)) return b;
  for (let i = 2; ; i++) if (!taken.includes(`${b}-${i}`)) return `${b}-${i}`;
}

function createdLabel(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : `created ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

function effectiveAuth(auth: AuthMethod, identities: Identity[]): DirectAuth | null {
  if (auth.kind !== "identity") return auth;
  const id = auth.identity_id;
  return identities.find((i) => i.id === id)?.auth ?? null;
}

function directSecret(auth: AuthMethod): string | null {
  return auth.kind === "key" || auth.kind === "password" ? auth.secret_id : null;
}

function secretOf(auth: AuthMethod, identities: Identity[]): string | null {
  const a = effectiveAuth(auth, identities);
  return a ? directSecret(a) : null;
}

function renamedAuth<T extends AuthMethod>(auth: T, from: string, to: string): T {
  return directSecret(auth) === from ? { ...auth, secret_id: to } : auth;
}

/** The host with every reference to `from` (sign-in credential and forwarded keys) pointing at `to`. */
function withSecretRenamed(h: Host, from: string, to: string): Host {
  return { ...h, auth: renamedAuth(h.auth, from, to), agent_keys: h.agent_keys.map((k) => (k === from ? to : k)) };
}

/* ---------- screen ---------- */

export function KeychainScreen(p: { hosts: Host[]; onHostsChanged(): void; onEditHost?(h: Host): void }) {
  const alive = useAlive();
  const [tab, setTab] = useState<Tab>("keys");
  const [secrets, setSecrets] = useState<SecretMeta[] | null>(null);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [info, setInfo] = useState<Record<string, KeyInfo>>({});
  // Bumped on every host or vault change from outside (the host editor can replace a key under
  // the same name), so derived public keys are read again instead of going stale.
  const [gen, setGen] = useState(0);
  const pending = useRef(new Set<string>());
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<"generate" | "import" | null>(null);

  // The app keeps its own copy of the secret list, so tell it about every vault change.
  const hostsChanged = useRef(p.onHostsChanged);
  hostsChanged.current = p.onHostsChanged;
  const notify = useCallback(() => hostsChanged.current(), []);

  /** Reloads the secret list; `reselect` runs in the same render so the selection never jumps. */
  const refresh = useCallback(
    async (reselect?: (cur: string | null) => string | null) => {
      try {
        const [list, idents] = await Promise.all([api.secretList(), api.identityList().catch(() => null)]);
        if (!alive.current) return;
        list.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
        setSecrets(list);
        if (idents) setIdentities(idents);
        setLoadErr("");
        if (reselect) setSel(reselect);
      } catch (e) {
        if (alive.current) setLoadErr(errText(e));
      }
    },
    [alive],
  );

  useEffect(() => {
    setGen((g) => g + 1);
    refresh();
  }, [refresh, p.hosts]);

  const keys = useMemo(() => (secrets ?? []).filter((s) => s.kind === "private_key"), [secrets]);
  const passwords = useMemo(() => (secrets ?? []).filter((s) => s.kind === "password"), [secrets]);
  const allIds = useMemo(() => (secrets ?? []).map((s) => s.id), [secrets]);

  // Derive the public half of every key, for the list, the details and the agent tab. The old
  // value stays on screen while a newer generation is read.
  useEffect(() => {
    for (const k of keys) {
      const cur = info[k.id];
      if ((cur && cur.gen >= gen) || pending.current.has(k.id)) continue;
      pending.current.add(k.id);
      readKey(k.id, gen).then((result) => {
        pending.current.delete(k.id);
        if (alive.current) setInfo((m) => ({ ...m, [k.id]: result }));
      });
    }
  }, [keys, info, gen, alive]);

  const retryKey = useCallback((id: string) => {
    setInfo((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
  }, []);

  useEffect(() => {
    if (keys.length === 0) {
      if (sel !== null && secrets !== null) setSel(null);
      return;
    }
    if (!sel || !keys.some((k) => k.id === sel)) setSel(keys[0].id);
  }, [keys, sel, secrets]);

  const usedBy = useCallback((id: string) => p.hosts.filter((h) => secretOf(h.auth, identities) === id), [p.hosts, identities]);
  const identitiesUsing = useCallback((id: string) => identities.filter((i) => directSecret(i.auth) === id), [identities]);
  const forwardedTo = useCallback((id: string) => p.hosts.filter((h) => h.forward_agent && h.agent_keys.includes(id)), [p.hosts]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return keys;
    return keys.filter((k) => {
      const i = info[k.id];
      return k.id.toLowerCase().includes(q) || (i?.ok === true && (i.algo.toLowerCase().includes(q) || i.comment.toLowerCase().includes(q) || i.fp.toLowerCase().includes(q)));
    });
  }, [keys, filter, info]);

  const current = keys.find((k) => k.id === sel) ?? null;

  /**
   * Copies the secret to the new name, points every host at it, then drops the old one. A failure
   * undoes the finished steps, so hosts never stay split between two copies unless the undo
   * itself fails, and then the error says which hosts use which name.
   */
  const renameSecret = useCallback(
    async (oldId: string, newId: string) => {
      let current: Host[];
      let idents: Identity[];
      try {
        [current, idents] = await Promise.all([api.hostList(), api.identityList()]);
        await api.secretCopy(oldId, newId);
      } catch (e) {
        throw new Error(`Rename failed: ${errText(e)}. Nothing was changed.`);
      }
      const affected = current.filter((h) => directSecret(h.auth) === oldId || h.agent_keys.includes(oldId));
      const affectedIdents = idents.filter((i) => directSecret(i.auth) === oldId);
      const moved: Host[] = [];
      const movedIdents: Identity[] = [];
      try {
        for (const i of affectedIdents) {
          await api.identityUpdate({ ...i, auth: renamedAuth(i.auth, oldId, newId) });
          movedIdents.push(i);
        }
        for (const h of affected) {
          await api.hostUpdate(withSecretRenamed(h, oldId, newId));
          moved.push(h);
        }
        await api.secretDelete(oldId);
      } catch (e) {
        // A delete that reports an error can still have gone through; then the rename is complete.
        const oldStillThere = await api.secretList().then(
          (l) => l.some((s) => s.id === oldId),
          () => true,
        );
        if (oldStillThere) {
          const message = await undoRename(e, oldId, newId, moved, movedIdents);
          await refresh();
          notify();
          throw new Error(message);
        }
      }
      if (alive.current) {
        setInfo((m) => {
          const next = { ...m };
          if (m[oldId]) next[newId] = m[oldId];
          delete next[oldId];
          return next;
        });
        // Follow the key only if the user did not pick another one meanwhile.
        await refresh((cur) => (cur === oldId ? newId : cur));
      }
      notify();
    },
    [alive, refresh, notify],
  );

  const deleteSecret = useCallback(
    async (id: string) => {
      await api.secretDelete(id);
      if (alive.current) {
        setInfo((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
        await refresh();
      }
      notify();
    },
    [alive, refresh, notify],
  );

  const showKey = useCallback((id: string) => {
    setFilter("");
    setSel(id);
    setTab("keys");
  }, []);

  const added = useCallback(
    async (id: string) => {
      setDialog(null);
      setFilter("");
      setTab("keys");
      await refresh(() => id);
      notify();
    },
    [refresh, notify],
  );

  const hasKeys = keys.length > 0;
  const hostCount = (id: string) => new Set([...usedBy(id), ...forwardedTo(id)].map((h) => h.id)).size;

  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, minHeight: 56, padding: "12px 28px", boxSizing: "border-box" }}>
        <h1 style={{ position: "relative", top: -1, margin: 0, fontSize: 20, fontWeight: 600 }}>Keychain</h1>
        <SegGroup label="View" value={tab} style={{ marginLeft: 8 }}>
          {(
            [
              ["keys", "Keys"],
              ["identities", "Identities"],
              ["agent", "Agent"],
            ] as const
          ).map(([t, label]) => (
            <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)} style={segItem(tab === t)}>
              {label}
            </button>
          ))}
        </SegGroup>
        <div style={{ flex: 1 }} />
        {tab === "keys" && hasKeys && (
          <>
            <button type="button" onClick={() => setDialog("import")} style={pageBtn}>Import</button>
            <button type="button" onClick={() => setDialog("generate")} style={primaryBtn}>
              <PlusIcon size={14} sw={1.75} />
              Generate key
            </button>
          </>
        )}
      </div>

      {secrets === null ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, borderTop: "1px solid var(--line)", padding: 24, textAlign: "center", color: "var(--text-2)" }}>
          {loadErr ? (
            <>
              <p style={errLine}>Could not read the vault: {loadErr}</p>
              <button type="button" onClick={() => refresh()} style={outlineBtn}>Try again</button>
            </>
          ) : (
            "Loading…"
          )}
        </div>
      ) : tab === "keys" && !hasKeys ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, borderTop: "1px solid var(--line)", padding: 24, textAlign: "center", color: "var(--text-2)" }}>
          <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 10, background: "var(--bg-raised)", color: "var(--text-2)" }}><KeyIcon size={20} /></span>
          <span>No SSH keys yet</span>
          {loadErr && <p style={errLine}>Could not refresh: {loadErr}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => setDialog("generate")} style={primaryBtn}>
              <PlusIcon size={14} sw={1.75} />
              Generate key
            </button>
            <button type="button" onClick={() => setDialog("import")} style={pageBtn}>Import</button>
          </div>
        </div>
      ) : tab === "keys" ? (
        <div style={{ display: "flex", flexWrap: "wrap", flex: 1, minHeight: 0, borderTop: "1px solid var(--line)", overflow: "auto" }}>
          <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8, padding: "12px 10px", borderRight: "1px solid var(--line)", boxSizing: "border-box", overflow: "auto" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, height: 32, flex: "none", padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text-2)", boxSizing: "border-box" }}>
              <SearchIcon size={14} />
              <span style={srOnly}>Filter keys</span>
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && filter) {
                    e.stopPropagation();
                    setFilter("");
                  }
                }}
                placeholder="Filter keys"
                style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--text)" }}
              />
            </label>
            {loadErr && <p style={{ ...errLine, margin: "0 8px" }}>Could not refresh: {loadErr}</p>}
            {filtered.length === 0 ? (
              <p style={{ margin: "8px", fontSize: 12, color: "var(--text-2)" }}>No keys match “{filter.trim()}”.</p>
            ) : (
              <KeyList keys={filtered} info={info} sel={sel} onSelect={setSel} hostCount={hostCount} />
            )}
          </div>

          <section aria-label="Key details" style={{ flex: "999 1 480px", minWidth: 0, padding: "24px 28px", overflow: "auto", boxSizing: "border-box" }}>
            {current && (
              <div style={{ width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 22 }}>
              <KeyDetail
                key={current.id}
                secret={current}
                info={info[current.id]}
                hosts={p.hosts}
                usedBy={usedBy(current.id)}
                identitiesUsing={identitiesUsing(current.id)}
                forwardedTo={forwardedTo(current.id)}
                takenIds={allIds.filter((i) => i !== current.id)}
                onRename={(next) => renameSecret(current.id, next)}
                onShowIdentities={() => setTab("identities")}
                onDelete={() => deleteSecret(current.id)}
                onRetry={() => retryKey(current.id)}
                onEditHost={p.onEditHost}
              />
              </div>
            )}
          </section>
        </div>
      ) : tab === "identities" ? (
        <IdentitiesTab
          hosts={p.hosts}
          secrets={secrets}
          keys={keys}
          passwords={passwords}
          identities={identities}
          allIds={allIds}
          onShowKey={showKey}
          onEditHost={p.onEditHost}
          onDelete={deleteSecret}
          onChanged={async () => {
            await refresh();
            notify();
          }}
        />
      ) : (
        <AgentTab hosts={p.hosts} secrets={secrets} identities={identities} info={info} onShowKey={showKey} onEditHost={p.onEditHost} />
      )}

      {dialog === "generate" && <GenerateDialog taken={allIds} onClose={() => setDialog(null)} onDone={added} />}
      {dialog === "import" && <ImportDialog taken={allIds} onClose={() => setDialog(null)} onDone={added} />}
    </main>
  );
}

/** Points every host already moved to `newId` back at `oldId` and removes the copy. Returns the error to show. */
async function undoRename(cause: unknown, oldId: string, newId: string, moved: Host[], movedIdents: Identity[]): Promise<string> {
  const why = `Rename failed: ${errText(cause)}.`;
  const stuck: string[] = [];
  for (const h of moved) {
    try {
      await api.hostUpdate(h);
    } catch {
      stuck.push(h.name);
    }
  }
  for (const i of movedIdents) {
    try {
      await api.identityUpdate(i);
    } catch {
      stuck.push(`identity ${i.name}`);
    }
  }
  if (stuck.length > 0) {
    return `${why} ${stuck.join(", ")} still ${stuck.length === 1 ? "uses" : "use"} ${newId}, everything else uses ${oldId}. Both keys are in your vault, so fix those in the host editor or on the Identities tab before you delete one.`;
  }
  try {
    await api.secretDelete(newId);
  } catch (e) {
    return `${why} Every host still uses ${oldId}, but the copy named ${newId} could not be removed (${errText(e)}). Delete it yourself.`;
  }
  return `${why} Nothing was changed.`;
}

/* ---------- keys tab ---------- */

function KeyList(p: { keys: SecretMeta[]; info: Record<string, KeyInfo>; sel: string | null; onSelect(id: string): void; hostCount(id: string): number }) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  function move(from: number, delta: number) {
    const next = p.keys[Math.min(p.keys.length - 1, Math.max(0, from + delta))];
    if (!next) return;
    p.onSelect(next.id);
    refs.current.get(next.id)?.focus();
  }
  return (
    <ul data-stagger style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      {p.keys.map((k, i) => {
        const inf = p.info[k.id];
        const n = p.hostCount(k.id);
        const sub = !inf ? "Reading…" : [inf.ok ? inf.algo : inf.transient ? "Could not read" : "Unreadable", inf.ok && inf.encrypted ? "locked" : "", n > 0 ? plural(n, "host") : "unused"].filter(Boolean).join(" · ");
        const active = k.id === p.sel;
        return (
          <li key={k.id}>
            <button
              ref={(el) => {
                if (el) refs.current.set(k.id, el);
                else refs.current.delete(k.id);
              }}
              type="button"
              aria-current={active}
              onClick={() => p.onSelect(k.id)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(i, e.key === "ArrowDown" ? 1 : -1);
                }
              }}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: 8, border: 0, borderRadius: 6, background: active ? "var(--sel)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer" }}
            >
              <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: "none", width: 30, height: 30, borderRadius: 6, background: "var(--bg-raised)", color: inf && (!inf.ok || inf.encrypted) ? "var(--warn)" : "var(--text-2)" }}><KeyIcon /></span>
              <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{k.id}</span>
                <span title={sub} style={{ ...oneLine, fontSize: 12, color: "var(--text-2)" }}>{sub}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function HostChip({ host, onEditHost }: { host: Host; onEditHost?(h: Host): void }) {
  if (!onEditHost) return <span style={chip} title={`${host.username ? `${host.username}@` : ""}${host.hostname}`}>{host.name}</span>;
  return (
    <button type="button" onClick={() => onEditHost(host)} title={`Edit ${host.name}`} style={{ ...chip, cursor: "pointer" }}>
      {host.name}
    </button>
  );
}

function HostName({ host, onEditHost }: { host: Host; onEditHost?(h: Host): void }) {
  if (!onEditHost) return <div style={{ fontWeight: 600 }}>{host.name}</div>;
  return (
    <button type="button" onClick={() => onEditHost(host)} title={`Edit ${host.name}`} style={{ padding: 0, border: 0, background: "transparent", color: "var(--text)", fontWeight: 600, cursor: "pointer", textAlign: "left" }}>
      {host.name}
    </button>
  );
}

function KeyDetail(p: {
  secret: SecretMeta;
  info: KeyInfo | undefined;
  hosts: Host[];
  usedBy: Host[];
  identitiesUsing: Identity[];
  forwardedTo: Host[];
  takenIds: string[];
  onRename(next: string): Promise<void>;
  onDelete(): Promise<void>;
  onRetry(): void;
  onEditHost?(h: Host): void;
  onShowIdentities(): void;
}) {
  const alive = useAlive();
  const ok = p.info?.ok === true ? p.info : null;
  const failed = p.info && !p.info.ok ? p.info : null;
  const [label, setLabel] = useState(p.secret.id);
  const [renaming, setRenaming] = useState(false);
  const [labelErr, setLabelErr] = useState("");
  const [modal, setModal] = useState<"delete" | "export" | "show" | null>(null);
  const [privCopied, flashPriv] = useFlash();
  const [commentBusy, setCommentBusy] = useState(false);
  const [notice, setNotice] = useNotice();
  const [fpCopied, flashFp] = useFlash();
  const [pubCopied, flashPub] = useFlash();
  const [pubSaved, flashSaved] = useFlash();

  const pendingLabel = label.trim() !== p.secret.id;

  // Renames only on Enter: committing on blur would race a click on another key or on Delete.
  async function commitLabel() {
    if (renaming) return;
    const next = label.trim();
    if (next === p.secret.id) {
      setLabel(p.secret.id);
      setLabelErr("");
      return;
    }
    const err = nameError(next, p.takenIds);
    if (err) {
      setLabelErr(err);
      return;
    }
    setLabelErr("");
    setRenaming(true);
    try {
      await p.onRename(next);
    } catch (e) {
      if (!alive.current) return;
      setLabel(p.secret.id);
      setLabelErr(errText(e));
      setRenaming(false);
    }
  }

  async function copy(text: string, done: () => void) {
    try {
      await clipWrite(text);
      if (alive.current) done();
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: `Could not copy: ${errText(e)}` });
    }
  }

  async function copyPrivate() {
    setNotice(null);
    try {
      const pem = await api.secretReveal(p.secret.id);
      await copy(pem, flashPriv);
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: `Could not read the private key: ${errText(e)}` });
    }
  }

  async function removeComment() {
    if (commentBusy) return;
    setCommentBusy(true);
    setNotice(null);
    try {
      await api.keySetComment(p.secret.id, "");
      p.onRetry();
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: errText(e) });
    } finally {
      if (alive.current) setCommentBusy(false);
    }
  }

  async function exportPub() {
    if (!ok) return;
    setNotice(null);
    try {
      const path = await saveDialog({ defaultPath: await freeExportPath(`${p.secret.id}.pub`), filters: [{ name: "Public key", extensions: ["pub"] }] });
      if (!path) return;
      await api.localWriteText(path, `${ok.pub}\n`);
      if (alive.current) flashSaved();
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: `Export failed: ${errText(e)}` });
    }
  }


  const needKey = ok ? undefined : p.info ? "The public key could not be read from this private key." : "Reading the key…";
  const busyTip = renaming ? "Wait for the rename to finish." : undefined;
  const placeholder = p.info ? "Unavailable" : "Reading…";
  const labelHint = renaming ? "Renaming…" : labelErr || (pendingLabel ? "Enter to rename, Esc to cancel" : "");

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, overflowWrap: "anywhere" }}>{p.secret.id}</h2>
          <p style={{ margin: "4px 0 0", color: "var(--text-2)" }}>{[ok ? ok.algo.replace(/ \d+$/, "") : p.info ? "Private key" : "Reading…", ok && keyBits(ok.pub) ? `${keyBits(ok.pub)} bit` : "", createdLabel(p.secret.created_at)].filter(Boolean).join(", ")}</p>
        </div>
        <button type="button" onClick={() => setModal("delete")} disabled={renaming} title={busyTip} style={{ ...dangerOutlineBtn, flex: "none", ...disabledLook(renaming) }}>
          <TrashIcon />
          Delete
        </button>
      </div>

      {failed && (
        <div role="alert" style={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 10, padding: "12px 14px", border: "1px solid var(--warn)", borderRadius: 8, background: "var(--warn-tint)" }}>
          <span style={{ color: "var(--warn)", display: "flex", marginTop: 1 }}><WarningIcon /></span>
          <span style={{ flex: "1 1 240px", lineHeight: 1.5 }}>
            {failed.transient ? "This key could not be read from the vault. " : "This key could not be read, so it cannot be used to sign in. "}
            <span style={{ color: "var(--text-2)", overflowWrap: "anywhere" }}>({failed.error})</span>
          </span>
          {failed.transient && <button type="button" onClick={p.onRetry} style={outlineBtn}>Try again</button>}
        </div>
      )}
      {ok?.encrypted && <UnlockBanner id={p.secret.id} onUnlocked={p.onRetry} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <label htmlFor="key-label" style={{ ...fieldLabel, marginBottom: 0, flex: "none" }}>Label</label>
            <span id="key-label-hint" role="status" title={labelHint || undefined} style={{ ...oneLine, fontSize: 12, color: labelErr ? "var(--err)" : "var(--text-3)" }}>{labelHint}</span>
          </div>
          <input
            id="key-label"
            type="text"
            value={label}
            disabled={renaming}
            spellCheck={false}
            aria-invalid={labelErr ? true : undefined}
            aria-describedby="key-label-hint"
            onChange={(e) => {
              setLabel(e.target.value);
              setLabelErr("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitLabel();
              } else if (e.key === "Escape" && (pendingLabel || labelErr)) {
                e.stopPropagation();
                setLabel(p.secret.id);
                setLabelErr("");
              }
            }}
            style={{ ...field, borderColor: labelErr ? "var(--err)" : "var(--line)", opacity: renaming ? 0.6 : 1 }}
          />
        </div>
        <div>
          <span style={fieldLabel}>Comment</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32 }}>
            <div title={ok?.comment || undefined} style={{ ...oneLine, flex: 1, minWidth: 0, color: ok?.comment ? "var(--text)" : "var(--text-3)" }}>{ok ? ok.comment || "No comment" : placeholder}</div>
            <button
              type="button"
              onClick={() => void removeComment()}
              disabled={!ok?.comment || ok.encrypted || commentBusy}
              title={ok?.encrypted ? "This key has a passphrase, so its comment cannot be changed here." : "Remove the comment from the key"}
              style={{ ...outlineBtn, flex: "none", ...disabledLook(!ok?.comment || !!ok?.encrypted || commentBusy) }}
            >
              <Stable text={commentBusy ? "Removing…" : "Remove"} alts={["Remove", "Removing…"]} />
            </button>
          </div>
        </div>
      </div>

      <div>
        <h3 style={h3}>Fingerprint</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 4px 0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", boxSizing: "border-box" }}>
          <code title={ok?.fp} style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: ok ? "var(--text)" : "var(--text-3)" }}>{ok ? ok.fp : placeholder}</code>
          <button type="button" aria-label={fpCopied ? "Copied" : "Copy fingerprint"} title={fpCopied ? "Copied" : needKey ?? "Copy fingerprint"} disabled={!ok} onClick={() => ok && copy(ok.fp, flashFp)} style={{ ...iconBtn, color: fpCopied ? "var(--ok)" : "var(--text-2)", ...disabledLook(!ok) }}>
            {fpCopied ? <CheckIcon size={14} /> : <CopyIcon />}
          </button>
        </div>
      </div>

      <div>
        <h3 style={h3}>Public key</h3>
        <div style={{ padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", fontFamily: MONO, fontSize: 12, lineHeight: 1.6, wordBreak: "break-all", userSelect: "text", color: ok ? "var(--text)" : "var(--text-3)" }}>
          {ok ? ok.pub : placeholder}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <button type="button" disabled={!ok} title={needKey} onClick={() => ok && copy(ok.pub, flashPub)} style={{ ...outlineBtn, ...disabledLook(!ok) }}>
            {pubCopied ? <CheckIcon size={14} /> : <CopyIcon />}
            <Stable text={pubCopied ? "Copied" : "Copy public key"} alts={["Copy public key", "Copied"]} />
          </button>
          <button type="button" disabled={!ok} title={needKey} onClick={exportPub} style={{ ...outlineBtn, ...disabledLook(!ok) }}>
            {pubSaved ? <CheckIcon size={14} /> : <DownloadIcon />}
            <Stable text={pubSaved ? "Saved" : "Export .pub"} alts={["Export .pub", "Saved"]} />
          </button>
          <StatusText notice={notice} style={{ flex: 1, marginLeft: 4 }} />
        </div>
      </div>

      <div>
        <h3 style={h3}>Private key</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button type="button" onClick={() => setModal("show")} style={outlineBtn}>
            <KeyIcon size={14} />
            Show
          </button>
          <button type="button" onClick={() => void copyPrivate()} style={outlineBtn}>
            {privCopied ? <CheckIcon size={14} /> : <CopyIcon />}
            <Stable text={privCopied ? "Copied" : "Copy"} alts={["Copy", "Copied"]} />
          </button>
          <button type="button" onClick={() => setModal("export")} style={outlineBtn}>
            <DownloadIcon />
            Export…
          </button>
        </div>
      </div>

      <div>
        <h3 style={{ ...h3, marginBottom: 8 }}>{p.usedBy.length > 0 ? `Used by ${plural(p.usedBy.length, "host")}` : p.forwardedTo.length > 0 ? "Not used to sign in" : "Not used by any host"}</h3>
        {p.usedBy.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {p.usedBy.map((h) => <HostChip key={h.id} host={h} onEditHost={p.onEditHost} />)}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-3)" }}>Pick this key as the authentication of a host in the host editor.</p>
        )}
      </div>

      {p.identitiesUsing.length > 0 && (
        <div>
          <h3 style={{ ...h3, marginBottom: 8 }}>Part of {p.identitiesUsing.length === 1 ? "1 identity" : `${p.identitiesUsing.length} identities`}</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {p.identitiesUsing.map((i) => (
              <button key={i.id} type="button" onClick={p.onShowIdentities} title="Show identities" style={{ ...chip, cursor: "pointer" }}>
                <ShieldIcon size={12} />
                {i.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {p.forwardedTo.length > 0 && (
        <div>
          <h3 style={{ ...h3, marginBottom: 8 }}>Forwarded to {plural(p.forwardedTo.length, "host")}</h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {p.forwardedTo.map((h) => <HostChip key={h.id} host={h} onEditHost={p.onEditHost} />)}
          </div>
        </div>
      )}

      {modal === "show" && <ShowPrivateKeyDialog id={p.secret.id} onClose={() => setModal(null)} />}
      {modal === "export" && (
        <ExportKeyDialog
          id={p.secret.id}
          onClose={() => setModal(null)}
          onDone={(path, locked) => {
            setModal(null);
            setNotice({ tone: "ok", text: `Private key saved to ${path}${locked ? ", encrypted" : ""}.` });
          }}
        />
      )}
      {modal === "delete" && (
        <RichConfirm
          title="Delete key"
          confirmLabel="Delete key"
          busyLabel="Deleting…"
          onConfirm={p.onDelete}
          onClose={() => setModal(null)}
          message={
            <>
              Delete <strong style={{ color: "var(--text)" }}>{p.secret.id}</strong> from your vault? This cannot be undone.
              {p.usedBy.length > 0 && (
                <span style={{ display: "block", marginTop: 8, color: "var(--err)" }}>
                  {names(p.usedBy)} {p.usedBy.length === 1 ? "signs in" : "sign in"} with this key and will fail to connect until you pick another one.
                </span>
              )}
              {p.identitiesUsing.length > 0 && (
                <span style={{ display: "block", marginTop: 8, color: "var(--err)" }}>
                  The {p.identitiesUsing.length === 1 ? "identity" : "identities"} {p.identitiesUsing.map((i) => i.name).join(", ")} {p.identitiesUsing.length === 1 ? "uses" : "use"} it too.
                </span>
              )}
              {p.forwardedTo.length > 0 && <span style={{ display: "block", marginTop: 8 }}>It is also no longer forwarded to {names(p.forwardedTo)}.</span>}
            </>
          }
        />
      )}
    </>
  );
}

function kindMismatch(auth: AuthMethod, kind: SecretKind): string {
  if (auth.kind === "key" && kind !== "private_key") return "a password, not a key";
  if (auth.kind === "password" && kind !== "password") return "a key, not a password";
  return "";
}

function IdentitiesTab(p: {
  hosts: Host[];
  secrets: SecretMeta[];
  keys: SecretMeta[];
  passwords: SecretMeta[];
  identities: Identity[];
  allIds: string[];
  onShowKey(id: string): void;
  onEditHost?(h: Host): void;
  onDelete(id: string): Promise<void>;
  onChanged(): Promise<void>;
}) {
  const alive = useAlive();
  const [pwDialog, setPwDialog] = useState<{ secret: SecretMeta | null } | null>(null);
  const [idDialog, setIdDialog] = useState<{ identity: Identity | null } | null>(null);
  const [toDelete, setToDelete] = useState<SecretMeta | null>(null);
  const [identityToDelete, setIdentityToDelete] = useState<Identity | null>(null);
  const [notice, setNotice] = useNotice();
  const [idNotice, setIdNotice] = useNotice();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const hosts = useMemo(() => [...p.hosts].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })), [p.hosts]);
  const identities = useMemo(() => [...p.identities].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })), [p.identities]);
  const kindOf = (id: string) => p.secrets.find((s) => s.id === id)?.kind ?? null;
  const usersOf = (id: string) => hosts.filter((h) => secretOf(h.auth, p.identities) === id);
  const identitiesOf = (id: string) => identities.filter((i) => directSecret(i.auth) === id);
  const hostsOfIdentity = (id: string) => hosts.filter((h) => h.auth.kind === "identity" && h.auth.identity_id === id);

  async function copyPassword(s: SecretMeta) {
    setNotice(null);
    try {
      await clipWrite(await api.secretReveal(s.id));
      if (!alive.current) return;
      setCopiedId(s.id);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => alive.current && setCopiedId(null), 1400);
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: `Could not copy ${s.id}: ${errText(e)}` });
    }
  }

  function credential(auth: DirectAuth): ReactNode {
    if (auth.kind === "agent") return <span>SSH agent on this computer</span>;
    const sid = auth.secret_id;
    const kind = kindOf(sid);
    if (kind === null) {
      return (
        <span style={{ ...warnText, color: "var(--err)" }} title="This credential is not in your vault. Pick another one.">
          <WarningIcon size={14} />
          {sid} (missing)
        </span>
      );
    }
    const mismatch = kindMismatch(auth, kind);
    if (mismatch) {
      return (
        <span style={warnText} title={`This sign-in expects ${auth.kind === "key" ? "a key" : "a password"}, so this credential cannot be used. Pick a matching one.`}>
          <WarningIcon size={14} />
          {sid} ({mismatch})
        </span>
      );
    }
    if (auth.kind === "key") {
      return (
        <button type="button" onClick={() => p.onShowKey(sid)} title="Show key" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: 0, border: 0, background: "transparent", color: "var(--link)", cursor: "pointer" }}>
          <KeyIcon size={14} />
          {sid}
        </button>
      );
    }
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ display: "flex", color: "var(--text-2)" }}><LockIcon size={14} /></span>
        {sid}
      </span>
    );
  }

  const deleteUsers = toDelete ? usersOf(toDelete.id) : [];
  const deleteIdentities = toDelete ? identitiesOf(toDelete.id) : [];

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", borderTop: "1px solid var(--line)", padding: "20px 28px 24px", display: "flex", flexDirection: "column", gap: 28 }}>
      <section aria-label="Identities" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={sectionTitle}>Identities</h2>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>{identities.length}</span>
          <StatusText notice={idNotice} style={{ flex: 1, textAlign: "right" }} />
          <button type="button" onClick={() => setIdDialog({ identity: null })} style={outlineBtn}>
            <PlusIcon size={14} />
            Add identity
          </button>
        </div>
        {identities.length === 0 ? (
          <p style={{ margin: "8px 0", color: "var(--text-2)", lineHeight: 1.5 }}>No identities yet. An identity is a user and credential that several hosts share.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th scope="col" style={th}>Name</th>
                <th scope="col" style={th}>User</th>
                <th scope="col" style={th}>Credential</th>
                <th scope="col" style={th}>Used by</th>
                <th scope="col" style={{ width: 96, borderBottom: "1px solid var(--line)" }}><span style={srOnly}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {identities.map((i) => {
                const users = hostsOfIdentity(i.id);
                return (
                  <tr key={i.id}>
                    <td style={{ ...cell, height: 40 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                        <span style={{ display: "flex", color: "var(--text-2)" }}><ShieldIcon size={14} /></span>
                        <span style={{ overflowWrap: "anywhere" }}>{i.name}</span>
                      </span>
                    </td>
                    <td style={{ ...cell, fontFamily: MONO, fontSize: 12 }}>{i.username || <span style={{ fontFamily: "inherit", color: "var(--text-3)" }}>host's user</span>}</td>
                    <td style={cell}>{credential(i.auth)}</td>
                    <td style={cell}>
                      {users.length === 0 ? (
                        <span style={{ color: "var(--text-3)" }}>Not used by any host</span>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 0" }}>
                          {users.map((h) => <HostChip key={h.id} host={h} onEditHost={p.onEditHost} />)}
                        </div>
                      )}
                    </td>
                    <td style={{ ...cell, padding: "0 8px" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
                        <button type="button" onClick={() => setIdDialog({ identity: i })} style={{ height: 26, padding: "0 8px", border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", fontSize: 12, cursor: "pointer" }}>Edit</button>
                        <button
                          type="button"
                          aria-label={`Delete identity ${i.name}`}
                          title={users.length > 0 ? `Used by ${names(users)}. Pick another sign-in method there first.` : "Delete"}
                          disabled={users.length > 0}
                          onClick={() => setIdentityToDelete(i)}
                          style={{ ...iconBtn, ...disabledLook(users.length > 0) }}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Passwords" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={sectionTitle}>Passwords</h2>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>{p.passwords.length}</span>
          <StatusText notice={notice} style={{ flex: 1, textAlign: "right" }} />
          <button type="button" onClick={() => setPwDialog({ secret: null })} style={outlineBtn}>
            <PlusIcon size={14} />
            Add password
          </button>
        </div>
        {p.passwords.length === 0 ? (
          <p style={{ margin: "8px 0", color: "var(--text-2)" }}>No passwords yet. Hosts that sign in with a password reference one stored here.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th scope="col" style={th}>Name</th>
                <th scope="col" style={th}>Used by</th>
                <th scope="col" style={{ width: 150, borderBottom: "1px solid var(--line)" }}><span style={srOnly}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {p.passwords.map((s) => {
                const users = usersOf(s.id);
                const idents = identitiesOf(s.id);
                return (
                  <tr key={s.id}>
                    <td style={{ ...cell, height: 40 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                        <span style={{ display: "flex", color: "var(--text-2)" }}><LockIcon size={14} /></span>
                        <span style={{ overflowWrap: "anywhere" }}>{s.id}</span>
                      </span>
                    </td>
                    <td style={cell}>
                      {users.length === 0 && idents.length === 0 ? (
                        <span style={{ color: "var(--text-3)" }}>Not used by any host</span>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "6px 0" }}>
                          {users.map((h) => <HostChip key={h.id} host={h} onEditHost={p.onEditHost} />)}
                          {idents.map((i) => (
                            <span key={i.id} style={chip} title="Identity">
                              <ShieldIcon size={12} />
                              {i.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ ...cell, padding: "0 8px" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
                        <button type="button" aria-label={`Copy password ${s.id}`} title={copiedId === s.id ? "Copied" : "Copy password to the clipboard"} onClick={() => copyPassword(s)} style={{ ...iconBtn, color: copiedId === s.id ? "var(--ok)" : "var(--text-2)" }}>
                          {copiedId === s.id ? <CheckIcon size={14} /> : <CopyIcon />}
                        </button>
                        <button type="button" onClick={() => setPwDialog({ secret: s })} style={{ height: 26, padding: "0 8px", border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", fontSize: 12, cursor: "pointer" }}>Change</button>
                        <button type="button" aria-label={`Delete password ${s.id}`} title="Delete" onClick={() => setToDelete(s)} style={iconBtn}><TrashIcon /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {idDialog && (
        <IdentityDialog
          identity={idDialog.identity}
          identities={p.identities}
          keys={p.keys}
          passwords={p.passwords}
          allIds={p.allIds}
          onClose={() => setIdDialog(null)}
          onDone={async (msg) => {
            setIdDialog(null);
            setIdNotice({ tone: "ok", text: msg });
            await p.onChanged();
          }}
        />
      )}
      {identityToDelete && (
        <RichConfirm
          title="Delete identity"
          confirmLabel="Delete"
          busyLabel="Deleting…"
          onConfirm={async () => {
            await api.identityRemove(identityToDelete.id);
            if (alive.current) setIdNotice({ tone: "ok", text: `Deleted ${identityToDelete.name}.` });
            await p.onChanged();
          }}
          onClose={() => setIdentityToDelete(null)}
          message={
            <>
              Delete the identity <strong style={{ color: "var(--text)" }}>{identityToDelete.name}</strong>? Its key or password stays in your vault.
            </>
          }
        />
      )}
      {pwDialog && (
        <PasswordDialog
          secret={pwDialog.secret}
          taken={p.allIds}
          onClose={() => setPwDialog(null)}
          onDone={async (msg) => {
            setPwDialog(null);
            setNotice({ tone: "ok", text: msg });
            await p.onChanged();
          }}
        />
      )}
      {toDelete && (
        <RichConfirm
          title="Delete password"
          confirmLabel="Delete"
          busyLabel="Deleting…"
          onConfirm={() => p.onDelete(toDelete.id)}
          onClose={() => setToDelete(null)}
          message={
            <>
              Delete <strong style={{ color: "var(--text)" }}>{toDelete.id}</strong> from your vault? This cannot be undone.
              {deleteUsers.length > 0 && (
                <span style={{ display: "block", marginTop: 8, color: "var(--err)" }}>
                  {names(deleteUsers)} {deleteUsers.length === 1 ? "signs in" : "sign in"} with it and will fail to connect until you pick another credential.
                </span>
              )}
              {deleteIdentities.length > 0 && (
                <span style={{ display: "block", marginTop: 8, color: "var(--err)" }}>
                  The {deleteIdentities.length === 1 ? "identity" : "identities"} {deleteIdentities.map((i) => i.name).join(", ")} {deleteIdentities.length === 1 ? "uses" : "use"} it too.
                </span>
              )}
            </>
          }
        />
      )}
    </div>
  );
}

/* ---------- agent tab ---------- */

const AGENT_NAMES: Record<string, string> = { openssh: "OpenSSH Authentication Agent", pageant: "Pageant", unix: "SSH agent" };

function AgentTab(p: { hosts: Host[]; secrets: SecretMeta[]; identities: Identity[]; info: Record<string, KeyInfo>; onShowKey(id: string): void; onEditHost?(h: Host): void }) {
  const alive = useAlive();
  const [local, setLocal] = useState<api.LocalAgentInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.localAgentIdentities();
      if (alive.current) setLocal(r);
    } catch (e) {
      if (alive.current) setLocal({ agent: null, keys: [], error: errText(e) });
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [alive]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const forwarding = useMemo(() => p.hosts.filter((h) => h.forward_agent).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })), [p.hosts]);
  const agentHosts = useMemo(() => p.hosts.filter((h) => effectiveAuth(h.auth, p.identities)?.kind === "agent").sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })), [p.hosts, p.identities]);
  const vaultByFp = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, inf] of Object.entries(p.info)) if (inf.ok) m.set(inf.fp, id);
    return m;
  }, [p.info]);

  async function copyPub(k: api.AgentKeyInfo) {
    try {
      await clipWrite(k.public_key);
      if (!alive.current) return;
      setCopied(k.fingerprint);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => alive.current && setCopied(null), 1400);
    } catch {
      setCopied(null);
    }
  }

  const code: CSSProperties = { fontFamily: MONO, fontSize: 12 };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", borderTop: "1px solid var(--line)", padding: "20px 28px 24px", display: "flex", flexDirection: "column", gap: 28 }}>
      <section aria-label="SSH agent on this computer" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h2 style={sectionTitle}>SSH agent on this computer</h2>
          {local?.agent && <span style={{ fontSize: 12, color: "var(--text-2)" }}>{AGENT_NAMES[local.agent] ?? local.agent}, {plural(local.keys.length, "key")}</span>}
          <div style={{ flex: 1 }} />
          <button type="button" onClick={() => void load()} disabled={loading} style={{ ...outlineBtn, ...disabledLook(loading) }}>
            <RefreshIcon size={14} />
            <Stable text={loading ? "Checking…" : "Refresh"} alts={["Refresh", "Checking…"]} />
          </button>
        </div>
        {local === null ? (
          <p style={{ margin: 0, color: "var(--text-2)" }}>Looking for an SSH agent…</p>
        ) : !local.agent ? (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 8, lineHeight: 1.5, color: "var(--text-2)" }}>
            <span style={{ display: "flex", color: "var(--warn)", marginTop: 2 }}><WarningIcon size={14} /></span>
            <span>
              <span style={{ color: "var(--text)" }}>No SSH agent found.</span>{" "}
              {IS_MAC ? (
                <>Kestral uses the agent from <code style={code}>SSH_AUTH_SOCK</code>. Load your keys with <code style={code}>ssh-add</code>, then refresh.</>
              ) : (
                <>Start the OpenSSH Authentication Agent service (or run <code style={code}>Start-Service ssh-agent</code> as administrator) or open Pageant, add your keys with <code style={code}>ssh-add</code>, then refresh.</>
              )}
            </span>
          </div>
        ) : local.error ? (
          <p style={errLine}>{local.error}</p>
        ) : local.keys.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-2)", lineHeight: 1.5 }}>The agent is running but holds no keys. Add one with <code style={code}>ssh-add</code>, then refresh.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th scope="col" style={th}>Key</th>
                <th scope="col" style={th}>Type</th>
                <th scope="col" style={th}>Fingerprint</th>
                <th scope="col" style={{ width: 40, borderBottom: "1px solid var(--line)" }}><span style={srOnly}>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {local.keys.map((k) => {
                const inVault = vaultByFp.get(k.fingerprint);
                return (
                  <tr key={k.fingerprint}>
                    <td style={{ ...cell, height: 40 }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{k.comment || <span style={{ fontWeight: 400, color: "var(--text-3)" }}>No comment</span>}</span>
                        {inVault && (
                          <button type="button" onClick={() => p.onShowKey(inVault)} title="Also in your vault" style={{ ...chip, height: 20, cursor: "pointer" }}>
                            <KeyIcon size={12} />
                            {inVault}
                          </button>
                        )}
                      </span>
                    </td>
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>{k.algorithm}{k.bits ? ` ${k.bits}` : ""}</td>
                    <td style={{ ...cell, maxWidth: 0, width: "45%" }}>
                      <code title={k.fingerprint} style={{ display: "block", ...code, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-2)" }}>{k.fingerprint}</code>
                    </td>
                    <td style={{ ...cell, padding: "0 8px" }}>
                      <button type="button" aria-label="Copy public key" title={copied === k.fingerprint ? "Copied" : "Copy public key"} onClick={() => void copyPub(k)} style={{ ...iconBtn, color: copied === k.fingerprint ? "var(--ok)" : "var(--text-2)" }}>
                        {copied === k.fingerprint ? <CheckIcon size={14} /> : <CopyIcon />}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <span style={{ fontSize: 12, color: "var(--text-2)", marginRight: 4 }}>{agentHosts.length > 0 ? "Hosts that sign in with the agent" : "No host signs in with the agent. Pick SSH agent as the sign-in method in the host editor."}</span>
          {agentHosts.map((h) => <HostChip key={h.id} host={h} onEditHost={p.onEditHost} />)}
        </div>
      </section>

      <section aria-label="Vault agent" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <h2 style={sectionTitle}>Vault agent</h2>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>Forwarding hosts sign with vault keys that never leave Kestral</span>
        </div>

        {forwarding.length === 0 ? (
          <p style={{ margin: 0, color: "var(--text-2)" }}>No host forwards vault keys. Turn it on per host in the host editor.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th scope="col" style={th}>Host</th>
                <th scope="col" style={th}>Forwarded keys</th>
              </tr>
            </thead>
            <tbody>
              {forwarding.map((h) => (
                <tr key={h.id}>
                  <td style={{ ...cell, height: 46, width: "35%" }}>
                    <HostName host={h} onEditHost={p.onEditHost} />
                    <div style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--text-2)", overflowWrap: "anywhere" }}>{h.username ? `${h.username}@` : ""}{h.hostname}</div>
                  </td>
                  <td style={cell}>
                    {h.agent_keys.length === 0 ? (
                      <span style={warnText}>
                        <WarningIcon size={14} />
                        No keys picked, so nothing is forwarded.
                      </span>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 0" }}>
                        {h.agent_keys.map((id) => {
                          const kind = p.secrets.find((s) => s.id === id)?.kind ?? null;
                          if (kind === null) {
                            return (
                              <span key={id} title="Not in your vault, so nothing is forwarded for it." style={{ ...chip, color: "var(--err)" }}>
                                <WarningIcon size={12} />
                                {id} (missing)
                              </span>
                            );
                          }
                          if (kind !== "private_key") {
                            return (
                              <span key={id} title="This is a password, not a private key, so nothing is forwarded for it." style={{ ...chip, color: "var(--warn)" }}>
                                <WarningIcon size={12} />
                                {id} (not a key)
                              </span>
                            );
                          }
                          const inf = p.info[id];
                          const problem = inf && !inf.ok ? "This key cannot be read." : inf?.ok && inf.encrypted ? "This key is locked by its passphrase. Unlock it on the Keys tab." : "";
                          return (
                            <button key={id} type="button" onClick={() => p.onShowKey(id)} title={problem || "Show key"} style={{ ...chip, cursor: "pointer", color: problem ? "var(--warn)" : "var(--text)" }}>
                              {problem ? <WarningIcon size={12} /> : <KeyIcon size={12} />}
                              {id}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/* ---------- dialogs ---------- */

/** A dialog on the shared modal layer: topmost-only Escape, focus trap and focus restore. */
function Modal(p: { label: string; onClose(): void; dismissable?: boolean; dirty?: boolean; alert?: boolean; width?: number; initialFocus?: RefObject<HTMLElement | null>; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const z = useModalLayer(ref, { onEscape: p.onClose, initialFocus: p.initialFocus });
  const [top, setTop] = useState(24);
  useLayoutEffect(() => {
    const place = () => setTop(Math.max(24, Math.round((window.innerHeight - (ref.current?.offsetHeight ?? 0)) / 2)));
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);
  return (
    <Overlay z={z} align="flex-start" padding={`${top}px 16px 24px`} onBackdrop={p.dismissable === false || p.dirty ? undefined : p.onClose}>
      <section
        ref={ref}
        role={p.alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={p.label}
        tabIndex={-1}
        style={{ width: p.width ?? 440, maxWidth: "100%", maxHeight: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 16, padding: 24, borderRadius: 12, background: "var(--bg)", color: "var(--text)", boxShadow: "var(--shadow)", boxSizing: "border-box", outline: "none" }}
      >
        {p.children}
      </section>
    </Overlay>
  );
}

/** Primary action comes first on Windows and last on macOS. */
function Actions({ primary, cancel, err = "" }: { primary: ReactNode; cancel: ReactNode; err?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
      <p role="alert" title={err || undefined} style={errSlot}>{err}</p>
      {IS_MAC ? <>{cancel}{primary}</> : <>{primary}{cancel}</>}
    </div>
  );
}

function CancelButton({ onClick, disabled, label = "Cancel", btnRef }: { onClick(): void; disabled?: boolean; label?: string; btnRef?: RefObject<HTMLButtonElement | null> }) {
  return <button ref={btnRef} type="button" onClick={onClick} disabled={disabled} style={{ ...pageBtn, padding: "0 14px", ...disabledLook(!!disabled) }}><Stable text={label} alts={["Cancel", "Close"]} /></button>;
}

/** Destructive confirmation with a formatted message. Escape only, and focus starts on Cancel. */
function RichConfirm(p: { title: string; message: ReactNode; confirmLabel: string; busyLabel: string; onConfirm(): Promise<void>; onClose(): void }) {
  const alive = useAlive();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const close = () => {
    if (!busy) p.onClose();
  };
  async function run() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await p.onConfirm();
      if (alive.current) p.onClose();
    } catch (e) {
      if (!alive.current) return;
      setErr(errText(e));
      setBusy(false);
    }
  }
  useEffect(() => {
    if (err) cancelRef.current?.focus();
  }, [err]);
  return (
    <Modal label={p.title} onClose={close} dismissable={false} alert initialFocus={cancelRef}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{p.title}</h2>
      <div style={{ color: "var(--text-2)", lineHeight: 1.5, overflowWrap: "anywhere" }}>{p.message}</div>
      <Actions
        err={err}
        primary={
          <button type="button" onClick={run} disabled={busy} style={{ ...dangerOutlineBtn, padding: "0 14px", ...disabledLook(busy) }}>
            <Stable text={busy ? p.busyLabel : p.confirmLabel} alts={[p.confirmLabel, p.busyLabel]} />
          </button>
        }
        cancel={<CancelButton btnRef={cancelRef} onClick={close} disabled={busy} />}
      />
    </Modal>
  );
}

function Segmented<T extends string>(p: { label: string; value: T; options: { id: T; label: string }[]; onChange(v: T): void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={p.label} style={{ display: "inline-flex", padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)" }}>
      {p.options.map((o) => {
        const on = p.value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={p.disabled}
            onClick={() => p.onChange(o.id)}
            style={{ height: 26, padding: "0 12px", border: 0, borderRadius: 4, background: on ? "var(--bg)" : "transparent", boxShadow: on ? "0 0 0 1px var(--line)" : "none", color: on ? "var(--text)" : "var(--text-2)", cursor: p.disabled ? "default" : "pointer" }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function GenerateDialog(p: { taken: string[]; onClose(): void; onDone(id: string): Promise<void> }) {
  const alive = useAlive();
  const [name, setName] = useState(() => freeName("id_ed25519", p.taken));
  const suggestedRef = useRef(name);
  const [family, setFamily] = useState<Family>("ed25519");
  const [algo, setAlgo] = useState<KeyAlgorithm>("ed25519");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const fam = FAMILIES.find((f) => f.id === family) ?? FAMILIES[0];

  function pickFamily(f: Family) {
    const next = FAMILIES.find((x) => x.id === f) ?? FAMILIES[0];
    setFamily(f);
    setAlgo(next.sizes[0].id);
    const suggestion = freeName(`id_${f}`, p.taken);
    setName((cur) => (!cur.trim() || cur === suggestedRef.current ? suggestion : cur));
    suggestedRef.current = suggestion;
    setErr("");
  }

  async function create() {
    if (busy) return;
    const id = name.trim();
    const v = nameError(id, p.taken);
    if (v) {
      setErr(v);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      if ((await api.secretList()).some((x) => x.id === id)) throw new Error("This name is already taken.");
      const key = await api.generateKey(algo, comment.trim() || id);
      await api.secretPut(id, "private_key", key);
      await p.onDone(id);
    } catch (e) {
      if (!alive.current) return;
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <Modal label="Generate key" onClose={() => !busy && p.onClose()} dirty={name !== suggestedRef.current || comment !== ""}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Generate key</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div>
          <label style={fieldLabel} htmlFor="gk-name">Name</label>
          <input id="gk-name" value={name} spellCheck={false} disabled={busy} onChange={(e) => { setName(e.target.value); setErr(""); }} onFocus={(e) => e.currentTarget.select()} placeholder="deploy-ed25519" style={field} />
        </div>
        <div>
          <span style={fieldLabel} id="gk-algo">Algorithm</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 32 }}>
            <Segmented label="Algorithm" value={family} disabled={busy} options={FAMILIES.map((f) => ({ id: f.id, label: f.label }))} onChange={pickFamily} />
            {fam.sizes.length > 1 && (
              <select aria-label="Key size" value={algo} disabled={busy} onChange={(e) => setAlgo(e.target.value as KeyAlgorithm)} style={{ ...field, width: "auto", height: 32, padding: "0 8px" }}>
                {fam.sizes.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            )}
          </div>
          <p style={{ ...oneLine, margin: "6px 0 0", fontSize: 12, color: "var(--text-3)" }}>
            {family === "ed25519" ? "Fast, small and supported by every current server." : family === "rsa" ? "For older servers without ED25519. Takes a few seconds." : "For servers that require NIST curves."}
          </p>
        </div>
        <div>
          <label style={fieldLabel} htmlFor="gk-comment">Comment</label>
          <input id="gk-comment" value={comment} spellCheck={false} disabled={busy} onChange={(e) => setComment(e.target.value)} placeholder={name.trim() || "you@workstation"} style={field} />
          <p style={{ ...oneLine, margin: "6px 0 0", fontSize: 12, color: "var(--text-3)" }}>Shown at the end of the public key. Defaults to the name.</p>
        </div>
        <Actions
          err={err}
          primary={<button type="submit" disabled={busy} style={{ ...primaryBtn, padding: "0 16px", ...disabledLook(busy) }}><Stable text={busy ? "Generating…" : "Generate"} alts={["Generate", "Generating…"]} /></button>}
          cancel={<CancelButton onClick={p.onClose} disabled={busy} />}
        />
      </form>
    </Modal>
  );
}

type Loaded = { algo: string; fp: string; source: string };

function ImportDialog(p: { taken: string[]; onClose(): void; onDone(id: string): Promise<void> }) {
  const alive = useAlive();
  const keyRef = useRef<string | null>(null);
  const lockedRef = useRef<string | null>(null);
  const suggestedRef = useRef("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [locked, setLocked] = useState<{ source: string; suggested: string } | null>(null);
  const [pass, setPass] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"" | "file" | "paste" | "unlock" | "save">("");
  const [err, setErr] = useState("");

  function take(text: string, d: api.PubkeyInfo, source: string, suggested: string) {
    const inf = toInfo(d);
    keyRef.current = `${text.trim()}\n`;
    setLoaded({ algo: inf.algo, fp: inf.fp, source });
    const next = freeName(suggested, p.taken);
    const previous = suggestedRef.current;
    setName((cur) => (!cur.trim() || cur === previous ? next : cur));
    suggestedRef.current = next;
  }

  async function accept(raw: string, source: string, suggested: string) {
    const text = cleanText(raw).trim();
    if (/^(ssh-|ecdsa-|sk-)/.test(text)) throw new Error("This is a public key. Choose the file without .pub.");
    if (!text.includes("PRIVATE KEY")) throw new Error("This does not look like an SSH private key.");
    let d: api.PubkeyInfo | null = null;
    try {
      d = await api.derivePubkey(text);
    } catch (e) {
      if (!api.isPassphraseError(e)) throw new Error(`The key could not be read. (${errText(e)})`);
    }
    if (!alive.current) return;
    if (!d || d.encrypted) {
      keyRef.current = null;
      lockedRef.current = text;
      setLoaded(null);
      setPass("");
      setLocked({ source, suggested });
      return;
    }
    lockedRef.current = null;
    setLocked(null);
    take(text, d, source, suggested);
  }

  async function unlock() {
    const pem = lockedRef.current;
    if (!locked || !pem || !pass || busy) return;
    setBusy("unlock");
    setErr("");
    try {
      const plain = await api.decryptKey(pem, pass);
      const d = await api.derivePubkey(plain);
      if (!alive.current) return;
      lockedRef.current = null;
      setLocked(null);
      setPass("");
      take(plain, d, locked.source, locked.suggested);
    } catch (e) {
      if (alive.current) setErr(errText(e));
    } finally {
      if (alive.current) setBusy("");
    }
  }

  async function fromFile() {
    setErr("");
    let path: string | null = null;
    try {
      const picked = await openDialog({ multiple: false, directory: false, title: "Choose a private key", defaultPath: await sshDir() });
      path = typeof picked === "string" ? picked : null;
    } catch (e) {
      if (alive.current) setErr(errText(e));
      return;
    }
    if (!path || !alive.current) return;
    setBusy("file");
    try {
      const base = path.split(/[\\/]/).pop() ?? "key";
      await accept(await api.localReadText(path), base, base.replace(/\.(pem|key|txt)$/i, ""));
    } catch (e) {
      if (alive.current) setErr(errText(e));
    } finally {
      if (alive.current) setBusy("");
    }
  }

  async function fromClipboard() {
    setErr("");
    setBusy("paste");
    try {
      const text = await clipRead();
      if (!text) throw new Error("The clipboard is empty.");
      await accept(text, "Clipboard", "imported-key");
    } catch (e) {
      if (alive.current) setErr(errText(e));
    } finally {
      if (alive.current) setBusy("");
    }
  }

  async function pasteKey(text: string) {
    setErr("");
    setBusy("paste");
    try {
      await accept(text, "Clipboard", "imported-key");
    } catch (e) {
      if (alive.current) setErr(errText(e));
    } finally {
      if (alive.current) setBusy("");
    }
  }

  async function save() {
    if (busy) return;
    const id = name.trim();
    const v = nameError(id, p.taken);
    if (v) {
      setErr(v);
      return;
    }
    if (!keyRef.current) {
      setErr(locked ? "Enter the passphrase of the key first." : "Choose a key file or paste a key first.");
      return;
    }
    setBusy("save");
    setErr("");
    try {
      if ((await api.secretList()).some((x) => x.id === id)) throw new Error("This name is already taken.");
      await api.secretPut(id, "private_key", keyRef.current);
      keyRef.current = null;
      await p.onDone(id);
    } catch (e) {
      if (!alive.current) return;
      setErr(errText(e));
      setBusy("");
    }
  }

  return (
    <Modal label="Import key" onClose={() => !busy && p.onClose()} width={460} dirty={!!loaded || !!locked || pass !== "" || name.trim() !== ""}>
      <div
        onPasteCapture={(e) => {
          const text = e.clipboardData.getData("text");
          if (!/PRIVATE KEY/.test(text)) return;
          e.preventDefault();
          if (!busy) void pasteKey(text);
        }}
        style={{ display: "contents" }}
      >
      <div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Import key</h2>
        <p style={{ margin: "6px 0 0", color: "var(--text-2)", lineHeight: 1.5 }}>Adds an OpenSSH or PEM private key to your vault.</p>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="button" onClick={fromFile} disabled={!!busy} style={{ ...pageBtn, ...disabledLook(!!busy) }}><Stable text={busy === "file" ? "Reading…" : "Choose file…"} alts={["Choose file…", "Reading…"]} /></button>
        <button type="button" onClick={fromClipboard} disabled={!!busy} style={{ ...pageBtn, ...disabledLook(!!busy) }}><Stable text={busy === "paste" ? "Reading…" : "Paste from clipboard"} alts={["Paste from clipboard", "Reading…"]} /></button>
      </div>
      <div style={{ height: 78, display: "flex", flexDirection: "column", justifyContent: "center", gap: 6, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-sunken)", boxSizing: "border-box" }}>
      {locked ? (
        <>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "flex", color: "var(--text-2)" }}><LockIcon size={14} /></span>
            <span title={locked.source} style={oneLine}>{locked.source} is protected by a passphrase.</span>
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="password"
              aria-label="Key passphrase"
              autoFocus
              value={pass}
              placeholder="Passphrase"
              disabled={busy === "unlock"}
              onChange={(e) => {
                setPass(e.target.value);
                setErr("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void unlock();
                }
              }}
              style={{ ...field, flex: 1, width: "auto" }}
            />
            <button type="button" onClick={() => void unlock()} disabled={!pass || !!busy} style={{ ...pageBtn, ...disabledLook(!pass || !!busy) }}><Stable text={busy === "unlock" ? "Unlocking…" : "Unlock"} alts={["Unlock", "Unlocking…"]} /></button>
          </div>
        </>
      ) : loaded ? (
        <>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "flex", color: "var(--ok)" }}><CheckIcon size={14} /></span>
            <span title={`${loaded.algo} key from ${loaded.source}`} style={oneLine}>{loaded.algo} key from {loaded.source}</span>
          </span>
          <code title={loaded.fp} style={{ ...oneLine, display: "block", fontFamily: MONO, fontSize: 12, color: "var(--text-2)" }}>{loaded.fp}</code>
        </>
      ) : (
        <span style={{ color: "var(--text-3)", textAlign: "center" }}>No key chosen yet</span>
      )}
      </div>
      <div>
        <label style={fieldLabel} htmlFor="ik-name">Name</label>
        <input
          id="ik-name"
          value={name}
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && loaded) save();
          }}
          placeholder="deploy-ed25519"
          style={field}
        />
      </div>
      <Actions
        err={err}
        primary={
          <button type="button" onClick={save} disabled={!loaded || !!busy} title={loaded ? undefined : locked ? "Enter the passphrase of the key first." : "Choose a key file or paste a key first."} style={{ ...primaryBtn, padding: "0 16px", ...disabledLook(!loaded || !!busy) }}>
            <Stable text={busy === "save" ? "Importing…" : "Import key"} alts={["Import key", "Importing…"]} />
          </button>
        }
        cancel={<CancelButton onClick={p.onClose} disabled={!!busy} />}
      />
      </div>
    </Modal>
  );
}

function UnlockBanner(p: { id: string; onUnlocked(): void }) {
  const alive = useAlive();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function unlock() {
    if (!pass || busy) return;
    setBusy(true);
    setErr("");
    try {
      const plain = await api.decryptKey(await api.secretReveal(p.id), pass);
      await api.secretPut(p.id, "private_key", plain.endsWith("\n") ? plain : `${plain}\n`);
      if (!alive.current) return;
      setPass("");
      p.onUnlocked();
    } catch (e) {
      if (alive.current) setErr(errText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", border: "1px solid var(--warn)", borderRadius: 8, background: "var(--warn-tint)" }}>
      <span style={{ display: "flex", alignItems: "flex-start", gap: 10, lineHeight: 1.5 }}>
        <span style={{ color: "var(--warn)", display: "flex", marginTop: 1 }}><WarningIcon /></span>
        This key is still locked by its own passphrase, so Kestral cannot sign in with it. Enter the passphrase once and the key is kept unlocked inside your encrypted vault.
      </span>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void unlock();
        }}
        style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
      >
        <input type="password" aria-label="Key passphrase" placeholder="Passphrase" value={pass} disabled={busy} onChange={(e) => { setPass(e.target.value); setErr(""); }} style={{ ...field, flex: "1 1 200px", width: "auto" }} />
        <button type="submit" disabled={!pass || busy} style={{ ...pageBtn, ...disabledLook(!pass || busy) }}><Stable text={busy ? "Unlocking…" : "Unlock key"} alts={["Unlock key", "Unlocking…"]} /></button>
      </form>
      {err && <p style={errLine}>{err}</p>}
    </div>
  );
}

function ExportKeyDialog(p: { id: string; onClose(): void; onDone(path: string, locked: boolean): void }) {
  const alive = useAlive();
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run() {
    if (busy) return;
    if (pass !== repeat) {
      setErr("The passphrases do not match.");
      return;
    }
    setErr("");
    let path: string | null;
    try {
      path = await saveDialog({ defaultPath: await freeExportPath(p.id), title: "Export private key" });
    } catch (e) {
      if (alive.current) setErr(errText(e));
      return;
    }
    if (!path || !alive.current) return;
    setBusy(true);
    try {
      await api.exportPrivateKey(p.id, path, pass || undefined);
      if (!alive.current) return;
      setPass("");
      setRepeat("");
      p.onDone(path, !!pass);
    } catch (e) {
      if (!alive.current) return;
      setErr(`Export failed: ${errText(e)}`);
      setBusy(false);
    }
  }

  return (
    <Modal label="Export private key" onClose={() => !busy && p.onClose()} dirty={pass !== "" || repeat !== ""}>
      <div>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Export private key</h2>
        <p style={{ margin: "6px 0 0", color: "var(--text-2)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
          Writes the private key of <strong style={{ color: "var(--text)" }}>{p.id}</strong> to a file. Anyone with the file can sign in where this key is trusted.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div>
          <label style={fieldLabel} htmlFor="ex-pass">Passphrase for the file</label>
          <input id="ex-pass" type="password" autoComplete="new-password" autoFocus value={pass} disabled={busy} onChange={(e) => { setPass(e.target.value); if (!e.target.value) setRepeat(""); setErr(""); }} style={field} />
        </div>
        <div>
          <label style={fieldLabel} htmlFor="ex-repeat">Repeat passphrase</label>
          <input id="ex-repeat" type="password" autoComplete="new-password" value={repeat} disabled={busy || !pass} onChange={(e) => { setRepeat(e.target.value); setErr(""); }} style={{ ...field, ...disabledLook(!pass) }} />
        </div>
        <p style={{ ...oneLine, margin: 0, fontSize: 12, color: pass ? "var(--text-3)" : "var(--warn)" }}>{pass ? "The file is encrypted with this passphrase." : "Without a passphrase the file holds the key unencrypted."}</p>
        <Actions
          err={err}
          primary={<button type="submit" disabled={busy} style={{ ...primaryBtn, padding: "0 16px", ...disabledLook(busy) }}><Stable text={busy ? "Exporting…" : "Choose file…"} alts={["Choose file…", "Exporting…"]} /></button>}
          cancel={<CancelButton onClick={p.onClose} disabled={busy} />}
        />
      </form>
    </Modal>
  );
}

const NEW_PASSWORD = "\tnew";

function IdentityDialog(p: { identity: Identity | null; identities: Identity[]; keys: SecretMeta[]; passwords: SecretMeta[]; allIds: string[]; onClose(): void; onDone(message: string): Promise<void> }) {
  const alive = useAlive();
  const init = p.identity;
  const initSecret = init ? directSecret(init.auth) ?? "" : "";
  const [name, setName] = useState(init?.name ?? "");
  const [user, setUser] = useState(init?.username ?? "");
  const [kind, setKind] = useState<DirectAuth["kind"]>(init?.auth.kind ?? (p.keys.length > 0 ? "key" : "password"));
  const [keyId, setKeyId] = useState(init?.auth.kind === "key" ? initSecret : p.keys[0]?.id ?? "");
  const [pwId, setPwId] = useState(init?.auth.kind === "password" ? initSecret : p.passwords[0]?.id ?? NEW_PASSWORD);
  const [pwName, setPwName] = useState("");
  const [pwValue, setPwValue] = useState("");
  const createdPw = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const keyOptions = keyId && !p.keys.some((k) => k.id === keyId) ? [...p.keys.map((k) => k.id), keyId] : p.keys.map((k) => k.id);
  const pwOptions = pwId && pwId !== NEW_PASSWORD && !p.passwords.some((k) => k.id === pwId) ? [...p.passwords.map((k) => k.id), pwId] : p.passwords.map((k) => k.id);
  const missing = (id: string, list: SecretMeta[]) => !list.some((s) => s.id === id);

  async function save() {
    if (busy) return;
    const n = name.trim();
    if (!n) return setErr("Enter a name.");
    if (p.identities.some((i) => i.id !== init?.id && i.name.trim().toLowerCase() === n.toLowerCase())) return setErr("An identity with this name already exists.");
    let auth: DirectAuth;
    let newPw: { id: string; value: string } | null = null;
    if (kind === "agent") auth = { kind: "agent" };
    else if (kind === "key") {
      if (!keyId) return setErr("Pick a key, or generate one on the Keys tab first.");
      auth = { kind: "key", secret_id: keyId };
    } else if (pwId === NEW_PASSWORD && !createdPw.current) {
      const pn = pwName.trim();
      const v = nameError(pn, p.allIds);
      if (v) return setErr(v === "Enter a name." ? "Enter a name for the password." : v);
      if (!pwValue) return setErr("Enter the password.");
      auth = { kind: "password", secret_id: pn };
      newPw = { id: pn, value: pwValue };
    } else auth = { kind: "password", secret_id: pwId === NEW_PASSWORD ? createdPw.current! : pwId };
    setBusy(true);
    setErr("");
    try {
      if (newPw) {
        if ((await api.secretList()).some((x) => x.id === newPw.id)) throw new Error("This name is already taken.");
        await api.secretPut(newPw.id, "password", newPw.value);
        createdPw.current = newPw.id;
        if (alive.current) setPwValue("");
      }
      if (init) await api.identityUpdate({ ...init, name: n, username: user.trim(), auth });
      else await api.identityAdd({ name: n, username: user.trim(), auth });
      await p.onDone(init ? `Saved ${n}.` : `Added ${n}.`);
    } catch (e) {
      if (!alive.current) return;
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <Modal label={init ? "Edit identity" : "Add identity"} onClose={() => !busy && p.onClose()} width={460} dirty={name !== (init?.name ?? "") || user !== (init?.username ?? "") || pwValue !== "" || (pwId === NEW_PASSWORD && pwName !== "")}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" }}>{init ? `Edit ${init.name}` : "Add identity"}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        <div>
          <label style={fieldLabel} htmlFor="id-name">Name</label>
          <input id="id-name" value={name} autoFocus spellCheck={false} disabled={busy} onChange={(e) => { setName(e.target.value); setErr(""); }} placeholder="deploy" style={field} />
        </div>
        <div>
          <label style={fieldLabel} htmlFor="id-user">User</label>
          <input id="id-user" value={user} spellCheck={false} autoCapitalize="off" disabled={busy} onChange={(e) => { setUser(e.target.value); setErr(""); }} placeholder="Use the host's user" style={{ ...field, fontFamily: MONO, fontSize: 12.5 }} />
          <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-3)" }}>Leave empty to keep the user set on each host.</p>
        </div>
        <div>
          <span style={fieldLabel}>Sign in with</span>
          <Segmented
            label="Sign in with"
            value={kind}
            disabled={busy}
            options={[
              { id: "key", label: "Key" },
              { id: "password", label: "Password" },
              { id: "agent", label: "SSH agent" },
            ]}
            onChange={(k) => {
              setKind(k);
              setErr("");
            }}
          />
        </div>
        {kind === "key" &&
          (keyOptions.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-2)" }}>Your vault has no keys yet. Generate or import one on the Keys tab first.</p>
          ) : (
            <div>
              <label style={fieldLabel} htmlFor="id-key">Key</label>
              <select id="id-key" value={keyId} disabled={busy} onChange={(e) => setKeyId(e.target.value)} style={{ ...field, padding: "0 8px" }}>
                {keyOptions.map((id) => (
                  <option key={id} value={id}>{missing(id, p.keys) ? `${id} (missing)` : id}</option>
                ))}
              </select>
            </div>
          ))}
        {kind === "password" && (
          <>
            <div>
              <label style={fieldLabel} htmlFor="id-pw">Password</label>
              <select
                id="id-pw"
                value={pwId}
                disabled={busy}
                onChange={(e) => {
                  setPwId(e.target.value);
                  setErr("");
                  if (e.target.value === NEW_PASSWORD && !pwName.trim()) setPwName(freeName(`${name.trim() || "identity"}-password`, p.allIds));
                }}
                style={{ ...field, padding: "0 8px" }}
              >
                {pwOptions.map((id) => (
                  <option key={id} value={id}>{missing(id, p.passwords) ? `${id} (missing)` : id}</option>
                ))}
                <option value={NEW_PASSWORD}>{createdPw.current ? createdPw.current : "New password…"}</option>
              </select>
            </div>
            {pwId === NEW_PASSWORD && !createdPw.current && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                <div>
                  <label style={fieldLabel} htmlFor="id-pw-name">Password name</label>
                  <input id="id-pw-name" value={pwName} spellCheck={false} disabled={busy} onChange={(e) => { setPwName(e.target.value); setErr(""); }} placeholder="prod-root" style={field} />
                </div>
                <div>
                  <label style={fieldLabel} htmlFor="id-pw-value">Password</label>
                  <input id="id-pw-value" type="password" autoComplete="new-password" value={pwValue} disabled={busy} onChange={(e) => { setPwValue(cleanText(e.target.value)); setErr(""); }} style={field} />
                </div>
              </div>
            )}
          </>
        )}
        {kind === "agent" && <p style={{ margin: 0, fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>Signs in with the keys of the SSH agent running on this computer. The Agent tab shows which keys it holds.</p>}
        <Actions
          err={err}
          primary={<button type="submit" disabled={busy} style={{ ...primaryBtn, padding: "0 16px", ...disabledLook(busy) }}><Stable text={busy ? "Saving…" : init ? "Save" : "Add identity"} alts={[init ? "Save" : "Add identity", "Saving…"]} /></button>}
          cancel={<CancelButton onClick={p.onClose} disabled={busy} />}
        />
      </form>
    </Modal>
  );
}

function PasswordDialog(p: { secret: SecretMeta | null; taken: string[]; onClose(): void; onDone(message: string): Promise<void> }) {
  const alive = useAlive();
  const editing = p.secret !== null;
  const [name, setName] = useState(p.secret?.id ?? "");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function save() {
    if (busy) return;
    const id = p.secret ? p.secret.id : name.trim();
    if (!p.secret) {
      const v = nameError(id, p.taken);
      if (v) {
        setErr(v);
        return;
      }
    }
    if (!value) {
      setErr("Enter the password.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      if (!p.secret && (await api.secretList()).some((x) => x.id === id)) throw new Error("This name is already taken.");
      await api.secretPut(id, "password", value);
      setValue("");
      await p.onDone(editing ? `Changed ${id}.` : `Added ${id}.`);
    } catch (e) {
      if (!alive.current) return;
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <Modal label={editing ? "Change password" : "Add password"} onClose={() => !busy && p.onClose()} dirty={(!editing && name !== "") || value !== ""}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, overflowWrap: "anywhere" }}>{p.secret ? `Change ${p.secret.id}` : "Add password"}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
      >
        {!editing && (
          <div>
            <label style={fieldLabel} htmlFor="pw-name">Name</label>
            <input id="pw-name" value={name} spellCheck={false} onChange={(e) => { setName(e.target.value); setErr(""); }} placeholder="prod-root" style={field} />
          </div>
        )}
        <div>
          <label style={fieldLabel} htmlFor="pw-value">{editing ? "New password" : "Password"}</label>
          <input id="pw-value" type="password" autoComplete="new-password" value={value} onChange={(e) => { setValue(cleanText(e.target.value)); setErr(""); }} style={field} />
          {p.secret && <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-3)" }}>Hosts that use {p.secret.id} sign in with the new password from now on.</p>}
        </div>
        <Actions
          err={err}
          primary={<button type="submit" disabled={busy} style={{ ...primaryBtn, padding: "0 16px", ...disabledLook(busy) }}><Stable text={busy ? "Saving…" : editing ? "Change password" : "Add password"} alts={[editing ? "Change password" : "Add password", "Saving…"]} /></button>}
          cancel={<CancelButton onClick={p.onClose} disabled={busy} />}
        />
      </form>
    </Modal>
  );
}

function ShowPrivateKeyDialog(p: { id: string; onClose(): void }) {
  const alive = useAlive();
  const [pem, setPem] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [copied, flash] = useFlash();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    api
      .secretReveal(p.id)
      .then((v) => alive.current && setPem(v))
      .catch((e) => alive.current && setErr(errText(e)));
  }, [p.id, alive]);
  return (
    <Modal label="Private key" onClose={p.onClose} width={560} initialFocus={closeRef}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{p.id}</h2>
      <pre data-selectable style={{ margin: 0, height: 260, overflow: "auto", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: err ? "var(--err)" : "var(--text)" }}>
        {err || pem || ""}
      </pre>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          disabled={!pem}
          onClick={() => {
            if (!pem) return;
            void clipWrite(pem)
              .then(() => alive.current && flash())
              .catch((e) => alive.current && setErr(errText(e)));
          }}
          style={{ ...outlineBtn, ...disabledLook(!pem) }}
        >
          {copied ? <CheckIcon size={14} /> : <CopyIcon />}
          <Stable text={copied ? "Copied" : "Copy"} alts={["Copy", "Copied"]} />
        </button>
        <button ref={closeRef} type="button" onClick={p.onClose} style={outlineBtn}>
          Close
        </button>
      </div>
    </Modal>
  );
}
