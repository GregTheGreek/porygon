import { useCanvasStore, BACKDROP_COLOR_PRESETS } from '../store/canvas';
import { useProjectStore } from '../store/project';
import { ToolbarButton } from './ToolbarButton';

// The canvas preview-backdrop picker (P2.1), shown in the LayerControls row when
// artwork is on the canvas. None / Checker / Color / Object choose what renders
// behind the selected object so the artist can judge how it reads on different
// ground. The choice is a canvas-view setting that survives selection changes
// (see store/canvas.ts); it never touches Object or Tileset data.
export function BackdropControls() {
  const backdrop = useCanvasStore((s) => s.backdrop);
  const setKind = useCanvasStore((s) => s.setBackdropKind);
  const setColor = useCanvasStore((s) => s.setBackdropColor);
  const setObject = useCanvasStore((s) => s.setBackdropObject);
  const objects = useProjectStore((s) => s.open?.project.objects ?? []);
  const selectedId = useProjectStore((s) => s.selectedObjectId);
  // Any object except the one on the canvas: tiling an object under itself is
  // not a useful preview.
  const groundObjects = objects.filter((o) => o.id !== selectedId);

  return (
    <>
      <span className="mx-1 h-4 w-px bg-bg-border" />
      <span className="text-xs uppercase tracking-wide text-fg-muted">Backdrop</span>
      <ToolbarButton active={backdrop.kind === 'none'} title="No backdrop" onClick={() => setKind('none')}>
        None
      </ToolbarButton>
      <ToolbarButton
        active={backdrop.kind === 'checker'}
        title="Transparency-checker backdrop"
        onClick={() => setKind('checker')}
      >
        Checker
      </ToolbarButton>
      <ToolbarButton active={backdrop.kind === 'color'} title="Flat-color backdrop" onClick={() => setKind('color')}>
        Color
      </ToolbarButton>
      <ToolbarButton
        active={backdrop.kind === 'object'}
        disabled={groundObjects.length === 0}
        title="Tile another object underneath (e.g. rock on sand)"
        onClick={() => {
          setKind('object');
          // Seed a sensible default so the preview shows immediately.
          if (!backdrop.objectId && groundObjects[0]) setObject(groundObjects[0].id);
        }}
      >
        Object
      </ToolbarButton>

      {backdrop.kind === 'color' && (
        <>
          {BACKDROP_COLOR_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.label}
              onClick={() => setColor(p.color)}
              style={{ backgroundColor: p.color }}
              className={`h-4 w-4 rounded border ${
                backdrop.color.toLowerCase() === p.color.toLowerCase()
                  ? 'border-accent'
                  : 'border-bg-border'
              }`}
            />
          ))}
          <input
            type="color"
            value={backdrop.color}
            title="Custom color"
            onChange={(e) => setColor(e.target.value)}
            className="h-5 w-6 cursor-pointer rounded border border-bg-border bg-transparent p-0"
          />
        </>
      )}

      {backdrop.kind === 'object' && (
        <select
          value={backdrop.objectId ?? ''}
          onChange={(e) => setObject(e.target.value || null)}
          title="Object to tile underneath"
          className="rounded border border-bg-border bg-bg-input px-1 py-0.5 text-xs text-fg outline-none focus:border-accent"
        >
          {groundObjects.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
    </>
  );
}
