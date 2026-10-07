import { CSSProperties, ReactNode, RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { writeText as clipWrite } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { addedLabel } from "../../api";
import type { ApprovalRequest, HostKeyChanged, HostKeyRequest, KnownHostEntry } from "../../api";
import { IS_MAC, MONO, errText } from "../mock";
import { CheckIcon, CopyIcon, CpuIcon, DownloadIcon, ShieldIcon, WarningIcon } from "../icons";
import { updateLock } from "../../lib/updateLock";
import { Markdown } from "../Markdown";

/* ---------- modal layer: topmost-only Escape, focus trap, focus restore ---------- */

type LayerOpts = {
  /** Lets the app tell which modal is on top, e.g. "palette". */
  kind?: string;
  onEscape?: () => void;
  onTab?: (backwards: boolean) => void;
  initialFocus?: RefObject<HTMLElement | null>;
};
type Layer = { id: number; container: RefObject<HTMLElement | null>; opts: { current: LayerOpts } };

// Open modals. Ids grow with mount order, and the same id sets the overlay's
// z-index, so the modal that gets the keyboard is always the one drawn on top.
const layers: Layer[] = [];
let nextLayer = 1;

function topLayer(): Layer | undefined {
  let top: Layer | undefined;
  for (const l of layers) if (!top || l.id > top.id) top = l;
  return top;
}

export function isModalOpen(): boolean {
  return layers.length > 0;
}

export function topModalKind(): string | null {
  return topLayer()?.opts.current.kind ?? null;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** App shortcut keys (with Ctrl, or Cmd on macOS) that must not act on what lies behind a modal. */
const APP_SHORTCUT_KEYS = new Set(["tab", "k", "p", "t", "w", "d", "l", ",", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
/** The palette lets its own open shortcuts through so pressing one again closes it. */
const PALETTE_KEYS = new Set(["k", "p", "t"]);

function onModalKeyDown(e: KeyboardEvent) {
  const top = topLayer();
  if (!top || e.isComposing) return;
  const opts = top.opts.current;
  const key = e.key.toLowerCase();
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;

  if (mod && !e.altKey && APP_SHORTCUT_KEYS.has(key)) {
    if (opts.kind === "palette" && PALETTE_KEYS.has(key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    return;
  }
  if (key === "escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    opts.onEscape?.();
  } else if (key === "tab") {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (opts.onTab) {
      opts.onTab(e.shiftKey);
      return;
    }
    const el = top.container.current;
    if (!el) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (items.length === 0) {
      el.focus();
      return;
    }
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1;
    items[next].focus();
  }
}

// Registered when the module loads, which is before the app adds its own window
// listeners, so the top modal sees keys first and can stop them from reaching the app.
window.addEventListener("keydown", onModalKeyDown, true);

/**
 * Registers a modal: Escape, Tab and app shortcuts go to the topmost one only,
 * focus moves in on mount and back out on unmount. Returns the z-index for its Overlay.
 */
export function useModalLayer(container: RefObject<HTMLElement | null>, opts: LayerOpts): number {
  const latest = useRef(opts);
  latest.current = opts;
  const [id] = useState(() => nextLayer++);

  useEffect(() => {
    const layer: Layer = { id, container, opts: latest };
    layers.push(layer);
    const previous = document.activeElement as HTMLElement | null;
    const root = container.current;
    const first = latest.current.initialFocus?.current ?? root?.querySelector<HTMLElement>(FOCUSABLE) ?? root;
    first?.focus({ preventScroll: true });

    return () => {
      const at = layers.indexOf(layer);
      if (at !== -1) layers.splice(at, 1);
      // Give focus back only if nothing else (a newly opened view) has claimed it.
      const active = document.activeElement;
      const lost = !active || active === document.body || (root?.contains(active) ?? false);
      if (lost && previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [id, container]);

  return 100 + id;
}

export function Overlay({
  z,
  align = "center",
  padding = "24px 16px",
  onBackdrop,
  children,
}: {
  /** z-index from useModalLayer. */
  z: number;
  align?: "center" | "flex-start";
  padding?: string;
  onBackdrop?: () => void;
  children: ReactNode;
}) {
  // Only a press that starts and ends on the backdrop closes, so selecting text
  // inside the dialog and releasing outside does not dismiss it.
  const downOnBackdrop = useRef(false);
  return (
    <div
      data-anim="overlay"
      data-align={align}
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (onBackdrop && downOnBackdrop.current && e.target === e.currentTarget) onBackdrop();
        downOnBackdrop.current = false;
      }}
      style={{ position: "fixed", inset: 0, zIndex: z, display: "flex", alignItems: align, justifyContent: "center", padding, background: "var(--overlay)", boxSizing: "border-box" }}
    >
      {children}
    </div>
  );
}

/* ---------- shared styles ---------- */

const dialogBox = (width: number): CSSProperties => ({
  width,
  maxWidth: "100%",
  maxHeight: "100%",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 18,
  padding: 24,
  borderRadius: 12,
  background: "var(--bg)",
  color: "var(--text)",
  boxShadow: "var(--shadow)",
  boxSizing: "border-box",
  outline: "none",
});
const dl: CSSProperties = { display: "grid", gridTemplateColumns: "96px minmax(0, 1fr)", gap: "8px 12px", margin: 0, padding: 14, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-sunken)" };
const dt: CSSProperties = { color: "var(--text-2)" };
const title: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600 };
const lead: CSSProperties = { margin: "6px 0 0", color: "var(--text-2)" };
const errLine: CSSProperties = { margin: 0, fontSize: 12, color: "var(--err)", overflowWrap: "anywhere" };
const btnBase: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, height: 32, padding: "0 14px", borderRadius: 6, boxSizing: "border-box", cursor: "pointer", whiteSpace: "nowrap", outlineColor: "var(--focus)", outlineOffset: 2 };
const btn = {
  secondary: { ...btnBase, border: "1px solid var(--line)", background: "var(--bg)", color: "var(--text)" } as CSSProperties,
  primary: { ...btnBase, padding: "0 16px", border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500 } as CSSProperties,
  danger: { ...btnBase, border: "1px solid var(--err)", background: "transparent", color: "var(--err)" } as CSSProperties,
  ghost: { ...btnBase, border: "1px solid transparent", background: "transparent", color: "var(--text-2)" } as CSSProperties,
};
const disabledStyle: CSSProperties = { opacity: 0.6, cursor: "default" };

const WORKING = "Working…";

function Button({
  kind = "secondary",
  disabled,
  title: tip,
  btnRef,
  onClick,
  children,
}: {
  kind?: keyof typeof btn;
  disabled?: boolean;
  /** Tooltip; disabled buttons use it to say why. */
  title?: string;
  btnRef?: RefObject<HTMLButtonElement | null>;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button ref={btnRef} type="button" disabled={disabled} title={tip} onClick={onClick} style={disabled ? { ...btn[kind], ...disabledStyle } : btn[kind]}>
      {children}
    </button>
  );
}

/** Buttons are passed in macOS order (primary last); Windows and Linux put the primary action first. */
function Actions({ children, left }: { children: ReactNode[]; left?: ReactNode }) {
  const ordered = IS_MAC ? children : [...children].reverse();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
      {left && <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text-2)" }}>{left}</div>}
      {ordered}
    </div>
  );
}

function IconTile({ tone, children }: { tone: "accent" | "err"; children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 10, background: tone === "accent" ? "var(--accent-tint)" : "var(--err-tint)", color: tone === "accent" ? "var(--link)" : "var(--err)" }}
    >
      {children}
    </span>
  );
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <g>
        <path d="M8 2a6 6 0 1 1-6 6" />
        <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.8s" repeatCount="indefinite" />
      </g>
    </svg>
  );
}

const ArrowUpRightIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 11 11 5M6 5h5v5" />
  </svg>
);

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

/** Seconds left until `deadline` (ms epoch), ticking once per second. */
function useSecondsLeft(deadline: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

function fmtCountdown(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Backend gives up on unanswered host key and approval prompts after 120 s. */
const PROMPT_TIMEOUT_MS = 120_000;

/* ---------- key helpers ---------- */

type KeyFamily = "ed25519" | "ecdsa" | "rsa" | null;

function keyFamily(keyType: string): KeyFamily {
  const t = keyType.toLowerCase();
  if (t.includes("ed25519")) return "ed25519";
  if (t.includes("ecdsa")) return "ecdsa";
  if (t.includes("rsa")) return "rsa";
  return null;
}

function keyLabel(keyType: string): string {
  const fam = keyFamily(keyType);
  if (fam === "ecdsa") {
    const curve = keyType.toLowerCase().match(/nistp\d+/)?.[0];
    return curve ? `ECDSA ${curve}` : "ECDSA";
  }
  return fam ? fam.toUpperCase() : keyType;
}

function hostPort(host: string, port: number) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

/* ---------- ConfirmDialog ---------- */

export function ConfirmDialog({
  title: heading,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm(): void | Promise<void>;
  onClose(): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const alive = useAlive();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const titleId = useId();
  const descId = useId();

  const close = () => {
    if (!busy) onClose();
  };
  const focusRef = danger ? cancelRef : confirmRef;
  const z = useModalLayer(ref, { onEscape: close, initialFocus: focusRef });

  useEffect(() => {
    if (err) focusRef.current?.focus();
  }, [err, focusRef]);

  async function confirm() {
    if (busy) return;
    // The focused button is about to be disabled; keep focus inside the dialog.
    ref.current?.focus();
    setBusy(true);
    setErr("");
    try {
      await onConfirm();
      if (alive.current) onClose();
    } catch (e) {
      if (!alive.current) return;
      setErr(errText(e));
      setBusy(false);
    }
  }

  return (
    <Overlay z={z} onBackdrop={danger ? undefined : close}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} aria-busy={busy} tabIndex={-1} style={dialogBox(440)}>
        <div>
          <h2 id={titleId} style={title}>{heading}</h2>
          <p id={descId} style={{ ...lead, overflowWrap: "anywhere" }}>{message}</p>
        </div>
        <p role="alert" style={{ ...errLine, minHeight: 17 }}>{err}</p>
        <Actions>
          {[
            <Button key="cancel" btnRef={cancelRef} disabled={busy} title={busy ? WORKING : undefined} onClick={close}>Cancel</Button>,
            <Button key="ok" btnRef={confirmRef} kind={danger ? "danger" : "primary"} disabled={busy} title={busy ? WORKING : undefined} onClick={confirm}>
              {busy && <Spinner />}
              {confirmLabel ?? (danger ? "Delete" : "Confirm")}
            </Button>,
          ]}
        </Actions>
      </section>
    </Overlay>
  );
}

/* ---------- HostKeyDialog ---------- */

export function HostKeyDialog({
  req,
  hostName,
  receivedAt,
  expired: expiredByBackend,
  replaced,
  onAnswer,
}: {
  req: HostKeyRequest;
  /** Name of the saved host this address belongs to; the lead sentence falls back to the address. */
  hostName?: string;
  /** When the hostkey-request event arrived (ms epoch); defaults to when the dialog opened. */
  receivedAt?: number;
  expired?: boolean;
  replaced?: boolean;
  onAnswer(accept: boolean, save: boolean): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [save, setSave] = useState(true);
  const [copied, setCopied] = useState<"" | "ok" | "err">("");
  const [answered, setAnswered] = useState(false);
  const [openedAt] = useState(() => receivedAt ?? Date.now());
  const left = useSecondsLeft(openedAt + PROMPT_TIMEOUT_MS);
  const expired = left === 0 || !!expiredByBackend;
  const titleId = useId();
  const descId = useId();
  const alive = useAlive();

  const answer = (accept: boolean, persist: boolean) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(accept, persist);
  };
  const z = useModalLayer(ref, { onEscape: () => answer(false, false), initialFocus: cancelRef });

  useEffect(() => {
    if (expired) closeRef.current?.focus();
  }, [expired]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => alive.current && setCopied(""), 1500);
    return () => window.clearTimeout(t);
  }, [copied, alive]);

  const fam = keyFamily(req.key_type);
  const checkCmd = fam
    ? `ssh-keygen -lf /etc/ssh/ssh_host_${fam}_key.pub`
    : 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done';

  return (
    <Overlay z={z}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1} style={dialogBox(540)}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <IconTile tone="accent"><ShieldIcon size={20} /></IconTile>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={title}>Verify the host key</h2>
            <p id={descId} style={{ ...lead, overflowWrap: "anywhere" }}>
              {replaced
                ? `You removed the old key for ${hostName || req.host}. Compare the new fingerprint with the one on the server before you trust it.`
                : `This is your first connection to ${hostName || req.host}. Compare the fingerprint with the one on the server before you trust it.`}
            </p>
          </div>
        </div>
        <dl style={dl}>
          <dt style={dt}>Host</dt>
          <dd data-selectable style={{ margin: 0, fontFamily: MONO, fontSize: 12, overflowWrap: "anywhere" }}>{hostPort(req.host, req.port)}</dd>
          <dt style={dt}>Key type</dt>
          <dd style={{ margin: 0 }}>{keyLabel(req.key_type)}</dd>
          <dt style={dt}>Fingerprint</dt>
          <dd style={{ display: "flex", alignItems: "flex-start", gap: 6, margin: 0 }}>
            <code style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>{req.fingerprint}</code>
            <button
              type="button"
              aria-label={copied === "ok" ? "Fingerprint copied" : "Copy fingerprint"}
              title={copied === "ok" ? "Copied" : copied === "err" ? "Could not copy" : "Copy fingerprint"}
              onClick={() =>
                clipWrite(req.fingerprint)
                  .then(() => alive.current && setCopied("ok"))
                  .catch(() => alive.current && setCopied("err"))
              }
              style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, border: 0, borderRadius: 4, background: "transparent", color: copied === "ok" ? "var(--ok)" : copied === "err" ? "var(--err)" : "var(--text-2)", cursor: "pointer", outlineColor: "var(--focus)" }}
            >
              {copied === "ok" ? <CheckIcon size={14} /> : copied === "err" ? <WarningIcon size={14} /> : <CopyIcon />}
            </button>
          </dd>
        </dl>
        <div>
          <p style={{ margin: "0 0 6px", fontSize: 12, color: "var(--text-2)" }}>Check it on the server with this command</p>
          <code style={{ display: "block", padding: "8px 10px", borderRadius: 6, background: "var(--term-bg)", color: "var(--term-text)", fontFamily: MONO, fontSize: 12, overflowWrap: "anywhere" }}>{checkCmd}</code>
        </div>
        {expired ? (
          <>
            <p role="alert" style={errLine}>This request timed out and the connection was refused. Connect again to retry.</p>
            <Actions>{[<Button key="close" kind="primary" btnRef={closeRef} onClick={() => answer(false, false)}>Close</Button>]}</Actions>
          </>
        ) : (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-start", cursor: "pointer" }}>
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} style={{ accentColor: "var(--accent)", outlineColor: "var(--focus)" }} />
              Save to known hosts
            </label>
            <Actions left={`Refused automatically in ${fmtCountdown(left)}`}>
              {[
                <Button key="cancel" btnRef={cancelRef} disabled={answered} title={answered ? WORKING : undefined} onClick={() => answer(false, false)}>Cancel</Button>,
                <Button key="once" disabled={answered} title={answered ? WORKING : undefined} onClick={() => answer(true, false)}>Connect once</Button>,
                <Button key="trust" kind="primary" disabled={answered} title={answered ? WORKING : undefined} onClick={() => answer(true, save)}>Trust and connect</Button>,
              ]}
            </Actions>
          </>
        )}
      </section>
    </Overlay>
  );
}

/* ---------- HostKeyChangedDialog ---------- */

export function HostKeyChangedDialog({
  info,
  saved,
  hostName,
  onReplace,
  onCancel,
}: {
  info: HostKeyChanged;
  saved: KnownHostEntry[];
  /** Name of the saved host this address belongs to; the lead sentence falls back to the address. */
  hostName?: string;
  /** May return a promise; the dialog shows a spinner meanwhile and the error inline if it rejects. */
  onReplace(): void | Promise<void>;
  onCancel(): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const alive = useAlive();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const titleId = useId();
  const descId = useId();

  const cancel = () => {
    if (!busy) onCancel();
  };
  const z = useModalLayer(ref, { onEscape: cancel, initialFocus: cancelRef });

  useEffect(() => {
    if (err) cancelRef.current?.focus();
  }, [err]);

  async function replace() {
    if (busy) return;
    ref.current?.focus();
    setBusy(true);
    setErr("");
    try {
      await onReplace();
    } catch (e) {
      if (alive.current) setErr(errText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <Overlay z={z} onBackdrop={cancel}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} aria-busy={busy} tabIndex={-1} style={dialogBox(540)}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <IconTile tone="err"><WarningIcon size={20} /></IconTile>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={title}>The host key has changed</h2>
            <p id={descId} style={{ ...lead, overflowWrap: "anywhere" }}>
              The key sent by {hostName || info.host} does not match the one you saved. The server may have been reinstalled, or someone may be intercepting the connection.
            </p>
          </div>
        </div>
        <dl style={dl}>
          <dt style={dt}>Host</dt>
          <dd data-selectable style={{ margin: 0, fontFamily: MONO, fontSize: 12, overflowWrap: "anywhere" }}>{hostPort(info.host, info.port)}</dd>
          <dt style={dt}>Saved key</dt>
          <dd style={{ margin: 0, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            {saved.length === 0 ? (
              <span style={{ color: "var(--text-2)" }}>No matching entry in your known hosts</span>
            ) : (
              saved.map((s) => (
                <div key={s.line} style={{ minWidth: 0 }}>
                  <code style={{ fontFamily: MONO, fontSize: 12, wordBreak: "break-all" }}>{keyLabel(s.key_type)} {s.fingerprint}</code>
                  {s.added && <div style={{ fontSize: 12, color: "var(--text-2)" }}>Added {addedLabel(s.added)}</div>}
                </div>
              ))
            )}
          </dd>
          <dt style={dt}>Received key</dt>
          <dd style={{ margin: 0, minWidth: 0 }}>
            <code style={{ fontFamily: MONO, fontSize: 12, color: "var(--err)", wordBreak: "break-all" }}>{keyLabel(info.key_type)} {info.fingerprint}</code>
          </dd>
        </dl>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-2)" }}>If you did not expect this, cancel and ask whoever runs the server.</p>
        <p role="alert" style={{ ...errLine, minHeight: 17 }}>{err}</p>
        <Actions>
          {[
            <Button key="replace" kind="danger" disabled={busy} title={busy ? WORKING : undefined} onClick={replace}>
              {busy && <Spinner />}
              Replace key and connect
            </Button>,
            <Button key="cancel" kind="primary" btnRef={cancelRef} disabled={busy} title={busy ? WORKING : undefined} onClick={cancel}>Cancel</Button>,
          ]}
        </Actions>
      </section>
    </Overlay>
  );
}

/* ---------- ApprovalDialog ---------- */

export function ApprovalDialog({
  req,
  receivedAt,
  expired: expiredByBackend,
  onAnswer,
}: {
  req: ApprovalRequest;
  /** When the approval-request event arrived (ms epoch); defaults to when the dialog opened. */
  receivedAt?: number;
  expired?: boolean;
  onAnswer(approved: boolean): void;
}) {
  const ref = useRef<HTMLElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const [answered, setAnswered] = useState(false);
  const [openedAt] = useState(() => receivedAt ?? Date.now());
  const left = useSecondsLeft(openedAt + PROMPT_TIMEOUT_MS);
  const timedOut = left === 0 || !!expiredByBackend;
  const isFile = req.command.startsWith("sftp ");
  const titleId = useId();
  const descId = useId();

  const answer = (approved: boolean) => {
    if (answered) return;
    setAnswered(true);
    onAnswer(approved);
  };
  const z = useModalLayer(ref, { onEscape: () => answer(false), initialFocus: denyRef });

  return (
    <Overlay z={z}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1} style={dialogBox(540)}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <IconTile tone="accent"><CpuIcon size={20} /></IconTile>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={title}>{isFile ? "AI wants to access files" : "AI wants to run a command"}</h2>
            <p id={descId} style={{ ...lead, overflowWrap: "anywhere" }}>
              On <span style={{ fontWeight: 500, color: "var(--text)" }}>{req.host_name}</span>. Review it before you allow it.
            </p>
          </div>
        </div>
        <pre
          data-selectable
          style={{ margin: 0, maxHeight: 208, overflow: "auto", padding: "10px 12px", borderRadius: 6, background: "var(--term-bg)", color: "var(--term-text)", fontFamily: MONO, fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {req.command}
        </pre>
        <Actions left={!timedOut ? `Denied automatically in ${fmtCountdown(left)}` : isFile ? "Timed out, the request was denied" : "Timed out, the command was denied"}>
          {[
            <Button key="deny" btnRef={denyRef} disabled={answered} title={answered ? WORKING : undefined} onClick={() => answer(false)}>Deny</Button>,
            <Button
              key="approve"
              kind="primary"
              disabled={answered || timedOut}
              title={timedOut ? "This request timed out" : answered ? WORKING : undefined}
              onClick={() => answer(true)}
            >
              {isFile ? "Approve" : <>Approve &amp; run</>}
            </Button>,
          ]}
        </Actions>
      </section>
    </Overlay>
  );
}

/* ---------- AiStoppedDialog ---------- */

export function AiStoppedDialog({ info, onClose }: { info: { host_name: string; path: string }; onClose(): void }) {
  const ref = useRef<HTMLElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const pathId = useId();
  const explId = useId();
  const z = useModalLayer(ref, { onEscape: onClose, initialFocus: okRef });

  return (
    <Overlay z={z} onBackdrop={onClose}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={`${descId} ${pathId} ${explId}`} tabIndex={-1} style={dialogBox(480)}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <IconTile tone="err"><ShieldIcon size={20} /></IconTile>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={title}>AI access stopped</h2>
            <p id={descId} style={{ ...lead, overflowWrap: "anywhere" }}>
              The AI tried to touch a protected path on <span style={{ fontWeight: 500, color: "var(--text)" }}>{info.host_name}</span>:
            </p>
          </div>
        </div>
        <code id={pathId} data-selectable style={{ display: "block", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--bg-sunken)", fontFamily: MONO, fontSize: 12, overflowWrap: "anywhere" }}>
          {info.path}
        </code>
        <p id={explId} style={{ margin: 0, color: "var(--text-2)" }}>
          Access was turned off so it cannot try another way. Turn it back on yourself in AI access if you want to continue.
        </p>
        <Actions>{[<Button key="ok" kind="primary" btnRef={okRef} onClick={onClose}>Understood</Button>]}</Actions>
      </section>
    </Overlay>
  );
}

/* ---------- UpdateDialog ---------- */

const RELEASES_URL = "https://github.com/antndev/kestral/releases/latest";

type DownloadEvent = { event: string; data?: { contentLength?: number; chunkLength?: number } };
type PendingUpdate = { version: string; body?: string; downloadAndInstall(cb: (e: DownloadEvent) => void): Promise<void> };
type UpdateWindow = { __kestralUpdate?: PendingUpdate };

async function pendingUpdate(): Promise<PendingUpdate> {
  const w = window as unknown as UpdateWindow;
  if (w.__kestralUpdate) return w.__kestralUpdate;
  const { check } = await import("@tauri-apps/plugin-updater");
  const found = await check();
  if (!found) throw "No update to install";
  w.__kestralUpdate = found;
  return found;
}

/** Downloads, installs and relaunches. `onPct` gets null while the size is unknown. */
async function installUpdate(onPct: (pct: number | null) => void) {
  if (updateLock.busy) throw new Error("An update is already installing.");
  const update = await pendingUpdate();
  updateLock.busy = true;

  const runDownload = async () => {
    let total = 0;
    let got = 0;
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") {
        total = e.data?.contentLength ?? 0;
        onPct(total ? 0 : null);
      } else if (e.event === "Progress") {
        got += e.data?.chunkLength ?? 0;
        onPct(total ? Math.min(100, Math.round((got / total) * 100)) : null);
      }
    });
  };

  // GitHub's release CDN and some antivirus scanners drop the connection now and
  // then ("error sending request"). A retry usually succeeds, so try a few times.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await runDownload();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e).toLowerCase();
      const retryable = ["error sending request", "connect", "timed out", "timeout", "request", "network", "reset"].some((k) => msg.includes(k));
      if (!retryable || attempt === 2) break;
      onPct(0);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  updateLock.busy = false;
  throw lastErr;
}

function friendlyUpdateError(e: unknown): string {
  const raw = errText(e).toLowerCase();
  if (["error sending request", "connect", "timed out", "timeout", "dns", "network", "tcp", "request"].some((k) => raw.includes(k))) {
    return "Couldn't reach GitHub to fetch the update. Check your connection, VPN or firewall, then try again.";
  }
  if (raw.includes("signature") || raw.includes("verif")) {
    return "The update's signature couldn't be verified. Try again; if it keeps failing, install the latest release from GitHub.";
  }
  if (raw.includes("permission") || raw.includes("denied") || raw.includes("os error 5")) {
    return IS_MAC
      ? "Your system blocked the update. Install the latest release from GitHub yourself, or allow it in your security software."
      : "Windows blocked the update. Close Kestral and run the installer yourself, or allow it in your antivirus.";
  }
  if (raw.includes("not found") || raw.includes("404")) {
    return "The update file wasn't available yet. It may still be publishing; try again in a few minutes.";
  }
  return "The update couldn't be completed. Please try again.";
}

export function UpdateDialog({ version, notes, onClose }: { version: string; notes: string; onClose(): void }) {
  const ref = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const alive = useAlive();
  const [phase, setPhase] = useState<"prompt" | "downloading" | "done" | "error">("prompt");
  const [pct, setPct] = useState<number | null>(0);
  const [err, setErr] = useState("");
  const [linkErr, setLinkErr] = useState("");
  const busy = phase === "downloading" || phase === "done";
  const titleId = useId();
  const descId = useId();
  const indeterminate = useCallback((el: HTMLDivElement | null) => {
    el?.animate([{ transform: "translateX(-100%)" }, { transform: "translateX(340%)" }], { duration: 1200, iterations: Infinity });
  }, []);

  const close = () => {
    if (!busy) onClose();
  };
  const z = useModalLayer(ref, { onEscape: close, initialFocus: primaryRef });

  useEffect(() => {
    if (phase === "error") primaryRef.current?.focus();
  }, [phase]);

  async function run() {
    // The focused button unmounts while downloading; keep focus inside the dialog.
    ref.current?.focus();
    setPhase("downloading");
    setPct(0);
    setErr("");
    try {
      await installUpdate((p) => alive.current && setPct(p));
      if (alive.current) setPhase("done");
    } catch (e) {
      if (!alive.current) return;
      setErr(friendlyUpdateError(e));
      setPhase("error");
    }
  }

  function openReleases() {
    setLinkErr("");
    openUrl(RELEASES_URL).catch((e) => alive.current && setLinkErr(errText(e)));
  }

  return (
    <Overlay z={z} onBackdrop={close}>
      <section ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} aria-busy={busy} tabIndex={-1} style={dialogBox(480)}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
          <IconTile tone="accent"><DownloadIcon size={20} /></IconTile>
          <div style={{ minWidth: 0 }}>
            <h2 id={titleId} style={title}>Update available</h2>
            <p id={descId} style={lead}>
              Version <span style={{ fontWeight: 500, color: "var(--text)" }}>{version}</span> is available.
            </p>
          </div>
        </div>

        <div style={{ height: 168, overflow: "auto", display: "flex", flexDirection: "column", justifyContent: phase === "prompt" ? "flex-start" : "center" }}>
        {phase === "prompt" && notes.trim() && (
          <div data-selectable style={{ paddingTop: 12, borderTop: "1px solid var(--line)", fontSize: 12, color: "var(--text-2)", overflowWrap: "anywhere" }}>
            <Markdown text={notes.trim()} />
          </div>
        )}
        {phase === "downloading" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
              style={{ height: 8, borderRadius: 4, background: "var(--bg-raised)", overflow: "hidden" }}
            >
              {pct === null ? (
                <div ref={indeterminate} style={{ height: "100%", width: "30%", background: "var(--accent)" }} />
              ) : (
                <div style={{ height: "100%", width: `${pct}%`, background: "var(--accent)", transition: "width 200ms" }} />
              )}
            </div>
            <span style={{ fontSize: 12, color: "var(--text-2)" }}>{pct === null ? "Downloading…" : `Downloading… ${pct}%`}</span>
          </div>
        )}
        {phase === "done" && <p style={{ margin: 0, color: "var(--text-2)" }}>Installed. Restarting Kestral…</p>}
        {phase === "error" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <p role="alert" style={errLine}>{err}</p>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-2)" }}>
              You can also download the installer from GitHub and run it; your hosts and settings stay.
            </p>
            {linkErr && <p style={errLine}>{linkErr}</p>}
          </div>
        )}

        </div>

        {phase === "prompt" && (
          <Actions>
            {[
              <Button key="later" onClick={onClose}>Later</Button>,
              <Button key="go" kind="primary" btnRef={primaryRef} onClick={run}><DownloadIcon />Update now</Button>,
            ]}
          </Actions>
        )}
        {busy && (
          <Actions>
            {[
              <Button key="busy" kind="primary" disabled title={phase === "done" ? "Restarting Kestral" : "Installing the update"} onClick={() => {}}>
                <Spinner />
                {phase === "done" ? "Restarting" : "Updating"}
              </Button>,
            ]}
          </Actions>
        )}
        {phase === "error" && (
          <Actions>
            {[
              <Button key="close" kind="ghost" onClick={onClose}>Close</Button>,
              <Button key="gh" onClick={openReleases}><ArrowUpRightIcon />Get it from GitHub</Button>,
              <Button key="retry" kind="primary" btnRef={primaryRef} onClick={run}>Try again</Button>,
            ]}
          </Actions>
        )}
      </section>
    </Overlay>
  );
}

/* ---------- TrayOnboardingDialog ---------- */

export function TrayOnboardingDialog({ onChoose }: { onChoose(minimizeToTray: boolean): void | Promise<void> }) {
  const ref = useRef<HTMLElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const [chosen, setChosen] = useState(false);
  const [err, setErr] = useState("");
  const alive = useAlive();
  const titleId = useId();
  const descId = useId();
  // A choice is required, so Escape and the backdrop do nothing here.
  const z = useModalLayer(ref, { initialFocus: keepRef });

  const choose = async (tray: boolean) => {
    if (chosen) return;
    setChosen(true);
    setErr("");
    try {
      await onChoose(tray);
    } catch (e) {
      if (!alive.current) return;
      setErr(errText(e));
      setChosen(false);
    }
  };

  return (
    <Overlay z={z}>
      <section ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1} style={dialogBox(460)}>
        <div>
          <h2 id={titleId} style={title}>Keep Kestral running in the tray?</h2>
          <p id={descId} style={lead}>
            Tunnels and AI access keep working while the window is closed. You can change this in Settings.
          </p>
        </div>
        <p role="alert" style={{ ...errLine, minHeight: 17 }}>{err}</p>
        <Actions>
          {[
            <Button key="quit" disabled={chosen} title={chosen ? WORKING : undefined} onClick={() => choose(false)}>Quit</Button>,
            <Button key="keep" kind="primary" btnRef={keepRef} disabled={chosen} title={chosen ? WORKING : undefined} onClick={() => choose(true)}>Keep in tray</Button>,
          ]}
        </Actions>
      </section>
    </Overlay>
  );
}
