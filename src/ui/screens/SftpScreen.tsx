import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Channel, invoke } from "@tauri-apps/api/core";
import { tempDir, join as pathJoin } from "@tauri-apps/api/path";
import { writeText as clipWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import * as api from "../../api";
import type { FileEntry, Host } from "../../api";
import { usePrefs } from "../../lib/prefs";
import { IS_MAC, MOD, MONO, errText, fmtDate, fmtPerms, fmtSize } from "../mock";
import { ConfirmDialog, Overlay, useModalLayer } from "../overlays/Dialogs";
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  DotsIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  RefreshIcon,
  TerminalTabIcon,
  UploadIcon,
  WarningIcon,
} from "../icons";
import { Stable } from "../Stable";

// ---------------------------------------------------------------- icons

function Svg({ size = 14, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const FilePlusIcon = () => (
  <Svg>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3M8 7.5v4M6 9.5h4" />
  </Svg>
);
const LinkIcon = () => (
  <Svg>
    <path d="M6.75 9.25a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.9.9" />
    <path d="M9.25 6.75a2.6 2.6 0 0 0-3.7 0l-2.1 2.1a2.6 2.6 0 0 0 3.7 3.7l.9-.9" />
  </Svg>
);
const ParentIcon = () => (
  <Svg>
    <path d="M3.5 6.5 7 3l3.5 3.5" />
    <path d="M7 3v6.5a3 3 0 0 0 3 3h2.5" />
  </Svg>
);

// ---------------------------------------------------------------- styles

const toolBtn: CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
const iconBtn: CSSProperties = { ...toolBtn, width: 28, padding: 0, justifyContent: "center" };
const primaryBtn: CSSProperties = { ...toolBtn, border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500 };
const ghostBtn: CSSProperties = { height: 24, padding: "0 8px", border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", fontSize: 12, cursor: "pointer" };
const smallIconBtn: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: "var(--text-2)", cursor: "pointer" };
// Sticky header cells lose collapsed borders while scrolling, so the bottom rule is an inset shadow.
const th: CSSProperties = { position: "sticky", top: 0, zIndex: 1, height: 28, padding: "0 12px", fontWeight: 500, textAlign: "left", color: "var(--text-2)", boxShadow: "inset 0 -1px 0 var(--line)", background: "var(--bg)", whiteSpace: "nowrap", overflow: "hidden" };
const td: CSSProperties = { padding: "0 12px", color: "var(--text-2)", borderBottom: "1px solid var(--line-soft)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const nameCell: CSSProperties = { height: 30, padding: "0 12px", borderBottom: "1px solid var(--line-soft)" };
const miniInput: CSSProperties = { flex: 1, minWidth: 0, height: 28, padding: "0 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontFamily: MONO, fontSize: 12, boxSizing: "border-box" };
const selectStyle: CSSProperties = { height: 28, maxWidth: 180, padding: "0 6px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text)", fontSize: 12, fontWeight: 500 };
const transferRow: CSSProperties = { display: "grid", gridTemplateColumns: "16px minmax(0, 2fr) minmax(0, 2fr) minmax(0, 1.5fr) 110px 24px", alignItems: "center", gap: 12, height: 34, padding: "0 12px", borderTop: "1px solid var(--line-soft)", fontSize: 12.5 };
const ellipsis: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
const inlineInput: CSSProperties = { flex: 1, minWidth: 0, height: 22, padding: "0 6px", border: "1px solid var(--focus)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 12.5, outline: "none", boxSizing: "border-box" };

function disabledStyle(base: CSSProperties, disabled: boolean): CSSProperties {
  return disabled ? { ...base, opacity: 0.5, cursor: "default" } : base;
}

// ---------------------------------------------------------------- paths and file systems

type Side = "left" | "right";
type Loc = { kind: "local" } | { kind: "remote"; hostId: string } | { kind: "none" };
type Phase = "idle" | "connecting" | "ready" | "error";
type SortKey = "name" | "size" | "mtime" | "perm";

const SIDES: Side[] = ["left", "right"];
const EDIT_LIMIT = 1024 * 1024;
const TOO_LARGE = /larger than 1 MiB/i;
const NOT_TEXT = /utf-?8|not.{0,10}text/i;
const REFRESH_MS = 5000;
const DRIVE = /^[A-Za-z]:$/;
const UNC_ROOT = /^\\\\[^\\/]+[\\/][^\\/]+$/;

const otherSide = (s: Side): Side => (s === "left" ? "right" : "left");

function sameLoc(a: Loc, b: Loc): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "remote" || a.hostId === (b as { hostId: string }).hostId;
}

const LOCAL_WIN = !IS_MAC && typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function isWinPath(p: string): boolean {
  return LOCAL_WIN || /^[A-Za-z]:/.test(p);
}

function parentPath(p: string, remote: boolean): string {
  if (remote || !isWinPath(p)) {
    const t = p.replace(/\/+$/, "");
    if (t === "") return "/";
    const i = t.lastIndexOf("/");
    return i <= 0 ? "/" : t.slice(0, i);
  }
  const t = p.replace(/[\\/]+$/, "");
  if (DRIVE.test(t)) return t + "\\";
  if (UNC_ROOT.test(t)) return p;
  const i = Math.max(t.lastIndexOf("\\"), t.lastIndexOf("/"));
  if (i < 0) return p;
  const head = t.slice(0, i);
  return DRIVE.test(head) ? head + "\\" : head || "\\";
}

function joinPath(dir: string, name: string, remote: boolean): string {
  if (remote || !isWinPath(dir)) return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
  return /[\\/]$/.test(dir) ? dir + name : `${dir}\\${name}`;
}

function isAbsolute(p: string, win: boolean): boolean {
  return p.startsWith("/") || (win && (/^[A-Za-z]:/.test(p) || p.startsWith("\\")));
}

/** Collapses empty, "." and ".." segments; ".." never climbs above the root. */
function collapsePath(p: string, win: boolean): string {
  const m = win ? /^([A-Za-z]:|\\\\[^\\/]+[\\/][^\\/]+)?(.*)$/.exec(p) : null;
  const prefix = m?.[1] ?? "";
  const rest = m ? m[2] : p;
  const out: string[] = [];
  for (const seg of rest.split(win ? /[\\/]/ : "/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  if (!win) return "/" + out.join("/");
  if (out.length === 0) return prefix.startsWith("\\\\") ? prefix : `${prefix}\\`;
  return `${prefix}\\${out.join("\\")}`;
}

/** Resolves typed input: "~" is the start folder, relative paths are taken from the current folder. */
function normalizePath(raw: string, home: string, cwd: string, remote: boolean): string {
  let p = raw.trim();
  if (p === "" || p === "~") return home;
  // Windows rules only for a local side whose home is a Windows path; a backslash is a valid name character elsewhere.
  const win = !remote && /^([A-Za-z]:|\\\\)/.test(home);
  if (p.startsWith("~/") || (win && p.startsWith("~\\"))) p = joinPath(home, p.slice(2), remote);
  else if (!isAbsolute(p, win)) p = joinPath(cwd || home, p, remote);
  return collapsePath(p, win);
}

function baseName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

/** Only the bare basename of a server-supplied name, so `..\..\evil` cannot escape the target folder. */
function safeName(name: string): string | null {
  const n = name.split(/[/\\]/).pop() ?? "";
  if (!n || n === "." || n === "..") return null;
  if (LOCAL_WIN && (/[<>:"|?*\u0000-\u001f]/.test(n) || /[. ]$/.test(n) || WIN_RESERVED.test(n))) return null;
  return n;
}

function invalidName(name: string, remote: boolean): string | null {
  if (name === "." || name === "..") return "That name is reserved.";
  if (remote ? name.includes("/") : /[\\/]/.test(name)) return "Names cannot contain slashes.";
  return null;
}

function sameName(a: string, b: string, remote: boolean): boolean {
  return remote ? a === b : a.toLowerCase() === b.toLowerCase();
}

interface Fs {
  remote: boolean;
  list(path: string): Promise<FileEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string, isDir: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
}

const localFs: Fs = {
  remote: false,
  list: api.localList,
  mkdir: api.localMkdir,
  remove: api.localRemove,
  rename: api.localRename,
  readText: api.localReadText,
  writeText: api.localWriteText,
};

function remoteFs(id: string): Fs {
  return {
    remote: true,
    list: (p) => api.sftpList(id, p),
    mkdir: (p) => api.sftpMkdir(id, p),
    remove: (p, d) => api.sftpRemove(id, p, d),
    rename: (a, b) => api.sftpRename(id, a, b),
    readText: (p) => api.sftpReadText(id, p),
    writeText: (p, c) => api.sftpWriteText(id, p, c),
  };
}

async function removeTree(fs: Fs, e: FileEntry): Promise<void> {
  // The local backend removes a whole tree in one call. SFTP has no recursive delete,
  // so remote folders are emptied first; symlinks are removed as links, never followed.
  if (fs.remote && e.is_dir && !e.is_symlink) {
    for (const child of await fs.list(e.path)) await removeTree(fs, child);
  }
  await fs.remove(e.path, e.is_dir);
}

function sortEntries(list: FileEntry[], key: SortKey, asc: boolean): FileEntry[] {
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const cmp = (a: FileEntry, b: FileEntry) => {
    if (key === "size") return a.size - b.size || byName(a, b);
    if (key === "mtime") return (a.mtime ?? 0) - (b.mtime ?? 0) || byName(a, b);
    if (key === "perm") return fmtPerms(a.permissions).localeCompare(fmtPerms(b.permissions)) || byName(a, b);
    return byName(a, b);
  };
  return [...list].sort((a, b) => (a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1) : asc ? cmp(a, b) : -cmp(a, b)));
}

async function copyText(text: string) {
  try {
    await clipWriteText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

function itemCount(n: number): string {
  return `${n} item${n === 1 ? "" : "s"}`;
}

function isDirty(p: { editing: Editing | null }): boolean {
  return !!p.editing && p.editing.content !== p.editing.original;
}

type ChildCount = { all: number; shown: number } | null;

// ---------------------------------------------------------------- pane state

const CONN_ERROR = /session|channel|connect|closed|disconnect|eof|broken pipe|timed out|reset by peer|not found: sftp/i;

function withEol(content: string, eol: "\n" | "\r\n"): string {
  return eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

interface Editing {
  path: string;
  name: string;
  content: string;
  original: string;
  eol: "\n" | "\r\n";
  saving: boolean;
  saved: boolean;
  error: string;
}

type Note = { text: string; tone: "ok" | "info" };

function usePane(side: Side, initial: Loc, opts: { active: boolean; autoRefresh: boolean; showHidden: boolean; paused: boolean }) {
  const [loc, setLoc] = useState<Loc>(initial);
  const [gen, setGen] = useState(0);
  const [sid, setSid] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(initial.kind === "none" ? "idle" : "connecting");
  const [connectError, setConnectError] = useState("");
  const [home, setHome] = useState("");
  const [cwd, setCwd] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchorState] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const setAnchor = (v: string | null) => {
    setAnchorState(v);
    setCursor(v);
  };
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [creating, setCreatingState] = useState<{ kind: "folder" | "file"; name: string } | null>(null);
  const [renaming, setRenamingState] = useState<{ path: string; value: string } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [counts, setCounts] = useState<Map<string, ChildCount>>(() => new Map());

  const fs = useMemo<Fs | null>(() => (loc.kind === "local" ? localFs : loc.kind === "remote" && sid ? remoteFs(sid) : null), [loc, sid]);

  const mounted = useRef(true);
  const noteTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(noteTimer.current);
    };
  }, []);

  // `epoch` changes with every location switch so late results from the old location are dropped.
  const epoch = useRef(0);
  const reqRef = useRef(0);
  const resumeRef = useRef("");
  const busyRef = useRef(false);
  const countState = useRef({ seen: new Set<string>(), queue: [] as { key: string; path: string }[], inFlight: 0 });
  const creatingRef = useRef(creating);
  const renamingRef = useRef(renaming);

  const setBusy = (v: boolean) => {
    busyRef.current = v;
    if (mounted.current) setBusyState(v);
  };
  const setCreating = (v: { kind: "folder" | "file"; name: string } | null) => {
    creatingRef.current = v;
    setCreatingState(v);
  };
  const setRenaming = (v: { path: string; value: string } | null) => {
    renamingRef.current = v;
    setRenamingState(v);
  };

  const listInto = useCallback(async (f: Fs, path: string, mode: "navigate" | "refresh" | "silent"): Promise<boolean> => {
    const my = ++reqRef.current;
    const ep = epoch.current;
    if (mode !== "silent") setLoading(true);
    if (mode === "navigate") setError("");
    try {
      const list = await f.list(path);
      if (!mounted.current || my !== reqRef.current || ep !== epoch.current) return false;
      setEntries(list);
      setCwd(path);
      if (mode === "navigate") {
        setSelected(new Set());
        setAnchor(null);
      } else {
        setSelected((prev) => {
          if (prev.size === 0) return prev;
          const keep = new Set(list.map((e) => e.path));
          const next = new Set([...prev].filter((p) => keep.has(p)));
          return next.size === prev.size ? prev : next;
        });
      }
      return true;
    } catch (e) {
      if (mounted.current && my === reqRef.current && ep === epoch.current) setError(errText(e));
      return false;
    } finally {
      if (mounted.current && my === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    epoch.current++;
    reqRef.current++;
    setSid(null);
    setEntries([]);
    setCwd("");
    setError("");
    setConnectError("");
    setSelected(new Set());
    setAnchor(null);
    creatingRef.current = null;
    renamingRef.current = null;
    setCreatingState(null);
    setRenamingState(null);
    setEditing(null);
    setLoading(false);
    countState.current = { seen: new Set(), queue: [], inFlight: 0 };
    setCounts(new Map());
    if (loc.kind === "none") {
      setPhase("idle");
      return;
    }
    setPhase("connecting");
    let alive = true;
    const resume = resumeRef.current;
    resumeRef.current = "";
    const fail = (e: unknown) => {
      if (!alive) return;
      setConnectError(errText(e));
      setPhase("error");
    };
    const firstList = async (list: (p: string) => Promise<FileEntry[]>, start: string): Promise<[string, FileEntry[]]> => {
      if (resume) {
        try {
          return [resume, await list(resume)];
        } catch {
          /* the old folder is gone, fall back to home */
        }
      }
      return [start, await list(start)];
    };

    if (loc.kind === "local") {
      api
        .localHome()
        .then(async (h) => {
          if (!alive) return;
          setHome(h);
          const [path, list] = await firstList(api.localList, h);
          if (!alive) return;
          setEntries(list);
          setCwd(path);
          setPhase("ready");
        })
        .catch(fail);
      return () => {
        alive = false;
      };
    }

    const id = `sftp-${side}-${crypto.randomUUID()}`;
    let opened = false;
    api
      .sftpOpen(id, loc.hostId)
      .then(async (h) => {
        opened = true;
        if (!alive) {
          void api.sftpClose(id).catch(() => {});
          return;
        }
        const start = h || "/";
        setHome(start);
        const [path, list] = await firstList((p) => api.sftpList(id, p), start);
        if (!alive) return;
        setEntries(list);
        setCwd(path);
        setSid(id);
        setPhase("ready");
      })
      .catch(fail);
    return () => {
      alive = false;
      if (opened) void api.sftpClose(id).catch(() => {});
    };
  }, [loc, gen, side]);

  const lastCwd = useRef("");
  useEffect(() => {
    if (cwd) lastCwd.current = cwd;
  }, [cwd]);
  useEffect(() => {
    if (phase === "ready") setError("");
  }, [phase]);

  const live = useRef({ loading, creating, renaming, editing, paused: opts.paused, cwd, fs, phase });
  live.current = { loading, creating, renaming, editing, paused: opts.paused, cwd, fs, phase };

  useEffect(() => {
    if (!opts.autoRefresh || !opts.active || phase !== "ready") return;
    const t = window.setInterval(() => {
      const s = live.current;
      if (s.loading || busyRef.current || s.creating || s.renaming || s.editing || s.paused || !s.fs || !s.cwd) return;
      void listInto(s.fs, s.cwd, "silent");
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [opts.autoRefresh, opts.active, phase, listInto]);

  const wasActive = useRef(opts.active);
  useEffect(() => {
    if (opts.active && !wasActive.current) {
      const s = live.current;
      if (s.phase === "ready" && s.fs && s.cwd && !s.loading && !busyRef.current) void listInto(s.fs, s.cwd, "silent");
    }
    wasActive.current = opts.active;
  }, [opts.active, listInto]);

  const visible = useMemo(
    () => sortEntries(opts.showHidden ? entries : entries.filter((e) => !e.hidden), sort.key, sort.asc),
    [entries, opts.showHidden, sort],
  );
  const selectedEntries = useMemo(() => visible.filter((e) => selected.has(e.path)), [visible, selected]);
  const hiddenCount = entries.length - (opts.showHidden ? entries.length : entries.filter((e) => !e.hidden).length);

  // ---- folder item counts, fetched lazily for rows that scroll into view.
  // Keyed by path and mtime: a folder's mtime changes when entries are added or removed.

  const countKey = (e: FileEntry) => `${e.path}\n${e.mtime ?? ""}`;
  const fsRef = useRef(fs);
  fsRef.current = fs;

  function pumpCounts() {
    const f = fsRef.current;
    const st = countState.current;
    if (!f) return;
    const limit = f.remote ? 2 : 4;
    while (st.inFlight < limit && st.queue.length > 0) {
      const job = st.queue.shift()!;
      st.inFlight++;
      f.list(job.path)
        .then(
          (l): ChildCount => ({ all: l.length, shown: l.filter((x) => !x.hidden).length }),
          (): ChildCount => null,
        )
        .then((c) => {
          if (st !== countState.current || !mounted.current) return;
          st.inFlight--;
          setCounts((m) => new Map(m).set(job.key, c));
          pumpCounts();
        });
    }
  }
  function wantCount(e: FileEntry) {
    if (!opts.active || phase !== "ready" || !e.is_dir) return;
    const key = countKey(e);
    const st = countState.current;
    if (st.seen.has(key)) return;
    st.seen.add(key);
    st.queue.push({ key, path: e.path });
    pumpCounts();
  }
  function countFor(e: FileEntry): number | null {
    const c = counts.get(countKey(e));
    return c ? (opts.showHidden ? c.all : c.shown) : null;
  }

  useEffect(() => {
    // Rows of the folder we just left no longer need counting.
    const st = countState.current;
    for (const j of st.queue) st.seen.delete(j.key);
    st.queue = [];
  }, [cwd]);

  function flash(text: string, tone: Note["tone"] = "ok") {
    window.clearTimeout(noteTimer.current);
    setNote({ text, tone });
    noteTimer.current = window.setTimeout(
      () => {
        if (mounted.current) setNote(null);
      },
      tone === "ok" ? 1800 : 4000,
    );
  }

  function changeLoc(next: Loc) {
    setLoc((prev) => (sameLoc(prev, next) ? prev : next));
  }
  function reconnect() {
    resumeRef.current = cwd || lastCwd.current;
    setGen((g) => g + 1);
  }
  function navigate(raw: string) {
    if (!fs || phase !== "ready") return;
    setCreating(null);
    setRenaming(null);
    void listInto(fs, normalizePath(raw, home, cwd, fs.remote), "navigate");
  }
  function goUp() {
    if (!fs || !cwd) return;
    const up = parentPath(cwd, fs.remote);
    if (up !== cwd) navigate(up);
  }
  function refresh(silent = false): Promise<boolean> {
    if (!fs || !cwd || phase !== "ready") return Promise.resolve(false);
    // A background refresh must not supersede a navigation that is still loading.
    if (silent && live.current.loading) return Promise.resolve(false);
    return listInto(fs, cwd, silent ? "silent" : "refresh");
  }
  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, asc: !s.asc } : { key, asc: true }));
  }

  function clickRow(entry: FileEntry, ctrl: boolean, shift: boolean) {
    const p = entry.path;
    if (shift && anchor) {
      const a = visible.findIndex((e) => e.path === anchor);
      const b = visible.findIndex((e) => e.path === p);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const range = visible.slice(lo, hi + 1).map((e) => e.path);
        setSelected((prev) => (ctrl ? new Set([...prev, ...range]) : new Set(range)));
        setCursor(p);
        return;
      }
    }
    if (ctrl) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(p)) next.delete(p);
        else next.add(p);
        return next;
      });
      setAnchor(p);
      return;
    }
    setSelected(new Set([p]));
    setAnchor(p);
  }
  function selectOnly(entry: FileEntry) {
    setSelected(new Set([entry.path]));
    setAnchor(entry.path);
  }
  function selectAll() {
    setSelected(new Set(visible.map((e) => e.path)));
  }
  function clearSelection() {
    setSelected(new Set());
    setAnchor(null);
  }
  function moveSelection(delta: number, extend: boolean, absolute?: number): string | null {
    if (visible.length === 0) return null;
    const from = cursor ?? anchor;
    const idx = from ? visible.findIndex((e) => e.path === from) : -1;
    const nextIdx =
      absolute !== undefined ? Math.max(0, Math.min(visible.length - 1, absolute)) : idx < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, idx + delta));
    const next = visible[nextIdx];
    const a = anchor ? visible.findIndex((e) => e.path === anchor) : -1;
    if (extend && a >= 0) {
      const [lo, hi] = a < nextIdx ? [a, nextIdx] : [nextIdx, a];
      setSelected(new Set(visible.slice(lo, hi + 1).map((e) => e.path)));
      setCursor(next.path);
    } else {
      setSelected(new Set([next.path]));
      setAnchor(next.path);
    }
    return next.path;
  }

  function exists(name: string, except?: string): boolean {
    return entries.some((e) => e.path !== except && sameName(e.name, name, !!fs?.remote));
  }

  function startCreate(kind: "folder" | "file") {
    if (phase !== "ready") return;
    setRenaming(null);
    setCreating({ kind, name: "" });
  }
  function editCreate(name: string) {
    if (creatingRef.current) setCreating({ ...creatingRef.current, name });
  }
  function cancelCreate() {
    setCreating(null);
    setError("");
  }
  async function commitCreate() {
    const c = creatingRef.current;
    if (!c || !fs || busyRef.current) return;
    const name = c.name.trim();
    if (!name) {
      setCreating(null);
      return;
    }
    const bad = invalidName(name, fs.remote);
    if (bad) return setError(bad);
    if (exists(name)) return setError(`"${name}" already exists here.`);
    const ep = epoch.current;
    setBusy(true);
    setError("");
    try {
      const target = joinPath(cwd, name, fs.remote);
      if (c.kind === "folder") await fs.mkdir(target);
      else await fs.writeText(target, "");
      if (ep !== epoch.current) return;
      setCreating(null);
      if (live.current.cwd !== cwd) return;
      await listInto(fs, cwd, "refresh");
      if (live.current.cwd !== cwd) return;
      setSelected(new Set([target]));
      setAnchor(target);
    } catch (e) {
      if (ep === epoch.current && mounted.current) setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  function startRename(entry: FileEntry) {
    setCreating(null);
    setRenaming({ path: entry.path, value: entry.name });
  }
  function editRename(value: string) {
    if (renamingRef.current) setRenaming({ ...renamingRef.current, value });
  }
  function cancelRename() {
    setRenaming(null);
    setError("");
  }
  async function commitRename() {
    const r = renamingRef.current;
    if (!r || !fs || busyRef.current) return;
    const entry = entries.find((e) => e.path === r.path);
    const name = r.value.trim();
    if (!entry || !name || name === entry.name) {
      setRenaming(null);
      return;
    }
    const bad = invalidName(name, fs.remote);
    if (bad) return setError(bad);
    if (exists(name, entry.path)) return setError(`"${name}" already exists here.`);
    const ep = epoch.current;
    setBusy(true);
    setError("");
    try {
      const to = joinPath(cwd, name, fs.remote);
      await fs.rename(entry.path, to);
      if (ep !== epoch.current) return;
      setRenaming(null);
      if (live.current.cwd !== cwd) return;
      await listInto(fs, cwd, "refresh");
      if (live.current.cwd !== cwd) return;
      setSelected(new Set([to]));
      setAnchor(to);
    } catch (e) {
      if (ep === epoch.current && mounted.current) setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeEntries(items: FileEntry[]) {
    if (!fs || items.length === 0) return;
    const ep = epoch.current;
    setBusy(true);
    setError("");
    const failed: string[] = [];
    for (const it of items) {
      try {
        await removeTree(fs, it);
      } catch (e) {
        failed.push(`${it.name} (${errText(e)})`);
      }
    }
    if (ep === epoch.current && mounted.current) {
      if (live.current.cwd === cwd) await listInto(fs, cwd, "refresh");
      if (failed.length) setError(`Could not delete ${failed.join(", ")}`);
    }
    setBusy(false);
  }

  async function isDirLink(entry: FileEntry): Promise<boolean> {
    if (!fs) return false;
    try {
      await fs.list(entry.path);
      return true;
    } catch {
      return false;
    }
  }

  /** Opens the inline editor. Resolves to the read error, or "" on success. */
  async function openEditor(entry: FileEntry, quiet = false): Promise<string> {
    if (!fs || busyRef.current) return "";
    const ep = epoch.current;
    setBusy(true);
    setError("");
    try {
      const raw = await fs.readText(entry.path);
      if (ep !== epoch.current || !mounted.current) return "";
      const eol = /\r\n/.test(raw) ? "\r\n" : "\n";
      const content = raw.replace(/\r\n?/g, "\n");
      setRenaming(null);
      setCreating(null);
      setEditing({ path: entry.path, name: entry.name, content, original: content, eol, saving: false, saved: false, error: "" });
      return "";
    } catch (e) {
      const msg = errText(e);
      if (ep === epoch.current && mounted.current && !(quiet && (TOO_LARGE.test(msg) || NOT_TEXT.test(msg)))) setError(msg);
      return msg;
    } finally {
      setBusy(false);
    }
  }
  function editText(content: string) {
    setEditing((s) => (s ? { ...s, content, saved: false } : s));
  }
  async function reopenAndSave() {
    if (loc.kind !== "remote" || !editing || editing.saving) return;
    const old = sid;
    const id = `sftp-${side}-${crypto.randomUUID()}`;
    setEditing((s) => (s ? { ...s, saving: true, error: "" } : s));
    try {
      await api.sftpOpen(id, loc.hostId);
    } catch (e) {
      if (mounted.current) setEditing((s) => (s ? { ...s, saving: false, error: errText(e) } : s));
      return;
    }
    if (!mounted.current) {
      void api.sftpClose(id).catch(() => {});
      return;
    }
    if (old) void api.sftpClose(old).catch(() => {});
    setSid(id);
    const { path, content, eol } = editing;
    try {
      await remoteFs(id).writeText(path, withEol(content, eol));
      if (mounted.current) setEditing((s) => (s && s.path === path ? { ...s, original: content, saving: false, saved: s.content === content } : s));
    } catch (e) {
      if (mounted.current) setEditing((s) => (s && s.path === path ? { ...s, saving: false, error: errText(e) } : s));
    }
  }
  async function saveEditor() {
    if (!fs || !editing || editing.saving) return;
    const { path, content, eol } = editing;
    setEditing((s) => (s ? { ...s, saving: true, error: "" } : s));
    try {
      await fs.writeText(path, withEol(content, eol));
      if (mounted.current) setEditing((s) => (s && s.path === path ? { ...s, original: content, saving: false, saved: s.content === content } : s));
    } catch (e) {
      if (mounted.current) setEditing((s) => (s && s.path === path ? { ...s, saving: false, error: errText(e) } : s));
    }
  }
  function closeEditor() {
    if (!editing) return;
    setEditing(null);
    void refresh(true);
  }
  function dismissEditorError() {
    setEditing((s) => (s ? { ...s, error: "" } : s));
  }

  return {
    side,
    loc,
    sid,
    phase,
    connectError,
    home,
    cwd,
    entries,
    visible,
    hiddenCount,
    loading,
    busy,
    error,
    selected,
    selectedEntries,
    anchor,
    sort,
    creating,
    renaming,
    editing,
    note,
    fs,
    isRemote: loc.kind === "remote",
    setError,
    setBusy,
    flash,
    wantCount,
    countFor,
    changeLoc,
    reconnect,
    navigate,
    goUp,
    refresh,
    toggleSort,
    clickRow,
    selectOnly,
    selectAll,
    clearSelection,
    moveSelection,
    startCreate,
    editCreate,
    cancelCreate,
    commitCreate,
    startRename,
    editRename,
    cancelRename,
    commitRename,
    removeEntries,
    isDirLink,
    openEditor,
    editText,
    saveEditor,
    reopenAndSave,
    closeEditor,
    dismissEditorError,
  };
}

type Pane = ReturnType<typeof usePane>;

// ---------------------------------------------------------------- small UI pieces

/**
 * Duration for a looping animation, scaled like every other animation by the
 * animation speed preference (it multiplies durations, as --anim-scale does). 0 = off.
 */
function useAnimDuration(base: number): number {
  const { animScale } = usePrefs();
  return animScale < 0.05 ? 0 : base * animScale;
}

function Spin({ on, children }: { on: boolean; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const duration = useAnimDuration(900);
  useEffect(() => {
    if (!on || !duration || !ref.current) return;
    const a = ref.current.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration, iterations: Infinity });
    return () => a.cancel();
  }, [on, duration]);
  return (
    <span ref={ref} style={{ display: "flex" }}>
      {children}
    </span>
  );
}

function Indeterminate({ height = 4 }: { height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const duration = useAnimDuration(1300);
  useEffect(() => {
    if (!duration || !ref.current) return;
    const a = ref.current.animate([{ transform: "translateX(-100%)" }, { transform: "translateX(290%)" }], { duration, iterations: Infinity, easing: "ease-in-out" });
    return () => a.cancel();
  }, [duration]);
  return (
    <div role="progressbar" aria-label="In progress" style={{ height, borderRadius: height / 2, background: "var(--bg-raised)", overflow: "hidden" }}>
      <div ref={ref} style={{ width: "35%", height: "100%", borderRadius: height / 2, background: "var(--accent)" }} />
    </div>
  );
}

function StatusLine({ error, action, onDismiss, children }: { error: string; action?: ReactNode; onDismiss?(): void; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, height: 26, flex: "none", padding: "0 4px 0 10px", borderTop: "1px solid var(--line-soft)", background: error ? "var(--err-tint)" : undefined, fontSize: 12, color: "var(--text-2)", boxSizing: "border-box" }}>
      {error ? (
        <>
          <span style={{ display: "flex", flex: "none", color: "var(--err)" }}>
            <WarningIcon size={12} />
          </span>
          <span role="alert" data-selectable title={error} style={{ ...ellipsis, flex: 1, minWidth: 0, color: "var(--err)" }}>
            {error}
          </span>
          {action}
          {onDismiss && (
            <button type="button" aria-label="Dismiss" title="Dismiss" onClick={onDismiss} style={{ ...smallIconBtn, width: 20, height: 20, flex: "none", color: "var(--err)" }}>
              <CloseIcon />
            </button>
          )}
        </>
      ) : (
        children
      )}
    </div>
  );
}

function NoteText({ note }: { note: Note }) {
  return (
    <span role="status" style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, color: note.tone === "ok" ? "var(--ok)" : "var(--text-2)" }}>
      {note.tone === "ok" && (
        <span style={{ display: "flex", flex: "none" }}>
          <CheckIcon size={12} />
        </span>
      )}
      <span title={note.text} style={ellipsis}>
        {note.text}
      </span>
    </span>
  );
}

function Btn({
  children,
  onClick,
  disabled = false,
  title,
  style,
  ariaLabel,
}: {
  children: ReactNode;
  onClick(ev: ReactMouseEvent<HTMLButtonElement>): void;
  disabled?: boolean;
  title?: string;
  style: CSSProperties;
  ariaLabel?: string;
}) {
  // aria-disabled instead of disabled so the tooltip explaining why still shows.
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={(ev) => {
        if (!disabled) onClick(ev);
      }}
      style={disabledStyle(style, disabled)}
    >
      {children}
    </button>
  );
}

type MenuEntry = { label: string; onSelect(): void; disabled?: boolean; title?: string; danger?: boolean; hint?: string } | null;

function MenuButton({ item, onClose }: { item: Exclude<MenuEntry, null>; onClose(): void }) {
  const [hover, setHover] = useState(false);
  const off = !!item.disabled;
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={off || undefined}
      title={item.title ?? item.label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      onClick={() => {
        if (off) return;
        onClose();
        item.onSelect();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        height: 28,
        padding: "0 10px",
        border: 0,
        borderRadius: 4,
        background: hover && !off ? "var(--sel)" : "transparent",
        color: off ? "var(--text-3)" : item.danger ? "var(--err)" : "var(--text)",
        fontSize: 12.5,
        textAlign: "left",
        cursor: off ? "default" : "pointer",
        outline: "none",
        whiteSpace: "nowrap",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
      {item.hint && <span style={{ flex: "none", fontSize: 11.5, color: "var(--text-3)" }}>{item.hint}</span>}
    </button>
  );
}

function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if ((!a || a === document.body || !a.isConnected) && prev?.isConnected) prev.focus({ preventScroll: true });
      });
    };
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
    const top = y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y;
    setPos({ left, top });
    el.querySelector<HTMLButtonElement>("button:not([aria-disabled])")?.focus();
  }, [x, y]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([aria-disabled])") ?? [])];
    if (btns.length === 0) return;
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const n = e.key === "ArrowDown" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
    btns[n].focus();
  };
  return (
    <>
      <div
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 100 }}
      />
      <div
        ref={ref}
        role="menu"
        onKeyDown={onKeyDown}
        style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 101, minWidth: 200, maxWidth: 360, display: "flex", flexDirection: "column", padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)" }}
      >
        {items.map((it, i) =>
          it === null ? (
            <div key={`sep-${i}`} role="separator" style={{ height: 1, margin: "4px 2px", background: "var(--line-soft)" }} />
          ) : (
            <MenuButton key={`${it.label}-${i}`} item={it} onClose={onClose} />
          ),
        )}
      </div>
    </>
  );
}

interface ChoiceSpec {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  secondary?: { label: string; onSelect(): void };
}

/** Non-destructive question with up to three answers. Escape and a backdrop click cancel. */
function ChoiceDialog({ spec, onClose }: { spec: ChoiceSpec; onClose(): void }) {
  const ref = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const z = useModalLayer(ref, { onEscape: onClose, initialFocus: spec.danger ? cancelRef : confirmRef });
  const btn: CSSProperties = { height: 32, padding: "0 14px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: "inherit", cursor: "pointer", whiteSpace: "nowrap", outlineColor: "var(--focus)", outlineOffset: 2 };
  // Listed in macOS order (primary last); Windows and Linux put the primary action first.
  const buttons = [
    <button key="cancel" ref={cancelRef} type="button" onClick={onClose} style={btn}>
      Cancel
    </button>,
    spec.secondary && (
      <button
        key="secondary"
        type="button"
        onClick={() => {
          onClose();
          spec.secondary?.onSelect();
        }}
        style={btn}
      >
        {spec.secondary.label}
      </button>
    ),
    <button
      key="confirm"
      ref={confirmRef}
      type="button"
      onClick={() => {
        onClose();
        spec.onConfirm();
      }}
      style={spec.danger ? { ...btn, border: "1px solid var(--err)", background: "transparent", color: "var(--err)" } : { ...btn, padding: "0 16px", border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500 }}
    >
      {spec.confirmLabel}
    </button>,
  ].filter(Boolean);
  return (
    <Overlay z={z} onBackdrop={spec.danger ? undefined : onClose}>
      <section ref={ref} role={spec.danger ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1} style={{ width: 440, maxWidth: "100%", maxHeight: "100%", overflow: "auto", display: "flex", flexDirection: "column", gap: 18, padding: 24, borderRadius: 12, background: "var(--bg)", color: "var(--text)", boxShadow: "var(--shadow)", boxSizing: "border-box", outline: "none" }}>
        <div>
          <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {spec.title}
          </h2>
          <p id={descId} style={{ margin: "6px 0 0", color: "var(--text-2)", overflowWrap: "anywhere" }}>
            {spec.message}
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>{IS_MAC ? buttons : buttons.reverse()}</div>
      </section>
    </Overlay>
  );
}

type DialogSpec = ({ kind: "choice" } & ChoiceSpec) | { kind: "delete"; title: string; message: string; confirmLabel: string; onConfirm(): Promise<void> };

// ---------------------------------------------------------------- transfers

type TransferState = "queued" | "running" | "done" | "failed" | "canceled";

/**
 * A queued copy between this computer and a host, or between two hosts. It names hosts,
 * not sessions: the sessions are looked up when the job starts, so a reconnected pane can
 * run or retry it. For a copy between hosts `local` holds the source path on srcHostId.
 */
interface Transfer {
  id: string;
  kind: "up" | "down" | "copy";
  name: string;
  /** Folder the item lands in, shown as "to <target>". */
  target: string;
  hostId: string;
  hostName: string;
  srcHostId?: string;
  srcHostName?: string;
  local: string;
  remote: string;
  isDir: boolean;
  state: TransferState;
  bytes: number;
  done: number;
  total: number | null;
  speed: number;
  error: string;
}

function runTransfer(t: Transfer, sid: string, srcSid: string | null, onProgress: Channel<api.TransferProgress>): Promise<number> {
  if (t.kind === "copy") return api.sftpCopyRemote(srcSid ?? sid, sid, t.id, t.local, t.remote, t.isDir, onProgress);
  return api.sftpTransfer(sid, t.id, t.kind === "up", t.isDir, t.local, t.remote, onProgress);
}

function fmtRate(bps: number): string {
  return `${fmtSize(Math.max(0, Math.round(bps)))}/s`;
}

interface LocalItem {
  path: string;
  name: string;
  is_dir: boolean;
}

function transferError(e: unknown): string {
  const m = errText(e);
  return /session not found/i.test(m) ? "The connection for this transfer was closed." : m;
}

async function statLocal(paths: string[]): Promise<LocalItem[]> {
  const listings = new Map<string, FileEntry[] | null>();
  const out: LocalItem[] = [];
  for (const path of paths) {
    const parent = parentPath(path, false);
    if (!listings.has(parent)) listings.set(parent, await api.localList(parent).catch(() => null));
    const name = baseName(path);
    const hit = listings.get(parent)?.find((e) => sameName(e.name, name, false));
    out.push({ path, name, is_dir: hit ? hit.is_dir : false });
  }
  return out;
}

function TransferRow({ t, retryBlocked, onCancel, onRetry }: { t: Transfer; retryBlocked: string | null; onCancel(): void; onRetry(): void }) {
  const dirLabel = t.kind === "up" ? "Upload" : t.kind === "down" ? "Download" : "Copy between hosts";
  let bar: ReactNode;
  let status: ReactNode;
  let action: ReactNode = <span />;
  if (t.state === "running") {
    const pct = t.total && t.total > 0 ? Math.min(100, Math.floor((t.done / t.total) * 100)) : null;
    bar =
      pct === null ? (
        <Indeterminate />
      ) : (
        <div role="progressbar" aria-label={`${t.name} progress`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 4, borderRadius: 2, background: "var(--bg-raised)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", borderRadius: 2, background: "var(--accent)", transition: "width 200ms linear" }} />
        </div>
      );
    const rate = t.speed > 0 ? `, ${fmtRate(t.speed)}` : "";
    status = <span style={{ fontSize: 12, color: "var(--text-2)", whiteSpace: "nowrap" }}>{pct === null ? `${fmtSize(t.done)}${rate}` : `${pct}%${rate}`}</span>;
    action = (
      <Btn ariaLabel={`Cancel ${t.name}`} title="Cancel" onClick={onCancel} style={smallIconBtn}>
        <CloseIcon />
      </Btn>
    );
  } else if (t.state === "canceled") {
    bar = <span />;
    status = <span style={{ fontSize: 12, color: "var(--text-2)" }}>Canceled</span>;
    action = (
      <Btn ariaLabel={`Retry ${t.name}`} title={retryBlocked ?? "Retry"} disabled={!!retryBlocked} onClick={onRetry} style={smallIconBtn}>
        <RefreshIcon size={12} />
      </Btn>
    );
  } else if (t.state === "queued") {
    bar = <span />;
    status = <span style={{ fontSize: 12, color: "var(--text-2)" }}>Queued</span>;
    action = (
      <Btn ariaLabel={`Cancel ${t.name}`} title="Cancel" onClick={onCancel} style={smallIconBtn}>
        <CloseIcon />
      </Btn>
    );
  } else if (t.state === "done") {
    bar = <span />;
    status = (
      <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-2)", whiteSpace: "nowrap" }}>
        <span style={{ display: "flex", color: "var(--ok)" }}>
          <CheckIcon />
        </span>
        <span style={srOnly}>Done,</span>
        {fmtSize(t.bytes)}
      </span>
    );
  } else {
    bar = <span />;
    status = (
      <span style={{ fontSize: 12, color: "var(--err)", whiteSpace: "nowrap" }}>Failed</span>
    );
    action = (
      <Btn ariaLabel={`Retry ${t.name}`} title={retryBlocked ?? "Retry"} disabled={!!retryBlocked} onClick={onRetry} style={smallIconBtn}>
        <RefreshIcon size={12} />
      </Btn>
    );
  }
  return (
    <div style={transferRow}>
      <span role="img" aria-label={dirLabel} title={t.kind === "copy" ? `From ${t.srcHostName ?? "another host"} to ${t.hostName}` : undefined} style={{ color: "var(--text-2)", display: "flex" }}>
        {t.kind === "up" ? <UploadIcon /> : t.kind === "down" ? <DownloadIcon /> : <CopyIcon />}
      </span>
      <span title={t.name} style={ellipsis}>
        {t.name}
      </span>
      {t.state === "failed" ? (
        <span data-selectable title={t.error} style={{ ...ellipsis, fontSize: 12, color: "var(--err)" }}>
          {t.error}
        </span>
      ) : (
        <span title={`to ${t.target}`} style={{ ...ellipsis, fontFamily: MONO, fontSize: 12, color: "var(--text-2)" }}>
          to {t.target}
        </span>
      )}
      {bar}
      {status}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- pane view

interface PaneHandlers {
  onFocus(): void;
  onRowMouseDown(entry: FileEntry, ev: ReactMouseEvent): void;
  onRowClick(entry: FileEntry, ev: ReactMouseEvent): void;
  onRowMenu(entry: FileEntry, x: number, y: number): void;
  onBackgroundMenu(x: number, y: number): void;
  onOpen(entry: FileEntry): void;
  onDelete(entries: FileEntry[]): void;
  onCloseEditor(): void;
}

function PaneView({
  pane,
  hosts,
  stacked,
  focused,
  focusReq,
  dropHint,
  dragTarget,
  h,
}: {
  pane: Pane;
  hosts: Host[];
  stacked: boolean;
  /** This pane receives the toolbar's New folder and New file. */
  focused: boolean;
  focusReq: { n: number; now: boolean } | null;
  dropHint: { dir: string | null } | null;
  dragTarget: { dir: string | null } | null;
  h: PaneHandlers;
}) {
  const uid = useId();
  const [pathDraft, setPathDraft] = useState(pane.cwd);
  const [hoverPath, setHoverPath] = useState<string | null>(null);
  const [width, setWidth] = useState(600);
  const [listFocus, setListFocus] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const wantFocus = useRef(false);

  const takeFocus = useCallback((el: HTMLDivElement) => {
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected || !!sectionRef.current?.closest("main")?.contains(a)) el.focus({ preventScroll: true });
  }, []);
  const setListRef = useCallback(
    (el: HTMLDivElement | null) => {
      listRef.current = el;
      if (el && wantFocus.current) {
        wantFocus.current = false;
        takeFocus(el);
      }
    },
    [takeFocus],
  );
  useEffect(() => {
    wantFocus.current = false;
    if (!focusReq) return;
    const el = listRef.current;
    if (focusReq.now && el) takeFocus(el);
    else wantFocus.current = true;
  }, [focusReq?.n]);

  useEffect(() => setPathDraft(pane.cwd), [pane.cwd]);
  const inlineOpen = !!pane.renaming || !!pane.creating || !!pane.editing;
  const wasInline = useRef(inlineOpen);
  useEffect(() => {
    if (wasInline.current && !inlineOpen) {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (!a || a === document.body || !a.isConnected) listRef.current?.focus({ preventScroll: true });
      });
    }
    wasInline.current = inlineOpen;
  }, [inlineOpen]);
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const host = pane.loc.kind === "remote" ? hosts.find((x) => x.id === (pane.loc as { hostId: string }).hostId) ?? null : null;
  const label = pane.loc.kind === "local" ? "This computer" : host?.name ?? "host";
  const remote = pane.isRemote;
  const showPerms = remote && width >= 470;
  const showModified = width >= 400;
  const ready = pane.phase === "ready";
  const atRoot = !pane.fs || !pane.cwd || parentPath(pane.cwd, remote) === pane.cwd;
  const locValue = pane.loc.kind === "local" ? "local" : pane.loc.kind === "remote" ? `host:${pane.loc.hostId}` : "";
  const editorOpen = !!pane.editing;

  useEffect(() => {
    if (hoverPath && (!ready || editorOpen || !pane.visible.some((e) => e.path === hoverPath))) setHoverPath(null);
  }, [hoverPath, ready, editorOpen, pane.visible]);

  useEffect(() => {
    const root = listRef.current;
    if (!root || !ready || editorOpen) return;
    const byPath = new Map(pane.visible.filter((e) => e.is_dir).map((e) => [e.path, e]));
    if (byPath.size === 0) return;
    const io = new IntersectionObserver(
      (seen) => {
        for (const it of seen) {
          const e = it.isIntersecting ? byPath.get((it.target as HTMLElement).dataset.countPath ?? "") : undefined;
          if (e) paneRef.current.wantCount(e);
        }
      },
      { root, rootMargin: "200px 0px" },
    );
    root.querySelectorAll<HTMLElement>("tr[data-count-path]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [pane.visible, ready, editorOpen]);

  const onKeyDown = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((ev.target as HTMLElement).closest("input, textarea, select, button")) return;
    const sel = pane.selectedEntries;
    const mod = ev.ctrlKey || ev.metaKey;
    const scrollTo = (p: string | null) => {
      if (p) rowRefs.current.get(p)?.scrollIntoView({ block: "nearest" });
    };
    const pageRows = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 300) / 32) - 1);
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      scrollTo(pane.moveSelection(ev.key === "ArrowDown" ? 1 : -1, ev.shiftKey));
    } else if (ev.key === "Home" || ev.key === "End") {
      ev.preventDefault();
      scrollTo(pane.moveSelection(0, ev.shiftKey, ev.key === "Home" ? 0 : pane.visible.length - 1));
    } else if (ev.key === "PageDown" || ev.key === "PageUp") {
      ev.preventDefault();
      scrollTo(pane.moveSelection(ev.key === "PageDown" ? pageRows : -pageRows, ev.shiftKey));
    } else if (ev.key === "F5" || (mod && ev.key.toLowerCase() === "r")) {
      ev.preventDefault();
      void pane.refresh();
    } else if (ev.key === "Enter" && sel.length === 1) {
      ev.preventDefault();
      h.onOpen(sel[0]);
    } else if (ev.key === "Delete" && sel.length > 0) {
      ev.preventDefault();
      h.onDelete(sel);
    } else if (ev.key === "F2" && sel.length === 1) {
      ev.preventDefault();
      pane.startRename(sel[0]);
    } else if (ev.key === "Backspace") {
      ev.preventDefault();
      pane.goUp();
    } else if (ev.key === "Escape" && pane.selected.size > 0) {
      ev.preventDefault();
      pane.clearSelection();
    } else if (mod && ev.key.toLowerCase() === "a") {
      ev.preventDefault();
      pane.selectAll();
    } else if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) {
      ev.preventDefault();
      const first = sel[0];
      const r = first ? rowRefs.current.get(first.path)?.getBoundingClientRect() : null;
      if (first && r) h.onRowMenu(first, r.left + 40, r.bottom);
      else {
        const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        h.onBackgroundMenu(box.left + 40, box.top + 40);
      }
    }
  };

  const sortHeader = (key: SortKey, text: string, align: "left" | "right" = "left") => {
    const activeSort = pane.sort.key === key;
    return (
      <th scope="col" aria-sort={activeSort ? (pane.sort.asc ? "ascending" : "descending") : "none"} style={{ ...th, textAlign: align }}>
        <button
          type="button"
          onClick={() => pane.toggleSort(key)}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, flexDirection: align === "right" ? "row-reverse" : "row", padding: 0, border: 0, background: "transparent", color: activeSort ? "var(--text)" : "inherit", fontWeight: 500, fontSize: "inherit", cursor: "pointer" }}
        >
          {text}
          {activeSort && (
            <span style={{ display: "flex", transform: pane.sort.asc ? "rotate(180deg)" : undefined }}>
              <ChevronIcon size={12} />
            </span>
          )}
        </button>
      </th>
    );
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px", borderBottom: "1px solid var(--line)", background: focused ? "var(--bg-sunken)" : undefined, boxShadow: focused ? "inset 0 2px 0 var(--focus)" : undefined }}>
      <label htmlFor={`${uid}-loc`} style={srOnly}>
        Location
      </label>
      <select
        id={`${uid}-loc`}
        value={locValue}
        onChange={(e) => {
          const v = e.target.value;
          pane.changeLoc(v === "local" ? { kind: "local" } : { kind: "remote", hostId: v.slice(5) });
        }}
        style={{ ...selectStyle, maxWidth: "min(180px, 40%)" }}
      >
        {pane.loc.kind === "none" && (
          <option value="" disabled>
            Choose a host
          </option>
        )}
        <option value="local">This computer</option>
        {hosts.map((x) => (
          <option key={x.id} value={`host:${x.id}`}>
            {x.name}
          </option>
        ))}
      </select>
      <Btn ariaLabel="Parent folder" title={ready && atRoot ? "Already at the top folder" : "Parent folder"} disabled={!ready || atRoot} onClick={() => pane.goUp()} style={iconBtn}>
        <ParentIcon />
      </Btn>
      <label htmlFor={`${uid}-path`} style={srOnly}>
        {remote ? "Remote path" : "Local path"}
      </label>
      <input
        id={`${uid}-path`}
        type="text"
        value={pathDraft}
        disabled={!ready}
        spellCheck={false}
        title="Type or paste a path, then press Enter"
        onChange={(e) => setPathDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") pane.navigate(pathDraft);
          else if (e.key === "Escape") {
            setPathDraft(pane.cwd);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => setPathDraft(pane.cwd)}
        style={disabledStyle(miniInput, !ready)}
      />
    </div>
  );

  let body: ReactNode;
  if (pane.phase === "idle") {
    body = (
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
        <span style={{ color: "var(--text-2)" }}>{hosts.length === 0 ? "No hosts yet. Add one under Hosts to browse its files." : "Choose a host to browse its files."}</span>
      </div>
    );
  } else if (pane.phase === "connecting") {
    body = (
      <div role="status" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--text-2)" }}>
        <Spin on>
          <RefreshIcon />
        </Spin>
        {pane.loc.kind === "local" ? "Opening this computer…" : `Connecting to ${label}…`}
      </div>
    );
  } else if (pane.phase === "error") {
    body = (
      <div role="alert" style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 10, background: "var(--err-tint)", color: "var(--err)" }}>
          <WarningIcon size={20} />
        </span>
        <span style={{ fontWeight: 600 }}>{pane.loc.kind === "local" ? "Could not open this computer" : `Could not connect to ${label}`}</span>
        <span style={{ maxWidth: 380, fontSize: 12, color: "var(--err)", overflowWrap: "anywhere" }}>{pane.connectError}</span>
        <button type="button" onClick={() => pane.reconnect()} style={toolBtn}>
          <RefreshIcon />
          Retry
        </button>
      </div>
    );
  } else {
    const rows = pane.visible;
    const colCount = 2 + (showModified ? 1 : 0) + (showPerms ? 1 : 0) + 1;
    body = (
      <div
        ref={setListRef}
        tabIndex={0}
        aria-label={`${label} files`}
        onKeyDown={onKeyDown}
        onFocus={(ev) => setListFocus(ev.target === ev.currentTarget && ev.currentTarget.matches(":focus-visible"))}
        onBlur={() => setListFocus(false)}
        onClick={(ev) => {
          if (!(ev.target as HTMLElement).closest("tr[data-row], thead, input, button")) pane.clearSelection();
        }}
        onContextMenu={(ev) => {
          if ((ev.target as HTMLElement).closest("tr[data-row], input")) return;
          ev.preventDefault();
          h.onBackgroundMenu(ev.clientX, ev.clientY);
        }}
        style={{ position: "relative", flex: 1, minHeight: 0, overflow: "auto", outline: "none", boxShadow: (dragTarget && !dragTarget.dir) || listFocus ? "inset 0 0 0 2px var(--focus)" : undefined }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: 12.5 }}>
          <colgroup>
            <col />
            <col style={{ width: 84 }} />
            {showModified && <col style={{ width: 128 }} />}
            {showPerms && <col style={{ width: 108 }} />}
            <col style={{ width: 34 }} />
          </colgroup>
          <thead>
            <tr>
              {sortHeader("name", "Name")}
              {sortHeader("size", "Size", "right")}
              {showModified && sortHeader("mtime", "Modified")}
              {showPerms && sortHeader("perm", "Permissions")}
              <th scope="col" style={th}>
                <span style={srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pane.creating && (
              <tr>
                <td style={nameCell} colSpan={colCount}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--text-2)", display: "flex" }}>{pane.creating.kind === "folder" ? <FolderIcon /> : <FileIcon />}</span>
                    <input
                      autoFocus
                      aria-label={pane.creating.kind === "folder" ? "New folder name" : "New file name"}
                      placeholder={pane.creating.kind === "folder" ? "Folder name" : "File name"}
                      value={pane.creating.name}
                      readOnly={pane.busy}
                      spellCheck={false}
                      onChange={(e) => pane.editCreate(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void pane.commitCreate();
                        else if (e.key === "Escape") {
                          e.stopPropagation();
                          pane.cancelCreate();
                        }
                      }}
                      onBlur={() => void pane.commitCreate()}
                      style={{ ...inlineInput, maxWidth: 360 }}
                    />
                  </span>
                </td>
              </tr>
            )}
            {rows.map((e) => {
              const isSel = pane.selected.has(e.path);
              const isDropDir = dragTarget?.dir === e.path || dropHint?.dir === e.path;
              const hidden = e.hidden;
              const realDir = e.is_dir && !e.is_symlink;
              const renamingThis = pane.renaming?.path === e.path;
              const count = e.is_dir ? pane.countFor(e) : null;
              return (
                <tr
                  key={e.path}
                  data-row=""
                  data-dir={realDir ? e.path : undefined}
                  data-count-path={e.is_dir ? e.path : undefined}
                  ref={(el) => {
                    if (el) rowRefs.current.set(e.path, el);
                    else rowRefs.current.delete(e.path);
                  }}
                  aria-selected={isSel}
                  onMouseEnter={() => setHoverPath(e.path)}
                  onMouseLeave={() => setHoverPath((p) => (p === e.path ? null : p))}
                  onMouseDown={(ev) => h.onRowMouseDown(e, ev)}
                  onClick={(ev) => h.onRowClick(e, ev)}
                  onDoubleClick={(ev) => {
                    if ((ev.target as HTMLElement).closest("input, button")) return;
                    h.onOpen(e);
                  }}
                  onContextMenu={(ev) => {
                    if ((ev.target as HTMLElement).closest("input")) return;
                    ev.preventDefault();
                    h.onRowMenu(e, ev.clientX, ev.clientY);
                  }}
                  style={{ background: isDropDir ? "var(--accent-tint)" : isSel ? "var(--sel)" : hoverPath === e.path ? "var(--bg-sunken)" : undefined, boxShadow: isDropDir ? "inset 0 0 0 1px var(--focus)" : undefined, cursor: "default" }}
                >
                  <td style={isSel && !isDropDir ? { ...nameCell, boxShadow: "inset 2px 0 0 var(--accent)" } : nameCell}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span title={e.is_symlink ? "Symbolic link" : undefined} style={{ color: "var(--text-2)", display: "flex", flex: "none" }}>
                        {e.is_symlink ? <LinkIcon /> : e.is_dir ? <FolderIcon /> : <FileIcon />}
                      </span>
                      {renamingThis ? (
                        <input
                          autoFocus
                          aria-label={`Rename ${e.name}`}
                          value={pane.renaming?.value ?? ""}
                          readOnly={pane.busy}
                          spellCheck={false}
                          onFocus={(ev) => {
                            const v = ev.currentTarget.value;
                            const dot = e.is_dir ? -1 : v.lastIndexOf(".");
                            ev.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length);
                          }}
                          onChange={(ev) => pane.editRename(ev.target.value)}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter") void pane.commitRename();
                            else if (ev.key === "Escape") {
                              ev.stopPropagation();
                              pane.cancelRename();
                            }
                          }}
                          onBlur={() => void pane.commitRename()}
                          style={inlineInput}
                        />
                      ) : (
                        <span title={e.name} style={{ ...ellipsis, color: hidden ? "var(--text-2)" : "var(--text)" }}>
                          {e.name}
                        </span>
                      )}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>{e.is_dir ? (count != null ? itemCount(count) : "") : fmtSize(e.size)}</td>
                  {showModified && (
                    <td title={e.mtime ? new Date(e.mtime * 1000).toLocaleString() : undefined} style={td}>
                      {e.mtime ? fmtDate(e.mtime) : ""}
                    </td>
                  )}
                  {showPerms && <td style={{ ...td, fontFamily: MONO, fontSize: 12 }}>{fmtPerms(e.permissions)}</td>}
                  <td style={{ ...td, padding: "0 6px" }}>
                    <button
                      type="button"
                      aria-label={`Actions for ${e.name}`}
                      title="Actions"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        const r = ev.currentTarget.getBoundingClientRect();
                        h.onRowMenu(e, r.left, r.bottom + 2);
                      }}
                      style={{ ...smallIconBtn, visibility: isSel || hoverPath === e.path ? "visible" : "hidden" }}
                    >
                      <DotsIcon />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && !pane.creating && (
          <div style={{ padding: "28px 16px", textAlign: "center", color: "var(--text-3)" }}>
            {pane.loading
              ? "Loading…"
              : pane.hiddenCount > 0
                ? `Only hidden files here. Turn on "Show hidden files" to see ${pane.hiddenCount === 1 ? "it" : "them"}.`
                : "This folder is empty."}
          </div>
        )}
      </div>
    );
  }

  const editor = pane.editing;
  const shown = pane.visible.length;
  const selCount = pane.selectedEntries.length;
  const footer = (
    <StatusLine
      error={pane.note ? "" : pane.error}
      action={
        remote &&
        CONN_ERROR.test(pane.error) && (
          <button type="button" onClick={() => pane.reconnect()} style={{ ...ghostBtn, height: 20, padding: "0 6px", color: "var(--err)", flex: "none" }}>
            Reconnect
          </button>
        )
      }
      onDismiss={() => pane.setError("")}
    >
      {pane.note ? (
        <NoteText note={pane.note} />
      ) : (
        <span style={{ ...ellipsis, flex: 1, minWidth: 0 }}>
          {ready && (selCount > 0 ? `${selCount} of ${itemCount(shown)} selected` : itemCount(shown))}
          {ready && pane.hiddenCount > 0 ? `, ${pane.hiddenCount} hidden` : ""}
        </span>
      )}
      {pane.busy && (
        <span role="status" aria-label="Working" title="Working…" style={{ display: "flex", flex: "none", marginLeft: "auto", padding: "0 6px" }}>
          <Spin on>
            <RefreshIcon size={12} />
          </Spin>
        </span>
      )}
    </StatusLine>
  );

  return (
    <section
      ref={sectionRef}
      data-pane={pane.side}
      aria-label={remote ? `Remote files on ${label}` : pane.loc.kind === "local" ? "Local files" : "Choose a host"}
      onMouseDown={h.onFocus}
      onFocus={h.onFocus}
      style={{
        position: "relative",
        flex: "1 1 0",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: pane.side === "left" && !stacked ? "1px solid var(--line)" : undefined,
        borderBottom: pane.side === "left" && stacked ? "1px solid var(--line)" : undefined,
      }}
    >
      {editor ? (
        <EditorView pane={pane} editor={editor} label={label} focused={focused} onClose={h.onCloseEditor} />
      ) : (
        <>
          {header}
          {body}
          {footer}
          {dropHint && (
            <div style={{ position: "absolute", inset: 8, zIndex: 5, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, border: "2px dashed var(--focus)", borderRadius: 8, background: "color-mix(in srgb, var(--bg) 88%, transparent)", pointerEvents: "none", textAlign: "center", padding: 16 }}>
              <span style={{ color: "var(--text)", display: "flex" }}>
                <UploadIcon size={22} />
              </span>
              <span style={{ fontWeight: 500 }}>Drop to upload to {label}</span>
              <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--text-2)", overflowWrap: "anywhere" }}>{dropHint.dir ?? pane.cwd}</span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function EditorView({ pane, editor, label, focused, onClose }: { pane: Pane; editor: Editing; label: string; focused: boolean; onClose(): void }) {
  const dirty = editor.content !== editor.original;
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => areaRef.current?.focus(), []);
  const error = editor.error || pane.error;
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 45, padding: "0 10px", borderBottom: "1px solid var(--line)", background: focused ? "var(--bg-sunken)" : undefined, boxShadow: focused ? "inset 0 2px 0 var(--focus)" : undefined, boxSizing: "border-box" }}>
        <span style={{ color: "var(--text-2)", display: "flex", flex: "none" }}>
          <FileIcon />
        </span>
        <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <span style={{ ...ellipsis, fontWeight: 600 }}>
            {editor.name}
            {dirty ? " •" : ""}
          </span>
          <span title={editor.path} style={{ ...ellipsis, fontFamily: MONO, fontSize: 11.5, color: "var(--text-2)" }}>
            {label}: {editor.path}
          </span>
        </span>
        <Btn onClick={onClose} disabled={editor.saving} style={toolBtn}>
          Close
        </Btn>
        <Btn onClick={() => void pane.saveEditor()} disabled={editor.saving || !dirty} title={`Save (${MOD}+S)`} style={primaryBtn}>
          <Stable text={editor.saving ? "Saving…" : "Save"} alts={["Save", "Saving…"]} />
        </Btn>
      </div>
      <textarea
        ref={areaRef}
        value={editor.content}
        aria-label={`Contents of ${editor.name}`}
        spellCheck={false}
        data-selectable
        onChange={(e) => pane.editText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            void pane.saveEditor();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (!editor.saving) onClose();
          } else if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            const el = e.currentTarget;
            el.setRangeText("\t", el.selectionStart, el.selectionEnd, "end");
            pane.editText(el.value);
          }
        }}
        style={{ flex: 1, minHeight: 0, width: "100%", margin: 0, padding: "10px 12px", border: 0, outline: "none", resize: "none", background: "var(--bg-sunken)", color: "var(--text)", fontFamily: MONO, fontSize: 12.5, lineHeight: 1.6, tabSize: 4, boxSizing: "border-box" }}
      />
      <StatusLine
        error={error}
        action={
          !!editor.error &&
          pane.isRemote &&
          CONN_ERROR.test(editor.error) && (
            <Btn onClick={() => void pane.reopenAndSave()} disabled={editor.saving} style={{ ...ghostBtn, height: 20, padding: "0 6px", color: "var(--err)", flex: "none" }}>
              Reconnect and save
            </Btn>
          )
        }
        onDismiss={() => (editor.error ? pane.dismissEditorError() : pane.setError(""))}
      >
        {pane.note ? <NoteText note={pane.note} /> : editor.saved && !dirty ? <NoteText note={{ text: "Saved", tone: "ok" }} /> : null}
      </StatusLine>
    </>
  );
}

// ---------------------------------------------------------------- screen

/** Files dragged in from the OS: the pane that would receive them, or a note why the spot does not accept them. */
interface OsDrop {
  side: Side | null;
  dir: string | null;
  note: string;
  x: number;
  y: number;
}

interface DragGhost {
  from: Side;
  label: string;
  x: number;
  y: number;
  over: Side | null;
  overDir: string | null;
  note: string;
}

function hitTest(x: number, y: number): { side: Side; dir: string | null } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const paneEl = el?.closest<HTMLElement>("[data-pane]");
  if (!el || !paneEl) return null;
  const row = el.closest<HTMLElement>("tr[data-dir]");
  return { side: paneEl.dataset.pane as Side, dir: row && paneEl.contains(row) ? row.dataset.dir ?? null : null };
}

export function SftpScreen({
  hosts,
  host,
  active,
  onOpenTerminal,
  openRequest,
  onStatus,
  onUnsavedChange,
}: {
  hosts: Host[];
  host: Host | null;
  active: boolean;
  onOpenTerminal?(h: Host): void;
  /** Bump to re-apply `host` to a pane even when it is the same host as before. */
  openRequest?: number;
  onStatus?(s: "connecting" | "connected" | "error" | "closed"): void;
  onUnsavedChange?(reason: string | null): void;
}) {
  const { sftpShowHidden, setSftpShowHidden, sftpAutoRefresh } = usePrefs();
  const [focus, setFocus] = useState<Side>("right");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [drag, setDrag] = useState<DragGhost | null>(null);
  const [osDrop, setOsDrop] = useState<OsDrop | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [transfersOpen, setTransfersOpen] = useState(false);
  const [popLeft, setPopLeft] = useState(16);
  const [stacked, setStacked] = useState(false);
  const [focusReq, setFocusReq] = useState<{ side: Side; n: number; now: boolean } | null>(null);
  const panesBoxRef = useRef<HTMLDivElement>(null);
  const transfersBtnRef = useRef<HTMLButtonElement>(null);
  const transfersPopRef = useRef<HTMLDivElement>(null);

  const paused = !!menu || !!dialog || !!drag;
  const paneOpts = { active, autoRefresh: sftpAutoRefresh, showHidden: sftpShowHidden, paused };
  const left = usePane("left", { kind: "local" }, paneOpts);
  const right = usePane("right", host ? { kind: "remote", hostId: host.id } : { kind: "none" }, paneOpts);
  const panes: Record<Side, Pane> = { left, right };
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const activeRef = useRef(active);
  activeRef.current = active;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const hostById = useCallback((id: string) => hosts.find((x) => x.id === id) ?? null, [hosts]);
  const paneLabel = (p: Pane) => (p.loc.kind === "local" ? "this computer" : p.loc.kind === "remote" ? hostById(p.loc.hostId)?.name ?? "host" : "");

  /** Points a pane somewhere else, asking first when its editor holds unsaved changes. */
  const switchPane = (side: Side, next: Loc, label: string) => {
    const p = panesRef.current[side];
    if (sameLoc(p.loc, next)) return;
    if (!isDirty(p)) return p.changeLoc(next);
    setDialog({
      kind: "choice",
      title: "Discard unsaved changes?",
      message: `${p.editing?.name ?? "This file"} has unsaved changes. Opening ${label} in this pane discards them.`,
      confirmLabel: "Discard and open",
      danger: true,
      onConfirm: () => panesRef.current[side].changeLoc(next),
    });
  };

  const handledRequest = useRef("");
  useEffect(() => {
    if (!host || !active) return;
    const key = `${host.id}\n${openRequest ?? ""}`;
    if (handledRequest.current === key) return;
    handledRequest.current = key;
    const ps = panesRef.current;
    const focusSide = (side: Side, now: boolean) => {
      setFocus(side);
      setFocusReq((r) => ({ side, n: (r?.n ?? 0) + 1, now }));
    };
    for (const s of SIDES) {
      const p = ps[s];
      const l = p.loc;
      if (l.kind === "remote" && l.hostId === host.id) {
        if (p.phase === "error") p.reconnect();
        focusSide(s, p.phase === "ready");
        return;
      }
    }
    // Keep the pane that shows this computer so transfers stay possible.
    const replaceable = (["right", "left"] as Side[]).filter((s) => ps[s].loc.kind !== "local");
    const candidates: Side[] = replaceable.length > 0 ? replaceable : ["right", "left"];
    const side = candidates.find((s) => !isDirty(ps[s])) ?? candidates[0];
    switchPane(side, { kind: "remote", hostId: host.id }, host.name);
    focusSide(side, false);
  }, [host?.id, openRequest, active]);

  const openedTarget = useRef<Record<Side, string>>({ left: "", right: "" });
  const targetOf = (hostId: string) => {
    const x = hosts.find((h) => h.id === hostId);
    return x ? `${x.username}@${x.hostname}:${x.port}>${x.jump_host_id ?? ""}` : "";
  };
  useEffect(() => {
    for (const sd of SIDES) {
      const p = panesRef.current[sd];
      if (p.loc.kind !== "remote" || p.phase !== "ready") {
        if (p.phase !== "ready") openedTarget.current[sd] = "";
        continue;
      }
      const now = targetOf(p.loc.hostId);
      const was = openedTarget.current[sd];
      if (!was) openedTarget.current[sd] = now;
      else if (now && was !== now && !isDirty(p)) {
        openedTarget.current[sd] = "";
        p.reconnect();
      }
    }
  }, [hosts, left.phase, right.phase, left.loc, right.loc]);

  // A pane whose host was deleted is reset, unless its editor still holds unsaved changes;
  // the open session keeps working until the editor is closed.
  const dirtyKey = `${isDirty(left)}:${isDirty(right)}`;
  useEffect(() => {
    for (const s of SIDES) {
      const p = panesRef.current[s];
      const l = p.loc;
      if (l.kind === "remote" && !hosts.some((x) => x.id === l.hostId) && !isDirty(p)) p.changeLoc({ kind: "none" });
    }
  }, [hosts, dirtyKey]);

  useEffect(() => {
    const el = panesBoxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStacked(e.contentRect.width < 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!active) {
      // A hidden screen must not keep a modal open: it would trap focus and keys app-wide.
      setMenu(null);
      setDialog(null);
      setDrag(null);
      setOsDrop(null);
      setTransfersOpen(false);
    }
  }, [active]);

  // ---- transfer queue, run one at a time

  const runningRef = useRef(false);
  const enqueue = useCallback((jobs: Transfer[]) => {
    if (jobs.length === 0) return;
    setTransfers((ts) => [...ts, ...jobs]);
  }, []);

  /** The open, ready session for a host in either pane, if any. */
  const sessionFor = (hostId: string): string | null => {
    for (const s of SIDES) {
      const p = panesRef.current[s];
      if (p.loc.kind === "remote" && p.loc.hostId === hostId && p.phase === "ready" && p.sid) return p.sid;
    }
    return null;
  };
  const hostLabel = (t: Transfer) => hostById(t.hostId)?.name ?? t.hostName;
  const missingSession = (t: Transfer): string | null => {
    if (!sessionFor(t.hostId)) return `Open ${hostLabel(t)} in a pane to retry.`;
    if (t.kind === "copy" && t.srcHostId && !sessionFor(t.srcHostId)) return `Open ${hostById(t.srcHostId)?.name ?? t.srcHostName ?? "the source host"} in a pane to retry.`;
    return null;
  };
  const canceledIds = useRef(new Set<string>());

  useEffect(() => {
    if (runningRef.current) return;
    const next = transfers.find((t) => t.state === "queued");
    if (!next) return;
    const settle = (patch: Partial<Transfer>) => {
      runningRef.current = false;
      if (!mounted.current) return;
      setTransfers((ts) => ts.map((t) => (t.id === next.id ? { ...t, ...patch } : t)));
      // Also after a failure: a folder transfer may have copied part of its contents.
      for (const s of SIDES) {
        const p = panesRef.current[s];
        const showsTarget =
          p.phase === "ready" &&
          p.cwd === next.target &&
          (next.kind === "down" ? p.loc.kind === "local" : p.loc.kind === "remote" && p.loc.hostId === next.hostId);
        if (showsTarget) void p.refresh(true);
      }
    };
    const sid = sessionFor(next.hostId);
    const srcSid = next.kind === "copy" && next.srcHostId ? sessionFor(next.srcHostId) : null;
    runningRef.current = true;
    const missing = missingSession(next);
    if (!sid || missing) {
      settle({ state: "failed", error: missing ?? `Open ${hostLabel(next)} in a pane to retry.` });
      return;
    }
    canceledIds.current.delete(next.id);
    setTransfers((ts) => ts.map((t) => (t.id === next.id ? { ...t, state: "running", done: 0, total: null, speed: 0 } : t)));
    const channel = new Channel<api.TransferProgress>();
    let last = { at: performance.now(), done: 0 };
    let speed = 0;
    channel.onmessage = (pr) => {
      if (!mounted.current) return;
      const now = performance.now();
      const dt = (now - last.at) / 1000;
      if (dt >= 0.15) {
        const inst = Math.max(0, pr.done - last.done) / dt;
        speed = speed === 0 ? inst : speed * 0.6 + inst * 0.4;
        last = { at: now, done: pr.done };
      }
      setTransfers((ts) => ts.map((t) => (t.id === next.id && t.state === "running" ? { ...t, done: pr.done, total: pr.total, speed } : t)));
    };
    runTransfer(next, sid, srcSid, channel).then(
      (bytes) => settle({ state: "done", bytes, done: bytes }),
      (e) => settle(canceledIds.current.delete(next.id) || /^cancel+ed$/i.test(errText(e)) ? { state: "canceled", error: "" } : { state: "failed", error: transferError(e) }),
    );
  }, [transfers]);

  const cancelTransfer = (t: Transfer) => {
    if (t.state === "queued") {
      setTransfers((ts) => ts.map((x) => (x.id === t.id && x.state === "queued" ? { ...x, state: "canceled" } : x)));
      return;
    }
    if (t.state !== "running") return;
    canceledIds.current.add(t.id);
    void api.sftpCancel(t.id).catch(() => {});
  };

  const counts = useMemo(() => {
    const c = { running: 0, queued: 0, done: 0, failed: 0, canceled: 0 };
    for (const t of transfers) c[t.state]++;
    return c;
  }, [transfers]);

  const hasTransfers = transfers.length > 0;
  const finishedCount = counts.done + counts.failed + counts.canceled;
  const transferSummary = (["running", "queued", "done", "failed", "canceled"] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`)
    .join(", ");
  const runningTransfer = transfers.find((t) => t.state === "running") ?? null;
  const runningPct = runningTransfer?.total ? Math.min(100, Math.floor((runningTransfer.done / runningTransfer.total) * 100)) : null;
  useEffect(() => {
    if (!hasTransfers) setTransfersOpen(false);
  }, [hasTransfers]);
  useEffect(() => {
    if (!transfersOpen) return;
    transfersPopRef.current?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (transfersPopRef.current?.contains(t) || transfersBtnRef.current?.contains(t)) return;
      setTransfersOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setTransfersOpen(false);
      transfersBtnRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [transfersOpen]);
  const toggleTransfers = () => {
    setPopLeft(transfersBtnRef.current?.offsetLeft ?? 16);
    setTransfersOpen((o) => !o);
  };

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const hostPane = host ? SIDES.map((sd) => panes[sd]).find((p) => p.loc.kind === "remote" && p.loc.hostId === host.id) : undefined;
  const hostPhase = hostPane?.phase ?? "idle";
  useEffect(() => {
    onStatusRef.current?.(hostPhase === "ready" ? "connected" : hostPhase === "connecting" ? "connecting" : hostPhase === "error" ? "error" : "closed");
  }, [hostPhase]);

  const unsavedRef = useRef(onUnsavedChange);
  unsavedRef.current = onUnsavedChange;
  const dirtyEditor = SIDES.map((sd) => panes[sd]).find((p) => isDirty(p))?.editing?.name ?? null;
  const pendingTransfers = counts.running + counts.queued;
  const unsaved = dirtyEditor ? `${dirtyEditor} has unsaved changes.` : pendingTransfers > 0 ? `${pendingTransfers} ${pendingTransfers === 1 ? "transfer is" : "transfers are"} not finished.` : null;
  const reportsUnsaved = !!onUnsavedChange;
  useEffect(() => {
    unsavedRef.current?.(unsaved);
  }, [unsaved, reportsUnsaved]);
  useEffect(() => () => unsavedRef.current?.(null), []);

  const mkJob = (kind: "up" | "down" | "copy", hostId: string, item: { name: string; local: string; remote: string; isDir: boolean }, target: string, srcHostId?: string): Transfer => ({
    id: crypto.randomUUID(),
    kind,
    name: item.name,
    target,
    hostId,
    hostName: hostById(hostId)?.name ?? "the host",
    srcHostId,
    srcHostName: srcHostId ? hostById(srcHostId)?.name ?? "the host" : undefined,
    local: item.local,
    remote: item.remote,
    isDir: item.isDir,
    state: "queued",
    bytes: 0,
    done: 0,
    total: null,
    speed: 0,
    error: "",
  });

  /** Queues jobs, asking first when some names already exist in the target folder. */
  const queueChecked = (jobs: Transfer[], existing: FileEntry[], dir: string, remoteTarget: boolean) => {
    const clash = jobs.filter((j) => existing.some((x) => sameName(x.name, baseName(j.kind === "down" ? j.local : j.remote), remoteTarget)));
    if (clash.length === 0) return enqueue(jobs);
    const fresh = jobs.filter((j) => !clash.includes(j));
    const mono = (t: string) => <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--text)" }}>{t}</span>;
    setDialog({
      kind: "choice",
      title: clash.length === 1 ? "Replace existing item?" : "Replace existing items?",
      message:
        clash.length === 1 ? (
          <>
            {mono(clash[0].name)} already exists in {mono(dir)}. Replace it?
          </>
        ) : (
          <>
            {clash.length} items already exist in {mono(dir)}. Replace them?
          </>
        ),
      confirmLabel: "Replace",
      danger: true,
      onConfirm: () => enqueue(jobs),
      secondary: fresh.length > 0 ? { label: "Skip existing", onSelect: () => enqueue(fresh) } : undefined,
    });
  };

  const queueUploads = async (side: Side, items: LocalItem[], dir?: string) => {
    const p = panesRef.current[side];
    const sid = p.sid;
    if (!sid || p.loc.kind !== "remote" || p.phase !== "ready" || items.length === 0) return;
    const hostId = p.loc.hostId;
    const target = dir ?? p.cwd;
    const jobs = items.map((it) => mkJob("up", hostId, { name: it.name, local: it.path, remote: joinPath(target, it.name, true), isDir: it.is_dir }, target));
    const existing = target === p.cwd ? p.entries : await api.sftpList(sid, target).catch(() => [] as FileEntry[]);
    queueChecked(jobs, existing, target, true);
  };

  const queueDownloads = async (side: Side, items: FileEntry[], localDir: string, known?: FileEntry[]) => {
    const p = panesRef.current[side];
    if (p.loc.kind !== "remote" || items.length === 0) return;
    const hostId = p.loc.hostId;
    const skipped: string[] = [];
    const jobs: Transfer[] = [];
    for (const e of items) {
      const clean = safeName(e.name);
      if (!clean) {
        skipped.push(e.name);
        continue;
      }
      jobs.push(mkJob("down", hostId, { name: e.name, local: joinPath(localDir, clean, false), remote: e.path, isDir: e.is_dir }, localDir));
    }
    if (skipped.length) p.setError(`Skipped unsafe names: ${skipped.join(", ")}`);
    const existing = known ?? (await api.localList(localDir).catch(() => [] as FileEntry[]));
    queueChecked(jobs, existing, localDir, false);
  };

  const blockReason = (from: Side): string | null => {
    const src = panesRef.current[from];
    const dst = panesRef.current[otherSide(from)];
    if (src.phase !== "ready" || dst.phase !== "ready") return "Open a location in the other pane first.";
    if (!src.isRemote && !dst.isRemote) return "Both panes show this computer. Choose a host in one pane.";
    return null;
  };

  const queueCopies = async (from: Side, items: FileEntry[], dir: string) => {
    const src = panesRef.current[from];
    const dst = panesRef.current[otherSide(from)];
    if (src.loc.kind !== "remote" || dst.loc.kind !== "remote" || !dst.sid || items.length === 0) return;
    const srcHostId = src.loc.hostId;
    const dstHostId = dst.loc.hostId;
    if (srcHostId === dstHostId && dir === src.cwd) return src.setError("Source and target are the same folder.");
    const jobs = items.map((e) => mkJob("copy", dstHostId, { name: e.name, local: e.path, remote: joinPath(dir, e.name, true), isDir: e.is_dir }, dir, srcHostId));
    const existing = dir === dst.cwd ? dst.entries : await api.sftpList(dst.sid, dir).catch(() => [] as FileEntry[]);
    queueChecked(jobs, existing, dir, true);
  };

  const transferAcross = async (from: Side, items: FileEntry[], toDir?: string) => {
    const why = blockReason(from);
    const src = panesRef.current[from];
    if (why) return src.setError(why);
    if (items.length === 0) return;
    const dst = panesRef.current[otherSide(from)];
    const dir = toDir ?? dst.cwd;
    if (src.isRemote && dst.isRemote) {
      await queueCopies(from, items, dir);
    } else if (src.isRemote) {
      await queueDownloads(from, items, dir, dir === dst.cwd ? dst.entries : undefined);
    } else {
      await queueUploads(otherSide(from), items.map((e) => ({ path: e.path, name: e.name, is_dir: e.is_dir })), dir);
    }
  };

  const downloadPicked = async (side: Side, items: FileEntry[]) => {
    const p = panesRef.current[side];
    if (p.loc.kind !== "remote" || p.phase !== "ready" || items.length === 0) return;
    const hostId = p.loc.hostId;
    try {
      if (items.length === 1 && !items[0].is_dir) {
        const it = items[0];
        const dest = await saveDialog({ defaultPath: safeName(it.name) ?? undefined, title: "Save as" });
        if (!dest) return;
        enqueue([mkJob("down", hostId, { name: it.name, local: dest, remote: it.path, isDir: false }, parentPath(dest, false))]);
        return;
      }
      const dir = await openDialog({ directory: true, multiple: false, title: items.length === 1 ? `Download "${items[0].name}" into folder` : "Download to folder" });
      if (typeof dir !== "string" || !dir) return;
      await queueDownloads(side, items, dir);
    } catch (e) {
      p.setError(errText(e));
    }
  };

  const uploadPicked = async (side: Side, kind: "files" | "folders") => {
    const p = panesRef.current[side];
    try {
      const picked = await openDialog(kind === "files" ? { multiple: true, title: "Upload files" } : { directory: true, multiple: true, title: "Upload folders" });
      if (!picked) return;
      const paths = Array.isArray(picked) ? picked : [picked];
      await queueUploads(side, paths.map((path) => ({ path, name: baseName(path), is_dir: kind === "folders" })));
    } catch (e) {
      p.setError(errText(e));
    }
  };

  // ---- drag out to the OS (remote files), via a temp copy

  const tempPaths = useRef(new Set<string>());
  const tempDirs = useRef<{ path: string; isDir: boolean }[]>([]);
  const cleanTemp = () => {
    const list = tempDirs.current;
    tempDirs.current = [];
    for (const t of list) void api.localRemove(t.path, t.isDir).catch(() => {});
  };
  useEffect(() => cleanTemp, []);
  const dragOut = async (side: Side, items: FileEntry[]) => {
    const p = panesRef.current[side];
    const sid = p.sid;
    if (!sid) return;
    p.setBusy(true);
    cleanTemp();
    try {
      const base = await pathJoin(await tempDir(), `kestral-drag-${crypto.randomUUID()}`);
      let ownDir = true;
      try {
        await api.localMkdir(base);
        tempDirs.current.push({ path: base, isDir: true });
      } catch {
        ownDir = false;
      }
      const paths: string[] = [];
      for (const e of items) {
        const clean = safeName(e.name);
        if (!clean) continue;
        const dest = ownDir ? await pathJoin(base, clean) : `${base}-${clean}`;
        await api.sftpDownload(sid, e.path, dest);
        tempPaths.current.add(dest);
        if (!ownDir) tempDirs.current.push({ path: dest, isDir: false });
        paths.push(dest);
      }
      if (paths.length === 0) return;
      const icon = await invoke<string>("drag_icon_path");
      p.setBusy(false);
      await startDrag({ item: paths, icon });
    } catch (e) {
      p.setError(errText(e));
    } finally {
      p.setBusy(false);
    }
  };

  // ---- in-app drag between panes (pointer based; HTML5 drag and drop is taken over by the OS drop handler)

  const suppressClick = useRef(false);
  const onRowMouseDown = (side: Side, entry: FileEntry, ev: ReactMouseEvent) => {
    if (ev.button !== 0 || ev.ctrlKey || ev.shiftKey || ev.metaKey) return;
    if ((ev.target as HTMLElement).closest("input, button")) return;
    const p0 = panesRef.current[side];
    if (p0.renaming || p0.busy) return;
    const startX = ev.clientX;
    const startY = ev.clientY;
    let started = false;
    let items: FileEntry[] = [];
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", onKey, true);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
    const cancel = () => {
      stop();
      if (!started) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setDrag(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !started) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    const tryDragOut = () => {
      if (!panesRef.current[side].isRemote || items.some((e) => e.is_dir)) return false;
      stop();
      setDrag(null);
      void dragOut(side, items);
      return true;
    };
    const onMove = (e: MouseEvent) => {
      if ((e.buttons & 1) === 0) {
        cancel();
        return;
      }
      if (!started) {
        if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 5) return;
        started = true;
        const p = panesRef.current[side];
        items = p.selected.has(entry.path) ? p.selectedEntries : [entry];
        if (!p.selected.has(entry.path)) p.selectOnly(entry);
      }
      const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth - 1 || e.clientY >= window.innerHeight - 1;
      if (outside && tryDragOut()) return;
      const hit = hitTest(e.clientX, e.clientY);
      const over = hit && hit.side !== side ? hit.side : null;
      const why = over ? blockReason(side) : null;
      const src = panesRef.current[side];
      const dst = panesRef.current[otherSide(side)];
      const label = items.length === 1 ? items[0].name : `${items.length} items`;
      const dir = hit?.dir ?? dst.cwd;
      const note = !over
        ? src.isRemote && !items.some((x) => x.is_dir)
          ? "Drop on the other pane, or drag out of the window"
          : "Drop on the other pane"
        : why ?? (src.isRemote && dst.isRemote ? `Copy to ${paneLabel(dst)}:${dir}` : `${src.isRemote ? "Download" : "Upload"} to ${dir}`);
      setDrag({ from: side, label, x: e.clientX, y: e.clientY, over: why ? null : over, overDir: why ? null : hit?.dir ?? null, note });
    };
    const onLeave = () => {
      if (started) tryDragOut();
    };
    const onUp = (e: MouseEvent) => {
      stop();
      if (!started) return;
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      setDrag(null);
      const hit = hitTest(e.clientX, e.clientY);
      if (hit && hit.side !== side) void transferAcross(side, items, hit.dir ?? undefined);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("keydown", onKey, true);
    document.documentElement.addEventListener("mouseleave", onLeave);
  };

  // ---- files dropped from the OS onto a host pane

  const latest = useRef({ queueUploads, statLocal, paneLabel });
  latest.current = { queueUploads, statLocal, paneLabel };
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    let enterPaths: string[] = [];
    const ownDrag = (paths: string[]) => paths.length > 0 && paths.every((x) => tempPaths.current.has(x));
    const name = (s: Side) => latest.current.paneLabel(panesRef.current[s]);
    const eligible = (s: Side) => {
      const p = panesRef.current[s];
      return p.isRemote && p.phase === "ready" && !!p.sid && !p.editing;
    };
    const notReady = (s: Side, here: boolean) => {
      const p = panesRef.current[s];
      if (p.editing) return here ? "Close the editor to upload here." : `Close the editor on ${name(s)} to upload.`;
      if (p.phase === "error") return `Reconnect to ${name(s)} first.`;
      return `Wait until ${name(s)} is connected.`;
    };
    /** Where a drop at this point would go, or why it cannot. Drops outside the panes go to the only open host pane. */
    const resolve = (x: number, y: number): { side: Side | null; dir: string | null; note: string; errSide: Side | null } => {
      const hit = hitTest(x, y);
      const open = SIDES.filter(eligible);
      const remote = SIDES.find((s) => panesRef.current[s].isRemote);
      if (hit && eligible(hit.side)) return { side: hit.side, dir: hit.dir, note: "", errSide: null };
      if (hit) {
        let note: string;
        if (panesRef.current[hit.side].isRemote) note = notReady(hit.side, true);
        else if (open.length > 0) note = `Drop on the ${name(open[0])} pane to upload.`;
        else note = remote ? notReady(remote, false) : "Open a host in one pane to upload files.";
        return { side: null, dir: null, note, errSide: hit.side };
      }
      if (open.length === 1) return { side: open[0], dir: null, note: "", errSide: null };
      if (open.length > 1) return { side: null, dir: null, note: "Drop on a host pane to upload.", errSide: null };
      return { side: null, dir: null, note: remote ? notReady(remote, false) : "Open a host in one pane to upload files.", errSide: remote ?? null };
    };
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return;
    }
    webview
      .onDragDropEvent((event) => {
        if (!activeRef.current) return;
        const ev = event.payload;
        if (ev.type === "leave") {
          setOsDrop(null);
          return;
        }
        if (ev.type === "enter") enterPaths = ev.paths;
        const dpr = window.devicePixelRatio || 1;
        const x = ev.position.x / dpr;
        const y = ev.position.y / dpr;
        const r = resolve(x, y);
        if (ev.type === "enter" || ev.type === "over") {
          if (ownDrag(enterPaths)) return setOsDrop(null);
          setOsDrop((cur) => (cur && r.side && cur.side === r.side && cur.dir === r.dir ? cur : { side: r.side, dir: r.dir, note: r.note, x, y }));
          return;
        }
        setOsDrop(null);
        if (ev.paths.length === 0 || ownDrag(ev.paths)) return;
        const target = r.side;
        if (target) {
          void latest.current.statLocal(ev.paths).then((items) => latest.current.queueUploads(target, items, r.dir ?? undefined));
        } else {
          panesRef.current[r.errSide ?? focusRef.current].setError(r.note);
        }
      })
      .then((f) => {
        if (alive) off = f;
        else f();
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // ---- open, delete, menus

  const tooLargeHint = "Too large to edit. Use the menu or drag to transfer it.";
  const openEntry = async (side: Side, e: FileEntry) => {
    const p = panesRef.current[side];
    if (e.is_dir) return p.navigate(e.path);
    // Local listings report the link target's type and size; remote ones only describe the link.
    const remoteLink = e.is_symlink && p.isRemote;
    if (remoteLink && (await p.isDirLink(e))) return panesRef.current[side].navigate(e.path);
    if (!remoteLink && e.size > EDIT_LIMIT) return p.flash(tooLargeHint, "info");
    const err = await panesRef.current[side].openEditor(e, true);
    if (TOO_LARGE.test(err)) panesRef.current[side].flash(tooLargeHint, "info");
    else if (NOT_TEXT.test(err)) panesRef.current[side].flash("Not a text file. Use the menu or drag to transfer it.", "info");
  };

  const editEntry = async (side: Side, e: FileEntry) => {
    const p = panesRef.current[side];
    if (!(e.is_symlink && p.isRemote)) return void p.openEditor(e);
    if (await p.isDirLink(e)) return panesRef.current[side].setError(`${e.name} links to a folder, so it cannot be edited. Open it instead.`);
    void p.openEditor(e);
  };

  const askDelete = async (side: Side, items: FileEntry[]) => {
    const p = panesRef.current[side];
    if (!p.fs || items.length === 0) return;
    let title: string;
    let message: string;
    let confirmLabel = "Delete";
    if (items.length === 1) {
      const e = items[0];
      const realDir = e.is_dir && !e.is_symlink;
      title = realDir ? "Delete folder" : "Delete file";
      const count = realDir ? await p.fs.list(e.path).then((l) => l.length, () => 0) : 0;
      if (count > 0) {
        confirmLabel = "Delete all";
        message = `"${e.name}" contains ${itemCount(count)}. Delete the folder and everything inside? This cannot be undone.`;
      } else {
        message = `Delete "${e.name}"? This cannot be undone.`;
      }
    } else {
      title = `Delete ${items.length} items`;
      confirmLabel = "Delete all";
      message = `Delete the ${items.length} selected items? Folders are removed with all their contents. This cannot be undone.`;
    }
    if (!activeRef.current) return;
    setDialog({ kind: "delete", title, message, confirmLabel, onConfirm: () => panesRef.current[side].removeEntries(items) });
  };

  const copy = (side: Side, text: string, done: string) => {
    copyText(text).then(
      () => panesRef.current[side].flash(done),
      (e) => panesRef.current[side].setError(errText(e)),
    );
  };

  const transferMenuItem = (side: Side, items: FileEntry[]): MenuEntry => {
    const p = panesRef.current[side];
    const dst = panesRef.current[otherSide(side)];
    const why = blockReason(side);
    const what = items.length === 1 ? "" : ` ${items.length} items`;
    const label = why ? `Copy${what} to other pane` : p.isRemote && dst.isRemote ? `Copy${what} to ${paneLabel(dst)}` : p.isRemote ? `Download${what} to this computer` : `Upload${what} to ${paneLabel(dst)}`;
    return { label, disabled: !!why, title: why ?? `Into ${dst.cwd}`, onSelect: () => void transferAcross(side, items) };
  };

  const openRowMenu = (side: Side, entry: FileEntry, x: number, y: number) => {
    const p = panesRef.current[side];
    setFocus(side);
    const multi = p.selected.has(entry.path) && p.selected.size > 1;
    if (!p.selected.has(entry.path)) p.selectOnly(entry);
    const items = multi ? p.selectedEntries : [entry];
    const entries: MenuEntry[] = [];
    if (multi) {
      entries.push(transferMenuItem(side, items));
      if (p.isRemote) entries.push({ label: `Download ${items.length} items to…`, onSelect: () => void downloadPicked(side, items) });
      entries.push(null, { label: "Copy paths", onSelect: () => copy(side, items.map((e) => e.path).join("\n"), "Paths copied") });
      entries.push(null, { label: `Delete ${items.length} items`, danger: true, hint: "Del", onSelect: () => void askDelete(side, items) });
    } else {
      // Remote links list the link's own size; editEntry asks before reading their target.
      const remoteLink = entry.is_symlink && p.isRemote;
      const tooBig = !remoteLink && entry.size > EDIT_LIMIT;
      if (entry.is_dir) entries.push({ label: "Open", hint: "Enter", onSelect: () => p.navigate(entry.path) });
      else if (entry.is_symlink) entries.push({ label: "Open", hint: "Enter", onSelect: () => void openEntry(side, entry) });
      entries.push(transferMenuItem(side, items));
      if (p.isRemote) entries.push({ label: "Download to…", onSelect: () => void downloadPicked(side, items) });
      if (!entry.is_dir) {
        entries.push({
          label: "Edit",
          disabled: tooBig,
          title: tooBig ? "Files over 1 MB cannot be edited here" : remoteLink ? "Edit as text. The linked file's size is unknown." : "Edit as text",
          onSelect: () => void editEntry(side, entry),
        });
      }
      entries.push(null, { label: "Rename", hint: "F2", onSelect: () => p.startRename(entry) });
      entries.push({ label: "Copy path", onSelect: () => copy(side, entry.path, "Path copied") });
      entries.push(null, { label: "Delete", danger: true, hint: "Del", onSelect: () => void askDelete(side, items) });
    }
    setMenu({ x, y, items: entries });
  };

  const openBackgroundMenu = (side: Side, x: number, y: number) => {
    const p = panesRef.current[side];
    setFocus(side);
    p.clearSelection();
    const entries: MenuEntry[] = [
      { label: "New folder", onSelect: () => p.startCreate("folder") },
      { label: "New file", onSelect: () => p.startCreate("file") },
    ];
    if (p.isRemote) {
      entries.push(null, { label: "Upload files here…", onSelect: () => void uploadPicked(side, "files") }, { label: "Upload folders here…", onSelect: () => void uploadPicked(side, "folders") });
    }
    entries.push(
      null,
      { label: "Select all", hint: `${MOD}+A`, disabled: p.visible.length === 0, title: p.visible.length === 0 ? "This folder is empty" : undefined, onSelect: () => p.selectAll() },
      { label: "Copy folder path", onSelect: () => copy(side, p.cwd, "Folder path copied") },
    );
    setMenu({ x, y, items: entries });
  };

  const closeEditor = (side: Side) => {
    const p = panesRef.current[side];
    if (!p.editing) return;
    if (!isDirty(p)) return p.closeEditor();
    setDialog({
      kind: "choice",
      title: "Discard unsaved changes?",
      message: `${p.editing.name} has unsaved changes.`,
      confirmLabel: "Discard",
      danger: true,
      onConfirm: () => panesRef.current[side].closeEditor(),
    });
  };

  const handlersFor = (side: Side): PaneHandlers => ({
    onFocus: () => {
      setFocus(side);
      setFocusReq((r) => (r && r.side !== side ? null : r));
    },
    onRowMouseDown: (entry, ev) => onRowMouseDown(side, entry, ev),
    onRowClick: (entry, ev) => {
      if (suppressClick.current) return;
      if ((ev.target as HTMLElement).closest("input, button")) return;
      panesRef.current[side].clickRow(entry, ev.ctrlKey || ev.metaKey, ev.shiftKey);
    },
    onRowMenu: (entry, x, y) => openRowMenu(side, entry, x, y),
    onBackgroundMenu: (x, y) => openBackgroundMenu(side, x, y),
    onOpen: (entry) => void openEntry(side, entry),
    onDelete: (items) => void askDelete(side, items),
    onCloseEditor: () => closeEditor(side),
  });

  // ---- toolbar

  const focused = panes[focus];
  const remoteSide: Side | null = focused.isRemote ? focus : panes[otherSide(focus)].isRemote ? otherSide(focus) : null;
  const remotePane = remoteSide ? panes[remoteSide] : null;
  const localSide: Side | null = remoteSide && !panes[otherSide(remoteSide)].isRemote && panes[otherSide(remoteSide)].loc.kind === "local" ? otherSide(remoteSide) : null;
  const toolbarHost = remotePane && remotePane.loc.kind === "remote" ? hostById(remotePane.loc.hostId) : null;
  const remoteReady = !!remotePane && remotePane.phase === "ready";
  const localSel = localSide && panes[localSide].phase === "ready" ? panes[localSide].selectedEntries : [];
  const remoteSel = remoteReady && remotePane ? remotePane.selectedEntries : [];
  const createPane = focused.phase === "ready" ? focused : panes[otherSide(focus)].phase === "ready" ? panes[otherSide(focus)] : null;
  const anyLoading = left.loading || right.loading;

  const uploadDisabled = !remoteReady ? "Open a host in one of the panes first." : null;
  const downloadDisabled = !remoteReady ? "Open a host in one of the panes first." : remoteSel.length === 0 ? `Select files on ${toolbarHost?.name ?? "the host"} first.` : null;

  const openUploadMenu = (ev: ReactMouseEvent<HTMLButtonElement>) => {
    if (!remoteSide) return;
    const r = ev.currentTarget.getBoundingClientRect();
    const target = remoteSide;
    const items: MenuEntry[] = [];
    if (localSide) {
      items.push({
        label: localSel.length > 0 ? `Upload ${localSel.length === 1 ? `"${localSel[0].name}"` : `${localSel.length} selected items`}` : "Upload selected items",
        disabled: localSel.length === 0 || !!blockReason(localSide),
        title: localSel.length === 0 ? "Select files in the This computer pane first" : blockReason(localSide) ?? `Into ${panes[target].cwd}`,
        onSelect: () => void transferAcross(localSide, panesRef.current[localSide].selectedEntries),
      });
      items.push(null);
    }
    items.push({ label: "Files…", onSelect: () => void uploadPicked(target, "files") }, { label: "Folders…", onSelect: () => void uploadPicked(target, "folders") });
    setMenu({ x: r.left, y: r.bottom + 4, items });
  };

  const download = () => {
    if (!remoteSide) return;
    const items = panesRef.current[remoteSide].selectedEntries;
    if (localSide && panes[localSide].phase === "ready") void transferAcross(remoteSide, items);
    else void downloadPicked(remoteSide, items);
  };

  const refreshAll = () => {
    for (const s of SIDES) {
      const p = panesRef.current[s];
      if (p.phase === "error") p.reconnect();
      else if (p.phase === "ready" && !p.loading) void p.refresh();
    }
  };

  const canCreate = !!createPane && !createPane.editing;
  const createTitle = !createPane ? "Open a location first." : createPane.editing ? "Close the editor first." : `In ${createPane.cwd}`;
  // Marked only when both panes could receive New folder and New file.
  const markedSide = left.phase === "ready" && right.phase === "ready" ? createPane?.side ?? null : null;

  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, height: 56, flex: "none", padding: "0 16px", borderBottom: "1px solid var(--line)", background: "var(--tab)", boxSizing: "border-box", whiteSpace: "nowrap" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, flex: "none" }}>SFTP</h1>
        <button
          ref={transfersBtnRef}
          type="button"
          aria-label={hasTransfers ? `Transfers: ${transferSummary}` : "Transfers"}
          aria-expanded={transfersOpen}
          aria-hidden={hasTransfers ? undefined : true}
          tabIndex={hasTransfers ? undefined : -1}
          title={transferSummary}
          onClick={toggleTransfers}
          style={{ position: "relative", display: "flex", alignItems: "center", gap: 6, minWidth: 0, maxWidth: 220, height: 28, marginLeft: 4, padding: "0 8px", border: 0, borderRadius: 6, background: transfersOpen ? "var(--bg-sunken)" : "transparent", color: "var(--text-2)", fontSize: 12, cursor: "pointer", visibility: hasTransfers ? "visible" : "hidden" }}
        >
          <span style={{ display: "flex", flex: "none" }}>
            <Spin on={counts.running > 0}>{counts.running > 0 ? <RefreshIcon size={12} /> : <DownloadIcon size={12} />}</Spin>
          </span>
          <span style={{ ...ellipsis, minWidth: 0, color: counts.failed > 0 && pendingTransfers === 0 ? "var(--err)" : undefined }}>{transferSummary}</span>
          {runningTransfer && (
            <span style={{ position: "absolute", left: 8, right: 8, bottom: 1 }}>
              {runningPct === null ? (
                <Indeterminate height={2} />
              ) : (
                <span style={{ display: "block", height: 2, borderRadius: 1, background: "var(--bg-raised)", overflow: "hidden" }}>
                  <span style={{ display: "block", width: `${runningPct}%`, height: "100%", background: "var(--accent)", transition: "width 200ms linear" }} />
                </span>
              )}
            </span>
          )}
        </button>
        <div style={{ flex: 1 }} />
        <Btn onClick={openUploadMenu} disabled={!!uploadDisabled} title={uploadDisabled ?? `Upload to ${toolbarHost?.name ?? "host"}`} style={toolBtn}>
          <UploadIcon />
          Upload
        </Btn>
        <Btn onClick={download} disabled={!!downloadDisabled} title={downloadDisabled ?? (localSide ? `Download into ${panes[localSide].cwd}` : "Download to a folder")} style={toolBtn}>
          <DownloadIcon />
          Download
        </Btn>
        <Btn ariaLabel="New folder" onClick={() => createPane?.startCreate("folder")} disabled={!canCreate} title={canCreate ? `New folder in ${createPane?.cwd}` : createTitle} style={iconBtn}>
          <FolderPlusIcon />
        </Btn>
        <Btn ariaLabel="New file" onClick={() => createPane?.startCreate("file")} disabled={!canCreate} title={canCreate ? `New file in ${createPane?.cwd}` : createTitle} style={iconBtn}>
          <FilePlusIcon />
        </Btn>
        <Btn ariaLabel="Refresh" title="Refresh both panes" disabled={left.phase === "idle" && right.phase === "idle"} onClick={refreshAll} style={iconBtn}>
          <Spin on={anyLoading}>
            <RefreshIcon />
          </Spin>
        </Btn>
        {onOpenTerminal && (
          <Btn
            ariaLabel="Open terminal"
            title={toolbarHost ? `Open a terminal on ${toolbarHost.name}` : "Open a host in one of the panes first."}
            disabled={!toolbarHost}
            onClick={() => toolbarHost && onOpenTerminal(toolbarHost)}
            style={iconBtn}
          >
            <TerminalTabIcon />
          </Btn>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 4, fontSize: 12, color: "var(--text-2)" }}>
          <input type="checkbox" checked={sftpShowHidden} onChange={(e) => setSftpShowHidden(e.target.checked)} style={{ accentColor: "var(--accent)", margin: 0 }} />
          Show hidden files
        </label>
        {transfersOpen && hasTransfers && (
          <div
            ref={transfersPopRef}
            role="dialog"
            aria-label="Transfers"
            tabIndex={-1}
            style={{ position: "absolute", top: 50, left: Math.max(8, popLeft - 8), zIndex: 90, width: 560, maxWidth: "calc(100% - 16px)", display: "flex", flexDirection: "column", borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", outline: "none", whiteSpace: "normal", overflow: "hidden" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, height: 34, flex: "none", padding: "0 8px 0 12px" }}>
              <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>Transfers</h2>
              <span style={{ ...ellipsis, fontSize: 12, color: "var(--text-2)" }}>{transferSummary}</span>
              <div style={{ flex: 1 }} />
              <Btn
                onClick={() => setTransfers((ts) => ts.filter((t) => t.state === "queued" || t.state === "running"))}
                disabled={finishedCount === 0}
                title={finishedCount === 0 ? "Nothing finished yet" : "Remove finished, failed and canceled transfers"}
                style={ghostBtn}
              >
                Clear finished
              </Btn>
            </div>
            <div style={{ maxHeight: 34 * 6, overflowY: "auto" }}>
              {transfers.map((t) => (
                <TransferRow
                  key={t.id}
                  t={t}
                  retryBlocked={t.state === "failed" || t.state === "canceled" ? missingSession(t) : null}
                  onCancel={() => cancelTransfer(t)}
                  onRetry={() => setTransfers((ts) => ts.map((x) => (x.id === t.id && (x.state === "failed" || x.state === "canceled") ? { ...x, state: "queued", error: "" } : x)))}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div ref={panesBoxRef} style={{ display: "flex", flexDirection: stacked ? "column" : "row", flex: 1, minHeight: 0 }}>
        {SIDES.map((s) => (
          <PaneView
            key={s}
            pane={panes[s]}
            hosts={hosts}
            stacked={stacked}
            focused={markedSide === s}
            focusReq={focusReq?.side === s ? focusReq : null}
            dropHint={osDrop?.side === s ? { dir: osDrop.dir } : null}
            dragTarget={drag?.over === s ? { dir: drag.overDir } : null}
            h={handlersFor(s)}
          />
        ))}
      </div>

      {drag && (
        <div style={{ position: "fixed", left: drag.x + 14, top: drag.y + 14, zIndex: 120, display: "flex", flexDirection: "column", gap: 2, maxWidth: 320, padding: "6px 10px", borderRadius: 6, background: "var(--bg)", boxShadow: "var(--shadow)", pointerEvents: "none", fontSize: 12 }}>
          <span style={{ ...ellipsis, fontWeight: 500, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ display: "flex", color: "var(--text-2)" }}>{panes[drag.from].isRemote && panes[otherSide(drag.from)].isRemote ? <CopyIcon /> : panes[drag.from].isRemote ? <DownloadIcon /> : <UploadIcon />}</span>
            {drag.label}
          </span>
          <span style={{ ...ellipsis, color: drag.over ? "var(--text-2)" : "var(--text-3)" }}>{drag.note}</span>
        </div>
      )}
      {osDrop && !osDrop.side && osDrop.note && (
        <div role="status" style={{ position: "fixed", left: osDrop.x + 14, top: osDrop.y + 14, zIndex: 120, maxWidth: 320, padding: "6px 10px", borderRadius: 6, background: "var(--bg)", boxShadow: "var(--shadow)", pointerEvents: "none", fontSize: 12, color: "var(--text-2)" }}>
          {osDrop.note}
        </div>
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog?.kind === "choice" && <ChoiceDialog spec={dialog} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && (
        <ConfirmDialog title={dialog.title} message={dialog.message} confirmLabel={dialog.confirmLabel} danger onConfirm={dialog.onConfirm} onClose={() => setDialog(null)} />
      )}
    </main>
  );
}
