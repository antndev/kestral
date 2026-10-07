import React from "react";
import ReactDOM from "react-dom/client";
import RealApp from "./RealApp";
import { ErrorBoundary } from "./ErrorBoundary";
import { PrefsProvider } from "./lib/prefs";
import "./index.css";
import "./tokens.css";

// In a plain browser (no Tauri runtime) install a mock IPC so the full UI can be
// tested without a backend. The real desktop app always has __TAURI_INTERNALS__.
if (!("__TAURI_INTERNALS__" in window)) {
  const { installDevMock } = await import("./devMock");
  installDevMock();
}

document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (t && t.closest("input, textarea, .xterm, pre, code, [data-selectable]")) return;
  e.preventDefault();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "r")) {
    e.preventDefault();
    return;
  }
  if (e.key === "F12") {
    e.preventDefault();
    return;
  }
  if (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key.toUpperCase())) {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <PrefsProvider>
        <RealApp />
      </PrefsProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
