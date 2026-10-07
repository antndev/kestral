import type { MouseEvent as ReactMouseEvent } from "react";

export type DragHandlers = {
  label: string;
  onMove(target: Element | null, pt: { x: number; y: number }): void;
  onDrop(target: Element | null, pt: { x: number; y: number }): void;
  onEnd(): void;
};

let dragging = false;

export function isDragging() {
  return dragging;
}

export function beginDrag(e: ReactMouseEvent, h: DragHandlers) {
  if (e.button !== 0) return;
  const origin = e.currentTarget as HTMLElement;
  const sx = e.clientX;
  const sy = e.clientY;
  let active = false;
  let ghost: HTMLDivElement | null = null;

  const cleanup = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", up, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    ghost?.remove();
    ghost = null;
    document.documentElement.style.cursor = "";
    document.documentElement.style.userSelect = "";
    dragging = false;
  };

  const swallowClick = () => {
    const stop = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", stop, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
  };

  const move = (ev: MouseEvent) => {
    if (!active) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 5) return;
      active = true;
      dragging = true;
      ghost = document.createElement("div");
      ghost.textContent = h.label;
      Object.assign(ghost.style, {
        position: "fixed",
        zIndex: "100002",
        pointerEvents: "none",
        padding: "3px 8px",
        borderRadius: "6px",
        border: "1px solid var(--line)",
        background: "var(--bg)",
        color: "var(--text)",
        boxShadow: "var(--shadow)",
        fontSize: "12px",
        whiteSpace: "nowrap",
      });
      (origin.closest(".t-dark, .t-light") ?? document.body).appendChild(ghost);
      document.documentElement.style.cursor = "grabbing";
      document.documentElement.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }
    ev.preventDefault();
    if (ghost) {
      ghost.style.left = `${ev.clientX + 14}px`;
      ghost.style.top = `${ev.clientY + 10}px`;
    }
    h.onMove(document.elementFromPoint(ev.clientX, ev.clientY), { x: ev.clientX, y: ev.clientY });
  };

  const up = (ev: MouseEvent) => {
    const was = active;
    const target = was ? document.elementFromPoint(ev.clientX, ev.clientY) : null;
    cleanup();
    if (!was) return;
    swallowClick();
    h.onDrop(target, { x: ev.clientX, y: ev.clientY });
    h.onEnd();
  };

  const cancel = () => {
    const was = active;
    cleanup();
    if (was) h.onEnd();
  };

  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape" || !active) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
  };

  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", up, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
