// Registry of live terminal panes, so app-level features (snippets, palette,
// shortcuts, host-key recovery) can reach a terminal without prop drilling.
// Kept free of xterm imports so it can ship in the main bundle.

export type SessionStatus = "connecting" | "connected" | "reconnecting" | "error" | "closed";
export type PaneStage = "connecting" | "connected" | "reconnecting" | "failed" | "ended";

/** How mirrored input is delivered: `secret` keeps it out of the audit log, `paste` re-wraps it per the receiving pane's paste mode. */
export interface PaneInput {
  secret?: boolean;
  paste?: boolean;
}

export interface PaneApi {
  hostId: string;
  /** False when the pane has no open shell, so nothing was sent. */
  write(data: string, input?: PaneInput): boolean;
  reconnect(): void;
  stage?(): PaneStage;
  clear?(): void;
  focus?(): void;
  password?(): string | null;
}

const panes = new Map<string, Map<string, PaneApi>>();
const byId = new Map<string, PaneApi>();
const handoff = new Map<string, string>();
const focused = new Map<string, string>();
const broadcasting = new Set<string>();

function tabPanes(tabId: string): Map<string, PaneApi> | undefined {
  const m = panes.get(tabId);
  return m && m.size > 0 ? m : undefined;
}

export const termBus = {
  register(tabId: string, paneId: string, api: PaneApi): () => void {
    let m = panes.get(tabId);
    if (!m) {
      m = new Map();
      panes.set(tabId, m);
    }
    m.set(paneId, api);
    byId.set(paneId, api);
    return () => {
      if (byId.get(paneId) === api) byId.delete(paneId);
      const cur = panes.get(tabId);
      if (!cur || cur.get(paneId) !== api) return;
      cur.delete(paneId);
      if (cur.size === 0) panes.delete(tabId);
      if (focused.get(tabId) === paneId) focused.delete(tabId);
    };
  },

  setFocused(tabId: string, paneId: string): void {
    focused.set(tabId, paneId);
  },

  /** Writes to the focused pane of the tab (or its first pane), or to every pane while broadcast is on. False if nothing was sent. */
  write(tabId: string, data: string, input: PaneInput = { paste: true }): boolean {
    const m = tabPanes(tabId);
    if (!m) return false;
    if (broadcasting.has(tabId)) {
      let sent = false;
      for (const p of m.values()) sent = p.write(data, input) || sent;
      return sent;
    }
    const f = focused.get(tabId);
    const target = (f && m.get(f)) || m.values().next().value;
    return target ? target.write(data, input) : false;
  },

  /** Reconnects the panes of that host whose session failed or ended. Live shells are left alone. */
  reconnectHost(hostId: string): number {
    let n = 0;
    for (const m of panes.values()) {
      for (const p of m.values()) {
        if (p.hostId !== hostId) continue;
        const stage = p.stage?.();
        if (stage === "failed" || stage === "ended") {
          p.reconnect();
          n++;
        }
      }
    }
    return n;
  },

  pane(tabId: string, paneId: string): PaneApi | undefined {
    return panes.get(tabId)?.get(paneId);
  },

  byId(paneId: string): PaneApi | undefined {
    return byId.get(paneId);
  },

  isBroadcast(tabId: string): boolean {
    return broadcasting.has(tabId);
  },

  /** Passes a password typed for one pane to a new pane of the same host. Kept in memory only, until that pane connected or failed. */
  handOver(paneId: string, password: string): void {
    handoff.set(paneId, password);
  },

  handedPassword(paneId: string): string | undefined {
    return handoff.get(paneId);
  },

  dropPassword(paneId: string): void {
    handoff.delete(paneId);
  },

  /** Mirrors input typed in one pane to every other pane of the same tab. */
  broadcast(tabId: string, fromPaneId: string, data: string, input?: PaneInput): void {
    const m = tabPanes(tabId);
    if (!m) return;
    for (const [id, p] of m) if (id !== fromPaneId) p.write(data, input);
  },

  setBroadcast(tabId: string, on: boolean): void {
    if (on) broadcasting.add(tabId);
    else broadcasting.delete(tabId);
  },
};
