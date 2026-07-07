import { useState } from 'react';
import { Panel } from './Panel';
import { Canvas } from './Canvas';
import { Inspector } from './Inspector';
import { ObjectLibrary } from './ObjectLibrary';
import { TilesetLibrary } from './TilesetLibrary';
import { TilesetBuilder } from './TilesetBuilder';
import { ResizeHandle } from './ResizeHandle';
import { useProjectStore } from '../store/project';

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// The bible's four permanent regions (minus the Toolbar, which is app-global):
//   Object Library / Tilesets | Canvas or Tileset Builder | Inspector
//   Runtime | Problems | Export           (bottom, whole row resizable)
// The left column stacks the Object Library (authoring) over the Tilesets list
// (compiling); selecting a tileset swaps the centre from the Canvas to the
// Tileset Builder, keeping the four regions coherent.
export function Workspace() {
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(300);
  const [bottomHeight, setBottomHeight] = useState(200);
  const [tilesetsHeight, setTilesetsHeight] = useState(200);

  const selectedTilesetId = useProjectStore((s) => s.selectedTilesetId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <div style={{ width: leftWidth }} className="flex shrink-0 flex-col">
          <Panel title="Object Library" className="min-h-0 flex-1">
            <ObjectLibrary />
          </Panel>
          <ResizeHandle
            orientation="horizontal"
            onDelta={(d) => setTilesetsHeight((h) => clamp(h - d, 100, 500))}
          />
          <div style={{ height: tilesetsHeight }} className="shrink-0">
            <Panel title="Tilesets" className="h-full border-t border-bg-border">
              <TilesetLibrary />
            </Panel>
          </div>
        </div>
        <ResizeHandle
          orientation="vertical"
          onDelta={(d) => setLeftWidth((w) => clamp(w + d, 180, 480))}
        />

        <div className="min-w-0 flex-1">
          {selectedTilesetId ? <TilesetBuilder /> : <Canvas />}
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
