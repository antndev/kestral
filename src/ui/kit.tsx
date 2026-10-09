import { Fragment } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode, Ref } from "react";
import { SearchIcon } from "./icons";
import { MONO } from "./mock";

export const srOnly: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
export const oneLine: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
export const errLine: CSSProperties = { margin: 0, fontSize: 12, color: "var(--err)", overflowWrap: "anywhere" };
export const pageBtn: CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
export const primaryBtn: CSSProperties = { ...pageBtn, border: "1px solid var(--btn-line)", background: "var(--btn)", color: "var(--btn-text)", fontWeight: 500 };
export const smallBtn: CSSProperties = { display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontSize: 12, cursor: "pointer", boxSizing: "border-box", whiteSpace: "nowrap" };
export const sectionLabel: CSSProperties = { margin: "0 0 8px", fontSize: 12, fontWeight: 500, color: "var(--text-2)" };
export const mono: CSSProperties = { fontFamily: MONO, fontSize: 12.5 };
export const muted: CSSProperties = { color: "var(--text-3)" };
export const chip: CSSProperties = { display: "inline-flex", alignItems: "center", maxWidth: 200, height: 24, padding: "0 10px", borderRadius: 12, background: "var(--bg-raised)", color: "var(--text)", fontSize: 12, boxSizing: "border-box", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
export const th: CSSProperties = { height: 32, padding: "0 12px", fontWeight: 500, textAlign: "left", color: "var(--text-2)", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" };
export const td: CSSProperties = { height: 40, padding: "0 12px", borderBottom: "1px solid var(--line-soft)" };

export function ScreenHeader({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, minHeight: 56, flex: "none", padding: "12px 18px 12px 28px", boxSizing: "border-box" }}>
      <h1 style={{ position: "relative", top: -1, flex: "none", margin: 0, fontSize: 20, fontWeight: 600 }}>{title}</h1>
      {meta !== undefined && <span style={{ flex: "none", color: "var(--text-2)" }}>{meta}</span>}
      <div style={{ flex: 1 }} />
      {children}
    </div>
  );
}

export function SplitView({ list, children, detailLabel }: { list: ReactNode; children: ReactNode; detailLabel: string }) {
  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, borderTop: "1px solid var(--line)" }}>
      <div style={{ flex: "0 0 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8, padding: "12px 10px", borderRight: "1px solid var(--line)", boxSizing: "border-box", overflow: "auto" }}>{list}</div>
      <section aria-label={detailLabel} style={{ flex: 1, minWidth: 0, padding: "24px 28px", overflow: "auto", boxSizing: "border-box" }}>
        <div style={{ width: "100%", maxWidth: 760, display: "flex", flexDirection: "column", gap: 22 }}>{children}</div>
      </section>
    </div>
  );
}

export function ListFilter({ value, onChange, placeholder, onKeyDown, inputRef }: { value: string; onChange(v: string): void; placeholder: string; onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void; inputRef?: Ref<HTMLInputElement> }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, height: 32, flex: "none", padding: "0 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg-sunken)", color: "var(--text-2)", boxSizing: "border-box" }}>
      <SearchIcon size={14} />
      <span style={srOnly}>{placeholder}</span>
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder}
        style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--text)" }}
      />
    </label>
  );
}

export function ListItem({
  icon,
  iconColor,
  title,
  sub,
  selected,
  trailing,
  onSelect,
  onOpen,
  onKeyDown,
  buttonRef,
}: {
  icon: ReactNode;
  iconColor?: string;
  title: ReactNode;
  sub?: ReactNode;
  selected: boolean;
  trailing?: ReactNode;
  onSelect(): void;
  onOpen?(): void;
  onKeyDown?(e: KeyboardEvent<HTMLButtonElement>): void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <li style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        ref={buttonRef}
        type="button"
        aria-current={selected}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onOpen) {
            e.preventDefault();
            onOpen();
            return;
          }
          onKeyDown?.(e);
        }}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: 8, paddingRight: trailing ? 52 : 8, border: 0, borderRadius: 6, background: selected ? "var(--sel)" : "transparent", color: "var(--text)", textAlign: "left", cursor: "pointer", transition: "background 120ms" }}
      >
        <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: "none", width: 30, height: 30, borderRadius: 6, background: "var(--bg-raised)", color: iconColor ?? "var(--text-2)" }}>{icon}</span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span style={{ ...oneLine, fontWeight: 600 }}>{title}</span>
          {sub !== undefined && <span style={{ ...oneLine, fontSize: 12, color: "var(--text-2)" }}>{sub}</span>}
        </span>
      </button>
      {trailing && <span style={{ position: "absolute", right: 8, display: "flex", alignItems: "center" }}>{trailing}</span>}
    </li>
  );
}

export function List({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul data-stagger aria-label={label} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
      {children}
    </ul>
  );
}

export type Fact = [string, ReactNode];

export function Facts({ rows }: { rows: Fact[] }) {
  return (
    <dl style={{ display: "grid", gridTemplateColumns: "96px minmax(0, 1fr)", alignItems: "baseline", columnGap: 12, rowGap: 8, margin: 0 }}>
      {rows.map(([label, value], i) => (
        <Fragment key={i}>
          <dt title={label} style={{ ...oneLine, color: "var(--text-2)" }}>{label}</dt>
          <dd title={typeof value === "string" ? value : undefined} style={{ ...oneLine, margin: 0 }}>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <h3 style={sectionLabel}>{title}</h3>
      {children}
    </div>
  );
}

export function Blocks({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 22 }}>{children}</div>;
}

export function DetailHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, overflowWrap: "anywhere" }}>{title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 12, height: 20, margin: "4px 0 0", color: "var(--text-2)" }}>{sub}</div>
      </div>
      {actions && <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>{actions}</div>}
    </div>
  );
}

export function EditFooter({ left, children }: { left?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
      {left}
      <div style={{ flex: 1 }} />
      {children}
    </div>
  );
}

export function EmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24, textAlign: "center", color: "var(--text-2)" }}>
      {icon && <span aria-hidden="true" style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: 10, background: "var(--bg-raised)", color: "var(--text-2)" }}>{icon}</span>}
      {children}
    </div>
  );
}

export function arrowNav<T extends { id: string }>(items: T[], index: number, e: KeyboardEvent, select: (id: string) => void, focus: (id: string) => void) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const next = items[Math.min(items.length - 1, Math.max(0, index + (e.key === "ArrowDown" ? 1 : -1)))];
  if (!next) return;
  select(next.id);
  focus(next.id);
}
