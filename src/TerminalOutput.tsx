import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { usePrefs } from "./lib/prefs";
import { resolveTerminalTheme, toneOf, type Tone } from "./lib/terminal-themes";
import { termFontStack } from "./ui/mock";
import { installDisposeGuard, oscLinkHandler } from "./lib/xtermGuard";

// A read-only xterm for command/script output. It matches the interactive
// terminal (same font, size, line height and GPU rendering) and streams: pass a
// growing `output` string and it writes only the new suffix as it arrives, so
// the log fills in live while the command runs. Split into its own lazy module
// so xterm stays out of the initial bundle.
export function LiveTerminalOutput({ output }: { output: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const written = useRef(0);
  const { termTheme, termColors, termFontSize, termLineHeight, termFontFamily } = usePrefs();
  const [tone, setTone] = useState<Tone>("dark");
  const [bg, setBg] = useState("");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    installDisposeGuard();
    // Start from a clean node so a re-mount never opens xterm over stale DOM.
    el.replaceChildren();
    const term = new XTerm({
      convertEol: true,
      disableStdin: true,
      cursorInactiveStyle: "none",
      fontFamily: termFontStack(termFontFamily),
      fontSize: termFontSize,
      lineHeight: termLineHeight,
      scrollback: 5000,
      theme: resolveTerminalTheme(termTheme, termColors, el),
      linkHandler: oscLinkHandler,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
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
      fitRef.current = null;
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

  useEffect(() => {
    const root = ref.current?.closest(".t-dark, .t-light");
    setTone(toneOf(ref.current));
    if (!root) return;
    const mo = new MutationObserver(() => setTone(toneOf(ref.current)));
    mo.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      const theme = resolveTerminalTheme(termTheme, termColors, ref.current);
      setBg(theme.background ?? "");
      term.options.theme = theme;
      term.options.fontFamily = termFontStack(termFontFamily);
      term.options.fontSize = termFontSize;
      term.options.lineHeight = termLineHeight;
      fitRef.current?.fit();
      term.refresh(0, term.rows - 1);
    } catch {
      return;
    }
  }, [termTheme, termColors, termFontSize, termLineHeight, termFontFamily, tone]);

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

  return (
    <div style={{ width: "100%", height: "100%", padding: "10px 12px", boxSizing: "border-box", background: bg || "var(--term-bg)" }}>
      <div ref={ref} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
