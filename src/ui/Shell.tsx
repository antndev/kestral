import React, { CSSProperties, ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { IS_MAC, KEYS, SANS, SectionId, Status, statusColor } from "./mock";
import { ContextMenu, type ContextItem } from "./ContextMenu";
import { dnd } from "./panes";
import { windowAction } from "./win";
import {
  CpuIcon,
  ForwardIcon,
  HostsIcon,
  KeyIcon,
  LockIcon,
  LogsIcon,
  SearchIcon,
  SettingsIcon,
  SftpIcon,
  ShieldIcon,
  SidebarToggleIcon,
  SnippetIcon,
} from "./icons";

export type Tab = { id: string; kind?: "terminal" | "sftp"; name: string; status: Status; attention?: boolean; panes?: number; title?: string };

const iconBtn = (w = 28): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: w,
  height: w,
  padding: 0,
  border: 0,
  borderRadius: 6,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
});

const NAV: { id: SectionId; label: string; icon: ReactNode }[] = [
  { id: "hosts", label: "Hosts", icon: <HostsIcon /> },
  { id: "snippets", label: "Snippets", icon: <SnippetIcon /> },
  { id: "forwarding", label: "Port forwarding", icon: <ForwardIcon /> },
  { id: "keychain", label: "Keychain", icon: <KeyIcon /> },
  { id: "known", label: "Known hosts", icon: <ShieldIcon /> },
  { id: "logs", label: "Logs", icon: <LogsIcon /> },
  { id: "ai", label: "AI access", icon: <CpuIcon /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon /> },
];
const STRIP = 40;
const TAB_H = 36;
const SIDEBAR_W = 240;
const SLIDE_MS = 240;
const slide = (prop: string) => `${prop} ${SLIDE_MS}ms var(--ease-out)`;

function useNow(on: boolean, every: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(t);
  }, [on, every]);
  return now;
}

function AiLive({ until }: { until: number | null }) {
  const now = useNow(until !== null, 15000);
  const mins = until === null ? null : Math.max(1, Math.ceil((until - now) / 60000));
  const left = mins === null ? "" : mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  return (
    <span title={mins === null ? "AI access is on" : `AI access is on, turns off in ${left}`} style={{ display: "flex", alignItems: "center", gap: 7, flex: "none", color: "var(--ok)", fontSize: 11, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
      {left}
      <span aria-hidden="true" data-anim="ping" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok)" }} />
    </span>
  );
}

export function useMacInset() {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!IS_MAC) return;
    let un: (() => void) | undefined;
    let alive = true;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        const sync = async () => {
          try {
            const f = await w.isFullscreen();
            if (alive) setFull(!!f);
          } catch {
            /* not available */
          }
        };
        await sync();
        un = await w.onResized(() => void sync());
      } catch {
        /* not running under Tauri */
      }
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, []);
  return IS_MAC && !full ? 78 : 8;
}

function useMaximized() {
  const [max, setMax] = useState(false);
  useEffect(() => {
    let un: (() => void) | undefined;
    let alive = true;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        const sync = async () => {
          try {
            const m = await w.isMaximized();
            if (alive) setMax(!!m);
          } catch {
            /* not available */
          }
        };
        await sync();
        un = await w.onResized(() => void sync());
      } catch {
        /* not running under Tauri */
      }
    })();
    return () => {
      alive = false;
      un?.();
    };
  }, []);
  return max;
}

export function WindowControls() {
  const maximized = useMaximized();
  return (
    <div style={{ display: "flex", alignSelf: "stretch" }}>
      {(["min", "max", "close"] as const).map((k) => (
        <button
          key={k}
          type="button"
          aria-label={k === "min" ? "Minimize" : k === "max" ? (maximized ? "Restore" : "Maximize") : "Close"}
          title={k === "min" ? "Minimize" : k === "max" ? (maximized ? "Restore" : "Maximize") : "Close"}
          tabIndex={-1}
          data-no-press
          onClick={() => windowAction(k)}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 46, height: 40, padding: 0, border: 0, background: "transparent", color: "var(--text-2)", cursor: "pointer" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = k === "close" ? "#C42B1C" : "var(--sel)";
            if (k === "close") e.currentTarget.style.color = "#FFFFFF";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-2)";
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1}>
            {k === "min" && <path d="M0 5h10" />}
            {k === "max" && !maximized && <rect x="0.5" y="0.5" width="9" height="9" />}
            {k === "max" && maximized && (
              <>
                <rect x="0.5" y="2.5" width="7" height="7" />
                <path d="M2.5 2.5V0.5h7v7h-2" />
              </>
            )}
            {k === "close" && <path d="m0 0 10 10M10 0 0 10" />}
          </svg>
        </button>
      ))}
    </div>
  );
}

function Cross({ turned }: { turned?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" aria-hidden="true" style={{ display: "block", transform: turned ? "rotate(45deg)" : undefined }}>
      <path d="M6.5 2.5v8M2.5 6.5h8" />
    </svg>
  );
}

function NewTabButton({ onClick, tabSized }: { onClick: () => void; tabSized?: boolean }) {
  return (
    <button
      type="button"
      data-icon-btn
      aria-label="New tab"
      title={`New tab (${KEYS.newTab})`}
      onClick={onClick}
      style={{ ...iconBtn(28), width: tabSized ? 22 : 28, height: tabSized ? 22 : 28, borderRadius: 6, background: undefined, flex: "none", color: "var(--text-2)" }}
    >
      <Cross />
    </button>
  );
}

function TabLabel({ text, bold }: { text: string; bold: boolean }) {
  const item: CSSProperties = { gridArea: "1 / 1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  return (
    <span style={{ display: "grid", flex: "0 1 auto", minWidth: 0, maxWidth: 150 }}>
      <span aria-hidden="true" style={{ ...item, fontWeight: 600, visibility: "hidden" }}>
        {text}
      </span>
      <span style={{ ...item, fontWeight: bold ? 600 : 400 }}>{text}</span>
    </span>
  );
}

function TitleBar({
  tabs,
  activeTab,
  updateReady,
  onUpdate,
  onLock,
  onSelectTab,
  onCloseTab,
  onDragTab,
  onReorderTab,
  tabMenu,
  onNewTab,
  sidebarOpen,
}: {
  sidebarOpen: boolean;
  tabs: Tab[];
  activeTab: string;
  updateReady: boolean;
  onUpdate: () => void;
  onLock: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onDragTab: (e: React.MouseEvent, id: string, name: string) => void;
  onReorderTab: (id: string, beforeId: string) => void;
  tabMenu: (id: string) => ContextItem[];
  onNewTab: () => void;
}) {
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; id: string; restore: HTMLElement | null } | null>(null);
  const stripRef = useRef<HTMLElement | null>(null);
  const [hoverTab, setHoverTab] = useState<string | null>(null);
  const [tabSlide, setTabSlide] = useState<{ id: string; dx: number; from: number; to: number; w: number; settling: boolean; done?: boolean } | null>(null);
  const slideAbort = useRef<(() => void) | null>(null);
  const startSlide = (e: React.MouseEvent<HTMLElement>, id: string, name: string) => {
    if (e.button !== 0) return;
    const strip = stripRef.current;
    if (!strip) return;
    const els = [...strip.querySelectorAll<HTMLElement>("[data-tab-id]")];
    const rects = els.map((el) => ({ id: el.dataset.tabId ?? "", left: el.offsetLeft, width: el.offsetWidth }));
    const from = rects.findIndex((r) => r.id === id);
    if (from < 0) return;
    const me = rects[from];
    const band = strip.getBoundingClientRect();
    const tabEl = e.currentTarget;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    let to = from;
    const cleanup = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", abort);
      if (slideAbort.current === abort) slideAbort.current = null;
      document.documentElement.style.cursor = "";
    };
    const abort = () => {
      cleanup();
      if (started) setTabSlide(null);
    };
    const move = (ev: MouseEvent) => {
      if ((ev.buttons & 1) === 0) {
        abort();
        return;
      }
      const dx = ev.clientX - sx;
      if (!started) {
        if (Math.abs(dx) < 5 && Math.abs(ev.clientY - sy) < 5) return;
        started = true;
        onSelectTab(id);
        document.documentElement.style.cursor = "grabbing";
      }
      ev.preventDefault();
      if (ev.clientY > band.bottom + 28 || ev.clientY < band.top - 28) {
        cleanup();
        setTabSlide(null);
        onDragTab({ button: 0, currentTarget: tabEl, clientX: ev.clientX, clientY: ev.clientY } as unknown as React.MouseEvent, id, name);
        return;
      }
      const last = rects[rects.length - 1];
      const cdx = Math.max(rects[0].left - me.left, Math.min(last.left + last.width - me.left - me.width, dx));
      const center = me.left + cdx + me.width / 2;
      to = rects.filter((r, k) => k !== from && r.left + r.width / 2 < center).length;
      setTabSlide({ id, dx: cdx, from, to, w: me.width, settling: false });
    };
    const up = () => {
      cleanup();
      if (!started) return;
      const stop = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", stop, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
      const slot = to > from ? rects[to].left + rects[to].width - me.width : to < from ? rects[to].left : me.left;
      setTabSlide({ id, dx: slot - me.left, from, to, w: me.width, settling: true });
      window.setTimeout(() => {
        if (to !== from) onReorderTab(id, rects[to].id);
        setTabSlide({ id, dx: 0, from, to: from, w: me.width, settling: true, done: true });
        requestAnimationFrame(() => requestAnimationFrame(() => setTabSlide(null)));
      }, 150);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      cleanup();
      setTabSlide(null);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", abort);
    slideAbort.current?.();
    slideAbort.current = abort;
  };
  useEffect(() => () => slideAbort.current?.(), []);
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>(`[data-tab-id="${activeTab}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab, tabs.length]);
  const { payload, hint } = useSyncExternalStore(dnd.subscribe, dnd.get);
  const inset = useMacInset();

  return (
    <header data-tauri-drag-region data-tab-strip style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0, height: STRIP, paddingLeft: sidebarOpen ? 0 : inset + 36, background: "var(--bg-chrome)", boxSizing: "border-box", transition: slide("padding-left") }}>
      <span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, background: "var(--line)", pointerEvents: "none" }} />
      <nav
        ref={stripRef}
        role="tablist"
        aria-label="Open tabs"
        onWheel={(e) => {
          if (e.deltaY && stripRef.current) stripRef.current.scrollLeft += e.deltaY;
        }}
        style={{ display: "flex", alignItems: "flex-end", alignSelf: "stretch", minWidth: 0, overflowX: "auto", overflowY: "hidden", scrollbarWidth: "none", padding: tabs.length ? "0 9px" : 0 }}
      >
        {tabs.map((t, i) => {
          const active = activeTab === t.id;
          const hovered = hoverTab === t.id;
          const next = tabs[i + 1];
          const divider = !active && !!next && next.id !== activeTab && !hovered && hoverTab !== next.id;
          const here = hint?.kind === "tab" && hint.tabId === t.id ? hint : null;
          const into = here?.mode === "into";
          const dragged = payload?.kind === "tab" && payload.tabId === t.id;
          const sliding = tabSlide?.id === t.id;
          const shift = !tabSlide || sliding ? 0 : tabSlide.from < tabSlide.to && i > tabSlide.from && i <= tabSlide.to ? -tabSlide.w : tabSlide.from > tabSlide.to && i >= tabSlide.to && i < tabSlide.from ? tabSlide.w : 0;
          const panes = t.panes ?? 0;
          const openMenu = (x: number, y: number, el: HTMLElement) => setTabCtx({ x, y, id: t.id, restore: el });
          return (
            <div
              key={t.id}
              role="tab"
              data-anim="tab"
              onAnimationEnd={(e) => {
                if (e.target === e.currentTarget) e.currentTarget.removeAttribute("data-anim");
              }}
              tabIndex={0}
              aria-selected={active}
              data-tab-id={t.id}
              title={t.attention ? `${t.name} (bell)` : t.title ? `${t.name}. Panes: ${t.title}` : t.name}
              onClick={() => onSelectTab(t.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectTab(t.id);
                } else if (e.key === "Delete") {
                  e.preventDefault();
                  onCloseTab(t.id);
                } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  openMenu(r.left + 12, r.bottom, e.currentTarget);
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) onCloseTab(t.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, e.currentTarget);
              }}
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                startSlide(e, t.id, t.name);
              }}
              onMouseEnter={() => setHoverTab(t.id)}
              onMouseLeave={() => setHoverTab((h) => (h === t.id ? null : h))}
              style={{
                position: "relative",
                isolation: "isolate",
                display: "flex",
                alignItems: "center",
                gap: 6,
                minWidth: 88,
                flex: "0 1 auto",
                height: TAB_H,
                padding: `0 6px ${STRIP - TAB_H + 1}px 10px`,
                background: into ? (here?.ok ? "var(--accent-tint)" : "var(--err-tint)") : active ? "var(--tab)" : "transparent",
                borderWidth: "1px 1px 0",
                borderStyle: "solid",
                borderColor: active && !into ? "var(--line)" : "transparent",
                borderRadius: "8px 8px 0 0",
                boxSizing: "border-box",
                color: active || t.attention || into ? "var(--text)" : "var(--text-2)",
                boxShadow: here?.mode === "reorder" ? "inset 2px 0 0 var(--text-3)" : into ? `inset 0 0 0 1px ${here?.ok ? "var(--accent)" : "var(--err)"}` : undefined,
                opacity: dragged ? 0.55 : 1,
                cursor: "pointer",
                zIndex: sliding ? 2 : undefined,
                transform: tabSlide?.done ? undefined : sliding ? `translateX(${tabSlide.dx}px)` : shift ? `translateX(${shift}px)` : undefined,
                transition: tabSlide?.done || (sliding && !tabSlide.settling) ? "background 120ms, opacity 120ms" : "background 120ms, opacity 120ms, transform 150ms var(--ease-out)",
              }}
            >
              {!active && !into && (
                <span aria-hidden="true" style={{ position: "absolute", inset: `3px 1px ${3 + STRIP - TAB_H}px`, zIndex: -1, borderRadius: 7, background: t.attention ? "var(--accent-tint)" : "var(--hover)", opacity: hovered || t.attention ? 1 : 0, transition: "opacity 120ms", pointerEvents: "none" }} />
              )}
              {active && !into && (
                <>
                  <span aria-hidden="true" style={{ position: "absolute", left: -9, bottom: 0, width: 9, height: 9, background: "radial-gradient(circle at 0 0, transparent 7.6px, var(--line) 8.1px, var(--line) 8.9px, var(--tab) 9.4px)", pointerEvents: "none" }} />
                  <span aria-hidden="true" style={{ position: "absolute", right: -9, bottom: 0, width: 9, height: 9, background: "radial-gradient(circle at 100% 0, transparent 7.6px, var(--line) 8.1px, var(--line) 8.9px, var(--tab) 9.4px)", pointerEvents: "none" }} />
                </>
              )}
              {divider && <span aria-hidden="true" style={{ position: "absolute", right: -1, top: 9, bottom: 9, width: 1, background: "var(--line)", pointerEvents: "none" }} />}
              <span aria-hidden="true" data-anim={t.status === "warn" ? "pulse" : undefined} style={{ width: 7, height: 7, flex: "none", borderRadius: "50%", background: t.status === "idle" ? "transparent" : statusColor(t.status), border: t.status === "idle" ? "1.5px solid var(--ring-idle)" : "none", boxSizing: "border-box" }} />
              {t.kind === "sftp" && (
                <span aria-label="SFTP" style={{ display: "flex", flex: "none", color: "var(--text-2)" }}>
                  <SftpIcon size={13} />
                </span>
              )}
              <TabLabel text={t.name} bold={active} />
              {panes > 1 && (
                <span aria-label={`${panes} panes`} style={{ flex: "none", minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "var(--bg-raised)", color: "var(--text-2)", fontSize: 10.5, fontWeight: 600, lineHeight: "16px", textAlign: "center", boxSizing: "border-box" }}>
                  {panes}
                </span>
              )}
              <button
                type="button"
                aria-label={`Close ${t.name}`}
                title={`Close (${KEYS.closeTab})`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(t.id);
                }}
                data-icon-btn
                style={{ ...iconBtn(22), background: undefined, flex: "none", color: "var(--text-2)" }}
              >
                <Cross turned />
              </button>
            </div>
          );
        })}
      </nav>
      <div style={{ position: "relative", display: "flex", alignItems: "center", alignSelf: "center", height: 28, flex: "none", boxSizing: "border-box", marginLeft: tabs.length ? -7 : 2 }}>
        <NewTabButton onClick={onNewTab} tabSized={tabs.length > 0} />
      </div>
      <div data-tauri-drag-region style={{ flex: 1, alignSelf: "stretch", minWidth: 24 }} />
      {updateReady && (
        <button type="button" onClick={onUpdate} title="An update is ready to install" style={{ display: "flex", alignItems: "center", gap: 6, flex: "none", height: 24, padding: "0 10px", marginRight: 4, border: "1px solid var(--line)", borderRadius: 12, background: "transparent", color: "var(--text)", fontSize: 12, cursor: "pointer" }}>
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)" }} />
          Update
        </button>
      )}
      <button type="button" aria-label="Lock vault" title={`Lock vault (${KEYS.lock})`} onClick={onLock} style={{ ...iconBtn(), flex: "none", marginRight: 8, color: "var(--text-2)" }}>
        <LockIcon />
      </button>
      {!IS_MAC && <WindowControls />}
      {tabCtx && (
        <ContextMenu
          pos={tabCtx}
          label="Tab actions"
          items={tabMenu(tabCtx.id)}
          onClose={(restore) => {
            const el = tabCtx.restore;
            setTabCtx(null);
            if (restore) el?.focus();
          }}
        />
      )}
    </header>
  );
}

export type DragHost = (e: React.MouseEvent, id: string, label: string) => void;

function Sidebar({
  section,
  vaultActive,
  aiActive,
  aiUntil,
  onSelect,
  onOpenPalette,
}: {
  section: SectionId;
  vaultActive: boolean;
  aiActive: boolean;
  aiUntil: number | null;
  onSelect: (s: SectionId) => void;
  onOpenPalette: () => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const [pill, setPill] = useState<{ top: number; h: number; on: boolean } | null>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const b = nav.querySelector<HTMLElement>('[aria-current="page"]');
      setPill((p) => (b ? { top: b.offsetTop, h: b.offsetHeight, on: true } : p ? { ...p, on: false } : null));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [section, vaultActive]);
  useEffect(() => {
    if (!pill || ready) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [pill, ready]);
  return (
    <aside aria-label="Sidebar" style={{ width: SIDEBAR_W, flex: `0 0 ${SIDEBAR_W}px`, display: "flex", flexDirection: "column", gap: 12, minWidth: 0, minHeight: 0, padding: "12px 10px", background: "var(--bg-side)", borderRight: "1px solid var(--line)", boxSizing: "border-box" }}>
      <button type="button" onClick={onOpenPalette} title={`Search or connect (${KEYS.palette})`} style={{ display: "flex", alignItems: "center", gap: 8, height: 32, flex: "none", padding: "0 8px 0 10px", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6, color: "var(--text-2)", boxSizing: "border-box", cursor: "pointer", textAlign: "left" }}>
        <SearchIcon />
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Search or connect</span>
      </button>

      <nav ref={navRef} aria-label="Sections" style={{ position: "relative", display: "flex", flexDirection: "column", gap: 2, flex: 1, minHeight: 0, overflow: "auto" }}>
        {pill && <span aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, right: 0, height: pill.h, borderRadius: 6, background: "var(--sel)", opacity: pill.on ? 1 : 0, transform: `translateY(${pill.top}px)`, transition: ready ? "transform 240ms var(--ease-out), opacity 120ms" : "none", pointerEvents: "none" }} />}
        {NAV.map((n) => {
          const active = vaultActive && section === n.id;
          const hot = n.id === "ai" && aiActive;
          return (
            <button
              key={n.id}
              type="button"
              data-nav
              aria-current={active ? "page" : undefined}
              onClick={() => onSelect(n.id)}
              style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, height: 30, flex: "none", marginTop: n.id === "settings" ? "auto" : 0, padding: "0 8px", border: 0, borderRadius: 6, color: "var(--text)", fontWeight: active ? 600 : 400, textAlign: "left", cursor: "pointer" }}
            >
              <span style={{ display: "flex" }}>{n.icon}</span>
              <span style={{ flex: 1 }}>{n.label}</span>
              {hot && <AiLive until={aiUntil} />}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

export function Shell({
  theme,
  section,
  vaultActive,
  tabs,
  activeTab,
  sidebarOpen,
  aiActive,
  aiUntil = null,
  updateReady,
  onUpdate,
  onToggleSidebar,
  onSelectSection,
  onDragTab,
  onReorderTab,
  tabMenu,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onOpenPalette,
  onLock,
  children,
}: {
  theme: "dark" | "light";
  section: SectionId;
  vaultActive: boolean;
  tabs: Tab[];
  activeTab: string;
  sidebarOpen: boolean;
  aiActive: boolean;
  aiUntil?: number | null;
  updateReady: boolean;
  onUpdate: () => void;
  onToggleSidebar: () => void;
  onSelectSection: (s: SectionId) => void;
  onDragTab: (e: React.MouseEvent, id: string, name: string) => void;
  onReorderTab: (id: string, beforeId: string) => void;
  tabMenu: (id: string) => ContextItem[];
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onOpenPalette: () => void;
  onLock: () => void;
  children: ReactNode;
}) {
  const inset = useMacInset();
  const firstLayout = useRef(true);
  useEffect(() => {
    if (firstLayout.current) {
      firstLayout.current = false;
      return;
    }
    const root = document.documentElement;
    const scale = parseFloat(getComputedStyle(root).getPropertyValue("--anim-scale"));
    const settle = () => {
      root.removeAttribute("data-relayout");
      window.dispatchEvent(new Event("kst-relayout"));
    };
    root.setAttribute("data-relayout", "");
    const t = window.setTimeout(settle, (SLIDE_MS + 40) * (Number.isFinite(scale) ? scale : 1));
    return () => {
      window.clearTimeout(t);
      settle();
    };
  }, [sidebarOpen]);
  return (
    <div className={theme === "light" ? "t-light" : "t-dark"} data-anim="app" style={{ position: "relative", width: "100%", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", color: "var(--text)", fontFamily: SANS, fontSize: 13, lineHeight: 1.4 }}>
      <button type="button" aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} title={sidebarOpen ? "Hide sidebar" : "Show sidebar"} onClick={onToggleSidebar} style={{ ...iconBtn(), position: "absolute", top: (STRIP - 28) / 2, left: inset, zIndex: 3, color: "var(--text-2)" }}>
        <SidebarToggleIcon />
      </button>
      <div style={{ display: "flex", height: STRIP, flex: "none" }}>
        <div data-tauri-drag-region style={{ width: sidebarOpen ? SIDEBAR_W : 0, flex: "none", overflow: "hidden", transition: slide("width") }}>
          <div data-tauri-drag-region style={{ width: SIDEBAR_W, height: "100%", background: "var(--bg-side)", borderRight: "1px solid var(--line)", borderBottom: "1px solid var(--line)", boxSizing: "border-box" }} />
        </div>
        <TitleBar sidebarOpen={sidebarOpen} tabs={tabs} activeTab={activeTab} updateReady={updateReady} onUpdate={onUpdate} onLock={onLock} onSelectTab={onSelectTab} onCloseTab={onCloseTab} onDragTab={onDragTab} onReorderTab={onReorderTab} tabMenu={tabMenu} onNewTab={onNewTab} />
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div inert={!sidebarOpen || undefined} style={{ display: "flex", width: sidebarOpen ? SIDEBAR_W : 0, flex: "none", overflow: "hidden", transition: slide("width") }}>
          <Sidebar section={section} vaultActive={vaultActive} aiActive={aiActive} aiUntil={aiUntil} onSelect={onSelectSection} onOpenPalette={onOpenPalette} />
        </div>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>{children}</div>
      </div>
    </div>
  );
}
