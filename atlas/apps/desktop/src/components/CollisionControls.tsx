import { useEffect, useState } from 'react';
import { getCollisionTags, type CollisionTag } from '../lib/api';
import { useCanvasStore } from '../store/canvas';
import { ToolbarButton } from './ToolbarButton';

// The collision value picker (Blocked / Custom tag / Erase), shown when the
// Collision paint mode is active. The mode toggle and overlay visibility live in
// LayerControls; this component owns only the collision-specific tools. The tag
// vocabulary comes from the engine module over IPC, never hardcoded here.
export function CollisionControls() {
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
    <>
      <span className="mx-1 h-4 w-px bg-bg-border" />
      <ToolbarButton active={activeTool === 'blocked'} onClick={() => setPaintValue('Blocked')}>
        Blocked
      </ToolbarButton>
      <ToolbarButton
        active={activeTool === 'custom'}
        disabled={tags.length === 0}
        onClick={() => selectedTag && setPaintValue({ Custom: selectedTag })}
      >
        Custom
      </ToolbarButton>
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
      <ToolbarButton active={activeTool === 'erase'} onClick={() => setPaintValue('Walkable')}>
        Erase
      </ToolbarButton>
    </>
  );
}
