import { useEffect, useState } from 'react';
import { getCollisionTags, type CollisionTag } from '../lib/api';
import { useCanvasStore } from '../store/canvas';

// Canvas-toolbar controls for the collision layer (M6): a Select/Collision mode
// toggle, an always-available visibility toggle, and - in collision mode - the
// value picker (Blocked / Custom tag / Erase). The tag vocabulary comes from
// the engine module over IPC, never hardcoded here.
export function CollisionControls() {
  const paintMode = useCanvasStore((s) => s.paintMode);
  const setPaintMode = useCanvasStore((s) => s.setPaintMode);
  const collisionVisible = useCanvasStore((s) => s.collisionVisible);
  const setCollisionVisible = useCanvasStore((s) => s.setCollisionVisible);
  const paintValue = useCanvasStore((s) => s.paintValue);
  const setPaintValue = useCanvasStore((s) => s.setPaintValue);

  const [tags, setTags] = useState<CollisionTag[]>([]);
  // Remembers the chosen custom tag while another tool is active.
  const [customTag, setCustomTag] = useState('');

  useEffect(() => {
    let alive = true;
    getCollisionTags()
      .then((t) => {
        if (!alive) return;
        setTags(t);
        setCustomTag((current) => current || t[0]?.tag || '');
      })
      .catch(() => {
        /* leave the dropdown empty; the other tools still work */
      });
    return () => {
      alive = false;
    };
  }, []);

  const activeTool =
    paintValue === 'Walkable' ? 'erase' : typeof paintValue === 'object' ? 'custom' : 'blocked';
  const selectedTag = typeof paintValue === 'object' ? paintValue.Custom : customTag;

  const pickCustom = (tag: string) => {
    setCustomTag(tag);
    if (tag) setPaintValue({ Custom: tag });
  };

  return (
    <div className="flex items-center gap-1">
      <ModeButton active={paintMode === 'select'} onClick={() => setPaintMode('select')}>
        Select
      </ModeButton>
      <ModeButton active={paintMode === 'collision'} onClick={() => setPaintMode('collision')}>
        Collision
      </ModeButton>

      <button
        type="button"
        title={collisionVisible ? 'Hide collision overlay' : 'Show collision overlay'}
        onClick={() => setCollisionVisible(!collisionVisible)}
        className={`rounded px-1.5 py-0.5 ${
          collisionVisible ? 'bg-accent/20 text-accent' : 'text-fg-subtle hover:bg-bg-input hover:text-fg'
        }`}
      >
        {collisionVisible ? 'Shown' : 'Hidden'}
      </button>

      {paintMode === 'collision' && (
        <>
          <span className="mx-1 h-4 w-px bg-bg-border" />
          <ToolButton active={activeTool === 'blocked'} onClick={() => setPaintValue('Blocked')}>
            Blocked
          </ToolButton>
          <ToolButton
            active={activeTool === 'custom'}
            disabled={tags.length === 0}
            onClick={() => selectedTag && setPaintValue({ Custom: selectedTag })}
          >
            Custom
          </ToolButton>
          <select
            value={selectedTag}
            disabled={tags.length === 0}
            onChange={(e) => pickCustom(e.target.value)}
            title="Custom collision tag"
            className="rounded border border-bg-border bg-bg-input px-1 py-0.5 text-xs text-fg outline-none focus:border-accent disabled:opacity-40"
          >
            {tags.map((t) => (
              <option key={t.tag} value={t.tag}>
                {t.label}
              </option>
            ))}
          </select>
          <ToolButton active={activeTool === 'erase'} onClick={() => setPaintValue('Walkable')}>
            Erase
          </ToolButton>
        </>
      )}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 ${
        active ? 'bg-accent/20 text-accent' : 'text-fg-subtle hover:bg-bg-input hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

function ToolButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-1.5 py-0.5 disabled:opacity-40 ${
        active ? 'bg-accent/20 text-accent' : 'text-fg-subtle hover:bg-bg-input hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}
