import { Suspense, lazy, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Host } from "../api";
import { termBus } from "./termBus";
import { paneHost, paneStore } from "./panes";

// xterm and its addons are heavy, so they load with the first terminal instead
// of with the app.
const SshTerminal = lazy(() => import("../SshTerminal").then((m) => ({ default: m.SshTerminal })));

export type PoolPane = { id: string; tabId: string; host: Host; focused: boolean; initialCommand?: string };

export function PanePool({ panes, onBell, onEditHost, onClosePane }: { panes: PoolPane[]; onBell(paneId: string): void; onEditHost(h: Host): void; onClosePane(paneId: string): void }) {
  const parkRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    paneHost.setParking(parkRef.current);
    return () => paneHost.setParking(null);
  }, []);

  useLayoutEffect(() => {
    paneHost.parkStray();
  });

  const ids = panes.map((p) => p.id).join(",");
  useEffect(() => {
    const live = new Set(ids ? ids.split(",") : []);
    const gone = paneHost.ids().filter((id) => !live.has(id));
    gone.forEach((id) => {
      paneHost.release(id);
      termBus.dropPassword(id);
    });
    paneStore.remove(gone);
  }, [ids]);

  return (
    <>
      <div ref={parkRef} aria-hidden="true" style={{ display: "none" }} />
      {panes.map((p) =>
        createPortal(
          <Suspense fallback={<div style={{ height: "100%", background: "var(--term-bg)" }} />}>
            <SshTerminal
              hostId={p.host.id}
              hostName={p.host.name}
              hostAddress={p.host.hostname}
              tabId={p.tabId}
              paneId={p.id}
              focused={p.focused}
              initialCommand={p.initialCommand}
              startupCommand={p.host.options?.startup_command}
              encoding={p.host.options?.encoding}
              themeOverride={p.host.options?.terminal_theme}
              onClosePane={() => onClosePane(p.id)}
              onEditHost={() => onEditHost(p.host)}
              onProcess={(proc) => paneStore.patch(p.id, { proc })}
              onAuth={(auth) => paneStore.patch(p.id, { auth })}
              onLatency={(latency) => paneStore.patch(p.id, { latency })}
              onStatus={(stage) => paneStore.patch(p.id, { stage })}
              onNote={(n) => paneStore.patch(p.id, { attempt: n.attempt, of: n.of, retryAt: n.at, note: n.text })}
              onResize={(cols, rows) => paneStore.patch(p.id, { cols, rows })}
              onUserInput={(data, info) => {
                if (termBus.isBroadcast(p.tabId)) termBus.broadcast(p.tabId, p.id, data, info);
              }}
              onBell={() => {
                paneStore.bell(p.id);
                onBell(p.id);
              }}
              onTitle={(t) => paneStore.patch(p.id, { title: t.trim() })}
            />
          </Suspense>,
          paneHost.container(p.id),
          p.id,
        ),
      )}
    </>
  );
}
