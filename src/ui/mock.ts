// Shared UI constants and small helpers for the design-system screens.
// (File name kept for import stability; it no longer holds mock data.)

export const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace";
export const SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Connection state shown as a dot: ok = connected, warn = connecting/reconnecting, err = failed, idle = no session. */
export type Status = "ok" | "idle" | "warn" | "err";

export type SectionId =
  | "hosts"
  | "keychain"
  | "snippets"
  | "forwarding"
  | "known"
  | "ai"
  | "logs"
  | "terminal"
  | "settings";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
/** Modifier label for shortcuts: "⌘" on macOS, "Ctrl" elsewhere. */
export const MOD = IS_MAC ? "⌘" : "Ctrl";

export const KEYS = IS_MAC
  ? { palette: "⌘K", newTab: "⌘T", closeTab: "⌘W", split: "⌘D", copy: "⌘C", paste: "⌘V", settings: "⌘,", lock: "⌘L", enter: "⌘↵", find: "⌘F" }
  : { palette: "Ctrl+Shift+K", newTab: "Ctrl+Shift+T", closeTab: "Ctrl+Shift+W", split: "Alt+Shift+D", copy: "Ctrl+Shift+C", paste: "Ctrl+Shift+V", settings: "Ctrl+,", lock: "Ctrl+Shift+L", enter: "Ctrl+Enter", find: "Ctrl+Shift+F" };

export function statusColor(status: Status): string {
  return status === "ok" ? "var(--ok)" : status === "warn" ? "var(--warn)" : status === "err" ? "var(--err)" : "var(--ring-idle)";
}

export function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

/** "Today 13:02", "Yesterday", or "12 Sep 2026" like the design. mtime in unix seconds. */
export function fmtDate(mtime: number | null): string {
  if (!mtime) return "";
  const d = new Date(mtime * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay) return `Today ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtPerms(mode: number | null): string {
  if (mode == null) return "";
  const t = (mode & 0o170000) === 0o040000 ? "d" : (mode & 0o170000) === 0o120000 ? "l" : "-";
  const r = (m: number) => ((mode & m) ? "r" : "-");
  const w = (m: number) => ((mode & m) ? "w" : "-");
  const x = (m: number) => ((mode & m) ? "x" : "-");
  return t + r(0o400) + w(0o200) + x(0o100) + r(0o040) + w(0o020) + x(0o010) + r(0o004) + w(0o002) + x(0o001);
}

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function termFontStack(family: string): string {
  const f = family.trim().replace(/["\\]/g, "");
  return f ? `"${f}", ${MONO}` : MONO;
}

export function fontInstalled(name: string): boolean {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return true;
    const sample = "mmmmmmmmmmlliWW00";
    ctx.font = `72px "${name}", monospace`;
    const a = ctx.measureText(sample).width;
    ctx.font = `72px "${name}", serif`;
    const b = ctx.measureText(sample).width;
    return a === b;
  } catch {
    return true;
  }
}
