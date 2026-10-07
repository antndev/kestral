import { CSSProperties, Fragment, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { writeText as clipWriteText } from "@tauri-apps/plugin-clipboard-manager";
import type { Host, PortForward } from "../../api";
import { MONO, Status, statusColor } from "../mock";
import { CheckIcon, DotsIcon, ForwardIcon, PlusIcon, SearchIcon, WarningIcon } from "../icons";
import { useAlive } from "./SettingsScreen";
import type { DragHost } from "../Shell";
import { parseTarget, type QuickConnect, type Target } from "../target";
import { SegGroup, segItem } from "../SegGroup";

export type { QuickConnect } from "../target";

const STATUS_LABEL: Record<Status, string> = { ok: "Connected", warn: "Connecting", err: "Failed", idle: "" };

const outlineBtn: CSSProperties = { display: "flex", alignItems: "center", height: 28, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 6, background: "transparent", color: "var(--text)", fontSize: 12, boxSizing: "border-box", cursor: "pointer", whiteSpace: "nowrap" };
const invBtn: CSSProperties = { display: "flex", alignItems: "center", height: 28, padding: "0 12px", borderRadius: 6, border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontSize: 12, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" };
const iconBtn: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, padding: 0, border: 0, borderRadius: 6, background: "transparent", color: "var(--text-2)", cursor: "pointer", flex: "none" };
const chip: CSSProperties = { display: "inline-block", flex: "none", maxWidth: "100%", height: 22, lineHeight: "22px", padding: "0 8px", borderRadius: 11, background: "var(--bg-raised)", fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", boxSizing: "border-box" };
const tagChip: CSSProperties = { ...chip, maxWidth: 160 };
const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
const ellipsis: CSSProperties = { minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const TAG_GAP = 6;
const ROW_COLS = "8px minmax(0, 1fr) minmax(0, 1.4fr) minmax(0, 1fr) auto";
const VIEW_KEY = "kestral.hosts.view";

function readView(): "grid" | "list" {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function storeView(v: "grid" | "list") {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    // Storage blocked: the choice still applies until the screen unmounts.
  }
}

export function hostAddress(h: Pick<Host, "username" | "hostname" | "port">): string {
  const custom = h.port !== 22;
  const host = custom && h.hostname.includes(":") ? `[${h.hostname}]` : h.hostname;
  return `${h.username}@${host}${custom ? `:${h.port}` : ""}`;
}

function sshCommand(h: Host): string {
  const target = h.username ? `${h.username}@${h.hostname}` : h.hostname;
  return h.port === 22 ? target : `ssh -p ${h.port} ${target}`;
}

function sameTarget(h: Host, t: Target): boolean {
  return h.hostname.toLowerCase() === t.hostname.toLowerCase() && h.port === t.port && h.username === t.username;
}

function looksLikeTarget(text: string): boolean {
  return text.includes("@") || /^ssh(\s|:\/\/)/i.test(text);
}

/** A local bind that stays on this machine: empty, loopback IPs, or "localhost". */
function isLoopbackBind(host: string): boolean {
  const v = host.trim().toLowerCase();
  return v === "" || v === "127.0.0.1" || v === "localhost" || v === "::1";
}

function withPort(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function forwardLabel(f: PortForward): string {
  const kind = f.kind ?? "local";
  const local = isLoopbackBind(f.local_host) ? String(f.local_port) : withPort(f.local_host.trim(), f.local_port);
  if (kind === "dynamic") return `SOCKS ${local}`;
  if (kind === "remote") {
    const listen = isLoopbackBind(f.remote_host) ? `remote:${f.remote_port}` : withPort(f.remote_host.trim(), f.remote_port);
    const dest = f.local_host.trim();
    return `R ${listen} → ${withPort(isLoopbackBind(dest) || dest === "0.0.0.0" || dest === "::" ? "localhost" : dest, f.local_port)}`;
  }
  return `L ${local} → ${withPort(f.remote_host, f.remote_port)}`;
}

function isFromControl(e: ReactMouseEvent): boolean {
  return !!(e.target as HTMLElement).closest("button, input, select, a, [role=menu]");
}

interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect(): void | Promise<void>;
}

type MenuAt = "button" | { x: number; y: number } | null;

function menuPoint(e: ReactMouseEvent): MenuAt {
  e.preventDefault();
  return e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : "button";
}

function MoreMenu({ hostName, items, at, note, onAt }: { hostName: string; items: MenuItem[]; at: MenuAt; note: Note | null; onAt(at: MenuAt): void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [hover, setHover] = useState(-1);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = at !== null;

  useLayoutEffect(() => {
    setHover(-1);
    if (!at || !btnRef.current || !menuRef.current) {
      setPos(null);
      return;
    }
    const b = btnRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const [x, below, above] = at === "button" ? [b.right - m.width, b.bottom + 4, b.top - 4 - m.height] : [at.x, at.y, at.y - m.height];
    setPos({ top: below + m.height <= window.innerHeight - 8 ? below : Math.max(8, above), left: Math.max(8, Math.min(x, window.innerWidth - m.width - 8)) });
  }, [at]);

  useEffect(() => {
    if (!open) return;
    const close = () => onAt(null);
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        btnRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, onAt]);

  useEffect(() => {
    if (open && pos) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [open, pos]);

  function onMenuKey(e: ReactKeyboardEvent) {
    const btns = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      btns[(n + btns.length) % btns.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(btns.length - 1);
    else if (e.key === "Tab") {
      e.preventDefault();
      onAt(null);
      btnRef.current?.focus();
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`More actions for ${hostName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={note?.text}
        onClick={() => onAt(open ? null : "button")}
        style={{ ...iconBtn, background: open ? "var(--bg-raised)" : "transparent", color: note ? (note.err ? "var(--err)" : "var(--ok)") : iconBtn.color }}
      >
        {note ? note.err ? <WarningIcon size={14} /> : <CheckIcon size={14} /> : <DotsIcon />}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label={`Actions for ${hostName}`}
          onKeyDown={onMenuKey}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && (menuRef.current?.contains(to) || btnRef.current?.contains(to))) return;
            onAt(null);
          }}
          style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden", zIndex: 90, minWidth: 160, display: "flex", flexDirection: "column", padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", boxSizing: "border-box", outline: "none" }}
        >
          {items.map((it, i) => (
            <Fragment key={it.label}>
              {it.danger && <div aria-hidden style={{ height: 1, margin: "4px 2px", background: "var(--line-soft)" }} />}
              <button
                type="button"
                role="menuitem"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(-1)}
                onFocus={(e) => e.currentTarget.matches(":focus-visible") && setHover(i)}
                onBlur={() => setHover(-1)}
                onClick={() => {
                  btnRef.current?.focus();
                  onAt(null);
                  void it.onSelect();
                }}
                style={{ display: "flex", alignItems: "center", height: 28, padding: "0 10px", border: 0, borderRadius: 4, background: hover === i ? "var(--sel)" : "transparent", color: it.danger ? "var(--err)" : "var(--text)", fontSize: 13, textAlign: "left", cursor: "pointer", outline: "none" }}
              >
                {it.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

function TagLine({ tags }: { tags: string[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState(tags.length);
  const sig = tags.join("\n");

  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const calc = () => {
      const widths = Array.from(measure.children, (el) => el.getBoundingClientRect().width);
      const more = widths.pop() ?? 0;
      const room = box.getBoundingClientRect().width;
      const need = (k: number) => widths.slice(0, k).reduce((sum, w) => sum + w + TAG_GAP, 0) + (k < widths.length ? more : -TAG_GAP);
      let k = widths.length;
      while (k > 0 && need(k) > room + 0.01) k--;
      setFit(k);
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(box);
    ro.observe(measure);
    return () => ro.disconnect();
  }, [sig]);

  const shown = Math.max(fit, Math.min(1, tags.length));
  const rest = tags.slice(shown);
  return (
    <div ref={boxRef} style={{ position: "relative", display: "flex", gap: TAG_GAP, minWidth: 0, height: 22, overflow: "hidden" }}>
      {tags.slice(0, shown).map((t, i) => (
        <span key={i} title={t} style={{ ...tagChip, flex: "0 1 auto", minWidth: 0 }}>{t}</span>
      ))}
      {rest.length > 0 && <span title={rest.join(", ")} style={{ ...tagChip, color: "var(--text-2)" }}>+{rest.length}</span>}
      <span ref={measureRef} aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, display: "flex", gap: TAG_GAP, width: "max-content", visibility: "hidden", pointerEvents: "none" }}>
        {tags.map((t, i) => (
          <span key={i} style={tagChip}>{t}</span>
        ))}
        <span style={tagChip}>+{tags.length}</span>
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: Status }) {
  return <span aria-hidden="true" title={STATUS_LABEL[status] || undefined} style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: status === "idle" ? "transparent" : statusColor(status) }} />;
}

function Address({ host, via }: { host: Host; via?: string }) {
  const addr = hostAddress(host);
  return (
    <div title={via ? `${addr} via ${via}` : addr} style={{ ...ellipsis, fontSize: 12, color: "var(--text-2)" }}>
      <span style={{ fontFamily: MONO }}>{addr}</span>
      {via && ` via ${via}`}
    </div>
  );
}

function TunnelCount({ forwards }: { forwards: PortForward[] }) {
  if (forwards.length === 0) return null;
  const label = plural(forwards.length, "tunnel", "tunnels");
  const lines = forwards.map((f) => ((f.name ?? "").trim() ? `${f.name.trim()}: ${forwardLabel(f)}` : forwardLabel(f)));
  return (
    <span title={[label, ...lines].join("\n")} style={{ display: "flex", alignItems: "center", gap: 4, flex: "none", fontSize: 12, color: "var(--text-2)" }}>
      <ForwardIcon size={13} />
      <span aria-hidden="true">{forwards.length}</span>
      <span style={srOnly}>{label}</span>
    </span>
  );
}

function Live({ host, status, note }: { host: Host; status: Status; note: Note | null }) {
  const text = note?.text ?? STATUS_LABEL[status];
  return <span role="status" style={srOnly}>{text ? `${host.name}: ${text}` : ""}</span>;
}

interface Note {
  text: string;
  err: boolean;
}

interface CardProps {
  host: Host;
  via?: string;
  onDragStart?(e: ReactMouseEvent): void;
  note: Note | null;
  status: Status;
  menu: MenuItem[];
  onConnect(): void;
  onSftp(): void;
}

function HostCard({ host, via, note, status, menu, onConnect, onSftp, onDragStart }: CardProps) {
  const [menuAt, setMenuAt] = useState<MenuAt>(null);
  return (
    <article
      onDoubleClick={(e) => !isFromControl(e) && onConnect()}
      onMouseDown={onDragStart}
      onContextMenu={(e) => setMenuAt(menuPoint(e))}
      style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, border: "1px solid var(--line)", borderRadius: 8, minWidth: 0, userSelect: "none" }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 title={host.name} style={{ ...ellipsis, flex: 1, margin: 0, fontSize: 14, fontWeight: 600 }}>{host.name}</h3>
          <StatusDot status={status} />
        </div>
        <Address host={host} via={via} />
      </div>
      {host.tags.length > 0 && <TagLine tags={host.tags} />}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: "auto" }}>
        <button type="button" aria-label={`Connect to ${host.name}`} onClick={onConnect} style={invBtn}>Connect</button>
        <button type="button" aria-label={`Open SFTP for ${host.name}`} onClick={onSftp} style={outlineBtn}>SFTP</button>
        <div style={{ flex: 1 }} />
        <TunnelCount forwards={host.forwards} />
        <MoreMenu hostName={host.name} items={menu} at={menuAt} note={note} onAt={setMenuAt} />
      </div>
      <Live host={host} status={status} note={note} />
    </article>
  );
}

function HostRow({ host, via, note, status, first, menu, onConnect, onSftp, onDragStart }: CardProps & { first: boolean }) {
  const [menuAt, setMenuAt] = useState<MenuAt>(null);
  return (
    <div
      onDoubleClick={(e) => !isFromControl(e) && onConnect()}
      onMouseDown={onDragStart}
      onContextMenu={(e) => setMenuAt(menuPoint(e))}
      style={{ display: "grid", gridTemplateColumns: ROW_COLS, alignItems: "center", columnGap: 12, minHeight: 44, padding: "6px 12px", borderTop: first ? 0 : "1px solid var(--line-soft)", boxSizing: "border-box", userSelect: "none" }}
    >
      <StatusDot status={status} />
      <span title={host.name} style={{ ...ellipsis, fontWeight: 600 }}>{host.name}</span>
      <Address host={host} via={via} />
      {host.tags.length > 0 ? <TagLine tags={host.tags} /> : <span />}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ display: "flex", justifyContent: "flex-end", width: 36 }}>
          <TunnelCount forwards={host.forwards} />
        </span>
        <button type="button" aria-label={`Connect to ${host.name}`} onClick={onConnect} style={invBtn}>Connect</button>
        <button type="button" aria-label={`Open SFTP for ${host.name}`} onClick={onSftp} style={outlineBtn}>SFTP</button>
        <MoreMenu hostName={host.name} items={menu} at={menuAt} note={note} onAt={setMenuAt} />
      </div>
      <Live host={host} status={status} note={note} />
    </div>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function HostsScreen(p: {
  hosts: Host[];
  statuses: Record<string, Status>;
  onConnect(h: Host): void;
  onSftp(h: Host): void;
  onEdit(h: Host): void;
  onNew(): void;
  onDuplicate(h: Host): void;
  onDelete(h: Host): void;
  onQuickConnect(q: QuickConnect): void;
  onDragHost?: DragHost;
}) {
  const { hosts, statuses } = p;
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const errId = useId();
  const [view, setViewState] = useState<"grid" | "list">(readView);
  const setView = (v: "grid" | "list") => {
    setViewState(v);
    storeView(v);
  };
  const [filterFocus, setFilterFocus] = useState(false);
  const [quickErr, setQuickErr] = useState("");
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const alive = useAlive();

  const target = useMemo(() => parseTarget(query), [query]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter((h) => h.name.toLowerCase().includes(q) || hostAddress(h).toLowerCase().includes(q) || h.tags.some((t) => t.toLowerCase().includes(q)) || (target.ok && sameTarget(h, target.value)));
  }, [hosts, query, target]);

  const dragHost = (e: ReactMouseEvent, h: Host) => {
    if (isFromControl(e)) return;
    p.onDragHost?.(e, h.id, h.name);
  };

  const menuFor = (h: Host): MenuItem[] => [
    { label: "Edit", onSelect: () => p.onEdit(h) },
    { label: "Duplicate", onSelect: () => p.onDuplicate(h) },
    {
      label: "Copy address",
      onSelect: async () => {
        let note: Note;
        try {
          await clipWriteText(sshCommand(h));
          note = { text: "Address copied", err: false };
        } catch {
          note = { text: "Copy failed", err: true };
        }
        if (!alive.current) return;
        setNotes((n) => ({ ...n, [h.id]: note }));
        setTimeout(() => {
          if (!alive.current) return;
          setNotes((n) => {
            if (n[h.id] !== note) return n;
            const next = { ...n };
            delete next[h.id];
            return next;
          });
        }, note.err ? 3000 : 1500);
      },
    },
    { label: "Delete", danger: true, onSelect: () => p.onDelete(h) },
  ];

  function submitTarget() {
    const text = query.trim();
    if (!text) return;
    if (!target.ok) {
      if (looksLikeTarget(text)) setQuickErr(target.error);
      return;
    }
    setQuickErr("");
    if (hosts.some((h) => sameTarget(h, target.value))) setQuery("");
    else filterRef.current?.select();
    p.onQuickConnect({ ...target.value, identity: "" });
  }

  const clearFilter = () => {
    setQuery("");
    setQuickErr("");
    filterRef.current?.focus();
  };

  const ring = quickErr ? "var(--err)" : "var(--focus)";

  const cardProps = (h: Host): CardProps => ({
    host: h,
    via: h.jump_host_id ? hosts.find((x) => x.id === h.jump_host_id)?.name ?? "missing host" : undefined,
    note: notes[h.id] ?? null,
    status: statuses[h.id] ?? "idle",
    menu: menuFor(h),
    onConnect: () => p.onConnect(h),
    onSftp: () => p.onSftp(h),
    onDragStart: (e) => dragHost(e, h),
  });

  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "20px 28px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Hosts</h1>
        <span style={{ color: "var(--text-2)" }}>{plural(hosts.length, "host", "hosts")}</span>
        <div style={{ flex: 1 }} />
        <label title={quickErr || undefined} style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 1 300px", minWidth: 160, height: 32, padding: "0 10px", border: `1px solid ${quickErr || filterFocus ? ring : "var(--line)"}`, boxShadow: filterFocus ? `0 0 0 1px ${ring}` : "none", borderRadius: 6, boxSizing: "border-box", color: "var(--text-2)" }}>
          <SearchIcon size={14} />
          <input
            ref={filterRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setQuickErr("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitTarget();
              } else if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
                setQuickErr("");
              }
            }}
            onFocus={() => setFilterFocus(true)}
            onBlur={() => setFilterFocus(false)}
            placeholder="Filter, or user@host to connect"
            aria-label="Filter hosts, or enter user@host and press Enter to connect"
            aria-invalid={!!quickErr || undefined}
            aria-describedby={quickErr ? errId : undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--text)" }}
          />
        </label>
        <span id={errId} role="alert" style={srOnly}>{quickErr}</span>
        <SegGroup label="View" value={view}>
          <button type="button" aria-pressed={view === "grid"} onClick={() => setView("grid")} style={segItem(view === "grid")}>Grid</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")} style={segItem(view === "list")}>List</button>
        </SegGroup>
        <button type="button" onClick={() => p.onNew()} style={{ display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", borderRadius: 6, border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500, boxSizing: "border-box", cursor: "pointer" }}>
          <PlusIcon size={14} sw={1.75} />
          New host
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 24, padding: "0 28px 28px" }}>
        {filtered.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, padding: "80px 0", textAlign: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-2)" }}>No matching hosts</div>
            <div style={{ fontSize: 13, color: "var(--text-3)", overflowWrap: "anywhere" }}>
              {target.ok ? `Press Enter to connect to ${hostAddress(target.value)}.` : `Nothing matches "${query.trim()}".`}
            </div>
            <button type="button" onClick={clearFilter} style={{ ...outlineBtn, height: 32, marginTop: 10, fontSize: 13 }}>Clear filter</button>
          </div>
        ) : view === "grid" ? (
          <div data-stagger style={{ display: "grid", flex: "none", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
            {filtered.map((h) => (
              <HostCard key={h.id} {...cardProps(h)} />
            ))}
          </div>
        ) : (
          <div data-stagger style={{ display: "flex", flex: "none", flexDirection: "column", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            {filtered.map((h, i) => (
              <HostRow key={h.id} first={i === 0} {...cardProps(h)} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
