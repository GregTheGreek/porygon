import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/project';
import { pickDirectory, pickFile, setPorytilesPath, verifyPorytiles } from '../lib/api';
import type { AtlasObject, BinaryStatus } from '../lib/api';
import { BudgetMeter } from './BudgetMeter';
import { OBJECT_DRAG_TYPE } from './ObjectLibrary';

// Payload for reordering a member within the list (carries its current index).
const MEMBER_DRAG_TYPE = 'application/x-atlas-member-index';

// Center region when a Tileset is selected: the Builder. Shows the tileset's
// members, live budget meters (palettes / tiles / metatiles), export, and the
// M11 compile flow (target decomp project + Porytiles). Tier 2/3 problems now
// render in the bottom Problems panel; the Builder holds the meters and the
// actions. Budgets recompute after any membership change, debounced, off the
// UI thread (the Rust command is async), and live in the store so the
// Problems panel reads the same result.
const RECOMPUTE_DELAY_MS = 250;

export function TilesetBuilder() {
  const tileset = useProjectStore((s) =>
    s.open && s.selectedTilesetId
      ? s.open.project.tilesets.find((t) => t.id === s.selectedTilesetId) ?? null
      : null,
  );
  const objects = useProjectStore((s) => s.open?.project.objects ?? []);
  const compileTarget = useProjectStore((s) => s.open?.project.compile_target ?? null);
  const renameTileset = useProjectStore((s) => s.renameTileset);
  const addMember = useProjectStore((s) => s.addTilesetMember);
  const removeMember = useProjectStore((s) => s.removeTilesetMember);
  const reorderMember = useProjectStore((s) => s.reorderTilesetMember);
  const bulkAddToTileset = useProjectStore((s) => s.bulkAddToTileset);
  const refreshBudget = useProjectStore((s) => s.refreshTilesetBudget);
  const runExport = useProjectStore((s) => s.exportTileset);
  const setCompileTarget = useProjectStore((s) => s.setCompileTarget);
  const runCompile = useProjectStore((s) => s.compileTileset);

  const budget = useProjectStore((s) => s.budget);
  const computing = useProjectStore((s) => s.budgetComputing);
  const budgetError = useProjectStore((s) => s.budgetError);
  const compiling = useProjectStore((s) => s.compiling);
  const compileResult = useProjectStore((s) => s.compileResult);

  // Export status. Not undoable and outside autosave: export writes outside
  // the project and never touches project data.
  const [exporting, setExporting] = useState(false);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Porytiles binary readiness, checked once per Builder mount. Compile is
  // disabled (with the status message) until the pinned version is found.
  const [binary, setBinary] = useState<BinaryStatus | null>(null);
  useEffect(() => {
    let alive = true;
    verifyPorytiles()
      .then((s) => alive && setBinary(s))
      .catch((e) => alive && setBinary({ ok: false, path: '', version: null, message: String(e) }));
    return () => {
      alive = false;
    };
  }, []);

  const tilesetId = tileset?.id ?? null;
  // A key that changes whenever membership changes, so budgets recompute.
  const membersKey = tileset?.members.join(',') ?? '';

  useEffect(() => {
    if (!tilesetId) return;
    const timer = setTimeout(() => {
      void refreshBudget(tilesetId);
    }, RECOMPUTE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tilesetId, membersKey, refreshBudget]);

  // A stale success/error message would mislead once the tileset or its
  // membership changes, so export status resets with them.
  useEffect(() => {
    setExportedPath(null);
    setExportError(null);
  }, [tilesetId, membersKey]);

  if (!tileset) return null;

  const objectsById = new Map(objects.map((o) => [o.id, o]));
  const available = objects.filter((o) => !tileset.members.includes(o.id));

  // Same gating for export and compile: any Tier 1/2 problem blocks both.
  const blocked = (budget?.problems.length ?? 0) > 0;
  const actionDisabled = computing || tileset.members.length === 0 || blocked;
  const blockTitle = blocked
    ? 'Fix the problems in the Problems panel first'
    : tileset.members.length === 0
      ? 'Add objects to the tileset first'
      : undefined;

  const onExport = async () => {
    const dest = await pickDirectory('Choose where to export the tileset');
    if (!dest) return;
    setExporting(true);
    setExportedPath(null);
    setExportError(null);
    try {
      const result = await runExport(tileset.id, dest);
      setExportedPath(result.path);
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  };

  const onPickTarget = async () => {
    const dir = await pickDirectory('Choose the decomp project to compile into');
    if (dir) setCompileTarget(dir);
  };

  // Point Porygon at a different Porytiles binary (persisted app-side, like
  // recents), then re-verify so the readiness message updates immediately.
  const onLocatePorytiles = async () => {
    const path = await pickFile('Locate the porytiles binary');
    if (!path) return;
    try {
      await setPorytilesPath(path);
      setBinary(await verifyPorytiles());
    } catch (e) {
      setBinary({ ok: false, path, version: null, message: String(e) });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-bg-border px-3">
        <span className="text-xs uppercase tracking-wide text-fg-muted">
          Tileset
        </span>
        <TilesetName
          key={tileset.id}
          name={tileset.name}
          onCommit={(v) => renameTileset(tileset.id, v)}
        />
        <span className="ml-auto text-xs text-fg-subtle">
          {computing ? 'Computing…' : ''}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto max-w-2xl space-y-6">
          <section className="space-y-3">
            <h3 className="text-xs uppercase tracking-wide text-fg-muted">
              Budgets (secondary tileset)
            </h3>
            {budget ? (
              <div className="space-y-3">
                <BudgetMeter
                  label="Palettes"
                  used={budget.palettes.used}
                  total={budget.palettes.total}
                />
                <BudgetMeter
                  label="Tiles"
                  used={budget.tiles.used_min}
                  total={budget.tiles.total}
                  note={
                    budget.tiles.used_max !== budget.tiles.used_min
                      ? `${budget.tiles.used_min}-${budget.tiles.used_max} depending on flip reuse`
                      : undefined
                  }
                />
                <BudgetMeter
                  label="Metatiles"
                  used={budget.metatiles.used}
                  total={budget.metatiles.total}
                />
                {blocked && (
                  <p className="text-xs text-red-300">
                    This tileset has problems - see the Problems panel below.
                  </p>
                )}
              </div>
            ) : budgetError ? (
              <p className="text-sm text-red-400">{budgetError}</p>
            ) : (
              <p className="text-sm text-fg-subtle">Computing budgets…</p>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs uppercase tracking-wide text-fg-muted">
                Members ({tileset.members.length})
              </h3>
              <AddMember
                available={available.map((o) => ({ id: o.id, name: o.name }))}
                onAdd={(id) => addMember(tileset.id, id)}
              />
            </div>

            <MemberList
              members={tileset.members}
              objectsById={objectsById}
              onRemove={(memberId) => removeMember(tileset.id, memberId)}
              onReorder={(from, to) => reorderMember(tileset.id, from, to)}
              onAddObjects={(ids) => bulkAddToTileset(tileset.id, ids)}
            />
          </section>

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-fg-muted">
              Compile (Porytiles)
            </h3>
            <p className="text-xs text-fg-subtle">
              Compiles this tileset into a decomp project with Porytiles and
              adds a Porymap prefab per object. Point it at a scratch copy of
              your project, never at a pristine checkout.
            </p>

            {binary && !binary.ok && (
              <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
                <p>{binary.message}</p>
                <button
                  type="button"
                  onClick={() => void onLocatePorytiles()}
                  className="underline hover:text-amber-100"
                >
                  Locate Porytiles…
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void onPickTarget()}
                className="rounded border border-bg-border bg-bg-input px-3 py-1 text-sm text-fg hover:border-accent"
              >
                {compileTarget ? 'Change target…' : 'Choose target project…'}
              </button>
              {compileTarget && (
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle" title={compileTarget}>
                  {compileTarget}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={
                  actionDisabled || compiling || !compileTarget || !(binary?.ok ?? false)
                }
                onClick={() => void runCompile(tileset.id)}
                title={
                  blockTitle ??
                  (!compileTarget
                    ? 'Choose a target decomp project first'
                    : !(binary?.ok ?? false)
                      ? binary?.message
                      : undefined)
                }
                className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {compiling ? 'Compiling...' : 'Compile tileset'}
              </button>
              {blocked && (
                <span className="text-xs text-fg-subtle">
                  Fix the problems below to enable compiling.
                </span>
              )}
            </div>

            {compileResult?.success && (
              <div className="space-y-1 rounded border border-green-500/40 bg-green-500/10 px-2 py-1.5 text-xs text-green-200">
                <p>
                  Compiled {compileResult.secondary_symbol} (paired with{' '}
                  {compileResult.primary_symbol}).
                </p>
                {compileResult.tileset_bin_dir && (
                  <p className="break-all">Tileset written to {compileResult.tileset_bin_dir}</p>
                )}
                {compileResult.prefabs && (
                  <p className="break-all">
                    {compileResult.prefabs.written} prefab
                    {compileResult.prefabs.written === 1 ? '' : 's'} written to{' '}
                    {compileResult.prefabs.prefabs_path}
                  </p>
                )}
              </div>
            )}
            {compileResult && !compileResult.success && (
              <p className="text-xs text-fg-subtle">
                The compile was rejected - see the Problems panel below.
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-fg-muted">
              Export
            </h3>
            <p className="text-xs text-fg-subtle">
              Writes the Porytiles source files and one .atlasobject per object
              into a folder you choose. Nothing in the project changes.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={actionDisabled || exporting}
                onClick={onExport}
                title={blockTitle}
                className="rounded border border-bg-border bg-bg-input px-3 py-1 text-sm text-fg hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                {exporting ? 'Exporting...' : 'Export tileset'}
              </button>
            </div>
            {exportedPath && (
              <p className="break-all rounded border border-green-500/40 bg-green-500/10 px-2 py-1.5 text-xs text-green-200">
                Exported to {exportedPath}
              </p>
            )}
            {exportError && (
              <p className="whitespace-pre-wrap rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-200">
                {exportError}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// The tileset's members, in layout order (M14): drag a row to reorder, drop an
// object dragged from the library to add it, or use Remove. Order matters for
// layout, so reordering is a real (undoable) project edit.
function MemberList({
  members,
  objectsById,
  onRemove,
  onReorder,
  onAddObjects,
}: {
  members: string[];
  objectsById: Map<string, AtlasObject>;
  onRemove: (memberId: string) => void;
  onReorder: (from: number, to: number) => void;
  onAddObjects: (ids: string[]) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [addTarget, setAddTarget] = useState(false);

  // Accept objects dragged from the Object Library anywhere over the list.
  const onListDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(OBJECT_DRAG_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!addTarget) setAddTarget(true);
    }
  };
  const onListDrop = (e: React.DragEvent) => {
    setAddTarget(false);
    const raw = e.dataTransfer.getData(OBJECT_DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    try {
      const ids = JSON.parse(raw) as string[];
      if (Array.isArray(ids) && ids.length > 0) onAddObjects(ids);
    } catch {
      /* malformed payload: ignore */
    }
  };

  if (members.length === 0) {
    return (
      <div
        onDragOver={onListDragOver}
        onDragLeave={() => setAddTarget(false)}
        onDrop={onListDrop}
        className={`rounded border border-dashed px-3 py-4 text-sm text-fg-subtle ${
          addTarget ? 'border-accent bg-accent/10' : 'border-bg-border'
        }`}
      >
        No objects yet. Add objects, or drag them here from the library.
      </div>
    );
  }

  return (
    <ul
      onDragOver={onListDragOver}
      onDragLeave={() => setAddTarget(false)}
      onDrop={onListDrop}
      className={`space-y-1 rounded ${addTarget ? 'ring-1 ring-accent' : ''}`}
    >
      {members.map((memberId, index) => {
        const obj = objectsById.get(memberId);
        return (
          <li
            key={memberId}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(MEMBER_DRAG_TYPE, String(index));
              e.dataTransfer.effectAllowed = 'move';
              setDragIndex(index);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(MEMBER_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (overIndex !== index) setOverIndex(index);
            }}
            onDrop={(e) => {
              if (!e.dataTransfer.types.includes(MEMBER_DRAG_TYPE)) return; // object-add bubbles to the list
              e.preventDefault();
              e.stopPropagation();
              const from = Number(e.dataTransfer.getData(MEMBER_DRAG_TYPE));
              setOverIndex(null);
              setDragIndex(null);
              if (Number.isInteger(from)) onReorder(from, index);
            }}
            className={`flex items-center gap-2 rounded bg-bg-panel px-2 py-1.5 text-sm ${
              overIndex === index && dragIndex !== index ? 'ring-1 ring-accent' : ''
            } ${dragIndex === index ? 'opacity-50' : ''}`}
          >
            <span className="cursor-grab select-none text-fg-subtle" title="Drag to reorder">
              ⋮⋮
            </span>
            <span className={`min-w-0 flex-1 truncate ${obj ? 'text-fg' : 'text-fg-subtle italic'}`}>
              {obj ? obj.name : 'Missing object'}
            </span>
            {obj && (
              <span className="shrink-0 font-mono text-xs text-fg-subtle">
                {obj.width}×{obj.height}
              </span>
            )}
            <button
              type="button"
              title="Remove from tileset"
              onClick={() => onRemove(memberId)}
              className="shrink-0 rounded px-1 py-0.5 text-xs text-fg-subtle hover:bg-red-500/20 hover:text-red-300"
            >
              Remove
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Inline editable tileset name in the Builder header.
function TilesetName({
  name,
  onCommit,
}: {
  name: string;
  onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        onCommit(draft);
        setDraft(name);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(name);
      }}
      className="rounded px-1 py-0.5 text-sm font-medium text-fg outline-none hover:bg-bg-input focus:bg-bg-input focus:border-accent"
    />
  );
}

// A select that adds an object to the tileset. Resets after each add. Disabled
// when every object is already a member.
function AddMember({
  available,
  onAdd,
}: {
  available: { id: string; name: string }[];
  onAdd: (id: string) => void;
}) {
  return (
    <select
      value=""
      disabled={available.length === 0}
      onChange={(e) => {
        if (e.target.value) onAdd(e.target.value);
      }}
      className="rounded border border-bg-border bg-bg-input px-2 py-0.5 text-xs text-fg outline-none focus:border-accent disabled:opacity-40"
    >
      <option value="">
        {available.length === 0 ? 'All objects added' : 'Add object…'}
      </option>
      {available.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}
