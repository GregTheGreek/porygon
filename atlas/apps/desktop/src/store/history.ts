// Command-based undo (Milestone 4 foundation).
//
// Why command-based rather than immutable-state snapshots: every M4 mutation
// pairs an in-memory change with a filesystem side effect (copy artwork on
// import/duplicate, move it to/from `.trash` on delete). A snapshot of app
// state cannot by itself re-copy or restore those files, and diffing snapshots
// to derive the file work would be more code than just writing the inverse
// action. A command carries its own do/undo pair, so the file effect and the
// state effect stay together and both are reversible. This is the pattern every
// future edit (collision/occlusion painting, scene-graph moves) will reuse.
//
// The initial forward action runs at the call site; the caller then pushes a
// command whose `redo`/`undo` re-apply or reverse it. Async commands are
// serialized by a `busy` flag so overlapping undo/redo cannot interleave.
// The stack is cleared on project close (undo need not survive it).

import { create } from 'zustand';

import { useProjectStore } from './project';

// Surface a failed undo/redo through the project store's error field (the same
// channel store actions use), so a filesystem failure mid-undo is shown to the
// artist rather than lost as an unhandled rejection. Imported lazily via
// getState() at call time, so the project<->history module cycle stays safe.
function reportHistoryError(action: 'undo' | 'redo', e: unknown) {
  useProjectStore.setState({ error: `Could not ${action}: ${String(e)}` });
}

export type Command = {
  label: string;
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
};

type HistoryState = {
  past: Command[];
  future: Command[];
  busy: boolean;
  push: (command: Command) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  clear: () => void;
};

export const useHistory = create<HistoryState>((set, get) => ({
  past: [],
  future: [],
  busy: false,

  // A fresh action invalidates any redo tail.
  push: (command) => set((s) => ({ past: [...s.past, command], future: [] })),

  undo: async () => {
    const { busy, past } = get();
    const command = past.at(-1);
    if (busy || !command) return;
    set({ busy: true });
    try {
      await command.undo();
      set((s) => ({
        past: s.past.slice(0, -1),
        future: [...s.future, command],
      }));
    } catch (e) {
      // Leave the command on the past stack (it did not fully reverse) so the
      // artist can retry, and surface why it failed.
      reportHistoryError('undo', e);
    } finally {
      set({ busy: false });
    }
  },

  redo: async () => {
    const { busy, future } = get();
    const command = future.at(-1);
    if (busy || !command) return;
    set({ busy: true });
    try {
      await command.redo();
      set((s) => ({
        future: s.future.slice(0, -1),
        past: [...s.past, command],
      }));
    } catch (e) {
      // Leave the command on the future stack (it did not fully re-apply) so
      // the artist can retry, and surface why it failed.
      reportHistoryError('redo', e);
    } finally {
      set({ busy: false });
    }
  },

  clear: () => set({ past: [], future: [] }),
}));
