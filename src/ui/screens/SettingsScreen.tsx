import { CSSProperties, FormEvent, ReactNode, RefObject, useEffect, useId, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../../api";
import type { ImportReport } from "../../api";
import { usePrefs, THEMES } from "../../lib/prefs";
import type { BellMode, CursorStyle, RightClickMode, Theme } from "../../lib/prefs";
import { TERMINAL_THEMES, resolveTerminalTheme } from "../../lib/terminal-themes";
import { IS_MAC, MOD, MONO, SANS, errText, fontInstalled, readJson, termFontStack, writeJson } from "../mock";
import { CheckIcon, SearchIcon } from "../icons";
import { Markdown } from "../Markdown";
import { Overlay, useModalLayer } from "../overlays/Dialogs";
import { Stable } from "../Stable";
import { updateLock } from "../../lib/updateLock";
import { SegGroup, segItem } from "../SegGroup";

/* ---------- shared bits (also used by WelcomeScreen) ---------- */

export const btnSecondary: CSSProperties = { height: 32, padding: "0 14px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer", whiteSpace: "nowrap", boxSizing: "border-box" };
export const btnPrimary: CSSProperties = { height: 32, padding: "0 16px", border: "1px solid var(--btn-line)", borderRadius: 6, background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap", boxSizing: "border-box" };
export const inputStyle: CSSProperties = { width: "100%", height: 32, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text)", boxSizing: "border-box" };
const disabledLook: CSSProperties = { opacity: 0.5, cursor: "default" };
export const withDisabled = (base: CSSProperties, disabled: boolean): CSSProperties => (disabled ? { ...base, ...disabledLook } : base);

/** Returns a ref that is false once the component has unmounted, to drop late async results. */
export function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-2)" }}>{label}</span>
      {children}
    </label>
  );
}

/** Dialog buttons in platform order: the primary action comes first on Windows and Linux, last on macOS. */
export function DialogActions({ primary, cancel }: { primary: ReactNode; cancel: ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
      {IS_MAC ? cancel : primary}
      {IS_MAC ? primary : cancel}
    </div>
  );
}

/**
 * Dialog on the app's modal layer (topmost-only Escape, focus trap, focus restore).
 * While `busy`, Escape and the backdrop do nothing so a running operation can't be orphaned.
 */
export function Modal({ title, description, width = 420, busy = false, initialFocus, onClose, children }: { title: string; description?: ReactNode; width?: number; busy?: boolean; initialFocus?: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const descId = useId();
  const close = () => {
    if (!busy) onClose();
  };
  const z = useModalLayer(ref, { onEscape: close, initialFocus });
  return (
    <Overlay z={z} onBackdrop={close}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} aria-busy={busy} tabIndex={-1} style={{ width, maxWidth: "100%", maxHeight: "100%", display: "flex", flexDirection: "column", gap: 16, padding: 24, borderRadius: 12, background: "var(--bg)", color: "var(--text)", boxShadow: "var(--shadow)", boxSizing: "border-box", overflow: "auto", outline: "none", fontFamily: SANS, fontSize: 13, lineHeight: 1.4 }}>
        <div>
          <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h2>
          {description && <p id={descId} style={{ margin: "6px 0 0", color: "var(--text-2)" }}>{description}</p>}
        </div>
        {children}
      </section>
    </Overlay>
  );
}

const formErr: CSSProperties = { height: 16, margin: "-5px 0", fontSize: 12, lineHeight: "16px", color: "var(--err)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

export function ChangeMasterDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const alive = useAlive();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const can = !!current && !!next && !!repeat && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!can) return;
    if (next.length < 8) {
      setErr("Use at least 8 characters.");
      return;
    }
    if (next !== repeat) {
      setErr("The new passwords don't match.");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      await api.vaultChangeMaster(current, next);
      onChanged();
    } catch (x) {
      if (alive.current) {
        setErr(errText(x));
        setBusy(false);
      }
    }
  }

  return (
    <Modal title="Change master password" description="It unlocks the vault and encrypts all local data." busy={busy} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Current password">
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => { setCurrent(e.target.value); setErr(""); }} style={inputStyle} />
        </Field>
        <Field label="New password">
          <input type="password" autoComplete="new-password" value={next} onChange={(e) => { setNext(e.target.value); setErr(""); }} style={inputStyle} />
        </Field>
        <Field label="Repeat new password">
          <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => { setRepeat(e.target.value); setErr(""); }} style={inputStyle} />
        </Field>
        <p role="alert" title={err || undefined} style={formErr}>{err}</p>
        <DialogActions
          primary={<button type="submit" disabled={!can} style={withDisabled(btnPrimary, !can)}><Stable text={busy ? "Changing…" : "Change password"} alts={["Change password", "Changing…"]} /></button>}
          cancel={<button type="button" disabled={busy} onClick={onClose} style={withDisabled(btnSecondary, busy)}>Cancel</button>}
        />
      </form>
    </Modal>
  );
}

/* ---------- settings-only styles and controls ---------- */

const PAGES = ["General", "Appearance", "Terminal", "Keyboard", "Vault and security", "About"] as const;
type Page = (typeof PAGES)[number];
const PAGE_KEY = "kestral-settings-page";

const row: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--line-soft)" };
const blockRow: CSSProperties = { display: "grid", gap: 10, padding: "12px 0", borderBottom: "1px solid var(--line-soft)" };
const rowHead: CSSProperties = { flex: "1 1 220px", minWidth: 0 };
const field: CSSProperties = { width: 240, height: 30, padding: "0 8px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text)", boxSizing: "border-box" };
const ctlBox: CSSProperties = { width: 240, display: "flex", alignItems: "center", gap: 10 };
const sub: CSSProperties = { margin: "2px 0 0", fontSize: 12, color: "var(--text-2)" };
const oneLine: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const rowBtn: CSSProperties = { height: 30, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
const groupHead: CSSProperties = { margin: "18px 0 8px", fontSize: 12, fontWeight: 500, color: "var(--text-2)" };
const kbd: CSSProperties = { display: "inline-block", minWidth: 10, padding: "0 5px", border: "1px solid var(--line)", borderRadius: 4, fontFamily: "inherit", fontSize: 11, lineHeight: "18px", color: "var(--text-2)", textAlign: "center" };
const linkBtn: CSSProperties = { padding: 0, border: 0, background: "transparent", color: "var(--link)", textDecoration: "underline", textUnderlineOffset: 2, fontSize: 12, cursor: "pointer" };

// Same stack as the xterm instance in SshTerminal, so the preview matches the real sessions.
const FONT_CHOICES = ["Cascadia Mono", "Cascadia Code", "Consolas", "JetBrains Mono", "Fira Code", "Source Code Pro", "SF Mono", "Menlo", "Courier New"];
const CUSTOM_FONT = "__custom__";
const IS_WIN = !IS_MAC && /Windows/.test(navigator.userAgent);
const PLATFORM_FONTS: Record<string, boolean> = { "SF Mono": IS_MAC, Menlo: IS_MAC, Consolas: IS_WIN };

function FontSelect({ value, onChange }: { value: string; onChange(v: string): void }) {
  const fonts = useMemo(() => {
    const installed = Object.fromEntries(FONT_CHOICES.map((f) => [f, fontInstalled(f)]));
    const system = IS_MAC ? "SF Mono" : ["SF Mono", "Cascadia Mono", "Consolas"].find((f) => installed[f]) ?? "";
    return { installed, system };
  }, []);
  const known = value === "" || FONT_CHOICES.includes(value);
  const [custom, setCustom] = useState(!known);
  const [draft, setDraft] = useState(known ? "" : value);
  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onChange(v);
  };
  const choices = FONT_CHOICES.filter((f) => f !== fonts.system && (f === value || fonts.installed[f] || PLATFORM_FONTS[f] !== false));
  const missing = custom && !!draft.trim() && !fontInstalled(draft.trim());
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 240 }}>
      <select
        id="st-font"
        value={custom ? CUSTOM_FONT : value === fonts.system ? "" : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM_FONT) {
            setCustom(true);
            setDraft(value);
            return;
          }
          setCustom(false);
          onChange(e.target.value);
        }}
        style={field}
      >
        <option value="">{fonts.system ? `${fonts.system} (system)` : "System monospace"}</option>
        {choices.map((f) => (
          <option key={f} value={f} disabled={!fonts.installed[f] && f !== value}>
            {fonts.installed[f] ? f : `${f} (not installed)`}
          </option>
        ))}
        <option value={CUSTOM_FONT}>Other font…</option>
      </select>
      {custom && (
        <input
          aria-label="Font name"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          placeholder="Font name, for example Iosevka"
          spellCheck={false}
          style={{ ...field, fontFamily: termFontStack(draft) }}
        />
      )}
      {custom && <span aria-live="polite" style={{ ...oneLine, height: 16, fontSize: 12, lineHeight: "16px", color: "var(--warn)" }}>{missing ? "Not installed, the system font is used." : ""}</span>}
    </div>
  );
}
const RELEASES_URL = "https://github.com/antndev/kestral/releases/latest";

function Toggle({ on, onChange, labelledBy, disabled, title }: { on: boolean; onChange: (v: boolean) => void; labelledBy: string; disabled?: boolean; title?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-labelledby={labelledBy} disabled={disabled} title={title} onClick={() => onChange(!on)} style={{ position: "relative", display: "block", width: 30, height: 18, padding: 0, border: 0, borderRadius: 9, background: on ? "var(--ok)" : "var(--light-ring)", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1, flex: "none" }}>
      <span aria-hidden="true" style={{ position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", background: "#FFFFFF", transition: "left .12s" }} />
    </button>
  );
}

function Seg<T extends string>({ value, options, onChange, labelledBy }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; labelledBy?: string }) {
  return (
    <SegGroup labelledBy={labelledBy} value={value}>
      {options.map((o) => {
        const on = value === o.v;
        return (
          <button key={o.v} type="button" aria-pressed={on} onClick={() => onChange(o.v)} style={segItem(on, { height: 24, padding: "0 8px", fontSize: 12 })}>{o.label}</button>
        );
      })}
    </SegGroup>
  );
}

/** Text field for a bounded number. Edits are committed on blur or Enter, so typing "14" never passes through an out-of-range "1". */
function NumField({ id, label, value, min, max, step, unit, decimals = 0, onCommit, style }: { id?: string; label?: string; value: number; min: number; max: number; step: number; unit?: string; decimals?: number; onCommit: (v: number) => void; style?: CSSProperties }) {
  const [draft, setDraft] = useState<string | null>(null);
  const fmt = (n: number) => (decimals ? n.toFixed(decimals).replace(/\.?0+$/, "") : String(Math.round(n)));
  const clamp = (n: number) => {
    const f = 10 ** decimals;
    return Math.min(max, Math.max(min, Math.round(n * f) / f));
  };
  const commit = (keep: boolean) => {
    if (draft == null) return;
    const n = parseFloat(draft.replace(",", "."));
    const next = Number.isFinite(n) ? clamp(n) : value;
    if (Number.isFinite(n)) onCommit(next);
    setDraft(keep ? fmt(next) : null);
  };
  const shown = draft ?? (unit ? `${fmt(value)} ${unit}` : fmt(value));
  return (
    <input
      id={id}
      aria-label={label}
      type="text"
      inputMode={decimals ? "decimal" : "numeric"}
      value={shown}
      onFocus={() => setDraft(fmt(value))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(true);
        else if (e.key === "Escape") {
          if (draft == null || draft === fmt(value)) return;
          e.stopPropagation();
          setDraft(fmt(value));
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const base = parseFloat((draft ?? "").replace(",", "."));
          const n = clamp((Number.isFinite(base) ? base : value) + (e.key === "ArrowUp" ? step : -step));
          onCommit(n);
          setDraft(fmt(n));
        }
      }}
      style={{ ...field, ...style }}
    />
  );
}

function Keys({ combos }: { combos: string[][] }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
      {combos.map((c, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span style={{ fontSize: 12, color: "var(--text-3)" }}>or</span>}
          <span style={{ display: "inline-flex", gap: 3 }}>
            {c.map((k) => <kbd key={k} style={kbd}>{k}</kbd>)}
          </span>
        </span>
      ))}
    </span>
  );
}

function CursorPreview({ style, blink }: { style: CursorStyle; blink: boolean }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(true);
    if (!blink) return;
    const t = window.setInterval(() => setOn((v) => !v), 530);
    return () => window.clearInterval(t);
  }, [blink]);
  const shape: CSSProperties =
    style === "bar" ? { width: 2, height: "1.15em", verticalAlign: "text-bottom" } : style === "underline" ? { width: "0.6em", height: 2, verticalAlign: "baseline" } : { width: "0.6em", height: "1.15em", verticalAlign: "text-bottom" };
  return <span aria-hidden="true" style={{ display: "inline-block", background: "currentColor", visibility: on ? "visible" : "hidden", ...shape }} />;
}


const themedRoot = () => document.querySelector(".t-dark, .t-light");

/** Re-renders when the app switches between dark and light, so scheme previews that
 *  follow the app tokens (the default "Kestral" scheme) read the new colors. */
function useAppTone(): "dark" | "light" {
  const read = () => (themedRoot()?.classList.contains("t-light") ? "light" : "dark");
  const [tone, setTone] = useState<"dark" | "light">(read);
  useEffect(() => {
    const el = themedRoot();
    if (!el) return;
    const mo = new MutationObserver(() => setTone(read()));
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return tone;
}

const SWATCHES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

function SchemeCard({ id, colors, selected, onSelect }: { id: string; colors: boolean; selected: boolean; onSelect: () => void }) {
  useAppTone();
  const { termFontFamily } = usePrefs();
  const t = resolveTerminalTheme(id, colors, themedRoot());
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect} style={{ display: "flex", flexDirection: "column", padding: 0, border: `1px solid ${selected ? "var(--focus)" : "var(--line)"}`, boxShadow: selected ? "0 0 0 1px var(--focus)" : "none", borderRadius: 8, background: "var(--bg)", color: "var(--text)", textAlign: "left", cursor: "pointer", overflow: "hidden" }}>
      <span style={{ display: "block", padding: "10px 12px", background: t.background, color: t.foreground, fontFamily: termFontStack(termFontFamily), fontSize: 11.5, lineHeight: 1.5, whiteSpace: "pre", overflow: "hidden" }}>
        <span style={{ display: "block" }}>
          <span style={{ color: t.green }}>user@kestral</span>:<span style={{ color: t.blue }}>~/app</span>$ ls
        </span>
        <span style={{ display: "block" }}>
          <span style={{ color: t.blue }}>src</span>  <span style={{ color: t.cyan }}>README.md</span>  <span style={{ color: t.red }}>err.log</span>
        </span>
        <span style={{ display: "flex", gap: 3, marginTop: 6 }}>
          {SWATCHES.map((k) => <span key={k} style={{ width: 12, height: 12, borderRadius: 2, background: t[k] }} />)}
        </span>
      </span>
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "7px 10px", fontSize: 12, fontWeight: selected ? 600 : 400, borderTop: "1px solid var(--line)" }}>
        {TERMINAL_THEMES[id].name}
        {selected && <span style={{ display: "flex", color: "var(--link)" }}><CheckIcon /></span>}
      </span>
    </button>
  );
}

type UpdateHandle = {
  version: string;
  body?: string;
  downloadAndInstall: (cb: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
};
type UpdateWindow = { __kestralUpdate?: UpdateHandle };
const updateWindow = window as unknown as UpdateWindow;
// One install at a time, even if Settings is closed and reopened while it runs.

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; pct: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function friendlyUpdateError(e: unknown): string {
  const raw = errText(e).toLowerCase();
  if (["error sending request", "connect", "timed out", "timeout", "dns", "network", "tcp", "request"].some((s) => raw.includes(s))) return "Couldn't reach GitHub. Check your connection.";
  if (raw.includes("signature") || raw.includes("verif")) return "The update's signature couldn't be verified.";
  if (raw.includes("permission") || raw.includes("denied") || raw.includes("os error 5")) return IS_MAC ? "macOS blocked the update." : "Windows blocked the update.";
  if (raw.includes("not found") || raw.includes("404")) return "The update isn't published yet. Try again later.";
  return "The update couldn't be completed.";
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

function importSummary(r: ImportReport): string {
  const skipped = r.hosts_skipped + r.secrets_skipped + r.snippets_skipped;
  return `Imported ${plural(r.hosts_added, "host")}, ${plural(r.secrets_added, "secret")} and ${plural(r.snippets_added, "snippet")}.${skipped > 0 ? ` Skipped ${skipped} already present.` : ""}`;
}

function ExportDialog({ onClose, onDone }: { onClose: () => void; onDone: (path: string) => void }) {
  const alive = useAlive();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const can = !!pw && !!pw2 && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!can) return;
    if (pw.length < 8) {
      setErr("Use at least 8 characters.");
      return;
    }
    if (pw !== pw2) {
      setErr("The passwords don't match.");
      return;
    }
    setErr("");
    setBusy(true);
    try {
      const path = await saveDialog({ defaultPath: "kestral-vault.kvault", filters: [{ name: "Kestral vault", extensions: ["kvault"] }] });
      if (!path) {
        if (alive.current) setBusy(false);
        return;
      }
      await api.vaultExport(path, pw);
      onDone(path);
    } catch (x) {
      if (alive.current) {
        setErr(errText(x));
        setBusy(false);
      }
    }
  }

  return (
    <Modal title="Export vault" description="Every host, key, password and snippet, encrypted with this password. Keep the file safe." busy={busy} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Export password">
          <input type="password" autoComplete="new-password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} style={inputStyle} />
        </Field>
        <Field label="Repeat password">
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => { setPw2(e.target.value); setErr(""); }} style={inputStyle} />
        </Field>
        <p role="alert" title={err || undefined} style={formErr}>{err}</p>
        <DialogActions
          primary={<button type="submit" disabled={!can} style={withDisabled(btnPrimary, !can)}><Stable text={busy ? "Exporting…" : "Choose file and export"} alts={["Choose file and export", "Exporting…"]} /></button>}
          cancel={<button type="button" disabled={busy} onClick={onClose} style={withDisabled(btnSecondary, busy)}>Cancel</button>}
        />
      </form>
    </Modal>
  );
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (r: ImportReport) => void }) {
  const alive = useAlive();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const can = !!pw && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!can) return;
    setErr("");
    setBusy(true);
    try {
      const picked = await openDialog({ multiple: false, directory: false, filters: [{ name: "Kestral vault", extensions: ["kvault"] }] });
      const path = typeof picked === "string" ? picked : null;
      if (!path) {
        if (alive.current) setBusy(false);
        return;
      }
      const report = await api.vaultImport(path, pw);
      onDone(report);
    } catch (x) {
      if (alive.current) {
        setErr(errText(x));
        setBusy(false);
      }
    }
  }

  return (
    <Modal title="Import vault" description="Merges an exported file into this vault. Items you already have are skipped." busy={busy} onClose={onClose}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label="Password of the export file">
          <input type="password" autoComplete="off" value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }} style={inputStyle} />
        </Field>
        <p role="alert" title={err || undefined} style={formErr}>{err}</p>
        <DialogActions
          primary={<button type="submit" disabled={!can} style={withDisabled(btnPrimary, !can)}><Stable text={busy ? "Importing…" : "Choose file and import"} alts={["Choose file and import", "Importing…"]} /></button>}
          cancel={<button type="button" disabled={busy} onClick={onClose} style={withDisabled(btnSecondary, busy)}>Cancel</button>}
        />
      </form>
    </Modal>
  );
}

type RowDef = { id: string; page: Page; group?: string; label: string; hint?: string; keywords?: string; node: ReactNode };
type Note = { tone: "ok" | "err"; text: ReactNode; title?: string } | null;

/* ---------- screen ---------- */

let helloCache: api.HelloStatus | null = null;

/**
 * onVaultImported: refresh hosts, keys and snippets after a vault import.
 */
export function SettingsScreen({ onVaultImported }: { onVaultImported?(): void }) {
  const p = usePrefs();
  useAppTone();
  const alive = useAlive();
  const [page, setPage] = useState<Page>(() => {
    const saved = readJson<string>(PAGE_KEY, "General");
    return (PAGES as readonly string[]).includes(saved) ? (saved as Page) : "General";
  });
  const [query, setQuery] = useState("");
  const [searchFocus, setSearchFocus] = useState(false);
  const [dialog, setDialog] = useState<null | "password" | "export" | "import">(null);

  const [tray, setTray] = useState<boolean | null>(null);
  const [trayErr, setTrayErr] = useState("");
  const [trayLoadErr, setTrayLoadErr] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [revealErr, setRevealErr] = useState("");
  const [hello, setHello] = useState<api.HelloStatus | null>(helloCache);
  const [helloBusy, setHelloBusy] = useState(false);
  const [helloNote, setHelloNote] = useState<Note>(null);

  function refreshHello() {
    return api.helloStatus().then((st) => {
      helloCache = st;
      if (alive.current) setHello(st);
      return st;
    });
  }

  async function toggleHello() {
    if (!hello || helloBusy) return;
    setHelloBusy(true);
    setHelloNote(null);
    try {
      if (hello.enabled) await api.helloDisable();
      else await api.helloEnable();
      const st = await refreshHello();
      setHelloNote({ tone: "ok", text: st.enabled ? `${st.method} is set up.` : `${st.method} is off.` });
    } catch (e) {
      setHelloNote({ tone: "err", text: errText(e) });
    } finally {
      setHelloBusy(false);
    }
  }

  const [pwOk, setPwOk] = useState(false);
  const [exportedTo, setExportedTo] = useState("");
  const [importMsg, setImportMsg] = useState("");

  const [version, setVersion] = useState("");
  const [changelog, setChangelog] = useState<string | null>(null);
  const [changelogErr, setChangelogErr] = useState("");
  const [upd, setUpd] = useState<UpdateState>({ kind: "idle" });
  const [pending, setPending] = useState<{ version: string; notes: string } | null>(null);
  const updRef = useRef<UpdateHandle | null>(null);
  const [linkErr, setLinkErr] = useState("");

  const queryRef = useRef(query);
  queryRef.current = query;

  function loadTray() {
    setTrayLoadErr("");
    api.settingsGet().then((s) => alive.current && setTray(s.minimizeToTray)).catch((e) => alive.current && setTrayLoadErr(errText(e)));
  }

  useEffect(() => {
    loadTray();
    refreshHello().catch(() => {});
    api.dataDir().then((d) => alive.current && setDataDir(d)).catch(() => {});
    api.dataWarnings().then((w) => alive.current && setWarnings(w)).catch(() => {});
    getVersion().then((v) => alive.current && setVersion(v)).catch(() => {});
    api.appChangelog().then((md) => alive.current && setChangelog(md)).catch((e) => alive.current && setChangelogErr(errText(e)));
  }, []);

  useEffect(() => writeJson(PAGE_KEY, page), [page]);

  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    searchRef.current?.focus({ preventScroll: true });
  }, []);

  const aboutSeen = page === "About" || /updat|version/i.test(query);
  useEffect(() => {
    if (aboutSeen && upd.kind === "idle") void checkUpdate();
  }, [aboutSeen]);

  function found(u: UpdateHandle) {
    updRef.current = u;
    setPending({ version: u.version, notes: u.body?.trim() ?? "" });
    setUpd({ kind: "available", version: u.version });
  }

  async function checkUpdate() {
    setLinkErr("");
    if (updateLock.busy) {
      setUpd({ kind: "downloading", pct: null });
      return;
    }
    // Reuse an update the app already found at startup or from the menu.
    const known = updateWindow.__kestralUpdate;
    if (known) {
      found(known);
      return;
    }
    setUpd({ kind: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = (await check()) as UpdateHandle | null;
      if (u) updateWindow.__kestralUpdate = u;
      if (!alive.current) return;
      if (u) found(u);
      else {
        updRef.current = null;
        setUpd({ kind: "current" });
      }
    } catch (e) {
      if (alive.current) setUpd({ kind: "error", message: friendlyUpdateError(e) });
    }
  }

  async function installUpdate() {
    const u = updRef.current;
    if (!u) return void checkUpdate();
    if (updateLock.busy) return;
    updateLock.busy = true;
    setLinkErr("");
    setUpd({ kind: "downloading", pct: 0 });
    // The release CDN and some antivirus scanners drop connections now and then; a retry usually works.
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let total = 0;
        let got = 0;
        await u.downloadAndInstall((e) => {
          if (e.event === "Started") total = e.data?.contentLength ?? 0;
          else if (e.event === "Progress") {
            got += e.data?.chunkLength ?? 0;
            if (alive.current) setUpd({ kind: "downloading", pct: total ? Math.round((got / total) * 100) : 0 });
          }
        });
        if (alive.current) setUpd({ kind: "ready" });
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
        return;
      } catch (e) {
        last = e;
        const msg = errText(e).toLowerCase();
        const retryable = ["error sending request", "connect", "timed out", "timeout", "request", "network", "reset"].some((s) => msg.includes(s));
        if (!retryable || attempt === 2) break;
        if (alive.current) setUpd({ kind: "downloading", pct: 0 });
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    updateLock.busy = false;
    if (alive.current) setUpd({ kind: "error", message: friendlyUpdateError(last) });
  }

  function openReleases() {
    setLinkErr("");
    openUrl(RELEASES_URL).catch((e) => alive.current && setLinkErr(errText(e)));
  }

  async function setTrayPref(v: boolean) {
    setTray(v);
    setTrayErr("");
    try {
      await api.settingsSetMinimizeToTray(v);
    } catch (e) {
      if (!alive.current) return;
      setTray(!v);
      setTrayErr(errText(e));
    }
  }

  const sep = dataDir.includes("\\") ? "\\" : "/";
  async function revealData() {
    setRevealErr("");
    try {
      await revealItemInDir(`${dataDir}${sep}vault.json`);
    } catch (e) {
      if (alive.current) setRevealErr(errText(e));
    }
  }

  const animValue = p.animScale < 0.05 ? "off" : p.animScale <= 0.8 ? "fast" : p.animScale >= 1.2 ? "slow" : "normal";
  const labelId = (id: string) => `st-${id}-label`;

  const labelEl = (id: string, label: string, htmlFor?: string) =>
    htmlFor ? <label htmlFor={htmlFor} style={{ fontWeight: 500 }}>{label}</label> : <span id={labelId(id)} style={{ fontWeight: 500 }}>{label}</span>;
  const head = (id: string, label: string, hint?: ReactNode, htmlFor?: string) => (
    <div style={rowHead}>
      {labelEl(id, label, htmlFor)}
      {hint && <p style={sub}>{hint}</p>}
    </div>
  );
  const noteHead = (id: string, label: string, hint: ReactNode, note: Note) => (
    <div style={rowHead}>
      {labelEl(id, label)}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", marginTop: 2 }}>
        <p style={{ ...sub, margin: 0, gridArea: "1 / 1", minWidth: 0, visibility: note ? "hidden" : "visible" }}>{hint}</p>
        <p aria-live="polite" title={note?.title ?? (typeof note?.text === "string" ? note.text : undefined)} style={{ ...sub, ...oneLine, margin: 0, gridArea: "1 / 1", color: note?.tone === "err" ? "var(--err)" : "var(--ok)" }}>{note?.text}</p>
      </div>
    </div>
  );
  const textCtl = (text: ReactNode) => <div style={{ ...ctlBox, fontSize: 12.5, color: "var(--text-2)" }}>{text}</div>;
  const pathText = (text: string) => <code data-selectable style={{ fontFamily: MONO, fontSize: 12, color: "var(--text)", wordBreak: "break-all" }}>{text}</code>;

  // Mirrors the bindings in RealApp (app shortcuts) and SshTerminal (copy and paste).
  const winShell = "Ctrl plus a letter is left to the shell";
  const app = (key: string): string[][] => (IS_MAC ? [[MOD, key]] : [["Ctrl", "Shift", key]]);
  const SHORTCUTS: { group: string; label: string; combos: string[][]; hint?: string }[] = [
    { group: "General", label: "Search or connect", combos: app("K"), hint: IS_MAC ? undefined : winShell },
    { group: "General", label: "New tab", combos: app("T") },
    { group: "General", label: "Open settings", combos: [[MOD, ","]] },
    { group: "General", label: "Lock the vault", combos: app("L") },
    { group: "General", label: "Close a dialog or settings", combos: [["Esc"]] },
    { group: "Tabs", label: "Close tab", combos: app("W") },
    { group: "Tabs", label: "Next tab", combos: [["Ctrl", "Tab"]] },
    { group: "Tabs", label: "Previous tab", combos: [["Ctrl", "Shift", "Tab"]] },
    { group: "Tabs", label: "Go to a tab by position", combos: [[MOD, "1…8"]] },
    { group: "Tabs", label: "Go to the last tab", combos: [[MOD, "9"]] },
    { group: "Tabs", label: "Split pane", combos: IS_MAC ? [[MOD, "D"]] : [["Alt", "Shift", "D"]], hint: "Splits the focused pane along its longer side" },
    { group: "Tabs", label: "Move to the pane next to it", combos: IS_MAC ? [[MOD, "⌥", "Arrow"]] : [["Alt", "Arrow"]], hint: "With more than one pane in the tab" },
    { group: "Terminal", label: "Reconnect a closed session", combos: [["Enter"]], hint: "While the session has ended or lost its connection" },
    IS_MAC
      ? { group: "Terminal", label: "Copy", combos: [[MOD, "C"], ["Ctrl", "Shift", "C"]] }
      : { group: "Terminal", label: "Copy", combos: [["Ctrl", "Shift", "C"], ["Ctrl", "C"]], hint: "Ctrl+C copies only while text is selected" },
    IS_MAC ? { group: "Terminal", label: "Paste", combos: [[MOD, "V"], ["Ctrl", "Shift", "V"]] } : { group: "Terminal", label: "Paste", combos: [["Ctrl", "Shift", "V"], ["Ctrl", "V"]] },
    { group: "Snippets", label: "Run the snippet", combos: [[MOD, "Enter"]] },
  ];

  const keyRows = SHORTCUTS.map((s, i): RowDef => ({
    id: `key-${i}`, page: "Keyboard", group: s.group, label: s.label, hint: s.hint, keywords: "shortcut " + s.combos.map((c) => c.join(" ")).join(" "),
    node: (
      <div style={row}>
        {head(`key-${i}`, s.label, s.hint)}
        <div style={ctlBox}><Keys combos={s.combos} /></div>
      </div>
    ),
  }));
  const snippetsAt = keyRows.findIndex((r) => r.group === "Snippets");
  keyRows.splice(snippetsAt < 0 ? keyRows.length : snippetsAt, 0, {
    id: "key-rclick", page: "Keyboard", group: "Terminal", label: "Right click", keywords: "shortcut mouse paste menu",
    hint: p.termRightClick === "paste" ? "Pastes the clipboard" : "Shows the context menu",
    node: (
      <div style={row}>
        {head("key-rclick", "Right click", p.termRightClick === "paste" ? "Pastes the clipboard" : "Shows the context menu")}
        <div style={ctlBox}><button type="button" onClick={() => { setQuery(""); setPage("Terminal"); }} style={rowBtn}>Change in Terminal</button></div>
      </div>
    ),
  });

  const trayNote: Note = trayLoadErr
    ? { tone: "err", text: <>Couldn't load this setting. <button type="button" onClick={loadTray} style={linkBtn}>Retry</button></>, title: trayLoadErr }
    : trayErr
      ? { tone: "err", text: trayErr }
      : null;
  const showHello = hello ? hello.supported : IS_WIN;
  const helloMethod = hello?.method ?? "Windows Hello";
  const pendingNotes = pending?.notes ? (pending.notes.split("\n")[0].includes(pending.version) ? pending.notes : `## ${pending.version} - available\n\n${pending.notes}`) : "";

  const rows: RowDef[] = [
    /* General */
    {
      id: "tray", page: "General", label: "Keep running in the tray", hint: "Closing the window keeps Kestral running, so tunnels and AI access stay up", keywords: "minimize close background",
      node: (
        <div style={row}>
          {noteHead("tray", "Keep running in the tray", "Closing the window keeps Kestral running, so tunnels and AI access stay up", trayNote)}
          <div style={ctlBox}><Toggle on={!!tray} disabled={tray === null} title={tray !== null ? undefined : trayLoadErr ? "Couldn't load this setting" : "Loading…"} onChange={setTrayPref} labelledBy={labelId("tray")} /></div>
        </div>
      ),
    },

    /* Appearance */
    {
      id: "theme", page: "Appearance", label: "Theme", hint: "Color mode of the app", keywords: "dark light system color mode",
      node: (
        <div style={row}>
          {head("theme", "Theme", "Color mode of the app")}
          <div style={ctlBox}><Seg<Theme> value={p.theme} labelledBy={labelId("theme")} options={THEMES.map((t) => ({ v: t, label: t[0].toUpperCase() + t.slice(1) }))} onChange={p.setTheme} /></div>
        </div>
      ),
    },
    {
      id: "anim", page: "Appearance", label: "Animations", hint: "Speed of motion in the app", keywords: "motion speed reduce",
      node: (
        <div style={row}>
          {head("anim", "Animations", "Speed of motion in the app")}
          <div style={ctlBox}>
            <Seg value={animValue} labelledBy={labelId("anim")} options={[{ v: "off", label: "Off" }, { v: "fast", label: "Fast" }, { v: "normal", label: "Normal" }, { v: "slow", label: "Slow" }]} onChange={(v) => p.setAnimScale(v === "off" ? 0 : v === "fast" ? 0.6 : v === "slow" ? 1.4 : 1)} />
          </div>
        </div>
      ),
    },

    /* Terminal */
    {
      id: "font", page: "Terminal", label: "Font", hint: "Used in every session", keywords: "typeface monospace",
      node: (
        <div style={row}>
          {head("font", "Font", "Used in every session", "st-font")}
          <FontSelect value={p.termFontFamily} onChange={p.setTermFontFamily} />
        </div>
      ),
    },
    {
      id: "size", page: "Terminal", label: "Size and line height", keywords: "font size line spacing",
      node: (
        <div style={row}>
          {head("size", "Size and line height")}
          <div style={{ display: "flex", gap: 8, width: 240 }}>
            <NumField id="st-size" label="Font size" value={p.termFontSize} min={8} max={32} step={1} unit="px" onCommit={p.setTermFontSize} style={{ width: "auto", flex: 1, minWidth: 0 }} />
            <NumField id="st-lh" label="Line height" value={p.termLineHeight} min={1} max={2.5} step={0.1} decimals={2} onCommit={p.setTermLineHeight} style={{ width: "auto", flex: 1, minWidth: 0 }} />
          </div>
        </div>
      ),
    },
    {
      id: "cursor", page: "Terminal", label: "Cursor", keywords: "block bar underline blink caret",
      node: (
        <div style={row}>
          {head("cursor", "Cursor")}
          <div style={ctlBox}>
            <Seg<CursorStyle> value={p.termCursor} labelledBy={labelId("cursor")} options={[{ v: "block", label: "Block" }, { v: "bar", label: "Bar" }, { v: "underline", label: "Underline" }]} onChange={p.setTermCursor} />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}><input type="checkbox" checked={p.termCursorBlink} onChange={(e) => p.setTermCursorBlink(e.target.checked)} />Blink</label>
          </div>
        </div>
      ),
    },
    {
      id: "scrollback", page: "Terminal", label: "Scrollback", hint: "Lines kept per session", keywords: "history buffer lines",
      node: (
        <div style={row}>
          {head("scrollback", "Scrollback", "Lines kept per session", "st-scroll")}
          <NumField id="st-scroll" value={p.termScrollback} min={0} max={200000} step={1000} onCommit={p.setTermScrollback} />
        </div>
      ),
    },
    {
      id: "copysel", page: "Terminal", label: "Copy on select", hint: "Selected text goes straight to the clipboard", keywords: "clipboard selection",
      node: (
        <div style={row}>
          {head("copysel", "Copy on select", "Selected text goes straight to the clipboard")}
          <div style={ctlBox}><Toggle on={p.termCopyOnSelect} onChange={p.setTermCopyOnSelect} labelledBy={labelId("copysel")} /></div>
        </div>
      ),
    },
    {
      id: "rclick", page: "Terminal", label: "Right click", keywords: "context menu paste mouse",
      node: (
        <div style={row}>
          {head("rclick", "Right click", undefined, "st-right")}
          <select id="st-right" value={p.termRightClick} onChange={(e) => p.setTermRightClick(e.target.value as RightClickMode)} style={field}>
            <option value="menu">Show context menu</option>
            <option value="paste">Paste</option>
          </select>
        </div>
      ),
    },
    {
      id: "bell", page: "Terminal", label: "Bell", keywords: "beep sound flash alert",
      node: (
        <div style={row}>
          {head("bell", "Bell", undefined, "st-bell")}
          <select id="st-bell" value={p.termBell} onChange={(e) => p.setTermBell(e.target.value as BellMode)} style={field}>
            <option value="flash">Flash the tab</option>
            <option value="sound">Sound</option>
            <option value="off">Off</option>
          </select>
        </div>
      ),
    },
    {
      id: "term-colors", page: "Terminal", group: "Colors", label: "Colored output", hint: "Render ANSI colors", keywords: "ansi color",
      node: (
        <div style={row}>
          {head("term-colors", "Colored output", "Render ANSI colors")}
          <div style={ctlBox}><Toggle on={p.termColors} onChange={p.setTermColors} labelledBy={labelId("term-colors")} /></div>
        </div>
      ),
    },
    {
      id: "scheme", page: "Terminal", group: "Colors", label: "Color scheme", hint: "Also tints the terminal frame", keywords: Object.values(TERMINAL_THEMES).map((t) => t.name).join(" ") + " theme palette",
      node: (
        <div style={blockRow}>
          {head("scheme", "Color scheme", "Also tints the terminal frame")}
          <div role="group" aria-labelledby={labelId("scheme")} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 10 }}>
            {Object.keys(TERMINAL_THEMES).map((id) => <SchemeCard key={id} id={id} colors={p.termColors} selected={p.termTheme === id} onSelect={() => p.setTermTheme(id)} />)}
          </div>
        </div>
      ),
    },
    {
      id: "preview", page: "Terminal", label: "Preview", keywords: "sample",
      node: (() => {
        const t = resolveTerminalTheme(p.termTheme, p.termColors, themedRoot());
        return (
          <div>
            <h2 style={groupHead}>Preview</h2>
            <div aria-label="Terminal preview" style={{ padding: "12px 14px", border: "1px solid var(--line)", borderRadius: 8, background: t.background, color: t.foreground, fontFamily: termFontStack(p.termFontFamily), fontSize: p.termFontSize, lineHeight: p.termLineHeight, overflow: "hidden" }}>
              <div style={{ whiteSpace: "pre" }}>deploy@web-01:~$ uptime</div>
              <div style={{ whiteSpace: "pre", color: t.brightBlack }}> 14:02:11 up 3 days,  2:41,  1 user,  load average: 0.08</div>
              <div style={{ whiteSpace: "pre" }}>deploy@web-01:~$ <span style={{ color: t.cursor ?? t.foreground }}><CursorPreview style={p.termCursor} blink={p.termCursorBlink} /></span></div>
            </div>
          </div>
        );
      })(),
    },

    /* Keyboard */
    ...keyRows,

    /* SSH */
    {
      id: "sftp-refresh", page: "General", label: "Auto-refresh SFTP folders", hint: "Re-read the open folder periodically", keywords: "sftp reload",
      node: (
        <div style={row}>
          {head("sftp-refresh", "Auto-refresh SFTP folders", "Re-read the open folder periodically")}
          <div style={ctlBox}><Toggle on={p.sftpAutoRefresh} onChange={p.setSftpAutoRefresh} labelledBy={labelId("sftp-refresh")} /></div>
        </div>
      ),
    },

    /* Vault and security */
    {
      id: "master", page: "Vault and security", label: "Master password", hint: "Unlocks the vault and encrypts all local data", keywords: "change password encryption unlock",
      node: (
        <div style={row}>
          {noteHead("master", "Master password", "Unlocks the vault and encrypts all local data", pwOk ? { tone: "ok", text: "Master password changed." } : null)}
          <div style={ctlBox}><button type="button" onClick={() => { setPwOk(false); setDialog("password"); }} style={rowBtn}>Change…</button></div>
        </div>
      ),
    },
    ...(showHello
      ? [
          {
            id: "hello", page: "Vault and security" as Page, label: helloMethod, hint: "Unlock without typing the master password. Changing the password turns it off", keywords: "windows hello touch id biometric pin quick unlock face fingerprint",
            node: (
              <div style={row}>
                {noteHead("hello", helloMethod, "Unlock without typing the master password. Changing the password turns it off", helloNote)}
                <div style={ctlBox}>
                  <button type="button" disabled={!hello || helloBusy} onClick={() => void toggleHello()} style={withDisabled(rowBtn, !hello || helloBusy)}>
                    <Stable text={helloBusy ? "Waiting…" : hello?.enabled ? "Turn off" : "Set up"} alts={["Set up", "Turn off", "Waiting…"]} />
                  </button>
                </div>
              </div>
            ),
          },
        ]
      : []),
    {
      id: "data-dir", page: "Vault and security", label: "Data folder", keywords: "location path files storage vault settings audit log",
      node: (
        <div style={row}>
          {noteHead("data-dir", "Data folder", <span title={dataDir || undefined} style={{ ...oneLine, display: "block" }}>{dataDir ? pathText(dataDir) : " "}</span>, revealErr ? { tone: "err", text: revealErr } : null)}
          <div style={ctlBox}><button type="button" disabled={!dataDir} onClick={() => void revealData()} style={withDisabled(rowBtn, !dataDir)}>Show in folder</button></div>
        </div>
      ),
    },
    {
      id: "export", page: "Vault and security", group: "Backup", label: "Export vault", hint: "Every host, key, password and snippet in one encrypted file", keywords: "backup transfer move file kvault",
      node: (
        <div style={row}>
          {noteHead("export", "Export vault", "Every host, key, password and snippet in one encrypted file", exportedTo ? { tone: "ok", text: `Exported to ${exportedTo}` } : null)}
          <div style={ctlBox}><button type="button" onClick={() => { setExportedTo(""); setDialog("export"); }} style={rowBtn}>Export…</button></div>
        </div>
      ),
    },
    {
      id: "import", page: "Vault and security", group: "Backup", label: "Import vault", hint: "Merge an exported file into this vault", keywords: "restore transfer move file kvault",
      node: (
        <div style={row}>
          {noteHead("import", "Import vault", "Merge an exported file into this vault", importMsg ? { tone: "ok", text: importMsg } : null)}
          <div style={ctlBox}><button type="button" onClick={() => { setImportMsg(""); setDialog("import"); }} style={rowBtn}>Import…</button></div>
        </div>
      ),
    },
    ...(warnings.length
      ? [{
          id: "warnings", page: "Vault and security" as Page, label: "Data warnings", keywords: "error problem",
          node: (
            <div style={{ margin: "12px 0 0", padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--warn-tint)", color: "var(--text)", fontSize: 12.5 }}>
              {warnings.map((w) => <p key={w} style={{ margin: 0 }}>{w}</p>)}
            </div>
          ),
        }]
      : []),

    /* About */
    {
      id: "version", page: "About", label: "Version", hint: "An SSH and SFTP client", keywords: "kestral app about",
      node: (
        <div style={row}>
          {head("version", "Kestral", "An SSH and SFTP client")}
          {textCtl(<span>Version <span style={{ color: "var(--text)", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{version || "…"}</span></span>)}
        </div>
      ),
    },
    {
      id: "updates", page: "About", label: "Updates", keywords: "update upgrade release github check",
      node: (() => {
        const status =
          upd.kind === "checking" ? "Checking for updates…"
          : upd.kind === "current" ? "You are on the latest version."
          : upd.kind === "available" ? `Update available, version ${upd.version}.`
          : upd.kind === "downloading" ? (upd.pct === null ? "Downloading…" : `Downloading… ${upd.pct}%`)
          : upd.kind === "ready" ? "Installed. Restarting…"
          : upd.kind === "error" ? upd.message
          : "Updates come from signed GitHub releases.";
        const shown = linkErr || status;
        const busy = upd.kind === "checking" || upd.kind === "downloading" || upd.kind === "ready";
        return (
          <div style={row}>
            <div style={rowHead}>
              <span id={labelId("updates")} style={{ fontWeight: 500 }}>Updates</span>
              <p aria-live="polite" title={shown} style={{ ...sub, ...oneLine, color: upd.kind === "error" || linkErr ? "var(--err)" : "var(--text-2)" }}>{shown}</p>
            </div>
            <div style={ctlBox}>
              {upd.kind === "available" ? (
                <button type="button" onClick={() => void installUpdate()} style={{ ...btnPrimary, height: 30 }}>Update now</button>
              ) : (
                <button type="button" disabled={busy} onClick={() => (upd.kind === "error" && updRef.current ? void installUpdate() : void checkUpdate())} style={withDisabled(rowBtn, busy)}>
                  <Stable text={upd.kind === "checking" ? "Checking…" : upd.kind === "downloading" ? "Updating…" : upd.kind === "ready" ? "Restarting…" : upd.kind === "error" ? "Try again" : "Check for updates"} alts={["Check for updates", "Checking…", "Updating…", "Restarting…", "Try again"]} />
                </button>
              )}
              {upd.kind === "error" && <button type="button" onClick={openReleases} style={linkBtn}>Get it on GitHub</button>}
            </div>
          </div>
        );
      })(),
    },
    {
      id: "changelog", page: "About", label: "Changelog", hint: "What changed in each version", keywords: "release notes history",
      node: (
        <div>
          <h2 id="st-changelog" style={groupHead}>Changelog</h2>
          <div data-selectable role="region" aria-labelledby="st-changelog" tabIndex={0} style={{ maxHeight: 360, overflow: "auto", padding: "14px 16px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-sunken)", fontSize: 12.5, color: "var(--text-2)", boxSizing: "border-box" }}>
            {pendingNotes && (
              <div style={{ paddingBottom: 14, marginBottom: 14, borderBottom: "1px solid var(--line)" }}>
                <Markdown text={pendingNotes} />
              </div>
            )}
            {changelogErr ? <p style={{ margin: 0, color: "var(--err)" }}>{changelogErr}</p> : changelog == null ? <p style={{ margin: 0 }}>Loading…</p> : changelog.trim() ? <Markdown text={changelog.replace(/^\s*# [^\n]*\n/, "")} /> : <p style={{ margin: 0 }}>No changelog available.</p>}
          </div>
        </div>
      ),
    },
  ];

  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const atWordStart = (hay: string, w: string) => {
    for (let at = hay.indexOf(w); at !== -1; at = hay.indexOf(w, at + 1)) if (at === 0 || !/[\p{L}\p{N}]/u.test(hay[at - 1])) return true;
    return false;
  };
  const matches = (r: RowDef) => {
    const hay = `${r.page} ${r.group ?? ""} ${r.label} ${r.hint ?? ""} ${r.keywords ?? ""}`.toLowerCase();
    return words.every((w) => atWordStart(hay, w));
  };
  const hits = q ? rows.filter(matches) : [];
  const pagesWithHits = new Set(hits.map((r) => r.page));

  const renderRows = (list: RowDef[]) => {
    let group: string | undefined;
    return list.map((r) => {
      const showGroup = r.group && r.group !== group;
      group = r.group;
      return (
        <div key={r.id}>
          {showGroup && <h2 style={groupHead}>{r.group}</h2>}
          {r.node}
        </div>
      );
    });
  };

  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 28px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Settings</h1>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0, borderTop: "1px solid var(--line)" }}>
        <nav aria-label="Settings sections" style={{ flex: "0 0 240px", display: "flex", flexDirection: "column", gap: 2, minWidth: 0, padding: "12px 10px", borderRight: "1px solid var(--line)", boxSizing: "border-box", overflow: "auto" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, height: 32, flex: "none", marginBottom: 6, padding: "0 10px", border: `1px solid ${searchFocus ? "var(--focus)" : "var(--line)"}`, borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text-2)", boxSizing: "border-box" }}>
            <SearchIcon size={14} />
            <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>Search settings</span>
            <input
              ref={searchRef}
              type="search"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              onFocus={() => setSearchFocus(true)}
              onBlur={() => setSearchFocus(false)}
              style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--text)" }}
            />
          </label>
          {PAGES.map((n) => {
            const active = !q && page === n;
            const dim = !!q && !pagesWithHits.has(n);
            return (
              <button key={n} type="button" data-nav aria-current={active ? "page" : undefined} onClick={() => { setQuery(""); setPage(n); }} style={{ height: 32, flex: "none", padding: "0 10px", border: 0, borderRadius: 6, background: active ? "var(--sel)" : undefined, color: dim ? "var(--text-3)" : "var(--text)", fontWeight: active ? 600 : 400, textAlign: "left", cursor: "pointer" }}>{n}</button>
            );
          })}
        </nav>

        <section key={q ? "search" : page} data-anim="screen" aria-label="Settings" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: "24px 28px 28px", overflow: "auto", boxSizing: "border-box" }}>
          <div style={{ width: "100%", maxWidth: 760 }}>
            {q ? (
              hits.length === 0 ? (
                <p style={{ margin: 0, color: "var(--text-2)" }}>No settings match “{query.trim()}”.</p>
              ) : (
                PAGES.filter((pg) => pagesWithHits.has(pg)).map((pg, i) => (
                  <section key={pg} style={{ marginTop: i ? 24 : 0 }}>
                    <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 600 }}>{pg}</h2>
                    {renderRows(hits.filter((r) => r.page === pg))}
                  </section>
                ))
              )
            ) : (
              <>
                <h2 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 600 }}>{page}</h2>
                {renderRows(rows.filter((r) => r.page === page))}
              </>
            )}
          </div>
        </section>
      </div>

      {dialog === "password" && (
        <ChangeMasterDialog
          onClose={() => setDialog(null)}
          onChanged={() => {
            setDialog(null);
            setPwOk(true);
            setHelloNote(null);
            refreshHello().catch(() => {});
          }}
        />
      )}
      {dialog === "export" && <ExportDialog onClose={() => setDialog(null)} onDone={(path) => { setDialog(null); setExportedTo(path); }} />}
      {dialog === "import" && (
        <ImportDialog
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            setImportMsg(importSummary(r));
            onVaultImported?.();
          }}
        />
      )}
    </main>
  );
}
