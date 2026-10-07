// xterm's WebGL renderer can throw a benign "reading '_isDisposed'" error from a
// requestAnimationFrame that fires just after the addon is disposed (on
// reconnect, or when a terminal tab is closed). It is a teardown race inside
// xterm, not a real fault, but uncaught it makes React unmount the whole view
// and drops you back to the host list. The synchronous dispose is already
// guarded; this swallows only that exact asynchronous disposal error and lets
// everything else propagate. Installed once, on first terminal mount.
let disposeGuardInstalled = false;
export function installDisposeGuard() {
  if (disposeGuardInstalled || typeof window === "undefined") return;
  disposeGuardInstalled = true;
  // Also xterm's Viewport.syncScrollArea "reading 'dimensions'", the same race
  // when a renderer is torn down before its queued frame runs.
  const isBenign = (msg: unknown) =>
    typeof msg === "string" && (msg.includes("_isDisposed") || msg.includes("reading 'dimensions'"));
  window.addEventListener(
    "error",
    (e) => {
      if (isBenign(e.message)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason as { message?: unknown } | undefined;
    if (isBenign(reason?.message) || isBenign(String(e.reason ?? ""))) {
      e.preventDefault();
    }
  });
}
