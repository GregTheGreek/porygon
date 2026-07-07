import { useEffect, useRef, useState } from 'react';
import { CanvasEngine } from '../canvas/CanvasEngine';
import { useCanvasStore } from '../store/canvas';
import { useProjectStore } from '../store/project';

// The center region. React only mounts the Pixi world and plumbs props; all
// rendering, zoom, pan, grid, and selection live in CanvasEngine.
export function Canvas() {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<CanvasEngine | null>(null);

  const artwork = useCanvasStore((s) => s.artwork);
  const setSelected = useCanvasStore((s) => s.setSelected);
  // The selected Object's anchor drives the crosshair marker. The reference is
  // stable across unrelated store updates, so this only re-fires on real edits.
  const anchor = useProjectStore((s) =>
    s.open && s.selectedObjectId
      ? s.open.project.objects.find((o) => o.id === s.selectedObjectId)?.anchor ?? null
      : null,
  );
  const error = useProjectStore((s) => s.error);
  const importing = useProjectStore((s) => s.importing);
  const importObject = useProjectStore((s) => s.importObject);
  const hasObjects = useProjectStore((s) => (s.open?.project.objects.length ?? 0) > 0);

  const [zoom, setZoom] = useState(100);
  const [show8, setShow8] = useState(false);
  const [show16, setShow16] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);

  // Create the Pixi engine once. Init is async, so guard against unmount.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const engine = new CanvasEngine();
    let disposed = false;
    let observer: ResizeObserver | null = null;

    void engine
      .init(mount, { onZoom: setZoom, onSelectionChange: setSelected })
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
        const current = useCanvasStore.getState().artwork;
        if (current) void engine.loadArtwork(current);
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

  // Push artwork changes into the engine.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (artwork) void engine.loadArtwork(artwork);
    else engine.clearArtwork();
  }, [artwork]);

  // Push grid toggles into the engine.
  useEffect(() => {
    engineRef.current?.setGrid({ show8, show16 });
  }, [show8, show16]);

  // Push the anchor marker into the engine.
  useEffect(() => {
    engineRef.current?.setAnchor(anchor);
  }, [anchor]);

  const hasArtwork = artwork !== null;

  return (
    <div className="flex h-full min-w-0 flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-bg-border px-3">
        <span className="text-xs font-medium uppercase tracking-wide text-fg-muted">
          Canvas
        </span>
        <div className="flex items-center gap-1 text-xs">
          <GridToggle label="8" title="Toggle 8px tile grid" active={show8} onClick={() => setShow8((v) => !v)} />
          <GridToggle label="16" title="Toggle 16px metatile grid" active={show16} onClick={() => setShow16((v) => !v)} />
          <span className="mx-1 h-4 w-px bg-bg-border" />
          <CanvasButton disabled={!hasArtwork} onClick={() => engineRef.current?.zoomStep(1 / 1.5)}>
            −
          </CanvasButton>
          <CanvasButton disabled={!hasArtwork} onClick={() => engineRef.current?.zoomStep(1.5)}>
            +
          </CanvasButton>
          <CanvasButton disabled={!hasArtwork} onClick={() => engineRef.current?.fit()}>
            Fit
          </CanvasButton>
          <CanvasButton disabled={!hasArtwork} onClick={() => engineRef.current?.reset100()}>
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

        {(engineError ?? error) && (
          <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
            {engineError ?? error}
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
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
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
