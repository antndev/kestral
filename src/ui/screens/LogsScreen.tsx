import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { writeText as clipWrite } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "../../api";
import type { AuditEntry } from "../../api";
import { MONO, errText } from "../mock";
import { CheckIcon, ChevronIcon, CopyIcon, SearchIcon } from "../icons";
import { Stable } from "../Stable";

type Tone = "ok" | "err" | "warn" | "accent" | "muted";

type Actor = "You" | "AI" | "Session";

const DECISIONS: Record<string, { label: string; tone: Tone; by: Actor }> = {
  user: { label: "Direct", tone: "muted", by: "You" },
  allowed: { label: "Allowed", tone: "ok", by: "AI" },
  approved: { label: "Approved", tone: "accent", by: "AI" },
  denied: { label: "Denied", tone: "err", by: "AI" },
  blocked: { label: "Blocked", tone: "err", by: "AI" },
  error: { label: "Error", tone: "err", by: "AI" },
  config: { label: "Config", tone: "warn", by: "AI" },
  agent: { label: "Agent sign", tone: "warn", by: "Session" },
};

const ACTOR_HINT: Record<Actor, string> = {
  You: "Run by you",
  AI: "Requested by the AI",
  Session: "Requested through agent forwarding in an SSH session",
};

const DECISION_HINT: Record<string, string> = {
  user: "You ran this yourself, no approval involved.",
  allowed: "The AI ran this without asking, the host allows it.",
  approved: "The AI asked and you approved it.",
  denied: "Refused. Not run.",
  blocked: "Stopped by a protected path. AI access was switched off.",
  error: "The AI request failed before it finished.",
  config: "The AI changed a host or script.",
  agent: "A signature with a vault key, requested through agent forwarding. This can come from your own session or from the AI.",
};

const UNTRACKED = "Typed in a terminal session, the result is not tracked.";

const TONES: Record<Tone, { bg: string; selBg: string; fg: string }> = {
  ok: { bg: "var(--bg-raised)", selBg: "var(--bg)", fg: "var(--ok)" },
  err: { bg: "var(--err-tint)", selBg: "var(--err-tint)", fg: "var(--err)" },
  warn: { bg: "var(--warn-tint)", selBg: "var(--warn-tint)", fg: "var(--warn)" },
  accent: { bg: "var(--accent-tint)", selBg: "var(--bg)", fg: "var(--link)" },
  muted: { bg: "var(--bg-raised)", selBg: "var(--bg)", fg: "var(--text-2)" },
};

type DecisionFilter = "all" | "user" | "ai" | "refused" | "failed";

const DECISION_FILTERS: { value: DecisionFilter; label: string }[] = [
  { value: "all", label: "All decisions" },
  { value: "user", label: "You" },
  { value: "ai", label: "AI" },
  { value: "refused", label: "Blocked or denied" },
  { value: "failed", label: "Failed" },
];

const PAGE = 300;
const REFRESH_MS = 5000;
const COLS = 6;

// The header line is an inset shadow so it stays attached to the sticky header while scrolling.
const th: CSSProperties = { position: "sticky", top: 0, zIndex: 1, height: 32, padding: "0 12px", fontWeight: 500, textAlign: "left", color: "var(--text-2)", background: "var(--bg)", boxShadow: "inset 0 -1px 0 var(--line)", whiteSpace: "nowrap" };
const cell: CSSProperties = { height: 40, padding: "10px 12px 9px", lineHeight: "20px", verticalAlign: "top", borderBottom: "1px solid var(--line-soft)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const dayCell: CSSProperties = { padding: "14px 12px 6px 40px", fontSize: 12, fontWeight: 600, color: "var(--text-2)", borderBottom: "1px solid var(--line-soft)" };
const control: CSSProperties = { height: 32, border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text)", boxSizing: "border-box" };
const secondaryBtn: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
const linkBtn: CSSProperties = { padding: 0, border: 0, background: "transparent", color: "var(--link)", textDecoration: "underline", textUnderlineOffset: 2, cursor: "pointer" };
const inline: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, height: 20, verticalAlign: "top" };

function decisionOf(d: string) {
  return DECISIONS[d] ?? { label: d ? d.charAt(0).toUpperCase() + d.slice(1) : "Unknown", tone: "muted" as Tone, by: "AI" as Actor };
}

function isRefused(e: AuditEntry) {
  return e.decision === "denied" || e.decision === "blocked";
}

function matchesDecision(e: AuditEntry, f: DecisionFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "user":
      return e.decision === "user";
    case "ai":
      return e.decision !== "user" && e.decision !== "agent";
    case "refused":
      return isRefused(e);
    case "failed":
      return !e.success && !isRefused(e);
  }
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };

function parseTs(ts: string): Date | null {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtTime(ts: string): string {
  const d = parseTs(ts);
  return d ? d.toLocaleTimeString("en-GB", CLOCK) : ts;
}

function fmtDate(d: Date, withYear: boolean): string {
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  const date = d.toLocaleDateString("en-GB", withYear ? { day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "long" });
  return `${weekday} ${date}`;
}

function fmtDay(ts: string): string {
  const d = parseTs(ts);
  if (!d) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return fmtDate(d, d.getFullYear() !== now.getFullYear());
}

function fmtFull(ts: string): string {
  const d = parseTs(ts);
  return d ? `${fmtDate(d, true)}, ${d.toLocaleTimeString("en-GB", CLOCK)}` : ts;
}

function DecisionBadge({ decision, sel }: { decision: string; sel: boolean }) {
  const d = decisionOf(decision);
  const c = TONES[d.tone];
  return (
    <span title={DECISION_HINT[decision]} style={{ display: "inline-flex", alignItems: "center", height: 18, padding: "0 6px", borderRadius: 9, background: sel ? c.selBg : c.bg, color: c.fg, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>
      {d.label}
    </span>
  );
}

function ActorTag({ by }: { by: Actor }) {
  return (
    <span title={ACTOR_HINT[by]} style={{ color: by === "AI" ? "var(--text)" : "var(--text-2)", fontWeight: by === "AI" ? 600 : 400 }}>
      {by}
    </span>
  );
}

function Decision({ decision, sel }: { decision: string; sel: boolean }) {
  const by = decisionOf(decision).by;
  return (
    <span style={inline}>
      {by !== "Session" && <ActorTag by={by} />}
      {by !== "You" && <DecisionBadge decision={decision} sel={sel} />}
    </span>
  );
}

function untracked(e: AuditEntry): boolean {
  return e.decision === "user" && e.success && e.exit_status == null && !e.detail;
}

function Result({ e }: { e: AuditEntry }) {
  if (isRefused(e)) return <span style={{ color: "var(--text-3)" }}>Not run</span>;
  if (untracked(e)) return <span style={{ color: "var(--text-2)" }} title={UNTRACKED}>Sent</span>;
  const code = e.exit_status != null && e.exit_status !== 0 ? e.exit_status : null;
  return (
    <span style={inline} title={code != null ? `Exit status ${code}` : undefined}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: e.success ? "var(--ok)" : "var(--err)", flex: "none" }} />
      <span style={{ color: e.success ? "var(--text)" : "var(--err)" }}>{e.success ? "Success" : code != null ? `Exit ${code}` : "Failed"}</span>
    </span>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [state, setState] = useState<"" | "ok" | "err">("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function copy() {
    let next: "ok" | "err" = "ok";
    try {
      await clipWrite(text);
    } catch {
      next = "err";
    }
    if (!alive.current) return;
    setState(next);
    setTimeout(() => alive.current && setState(""), 1500);
  }
  const color = state === "ok" ? "var(--ok)" : state === "err" ? "var(--err)" : "var(--text)";
  return (
    <button type="button" onClick={copy} style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none", height: 28, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color, fontSize: 12, cursor: "pointer", boxSizing: "border-box" }}>
      {state === "ok" ? <CheckIcon size={14} /> : <CopyIcon />}
      <span aria-live="polite"><Stable text={state === "ok" ? "Copied" : state === "err" ? "Copy failed" : "Copy command"} alts={["Copy command", "Copied", "Copy failed"]} /></span>
    </button>
  );
}

export function LogsScreen() {
  const rootRef = useRef<HTMLElement>(null);
  const alive = useRef(true);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hostId, setHostId] = useState("");
  const [decision, setDecision] = useState<DecisionFilter>("all");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reqSeq = useRef(0);
  const inFlight = useRef(false);

  // Only the newest request may write state, so a slow older snapshot never overwrites newer
  // data. Automatic refreshes are skipped while one is still running.
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const seq = ++reqSeq.current;
    inFlight.current = true;
    try {
      const list = await api.auditList();
      if (!alive.current || seq !== reqSeq.current) return;
      setEntries(list.slice().reverse());
      setErr(null);
    } catch (e) {
      if (alive.current && seq === reqSeq.current) setErr(errText(e));
    } finally {
      if (seq === reqSeq.current) inFlight.current = false;
    }
  }, []);

  // Auto-refresh only while this screen is actually on screen: the window is visible
  // and the screen is not hidden by its container.
  useEffect(() => {
    const visible = () => !document.hidden && !!rootRef.current && rootRef.current.getClientRects().length > 0;
    refresh();
    const t = setInterval(() => {
      if (visible()) refresh();
    }, REFRESH_MS);
    const onVisibility = () => {
      if (visible()) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    let wasVisible = true;
    const io = new IntersectionObserver((items) => {
      const now = items.some((i) => i.isIntersecting);
      if (now && !wasVisible) refresh();
      wasVisible = now;
    });
    if (rootRef.current) io.observe(rootRef.current);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
      io.disconnect();
    };
  }, [refresh]);

  const hostOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries ?? []) if (!m.has(e.host_id)) m.set(e.host_id, e.host_name);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter(
      (e) =>
        (!hostId || e.host_id === hostId) &&
        matchesDecision(e, decision) &&
        (!q || e.command.toLowerCase().includes(q) || e.host_name.toLowerCase().includes(q) || (e.detail ?? "").toLowerCase().includes(q)),
    );
  }, [entries, query, hostId, decision]);

  useEffect(() => setLimit(PAGE), [query, hostId, decision]);

  const filtering = query.trim() !== "" || hostId !== "" || decision !== "all";
  const total = entries?.length ?? 0;
  const shown = filtered.slice(0, limit);
  const unit = total === 1 ? "entry" : "entries";
  const status = entries === null ? "" : err ? `Refresh failed: ${err}` : !filtered.length ? "" : filtering ? `${filtered.length} of ${total}` : `${total} ${unit}`;

  function toggle(id: string) {
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setQuery("");
    setHostId("");
    setDecision("all");
  }

  return (
    <main ref={rootRef} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 28px 14px", overflow: "hidden", scrollbarGutter: "stable" }}>
        <div style={{ flex: "1 1 0", minWidth: 140, display: "flex", alignItems: "center", gap: 10 }}>
          <h1 style={{ margin: 0, flex: "none", fontSize: 20, fontWeight: 600 }}>Logs</h1>
          <span title={status || undefined} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: err ? "var(--err)" : "var(--text-2)" }}>{status}</span>
        </div>
        <label style={{ ...control, flex: "0 1 220px", minWidth: 0, display: "flex", alignItems: "center", gap: 6, padding: "0 10px", color: "var(--text-2)" }}>
          <SearchIcon size={14} />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter commands" aria-label="Filter by command or host" style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--text)", textOverflow: "ellipsis" }} />
        </label>
        <select aria-label="Host" value={hostId} onChange={(e) => setHostId(e.target.value)} style={{ ...control, flex: "none", width: 120, padding: "0 8px" }}>
          <option value="">All hosts</option>
          {hostOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <select aria-label="Decision" value={decision} onChange={(e) => setDecision(e.target.value as DecisionFilter)} style={{ ...control, flex: "none", width: 144, padding: "0 8px" }}>
          {DECISION_FILTERS.map((d) => (
            <option key={d.value} value={d.value}>{d.label}</option>
          ))}
        </select>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", scrollbarGutter: "stable", padding: "0 28px 24px" }}>
        {entries === null ? (
          <p data-selectable={err ? true : undefined} style={{ margin: 0, color: err ? "var(--err)" : "var(--text-2)", overflowWrap: "anywhere" }}>{err ? `Could not load logs: ${err}` : "Loading…"}</p>
        ) : total === 0 && !filtering ? (
          <div style={{ padding: "40px 0", textAlign: "center" }}>
            <p style={{ margin: 0, fontWeight: 600 }}>No activity yet</p>
            <p style={{ margin: "4px 0 0", color: "var(--text-2)" }}>Commands you run and AI actions appear here.</p>
          </div>
        ) : (
          <>
            <table style={{ width: "100%", tableLayout: "fixed", borderCollapse: "separate", borderSpacing: 0, fontSize: 12.5 }}>
              <colgroup>
                <col style={{ width: 28 }} />
                <col style={{ width: 72 }} />
                <col style={{ width: 110 }} />
                <col />
                <col style={{ width: 108 }} />
                <col style={{ width: 88 }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ ...th, padding: 0 }} aria-label="Expand" />
                  <th style={th}>Time</th>
                  <th style={th}>Host</th>
                  <th style={th}>Command</th>
                  <th style={th}>Decision</th>
                  <th style={th}>Result</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={COLS} style={{ ...cell, paddingLeft: 40, borderBottom: 0, color: "var(--text-2)" }}>
                      No entries match.{" "}
                      <button type="button" onClick={clearFilters} style={linkBtn}>Clear filters</button>
                    </td>
                  </tr>
                )}
                {shown.map((e, i) => {
                  const expanded = open.has(e.id);
                  const day = fmtDay(e.timestamp);
                  const newDay = day !== "" && (i === 0 || day !== fmtDay(shown[i - 1].timestamp));
                  const note = e.detail || (untracked(e) ? UNTRACKED : DECISION_HINT[e.decision]);
                  const joined: CSSProperties | null = expanded ? { borderBottomColor: "transparent" } : null;
                  return (
                    <Fragment key={e.id}>
                      {newDay && (
                        <tr>
                          <td colSpan={COLS} style={dayCell}>{day}</td>
                        </tr>
                      )}
                      <tr
                        onClick={() => {
                          if (window.getSelection()?.toString()) return;
                          toggle(e.id);
                        }}
                        style={{ cursor: "pointer", background: expanded ? "var(--sel)" : undefined }}
                      >
                        <td style={{ ...cell, ...joined, padding: "9px 0 0 4px" }}>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={expanded ? "Hide details" : "Show details"}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              toggle(e.id);
                            }}
                            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", cursor: "pointer" }}
                          >
                            <span style={{ display: "flex", transform: expanded ? "none" : "rotate(-90deg)", transition: "transform 120ms ease-out" }}>
                              <ChevronIcon size={12} />
                            </span>
                          </button>
                        </td>
                        <td style={{ ...cell, ...joined, color: "var(--text-2)", fontVariantNumeric: "tabular-nums" }} title={fmtFull(e.timestamp)}>{fmtTime(e.timestamp)}</td>
                        <td style={{ ...cell, ...joined, fontWeight: 600 }} title={e.host_name}>{e.host_name}</td>
                        <td style={{ ...cell, ...joined, fontFamily: MONO, fontSize: 12, whiteSpace: expanded ? "normal" : "nowrap" }} title={expanded ? undefined : e.command}>
                          {expanded ? (
                            <div data-selectable onClick={(ev) => ev.stopPropagation()} style={{ maxHeight: 240, overflowY: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", cursor: "text" }}>
                              {e.command}
                            </div>
                          ) : (
                            e.command
                          )}
                        </td>
                        <td style={{ ...cell, ...joined }}><Decision decision={e.decision} sel={expanded} /></td>
                        <td style={{ ...cell, ...joined }}><Result e={e} /></td>
                      </tr>
                      {expanded && (
                        <tr style={{ background: "var(--sel)" }}>
                          <td style={{ borderBottom: "1px solid var(--line-soft)" }} />
                          <td colSpan={COLS - 1} style={{ padding: "0 12px 12px", borderBottom: "1px solid var(--line-soft)" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                              <p data-selectable style={{ flex: 1, minWidth: 0, margin: 0, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: e.detail ? (isRefused(e) || !e.success ? "var(--err)" : "var(--text)") : "var(--text-2)" }}>{note}</p>
                              <CopyCommand text={e.command} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {filtered.length > shown.length && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, paddingTop: 14 }}>
                <span style={{ color: "var(--text-2)" }}>Showing {shown.length} of {filtered.length}</span>
                <button type="button" onClick={() => setLimit((l) => l + PAGE)} style={secondaryBtn}>Show more</button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
