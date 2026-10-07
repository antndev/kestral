import React, { useEffect, useRef } from "react";

export type ContextItem = { label: string; danger?: boolean; onClick(): void };

export function ContextMenu({ pos, items, label = "Actions", onClose }: { pos: { x: number; y: number }; label?: string; items: ContextItem[]; onClose(restore: boolean): void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current(false);
    };
    const onBlur = () => close.current(false);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      btns[(n + btns.length) % btns.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(btns.length - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    }
  };
  const left = Math.max(4, Math.min(pos.x, window.innerWidth - 214));
  const top = Math.max(4, Math.min(pos.y, window.innerHeight - (items.length * 30 + 12)));
  return (
    <div ref={ref} role="menu" aria-label={label} onKeyDown={onKeyDown} onContextMenu={(e) => e.preventDefault()} style={{ position: "fixed", left, top, zIndex: 95, minWidth: 200, padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)" }}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose(false);
            it.onClick();
          }}
          style={{ display: "flex", alignItems: "center", width: "100%", height: 30, padding: "0 10px", border: 0, borderRadius: 6, background: "transparent", color: it.danger ? "var(--err)" : "var(--text)", textAlign: "left", cursor: "pointer", fontSize: 13, outline: "none" }}
          onMouseEnter={(e) => e.currentTarget.focus()}
          onFocus={(e) => (e.currentTarget.style.background = "var(--sel)")}
          onBlur={(e) => (e.currentTarget.style.background = "transparent")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

