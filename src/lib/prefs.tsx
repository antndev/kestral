import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TERMINAL_THEMES, DEFAULT_TERM_THEME, termThemeOf, type TermThemeId } from "./terminal-themes";

export type Theme = "system" | "light" | "dark";

export const ANIM_MIN = 0;
export const ANIM_MAX = 1.5;
export const ANIM_DEFAULT = 1;

const THEME_KEY = "kestral-theme";
const ANIM_KEY = "kestral-anim";
const TERM_KEY = "kestral-term-theme";
const AI_MIN_KEY = "kestral-ai-minutes";
const SFTP_HIDDEN_KEY = "kestral-sftp-hidden";
const SFTP_AUTOREFRESH_KEY = "kestral-sftp-autorefresh";
const TERM_COLORS_KEY = "kestral-term-colors";
const TERM_FONT_KEY = "kestral-term-font-size";
const TERM_FAMILY_KEY = "kestral-term-font-family";
const TERM_LH_KEY = "kestral-term-line-height";
const TERM_SCROLLBACK_KEY = "kestral-term-scrollback";
const TERM_CURSOR_KEY = "kestral-term-cursor";
const TERM_BLINK_KEY = "kestral-term-cursor-blink";
const TERM_COPYSEL_KEY = "kestral-term-copy-on-select";
const TERM_BELL_KEY = "kestral-term-bell";
const TERM_RCLICK_KEY = "kestral-term-right-click";

export type CursorStyle = "block" | "bar" | "underline";
export type BellMode = "flash" | "sound" | "off";
export type RightClickMode = "paste" | "menu";

export const THEMES: Theme[] = ["system", "light", "dark"];

function readNum(key: string, fallback: number, min: number, max: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null || raw.trim() === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

function readAnimScale(): number {
  const v = localStorage.getItem(ANIM_KEY);
  if (v === "off") return 0;
  if (v === "fast") return 0.6;
  if (v === "normal" || v === null) return ANIM_DEFAULT;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(ANIM_MAX, Math.max(ANIM_MIN, n)) : ANIM_DEFAULT;
}

async function applyTheme(t: Theme) {
  const win = getCurrentWindow();
  try {
    await win.setTheme(t === "light" ? "light" : t === "dark" ? "dark" : null);
  } catch {
  }
  let dark: boolean;
  if (t === "light") dark = false;
  else if (t === "dark") dark = true;
  else {
    let resolved: string | null = null;
    try {
      resolved = await win.theme();
    } catch {
    }
    dark = resolved ? resolved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  document.documentElement.classList.toggle("dark", dark);
}

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = localStorage.getItem(key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

type Prefs = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  termTheme: TermThemeId;
  setTermTheme: (id: TermThemeId) => void;
  termColors: boolean;
  setTermColors: (v: boolean) => void;
  animScale: number;
  setAnimScale: (v: number) => void;
  aiMinutes: number;
  setAiMinutes: (m: number) => void;
  sftpShowHidden: boolean;
  setSftpShowHidden: (v: boolean) => void;
  sftpAutoRefresh: boolean;
  setSftpAutoRefresh: (v: boolean) => void;
  termFontSize: number;
  setTermFontSize: (v: number) => void;
  termFontFamily: string;
  setTermFontFamily: (v: string) => void;
  termLineHeight: number;
  setTermLineHeight: (v: number) => void;
  termScrollback: number;
  setTermScrollback: (v: number) => void;
  termCursor: CursorStyle;
  setTermCursor: (v: CursorStyle) => void;
  termCursorBlink: boolean;
  setTermCursorBlink: (v: boolean) => void;
  termCopyOnSelect: boolean;
  setTermCopyOnSelect: (v: boolean) => void;
  termBell: BellMode;
  setTermBell: (v: BellMode) => void;
  termRightClick: RightClickMode;
  setTermRightClick: (v: RightClickMode) => void;
};

const PrefsCtx = createContext<Prefs | null>(null);

export function usePrefs(): Prefs {
  const c = useContext(PrefsCtx);
  if (!c) throw new Error("usePrefs must be used within PrefsProvider");
  return c;
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => readEnum(THEME_KEY, THEMES, "system"));
  const [animScale, setAnimScaleState] = useState<number>(() => readAnimScale());
  const [termTheme, setTermThemeState] = useState<TermThemeId>(() => {
    const v = localStorage.getItem(TERM_KEY);
    return v && TERMINAL_THEMES[v] ? v : DEFAULT_TERM_THEME;
  });
  const [aiMinutes, setAiMinutesState] = useState<number>(() => {
    const raw = localStorage.getItem(AI_MIN_KEY);
    // 0 is a valid choice (no time limit); a missing key defaults to 30.
    const v = raw == null ? 30 : Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : 30;
  });
  const [sftpShowHidden, setSftpShowHiddenState] = useState<boolean>(
    () => localStorage.getItem(SFTP_HIDDEN_KEY) !== "false",
  );
  const [sftpAutoRefresh, setSftpAutoRefreshState] = useState<boolean>(
    () => localStorage.getItem(SFTP_AUTOREFRESH_KEY) !== "false",
  );
  const [termColors, setTermColorsState] = useState<boolean>(
    () => localStorage.getItem(TERM_COLORS_KEY) !== "false",
  );
  const [termFontSize, setTermFontSizeState] = useState<number>(() => readNum(TERM_FONT_KEY, 13, 8, 32));
  const [termFontFamily, setTermFontFamilyState] = useState<string>(() => localStorage.getItem(TERM_FAMILY_KEY) ?? "");
  const [termLineHeight, setTermLineHeightState] = useState<number>(() => readNum(TERM_LH_KEY, 1.2, 1, 2.5));
  const [termScrollback, setTermScrollbackState] = useState<number>(() => readNum(TERM_SCROLLBACK_KEY, 5000, 0, 200000));
  const [termCursor, setTermCursorState] = useState<CursorStyle>(() => readEnum(TERM_CURSOR_KEY, ["block", "bar", "underline"] as const, "block"));
  const [termCursorBlink, setTermCursorBlinkState] = useState<boolean>(() => localStorage.getItem(TERM_BLINK_KEY) !== "false");
  const [termCopyOnSelect, setTermCopyOnSelectState] = useState<boolean>(() => localStorage.getItem(TERM_COPYSEL_KEY) === "true");
  const [termBell, setTermBellState] = useState<BellMode>(() => readEnum(TERM_BELL_KEY, ["flash", "sound", "off"] as const, "flash"));
  const [termRightClick, setTermRightClickState] = useState<RightClickMode>(() => readEnum(TERM_RCLICK_KEY, ["paste", "menu"] as const, "paste"));

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.storageArea !== localStorage || (e.key !== null && !e.key.startsWith("kestral-"))) return;
      setThemeState(readEnum(THEME_KEY, THEMES, "system"));
      setAnimScaleState(readAnimScale());
      const tt = localStorage.getItem(TERM_KEY);
      setTermThemeState(tt && TERMINAL_THEMES[tt] ? tt : DEFAULT_TERM_THEME);
      const ai = localStorage.getItem(AI_MIN_KEY);
      const aiV = ai == null ? 30 : Number(ai);
      setAiMinutesState(Number.isFinite(aiV) && aiV >= 0 ? aiV : 30);
      setSftpShowHiddenState(localStorage.getItem(SFTP_HIDDEN_KEY) !== "false");
      setSftpAutoRefreshState(localStorage.getItem(SFTP_AUTOREFRESH_KEY) !== "false");
      setTermColorsState(localStorage.getItem(TERM_COLORS_KEY) !== "false");
      setTermFontSizeState(readNum(TERM_FONT_KEY, 13, 8, 32));
      setTermFontFamilyState(localStorage.getItem(TERM_FAMILY_KEY) ?? "");
      setTermLineHeightState(readNum(TERM_LH_KEY, 1.2, 1, 2.5));
      setTermScrollbackState(readNum(TERM_SCROLLBACK_KEY, 5000, 0, 200000));
      setTermCursorState(readEnum(TERM_CURSOR_KEY, ["block", "bar", "underline"] as const, "block"));
      setTermCursorBlinkState(localStorage.getItem(TERM_BLINK_KEY) !== "false");
      setTermCopyOnSelectState(localStorage.getItem(TERM_COPYSEL_KEY) === "true");
      setTermBellState(readEnum(TERM_BELL_KEY, ["flash", "sound", "off"] as const, "flash"));
      setTermRightClickState(readEnum(TERM_RCLICK_KEY, ["paste", "menu"] as const, "paste"));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    void applyTheme(theme);
    const m = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "system") void applyTheme("system");
    };
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--anim-scale", String(animScale));
    root.toggleAttribute("data-anim-scaled", Math.abs(animScale - 1) > 0.001);
  }, [animScale]);

  useEffect(() => {
    document.documentElement.style.setProperty("--term-bg", termThemeOf(termTheme).theme.background ?? "#1e1e1e");
  }, [termTheme]);

  const setTheme = (t: Theme) => {
    localStorage.setItem(THEME_KEY, t);
    setThemeState(t);
  };
  const setAnimScale = (v: number) => {
    const clamped = Math.min(ANIM_MAX, Math.max(ANIM_MIN, v));
    localStorage.setItem(ANIM_KEY, String(clamped));
    setAnimScaleState(clamped);
  };
  const setTermTheme = (id: TermThemeId) => {
    localStorage.setItem(TERM_KEY, id);
    setTermThemeState(id);
  };
  const setAiMinutes = (m: number) => {
    localStorage.setItem(AI_MIN_KEY, String(m));
    setAiMinutesState(m);
  };
  const setSftpShowHidden = (v: boolean) => {
    localStorage.setItem(SFTP_HIDDEN_KEY, String(v));
    setSftpShowHiddenState(v);
  };
  const setSftpAutoRefresh = (v: boolean) => {
    localStorage.setItem(SFTP_AUTOREFRESH_KEY, String(v));
    setSftpAutoRefreshState(v);
  };
  const setTermColors = (v: boolean) => {
    localStorage.setItem(TERM_COLORS_KEY, String(v));
    setTermColorsState(v);
  };
  const setTermFontSize = (v: number) => { localStorage.setItem(TERM_FONT_KEY, String(v)); setTermFontSizeState(v); };
  const setTermFontFamily = (v: string) => { localStorage.setItem(TERM_FAMILY_KEY, v.trim()); setTermFontFamilyState(v.trim()); };
  const setTermLineHeight = (v: number) => { localStorage.setItem(TERM_LH_KEY, String(v)); setTermLineHeightState(v); };
  const setTermScrollback = (v: number) => { localStorage.setItem(TERM_SCROLLBACK_KEY, String(v)); setTermScrollbackState(v); };
  const setTermCursor = (v: CursorStyle) => { localStorage.setItem(TERM_CURSOR_KEY, v); setTermCursorState(v); };
  const setTermCursorBlink = (v: boolean) => { localStorage.setItem(TERM_BLINK_KEY, String(v)); setTermCursorBlinkState(v); };
  const setTermCopyOnSelect = (v: boolean) => { localStorage.setItem(TERM_COPYSEL_KEY, String(v)); setTermCopyOnSelectState(v); };
  const setTermBell = (v: BellMode) => { localStorage.setItem(TERM_BELL_KEY, v); setTermBellState(v); };
  const setTermRightClick = (v: RightClickMode) => { localStorage.setItem(TERM_RCLICK_KEY, v); setTermRightClickState(v); };

  return (
    <PrefsCtx.Provider
      value={{
        theme,
        setTheme,
        animScale,
        setAnimScale,
        termTheme,
        setTermTheme,
        termColors,
        setTermColors,
        aiMinutes,
        setAiMinutes,
        sftpShowHidden,
        setSftpShowHidden,
        sftpAutoRefresh,
        setSftpAutoRefresh,
        termFontSize,
        setTermFontSize,
        termFontFamily,
        setTermFontFamily,
        termLineHeight,
        setTermLineHeight,
        termScrollback,
        setTermScrollback,
        termCursor,
        setTermCursor,
        termCursorBlink,
        setTermCursorBlink,
        termCopyOnSelect,
        setTermCopyOnSelect,
        termBell,
        setTermBell,
        termRightClick,
        setTermRightClick,
      }}
    >
      <MotionConfig reducedMotion={animScale < 0.05 ? "always" : "user"}>{children}</MotionConfig>
    </PrefsCtx.Provider>
  );
}
