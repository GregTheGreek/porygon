import { create } from 'zustand';

// One transient notification. `kind` picks both the styling and the dismissal
// rule: info and success clear themselves after a few seconds, errors stay put
// until the artist dismisses them so a failure is never missed. Toasts are
// pure UI - never persisted, never undoable, never project data.
export type ToastKind = 'error' | 'info' | 'success';

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

// The queue is capped so a burst of failures cannot bury the workspace; the
// oldest toasts drop first. A few seconds is enough to read one short line.
export const MAX_TOASTS = 4;
export const AUTO_DISMISS_MS = 4000;

// Which kinds clear themselves. Errors are sticky (manual dismiss only).
export function autoDismisses(kind: ToastKind): boolean {
  return kind !== 'error';
}

// Append a toast, keeping only the most recent `max`. Pure so the cap rule is
// checkable without a store instance (no Vitest in this project yet).
export function enqueue(toasts: Toast[], toast: Toast, max = MAX_TOASTS): Toast[] {
  return [...toasts, toast].slice(-max);
}

type ToastState = {
  toasts: Toast[];
  // Raise a notification. Callers pass only kind + message; the id is minted
  // here. Fire once per user-facing outcome, not per internal retry.
  push: (toast: { kind: ToastKind; message: string }) => void;
  dismiss: (id: number) => void;
  clear: () => void;
};

export const useToasts = create<ToastState>((set, get) => {
  // Monotonic id, kept in the closure so bumping it never re-renders.
  let nextId = 1;
  return {
    toasts: [],
    push: ({ kind, message }) => {
      const id = nextId++;
      set((s) => ({ toasts: enqueue(s.toasts, { id, kind, message }) }));
      if (autoDismisses(kind)) {
        setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
      }
    },
    dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    clear: () => set({ toasts: [] }),
  };
});
