import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/project';
import type { TilesetBudget } from '../lib/api';
import { BudgetMeter } from './BudgetMeter';

// Center region when a Tileset is selected: the Builder. Shows the tileset's
// members, live budget meters (palettes / tiles / metatiles), and Tier 2
// problems in artist terms. Budgets recompute after any membership change,
// debounced, off the UI thread (the Rust command is async).
const RECOMPUTE_DELAY_MS = 250;

export function TilesetBuilder() {
  const tileset = useProjectStore((s) =>
    s.open && s.selectedTilesetId
      ? s.open.project.tilesets.find((t) => t.id === s.selectedTilesetId) ?? null
      : null,
  );
  const objects = useProjectStore((s) => s.open?.project.objects ?? []);
  const renameTileset = useProjectStore((s) => s.renameTileset);
  const addMember = useProjectStore((s) => s.addTilesetMember);
  const removeMember = useProjectStore((s) => s.removeTilesetMember);
  const computeBudget = useProjectStore((s) => s.computeTilesetBudget);

  const [budget, setBudget] = useState<TilesetBudget | null>(null);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tilesetId = tileset?.id ?? null;
  // A key that changes whenever membership changes, so budgets recompute.
  const membersKey = tileset?.members.join(',') ?? '';

  useEffect(() => {
    if (!tilesetId) return;
    let alive = true;
    setComputing(true);
    const timer = setTimeout(() => {
      computeBudget(tilesetId)
        .then((b) => {
          if (alive) {
            setBudget(b);
            setError(null);
          }
        })
        .catch((e) => {
          if (alive) setError(String(e));
        })
        .finally(() => {
          if (alive) setComputing(false);
        });
    }, RECOMPUTE_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [tilesetId, membersKey, computeBudget]);

  if (!tileset) return null;

  const objectsById = new Map(objects.map((o) => [o.id, o]));
  const available = objects.filter((o) => !tileset.members.includes(o.id));

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
              </div>
            ) : error ? (
              <p className="text-sm text-red-400">{error}</p>
            ) : (
              <p className="text-sm text-fg-subtle">Computing budgets…</p>
            )}
          </section>

          {budget && budget.problems.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-wide text-fg-muted">
                Problems
              </h3>
              <ul className="space-y-1">
                {budget.problems.map((p, i) => (
                  <li
                    key={i}
                    className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-200"
                  >
                    <span className="mr-1 font-medium uppercase tracking-wide text-red-400/80">
                      {p.tier}
                    </span>
                    {p.message}
                  </li>
                ))}
              </ul>
            </section>
          )}

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

            {tileset.members.length === 0 ? (
              <p className="text-sm text-fg-subtle">
                No objects yet. Add objects to build the tileset.
              </p>
            ) : (
              <ul className="space-y-1">
                {tileset.members.map((memberId) => {
                  const obj = objectsById.get(memberId);
                  return (
                    <li
                      key={memberId}
                      className="flex items-center gap-2 rounded bg-bg-panel px-2 py-1.5 text-sm"
                    >
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
                        onClick={() => removeMember(tileset.id, memberId)}
                        className="shrink-0 rounded px-1 py-0.5 text-xs text-fg-subtle hover:bg-red-500/20 hover:text-red-300"
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
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
