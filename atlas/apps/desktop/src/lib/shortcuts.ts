// Structured keyboard shortcuts, shared by the command registry, the global
// shortcut handler, the command palette, and the help overlay so a shortcut is
// declared exactly once (M14). `mod` is the platform primary modifier (cmd on
// macOS, ctrl elsewhere); `key` is compared case-insensitively against
// KeyboardEvent.key ('v', 's', '/', '[', 'ArrowUp', 'Backspace', 'F2', ...).
export type Shortcut = {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
};

// macOS uses the Command key and glyph modifiers; everything else uses Ctrl and
// spelled-out modifiers. Detected once from the user agent.
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Special-key display glyphs/labels, keyed by the lowercased shortcut key.
const KEY_LABEL: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  backspace: isMac ? '⌫' : 'Backspace',
  enter: '↵',
  escape: 'Esc',
  ' ': 'Space',
};

// A human-readable label for a single key ('v' -> 'V', 'arrowup' -> '↑').
function keyLabel(key: string): string {
  const lower = key.toLowerCase();
  if (KEY_LABEL[lower]) return KEY_LABEL[lower];
  return key.length === 1 ? key.toUpperCase() : key;
}

// Render a shortcut for display, e.g. '⌘K', '⇧⌘Z', 'V', '⌘⌫' on macOS, or
// 'Ctrl+K', 'Ctrl+Shift+Z', 'V' elsewhere.
export function formatShortcut(s: Shortcut): string {
  if (isMac) {
    let out = '';
    if (s.alt) out += '⌥';
    if (s.shift) out += '⇧';
    if (s.mod) out += '⌘';
    return out + keyLabel(s.key);
  }
  const parts: string[] = [];
  if (s.mod) parts.push('Ctrl');
  if (s.shift) parts.push('Shift');
  if (s.alt) parts.push('Alt');
  parts.push(keyLabel(s.key));
  return parts.join('+');
}

// Whether a keyboard event matches a shortcut. `mod` treats cmd and ctrl alike
// (the app has always accepted either, see the undo handler), so a shortcut
// works on any platform without a second binding.
export function matchShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (mod !== !!s.mod) return false;
  if (e.shiftKey !== !!s.shift) return false;
  if (e.altKey !== !!s.alt) return false;
  return e.key.toLowerCase() === s.key.toLowerCase();
}
