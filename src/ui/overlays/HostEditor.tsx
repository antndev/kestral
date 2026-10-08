import { ClipboardEvent, CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readText as clipReadText, writeText as clipWriteText } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "../../api";
import type { AiPolicy, AuthMethod, ForwardKind, Host, Identity, KeyAlgorithm, LocalAgentInfo, NewHost, PortForward, PubkeyInfo, SecretMeta } from "../../api";
import { TERMINAL_THEMES } from "../../lib/terminal-themes";
import { IS_MAC, MONO, errText } from "../mock";
import { CheckIcon, ChevronIcon, CloseIcon, CopyIcon, PlusIcon, TrashIcon } from "../icons";
import { ConfirmDialog, Overlay, useModalLayer } from "./Dialogs";
import { Stable } from "../Stable";

type AuthKind = AuthMethod["kind"];
type Errors = Record<string, string>;
type EnvDraft = { id: string; name: string; value: string };

interface ForwardDraft {
  id: string;
  name: string;
  local_host: string;
  local_port: string;
  remote_host: string;
  remote_port: string;
  autostart: boolean;
  kind: ForwardKind;
  start_on_connect: boolean;
}

const NEW = "__new__";
const KEY_ALGOS: { value: KeyAlgorithm; label: string }[] = [
  { value: "ed25519", label: "ED25519" },
  { value: "ecdsa-p256", label: "ECDSA P-256" },
  { value: "ecdsa-p384", label: "ECDSA P-384" },
  { value: "ecdsa-p521", label: "ECDSA P-521" },
  { value: "rsa-3072", label: "RSA 3072" },
  { value: "rsa-4096", label: "RSA 4096" },
];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEST_FIELDS = ["hostname", "port", "username", "password", "key", "identity"];
const inAdvanced = (k: string) => k === "keepalive" || k === "timeout" || k.startsWith("env:") || k.startsWith("fwd:");

const labelStyle: CSSProperties = { display: "block", marginBottom: 6, fontSize: 12, fontWeight: 500, color: "var(--text-2)" };
const labelRow: CSSProperties = { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, minWidth: 0 };
const rowMsg: CSSProperties = { flex: "1 1 0", minWidth: 0, fontSize: 12, color: "var(--err)", textAlign: "right", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const h3Style: CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600 };
const sectionStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 12 };
const grid2: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 };
const hint: CSSProperties = { margin: 0, fontSize: 12, color: "var(--text-2)", lineHeight: 1.45 };
const errStyle: CSSProperties = { display: "block", marginTop: 4, fontSize: 12, color: "var(--err)", overflowWrap: "anywhere" };
const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
const chip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%", minWidth: 0, height: 22, padding: "0 4px 0 8px", borderRadius: 11, background: "var(--bg-raised)", fontSize: 12, color: "var(--text)", boxSizing: "border-box" };
const panel: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: 12, border: "1px solid var(--line)", borderRadius: 8 };

function inputStyle(opts: { error?: boolean; mono?: boolean; disabled?: boolean } = {}): CSSProperties {
  return {
    width: "100%",
    height: 32,
    padding: "0 10px",
    border: `1px solid ${opts.error ? "var(--err)" : "var(--line)"}`,
    borderRadius: 6,
    background: "var(--bg-sunken)",
    color: "var(--text)",
    boxSizing: "border-box",
    ...(opts.mono ? { fontFamily: MONO, fontSize: 12.5 } : null),
    ...(opts.disabled ? { opacity: 0.55, cursor: "not-allowed" } : null),
  };
}
function selectStyle(opts: { error?: boolean; disabled?: boolean } = {}): CSSProperties {
  return { ...inputStyle(opts), padding: "0 8px" };
}
function btn(kind: "primary" | "secondary" | "danger", opts: { small?: boolean; disabled?: boolean } = {}): CSSProperties {
  const base: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: 6, height: opts.small ? 28 : 32, padding: opts.small ? "0 10px" : kind === "primary" ? "0 16px" : "0 14px", borderRadius: 6, fontSize: opts.small ? 12 : 13, boxSizing: "border-box", whiteSpace: "nowrap", cursor: opts.disabled ? "default" : "pointer", opacity: opts.disabled ? 0.55 : 1, flex: "none" };
  if (kind === "primary") return { ...base, border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500 };
  if (kind === "danger") return { ...base, border: "1px solid var(--err)", background: "transparent", color: "var(--err)" };
  return { ...base, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--text)" };
}
const iconBtn: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, padding: 0, border: 0, borderRadius: 6, background: "transparent", color: "var(--text-2)", cursor: "pointer", flex: "none" };

/** Strips invisible characters that sneak in when pasting from web pages and chat apps. */
function cleanText(text: string): string {
  return text.replace(/﻿/g, "").replace(/[​-‍⁠]/g, "").replace(/ /g, " ").replace(/\r\n?/g, "\n");
}
function pasteClean(e: ClipboardEvent<HTMLInputElement>, onChange: (v: string) => void) {
  const raw = e.clipboardData.getData("text");
  if (!raw) return;
  e.preventDefault();
  const el = e.currentTarget;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const ins = cleanText(raw).replace(/\n+/g, " ").trim();
  onChange(el.value.slice(0, start) + ins + el.value.slice(end));
}

/** Passwords keep their spaces, but a trailing line break from a copied file would make the login fail invisibly. */
function cleanPassword(v: string): string {
  return cleanText(v).replace(/\n+/g, "");
}

function digits(v: string): string {
  return v.replace(/\D/g, "").slice(0, 5);
}
function clampPortText(v: string): string {
  if (!v) return v;
  const n = parseInt(v, 10);
  return String(Math.min(65535, Math.max(1, Number.isFinite(n) ? n : 1)));
}
function validPort(v: string): boolean {
  if (!/^\d+$/.test(v)) return false;
  const n = Number(v);
  return n >= 1 && n <= 65535;
}

/** A local bind that stays on this machine: empty, loopback IPs, or "localhost". */
function isLoopbackBind(host: string): boolean {
  const v = host.trim().toLowerCase();
  return v === "" || v === "127.0.0.1" || v === "localhost" || v === "::1";
}

function sshKeyType(publicKey: string): string {
  const t = (publicKey.trim().split(/\s+/)[0] || "").toLowerCase();
  if (t === "ssh-ed25519") return "ED25519";
  if (t === "sk-ssh-ed25519@openssh.com") return "ED25519-SK";
  if (t === "ssh-rsa") return "RSA";
  if (t === "ssh-dss") return "DSA";
  if (t.startsWith("ecdsa-sha2-")) return "ECDSA " + t.replace("ecdsa-sha2-nistp", "P-");
  if (t.startsWith("sk-ecdsa-sha2-")) return "ECDSA-SK";
  return t || "Key";
}

function uniqueId(base: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  const b = base.trim() || "key";
  if (!lower.has(b.toLowerCase())) return b;
  for (let i = 2; ; i++) if (!lower.has(`${b}-${i}`.toLowerCase())) return `${b}-${i}`;
}
function uniqueLabel(base: string, hosts: Host[]): string {
  const b = base.trim();
  const taken = new Set(hosts.map((h) => h.name.trim().toLowerCase()));
  if (!b || !taken.has(b.toLowerCase())) return base;
  const sep = /\s/.test(b) ? " " : "-";
  for (let i = 2; ; i++) if (!taken.has(`${b}${sep}${i}`.toLowerCase())) return `${b}${sep}${i}`;
}
function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
}
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function toDraft(f: PortForward): ForwardDraft {
  return { id: f.id, name: f.name ?? "", local_host: f.local_host, local_port: String(f.local_port), remote_host: f.remote_host, remote_port: String(f.remote_port), autostart: f.autostart, kind: f.kind ?? "local", start_on_connect: !!f.start_on_connect };
}
function fromDraft(d: ForwardDraft): PortForward {
  const remotePort = d.kind === "dynamic" ? 0 : Number(d.remote_port);
  return {
    id: d.id,
    name: d.name.trim(),
    local_host: d.local_host.trim() || (d.kind === "remote" ? "localhost" : "127.0.0.1"),
    local_port: Number(d.local_port),
    remote_host: d.kind === "dynamic" ? "" : d.remote_host.trim() || (d.kind === "remote" ? "localhost" : ""),
    remote_port: remotePort,
    autostart: d.autostart,
    kind: d.kind,
    start_on_connect: d.start_on_connect,
  };
}

/** Splits "user@host:port" typed into the address field into its parts. */
function splitAddress(raw: string): { username?: string; hostname: string; port?: string } | null {
  let s = raw.trim();
  const url = /^ssh:\/\//i.test(s);
  if (url) s = s.slice(6).replace(/\/+$/, "");
  if (!s.includes("@") && !/^[^:\s]+:\d+$/.test(s) && !/^\[.+\]:\d+$/.test(s)) return url ? { hostname: s.replace(/^\[(.+)\]$/, "$1") } : null;
  let username: string | undefined;
  const at = s.lastIndexOf("@");
  if (at >= 0) {
    username = s.slice(0, at) || undefined;
    s = s.slice(at + 1);
  }
  let port: string | undefined;
  const v6 = s.match(/^\[(.+)\](?::(\d+))?$/);
  if (v6) return { username, hostname: v6[1], port: v6[2] };
  if (s.split(":").length === 2) {
    const [h, p] = s.split(":");
    if (/^\d+$/.test(p)) {
      s = h;
      port = p;
    }
  }
  return { username, hostname: s, port };
}

function LabelRow({ htmlFor, label, msg, msgId, warn, tip, style }: { htmlFor?: string; label: ReactNode; msg?: string; msgId?: string; warn?: boolean; tip?: string; style?: CSSProperties }) {
  const text: CSSProperties = { fontSize: 12, fontWeight: 500, color: "var(--text-2)" };
  return (
    <div style={{ ...labelRow, ...style }}>
      {htmlFor ? <label htmlFor={htmlFor} style={text}>{label}</label> : <span style={text}>{label}</span>}
      <span id={msgId} role="alert" title={msg ? tip ?? msg : undefined} style={warn ? { ...rowMsg, color: "var(--warn)" } : rowMsg}>
        {msg}
      </span>
    </div>
  );
}

function Field({ id, label, error, warn, tip, children }: { id: string; label: ReactNode; error?: string; warn?: string; tip?: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <LabelRow htmlFor={id} label={label} msg={error || warn} msgId={`${id}-err`} warn={!error && !!warn} tip={error ? undefined : tip} />
      {children}
    </div>
  );
}

function Segmented<T extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange(v: T): void }) {
  const [focused, setFocused] = useState<T | null>(null);
  return (
    <fieldset style={{ margin: 0, padding: 0, border: 0, minWidth: 0 }}>
      <legend style={srOnly}>{legend}</legend>
      <div style={{ display: "inline-flex", padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)" }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label
              key={o.value}
              title={o.title}
              style={{ position: "relative", display: "flex", alignItems: "center", height: 26, padding: "0 12px", borderRadius: 4, background: on ? "var(--bg)" : "transparent", boxShadow: focused === o.value ? "0 0 0 2px var(--focus)" : on ? "0 0 0 1px var(--line)" : "none", color: on ? "var(--text)" : "var(--text-2)", cursor: o.disabled ? "not-allowed" : "pointer", opacity: o.disabled ? 0.5 : 1, whiteSpace: "nowrap" }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
                onFocus={(e) => e.currentTarget.matches(":focus-visible") && setFocused(o.value)}
                onBlur={() => setFocused(null)}
                style={srOnly}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Toggle({ on, label, onChange, describedBy }: { on: boolean; label: string; onChange(v: boolean): void; describedBy?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={() => onChange(!on)}
      style={{ position: "relative", display: "block", flex: "none", width: 30, height: 18, padding: 0, border: 0, borderRadius: 9, background: on ? "var(--ok)" : "var(--light-ring)", cursor: "pointer" }}
    >
      <span aria-hidden="true" style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "#FFFFFF", transition: "left 120ms ease" }} />
    </button>
  );
}

function CopyTextButton({ text, label, ariaLabel }: { text: string; label: string; ariaLabel?: string }) {
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!done && !err) return;
    const t = setTimeout(() => {
      setDone(false);
      setErr(false);
    }, 1500);
    return () => clearTimeout(t);
  }, [done, err]);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() =>
        clipWriteText(text).then(
          () => setDone(true),
          () => setErr(true),
        )
      }
      style={{ ...btn("secondary", { small: true }), color: err ? "var(--err)" : "var(--text)" }}
    >
      {done ? <CheckIcon /> : <CopyIcon size={13} />}
      <Stable text={done ? "Copied" : err ? "Copy failed" : label} alts={[label, "Copied", "Copy failed"]} />
    </button>
  );
}

function KeyInfo({ info }: { info: PubkeyInfo }) {
  const key: CSSProperties = { color: "var(--text-2)" };
  const value: CSSProperties = { minWidth: 0, fontFamily: MONO, fontSize: 12, overflowWrap: "anywhere", wordBreak: "break-all", userSelect: "text" };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "80px minmax(0, 1fr) auto", alignItems: "center", gap: "6px 10px", padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", fontSize: 12 }}>
      <span style={key}>Type</span>
      <span style={{ gridColumn: "2 / 4", fontWeight: 500 }}>{sshKeyType(info.public_key)}</span>
      <span style={key}>Fingerprint</span>
      <code data-selectable style={value}>{info.fingerprint}</code>
      <CopyTextButton text={info.fingerprint} label="Copy" ariaLabel="Copy fingerprint" />
      <span style={key}>Public key</span>
      <code data-selectable style={{ ...value, color: "var(--text-2)" }}>{info.public_key}</code>
      <CopyTextButton text={info.public_key} label="Copy" ariaLabel="Copy public key" />
    </div>
  );
}

function sameEndpoint(a: PortForward, b: PortForward): boolean {
  const bind = (h: string) => (isLoopbackBind(h) ? "loopback" : h.trim().toLowerCase());
  return bind(a.local_host) === bind(b.local_host) && a.local_port === b.local_port && a.remote_host.trim() === b.remote_host.trim() && a.remote_port === b.remote_port;
}
function authRef(h: Pick<Host, "auth">): string {
  return h.auth.kind === "agent" ? "" : h.auth.kind === "identity" ? h.auth.identity_id : h.auth.secret_id;
}
function sameConnection(a: Host, b: Host): boolean {
  return a.hostname === b.hostname && a.port === b.port && a.username === b.username && a.auth.kind === b.auth.kind && authRef(a) === authRef(b) && (a.jump_host_id ?? "") === (b.jump_host_id ?? "");
}
function forwardText(f: PortForward): string {
  if (f.name.trim()) return f.name.trim();
  if (f.kind === "dynamic") return `SOCKS on ${f.local_port}`;
  if (f.kind === "remote") return `host ${f.remote_port} → ${f.local_host}:${f.local_port}`;
  return `${f.local_port} → ${f.remote_host}:${f.remote_port}`;
}

function Frame({ inline, z, onBackdrop, children }: { inline: boolean; z: number; onBackdrop(): void; children: ReactNode }) {
  if (inline) return <>{children}</>;
  return (
    <Overlay z={z} align="flex-start" padding="52px 16px 24px" onBackdrop={onBackdrop}>
      {children}
    </Overlay>
  );
}

export function HostEditor(p: {
  host: Host | null;
  prefill?: Partial<NewHost>;
  hosts: Host[];
  connectAfterSave?: boolean;
  inline?: boolean;
  onClose(): void;
  onSaved(h: Host, connect: boolean): void;
  onDirtyChange?(dirty: boolean): void;
}) {
  const { host, hosts } = p;
  const src: Partial<NewHost> = host ?? p.prefill ?? {};
  const uid = useId();
  const fid = (s: string) => `${uid}-${s}`;

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Vault secrets (ids and kinds only).
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [secretsLoaded, setSecretsLoaded] = useState(false);
  const [secretsErr, setSecretsErr] = useState("");
  const [secretsRetrying, setSecretsRetrying] = useState(false);
  const reloadSecrets = useCallback(async () => {
    try {
      const list = await api.secretList();
      if (!alive.current) return list;
      setSecrets(list);
      setSecretsErr("");
      setSecretsLoaded(true);
      return list;
    } catch (e) {
      if (alive.current) setSecretsErr(errText(e));
      return null;
    }
  }, []);
  useEffect(() => {
    void reloadSecrets();
  }, [reloadSecrets]);
  async function retrySecrets() {
    setSecretsRetrying(true);
    await reloadSecrets();
    if (alive.current) setSecretsRetrying(false);
  }
  const keyIds = useMemo(() => secrets.filter((s) => s.kind === "private_key").map((s) => s.id), [secrets]);
  const pwIds = useMemo(() => secrets.filter((s) => s.kind === "password").map((s) => s.id), [secrets]);

  // General
  const [name, setName] = useState(() => (host ? host.name : uniqueLabel(src.name ?? "", hosts)));
  const [tags, setTags] = useState<string[]>(src.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [tagFocus, setTagFocus] = useState(false);

  // Connection
  const [hostname, setHostname] = useState(src.hostname ?? "");
  const [port, setPort] = useState(String(src.port ?? 22));
  const [username, setUsername] = useState(src.username ?? "");

  // Authentication
  const initialKind: AuthKind = src.auth?.kind ?? "key";
  const [authKind, setAuthKind] = useState<AuthKind>(initialKind);
  const authTouched = useRef(!!src.auth);
  const initialSecret = src.auth && (src.auth.kind === "password" || src.auth.kind === "key") ? src.auth.secret_id : "";
  const [identitySel, setIdentitySel] = useState(src.auth?.kind === "identity" ? src.auth.identity_id : "");
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [identitiesLoaded, setIdentitiesLoaded] = useState(false);
  useEffect(() => {
    api
      .identityList()
      .then((list) => {
        if (!alive.current) return;
        setIdentities(list);
        setIdentitiesLoaded(true);
        setIdentitySel((cur) => (cur && list.some((i) => i.id === cur) ? cur : cur || list[0]?.id || ""));
      })
      .catch(() => alive.current && setIdentitiesLoaded(true));
  }, []);
  const [agentInfo, setAgentInfo] = useState<LocalAgentInfo | null>(null);
  const [jumpId, setJumpId] = useState(src.jump_host_id ?? "");
  const opts = src.options ?? api.DEFAULT_HOST_OPTIONS;
  const [keepalive, setKeepalive] = useState(opts.keepalive_secs == null ? "" : String(opts.keepalive_secs));
  const [connectTimeout, setConnectTimeout] = useState(opts.connect_timeout_secs == null ? "" : String(opts.connect_timeout_secs));
  const [termTheme, setTermTheme] = useState(opts.terminal_theme ?? "");
  const [encoding, setEncoding] = useState(opts.encoding || "utf-8");
  const [startup, setStartup] = useState(opts.startup_command ?? "");
  const [envVars, setEnvVars] = useState<EnvDraft[]>(() => (opts.env ?? []).map((v) => ({ id: crypto.randomUUID(), name: v.name, value: v.value })));
  const [pwSel, setPwSel] = useState(src.auth?.kind === "password" && src.auth.secret_id ? src.auth.secret_id : NEW);
  const [pwChanging, setPwChanging] = useState(false);
  const [pwValue, setPwValue] = useState("");
  const [pwName, setPwName] = useState("");
  const [keySel, setKeySel] = useState(src.auth?.kind === "key" ? initialSecret : "");
  const [forwardAgent, setForwardAgent] = useState(src.forward_agent ?? false);
  const [agentKeys, setAgentKeys] = useState<string[]>(src.agent_keys ?? []);

  const effPwSel = secretsLoaded && pwSel !== NEW && !pwIds.includes(pwSel) ? NEW : pwSel;
  const authBase = useRef<{ kind: AuthKind; key: string; pw: string; identity: string } | null>(null);
  const touchAuth = () => {
    if (!authBase.current) authBase.current = { kind: authKind, key: keySel, pw: effPwSel, identity: identitySel };
  };
  useEffect(() => {
    if (authKind !== "agent" || agentInfo) return;
    api
      .localAgentIdentities()
      .then((i) => alive.current && setAgentInfo(i))
      .catch((e) => alive.current && setAgentInfo({ agent: null, keys: [], error: errText(e) }));
  }, [authKind, agentInfo]);
  const jumpChoices = useMemo(() => {
    const self = host?.id;
    const loops = (h: Host) => {
      const seen = new Set<string>();
      let cur: Host | undefined = h;
      while (cur) {
        if (cur.id === self) return true;
        if (seen.has(cur.id) || !cur.jump_host_id) return false;
        seen.add(cur.id);
        const next: string = cur.jump_host_id;
        cur = hosts.find((x) => x.id === next);
      }
      return false;
    };
    return hosts.filter((h) => h.id !== self && !loops(h));
  }, [hosts, host]);
  const pwShared = useMemo(
    () => (effPwSel === NEW ? [] : hosts.filter((h) => h.id !== host?.id && h.auth.kind === "password" && h.auth.secret_id === effPwSel).map((h) => h.name)),
    [hosts, host, effPwSel],
  );

  useEffect(() => {
    if (!secretsLoaded) return;
    if (!authTouched.current && keyIds.length === 0) setAuthKind("password");
    if (!keySel) setKeySel(keyIds[0] ?? "");
    // keySel is intentionally not a dependency: this only fills a default when the list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secretsLoaded, keyIds]);

  // Port forwards
  const [forwards, setForwards] = useState<ForwardDraft[]>((src.forwards ?? []).map(toDraft));
  const patchForward = (id: string, patch: Partial<ForwardDraft>) => setForwards((cur) => cur.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  // AI access
  const [aiPolicy, setAiPolicy] = useState<AiPolicy>(src.ai_policy ?? "locked");
  const [aiFilePolicy, setAiFilePolicy] = useState<AiPolicy>(src.ai_file_policy ?? "locked");

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [saveErr, setSaveErr] = useState("");
  const [busy, setBusy] = useState<null | "save" | "connect">(null);
  // Set when the host was saved but a follow-up step (new password, tunnel restart) failed.
  const [saved, setSaved] = useState<Host | null>(null);
  const current = saved ?? host;
  const editing = current !== null;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [test, setTest] = useState<{ state: "idle" | "busy" | "ok" | "err"; msg: string }>({ state: "idle", msg: "" });

  const clearErr = (...keys: string[]) =>
    setErrors((cur) => {
      if (!keys.some((k) => k in cur)) return cur;
      const n = { ...cur };
      for (const k of keys) delete n[k];
      return n;
    });

  // ---- Key details, generate and import ----
  const [keyInfo, setKeyInfo] = useState<Record<string, PubkeyInfo | { error: string }>>({});
  useEffect(() => {
    if (authKind !== "key" || !keySel || !keyIds.includes(keySel) || keyInfo[keySel]) return;
    let live = true;
    (async () => {
      try {
        const info = await api.derivePubkey(await api.secretReveal(keySel));
        if (live && alive.current) setKeyInfo((m) => ({ ...m, [keySel]: info }));
      } catch (e) {
        if (live && alive.current) setKeyInfo((m) => ({ ...m, [keySel]: { error: errText(e) } }));
      }
    })();
    return () => {
      live = false;
    };
  }, [authKind, keySel, keyIds, keyInfo]);

  const [keyPanel, setKeyPanel] = useState<null | "generate" | "import">(null);
  const dialogRef = useRef<HTMLElement>(null);
  const focusTarget = useRef<string | null>(null);
  const rescueFocus = (selector: string) => {
    focusTarget.current = selector;
  };
  useEffect(() => {
    const selector = focusTarget.current;
    if (!selector) return;
    focusTarget.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    dialogRef.current?.querySelector<HTMLElement>(selector)?.focus();
  });
  const [genName, setGenName] = useState("");
  const [genAlgo, setGenAlgo] = useState<KeyAlgorithm>("ed25519");
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState("");
  const [justCreated, setJustCreated] = useState("");

  const [impName, setImpName] = useState("");
  const [impSource, setImpSource] = useState("");
  const [impInfo, setImpInfo] = useState<PubkeyInfo | null>(null);
  const [impBusy, setImpBusy] = useState<null | "load" | "save">(null);
  const [impErr, setImpErr] = useState("");
  const [impLocked, setImpLocked] = useState(false);
  const [impPass, setImpPass] = useState("");
  // The private key stays out of React state and is never rendered.
  const impPem = useRef<string | null>(null);
  useEffect(
    () => () => {
      impPem.current = null;
    },
    [],
  );

  const allSecretIds = secrets.map((s) => s.id);
  /** Fresh ids straight from the vault, so a new secret can never overwrite an existing one. */
  const takenIds = async () => (await api.secretList()).map((s) => s.id.toLowerCase());

  function openGenerate() {
    setKeyPanel("generate");
    setGenErr("");
    setGenName(uniqueId(`${slug(name || hostname)}-${genAlgo}`, allSecretIds));
  }
  function openImport() {
    setKeyPanel("import");
    setImpErr("");
    setImpName("");
    setImpSource("");
    setImpInfo(null);
    setImpLocked(false);
    setImpPass("");
    impPem.current = null;
  }
  function closeKeyPanel() {
    if (keyPanel) rescueFocus(`[data-focus="${keyPanel}"]`);
    setKeyPanel(null);
    impPem.current = null;
    setImpInfo(null);
  }

  async function generate() {
    const id = genName.trim();
    if (!id) return setGenErr("Enter a name for the key");
    setGenBusy(true);
    setGenErr("");
    try {
      if ((await takenIds()).includes(id.toLowerCase())) throw "A key or password with this name already exists";
      const pem = await api.generateKey(genAlgo, id);
      await api.secretPut(id, "private_key", pem);
      await reloadSecrets();
      if (!alive.current) return;
      touchAuth();
      setKeySel(id);
      setJustCreated(id);
      clearErr("key");
      rescueFocus('[data-field="key"]');
      setKeyPanel(null);
    } catch (e) {
      if (alive.current) setGenErr(errText(e));
    } finally {
      if (alive.current) setGenBusy(false);
    }
  }

  async function loadKeyText(text: string, source: string) {
    const pem = cleanText(text).trim();
    if (/^(ssh-|ecdsa-|sk-)/.test(pem) || pem.includes("PUBLIC KEY")) throw "That is a public key. Pick the private key, usually the file without .pub.";
    if (!pem.includes("PRIVATE KEY")) throw "No private key found. It should start with -----BEGIN OPENSSH PRIVATE KEY-----.";
    let info: PubkeyInfo | null = null;
    try {
      info = await api.derivePubkey(pem);
    } catch (e) {
      if (!api.isPassphraseError(e)) throw `Could not read the key. (${errText(e)})`;
    }
    impPem.current = pem;
    setImpSource(source);
    setImpPass("");
    if (!info || info.encrypted) {
      setImpLocked(true);
      setImpInfo(info);
      return;
    }
    setImpLocked(false);
    setImpInfo(info);
  }

  async function unlockImported() {
    if (!impPem.current || !impPass) return;
    setImpBusy("load");
    setImpErr("");
    try {
      const plain = await api.decryptKey(impPem.current, impPass);
      const info = await api.derivePubkey(plain);
      if (!alive.current) return;
      impPem.current = plain;
      setImpPass("");
      setImpLocked(false);
      setImpInfo(info);
    } catch (e) {
      if (alive.current) setImpErr(errText(e));
    } finally {
      if (alive.current) setImpBusy(null);
    }
  }

  async function importFromFile() {
    setImpErr("");
    try {
      let defaultPath: string | undefined;
      try {
        const home = await api.localHome();
        defaultPath = home + (home.includes("\\") ? "\\.ssh" : "/.ssh");
      } catch {
        defaultPath = undefined;
      }
      const picked = await openDialog({ multiple: false, directory: false, defaultPath, title: "Import a private key" });
      if (typeof picked !== "string") return;
      setImpBusy("load");
      const text = await api.localReadText(picked);
      await loadKeyText(text, baseName(picked));
      if (!alive.current) return;
      if (!impName.trim()) setImpName(uniqueId(baseName(picked).replace(/\.(pem|key|ppk)$/i, ""), allSecretIds));
    } catch (e) {
      if (alive.current) {
        impPem.current = null;
        setImpInfo(null);
        setImpErr(errText(e));
      }
    } finally {
      if (alive.current) setImpBusy(null);
    }
  }

  async function importFromClipboard() {
    setImpErr("");
    setImpBusy("load");
    try {
      const text = await clipReadText();
      if (!text) throw "The clipboard is empty.";
      await loadKeyText(text, "the clipboard");
      if (alive.current && !impName.trim()) setImpName(uniqueId(`${slug(name || hostname)}-key`, allSecretIds));
    } catch (e) {
      if (alive.current) {
        impPem.current = null;
        setImpInfo(null);
        setImpErr(errText(e));
      }
    } finally {
      if (alive.current) setImpBusy(null);
    }
  }

  async function saveImported() {
    const id = impName.trim();
    if (!impPem.current) return setImpErr("Choose a key file or paste a key first");
    if (!id) return setImpErr("Enter a name for the key");
    setImpBusy("save");
    setImpErr("");
    try {
      if ((await takenIds()).includes(id.toLowerCase())) throw "A key or password with this name already exists";
      await api.secretPut(id, "private_key", impPem.current);
      impPem.current = null;
      await reloadSecrets();
      if (!alive.current) return;
      touchAuth();
      setKeySel(id);
      clearErr("key");
      rescueFocus('[data-field="key"]');
      setKeyPanel(null);
      setImpInfo(null);
    } catch (e) {
      if (alive.current) setImpErr(errText(e));
    } finally {
      if (alive.current) setImpBusy(null);
    }
  }

  // ---- Tags ----
  function addTags(raw: string) {
    const parts = raw.split(",").map((t) => t.trim()).filter(Boolean);
    if (parts.length === 0) return;
    setTags((cur) => {
      const next = [...cur];
      for (const t of parts) if (!next.some((x) => x.toLowerCase() === t.toLowerCase())) next.push(t);
      return next;
    });
  }
  function onTagKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTags(tagDraft);
      setTagDraft("");
    } else if (e.key === "Backspace" && !tagDraft && tags.length > 0) {
      setTags((cur) => cur.slice(0, -1));
    }
  }

  // ---- Address helpers ----
  function onAddressBlur() {
    const parts = splitAddress(hostname);
    if (!parts) return;
    setHostname(parts.hostname);
    if (parts.username && !username.trim()) setUsername(parts.username);
    if (parts.port) setPort(clampPortText(parts.port));
    clearErr("hostname", "username", "port");
  }

  const formSnap = JSON.stringify([name, tags, tagDraft.trim(), hostname, port, username, forwardAgent, [...agentKeys].sort(), forwards, aiPolicy, aiFilePolicy, jumpId, keepalive, connectTimeout, termTheme, encoding, startup, envVars.map((v) => [v.name, v.value])]);
  const [baseline, setBaseline] = useState(formSnap);

  // ---- Validation and save ----
  function validate(): Errors {
    const e: Errors = {};
    const n = name.trim();
    if (n && hosts.some((h) => h.id !== current?.id && h.name.trim().toLowerCase() === n.toLowerCase())) e.name = "A host with this label already exists";
    if (!hostname.trim()) e.hostname = "Enter an address";
    else if (/\s/.test(hostname.trim())) e.hostname = "The address cannot contain spaces";
    if (!validPort(port)) e.port = port.trim() ? "1 to 65535" : "Required";
    if (!username.trim()) e.username = "Enter a user name";
    else if (/\s/.test(username.trim())) e.username = "The user name cannot contain spaces";
    if (authKind === "password" && effPwSel === NEW && !pwValue) e.password = "Enter a password";
    if (authKind === "password" && effPwSel === NEW && pwName.trim() && allSecretIds.some((x) => x.toLowerCase() === pwName.trim().toLowerCase())) e.pwname = "Name already in use";
    if (authKind === "key" && (!keySel || !keyIds.includes(keySel))) e.key = !secretsLoaded && secretsErr ? "Could not load the vault keys" : keyIds.length ? "Pick a key" : "Generate or import a key first";
    if (authKind === "identity" && !identities.some((i) => i.id === identitySel)) e.identity = identities.length ? "Pick an identity" : "Create an identity in Keychain first";
    if (keepalive.trim() && (!/^\d+$/.test(keepalive.trim()) || (Number(keepalive) !== 0 && (Number(keepalive) < 5 || Number(keepalive) > 3600)))) e.keepalive = "Use 5 to 3600, or 0";
    if (connectTimeout.trim() && (!/^\d+$/.test(connectTimeout.trim()) || Number(connectTimeout) < 3 || Number(connectTimeout) > 300)) e.timeout = "Use 3 to 300";
    for (const v of envVars) {
      if (!v.name.trim() && !v.value) continue;
      if (!ENV_NAME.test(v.name.trim())) e[`env:${v.id}`] = "Letters, digits and _ only, not starting with a digit";
    }
    const seen = new Map<string, string>();
    for (const f of forwards) {
      if (!validPort(f.local_port)) e[`fwd:${f.id}:local_port`] = "Use a port from 1 to 65535";
      if (f.kind !== "dynamic" && !validPort(f.remote_port)) e[`fwd:${f.id}:remote_port`] = "Use a port from 1 to 65535";
      if (f.kind === "local" && !f.remote_host.trim()) e[`fwd:${f.id}:remote_host`] = "Enter a destination host";
      else if (/\s/.test(f.remote_host.trim())) e[`fwd:${f.id}:remote_host`] = "Hosts cannot contain spaces";
      if (/\s/.test(f.local_host.trim())) e[`fwd:${f.id}:local_host`] = "Hosts cannot contain spaces";
      if (f.kind !== "remote" && validPort(f.local_port)) {
        const bind = isLoopbackBind(f.local_host) ? "loopback" : f.local_host.trim().toLowerCase();
        const key = `${bind}:${Number(f.local_port)}`;
        if (seen.has(key)) e[`fwd:${f.id}:local_port`] = "Port already used by another forward";
        else seen.set(key, f.id);
      }
    }
    return e;
  }

  const defaultLabel = hostname.trim() ? uniqueLabel(hostname.trim(), hosts.filter((h) => h.id !== current?.id)) : "";
  const canTest = !TEST_FIELDS.some((k) => k in validate());

  const labelRef = useRef<HTMLInputElement>(null);

  /** Stops running tunnels of this host whose definition or connection changes. Returns the ones to start again after saving. */
  async function stopChangedTunnels(before: Host, after: Host): Promise<{ stopped: string[]; restart: string[] }> {
    let running: string[];
    try {
      running = await api.forwardActive();
    } catch {
      return { stopped: [], restart: [] };
    }
    const connChanged = !sameConnection(before, after);
    const stopped: string[] = [];
    const restart: string[] = [];
    for (const f of before.forwards) {
      if (!running.includes(f.id)) continue;
      const next = after.forwards.find((x) => x.id === f.id);
      if (next && !connChanged && sameEndpoint(f, next)) continue;
      await api.forwardStop(before.id, f.id);
      stopped.push(f.id);
      if (next) restart.push(f.id);
    }
    return { stopped, restart };
  }

  async function save(connect: boolean) {
    if (busy) return;
    const e = validate();
    setErrors(e);
    setSaveErr("");
    const firstKey = Object.keys(e)[0];
    if (firstKey) {
      const order = ["name", "hostname", "port", "username", "password", "pwname", "key"];
      const first = order.find((k) => k in e) ?? firstKey;
      if (!advancedOpen && Object.keys(e).some(inAdvanced)) flushSync(() => setAdvancedOpen(true));
      const el = dialogRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    const pendingTags = tagDraft.split(",").map((t) => t.trim()).filter(Boolean);
    const finalTags = [...tags];
    for (const t of pendingTags) if (!finalTags.some((x) => x.toLowerCase() === t.toLowerCase())) finalTags.push(t);
    const base = saved ?? host;
    const snapAtSave = formSnap;

    setBusy(connect ? "connect" : "save");
    let createdSecret: string | null = null;
    let newPassword: string | null = null;
    try {
      let auth: AuthMethod;
      if (authKind === "password") {
        if (effPwSel === NEW) {
          const taken = await takenIds();
          const wanted = pwName.trim();
          if (wanted && taken.includes(wanted.toLowerCase())) throw "A key or password with this name already exists. Pick another name under Save as.";
          const id = wanted || uniqueId(`${username.trim()}@${hostname.trim()}`, taken);
          await api.secretPut(id, "password", pwValue);
          createdSecret = id;
          newPassword = id;
          auth = { kind: "password", secret_id: id };
        } else {
          auth = { kind: "password", secret_id: effPwSel };
        }
      } else if (authKind === "key") {
        auth = { kind: "key", secret_id: keySel };
      } else if (authKind === "identity") {
        auth = { kind: "identity", identity_id: identitySel };
      } else {
        auth = { kind: "agent" };
      }
      const data: NewHost = {
        name: name.trim() || defaultLabel,
        hostname: hostname.trim(),
        port: Number(port),
        username: username.trim(),
        auth,
        ai_policy: aiPolicy,
        ai_file_policy: aiFilePolicy,
        forward_agent: forwardAgent,
        agent_keys: secretsLoaded ? agentKeys.filter((k) => keyIds.includes(k)) : agentKeys,
        forwards: forwards.map(fromDraft),
        group: src.group ?? "",
        tags: finalTags,
        jump_host_id: jumpId || null,
        options: hostOptions(),
      };
      let result: Host;
      let restart: string[] = [];
      if (base) {
        result = { ...base, ...data };
        const tunnels = await stopChangedTunnels(base, result);
        restart = tunnels.restart;
        try {
          await api.hostUpdate(result);
        } catch (err) {
          for (const id of tunnels.stopped) await api.forwardStart(base.id, id).catch(() => undefined);
          throw err;
        }
      } else {
        result = await api.hostAdd(data);
      }
      createdSecret = null;

      // Written only after the host saved, so a failed save never changes a password other hosts may share.
      const problems: string[] = [];
      if (authKind === "password" && effPwSel !== NEW && pwChanging && pwValue) {
        try {
          await api.secretPut(effPwSel, "password", pwValue);
          if (alive.current) {
            setPwChanging(false);
            setPwValue("");
          }
        } catch (err) {
          problems.push(`The new password was not stored: ${errText(err)}`);
        }
      }
      for (const id of restart) {
        const f = result.forwards.find((x) => x.id === id);
        try {
          await api.forwardStart(result.id, id);
        } catch (err) {
          problems.push(`Tunnel ${f ? forwardText(f) : id} did not restart: ${errText(err)}`);
        }
      }
      if (problems.length > 0 && newPassword) await reloadSecrets();
      if (!alive.current) return;
      setBusy(null);
      if (problems.length > 0) {
        if (newPassword) {
          setPwSel(newPassword);
          setPwValue("");
          setPwName("");
        }
        authBase.current = null;
        setBaseline(snapAtSave);
        setSaved(result);
        setSaveErr(`Saved the host. ${problems.join(" ")}`);
        return;
      }
      setPwValue("");
      p.onSaved(result, connect);
    } catch (err) {
      if (createdSecret) await api.secretDelete(createdSecret).catch(() => undefined);
      if (alive.current) {
        setSaveErr(errText(err));
        setBusy(null);
      }
    }
  }

  function hostOptions(): api.HostOptions {
    return {
      keepalive_secs: keepalive.trim() ? Number(keepalive) : null,
      connect_timeout_secs: connectTimeout.trim() ? Number(connectTimeout) : null,
      terminal_theme: termTheme,
      encoding: encoding === "utf-8" ? "" : encoding,
      startup_command: startup.trim(),
      env: envVars.filter((v) => v.name.trim()).map((v) => ({ name: v.name.trim(), value: v.value })),
    };
  }

  async function testConnection() {
    const e = validate();
    const blocking = [...TEST_FIELDS, "keepalive", "timeout"].filter((k) => k in e);
    const newPw = authKind === "password" && (effPwSel === NEW || pwChanging) && pwValue ? pwValue : undefined;
    if (blocking.length) {
      if (!advancedOpen && blocking.some(inAdvanced)) flushSync(() => setAdvancedOpen(true));
      setErrors(e);
      setTest({ state: "err", msg: "Fix the highlighted fields first" });
      return;
    }
    setTest({ state: "busy", msg: "" });
    let auth: AuthMethod;
    if (authKind === "password") auth = { kind: "password", secret_id: effPwSel === NEW ? "" : effPwSel };
    else if (authKind === "key") auth = { kind: "key", secret_id: keySel };
    else if (authKind === "identity") auth = { kind: "identity", identity_id: identitySel };
    else auth = { kind: "agent" };
    const draft: Host = {
      ...(current ?? { id: crypto.randomUUID(), ai_policy: aiPolicy, ai_file_policy: aiFilePolicy, forward_agent: false, agent_keys: [], forwards: [], group: "", tags: [] }),
      name: name.trim() || defaultLabel,
      hostname: hostname.trim(),
      port: Number(port),
      username: username.trim(),
      auth,
      jump_host_id: jumpId || null,
      options: hostOptions(),
    } as Host;
    try {
      const r = await api.hostTest(draft, newPw);
      if (!alive.current) return;
      if (r.ok) setTest({ state: "ok", msg: `Connected in ${r.elapsed_ms < 1000 ? `${r.elapsed_ms} ms` : `${(r.elapsed_ms / 1000).toFixed(1)} s`}${r.auth ? `, ${r.auth}` : ""}` });
      else setTest({ state: "err", msg: r.message });
    } catch (err) {
      if (alive.current) setTest({ state: "err", msg: errText(err) });
    }
  }

  // ---- Close behavior ----
  const isDirty = () => {
    if (formSnap !== baseline || pwValue || pwName.trim()) return true;
    const b = authBase.current;
    if (!b) return false;
    if (authKind !== b.kind) return true;
    if (authKind === "key") return keySel !== b.key;
    if (authKind === "password") return effPwSel !== b.pw;
    if (authKind === "identity") return identitySel !== b.identity;
    return false;
  };
  const dirty = isDirty();
  const onDirtyChange = p.onDirtyChange;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const leave = () => {
    if (saved) p.onSaved(saved, false);
    else p.onClose();
  };
  const close = () => {
    if (busy) return;
    if (isDirty()) setConfirmDiscard(true);
    else leave();
  };
  const z = useModalLayer(dialogRef, {
    inline: p.inline,
    initialFocus: labelRef,
    onEscape: () => {
      if (keyPanel) {
        closeKeyPanel();
        return;
      }
      close();
    },
    onTab: (backwards) => {
      const root = dialogRef.current;
      if (!root) return;
      // Like the browser, step over unchecked radios so each segmented control is one tab stop.
      const items = Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")).filter(
        (el) => el.getClientRects().length > 0 && !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked),
      );
      if (items.length === 0) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = backwards ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1;
      items[next].focus();
    },
  });

  // ---- Render helpers ----
  const fe = (k: string) => errors[k];
  const describedBy = (k: string, id: string) => (errors[k] ? `${id}-err` : undefined);

  const policyOptions: { value: AiPolicy; label: string }[] = [
    { value: "locked", label: "Blocked" },
    { value: "confirm", label: "Ask" },
    { value: "free", label: "Free" },
  ];

  const primaryConnect = !!p.connectAfterSave;
  const saveBtn = (
    <button key="save" type={primaryConnect ? "button" : "submit"} disabled={!!busy} onClick={primaryConnect ? () => save(false) : undefined} style={btn(primaryConnect ? "secondary" : "primary", { disabled: !!busy })}>
      <Stable text={busy === "save" ? "Saving…" : "Save"} alts={["Save", "Saving…"]} />
    </button>
  );
  const connectBtn = (
    <button key="connect" type={primaryConnect ? "submit" : "button"} disabled={!!busy} onClick={primaryConnect ? undefined : () => save(true)} style={btn(primaryConnect ? "primary" : "secondary", { disabled: !!busy })}>
      <Stable text={busy === "connect" ? "Saving…" : "Save and connect"} alts={["Save and connect", "Saving…"]} />
    </button>
  );
  const cancelBtn = (
    <button key="cancel" type="button" disabled={!!busy} onClick={close} style={btn("secondary", { disabled: !!busy })}>
      <Stable text={saved ? "Close" : "Cancel"} alts={["Cancel", "Close"]} />
    </button>
  );
  const primary = primaryConnect ? connectBtn : saveBtn;
  const secondary = primaryConnect ? saveBtn : connectBtn;
  const footerRight = IS_MAC ? [cancelBtn, secondary, primary] : [primary, secondary, cancelBtn];

  const selectedKeyInfo = keySel ? keyInfo[keySel] : undefined;
  const noIdentities = identitiesLoaded && identities.length === 0;
  const secretsNotice = (
    <div role="alert" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--err)" }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>Could not load the vault: {secretsErr}</span>
      <button type="button" disabled={secretsRetrying} onClick={retrySecrets} style={btn("secondary", { small: true, disabled: secretsRetrying })}>
        <Stable text={secretsRetrying ? "Retrying…" : "Retry"} alts={["Retry", "Retrying…"]} />
      </button>
    </div>
  );

  return (
    <>
      <Frame inline={!!p.inline} z={z} onBackdrop={close}>
        <section
          ref={dialogRef}
          role={p.inline ? "region" : "dialog"}
          aria-modal={p.inline ? undefined : "true"}
          aria-labelledby={fid("title")}
          aria-busy={!!busy || undefined}
          onKeyDown={
            p.inline
              ? (e) => {
                  if (e.key !== "Escape" || e.defaultPrevented) return;
                  e.preventDefault();
                  if (keyPanel) closeKeyPanel();
                  else close();
                }
              : undefined
          }
          style={p.inline ? { display: "flex", flexDirection: "column", color: "var(--text)" } : { width: 680, maxWidth: "100%", maxHeight: "100%", display: "flex", flexDirection: "column", borderRadius: 12, background: "var(--bg)", color: "var(--text)", boxShadow: "var(--shadow)", overflow: "hidden" }}
        >
          <div style={p.inline ? { display: "flex", alignItems: "center", gap: 12, paddingBottom: 18 } : { display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
            <h2 id={fid("title")} style={{ flex: 1, minWidth: 0, margin: 0, fontSize: p.inline ? 18 : 16, fontWeight: 600 }}>{editing ? (p.inline && current ? `Edit ${current.name}` : "Edit host") : "New host"}</h2>
            {!p.inline && (
              <button type="button" aria-label="Close" disabled={!!busy} onClick={close} style={{ ...iconBtn, cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1 }}>
                <CloseIcon size={14} />
              </button>
            )}
          </div>

          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save(primaryConnect);
            }}
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
          >
          <div style={p.inline ? { display: "flex", flexDirection: "column", gap: 22, paddingBottom: 22 } : { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 22, padding: 20 }}>
            {/* General */}
            <section aria-labelledby={fid("general")} style={sectionStyle}>
              <h3 id={fid("general")} style={h3Style}>General</h3>
              <Field id={fid("label")} label="Label" error={fe("name")}>
                <input
                  ref={labelRef}
                  id={fid("label")}
                  data-field="name"
                  type="text"
                  value={name}
                  placeholder={defaultLabel || "web-01"}
                  aria-invalid={!!fe("name") || undefined}
                  aria-describedby={describedBy("name", fid("label"))}
                  onChange={(e) => {
                    setName(cleanText(e.target.value));
                    clearErr("name");
                  }}
                  style={inputStyle({ error: !!fe("name") })}
                />
              </Field>
              <div>
                <label htmlFor={fid("tags")} style={labelStyle}>Tags</label>
                <div
                  onClick={(e) => e.target === e.currentTarget && (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}
                  style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, minHeight: 32, padding: "3px 6px", border: `1px solid ${tagFocus ? "var(--focus)" : "var(--line)"}`, boxShadow: tagFocus ? "0 0 0 1px var(--focus)" : "none", borderRadius: 6, background: "var(--bg-sunken)", boxSizing: "border-box", cursor: "text" }}
                >
                  {tags.map((t) => (
                    <span key={t} title={t} style={chip}>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t}</span>
                      <button
                        type="button"
                        aria-label={`Remove tag ${t}`}
                        onClick={() => {
                          rescueFocus('[data-focus="tags"]');
                          setTags((cur) => cur.filter((x) => x !== t));
                        }}
                        style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: "none", width: 16, height: 16, padding: 0, border: 0, borderRadius: 8, background: "transparent", color: "var(--text-2)", cursor: "pointer" }}
                      >
                        <CloseIcon size={10} />
                      </button>
                    </span>
                  ))}
                  <input
                    id={fid("tags")}
                    data-focus="tags"
                    type="text"
                    value={tagDraft}
                    placeholder={tags.length ? "" : "Add tag"}
                    onChange={(e) => {
                      const v = cleanText(e.target.value);
                      if (v.includes(",")) {
                        const parts = v.split(",");
                        addTags(parts.slice(0, -1).join(","));
                        setTagDraft(parts[parts.length - 1]);
                      } else setTagDraft(v);
                    }}
                    onKeyDown={onTagKey}
                    onFocus={() => setTagFocus(true)}
                    onBlur={() => {
                      setTagFocus(false);
                      addTags(tagDraft);
                      setTagDraft("");
                    }}
                    style={{ flex: 1, minWidth: 80, height: 24, border: 0, outline: "none", background: "transparent", color: "var(--text)" }}
                  />
                </div>
              </div>
            </section>

            {/* Connection */}
            <section aria-labelledby={fid("conn")} style={sectionStyle}>
              <h3 id={fid("conn")} style={h3Style}>Connection</h3>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 96px", gap: 12 }}>
                <Field id={fid("addr")} label="Address" error={fe("hostname")}>
                  <input
                    id={fid("addr")}
                    data-field="hostname"
                    type="text"
                    value={hostname}
                    placeholder="example.com or 10.0.0.5"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-invalid={!!fe("hostname") || undefined}
                    aria-describedby={describedBy("hostname", fid("addr"))}
                    onChange={(e) => {
                      setHostname(cleanText(e.target.value));
                      clearErr("hostname");
                    }}
                    onPaste={(e) =>
                      pasteClean(e, (v) => {
                        setHostname(v);
                        clearErr("hostname");
                      })
                    }
                    onBlur={onAddressBlur}
                    style={inputStyle({ error: !!fe("hostname"), mono: true })}
                  />
                </Field>
                <Field id={fid("port")} label="Port" error={fe("port")}>
                  <input
                    id={fid("port")}
                    data-field="port"
                    type="text"
                    inputMode="numeric"
                    value={port}
                    placeholder="22"
                    aria-invalid={!!fe("port") || undefined}
                    aria-describedby={describedBy("port", fid("port"))}
                    onChange={(e) => {
                      setPort(digits(e.target.value));
                      clearErr("port");
                    }}
                    onBlur={() => setPort((v) => clampPortText(v))}
                    style={inputStyle({ error: !!fe("port"), mono: true })}
                  />
                </Field>
              </div>
              <div style={grid2}>
                <Field id={fid("user")} label="Username" error={fe("username")}>
                  <input
                    id={fid("user")}
                    data-field="username"
                    type="text"
                    value={username}
                    placeholder="root"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-invalid={!!fe("username") || undefined}
                    aria-describedby={describedBy("username", fid("user"))}
                    onChange={(e) => {
                      setUsername(cleanText(e.target.value));
                      clearErr("username");
                    }}
                    onPaste={(e) =>
                      pasteClean(e, (v) => {
                        setUsername(v);
                        clearErr("username");
                      })
                    }
                    style={inputStyle({ error: !!fe("username") })}
                  />
                </Field>
                <Field id={fid("jump")} label="Jump host">
                  <select id={fid("jump")} value={jumpId} title="Connects through this host first, like ssh -J" onChange={(e) => setJumpId(e.target.value)} style={selectStyle()}>
                    <option value="">None</option>
                    {jumpId && !jumpChoices.some((h) => h.id === jumpId) && <option value={jumpId}>Missing host</option>}
                    {jumpChoices.map((h) => (
                      <option key={h.id} value={h.id}>{h.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
            </section>

            {/* Authentication */}
            <section aria-labelledby={fid("auth")} style={sectionStyle}>
              <h3 id={fid("auth")} style={h3Style}>Authentication</h3>
              <Segmented<AuthKind>
                name={fid("method")}
                legend="Method"
                value={authKind}
                onChange={(v) => {
                  touchAuth();
                  authTouched.current = true;
                  setAuthKind(v);
                  clearErr("password", "key", "pwname", "identity");
                }}
                options={[
                  { value: "password", label: "Password" },
                  { value: "key", label: "Key" },
                  { value: "agent", label: "SSH agent" },
                  { value: "identity", label: "Identity", disabled: noIdentities && authKind !== "identity", title: noIdentities ? "Create an identity in Keychain first" : undefined },
                ]}
              />

              {authKind === "password" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {secretsErr && secretsNotice}
                  <div style={{ ...grid2, alignItems: "start" }}>
                    {pwIds.length > 0 && (
                      <Field id={fid("pwsel")} label="Saved password">
                        <select
                          id={fid("pwsel")}
                          value={effPwSel}
                          onChange={(e) => {
                            touchAuth();
                            setPwSel(e.target.value);
                            setPwChanging(false);
                            setPwValue("");
                            clearErr("password", "pwname");
                          }}
                          style={selectStyle()}
                        >
                          <option value={NEW}>New password</option>
                          {pwIds.map((id) => (
                            <option key={id} value={id}>{id}</option>
                          ))}
                        </select>
                      </Field>
                    )}
                    {effPwSel === NEW || pwChanging ? (
                      <Field
                        id={fid("pw")}
                        label={effPwSel === NEW ? "Password" : "New password"}
                        error={fe("password")}
                        warn={pwChanging && pwShared.length > 0 ? `Also used by ${pwShared.join(", ")}` : undefined}
                        tip={`Also used by ${pwShared.join(", ")}. Changing it updates ${pwShared.length === 1 ? "that host" : "those hosts"} too.`}
                      >
                        <div style={{ display: "flex", gap: 6 }}>
                          <input
                            id={fid("pw")}
                            data-field="password"
                            type="password"
                            autoComplete="new-password"
                            autoFocus={pwChanging}
                            value={pwValue}
                            placeholder={effPwSel === NEW ? "Password" : "Unchanged"}
                            aria-invalid={!!fe("password") || undefined}
                            aria-describedby={describedBy("password", fid("pw"))}
                            onChange={(e) => {
                              setPwValue(cleanPassword(e.target.value));
                              clearErr("password");
                            }}
                            style={inputStyle({ error: !!fe("password") })}
                          />
                          {pwChanging && (
                            <button
                              type="button"
                              onClick={() => {
                                rescueFocus('[data-focus="pw-change"]');
                                setPwChanging(false);
                                setPwValue("");
                                clearErr("password");
                              }}
                              style={btn("secondary")}
                            >
                              Keep
                            </button>
                          )}
                        </div>
                      </Field>
                    ) : (
                      <div>
                        <span style={labelStyle}>Password</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 32, padding: "0 2px 0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", boxSizing: "border-box" }}>
                          <span style={{ display: "flex", color: "var(--ok)" }}>
                            <CheckIcon />
                          </span>
                          <span style={{ flex: 1, minWidth: 0, color: "var(--text-2)" }}>Password saved</span>
                          <button type="button" data-focus="pw-change" onClick={() => setPwChanging(true)} style={{ ...btn("secondary", { small: true }), height: 26 }}>
                            Change
                          </button>
                        </div>
                      </div>
                    )}
                    {effPwSel === NEW && (
                      <Field id={fid("pwname")} label="Save as" error={fe("pwname")}>
                        <input
                          id={fid("pwname")}
                          data-field="pwname"
                          type="text"
                          value={pwName}
                          placeholder={`${username.trim() || "user"}@${hostname.trim() || "host"}`}
                          spellCheck={false}
                          autoCapitalize="off"
                          autoCorrect="off"
                          aria-invalid={!!fe("pwname") || undefined}
                          aria-describedby={describedBy("pwname", fid("pwname"))}
                          onChange={(e) => {
                            setPwName(cleanText(e.target.value));
                            clearErr("pwname");
                          }}
                          style={inputStyle({ error: !!fe("pwname"), mono: true })}
                        />
                      </Field>
                    )}
                  </div>
                  {pwIds.length === 0 && <p style={hint}>Encrypted in the vault. Other hosts can reuse it by name.</p>}
                </div>
              )}

              {authKind === "key" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ ...grid2, alignItems: "end" }}>
                    <Field id={fid("key")} label="Key" error={fe("key")}>
                      <select
                        id={fid("key")}
                        data-field="key"
                        value={keyIds.includes(keySel) ? keySel : ""}
                        aria-invalid={!!fe("key") || undefined}
                        aria-describedby={describedBy("key", fid("key"))}
                        onChange={(e) => {
                          touchAuth();
                          setKeySel(e.target.value);
                          clearErr("key");
                        }}
                        style={selectStyle({ error: !!fe("key") })}
                      >
                        {keyIds.length === 0 ? (
                          <option value="" disabled>
                            {secretsLoaded ? "No keys in the vault" : "Loading keys…"}
                          </option>
                        ) : (
                          !keyIds.includes(keySel) && (
                            <option value="" disabled>
                              {keySel ? `${keySel} (not in the vault)` : "Pick a key"}
                            </option>
                          )
                        )}
                        {keyIds.map((id) => (
                          <option key={id} value={id}>{id}</option>
                        ))}
                      </select>
                    </Field>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" data-focus="generate" aria-expanded={keyPanel === "generate"} onClick={() => (keyPanel === "generate" ? closeKeyPanel() : openGenerate())} style={{ ...btn("secondary"), background: keyPanel === "generate" ? "var(--bg-raised)" : "var(--bg)" }}>
                        Generate key
                      </button>
                      <button type="button" data-focus="import" aria-expanded={keyPanel === "import"} onClick={() => (keyPanel === "import" ? closeKeyPanel() : openImport())} style={{ ...btn("secondary"), background: keyPanel === "import" ? "var(--bg-raised)" : "var(--bg)" }}>
                        Import key
                      </button>
                    </div>
                  </div>
                  {secretsErr && secretsNotice}

                  {keySel && keyIds.includes(keySel) && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {selectedKeyInfo === undefined ? (
                        <p style={hint}>Reading the key fingerprint…</p>
                      ) : "error" in selectedKeyInfo ? (
                        <p style={{ ...hint, color: "var(--err)" }}>Could not read this key: {selectedKeyInfo.error}</p>
                      ) : (
                        <KeyInfo info={selectedKeyInfo} />
                      )}
                      {justCreated === keySel && selectedKeyInfo && !("error" in selectedKeyInfo) && (
                        <p style={hint}>
                          Add the public key to <code style={{ fontFamily: MONO, fontSize: 12 }}>~/.ssh/authorized_keys</code> on the server before you connect.
                        </p>
                      )}
                    </div>
                  )}

                  {keyPanel === "generate" && (
                    <div style={panel}>
                      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 160px", gap: 10 }}>
                        <Field id={fid("genname")} label="Name">
                          <input
                            id={fid("genname")}
                            type="text"
                            autoFocus
                            value={genName}
                            spellCheck={false}
                            onChange={(e) => {
                              setGenName(cleanText(e.target.value));
                              setGenErr("");
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void generate();
                              }
                            }}
                            style={inputStyle({ mono: true })}
                          />
                        </Field>
                        <Field id={fid("genalgo")} label="Algorithm">
                          <select
                            id={fid("genalgo")}
                            value={genAlgo}
                            onChange={(e) => {
                              const next = e.target.value as KeyAlgorithm;
                              setGenName((n) => (n === uniqueId(`${slug(name || hostname)}-${genAlgo}`, allSecretIds) ? uniqueId(`${slug(name || hostname)}-${next}`, allSecretIds) : n));
                              setGenAlgo(next);
                            }}
                            style={selectStyle()}
                          >
                            {KEY_ALGOS.map((a) => (
                              <option key={a.value} value={a.value}>{a.label}</option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      {genAlgo.startsWith("rsa") && <p style={hint}>RSA keys take a few seconds to generate.</p>}
                      {genErr && <span role="alert" style={{ ...errStyle, marginTop: 0 }}>{genErr}</span>}
                      <div style={{ display: "flex", gap: 6, justifyContent: IS_MAC ? "flex-end" : "flex-start" }}>
                        {IS_MAC && <button type="button" onClick={closeKeyPanel} style={btn("secondary", { small: true })}>Cancel</button>}
                        <button type="button" disabled={genBusy} onClick={generate} style={btn("primary", { small: true, disabled: genBusy })}>
                          <Stable text={genBusy ? "Generating…" : "Generate and save"} alts={["Generate and save", "Generating…"]} />
                        </button>
                        {!IS_MAC && <button type="button" onClick={closeKeyPanel} style={btn("secondary", { small: true })}>Cancel</button>}
                      </div>
                    </div>
                  )}

                  {keyPanel === "import" && (
                    <div style={panel}>
                      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "end" }}>
                        <Field id={fid("impname")} label="Name">
                          <input
                            id={fid("impname")}
                            type="text"
                            value={impName}
                            placeholder="prod-key"
                            spellCheck={false}
                            onChange={(e) => {
                              setImpName(cleanText(e.target.value));
                              setImpErr("");
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                if (impInfo && !impLocked && !impBusy) void saveImported();
                              }
                            }}
                            style={inputStyle({ mono: true })}
                          />
                        </Field>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button type="button" disabled={!!impBusy} onClick={importFromFile} style={btn("secondary", { disabled: !!impBusy })}>
                            Choose file…
                          </button>
                          <button type="button" disabled={!!impBusy} onClick={importFromClipboard} style={btn("secondary", { disabled: !!impBusy })}>
                            Paste from clipboard
                          </button>
                        </div>
                      </div>
                      {impBusy === "load" && <p style={hint}>Reading the key…</p>}
                      {impLocked && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <p style={hint}>This key from {impSource} has a passphrase. Enter it once, you are not asked again.</p>
                          <div style={{ display: "flex", gap: 6 }}>
                            <input
                              type="password"
                              aria-label="Key passphrase"
                              autoFocus
                              value={impPass}
                              placeholder="Passphrase"
                              onChange={(e) => {
                                setImpPass(e.target.value);
                                setImpErr("");
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void unlockImported();
                                }
                              }}
                              style={inputStyle()}
                            />
                            <button type="button" disabled={!impPass || !!impBusy} onClick={unlockImported} style={btn("secondary", { disabled: !impPass || !!impBusy })}>
                              Unlock
                            </button>
                          </div>
                        </div>
                      )}
                      {impInfo && !impLocked ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          <p style={hint}>Loaded from {impSource}. The private key is never shown.</p>
                          <KeyInfo info={impInfo} />
                        </div>
                      ) : (
                        !impBusy && <p style={hint}>Pick a private key file, for example id_ed25519, or copy the key and paste it here.</p>
                      )}
                      {impErr && <span role="alert" style={{ ...errStyle, marginTop: 0 }}>{impErr}</span>}
                      <div style={{ display: "flex", gap: 6, justifyContent: IS_MAC ? "flex-end" : "flex-start" }}>
                        {IS_MAC && <button type="button" onClick={closeKeyPanel} style={btn("secondary", { small: true })}>Cancel</button>}
                        <button type="button" disabled={!!impBusy || !impInfo || impLocked} onClick={saveImported} style={btn("primary", { small: true, disabled: !!impBusy || !impInfo || impLocked })}>
                          <Stable text={impBusy === "save" ? "Saving…" : "Save key"} alts={["Save key", "Saving…"]} />
                        </button>
                        {!IS_MAC && <button type="button" onClick={closeKeyPanel} style={btn("secondary", { small: true })}>Cancel</button>}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {authKind === "agent" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {agentInfo === null ? (
                    <p style={hint}>Looking for your SSH agent…</p>
                  ) : agentInfo.error && agentInfo.keys.length === 0 ? (
                    <p style={{ ...hint, color: "var(--warn)" }}>{agentInfo.error}</p>
                  ) : (
                    <p style={hint}>
                      Signs in with the keys in your {agentInfo.agent === "pageant" ? "Pageant" : agentInfo.agent === "openssh" ? "OpenSSH agent" : "SSH agent"}
                      {agentInfo.keys.length ? `: ${agentInfo.keys.map((k) => k.comment || k.algorithm).join(", ")}` : ", which has no keys loaded right now"}. The keys never enter the vault.
                    </p>
                  )}
                </div>
              )}

              {authKind === "identity" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <Field id={fid("identity")} label="Identity" error={fe("identity")}>
                    <select
                      id={fid("identity")}
                      data-field="identity"
                      value={identities.some((i) => i.id === identitySel) ? identitySel : ""}
                      aria-invalid={!!fe("identity") || undefined}
                      aria-describedby={describedBy("identity", fid("identity"))}
                      onChange={(e) => {
                        touchAuth();
                        setIdentitySel(e.target.value);
                        clearErr("identity");
                      }}
                      style={selectStyle({ error: !!fe("identity") })}
                    >
                      {!identities.some((i) => i.id === identitySel) && (
                        <option value="" disabled>
                          {!identitiesLoaded ? "Loading identities…" : identities.length ? "Pick an identity" : "No identities yet"}
                        </option>
                      )}
                      {identities.map((i) => (
                        <option key={i.id} value={i.id}>{i.name}</option>
                      ))}
                    </select>
                  </Field>
                  {(() => {
                    const ident = identities.find((i) => i.id === identitySel);
                    if (!ident) return identitiesLoaded && identities.length === 0 ? <p style={hint}>Create identities under Keychain, Identities. One identity can sign in to many hosts.</p> : null;
                    const how = ident.auth.kind === "agent" ? "the SSH agent" : `${ident.auth.kind === "key" ? "key" : "password"} ${ident.auth.secret_id}`;
                    return <p style={hint}>Signs in{ident.username ? ` as ${ident.username}` : ""} with {how}.{ident.username ? " The username above is used only when the identity has none." : ""}</p>;
                  })()}
                </div>
              )}
            </section>

            {/* Advanced */}
            <section aria-labelledby={fid("adv")} style={sectionStyle}>
              <h3 id={fid("adv")} style={{ margin: 0 }}>
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  aria-controls={fid("adv-body")}
                  onClick={() => setAdvancedOpen((o) => !o)}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: 0, border: 0, background: "transparent", color: "var(--text)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                >
                  <span style={{ display: "flex", transform: advancedOpen ? "none" : "rotate(-90deg)", transition: "transform 120ms ease" }}>
                    <ChevronIcon size={14} />
                  </span>
                  Advanced
                </button>
              </h3>
              {advancedOpen && (
                <div id={fid("adv-body")} style={{ display: "flex", flexDirection: "column", gap: 22 }}>
                  {/* Port forwards */}
                  <section aria-labelledby={fid("fwd")} style={sectionStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <h4 id={fid("fwd")} style={{ ...h3Style, flex: 1 }}>Port forwards</h4>
                      <button
                        type="button"
                        data-focus="add-forward"
                        onClick={() =>
                          setForwards((cur) => {
                            const used = new Set(cur.filter((f) => isLoopbackBind(f.local_host)).map((f) => Number(f.local_port)));
                            let port = 8080;
                            while (used.has(port) && port < 65535) port++;
                            return [...cur, { id: crypto.randomUUID(), name: "", local_host: "127.0.0.1", local_port: String(port), remote_host: "localhost", remote_port: String(port), autostart: false, kind: "local" as ForwardKind, start_on_connect: false }];
                          })
                        }
                        style={btn("secondary", { small: true })}
                      >
                        <PlusIcon size={14} />
                        Add forward
                      </button>
                    </div>
                    <p style={hint}>Start and stop them from the host card or Port forwarding.</p>
                    {forwards.map((f, i) => {
                      const k = (field: string) => `fwd:${f.id}:${field}`;
                      const id = (field: string) => fid(`fwd-${i}-${field}`);
                      const msgId = id("msg");
                      const errKey = (f.kind === "remote" ? ["remote_host", "remote_port", "local_host", "local_port"] : ["local_host", "local_port", "remote_host", "remote_port"]).map(k).find((x) => errors[x]);
                      const exposed = !errKey && f.kind !== "remote" && !isLoopbackBind(f.local_host);
                      const msg = errKey ? errors[errKey] : exposed ? `Listening on ${f.local_host.trim()}, reachable from your network` : "";
                      const desc = (field: string) => (fe(k(field)) ? msgId : undefined);
                      return (
                        <div key={f.id} style={panel}>
                          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Field id={id("name")} label="Name">
                                <input id={id("name")} type="text" value={f.name} placeholder="Optional, for example Postgres" onChange={(e) => patchForward(f.id, { name: cleanText(e.target.value) })} style={inputStyle()} />
                              </Field>
                            </div>
                            <button
                              type="button"
                              aria-label={`Remove forward ${f.name.trim() || i + 1}`}
                              title="Remove forward"
                              onClick={() => {
                                rescueFocus('[data-focus="add-forward"]');
                                setForwards((cur) => cur.filter((x) => x.id !== f.id));
                                clearErr(k("local_host"), k("local_port"), k("remote_host"), k("remote_port"));
                              }}
                              style={{ ...iconBtn, width: 32, height: 32 }}
                            >
                              <TrashIcon />
                            </button>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                            <Segmented<ForwardKind>
                              name={id("kind")}
                              legend="Forward type"
                              value={f.kind}
                              onChange={(v) => {
                                patchForward(f.id, v === "remote" && f.kind !== "remote" ? { kind: v, local_host: "localhost", remote_host: "localhost" } : v !== "remote" && f.kind === "remote" ? { kind: v, local_host: "127.0.0.1", remote_host: v === "dynamic" ? "" : "localhost" } : { kind: v });
                                clearErr(k("local_host"), k("local_port"), k("remote_host"), k("remote_port"));
                              }}
                              options={[
                                { value: "local", label: "Local", title: "Reaches a service on the host side" },
                                { value: "remote", label: "Remote", title: "Publishes a port of this computer on the host" },
                                { value: "dynamic", label: "Dynamic", title: "SOCKS proxy through the host" },
                              ]}
                            />
                            <span
                              id={msgId}
                              role="alert"
                              title={exposed ? `Listening on ${f.local_host.trim()}, so other devices on your network can reach this tunnel. Use 127.0.0.1 to keep it on this computer.` : msg || undefined}
                              style={exposed ? { ...rowMsg, color: "var(--warn)" } : rowMsg}
                            >
                              {msg}
                            </span>
                          </div>
                          {f.kind === "remote" ? (
                          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 84px 16px minmax(0, 1fr) 84px", gap: 10, alignItems: "start" }}>
                            <Field id={id("rhost")} label="Listen on host">
                              <input
                                id={id("rhost")}
                                data-field={k("remote_host")}
                                aria-invalid={!!fe(k("remote_host")) || undefined}
                                aria-describedby={desc("remote_host")}
                                type="text"
                                value={f.remote_host}
                                placeholder="localhost"
                                spellCheck={false}
                                onChange={(e) => {
                                  patchForward(f.id, { remote_host: cleanText(e.target.value) });
                                  clearErr(k("remote_host"));
                                }}
                                style={inputStyle({ mono: true, error: !!fe(k("remote_host")) })}
                              />
                            </Field>
                            <Field id={id("rport")} label="Port">
                              <input
                                id={id("rport")}
                                data-field={k("remote_port")}
                                aria-invalid={!!fe(k("remote_port")) || undefined}
                                aria-describedby={desc("remote_port")}
                                type="text"
                                inputMode="numeric"
                                value={f.remote_port}
                                onChange={(e) => {
                                  patchForward(f.id, { remote_port: digits(e.target.value) });
                                  clearErr(k("remote_port"));
                                }}
                                onBlur={() => patchForward(f.id, { remote_port: clampPortText(f.remote_port) })}
                                style={inputStyle({ mono: true, error: !!fe(k("remote_port")) })}
                              />
                            </Field>
                            <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 32, marginTop: 20, color: "var(--text-2)" }}>
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2.5 8h11M10 4.5 13.5 8 10 11.5" />
                              </svg>
                            </span>
                            <Field id={id("lhost")} label="Destination on this computer">
                              <input
                                id={id("lhost")}
                                data-field={k("local_host")}
                                aria-invalid={!!fe(k("local_host")) || undefined}
                                aria-describedby={desc("local_host")}
                                type="text"
                                value={f.local_host}
                                placeholder="localhost"
                                spellCheck={false}
                                onChange={(e) => {
                                  patchForward(f.id, { local_host: cleanText(e.target.value) });
                                  clearErr(k("local_host"));
                                }}
                                style={inputStyle({ mono: true, error: !!fe(k("local_host")) })}
                              />
                            </Field>
                            <Field id={id("lport")} label="Port">
                              <input
                                id={id("lport")}
                                data-field={k("local_port")}
                                aria-invalid={!!fe(k("local_port")) || undefined}
                                aria-describedby={desc("local_port")}
                                type="text"
                                inputMode="numeric"
                                value={f.local_port}
                                onChange={(e) => {
                                  patchForward(f.id, { local_port: digits(e.target.value) });
                                  clearErr(k("local_port"));
                                }}
                                onBlur={() => patchForward(f.id, { local_port: clampPortText(f.local_port) })}
                                style={inputStyle({ mono: true, error: !!fe(k("local_port")) })}
                              />
                            </Field>
                          </div>
                          ) : (
                          <div style={{ display: "grid", gridTemplateColumns: f.kind === "dynamic" ? "minmax(0, 1fr) 84px" : "minmax(0, 1fr) 84px 16px minmax(0, 1fr) 84px", gap: 10, alignItems: "start" }}>
                            <Field id={id("lhost")} label="Listen address">
                              <input
                                id={id("lhost")}
                                data-field={k("local_host")}
                                aria-invalid={!!fe(k("local_host")) || undefined}
                                aria-describedby={desc("local_host")}
                                type="text"
                                value={f.local_host}
                                placeholder="127.0.0.1"
                                spellCheck={false}
                                onChange={(e) => {
                                  patchForward(f.id, { local_host: cleanText(e.target.value) });
                                  clearErr(k("local_host"), k("local_port"));
                                }}
                                onPaste={(e) => pasteClean(e, (v) => patchForward(f.id, { local_host: v }))}
                                style={inputStyle({ mono: true, error: !!fe(k("local_host")) })}
                              />
                            </Field>
                            <Field id={id("lport")} label="Port">
                              <input
                                id={id("lport")}
                                data-field={k("local_port")}
                                aria-invalid={!!fe(k("local_port")) || undefined}
                                aria-describedby={desc("local_port")}
                                type="text"
                                inputMode="numeric"
                                value={f.local_port}
                                onChange={(e) => {
                                  patchForward(f.id, { local_port: digits(e.target.value) });
                                  clearErr(k("local_port"));
                                }}
                                onBlur={() => patchForward(f.id, { local_port: clampPortText(f.local_port) })}
                                style={inputStyle({ mono: true, error: !!fe(k("local_port")) })}
                              />
                            </Field>
                            {f.kind === "local" && (
                            <>
                            <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 32, marginTop: 20, color: "var(--text-2)" }}>
                              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2.5 8h11M10 4.5 13.5 8 10 11.5" />
                              </svg>
                            </span>
                            <Field id={id("rhost")} label="Destination host">
                              <input
                                id={id("rhost")}
                                data-field={k("remote_host")}
                                aria-invalid={!!fe(k("remote_host")) || undefined}
                                aria-describedby={desc("remote_host")}
                                type="text"
                                value={f.remote_host}
                                placeholder="localhost"
                                spellCheck={false}
                                onChange={(e) => {
                                  patchForward(f.id, { remote_host: cleanText(e.target.value) });
                                  clearErr(k("remote_host"));
                                }}
                                onPaste={(e) => pasteClean(e, (v) => patchForward(f.id, { remote_host: v }))}
                                style={inputStyle({ mono: true, error: !!fe(k("remote_host")) })}
                              />
                            </Field>
                            <Field id={id("rport")} label="Port">
                              <input
                                id={id("rport")}
                                data-field={k("remote_port")}
                                aria-invalid={!!fe(k("remote_port")) || undefined}
                                aria-describedby={desc("remote_port")}
                                type="text"
                                inputMode="numeric"
                                value={f.remote_port}
                                onChange={(e) => {
                                  patchForward(f.id, { remote_port: digits(e.target.value) });
                                  clearErr(k("remote_port"));
                                }}
                                onBlur={() => patchForward(f.id, { remote_port: clampPortText(f.remote_port) })}
                                style={inputStyle({ mono: true, error: !!fe(k("remote_port")) })}
                              />
                            </Field>
                            </>
                            )}
                          </div>
                          )}
                          {f.kind === "dynamic" && <p style={hint}>Point a browser or app at SOCKS5 {f.local_host.trim() || "127.0.0.1"}:{f.local_port || "port"}. Every connection goes out from {hostname.trim() || "the host"}.</p>}
                          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            Start
                            <select
                              value={f.autostart && f.start_on_connect ? "both" : f.autostart ? "open" : f.start_on_connect ? "connect" : "manual"}
                              onChange={(e) => {
                                const v = e.target.value;
                                patchForward(f.id, { autostart: v === "open" || v === "both", start_on_connect: v === "connect" || v === "both" });
                              }}
                              style={{ ...selectStyle(), width: "auto", flex: 1 }}
                            >
                              <option value="manual">Manually</option>
                              <option value="open">When Kestral opens</option>
                              <option value="connect">When the host connects</option>
                              {f.autostart && f.start_on_connect && <option value="both">When Kestral opens or the host connects</option>}
                            </select>
                          </label>
                        </div>
                      );
                    })}
                  </section>

                  <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 2 }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <div style={{ paddingTop: 1 }}>
                        <Toggle on={forwardAgent} label="Forward agent" describedBy={fid("fwdagent-desc")} onChange={setForwardAgent} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500 }}>Forward agent</div>
                        <p id={fid("fwdagent-desc")} style={{ ...hint, marginTop: 2 }}>
                          Lets this host sign in elsewhere with the keys you pick. Only for trusted hosts.
                        </p>
                      </div>
                    </div>
                    {forwardAgent && (
                      <div style={{ ...panel, gap: 6, marginLeft: 40 }}>
                        <LabelRow label="Keys to expose" msg={keyIds.length > 0 && !agentKeys.some((k) => keyIds.includes(k)) ? "Pick at least one key, otherwise nothing is forwarded" : undefined} warn style={{ marginBottom: 0 }} />
                        {keyIds.length === 0 ? (
                          <p style={hint}>No keys in the vault yet. Generate or import one under Key.</p>
                        ) : (
                          keyIds.map((id) => (
                            <label key={id} title={id} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, minHeight: 24, cursor: "pointer" }}>
                              <input type="checkbox" checked={agentKeys.includes(id)} onChange={() => setAgentKeys((cur) => (cur.includes(id) ? cur.filter((k) => k !== id) : [...cur, id]))} style={{ flex: "none" }} />
                              <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{id}</span>
                            </label>
                          ))
                        )}
                      </div>
                    )}
                  </div>

                  <section aria-labelledby={fid("session")} style={sectionStyle}>
                    <h4 id={fid("session")} style={h3Style}>Session</h4>
                    <div style={grid2}>
                      <Field id={fid("keepalive")} label="Keepalive interval" error={fe("keepalive")}>
                        <input
                          id={fid("keepalive")}
                          data-field="keepalive"
                          type="text"
                          inputMode="numeric"
                          value={keepalive}
                          placeholder="15 s"
                          aria-invalid={!!fe("keepalive") || undefined}
                          onChange={(e) => {
                            setKeepalive(digits(e.target.value));
                            clearErr("keepalive");
                          }}
                          style={inputStyle({ error: !!fe("keepalive") })}
                        />
                      </Field>
                      <Field id={fid("timeout")} label="Connect timeout" error={fe("timeout")}>
                        <input
                          id={fid("timeout")}
                          data-field="timeout"
                          type="text"
                          inputMode="numeric"
                          value={connectTimeout}
                          placeholder="15 s"
                          aria-invalid={!!fe("timeout") || undefined}
                          onChange={(e) => {
                            setConnectTimeout(digits(e.target.value));
                            clearErr("timeout");
                          }}
                          style={inputStyle({ error: !!fe("timeout") })}
                        />
                      </Field>
                    </div>
                    <p style={{ ...hint, marginTop: -4 }}>In seconds, 15 when empty. Keepalive 0 turns it off.</p>
                    <div style={grid2}>
                      <Field id={fid("theme")} label="Terminal theme">
                        <select id={fid("theme")} value={termTheme} onChange={(e) => setTermTheme(e.target.value)} style={selectStyle()}>
                          <option value="">Follow app</option>
                          {Object.entries(TERMINAL_THEMES).map(([id, t]) => (
                            <option key={id} value={id}>{t.name}</option>
                          ))}
                        </select>
                      </Field>
                      <Field id={fid("enc")} label="Encoding">
                        <select id={fid("enc")} value={encoding} onChange={(e) => setEncoding(e.target.value)} style={selectStyle()}>
                          <option value="utf-8">UTF-8</option>
                          <option value="iso-8859-1">ISO-8859-1</option>
                          <option value="windows-1252">Windows-1252</option>
                        </select>
                      </Field>
                    </div>
                    <Field id={fid("startup")} label="Startup command">
                      <input
                        id={fid("startup")}
                        type="text"
                        value={startup}
                        placeholder="Runs after login, for example tmux attach"
                        spellCheck={false}
                        onChange={(e) => setStartup(cleanText(e.target.value))}
                        style={inputStyle({ mono: true })}
                      />
                    </Field>
                    <div>
                      <LabelRow label="Environment variables" msg={envVars.map((v) => fe(`env:${v.id}`)).find(Boolean)} msgId={fid("env-err")} />
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {envVars.map((v, i) => (
                          <div key={v.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.4fr) 32px", gap: 6, alignItems: "start" }}>
                            <input
                              aria-label={`Variable ${i + 1} name`}
                              data-field={`env:${v.id}`}
                              type="text"
                              value={v.name}
                              placeholder="LANG"
                              spellCheck={false}
                              aria-invalid={!!fe(`env:${v.id}`) || undefined}
                              aria-describedby={fe(`env:${v.id}`) ? fid("env-err") : undefined}
                              onChange={(e) => {
                                const name = cleanText(e.target.value);
                                setEnvVars((cur) => cur.map((x) => (x.id === v.id ? { ...x, name } : x)));
                                clearErr(`env:${v.id}`);
                              }}
                              style={inputStyle({ mono: true, error: !!fe(`env:${v.id}`) })}
                            />
                            <input
                              aria-label={`Variable ${i + 1} value`}
                              type="text"
                              value={v.value}
                              placeholder="en_US.UTF-8"
                              spellCheck={false}
                              onChange={(e) => {
                                const value = e.target.value;
                                setEnvVars((cur) => cur.map((x) => (x.id === v.id ? { ...x, value } : x)));
                              }}
                              style={inputStyle({ mono: true })}
                            />
                            <button
                              type="button"
                              aria-label={`Remove variable ${v.name || i + 1}`}
                              title="Remove variable"
                              onClick={() => {
                                rescueFocus('[data-focus="add-env"]');
                                setEnvVars((cur) => cur.filter((x) => x.id !== v.id));
                                clearErr(`env:${v.id}`);
                              }}
                              style={{ ...iconBtn, width: 32, height: 32 }}
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        ))}
                        <div>
                          <button type="button" data-focus="add-env" onClick={() => setEnvVars((cur) => [...cur, { id: crypto.randomUUID(), name: "", value: "" }])} style={btn("secondary", { small: true })}>
                            <PlusIcon size={14} />
                            Add variable
                          </button>
                        </div>
                        <p style={hint}>Sent when a terminal opens. The server only accepts names its AcceptEnv setting allows.</p>
                      </div>
                    </div>
                  </section>

                  {/* AI access */}
                  <section aria-labelledby={fid("ai")} style={sectionStyle}>
                    <h4 id={fid("ai")} style={h3Style}>AI access</h4>
                    <p style={hint}>What AI assistants may do on this host. Ask means you approve each request.</p>
                    <div style={grid2}>
                      <div>
                        <span style={labelStyle}>Commands</span>
                        <Segmented<AiPolicy> name={fid("aicmd")} legend="Commands" value={aiPolicy} onChange={setAiPolicy} options={policyOptions} />
                      </div>
                      <div>
                        <span style={labelStyle}>Files</span>
                        <Segmented<AiPolicy> name={fid("aifile")} legend="Files" value={aiFilePolicy} onChange={setAiFilePolicy} options={policyOptions} />
                      </div>
                    </div>
                  </section>
                </div>
              )}
            </section>

            {saveErr && (
              <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--err)", overflowWrap: "anywhere" }}>
                {saveErr}
              </p>
            )}
          </div>

          <div style={p.inline ? { position: "sticky", bottom: -24, display: "flex", alignItems: "center", gap: 8, padding: "16px 0 24px", borderTop: "1px solid var(--line)", background: "var(--bg)" } : { display: "flex", alignItems: "center", gap: 8, padding: "14px 20px", borderTop: "1px solid var(--line)", background: "var(--bg-side)" }}>
            <button
              type="button"
              disabled={!canTest || test.state === "busy"}
              title={canTest ? "Tries to sign in with these settings" : "Fill in the connection details first"}
              onClick={testConnection}
              style={{ ...btn("secondary", { disabled: !canTest || test.state === "busy" }), padding: "0 12px" }}
            >
              <Stable text={test.state === "busy" ? "Testing…" : "Test connection"} alts={["Test connection", "Testing…"]} />
            </button>
            <span
              role="status"
              title={test.state === "ok" || test.state === "err" ? test.msg : undefined}
              style={{ flex: "1 1 0", minWidth: 0, display: "flex", alignItems: "center", gap: 6, overflow: "hidden", fontSize: 12, color: test.state === "ok" ? "var(--ok)" : test.state === "err" ? "var(--err)" : "var(--text-2)" }}
            >
              {test.state === "ok" && (
                <span style={{ display: "flex", flex: "none" }}>
                  <CheckIcon />
                </span>
              )}
              <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{test.state === "ok" || test.state === "err" ? test.msg : ""}</span>
            </span>
            {footerRight}
          </div>
          </form>
        </section>
      </Frame>
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          message={current ? `Your changes to ${current.name} are not saved.` : "This host is not saved yet."}
          confirmLabel="Discard"
          danger
          onConfirm={leave}
          onClose={() => setConfirmDiscard(false)}
        />
      )}
    </>
  );
}
