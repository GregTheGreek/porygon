import { useEffect, useRef, useState } from 'react';
import { CanvasEngine } from '../canvas/CanvasEngine';
import { useCanvasStore } from '../store/canvas';
import { useProjectStore } from '../store/project';
import { LayerControls } from './LayerControls';
import type { CollisionValue } from '../lib/api';

// Stable empty map/array for selections with no painted collision/occlusion, so
// the selectors below never return a fresh reference and loop renders.
const NO_CELLS: Record<string, CollisionValue> = {};
const NO_PIXELS: number[] = [];

// The center region. React only mounts the Pixi world and plumbs props; all
// rendering, zoom, pan, grid, and selection live in CanvasEngine.
export function Canvas() {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CanvasEngine | null>(null);

  const artwork = useCanvasStore((s) => s.artwork);
  const setSelected = useCanvasStore((s) => s.setSelected);
  // The selected Object's anchor drives the crosshair marker. The reference is
  // stable across unrelated store updates, so this only re-fires on real edits.
  const ownAnchor = useProjectStore((s) =>
    s.open && s.selectedObjectId
      ? s.open.project.objects.find((o) => o.id === s.selectedObjectId)?.anchor ?? null
      : null,
  );
  // The selected Object itself (stable reference until patched): its own
  // footprint bounds the brushes when the composed view is shown (M12).
  const selectedObject = useProjectStore((s) =>
    s.open && s.selectedObjectId
      ? s.open.project.objects.find((o) => o.id === s.selectedObjectId) ?? null
      : null,
  );
  // The composed view (M12): non-null when the selected object has children.
  // Its collision/occlusion/anchor supersede the object's own on the canvas,
  // so overlays and play mode operate on the flattened result.
  const composed = useProjectStore((s) => s.composed);
  const composeError = useProjectStore((s) => s.composeError);
  const selectedChildIndex = useProjectStore((s) => s.selectedChildIndex);
  const refreshComposed = useProjectStore((s) => s.refreshComposed);
  const selectedObjectId = useProjectStore((s) => s.selectedObjectId);
  // Any object edit (paint, child add/remove/nudge, anchor, undo/redo) can
  // change the composition, so the objects array reference drives refresh.
  const objects = useProjectStore((s) => s.open?.project.objects ?? null);
  const error = useProjectStore((s) => s.error);
  const importing = useProjectStore((s) => s.importing);
  const importObject = useProjectStore((s) => s.importObject);
  const hasObjects = useProjectStore((s) => (s.open?.project.objects.length ?? 0) > 0);

  // The selected Object's collision cells drive the overlay. The reference is
  // stable until the object is edited, so this only re-fires on real changes.
  const ownCollisionCells = useProjectStore((s) =>
    s.open && s.selectedObjectId
      ? s.open.project.objects.find((o) => o.id === s.selectedObjectId)?.collision.cells ??
        NO_CELLS
      : NO_CELLS,
  );
  // The selected Object's occlusion pixels drive the occlusion overlay. Stable
  // until edited, like the collision selector above.
  const ownOcclusionPixels = useProjectStore((s) =>
    s.open && s.selectedObjectId
      ? s.open.project.objects.find((o) => o.id === s.selectedObjectId)?.occlusion.pixels ??
        NO_PIXELS
      : NO_PIXELS,
  );
  // Effective canvas data: composed when children are shown, own otherwise.
  const collisionCells = composed ? composed.collision.cells : ownCollisionCells;
  const occlusionPixels = composed ? composed.occlusion.pixels : ownOcclusionPixels;
  const anchor = composed ? composed.anchor : ownAnchor;
  const paintMode = useCanvasStore((s) => s.paintMode);
  const setPaintMode = useCanvasStore((s) => s.setPaintMode);
  const collisionVisible = useCanvasStore((s) => s.collisionVisible);
  const paintValue = useCanvasStore((s) => s.paintValue);
  const occlusionVisible = useCanvasStore((s) => s.occlusionVisible);
  const occlusionErase = useCanvasStore((s) => s.occlusionErase);
  const occlusionBrushSize = useCanvasStore((s) => s.occlusionBrushSize);
  const previewEnabled = useCanvasStore((s) => s.previewEnabled);

  // Grid visibility lives in the canvas store (M14) so shortcuts, the command
  // palette, and the default-grid preference can drive it too.
  const show8 = useCanvasStore((s) => s.grid8);
  const show16 = useCanvasStore((s) => s.grid16);
  const toggleGrid8 = useCanvasStore((s) => s.toggleGrid8);
  const toggleGrid16 = useCanvasStore((s) => s.toggleGrid16);

  const [zoom, setZoom] = useState(100);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Create the Pixi engine once. Init is async, so guard against unmount.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const engine = new CanvasEngine();
    let disposed = false;
    let observer: ResizeObserver | null = null;

    void engine
      .init(mount, {
        onZoom: setZoom,
        onSelectionChange: setSelected,
        // Read the live selection/action from the store so this stays correct
        // regardless of what was selected when the engine mounted.
        onCollisionStroke: (indices, value) => {
          const store = useProjectStore.getState();
          if (store.selectedObjectId) {
            store.paintCollision(store.selectedObjectId, indices, value);
          }
        },
        onOcclusionStroke: (indices, occluding) => {
          const store = useProjectStore.getState();
          if (store.selectedObjectId) {
            store.paintOcclusion(store.selectedObjectId, indices, occluding);
          }
        },
      })
      .then(() => {
        if (disposed) {
          engine.destroy();
          return;
        }
        engineRef.current = engine;
        observer = new ResizeObserver(() => {
          const r = mount.getBoundingClientRect();
          engine.resize(r.width, r.height);
        });
        observer.observe(mount);
        // Apply current UI state / restore artwork on remount.
        engine.setGrid({ show8, show16 });
        engine.setAnchor(anchor);
        const canvas = useCanvasStore.getState();
        engine.setPaintMode(canvas.paintMode);
        engine.setCollisionVisible(canvas.collisionVisible);
        engine.setActiveCollisionValue(canvas.paintValue);
        engine.setOcclusionVisible(canvas.occlusionVisible);
        engine.setOcclusionErase(canvas.occlusionErase);
        engine.setOcclusionBrushSize(canvas.occlusionBrushSize);
        engine.setPreview(canvas.previewEnabled);
        const project = useProjectStore.getState();
        const selected =
          project.open && project.selectedObjectId
            ? project.open.project.objects.find((o) => o.id === project.selectedObjectId)
            : undefined;
        // Composed data supersedes the object's own when children are shown.
        const comp = project.composed;
        engine.setCollision(comp?.collision.cells ?? selected?.collision.cells ?? NO_CELLS);
        engine.setOcclusion(comp?.occlusion.pixels ?? selected?.occlusion.pixels ?? NO_PIXELS);
        if (comp) engine.setAnchor(comp.anchor);
        engine.setPaintBounds(
          comp && selected
            ? { x: comp.origin_x, y: comp.origin_y, width: selected.width, height: selected.height }
            : null,
        );
        if (canvas.artwork) void engine.loadArtwork(canvas.artwork);
      })
      .catch((e: unknown) => {
        // A failed renderer init must be visible, not a silent blank canvas.
        console.error('Canvas engine init failed:', e);
        if (!disposed) setEngineError(`Canvas failed to initialize: ${String(e)}`);
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      engineRef.current?.destroy();
      engineRef.current = null;
    };
    // Mount-once; live state is pushed via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push artwork changes into the engine. A reload of the SAME object (a
  // recompose after a child edit, M12) preserves the view instead of
  // re-fitting; a different object still fits fresh.
  const lastArtworkObjectId = useRef<string | null>(null);
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (artwork) {
      const preserve =
        artwork.objectId !== undefined &&
        artwork.objectId === lastArtworkObjectId.current;
      lastArtworkObjectId.current = artwork.objectId ?? null;
      void engine.loadArtwork(artwork, preserve);
    } else {
      lastArtworkObjectId.current = null;
      engine.clearArtwork();
    }
  }, [artwork]);

  // Recompute the composed view whenever the project's objects or the
  // selection change (paints, child edits, anchors, undo/redo). No-op and
  // cheap when the selected object has no children.
  useEffect(() => {
    void refreshComposed();
  }, [objects, selectedObjectId, refreshComposed]);

  // Bound the brushes to the parent's own footprint while composed (M12).
  useEffect(() => {
    engineRef.current?.setPaintBounds(
      composed && selectedObject
        ? {
            x: composed.origin_x,
            y: composed.origin_y,
            width: selectedObject.width,
            height: selectedObject.height,
          }
        : null,
    );
  }, [composed, selectedObject]);

  // Highlight the selected child's footprint on the canvas (M12).
  useEffect(() => {
    const fp =
      composed && selectedChildIndex !== null
        ? composed.children[selectedChildIndex] ?? null
        : null;
    engineRef.current?.setChildHighlight(
      fp ? { x: fp.x, y: fp.y, width: fp.width, height: fp.height } : null,
    );
  }, [composed, selectedChildIndex]);

  // Play mode needs an object to play on: losing the artwork (deselect,
  // delete) drops back to Select so the store and engine stay coherent.
  useEffect(() => {
    if (!artwork && paintMode === 'play') setPaintMode('select');
  }, [artwork, paintMode, setPaintMode]);

  // Push grid toggles into the engine.
  useEffect(() => {
    engineRef.current?.setGrid({ show8, show16 });
  }, [show8, show16]);

  // Push the anchor marker into the engine.
  useEffect(() => {
    engineRef.current?.setAnchor(anchor);
  }, [anchor]);

  // Push collision state into the engine. Overlay updates immediately on paint,
  // undo/redo, selection change, and visibility/mode/value toggles.
  useEffect(() => {
    engineRef.current?.setCollision(collisionCells);
  }, [collisionCells]);
  useEffect(() => {
    engineRef.current?.setPaintMode(paintMode);
  }, [paintMode]);
  useEffect(() => {
    engineRef.current?.setCollisionVisible(collisionVisible);
  }, [collisionVisible]);
  useEffect(() => {
    engineRef.current?.setActiveCollisionValue(paintValue);
  }, [paintValue]);

  // Push occlusion + preview state into the engine, mirroring the collision
  // plumbing above. Overlay updates immediately on paint, undo/redo, selection
  // change, and every toggle.
  useEffect(() => {
    engineRef.current?.setOcclusion(occlusionPixels);
  }, [occlusionPixels]);
  useEffect(() => {
    engineRef.current?.setOcclusionVisible(occlusionVisible);
  }, [occlusionVisible]);
  useEffect(() => {
    engineRef.current?.setOcclusionErase(occlusionErase);
  }, [occlusionErase]);
  useEffect(() => {
    engineRef.current?.setOcclusionBrushSize(occlusionBrushSize);
  }, [occlusionBrushSize]);
  useEffect(() => {
    engineRef.current?.setPreview(previewEnabled);
  }, [previewEnabled]);

  const hasArtwork = artwork !== null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-bg-border px-3">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium uppercase tracking-wide text-fg-muted">
            Canvas
          </span>
          {hasArtwork && (
            <LayerControls onResetPlay={() => engineRef.current?.resetPlayer()} />
          )}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <GridToggle label="8" title="Toggle 8px tile grid (Shift+G)" active={show8} onClick={toggleGrid8} />
          <GridToggle label="16" title="Toggle 16px metatile grid (G)" active={show16} onClick={toggleGrid16} />
          <span className="mx-1 h-4 w-px bg-bg-border" />
          <CanvasButton title="Zoom out (Cmd/Ctrl+-)" disabled={!hasArtwork} onClick={() => engineRef.current?.zoomStep(1 / 1.5)}>
            −
          </CanvasButton>
          <CanvasButton title="Zoom in (Cmd/Ctrl+=)" disabled={!hasArtwork} onClick={() => engineRef.current?.zoomStep(1.5)}>
            +
          </CanvasButton>
          <CanvasButton title="Fit to view (Cmd/Ctrl+0)" disabled={!hasArtwork} onClick={() => engineRef.current?.fit()}>
            Fit
          </CanvasButton>
          <CanvasButton title="Actual size 100% (Cmd/Ctrl+1)" disabled={!hasArtwork} onClick={() => engineRef.current?.reset100()}>
            100%
          </CanvasButton>
          <span className="w-12 text-right font-mono text-fg-subtle">
            {hasArtwork ? `${zoom}%` : '-'}
          </span>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div ref={mountRef} className="absolute inset-0" />

        {!hasArtwork && hasObjects && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-fg-subtle">
              Select an object in the library to view it.
            </p>
          </div>
        )}

        {!hasArtwork && !hasObjects && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
            <p className="text-sm text-fg-subtle">Import artwork to begin.</p>
            <button
              type="button"
              onClick={() => void importObject()}
              disabled={importing}
              className="pointer-events-auto rounded bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {importing ? 'Importing…' : 'Import PNG'}
            </button>
          </div>
        )}

        {(engineError ?? composeError ?? error) && (
          <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
            {engineError ?? composeError ?? error}
          </p>
        )}
      </div>
    </div>
  );
}

function CanvasButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-bg-input hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function GridToggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 font-mono ${
        active ? 'bg-accent/20 text-accent' : 'text-fg-subtle hover:bg-bg-input hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}
