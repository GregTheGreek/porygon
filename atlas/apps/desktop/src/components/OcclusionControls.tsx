import { OCCLUSION_BRUSH_SIZES, useCanvasStore } from '../store/canvas';
import { ToolbarButton } from './ToolbarButton';

// The occlusion tools (Paint / Erase and brush size), shown when the Occlusion
// paint mode is active. Occlusion is pixel-level, so the brush is a square of N
// artwork pixels; a 1px brush is precise, larger sizes cover canopies quickly.
export function OcclusionControls() {
  const occlusionErase = useCanvasStore((s) => s.occlusionErase);
  const setOcclusionErase = useCanvasStore((s) => s.setOcclusionErase);
  const brush = useCanvasStore((s) => s.occlusionBrushSize);
  const setBrush = useCanvasStore((s) => s.setOcclusionBrushSize);

  return (
    <>
      <span className="mx-1 h-4 w-px bg-bg-border" />
      <ToolbarButton
        active={!occlusionErase}
        title="Paint occluding pixels (player renders behind)"
        onClick={() => setOcclusionErase(false)}
      >
        Paint
      </ToolbarButton>
      <ToolbarButton
        active={occlusionErase}
        title="Erase occluding pixels"
        onClick={() => setOcclusionErase(true)}
      >
        Erase
      </ToolbarButton>
      <span className="ml-1 text-xs text-fg-subtle">Brush</span>
      {OCCLUSION_BRUSH_SIZES.map((size) => (
        <ToolbarButton key={size} active={brush === size} onClick={() => setBrush(size)}>
          {size}px
        </ToolbarButton>
      ))}
    </>
  );
}
