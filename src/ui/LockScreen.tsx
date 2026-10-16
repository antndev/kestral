import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import * as api from "../api";
import { IS_MAC, SANS, errText, readJson } from "./mock";
import { WindowControls } from "./Shell";
import bird from "../assets/bird.png";

export const HELLO_AUTO_KEY = "kestral-hello-auto";

const SHAKE_FRAMES = "{ 20%, 80% { transform: translateX(-2px) } 40% { transform: translateX(4px) } 60% { transform: translateX(-4px) } }";
const LOCK_CSS = `@keyframes kst-shake-a ${SHAKE_FRAMES} @keyframes kst-shake-b ${SHAKE_FRAMES}
.kst-lock-input::placeholder { color: var(--text-3) }`;
const shakeAnim = (n: number) => (n ? `${n % 2 ? "kst-shake-a" : "kst-shake-b"} 300ms ease-in-out` : undefined);

const title: CSSProperties = { margin: "0 0 10px", textAlign: "center", fontSize: 20, fontWeight: 600, letterSpacing: "-0.015em" };
const fieldBox: CSSProperties = { display: "flex", alignItems: "center", height: 42, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-sunken)", boxSizing: "border-box", transition: "border-color 160ms" };
const wide: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, height: 38, width: "100%", borderRadius: 8, fontSize: 13.5, boxSizing: "border-box" };
const primary: CSSProperties = { ...wide, border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500 };
const secondary: CSSProperties = { ...wide, border: "1px solid var(--line)", background: "transparent", color: "var(--text)" };
const card: CSSProperties = { display: "flex", flexDirection: "column", gap: 16, padding: 24, border: "1px solid var(--line)", borderRadius: 12, background: "var(--bg)", boxShadow: "0 16px 48px rgba(0,0,0,.28)" };
const smallBtn: CSSProperties = { display: "grid", placeItems: "center", height: 32, padding: "0 16px", border: "1px solid var(--btn-line)", borderRadius: 6, background: "var(--btn)", color: "var(--btn-text)", fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", boxSizing: "border-box" };

function Spinner() {
  return <span aria-hidden="true" style={{ width: 14, height: 14, border: "2px solid color-mix(in srgb, currentColor 25%, transparent)", borderTopColor: "currentColor", borderRadius: "50%", boxSizing: "border-box", animation: "kst-spin 0.7s linear infinite" }} />;
}

function PasskeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9.5" cy="7.5" r="3.5" />
      <path d="M3 20c0-3.6 2.9-6.5 6.5-6.5 1.1 0 2.2.3 3.1.8" />
      <circle cx="17.5" cy="14" r="2.5" />
      <path d="M17.5 16.5V22M17.5 19.5h2M17.5 21.5h1.5" />
    </svg>
  );
}

function CapsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4 4 12h4.5v4h7v-4H20L12 4ZM8.5 20h7" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function Brand() {
  return (
    <span data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: 8, flexDirection: IS_MAC ? "row-reverse" : "row" }}>
      <span data-tauri-drag-region aria-hidden="true" style={{ width: 17, height: 18, flex: "none", background: "var(--text-2)", WebkitMask: `url(${bird}) center / contain no-repeat`, mask: `url(${bird}) center / contain no-repeat` }} />
      <span data-tauri-drag-region style={{ fontSize: 13, fontWeight: 600, color: "var(--text-2)" }}>Kestral</span>
    </span>
  );
}

function LockFrame({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div
      className={className}
      style={{ position: "relative", width: "100%", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", color: "var(--text)", fontFamily: SANS, fontSize: 13, lineHeight: 1.4 }}>
      <style>{LOCK_CSS}</style>
      <header data-tauri-drag-region style={{ display: "flex", alignItems: "center", height: 40, flex: "none", padding: IS_MAC ? "0 14px 0 0" : "0 0 0 12px" }}>
        {!IS_MAC && <Brand />}
        <span data-tauri-drag-region style={{ flex: 1, alignSelf: "stretch" }} />
        {IS_MAC ? <Brand /> : <WindowControls />}
      </header>
      <main style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", justifyContent: "center", alignItems: "center", padding: "0 24px 64px", overflow: "auto" }}>
        <div style={{ width: "100%", maxWidth: 340 }}>{children}</div>
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
  const [reveal, setReveal] = useState(false);
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
  const shown = exists ? error : err || error;
  const ready = !!pw && (exists || !!pw2);

  const field = (id: "pw" | "pw2", label: string, eye: boolean) => {
    const bad = !!err && errField === id;
    const value = id === "pw" ? pw : pw2;
    return (
      <div style={{ ...fieldBox, borderColor: bad ? "var(--err)" : focus === id ? "color-mix(in srgb, var(--text) 26%, var(--line))" : "var(--line)" }}>
        <input
          id={id === "pw" ? "lock-pw" : undefined}
          ref={id === "pw" ? pwRef : undefined}
          className="kst-lock-input"
          autoFocus={id === "pw"}
          type={reveal ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          placeholder={label}
          aria-invalid={bad || undefined}
          value={value}
          onChange={(e) => {
            (id === "pw" ? setPw : setPw2)(e.target.value);
            if (err) setErr("");
          }}
          onKeyDown={onKey}
          onKeyUp={onKey}
          onFocus={() => setFocus(id)}
          onBlur={() => setFocus(null)}
          style={{ flex: 1, minWidth: 0, height: "100%", padding: eye ? "0 0 0 13px" : "0 13px", border: 0, background: "transparent", color: "var(--text)", fontSize: 14, letterSpacing: value && !reveal ? "0.16em" : undefined, outline: "none" }}
        />
        {caps && focus === id && (
          <span role="img" aria-label="Caps Lock is on" title="Caps Lock is on" style={{ display: "grid", placeItems: "center", width: 26, height: 34, marginRight: eye ? 0 : 6, flex: "none", color: "var(--warn)" }}>
            <CapsIcon />
          </span>
        )}
        {eye && (
          <button type="button" aria-label={reveal ? "Hide password" : "Show password"} title={reveal ? "Hide password" : "Show password"} onClick={() => setReveal((r) => !r)} style={{ display: "grid", placeItems: "center", width: 34, height: 34, marginRight: 4, flex: "none", border: 0, borderRadius: 6, background: "transparent", color: "var(--text-2)", cursor: "pointer" }}>
            <EyeIcon off={reveal} />
          </button>
        )}
      </div>
    );
  };

  const note = (
    <div role={shown ? "alert" : undefined} title={shown || undefined} style={{ position: "absolute", left: 0, right: 0, top: exists && !hello?.enabled ? "calc(100% - 38px)" : "100%", marginTop: exists && !hello?.enabled ? 4 : 14, fontSize: 12.5, lineHeight: "18px", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: shown ? "var(--err)" : "var(--text-3)" }}>
      {shown || (exists ? "" : "There is no way to recover it if you forget it.")}
    </div>
  );

  return (
    <LockFrame className={className}>
      <form onSubmit={submit} style={{ position: "relative", display: "flex", flexDirection: "column", gap: 10 }}>
        <h1 style={title}>{exists ? "Welcome back!" : "Welcome!"}</h1>
        {exists ? (
          <div style={{ animation: shakeAnim(shake) }}>{field("pw", "Password", true)}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, animation: shakeAnim(shake) }}>
            {field("pw", "Password", true)}
            {field("pw2", "Repeat password", false)}
          </div>
        )}
        <button type="submit" disabled={!ready || busy} style={{ ...primary, opacity: ready || busy ? 1 : 0.5, cursor: ready && !busy ? "pointer" : "default" }}>
          {busy ? <Spinner /> : exists ? "Unlock" : "Create vault"}
        </button>
        {exists && (
          <div style={{ height: 38 }}>
            {hello?.enabled && (
              <button type="button" disabled={helloBusy || busy} onClick={() => void unlockWithHello()} style={{ ...secondary, cursor: helloBusy || busy ? "default" : "pointer" }}>
                {helloBusy ? <Spinner /> : <PasskeyIcon />}
                Unlock with {hello.method}
              </button>
            )}
          </div>
        )}
        {note}
      </form>
    </LockFrame>
  );
}

/** Shown while the vault locks: the unlock screen fades in before the real one takes over at the same spot. */
export function LockingScreen({ className }: { className: string }) {
  return (
    <LockFrame className={className}>
      <div role="status" aria-label="Locking" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <h1 style={title}>Welcome back!</h1>
        <div style={{ ...fieldBox, padding: "0 13px", fontSize: 14, color: "var(--text-3)" }}>Password</div>
        <div style={{ ...primary, opacity: 0.5 }}>Unlock</div>
        <div style={{ height: 38 }} />
      </div>
    </LockFrame>
  );
}

export function BootScreen({ className, error, onRetry }: { className: string; error: string; onRetry(): void }) {
  return (
    <LockFrame className={className}>
      {error && (
        <div style={card}>
          <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Could not reach the Kestral backend</h1>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-2)", wordBreak: "break-word" }}>{error}</p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={onRetry} style={{ ...smallBtn, cursor: "pointer" }}>
              Retry
            </button>
          </div>
        </div>
      )}
    </LockFrame>
  );
}
