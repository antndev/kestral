import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import * as api from "../api";
import { IS_MAC, SANS, errText, readJson } from "./mock";
import { WindowControls } from "./Shell";
import { DotField } from "./DotField";

export const HELLO_AUTO_KEY = "kestral-hello-auto";

const SHAKE_FRAMES = "{ 20%, 80% { transform: translateX(-2px) } 40% { transform: translateX(4px) } 60% { transform: translateX(-4px) } }";
const SHAKE = `@keyframes kst-shake-a ${SHAKE_FRAMES} @keyframes kst-shake-b ${SHAKE_FRAMES}`;
const shakeAnim = (n: number) => (n ? `${n % 2 ? "kst-shake-a" : "kst-shake-b"} 300ms ease-in-out` : undefined);

const field: CSSProperties = { width: "100%", height: 36, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-sunken)", color: "var(--text)", fontSize: 13, boxSizing: "border-box", outline: "none" };
const button: CSSProperties = { display: "grid", placeItems: "center", height: 32, padding: "0 16px", border: "1px solid var(--btn-line)", borderRadius: 6, background: "var(--btn)", color: "var(--btn-text)", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", boxSizing: "border-box" };
const card: CSSProperties = { display: "flex", flexDirection: "column", gap: 16, padding: 24, border: "1px solid var(--line)", borderRadius: 12, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,.28)" };
const heading: CSSProperties = { margin: 0, fontSize: 16, fontWeight: 600 };
const lead: CSSProperties = { margin: "4px 0 0", fontSize: 12.5, lineHeight: 1.45, color: "var(--text-3)" };
const actions: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minHeight: 32, marginTop: -4 };

function Spinner() {
  return <span aria-hidden="true" style={{ width: 14, height: 14, border: "2px solid color-mix(in srgb, currentColor 25%, transparent)", borderTopColor: "currentColor", borderRadius: "50%", boxSizing: "border-box", animation: "kst-spin 0.7s linear infinite" }} />;
}

function SubmitButton({ label, busy, ready }: { label: string; busy: boolean; ready: boolean }) {
  return (
    <button type="submit" disabled={!ready || busy} aria-label={busy ? `${label}…` : label} style={{ ...button, opacity: ready || busy ? 1 : 0.5, cursor: ready && !busy ? "pointer" : "default" }}>
      <span style={{ gridArea: "1 / 1", opacity: busy ? 0 : 1, transition: "opacity 120ms" }}>{label}</span>
      <span style={{ gridArea: "1 / 1", display: "flex", opacity: busy ? 1 : 0, transition: "opacity 120ms" }}>
        <Spinner />
      </span>
    </button>
  );
}

function FaceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" />
    </svg>
  );
}

function LockFrame({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div
      className={className}
      style={{ position: "relative", width: "100%", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-side)", color: "var(--text)", fontFamily: SANS, fontSize: 13, lineHeight: 1.4 }}>
      <style>{SHAKE}</style>
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", maskImage: "radial-gradient(circle at center, transparent 12%, #000 68%)", WebkitMaskImage: "radial-gradient(circle at center, transparent 12%, #000 68%)" }}>
        {className.includes("t-light") ? <DotField from="rgba(70,70,80,.38)" to="rgba(70,70,80,.12)" /> : <DotField from="rgba(150,150,162,.5)" to="rgba(150,150,162,.16)" />}
      </div>
      <header data-tauri-drag-region style={{ position: "relative", display: "flex", justifyContent: "flex-end", height: 40, flex: "none" }}>
        {!IS_MAC && <WindowControls />}
      </header>
      <main style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", justifyContent: "center", alignItems: "center", padding: "0 24px 64px", overflow: "auto" }}>
        <div data-anim="screen" style={{ width: "100%", maxWidth: 360 }}>
          {children}
        </div>
      </main>
    </div>
  );
}

export function LockScreen({ className, exists, error, autoHello, onUnlocked }: { className: string; exists: boolean; error?: string; autoHello?: boolean; onUnlocked: () => void | Promise<void> }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const [errField, setErrField] = useState<"pw" | "pw2">("pw");
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState(false);
  const [focus, setFocus] = useState<"pw" | "pw2" | null>(null);
  const [hello, setHello] = useState<api.HelloStatus | null>(null);
  const [helloBusy, setHelloBusy] = useState(false);
  const pwRef = useRef<HTMLInputElement | null>(null);
  const prompted = useRef(false);

  useEffect(() => {
    if (!exists) return;
    let live = true;
    api
      .helloStatus()
      .then((s) => live && setHello(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [exists]);

  const fail = (e: unknown, where: "pw" | "pw2" = "pw") => {
    setErr(errText(e));
    setErrField(where);
    setShake((n) => n + 1);
  };

  async function unlockWithHello() {
    if (helloBusy || busy) return;
    setErr("");
    setHelloBusy(true);
    try {
      await api.helloUnlock();
      await onUnlocked();
      setHelloBusy(false);
    } catch (e) {
      fail(e);
      setHelloBusy(false);
      pwRef.current?.focus();
      api
        .helloStatus()
        .then(setHello)
        .catch(() => {});
    }
  }

  useEffect(() => {
    if (!hello?.enabled || !autoHello || prompted.current || !readJson(HELLO_AUTO_KEY, false)) return;
    prompted.current = true;
    void unlockWithHello();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hello?.enabled, autoHello]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !pw) return;
    setErr("");
    if (!exists && pw.length < 8) {
      fail("Use at least 8 characters.");
      return;
    }
    if (!exists && pw !== pw2) {
      fail("The passwords do not match.", "pw2");
      return;
    }
    setBusy(true);
    try {
      if (exists) await api.vaultUnlock(pw);
      else await api.vaultCreate(pw);
      await onUnlocked();
      setPw("");
      setPw2("");
      setBusy(false);
    } catch (x) {
      fail(x);
      setBusy(false);
      window.setTimeout(() => {
        pwRef.current?.focus();
        pwRef.current?.select();
      }, 0);
    }
  }

  const onKey = (e: ReactKeyboardEvent) => setCaps(e.getModifierState("CapsLock"));
  const ring = (f: "pw" | "pw2"): CSSProperties => {
    const bad = !!err && errField === f;
    const color = bad ? "var(--err)" : focus === f ? "var(--focus)" : "var(--line)";
    return { borderColor: color, boxShadow: bad || focus === f ? `0 0 0 1px ${color}` : "none", transition: "border-color 120ms, box-shadow 120ms" };
  };
  const shown = err || error;
  const note = (
    <div style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: "15px", maxHeight: 30, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", color: shown ? "var(--err)" : "var(--warn)" }} role={shown ? "alert" : undefined}>
      {shown || (caps ? "Caps Lock is on" : "")}
    </div>
  );

  const input = (id: "pw" | "pw2", label: string) => (
    <input
      id={id === "pw" ? "lock-pw" : undefined}
      ref={id === "pw" ? pwRef : undefined}
      autoFocus={id === "pw"}
      type="password"
      aria-label={label}
      placeholder={label}
      aria-invalid={err && errField === id ? true : undefined}
      value={id === "pw" ? pw : pw2}
      onChange={(e) => {
        (id === "pw" ? setPw : setPw2)(e.target.value);
        if (err) setErr("");
      }}
      onKeyDown={onKey}
      onKeyUp={onKey}
      onFocus={() => setFocus(id)}
      onBlur={() => setFocus(null)}
      style={{ ...field, ...ring(id) }}
    />
  );

  if (exists) {
    return (
      <LockFrame className={className}>
        <form onSubmit={submit} style={card}>
          <div>
            <h1 style={heading}>Unlock vault</h1>
            <p style={lead}>Enter your master password to continue.</p>
          </div>
          <div style={{ animation: shakeAnim(shake) }}>{input("pw", "Master password")}</div>
          <div style={actions}>
            {note}
            {hello?.enabled && (
              <button
                type="button"
                aria-label={`Use ${hello.method}`}
                title={`Use ${hello.method}`}
                disabled={helloBusy || busy}
                onClick={() => void unlockWithHello()}
                style={{ ...button, width: 32, padding: 0, cursor: helloBusy || busy ? "default" : "pointer" }}
              >
                {helloBusy ? <Spinner /> : <FaceIcon />}
              </button>
            )}
            <SubmitButton label="Unlock" busy={busy} ready={!!pw} />
          </div>
        </form>
      </LockFrame>
    );
  }

  return (
    <LockFrame className={className}>
      <form onSubmit={submit} style={card}>
        <div>
          <h1 style={heading}>Create your vault</h1>
          <p style={lead}>Everything in Kestral is encrypted with this password. It cannot be recovered if you forget it.</p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, animation: shakeAnim(shake) }}>
          {input("pw", "Master password")}
          {input("pw2", "Repeat password")}
        </div>
        <div style={actions}>
          {note}
          <SubmitButton label="Create vault" busy={busy} ready={!!pw} />
        </div>
      </form>
    </LockFrame>
  );
}

export function BootScreen({ className, error, onRetry }: { className: string; error: string; onRetry(): void }) {
  return (
    <LockFrame className={className}>
      {error && (
        <div style={card}>
          <h1 style={heading}>Could not reach the Kestral backend</h1>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-2)", wordBreak: "break-word" }}>{error}</p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={onRetry} style={{ ...button, cursor: "pointer" }}>
              Retry
            </button>
          </div>
        </div>
      )}
    </LockFrame>
  );
}
