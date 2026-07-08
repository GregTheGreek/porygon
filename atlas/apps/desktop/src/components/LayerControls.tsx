import { useCanvasStore } from '../store/canvas';
import { BackdropControls } from './BackdropControls';
import { CollisionControls } from './CollisionControls';
import { OcclusionControls } from './OcclusionControls';
import { PlayControls } from './PlayControls';
import { ToolbarButton } from './ToolbarButton';

// Canvas-toolbar controls for the paint layers and the runtime preview. The
// four-way mode toggle (Select / Collision / Occlusion / Play) picks what the
// Canvas does; the two overlay visibility toggles and the preview toggle are
// always available and independent of the mode and of each other. The active
// mode's tools render inline after. `onResetPlay` reaches the Canvas engine
// (play state is ephemeral, not store state).
export function LayerControls({ onResetPlay }: { onResetPlay: () => void }) {
  const paintMode = useCanvasStore((s) => s.paintMode);
  const setPaintMode = useCanvasStore((s) => s.setPaintMode);
  const collisionVisible = useCanvasStore((s) => s.collisionVisible);
  const setCollisionVisible = useCanvasStore((s) => s.setCollisionVisible);
  const occlusionVisible = useCanvasStore((s) => s.occlusionVisible);
  const setOcclusionVisible = useCanvasStore((s) => s.setOcclusionVisible);
  const previewEnabled = useCanvasStore((s) => s.previewEnabled);
  const setPreviewEnabled = useCanvasStore((s) => s.setPreviewEnabled);

  return (
    // shrink-0 so buttons keep their natural width and the parent bar scrolls
    // rather than squishing the cluster.
    <div className="flex shrink-0 items-center gap-1 [&>*]:shrink-0">
      <ToolbarButton active={paintMode === 'select'} onClick={() => setPaintMode('select')}>
        Select
      </ToolbarButton>
      <ToolbarButton active={paintMode === 'collision'} onClick={() => setPaintMode('collision')}>
        Collision
      </ToolbarButton>
      <ToolbarButton active={paintMode === 'occlusion'} onClick={() => setPaintMode('occlusion')}>
        Occlusion
      </ToolbarButton>
      <ToolbarButton
        active={paintMode === 'play'}
        title="Walk a player on the object's grid (arrows / WASD)"
        onClick={() => setPaintMode('play')}
      >
        Play
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

      <BackdropControls />

      {paintMode === 'collision' && <CollisionControls />}
      {paintMode === 'occlusion' && <OcclusionControls />}
      {paintMode === 'play' && <PlayControls onReset={onResetPlay} />}
    </div>
  );
}
