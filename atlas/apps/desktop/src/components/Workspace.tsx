import { useState } from 'react';
import { Panel } from './Panel';
import { Canvas } from './Canvas';
import { ResizeHandle } from './ResizeHandle';
import { useCanvasStore } from '../store/canvas';

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// The bible's four permanent regions (minus the Toolbar, which is app-global):
//   Object Library | Canvas | Inspector   (middle, side panels resizable)
//   Runtime | Problems | Export           (bottom, whole row resizable)
export function Workspace() {
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(300);
  const [bottomHeight, setBottomHeight] = useState(200);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <div style={{ width: leftWidth }} className="shrink-0">
          <Panel title="Object Library" className="h-full">
            No objects yet. Import artwork to create one.
          </Panel>
        </div>
        <ResizeHandle
          orientation="vertical"
          onDelta={(d) => setLeftWidth((w) => clamp(w + d, 180, 480))}
        />

        <div className="min-w-0 flex-1">
          <Canvas />
        </div>

        <ResizeHandle
          orientation="vertical"
          onDelta={(d) => setRightWidth((w) => clamp(w - d, 220, 520))}
        />
        <div style={{ width: rightWidth }} className="shrink-0">
          <Panel title="Inspector" className="h-full">
            <Inspector />
          </Panel>
        </div>
      </div>

      <ResizeHandle
        orientation="horizontal"
        onDelta={(d) => setBottomHeight((h) => clamp(h - d, 120, 480))}
      />

      <div
        style={{ height: bottomHeight }}
        className="flex shrink-0 border-t border-bg-border"
      >
        <Panel title="Runtime" className="flex-1 border-r border-bg-border">
          Runtime preview will appear here.
        </Panel>
        <Panel title="Problems" className="flex-1 border-r border-bg-border">
          No problems detected.
        </Panel>
        <Panel title="Export" className="flex-1">
          No export target configured.
        </Panel>
      </div>
    </div>
  );
}

// M3 placeholder Inspector: when the imported artwork is selected on the
// Canvas, show its filename and dimensions. Real Objects arrive in M4.
function Inspector() {
  const artwork = useCanvasStore((s) => s.artwork);
  const selected = useCanvasStore((s) => s.selected);

  if (!artwork || !selected) {
    return <>No selection. Select artwork on the canvas to inspect it.</>;
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Artwork</div>
        <div className="mt-1 truncate text-sm text-fg" title={artwork.name}>
          {artwork.name}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-fg-muted">Dimensions</div>
        <div className="mt-1 font-mono text-sm text-fg">
          {artwork.width} × {artwork.height} px
        </div>
      </div>
    </div>
  );
}
