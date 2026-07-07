import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../store/project';

// Left panel: the project's Objects, with import / rename / duplicate / delete.
// Selecting an object shows its artwork on the Canvas.
export function ObjectLibrary() {
  const open = useProjectStore((s) => s.open);
  const selectedId = useProjectStore((s) => s.selectedObjectId);
  const importing = useProjectStore((s) => s.importing);
  const importObject = useProjectStore((s) => s.importObject);
  const selectObject = useProjectStore((s) => s.selectObject);

  const objects = open?.project.objects ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-xs uppercase tracking-wide text-fg-muted">
          {objects.length} object{objects.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={() => void importObject()}
          disabled={importing}
          title="Import a PNG as a new object"
          className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {importing ? 'Importing…' : 'Import'}
        </button>
      </div>

      {objects.length === 0 ? (
        <p className="px-3 text-sm text-fg-subtle">
          No objects yet. Import artwork to create one.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {objects.map((obj) => (
            <ObjectRow
              key={obj.id}
              id={obj.id}
              name={obj.name}
              selected={obj.id === selectedId}
              onSelect={() => void selectObject(obj.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ObjectRow({
  id,
  name,
  selected,
  onSelect,
}: {
  id: string;
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const renameObject = useProjectStore((s) => s.renameObject);
  const duplicateObject = useProjectStore((s) => s.duplicateObject);
  const deleteObject = useProjectStore((s) => s.deleteObject);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    renameObject(id, draft);
    setEditing(false);
  };

  return (
    <li
      className={`group flex items-center gap-1 rounded px-2 py-1 ${
        selected ? 'bg-accent/20' : 'hover:bg-bg-input'
      }`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="min-w-0 flex-1 rounded border border-accent bg-bg-input px-1 text-sm text-fg outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={() => {
            setDraft(name);
            setEditing(true);
          }}
          title={name}
          className={`min-w-0 flex-1 truncate text-left text-sm ${
            selected ? 'text-fg' : 'text-fg-muted'
          }`}
        >
          {name}
        </button>
      )}

      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <RowButton
            title="Rename"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            Rename
          </RowButton>
          <RowButton title="Duplicate" onClick={() => void duplicateObject(id)}>
            Dup
          </RowButton>
          <RowButton
            title="Delete"
            danger
            onClick={() => void deleteObject(id)}
          >
            Del
          </RowButton>
        </div>
      )}
    </li>
  );
}

function RowButton({
  children,
  title,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded px-1 py-0.5 text-xs ${
        danger
          ? 'text-fg-subtle hover:bg-red-500/20 hover:text-red-300'
          : 'text-fg-subtle hover:bg-bg-raised hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
