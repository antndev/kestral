import { CSSProperties, FormEvent, RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../../api";
import type { ForwardKind, Host, PortForward } from "../../api";
import { MONO, errText } from "../mock";
import { ForwardIcon, PlusIcon, TrashIcon } from "../icons";
import { ConfirmDialog as SharedConfirm } from "../overlays/Dialogs";
import { Stable } from "../Stable";
import { SegGroup, segItem } from "../SegGroup";
import { Block, Blocks, DetailHead, EditFooter, EmptyState, Facts, List, ListFilter, ListItem, ScreenHeader, SplitView, arrowNav, mono, muted, oneLine, pageBtn, primaryBtn } from "../kit";

const fieldLabel: CSSProperties = { display: "block", marginBottom: 6, fontSize: 12, fontWeight: 500, color: "var(--text-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const input: CSSProperties = { width: "100%", height: 32, padding: "0 10px", borderWidth: 1, borderStyle: "solid", borderColor: "var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text)", boxSizing: "border-box" };
const monoField: CSSProperties = { ...input, fontFamily: MONO, fontSize: 12 };
const dangerBtn: CSSProperties = { ...pageBtn, border: "1px solid var(--err)", background: "transparent", color: "var(--err)" };
const linkBtn: CSSProperties = { flex: "none", height: 18, padding: 0, border: 0, background: "transparent", color: "var(--link)", fontSize: 12, lineHeight: "18px", textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer", whiteSpace: "nowrap" };
const formGrid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 };
const addrPair: CSSProperties = { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 84px", gap: 10 };

function off(style: CSSProperties, disabled: boolean): CSSProperties {
  return disabled ? { ...style, opacity: 0.5, cursor: "default" } : style;
}

function withPort(host: string, port: number | string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

const bindHost = (h: string) => h.trim() || "127.0.0.1";

const unbracket = (h: string) => (h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h);

function normBind(h: string): string {
  const v = unbracket(bindHost(h).toLowerCase());
  return v === "localhost" ? "127.0.0.1" : v;
}

const isWildcard = (h: string) => h === "0.0.0.0" || h === "::";

function isLoopbackBind(h: string): boolean {
  const v = normBind(h);
  return v === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v);
}

// Two listeners clash on the same port when their addresses are equal or
// either one binds every interface.
function bindsOverlap(a: string, b: string): boolean {
  const x = normBind(a);
  const y = normBind(b);
  return x === y || isWildcard(x) || isWildcard(y);
}

function browserHost(h: string): string {
  const v = normBind(h);
  if (v === "127.0.0.1" || v === "::1" || isWildcard(v)) return "localhost";
  return v.includes(":") ? `[${v}]` : v;
}

const kindOf = (f: PortForward): ForwardKind => f.kind ?? "local";
const listensHere = (f: PortForward) => kindOf(f) !== "remote";
const ruleName = (f: PortForward) => (f.name ?? "").trim() || `Port ${kindOf(f) === "remote" ? f.remote_port : f.local_port}`;
const KIND_LABEL: Record<ForwardKind, string> = { local: "Local", remote: "Remote", dynamic: "Dynamic" };
const KIND_HINT: Record<ForwardKind, string> = {
  local: "A port on this computer reaches a service through the host",
  remote: "A port on the host reaches a service on this computer",
  dynamic: "A SOCKS proxy on this computer sends any connection through the host",
};

const WEB_PORTS = new Set([80, 443, 3000, 3001, 4000, 4200, 5000, 5173, 5601, 8000, 8008, 8080, 8081, 8088, 8443, 8888, 9000, 9090, 9443]);
const TLS_PORTS = new Set([443, 8443, 9443]);

function webUrl(f: PortForward): string | null {
  if (kindOf(f) !== "local" || !WEB_PORTS.has(f.remote_port)) return null;
  return `${TLS_PORTS.has(f.remote_port) ? "https" : "http"}://${browserHost(f.local_host)}:${f.local_port}`;
}

function parsePort(v: string): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  const n = Number(v.trim());
  return n >= 1 && n <= 65535 ? n : null;
}

type Row = { host: Host; f: PortForward };

interface Draft {
  name: string;
  kind: ForwardKind;
  listenHost: string;
  listenPort: string;
  hostId: string;
  destHost: string;
  destPort: string;
  autostart: boolean;
  startOnConnect: boolean;
}

function draftOf(r: Row): Draft {
  const kind = kindOf(r.f);
  const remote = kind === "remote";
  return {
    name: r.f.name ?? "",
    kind,
    listenHost: remote ? (r.f.remote_host || "localhost") : bindHost(r.f.local_host),
    listenPort: String(remote ? r.f.remote_port : r.f.local_port),
    hostId: r.host.id,
    destHost: remote ? r.f.local_host || "127.0.0.1" : kind === "dynamic" ? "" : r.f.remote_host,
    destPort: remote ? String(r.f.local_port) : kind === "dynamic" ? "" : String(r.f.remote_port),
    autostart: r.f.autostart,
    startOnConnect: !!r.f.start_on_connect,
  };
}

const blankDraft = (hostId: string): Draft => ({ name: "", kind: "local", listenHost: "127.0.0.1", listenPort: "", hostId, destHost: "localhost", destPort: "", autostart: false, startOnConnect: false });

const sameDraft = (a: Draft, b: Draft) => (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k]);

function listenOf(d: Draft, hostName: string): string {
  const port = d.listenPort.trim();
  if (!port) return "";
  const b = d.listenHost.trim() || (d.kind === "remote" ? "localhost" : "127.0.0.1");
  return withPort(d.kind === "remote" && hostName && isLoopbackBind(b) ? hostName : b, port);
}

function destOf(d: Draft): string {
  if (d.kind === "dynamic") return "Any";
  const port = d.destPort.trim();
  return port ? withPort(d.destHost.trim() || (d.kind === "remote" ? "127.0.0.1" : "localhost"), port) : "";
}

function exposureOf(d: Draft): { text: string; title: string } | null {
  if (isLoopbackBind(d.listenHost.trim() || (d.kind === "remote" ? "localhost" : "127.0.0.1"))) return null;
  return d.kind === "remote"
    ? { text: "Reachable from other machines", title: "The server only allows this with GatewayPorts in its sshd_config." }
    : { text: "Reachable from your network", title: "Use 127.0.0.1 to keep it on this computer." };
}

type StartMode = "manual" | "open" | "connect" | "both";
const START_MODES: StartMode[] = ["manual", "open", "connect"];
const START_LABEL: Record<StartMode, string> = { manual: "Manually", open: "When Kestral opens", connect: "When the host connects", both: "When Kestral opens or the host connects" };
const startModeOf = (d: Draft): StartMode => (d.autostart ? (d.startOnConnect ? "both" : "open") : d.startOnConnect ? "connect" : "manual");

// Unsaved edits per rule. Module level so they survive selecting another rule
// and leaving the screen.
let keptDrafts: Record<string, Draft> = {};

function Toggle({ on, busy, disabled, label, title, onClick }: { on: boolean; busy: boolean; disabled?: boolean; label: string; title?: string; onClick(): void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      aria-busy={busy}
      disabled={busy || disabled}
      title={disabled ? "Save the rule first" : title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{ position: "relative", display: "block", flex: "none", width: 30, height: 18, padding: 0, border: 0, borderRadius: 9, background: on ? "var(--ok)" : "var(--light-ring)", cursor: busy || disabled ? "default" : "pointer", opacity: disabled ? 0.4 : busy ? 0.6 : 1 }}
    >
      <span aria-hidden="true" style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "#FFFFFF", transition: "left .12s" }} />
    </button>
  );
}

const Dot = ({ color, label }: { color: string; label: string }) => (
  <span role="img" aria-label={label} title={label} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flex: "none" }}>
    <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
  </span>
);

const At = ({ addr, where }: { addr: string; where: string }) => (
  <span title={`${addr} on ${where}`}>
    <span style={mono}>{addr}</span>
    <span style={muted}> on {where}</span>
  </span>
);

type Item = { id: string; row: Row | null; name: string; d: Draft; hostName: string; unsaved: boolean };

function routeOf(it: Item): string {
  const listen = listenOf(it.d, it.hostName);
  const dest = it.d.kind === "dynamic" ? "" : destOf(it.d);
  const path = listen && dest ? `${listen} to ${dest}` : listen || (dest ? `to ${dest}` : "");
  const rest = [path, it.hostName ? `via ${it.hostName}` : ""].filter(Boolean).join(" ");
  return rest ? `${KIND_LABEL[it.d.kind]} · ${rest}` : KIND_LABEL[it.d.kind];
}

export function PortForwardingScreen({ hosts: hostsProp, onHostsChanged, onConfirmHosts }: { hosts: Host[]; onHostsChanged(): void; onConfirmHosts?(hostIds: string[], then: () => void): void }) {
  const [hosts, setHosts] = useState<Host[]>(hostsProp);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<Record<string, "start" | "stop">>({});
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const [selId, setSelId] = useState<string | null>(() => hostsProp.flatMap((h) => h.forwards).find((f) => f.id in keptDrafts)?.id ?? null);
  const [newDraft, setNewDraft] = useState<{ id: string; draft: Draft } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const [drafts, setDraftsState] = useState<Record<string, Draft>>(keptDrafts);
  const [filter, setFilter] = useState("");
  const alive = useRef(true);
  const focusName = useRef(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const prevSel = useRef<string | null>(null);

  useEffect(() => setHosts(hostsProp), [hostsProp]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshActive = useCallback(async () => {
    try {
      const ids = await api.forwardActive();
      if (!alive.current) return;
      setActive(new Set(ids));
      if (ids.length > 0) {
        const s = await api.forwardStats().catch(() => null);
        if (s && alive.current) setStats(s);
      } else setStats({});
    } catch {
      /* vault locked; the next poll tries again */
    }
  }, []);

  useEffect(() => {
    void refreshActive();
    const iv = window.setInterval(() => void refreshActive(), 3000);
    return () => window.clearInterval(iv);
  }, [refreshActive]);

  const setDrafts = useCallback((fn: (d: Record<string, Draft>) => Record<string, Draft>) => {
    setDraftsState((cur) => {
      const next = fn(cur);
      keptDrafts = next;
      return next;
    });
  }, []);

  const rows: Row[] = useMemo(() => hosts.flatMap((h) => h.forwards.map((f) => ({ host: h, f }))), [hosts]);
  const activeCount = rows.filter((r) => active.has(r.f.id)).length;
  const newRow = newDraft && !rows.some((r) => r.f.id === newDraft.id) ? newDraft : null;
  const known = selId !== null && (rows.some((r) => r.f.id === selId) || newRow?.id === selId);
  const selectedId = known ? selId : rows[0]?.f.id ?? newRow?.id ?? null;
  const current = rows.find((r) => r.f.id === selectedId) ?? null;
  const showingNew = !current && !!newRow && newRow.id === selectedId;
  const detailId = current?.f.id ?? (showingNew && newRow ? newRow.id : null);
  const empty = rows.length === 0 && !newRow;

  const items: Item[] = rows.map((r) => ({ id: r.f.id, row: r, name: ruleName(r.f), d: draftOf(r), hostName: r.host.name, unsaved: r.f.id in drafts }));
  if (newRow) items.push({ id: newRow.id, row: null, name: newRow.draft.name.trim() || "New rule", d: newRow.draft, hostName: hosts.find((h) => h.id === newRow.draft.hostId)?.name ?? "", unsaved: true });

  const q = filter.trim().toLowerCase();
  const shown = q ? items.filter((it) => [it.name, routeOf(it)].some((s) => s.toLowerCase().includes(q))) : items;

  // Forget drafts of rules that are gone or that match what is stored again.
  useEffect(() => {
    if (hosts.length === 0) return;
    setDrafts((d) => {
      const keep = Object.entries(d).filter(([id, draft]) => {
        const r = rows.find((x) => x.f.id === id);
        return !!r && !sameDraft(draft, draftOf(r));
      });
      return keep.length === Object.keys(d).length ? d : Object.fromEntries(keep);
    });
  }, [hosts.length, rows, setDrafts]);

  useEffect(() => {
    if (focusName.current && showingNew) {
      focusName.current = false;
      nameRef.current?.focus();
    }
  }, [showingNew]);

  function select(id: string) {
    if (newRow && id === newRow.id && selectedId !== id) prevSel.current = selectedId;
    setSelId(id);
  }

  async function toggle(r: Row, checked = false) {
    const id = r.f.id;
    if (pending[id]) return;
    const on = active.has(id);
    if (!on && !checked && onConfirmHosts) {
      onConfirmHosts([r.host.id], () => void toggle(r, true));
      return;
    }
    setPending((p) => ({ ...p, [id]: on ? "stop" : "start" }));
    setRowErr((e) => ({ ...e, [id]: "" }));
    try {
      if (on) await api.forwardStop(r.host.id, id);
      else await api.forwardStart(r.host.id, id);
    } catch (e) {
      if (alive.current) setRowErr((p) => ({ ...p, [id]: errText(e) }));
    }
    await refreshActive();
    if (alive.current)
      setPending((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
  }

  function startNewRule() {
    if (hosts.length === 0) return;
    setFilter("");
    if (newRow) {
      if (showingNew) nameRef.current?.focus();
      else {
        prevSel.current = selectedId;
        focusName.current = true;
        setSelId(newRow.id);
      }
      return;
    }
    const id = crypto.randomUUID();
    prevSel.current = selectedId;
    focusName.current = true;
    setNewDraft({ id, draft: blankDraft(hosts.length === 1 ? hosts[0].id : "") });
    setSelId(id);
  }

  async function deleteRule(r: Row) {
    await api.forwardStop(r.host.id, r.f.id).catch(() => {});
    const fresh = await api.hostList();
    const host = fresh.find((h) => h.id === r.host.id);
    if (!host) throw new Error("This host no longer exists.");
    const updated = { ...host, forwards: host.forwards.filter((f) => f.id !== r.f.id) };
    await api.hostUpdate(updated);
    onHostsChanged();
    setDrafts((d) => {
      if (!(r.f.id in d)) return d;
      const next = { ...d };
      delete next[r.f.id];
      return next;
    });
    if (!alive.current) return;
    const idx = rows.findIndex((x) => x.f.id === r.f.id);
    const next = rows[idx + 1] ?? rows[idx - 1] ?? null;
    setHosts(fresh.map((h) => (h.id === host.id ? updated : h)));
    setSelId(next && next.f.id !== r.f.id ? next.f.id : null);
    setRowErr((e) => ({ ...e, [r.f.id]: "" }));
    void refreshActive();
  }

  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Port forwarding" meta={rows.length > 0 ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{activeCount} of {rows.length} active</span> : undefined}>
        {!empty && (
          <button type="button" onClick={startNewRule} style={primaryBtn}>
            <PlusIcon size={14} sw={1.75} />
            New rule
          </button>
        )}
      </ScreenHeader>

      {empty ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", borderTop: "1px solid var(--line)" }}>
          <EmptyState icon={<ForwardIcon size={20} />}>
            <span>{hosts.length === 0 ? "Add a host first to forward ports" : "No port forwarding rules yet"}</span>
            {hosts.length > 0 && (
              <button type="button" onClick={startNewRule} style={primaryBtn}>
                <PlusIcon size={14} sw={1.75} />
                New rule
              </button>
            )}
          </EmptyState>
        </div>
      ) : (
        <SplitView
          detailLabel="Rule details"
          list={
            <>
              <ListFilter value={filter} onChange={setFilter} placeholder="Filter rules" />
              {shown.length === 0 ? (
                <p style={{ margin: 8, fontSize: 12, color: "var(--text-2)" }}>No rules match “{filter.trim()}”.</p>
              ) : (
                <List label="Rules">
                  {shown.map((it, i) => {
                    const r = it.row;
                    const err = rowErr[it.id];
                    const on = active.has(it.id);
                    return (
                      <ListItem
                        key={it.id}
                        buttonRef={(el) => {
                          if (el) itemRefs.current.set(it.id, el);
                          else itemRefs.current.delete(it.id);
                        }}
                        icon={<ForwardIcon />}
                        iconColor={on ? "var(--ok)" : err ? "var(--err)" : undefined}
                        title={
                          <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                            <span title={it.name} style={oneLine}>{it.name}</span>
                            {it.unsaved && <Dot color="var(--warn)" label="Unsaved changes" />}
                          </span>
                        }
                        sub={<span title={routeOf(it)}>{routeOf(it)}</span>}
                        selected={it.id === selectedId}
                        onSelect={() => select(it.id)}
                        onKeyDown={(e) => arrowNav(shown, i, e, select, (id) => itemRefs.current.get(id)?.focus())}
                        trailing={
                          r ? (
                            <Toggle on={on} busy={!!pending[it.id]} label={`${it.name} active`} title={err ? `Could not start: ${err}` : undefined} onClick={() => void toggle(r)} />
                          ) : (
                            <Toggle on={false} busy={false} disabled label={`${it.name} active`} onClick={() => {}} />
                          )
                        }
                      />
                    );
                  })}
                </List>
              )}
            </>
          }
        >
          {detailId && (
            <RuleDetail
              key={detailId}
              id={detailId}
              row={current}
              rows={rows}
              hosts={hosts}
              active={!!current && active.has(current.f.id)}
              connections={stats[detailId] ?? 0}
              activeIds={active}
              pending={pending[detailId]}
              error={rowErr[detailId] ?? ""}
              draft={current ? drafts[current.f.id] ?? null : newRow?.draft ?? null}
              onDraft={(d) => {
                if (!current) {
                  if (d) setNewDraft((n) => (n ? { ...n, draft: d } : n));
                  return;
                }
                const id = current.f.id;
                const base = draftOf(current);
                setDrafts((cur) => {
                  const next = { ...cur };
                  if (d && !sameDraft(d, base)) next[id] = d;
                  else delete next[id];
                  return next;
                });
              }}
              nameRef={nameRef}
              onToggle={() => {
                if (current) void toggle(current);
              }}
              onDelete={() => setConfirmDelete(current)}
              onCancel={() => {
                const prev = prevSel.current;
                const back = prev && rows.some((r) => r.f.id === prev) ? prev : rows[0]?.f.id ?? null;
                prevSel.current = null;
                setNewDraft(null);
                setSelId(back);
                if (back) requestAnimationFrame(() => itemRefs.current.get(back)?.focus());
              }}
              onSaved={(id, next, restartErr) => {
                onHostsChanged();
                setDrafts((cur) => {
                  if (!(id in cur)) return cur;
                  const rest = { ...cur };
                  delete rest[id];
                  return rest;
                });
                if (!alive.current) return;
                setNewDraft((n) => (n?.id === id ? null : n));
                setHosts(next);
                if (restartErr !== null) setRowErr((e) => ({ ...e, [id]: restartErr }));
                void refreshActive();
              }}
              refreshActive={refreshActive}
            />
          )}
        </SplitView>
      )}

      {confirmDelete && (
        <ConfirmDeleteDialog
          name={ruleName(confirmDelete.f)}
          hostName={confirmDelete.host.name}
          onConfirm={() => deleteRule(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </main>
  );
}

function RuleDetail({
  id,
  row,
  rows,
  hosts,
  active,
  connections,
  activeIds,
  pending,
  error,
  draft: kept,
  onDraft,
  nameRef,
  onToggle,
  onDelete,
  onCancel,
  onSaved,
  refreshActive,
}: {
  id: string;
  row: Row | null;
  rows: Row[];
  hosts: Host[];
  active: boolean;
  connections: number;
  activeIds: Set<string>;
  pending: "start" | "stop" | undefined;
  error: string;
  draft: Draft | null;
  onDraft(d: Draft | null): void;
  nameRef: RefObject<HTMLInputElement | null>;
  onToggle(): void;
  onDelete(): void;
  onCancel(): void;
  onSaved(id: string, hosts: Host[], restartErr: string | null): void;
  refreshActive(): Promise<void>;
}) {
  const saved = useMemo(() => (row ? draftOf(row) : null), [row]);
  const draft = kept ?? saved ?? blankDraft("");
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [formWarn, setFormWarn] = useState("");
  const [bad, setBad] = useState<Partial<Record<keyof Draft, boolean>>>({});
  const [editing, setEditing] = useState(() => !row || !!kept);
  const editMode = editing || !row;
  const focusTo = useRef<"name" | "edit" | null>(null);
  const editRef = useRef<HTMLButtonElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const to = focusTo.current;
    focusTo.current = null;
    if (to === "name") nameRef.current?.focus();
    else if (to === "edit") editRef.current?.focus();
  }, [editMode, nameRef]);

  const dirty = !saved || !sameDraft(draft, saved);
  const set = (patch: Partial<Draft>) => {
    onDraft({ ...draft, ...patch });
    setBad((b) => {
      const next = { ...b };
      for (const k of Object.keys(patch) as (keyof Draft)[]) delete next[k];
      return next;
    });
    setFormErr("");
    setFormWarn("");
  };
  const startEdit = () => {
    setFormErr("");
    setFormWarn("");
    focusTo.current = "name";
    setEditing(true);
  };
  const cancelEdit = () => {
    if (!row) {
      onCancel();
      return;
    }
    onDraft(null);
    setBad({});
    setFormErr("");
    setFormWarn("");
    focusTo.current = "edit";
    setEditing(false);
  };

  async function saveStart(m: StartMode) {
    if (!row || saving) return;
    setSaving(true);
    setFormErr("");
    try {
      const fresh = await api.hostList();
      const h = fresh.find((x) => x.id === row.host.id);
      const cur = h?.forwards.find((f) => f.id === id);
      if (!h) throw new Error("That host no longer exists.");
      if (!cur) throw new Error("This rule no longer exists.");
      const updated: PortForward = { ...cur, autostart: m === "open" || m === "both", start_on_connect: m === "connect" || m === "both" };
      const next = { ...h, forwards: h.forwards.map((f) => (f.id === id ? updated : f)) };
      await api.hostUpdate(next);
      onSaved(id, fresh.map((x) => (x.id === next.id ? next : x)), null);
    } catch (e) {
      if (alive.current) setFormErr(errText(e));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  const throughHost = hosts.find((h) => h.id === draft.hostId) ?? null;
  const kind = draft.kind;
  const dynamic = kind === "dynamic";
  const listenDefault = kind === "remote" ? "localhost" : "127.0.0.1";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty || saving || pending) return;
    const lport = parsePort(draft.listenPort);
    const dport = dynamic ? row?.f.remote_port || 1 : parsePort(draft.destPort);
    const destHost = dynamic ? row?.f.remote_host || "localhost" : draft.destHost.trim();
    const listenHost = draft.listenHost.trim() || listenDefault;
    const nextBad: Partial<Record<keyof Draft, boolean>> = {};
    if (!throughHost) nextBad.hostId = true;
    if (lport === null) nextBad.listenPort = true;
    if (dport === null) nextBad.destPort = true;
    if (!destHost || /\s/.test(destHost)) nextBad.destHost = true;
    if (/\s/.test(listenHost)) nextBad.listenHost = true;
    if (!throughHost || lport === null || dport === null || Object.keys(nextBad).length > 0) {
      setBad(nextBad);
      setFormErr(!throughHost ? "Choose a host." : lport === null || dport === null ? "Enter a port from 1 to 65535." : !destHost ? "Enter a destination." : "Addresses cannot contain spaces.");
      return;
    }
    setFormWarn("");
    const listenChanged = !row || kind !== kindOf(row.f) || lport !== row.f.local_port || listenHost !== bindHost(row.f.local_host) || draft.hostId !== row.host.id;
    const clash = listenChanged && kind !== "remote" ? rows.find((r) => r.f.id !== id && listensHere(r.f) && r.f.local_port === lport && bindsOverlap(r.f.local_host, listenHost)) : undefined;
    if (clash && (clash.host.id === draft.hostId || activeIds.has(clash.f.id))) {
      setBad({ listenPort: true });
      setFormErr(`Port ${lport} is used by "${ruleName(clash.f)}"${activeIds.has(clash.f.id) ? ", which is running" : ""}.`);
      return;
    }
    if (clash) setFormWarn(`"${ruleName(clash.f)}" on ${clash.host.name} uses this port too, so only one can run at a time.`);

    const base: PortForward = row?.f ?? { id, name: "", local_host: "", local_port: 0, remote_host: "", remote_port: 0, autostart: false, kind, start_on_connect: false };
    const merged: PortForward = { ...base, name: draft.name.trim(), kind, autostart: draft.autostart, start_on_connect: draft.startOnConnect };
    const updated: PortForward =
      kind === "remote"
        ? { ...merged, remote_host: listenHost, remote_port: lport, local_host: destHost, local_port: dport }
        : { ...merged, local_host: listenHost, local_port: lport, remote_host: destHost, remote_port: dport };
    const moved = !!row && draft.hostId !== row.host.id;
    const tunnelChanged =
      !row || moved || kind !== kindOf(row.f) || updated.local_host !== row.f.local_host || updated.local_port !== row.f.local_port || updated.remote_host !== row.f.remote_host || updated.remote_port !== row.f.remote_port;
    const restart = active && tunnelChanged;

    setSaving(true);
    setFormErr("");
    let stopped = false;
    try {
      if (restart && row) {
        await api.forwardStop(row.host.id, id);
        stopped = true;
      }
      const fresh = await api.hostList();
      const to = fresh.find((h) => h.id === draft.hostId);
      const from = row ? fresh.find((h) => h.id === row.host.id) : to;
      if (!from || !to) throw new Error("That host no longer exists.");
      let next: Host[];
      if (!moved) {
        const h = { ...to, forwards: row ? to.forwards.map((f) => (f.id === id ? updated : f)) : [...to.forwards, updated] };
        await api.hostUpdate(h);
        next = fresh.map((x) => (x.id === h.id ? h : x));
      } else {
        // Add to the new host first so a failure can never lose the rule.
        const toNext = { ...to, forwards: [...to.forwards.filter((f) => f.id !== id), updated] };
        const fromNext = { ...from, forwards: from.forwards.filter((f) => f.id !== id) };
        await api.hostUpdate(toNext);
        try {
          await api.hostUpdate(fromNext);
        } catch (e) {
          await api.hostUpdate(to).catch(() => {});
          throw e;
        }
        next = fresh.map((x) => (x.id === toNext.id ? toNext : x.id === fromNext.id ? fromNext : x));
      }
      let restartErr = "";
      if (restart) {
        try {
          await api.forwardStart(draft.hostId, id);
        } catch (e) {
          restartErr = errText(e);
        }
      }
      onSaved(id, next, restartErr);
      if (alive.current) {
        focusTo.current = "edit";
        setEditing(false);
      }
    } catch (e) {
      if (stopped && row) await api.forwardStart(row.host.id, id).catch(() => {});
      if (alive.current) setFormErr(errText(e));
      void refreshActive();
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  const status: { dot: string; text: string } = !row
    ? { dot: "var(--ring-idle)", text: "Not saved yet" }
    : pending === "start"
      ? { dot: "var(--warn)", text: "Starting…" }
      : pending === "stop"
        ? { dot: "var(--warn)", text: "Stopping…" }
        : active
          ? { dot: "var(--ok)", text: connections > 0 ? `Active, ${connections} ${connections === 1 ? "connection" : "connections"}` : "Active" }
          : error
            ? { dot: "var(--err)", text: `Could not start: ${error}` }
            : { dot: "var(--ring-idle)", text: "Stopped" };

  const web = row ? webUrl(row.f) : null;
  const exposure = exposureOf(draft);
  const msg: { tone: "err" | "warn" | "muted"; text: string; title?: string } | null = formErr
    ? { tone: "err", text: formErr }
    : formWarn
      ? { tone: "warn", text: formWarn }
      : exposure
        ? { tone: "warn", ...exposure }
        : dirty && row
          ? { tone: "muted", text: "Unsaved changes" }
          : null;
  const msgColor = msg?.tone === "err" ? "var(--err)" : msg?.tone === "warn" ? "var(--warn)" : "var(--text-3)";

  const field = (k: keyof Draft, base: CSSProperties): CSSProperties => (bad[k] ? { ...base, borderColor: "var(--err)" } : base);
  const segBtn = (on: boolean): CSSProperties => segItem(on, { padding: "0 12px" });
  const pickKind = (k: ForwardKind) => {
    if (k === kind) return;
    const patch: Partial<Draft> = { kind: k };
    if (k === "remote") {
      if (kind !== "remote") {
        patch.listenHost = "localhost";
        patch.destHost = "127.0.0.1";
        patch.destPort = draft.listenPort;
      }
    } else if (kind === "remote") {
      patch.listenHost = "127.0.0.1";
      patch.listenPort = draft.destPort || draft.listenPort;
      patch.destHost = k === "dynamic" ? "" : "localhost";
      patch.destPort = k === "dynamic" ? "" : draft.listenPort;
    } else if (k === "dynamic") {
      patch.destHost = "";
      patch.destPort = "";
    } else if (!draft.destHost.trim()) {
      patch.destHost = "localhost";
      patch.destPort = "80";
    }
    set(patch);
  };

  const title = row ? ruleName(row.f) : "New rule";
  const locked = saving || (!!row && !!pending);

  const sub = (
    <>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: status.dot }} />
        <span title={status.text} style={oneLine}>{status.text}</span>
      </span>
      {web && (
        <button type="button" disabled={!active} onClick={() => void openUrl(web).catch((e) => setFormErr(errText(e)))} style={{ ...linkBtn, visibility: active ? "visible" : "hidden" }}>
          Open in browser
        </button>
      )}
    </>
  );

  if (!editMode && row && saved) {
    const k = saved.kind;
    const hostName = row.host.name;
    const listenAddr = withPort(saved.listenHost.trim() || (k === "remote" ? "localhost" : "127.0.0.1"), saved.listenPort);
    const destAddr = withPort(saved.destHost.trim() || (k === "remote" ? "127.0.0.1" : "localhost"), saved.destPort);
    const reach = exposureOf(saved);
    const note = formErr ? { err: true, text: formErr } : formWarn ? { err: false, text: formWarn } : null;
    const busy = !!pending || saving;
    return (
      <>
        <DetailHead
          title={title}
          sub={sub}
          actions={
            <>
              <button type="button" onClick={onToggle} disabled={busy} style={off(primaryBtn, busy)}>
                <Stable text={pending === "start" ? "Starting…" : pending === "stop" ? "Stopping…" : active ? "Stop" : "Start"} alts={["Start", "Stop", "Starting…", "Stopping…"]} />
              </button>
              <button ref={editRef} type="button" aria-label={`Edit ${title}`} onClick={startEdit} style={pageBtn}>
                Edit
              </button>
              <button type="button" aria-label={`Delete ${title}`} onClick={onDelete} disabled={locked} title={pending ? "Wait until the tunnel has started or stopped" : undefined} style={off(pageBtn, locked)}>
                Delete
              </button>
            </>
          }
        />

        <Blocks>
          <Block title="Forwarding">
            <Facts
              rows={[
                ["Type", <span title={KIND_HINT[k]}>{KIND_LABEL[k]}</span>],
                ["Listen on", <At addr={listenAddr} where={k === "remote" ? hostName : "this computer"} />],
                ["Through host", hostName],
                ["Destination", k === "dynamic" ? <span style={muted}>Any (SOCKS proxy)</span> : k === "remote" ? <At addr={destAddr} where="this computer" /> : <span title={destAddr} style={mono}>{destAddr}</span>],
              ]}
            />
          </Block>
          <Block title="Behaviour">
            <Facts
              rows={[
                [
                  "Start",
                  <select
                    aria-label="Start"
                    value={startModeOf(saved)}
                    disabled={saving}
                    onChange={(e) => void saveStart(e.target.value as StartMode)}
                    style={{ maxWidth: "100%", height: 18, margin: "0 0 0 -4px", padding: "0 2px", border: 0, borderRadius: 4, background: "transparent", color: "var(--text)", font: "inherit", cursor: saving ? "default" : "pointer" }}
                  >
                    {START_MODES.map((m) => (
                      <option key={m} value={m}>{START_LABEL[m]}</option>
                    ))}
                    {startModeOf(saved) === "both" && <option value="both">{START_LABEL.both}</option>}
                  </select>,
                ],
                ["Reachable", reach ? <span title={reach.title} style={{ color: "var(--warn)" }}>{k === "remote" ? "From other machines" : "From your network"}</span> : `Only from ${k === "remote" ? hostName : "this computer"}`],
              ]}
            />
          </Block>
        </Blocks>

        <p role="status" title={note?.text} style={{ ...oneLine, height: 18, margin: 0, fontSize: 12, lineHeight: "18px", color: note?.err ? "var(--err)" : "var(--warn)" }}>
          <span key={note?.text} role={note?.err ? "alert" : undefined}>{note?.text}</span>
        </p>
      </>
    );
  }

  return (
    <form onSubmit={(e) => void save(e)} noValidate aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <DetailHead title={title} sub={sub} />

      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
        <span style={fieldLabel}>Type</span>
        <SegGroup label="Type" value={kind} style={{ flex: "none" }}>
          {(["local", "remote", "dynamic"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              title={KIND_HINT[k]}
              onClick={() => pickKind(k)}
              style={segBtn(kind === k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </SegGroup>
      </div>

      <div style={formGrid}>
        <div style={{ minWidth: 0 }}>
          <label htmlFor="pf-name" style={fieldLabel}>Name</label>
          <input id="pf-name" ref={nameRef} type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={draft.listenPort.trim() ? `Port ${draft.listenPort.trim()}` : "Optional"} style={input} />
        </div>
        <div style={{ minWidth: 0 }}>
          <label htmlFor="pf-via" style={fieldLabel}>Through host</label>
          <select id="pf-via" value={throughHost ? draft.hostId : ""} onChange={(e) => set({ hostId: e.target.value })} aria-invalid={bad.hostId || undefined} style={field("hostId", { ...input, padding: "0 8px" })}>
            {!throughHost && (
              <option value="" disabled>
                Choose a host
              </option>
            )}
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>{h.name}</option>
            ))}
          </select>
        </div>
        <div style={addrPair}>
          <div style={{ minWidth: 0 }}>
            <label htmlFor="pf-listen" style={fieldLabel}>{kind === "remote" ? `Listen on ${throughHost?.name ?? "the host"}` : "Listen on this computer"}</label>
            <input id="pf-listen" type="text" value={draft.listenHost} onChange={(e) => set({ listenHost: e.target.value })} placeholder={listenDefault} spellCheck={false} aria-invalid={bad.listenHost || undefined} style={field("listenHost", monoField)} />
          </div>
          <div>
            <label htmlFor="pf-lport" style={fieldLabel}>Port</label>
            <input id="pf-lport" type="text" inputMode="numeric" value={draft.listenPort} onChange={(e) => set({ listenPort: e.target.value })} aria-invalid={bad.listenPort || undefined} style={field("listenPort", monoField)} />
          </div>
        </div>
        <div style={addrPair}>
          <div style={{ minWidth: 0 }}>
            <label htmlFor="pf-dest" style={fieldLabel}>{kind === "remote" ? "Destination on this computer" : "Destination"}</label>
            <input
              id="pf-dest"
              type="text"
              disabled={dynamic}
              value={dynamic ? "" : draft.destHost}
              onChange={(e) => set({ destHost: e.target.value })}
              placeholder={dynamic ? "Any (SOCKS proxy)" : kind === "remote" ? "127.0.0.1" : "localhost"}
              spellCheck={false}
              aria-invalid={bad.destHost || undefined}
              style={field("destHost", dynamic ? { ...monoField, opacity: 0.6 } : monoField)}
            />
          </div>
          <div>
            <label htmlFor="pf-dport" style={fieldLabel}>Port</label>
            <input id="pf-dport" type="text" inputMode="numeric" disabled={dynamic} value={dynamic ? "" : draft.destPort} onChange={(e) => set({ destPort: e.target.value })} aria-invalid={bad.destPort || undefined} style={field("destPort", dynamic ? { ...monoField, opacity: 0.6 } : monoField)} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, height: 18 }}>
          <span key={msg?.text} role={msg?.tone === "err" ? "alert" : undefined} title={msg?.title ?? msg?.text} style={{ ...oneLine, flex: 1, fontSize: 12, lineHeight: "18px", color: msgColor }}>
            {msg?.text}
          </span>
        </div>
        <EditFooter
          left={
            row ? (
              <button type="button" onClick={onDelete} disabled={locked} title={pending ? "Wait until the tunnel has started or stopped" : undefined} style={off(dangerBtn, locked)}>
                <TrashIcon />
                Delete rule
              </button>
            ) : undefined
          }
        >
          <button type="button" onClick={cancelEdit} disabled={saving} style={off(pageBtn, saving)}>
            Cancel
          </button>
          <button type="submit" disabled={!dirty || saving || !!pending} title={!dirty ? "No changes to save" : pending ? "Wait until the tunnel has started or stopped" : undefined} style={off(primaryBtn, !dirty || saving || !!pending)}>
            <Stable text={saving ? "Saving…" : "Save"} alts={["Save", "Saving…"]} />
          </button>
        </EditFooter>
      </div>
    </form>
  );
}

function ConfirmDeleteDialog({ name, hostName, onConfirm, onClose }: { name: string; hostName: string; onConfirm(): Promise<void>; onClose(): void }) {
  return (
    <SharedConfirm
      title="Delete rule"
      message={`Delete "${name}" on ${hostName}? A running tunnel is stopped first. This cannot be undone.`}
      confirmLabel="Delete rule"
      danger
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
