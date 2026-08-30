import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { usePrefs } from "./lib/prefs";
import { terminalTheme } from "./lib/terminal-themes";

// A read-only xterm for command/script output. It matches the interactive
// terminal (same font, size, line height and GPU rendering) and streams: pass a
// growing `output` string and it writes only the new suffix as it arrives, so
// the log fills in live while the command runs. Split into its own lazy module
// so xterm stays out of the initial bundle.
export function LiveTerminalOutput({ output }: { output: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const written = useRef(0);
  const { termTheme, termColors } = usePrefs();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Start from a clean node so a re-mount never opens xterm over stale DOM.
    el.replaceChildren();
    const term = new XTerm({
      convertEol: true,
      disableStdin: true,
      cursorInactiveStyle: "none",
      fontFamily: "Consolas, ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: terminalTheme(termTheme, termColors),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // Crisp GPU text, matching the interactive terminal; falls back to the DOM
    // renderer if WebGL is unavailable.
    let webgl: WebglAddon | undefined;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        try {
          webgl?.dispose();
        } catch {
          /* already gone */
        }
      });
      term.loadAddon(webgl);
    } catch {
      webgl = undefined; /* no WebGL; DOM renderer stays */
    }
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    termRef.current = term;
    written.current = 0;
    if (output) {
      term.write(output);
      written.current = output.length;
    }
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* detached */
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      // Drop the ref first so a stream update firing during teardown bails out.
      termRef.current = null;
      // Dispose the WebGL addon before the terminal, each guarded: collapsing the
      // log tears these down synchronously and xterm can throw a benign
      // `_isDisposed` on the dispose race. Swallow it so it never reaches React's
      // error boundary.
      try {
        webgl?.dispose();
      } catch {
        /* WebGL already lost */
      }
      try {
        term.dispose();
      } catch {
        /* benign _isDisposed race */
      }
    };
    // Created once; live updates are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write only what has arrived since the last render, so streaming stays cheap.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      if (output.length < written.current) {
        term.clear();
        written.current = 0;
      }
      if (output.length > written.current) {
        term.write(output.slice(written.current));
        written.current = output.length;
      }
    } catch {
      /* terminal disposed mid-update; ignore */
    }
  }, [output]);

  return <div ref={ref} className="h-full w-full" />;
}
