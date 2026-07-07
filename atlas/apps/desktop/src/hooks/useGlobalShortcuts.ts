import { useEffect } from 'react';
import { buildCommands } from '../commands';
import { matchShortcut } from '../lib/shortcuts';
import { useUiStore } from '../store/ui';

// The single global keyboard handler (M14). It drives every app-level shortcut
// from the command registry, so shortcuts can never drift from the palette or
// the help overlay. Deliberately NOT handled here (and left to their existing
// owners so behavior is unchanged):
//   - cmd+= / cmd+- / cmd+0 / cmd+1 canvas zoom (CanvasEngine's own listener)
//   - play-mode arrows / WASD movement (CanvasEngine, while playing)
// The same input-field guard the canvas uses keeps shortcuts from firing while
// the user is typing in a field.
export function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      // Overlays (palette, help, preferences, context menu) own the keyboard
      // while open; each handles its own Escape/navigation.
      if (useUiStore.getState().anyOverlayOpen()) return;

      // '?' (shift+/) is the second, unmodified binding for the help overlay.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        useUiStore.getState().openHelp();
        return;
      }

      for (const cmd of buildCommands()) {
        if (!cmd.shortcut) continue;
        if (matchShortcut(e, cmd.shortcut)) {
          // A matched-but-disabled command is swallowed silently (e.g. a tool
          // key with no artwork loaded); it never falls through to the browser.
          if (cmd.enabled()) {
            e.preventDefault();
            void cmd.run();
          }
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
