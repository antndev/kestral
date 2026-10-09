import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import type { Host } from "../../api";
import { termBus } from "../termBus";
import type { PaneStage, SessionStatus } from "../termBus";
import { MONO } from "../mock";
import { CloseIcon, CollapseIcon, DotsIcon, RefreshIcon } from "../icons";
import { MAX_PANES, aggregate, dnd, equalShare, leaves, paneHost, paneStore, shape } from "../panes";
import type { Layout, PaneSpec, Side, Zone } from "../panes";

export { termBus };
export type { SessionStatus };

export function encodingLabel(enc: string | undefined): string {
  const e = (enc || "utf-8").toLowerCase();
  return e === "iso-8859-1" ? "ISO-8859-1" : e === "windows-1252" ? "Windows-1252" : "UTF-8";
}


export interface MenuEntry {
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Tooltip, e.g. why the entry is disabled. */
  title?: string;
  danger?: boolean;
  onSelect(): void;
}

/** Small design-style popup menu. `null` entries render a separator. */
export function PopupMenu({
  label,
  items,
  style,
  ignoreRef,
  onClose,
}: {
  label: string;
  items: (MenuEntry | null)[];
  style: CSSProperties;
  ignoreRef?: RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(-1);
  const prevFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const enabled = items.flatMap((it, i) => (it && !it.disabled ? [i] : []));

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not([aria-disabled='true'])")?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || ignoreRef?.current?.contains(t)) return;
      onCloseRef.current();
    };
    const close = () => onCloseRef.current();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [ignoreRef]);

  const focusItem = (i: number) => {
    setActive(i);
    ref.current?.querySelector<HTMLButtonElement>(`[data-idx="${i}"]`)?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      prevFocus.current?.focus();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (enabled.length === 0) return;
      const pos = enabled.indexOf(active);
      const next = e.key === "ArrowDown" ? (pos + 1) % enabled.length : (pos <= 0 ? enabled.length : pos) - 1;
      focusItem(enabled[next]);
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={{ zIndex: 110, minWidth: 190, display: "flex", flexDirection: "column", padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", color: "var(--text)", fontSize: 13, boxSizing: "border-box", ...style }}
    >
      {items.map((it, i) =>
        it ? (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            data-idx={i}
            aria-disabled={it.disabled || undefined}
            title={it.title}
            onMouseEnter={() => !it.disabled && focusItem(i)}
            onFocus={() => setActive(i)}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              if (prevFocus.current?.isConnected) prevFocus.current.focus({ preventScroll: true });
              it.onSelect();
            }}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, height: 28, padding: "0 10px", border: 0, borderRadius: 4, outline: "none", background: active === i && !it.disabled ? "var(--sel)" : "transparent", color: it.disabled ? "var(--text-3)" : it.danger ? "var(--err)" : "var(--text)", fontSize: 13, textAlign: "left", whiteSpace: "nowrap", cursor: it.disabled ? "default" : "pointer" }}
          >
            <span>{it.label}</span>
            {it.hint && <span style={{ fontSize: 12, color: "var(--text-3)" }}>{it.hint}</span>}
          </button>
        ) : (
          <div key={`sep-${i}`} role="separator" style={{ height: 1, margin: "4px 6px", background: "var(--line)" }} />
        ),
      )}
    </div>
  );
}

const PANE_STATE: Record<PaneStage, string> = { connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting", failed: "Failed", ended: "Ended" };

function paneDot(stage: PaneStage): CSSProperties {
  if (stage === "connecting") return { border: "1.5px solid var(--warn)" };
  if (stage === "reconnecting") return { background: "var(--warn)" };
  if (stage === "failed") return { background: "var(--err)" };
  if (stage === "ended") return { border: "1.5px solid var(--ring-idle)" };
  return { background: "var(--ok)" };
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function PaneSlot({ id, onFocus }: { id: string; onFocus(): void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const focusRef = useRef(onFocus);
  focusRef.current = onFocus;
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    paneHost.attach(id, slot);
    const on = () => focusRef.current();
    slot.addEventListener("mousedown", on, true);
    slot.addEventListener("focusin", on);
    return () => {
      slot.removeEventListener("mousedown", on, true);
      slot.removeEventListener("focusin", on);
      paneHost.detach(id, slot);
    };
  }, [id]);
  return <div ref={ref} style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0 }} />;
}

type SplitNode = Extract<Layout, { type: "split" }>;

function Split({ node, path, first, second, onRatio }: { node: SplitNode; path: string; first: ReactNode; second: ReactNode; onRatio(path: string, ratio: number): void }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const [hot, setHot] = useState(false);
  const row = node.dir === "row";
  const ratio = live ?? node.ratio;

  const bounds = () => {
    const r = boxRef.current?.getBoundingClientRect();
    const size = r ? (row ? r.width : r.height) : 0;
    return { r, size, min: size > 0 ? Math.min(0.45, (row ? 160 : 90) / size) : 0.1 };
  };

  const start = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const { r, size, min } = bounds();
    if (!r || size <= 0) return;
    let last = node.ratio;
    const move = (ev: MouseEvent) => {
      ev.preventDefault();
      const pos = row ? ev.clientX - r.left : ev.clientY - r.top;
      last = Math.min(1 - min, Math.max(min, pos / size));
      setLive(last);
    };
    const end = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", end, true);
      window.removeEventListener("blur", end);
      document.documentElement.style.cursor = "";
      document.documentElement.style.userSelect = "";
      setLive(null);
      if (last !== node.ratio) onRatio(path, last);
    };
    document.documentElement.style.cursor = row ? "col-resize" : "row-resize";
    document.documentElement.style.userSelect = "none";
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", end, true);
    window.addEventListener("blur", end);
  };

  const nudge = (e: ReactKeyboardEvent) => {
    const back = row ? "ArrowLeft" : "ArrowUp";
    const fwd = row ? "ArrowRight" : "ArrowDown";
    if (e.key === "Home" || e.key === "Enter") {
      e.preventDefault();
      onRatio(path, equalShare(node));
      return;
    }
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    const { min } = bounds();
    onRatio(path, Math.min(1 - min, Math.max(min, node.ratio + (e.key === fwd ? 0.05 : -0.05))));
  };

  const lit = hot || live !== null;
  return (
    <div ref={boxRef} style={{ display: "flex", flexDirection: node.dir, flex: 1, minWidth: 0, minHeight: 0 }}>
      <div style={{ display: "flex", flex: `${ratio} 1 0px`, minWidth: 0, minHeight: 0 }}>{first}</div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={row ? "vertical" : "horizontal"}
        aria-label="Resize panes"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        title="Drag to resize. Double click to even out."
        onMouseDown={start}
        onDoubleClick={() => onRatio(path, equalShare(node))}
        onKeyDown={nudge}
        onMouseEnter={() => setHot(true)}
        onMouseLeave={() => setHot(false)}
        style={{ position: "relative", zIndex: 31, flex: "none", width: row ? 1 : undefined, height: row ? undefined : 1, background: lit ? "var(--focus)" : "var(--term-line)", boxShadow: lit ? `0 0 0 1px var(--focus)` : undefined, cursor: row ? "col-resize" : "row-resize", outlineOffset: 0, transition: "background 120ms, box-shadow 120ms" }}
      >
        <span aria-hidden="true" style={{ position: "absolute", ...(row ? { top: 0, bottom: 0, left: -4, right: -4 } : { left: 0, right: 0, top: -4, bottom: -4 }) }} />
      </div>
      <div style={{ display: "flex", flex: `${1 - ratio} 1 0px`, minWidth: 0, minHeight: 0 }}>{second}</div>
    </div>
  );
}

const ZONE_BOX: Record<Zone, CSSProperties> = {
  left: { left: "0%", top: "0%", width: "50%", height: "100%" },
  right: { left: "50%", top: "0%", width: "50%", height: "100%" },
  top: { left: "0%", top: "0%", width: "100%", height: "50%" },
  bottom: { left: "0%", top: "50%", width: "100%", height: "50%" },
  center: { left: "20%", top: "20%", width: "60%", height: "60%" },
};

function DropZone({ zone, ok }: { zone: Zone; ok: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div aria-hidden="true" style={{ position: "absolute", zIndex: 40, pointerEvents: "none", transition: "left 120ms ease-out, top 120ms ease-out, width 120ms ease-out, height 120ms ease-out", ...ZONE_BOX[zone] }}>
      <div
        style={{
          position: "absolute",
          inset: 4,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 8,
          border: `2px solid ${ok ? "var(--accent)" : "var(--err)"}`,
          borderRadius: 8,
          background: ok ? "color-mix(in srgb, var(--accent) 22%, transparent)" : "color-mix(in srgb, var(--err) 16%, transparent)",
          color: "var(--term-text)",
          fontSize: 12,
          fontWeight: 600,
          textAlign: "center",
          boxSizing: "border-box",
          opacity: shown ? 1 : 0,
          transform: shown ? "scale(1)" : "scale(0.96)",
          transition: "opacity 120ms ease-out, transform 120ms ease-out",
        }}
      >
        {!ok ? `Up to ${MAX_PANES} panes per tab` : zone === "center" ? "Swap panes" : null}
      </div>
    </div>
  );
}

function PaneHeader({
  index,
  name,
  stage,
  proc,
  title,
  focused,
  multi,
  zoomed,
  bell,
  onMouseDown,
  onToggleZoom,
  onMenu,
  onClose,
}: {
  index: number;
  name: string;
  stage: PaneStage;
  proc: string;
  title: string;
  focused: boolean;
  multi: boolean;
  zoomed: boolean;
  bell: number;
  onMouseDown(e: ReactMouseEvent): void;
  onToggleZoom(): void;
  onMenu(x: number, y: number): void;
  onClose(): void;
}) {
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!bell) return;
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 220);
    return () => window.clearTimeout(t);
  }, [bell]);
  const lit = focused || flash;
  const btn: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 20, height: 20, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--term-dim)", cursor: "pointer" };
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("button") && multi) onToggleZoom();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      title={multi ? "Drag to move this pane. Double click to zoom." : "Drag into another tab to join it."}
      style={{ display: "flex", alignItems: "center", gap: 8, height: 26, flexShrink: 0, minWidth: 0, padding: "0 4px 0 12px", background: flash ? "var(--accent-tint)" : focused ? "var(--term-head)" : "var(--term-head-dim)", color: lit ? "var(--term-text)" : "var(--term-dim)", fontSize: 12, transition: "background 120ms ease-out" }}
    >
      {stage !== "connected" && <span aria-hidden="true" style={{ width: 7, height: 7, flex: "none", borderRadius: "50%", boxSizing: "border-box", ...paneDot(stage) }} />}
      <span title={name} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: stage !== "connected" ? "var(--term-text)" : undefined }}>
        {name}
      </span>
      <span title={title || undefined} style={{ minWidth: 0, maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--term-dim)" }}>
        {stage === "connected" ? proc || "shell" : PANE_STATE[stage]}
      </span>
      <div style={{ flex: 1 }} />
      {zoomed && (
        <button type="button" aria-label="Show all panes" title="Show all panes" onClick={onToggleZoom} style={{ ...btn, width: "auto", gap: 4, padding: "0 6px", color: "var(--term-text)" }}>
          <CollapseIcon />
          <span style={{ fontSize: 11.5 }}>Zoomed</span>
        </button>
      )}
      <button
        type="button"
        aria-label={`Actions for pane ${index + 1}`}
        aria-haspopup="menu"
        title="Pane actions"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.right - 190, r.bottom + 4);
        }}
        style={btn}
      >
        <DotsIcon size={13} />
      </button>
      <button type="button" data-pane-close aria-label={`Close pane ${index + 1}`} title={multi ? "Close pane" : "Close pane and tab"} onClick={onClose} style={btn}>
        <CloseIcon />
      </button>
    </div>
  );
}

export function TerminalSession({
  tabId,
  active,
  hosts,
  fallbackHost,
  layout,
  specs,
  focus,
  zoom,
  broadcast,
  onFocus,
  onSplit,
  onClosePane,
  onRatio,
  onZoom,
  onPopOut,
  onEditHost,
  onDragPane,
}: {
  tabId: string;
  active: boolean;
  hosts: Host[];
  fallbackHost: Host;
  layout: Layout;
  specs: Record<string, PaneSpec>;
  focus: string;
  zoom: string | null;
  broadcast: boolean;
  onFocus(paneId: string): void;
  onSplit(paneId: string, side?: Side): void;
  onClosePane(paneId: string): void;
  onRatio(path: string, ratio: number): void;
  onZoom(paneId: string | null): void;
  onPopOut(paneId: string): void;
  onEditHost(h: Host): void;
  onDragPane(e: ReactMouseEvent, paneId: string, label: string): void;
}) {
  const infos = useSyncExternalStore(paneStore.subscribe, paneStore.infos);
  const { hint } = useSyncExternalStore(dnd.subscribe, dnd.get);
  const [paneMenu, setPaneMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const ids = useMemo(() => leaves(layout), [layout]);
  const multi = ids.length > 1;
  const zoomed = zoom && ids.includes(zoom) ? zoom : null;
  const full = ids.length >= MAX_PANES;
  const stageOf = (id: string): PaneStage => infos[id]?.stage ?? "connecting";
  const status = aggregate(ids.map(stageOf));
  const hostOf = (id: string) => hosts.find((h) => h.id === specs[id]?.hostId) ?? fallbackHost;
  const focusHost = hostOf(focus);
  const focusInfo = infos[focus];
  const counts = (["connecting", "failed", "reconnecting", "ended"] as const).map((k) => ({ k, n: ids.filter((id) => stageOf(id) === k).length })).filter((x) => x.n > 0);

  useEffect(() => {
    if (status === "connected") setConnectedAt((t) => t ?? Date.now());
    else setConnectedAt(null);
  }, [status]);

  const retryAt = focusInfo?.retryAt ?? null;
  useEffect(() => {
    if (!active || (connectedAt === null && retryAt === null)) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), retryAt === null ? 1000 : 250);
    return () => window.clearInterval(t);
  }, [active, connectedAt, retryAt]);

  useEffect(() => {
    termBus.setFocused(tabId, focus);
  }, [tabId, focus]);

  useEffect(() => {
    termBus.setBroadcast(tabId, broadcast && multi);
  }, [tabId, broadcast, multi]);

  useEffect(() => () => termBus.setBroadcast(tabId, false), [tabId]);

  const structure = `${shape(layout)}|${zoomed ?? ""}`;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => termBus.byId(focusRef.current)?.focus?.());
    return () => cancelAnimationFrame(raf);
  }, [structure, active]);

  const reconnect = (list: string[]) => list.forEach((id) => termBus.byId(id)?.reconnect());
  const splitEntry = (target: string, side: Side, label: string): MenuEntry => ({ label, disabled: full, title: full ? `Up to ${MAX_PANES} panes per tab` : undefined, onSelect: () => onSplit(target, side) });

  const paneItems = (id: string): (MenuEntry | null)[] => [
    splitEntry(id, "right", "Split right"),
    splitEntry(id, "bottom", "Split down"),
    ...(multi
      ? [
          { label: zoomed === id ? "Show all panes" : "Zoom pane", onSelect: () => onZoom(zoomed === id ? null : id) },
          { label: "Move to new tab", onSelect: () => onPopOut(id) },
        ]
      : []),
    null,
    { label: "Reconnect", onSelect: () => termBus.byId(id)?.reconnect() },
    { label: "Edit host", onSelect: () => onEditHost(hostOf(id)) },
    null,
    { label: multi ? "Close pane" : "Close pane and tab", danger: true, onSelect: () => onClosePane(id) },
  ];

  const renderPane = (id: string) => {
    const ph = hostOf(id);
    const info = infos[id];
    const isFocused = focus === id;
    const drop = hint?.kind === "pane" && hint.tabId === tabId && hint.paneId === id ? hint : null;
    const index = ids.indexOf(id);
    return (
      <section
        key={id}
        data-pane-id={id}
        data-pane-tab={tabId}
        aria-label={`Pane ${index + 1}, ${ph.name}`}
        style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", position: "relative", background: "var(--term-bg)" }}
      >
        {multi && <PaneHeader
          index={index}
          name={ph.name}
          stage={info?.stage ?? "connecting"}
          proc={info?.proc ?? ""}
          title={info?.title ?? ""}
          focused={isFocused}
          multi={multi}
          zoomed={zoomed === id}
          bell={info?.bell ?? 0}
          onMouseDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return;
            e.preventDefault();
            onFocus(id);
            termBus.byId(id)?.focus?.();
            onDragPane(e, id, ph.name);
          }}
          onToggleZoom={() => onZoom(zoomed === id ? null : id)}
          onMenu={(x, y) => {
            onFocus(id);
            setPaneMenu({ id, x, y });
          }}
          onClose={() => onClosePane(id)}
        />}
        <PaneSlot id={id} onFocus={() => onFocus(id)} />
        {isFocused && multi && !zoomed && (
          // Drawn above the header and the terminal, which would cover an inset shadow on the section.
          <div aria-hidden="true" style={{ position: "absolute", inset: 0, zIndex: 30, pointerEvents: "none", boxShadow: "inset 0 0 0 1px var(--focus)" }} />
        )}
        {drop && <DropZone key={`${drop.ok}`} zone={drop.zone} ok={drop.ok} />}
      </section>
    );
  };

  const renderNode = (node: Layout, path: string): ReactNode =>
    node.type === "pane" ? renderPane(node.id) : <Split key={`split:${path}`} node={node} path={path} onRatio={onRatio} first={renderNode(node.a, `${path}a`)} second={renderNode(node.b, `${path}b`)} />;

  const focusStage = focusInfo?.stage ?? "connecting";
  const note = focusInfo?.note ?? "";
  const tries = focusInfo && focusInfo.of > 0 ? ` (${focusInfo.attempt} of ${focusInfo.of})` : "";
  const stateText: ReactNode =
    focusStage === "connected"
      ? `Connected${connectedAt !== null ? ` ${elapsed(now - connectedAt)}` : ""}`
      : focusStage === "reconnecting"
        ? retryAt !== null
          ? (
              <>
                Connection lost{tries}, retrying in <span style={{ fontVariantNumeric: "tabular-nums" }}>{Math.max(1, Math.ceil((retryAt - now) / 1000))}</span> s
              </>
            )
          : `Reconnecting${tries}`
        : focusStage === "failed"
          ? note
            ? `Connection lost. ${note}`
            : "Connection failed"
          : focusStage === "ended"
            ? note
              ? `Session ended, ${note.charAt(0).toLowerCase()}${note.slice(1)}`
              : "Session ended"
            : "Connecting";
  const canReconnect = focusStage === "reconnecting" || focusStage === "ended" || (focusStage === "failed" && note !== "");
  const encoding = encodingLabel(focusHost.options?.encoding);

  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", flex: 1, minHeight: 0, minWidth: 0, background: "var(--term-line)" }}>{zoomed ? renderPane(zoomed) : renderNode(layout, "")}</div>

      {paneMenu && ids.includes(paneMenu.id) && (
        <PopupMenu
          label="Pane actions"
          items={paneItems(paneMenu.id)}
          onClose={() => setPaneMenu(null)}
          style={{ position: "fixed", left: Math.max(4, Math.min(paneMenu.x, window.innerWidth - 204)), top: Math.max(4, Math.min(paneMenu.y, window.innerHeight - 280)) }}
        />
      )}

      <footer style={{ display: "flex", alignItems: "center", gap: 16, height: 26, flex: "none", padding: "0 6px 0 12px", borderTop: "1px solid var(--line)", background: "var(--bg-side)", color: "var(--text-2)", fontSize: 12, boxSizing: "border-box", whiteSpace: "nowrap", overflow: "hidden" }}>
        <span title={`${focusHost.username}@${focusHost.hostname}${focusHost.port !== 22 ? `:${focusHost.port}` : ""}`} style={{ flex: "none", maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", fontFamily: MONO, fontSize: 11.5 }}>
          {focusHost.username}@{focusHost.hostname}
          {focusHost.port !== 22 ? `:${focusHost.port}` : ""}
        </span>
        <span role="status" style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, color: "var(--text)" }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, flex: "none", borderRadius: "50%", boxSizing: "border-box", ...paneDot(focusStage) }} />
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{stateText}</span>
        </span>
        {focusStage === "connected" && typeof focusInfo?.latency === "number" && <span title="Latency">{focusInfo.latency} ms</span>}
        {encoding !== "UTF-8" && <span>{encoding}</span>}
        {broadcast && multi && <span style={{ color: "var(--warn)" }}>Broadcast on</span>}
        {zoomed && <span>Zoomed</span>}
        {multi && counts.map((c) => <span key={c.k}>{c.n} {c.k}</span>)}
        <div style={{ flex: 1 }} />
        {canReconnect && (
          <button type="button" data-icon-btn onClick={() => reconnect([focus])} style={{ display: "flex", alignItems: "center", gap: 5, flex: "none", height: 20, padding: "0 8px 0 6px", border: 0, borderRadius: 5, color: "var(--text)", fontSize: 12, cursor: "pointer" }}>
            <RefreshIcon size={12} />
            {focusStage === "reconnecting" ? "Reconnect now" : "Reconnect"}
          </button>
        )}
        {focusInfo && focusInfo.cols > 0 && (
          <span style={{ paddingRight: 6 }}>
            {focusInfo.cols} × {focusInfo.rows}
          </span>
        )}
      </footer>
    </main>
  );
}
