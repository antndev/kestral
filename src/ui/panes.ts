import type { MouseEvent as ReactMouseEvent } from "react";
import type { PaneStage, SessionStatus } from "./termBus";

export type Side = "left" | "right" | "top" | "bottom";
export type Zone = Side | "center";
export type Layout = { type: "pane"; id: string } | { type: "split"; dir: "row" | "column"; ratio: number; a: Layout; b: Layout };
export type PaneSpec = { hostId: string; initialCommand?: string };

export const MAX_PANES = 8;

export const leaf = (id: string): Layout => ({ type: "pane", id });

export function newPaneId() {
  return `pane-${crypto.randomUUID()}`;
}

export function leaves(l: Layout): string[] {
  return l.type === "pane" ? [l.id] : [...leaves(l.a), ...leaves(l.b)];
}

export function hasPane(l: Layout, id: string): boolean {
  return l.type === "pane" ? l.id === id : hasPane(l.a, id) || hasPane(l.b, id);
}

export function removePane(l: Layout, id: string): Layout | null {
  if (l.type === "pane") return l.id === id ? null : l;
  const a = removePane(l.a, id);
  const b = removePane(l.b, id);
  if (!a) return b;
  if (!b) return a;
  return a === l.a && b === l.b ? l : { ...l, a, b };
}

export function siblingLeaf(l: Layout, id: string): string | null {
  if (l.type === "pane") return null;
  if (l.a.type === "pane" && l.a.id === id) return leaves(l.b)[0];
  if (l.b.type === "pane" && l.b.id === id) return leaves(l.a).slice(-1)[0];
  return hasPane(l.a, id) ? siblingLeaf(l.a, id) : siblingLeaf(l.b, id);
}

export function insertAt(l: Layout, target: string, side: Side, node: Layout): Layout {
  if (l.type === "pane") {
    if (l.id !== target) return l;
    const first = side === "left" || side === "top";
    return { type: "split", dir: side === "left" || side === "right" ? "row" : "column", ratio: 0.5, a: first ? node : l, b: first ? l : node };
  }
  const a = insertAt(l.a, target, side, node);
  const b = a === l.a ? insertAt(l.b, target, side, node) : l.b;
  return a === l.a && b === l.b ? l : { ...l, a, b };
}

export function swapPanes(l: Layout, x: string, y: string): Layout {
  if (l.type === "pane") return l.id === x ? leaf(y) : l.id === y ? leaf(x) : l;
  return { ...l, a: swapPanes(l.a, x, y), b: swapPanes(l.b, x, y) };
}

export function setRatio(l: Layout, path: string, ratio: number): Layout {
  if (l.type === "pane") return l;
  if (path === "") return { ...l, ratio };
  return path[0] === "a" ? { ...l, a: setRatio(l.a, path.slice(1), ratio) } : { ...l, b: setRatio(l.b, path.slice(1), ratio) };
}

function span(l: Layout, dir: "row" | "column"): number {
  if (l.type === "pane") return 1;
  return l.dir === dir ? span(l.a, dir) + span(l.b, dir) : Math.max(span(l.a, dir), span(l.b, dir));
}

export function equalShare(l: Layout): number {
  if (l.type === "pane") return 0.5;
  const sa = span(l.a, l.dir);
  return sa / (sa + span(l.b, l.dir));
}

export function equalize(l: Layout): Layout {
  if (l.type === "pane") return l;
  const next = { ...l, a: equalize(l.a), b: equalize(l.b) };
  return { ...next, ratio: equalShare(next) };
}

export function shape(l: Layout): string {
  return l.type === "pane" ? l.id : `${l.dir}(${shape(l.a)},${shape(l.b)})`;
}

export type Rect = { x: number; y: number; w: number; h: number };

export function paneRects(l: Layout, r: Rect, out = new Map<string, Rect>()): Map<string, Rect> {
  if (l.type === "pane") {
    out.set(l.id, r);
    return out;
  }
  if (l.dir === "row") {
    const w = r.w * l.ratio;
    paneRects(l.a, { ...r, w }, out);
    paneRects(l.b, { ...r, x: r.x + w, w: r.w - w }, out);
  } else {
    const h = r.h * l.ratio;
    paneRects(l.a, { ...r, h }, out);
    paneRects(l.b, { ...r, y: r.y + h, h: r.h - h }, out);
  }
  return out;
}

export function autoSide(l: Layout, paneId: string, w: number, h: number): Side {
  const r = paneRects(l, { x: 0, y: 0, w, h }).get(paneId);
  return !r || r.w >= r.h ? "right" : "bottom";
}

export function neighbor(l: Layout, from: string, dir: Side): string | null {
  const rects = paneRects(l, { x: 0, y: 0, w: 1000, h: 1000 });
  const a = rects.get(from);
  if (!a) return null;
  let best: string | null = null;
  let bestKey: [number, number, number] | null = null;
  for (const [id, b] of rects) {
    if (id === from) continue;
    let gap: number;
    let overlap: number;
    if (dir === "left" || dir === "right") {
      if (dir === "left" ? b.x + b.w > a.x + 0.5 : b.x < a.x + a.w - 0.5) continue;
      gap = dir === "left" ? a.x - (b.x + b.w) : b.x - (a.x + a.w);
      overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    } else {
      if (dir === "top" ? b.y + b.h > a.y + 0.5 : b.y < a.y + a.h - 0.5) continue;
      gap = dir === "top" ? a.y - (b.y + b.h) : b.y - (a.y + a.h);
      overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    }
    const key: [number, number, number] = [overlap > 0.5 ? 0 : 1, gap, -overlap];
    const better =
      !bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] - 0.5 || (Math.abs(key[1] - bestKey[1]) <= 0.5 && key[2] < bestKey[2])));
    if (better) {
      best = id;
      bestKey = key;
    }
  }
  return best;
}

export function aggregate(stages: PaneStage[]): SessionStatus {
  if (stages.includes("connected")) return "connected";
  if (stages.includes("connecting")) return "connecting";
  if (stages.includes("reconnecting")) return "reconnecting";
  if (stages.includes("failed")) return "error";
  return "closed";
}

// ---------------------------------------------------------------- runtime info per pane

export type PaneInfo = { stage: PaneStage; title: string; proc: string; auth: string; latency: number | null; cols: number; rows: number; bell: number; attempt: number; of: number; retryAt: number | null; note: string };

const BLANK: PaneInfo = { stage: "connecting", title: "", proc: "", auth: "", latency: null, cols: 0, rows: 0, bell: 0, attempt: 0, of: 0, retryAt: null, note: "" };

let infos: Record<string, PaneInfo> = {};
let stages: Record<string, PaneStage> = {};
const infoSubs = new Set<() => void>();
const stageSubs = new Set<() => void>();

export const paneStore = {
  subscribe(fn: () => void) {
    infoSubs.add(fn);
    return () => {
      infoSubs.delete(fn);
    };
  },
  subscribeStages(fn: () => void) {
    stageSubs.add(fn);
    return () => {
      stageSubs.delete(fn);
    };
  },
  infos: () => infos,
  stages: () => stages,
  info: (id: string): PaneInfo => infos[id] ?? BLANK,
  patch(id: string, p: Partial<PaneInfo>) {
    const cur = infos[id] ?? BLANK;
    if ((Object.keys(p) as (keyof PaneInfo)[]).every((k) => cur[k] === p[k])) return;
    infos = { ...infos, [id]: { ...cur, ...p } };
    infoSubs.forEach((f) => f());
    if (p.stage !== undefined && stages[id] !== p.stage) {
      stages = { ...stages, [id]: p.stage };
      stageSubs.forEach((f) => f());
    }
  },
  bell(id: string) {
    paneStore.patch(id, { bell: (infos[id]?.bell ?? 0) + 1 });
  },
  remove(ids: string[]) {
    const hit = ids.filter((id) => id in infos || id in stages);
    if (!hit.length) return;
    infos = { ...infos };
    stages = { ...stages };
    for (const id of hit) {
      delete infos[id];
      delete stages[id];
    }
    infoSubs.forEach((f) => f());
    stageSubs.forEach((f) => f());
  },
};

// ---------------------------------------------------------------- stable DOM homes for terminals

const containers = new Map<string, HTMLDivElement>();
let parking: HTMLElement | null = null;

export const paneHost = {
  container(id: string): HTMLDivElement {
    let c = containers.get(id);
    if (!c) {
      c = document.createElement("div");
      c.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;min-width:0;min-height:0";
      containers.set(id, c);
    }
    return c;
  },
  setParking(el: HTMLElement | null) {
    parking = el;
    paneHost.parkStray();
  },
  parkStray() {
    if (!parking) return;
    for (const c of containers.values()) if (!c.isConnected) parking.appendChild(c);
  },
  attach(id: string, slot: HTMLElement) {
    const c = paneHost.container(id);
    if (c.parentNode !== slot) slot.appendChild(c);
  },
  detach(id: string, slot: HTMLElement) {
    const c = containers.get(id);
    if (!c || c.parentNode !== slot) return;
    if (parking) parking.appendChild(c);
    else c.remove();
  },
  release(id: string) {
    containers.get(id)?.remove();
    containers.delete(id);
  },
  ids: () => [...containers.keys()],
};

// ---------------------------------------------------------------- drag and drop

export type DragPayload = { kind: "tab"; tabId: string } | { kind: "pane"; tabId: string; paneId: string } | { kind: "host"; hostId: string };

export type DropHint =
  | { kind: "pane"; tabId: string; paneId: string; zone: Zone; ok: boolean }
  | { kind: "tab"; tabId: string; mode: "reorder" | "into"; ok: boolean };

export type StartDrag = (e: ReactMouseEvent, payload: DragPayload, label: string) => void;

type DndState = { payload: DragPayload | null; hint: DropHint | null };

let dndState: DndState = { payload: null, hint: null };
const dndSubs = new Set<() => void>();

export const dnd = {
  subscribe(fn: () => void) {
    dndSubs.add(fn);
    return () => {
      dndSubs.delete(fn);
    };
  },
  get: () => dndState,
  set(next: DndState) {
    if (JSON.stringify(next) === JSON.stringify(dndState)) return;
    dndState = next;
    dndSubs.forEach((f) => f());
  },
};

export function zoneAt(rect: DOMRect, x: number, y: number, allowCenter: boolean): Zone {
  const nx = (x - rect.left) / Math.max(1, rect.width);
  const ny = (y - rect.top) / Math.max(1, rect.height);
  if (allowCenter && nx > 0.3 && nx < 0.7 && ny > 0.3 && ny < 0.7) return "center";
  const d: [Side, number][] = [
    ["left", nx],
    ["right", 1 - nx],
    ["top", ny],
    ["bottom", 1 - ny],
  ];
  return d.reduce((m, c) => (c[1] < m[1] ? c : m))[0];
}
