import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../../api";
import type { AiCaps, AiPolicy, AiStatus, Host, McpInfo } from "../../api";
import { usePrefs } from "../../lib/prefs";
import { MONO, errText } from "../mock";
import { PlusIcon, TrashIcon } from "../icons";
import { ConfirmDialog } from "../overlays/Dialogs";
import { Stable } from "../Stable";
import { ListFilter, ScreenHeader, oneLine, pageBtn, sectionLabel, smallBtn, td, th } from "../kit";

const DURATIONS = [
  { minutes: 15, label: "15m" },
  { minutes: 30, label: "30m" },
  { minutes: 60, label: "1h" },
  { minutes: 240, label: "4h" },
  { minutes: 0, label: "No limit" },
];

const POLICIES: { value: AiPolicy; label: string }[] = [
  { value: "locked", label: "Blocked" },
  { value: "confirm", label: "Ask" },
  { value: "free", label: "Free" },
];

const CAPS: { key: keyof AiCaps; label: string; hint?: string; group: "read" | "manage" }[] = [
  { key: "list_hosts", label: "List hosts", hint: "Off: the AI only uses hosts you name.", group: "read" },
  { key: "list_snippets", label: "List snippets", group: "read" },
  { key: "list_secrets", label: "List credentials", hint: "Ids and kinds only, never secret values.", group: "read" },
  { key: "audit_log", label: "Read audit log", group: "read" },
  { key: "manage_hosts", label: "Create and change hosts", group: "manage" },
  { key: "manage_snippets", label: "Create, change and delete snippets", hint: "Deleting cannot be undone.", group: "manage" },
];

const SKILL_LABELS = ["Install", "Installing…", "Remove", "Removing…", "Retry", "Checking…"];

const card: CSSProperties = { padding: 14, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)" };
const cardTitle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 };
const cardDesc: CSSProperties = { margin: "4px 0 0", fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 };
const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--line-soft)" };
const rowLast: CSSProperties = { ...row, borderBottom: 0, paddingBottom: 0 };
const rowHead: CSSProperties = { flex: "1 1 240px", minWidth: 0 };
const sub: CSSProperties = { margin: "2px 0 0", fontSize: 12, color: "var(--text-2)" };
const groupLabel: CSSProperties = { ...sectionLabel, margin: "14px 0 0" };
const field: CSSProperties = { width: "100%", height: 32, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text)", boxSizing: "border-box" };
const iconBtn: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", cursor: "pointer", flex: "none" };

function dim(off: boolean): CSSProperties {
  return off ? { opacity: 0.6, cursor: "default" } : {};
}

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

function Toggle({ on, label, disabled, title, onChange }: { on: boolean; label: string; disabled?: boolean; title?: string; onChange(v: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!on)}
      style={{ position: "relative", display: "block", flex: "none", width: 30, height: 18, padding: 0, border: 0, borderRadius: 9, background: on ? "var(--ok)" : "var(--light-ring)", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.6 : 1 }}
    >
      <span aria-hidden="true" style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "#FFFFFF", transition: "left 120ms ease-out" }} />
    </button>
  );
}

/**
 * Radio group with roving tabindex: one tab stop, arrow keys move and select.
 * `reselect` lets a click on the already selected option fire onChange again.
 */
function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  disabled,
  title,
  small,
  reselect,
}: {
  value: T | null;
  options: { value: T; label: string }[];
  onChange(v: T): void;
  label: string;
  disabled?: boolean;
  title?: string;
  small?: boolean;
  reselect?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selIdx = options.findIndex((o) => o.value === value);
  const tabIdx = selIdx >= 0 ? selIdx : 0;

  function onKey(e: ReactKeyboardEvent, i: number) {
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    if (options[next].value !== value) onChange(options[next].value);
  }

  return (
    <div role="radiogroup" aria-label={label} title={title} style={{ display: "inline-flex", flex: "none", padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", opacity: disabled ? 0.6 : 1 }}>
      {options.map((o, i) => {
        const sel = i === selIdx;
        const clickable = !disabled && (!sel || reselect);
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={sel}
            tabIndex={i === tabIdx ? 0 : -1}
            disabled={disabled}
            onClick={() => clickable && onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            style={{
              height: small ? 24 : 26,
              padding: small ? "0 8px" : "0 10px",
              border: 0,
              borderRadius: 4,
              background: sel ? "var(--bg)" : "transparent",
              boxShadow: sel ? "0 0 0 1px var(--line)" : "none",
              color: sel ? "var(--text)" : "var(--text-2)",
              fontSize: small ? 12 : 13,
              whiteSpace: "nowrap",
              cursor: clickable ? "pointer" : "default",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Card({ title, desc, note, right, children }: { title: string; desc?: ReactNode; note?: string | null; right?: ReactNode; children?: ReactNode }) {
  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <h2 style={{ ...cardTitle, flex: "none" }}>{title}</h2>
            <span data-selectable aria-live="polite" title={note ?? undefined} style={{ ...oneLine, flex: 1, textAlign: "right", fontSize: 12, color: "var(--err)" }}>
              {note}
            </span>
          </div>
          {desc && <p style={cardDesc}>{desc}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Dot({ color }: { color: string }) {
  return <span aria-hidden="true" style={{ display: "inline-block", flex: "none", width: 8, height: 8, borderRadius: "50%", background: color }} />;
}

function fmtRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

let lastStart: { minutes: number; expires: string | null } | null = null;

type Stop = { host_name: string; path: string };
let stop: Stop | null = null;
let stopWatch: Promise<unknown> | null = null;
const stopSubs = new Set<() => void>();

function setStop(s: Stop | null) {
  stop = s;
  stopSubs.forEach((f) => f());
}

function watchStops() {
  stopWatch ??= listen<Stop>("ai-stopped", (e) => setStop(e.payload)).catch(() => {
    stopWatch = null;
  });
}

function subscribeStops(f: () => void) {
  watchStops();
  stopSubs.add(f);
  return () => {
    stopSubs.delete(f);
  };
}

watchStops();

function MasterCard({ onAiChanged }: { onAiChanged?(active: boolean): void }) {
  const { aiMinutes, setAiMinutes } = usePrefs();
  const alive = useAlive();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const seq = useRef(0);
  const changedRef = useRef(onAiChanged);
  changedRef.current = onAiChanged;
  const durationTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(durationTimer.current), []);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The limit this screen last started; the backend only reports the expiry time.
  const [startedMinutes, setStartedMinutes] = useState<number | null>(null);
  const stopped = useSyncExternalStore(subscribeStops, () => stop);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const s = await api.aiStatus();
      if (!alive.current || mine !== seq.current || busyRef.current) return;
      setStatus(s);
      setLoadErr(null);
      changedRef.current?.(s.active);
    } catch (e) {
      if (alive.current && mine === seq.current) setLoadErr(errText(e));
    }
  }, [alive]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    window.addEventListener("focus", load);
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listen("ai-stopped", () => load())
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      clearInterval(t);
      window.removeEventListener("focus", load);
      unlisten?.();
    };
  }, [load]);

  const active = status?.active ?? false;
  const expiresAt = active && status?.expires_at ? new Date(status.expires_at).getTime() : null;

  useEffect(() => {
    if (expiresAt == null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  useEffect(() => {
    if (!active) setStartedMinutes(null);
  }, [active]);

  const remainingMs = expiresAt != null ? expiresAt - now : null;
  const expired = remainingMs != null && remainingMs <= 0;

  useEffect(() => {
    if (expired) load();
  }, [expired, load]);

  async function apply(on: boolean, minutes = aiMinutes) {
    if (busyRef.current) return;
    busyRef.current = true;
    ++seq.current;
    setBusy(true);
    setActionErr(null);
    try {
      if (on) await api.aiEnable(minutes);
      else await api.aiDisable();
      if (on) setStop(null);
      const s = await api.aiStatus();
      lastStart = on ? { minutes, expires: s.expires_at } : null;
      changedRef.current?.(s.active);
      if (!alive.current) return;
      setStatus(s);
      setLoadErr(null);
      setStartedMinutes(on ? minutes : null);
    } catch (e) {
      if (alive.current) setActionErr(errText(e));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }

  function pickDuration(m: number) {
    setAiMinutes(m);
    if (!active) return;
    window.clearTimeout(durationTimer.current);
    durationTimer.current = window.setTimeout(() => void apply(true, m), 500);
  }

  const known = DURATIONS.some((d) => d.minutes === aiMinutes);
  const options = (known ? DURATIONS : [...DURATIONS, { minutes: aiMinutes, label: `${aiMinutes}m` }]).map((d) => ({ value: d.minutes, label: d.label }));

  // While on, highlight the limit that is actually running, not the stored preference.
  // A limit started elsewhere (tray, earlier session) is unknown, so nothing is highlighted.
  let selected: number | null = aiMinutes;
  const remembered = lastStart && status && lastStart.expires === status.expires_at ? lastStart.minutes : null;
  const started = startedMinutes ?? remembered;
  if (active) selected = expiresAt == null ? 0 : started != null && started > 0 ? started : null;

  let head: string;
  let detail = "";
  if (!status) head = loadErr ? "Status unavailable" : "Checking…";
  else if (!active) {
    head = "Off";
    detail = "The AI cannot reach any host.";
  } else {
    head = "On";
    if (expiresAt == null) detail = "No time limit.";
    else if (expired) detail = "Turning off…";
    else detail = `Turns off in ${fmtRemaining(remainingMs!)}, at ${new Date(expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}.`;
  }
  const err = actionErr ?? loadErr;
  const tripped = status && !active ? stopped : null;

  const toggleTitle = !status ? (loadErr ? "AI status unavailable" : "Checking AI status") : busy ? "Saving…" : undefined;

  return (
    <section style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Toggle on={active} label="AI access" disabled={!status} title={toggleTitle} onChange={(v) => apply(v)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ ...cardTitle, ...oneLine }}>{head}</p>
          <p style={{ ...sub, display: "flex", alignItems: "center", gap: 6, minHeight: 18 }} aria-live="polite" title={err ?? (tripped ? `${tripped.path} on ${tripped.host_name}` : undefined)}>
            {err ? (
              <span data-selectable style={{ ...oneLine, color: "var(--err)" }}>{err}</span>
            ) : tripped ? (
              <>
                <Dot color="var(--warn)" />
                <span style={oneLine}>Stopped because a protected path was touched.</span>
              </>
            ) : (
              <span style={{ ...oneLine, fontVariantNumeric: "tabular-nums" }}>{detail}</span>
            )}
          </p>
        </div>
        {loadErr && (
          <button type="button" onClick={load} style={{ ...smallBtn, flex: "none" }}>
            Retry
          </button>
        )}
      </div>
      <div style={{ ...rowLast, marginTop: 12, borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
        <div style={rowHead}>
          <span style={{ fontWeight: 500 }}>{active ? "Time limit" : "Turn on for"}</span>
        </div>
        <Segmented label="Duration" value={selected} options={options} onChange={pickDuration} reselect={active} title={busy ? "Saving…" : active ? "Picking a limit restarts the timer" : undefined} />
      </div>
    </section>
  );
}

function SkillCard() {
  const alive = useAlive();
  const [installed, setInstalled] = useState<boolean | "unknown" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [server, setServer] = useState<McpInfo | "error" | null>(null);
  const actionRef = useRef<HTMLDivElement | null>(null);
  const refocus = () => requestAnimationFrame(() => actionRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));

  const check = useCallback(async () => {
    setInstalled(null);
    setErr(null);
    try {
      const v = await api.skillInstalled();
      if (alive.current) setInstalled(v);
    } catch (e) {
      if (!alive.current) return;
      setInstalled("unknown");
      setErr(errText(e));
    }
  }, [alive]);

  useEffect(() => {
    check();
    api
      .mcpInfo()
      .then((i) => alive.current && setServer(i))
      .catch(() => alive.current && setServer("error"));
  }, [alive, check]);

  async function apply(install: boolean) {
    actionRef.current?.focus({ preventScroll: true });
    setBusy(true);
    setErr(null);
    try {
      if (install) await api.installSkill();
      else await api.uninstallSkill();
      if (alive.current) setInstalled(install);
    } catch (e) {
      if (alive.current) setErr(errText(e));
    } finally {
      if (alive.current) {
        setBusy(false);
        refocus();
      }
    }
  }

  let state: string;
  let label: string;
  let onClick: (() => void) | undefined;
  if (installed === null) {
    state = "Checking…";
    label = "Checking…";
  } else if (installed === "unknown") {
    state = "Status unknown";
    label = "Retry";
    onClick = check;
  } else if (installed) {
    state = server && server !== "error" && !server.running ? "Installed, but the local server is not running. Restart Kestral." : "Installed";
    label = busy ? "Removing…" : "Remove";
    onClick = () => void apply(false);
  } else {
    state = "Not installed";
    label = busy ? "Installing…" : "Install";
    onClick = () => void apply(true);
  }
  const off = !onClick || busy;

  return (
    <Card
      title="Claude Code skill"
      note={err}
      desc={
        <span title={state} style={{ ...oneLine, display: "block" }}>
          {state}
        </span>
      }
      right={
        <div ref={actionRef} tabIndex={-1} style={{ outline: "none" }}>
          <button type="button" onClick={onClick} disabled={off} title={installed === null ? "Checking whether the skill is installed" : undefined} style={{ ...pageBtn, flex: "none", ...dim(off) }}>
            <Stable text={label} alts={SKILL_LABELS} />
          </button>
        </div>
      }
    />
  );
}

function CapsCard() {
  const alive = useAlive();
  const [caps, setCaps] = useState<AiCaps | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const capsRef = useRef<AiCaps | null>(null);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);
  const failed = useRef(false);

  const show = useCallback((c: AiCaps) => {
    capsRef.current = c;
    setCaps(c);
  }, []);

  useEffect(() => {
    api
      .aiCaps()
      .then((c) => alive.current && show(c))
      .catch((e) => alive.current && setErr(errText(e)));
  }, [alive, show]);

  // Saves are serialized. If any of them fails, the real state is re-read once the queue
  // is empty, so a later successful save can never be hidden by a stale rollback.
  function setCap(key: keyof AiCaps, val: boolean) {
    const cur = capsRef.current;
    if (!cur) return;
    const next = { ...cur, [key]: val };
    show(next);
    setErr(null);
    pending.current += 1;
    queue.current = queue.current.then(async () => {
      try {
        await api.aiSetCaps(next);
      } catch (e) {
        failed.current = true;
        if (alive.current) setErr(errText(e));
      } finally {
        pending.current -= 1;
        if (pending.current === 0 && failed.current) {
          failed.current = false;
          try {
            const real = await api.aiCaps();
            if (alive.current) show(real);
          } catch {
            // The save error is already shown.
          }
        }
      }
    });
  }

  const renderRows = (group: "read" | "manage") => {
    const items = CAPS.filter((c) => c.group === group);
    return items.map((c, i) => (
      <div key={c.key} style={group === "manage" && i === items.length - 1 ? rowLast : row}>
        <div style={rowHead}>
          <span style={{ fontWeight: 500 }}>{c.label}</span>
          {c.hint && <p style={sub}>{c.hint}</p>}
        </div>
        <Toggle on={caps ? caps[c.key] : false} label={c.label} disabled={!caps} onChange={(v) => setCap(c.key, v)} />
      </div>
    ));
  };

  return (
    <Card title="What the AI may do" note={err}>
      <h3 style={groupLabel}>Read</h3>
      {renderRows("read")}
      <h3 style={groupLabel}>Manage</h3>
      {renderRows("manage")}
    </Card>
  );
}

function normalizePaths(list: string[]): string[] {
  const out: string[] = [];
  for (const p of list) {
    const t = p.trim();
    if (t !== "" && !out.includes(t)) out.push(t);
  }
  return out;
}

let rowSeq = 0;
type PathRow = { id: number; path: string };
const toRows = (list: string[]): PathRow[] => list.map((path) => ({ id: ++rowSeq, path }));

function ProtectedCard() {
  const alive = useAlive();
  const [rows, setRows] = useState<PathRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [focusLast, setFocusLast] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const saved = useRef<string[]>([]);
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);

  const reload = useCallback(() => {
    if (pending.current > 0 || listRef.current?.contains(document.activeElement)) return;
    api
      .aiProtectedList()
      .then((p) => {
        if (!alive.current || pending.current > 0) return;
        saved.current = p;
        setRows((cur) => (cur && cur.length === p.length && cur.every((r, i) => r.path === p[i]) ? cur : toRows(p)));
        setErr(null);
      })
      .catch((e) => {
        if (alive.current) setErr(errText(e));
      });
  }, [alive]);

  useEffect(() => {
    reload();
    const sub = listen("protected-changed", () => reload());
    window.addEventListener("focus", reload);
    return () => {
      void sub.then((un) => un());
      window.removeEventListener("focus", reload);
    };
  }, [reload]);

  useEffect(() => {
    if (!focusLast || !listRef.current) return;
    const inputs = listRef.current.querySelectorAll("input");
    inputs[inputs.length - 1]?.focus();
    setFocusLast(false);
  }, [focusLast, rows]);

  function save(next: PathRow[]) {
    const clean = normalizePaths(next.map((r) => r.path));
    pending.current++;
    queue.current = queue.current.then(async () => {
      const prev = saved.current;
      try {
        if (clean.length === prev.length && clean.every((p, i) => p === prev[i])) return;
        await api.aiSetProtected(clean);
        saved.current = clean;
        if (alive.current) setErr(null);
      } catch (e) {
        if (!alive.current) return;
        setRows(toRows(saved.current));
        setErr(`Not saved: ${errText(e)}`);
      } finally {
        pending.current--;
      }
    });
  }

  function edit(id: number, val: string) {
    setRows((cur) => (cur ? cur.map((r) => (r.id === id ? { ...r, path: val } : r)) : cur));
  }

  function blurRow(id: number) {
    if (!rows) return;
    const next = rows.filter((r) => r.id !== id || r.path.trim() !== "");
    if (next.length !== rows.length) setRows(next);
    save(next);
  }

  function add() {
    setRows((cur) => [...(cur ?? []), { id: ++rowSeq, path: "" }]);
    setFocusLast(true);
  }

  function remove(id: number) {
    if (!rows) return;
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    save(next);
  }

  return (
    <Card title="Protected paths" desc="If the AI touches or names one, AI access turns off." note={err}>
      {rows === null ? (
        !err && <p style={{ ...sub, marginTop: 12 }}>Loading…</p>
      ) : (
        <div ref={listRef} style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
          {rows.length === 0 && <p style={{ ...sub, margin: 0 }}>No protected paths.</p>}
          {rows.map((r, i) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                value={r.path}
                onChange={(e) => edit(r.id, e.target.value)}
                onBlur={() => blurRow(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                placeholder=".ssh/authorized_keys"
                aria-label={`Protected path ${i + 1}`}
                spellCheck={false}
                style={{ ...field, flex: 1, fontFamily: MONO, fontSize: 12 }}
              />
              <button type="button" aria-label={`Remove ${r.path || "path"}`} title="Remove path" onMouseDown={(e) => e.preventDefault()} onClick={() => remove(r.id)} style={iconBtn}>
                <TrashIcon />
              </button>
            </div>
          ))}
          <div style={{ marginTop: 4 }}>
            <button type="button" onClick={add} style={{ ...smallBtn, flex: "none" }}>
              <PlusIcon size={14} sw={1.75} />
              Add path
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

type Kind = "cmd" | "file";

function PolicyCard({ hosts, onHostsChanged }: { hosts: Host[]; onHostsChanged(): void }) {
  const alive = useAlive();
  const [pending, setPending] = useState<Record<string, AiPolicy>>({});
  const [err, setErr] = useState<string | null>(null);
  const [bulk, setBulk] = useState<AiPolicy | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<AiPolicy | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setPending((cur) => {
      const next: Record<string, AiPolicy> = {};
      for (const [k, v] of Object.entries(cur)) {
        const [id, kind] = k.split("|");
        const h = hosts.find((x) => x.id === id);
        if (h && (kind === "cmd" ? h.ai_policy : h.ai_file_policy) !== v) next[k] = v;
      }
      return next;
    });
  }, [hosts]);

  const value = (h: Host, kind: Kind) => pending[`${h.id}|${kind}`] ?? (kind === "cmd" ? h.ai_policy : h.ai_file_policy);

  async function set(h: Host, kind: Kind, p: AiPolicy) {
    const key = `${h.id}|${kind}`;
    setPending((cur) => ({ ...cur, [key]: p }));
    setErr(null);
    try {
      if (kind === "cmd") await api.hostSetPolicy(h.id, p);
      else await api.hostSetFilePolicy(h.id, p);
    } catch (e) {
      if (!alive.current) return;
      setPending((cur) => {
        const next = { ...cur };
        delete next[key];
        return next;
      });
      setErr(`${h.name}: ${errText(e)}`);
    }
    onHostsChanged();
  }

  // Throws so the confirm dialog stays open and shows what went wrong.
  async function setAll(p: AiPolicy) {
    setBulk(p);
    setPending({});
    setErr(null);
    try {
      const results = await Promise.allSettled(hosts.flatMap((h) => [api.hostSetPolicy(h.id, p), api.hostSetFilePolicy(h.id, p)]));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed.length > 0) throw new Error(`${failed.length} of ${results.length} changes failed: ${errText(failed[0].reason)}`);
    } finally {
      if (alive.current) setBulk(null);
      onHostsChanged();
    }
  }

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter((h) => `${h.name} ${h.username}@${h.hostname}`.toLowerCase().includes(q));
  }, [hosts, filter]);

  const hidden = hosts.length - shown.length;
  const bulkLabel = confirmBulk ? POLICIES.find((x) => x.value === confirmBulk)!.label : "";
  const bulkWhat: Record<AiPolicy, string> = {
    locked: "The AI will not be able to run commands or touch files on any of them.",
    confirm: "Every AI command and file action on them will need your approval.",
    free: "The AI will be able to run commands and change files on all of them without asking.",
  };

  return (
    <Card title="Per-host permission" desc="Ask needs your approval each time, Free never asks." note={err}>
      {hosts.length === 0 ? (
        <p style={{ ...sub, marginTop: 12 }}>No hosts yet.</p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            {hosts.length > 6 && (
              <div style={{ width: 220 }}>
                <ListFilter value={filter} onChange={setFilter} placeholder="Filter hosts" />
              </div>
            )}
            <div style={{ flex: 1 }} />
            {hosts.length > 1 && (
              <>
                <span style={{ fontSize: 12, color: "var(--text-2)" }}>
                  <Stable text={hidden > 0 ? `Set all ${hosts.length} hosts` : "Set all hosts"} alts={["Set all hosts", `Set all ${hosts.length} hosts`]} align="end" />
                </span>
                {POLICIES.map((p) => (
                  <button key={p.value} type="button" onClick={() => setConfirmBulk(p.value)} disabled={bulk !== null} title={bulk !== null ? "Saving…" : `Set commands and files to ${p.label} on every host`} style={{ ...smallBtn, flex: "none", ...dim(bulk !== null) }}>
                    <Stable text={bulk === p.value ? "Saving…" : p.label} alts={[p.label, "Saving…"]} />
                  </button>
                ))}
              </>
            )}
          </div>
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  <th style={{ ...th, paddingLeft: 0 }}>Host</th>
                  <th style={{ ...th, width: 1 }}>Commands</th>
                  <th style={{ ...th, width: 1, paddingRight: 0 }}>Files</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((h, i) => {
                  const last = i === shown.length - 1;
                  const c: CSSProperties = last ? { ...td, borderBottom: 0 } : td;
                  const busyTitle = bulk !== null ? "Saving…" : undefined;
                  return (
                    <tr key={h.id}>
                      <td style={{ ...c, height: 46, paddingLeft: 0, maxWidth: 0, width: "100%" }}>
                        <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</div>
                        <div style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {h.username}@{h.hostname}
                          {h.port !== 22 ? `:${h.port}` : ""}
                        </div>
                      </td>
                      <td style={c}>
                        <Segmented small label={`${h.name} command policy`} value={value(h, "cmd")} options={POLICIES} onChange={(p) => set(h, "cmd", p)} disabled={bulk !== null} title={busyTitle} />
                      </td>
                      <td style={{ ...c, paddingRight: 0 }}>
                        <Segmented small label={`${h.name} file policy`} value={value(h, "file")} options={POLICIES} onChange={(p) => set(h, "file", p)} disabled={bulk !== null} title={busyTitle} />
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={3} style={{ ...td, borderBottom: 0, paddingLeft: 0, color: "var(--text-2)" }}>No hosts match the filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {confirmBulk && (
        <ConfirmDialog
          title={confirmBulk === "free" ? `Allow the AI on all ${hosts.length} hosts without asking?` : `Set all ${hosts.length} hosts to ${bulkLabel}?`}
          message={`Commands and files on every host are set to ${bulkLabel}. ${bulkWhat[confirmBulk]}${hidden > 0 ? ` This includes the ${hidden} ${hidden === 1 ? "host" : "hosts"} hidden by the filter.` : ""}`}
          confirmLabel={`Set all to ${bulkLabel}`}
          danger={confirmBulk === "free"}
          onConfirm={() => setAll(confirmBulk)}
          onClose={() => setConfirmBulk(null)}
        />
      )}
    </Card>
  );
}

export function AiScreen({ hosts, onHostsChanged, onAiChanged }: { hosts: Host[]; onHostsChanged(): void; onAiChanged?(active: boolean): void }) {
  const refreshHostsRef = useRef(onHostsChanged);
  refreshHostsRef.current = onHostsChanged;
  useEffect(() => {
    const f = () => refreshHostsRef.current();
    f();
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, []);
  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="AI access" />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 28px 28px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 920 }}>
          <MasterCard onAiChanged={onAiChanged} />
          <PolicyCard hosts={hosts} onHostsChanged={onHostsChanged} />
          <CapsCard />
          <ProtectedCard />
          <SkillCard />
        </div>
      </div>
    </main>
  );
}
