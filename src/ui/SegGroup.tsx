import { CSSProperties, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

export const segItem = (on: boolean, extra?: CSSProperties): CSSProperties => ({
  position: "relative",
  height: 26,
  padding: "0 10px",
  border: 0,
  borderRadius: 4,
  background: "transparent",
  color: on ? "var(--text)" : "var(--text-2)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "color 160ms",
  ...extra,
});

export function SegGroup({ label, labelledBy, value, style, children }: { label?: string; labelledBy?: string; value: unknown; style?: CSSProperties; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return;
    const measure = () => {
      const b = g.querySelector<HTMLElement>(':scope > [aria-pressed="true"]');
      setBox(b ? { x: b.offsetLeft, y: b.offsetTop, w: b.offsetWidth, h: b.offsetHeight } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(g);
    return () => ro.disconnect();
  }, [value]);

  useEffect(() => {
    if (!box || ready) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [box, ready]);

  return (
    <div ref={ref} role="group" aria-label={label} aria-labelledby={labelledBy} style={{ position: "relative", display: "flex", padding: 2, border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", ...style }}>
      {box && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: box.w,
            height: box.h,
            transform: `translate(${box.x}px, ${box.y}px)`,
            borderRadius: 4,
            background: "var(--bg)",
            boxShadow: "0 0 0 1px var(--line)",
            transition: ready ? "transform 240ms var(--ease-out), width 240ms var(--ease-out)" : "none",
            pointerEvents: "none",
          }}
        />
      )}
      {children}
    </div>
  );
}
