import { CSSProperties, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeText as clipWrite } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "../../api";
import type { Host, HostKeyChanged, KnownHostEntry } from "../../api";
import { IS_MAC, MONO, errText } from "../mock";
import { CheckIcon, SearchIcon, TrashIcon, WarningIcon } from "../icons";
import { Overlay, useModalLayer } from "../overlays/Dialogs";
import { Stable } from "../Stable";

const th: CSSProperties = { height: 32, padding: "0 12px", fontWeight: 500, textAlign: "left", color: "var(--text-2)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
const cell: CSSProperties = { padding: "0 12px", borderBottom: "1px solid var(--line-soft)" };
const pageBtn: CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
const dangerOutlineBtn: CSSProperties = { ...pageBtn, border: "1px solid var(--err)", background: "transparent", color: "var(--err)" };
const iconBtn: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", cursor: "pointer" };
const checkbox: CSSProperties = { width: 14, height: 14, margin: 0, accentColor: "var(--accent)", cursor: "pointer" };
const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

function disabledLook(disabled: boolean): CSSProperties {
  return disabled ? { opacity: 0.55, cursor: "default" } : {};
}

type Notice = { tone: "ok" | "err"; text: string } | null;
type Bar = { kind: "selection"; count: number } | { kind: "notice"; notice: NonNullable<Notice> };

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

async function sshPath(file?: string): Promise<string | undefined> {
  try {
    const home = await api.localHome();
    const sep = home.includes("\\") ? "\\" : "/";
    const dir = `${home.replace(/[\\/]+$/, "")}${sep}.ssh`;
    return file ? `${dir}${sep}${file}` : dir;
  } catch {
    return undefined;
  }
}

/** "ssh-ed25519" -> "ED25519", "ecdsa-sha2-nistp256" -> "ECDSA"; already short names pass through. */
function keyTypeLabel(t: string): string {
  const k = t.trim();
  if (k === "ssh-ed25519") return "ED25519";
  if (k === "sk-ssh-ed25519@openssh.com") return "ED25519-SK";
  if (k === "ssh-rsa") return "RSA";
  if (k === "ssh-dss") return "DSA";
  if (k.startsWith("ecdsa-sha2-")) return "ECDSA";
  if (k.startsWith("sk-ecdsa-sha2-")) return "ECDSA-SK";
  return k.toUpperCase() || "Unknown";
}

/** "SHA256:pX0mR4…L2aQ", like the design. */
function shortFingerprint(fp: string): string {
  const i = fp.indexOf(":");
  const prefix = i >= 0 ? fp.slice(0, i + 1) : "";
  const body = fp.slice(i + 1);
  return body.length > 12 ? `${prefix}${body.slice(0, 6)}…${body.slice(-4)}` : fp;
}

function hostLabel(host: string, port: number): string {
  return port === 22 ? host : `${host}:${port}`;
}

/** Parses one pattern of a known_hosts host field ("name" or "[name]:port"). */
function parsePattern(p: string): { host: string; port: number } {
  const m = /^\[(.+)\]:(\d+)$/.exec(p);
  return m ? { host: m[1], port: Number(m[2]) } : { host: p, port: 22 };
}

/** The readable names of a host field; hashed parts are left out. */
function plainNames(e: KnownHostEntry): string[] {
  return e.hosts
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("|1|"));
}

/**
 * Identity of an entry independent of its line number, which shifts whenever the file changes.
 * Selection and removal go by this, so a stale list can never remove someone else's line.
 */
function entryId(e: KnownHostEntry): string {
  return `${e.hosts}\u0000${e.key_type}\u0000${e.fingerprint}`;
}

function rowKey(e: KnownHostEntry): string {
  return `${e.line}\u0000${entryId(e)}`;
}

function entryName(e: KnownHostEntry): string {
  return e.hashed ? `hashed entry on line ${e.line}` : hostLabel(e.host, e.port);
}

/* ---------- host matching, mirroring the backend's hosts_match ---------- */

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** OpenSSH glob: `*` any run, `?` one character. */
function globMatch(pattern: string, text: string): boolean {
  const p = Array.from(pattern);
  const t = Array.from(text);
  let pi = 0;
  let ti = 0;
  let star: [number, number] | null = null;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === "*") {
      star = [pi, ti];
      pi++;
    } else if (star) {
      pi = star[0] + 1;
      ti = star[1] + 1;
      star = [star[0], star[1] + 1];
    } else {
      return false;
    }
  }
  return p.slice(pi).every((c) => c === "*");
}

/** One `|1|base64(salt)|base64(HMAC-SHA1(salt, name))` part against several spellings of a name. */
async function hashedMatch(entry: string, candidates: string[]): Promise<boolean> {
  const [, , salt, hash] = entry.split("|");
  if (!salt || !hash) return false;
  try {
    const want = b64ToBytes(hash);
    const key = await crypto.subtle.importKey("raw", b64ToBytes(salt), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    for (const c of candidates) {
      const got = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(c)));
      if (got.length === want.length && got.every((b, i) => b === want[i])) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function hostsMatch(field: string, host: string, port: number): Promise<boolean> {
  const target = port === 22 ? host : `[${host}]:${port}`;
  const lower = target.toLowerCase();
  let matched = false;
  for (const entry of field.split(",")) {
    if (entry.startsWith("|1|")) {
      if (await hashedMatch(entry, [target, lower])) matched = true;
      continue;
    }
    const negated = entry.startsWith("!");
    const pattern = negated ? entry.slice(1) : entry;
    if (globMatch(pattern.toLowerCase(), lower)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

/* ---------- screen ---------- */

function changedWhen(at: number | undefined): string {
  if (!at) return "changed";
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return `changed today at ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
  return `changed on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}

export function KnownHostsScreen(p: {
  changed: (HostKeyChanged & { at?: number })[];
  hosts?: Host[];
  active?: boolean;
  onReviewChanged(c: HostKeyChanged): void;
  onDismissChanged(c: HostKeyChanged): void;
}) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [entries, setEntries] = useState<KnownHostEntry[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [changedRows, setChangedRows] = useState<Set<string>>(new Set());
  const [rowHosts, setRowHosts] = useState<Map<string, Host[]>>(new Map());
  const [notice, setNotice] = useNotice();
  const [transfer, setTransfer] = useState<"" | "import" | "export">("");
  const [confirm, setConfirm] = useState<KnownHostEntry[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.knownHostsList();
      if (!alive.current) return;
      setEntries(list);
      setLoadErr("");
    } catch (e) {
      if (alive.current) setLoadErr(errText(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // Keyed by content so a parent passing a fresh array each render does not trigger reloads.
  const changedKey = p.changed.map((c) => `${c.host}\u0000${c.port}\u0000${c.key_type}\u0000${c.fingerprint}`).join("\u0001");
  const changedRef = useRef(p.changed);
  changedRef.current = p.changed;

  useEffect(() => {
    refresh();
  }, [refresh, changedKey]);

  const wasActive = useRef(p.active);
  useEffect(() => {
    if (p.active && wasActive.current === false) refresh();
    wasActive.current = p.active;
  }, [p.active, refresh]);

  const hostsKey = (p.hosts ?? []).map((h) => `${h.id}\u0000${h.name}\u0000${h.hostname}\u0000${h.port}`).join("\u0001");
  const hostsRef = useRef(p.hosts ?? []);
  hostsRef.current = p.hosts ?? [];
  useEffect(() => {
    const hosts = hostsRef.current;
    if (!entries || hosts.length === 0) {
      setRowHosts(new Map());
      return;
    }
    let live = true;
    (async () => {
      const out = new Map<string, Host[]>();
      for (const e of entries) {
        const hit: Host[] = [];
        for (const h of hosts) if (await hostsMatch(e.hosts, h.hostname, h.port)) hit.push(h);
        if (hit.length) out.set(rowKey(e), hit);
      }
      if (live) setRowHosts(out);
    })();
    return () => {
      live = false;
    };
  }, [entries, hostsKey]);

  const nameFor = (host: string, port: number) => (p.hosts ?? []).find((h) => h.hostname.toLowerCase() === host.toLowerCase() && h.port === port)?.name;

  // Which rows hold a saved key for a host whose key changed. Rows are matched the way the
  // backend matches them (wildcards, negations, hashed names), which needs async hashing.
  useEffect(() => {
    const changed = changedRef.current;
    if (!entries || changed.length === 0) {
      setChangedRows(new Set());
      return;
    }
    let live = true;
    (async () => {
      const hits = new Set<string>();
      for (const e of entries) {
        for (const c of changed) {
          if (await hostsMatch(e.hosts, c.host, c.port)) {
            hits.add(rowKey(e));
            break;
          }
        }
      }
      if (live) setChangedRows(hits);
    })();
    return () => {
      live = false;
    };
  }, [entries, changedKey]);

  // One banner per host and port, even when it reported several new keys.
  const banners = useMemo(() => {
    const groups = new Map<string, (HostKeyChanged & { at?: number })[]>();
    for (const c of p.changed) {
      const k = `${c.host}\u0000${c.port}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    return [...groups.entries()];
  }, [p.changed]);

  const visible = useMemo(() => {
    const all = entries ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return all;
    const word = q.replace(/[()]/g, "");
    return all.filter(
      (e) =>
        plainNames(e).some((n) => n.toLowerCase().includes(q)) ||
        (rowHosts.get(rowKey(e)) ?? []).some((h) => h.name.toLowerCase().includes(q) || hostLabel(h.hostname, h.port).toLowerCase().includes(q)) ||
        e.fingerprint.toLowerCase().includes(q) ||
        keyTypeLabel(e.key_type).toLowerCase().includes(q) ||
        (e.hashed && word.length >= 3 && "hashed".startsWith(word)),
    );
  }, [entries, filter, rowHosts]);

  const shownName = (e: KnownHostEntry) => {
    const m = rowHosts.get(rowKey(e));
    return m ? m.map((h) => h.name).join(", ") : entryName(e);
  };

  // Only rows the user can see stay selected, so a bulk remove never touches hidden or vanished entries.
  useEffect(() => {
    setSelected((cur) => {
      if (cur.size === 0) return cur;
      const shown = new Set(visible.map(entryId));
      const next = new Set([...cur].filter((id) => shown.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [visible]);

  const selectedRows = visible.filter((e) => selected.has(entryId(e)));
  const allSelected = visible.length > 0 && selectedRows.length === visible.length;
  const someSelected = selectedRows.length > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected, entries]);

  function toggle(e: KnownHostEntry) {
    const id = entryId(e);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected(allSelected ? new Set() : new Set(visible.map(entryId)));
  }

  async function copyFingerprint(e: KnownHostEntry) {
    try {
      await clipWrite(e.fingerprint);
      if (!alive.current) return;
      setCopied(rowKey(e));
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => alive.current && setCopied(null), 1400);
    } catch (err) {
      if (alive.current) setNotice({ tone: "err", text: `Could not copy: ${errText(err)}` });
    }
  }

  async function importFile() {
    if (transfer) return;
    setNotice(null);
    let path: string | null = null;
    try {
      const picked = await openDialog({ multiple: false, directory: false, title: "Import known_hosts", defaultPath: await sshPath() });
      path = typeof picked === "string" ? picked : null;
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: errText(e) });
      return;
    }
    if (!path || !alive.current) return;
    setTransfer("import");
    try {
      const added = await api.knownHostsImport(path);
      if (!alive.current) return;
      setNotice({
        tone: "ok",
        text: !added ? "Nothing new to import. Every entry was already known." : `Imported ${added} ${added === 1 ? "entry" : "entries"}.`,
      });
      await refresh();
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: `Import failed: ${errText(e)}` });
    } finally {
      if (alive.current) setTransfer("");
    }
  }

  async function exportFile() {
    if (transfer) return;
    setNotice(null);
    let path: string | null = null;
    try {
      const picked = await saveDialog({ title: "Export to known_hosts", defaultPath: (await sshPath("known_hosts")) ?? "known_hosts" });
      path = typeof picked === "string" ? picked : null;
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: errText(e) });
      return;
    }
    if (!path || !alive.current) return;
    setTransfer("export");
    try {
      const n = await api.knownHostsExport(path);
      if (!alive.current) return;
      setNotice({ tone: "ok", text: !n ? "Nothing to export. That file already has every entry." : `Exported ${n} ${n === 1 ? "entry" : "entries"} to ${path}.` });
    } catch (e) {
      if (alive.current) setNotice({ tone: "err", text: `Export failed: ${errText(e)}` });
    } finally {
      if (alive.current) setTransfer("");
    }
  }

  /** Looks the entries up again by identity right before removing, so shifted lines are never hit. */
  async function remove(list: KnownHostEntry[]) {
    const want = new Set(list.map(entryId));
    const done = list.length === 1 ? `Removed ${shownName(list[0])}.` : `Removed ${list.length} entries.`;
    const fresh = await api.knownHostsList();
    const hits = fresh.filter((e) => want.has(entryId(e)));
    if (new Set(hits.map(entryId)).size !== want.size) {
      if (alive.current) await refresh();
      throw new Error("The list changed, so nothing was removed. Check it and try again.");
    }
    await api.knownHostsRemove(hits.map((e) => e.line), hits);
    if (!alive.current) return;
    setSelected((cur) => new Set([...cur].filter((id) => !want.has(id))));
    setNotice({ tone: "ok", text: done });
    await refresh();
    const left = await api.knownHostsList().catch(() => null);
    if (!left || !alive.current) return;
    for (const c of changedRef.current) {
      let still = false;
      for (const e of left) {
        if (await hostsMatch(e.hosts, c.host, c.port)) {
          still = true;
          break;
        }
      }
      if (!still) p.onDismissChanged(c);
    }
  }

  const count = entries?.length ?? 0;
  const bar: Bar | null = selectedRows.length > 0 ? { kind: "selection", count: selectedRows.length } : notice ? { kind: "notice", notice } : null;
  const lastBar = useRef<Bar | null>(null);
  if (bar) lastBar.current = bar;
  const shown = bar ?? lastBar.current;

  return (
    <main style={{ position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 28px 14px" }}>
        <h1 style={{ flex: "none", margin: 0, fontSize: 20, fontWeight: 600 }}>Known hosts</h1>
        <span style={{ flex: "none", color: "var(--text-2)" }}>{entries === null ? (loadErr ? "" : "Loading…") : `${count} ${count === 1 ? "entry" : "entries"}`}</span>
        <div style={{ flex: 1 }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, height: 32, flex: "0 1 220px", minWidth: 120, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, boxSizing: "border-box", color: "var(--text-2)" }}>
          <SearchIcon size={14} />
          <span style={srOnly}>Filter known hosts</span>
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
            placeholder="Filter by host or fingerprint"
            style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--text)" }}
          />
        </label>
        <button type="button" onClick={importFile} disabled={!!transfer} title="Import an OpenSSH known_hosts file" style={{ ...pageBtn, flex: "none", ...disabledLook(!!transfer) }}>
          <Stable text={transfer === "import" ? "Importing…" : "Import…"} alts={["Import…", "Importing…"]} />
        </button>
        <button type="button" onClick={exportFile} disabled={!!transfer} title="Export to an OpenSSH known_hosts file" style={{ ...pageBtn, flex: "none", ...disabledLook(!!transfer) }}>
          <Stable text={transfer === "export" ? "Exporting…" : "Export…"} alts={["Export…", "Exporting…"]} />
        </button>
      </div>

      {banners.map(([key, group]) => {
        const first = group[0];
        const name = nameFor(first.host, first.port) ?? hostLabel(first.host, first.port);
        return (
          <div key={key} role="alert" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, margin: "0 28px 16px", padding: "12px 14px", border: "1px solid var(--warn)", borderRadius: 8, background: "var(--warn-tint)" }}>
            <span style={{ color: "var(--warn)", display: "flex" }}><WarningIcon size={18} /></span>
            <p style={{ flex: "1 1 320px", margin: 0, overflowWrap: "anywhere" }}>
              The host key of <strong>{name}</strong> {changedWhen(Math.max(...group.map((c) => c.at ?? 0)) || undefined)}. Check it before you connect again.
            </p>
            <button type="button" onClick={() => p.onReviewChanged(group[group.length - 1])} style={{ display: "flex", alignItems: "center", height: 28, padding: "0 12px", border: 0, borderRadius: 6, background: "var(--btn)", color: "var(--btn-text)", fontSize: 12, fontWeight: 500, cursor: "pointer" }}>Review</button>
            <button type="button" onClick={() => group.forEach((c) => p.onDismissChanged(c))} style={{ height: 28, padding: "0 10px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text-2)", fontSize: 12, cursor: "pointer" }}>Dismiss</button>
          </div>
        );
      })}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 28px 80px" }}>
        {loadErr && entries === null ? (
          <EmptyState>
            <span style={{ color: "var(--err)", fontSize: 12 }}>Could not read the known hosts: {loadErr}</span>
            <button type="button" onClick={refresh} disabled={loading} style={{ ...pageBtn, height: 28, fontSize: 12, ...disabledLook(loading) }}>Try again</button>
          </EmptyState>
        ) : entries === null ? (
          <EmptyState>Loading…</EmptyState>
        ) : entries.length === 0 ? (
          <EmptyState>
            <span>No known hosts yet.</span>
            <span style={{ fontSize: 12, color: "var(--text-3)" }}>Hosts you trust when you connect are saved here, encrypted in your vault. You can also import an existing known_hosts file.</span>
          </EmptyState>
        ) : (
          <>
            {loadErr && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--err)" }}>Could not refresh: {loadErr}</p>}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th scope="col" style={{ ...th, width: 36, padding: "0 0 0 12px" }}>
                    <input ref={selectAllRef} type="checkbox" aria-label="Select all shown entries" checked={allSelected} disabled={visible.length === 0} onChange={toggleAllVisible} style={{ ...checkbox, ...disabledLook(visible.length === 0) }} />
                  </th>
                  <th scope="col" style={th}>Host</th>
                  <th scope="col" style={th}>Port</th>
                  <th scope="col" style={th}>Key type</th>
                  <th scope="col" style={th}>Fingerprint</th>
                  <th scope="col" style={{ width: 40, borderBottom: "1px solid var(--line)" }}><span style={srOnly}>Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e) => {
                  const rk = rowKey(e);
                  const changed = changedRows.has(rk);
                  const checked = selected.has(entryId(e));
                  const isCopied = copied === rk;
                  const matched = rowHosts.get(rk);
                  const addresses = e.hashed ? (matched ?? []).map((h) => hostLabel(h.hostname, h.port)) : plainNames(e).map((a) => parsePattern(a).host);
                  const primary = matched ? matched.map((h) => h.name).join(", ") : e.hashed ? "(hashed)" : e.host;
                  const secondaryParts = matched ? addresses : e.hashed ? [`${e.hosts.slice(0, 14)}…`] : addresses.slice(1);
                  const secondary = [...new Set(secondaryParts)].filter((a) => a !== primary).join(" · ");
                  return (
                    <tr key={rk} style={{ background: checked ? "var(--sel)" : "transparent" }}>
                      <td style={{ ...cell, padding: "0 0 0 12px" }}>
                        <input type="checkbox" aria-label={`Select ${shownName(e)}`} checked={checked} onChange={() => toggle(e)} style={checkbox} />
                      </td>
                      <td style={{ ...cell, height: 46 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontWeight: 600, color: e.hashed && !matched ? "var(--text-2)" : "var(--text)", overflowWrap: "anywhere" }} title={e.hashed && !matched ? "OpenSSH stored this name hashed, so it cannot be shown." : e.hosts}>
                            {primary}
                          </span>
                          {changed && <span style={{ display: "inline-flex", alignItems: "center", height: 18, padding: "0 6px", borderRadius: 9, background: "var(--warn-tint)", color: "var(--warn)", fontSize: 11, fontWeight: 600 }}>Changed</span>}
                        </div>
                        {secondary && <div title={e.hosts} style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--text-2)", overflowWrap: "anywhere" }}>{secondary}</div>}
                      </td>
                      <td style={cell}>
                        {!e.hashed ? e.port : matched ? [...new Set(matched.map((h) => h.port))].join(", ") : <span style={{ color: "var(--text-3)" }} title="The port is part of the hashed name, so it cannot be shown.">unknown</span>}
                      </td>
                      <td style={cell} title={e.key_type}>{keyTypeLabel(e.key_type)}</td>
                      <td style={{ ...cell, fontFamily: MONO, fontSize: 12, color: "var(--text-2)" }}>
                        <button
                          type="button"
                          onClick={() => copyFingerprint(e)}
                          title={isCopied ? "Copied" : `${e.fingerprint}\nClick to copy`}
                          aria-label={isCopied ? "Fingerprint copied" : `Copy fingerprint of ${shownName(e)}`}
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: 0, border: 0, background: "transparent", font: "inherit", color: isCopied ? "var(--ok)" : "inherit", cursor: "copy", whiteSpace: "nowrap" }}
                        >
                          {shortFingerprint(e.fingerprint)}
                          <span aria-hidden="true" style={{ display: "flex", width: 12, visibility: isCopied ? "visible" : "hidden" }}><CheckIcon size={12} /></span>
                        </button>
                      </td>
                      <td style={{ padding: "0 8px", borderBottom: "1px solid var(--line-soft)" }}>
                        <button type="button" aria-label={`Remove ${shownName(e)}`} title="Remove" onClick={() => setConfirm([e])} style={iconBtn}><TrashIcon /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length === 0 && <p style={{ margin: "16px 12px", color: "var(--text-2)" }}>No entries match “{filter.trim()}”.</p>}
          </>
        )}
      </div>

      <div
        aria-hidden={bar ? undefined : true}
        inert={bar ? undefined : true}
        style={{ position: "absolute", left: "50%", bottom: 20, zIndex: 5, display: "flex", alignItems: "center", gap: 8, height: 40, maxWidth: "calc(100% - 56px)", padding: shown?.kind === "selection" ? "0 6px 0 14px" : "0 14px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", boxSizing: "border-box", opacity: bar ? 1 : 0, transform: `translate(-50%, ${bar ? 0 : 8}px)`, transition: "opacity 140ms ease-out, transform 140ms ease-out", pointerEvents: bar ? "auto" : "none" }}
      >
        {shown?.kind === "selection" ? (
          <>
            <span style={{ minWidth: 72, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{shown.count} selected</span>
            <button type="button" onClick={() => setConfirm(selectedRows)} style={{ ...dangerOutlineBtn, height: 28, padding: "0 10px", fontSize: 12 }}>
              <TrashIcon />
              Remove
            </button>
            <button type="button" onClick={() => setSelected(new Set())} style={{ height: 28, padding: "0 10px", border: 0, borderRadius: 6, background: "transparent", color: "var(--text-2)", fontSize: 12, cursor: "pointer" }}>Clear</button>
          </>
        ) : shown?.kind === "notice" ? (
          <span role="status" title={shown.notice.text} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12.5, color: shown.notice.tone === "err" ? "var(--err)" : "var(--text)" }}>{shown.notice.text}</span>
        ) : null}
      </div>

      {confirm && <RemoveDialog entries={confirm} nameOf={shownName} onConfirm={() => remove(confirm)} onClose={() => setConfirm(null)} />}
    </main>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 200, padding: 24, color: "var(--text-2)", textAlign: "center" }}>
      {children}
    </div>
  );
}

const LIST_MAX = 5;

/** Destructive, so Escape only (no backdrop close) and focus starts on Cancel. */
function RemoveDialog({ entries, nameOf, onConfirm, onClose }: { entries: KnownHostEntry[]; nameOf(e: KnownHostEntry): string; onConfirm(): Promise<void>; onClose(): void }) {
  const ref = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const close = () => {
    if (!busy) onClose();
  };
  const z = useModalLayer(ref, { onEscape: close, initialFocus: cancelRef });

  useEffect(() => {
    if (err) cancelRef.current?.focus();
  }, [err]);

  const single = entries.length === 1;
  async function run() {
    if (busy) return;
    setBusy(true);
    setErr("");
    try {
      await onConfirm();
      if (alive.current) onClose();
    } catch (e) {
      if (!alive.current) return;
      setErr(errText(e));
      setBusy(false);
    }
  }

  const cancelBtn = (
    <button key="cancel" ref={cancelRef} type="button" onClick={close} disabled={busy} style={{ ...pageBtn, padding: "0 14px", ...disabledLook(busy) }}>Cancel</button>
  );
  const removeBtn = (
    <button key="remove" type="button" onClick={run} disabled={busy} style={{ ...dangerOutlineBtn, padding: "0 14px", ...disabledLook(busy) }}>
      <Stable text={busy ? "Removing…" : "Remove"} alts={["Remove", "Removing…"]} />
    </button>
  );
  const shown = entries.slice(0, LIST_MAX);
  const more = entries.length - shown.length;

  return (
    <Overlay z={z}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-label={single ? "Remove known host" : "Remove known hosts"} tabIndex={-1} style={{ width: 440, maxWidth: "100%", maxHeight: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 14, padding: 24, borderRadius: 12, background: "var(--bg)", color: "var(--text)", boxShadow: "var(--shadow)", boxSizing: "border-box", outline: "none" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{single ? "Remove known host" : `Remove ${entries.length} known hosts`}</h2>
        <div style={{ color: "var(--text-2)", lineHeight: 1.5, overflowWrap: "anywhere" }}>
          {single ? (
            <p style={{ margin: 0 }}>
              Remove the {keyTypeLabel(entries[0].key_type)} key of <strong style={{ color: "var(--text)" }}>{nameOf(entries[0])}</strong> from your known hosts?
            </p>
          ) : (
            <>
              <p style={{ margin: 0 }}>Remove these entries from your known hosts?</p>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {shown.map((e) => (
                  <li key={rowKey(e)}>
                    <span style={{ color: "var(--text)" }}>{nameOf(e)}</span> ({keyTypeLabel(e.key_type)})
                  </li>
                ))}
                {more > 0 && <li>and {more} more</li>}
              </ul>
            </>
          )}
          <p style={{ margin: "8px 0 0" }}>You will be asked to verify the host key again on the next connection.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
          <p role="alert" title={err || undefined} style={{ flex: "1 1 0", minWidth: 0, margin: 0, fontSize: 12, lineHeight: "16px", color: "var(--err)", overflowWrap: "anywhere", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{err}</p>
          {IS_MAC ? [cancelBtn, removeBtn] : [removeBtn, cancelBtn]}
        </div>
      </section>
    </Overlay>
  );
}
