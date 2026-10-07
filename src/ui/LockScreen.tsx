import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import * as api from "../api";
import { IS_MAC, SANS, errText } from "./mock";
import { WindowControls } from "./Shell";
import { Stable } from "./Stable";

const SHAKE_FRAMES = "{ 20%, 80% { transform: translateX(-2px) } 40% { transform: translateX(4px) } 60% { transform: translateX(-4px) } }";
const SHAKE = `@keyframes kst-shake-a ${SHAKE_FRAMES} @keyframes kst-shake-b ${SHAKE_FRAMES}`;
const shakeAnim = (n: number) => (n ? `${n % 2 ? "kst-shake-a" : "kst-shake-b"} 300ms ease-in-out` : undefined);

const field: CSSProperties = { width: "100%", height: 38, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-sunken)", color: "var(--text)", fontSize: 13, boxSizing: "border-box", outline: "none" };
const button: CSSProperties = { height: 38, padding: "0 14px", border: "1px solid var(--btn-line)", borderRadius: 8, background: "var(--btn)", color: "var(--btn-text)", fontSize: 13, fontWeight: 500, cursor: "pointer", whiteSpace: "nowrap" };
const textButton: CSSProperties = { padding: 0, border: 0, background: "transparent", color: "var(--text-2)", fontSize: 12, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2 };
const title: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 600, textAlign: "center" };

function LockFrame({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={className} style={{ width: "100%", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", color: "var(--text)", fontFamily: SANS, fontSize: 13, lineHeight: 1.4 }}>
      <style>{SHAKE}</style>
      <header data-tauri-drag-region style={{ display: "flex", justifyContent: "flex-end", height: 40, flex: "none" }}>
        {!IS_MAC && <WindowControls />}
      </header>
      <main style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center", alignItems: "center", padding: "0 24px 64px", overflow: "auto" }}>
        <div data-anim="screen" style={{ width: "100%", maxWidth: 300 }}>
          {children}
        </div>
      </main>
    </div>
  );
}

function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

export function LockScreen({ className, exists, error, onUnlocked }: { className: string; exists: boolean; error?: string; onUnlocked: () => void | Promise<void> }) {
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
      api
        .helloStatus()
        .then(setHello)
        .catch(() => {});
    }
  }

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
  const note = shown ? (
    <span role="alert" style={{ color: "var(--err)" }}>{shown}</span>
  ) : caps ? (
    <span style={{ color: "var(--warn)" }}>Caps Lock is on</span>
  ) : null;

  if (exists) {
    const ready = !!pw && !busy;
    return (
      <LockFrame className={className}>
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <label htmlFor="lock-pw" style={title}>
            Unlock Kestral
          </label>
          <div style={{ position: "relative", animation: shakeAnim(shake) }}>
            <input
              id="lock-pw"
              ref={pwRef}
              autoFocus
              type="password"
              placeholder="Master password"
              aria-invalid={err ? true : undefined}
              value={pw}
              onChange={(e) => {
                setPw(e.target.value);
                if (err) setErr("");
              }}
              onKeyDown={onKey}
              onKeyUp={onKey}
              onFocus={() => setFocus("pw")}
              onBlur={() => setFocus(null)}
              style={{ ...field, paddingRight: 44, ...ring("pw") }}
            />
            <button
              type="submit"
              aria-label={busy ? "Unlocking" : "Unlock"}
              title="Unlock"
              disabled={!ready}
              style={{ position: "absolute", top: 5, right: 5, display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, padding: 0, border: 0, borderRadius: 6, background: ready || busy ? "var(--btn)" : "transparent", color: ready ? "var(--text)" : "var(--text-3)", cursor: ready ? "pointer" : "default", transition: "background 120ms, color 120ms" }}
            >
              {busy ? <span aria-hidden="true" style={{ width: 13, height: 13, border: "1.6px solid var(--line)", borderTopColor: "var(--text)", borderRadius: "50%", boxSizing: "border-box", animation: "kst-spin 0.7s linear infinite" }} /> : <ArrowIcon />}
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, fontSize: 12, textAlign: "center" }}>
            <span style={{ minHeight: 17 }}>{note}</span>
            {hello?.enabled && (
              <button type="button" onClick={() => void unlockWithHello()} disabled={helloBusy} style={{ ...textButton, cursor: helloBusy ? "default" : "pointer" }}>
                <Stable text={helloBusy ? `Waiting for ${hello.method}…` : `Use ${hello.method}`} alts={[`Use ${hello.method}`, `Waiting for ${hello.method}…`]} />
              </button>
            )}
          </div>
        </form>
      </LockFrame>
    );
  }

  return (
    <LockFrame className={className}>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <label htmlFor="lock-pw" style={title}>
          Create your vault
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, animation: shakeAnim(shake) }}>
          <input
            id="lock-pw"
            ref={pwRef}
            autoFocus
            type="password"
            placeholder="Master password"
            aria-invalid={err ? true : undefined}
            value={pw}
            onChange={(e) => {
              setPw(e.target.value);
              if (err) setErr("");
            }}
            onKeyDown={onKey}
            onKeyUp={onKey}
            onFocus={() => setFocus("pw")}
            onBlur={() => setFocus(null)}
            style={{ ...field, ...ring("pw") }}
          />
          <input
            type="password"
            aria-label="Repeat password"
            placeholder="Repeat password"
            value={pw2}
            onChange={(e) => {
              setPw2(e.target.value);
              if (err) setErr("");
            }}
            onKeyDown={onKey}
            onKeyUp={onKey}
            onFocus={() => setFocus("pw2")}
            onBlur={() => setFocus(null)}
            style={{ ...field, ...ring("pw2") }}
          />
        </div>
        <button type="submit" disabled={!pw || busy} style={{ ...button, width: "100%", opacity: pw && !busy ? 1 : 0.5, cursor: pw && !busy ? "pointer" : "default" }}>
          <Stable text={busy ? "Creating…" : "Create vault"} alts={["Create vault", "Creating…"]} />
        </button>
        <div style={{ minHeight: 17, fontSize: 12, textAlign: "center", color: "var(--text-3)" }}>{note ?? "A forgotten master password cannot be recovered."}</div>
      </form>
    </LockFrame>
  );
}

export function BootScreen({ className, error, onRetry }: { className: string; error: string; onRetry(): void }) {
  return (
    <LockFrame className={className}>
      {error && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Could not reach the Kestral backend</span>
          <span style={{ fontSize: 12, color: "var(--text-2)", wordBreak: "break-word" }}>{error}</span>
          <button type="button" onClick={onRetry} style={button}>
            Retry
          </button>
        </div>
      )}
    </LockFrame>
  );
}
