import {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Channel } from "@tauri-apps/api/core";
import * as api from "../../api";
import type { Host, Snippet } from "../../api";
import { usePrefs } from "../../lib/prefs";
import { IS_MAC, KEYS, MONO, errText, termFontStack } from "../mock";
import { ChevronIcon, DotsIcon, PlayIcon, PlusIcon, SnippetIcon, TrashIcon } from "../icons";
import { CommandPreview, ConfirmDialog, Overlay, VisibleLine, useModalLayer } from "../overlays/Dialogs";
import { Stable } from "../Stable";
import {
  Block,
  Blocks,
  DetailHead,
  EditFooter,
  EmptyState,
  Facts,
  List,
  ListFilter,
  ListItem,
  ScreenHeader,
  SplitView,
  arrowNav,
  chip as hostChip,
  errLine,
  mono,
  muted as quiet,
  oneLine,
  pageBtn,
  primaryBtn,
  sectionLabel,
  smallBtn,
  srOnly,
  type Fact,
} from "../kit";

const LiveTerminalOutput = lazy(() =>
  import("../../TerminalOutput").then((m) => ({ default: m.LiveTerminalOutput })),
);

const fieldLabel: CSSProperties = { display: "block", marginBottom: 6, fontSize: 12, fontWeight: 500, color: "var(--text-2)" };
const field: CSSProperties = { width: "100%", height: 32, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text)", boxSizing: "border-box" };
const h3: CSSProperties = { margin: "0 0 6px", fontSize: 12, fontWeight: 500, color: "var(--text-2)" };
const btnDanger: CSSProperties = { ...pageBtn, border: "1px solid var(--err)", background: "transparent", color: "var(--err)" };
const muted: CSSProperties = { fontSize: 12, color: "var(--text-2)" };
const chip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, height: 24, padding: "0 4px 0 10px", borderRadius: 12, background: "var(--bg-raised)", fontSize: 12, boxSizing: "border-box" };

function off(style: CSSProperties, disabled: boolean): CSSProperties {
  return disabled ? { ...style, opacity: 0.5, cursor: "default" } : style;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Variables: {name} placeholders, found the way a shell reads the text. Text in
// single quotes and comments is literal (awk '{print}', jq '{name}'), ${name}
// stays shell syntax and \{name} is an escaped literal that runs as {name}.

interface VarHit {
  start: number;
  end: number;
  name: string;
  escaped: boolean;
}

const NAME_AT = /\{([A-Za-z_][A-Za-z0-9_]*)\}/y;

function nameAt(script: string, i: number): RegExpExecArray | null {
  NAME_AT.lastIndex = i;
  return NAME_AT.exec(script);
}

function scanVars(script: string): VarHit[] {
  const hits: VarHit[] = [];
  let single = false;
  let double = false;
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (single) {
      if (c === "'") single = false;
      continue;
    }
    if (c === "\\") {
      const m = nameAt(script, i + 1);
      if (m) {
        hits.push({ start: i, end: i + 1 + m[0].length, name: m[1], escaped: true });
        i += m[0].length;
      } else i++;
      continue;
    }
    if (c === '"') {
      double = !double;
      continue;
    }
    if (!double && c === "'") {
      single = true;
      continue;
    }
    if (!double && c === "#" && (i === 0 || /[\s;&|()]/.test(script[i - 1]))) {
      const nl = script.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    const dollar = c === "$" && script[i + 1] === "{";
    if (c !== "{" && !dollar) continue;
    const m = nameAt(script, dollar ? i + 1 : i);
    if (!m) continue;
    if (dollar) {
      i += m[0].length;
    } else {
      hits.push({ start: i, end: i + m[0].length, name: m[1], escaped: false });
      i += m[0].length - 1;
    }
  }
  return hits;
}

function parseVars(script: string): string[] {
  const out: string[] = [];
  for (const h of scanVars(script)) if (!h.escaped && !out.includes(h.name)) out.push(h.name);
  return out;
}

function applyVars(script: string, values: Record<string, string>): string {
  let out = "";
  let last = 0;
  for (const h of scanVars(script)) {
    out += script.slice(last, h.start);
    if (h.escaped) out += script.slice(h.start + 1, h.end);
    else out += h.name in values ? values[h.name] : script.slice(h.start, h.end);
    last = h.end;
  }
  return out + script.slice(last);
}

function highlight(script: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const h of scanVars(script)) {
    if (h.escaped) continue;
    if (h.start > last) parts.push(script.slice(last, h.start));
    parts.push(<span key={h.start} style={{ color: "var(--text)", background: "var(--accent-tint)", borderRadius: 3 }}>{script.slice(h.start, h.end)}</span>);
    last = h.end;
  }
  parts.push(script.slice(last));
  return parts;
}

// ---------------------------------------------------------------------------

interface VarSetting {
  value: string;
  ask: boolean;
}
interface SnippetPrefs {
  vars: Record<string, VarSetting>;
  parallel: boolean;
  tabs: boolean;
}

const DEFAULT_PREFS: SnippetPrefs = { vars: {}, parallel: true, tabs: false };

type RunMode = "serial" | "parallel" | "tabs";
const RUN_MODES: { id: RunMode; label: string }[] = [
  { id: "serial", label: "One after another" },
  { id: "parallel", label: "All at once" },
  { id: "tabs", label: "In tabs" },
];
const RUN_LABELS = ["Run", "Run in tabs"];

const legacyKey = (id: string) => `kestral.snippet.${id}`;

function legacyPrefs(id: string): SnippetPrefs | null {
  try {
    const raw = localStorage.getItem(legacyKey(id));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<SnippetPrefs>;
    return { vars: p.vars && typeof p.vars === "object" ? p.vars : {}, parallel: p.parallel !== false, tabs: p.tabs === true };
  } catch {
    return null;
  }
}

function dropLegacy(id: string) {
  try {
    localStorage.removeItem(legacyKey(id));
  } catch {
    return;
  }
}

function prefsOf(s: Snippet): SnippetPrefs {
  return { vars: s.vars ?? {}, parallel: s.parallel !== false, tabs: s.open_tabs === true };
}

function untouched(s: Snippet): boolean {
  return Object.keys(s.vars ?? {}).length === 0 && s.parallel !== false && s.open_tabs !== true;
}

// ---------------------------------------------------------------------------
// Run history. Module level so runs keep streaming and stay visible while the
// user navigates away from the screen and back.

type HostRunStatus = "queued" | "running" | "done" | "error" | "cancelled";
interface HostRun {
  hostId: string;
  hostName: string;
  output: string;
  status: HostRunStatus;
  exit: number | null;
  signal: string | null;
  error: string;
}
interface ScriptRun {
  runId: string;
  snippetId: string;
  startedAt: number;
  parallel: boolean;
  cancelled: boolean;
  results: HostRun[];
}

const MAX_OUTPUT = 4 * 1024 * 1024;
let runStore: ScriptRun[] = [];
const runListeners = new Set<() => void>();

function setRuns(fn: (cur: ScriptRun[]) => ScriptRun[]) {
  runStore = fn(runStore);
  runListeners.forEach((l) => l());
}
function subscribeRuns(l: () => void) {
  runListeners.add(l);
  return () => {
    runListeners.delete(l);
  };
}
const getRuns = () => runStore;

export function clearSnippetRuns() {
  for (const r of runStore) if (r.results.some((x) => isLive(x.status))) stopRun(r.runId);
  pendingOutput.clear();
  setRuns(() => []);
}

let flushMounted: (() => Promise<void>) | null = null;
let lastSave: Promise<void> = Promise.resolve();

export function flushSnippetSaves(): Promise<void> {
  return flushMounted ? flushMounted() : lastSave;
}

function patchHost(runId: string, hostId: string, fn: (r: HostRun) => HostRun) {
  setRuns((cur) =>
    cur.map((run) =>
      run.runId !== runId ? run : { ...run, results: run.results.map((x) => (x.hostId === hostId ? fn(x) : x)) },
    ),
  );
}

// Output chunks are batched so a chatty command does not re-render per packet.
const pendingOutput = new Map<string, string>();
let flushTimer: number | null = null;

function capOutput(prev: string, add: string): string {
  if (prev.length >= MAX_OUTPUT) return prev;
  const next = prev + add;
  return next.length > MAX_OUTPUT ? next.slice(0, MAX_OUTPUT) + "\r\n[output truncated]\r\n" : next;
}

function flushOutput() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingOutput.size === 0) return;
  const batch = new Map(pendingOutput);
  pendingOutput.clear();
  setRuns((cur) =>
    cur.map((run) => {
      let changed = false;
      const results = run.results.map((x) => {
        const add = batch.get(`${run.runId}|${x.hostId}`);
        if (!add) return x;
        changed = true;
        return { ...x, output: capOutput(x.output, add) };
      });
      return changed ? { ...run, results } : run;
    }),
  );
}

function appendOutput(runId: string, hostId: string, chunk: string) {
  const key = `${runId}|${hostId}`;
  pendingOutput.set(key, (pendingOutput.get(key) ?? "") + chunk);
  if (flushTimer === null) flushTimer = window.setTimeout(flushOutput, 50);
}

async function startRun(snippetId: string, script: string, targets: Host[], parallel: boolean) {
  const runId = crypto.randomUUID();
  setRuns((cur) => [
    {
      runId,
      snippetId,
      startedAt: Date.now(),
      parallel,
      cancelled: false,
      results: targets.map((h) => ({
        hostId: h.id,
        hostName: h.name,
        output: "",
        status: parallel ? "running" : "queued",
        exit: null,
        signal: null,
        error: "",
      })),
    },
    ...cur,
  ]);

  const runOne = async (h: Host) => {
    patchHost(runId, h.id, (x) => ({ ...x, status: "running" }));
    const decoder = new TextDecoder();
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => appendOutput(runId, h.id, decoder.decode(new Uint8Array(buf), { stream: true }));
    try {
      const exit = await api.runCommandStream(h.id, script, channel, `${runId}:${h.id}`);
      flushOutput();
      patchHost(runId, h.id, (x) => ({
        ...x,
        status: exit.exit_signal ? "error" : "done",
        exit: exit.exit_status,
        signal: exit.exit_signal,
      }));
    } catch (e) {
      flushOutput();
      patchHost(runId, h.id, (x) => ({ ...x, status: "error", error: errText(e) }));
    }
  };

  if (parallel) {
    await Promise.all(targets.map(runOne));
    return;
  }
  for (const h of targets) {
    const run = runStore.find((r) => r.runId === runId);
    if (!run || run.cancelled) break;
    await runOne(h);
  }
}

function stopRun(runId: string) {
  const run = runStore.find((r) => r.runId === runId);
  cancelQueued(runId);
  for (const x of run?.results ?? []) if (x.status === "running") void api.runCommandCancel(`${runId}:${x.hostId}`).catch(() => {});
}

function cancelQueued(runId: string) {
  setRuns((cur) =>
    cur.map((r) =>
      r.runId !== runId
        ? r
        : { ...r, cancelled: true, results: r.results.map((x) => (x.status === "queued" ? { ...x, status: "cancelled" } : x)) },
    ),
  );
}

function clearRun(runId: string) {
  setRuns((cur) => cur.filter((r) => r.runId !== runId));
}

const isLive = (s: HostRunStatus) => s === "running" || s === "queued";


type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
interface SaveStatus {
  state: SaveState;
  id: string | null;
  error: string;
}
const NO_SAVE: SaveStatus = { state: "idle", id: null, error: "" };

type FolderDialogState = { mode: "create" } | { mode: "rename"; from: string };

const sameFolder = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// A run of the same snippet started within this window is a double trigger.
const RUN_DEBOUNCE_MS = 600;

const normalize = (s: Snippet): Snippet => ({ ...s, folder: s.folder ?? "" });

type RunPlan = { targets: Host[]; tabs: boolean; parallel: boolean };
type Review = { mode: "run" | "paste"; s: Snippet; script: string; values: Record<string, string>; plan: RunPlan; changed: boolean; seq: number };

function varDefaults(s: Snippet): Record<string, string> {
  const p = prefsOf(s);
  return Object.fromEntries(parseVars(s.script).map((v) => [v, p.vars[v]?.value ?? ""]));
}

// True when nothing (an app overlay, a dialog) covers the middle of el.
function isOnTop(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!hit && el.contains(hit);
}

// ---------------------------------------------------------------------------

export function SnippetsScreen({
  hosts,
  hasActiveTerminal,
  pasteTarget,
  onRunInTabs,
  onPasteToActive,
  onSnippetsChanged,
  onConfirmHosts,
  focusRequest,
}: {
  hosts: Host[];
  hasActiveTerminal?: boolean;
  pasteTarget?: { name: string; connected: boolean } | null;
  onRunInTabs(script: string, hostIds: string[]): void;
  onPasteToActive(script: string): void;
  onSnippetsChanged?(): void;
  onConfirmHosts?(hostIds: string[], then: () => void): void;
  focusRequest?: { id: string; seq: number };
}) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [actionErr, setActionErr] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [folderToDelete, setFolderToDelete] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(NO_SAVE);
  const [creating, setCreating] = useState(false);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [varPrompt, setVarPrompt] = useState<null | { snippetId: string; mode: "run" | "paste"; names: string[]; values: Record<string, string> }>(null);
  const [confirmDelete, setConfirmDelete] = useState<Snippet | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const runs = useSyncExternalStore(subscribeRuns, getRuns);

  const rootRef = useRef<HTMLElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const nameRef = useRef<HTMLInputElement | null>(null);
  const editBtnRef = useRef<HTMLButtonElement | null>(null);
  const focusName = useRef<"select" | "focus" | null>(null);
  const focusEditBtn = useRef(false);
  const alive = useRef(true);
  const snippetsRef = useRef<Snippet[]>([]);
  const dirty = useRef<Set<string>>(new Set());
  const saveTimer = useRef<number | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const lastRun = useRef<Record<string, number>>({});
  const changedRef = useRef(onSnippetsChanged);
  changedRef.current = onSnippetsChanged;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  const commitSnippets = (next: Snippet[]) => {
    snippetsRef.current = next;
    setSnippets(next);
  };

  // Writes every dirty snippet. Saves and reloads share one chain so an older
  // snapshot can never land after a newer one.
  const flush = useCallback(() => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    saveChain.current = saveChain.current.then(async () => {
      const ids = [...dirty.current];
      dirty.current.clear();
      if (ids.length === 0) return;
      if (alive.current) setSaveStatus((s) => ({ ...s, state: "saving" }));
      const known = new Set(hostsRef.current.map((h) => h.id));
      let failed: { id: string; error: string } | null = null;
      let savedAny = false;
      for (const id of ids) {
        const s = snippetsRef.current.find((x) => x.id === id);
        if (!s) continue;
        // Never write back a host that was deleted while this copy was open.
        const out = known.size > 0 ? { ...s, target_host_ids: s.target_host_ids.filter((t) => known.has(t)) } : s;
        try {
          await api.snippetUpdate(out);
          savedAny = true;
        } catch (e) {
          dirty.current.add(id);
          failed ??= { id, error: errText(e) };
        }
      }
      if (alive.current) {
        if (failed) setSaveStatus({ state: "error", id: failed.id, error: failed.error });
        else setSaveStatus((s) => (dirty.current.size > 0 ? { ...s, state: "pending" } : { ...s, state: "saved", error: "" }));
      }
      if (savedAny) changedRef.current?.();
    });
    lastSave = saveChain.current;
    return saveChain.current;
  }, []);

  // Fetches the stored snippets, keeping local copies that still wait to be saved.
  const reload = useCallback(() => {
    saveChain.current = saveChain.current.then(async () => {
      try {
        const [list, names] = await Promise.all([api.snippetList().then((l) => l.map(normalize)), api.snippetFolderList().catch(() => null)]);
        if (!alive.current) return;
        if (names) setFolders(names);
        const local = new Map(snippetsRef.current.map((s) => [s.id, s]));
        const stored = new Set(list.map((s) => s.id));
        for (const id of [...dirty.current]) if (!stored.has(id)) dirty.current.delete(id);
        const merged = list.map((s) => (dirty.current.has(s.id) ? local.get(s.id) ?? s : s));
        if (JSON.stringify(merged) !== JSON.stringify(snippetsRef.current)) commitSnippets(merged);
        setLoadErr("");
      } catch (e) {
        if (alive.current && snippetsRef.current.length === 0) setLoadErr(errText(e));
      }
      if (alive.current) setLoaded(true);
    });
    return saveChain.current;
  }, []);

  useEffect(() => {
    alive.current = true;
    flushMounted = flush;
    void reload();
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      alive.current = false;
      if (flushMounted === flush) flushMounted = null;
      void flush();
    };
  }, [reload, flush]);

  // Deleting a host strips it from every snippet in the vault; pick that up.
  const firstHosts = useRef(true);
  useEffect(() => {
    if (firstHosts.current) {
      firstHosts.current = false;
      return;
    }
    void reload();
  }, [hosts, reload]);

  async function retryLoad() {
    setRetrying(true);
    await reload();
    if (alive.current) setRetrying(false);
  }

  const selected = snippets.find((s) => s.id === selId) ?? null;
  const editing = !!selected && editId === selected.id;
  const fresh = editing && freshId === selected.id;

  const allFolders = useMemo(() => {
    const out = [...folders];
    snippets.forEach((s) => {
      if (s.folder && !out.some((f) => sameFolder(f, s.folder))) out.push(s.folder);
    });
    return out;
  }, [snippets, folders]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (s: Snippet) =>
      !q || s.label.toLowerCase().includes(q) || s.script.toLowerCase().includes(q) || s.folder.toLowerCase().includes(q);
    const list: { name: string; items: Snippet[] }[] = [{ name: "", items: snippets.filter((s) => !s.folder && match(s)) }];
    for (const f of allFolders) list.push({ name: f, items: snippets.filter((s) => !!s.folder && sameFolder(s.folder, f) && match(s)) });
    return list.filter((g) => g.items.length > 0 || (g.name !== "" && !q));
  }, [snippets, allFolders, filter]);

  const visibleItems = groups.flatMap((g) => g.items);
  const visibleOrder = visibleItems.map((s) => s.id);
  const firstVisible = visibleOrder[0] ?? null;

  useEffect(() => {
    if (!loaded) return;
    if (selId === null || !snippets.some((s) => s.id === selId)) setSelId(firstVisible ?? snippets[0]?.id ?? null);
  }, [loaded, snippets, selId, firstVisible]);


  const shownId = selected?.id ?? null;
  useEffect(() => {
    if (focusName.current && editing) {
      const how = focusName.current;
      focusName.current = null;
      nameRef.current?.focus();
      if (how === "select") nameRef.current?.select();
    }
    if (focusEditBtn.current && !editing) {
      focusEditBtn.current = false;
      editBtnRef.current?.focus();
    }
  }, [shownId, editing]);

  const prefsFor = (id: string) => {
    const sn = snippets.find((x) => x.id === id);
    return sn ? prefsOf(sn) : DEFAULT_PREFS;
  };
  const prefs = selected ? prefsOf(selected) : DEFAULT_PREFS;

  function patchSnippets(ids: string[], fn: (s: Snippet) => Snippet) {
    if (ids.length === 0) return;
    const set = new Set(ids);
    commitSnippets(snippetsRef.current.map((s) => (set.has(s.id) ? fn(s) : s)));
    ids.forEach((id) => dirty.current.add(id));
    setSaveStatus({ state: "pending", id: selId && set.has(selId) ? selId : ids[ids.length - 1], error: "" });
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), 600);
  }

  function edit(patch: Partial<Snippet>) {
    if (selected) patchSnippets([selected.id], (s) => ({ ...s, ...patch }));
  }

  function moveToFolder(folder: string) {
    if (!selected || folder === selected.folder) return;
    edit({ folder });
  }

  function updatePrefs(next: SnippetPrefs) {
    edit({ vars: next.vars, parallel: next.parallel, open_tabs: next.tabs });
  }

  const migrated = useRef(false);
  useEffect(() => {
    if (!loaded || migrated.current) return;
    migrated.current = true;
    const moved: string[] = [];
    for (const sn of snippetsRef.current) {
      const old = legacyPrefs(sn.id);
      if (!old) continue;
      if (!untouched(sn)) {
        dropLegacy(sn.id);
        continue;
      }
      moved.push(sn.id);
      commitSnippets(snippetsRef.current.map((x) => (x.id === sn.id ? { ...x, vars: old.vars, parallel: old.parallel, open_tabs: old.tabs } : x)));
      dirty.current.add(sn.id);
    }
    if (moved.length === 0) return;
    void flush().then(() => moved.forEach((id) => !dirty.current.has(id) && dropLegacy(id)));
  }, [loaded, flush]);

  function select(id: string) {
    if (id === selId) return;
    void flush();
    setSelId(id);
    setEditId(null);
    setFreshId(null);
    setSaveStatus((s) => (s.state === "saved" ? NO_SAVE : s));
  }

  function startEdit() {
    if (!selected) return;
    focusName.current = "focus";
    setEditId(selected.id);
  }

  function finishEdit() {
    void flush();
    focusEditBtn.current = true;
    setEditId(null);
    setFreshId(null);
  }

  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    if (!focusRequest || !loaded) return;
    if (snippets.some((s) => s.id === focusRequest.id)) {
      setFilter("");
      selectRef.current(focusRequest.id);
      setEditId(null);
      setFreshId(null);
    }
  }, [focusRequest, loaded]);

  async function newSnippet() {
    setCreating(true);
    setActionErr("");
    try {
      await flush();
      const created = await api.snippetAdd({ label: "New snippet", script: "", target_host_ids: [], folder: "", vars: {}, parallel: true, open_tabs: false });
      changedRef.current?.();
      if (!alive.current) return;
      commitSnippets([...snippetsRef.current, normalize(created)]);
      setLoadErr("");
      setFilter("");
      focusName.current = "select";
      setSelId(created.id);
      setEditId(created.id);
      setFreshId(created.id);
      setSaveStatus((s) => (s.state === "saved" ? NO_SAVE : s));
    } catch (e) {
      if (alive.current) setActionErr(errText(e));
    } finally {
      if (alive.current) setCreating(false);
    }
  }

  async function duplicateSnippet(src: Snippet) {
    setActionErr("");
    try {
      await flush();
      const created = await api.snippetAdd({ label: `${src.label.trim() || "Untitled"} copy`, script: src.script, target_host_ids: src.target_host_ids, folder: src.folder, vars: src.vars, parallel: src.parallel, open_tabs: src.open_tabs });
      changedRef.current?.();
      if (!alive.current) return;
      commitSnippets([...snippetsRef.current, normalize(created)]);
      setSelId(created.id);
    } catch (e) {
      if (alive.current) setActionErr(errText(e));
    }
  }

  async function deleteSnippet(target: Snippet) {
    const id = target.id;
    for (const r of runStore) if (r.snippetId === id && r.results.some((x) => isLive(x.status))) stopRun(r.runId);
    await api.snippetDelete(id);
    dirty.current.delete(id);
    dropLegacy(id);
    setRuns((cur) => cur.filter((r) => r.snippetId !== id));
    changedRef.current?.();
    if (!alive.current) return;
    const idx = visibleOrder.indexOf(id);
    const nextId = visibleOrder[idx + 1] ?? visibleOrder[idx - 1] ?? null;
    commitSnippets(snippetsRef.current.filter((s) => s.id !== id));
    if (selId === id) setSelId(nextId);
    setEditId((cur) => (cur === id ? null : cur));
    setFreshId((cur) => (cur === id ? null : cur));
    setSaveStatus((s) => (s.id === id ? NO_SAVE : s));
  }

  async function discardNew(target: Snippet) {
    if (discarding) return;
    setDiscarding(true);
    setActionErr("");
    dirty.current.delete(target.id);
    try {
      await saveChain.current;
      await deleteSnippet(target);
    } catch (e) {
      if (alive.current) setActionErr(errText(e));
    } finally {
      if (alive.current) setDiscarding(false);
    }
  }

  async function refreshFolders() {
    try {
      const names = await api.snippetFolderList();
      if (alive.current) setFolders(names);
    } catch {
      return;
    }
  }

  async function createFolder(name: string) {
    const created = await api.snippetFolderAdd(name);
    await refreshFolders();
    moveToFolder(created);
  }

  async function renameFolder(from: string, to: string) {
    await flush();
    const done = await api.snippetFolderRename(from, to);
    commitSnippets(snippetsRef.current.map((x) => (x.folder && sameFolder(x.folder, from) ? { ...x, folder: done } : x)));
    await refreshFolders();
    changedRef.current?.();
  }

  async function removeFolder(name: string) {
    await flush();
    await api.snippetFolderRemove(name);
    commitSnippets(snippetsRef.current.map((x) => (x.folder && sameFolder(x.folder, name) ? { ...x, folder: "" } : x)));
    await refreshFolders();
    changedRef.current?.();
  }

  const hostById = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts]);
  const pasteTo = pasteTarget !== undefined ? pasteTarget : hasActiveTerminal ? { name: "", connected: true } : null;

  function blockFor(s: Snippet) {
    const targets = s.target_host_ids.map((id) => hostById.get(id)).filter((h): h is Host => !!h);
    const empty = s.script.trim() === "";
    const tabs = targets.length > 1 && s.open_tabs === true;
    return {
      targets,
      tabs,
      runBlocked: empty ? "Write a command first" : targets.length === 0 ? "Add a host to run on" : "",
      pasteBlocked: !pasteTo
        ? "Open a terminal tab first"
        : !pasteTo.connected
          ? `${pasteTo.name || "The active terminal"} is not connected`
          : empty
            ? "Write a command first"
            : "",
      runLabel: tabs ? "Run in tabs" : "Run",
      runTitle: tabs ? `Run in ${targets.length} tabs` : targets.length === 1 ? `Run on ${targets[0].name}` : `Run on ${targets.length} hosts`,
    };
  }

  function planFor(s: Snippet) {
    return { ...blockFor(s), p: prefsFor(s.id), vars: parseVars(s.script) };
  }

  const plan = selected ? planFor(selected) : null;
  const runMode: RunMode = prefs.tabs ? "tabs" : prefs.parallel ? "parallel" : "serial";
  const subLine = selected && plan ? `${selected.folder || "No folder"} · ${plan.targets.length > 0 ? plural(plan.targets.length, "host") : "no hosts"}${selected.ai_edited ? " · changed by AI" : ""}` : "";
  const snippetRuns = runs.filter((r) => r.snippetId === selId);
  const busyIds = new Set(runs.filter((r) => r.results.some((x) => isLive(x.status))).map((r) => r.snippetId));
  const liveRuns = snippetRuns.filter((r) => r.results.some((x) => isLive(x.status)));
  const selBusy = liveRuns.length > 0;
  const busyRef = useRef(selBusy);
  busyRef.current = selBusy;

  function stopRuns() {
    if (selId && Date.now() - (lastRun.current[selId] ?? 0) < RUN_DEBOUNCE_MS) return;
    for (const r of liveRuns) stopRun(r.runId);
  }
  const promptSnippet = varPrompt ? snippets.find((s) => s.id === varPrompt.snippetId) ?? null : null;
  useEffect(() => {
    if (confirmDelete && loaded && !snippets.some((x) => x.id === confirmDelete.id)) setConfirmDelete(null);
  }, [confirmDelete, loaded, snippets]);

  const [review, setReview] = useState<Review | null>(null);
  const [reviewSeen, setReviewSeen] = useState(false);
  const reviewSeq = useRef(0);
  const modalOpen = folderDialog !== null || promptSnippet !== null || confirmDelete !== null || folderToDelete !== null || review !== null;

  function runPlan(s: Snippet): RunPlan {
    const { targets, tabs } = blockFor(s);
    return { targets, tabs, parallel: prefsOf(s).parallel };
  }

  function execute(mode: "run" | "paste", s: Snippet, script: string, values: Record<string, string>) {
    if ((snippetsRef.current.find((x) => x.id === s.id) ?? s).ai_edited) {
      setReview({ mode, s, script, values, plan: runPlan(s), changed: false, seq: ++reviewSeq.current });
      return;
    }
    executeNow(mode, s, script, runPlan(s));
  }

  function executeNow(mode: "run" | "paste", s: Snippet, script: string, plan: RunPlan) {
    if (mode === "paste") {
      onPasteToActive(script);
      return;
    }
    const now = Date.now();
    if (now - (lastRun.current[s.id] ?? 0) < RUN_DEBOUNCE_MS) return;
    lastRun.current[s.id] = now;
    setEditId((cur) => (cur === s.id ? null : cur));
    setFreshId((cur) => (cur === s.id ? null : cur));
    const ids = plan.targets.map((h) => h.id);
    if (plan.tabs) onRunInTabs(script, ids);
    else if (onConfirmHosts) onConfirmHosts(ids, () => void startRun(s.id, script, plan.targets, plan.parallel));
    else void startRun(s.id, script, plan.targets, plan.parallel);
  }

  async function confirmReview(r: Review): Promise<boolean> {
    await flush();
    const ok = await api.snippetMarkReviewed(r.s.id, r.s.script, r.s.target_host_ids);
    if (!ok) {
      await reload();
      const fresh = snippetsRef.current.find((x) => x.id === r.s.id);
      if (!fresh) throw new Error("This snippet was deleted.");
      const values = { ...varDefaults(fresh), ...r.values };
      setReview({ ...r, s: fresh, script: applyVars(fresh.script, values), values, plan: runPlan(fresh), changed: true, seq: ++reviewSeq.current });
      return false;
    }
    commitSnippets(snippetsRef.current.map((x) => (x.id === r.s.id ? { ...x, ai_edited: false } : x)));
    executeNow(r.mode, r.s, r.script, r.plan);
    return true;
  }

  function begin(mode: "run" | "paste", s: Snippet | null = selected) {
    if (!s) return;
    const { p, vars, runBlocked, pasteBlocked } = planFor(s);
    if (mode === "run" ? runBlocked : pasteBlocked) return;
    const need = vars.filter((v) => {
      const set = p.vars[v];
      return !set || set.ask || set.value === "";
    });
    if (need.length > 0) {
      setVarPrompt({ snippetId: s.id, mode, names: need, values: Object.fromEntries(need.map((v) => [v, p.vars[v]?.value ?? ""])) });
      return;
    }
    const values = Object.fromEntries(vars.map((v) => [v, p.vars[v]?.value ?? ""]));
    execute(mode, s, applyVars(s.script, values), values);
  }

  const beginRef = useRef(begin);
  beginRef.current = begin;
  const modalRef = useRef(modalOpen);
  modalRef.current = modalOpen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.altKey || !(IS_MAC ? e.metaKey : e.ctrlKey)) return;
      if (e.repeat || e.defaultPrevented || e.isComposing || modalRef.current) return;
      const root = rootRef.current;
      if (!root || root.getClientRects().length === 0) return;
      const t = e.target instanceof Node ? e.target : null;
      const onPage = !t || t === document.body || t === document.documentElement;
      if (!onPage && !root.contains(t)) return;
      if (!isOnTop(root)) return;
      e.preventDefault();
      if (busyRef.current) return;
      beginRef.current("run");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const labelOf = (id: string | null) => {
    const s = snippets.find((x) => x.id === id);
    return s ? s.label.trim() || "Untitled" : "";
  };

  const failed = loaded && snippets.length === 0 && loadErr !== "";
  const emptyVault = loaded && snippets.length === 0 && allFolders.length === 0;
  const fullState = failed || emptyVault;
  const focusRow = (id: string) => rowRefs.current.get(id)?.focus();
  const newButton = (style: CSSProperties) => (
    <button type="button" onClick={newSnippet} disabled={creating} style={off(style, creating)}>
      <PlusIcon size={14} sw={1.75} />
      <Stable text={creating ? "Creating…" : "New snippet"} alts={["New snippet", "Creating…"]} />
    </button>
  );

  return (
    <main ref={rootRef} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Snippets" meta={!loaded ? (loadErr ? "" : "Loading…") : plural(snippets.length, "snippet")}>
        <span role="alert" title={actionErr || undefined} style={{ ...oneLine, flex: "0 1 auto", maxWidth: 360, fontSize: 12, color: "var(--err)" }}>
          {actionErr}
        </span>
        {loaded && !fullState && newButton(primaryBtn)}
      </ScreenHeader>

      {fullState ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", borderTop: "1px solid var(--line)" }}>
          {failed ? (
            <EmptyState>
              <p role="alert" style={errLine}>Could not load snippets: {loadErr}</p>
              <button type="button" onClick={() => void retryLoad()} disabled={retrying} style={off(smallBtn, retrying)}>
                <Stable text={retrying ? "Retrying…" : "Try again"} alts={["Try again", "Retrying…"]} />
              </button>
            </EmptyState>
          ) : (
            <EmptyState icon={<SnippetIcon size={20} />}>
              <span style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span>No snippets yet</span>
                <span style={{ fontSize: 12, color: "var(--text-3)" }}>Save commands you run often, then run them on one host or many.</span>
              </span>
              {newButton(primaryBtn)}
            </EmptyState>
          )}
        </div>
      ) : (
        <SplitView
          detailLabel="Snippet details"
          list={
            <>
              <ListFilter value={filter} onChange={setFilter} placeholder="Filter snippets" />
              {loaded && snippets.length > 0 && filter.trim() !== "" && visibleOrder.length === 0 && (
                <p style={{ margin: 8, ...muted }}>No snippets match “{filter.trim()}”.</p>
              )}
              {groups.map((g) => (
                <div key={g.name || "\u0000"} style={{ display: "flex", flexDirection: "column" }}>
                  {g.name && (
                    <FolderHeader
                      name={g.name}
                      onRename={() => setFolderDialog({ mode: "rename", from: g.name })}
                      onRemove={() => setFolderToDelete(g.name)}
                    />
                  )}
                  {g.items.length === 0 ? (
                    <p style={{ margin: "2px 8px", fontSize: 12, color: "var(--text-3)" }}>Empty folder</p>
                  ) : (
                    <List label={g.name || "Snippets"}>
                      {g.items.map((s) => {
                        const name = s.label.trim();
                        const busy = busyIds.has(s.id);
                        return (
                          <ListItem
                            key={s.id}
                            icon={
                              <span data-anim={busy ? "pulse" : undefined} style={{ display: "flex" }}>
                                <SnippetIcon />
                              </span>
                            }
                            iconColor={busy ? "var(--warn)" : undefined}
                            title={
                              <>
                                {name || <span style={{ color: "var(--text-3)" }}>Untitled</span>}
                                {s.ai_edited && <span title="Changed by AI, review it before it runs" style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: "var(--warn)" }}>AI</span>}
                                {busy && <span style={srOnly}>, running</span>}
                              </>
                            }
                            sub={<span style={{ fontFamily: MONO, fontSize: 11.5 }}>{s.script.split("\n").find((l) => l.trim()) ?? " "}</span>}
                            selected={s.id === selId}
                            onSelect={() => select(s.id)}
                            onKeyDown={(e) => arrowNav(visibleItems, visibleOrder.indexOf(s.id), e, select, focusRow)}
                            buttonRef={(el) => {
                              if (el) rowRefs.current.set(s.id, el);
                              else rowRefs.current.delete(s.id);
                            }}
                          />
                        );
                      })}
                    </List>
                  )}
                </div>
              ))}
            </>
          }
        >
          {!selected || !plan ? (
            loaded && snippets.length === 0 && <p style={{ margin: 0, color: "var(--text-2)" }}>No snippets yet. Save commands you run often, then run them on one host or many.</p>
          ) : (
            <div key={editing ? "edit" : "view"} data-anim="tab" style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
              <DetailHead
                title={<span style={{ color: selected.label.trim() ? undefined : "var(--text-3)" }}>{selected.label.trim() || "Untitled"}</span>}
                sub={<span title={subLine} style={oneLine}>{subLine}</span>}
                actions={
                  editing ? undefined : (
                    <>
                      <RunButton
                        stop={selBusy}
                        label={plan.runLabel}
                        disabled={!selBusy && !!plan.runBlocked}
                        title={selBusy ? "Stop the run: running commands end, waiting hosts are skipped" : plan.runBlocked || plan.runTitle}
                        onClick={selBusy ? stopRuns : () => begin("run")}
                      />
                      <button
                        type="button"
                        onClick={() => begin("paste")}
                        disabled={!!plan.pasteBlocked}
                        title={plan.pasteBlocked || (pasteTo?.name ? `Paste into ${pasteTo.name}` : undefined)}
                        style={{ ...off(pageBtn, !!plan.pasteBlocked), flex: "none" }}
                      >
                        Paste to terminal
                      </button>
                      <button ref={editBtnRef} type="button" onClick={startEdit} style={{ ...pageBtn, flex: "none" }}>
                        Edit
                      </button>
                      <SnippetMenu name={selected.label.trim() || "Untitled"} canDuplicate={!selected.ai_edited} onDuplicate={() => void duplicateSnippet(selected)} onDelete={() => setConfirmDelete(selected)} />
                      <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", justifyContent: "flex-end" }}>
                        <SaveIndicator status={saveStatus} selId={selId} otherLabel={labelOf(saveStatus.id)} onRetry={() => void flush()} />
                      </div>
                    </>
                  )
                }
              />

              {editing ? (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 16 }}>
                    <div>
                      <label htmlFor="sn-name" style={fieldLabel}>Name</label>
                      <input id="sn-name" ref={nameRef} type="text" value={selected.label} onChange={(e) => edit({ label: e.target.value })} placeholder="Untitled" style={field} />
                    </div>
                    <div>
                      <label htmlFor="sn-folder" style={fieldLabel}>Folder</label>
                      <select
                        id="sn-folder"
                        value={selected.folder}
                        onChange={(e) => {
                          if (e.target.value === NEW_FOLDER) setFolderDialog({ mode: "create" });
                          else moveToFolder(e.target.value);
                        }}
                        style={{ ...field, padding: "0 8px" }}
                      >
                        <option value="">No folder</option>
                        {allFolders.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                        <option value={NEW_FOLDER}>New folder…</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <h3 style={h3} id="sn-command-label">Command</h3>
                    <CommandEditor key={selected.id} value={selected.script} onChange={(script) => edit({ script })} labelledBy="sn-command-label" />
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--text-3)" }}>Use {"{name}"} for a value you fill in when running.</p>
                  </div>

                  {plan.vars.length > 0 && (
                    <div>
                      <h3 style={h3}>Variables</h3>
                      <div style={{ display: "grid", gridTemplateColumns: "100px minmax(0, 1fr) auto", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8 }}>
                        {plan.vars.map((v) => {
                          const s = prefs.vars[v] ?? { value: "", ask: false };
                          const setVar = (patch: Partial<VarSetting>) =>
                            updatePrefs({ ...prefs, vars: { ...prefs.vars, [v]: { ...s, ...patch } } });
                          return <VarRow key={v} name={v} setting={s} onChange={setVar} />;
                        })}
                      </div>
                    </div>
                  )}

                  <div>
                    <h3 style={{ ...h3, marginBottom: 8 }}>Run on</h3>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                      {plan.targets.map((h) => (
                        <span key={h.id} style={chip}>
                          {h.name}
                          <button
                            type="button"
                            aria-label={`Remove ${h.name}`}
                            onClick={() => edit({ target_host_ids: selected.target_host_ids.filter((t) => t !== h.id) })}
                            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, border: 0, borderRadius: 9, background: "transparent", color: "var(--text-2)", cursor: "pointer" }}
                          >
                            <ChipCloseIcon />
                          </button>
                        </span>
                      ))}
                      <TargetPicker
                        hosts={hosts}
                        targets={plan.targets.map((h) => h.id)}
                        onAdd={(ids) => {
                          const keep = selected.target_host_ids.filter((id) => hostById.has(id));
                          edit({ target_host_ids: [...keep, ...ids.filter((id) => !keep.includes(id))] });
                        }}
                      />
                    </div>
                    {plan.targets.length > 1 && (
                      <div style={{ marginTop: 12 }}>
                        <RunModePicker
                          value={runMode}
                          onChange={(m) => updatePrefs({ ...prefs, tabs: m === "tabs", parallel: m === "tabs" ? prefs.parallel : m === "parallel" })}
                        />
                      </div>
                    )}
                  </div>

                  <EditFooter
                    left={
                      fresh ? undefined : (
                        <button type="button" onClick={() => setConfirmDelete(selected)} style={btnDanger}>
                          <TrashIcon />
                          Delete
                        </button>
                      )
                    }
                  >
                    <SaveIndicator status={saveStatus} selId={selId} otherLabel={labelOf(saveStatus.id)} onRetry={() => void flush()} />
                    {fresh && (
                      <button type="button" onClick={() => void discardNew(selected)} disabled={discarding} style={{ ...off(pageBtn, discarding), flex: "none" }}>
                        Cancel
                      </button>
                    )}
                    <button type="button" onClick={finishEdit} disabled={discarding} style={{ ...off(primaryBtn, discarding), flex: "none" }}>
                      Done
                    </button>
                  </EditFooter>
                </>
              ) : (
                <>
                  <Block title="Command">
                    <CommandView value={selected.script} />
                  </Block>

                  <Blocks>
                    {plan.vars.length > 0 && (
                      <Block title="Variables">
                        <Facts rows={plan.vars.map((v) => varFact(v, prefs.vars[v]))} />
                      </Block>
                    )}
                    <Block title="Run on">
                      {plan.targets.length === 0 ? (
                        <p style={{ ...quiet, margin: 0 }}>No hosts</p>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {plan.targets.map((h) => (
                              <span key={h.id} title={h.name} style={hostChip}>{h.name}</span>
                            ))}
                          </div>
                          {plan.targets.length > 1 && <span style={{ color: "var(--text-2)" }}>{RUN_MODES.find((m) => m.id === runMode)?.label}</span>}
                        </div>
                      )}
                    </Block>
                  </Blocks>

                  {snippetRuns.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                      {snippetRuns.map((run, i) => (
                        <RunBlock key={run.runId} run={run} latest={i === 0} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </SplitView>
      )}

      {folderDialog && (
        <FolderDialog
          title={folderDialog.mode === "create" ? "New folder" : "Rename folder"}
          submitLabel={folderDialog.mode === "create" ? "Create folder" : "Rename"}
          initial={folderDialog.mode === "rename" ? folderDialog.from : ""}
          existing={allFolders.filter((f) => folderDialog.mode !== "rename" || !sameFolder(f, folderDialog.from))}
          onSubmit={async (name) => {
            if (folderDialog.mode === "create") await createFolder(name);
            else if (name !== folderDialog.from) await renameFolder(folderDialog.from, name);
            if (alive.current) setFolderDialog(null);
          }}
          onClose={() => setFolderDialog(null)}
        />
      )}

      {varPrompt && promptSnippet && (() => {
        const pp = planFor(promptSnippet);
        return (
          <VarPromptDialog
            mode={varPrompt.mode}
            names={varPrompt.names}
            initial={varPrompt.values}
            script={promptSnippet.script}
            defaults={Object.fromEntries(pp.vars.map((v) => [v, pp.p.vars[v]?.value ?? ""]))}
            runLabel={pp.runTitle}
            onSubmit={(script, values) => {
              setVarPrompt(null);
              execute(varPrompt.mode, promptSnippet, script, values);
            }}
            onClose={() => setVarPrompt(null)}
          />
        );
      })()}

      {review && (
        <ConfirmDialog
          key={review.seq}
          guarded
          ready={reviewSeen}
          notReady="Scroll to the end of the command first"
          title="Changed by AI"
          message={review.changed ? "The snippet changed while you were reviewing it. This is the new version, check it again." : "The AI created or changed this snippet. Check every line and where it runs before you continue."}
          confirmLabel={review.mode === "paste" ? "Paste" : review.plan.tabs ? "Run in tabs" : "Run"}
          width={540}
          onConfirm={() => confirmReview(review)}
          onClose={() => setReview(null)}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <ReviewTarget review={review} pasteName={pasteTo?.name ?? ""} />
            <CommandPreview text={review.script} onReviewed={setReviewSeen} />
          </div>
        </ConfirmDialog>
      )}
      {confirmDelete && (
        <ConfirmDeleteDialog
          title="Delete snippet"
          message={`Delete "${confirmDelete.label.trim() || "Untitled"}"?${busyIds.has(confirmDelete.id) ? " Its running commands are stopped." : ""} This cannot be undone.`}
          onConfirm={() => deleteSnippet(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
      {folderToDelete !== null && (() => {
        const n = snippets.filter((x) => x.folder && sameFolder(x.folder, folderToDelete)).length;
        return (
          <ConfirmDeleteDialog
            title="Delete folder"
            message={n ? `Delete the folder "${folderToDelete}"? ${n === 1 ? "Its snippet moves" : `Its ${n} snippets move`} out of the folder. No snippet is deleted.` : `Delete the empty folder "${folderToDelete}"?`}
            onConfirm={() => removeFolder(folderToDelete)}
            onClose={() => setFolderToDelete(null)}
          />
        );
      })()}
    </main>
  );
}

function ReviewTarget({ review, pasteName }: { review: Review; pasteName: string }) {
  if (review.mode === "paste") return <p style={{ ...muted, margin: 0, fontSize: 12.5 }}>Pastes into {pasteName || "the active terminal"}</p>;
  const { targets, tabs, parallel } = review.plan;
  const mode: RunMode = tabs ? "tabs" : parallel ? "parallel" : "serial";
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 12.5 }}>
      <span style={{ color: "var(--text-2)", marginRight: 2 }}>Runs on</span>
      {targets.map((h) => (
        <span key={h.id} style={hostChip}>
          <VisibleLine text={h.name} />
          {h.ai_changed && <span title="Changed by AI" style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: "var(--warn)" }}>AI</span>}
        </span>
      ))}
      {targets.length > 1 && <span style={{ color: "var(--text-2)", marginLeft: 4 }}>{RUN_MODES.find((m) => m.id === mode)?.label}</span>}
    </div>
  );
}

const NEW_FOLDER = "\u0000new";
const RUN_KBD = KEYS.enter;

const ChipCloseIcon = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="3.75" y="3.75" width="8.5" height="8.5" rx="1.5" />
  </svg>
);

const MORPH = "180ms var(--ease-out)";

function RunButton({ stop, label, disabled, title, onClick }: { stop: boolean; label: string; disabled: boolean; title?: string; onClick(): void }) {
  const glyph = (on: boolean, turn: number): CSSProperties => ({ gridArea: "1 / 1", display: "flex", opacity: on ? 1 : 0, transform: on ? "rotate(0deg) scale(1)" : `rotate(${turn}deg) scale(0.4)`, transition: `opacity ${MORPH}, transform ${MORPH}` });
  const layer = (on: boolean): CSSProperties => ({ gridArea: "1 / 1", display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", opacity: on ? 1 : 0, transition: `opacity ${MORPH}` });
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} style={{ ...off(primaryBtn, disabled), flex: "none", transition: `opacity ${MORPH}, transform 160ms var(--ease-out)` }}>
      <span aria-hidden="true" style={{ display: "grid", placeItems: "center", width: 12, height: 12 }}>
        <span style={glyph(!stop, 90)}>
          <PlayIcon />
        </span>
        <span style={glyph(stop, -90)}>
          <StopIcon />
        </span>
      </span>
      <span style={{ display: "grid", justifyItems: "start" }}>
        <span aria-hidden={stop ? true : undefined} style={layer(!stop)}>
          <Stable text={label} alts={RUN_LABELS} align="start" />
          <kbd style={{ marginLeft: 4, fontFamily: "inherit", fontSize: 11, opacity: 0.85 }}>{RUN_KBD}</kbd>
        </span>
        <span aria-hidden={stop ? undefined : true} style={layer(stop)}>Stop</span>
      </span>
    </button>
  );
}

function FolderHeader({ name, onRename, onRemove }: { name: string; onRename(): void; onRemove(): void }) {
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (ref.current?.getClientRects().length ?? 0) > 0) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const shown = hover || open;
  const item = (key: string, disabled: boolean): CSSProperties =>
    off({ display: "flex", alignItems: "center", width: "100%", height: 28, padding: "0 8px", border: 0, borderRadius: 4, background: hot === key && !disabled ? "var(--sel)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 13 }, disabled);

  return (
    <div
      ref={ref}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false);
      }}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, padding: "6px 4px 4px 8px" }}
    >
      <h2 style={{ ...sectionLabel, ...oneLine, flex: 1, margin: 0 }} title={name}>
        {name}
      </h2>
      <button
        type="button"
        aria-label={`Folder actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", flex: "none", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: 0, borderRadius: 4, background: open ? "var(--sel)" : "transparent", color: "var(--text-2)", cursor: "pointer", opacity: shown ? 1 : 0, pointerEvents: shown ? "auto" : "none" }}
      >
        <DotsIcon size={14} />
      </button>
      {open && (
        <div role="menu" style={{ position: "absolute", top: "100%", right: 4, zIndex: 20, minWidth: 180, padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", boxSizing: "border-box" }}>
          <button
            type="button"
            role="menuitem"
            onMouseEnter={() => setHot("rename")}
            onMouseLeave={() => setHot(null)}
            onClick={() => {
              setOpen(false);
              onRename();
            }}
            style={item("rename", false)}
          >
            Rename…
          </button>
          <button
            type="button"
            role="menuitem"
            onMouseEnter={() => setHot("remove")}
            onMouseLeave={() => setHot(null)}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
            style={{ ...item("remove", false), color: "var(--err)" }}
          >
            Delete folder
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const codeFrame: CSSProperties = { display: "flex", border: "1px solid var(--line)", borderRadius: 8, background: "var(--term-bg)", fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7, overflow: "hidden" };
const codeGutter: CSSProperties = { padding: "10px 8px", minWidth: 28, textAlign: "right", color: "var(--term-dim)", borderRight: "1px solid var(--term-line)", userSelect: "none", boxSizing: "border-box" };
const codeText: CSSProperties = { margin: 0, padding: "10px 12px", fontFamily: MONO, fontSize: 12.5, lineHeight: 1.7, whiteSpace: "pre", tabSize: 4, letterSpacing: "normal", boxSizing: "border-box" };

function CommandView({ value }: { value: string }) {
  const lines = value.split("\n").length;
  return (
    <div style={codeFrame}>
      <div aria-hidden="true" style={codeGutter}>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre data-selectable style={{ ...codeText, flex: 1, minWidth: 0, overflowX: "auto", color: "var(--term-text)" }}>
        {value ? highlight(value) : <span style={{ color: "var(--term-dim)" }}>No command yet</span>}
        {"\n"}
      </pre>
    </div>
  );
}

function varFact(name: string, setting: VarSetting | undefined): Fact {
  if (!setting || setting.value === "") return [name, <span style={quiet}>Asked when run</span>];
  if (setting.ask)
    return [
      name,
      <span title={`${setting.value}, asked when run`}>
        <span style={mono}>{setting.value}</span>
        <span style={quiet}>, asked when run</span>
      </span>,
    ];
  return [name, <span title={setting.value} style={mono}>{setting.value}</span>];
}

function SnippetMenu({ name, canDuplicate, onDuplicate, onDelete }: { name: string; canDuplicate: boolean; onDuplicate(): void; onDelete(): void }) {
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const itemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    itemRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (ref.current?.getClientRects().length ?? 0) > 0) {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "flex", flex: "none" }}>
      <button
        ref={btnRef}
        type="button"
        aria-label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ ...pageBtn, width: 32, padding: 0, justifyContent: "center", background: open ? "var(--bg-raised)" : "var(--bg)", color: "var(--text-2)" }}
      >
        <DotsIcon />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for ${name}`}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              setOpen(false);
              btnRef.current?.focus();
            }
          }}
          style={{ position: "absolute", top: 36, left: 0, zIndex: 20, minWidth: 160, padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", boxSizing: "border-box" }}
        >
          {(
            [
              { id: "dup", label: "Duplicate", color: "var(--text)", disabled: !canDuplicate, title: canDuplicate ? undefined : "Review the AI change first: run it once or edit it", run: onDuplicate },
              { id: "del", label: "Delete snippet", color: "var(--err)", disabled: false, title: undefined, run: onDelete },
            ] as const
          ).map((it, i) => (
            <button
              key={it.id}
              ref={i === (canDuplicate ? 0 : 1) ? itemRef : undefined}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.title}
              onMouseEnter={() => setHot(it.id)}
              onMouseLeave={() => setHot(null)}
              onFocus={(e) => e.currentTarget.matches(":focus-visible") && setHot(it.id)}
              onBlur={() => setHot(null)}
              onClick={() => {
                setOpen(false);
                btnRef.current?.focus();
                it.run();
              }}
              style={{ display: "flex", alignItems: "center", width: "100%", height: 28, padding: "0 10px", border: 0, borderRadius: 4, background: hot === it.id && !it.disabled ? "var(--sel)" : "transparent", color: it.color, opacity: it.disabled ? 0.45 : 1, textAlign: "left", cursor: it.disabled ? "default" : "pointer", fontSize: 13, outline: "none" }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandEditor({ value, onChange, labelledBy }: { value: string; onChange(v: string): void; labelledBy: string }) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [focused, setFocused] = useState(false);
  const lines = value.split("\n").length;

  // Grow with the content so only the editor's horizontal scrollbar remains.
  const fit = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`;
  }, []);
  useLayoutEffect(fit, [value, fit]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    let width = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth !== width) {
        width = ta.clientWidth;
        fit();
      }
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [fit]);

  return (
    <div style={{ ...codeFrame, border: `1px solid ${focused ? "var(--focus)" : "var(--line)"}` }}>
      <div aria-hidden="true" style={codeGutter}>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div style={{ position: "relative", flex: 1, minWidth: 0, overflow: "hidden" }}>
        <pre aria-hidden="true" style={{ ...codeText, position: "absolute", top: 0, left: 0, minWidth: "100%", color: "var(--term-text)", pointerEvents: "none", transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>
          {value ? highlight(value) : <span style={{ color: "var(--term-dim)" }}>{"cd /opt/{app} && docker compose up -d"}</span>}
          {"\n"}
        </pre>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => setScroll({ left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop })}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-labelledby={labelledBy}
          wrap="off"
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          data-selectable
          style={{ ...codeText, position: "relative", display: "block", width: "100%", border: 0, background: "transparent", color: "transparent", WebkitTextFillColor: "transparent", caretColor: "var(--term-text)", overflowX: "auto", overflowY: "hidden", resize: "none", outline: "none" }}
        />
      </div>
    </div>
  );
}

function VarRow({ name, setting, onChange }: { name: string; setting: VarSetting; onChange(p: Partial<VarSetting>): void }) {
  const id = `sn-var-${name}`;
  return (
    <>
      <code style={{ fontFamily: MONO, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={name}>{name}</code>
      <div>
        <label htmlFor={id} style={srOnly}>Default value for {name}</label>
        <input
          id={id}
          type="text"
          value={setting.value}
          placeholder={setting.ask ? "Suggested value" : "Default value"}
          onChange={(e) => onChange({ value: e.target.value })}
          spellCheck={false}
          style={{ ...field, height: 30 }}
        />
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-2)", whiteSpace: "nowrap" }}>
        <input type="checkbox" checked={setting.ask} onChange={(e) => onChange({ ask: e.target.checked })} />
        Ask every time
      </label>
    </>
  );
}

// Errors stay visible whichever snippet is selected; progress and "Saved" only
// show for the snippet they belong to.
function SaveIndicator({ status, selId, otherLabel, onRetry }: { status: SaveStatus; selId: string | null; otherLabel: string; onRetry(): void }) {
  const mine = status.id === selId;
  if (status.state === "error") {
    const text = mine || !otherLabel ? `Not saved: ${status.error}` : `"${otherLabel}" not saved: ${status.error}`;
    return (
      <span role="status" style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 1 auto", fontSize: 12, color: "var(--err)", minWidth: 0 }}>
        <span style={{ ...oneLine, maxWidth: 260 }} title={text}>{text}</span>
        <button type="button" onClick={onRetry} style={{ flex: "none", padding: 0, border: 0, background: "transparent", color: "var(--link)", fontSize: 12, cursor: "pointer" }}>Retry</button>
      </span>
    );
  }
  const text = !mine ? "" : status.state === "saving" || status.state === "pending" ? "Saving…" : status.state === "saved" ? "Saved" : "";
  return (
    <span role="status" aria-live="polite" style={{ ...oneLine, flex: "0 1 auto", fontSize: 12, color: "var(--text-3)" }}>
      {text}
    </span>
  );
}

function TargetPicker({ hosts, targets, onAdd }: { hosts: Host[]; targets: string[]; onAdd(ids: string[]): void }) {
  const [open, setOpen] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (ref.current?.getClientRects().length ?? 0) > 0) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const free = hosts.filter((h) => !targets.includes(h.id));

  const blocked = hosts.length === 0 ? "Add a host first" : free.length === 0 ? "Every host is already selected" : "";
  const item = (key: string): CSSProperties => ({ display: "flex", alignItems: "center", gap: 10, width: "100%", height: 28, padding: "0 8px", border: 0, borderRadius: 4, background: hot === key ? "var(--sel)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 13 });
  const pick = (ids: string[]) => {
    onAdd(ids);
    setOpen(false);
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!!blocked}
        title={blocked || undefined}
        onClick={() => setOpen((o) => !o)}
        style={off({ display: "inline-flex", alignItems: "center", gap: 4, height: 24, padding: "0 10px", border: "1px dashed var(--line)", borderRadius: 12, background: "transparent", color: "var(--text-2)", fontSize: 12, cursor: "pointer", boxSizing: "border-box" }, !!blocked)}
      >
        <PlusIcon size={12} sw={1.75} />
        Add host
      </button>
      {open && (
        <div role="menu" style={{ position: "absolute", top: 28, left: 0, zIndex: 20, minWidth: 240, maxWidth: 320, maxHeight: 300, overflow: "auto", padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", boxSizing: "border-box" }}>
          {free.map((h) => (
            <button key={h.id} type="button" role="menuitem" onMouseEnter={() => setHot(h.id)} onMouseLeave={() => setHot(null)} onClick={() => pick([h.id])} style={item(h.id)}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</span>
              <span style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }}>
                {h.username ? `${h.username}@` : ""}{h.hostname}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RunModePicker({ value, onChange }: { value: RunMode; onChange(m: RunMode): void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + RUN_MODES.length) % RUN_MODES.length;
    refs.current[next]?.focus();
    onChange(RUN_MODES[next].id);
  };
  return (
    <div role="radiogroup" aria-label="How to run" style={{ display: "inline-flex", padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)" }}>
      {RUN_MODES.map((m, i) => {
        const on = m.id === value;
        return (
          <button
            key={m.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => !on && onChange(m.id)}
            onKeyDown={(e) => onKey(e, i)}
            style={{ height: 26, padding: "0 10px", border: 0, borderRadius: 4, background: on ? "var(--bg)" : "transparent", boxShadow: on ? "0 0 0 1px var(--line)" : "none", color: on ? "var(--text)" : "var(--text-2)", whiteSpace: "nowrap", cursor: "pointer" }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RunBlock({ run, latest }: { run: ScriptRun; latest: boolean }) {
  const blockRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (latest && Date.now() - run.startedAt < 2000) blockRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [latest, run.startedAt]);
  const queued = run.results.some((x) => x.status === "queued");
  const running = run.results.some((x) => x.status === "running");
  const time = new Date(run.startedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

  return (
    <div ref={blockRef} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ ...h3, margin: 0, flex: 1, minWidth: 0 }}>
          Output, started {time}
          <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
            {" · "}
            {run.results.length} {run.results.length === 1 ? "host" : "hosts"}
            {run.results.length > 1 ? (run.parallel ? ", at the same time" : ", one after another") : ""}
          </span>
        </h3>
        <button type="button" onClick={() => clearRun(run.runId)} disabled={queued || running} title={queued || running ? "Stop the run before you clear its output" : "Remove this output"} style={{ ...smallBtn, opacity: queued || running ? 0.45 : 1, cursor: queued || running ? "default" : "pointer" }}>
          Clear
        </button>
      </div>
      {run.results.length === 0 ? (
        <p style={{ margin: 0, ...muted }}>No hosts to run on.</p>
      ) : (
        run.results.map((r) => <HostResult key={r.hostId} result={r} defaultOpen={latest && run.results.length <= 3} />)
      )}
    </div>
  );
}

function statusChip(r: HostRun): { text: string; color: string; bg: string } {
  switch (r.status) {
    case "queued":
      return { text: "Queued", color: "var(--text-2)", bg: "var(--bg-raised)" };
    case "running":
      return { text: "Running…", color: "var(--warn)", bg: "var(--warn-tint)" };
    case "cancelled":
      return { text: "Skipped", color: "var(--text-2)", bg: "var(--bg-raised)" };
    case "error":
      if (r.signal === "cancelled") return { text: "Stopped", color: "var(--text-2)", bg: "var(--bg-raised)" };
      return { text: r.signal ? `Stopped: ${r.signal}` : "Failed", color: "var(--err)", bg: "var(--err-tint)" };
    default:
      if (r.exit == null) return { text: "Finished", color: "var(--text-2)", bg: "var(--bg-raised)" };
      return r.exit === 0
        ? { text: "Exit 0", color: "var(--ok)", bg: "var(--bg-raised)" }
        : { text: `Exit ${r.exit}`, color: "var(--err)", bg: "var(--err-tint)" };
  }
}

const OUTPUT_MAX = 260;
const OUTPUT_PAD_Y = 20;
const OUTPUT_PAD_X = 24;
const XTERM_SCROLLBAR = 15;

function cellSize(fontSize: number, family: string, lineHeight: number): { w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return { w: fontSize * 0.6, h: Math.ceil(fontSize * 1.2 * lineHeight) };
  ctx.font = `${fontSize}px ${family}`;
  const m = ctx.measureText("W");
  const charH = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent || fontSize * 1.2;
  return { w: Math.floor(m.width * dpr) / dpr, h: Math.floor(Math.ceil(charH * dpr) * lineHeight) / dpr };
}

function outputRows(text: string, cols: number, cap: number): number {
  let rows = 0;
  for (let at = 0; rows < cap; ) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl;
    let width = 0;
    for (const part of text.slice(at, Math.min(end, at + cols * cap)).split("\r")) width = Math.max(width, part.replace(/\t/g, "        ").length);
    rows += Math.max(1, Math.ceil(width / cols));
    if (nl < 0) break;
    at = nl + 1;
  }
  return Math.min(rows, cap);
}

function HostResult({ result, defaultOpen }: { result: HostRun; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [boxWidth, setBoxWidth] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const { termFontSize, termFontFamily, termLineHeight } = usePrefs();
  const cell = useMemo(() => cellSize(termFontSize, termFontStack(termFontFamily), termLineHeight), [termFontSize, termFontFamily, termLineHeight]);
  const chip = statusChip(result);
  const hasOutput = result.output.length > 0 || result.status === "running";
  const showOutput = open && hasOutput;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    setBoxWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [showOutput]);

  const cap = Math.max(1, Math.floor((OUTPUT_MAX - OUTPUT_PAD_Y) / cell.h));
  const cols = boxWidth > 0 && cell.w > 0 ? Math.max(1, Math.floor((boxWidth - OUTPUT_PAD_X - XTERM_SCROLLBAR) / cell.w)) : Infinity;
  const rows = showOutput ? outputRows(result.output, cols, cap) : 0;
  const outputHeight = rows >= cap ? OUTPUT_MAX : Math.ceil(rows * cell.h) + OUTPUT_PAD_Y;

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", height: 32, padding: "0 10px", border: 0, background: "var(--bg-sunken)", color: "var(--text)", textAlign: "left", cursor: "pointer" }}
      >
        <span style={{ display: "flex", color: "var(--text-2)", transform: open ? undefined : "rotate(-90deg)", transition: "transform .12s" }}>
          <ChevronIcon size={14} />
        </span>
        <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{result.hostName}</span>
        <span style={{ display: "inline-flex", alignItems: "center", height: 20, padding: "0 8px", borderRadius: 10, background: chip.bg, color: chip.color, fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }}>{chip.text}</span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--line)" }}>
          {result.error && <p style={{ margin: 0, padding: "8px 12px", fontSize: 12, color: "var(--err)" }}>{result.error}</p>}
          {hasOutput && (
            <div ref={boxRef} style={{ height: outputHeight }} data-selectable>
              <Suspense fallback={null}>
                <LiveTerminalOutput output={result.output} />
              </Suspense>
            </div>
          )}
          {!hasOutput && !result.error && (
            <p style={{ margin: 0, padding: "8px 12px", ...muted }}>
              {result.status === "queued" ? "Waiting for the previous host." : result.status === "cancelled" ? "Not run." : "No output."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs

function Modal({ title, onClose, backdropCloses, initialFocus, children }: { title: string; onClose(): void; backdropCloses: boolean; initialFocus?: RefObject<HTMLElement | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const openedAt = useRef(performance.now());
  const z = useModalLayer(ref, { onEscape: onClose, initialFocus });
  return (
    <Overlay z={z} padding="16px" onBackdrop={backdropCloses ? () => performance.now() - openedAt.current > 400 && onClose() : undefined}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} style={{ width: 440, maxWidth: "100%", maxHeight: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 14, padding: 24, borderRadius: 12, background: "var(--bg)", color: "var(--text)", boxShadow: "var(--shadow)", boxSizing: "border-box", outline: "none" }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
        {children}
      </div>
    </Overlay>
  );
}

// Primary action comes first on Windows, last on macOS.
function DialogButtons({ primary, cancel }: { primary: ReactNode; cancel: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
      {IS_MAC ? cancel : primary}
      {IS_MAC ? primary : cancel}
    </div>
  );
}

function FolderDialog({
  title,
  submitLabel,
  initial,
  existing,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial: string;
  existing: string[];
  onSubmit(name: string): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n) return setErr("Enter a folder name.");
    if (existing.some((f) => f.toLowerCase() === n.toLowerCase())) return setErr("A folder with this name already exists.");
    setBusy(true);
    try {
      await onSubmit(n);
    } catch (ex) {
      setErr(errText(ex));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={() => !busy && onClose()} backdropCloses>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label htmlFor="sn-new-folder" style={fieldLabel}>Name</label>
          <input
            id="sn-new-folder"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setErr("");
            }}
            placeholder="Docker"
            style={field}
          />
          {err && <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--err)" }}>{err}</p>}
        </div>
        <DialogButtons
          primary={<button type="submit" disabled={busy} style={off(primaryBtn, busy)}><Stable text={busy ? "Saving…" : submitLabel} alts={[submitLabel, "Saving…"]} /></button>}
          cancel={<button type="button" onClick={onClose} disabled={busy} style={off(pageBtn, busy)}>Cancel</button>}
        />
      </form>
    </Modal>
  );
}

function VarPromptDialog({
  mode,
  names,
  initial,
  script,
  defaults,
  runLabel,
  onSubmit,
  onClose,
}: {
  mode: "run" | "paste";
  names: string[];
  initial: Record<string, string>;
  script: string;
  defaults: Record<string, string>;
  runLabel: string;
  onSubmit(script: string, values: Record<string, string>): void;
  onClose(): void;
}) {
  const [values, setValues] = useState(initial);
  const missing = names.filter((n) => (values[n] ?? "") === "");
  const merged = { ...defaults, ...values };
  const final = applyVars(script, merged);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing.length === 0) onSubmit(final, merged);
  };
  return (
    <Modal title="Fill in variables" onClose={onClose} backdropCloses>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {names.map((n, i) => (
          <div key={n}>
            <label htmlFor={`sn-ask-${n}`} style={{ ...fieldLabel, fontFamily: MONO }}>{n}</label>
            <input
              id={`sn-ask-${n}`}
              autoFocus={i === 0}
              value={values[n] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
              spellCheck={false}
              style={field}
            />
          </div>
        ))}
        <div>
          <div style={fieldLabel}>Command</div>
          <pre data-selectable style={{ margin: 0, maxHeight: 160, overflow: "auto", padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--term-bg)", color: "var(--term-text)", fontFamily: MONO, fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{final}</pre>
        </div>
        <DialogButtons
          primary={
            <button type="submit" disabled={missing.length > 0} title={missing.length > 0 ? "Fill in every variable" : undefined} style={off(primaryBtn, missing.length > 0)}>
              {mode === "paste" ? "Paste" : runLabel}
            </button>
          }
          cancel={<button type="button" onClick={onClose} style={pageBtn}>Cancel</button>}
        />
      </form>
    </Modal>
  );
}

function ConfirmDeleteDialog({ title, message, onConfirm, onClose }: { title: string; message: string; onConfirm(): Promise<void>; onClose(): void }) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const confirm = async () => {
    setBusy(true);
    setErr("");
    try {
      await onConfirm();
      if (alive.current) onClose();
    } catch (e) {
      if (alive.current) {
        setErr(errText(e));
        setBusy(false);
      }
    }
  };
  return (
    <Modal title={title} onClose={() => !busy && onClose()} backdropCloses={false} initialFocus={cancelRef}>
      <p style={{ margin: 0, lineHeight: 1.5 }}>{message}</p>
      {err && <p style={{ margin: 0, fontSize: 12, color: "var(--err)" }}>{err}</p>}
      <DialogButtons
        primary={
          <button type="button" onClick={confirm} disabled={busy} style={off(btnDanger, busy)}>
            <Stable text={busy ? "Deleting…" : "Delete"} alts={["Delete", "Deleting…"]} />
          </button>
        }
        cancel={<button ref={cancelRef} type="button" onClick={onClose} disabled={busy} style={off(pageBtn, busy)}>Cancel</button>}
      />
    </Modal>
  );
}
