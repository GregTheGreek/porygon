import { useEffect, useRef, useState } from 'react';
import { useProjectStore, type SaveStatus } from '../store/project';
import { useUiStore } from '../store/ui';

type Props = {
  version: string;
};

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: '',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Save failed',
};

export function Toolbar({ version }: Props) {
  const open = useProjectStore((s) => s.open);
  const status = useProjectStore((s) => s.status);
  const rename = useProjectStore((s) => s.rename);
  const close = useProjectStore((s) => s.close);
  const importObject = useProjectStore((s) => s.importObject);
  const importing = useProjectStore((s) => s.importing);
  const openPalette = useUiStore((s) => s.openPalette);
  const openHelp = useUiStore((s) => s.openHelp);
  const openPreferences = useUiStore((s) => s.openPreferences);

  return (
    <div className="flex h-9 shrink-0 items-center justify-between border-b border-bg-border bg-bg-raised px-3 select-none">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-fg">Porygon</span>
        <span className="text-xs text-fg-subtle">Object Authoring</span>
      </div>

      {open && (
        <div className="flex items-center gap-3">
          <ProjectName name={open.project.name} onRenameCommit={rename} />
          <span
            className={`w-16 text-right text-xs ${
              status === 'error' ? 'text-red-400' : 'text-fg-subtle'
            }`}
          >
            {STATUS_LABEL[status]}
          </span>
        </div>
      )}

      <div className="flex items-center gap-3">
        {open && (
          <button
            type="button"
            onClick={() => void importObject()}
            disabled={importing}
            title="Import a PNG as a new object"
            className="rounded px-2 py-0.5 text-xs text-fg-muted hover:bg-bg-input hover:text-fg disabled:opacity-40"
          >
            {importing ? 'Importing…' : 'Import PNG'}
          </button>
        )}
        {open && (
          <button
            type="button"
            onClick={close}
            title="Close project"
            className="rounded px-2 py-0.5 text-xs text-fg-subtle hover:bg-bg-input hover:text-fg"
          >
            Close
          </button>
        )}
        <span className="mx-1 h-4 w-px bg-bg-border" />
        <button
          type="button"
          onClick={openPalette}
          title="Command palette (Cmd/Ctrl+K)"
          className="rounded px-1.5 py-0.5 font-mono text-xs text-fg-subtle hover:bg-bg-input hover:text-fg"
        >
          ⌘K
        </button>
        <button
          type="button"
          onClick={openHelp}
          title="Keyboard shortcuts (Cmd/Ctrl+/ or ?)"
          className="rounded px-1.5 py-0.5 text-xs text-fg-subtle hover:bg-bg-input hover:text-fg"
        >
          ?
        </button>
        <button
          type="button"
          onClick={openPreferences}
          title="Preferences"
          className="rounded p-1 text-fg-subtle hover:bg-bg-input hover:text-fg"
        >
          <GearIcon />
        </button>
        <span className="font-mono text-xs text-fg-subtle">
          {version ? `v${version}` : ''}
        </span>
      </div>
    </div>
  );
}

// A small inline cog (not an emoji, per the style rules) for the Preferences
// button. 14px, stroked with currentColor so it inherits the button's text tone.
function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// Click-to-edit project name. Autosave proves itself on every committed rename.
function ProjectName({
  name,
  onRenameCommit,
}: {
  name: string;
  onRenameCommit: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== name) onRenameCommit(trimmed);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        className="w-48 rounded border border-accent bg-bg-input px-2 py-0.5 text-center text-sm text-fg outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(name);
        setEditing(true);
      }}
      title="Click to rename"
      className="rounded px-2 py-0.5 text-sm font-medium text-fg hover:bg-bg-input"
    >
      {name}
    </button>
  );
}
