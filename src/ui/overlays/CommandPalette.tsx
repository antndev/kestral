import { CSSProperties, KeyboardEvent, ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Host, Snippet } from "../../api";
import { IS_MAC, KEYS, MONO, type SectionId } from "../mock";
import {
  CpuIcon,
  ForwardIcon,
  HostsIcon,
  KeyIcon,
  LockIcon,
  LogsIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SftpIcon,
  ShieldIcon,
  SnippetIcon,
  SplitIcon,
  TerminalTabIcon,
} from "../icons";
import { Overlay, useModalLayer } from "./Dialogs";
import { parseTarget, type QuickConnect } from "../target";
import { Stable } from "../Stable";

export type PaletteAction =
  | { kind: "connect"; host: Host }
  | { kind: "quick"; target: QuickConnect }
  | { kind: "sftp"; host: Host }
  | { kind: "split"; host: Host }
  | { kind: "edit"; host: Host }
  | { kind: "new-host" }
  | { kind: "section"; section: SectionId }
  | { kind: "snippet"; snippet: Snippet }
  | { kind: "settings" }
  | { kind: "lock" };

type TypeFilter = "all" | "hosts" | "actions" | "snippets";
const FILTERS: TypeFilter[] = ["all", "hosts", "actions", "snippets"];
const FILTER_LABEL: Record<TypeFilter, string> = { all: "All", hosts: "Hosts", actions: "Actions", snippets: "Snippets" };

type Item = {
  key: string;
  type: Exclude<TypeFilter, "all">;
  title: string;
  sub?: string;
  monoSub?: boolean;
  icon: ReactNode;
  action: PaletteAction;
  host?: Host;
  hint?: ReactNode;
  score: number;
};

const kbd: CSSProperties = { padding: "0 5px", border: "1px solid var(--line)", borderRadius: 4, fontFamily: "inherit", fontSize: 11, color: "var(--text-2)" };
const groupTitle = (first: boolean): CSSProperties => ({ flex: "none", margin: first ? "6px 10px 4px" : "10px 10px 4px", fontSize: 12, fontWeight: 600, color: "var(--text-2)" });
const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const ROW_HEIGHT = 48;
const LIST_HEIGHT = 440;

const SECTIONS: { id: SectionId; label: string; icon: ReactNode; keywords: string[] }[] = [
  { id: "hosts", label: "Hosts", icon: <HostsIcon />, keywords: ["servers"] },
  { id: "snippets", label: "Snippets", icon: <SnippetIcon />, keywords: ["scripts", "commands"] },
  { id: "forwarding", label: "Port forwarding", icon: <ForwardIcon />, keywords: ["tunnels", "ports"] },
  { id: "keychain", label: "Keychain", icon: <KeyIcon />, keywords: ["keys", "passwords", "secrets", "vault"] },
  { id: "known", label: "Known hosts", icon: <ShieldIcon />, keywords: ["fingerprints", "host keys"] },
  { id: "logs", label: "Logs", icon: <LogsIcon />, keywords: ["audit", "history"] },
  { id: "ai", label: "AI access", icon: <CpuIcon />, keywords: ["mcp", "claude", "policy", "approvals"] },
];

const SEPARATOR = /[\s\-_.@/:,;()[\]{}]/;

function atWordStart(hay: string, tok: string) {
  for (let i = hay.indexOf(tok); i >= 0; i = hay.indexOf(tok, i + 1)) if (i === 0 || SEPARATOR.test(hay[i - 1])) return true;
  return false;
}

function initials(tok: string, text: string) {
  const words = text.split(new RegExp(`${SEPARATOR.source}+`)).filter(Boolean);
  const failed = new Set<number>();
  const from = (at: number, w0: number): boolean => {
    if (at === tok.length) return true;
    const key = at * (words.length + 1) + w0;
    if (failed.has(key)) return false;
    for (let w = w0; w < words.length; w++) {
      for (let n = Math.min(words[w].length, tok.length - at); n > 0; n--) {
        if (words[w].startsWith(tok.slice(at, at + n)) && from(at + n, w + 1)) return true;
      }
    }
    failed.add(key);
    return false;
  };
  return from(0, 0);
}

/**
 * Every whitespace-separated token must match. Substring matches in the title rank
 * highest (word starts above mid-word), then word initials, then other fields.
 * `body` (long text such as a script) only counts on substring matches at a word start.
 */
function matchScore(tokens: string[], title: string, extra: string[], body = ""): number {
  if (tokens.length === 0) return 1;
  const t = title.toLowerCase();
  const ex = extra.filter(Boolean).map((x) => x.toLowerCase());
  const b = body.toLowerCase();
  let total = 0;
  for (const tok of tokens) {
    let s = 0;
    if (t.startsWith(tok)) s = 100;
    else if (atWordStart(t, tok)) s = 85;
    else if (t.includes(tok)) s = 70;
    else if (initials(tok, t)) s = 60;
    else if (ex.some((x) => x.includes(tok))) s = 50;
    else if (atWordStart(b, tok)) s = 40;
    else if (ex.some((x) => initials(tok, x))) s = 20;
    if (s === 0) return 0;
    total += s;
  }
  return total;
}

function address(username: string, hostname: string, port: number) {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${username ? `${username}@` : ""}${host}${port !== 22 ? `:${port}` : ""}`;
}

function hostSub(h: Host) {
  return address(h.username, h.hostname, h.port);
}

function firstLine(script: string) {
  return script.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

function byScore(a: Item, b: Item) {
  return b.score - a.score;
}

export function CommandPalette({
  hosts,
  snippets,
  canSplit,
  hostsOnly = false,
  onAction,
  onClose,
}: {
  hosts: Host[];
  snippets: Snippet[];
  canSplit: boolean;
  hostsOnly?: boolean;
  onAction(a: PaletteAction): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TypeFilter>("all");
  const [sel, setSel] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollToSel = useRef(false);
  // Hover selects only on real pointer movement, not when keyboard scrolling slides a row under a still cursor.
  const lastPointer = useRef("");
  const listId = useId();

  const z = useModalLayer(sectionRef, {
    kind: "palette",
    onEscape: onClose,
    initialFocus: inputRef,
    onTab: (back) => {
      if (hostsOnly) return;
      setFilter((f) => FILTERS[(FILTERS.indexOf(f) + (back ? FILTERS.length - 1 : 1)) % FILTERS.length]);
      setSel(0);
      inputRef.current?.focus();
    },
  });

  const groups = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const searching = tokens.length > 0;

    const hostItems: Item[] = hosts
      .map((h): Item => ({
        key: `h:${h.id}`,
        type: "hosts",
        title: h.name,
        sub: hostSub(h),
        icon: <HostsIcon />,
        action: { kind: "connect", host: h },
        host: h,
        score: matchScore(tokens, h.name, [h.hostname, h.username, `${h.username}@${h.hostname}`, ...h.tags]),
      }))
      .filter((i) => i.score > 0);
    if (searching) hostItems.sort(byScore);

    const actionItems: Item[] = [];
    const top = searching ? hostItems[0]?.host : undefined;
    if (top) {
      actionItems.push({ key: `a:sftp:${top.id}`, type: "actions", title: `Open SFTP for ${top.name}`, icon: <SftpIcon />, action: { kind: "sftp", host: top }, score: 1 });
      if (canSplit) {
        actionItems.push({ key: `a:split:${top.id}`, type: "actions", title: `Split right with ${top.name}`, icon: <SplitIcon size={16} />, action: { kind: "split", host: top }, hint: <kbd style={kbd}>{KEYS.enter}</kbd>, score: 1 });
      }
      actionItems.push({ key: `a:edit:${top.id}`, type: "actions", title: `Edit host ${top.name}`, icon: <SettingsIcon />, action: { kind: "edit", host: top }, score: 1 });
    }
    const globals: Omit<Item, "score" | "type">[] = [
      { key: "a:new-host", title: "New host", icon: <PlusIcon />, action: { kind: "new-host" } },
      { key: "a:settings", title: "Settings", icon: <SettingsIcon />, action: { kind: "settings" } },
      { key: "a:lock", title: "Lock vault", icon: <LockIcon />, action: { kind: "lock" } },
      ...SECTIONS.map((s) => ({ key: `a:go:${s.id}`, title: `Go to ${s.label}`, icon: s.icon, action: { kind: "section", section: s.id } as PaletteAction })),
    ];
    const keywords: Record<string, string[]> = {
      "a:new-host": ["add", "create", "server", "connection"],
      "a:settings": ["preferences", "options", "theme", "update"],
      "a:lock": ["vault", "sign out", "logout"],
      ...Object.fromEntries(SECTIONS.map((s) => [`a:go:${s.id}`, s.keywords])),
    };
    const globalItems = globals
      .map((g): Item => ({ ...g, type: "actions", score: matchScore(tokens, g.title, keywords[g.key] ?? []) }))
      .filter((i) => i.score > 0);
    if (searching) globalItems.sort(byScore);
    actionItems.push(...globalItems);

    const snippetItems: Item[] = snippets
      .map((s): Item => ({
        key: `s:${s.id}`,
        type: "snippets",
        title: s.label,
        sub: firstLine(s.script) || "Empty script",
        monoSub: true,
        icon: <SnippetIcon />,
        action: { kind: "snippet", snippet: s },
        score: matchScore(tokens, s.label, [s.folder], s.script),
      }))
      .filter((i) => i.score > 0);
    if (searching) snippetItems.sort(byScore);

    const parsed = parseTarget(query);
    const quickItems: Item[] = parsed.ok
      ? [{ key: "q:connect", type: "hosts", title: `Connect to ${address(parsed.value.username, parsed.value.hostname, parsed.value.port)}`, icon: <TerminalTabIcon size={16} />, action: { kind: "quick", target: { ...parsed.value, identity: "" } }, score: 1 }]
      : [];

    if (hostsOnly) {
      const newHost: Item = { key: "a:new-host", type: "hosts", title: "New host", icon: <PlusIcon />, action: { kind: "new-host" }, score: 1 };
      return [{ id: "hosts" as const, label: "Hosts", items: [...quickItems, ...hostItems, newHost] }];
    }
    return [
      { id: "hosts" as const, label: "Hosts", items: [...quickItems, ...hostItems] },
      { id: "actions" as const, label: "Actions", items: actionItems },
      { id: "snippets" as const, label: "Snippets", items: snippetItems },
    ].filter((g) => (filter === "all" || g.id === filter) && g.items.length > 0);
  }, [query, filter, hosts, snippets, canSplit, hostsOnly]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const selIdx = flat.length === 0 ? -1 : Math.min(sel, flat.length - 1);

  useEffect(() => {
    if (!scrollToSel.current) return;
    scrollToSel.current = false;
    if (selIdx === 0) listRef.current?.scrollTo({ top: 0 });
    else rowRefs.current[selIdx]?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [query, filter]);

  function run(item: Item, mod: boolean, sftp = false) {
    const action: PaletteAction = sftp && item.host ? { kind: "sftp", host: item.host } : mod && item.host ? { kind: canSplit ? "split" : "sftp", host: item.host } : item.action;
    onClose();
    onAction(action);
  }

  function move(delta: number) {
    if (flat.length === 0) return;
    scrollToSel.current = true;
    setSel((selIdx + delta + flat.length) % flat.length);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selIdx >= 0) run(flat[selIdx], IS_MAC ? e.metaKey : e.ctrlKey, e.shiftKey);
    } else if (e.key === "Backspace" && query === "" && filter !== "all") {
      e.preventDefault();
      setFilter("all");
      setSel(0);
    }
  }

  const emptyText =
    filter === "hosts" && hosts.length === 0 && !query.trim()
      ? "No hosts yet."
      : filter === "snippets" && snippets.length === 0 && !query.trim()
        ? "No snippets yet."
        : "No matches";

  let index = -1;
  return (
    <Overlay z={z} align="flex-start" padding="84px 16px 24px" onBackdrop={onClose}>
      <section
        ref={sectionRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        // The search input keeps focus for the whole life of the palette: arrows, Enter and typing all go through it.
        onMouseDown={(e) => {
          if (e.target === inputRef.current) return;
          e.preventDefault();
          inputRef.current?.focus();
        }}
        style={{ width: 640, maxWidth: "100%", maxHeight: "100%", display: "flex", flexDirection: "column", borderRadius: 12, background: "var(--bg)", color: "var(--text)", boxShadow: "var(--shadow)", overflow: "hidden" }}
      >
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, height: 52, padding: "0 16px", borderBottom: "1px solid var(--line)", cursor: "text" }}>
          <span style={{ display: "flex", color: "var(--text-2)" }}><SearchIcon size={18} /></span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={hostsOnly ? "Open a host, or connect to user@host" : "Search, or connect to user@host"}
            aria-label="Search hosts, actions and snippets, or connect to user@host"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={selIdx >= 0 ? `${listId}-${selIdx}` : undefined}
            spellCheck={false}
            autoComplete="off"
            style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--text)", fontSize: 16 }}
          />
          <button
            type="button"
            tabIndex={-1}
            title="Show all types (Backspace)"
            aria-label={`Filter: ${FILTER_LABEL[filter]}. Clear filter`}
            onClick={() => {
              setFilter("all");
              setSel(0);
            }}
            style={{ flex: "none", display: "inline-flex", alignItems: "center", height: 22, padding: "0 8px", border: 0, borderRadius: 11, background: "var(--bg-raised)", color: "var(--text)", fontSize: 12, cursor: "pointer", visibility: filter === "all" ? "hidden" : "visible" }}
          >
            <Stable text={filter === "all" ? "" : FILTER_LABEL[filter]} alts={FILTERS.filter((f) => f !== "all").map((f) => FILTER_LABEL[f])} />
          </button>
          <kbd style={{ ...kbd, padding: "1px 6px" }}>Esc</kbd>
        </div>

        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          style={{ flex: "0 1 auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 2, height: LIST_HEIGHT, padding: 8, overflow: "auto" }}
        >
          {flat.length === 0 && <div style={{ padding: "28px 10px", textAlign: "center", color: "var(--text-2)" }}>{emptyText}</div>}
          {groups.map((g, gi) => (
            <div key={g.id} role="group" aria-label={g.label} style={{ display: "contents" }}>
              <h2 aria-hidden="true" style={groupTitle(gi === 0)}>{g.label}</h2>
              {g.items.map((item) => {
                index++;
                const i = index;
                const active = i === selIdx;
                const isHost = item.type === "hosts";
                return (
                  <div
                    key={item.key}
                    id={`${listId}-${i}`}
                    ref={(el) => {
                      rowRefs.current[i] = el;
                    }}
                    role="option"
                    aria-selected={active}
                    onMouseMove={(e) => {
                      const at = `${e.clientX},${e.clientY}`;
                      if (at === lastPointer.current) return;
                      lastPointer.current = at;
                      if (i !== selIdx) setSel(i);
                    }}
                    onClick={(e) => run(item, IS_MAC ? e.metaKey : e.ctrlKey)}
                    style={{ flex: "none", display: "flex", alignItems: "center", gap: 12, height: ROW_HEIGHT, padding: "0 10px", boxSizing: "border-box", borderRadius: 8, background: active ? "var(--sel)" : "transparent", color: "var(--text)", cursor: "pointer" }}
                  >
                    <span
                      aria-hidden="true"
                      style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "center", width: 30, height: 30, borderRadius: 6, background: isHost ? "var(--bg-raised)" : "transparent", color: "var(--text-2)" }}
                    >
                      {item.icon}
                    </span>
                    {item.sub ? (
                      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <span style={{ ...ellipsis, lineHeight: "18px", fontWeight: isHost ? 600 : undefined }}>{item.title}</span>
                        <span style={{ ...ellipsis, lineHeight: "16px", color: "var(--text-2)", ...(item.monoSub ? { fontFamily: MONO, fontSize: 11.5 } : { fontSize: 12 }) }}>{item.sub}</span>
                      </span>
                    ) : (
                      <span style={{ ...ellipsis, flex: 1, minWidth: 0, lineHeight: "18px" }}>{item.title}</span>
                    )}
                    {active && item.host && (
                      <span style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-2)" }}>
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            run(item, false, true);
                          }}
                          style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 6px", border: 0, borderRadius: 6, background: "transparent", color: "inherit", fontSize: 12, cursor: "pointer" }}
                        >
                          SFTP<kbd style={{ ...kbd, color: undefined }}>{IS_MAC ? "⇧↵" : "Shift+↵"}</kbd>
                        </button>
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          Connect<kbd style={{ ...kbd, color: undefined }}>↵</kbd>
                        </span>
                      </span>
                    )}
                    {item.hint}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{ flex: "none", display: "flex", flexWrap: "wrap", gap: 16, padding: "10px 16px", borderTop: "1px solid var(--line)", background: "var(--bg-side)", fontSize: 12, color: "var(--text-2)" }}>
          <span><kbd style={kbd}>↑</kbd> <kbd style={kbd}>↓</kbd> move</span>
          <span><kbd style={kbd}>↵</kbd> open</span>
          <span><kbd style={kbd}>{IS_MAC ? "⇧↵" : "Shift+↵"}</kbd> SFTP</span>
          {canSplit && <span><kbd style={kbd}>{KEYS.enter}</kbd> open in split</span>}
          {!hostsOnly && <span><kbd style={kbd}>Tab</kbd> filter by type</span>}
        </div>
      </section>
    </Overlay>
  );
}
