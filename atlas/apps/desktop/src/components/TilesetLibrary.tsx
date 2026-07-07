import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../store/project';
import { useUiStore, type MenuItem } from '../store/ui';
import { pickDirectory } from '../lib/api';
import { OBJECT_DRAG_TYPE } from './ObjectLibrary';

// Left panel (below the Object Library): the project's Tilesets, with create /
// rename / delete, a right-click context menu, and a drop target so objects
// dragged from the library above join the tileset. Selecting a tileset opens
// its Builder in the center region.
export function TilesetLibrary() {
  const open = useProjectStore((s) => s.open);
  const selectedId = useProjectStore((s) => s.selectedTilesetId);
  const createTileset = useProjectStore((s) => s.createTileset);
  const selectTileset = useProjectStore((s) => s.selectTileset);

  const tilesets = open?.project.tilesets ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-xs uppercase tracking-wide text-fg-muted">
          {tilesets.length} tileset{tilesets.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={() => void createTileset()}
          title="Create a new tileset"
          className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-white"
        >
          New
        </button>
      </div>

      {tilesets.length === 0 ? (
        <p className="px-3 text-sm text-fg-subtle">
          No tilesets yet. Create one, then add objects to it.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {tilesets.map((t) => (
            <TilesetRow
              key={t.id}
              id={t.id}
              name={t.name}
              count={t.members.length}
              selected={t.id === selectedId}
              onSelect={() => selectTileset(t.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TilesetRow({
  id,
  name,
  count,
  selected,
  onSelect,
}: {
  id: string;
  name: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const renameTileset = useProjectStore((s) => s.renameTileset);
  const deleteTileset = useProjectStore((s) => s.deleteTileset);
  const selectTileset = useProjectStore((s) => s.selectTileset);
  const compileTileset = useProjectStore((s) => s.compileTileset);
  const exportTileset = useProjectStore((s) => s.exportTileset);
  const bulkAddToTileset = useProjectStore((s) => s.bulkAddToTileset);
  const beginRename = useProjectStore((s) => s.beginRename);
  const endRename = useProjectStore((s) => s.endRename);
  const editing = useProjectStore(
    (s) => s.renaming?.kind === 'tileset' && s.renaming.id === id,
  );
  const openContextMenu = useUiStore((s) => s.openContextMenu);

  const [draft, setDraft] = useState(name);
  const [dropTarget, setDropTarget] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name);
      inputRef.current?.select();
    }
  }, [editing, name]);

  const commit = () => {
    renameTileset(id, draft);
    endRename();
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const runExport = async () => {
      selectTileset(id);
      const dest = await pickDirectory('Choose where to export the tileset');
      if (!dest) return;
      try {
        await exportTileset(id, dest);
      } catch (err) {
        useProjectStore.setState({ error: String(err) });
      }
    };
    // Compile/export are only meaningful with members; the store still gates
    // the deeper validity (budgets, binary) and surfaces problems in the panel.
    const items: MenuItem[] = [
      { label: 'Rename', onClick: () => beginRename({ kind: 'tileset', id }) },
      {
        label: 'Compile',
        disabled: count === 0,
        onClick: () => {
          selectTileset(id);
          void compileTileset(id);
        },
      },
      { label: 'Export…', disabled: count === 0, onClick: () => void runExport() },
      { separator: true },
      { label: 'Delete', danger: true, onClick: () => deleteTileset(id) },
    ];
    openContextMenu(e.clientX, e.clientY, items);
  };

  // Accept objects dragged from the library (single or a multi-selection).
  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(OBJECT_DRAG_TYPE);
    setDropTarget(false);
    if (!raw) return;
    e.preventDefault();
    try {
      const ids = JSON.parse(raw) as string[];
      if (Array.isArray(ids) && ids.length > 0) bulkAddToTileset(id, ids);
    } catch {
      /* malformed payload: ignore */
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(OBJECT_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!dropTarget) setDropTarget(true);
    }
  };

  return (
    <li
      onContextMenu={onContextMenu}
      onDragOver={onDragOver}
      onDragLeave={() => setDropTarget(false)}
      onDrop={onDrop}
      className={`group flex items-center gap-1 rounded px-2 py-1 ${
        dropTarget
          ? 'ring-1 ring-accent bg-accent/15'
          : selected
            ? 'bg-accent/20'
            : 'hover:bg-bg-input'
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
            if (e.key === 'Escape') endRename();
          }}
          className="min-w-0 flex-1 rounded border border-accent bg-bg-input px-1 text-sm text-fg outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          onDoubleClick={() => beginRename({ kind: 'tileset', id })}
          title={name}
          className={`flex min-w-0 flex-1 items-baseline gap-1.5 text-left text-sm ${
            selected ? 'text-fg' : 'text-fg-muted'
          }`}
        >
          <span className="truncate">{name}</span>
          <span className="shrink-0 text-xs text-fg-subtle">{count}</span>
        </button>
      )}

      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <RowButton title="Rename" onClick={() => beginRename({ kind: 'tileset', id })}>
            Rename
          </RowButton>
          <RowButton title="Delete" danger onClick={() => deleteTileset(id)}>
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
