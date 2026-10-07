import { CSSProperties, ReactNode, useMemo } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MONO } from "./mock";

type Item = { text: string; depth: number; num: number | null };
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "list"; items: Item[] };

const FENCE = /^\s*(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|(https?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?])|\*\*(?=\S)([\s\S]*?\S)\*\*|\*(?=[^\s*])([\s\S]*?[^\s*])\*|\\([\\`*_{}[\]()#+\-.!<>~|])/g;

const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || ITEM.test(line) || QUOTE.test(line);

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    const first = line.match(ITEM);
    if (first) {
      const base = first[1].length;
      const items: Item[] = [];
      const counters: (number | undefined)[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (!cur.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && (ITEM.test(lines[j]) || /^\s{2,}\S/.test(lines[j])) && !RULE.test(lines[j])) {
            i = j;
            continue;
          }
          break;
        }
        if (RULE.test(cur)) break;
        const m = cur.match(ITEM);
        if (m) {
          const depth = Math.min(3, Math.max(0, Math.floor((m[1].length - base) / 2)));
          counters.length = depth + 1;
          const num = /\d/.test(m[2]) ? (counters[depth] ?? parseInt(m[2], 10) - 1) + 1 : undefined;
          counters[depth] = num;
          items.push({ text: m[3], depth, num: num ?? null });
        } else if (FENCE.test(cur) || HEADING.test(cur) || QUOTE.test(cur)) break;
        else items[items.length - 1].text += " " + cur.trim();
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (QUOTE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !startsBlock(lines[i]))) {
        parts.push(lines[i].replace(QUOTE, "$1").trim());
        i++;
      }
      blocks.push({ kind: "quote", text: parts.join(" ") });
      continue;
    }
    const parts: string[] = [];
    while (i < lines.length && lines[i].trim() && (parts.length === 0 || !startsBlock(lines[i]))) {
      parts.push(lines[i].trim());
      i++;
    }
    blocks.push({ kind: "para", text: parts.join(" ") });
  }
  return blocks;
}

const codeStyle: CSSProperties = { padding: "1px 4px", borderRadius: 4, background: "var(--bg-raised)", color: "var(--text)", fontFamily: MONO, fontSize: "0.92em" };
const strongStyle: CSSProperties = { fontWeight: 600, color: "var(--text)" };
const majorHead: CSSProperties = { fontSize: "1.05em", fontWeight: 600, color: "var(--text)" };
const minorHead: CSSProperties = { fontSize: "0.92em", fontWeight: 600, color: "var(--text-3)" };

function Link({ href, children }: { href: string; children: ReactNode }) {
  if (!/^(https?:|mailto:)/i.test(href)) return <>{children}</>;
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        void openUrl(href).catch(() => {});
      }}
      onAuxClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  );
}

function inline(src: string, key: string, links = true): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const k = `${key}.${m.index}`;
    if (m[1]) {
      const code = m[2].length > 2 && m[2].startsWith(" ") && m[2].endsWith(" ") && m[2].trim() ? m[2].slice(1, -1) : m[2];
      out.push(<code key={k} style={codeStyle}>{code}</code>);
    } else if (m[3] !== undefined) {
      const label = inline(m[3], k, false);
      out.push(links ? <Link key={k} href={m[4]}>{label}</Link> : <span key={k}>{label}</span>);
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const url = m[5] ?? m[6] ?? "";
      out.push(links ? <Link key={k} href={url}>{url}</Link> : url);
    } else if (m[7] !== undefined) out.push(<strong key={k} style={strongStyle}>{inline(m[7], k, links)}</strong>);
    else if (m[8] !== undefined) out.push(<em key={k}>{inline(m[8], k, links)}</em>);
    else out.push(m[9]);
    last = re.lastIndex;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  return useMemo(() => {
    const blocks = parse(text);
    return (
      <div style={{ lineHeight: 1.5, overflowWrap: "anywhere" }}>
        {blocks.map((b, i) => {
          const prev = blocks[i - 1];
          const top = !prev ? 0 : b.kind === "heading" ? (b.level <= 2 ? 16 : 10) : prev.kind === "heading" ? 4 : 8;
          const k = String(i);
          if (b.kind === "heading") {
            const H = (["h3", "h4", "h5", "h6"] as const)[Math.min(3, b.level - 1)];
            return <H key={k} style={{ margin: `${top}px 0 0`, ...(b.level <= 2 ? majorHead : minorHead) }}>{inline(b.text, k)}</H>;
          }
          if (b.kind === "para") return <p key={k} style={{ margin: `${top}px 0 0` }}>{inline(b.text, k)}</p>;
          if (b.kind === "quote") return <blockquote key={k} style={{ margin: `${top}px 0 0`, paddingLeft: 10, borderLeft: "2px solid var(--line)" }}>{inline(b.text, k)}</blockquote>;
          if (b.kind === "code")
            return (
              <pre key={k} style={{ margin: `${top}px 0 0`, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", fontFamily: MONO, fontSize: "0.92em", lineHeight: 1.45, whiteSpace: "pre", overflow: "auto" }}>
                <code>{b.text}</code>
              </pre>
            );
          if (b.kind === "rule") return <hr key={k} style={{ margin: `${top}px 0 0`, border: 0, borderTop: "1px solid var(--line)" }} />;
          return (
            <ul key={k} role="list" style={{ margin: `${top}px 0 0`, padding: 0, listStyle: "none" }}>
              {b.items.map((it, j) => (
                <li key={j} style={{ display: "flex", gap: 8, marginTop: j ? 3 : 0, paddingLeft: it.depth * 16 }}>
                  <span aria-hidden="true" style={{ flex: "none", minWidth: it.num == null ? undefined : "1.3em", color: "var(--text-3)", fontVariantNumeric: "tabular-nums" }}>{it.num == null ? "•" : `${it.num}.`}</span>
                  <span style={{ minWidth: 0 }}>{inline(it.text, `${k}.${j}`)}</span>
                </li>
              ))}
            </ul>
          );
        })}
      </div>
    );
  }, [text]);
}
