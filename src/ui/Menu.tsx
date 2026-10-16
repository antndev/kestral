import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { DotsIcon } from "./icons";

export type MenuItem = {
  label: string;
  hint?: string;
  disabled?: boolean;
  /** Tooltip, e.g. why the entry is disabled. */
  title?: string;
  danger?: boolean;
  onSelect(): void | Promise<void>;
};

/** `null` renders a separator; leading, trailing and doubled separators are dropped. */
export type MenuEntry = MenuItem | null | false | undefined;

export type MenuAnchor = { x: number; y: number } | { el: HTMLElement };

type Open<K> = { anchor: MenuAnchor; key: K; fromButton: boolean };

function tidy(entries: MenuEntry[]): (MenuItem | null)[] {
  const out: (MenuItem | null)[] = [];
  for (const e of entries) {
    if (e === false || e === undefined) continue;
    if (e === null && (out.length === 0 || out[out.length - 1] === null)) continue;
    out.push(e);
  }
  while (out.length && out[out.length - 1] === null) out.pop();
  return out;
}

/**
 * One menu state per screen. Rows call `openAt` from onContextMenu, the "…" button
 * calls `toggle`; both open the same menu for the same item, so actions never differ
 * between right click and the button.
 */
export function useMenu<K = string>() {
  const [open, setOpen] = useState<Open<K> | null>(null);
  const buttons = useRef(new Map<string, HTMLElement>());
  const openAt = useCallback((e: ReactMouseEvent, key: K, fallback?: HTMLElement | null) => {
    e.preventDefault();
    e.stopPropagation();
    const el = fallback ?? buttons.current.get(String(key)) ?? (e.currentTarget as HTMLElement);
    setOpen({ anchor: e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : { el }, key, fromButton: false });
  }, []);
  const toggle = useCallback((el: HTMLElement, key: K) => {
    setOpen((o) => (o && o.fromButton && o.key === key ? null : { anchor: { el }, key, fromButton: true }));
  }, []);
  const close = useCallback(() => setOpen(null), []);
  const registerButton = useCallback((key: K, el: HTMLElement | null) => {
    if (el) buttons.current.set(String(key), el);
    else buttons.current.delete(String(key));
  }, []);
  return { open, openAt, toggle, close, registerButton };
}

export type MenuState<K = string> = ReturnType<typeof useMenu<K>>;

const moreBtn: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: 32, height: 32, padding: 0, border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text-2)", cursor: "pointer", boxSizing: "border-box" };
const moreBtnSmall: CSSProperties = { ...moreBtn, width: 26, height: 26, border: 0, background: "transparent" };

/** The "…" trigger. `small` is the borderless variant for table rows and list headers. */
export function MoreButton<K>({ menu, itemKey, label, small, hidden, icon, color, title }: { menu: MenuState<K>; itemKey: K; label: string; small?: boolean; hidden?: boolean; icon?: ReactNode; color?: string; title?: string }) {
  const expanded = !!menu.open && menu.open.fromButton && menu.open.key === itemKey;
  return (
    <button
      ref={(el) => menu.registerButton(itemKey, el)}
      type="button"
      data-icon-btn={small ? "" : undefined}
      data-menu-trigger=""
      data-hover-only={hidden ? "" : undefined}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={expanded}
      title={title}
      onClick={(e) => menu.toggle(e.currentTarget, itemKey)}
      style={{ ...(small ? moreBtnSmall : moreBtn), background: expanded ? "var(--bg-raised)" : small ? undefined : "var(--bg)", color: color ?? "var(--text-2)" }}
    >
      {icon ?? <DotsIcon />}
    </button>
  );
}

/** Renders the open menu of a `useMenu` state. `items` gets the item key and how it was opened. */
export function ItemMenu<K>({ menu, label, items }: { menu: MenuState<K>; label: string; items(key: K, fromButton: boolean): MenuEntry[] }) {
  if (!menu.open) return null;
  const { anchor, key, fromButton } = menu.open;
  return <Menu key={`${String(key)}-${fromButton}`} anchor={anchor} label={label} items={items(key, fromButton)} onClose={menu.close} />;
}

/** The one popup menu of the app: measured before it shows, flips to stay on screen, full keyboard support. */
export function Menu({ anchor, label, items, onClose }: { anchor: MenuAnchor; label: string; items: MenuEntry[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  const prevFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const list = tidy(items);
  const enabled = list.flatMap((it, i) => (it && !it.disabled ? [i] : []));

  useLayoutEffect(() => {
    const m = ref.current?.getBoundingClientRect();
    if (!m) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let below: number;
    let above: number;
    if ("el" in anchor) {
      const b = anchor.el.getBoundingClientRect();
      left = b.right - m.width;
      below = b.bottom + 4;
      above = b.top - 4 - m.height;
    } else {
      left = anchor.x;
      below = anchor.y;
      above = anchor.y - m.height;
    }
    setPos({ left: Math.max(8, Math.min(left, vw - m.width - 8)), top: below + m.height <= vh - 8 ? below : Math.max(8, above) });
  }, [anchor]);

  useEffect(() => {
    if (!pos) return;
    const first = enabled[0];
    if (first !== undefined) {
      setActive(first);
      ref.current?.querySelector<HTMLButtonElement>(`[data-idx="${first}"]`)?.focus({ preventScroll: true });
    } else ref.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos !== null]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if ("el" in anchor && anchor.el.contains(t)) return;
      onCloseRef.current();
    };
    const close = () => onCloseRef.current();
    const onScroll = (e: Event) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (t instanceof Element && t.closest(".xterm")) return;
      if ("el" in anchor && !t.contains(anchor.el)) return;
      close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor]);

  const restore = () => {
    const back = "el" in anchor ? anchor.el : prevFocus.current;
    if (back?.isConnected) back.focus({ preventScroll: true });
  };

  const focusItem = (i: number) => {
    setActive(i);
    ref.current?.querySelector<HTMLButtonElement>(`[data-idx="${i}"]`)?.focus({ preventScroll: true });
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      restore();
      return;
    }
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(active);
    let next: number | undefined;
    if (e.key === "ArrowDown") next = enabled[(pos + 1) % enabled.length];
    else if (e.key === "ArrowUp") next = enabled[(pos <= 0 ? enabled.length : pos) - 1];
    else if (e.key === "Home") next = enabled[0];
    else if (e.key === "End") next = enabled[enabled.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    focusItem(next);
  };

  const host = document.querySelector(".t-dark, .t-light") ?? document.body;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onMouseDown={stop}
      onPointerDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      style={{ position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden", zIndex: 120, minWidth: 180, maxWidth: 360, display: "flex", flexDirection: "column", padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", color: "var(--text)", fontSize: 13, boxSizing: "border-box", outline: "none" }}
    >
      {list.map((it, i) =>
        it ? (
          <button
            key={`${it.label}-${i}`}
            type="button"
            role="menuitem"
            data-idx={i}
            aria-disabled={it.disabled || undefined}
            title={it.title}
            onMouseEnter={() => !it.disabled && focusItem(i)}
            onMouseLeave={() => setActive(-1)}
            onFocus={() => setActive(i)}
            onClick={() => {
              if (it.disabled) return;
              onClose();
              restore();
              void it.onSelect();
            }}
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24, height: 28, padding: "0 10px", border: 0, borderRadius: 4, outline: "none", background: active === i && !it.disabled ? "var(--sel)" : "transparent", color: it.disabled ? "var(--text-3)" : it.danger ? "var(--err)" : "var(--text)", fontSize: 13, textAlign: "left", whiteSpace: "nowrap", cursor: it.disabled ? "default" : "pointer" }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
            {it.hint && <span style={{ flex: "none", fontSize: 12, color: "var(--text-3)" }}>{it.hint}</span>}
          </button>
        ) : (
          <div key={`sep-${i}`} role="separator" style={{ height: 1, margin: "4px 6px", background: "var(--line-soft)" }} />
        ),
      )}
    </div>,
    host,
  );
}
