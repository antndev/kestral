import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { MONO, SANS } from "./ui/mock";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

// Rendered outside PrefsProvider, so the theme is read the same way index.html does.
function themeClass(): string {
  try {
    const t = localStorage.getItem("kestral-theme");
    const dark = t === "dark" || ((t === "system" || !t) && window.matchMedia("(prefers-color-scheme: dark)").matches);
    return dark ? "t-dark" : "t-light";
  } catch {
    return "t-dark";
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={themeClass()} style={{ width: "100vw", height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, boxSizing: "border-box", background: "var(--bg)", color: "var(--text)", fontFamily: SANS, fontSize: 13 }}>
        <div data-tauri-drag-region style={{ position: "fixed", inset: "0 0 auto 0", height: 40 }} />
        <div role="alert" style={{ width: "100%", maxWidth: 520, display: "flex", flexDirection: "column", gap: 14, padding: 24, border: "1px solid var(--line)", borderRadius: 12, background: "var(--bg-side)", boxShadow: "var(--shadow)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--err)" }}>
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2 14.5 13.5h-13z" />
              <path d="M8 6.5v3M8 11.5h.01" />
            </svg>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Something went wrong</h1>
          </div>
          <p style={{ margin: 0, color: "var(--text-2)" }}>The window hit an unexpected error. Your vault and connections on disk are not affected. Reloading usually fixes it.</p>
          <pre data-selectable style={{ margin: 0, maxHeight: 240, overflow: "auto", padding: "10px 12px", borderRadius: 8, background: "var(--bg-sunken)", border: "1px solid var(--line)", fontFamily: MONO, fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-2)" }}>
            {error.message}
            {error.stack ? "\n\n" + error.stack : ""}
          </pre>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            style={{ alignSelf: "flex-start", height: 32, padding: "0 14px", border: "1px solid var(--btn-line)", borderRadius: 6, background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500, cursor: "pointer" }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
