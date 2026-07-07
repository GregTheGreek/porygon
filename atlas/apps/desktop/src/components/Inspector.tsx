import { useEffect, useState } from 'react';
import { useProjectStore } from '../store/project';

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

      {/* Tier 1 problems moved to the bottom Problems panel (M11), which
          unifies all three validity tiers in one place. */}
    </div>
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
