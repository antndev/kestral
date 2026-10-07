// Window controls for the custom (frameless) title bar. Guarded so the same
// code runs in a plain browser preview, where there is no Tauri runtime.
export async function windowAction(action: "min" | "max" | "close") {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (action === "min") await w.minimize();
    else if (action === "max") await w.toggleMaximize();
    else await w.close();
  } catch {
    /* not running under Tauri */
  }
}
