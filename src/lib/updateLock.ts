export type UpdatePhase = { kind: "idle" } | { kind: "downloading"; pct: number | null } | { kind: "ready" } | { kind: "error"; message: string };

let phase: UpdatePhase = { kind: "idle" };
const listeners = new Set<() => void>();

export const updateLock = {
  busy: false,
  phase: () => phase,
  setPhase(next: UpdatePhase) {
    phase = next;
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
