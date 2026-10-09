import { Fragment, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { writeText as clipWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { identityList, type Host, type Identity, type NewHost, type PortForward } from "../../api";
import { HostEditor } from "../overlays/HostEditor";
import { Status, statusColor } from "../mock";
import { CheckIcon, DotsIcon, HostsIcon, PlusIcon, WarningIcon } from "../icons";
import { useAlive } from "./SettingsScreen";
import type { DragHost } from "../Shell";
import { parseTarget, type QuickConnect, type Target } from "../target";
import { Block, Blocks, DetailHead, EmptyState, Facts, List, ListFilter, ListItem, ScreenHeader, SplitView, arrowNav, chip, mono, muted, oneLine, pageBtn, primaryBtn, srOnly, type Fact } from "../kit";

export type { QuickConnect } from "../target";

const STATUS_LABEL: Record<Status, string> = { ok: "Connected", warn: "Connecting", err: "Failed", idle: "" };
const KIND_LABEL: Record<PortForward["kind"], string> = { local: "Local", remote: "Remote", dynamic: "SOCKS" };


export function hostAddress(h: Pick<Host, "username" | "hostname" | "port">): string {
  const custom = h.port !== 22;
  const host = custom && h.hostname.includes(":") ? `[${h.hostname}]` : h.hostname;
  return `${h.username}@${host}${custom ? `:${h.port}` : ""}`;
}

function sshCommand(h: Host): string {
  const target = h.username ? `${h.username}@${h.hostname}` : h.hostname;
  return h.port === 22 ? target : `ssh -p ${h.port} ${target}`;
}

function sameTarget(h: Host, t: Target): boolean {
  return h.hostname.toLowerCase() === t.hostname.toLowerCase() && h.port === t.port && h.username === t.username;
}

function looksLikeTarget(text: string): boolean {
  return text.includes("@") || /^ssh(\s|:\/\/)/i.test(text);
}

/** A local bind that stays on this machine: empty, loopback IPs, or "localhost". */
function isLoopbackBind(host: string): boolean {
  const v = host.trim().toLowerCase();
  return v === "" || v === "127.0.0.1" || v === "localhost" || v === "::1";
}

function withPort(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function forwardLabel(f: PortForward): string {
  const kind = f.kind ?? "local";
  const local = isLoopbackBind(f.local_host) ? String(f.local_port) : withPort(f.local_host.trim(), f.local_port);
  if (kind === "dynamic") return `SOCKS ${local}`;
  if (kind === "remote") {
    const listen = isLoopbackBind(f.remote_host) ? `remote:${f.remote_port}` : withPort(f.remote_host.trim(), f.remote_port);
    const dest = f.local_host.trim();
    return `R ${listen} → ${withPort(isLoopbackBind(dest) || dest === "0.0.0.0" || dest === "::" ? "localhost" : dest, f.local_port)}`;
  }
  return `L ${local} → ${withPort(f.remote_host, f.remote_port)}`;
}

interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect(): void | Promise<void>;
}

type MenuAt = "button" | { x: number; y: number } | null;

function menuPoint(e: ReactMouseEvent): MenuAt {
  e.preventDefault();
  return e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : "button";
}

function MoreMenu({ hostName, items, at, note, onAt }: { hostName: string; items: MenuItem[]; at: MenuAt; note: Note | null; onAt(at: MenuAt): void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [hover, setHover] = useState(-1);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = at !== null;

  useLayoutEffect(() => {
    setHover(-1);
    if (!at || !btnRef.current || !menuRef.current) {
      setPos(null);
      return;
    }
    const b = btnRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const [x, below, above] = at === "button" ? [b.right - m.width, b.bottom + 4, b.top - 4 - m.height] : [at.x, at.y, at.y - m.height];
    setPos({ top: below + m.height <= window.innerHeight - 8 ? below : Math.max(8, above), left: Math.max(8, Math.min(x, window.innerWidth - m.width - 8)) });
  }, [at]);

  useEffect(() => {
    if (!open) return;
    const close = () => onAt(null);
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        btnRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, onAt]);

  useEffect(() => {
    if (open && pos) menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [open, pos]);

  function onMenuKey(e: ReactKeyboardEvent) {
    const btns = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      btns[(n + btns.length) % btns.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(btns.length - 1);
    else if (e.key === "Tab") {
      e.preventDefault();
      onAt(null);
      btnRef.current?.focus();
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`More actions for ${hostName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={note?.text}
        onClick={() => onAt(open ? null : "button")}
        style={{ ...pageBtn, width: 32, padding: 0, justifyContent: "center", background: open ? "var(--bg-raised)" : "var(--bg)", color: note ? (note.err ? "var(--err)" : "var(--ok)") : "var(--text-2)" }}
      >
        {note ? note.err ? <WarningIcon size={14} /> : <CheckIcon size={14} /> : <DotsIcon />}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label={`Actions for ${hostName}`}
          onKeyDown={onMenuKey}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && (menuRef.current?.contains(to) || btnRef.current?.contains(to))) return;
            onAt(null);
          }}
          style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden", zIndex: 90, minWidth: 160, display: "flex", flexDirection: "column", padding: 4, borderRadius: 8, background: "var(--bg)", boxShadow: "var(--shadow)", boxSizing: "border-box", outline: "none" }}
        >
          {items.map((it, i) => (
            <Fragment key={it.label}>
              {it.danger && <div aria-hidden style={{ height: 1, margin: "4px 2px", background: "var(--line-soft)" }} />}
              <button
                type="button"
                role="menuitem"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(-1)}
                onFocus={(e) => e.currentTarget.matches(":focus-visible") && setHover(i)}
                onBlur={() => setHover(-1)}
                onClick={() => {
                  btnRef.current?.focus();
                  onAt(null);
                  void it.onSelect();
                }}
                style={{ display: "flex", alignItems: "center", height: 28, padding: "0 10px", border: 0, borderRadius: 4, background: hover === i ? "var(--sel)" : "transparent", color: it.danger ? "var(--err)" : "var(--text)", fontSize: 13, textAlign: "left", cursor: "pointer", outline: "none" }}
              >
                {it.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}

const AI_MARK = "Changed by AI, you are asked to check it before the next connection";

function AiMark() {
  return <span title={AI_MARK} style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: "var(--warn)" }}>AI</span>;
}

function Live({ host, status, note }: { host: Host; status: Status; note: Note | null }) {
  const text = note?.text ?? STATUS_LABEL[status];
  return <span role="status" style={srOnly}>{text ? `${host.name}: ${text}` : ""}</span>;
}

interface Note {
  text: string;
  err: boolean;
}

function authFacts(h: Host, identity: Identity | undefined, identities: Identity[] | null): Fact[] {
  const a = h.auth;
  if (a.kind === "agent") return [["Method", "SSH agent"]];
  if (a.kind === "key") return [["Method", "Key"], ["Key", a.secret_id]];
  if (a.kind === "password") return [["Method", "Password"], ["Password", a.secret_id]];
  return [["Method", "Identity"], ["Identity", identity ? identity.name : identities ? <span style={muted}>Missing</span> : ""]];
}

interface DetailProps {
  host: Host;
  user: string;
  via?: string;
  identity: Identity | undefined;
  identities: Identity[] | null;
  status: Status;
  note: Note | null;
  menu: MenuItem[];
  menuAt: MenuAt;
  onMenuAt(at: MenuAt): void;
  onConnect(): void;
  onSftp(): void;
  onEdit(): void;
  onConfirmAi(): void;
}

function HostDetail({ host, user, via, identity, identities, status, note, menu, menuAt, onMenuAt, onConnect, onSftp, onEdit, onConfirmAi }: DetailProps) {
  const addr = hostAddress({ ...host, username: user });
  return (
    <>
      <DetailHead
        title={
          <>
            {host.name}
            {host.ai_changed && <AiMark />}
          </>
        }
        sub={
          <>
            <span title={via ? `${addr} via ${via}` : addr} style={{ ...oneLine, ...mono }}>{addr}</span>
            {status !== "idle" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "none", fontSize: 12, color: statusColor(status) }}>
                <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
                {STATUS_LABEL[status]}
              </span>
            )}
          </>
        }
        actions={
          <>
            <button type="button" aria-label={`Connect to ${host.name}`} onClick={onConnect} style={primaryBtn}>Connect</button>
            <button type="button" aria-label={`Open SFTP for ${host.name}`} onClick={onSftp} style={pageBtn}>SFTP</button>
            <button type="button" aria-label={`Edit ${host.name}`} onClick={onEdit} style={pageBtn}>Edit</button>
            <MoreMenu hostName={host.name} items={menu} at={menuAt} note={note} onAt={onMenuAt} />
            {host.ai_changed && (
              <button type="button" onClick={onConfirmAi} title="The AI created this host or changed where it connects. Review and confirm it." style={pageBtn}>
                Confirm host
              </button>
            )}
          </>
        }
      />

      <Blocks>
        <Block title="Connection">
          <Facts
            rows={[
              ["Address", <span title={host.hostname} style={mono}>{host.hostname}</span>],
              ["Port", String(host.port)],
              ["User", user || <span style={muted}>None</span>],
              ["Jump host", via ?? <span style={muted}>None</span>],
            ]}
          />
        </Block>
        <Block title="Authentication">
          <Facts rows={authFacts(host, identity, identities)} />
        </Block>
      </Blocks>

      <Block title="Tags">
        {host.tags.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {host.tags.map((t, i) => (
              <span key={i} title={t} style={chip}>{t}</span>
            ))}
          </div>
        ) : (
          <p style={{ ...muted, margin: 0 }}>No tags</p>
        )}
      </Block>

      <Block title="Port forwards">
        {host.forwards.length > 0 ? (
          <Facts rows={host.forwards.map((f): Fact => [(f.name ?? "").trim() || KIND_LABEL[f.kind ?? "local"], <span title={forwardLabel(f)} style={mono}>{forwardLabel(f)}</span>])} />
        ) : (
          <p style={{ ...muted, margin: 0 }}>No port forwards</p>
        )}
      </Block>
    </>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

const FILTER_LABEL = "Filter hosts, or enter user@host and press Enter to connect";

export function HostsScreen(p: {
  hosts: Host[];
  statuses: Record<string, Status>;
  onConnect(h: Host): void;
  onSftp(h: Host): void;
  onConfirmAi(h: Host): void;
  onEdit(h: Host): void;
  onNew(): void;
  onDuplicate(h: Host): void;
  onDelete(h: Host): void;
  onQuickConnect(q: QuickConnect): void;
  onDragHost?: DragHost;
  editor?: { host: Host | null; prefill?: Partial<NewHost>; connectAfterSave?: boolean; seq?: number } | null;
  onEditorClose?(): void;
  onEditorSaved?(h: Host, connect: boolean): void;
  onEditorDirty?(dirty: boolean): void;
}) {
  const { hosts, statuses } = p;
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement | null>(null);
  const errId = useId();
  const [quickErr, setQuickErr] = useState("");
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [sel, setSel] = useState<string | null>(null);
  const [menuAt, setMenuAt] = useState<MenuAt>(null);
  const [identities, setIdentities] = useState<Identity[] | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const alive = useAlive();

  useEffect(() => {
    identityList().then(
      (list) => alive.current && setIdentities(list),
      () => {},
    );
  }, [hosts, alive]);

  const setFilterInput = useCallback((el: HTMLInputElement | null) => {
    filterRef.current = el;
    if (!el) return;
    el.spellcheck = false;
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocomplete", "off");
    el.setAttribute("aria-label", FILTER_LABEL);
  }, []);

  useLayoutEffect(() => {
    const el = filterRef.current;
    if (!el) return;
    if (quickErr) {
      el.setAttribute("aria-invalid", "true");
      el.setAttribute("aria-describedby", errId);
    } else {
      el.removeAttribute("aria-invalid");
      el.removeAttribute("aria-describedby");
    }
  }, [quickErr, errId]);

  const target = useMemo(() => parseTarget(query), [query]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter((h) => h.name.toLowerCase().includes(q) || hostAddress(h).toLowerCase().includes(q) || h.tags.some((t) => t.toLowerCase().includes(q)) || (target.ok && sameTarget(h, target.value)));
  }, [hosts, query, target]);

  const current = filtered.find((h) => h.id === sel) ?? filtered[0] ?? null;

  const identityOf = (h: Host): Identity | undefined => {
    const a = h.auth;
    return a.kind === "identity" ? identities?.find((i) => i.id === a.identity_id) : undefined;
  };
  const userOf = (h: Host) => identityOf(h)?.username || h.username;
  const viaOf = (h: Host) => (h.jump_host_id ? hosts.find((x) => x.id === h.jump_host_id)?.name ?? "missing host" : undefined);

  const focusItem = (id: string) => itemRefs.current.get(id)?.focus();

  const itemHost = (e: ReactMouseEvent): Host | undefined => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return undefined;
    for (const [id, el] of itemRefs.current) if (el === btn) return hosts.find((h) => h.id === id);
    return undefined;
  };

  const copyAddress = async (h: Host) => {
    let note: Note;
    try {
      await clipWriteText(sshCommand(h));
      note = { text: "Address copied", err: false };
    } catch {
      note = { text: "Copy failed", err: true };
    }
    if (!alive.current) return;
    setNotes((n) => ({ ...n, [h.id]: note }));
    setTimeout(() => {
      if (!alive.current) return;
      setNotes((n) => {
        if (n[h.id] !== note) return n;
        const next = { ...n };
        delete next[h.id];
        return next;
      });
    }, note.err ? 3000 : 1500);
  };

  const menuFor = (h: Host): MenuItem[] => [
    ...(menuAt !== null && menuAt !== "button" ? [{ label: "Edit…", onSelect: () => p.onEdit(h) }] : []),
    { label: "Duplicate", onSelect: () => p.onDuplicate(h) },
    { label: "Copy address", onSelect: () => copyAddress(h) },
    { label: "Delete", danger: true, onSelect: () => p.onDelete(h) },
  ];

  function submitTarget() {
    const text = query.trim();
    if (!text) return;
    if (!target.ok) {
      if (looksLikeTarget(text)) setQuickErr(target.error);
      return;
    }
    setQuickErr("");
    if (hosts.some((h) => sameTarget(h, target.value))) setQuery("");
    else filterRef.current?.select();
    p.onQuickConnect({ ...target.value, identity: "" });
  }

  const clearFilter = () => {
    setQuery("");
    setQuickErr("");
    filterRef.current?.focus();
  };

  const newHostBtn = (
    <button type="button" onClick={() => p.onNew()} style={primaryBtn}>
      <PlusIcon size={14} sw={1.75} />
      New host
    </button>
  );

  return (
    <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Hosts" meta={plural(hosts.length, "host", "hosts")}>
        {hosts.length > 0 && newHostBtn}
      </ScreenHeader>

      {hosts.length === 0 && !p.editor ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", borderTop: "1px solid var(--line)" }}>
          <EmptyState icon={<HostsIcon size={20} />}>
            <span>No hosts yet</span>
            {newHostBtn}
          </EmptyState>
        </div>
      ) : (
        <SplitView
          detailLabel="Host details"
          list={
            <>
              <div title={quickErr || undefined} style={{ flex: "none", borderRadius: 6, outline: quickErr ? "1px solid var(--err)" : "none", outlineOffset: -1 }}>
                <ListFilter
                  inputRef={setFilterInput}
                  value={query}
                  onChange={(v) => {
                    setQuery(v);
                    setQuickErr("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submitTarget();
                    } else if (e.key === "ArrowDown" && current) {
                      e.preventDefault();
                      setSel(current.id);
                      focusItem(current.id);
                    }
                  }}
                  placeholder="Filter, or user@host to connect"
                />
              </div>
              {filtered.length === 0 ? (
                <EmptyState>
                  <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={{ fontSize: 15, fontWeight: 600 }}>No matching hosts</span>
                    <span style={{ fontSize: 13, color: "var(--text-3)", overflowWrap: "anywhere" }}>
                      {target.ok ? `Press Enter to connect to ${hostAddress(target.value)}.` : `Nothing matches "${query.trim()}".`}
                    </span>
                  </span>
                  <button type="button" onClick={clearFilter} style={pageBtn}>Clear filter</button>
                </EmptyState>
              ) : (
                <div
                  style={{ display: "contents" }}
                  onMouseDown={(e) => {
                    const h = itemHost(e);
                    if (h) p.onDragHost?.(e, h.id, h.name);
                  }}
                  onContextMenu={(e) => {
                    const h = itemHost(e);
                    if (!h) return;
                    setSel(h.id);
                    setMenuAt(menuPoint(e));
                  }}
                >
                  <List label="Hosts">
                    {filtered.map((h, i) => {
                      const status = statuses[h.id] ?? "idle";
                      const via = viaOf(h);
                      return (
                        <ListItem
                          key={h.id}
                          buttonRef={(el) => {
                            if (el) itemRefs.current.set(h.id, el);
                            else itemRefs.current.delete(h.id);
                          }}
                          icon={<HostsIcon />}
                          iconColor={status === "idle" ? undefined : statusColor(status)}
                          title={
                            <>
                              {h.name}
                              {h.ai_changed && <AiMark />}
                            </>
                          }
                          sub={`${hostAddress({ ...h, username: userOf(h) })}${via ? ` via ${via}` : ""}`}
                          selected={h.id === current?.id}
                          onSelect={() => setSel(h.id)}
                          onOpen={() => p.onConnect(h)}
                          onKeyDown={(e) => arrowNav(filtered, i, e, setSel, focusItem)}
                        />
                      );
                    })}
                  </List>
                </div>
              )}
            </>
          }
        >
          {p.editor ? (
            <HostEditor
              key={p.editor.seq ?? p.editor.host?.id ?? "new"}
              inline
              host={p.editor.host}
              prefill={p.editor.prefill}
              hosts={hosts}
              connectAfterSave={p.editor.connectAfterSave}
              onClose={() => p.onEditorClose?.()}
              onDirtyChange={p.onEditorDirty}
              onSaved={(h, connect) => {
                setSel(h.id);
                p.onEditorSaved?.(h, connect);
              }}
            />
          ) : current && (
            <HostDetail
              key={current.id}
              host={current}
              user={userOf(current)}
              via={viaOf(current)}
              identity={identityOf(current)}
              identities={identities}
              status={statuses[current.id] ?? "idle"}
              note={notes[current.id] ?? null}
              menu={menuFor(current)}
              menuAt={menuAt}
              onMenuAt={setMenuAt}
              onConnect={() => p.onConnect(current)}
              onSftp={() => p.onSftp(current)}
              onEdit={() => p.onEdit(current)}
              onConfirmAi={() => p.onConfirmAi(current)}
            />
          )}
        </SplitView>
      )}

      <span id={errId} role="alert" style={srOnly}>{quickErr}</span>
      {hosts.map((h) => (
        <Live key={h.id} host={h} status={statuses[h.id] ?? "idle"} note={notes[h.id] ?? null} />
      ))}
    </main>
  );
}
