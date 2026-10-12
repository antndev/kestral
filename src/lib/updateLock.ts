import { IS_MAC, errText } from "../ui/mock";

export type UpdatePhase = { kind: "idle" } | { kind: "downloading"; pct: number | null } | { kind: "ready" } | { kind: "error"; message: string };

let phase: UpdatePhase = { kind: "idle" };
const listeners = new Set<() => void>();

export const updateLock = {
  busy: false,
  phase: () => phase,
  setPhase(next: UpdatePhase) {
    phase = next;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export const RELEASES_URL = "https://github.com/antndev/kestral/releases/latest";

type DownloadEvent = { event: string; data?: { contentLength?: number; chunkLength?: number } };
export type PendingUpdate = { version: string; body?: string; downloadAndInstall(cb: (e: DownloadEvent) => void): Promise<void> };
type UpdateWindow = { __kestralUpdate?: PendingUpdate };

export function knownUpdate(): PendingUpdate | undefined {
  return (window as unknown as UpdateWindow).__kestralUpdate;
}

export function rememberUpdate(u: PendingUpdate) {
  (window as unknown as UpdateWindow).__kestralUpdate = u;
}

async function pendingUpdate(): Promise<PendingUpdate> {
  const known = knownUpdate();
  if (known) return known;
  const { check } = await import("@tauri-apps/plugin-updater");
  const found = await check();
  if (!found) throw "No update to install";
  rememberUpdate(found);
  return found;
}

/** Downloads, installs and relaunches. `onPct` gets null while the size is unknown. */
export async function installUpdate(report?: (pct: number | null) => void) {
  if (updateLock.busy) throw new Error("An update is already installing.");
  const update = await pendingUpdate();
  updateLock.busy = true;
  const onPct = (pct: number | null) => {
    updateLock.setPhase({ kind: "downloading", pct });
    report?.(pct);
  };
  onPct(0);

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
      updateLock.setPhase({ kind: "ready" });
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
  updateLock.setPhase({ kind: "error", message: friendlyUpdateError(lastErr) });
  throw lastErr;
}

export function friendlyUpdateError(e: unknown): string {
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
