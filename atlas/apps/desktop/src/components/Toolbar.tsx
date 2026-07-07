import { useEffect, useRef, useState } from 'react';
import { useProjectStore, type SaveStatus } from '../store/project';
import { useCanvasStore } from '../store/canvas';

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
  const importArtwork = useCanvasStore((s) => s.importArtwork);
  const importing = useCanvasStore((s) => s.importing);

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
            onClick={() => void importArtwork()}
            disabled={importing}
            title="Import a PNG onto the canvas"
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
        <span className="font-mono text-xs text-fg-subtle">
          {version ? `v${version}` : ''}
        </span>
      </div>
    </div>
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
