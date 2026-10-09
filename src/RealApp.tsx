import { CSSProperties, ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import type { ApprovalRequest, Host, HostKeyChanged, HostKeyRequest, Identity, KnownHostEntry, NewHost, Snippet } from "./api";
import { usePrefs } from "./lib/prefs";
import { Shell, type Tab } from "./ui/Shell";
import { IS_MAC, MONO, errText, readJson, writeJson, type SectionId, type Status } from "./ui/mock";
import { LockIcon, CloseIcon } from "./ui/icons";
import { BootScreen, LockScreen } from "./ui/LockScreen";
import { termBus, TerminalSession, type SessionStatus } from "./ui/screens/TerminalSession";
import type { PaneStage } from "./ui/termBus";
import { PanePool, type PoolPane } from "./ui/PanePool";
import { beginDrag } from "./ui/drag";
import type { ContextItem } from "./ui/ContextMenu";
import {
  MAX_PANES,
  aggregate,
  autoSide,
  dnd,
  equalize,
  hasPane,
  insertAt,
  leaf,
  leaves,
  neighbor,
  newPaneId,
  paneStore,
  removePane,
  setRatio,
  siblingLeaf,
  swapPanes,
  zoneAt,
  type DragPayload,
  type DropHint,
  type Layout,
  type PaneSpec,
  type Side,
  type StartDrag,
  type Zone,
} from "./ui/panes";
import { HostsScreen, type QuickConnect } from "./ui/screens/HostsScreen";
import { SftpScreen } from "./ui/screens/SftpScreen";
import { KeychainScreen } from "./ui/screens/KeychainScreen";
import { SnippetsScreen, clearSnippetRuns, flushSnippetSaves } from "./ui/screens/SnippetsScreen";
import { PortForwardingScreen } from "./ui/screens/PortForwardingScreen";
import { KnownHostsScreen } from "./ui/screens/KnownHostsScreen";
import { AiScreen } from "./ui/screens/AiScreen";
import { LogsScreen } from "./ui/screens/LogsScreen";
import { WelcomeScreen } from "./ui/screens/WelcomeScreen";
import { SettingsScreen } from "./ui/screens/SettingsScreen";
import { CommandPalette, type PaletteAction } from "./ui/overlays/CommandPalette";
import { AiStoppedDialog, ApprovalDialog, ConfirmDialog, HostKeyChangedDialog, HostKeyDialog, TrayOnboardingDialog, UpdateDialog, VisibleLine } from "./ui/overlays/Dialogs";

// ------------------------------------------------------------------ theme

function useResolvedTheme(): "dark" | "light" {
  const { theme } = usePrefs();
  const [sysDark, setSysDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSysDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return theme === "system" ? (sysDark ? "dark" : "light") : theme;
}

// ------------------------------------------------------------------ root / vault gate

export default function RealApp() {
  const theme = useResolvedTheme();
  const [exists, setExists] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [bootError, setBootError] = useState("");

  const refreshVault = useCallback(async () => {
    try {
      const [e, u] = await Promise.all([api.vaultExists(), api.vaultStatus()]);
      setExists(e);
      setUnlocked(u);
      setBootError("");
    } catch (err) {
      setBootError(errText(err));
    }
  }, []);

  useEffect(() => {
    void refreshVault();
  }, [refreshVault]);

  const [askTray, setAskTray] = useState(false);
  const stopAsking = useRef<(() => void) | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.settingsGet();
        if (s.onboarded || !alive) return;
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const off = await getCurrentWindow().onCloseRequested((e) => {
          e.preventDefault();
          setAskTray(true);
        });
        if (alive) stopAsking.current = off;
        else off();
      } catch {
        /* not running under Tauri */
      }
    })();
    return () => {
      alive = false;
      stopAsking.current?.();
      stopAsking.current = null;
    };
  }, []);

  const lockedByHand = useRef(false);
  const cls = theme === "light" ? "t-light" : "t-dark";
  const screen =
    exists === null ? (
      <BootScreen className={cls} error={bootError} onRetry={() => void refreshVault()} />
    ) : !unlocked ? (
      <LockScreen className={cls} exists={exists} error={bootError} autoHello={!lockedByHand.current} onUnlocked={refreshVault} />
    ) : (
      <Workspace
        theme={theme}
        onLocked={() => {
          lockedByHand.current = true;
          return refreshVault();
        }}
      />
    );
  return (
    <>
      {screen}
      {askTray && (
        <div className={cls} style={{ display: "contents" }}>
          <TrayOnboardingDialog
            onChoose={async (tray) => {
              await api.settingsSetMinimizeToTray(tray);
              await api.settingsSetOnboarded();
              stopAsking.current?.();
              stopAsking.current = null;
              setAskTray(false);
              const { getCurrentWindow } = await import("@tauri-apps/api/window");
              await getCurrentWindow().close();
            }}
          />
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ toasts

type Toast = { id: number; kind: "info" | "error" | "ok"; text: string; sticky?: boolean };

function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 100000, display: "flex", flexDirection: "column", gap: 8, maxWidth: 420 }}>
      {items.map((t) => (
        <div key={t.id} role={t.kind === "error" ? "alert" : "status"} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 10px 10px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", fontSize: 12.5 }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, marginTop: 5, flex: "none", borderRadius: "50%", background: t.kind === "error" ? "var(--err)" : t.kind === "ok" ? "var(--ok)" : "var(--accent)" }} />
          <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => onDismiss(t.id)} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", cursor: "pointer", flex: "none" }}>
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ AI changed hosts

function signIn(h: Host, identities: Identity[] | null): { user: string; method: string } {
  const a = h.auth;
  if (a.kind === "agent") return { user: h.username, method: "SSH agent" };
  if (a.kind === "key") return { user: h.username, method: `Key ${a.secret_id}` };
  if (a.kind === "password") return { user: h.username, method: `Password ${a.secret_id}` };
  const it = identities?.find((i) => i.id === a.identity_id);
  return { user: it?.username || h.username, method: it ? `Identity ${it.name}` : "Identity" };
}

function AiHostFacts({ hosts, all, identities }: { hosts: Host[]; all: Host[]; identities: Identity[] | null }) {
  const dt: CSSProperties = { color: "var(--text-2)" };
  const dd: CSSProperties = { margin: 0, minWidth: 0, overflowWrap: "anywhere" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflow: "auto" }}>
      {hosts.map((h) => {
        const { user, method } = signIn(h, identities);
        const addr = `${user}@${h.hostname.includes(":") ? `[${h.hostname}]` : h.hostname}:${h.port}`;
        const jump = h.jump_host_id ? all.find((x) => x.id === h.jump_host_id)?.name ?? "missing host" : "";
        return (
          <dl key={h.id} data-selectable style={{ display: "grid", gridTemplateColumns: "84px minmax(0, 1fr)", gap: "6px 12px", margin: 0, padding: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-sunken)", fontSize: 12.5 }}>
            <dt style={dt}>Name</dt>
            <dd style={dd}><VisibleLine text={h.name} /></dd>
            <dt style={dt}>Address</dt>
            <dd style={{ ...dd, fontFamily: MONO, fontSize: 12 }}><VisibleLine text={addr} /></dd>
            <dt style={dt}>Sign-in</dt>
            <dd style={dd}><VisibleLine text={method} /></dd>
            {jump && (
              <>
                <dt style={dt}>Jump host</dt>
                <dd style={dd}><VisibleLine text={jump} /></dd>
              </>
            )}
          </dl>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ workspace

type Session = { tabId: string; kind: "terminal" | "sftp"; host: Host; status: Status; layout?: Layout; focus?: string; zoom?: string | null; broadcast?: boolean; openSeq?: number };
type EditorState = { host: Host | null; prefill?: Partial<NewHost>; connectAfterSave?: boolean; seq?: number };
type Confirm = { title: string; message: string; confirmLabel?: string; danger?: boolean; guarded?: boolean; width?: number; body?: ReactNode; onConfirm: () => void | Promise<void> };

const SESSION_TO_STATUS: Record<SessionStatus, Status> = { connecting: "warn", connected: "ok", reconnecting: "warn", error: "err", closed: "idle" };

type Drop = { hint: DropHint | null; spring: string | null };
const NO_DROP: Drop = { hint: null, spring: null };

function Workspace({ theme, onLocked }: { theme: "dark" | "light"; onLocked: () => void }) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hostsError, setHostsError] = useState("");
  const [snippetFocus, setSnippetFocus] = useState<{ id: string; seq: number }>();
  const [section, setSection] = useState<SectionId>("hosts");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [specs, setSpecs] = useState<Record<string, PaneSpec>>({});
  const specsRef = useRef(specs);
  specsRef.current = specs;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stages = useSyncExternalStore(paneStore.subscribeStages, paneStore.stages);
  const [activeTab, setActiveTab] = useState<string>("vault");
  const [lastTerminal, setLastTerminal] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => readJson("kestral-sidebar-open", true));
  useEffect(() => writeJson("kestral-sidebar-open", sidebarOpen), [sidebarOpen]);
  const [locking, setLocking] = useState(false);
  const lockingRef = useRef(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteHosts, setPaletteHosts] = useState(false);
  const openPalette = (hostsOnly: boolean) => {
    setPaletteHosts(hostsOnly);
    setPaletteOpen(true);
  };
  const toastRef = useRef<(kind: "info" | "error" | "ok", text: string) => void>(() => {});
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [editor, setEditorState] = useState<EditorState | null>(null);
  const editorRef = useRef(editor);
  const editorDirty = useRef(false);
  const editorSeq = useRef(0);
  const setEditor = (st: EditorState | null) => {
    editorDirty.current = false;
    editorRef.current = st && { ...st, seq: ++editorSeq.current };
    setEditorState(editorRef.current);
  };
  const onEditorDirty = useCallback((d: boolean) => {
    editorDirty.current = d;
  }, []);
  const discardEditorFirst = (then: () => void) => {
    if (!editorRef.current || !editorDirty.current) return then();
    const cur = editorRef.current.host;
    setConfirm({ title: "Discard changes?", message: cur ? `Your changes to ${cur.name} are not saved.` : "This host is not saved yet.", confirmLabel: "Discard", danger: true, onConfirm: then });
  };
  const editHost = (st: EditorState) => {
    const cur = editorRef.current;
    const same = !!cur && (cur.host || st.host ? cur.host?.id === st.host?.id : !cur.prefill && !st.prefill);
    setSection("hosts");
    setActiveTab("vault");
    if (same) return;
    discardEditorFirst(() => setEditor(st));
  };
  const [approvals, setApprovals] = useState<(ApprovalRequest & { receivedAt: number; expired?: boolean })[]>([]);
  const [aiStopped, setAiStopped] = useState<{ host_name: string; path: string } | null>(null);
  const [hostKeyReqs, setHostKeyReqs] = useState<(HostKeyRequest & { receivedAt: number; expired?: boolean; replaced?: boolean })[]>([]);
  const replacedKeys = useRef(new Set<string>());
  const [bellTabs, setBellTabs] = useState<Set<string>>(new Set());
  const [changedKeys, setChangedKeys] = useState<(HostKeyChanged & { at: number })[]>([]);
  const [changedOpen, setChangedOpen] = useState<{ info: HostKeyChanged; saved: KnownHostEntry[] } | null>(null);
  const [update, setUpdate] = useState<{ version: string; notes: string } | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [aiActive, setAiActive] = useState(false);
  const [aiUntil, setAiUntil] = useState<number | null>(null);
  const [aiPoke, setAiPoke] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const autostarted = useRef(false);
  const dataTimer = useRef<number | undefined>(undefined);
  const pendingKinds = useRef(new Set<string>());

  const toast = useCallback((kind: Toast["kind"], text: string, sticky = false) => {
    const id = ++toastSeq.current;
    setToasts((t) => (t.some((x) => x.text === text && x.kind === kind) ? t : [...t, { id, kind, text, sticky }]));
    if (!sticky) window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 5000);
  }, []);
  toastRef.current = toast;

  // ---------------------------------------------------------------- data
  const refreshHosts = useCallback(async () => {
    try {
      const list = await api.hostList();
      setHosts(list);
      setSessions((ss) => ss.map((s) => ({ ...s, host: list.find((h) => h.id === s.host.id) ?? s.host })));
      setHostsError("");
    } catch (e) {
      setHostsError(errText(e));
    } finally {
      setLoaded(true);
    }
  }, []);
  const refreshSnippets = useCallback(async () => {
    try {
      setSnippets(await api.snippetList());
    } catch {
      /* locked */
    }
  }, []);
  const refreshAll = useCallback(() => {
    void refreshHosts();
    void refreshSnippets();
  }, [refreshHosts, refreshSnippets]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!paletteOpen) return;
    void refreshHosts();
    void refreshSnippets();
  }, [paletteOpen, refreshHosts, refreshSnippets]);

  // Autostart forwards once per unlock.
  useEffect(() => {
    if (!loaded || hostsError || autostarted.current) return;
    autostarted.current = true;
    void (async () => {
      let active: Set<string>;
      try {
        active = new Set(await api.forwardActive());
      } catch {
        active = new Set();
      }
      for (const h of hosts) {
        if (h.ai_changed) {
          if (h.forwards.some((f) => f.autostart && !active.has(f.id))) toast("info", `Port forwards on ${h.name} did not start because the AI changed this host. Connect to it once to review it.`);
          continue;
        }
        for (const f of h.forwards) {
          if (!f.autostart || active.has(f.id)) continue;
          try {
            await api.forwardStart(h.id, f.id);
          } catch (e) {
            toast("error", `Port forward ${f.name || f.local_port} on ${h.name} did not start: ${errText(e)}`);
          }
        }
      }
    })();
  }, [loaded, hostsError, hosts, toast]);

  // Startup checks: data warnings, tray onboarding, updates.
  useEffect(() => {
    let alive = true;
    api
      .dataWarnings()
      .then((ws) => alive && ws.forEach((w) => toast("error", w, true)))
      .catch(() => {});
    const checkUpdate = async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check();
        if (alive && u) {
          (window as unknown as { __kestralUpdate?: unknown }).__kestralUpdate = u;
          setUpdate({ version: u.version, notes: u.body || "" });
        }
      } catch {
        /* offline or updater unavailable */
      }
    };
    void checkUpdate();
    const every = window.setInterval(() => void checkUpdate(), 6 * 60 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(every);
    };
  }, [toast]);

  // AI status for the sidebar indicator.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.aiStatus();
        if (!alive) return;
        setAiActive(s.active);
        const until = s.active && s.expires_at ? Date.parse(s.expires_at) : NaN;
        setAiUntil(Number.isFinite(until) ? until : null);
      } catch {
        /* locked */
      }
    };
    void tick();
    const t = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [aiPoke]);

  // Backend events.
  useEffect(() => {
    const subs = [
      listen<ApprovalRequest>("approval-request", (e) => setApprovals((q) => (q.some((r) => r.id === e.payload.id) ? q : [...q, { ...e.payload, receivedAt: Date.now() }]))),
      listen<string>("approval-expired", (e) => setApprovals((q) => q.map((r) => (r.id === e.payload ? { ...r, expired: true } : r)))),
      listen<{ host_name: string; path: string }>("ai-stopped", (e) => setAiStopped(e.payload)),
      listen<HostKeyRequest>("hostkey-request", (e) => {
        const k = `${e.payload.host.toLowerCase()}:${e.payload.port}`;
        const replaced = replacedKeys.current.delete(k);
        setHostKeyReqs((q) => (q.some((r) => r.id === e.payload.id) ? q : [...q, { ...e.payload, receivedAt: Date.now(), replaced }]));
      }),
      listen<string>("hostkey-expired", (e) => setHostKeyReqs((q) => q.map((r) => (r.id === e.payload ? { ...r, expired: true } : r)))),
      listen<HostKeyChanged>("hostkey-changed", (e) => {
        const c = e.payload;
        setChangedKeys((list) => (list.some((x) => x.host === c.host && x.port === c.port && x.fingerprint === c.fingerprint) ? list : [...list, { ...c, at: Date.now() }]));
        openChanged(c);
      }),
      listen<string>("data-changed", (e) => {
        if (lockingRef.current) return;
        pendingKinds.current.add(e.payload);
        window.clearTimeout(dataTimer.current);
        dataTimer.current = window.setTimeout(() => {
          const kinds = pendingKinds.current;
          pendingKinds.current = new Set();
          if (kinds.has("all")) {
            refreshAll();
            return;
          }
          if (kinds.has("snippets")) void refreshSnippets();
          if ([...kinds].some((k) => k !== "snippets")) void refreshHosts();
        }, 150);
      }),
      listen<api.ForwardFailed>("forward-failed", (e) => toast("error", `Port forward ${e.payload.name} on ${e.payload.host} could not start: ${e.payload.error}`)),
      listen<api.HostKeySaveFailed>("hostkey-save-failed", (e) =>
        toast("error", `The host key of ${e.payload.host}:${e.payload.port} could not be saved (${e.payload.error}). You will be asked again on the next connection.`),
      ),
    ];
    api
      .hostkeyPending()
      .then((pending) =>
        setHostKeyReqs((q) => {
          const fresh = pending.filter((p) => !q.some((r) => r.id === p.id)).map((p) => ({ ...p, receivedAt: Date.now() }));
          return fresh.length ? [...q, ...fresh] : q;
        }),
      )
      .catch(() => {});
    return () => {
      subs.forEach((p) => p.then((un) => un()).catch(() => {}));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openChanged(info: HostKeyChanged) {
    setChangedOpen({ info, saved: info.saved ?? [] });
  }

  const hostFor = (host: string, port: number) => hosts.find((h) => h.hostname.toLowerCase() === host.toLowerCase() && h.port === port);
  const hostNameFor = (host: string, port: number) => hostFor(host, port)?.name;
  const aiChangedAt = (host: string, port: number) => hosts.some((h) => h.ai_changed && h.hostname.toLowerCase() === host.toLowerCase() && h.port === port);

  const gateAi = useCallback((ids: string[], then: () => void) => {
    const changed = hostsRef.current.filter((h) => ids.includes(h.id) && h.ai_changed);
    if (changed.length === 0) {
      then();
      return;
    }
    void (async () => {
      const identities = changed.some((h) => h.auth.kind === "identity") ? await api.identityList().catch(() => null) : null;
      const one = changed.length === 1;
      setConfirm({
        title: one ? "Changed by AI" : `${changed.length} hosts changed by AI`,
        message: one ? "The AI created this host or changed where it connects. Check it before you connect." : "The AI created these hosts or changed where they connect. Check them before you connect.",
        confirmLabel: "Connect",
        guarded: true,
        width: 460,
        body: <AiHostFacts hosts={changed} all={hostsRef.current} identities={identities} />,
        onConfirm: async () => {
          for (const h of changed) await api.hostAckAiChange(h.id);
          const acked = new Set(changed.map((h) => h.id));
          hostsRef.current = hostsRef.current.map((h) => (acked.has(h.id) ? { ...h, ai_changed: false } : h));
          setHosts(hostsRef.current);
          then();
        },
      });
    })();
  }, []);

  // ---------------------------------------------------------------- sessions
  const openTerminalNow = useCallback((host: Host, initialCommand?: string, password?: string | null) => {
    const tabId = crypto.randomUUID();
    const paneId = newPaneId();
    if (password) termBus.handOver(paneId, password);
    setSpecs((sp) => ({ ...sp, [paneId]: { hostId: host.id, initialCommand } }));
    setSessions((s) => [...s, { tabId, kind: "terminal", host, status: "warn", layout: leaf(paneId), focus: paneId, zoom: null, broadcast: false }]);
    setActiveTab(tabId);
    setLastTerminal(tabId);
  }, []);
  const openTerminal = useCallback(
    (host: Host, initialCommand?: string, password?: string | null) => gateAi([host.id], () => openTerminalNow(host, initialCommand, password)),
    [gateAi, openTerminalNow],
  );
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  const sftpUnsaved = useRef(new Map<string, string>());
  const openSftp = useCallback((host: Host) => {
    const open = sessionsRef.current.find((s) => s.kind === "sftp" && s.host.id === host.id);
    if (open) {
      setSessions((ss) => ss.map((s) => (s.tabId === open.tabId ? { ...s, openSeq: (s.openSeq ?? 0) + 1 } : s)));
      setActiveTab(open.tabId);
      return;
    }
    gateAi([host.id], () => {
      const tabId = crypto.randomUUID();
      setSessions((s) => [...s, { tabId, kind: "sftp", host, status: "warn" }]);
      setActiveTab(tabId);
    });
  }, [gateAi]);
  const dropTab = useCallback((tabId: string) => {
    sftpUnsaved.current.delete(tabId);
    setSessions((s) => {
      const idx = s.findIndex((t) => t.tabId === tabId);
      const next = s.filter((t) => t.tabId !== tabId);
      setActiveTab((cur) => (cur !== tabId ? cur : next.length ? next[Math.min(idx, next.length - 1)].tabId : "vault"));
      return next;
    });
    setLastTerminal((l) => (l === tabId ? null : l));
  }, []);
  const closeTab = useCallback(
    (tabId: string) => {
      const unsaved = sftpUnsaved.current.get(tabId);
      if (!unsaved) return dropTab(tabId);
      setConfirm({ title: "Close this tab?", message: `${unsaved} Closing discards them.`, confirmLabel: "Close tab", danger: true, onConfirm: () => dropTab(tabId) });
    },
    [dropTab],
  );
  const reorderTab = useCallback((from: string, to: string) => {
    setSessions((s) => {
      const arr = [...s];
      const fi = arr.findIndex((t) => t.tabId === from);
      const ti = arr.findIndex((t) => t.tabId === to);
      if (fi < 0 || ti < 0) return arr;
      const [moved] = arr.splice(fi, 1);
      arr.splice(ti, 0, moved);
      return arr;
    });
  }, []);
  const selectTab = useCallback((id: string) => {
    setActiveTab(id);
    setBellTabs((b) => {
      if (!b.has(id)) return b;
      const n = new Set(b);
      n.delete(id);
      return n;
    });
    setSessions((s) => {
      if (s.find((t) => t.tabId === id)?.kind === "terminal") setLastTerminal(id);
      return s;
    });
  }, []);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const ringBell = useCallback((tabId: string) => {
    if (activeTabRef.current === tabId) return;
    setBellTabs((b) => (b.has(tabId) ? b : new Set(b).add(tabId)));
  }, []);

  // ---------------------------------------------------------------- panes
  const patchTab = useCallback((tabId: string, patch: (s: Session) => Partial<Session> | null) => {
    setSessions((ss) => {
      let changed = false;
      const next = ss.map((x) => {
        if (x.tabId !== tabId) return x;
        const p = patch(x);
        if (!p) return x;
        changed = true;
        return { ...x, ...p };
      });
      return changed ? next : ss;
    });
  }, []);

  const contentSize = useCallback(() => {
    const r = contentRef.current?.getBoundingClientRect();
    return { w: r && r.width > 0 ? r.width : 1200, h: r && r.height > 0 ? r.height : 700 };
  }, []);

  const withoutPane = (x: Session, paneId: string, sib: string | null): Session | null => {
    const layout = x.layout ? removePane(x.layout, paneId) : null;
    if (!layout) return null;
    const ids = leaves(layout);
    const focus = x.focus && ids.includes(x.focus) ? x.focus : sib && ids.includes(sib) ? sib : ids[0];
    return { ...x, layout, focus, zoom: x.zoom && ids.includes(x.zoom) ? x.zoom : null, broadcast: ids.length > 1 && !!x.broadcast };
  };

  const splitPane = useCallback(
    (tabId: string, opts: { target?: string; side?: Side; hostId?: string } = {}): boolean => {
      const s = sessionsRef.current.find((x) => x.tabId === tabId);
      if (!s?.layout) return false;
      if (leaves(s.layout).length >= MAX_PANES) {
        toastRef.current("info", `A tab holds up to ${MAX_PANES} panes.`);
        return false;
      }
      const target = opts.target && hasPane(s.layout, opts.target) ? opts.target : s.focus && hasPane(s.layout, s.focus) ? s.focus : leaves(s.layout)[0];
      const hostId = opts.hostId ?? specsRef.current[target]?.hostId ?? s.host.id;
      if (hostsRef.current.some((x) => x.id === hostId && x.ai_changed)) {
        gateAi([hostId], () => {
          if (splitPane(tabId, opts)) selectTab(tabId);
        });
        return true;
      }
      const { w, h } = contentSize();
      const side = opts.side ?? autoSide(s.layout, target, w, h);
      const id = newPaneId();
      const typed = hostId === specsRef.current[target]?.hostId ? termBus.byId(target)?.password?.() : null;
      if (typed) termBus.handOver(id, typed);
      setSpecs((sp) => ({ ...sp, [id]: { hostId } }));
      setSessions((ss) => ss.map((x) => (x.tabId === tabId && x.layout ? { ...x, layout: insertAt(x.layout, target, side, leaf(id)), focus: id, zoom: null } : x)));
      return true;
    },
    [contentSize, gateAi, selectTab],
  );

  const closePane = useCallback(
    (paneId: string) => {
      const s = sessionsRef.current.find((x) => x.layout && hasPane(x.layout, paneId));
      if (!s?.layout) return;
      if (!removePane(s.layout, paneId)) {
        closeTab(s.tabId);
        return;
      }
      const sib = siblingLeaf(s.layout, paneId);
      setSessions((ss) => ss.map((x) => (x.tabId === s.tabId ? (withoutPane(x, paneId, sib) ?? x) : x)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closeTab],
  );

  const movePane = useCallback(
    (paneId: string, toTabId: string, target: string | null, zone: Zone | null) => {
      const ss = sessionsRef.current;
      const src = ss.find((x) => x.layout && hasPane(x.layout, paneId));
      const dst = ss.find((x) => x.tabId === toTabId);
      if (!src?.layout || !dst?.layout) return;
      const goal = target && hasPane(dst.layout, target) ? target : dst.focus && hasPane(dst.layout, dst.focus) ? dst.focus : leaves(dst.layout)[0];
      if (goal === paneId) return;
      const { w, h } = contentSize();
      if (src.tabId === dst.tabId) {
        let next: Layout;
        if (zone === "center") next = swapPanes(src.layout, paneId, goal);
        else {
          const rest = removePane(src.layout, paneId);
          if (!rest) return;
          next = insertAt(rest, goal, zone ?? autoSide(rest, goal, w, h), leaf(paneId));
        }
        patchTab(src.tabId, () => ({ layout: next, focus: paneId, zoom: null }));
        return;
      }
      if (leaves(dst.layout).length >= MAX_PANES) {
        toastRef.current("info", `A tab holds up to ${MAX_PANES} panes.`);
        return;
      }
      const side = zone && zone !== "center" ? zone : autoSide(dst.layout, goal, w, h);
      const sib = siblingLeaf(src.layout, paneId);
      const emptied = !removePane(src.layout, paneId);
      setSessions((list) =>
        list.flatMap((x) => {
          if (x.tabId === src.tabId) {
            const kept = withoutPane(x, paneId, sib);
            return kept ? [kept] : [];
          }
          if (x.tabId === dst.tabId && x.layout) return [{ ...x, layout: insertAt(x.layout, goal, side, leaf(paneId)), focus: paneId, zoom: null }];
          return [x];
        }),
      );
      if (emptied) setLastTerminal((l) => (l === src.tabId ? dst.tabId : l));
      selectTab(dst.tabId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contentSize, patchTab, selectTab],
  );

  const mergeTab = useCallback(
    (fromTabId: string, toTabId: string, target: string | null, zone: Zone | null) => {
      const ss = sessionsRef.current;
      const src = ss.find((x) => x.tabId === fromTabId);
      const dst = ss.find((x) => x.tabId === toTabId);
      if (!src?.layout || !dst?.layout || fromTabId === toTabId) return;
      if (leaves(src.layout).length + leaves(dst.layout).length > MAX_PANES) {
        toastRef.current("info", `A tab holds up to ${MAX_PANES} panes.`);
        return;
      }
      const goal = target && hasPane(dst.layout, target) ? target : dst.focus && hasPane(dst.layout, dst.focus) ? dst.focus : leaves(dst.layout)[0];
      const { w, h } = contentSize();
      const side = zone && zone !== "center" ? zone : autoSide(dst.layout, goal, w, h);
      const moved = src.layout;
      const focus = src.focus && hasPane(moved, src.focus) ? src.focus : leaves(moved)[0];
      setSessions((list) => list.filter((x) => x.tabId !== fromTabId).map((x) => (x.tabId === toTabId && x.layout ? { ...x, layout: insertAt(x.layout, goal, side, moved), focus, zoom: null, broadcast: !!x.broadcast } : x)));
      setLastTerminal((l) => (l === fromTabId ? toTabId : l));
      setBellTabs((b) => {
        if (!b.has(fromTabId)) return b;
        const n = new Set(b);
        n.delete(fromTabId);
        return n;
      });
      selectTab(toTabId);
    },
    [contentSize, selectTab],
  );

  const popOut = useCallback(
    (paneId: string) => {
      const src = sessionsRef.current.find((x) => x.layout && hasPane(x.layout, paneId));
      if (!src?.layout || leaves(src.layout).length < 2) return;
      const tabId = crypto.randomUUID();
      const host = hostsRef.current.find((h) => h.id === specsRef.current[paneId]?.hostId) ?? src.host;
      const sib = siblingLeaf(src.layout, paneId);
      setSessions((list) => {
        const i = list.findIndex((x) => x.tabId === src.tabId);
        if (i < 0) return list;
        const kept = withoutPane(list[i], paneId, sib);
        if (!kept) return list;
        const fresh: Session = { tabId, kind: "terminal", host, status: "warn", layout: leaf(paneId), focus: paneId, zoom: null, broadcast: false };
        return [...list.slice(0, i), kept, fresh, ...list.slice(i + 1)];
      });
      selectTab(tabId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectTab],
  );

  const focusPaneIn = useCallback((tabId: string, paneId: string) => patchTab(tabId, (x) => (x.focus === paneId ? null : { focus: paneId })), [patchTab]);

  useEffect(() => {
    const live = new Set(sessions.flatMap((s) => (s.layout ? leaves(s.layout) : [])));
    setSpecs((sp) => {
      const dead = Object.keys(sp).filter((id) => !live.has(id));
      if (!dead.length) return sp;
      const next = { ...sp };
      dead.forEach((id) => delete next[id]);
      return next;
    });
  }, [sessions]);

  // ---------------------------------------------------------------- drag and drop
  function resolveDrop(el: Element | null, pt: { x: number; y: number }, p: DragPayload): Drop {
    const ss = sessionsRef.current;
    const count = (tabId: string) => {
      const s = ss.find((x) => x.tabId === tabId);
      return s?.layout ? leaves(s.layout).length : 0;
    };
    const srcKind = p.kind === "tab" ? ss.find((x) => x.tabId === p.tabId)?.kind : "terminal";
    if (p.kind === "host" && !hostsRef.current.some((h) => h.id === p.hostId)) return NO_DROP;
    const paneEl = el?.closest?.("[data-pane-id]") as HTMLElement | null;
    if (paneEl) {
      const paneId = paneEl.dataset.paneId ?? "";
      const tabId = paneEl.dataset.paneTab ?? "";
      if (srcKind !== "terminal") return NO_DROP;
      if (p.kind === "tab" && p.tabId === tabId) return NO_DROP;
      if (p.kind === "pane" && p.paneId === paneId) return NO_DROP;
      const same = p.kind === "pane" && p.tabId === tabId;
      const incoming = p.kind === "tab" ? count(p.tabId) : same ? 0 : 1;
      const zone = zoneAt(paneEl.getBoundingClientRect(), pt.x, pt.y, same);
      return { hint: { kind: "pane", tabId, paneId, zone, ok: count(tabId) + incoming <= MAX_PANES }, spring: null };
    }
    const tabEl = el?.closest?.("[data-tab-id]") as HTMLElement | null;
    if (tabEl) {
      const tabId = tabEl.dataset.tabId ?? "";
      const target = ss.find((x) => x.tabId === tabId);
      if (!target) return NO_DROP;
      if (p.kind === "tab") {
        if (p.tabId === tabId) return NO_DROP;
        return { hint: { kind: "tab", tabId, mode: "reorder", ok: true }, spring: target.kind === "terminal" && srcKind === "terminal" ? tabId : null };
      }
      if (target.kind !== "terminal" || (p.kind === "pane" && p.tabId === tabId)) return NO_DROP;
      return { hint: { kind: "tab", tabId, mode: "into", ok: count(tabId) + 1 <= MAX_PANES }, spring: tabId };
    }
    return NO_DROP;
  }

  function applyDrop(p: DragPayload, h: DropHint) {
    if (h.kind === "pane") {
      if (!h.ok) return;
      if (p.kind === "tab") mergeTab(p.tabId, h.tabId, h.paneId, h.zone);
      else if (p.kind === "pane") movePane(p.paneId, h.tabId, h.paneId, h.zone);
      else if (h.zone !== "center" && splitPane(h.tabId, { target: h.paneId, side: h.zone, hostId: p.hostId })) selectTab(h.tabId);
      return;
    }
    if (h.kind === "tab") {
      if (p.kind === "tab") {
        if (h.mode === "reorder") reorderTab(p.tabId, h.tabId);
        return;
      }
      if (!h.ok) {
        toast("info", `A tab holds up to ${MAX_PANES} panes.`);
        return;
      }
      if (p.kind === "pane") movePane(p.paneId, h.tabId, null, null);
      else if (splitPane(h.tabId, { hostId: p.hostId })) selectTab(h.tabId);
    }
  }

  const dropRef = useRef({ resolve: resolveDrop, apply: applyDrop });
  dropRef.current = { resolve: resolveDrop, apply: applyDrop };

  const startDrag: StartDrag = useCallback(
    (e, payload, label) => {
      let springId: string | null = null;
      let springTimer = 0;
      const spring = (id: string | null) => {
        if (id === springId) return;
        springId = id;
        window.clearTimeout(springTimer);
        if (id && id !== activeTabRef.current) springTimer = window.setTimeout(() => selectTab(id), 650);
      };
      beginDrag(e, {
        label,
        onMove: (el, pt) => {
          const r = dropRef.current.resolve(el, pt, payload);
          dnd.set({ payload, hint: r.hint });
          spring(r.spring);
        },
        onDrop: (el, pt) => {
          window.clearTimeout(springTimer);
          const r = dropRef.current.resolve(el, pt, payload);
          if (r.hint) dropRef.current.apply(payload, r.hint);
        },
        onEnd: () => {
          window.clearTimeout(springTimer);
          dnd.set({ payload: null, hint: null });
        },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectTab],
  );

  const activeSession = sessions.find((s) => s.tabId === activeTab);
  const pasteSession = lastTerminal ? sessions.find((s) => s.tabId === lastTerminal) : undefined;
  const tabHost = (s: Session): Host => (s.kind === "terminal" && s.focus ? (hosts.find((h) => h.id === specs[s.focus ?? ""]?.hostId) ?? s.host) : s.host);

  function splitActive(host?: Host) {
    if (activeSession?.kind === "terminal" && splitPane(activeSession.tabId, { hostId: host?.id, side: "right" })) return;
    if (host) openTerminal(host);
  }

  function goSection(s: SectionId) {
    const go = () => {
      setSection(s);
      setActiveTab("vault");
    };
    if (s === "hosts") return go();
    discardEditorFirst(() => {
      if (editorDirty.current) setEditor(null);
      go();
    });
  }

  function lock() {
    if (lockingRef.current) return;
    const open = sessionsRef.current.length;
    const ed = editorRef.current && editorDirty.current ? (editorRef.current.host ? `Your changes to ${editorRef.current.host.name} are not saved.` : "The new host is not saved yet.") : "";
    const lost = [...new Set(sftpUnsaved.current.values()), ed].filter(Boolean);
    if (!open && !lost.length) {
      lockNow();
      return;
    }
    setConfirm({
      title: "Lock the vault?",
      message: [open ? (open === 1 ? "This closes the open tab." : `This closes all ${open} open tabs.`) : "", ...lost, lost.length ? "Locking discards them." : ""].filter(Boolean).join(" "),
      confirmLabel: "Lock",
      danger: lost.length > 0,
      onConfirm: lockNow,
    });
  }

  function lockNow() {
    if (lockingRef.current) return;
    lockingRef.current = true;
    setLocking(true);
    clearSnippetRuns();
    setSessions([]);
    setSpecs({});
    setActiveTab("vault");
    void flushSnippetSaves()
      .catch(() => {})
      .then(() => api.vaultLock())
      .catch(() => {})
      .finally(() => window.setTimeout(onLocked, 450));
  }

  function quickConnect(q: QuickConnect) {
    const sameIdentity = (h: Host) =>
      !q.identity ||
      (q.identity === "password" || q.identity === "agent"
        ? h.auth.kind === q.identity
        : q.identity.startsWith("identity:")
          ? h.auth.kind === "identity" && h.auth.identity_id === q.identity.slice(9)
          : h.auth.kind === "key" && h.auth.secret_id === q.identity);
    const match = hosts.find((h) => h.hostname.toLowerCase() === q.hostname.toLowerCase() && h.port === q.port && (!q.username || h.username === q.username) && sameIdentity(h));
    if (match) {
      openTerminal(match);
      return;
    }
    const prefill: Partial<NewHost> = { name: q.hostname, hostname: q.hostname, port: q.port, username: q.username };
    if (q.identity === "agent") prefill.auth = { kind: "agent" };
    else if (q.identity === "password") prefill.auth = { kind: "password", secret_id: "" };
    else if (q.identity.startsWith("identity:")) prefill.auth = { kind: "identity", identity_id: q.identity.slice(9) };
    else if (q.identity) prefill.auth = { kind: "key", secret_id: q.identity };
    editHost({ host: null, prefill, connectAfterSave: true });
  }

  function deleteHost(h: Host) {
    const jumpers = hosts.filter((x) => x.jump_host_id === h.id).map((x) => x.name);
    const jumpNote = jumpers.length ? ` ${jumpers.join(", ")} ${jumpers.length === 1 ? "uses" : "use"} it as jump host and will connect directly afterwards.` : "";
    setConfirm({
      title: "Delete host",
      message: `Delete "${h.name}"? Its open tabs are closed. Keys and passwords stay in the Keychain.${jumpNote}`,
      confirmLabel: "Delete host",
      danger: true,
      onConfirm: async () => {
        await api.hostRemove(h.id);
        setSessions((ss) => {
          const out: Session[] = [];
          for (const s of ss) {
            if (!s.layout) {
              if (s.host.id !== h.id) out.push(s);
              continue;
            }
            const doomed = leaves(s.layout).filter((id) => (specsRef.current[id]?.hostId ?? s.host.id) === h.id);
            let cur: Session | null = s;
            for (const id of doomed) cur = cur && withoutPane(cur, id, null);
            if (!cur) continue;
            if (cur.host.id === h.id) {
              const first = leaves(cur.layout ?? leaf(""))[0];
              cur = { ...cur, host: hostsRef.current.find((x) => x.id === specsRef.current[first]?.hostId) ?? cur.host };
            }
            out.push(cur);
          }
          const gone = new Set(ss.filter((t) => !out.some((o) => o.tabId === t.tabId)).map((t) => t.tabId));
          setActiveTab((cur) => (gone.has(cur) ? "vault" : cur));
          return out;
        });
        setEditor(null);
        await refreshHosts();
        toast("ok", `Deleted ${h.name}.`);
      },
    });
  }

  function duplicateHost(h: Host) {
    const { id: _id, ai_changed: _ai, ...rest } = h;
    void _id;
    void _ai;
    editHost({
      host: null,
      prefill: {
        ...rest,
        name: `${h.name} copy`,
        options: { ...h.options, env: h.options.env.map((v) => ({ ...v })) },
        tags: [...h.tags],
        agent_keys: [...h.agent_keys],
        forwards: h.forwards.map((f) => ({ ...f, id: crypto.randomUUID(), autostart: false })),
      },
    });
  }

  function runInTabs(script: string, hostIds: string[]) {
    const list = hosts.filter((h) => hostIds.includes(h.id));
    gateAi(
      list.map((h) => h.id),
      () => list.forEach((h) => openTerminalNow(h, script)),
    );
  }

  function pasteToActive(script: string) {
    if (!lastTerminal || !pasteSession) {
      toast("error", "Open a terminal first.");
      return;
    }
    if (!termBus.write(lastTerminal, script)) {
      toast("error", "The terminal is not connected.");
      return;
    }
    selectTab(lastTerminal);
  }

  function onPalette(a: PaletteAction) {
    setPaletteOpen(false);
    switch (a.kind) {
      case "connect":
        openTerminal(a.host);
        break;
      case "sftp":
        openSftp(a.host);
        break;
      case "split":
        splitActive(a.host);
        break;
      case "edit":
        editHost({ host: a.host });
        break;
      case "new-host":
        editHost({ host: null });
        break;
      case "section":
        goSection(a.section);
        break;
      case "snippet":
        setSnippetFocus((f) => ({ id: a.snippet.id, seq: (f?.seq ?? 0) + 1 }));
        goSection("snippets");
        break;
      case "quick":
        quickConnect(a.target);
        break;
      case "settings":
        goSection("settings");
        break;
      case "lock":
        lock();
        break;
    }
  }

  // ---------------------------------------------------------------- shortcuts
  const stateRef = useRef({ sessions, activeTab, activeSession });
  stateRef.current = { sessions, activeTab, activeSession };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const { sessions: ss, activeTab: at, activeSession: as } = stateRef.current;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const isD = k === "d" || e.code === "KeyD";
      const splitKeys = IS_MAC ? e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && isD : isD && e.shiftKey && !e.metaKey && (e.altKey !== e.ctrlKey);
      if (splitKeys) {
        handled();
        if (as?.kind === "terminal") splitPane(as.tabId);
        return;
      }
      const dir = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" } as Record<string, Side | undefined>)[e.key];
      const navKeys = IS_MAC ? e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (dir && navKeys && as?.kind === "terminal" && as.layout && as.focus && leaves(as.layout).length > 1) {
        const t = e.target as HTMLElement | null;
        if (t === document.body || t?.closest?.("[data-pane-id]")) {
          handled();
          const next = neighbor(as.layout, as.focus, dir);
          if (next) {
            patchTab(as.tabId, (x) => ({ focus: next, zoom: x.zoom ? next : null }));
            requestAnimationFrame(() => termBus.byId(next)?.focus?.());
          }
          return;
        }
      }
      if (e.altKey) return;
      // Tab cycling is Ctrl+Tab on every platform; macOS reserves ⌘ Tab.
      if (k === "tab" && e.ctrlKey && !e.metaKey) {
        if (ss.length === 0) return;
        handled();
        const order = ["vault", ...ss.map((s) => s.tabId)];
        const i = order.indexOf(at);
        selectTab(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
        return;
      }
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      // Shells do not use Ctrl+digit or Ctrl+comma, so these work inside a terminal too.
      if (k === "," && !e.shiftKey) {
        handled();
        goSection("settings");
        return;
      }
      if (/^[1-9]$/.test(k) && !e.shiftKey) {
        const n = Number(k);
        const order = ss.map((s) => s.tabId);
        const target = n === 9 ? order[order.length - 1] : order[n - 1];
        if (target) {
          handled();
          selectTab(target);
        }
        return;
      }
      // Plain Ctrl+<letter> belongs to the shell, so app shortcuts need Shift outside macOS.
      const app = IS_MAC || e.shiftKey;
      if (!app) return;
      if (k === "k") {
        handled();
        setPaletteHosts(false);
        setPaletteOpen((o) => !o);
      } else if (k === "t") {
        handled();
        openPalette(true);
      } else if (k === "w") {
        if (at !== "vault") {
          handled();
          closeTab(at);
        }
      } else if (k === "l" && (IS_MAC || e.shiftKey)) {
        handled();
        lock();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- derived
  const statuses = useMemo(() => {
    const byHost: Record<string, PaneStage[]> = {};
    for (const s of sessions) {
      if (s.kind !== "terminal" || !s.layout) continue;
      for (const id of leaves(s.layout)) (byHost[specs[id]?.hostId ?? s.host.id] ??= []).push(stages[id] ?? "connecting");
    }
    const m: Record<string, Status> = {};
    for (const [hid, st] of Object.entries(byHost)) m[hid] = SESSION_TO_STATUS[aggregate(st)];
    return m;
  }, [sessions, specs, stages]);

  const tabStatus = (s: Session): Status => (s.kind === "terminal" && s.layout ? SESSION_TO_STATUS[aggregate(leaves(s.layout).map((id) => stages[id] ?? "connecting"))] : s.status);

  function tabMenu(id: string): ContextItem[] {
    const s = sessions.find((x) => x.tabId === id);
    if (!s) return [];
    const items: ContextItem[] = [];
    const cur = activeSession;
    const panes = s.layout ? leaves(s.layout) : [];
    if (s.kind === "terminal" && s.layout) {
      items.push({ label: "Split right", onClick: () => splitPane(id, { side: "right" }) });
      items.push({ label: "Split down", onClick: () => splitPane(id, { side: "bottom" }) });
      if (panes.length > 1) {
        items.push({ label: s.broadcast ? "Stop broadcasting" : "Broadcast input to all panes", onClick: () => patchTab(id, () => ({ broadcast: !s.broadcast })) });
        items.push({ label: "Even out pane sizes", onClick: () => patchTab(id, (x) => (x.layout ? { layout: equalize(x.layout) } : null)) });
      }
      items.push({ label: "Open SFTP", onClick: () => openSftp(tabHost(s)) });
      items.push({ label: panes.length > 1 ? "Reconnect all panes" : "Reconnect", onClick: () => panes.forEach((p) => termBus.byId(p)?.reconnect()) });
      items.push({ label: "Clear scrollback", onClick: () => s.focus && termBus.byId(s.focus)?.clear?.() });
    }
    items.push({ label: s.kind === "sftp" ? `Terminal to ${tabHost(s).name}` : `New tab to ${tabHost(s).name}`, onClick: () => openTerminal(tabHost(s), undefined, s.focus ? termBus.byId(s.focus)?.password?.() : null) });
    if (cur && cur.tabId !== id && cur.layout && s.layout && leaves(cur.layout).length + leaves(s.layout).length <= MAX_PANES) {
      items.push({ label: "Move into current tab", onClick: () => mergeTab(id, cur.tabId, null, null) });
    }
    items.push({ label: "Close tab", danger: true, onClick: () => closeTab(id) });
    if (sessions.length > 1) {
      items.push({
        label: "Close other tabs",
        danger: true,
        onClick: () => {
          const others = sessionsRef.current.filter((x) => x.tabId !== id);
          const reasons = [...new Set(others.map((x) => sftpUnsaved.current.get(x.tabId)).filter((r): r is string => !!r))];
          const closeAll = () => others.forEach((x) => dropTab(x.tabId));
          if (!reasons.length) return closeAll();
          setConfirm({ title: "Close other tabs?", message: `${reasons.join(" ")} Closing discards them.`, confirmLabel: "Close tabs", danger: true, onConfirm: closeAll });
        },
      });
    }
    return items;
  }

  const tabs: Tab[] = sessions.map((s) => {
    const ids = s.layout ? leaves(s.layout) : [];
    const names = [...new Set(ids.map((id) => hosts.find((h) => h.id === specs[id]?.hostId)?.name ?? s.host.name))];
    return { id: s.tabId, kind: s.kind, name: tabHost(s).name, status: tabStatus(s), attention: bellTabs.has(s.tabId), panes: ids.length, title: names.length > 1 ? names.join(", ") : undefined };
  });

  const paneTabs = new Map<string, Session>();
  for (const s of sessions) if (s.kind === "terminal" && s.layout) for (const id of leaves(s.layout)) paneTabs.set(id, s);
  const poolPanes: PoolPane[] = Object.keys(specs).flatMap((id) => {
    const s = paneTabs.get(id);
    if (!s) return [];
    const host = hosts.find((h) => h.id === specs[id]?.hostId) ?? s.host;
    return [{ id, tabId: s.tabId, host, focused: activeTab === s.tabId && s.focus === id, initialCommand: specs[id]?.initialCommand }];
  });

  let sectionBody: ReactNode;
  if (section === "hosts") {
    sectionBody = !loaded ? (
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }} />
    ) : hostsError && hosts.length === 0 ? (
      <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 0, padding: 24, color: "var(--text-2)" }}>
        <div style={{ color: "var(--err)" }}>Could not load your hosts.</div>
        <div style={{ fontSize: 12, maxWidth: 480, textAlign: "center", wordBreak: "break-word" }}>{hostsError}</div>
        <button type="button" onClick={() => void refreshHosts()} style={{ height: 32, padding: "0 14px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer" }}>
          Retry
        </button>
      </main>
    ) : hosts.length === 0 && !editor ? (
        <WelcomeScreen onQuickConnect={quickConnect} onNewHost={() => editHost({ host: null })} onImported={refreshAll} />
      ) : (
        <HostsScreen
          hosts={hosts}
          statuses={statuses}
          onConnect={(h) => openTerminal(h)}
          onSftp={openSftp}
          onEdit={(h) => editHost({ host: h })}
          onNew={() => editHost({ host: null })}
          onDuplicate={duplicateHost}
          onDelete={deleteHost}
          onQuickConnect={quickConnect}
          onDragHost={(e, id, label) => startDrag(e, { kind: "host", hostId: id }, label)}
          editor={editor}
          onEditorDirty={onEditorDirty}
          onEditorClose={() => setEditor(null)}
          onEditorSaved={(h, connect) => {
            setEditor(null);
            void refreshHosts();
            if (connect) openTerminal(h);
          }}
        />
      );
  }
  else if (section === "keychain")
    sectionBody = (
      <KeychainScreen
        hosts={hosts}
        onHostsChanged={() => void refreshHosts()}
        onEditHost={(h) => editHost({ host: h })}
      />
    );
  else if (section === "snippets") sectionBody = <SnippetsScreen hosts={hosts} pasteTarget={pasteSession ? { name: tabHost(pasteSession).name, connected: stages[pasteSession.focus ?? ""] === "connected" } : null} onRunInTabs={runInTabs} onPasteToActive={pasteToActive} onSnippetsChanged={refreshSnippets} onConfirmHosts={gateAi} focusRequest={snippetFocus} />;
  else if (section === "forwarding") sectionBody = <PortForwardingScreen hosts={hosts} onHostsChanged={refreshHosts} onConfirmHosts={gateAi} />;
  else if (section === "known")
    sectionBody = (
      <KnownHostsScreen
        changed={changedKeys}
        hosts={hosts}
        active={activeTab === "vault"}
        onReviewChanged={(c) => openChanged(c)}
        onDismissChanged={(c) => setChangedKeys((l) => l.filter((x) => !(x.host === c.host && x.port === c.port && x.fingerprint === c.fingerprint)))}
      />
    );
  else if (section === "ai") sectionBody = <AiScreen hosts={hosts} onHostsChanged={refreshHosts} onAiChanged={(on) => {
        setAiActive(on);
        setAiPoke((n) => n + 1);
      }} />;
  else if (section === "settings") sectionBody = <SettingsScreen onVaultImported={refreshAll} />;
  else sectionBody = <LogsScreen />;

  const box = (visible: boolean): CSSProperties => ({ position: "absolute", inset: 0, display: visible ? "flex" : "none", flexDirection: "column", minHeight: 0, minWidth: 0 });

  return (
    <Shell
      theme={theme}
      section={section}
      vaultActive={activeTab === "vault"}
      tabs={tabs}
      activeTab={activeTab}
      sidebarOpen={sidebarOpen}
      aiActive={aiActive}
      aiUntil={aiUntil}
      updateReady={!!update}
      onUpdate={() => setUpdateOpen(true)}
      onToggleSidebar={() => setSidebarOpen((o) => !o)}
      onSelectSection={goSection}
      onDragTab={(e, id, label) => startDrag(e, { kind: "tab", tabId: id }, label)}
      onReorderTab={reorderTab}
      tabMenu={tabMenu}
      onSelectTab={selectTab}
      onCloseTab={closeTab}
      onNewTab={() => openPalette(true)}
      onOpenPalette={() => openPalette(false)}
      onLock={lock}
    >
      <div ref={contentRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <div key={section} data-anim="screen" style={box(activeTab === "vault")}>{sectionBody}</div>
        {sessions
          .filter((s) => s.kind === "sftp")
          .map((s) => (
            <div key={`sftp-${s.tabId}`} data-anim="screen" style={box(activeTab === s.tabId)}>
              <SftpScreen
                hosts={hosts}
                host={s.host}
                active={activeTab === s.tabId}
                openRequest={s.openSeq}
                onStatus={(st) => {
                  const next: Status = st === "connected" ? "ok" : st === "error" ? "err" : st === "closed" ? "idle" : "warn";
                  patchTab(s.tabId, (x) => (x.status === next ? null : { status: next }));
                }}
                onUnsavedChange={(why) => {
                  if (why) sftpUnsaved.current.set(s.tabId, why);
                  else sftpUnsaved.current.delete(s.tabId);
                }}
                onOpenTerminal={(h) => openTerminal(h)}
                onConfirmHosts={gateAi}
              />
            </div>
          ))}
        {sessions
          .filter((s) => s.kind === "terminal")
          .map((s) => (
          <div key={s.tabId} style={box(activeTab === s.tabId)}>
            {s.layout && (
              <TerminalSession
                  tabId={s.tabId}
                  active={activeTab === s.tabId}
                  hosts={hosts}
                  fallbackHost={s.host}
                  layout={s.layout}
                  specs={specs}
                  focus={s.focus && hasPane(s.layout, s.focus) ? s.focus : leaves(s.layout)[0]}
                  zoom={s.zoom ?? null}
                  broadcast={!!s.broadcast}
                  onFocus={(id) => focusPaneIn(s.tabId, id)}
                  onSplit={(id, side) => {
                    splitPane(s.tabId, { target: id, side });
                  }}
                  onClosePane={closePane}
                  onRatio={(path, r) => patchTab(s.tabId, (x) => (x.layout ? { layout: setRatio(x.layout, path, r) } : null))}
                  onZoom={(id) => patchTab(s.tabId, () => ({ zoom: id }))}
                  onPopOut={popOut}
                  onEditHost={(h) => editHost({ host: hosts.find((x) => x.id === h.id) ?? h })}
                  onDragPane={(e, paneId, label) => startDrag(e, { kind: "pane", tabId: s.tabId, paneId }, label)}
                />
            )}
          </div>
        ))}
        <PanePool
          panes={poolPanes}
          onBell={(paneId) => {
            const s = sessionsRef.current.find((x) => x.layout && hasPane(x.layout, paneId));
            if (s) ringBell(s.tabId);
          }}
          onEditHost={(h) => editHost({ host: hostsRef.current.find((x) => x.id === h.id) ?? h })}
          onClosePane={closePane}
        />
      </div>

      {paletteOpen && <CommandPalette hosts={hosts} snippets={snippets} canSplit={activeSession?.kind === "terminal"} hostsOnly={paletteHosts} onAction={onPalette} onClose={() => setPaletteOpen(false)} />}
      {hostKeyReqs[0] && (
        <HostKeyDialog
          key={hostKeyReqs[0].id}
          req={hostKeyReqs[0]}
          receivedAt={hostKeyReqs[0].receivedAt}
          expired={hostKeyReqs[0].expired}
          replaced={hostKeyReqs[0].replaced}
          hostName={hostNameFor(hostKeyReqs[0].host, hostKeyReqs[0].port)}
          user={hostFor(hostKeyReqs[0].host, hostKeyReqs[0].port)?.username}
          aiChanged={aiChangedAt(hostKeyReqs[0].host, hostKeyReqs[0].port)}
          onAnswer={(accept, save) => {
            const r = hostKeyReqs[0];
            setHostKeyReqs((q) => q.filter((x) => x.id !== r.id));
            if (!r.expired) api.hostkeyRespond(r.id, accept, save).catch((e) => accept && toast("error", errText(e)));
          }}
        />
      )}
      {!hostKeyReqs[0] && changedOpen && (
        <HostKeyChangedDialog
          key={`${changedOpen.info.host}:${changedOpen.info.port}:${changedOpen.info.fingerprint}`}
          info={changedOpen.info}
          saved={changedOpen.saved}
          hostName={hostNameFor(changedOpen.info.host, changedOpen.info.port)}
          onCancel={() => setChangedOpen(null)}
          onReplace={async () => {
            const { info } = changedOpen;
            await api.knownHostsForget(info.host, info.port);
            setChangedOpen(null);
            setChangedKeys((l) => l.filter((x) => !(x.host === info.host && x.port === info.port)));
            replacedKeys.current.add(`${info.host.toLowerCase()}:${info.port}`);
            const restarted = hosts.filter((h) => h.hostname.toLowerCase() === info.host.toLowerCase() && h.port === info.port).reduce((n, h) => n + termBus.reconnectHost(h.id), 0);
            const name = hostNameFor(info.host, info.port) ?? info.host;
            toast("ok", restarted ? `Removed the old key for ${name}. Reconnecting.` : `Removed the old key for ${name}. Connect again to trust the new one.`);
          }}
        />
      )}
      {approvals[0] && (
        <ApprovalDialog
          key={approvals[0].id}
          req={approvals[0]}
          address={(() => {
            const h = hosts.find((x) => x.id === approvals[0].host_id);
            return h ? `${h.username}@${h.hostname}:${h.port}` : undefined;
          })()}
          receivedAt={approvals[0].receivedAt}
          expired={approvals[0].expired}
          onAnswer={(approved) => {
            const r = approvals[0];
            setApprovals((q) => q.filter((x) => x.id !== r.id));
            if (!r.expired) api.approvalRespond(r.id, approved).catch((e) => approved && toast("error", `Could not send your answer: ${errText(e)}`));
          }}
        />
      )}
      {aiStopped && <AiStoppedDialog info={aiStopped} onClose={() => setAiStopped(null)} />}
      {updateOpen && update && <UpdateDialog version={update.version} notes={update.notes} onClose={() => setUpdateOpen(false)} />}
      {confirm && (
        <ConfirmDialog
          key={confirm.title + confirm.message}
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          guarded={confirm.guarded}
          width={confirm.width}
          onClose={() => setConfirm(null)}
          onConfirm={() => confirm.onConfirm()}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      {locking && (
        <div role="status" style={{ position: "fixed", inset: 0, zIndex: 100001, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, background: "var(--bg)", color: "var(--text)" }}>
          <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 56, height: 56, borderRadius: 14, background: "var(--bg)", boxShadow: "var(--shadow)" }}>
            <LockIcon size={24} />
          </span>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>Locking…</span>
        </div>
      )}
    </Shell>
  );
}
