import { useCanvasStore } from '../store/canvas';
import { CollisionControls } from './CollisionControls';
import { OcclusionControls } from './OcclusionControls';
import { ToolbarButton } from './ToolbarButton';

// Canvas-toolbar controls for the paint layers. The three-way mode toggle
// (Select / Collision / Occlusion) picks what left-drag paints; the two overlay
// visibility toggles and the preview toggle are always available and independent
// of the mode and of each other. The active mode's tools render inline after.
export function LayerControls() {
  const paintMode = useCanvasStore((s) => s.paintMode);
  const setPaintMode = useCanvasStore((s) => s.setPaintMode);
  const collisionVisible = useCanvasStore((s) => s.collisionVisible);
  const setCollisionVisible = useCanvasStore((s) => s.setCollisionVisible);
  const occlusionVisible = useCanvasStore((s) => s.occlusionVisible);
  const setOcclusionVisible = useCanvasStore((s) => s.setOcclusionVisible);
  const previewEnabled = useCanvasStore((s) => s.previewEnabled);
  const setPreviewEnabled = useCanvasStore((s) => s.setPreviewEnabled);

  return (
    <div className="flex items-center gap-1">
      <ToolbarButton active={paintMode === 'select'} onClick={() => setPaintMode('select')}>
        Select
      </ToolbarButton>
      <ToolbarButton active={paintMode === 'collision'} onClick={() => setPaintMode('collision')}>
        Collision
      </ToolbarButton>
      <ToolbarButton active={paintMode === 'occlusion'} onClick={() => setPaintMode('occlusion')}>
        Occlusion
      </ToolbarButton>

      <span className="mx-1 h-4 w-px bg-bg-border" />
      <span className="text-xs uppercase tracking-wide text-fg-muted">Overlays</span>
      <ToolbarButton
        active={collisionVisible}
        title={collisionVisible ? 'Hide collision overlay' : 'Show collision overlay'}
        onClick={() => setCollisionVisible(!collisionVisible)}
      >
        Collision
      </ToolbarButton>
      <ToolbarButton
        active={occlusionVisible}
        title={occlusionVisible ? 'Hide occlusion overlay' : 'Show occlusion overlay'}
        onClick={() => setOcclusionVisible(!occlusionVisible)}
      >
        Occlusion
      </ToolbarButton>
      <ToolbarButton
        active={previewEnabled}
        title="Preview a player behind/in front of the occluding pixels"
        onClick={() => setPreviewEnabled(!previewEnabled)}
      >
        Preview
      </ToolbarButton>

      {paintMode === 'collision' && <CollisionControls />}
      {paintMode === 'occlusion' && <OcclusionControls />}
    </div>
  );
}
