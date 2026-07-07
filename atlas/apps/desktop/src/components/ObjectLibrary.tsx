import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '../store/project';
import { useUiStore, type MenuItem } from '../store/ui';

// The MIME-ish key for an internal object drag (library -> tileset). Carries a
// JSON array of object ids so a multi-selection drags as a unit.
export const OBJECT_DRAG_TYPE = 'application/x-atlas-objects';

// Left panel: the project's Objects, with import / rename / duplicate / delete,
// multi-select (cmd-click toggle, shift-click range), a right-click context
// menu, and drag-to-tileset. Selecting an object shows its artwork on the
// Canvas; the Canvas/Inspector always follow the PRIMARY (last-clicked)
// selection, while bulk actions operate on the whole set.
export function ObjectLibrary() {
  const open = useProjectStore((s) => s.open);
  const selectedIds = useProjectStore((s) => s.selectedObjectIds);
  const primaryId = useProjectStore((s) => s.selectedObjectId);
  const importing = useProjectStore((s) => s.importing);
  const importObject = useProjectStore((s) => s.importObject);
  const clickObject = useProjectStore((s) => s.clickObject);
  const beginRename = useProjectStore((s) => s.beginRename);
  const duplicateObject = useProjectStore((s) => s.duplicateObject);
  const deleteObject = useProjectStore((s) => s.deleteObject);
  const bulkDeleteObjects = useProjectStore((s) => s.bulkDeleteObjects);
  const bulkAddToTileset = useProjectStore((s) => s.bulkAddToTileset);
  const addTilesetMember = useProjectStore((s) => s.addTilesetMember);
  const openContextMenu = useUiStore((s) => s.openContextMenu);

  const objects = open?.project.objects ?? [];
  const tilesets = open?.project.tilesets ?? [];

  const onRowContextMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    // Operate on the whole selection when the right-clicked row is part of a
    // multi-selection; otherwise act on just this object (and select it).
    const inSelection = selectedIds.includes(id);
    const ids = inSelection && selectedIds.length > 1 ? selectedIds : [id];
    if (!inSelection) void clickObject(id, { meta: false, shift: false });
    const many = ids.length > 1;

    const addToTileset: MenuItem = {
      label: many ? `Add ${ids.length} to tileset` : 'Add to tileset',
      submenu:
        tilesets.length === 0
          ? [{ label: 'No tilesets yet', disabled: true }]
          : tilesets.map((t) => ({
              label: t.name,
              onClick: () =>
                many ? bulkAddToTileset(t.id, ids) : addTilesetMember(t.id, id),
            })),
    };

    const items: MenuItem[] = many
      ? [
          addToTileset,
          { separator: true },
          {
            label: `Delete ${ids.length} objects`,
            danger: true,
            onClick: () => void bulkDeleteObjects(ids),
          },
        ]
      : [
          { label: 'Rename', onClick: () => beginRename({ kind: 'object', id }) },
          { label: 'Duplicate', onClick: () => void duplicateObject(id) },
          addToTileset,
          { separator: true },
          { label: 'Delete', danger: true, onClick: () => void deleteObject(id) },
        ];

    openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-xs uppercase tracking-wide text-fg-muted">
          {objects.length} object{objects.length === 1 ? '' : 's'}
          {selectedIds.length > 1 ? ` · ${selectedIds.length} selected` : ''}
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
          No objects yet. Import artwork or drop a PNG to create one.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {objects.map((obj) => (
            <ObjectRow
              key={obj.id}
              id={obj.id}
              name={obj.name}
              selected={selectedIds.includes(obj.id)}
              primary={obj.id === primaryId}
              selectedIds={selectedIds}
              onClick={(e) =>
                void clickObject(obj.id, {
                  meta: e.metaKey || e.ctrlKey,
                  shift: e.shiftKey,
                })
              }
              onContextMenu={(e) => onRowContextMenu(e, obj.id)}
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
  primary,
  selectedIds,
  onClick,
  onContextMenu,
}: {
  id: string;
  name: string;
  selected: boolean;
  primary: boolean;
  selectedIds: string[];
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const renameObject = useProjectStore((s) => s.renameObject);
  const duplicateObject = useProjectStore((s) => s.duplicateObject);
  const deleteObject = useProjectStore((s) => s.deleteObject);
  const beginRename = useProjectStore((s) => s.beginRename);
  // This row is being renamed when the store's rename target points at it
  // (F2 / context menu / double-click all funnel through here).
  const editing = useProjectStore(
    (s) => s.renaming?.kind === 'object' && s.renaming.id === id,
  );
  const endRename = useProjectStore((s) => s.endRename);

  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name);
      inputRef.current?.select();
    }
  }, [editing, name]);

  const commit = () => {
    renameObject(id, draft);
    endRename();
  };

  // Dragging the row (or the selection it belongs to) onto a tileset adds
  // membership. Carry the whole multi-selection when this row is part of it.
  const onDragStart = (e: React.DragEvent) => {
    const ids = selected && selectedIds.length > 1 ? selectedIds : [id];
    e.dataTransfer.setData(OBJECT_DRAG_TYPE, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <li
      draggable={!editing}
      onDragStart={onDragStart}
      onContextMenu={onContextMenu}
      className={`group flex items-center gap-1 rounded px-2 py-1 ${
        primary ? 'bg-accent/25' : selected ? 'bg-accent/15' : 'hover:bg-bg-input'
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
          onClick={onClick}
          onDoubleClick={() => beginRename({ kind: 'object', id })}
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
          <RowButton title="Rename" onClick={() => beginRename({ kind: 'object', id })}>
            Rename
          </RowButton>
          <RowButton title="Duplicate" onClick={() => void duplicateObject(id)}>
            Dup
          </RowButton>
          <RowButton title="Delete" danger onClick={() => void deleteObject(id)}>
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
