import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText as clipReadText, writeText as clipWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { usePrefs } from "./lib/prefs";
import { resolveTerminalTheme as buildTheme, toneOf, type Tone } from "./lib/terminal-themes";
import { termBus } from "./ui/termBus";
import { installDisposeGuard } from "./lib/xtermGuard";
import type { PaneInput, PaneStage } from "./ui/termBus";
import { PopupMenu } from "./ui/screens/TerminalSession";
import type { MenuEntry } from "./ui/screens/TerminalSession";
import { CheckIcon, WarningIcon } from "./ui/icons";
import { IS_MAC, KEYS, errText, termFontStack } from "./ui/mock";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

const cleanPaste = (text: string) =>
  Array.from(text)
    .filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n === 9 || n === 10 || n === 13 || (n >= 32 && n !== 127 && (n < 128 || n > 159));
    })
    .join("");

export type TerminalStage = PaneStage;

// Prompts after which the typed line is treated as a secret and NOT recorded in
// the audit log. Kept deliberately broad and fail-safe: over-suppressing a
// command is far better than logging a token, OTP, key or password. Matches when
// the last output line ends with one of these words followed by a colon.
const PW_PROMPT =
  /(pass(word|phrase|code)|(verification|security|auth|login|one[-\s]?time)\s*code|\botp\b|\b2fa\b|\bmfa\b|token|secret|api[\s_-]?key|private[-\s]?key|\bpin\b)[^\n]{0,40}:\s*$/i;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const PASTE_WRAP = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

// Data xterm emits on its own (device attribute and status reports, focus and
// mouse events, OSC/DCS replies). It goes to this pane's shell, but must never
// be mirrored to other panes or treated as typed input. No key produces these
// shapes: Alt+] and Alt+Shift+P send a bare "\x1b]" / "\x1bP" without payload
// and terminator, so they stay typed input.
const TERMINAL_REPORT =
  /^(?:\x1b\[[?>=]?[\d;]*\$?[cny]|\x1b\[\?[\d;]*R|\x1b\[[IO]|\x1b\[M[\s\S]{3}|\x1b\[<[\d;]+[Mm]|\x1b\][\s\S]+(?:\x07|\x1b\\)|\x1bP[\s\S]+\x1b\\)$/;
// A plain cursor position report looks exactly like Shift/Ctrl+F3 ("\x1b[1;2R"),
// so it only counts as a report while the remote has asked for one.
const CURSOR_REPORT = /^\x1b\[\d+;\d+R$/;

// App shortcuts that xterm would otherwise turn into shell input (Ctrl+Shift+D
// would even send EOF and log the shell out). These match exactly what the app's
// shortcut listener handles while the terminal has focus: on Windows only the
// Shift variants and Ctrl+Tab, because plain Ctrl+<key> belongs to the shell.
function isAppShortcut(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  if (!IS_MAC && e.altKey && e.shiftKey && !e.ctrlKey && (k === "d" || e.code === "KeyD")) return true;
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;
  if (k === "tab") return true;
  if (IS_MAC) return ["k", "p", "t", "w", "l", ",", "d"].includes(k) || (!e.shiftKey && /^[1-9]$/.test(k));
  return e.shiftKey && ["k", "p", "t", "w", "d", "l"].includes(k);
}

let audioCtx: AudioContext | null = null;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.13);
  } catch {
    /* no audio output available */
  }
}

/** A friendly explanation for host key refusals. When set, the raw backend detail is not shown. */
function hostKeyMessage(detail: string): string | null {
  if (/known hosts could not be read|known_hosts is unreadable/i.test(detail)) return "Known hosts could not be read, so the host key could not be checked.";
  if (!/host\s*key/i.test(detail)) return null;
  if (/revoked/i.test(detail)) return "This host key is marked as revoked in Known hosts.";
  if (/chang|mismatch/i.test(detail)) return "The host key changed. Review it in the dialog or in Known hosts.";
  return "The host key was not trusted. Reconnect to review it again.";
}


export interface UserInputInfo {
  /** The line belongs to a password or token prompt; never audit it, wherever it is mirrored. */
  secret: boolean;
  /** A bracketed paste, already unwrapped; receivers re-wrap it for their own paste mode. */
  paste: boolean;
}

export interface SshTerminalProps {
  hostId: string;
  hostName: string;
  hostAddress: string;
  /** With paneId, registers this pane with termBus so the app can write to and reconnect it. */
  tabId?: string;
  paneId?: string;
  /** Sent once, followed by Enter, after the first successful connect. */
  initialCommand?: string;
  /** Sent after every successful connect, from the host's advanced settings. */
  startupCommand?: string;
  encoding?: string;
  themeOverride?: string;
  /** Moves keyboard focus into the terminal while true. */
  focused?: boolean;
  onStatus?(stage: TerminalStage, detail: string): void;
  onResize?(cols: number, rows: number): void;
  /** Keyboard and paste input typed into this pane (not programmatic or mirrored writes). */
  onUserInput?(data: string, info: UserInputInfo): void;
  onBell?(): void;
  onTitle?(title: string): void;
  onProcess?(name: string): void;
  onLatency?(ms: number | null): void;
  onAuth?(summary: string): void;
  onNote?(note: ConnNote): void;
  onClosePane?(): void;
  onEditHost?(): void;
}

export type ConnNote = { attempt: number; of: number; at: number | null; text: string };

type Step = { id: string; text: string; doneText: string; done: boolean };
type Conn =
  | { kind: "connecting"; steps: Step[]; quiet: boolean; attempt: number }
  | { kind: "connected" }
  | { kind: "auth-failed"; message: string; user: string; method: string; credential: string }
  | { kind: "error"; message: string }
  | { kind: "lost"; attempt: number; at: number; gaveUp: boolean; reason?: string }
  | { kind: "ended"; exitStatus: number | null; signal: string | null; canceled: boolean };

const RETRY_DELAYS = [2, 5, 10, 20, 30];
const MAX_ATTEMPTS = RETRY_DELAYS.length;
const PROMPT_END = /(?:[$#%>❯»]|\$\s)\s*$/;
const WRAPPERS = new Set(["sudo", "doas", "exec", "time", "nohup", "env", "nice", "command", "builtin", "stdbuf", "ionice"]);

function commandName(line: string): string {
  const parts = line.trim().split(/\s+/);
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (WRAPPERS.has(p) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(p)) {
      i++;
      while (i < parts.length && parts[i].startsWith("-")) i += /^-[ugCcDhpr]$/.test(parts[i]) ? 2 : 1;
      continue;
    }
    break;
  }
  const word = parts[i] ?? "";
  return word.replace(/^['"]|['"]$/g, "").split("/").pop() ?? "";
}

function noteOf(c: Conn): ConnNote {
  if (c.kind === "lost") return { attempt: c.attempt, of: MAX_ATTEMPTS, at: c.gaveUp ? null : c.at, text: c.gaveUp ? (c.reason ?? `Could not reconnect after ${MAX_ATTEMPTS} attempts.`) : "" };
  if (c.kind === "connecting" && c.quiet) return { attempt: c.attempt, of: MAX_ATTEMPTS, at: null, text: "" };
  if (c.kind === "ended") return { attempt: 0, of: MAX_ATTEMPTS, at: null, text: c.canceled ? "Canceled" : c.signal ? `Signal ${c.signal}` : c.exitStatus !== null ? `Exit code ${c.exitStatus}` : "" };
  return { attempt: 0, of: MAX_ATTEMPTS, at: null, text: "" };
}

function stageOf(c: Conn): TerminalStage {
  if (c.kind === "connected") return "connected";
  if (c.kind === "connecting") return c.quiet ? "reconnecting" : "connecting";
  if (c.kind === "lost") return c.gaveUp ? "failed" : "reconnecting";
  if (c.kind === "ended") return "ended";
  return "failed";
}

const CP1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };

function isSingleByte(enc: string) {
  return enc === "iso-8859-1" || enc === "windows-1252";
}

function encodeSingleByte(text: string, enc: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    if (enc === "windows-1252" && CP1252[cp] !== undefined) out.push(CP1252[cp]);
    else if (cp <= 0xff && !(enc === "windows-1252" && cp >= 0x80 && cp <= 0x9f)) out.push(cp);
    else out.push(0x3f);
  }
  return out;
}

export function SshTerminal(props: SshTerminalProps) {
  const { hostId, tabId, paneId, focused, themeOverride } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [conn, setConnState] = useState<Conn>({ kind: "connecting", steps: [], quiet: false, attempt: 0 });
  const [gen, setGen] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const [tone, setTone] = useState<Tone>("dark");
  const [palette, setPalette] = useState<{ bg: string; fg: string } | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState("");

  const prefs = usePrefs();
  const termTheme = themeOverride || prefs.termTheme;
  const { termColors } = prefs;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<Conn>(conn);
  const sessionRef = useRef<string | null>(null);
  const attemptRef = useRef<{ quiet: boolean; attempt: number; password?: string }>({ quiet: false, attempt: 0 });
  const passwordRef = useRef<string | null>(null);
  const sendRef = useRef<((data: string, input?: PaneInput) => boolean) | null>(null);
  const pasteRef = useRef<(() => Promise<void>) | null>(null);
  const refitRef = useRef<(() => void) | null>(null);
  const initialSentRef = useRef(false);
  const shellRef = useRef("");
  const processRef = useRef("");
  const outTailRef = useRef("");
  const propsRef = useRef(props);
  propsRef.current = props;
  const encodingRef = useRef((props.encoding || "utf-8").toLowerCase());
  encodingRef.current = (props.encoding || "utf-8").toLowerCase();

  const setConn = useCallback((c: Conn) => {
    connRef.current = c;
    setConnState(c);
    const stage = stageOf(c);
    propsRef.current.onStatus?.(stage, c.kind === "error" || c.kind === "auth-failed" ? c.message : "");
    propsRef.current.onNote?.(noteOf(c));
  }, []);

  const setProcess = useCallback((name: string) => {
    if (!name || processRef.current === name) return;
    processRef.current = name;
    propsRef.current.onProcess?.(name);
  }, []);

  const reconnect = useCallback((opts: { quiet?: boolean; attempt?: number; password?: string } = {}) => {
    attemptRef.current = { quiet: !!opts.quiet, attempt: opts.attempt ?? 0, password: opts.password };
    setPwOpen(false);
    setPw("");
    setGen((g) => g + 1);
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    installDisposeGuard();
    let disposed = false;

    const p0 = prefsRef.current;
    const term = new Terminal({
      cursorBlink: p0.termCursorBlink,
      cursorStyle: p0.termCursor,
      fontFamily: termFontStack(p0.termFontFamily),
      fontSize: p0.termFontSize,
      lineHeight: p0.termLineHeight,
      scrollback: p0.termScrollback,
      theme: buildTheme(propsRef.current.themeOverride || p0.termTheme, p0.termColors, el),
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) void openUrl(uri);
      }),
    );
    // A previous session's teardown can, in rare WebGL failure paths, leave a
    // stale screen element behind; clear the container so a reconnect never
    // stacks two terminals.
    el.replaceChildren();
    term.open(el);
    // Crisp GPU text rendering (this is the sharp look). If WebGL is unavailable
    // xterm keeps its DOM renderer, and on context loss we dispose so it degrades
    // gracefully rather than showing a black box.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try {
          webgl?.dispose();
        } catch {
          /* renderer already torn down */
        }
        webgl = undefined;
      });
      term.loadAddon(webgl);
    } catch {
      /* no WebGL; DOM renderer stays */
      webgl = undefined;
    }
    // After a `clear` (ED2), also drop the scrollback so you cannot scroll back
    // to the output from before the clear.
    term.parser.registerCsiHandler({ final: "J" }, (params) => {
      // Only on the normal buffer, so a full-screen app (vim, less, htop) that
      // erases its own screen on the alternate buffer is left alone.
      if (params[0] === 2 && term.buffer.active.type === "normal") {
        queueMicrotask(() => {
          try {
            term.clear();
          } catch {
            /* disposed */
          }
        });
      }
      return false; // let xterm still perform its normal erase
    });
    // Count cursor position requests so their replies are told apart from keys.
    let pendingCpr = 0;
    term.parser.registerCsiHandler({ final: "n" }, (params) => {
      if (params[0] === 6) pendingCpr = Math.min(pendingCpr + 1, 8);
      return false;
    });
    const isTerminalReport = (data: string) => {
      if (TERMINAL_REPORT.test(data)) return true;
      if (pendingCpr > 0 && CURSOR_REPORT.test(data)) {
        pendingCpr -= 1;
        return true;
      }
      return false;
    };

    const paste = async () => {
      try {
        const txt = await clipReadText();
        if (!disposed && txt) term.paste(cleanPaste(txt));
      } catch {
        /* clipboard empty or not text */
      }
    };
    pasteRef.current = paste;
    const copySelection = () => {
      const sel = term.getSelection();
      if (sel) clipWriteText(sel).catch(() => {});
      return sel;
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (isAppShortcut(e)) return false;
      const k = connRef.current.kind;
      if ((k === "error" || k === "auth-failed" || k === "ended" || k === "lost") && e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        reconnect();
        return false;
      }
      const key = e.key.toLowerCase();
      if (e.ctrlKey && e.shiftKey && key === "c") {
        copySelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && key === "v") {
        e.preventDefault();
        void paste();
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && key === "c") {
        if (copySelection()) {
          term.clearSelection();
          return false;
        }
        return true;
      }
      if (e.ctrlKey && !e.shiftKey && key === "v") {
        e.preventDefault();
        void paste();
        return false;
      }
      if (IS_MAC && e.metaKey && !e.shiftKey && key === "c") {
        copySelection();
        return false;
      }
      if (IS_MAC && e.metaKey && !e.shiftKey && key === "v") {
        e.preventDefault();
        void paste();
        return false;
      }
      return true;
    });
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (prefsRef.current.termRightClick === "menu") {
        setMenu({ x: e.clientX, y: e.clientY, hasSelection: term.hasSelection() });
      } else {
        void paste();
      }
    };
    el.addEventListener("contextmenu", onContextMenu);

    let lineBuf = "";
    let lineSecret = false;
    // Feeds input into the audit line buffer. `force` marks the line secret
    // (input mirrored from a pane that is at a password prompt). Returns true
    // when any of the input belonged to a secret line.
    const feed = (text: string, force: boolean): boolean => {
      let touchedSecret = false;
      for (const ch of text) {
        if (lineSecret || force) touchedSecret = true;
        if (ch === "\r" || ch === "\n") {
          const cmd = lineBuf.trim();
          const secret = lineSecret || force;
          lineBuf = "";
          lineSecret = false;
          if (cmd && !secret) {
            void invoke("audit_user_command", { hostId, command: cmd }).catch(() => {});
            if (term.buffer.active.type === "normal") setProcess(commandName(cmd));
          }
        } else if (ch === "\x7f" || ch === "\b") {
          lineBuf = lineBuf.slice(0, -1);
        } else if (ch === "\x03" || ch === "\x15") {
          lineBuf = "";
          lineSecret = false;
        } else if (ch >= " ") {
          if (lineBuf === "") {
            const lastLine = (outTailRef.current.split(/[\r\n]/).pop() ?? "").replace(ANSI, "");
            lineSecret = PW_PROMPT.test(lastLine);
          }
          if (force) lineSecret = true;
          if (lineSecret) touchedSecret = true;
          lineBuf += ch;
        }
      }
      return touchedSecret;
    };
    const track = (data: string, force = false): boolean => {
      if (data.startsWith("\x1b")) {
        const m = data.match(/\x1b\[200~([\s\S]*?)\x1b\[201~/);
        return m ? feed(m[1], force) : force;
      }
      return feed(data, force);
    };
    const write = (data: string) => {
      const id = sessionRef.current;
      if (!id) return;
      const enc = encodingRef.current;
      if (isSingleByte(enc)) void invoke("ssh_write_bytes", { id, data: encodeSingleByte(data, enc) }).catch(() => {});
      else void invoke("ssh_write", { id, data }).catch(() => {});
    };
    // Set while a mirrored paste runs through term.paste, so its onData is
    // written and audited here but never mirrored back.
    let mirror: { secret: boolean } | null = null;
    // Programmatic input (snippets, broadcast, initial command) is audited the
    // same way as typed input, and only once it is actually sent.
    sendRef.current = (data: string, input?: PaneInput) => {
      if (disposed || connRef.current.kind !== "connected") return false;
      if (input?.paste) {
        mirror = { secret: !!input.secret };
        try {
          term.paste(cleanPaste(data));
        } finally {
          mirror = null;
        }
        return true;
      }
      write(data);
      track(data, !!input?.secret);
      return true;
    };

    const dataSub = term.onData((data) => {
      if (connRef.current.kind !== "connected") return;
      write(data);
      if (mirror) {
        track(data, mirror.secret);
        return;
      }
      if (isTerminalReport(data)) return;
      const secret = track(data);
      const wrapped = PASTE_WRAP.exec(data);
      propsRef.current.onUserInput?.(wrapped ? wrapped[1] : data, { secret, paste: !!wrapped });
    });
    let selTimer = 0;
    const selSub = term.onSelectionChange(() => {
      if (!prefsRef.current.termCopyOnSelect) return;
      window.clearTimeout(selTimer);
      selTimer = window.setTimeout(() => {
        const s = term.getSelection();
        if (s) clipWriteText(s).catch(() => {});
      }, 150);
    });
    const titleSub = term.onTitleChange((t) => propsRef.current.onTitle?.(t));
    const resizeSub = term.onResize(({ cols, rows }) => propsRef.current.onResize?.(cols, rows));
    let lastBell = 0;
    const bellSub = term.onBell(() => {
      const now = performance.now();
      if (now - lastBell < 150) return;
      lastBell = now;
      const mode = prefsRef.current.termBell;
      if (mode === "flash") propsRef.current.onBell?.();
      else if (mode === "sound") beep();
    });

    // Skips while the tab is hidden (0 size): fitting then would resize the
    // remote PTY to a tiny width and garble the prompt on the next redraw.
    const refit = () => {
      if (disposed || el.clientWidth === 0 || el.clientHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* not laid out */
      }
      const id = sessionRef.current;
      if (id && connRef.current.kind === "connected") void invoke("ssh_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    refitRef.current = refit;

    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (document.documentElement.hasAttribute("data-relayout")) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refit);
    });
    ro.observe(el);
    const onRelayout = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(refit);
    };
    window.addEventListener("kst-relayout", onRelayout);

    return () => {
      disposed = true;
      sendRef.current = null;
      pasteRef.current = null;
      refitRef.current = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("kst-relayout", onRelayout);
      dataSub.dispose();
      window.clearTimeout(selTimer);
      selSub.dispose();
      titleSub.dispose();
      resizeSub.dispose();
      bellSub.dispose();
      el.removeEventListener("contextmenu", onContextMenu);
      // Dispose the WebGL addon first and defensively. After the connection
      // drops its renderer is half torn down, so letting term.dispose() reach it
      // throws "Cannot read properties of undefined (reading '_isDisposed')".
      // Both teardown steps are guarded so a failed dispose can never bubble up
      // to React and bounce the user back to the host list on reconnect.
      try {
        webgl?.dispose();
      } catch {
        /* already gone */
      }
      webgl = undefined;
      try {
        term.dispose();
      } catch {
        /* renderer already torn down */
      }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [hostId, reconnect, setProcess]);

  useEffect(() => {
    const term = termRef.current;
    const el = wrapRef.current;
    if (!term || !el) return;
    let cancelled = false;
    let settled = false;
    const sessionId = crypto.randomUUID();
    sessionRef.current = sessionId;
    const { quiet, attempt } = attemptRef.current;
    const password = attemptRef.current.password ?? passwordRef.current ?? (paneId ? termBus.handedPassword(paneId) : undefined);
    attemptRef.current = { quiet: false, attempt: 0 };
    setMenu(null);
    if (gen > 0 && !quiet) {
      try {
        const b = term.buffer.active;
        if (b.baseY + b.cursorY > 0 || b.cursorX > 0) term.write("\r\n");
      } catch {
        /* disposed */
      }
    }
    setConn({ kind: "connecting", steps: [], quiet, attempt });

    const enc = encodingRef.current;
    const decoder = isSingleByte(enc) ? new TextDecoder(enc === "windows-1252" ? "windows-1252" : "latin1") : null;
    const tailDecoder = new TextDecoder();
    const onOutput = new Channel<ArrayBuffer>();
    onOutput.onmessage = (buf) => {
      if (cancelled) return;
      const bytes = new Uint8Array(buf);
      let text: string;
      try {
        text = decoder ? decoder.decode(bytes, { stream: true }) : tailDecoder.decode(bytes, { stream: true });
      } catch {
        text = "";
      }
      if (decoder) term.write(text);
      else term.write(bytes);
      outTailRef.current = (outTailRef.current + text).slice(-400);
      if (term.buffer.active.type === "normal" && shellRef.current) {
        const last = (outTailRef.current.split(/[\r\n]/).pop() ?? "").replace(ANSI, "");
        if (last.length < 200 && PROMPT_END.test(last)) setProcess(shellRef.current);
      }
    };

    const fail = (message: string) => {
      if (settled || cancelled) return;
      settled = true;
      const c = connRef.current;
      if (c.kind === "connecting" && c.quiet && c.attempt < MAX_ATTEMPTS && !hostKeyMessage(message)) {
        setConn({ kind: "lost", attempt: c.attempt + 1, at: Date.now() + RETRY_DELAYS[c.attempt] * 1000, gaveUp: false });
        return;
      }
      if (c.kind === "connecting" && c.quiet) {
        setConn({ kind: "lost", attempt: c.attempt, at: 0, gaveUp: true, reason: hostKeyMessage(message) ?? undefined });
        return;
      }
      setConn({ kind: "error", message });
    };

    const step = (id: string, text: string, doneText: string) => {
      const c = connRef.current;
      if (c.kind !== "connecting") return;
      const steps = c.steps.map((s) => (s.done ? s : { ...s, done: true, text: s.doneText }));
      setConn({ ...c, steps: [...steps.filter((s) => s.id !== id), { id, text, doneText, done: false }] });
    };
    const finish = (id: string, doneText: string) => {
      const c = connRef.current;
      if (c.kind !== "connecting") return;
      setConn({ ...c, steps: c.steps.map((s) => (s.id === id ? { ...s, done: true, text: doneText, doneText } : s)) });
    };

    const statusSub = listen<{ id: string; stage: string; detail: string; data?: { user?: string; method?: string; credential?: string } }>("session-status", (e) => {
      if (cancelled || e.payload.id !== sessionId) return;
      const { stage, detail, data } = e.payload;
      if (stage === "jumping") step(`jump:${detail}`, `Connecting to ${detail}`, `Connected through ${detail}`);
      else if (stage === "jumped") finish(`jump:${detail}`, `Connected through ${detail}`);
      else if (stage === "resolving") step("resolve", `Looking up ${detail}`, `Looked up ${detail}`);
      else if (stage === "resolved") finish("resolve", `Resolved ${detail}`);
      else if (stage === "connecting") step("connect", `Connecting to ${detail}`, `Connected to ${detail}`);
      else if (stage === "authenticating") step("auth", `Authenticating with ${detail}`, `Authenticated with ${detail}`);
      else if (stage === "opening-shell") step("shell", "Opening the shell", "Shell opened");
      else if (stage === "connected") propsRef.current.onAuth?.(detail);
      else if (stage === "auth-failed") {
        settled = true;
        if (password && passwordRef.current === password) passwordRef.current = null;
        if (paneId) termBus.dropPassword(paneId);
        setConn({ kind: "auth-failed", message: detail, user: data?.user ?? "", method: data?.method ?? "", credential: data?.credential ?? "" });
      } else if (stage === "canceled") {
        settled = true;
        setConn({ kind: "ended", exitStatus: null, signal: null, canceled: true });
      } else if (stage === "error") fail(detail);
    });
    const closeSub = listen<{ id: string; exit_status: number | null; signal: string | null; lost: boolean }>("session-closed", (e) => {
      if (cancelled || e.payload.id !== sessionId) return;
      sessionRef.current = null;
      if (e.payload.lost) {
        try {
          term.write("\r\n\x1b[2m[Connection lost]\x1b[0m\r\n");
        } catch {
          /* disposed */
        }
        setConn({ kind: "lost", attempt: 1, at: Date.now() + RETRY_DELAYS[0] * 1000, gaveUp: false });
      } else {
        try {
          term.write(`\r\n\x1b[2mConnection to ${propsRef.current.hostAddress} closed.\x1b[0m\r\n`);
        } catch {
          /* disposed */
        }
        setConn({ kind: "ended", exitStatus: e.payload.exit_status, signal: e.payload.signal, canceled: false });
      }
      propsRef.current.onLatency?.(null);
    });
    const infoSub = listen<{ id: string; shell: string }>("session-info", (e) => {
      if (cancelled || e.payload.id !== sessionId) return;
      shellRef.current = e.payload.shell;
      if (!processRef.current) setProcess(e.payload.shell);
    });

    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* not laid out */
      }
      if (cancelled) return;
      propsRef.current.onResize?.(term.cols, term.rows);
      void invoke("ssh_open_shell", { id: sessionId, hostId, cols: term.cols, rows: term.rows, onOutput, password: password ?? null })
        .then(() => {
          if (cancelled) {
            void invoke("ssh_close", { id: sessionId }).catch(() => {});
            return;
          }
          settled = true;
          processRef.current = "";
          propsRef.current.onProcess?.(shellRef.current);
          if (password) passwordRef.current = password;
          if (paneId) termBus.dropPassword(paneId);
          setConn({ kind: "connected" });
          requestAnimationFrame(() => refitRef.current?.());
          const startup = propsRef.current.startupCommand?.trim();
          if (startup) sendRef.current?.(startup.replace(/\r?\n/g, "\r") + "\r");
          const cmd = propsRef.current.initialCommand;
          if (cmd && !initialSentRef.current) {
            initialSentRef.current = true;
            sendRef.current?.(cmd.replace(/\r?\n/g, "\r") + "\r");
          }
        })
        .catch((err) => fail(errText(err)));
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      statusSub.then((f) => f());
      closeSub.then((f) => f());
      infoSub.then((f) => f());
      if (sessionRef.current === sessionId) sessionRef.current = null;
      void invoke("ssh_close", { id: sessionId }).catch(() => {});
    };
  }, [hostId, paneId, gen, setConn, setProcess]);

  useEffect(() => {
    if (conn.kind !== "lost" || conn.gaveUp) return;
    const wait = Math.max(0, conn.at - Date.now());
    const go = window.setTimeout(() => reconnect({ quiet: true, attempt: conn.attempt }), wait);
    return () => window.clearTimeout(go);
  }, [conn, reconnect]);

  useEffect(() => {
    if (!focused || conn.kind !== "connected") return;
    let alive = true;
    const ping = async () => {
      const id = sessionRef.current;
      if (!id) return;
      try {
        const ms = await invoke<number | null>("ssh_ping", { id });
        if (alive) propsRef.current.onLatency?.(ms);
      } catch {
        if (alive) propsRef.current.onLatency?.(null);
      }
    };
    void ping();
    const t = window.setInterval(() => void ping(), 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [focused, conn.kind]);

  useEffect(() => {
    if (!tabId || !paneId) return;
    return termBus.register(tabId, paneId, {
      hostId,
      write: (data, input) => sendRef.current?.(data, input) ?? false,
      reconnect: () => reconnect(),
      stage: () => stageOf(connRef.current),
      clear: () => {
        try {
          termRef.current?.clear();
        } catch {
          /* disposed */
        }
      },
      focus: () => termRef.current?.focus(),
      password: () => passwordRef.current,
    });
  }, [tabId, paneId, hostId, reconnect]);

  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused, gen]);

  // The default scheme follows the app theme, which is a class on the app root.
  useEffect(() => {
    const root = wrapRef.current?.closest(".t-dark, .t-light");
    setTone(toneOf(wrapRef.current));
    if (!root) return;
    const mo = new MutationObserver(() => setTone(toneOf(wrapRef.current)));
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const theme = buildTheme(termTheme, termColors, wrapRef.current);
    setPalette({ bg: theme.background ?? "", fg: theme.foreground ?? "" });
    const t = termRef.current;
    if (!t) return;
    t.options.theme = theme;
    try {
      t.refresh(0, t.rows - 1);
    } catch {
      /* disposed */
    }
  }, [termTheme, termColors, tone, hostId]);

  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontFamily = termFontStack(prefs.termFontFamily);
    t.options.fontSize = prefs.termFontSize;
    t.options.lineHeight = prefs.termLineHeight;
    t.options.cursorStyle = prefs.termCursor;
    t.options.cursorBlink = prefs.termCursorBlink;
    t.options.scrollback = prefs.termScrollback;
    try {
      t.refresh(0, t.rows - 1);
    } catch {
      /* disposed */
    }
    // A new cell size changes how many columns and rows fit, but not the box,
    // so the resize observer would never fire.
    const raf = requestAnimationFrame(() => refitRef.current?.());
    return () => cancelAnimationFrame(raf);
  }, [prefs.termFontFamily, prefs.termFontSize, prefs.termLineHeight, prefs.termCursor, prefs.termCursorBlink, prefs.termScrollback]);

  // Overlay colors come from the same palette as its background, so they stay
  // readable whatever the terminal scheme and app theme are.
  const bg = palette?.bg || "var(--term-bg)";
  const fg = palette?.fg || "var(--term-text)";
  const dim = `color-mix(in srgb, ${fg} 62%, ${bg})`;
  const line = `color-mix(in srgb, ${fg} 24%, ${bg})`;

  const withTerm = (fn: (t: Terminal) => void) => () => {
    const t = termRef.current;
    if (!t) return;
    try {
      fn(t);
      t.focus();
    } catch {
      /* disposed */
    }
  };
  const menuItems: MenuEntry[] = menu
    ? [
        {
          label: "Copy",
          hint: KEYS.copy,
          disabled: !menu.hasSelection,
          title: menu.hasSelection ? undefined : "Select text first",
          onSelect: withTerm((t) => {
            const sel = t.getSelection();
            if (sel) clipWriteText(sel).catch(() => {});
          }),
        },
        { label: "Paste", hint: KEYS.paste, onSelect: withTerm(() => void pasteRef.current?.()) },
        { label: "Select all", onSelect: withTerm((t) => t.selectAll()) },
        { label: "Clear", onSelect: withTerm((t) => t.clear()) },
      ]
    : [];

  const outline: CSSProperties = { display: "flex", alignItems: "center", height: 28, padding: "0 12px", border: `1px solid ${line}`, borderRadius: 6, background: "transparent", color: fg, fontSize: 12, cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
  const primary: CSSProperties = { ...outline, border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500 };
  const card: CSSProperties = { position: "absolute", inset: 0, zIndex: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "safe center", gap: 12, padding: 20, overflow: "auto", background: bg, color: fg, fontSize: 13, textAlign: "center", boxSizing: "border-box" };
  const ring = (size: number, width: number): CSSProperties => ({ width: size, height: size, flex: "none", borderRadius: "50%", borderStyle: "solid", borderWidth: width, borderTopColor: "var(--focus)", borderRightColor: line, borderBottomColor: line, borderLeftColor: line, boxSizing: "border-box", animation: "kestral-spin 0.8s linear infinite" });

  const name = props.hostName;
  const credentialText = (c: Extract<Conn, { kind: "auth-failed" }>) => {
    const who = c.user ? ` for the user ${c.user}` : "";
    if (c.method === "key") return `The server rejected the key ${c.credential}${who}.`;
    if (c.method === "password") return c.credential ? `The server rejected the password ${c.credential}${who}.` : `The server rejected the password${who}.`;
    return `The server accepted none of the keys in your SSH agent${who}.`;
  };
  const errorKey = conn.kind === "error" ? hostKeyMessage(conn.message) : null;

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", width: "100%", background: bg, overflow: "hidden" }}>
      <style>{"@keyframes kestral-spin { to { transform: rotate(360deg) } }"}</style>
      <div
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          termRef.current?.focus();
        }}
        style={{ position: "relative", flex: 1, minHeight: 0, padding: "10px 12px", boxSizing: "border-box", opacity: conn.kind === "lost" || (conn.kind === "connecting" && conn.quiet) ? 0.45 : 1 }}
      >
        <div ref={wrapRef} style={{ height: "100%", width: "100%" }} />
      </div>

      {conn.kind === "connecting" && !conn.quiet && (
        <div role="status" aria-live="polite" style={{ ...card, gap: 14 }}>
          <span aria-hidden="true" style={ring(28, 2.5)} />
          <div style={{ fontWeight: 600 }}>Connecting to {name}</div>
          {conn.steps.length > 0 && (
            <ol aria-label="Connection progress" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5, color: dim, textAlign: "left" }}>
              {conn.steps.map((s) => (
                <li key={s.id} aria-current={s.done ? undefined : "step"} style={{ display: "flex", alignItems: "center", gap: 8, color: s.done ? dim : fg }}>
                  {s.done ? (
                    <span style={{ display: "flex", color: "var(--ok)" }}>
                      <CheckIcon size={14} />
                    </span>
                  ) : (
                    <span aria-hidden="true" style={{ ...ring(12, 2), margin: "0 1px" }} />
                  )}
                  {s.text}
                </li>
              ))}
            </ol>
          )}
          <button
            type="button"
            onClick={() => {
              const id = sessionRef.current;
              if (id) void invoke("ssh_close", { id }).catch(() => {});
            }}
            style={outline}
          >
            Cancel
          </button>
        </div>
      )}

      {conn.kind === "auth-failed" && (
        <div role="alert" style={card}>
          <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: "50%", background: "var(--err-tint)", color: "var(--err)" }}>
            <WarningIcon size={18} />
          </span>
          <div style={{ fontWeight: 600 }}>Authentication failed</div>
          <code style={{ fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace", fontSize: 12, color: dim }}>{conn.message}</code>
          <p style={{ margin: 0, maxWidth: 340, fontSize: 12.5, color: dim }}>{credentialText(conn)}</p>
          {pwOpen ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (pw) reconnect({ password: pw });
              }}
              style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}
            >
              <input
                type="password"
                autoFocus
                aria-label={`Password for ${conn.user || name}`}
                placeholder={`Password for ${conn.user || name}`}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setPwOpen(false);
                    setPw("");
                  }
                }}
                style={{ width: 220, height: 28, padding: "0 10px", border: `1px solid ${line}`, borderRadius: 6, background: "transparent", color: fg, fontSize: 12, boxSizing: "border-box", outline: "none" }}
              />
              <button type="submit" disabled={!pw} style={{ ...primary, opacity: pw ? 1 : 0.5, cursor: pw ? "pointer" : "default" }}>
                Connect
              </button>
              <button
                type="button"
                onClick={() => {
                  setPwOpen(false);
                  setPw("");
                }}
                style={outline}
              >
                Back
              </button>
            </form>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
              <button type="button" onClick={() => reconnect()} style={primary}>
                Retry
              </button>
              <button type="button" onClick={() => setPwOpen(true)} style={outline}>
                Try a password
              </button>
              {props.onEditHost && (
                <button type="button" onClick={props.onEditHost} style={outline}>
                  Edit host
                </button>
              )}
              {props.onClosePane && (
                <button type="button" onClick={props.onClosePane} style={outline}>
                  Close pane
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {conn.kind === "error" && (
        <div role="alert" style={card}>
          <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, borderRadius: "50%", background: "var(--err-tint)", color: "var(--err)" }}>
            <WarningIcon size={18} />
          </span>
          <div style={{ fontWeight: 600 }}>{errorKey ? "Host key not trusted" : "Connection failed"}</div>
          <code style={{ maxWidth: 420, fontFamily: "ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace", fontSize: 12, color: dim, overflowWrap: "anywhere" }}>{errorKey ?? conn.message.replace(/^SSH: /, "")}</code>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
            <button type="button" onClick={() => reconnect()} style={primary}>
              Retry
            </button>
            {props.onEditHost && (
              <button type="button" onClick={props.onEditHost} style={outline}>
                Edit host
              </button>
            )}
            {props.onClosePane && (
              <button type="button" onClick={props.onClosePane} style={outline}>
                Close pane
              </button>
            )}
          </div>
        </div>
      )}

      {menu && (
        <PopupMenu
          label="Terminal"
          items={menuItems}
          onClose={() => setMenu(null)}
          style={{ position: "fixed", left: Math.max(4, Math.min(menu.x, window.innerWidth - 204)), top: Math.max(4, Math.min(menu.y, window.innerHeight - 150)) }}
        />
      )}
    </div>
  );
}
