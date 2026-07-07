import { useEffect, useRef, useState } from 'react';
import { useProjectStore, wouldCreateCycle } from '../store/project';
import { useUiStore, type MenuItem } from '../store/ui';
import type { AtlasObject } from '../lib/api';

// Right panel: live, dialog-free metadata editing for the selected Object.
// Fields commit on blur/Enter; every commit is an undoable store mutation, so
// the library list and Canvas update immediately and autosave picks it up.
export function Inspector() {
  const object = useProjectStore((s) =>
    s.open && s.selectedObjectId
      ? s.open.project.objects.find((o) => o.id === s.selectedObjectId) ?? null
      : null,
  );
  const renameObject = useProjectStore((s) => s.renameObject);
  const setObjectCategory = useProjectStore((s) => s.setObjectCategory);
  const addObjectTag = useProjectStore((s) => s.addObjectTag);
  const removeObjectTag = useProjectStore((s) => s.removeObjectTag);
  const setObjectAnchor = useProjectStore((s) => s.setObjectAnchor);

  if (!object) {
    return <>No selection. Select an object in the library to inspect it.</>;
  }

  return (
    // Keyed by id so field drafts never leak across a selection change.
    <div key={object.id} className="space-y-3">
      <Field label="Name">
        <TextField
          value={object.name}
          onCommit={(v) => renameObject(object.id, v)}
        />
      </Field>

      <Field label="Dimensions">
        <div className="mt-1 font-mono text-sm text-fg">
          {object.width} × {object.height} px
        </div>
      </Field>

      <Field label="Category">
        <TextField
          value={object.category}
          placeholder="Uncategorized"
          onCommit={(v) => setObjectCategory(object.id, v)}
        />
      </Field>

      <Field label="Tags">
        <TagEditor
          tags={object.tags}
          onAdd={(tag) => addObjectTag(object.id, tag)}
          onRemove={(tag) => removeObjectTag(object.id, tag)}
        />
      </Field>

      <Field label="Variants">
        <VariantsEditor object={object} />
      </Field>

      <Field label="Anchor (16px grid)">
        <div className="mt-1 flex items-center gap-2">
          <NumberField
            label="X"
            value={object.anchor.x}
            onCommit={(v) => setObjectAnchor(object.id, v, object.anchor.y)}
          />
          <NumberField
            label="Y"
            value={object.anchor.y}
            onCommit={(v) => setObjectAnchor(object.id, object.anchor.x, v)}
          />
        </div>
      </Field>

      <Field label="Children">
        <ChildrenEditor object={object} />
      </Field>

      {/* Tier 1 problems moved to the bottom Problems panel (M11), which
          unifies all three validity tiers in one place. */}
    </div>
  );
}

// The Hierarchy section (M12): the selected object's child placements. Add a
// child from the library (cycle-creating candidates are excluded), nudge its
// anchor-to-anchor offset on the 16px grid, remove it, or click a row to
// highlight the child's footprint on the canvas. Every mutation is undoable.
function ChildrenEditor({ object }: { object: AtlasObject }) {
  const objects = useProjectStore((s) => s.open?.project.objects ?? []);
  const addObjectChild = useProjectStore((s) => s.addObjectChild);
  const removeObjectChild = useProjectStore((s) => s.removeObjectChild);
  const setObjectChildOffset = useProjectStore((s) => s.setObjectChildOffset);
  const selectedChildIndex = useProjectStore((s) => s.selectedChildIndex);
  const selectChild = useProjectStore((s) => s.selectChild);

  const openContextMenu = useUiStore((s) => s.openContextMenu);

  const byId = new Map(objects.map((o) => [o.id, o]));
  const candidates = objects.filter(
    (o) => o.id !== object.id && !wouldCreateCycle(objects, object.id, o.id),
  );

  const onChildContextMenu = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    const highlighted = selectedChildIndex === index;
    const items: MenuItem[] = [
      {
        label: highlighted ? 'Clear highlight' : 'Highlight footprint',
        onClick: () => selectChild(highlighted ? null : index),
      },
      { separator: true },
      {
        label: 'Remove child',
        danger: true,
        onClick: () => removeObjectChild(object.id, index),
      },
    ];
    openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <div className="mt-1 space-y-1.5">
      {object.children.map((child, i) => {
        const childObj = byId.get(child.object_id);
        const selected = selectedChildIndex === i;
        return (
          <div
            key={i}
            onContextMenu={(e) => onChildContextMenu(e, i)}
            className={`rounded border px-2 py-1.5 ${
              selected ? 'border-accent bg-accent/10' : 'border-bg-border bg-bg-input/40'
            }`}
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                title="Highlight this child's footprint on the canvas"
                onClick={() => selectChild(selected ? null : i)}
                className={`min-w-0 flex-1 truncate text-left text-sm ${
                  childObj ? 'text-fg' : 'italic text-fg-subtle'
                }`}
              >
                {childObj ? childObj.name : 'Missing object'}
              </button>
              <button
                type="button"
                title="Remove this child"
                onClick={() => removeObjectChild(object.id, i)}
                className="shrink-0 rounded px-1 py-0.5 text-xs text-fg-subtle hover:bg-red-500/20 hover:text-red-300"
              >
                Remove
              </button>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <NumberField
                label="X"
                value={child.x}
                onCommit={(v) => setObjectChildOffset(object.id, i, v, child.y)}
              />
              <NumberField
                label="Y"
                value={child.y}
                onCommit={(v) => setObjectChildOffset(object.id, i, child.x, v)}
              />
            </div>
          </div>
        );
      })}

      {object.children.length === 0 && (
        <p className="text-xs text-fg-subtle">
          No children. Add an object to compose it under this one.
        </p>
      )}

      <select
        value=""
        disabled={candidates.length === 0}
        onChange={(e) => {
          if (e.target.value) addObjectChild(object.id, e.target.value);
        }}
        className={`w-full ${INPUT_CLASS} disabled:opacity-40`}
      >
        <option value="">
          {candidates.length === 0 ? 'No addable objects' : 'Add child…'}
        </option>
        {candidates.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// The Variants section (M13): the object's named artwork variations. Only the
// artwork differs between variants - metadata, collision, occlusion, and
// dimensions are shared. Click a variant to make it active (canvas, budgets,
// export, and play all follow the active one); rename inline; duplicate; add a
// new one by importing a same-size PNG; delete (never the last). All undoable.
function VariantsEditor({ object }: { object: AtlasObject }) {
  const addVariant = useProjectStore((s) => s.addVariant);
  const duplicateVariant = useProjectStore((s) => s.duplicateVariant);
  const switchVariant = useProjectStore((s) => s.switchVariant);
  const renameVariant = useProjectStore((s) => s.renameVariant);
  const deleteVariant = useProjectStore((s) => s.deleteVariant);
  const importing = useProjectStore((s) => s.importing);
  const renaming = useProjectStore((s) => s.renaming);
  const beginRename = useProjectStore((s) => s.beginRename);
  const endRename = useProjectStore((s) => s.endRename);
  const openContextMenu = useUiStore((s) => s.openContextMenu);

  const canDelete = object.variants.length > 1;

  const onVariantContextMenu = (e: React.MouseEvent, variantId: string, active: boolean) => {
    e.preventDefault();
    const items: MenuItem[] = [
      {
        label: 'Switch to variant',
        disabled: active,
        onClick: () => switchVariant(object.id, variantId),
      },
      {
        label: 'Rename',
        onClick: () => beginRename({ kind: 'variant', objectId: object.id, variantId }),
      },
      { label: 'Duplicate', onClick: () => void duplicateVariant(object.id, variantId) },
      { separator: true },
      {
        label: 'Delete',
        danger: true,
        disabled: !canDelete,
        onClick: () => void deleteVariant(object.id, variantId),
      },
    ];
    openContextMenu(e.clientX, e.clientY, items);
  };

  return (
    <div className="mt-1 space-y-1.5">
      {object.variants.map((variant) => {
        const active = variant.id === object.active_variant;
        const renameActive =
          renaming?.kind === 'variant' &&
          renaming.objectId === object.id &&
          renaming.variantId === variant.id;
        return (
          <div
            key={variant.id}
            onContextMenu={(e) => onVariantContextMenu(e, variant.id, active)}
            className={`flex items-center gap-1 rounded border px-2 py-1 ${
              active ? 'border-accent bg-accent/10' : 'border-bg-border bg-bg-input/40'
            }`}
          >
            <button
              type="button"
              title={active ? 'Active variant' : 'Switch to this variant'}
              onClick={() => switchVariant(object.id, variant.id)}
              className="shrink-0 text-xs"
            >
              <span className={active ? 'text-accent' : 'text-fg-subtle'}>
                {active ? '●' : '○'}
              </span>
            </button>
            <InlineName
              value={variant.name}
              renameActive={renameActive}
              onRenameHandled={endRename}
              onCommit={(v) => renameVariant(object.id, variant.id, v)}
            />
            <button
              type="button"
              title="Duplicate this variant"
              onClick={() => void duplicateVariant(object.id, variant.id)}
              className="shrink-0 rounded px-1 py-0.5 text-xs text-fg-subtle hover:bg-bg-raised hover:text-fg"
            >
              Dup
            </button>
            <button
              type="button"
              title={canDelete ? 'Delete this variant' : 'An object must keep at least one variant'}
              disabled={!canDelete}
              onClick={() => void deleteVariant(object.id, variant.id)}
              className="shrink-0 rounded px-1 py-0.5 text-xs text-fg-subtle hover:bg-red-500/20 hover:text-red-300 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-subtle"
            >
              Del
            </button>
          </div>
        );
      })}

      <button
        type="button"
        onClick={() => void addVariant(object.id)}
        disabled={importing}
        title="Import a same-size PNG as a new variant"
        className="w-full rounded border border-bg-border bg-bg-input px-2 py-1 text-xs text-fg-muted hover:border-accent hover:text-fg disabled:opacity-40"
      >
        {importing ? 'Importing…' : 'Add variant…'}
      </button>
    </div>
  );
}

// Inline-editable variant name: click to edit, commits on blur/Enter. When a
// context-menu "Rename" targets it (renameActive), it focuses and selects, then
// clears the rename target on commit/blur so it does not re-focus.
function InlineName({
  value,
  onCommit,
  renameActive = false,
  onRenameHandled,
}: {
  value: string;
  onCommit: (value: string) => void;
  renameActive?: boolean;
  onRenameHandled?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (renameActive) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renameActive]);

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        onCommit(draft);
        setDraft(value);
        if (renameActive) onRenameHandled?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          if (renameActive) onRenameHandled?.();
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-sm text-fg outline-none focus:border-accent focus:bg-bg-input"
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      {children}
    </div>
  );
}

const INPUT_CLASS =
  'w-full rounded border border-bg-border bg-bg-input px-2 py-1 text-sm ' +
  'text-fg outline-none focus:border-accent';

// Text input that commits on blur (Enter blurs, Escape reverts). If the store
// rejects the commit (e.g. empty rename), the draft resets to the last value.
function TextField({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        onCommit(draft);
        setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(value);
      }}
      className={`mt-1 ${INPUT_CLASS}`}
    />
  );
}

// Numeric input for one anchor coordinate. The store clamps to the artwork
// bounds and snaps to the grid; the draft then resets to the stored result.
function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <label className="flex flex-1 items-center gap-1.5">
      <span className="text-xs text-fg-subtle">{label}</span>
      <input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          // An empty field reverts: Number('') is 0, not "no input".
          const parsed = Number(draft);
          if (draft.trim() !== '' && Number.isFinite(parsed)) onCommit(parsed);
          setDraft(String(value));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(String(value));
        }}
        className={`${INPUT_CLASS} font-mono`}
      />
    </label>
  );
}

// Tag chips with per-tag remove, plus an add input (Enter commits). The store
// trims, drops empties, and dedupes; the input clears on every Enter.
function TagEditor({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  const [draft, setDraft] = useState('');

  return (
    <div className="mt-1 space-y-1.5">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded bg-bg-input px-1.5 py-0.5 text-xs text-fg"
            >
              {tag}
              <button
                type="button"
                title={`Remove tag "${tag}"`}
                onClick={() => onRemove(tag)}
                className="text-fg-subtle hover:text-red-300"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={draft}
        placeholder="Add tag, press Enter"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onAdd(draft);
            setDraft('');
          }
          if (e.key === 'Escape') setDraft('');
        }}
        className={INPUT_CLASS}
      />
    </div>
  );
}
