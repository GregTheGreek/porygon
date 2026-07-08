// Pixi's WebGL renderer generates shader/uniform code with `new Function`,
// which our strict CSP (no unsafe-eval) blocks. This official module swaps in
// a CSP-safe implementation; it must load before the renderer is created.
import 'pixi.js/unsafe-eval';
import {
  Application,
  Container,
  Graphics,
  Sprite,
  Texture,
  TilingSprite,
} from 'pixi.js';
import { drawGrid, type GridConfig } from './grid';
import {
  findSpawn,
  resolveStep,
  type Cell,
  type Direction,
} from './playSim';
import type { CollisionValue } from '../lib/api';

export type PaintMode = 'select' | 'collision' | 'occlusion' | 'play';

export type CanvasCallbacks = {
  /** Current zoom as a percentage (100 = 1:1). */
  onZoom: (percent: number) => void;
  /** Whether the artwork is currently selected. */
  onSelectionChange: (selected: boolean) => void;
  /**
   * A collision brush stroke finished. `indices` are the row-major cell indices
   * whose value actually changed; `value` is what to apply ('Walkable' erases).
   * React turns this into one undoable store mutation.
   */
  onCollisionStroke: (indices: number[], value: CollisionValue) => void;
  /**
   * An occlusion brush stroke finished. `indices` are the row-major *pixel*
   * indices whose state actually changed; `occluding` is true when the stroke
   * added occlusion and false when it erased. React turns this into one undoable
   * store mutation (mirrors onCollisionStroke).
   */
  onOcclusionStroke: (indices: number[], occluding: boolean) => void;
};

export type ArtworkInput = {
  name: string;
  width: number;
  height: number;
  url: string;
};

// The preview backdrop rendered behind the artwork (P2.1). 'checker' is the
// transparency checker; 'color' is a flat fill; 'object' tiles another object's
// artwork (passed as a decoded PNG data URL). Preview-only: never exported.
export type BackdropSpec =
  | { kind: 'none' }
  | { kind: 'checker' }
  | { kind: 'color'; color: number }
  | { kind: 'object'; url: string };

const MIN_SCALE = 0.25;
const MAX_SCALE = 32;
const FIT_PADDING = 0.9;
// exp(-deltaY * SENSITIVITY): ~1.2x per typical mouse-wheel notch (deltaY 100).
const ZOOM_SENSITIVITY = 0.0018;
// Per press/click of the keyboard shortcuts and +/- buttons.
const KEY_ZOOM_STEP = 1.5;

// WebKit's proprietary pinch event (Safari/WKWebView only; not in lib.dom).
type WebKitGestureEvent = Event & { scale: number; clientX: number; clientY: number };
// Pointer travel (px) under which a press counts as a click, not a drag.
const CLICK_SLOP = 4;

const CHECKER_A = 0x26262a;
const CHECKER_B = 0x202024;
const SELECTION_COLOR = 0x7c5cff;
const ANCHOR_COLOR = 0xffb020;
// Child-footprint highlight (M12): green, distinct from every other overlay
// hue (selection purple, anchor orange, collision red/teal, occlusion pink).
const CHILD_HIGHLIGHT_COLOR = 0x35d07f;
// Crosshair arm length in screen pixels (zoom-independent).
const ANCHOR_ARM = 7;

// Collision overlay: one metatile cell = 16px, and the tint colors per value.
const COLLISION_CELL = 16;
const COLLISION_ALPHA = 0.4;
const BLOCKED_COLOR = 0xff3b30; // red: cannot walk here
const CUSTOM_COLOR = 0x00b8d4; // teal: a semantic tag (tall grass, water, ...)

// Occlusion overlay: a per-pixel tint distinct from every other overlay hue
// (collision red/teal, selection purple, anchor orange) so the two paint layers
// never read as the same thing. Magenta/pink = "renders above the player".
const OCCLUSION_TINT: [number, number, number] = [0xff, 0x3e, 0xa5];
const OCCLUSION_TINT_ALPHA = 150; // 0-255, applied per pixel in the tint canvas
// Preview player marker: 16x32 (one metatile wide, two tall) matching Emerald's
// overworld sprite footprint, standing on the 16x16 cell under the cursor.
const PLAYER_W = 16;
const PLAYER_H = 32;
const PLAYER_FILL = 0x3d7bff;
const PLAYER_ALPHA = 0.85;

// Play mode (M8): movement pacing. Chosen approximations tuned to feel like
// Emerald's walking pace, not measured GBA frame counts.
const WALK_MS = 250; // one 16px step
const HOP_MS = 500; // a two-cell ledge hop
const TURN_MS = 110; // a tap shorter than this turns in place without stepping
const HOP_ARC_PX = 6; // peak lift of the hop arc (visual flourish, not physics)

// Play-mode player sprite palette (programmatic, no asset files).
const PLAYER_HAIR = 0x5a3a20;
const PLAYER_SKIN = 0xf2c9a1;
const PLAYER_EYE = 0x202020;
const PLAYER_SHIRT = 0xc23b2e;
const PLAYER_PANTS = 0x2f4f8f;
const PLAYER_SHOE = 0x262626;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// Decode an already-loaded image into raw RGBA pixels via an offscreen 2D
// canvas, so the occlusion preview can read the artwork's real pixels.
function readImagePixels(img: HTMLImageElement, width: number, height: number): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}

// Whether two collision values are equal (handles the Custom tag object).
function collisionValueEq(
  a: CollisionValue | undefined,
  b: CollisionValue,
): boolean {
  if (typeof a === 'object' && typeof b === 'object') return a.Custom === b.Custom;
  return a === b;
}

// Play-mode movement keys: arrows by key, WASD by physical position (e.code)
// so non-QWERTY layouts keep the WASD cluster.
function keyToDirection(e: KeyboardEvent): Direction | null {
  switch (e.key) {
    case 'ArrowUp':
      return 'north';
    case 'ArrowDown':
      return 'south';
    case 'ArrowLeft':
      return 'west';
    case 'ArrowRight':
      return 'east';
  }
  switch (e.code) {
    case 'KeyW':
      return 'north';
    case 'KeyS':
      return 'south';
    case 'KeyA':
      return 'west';
    case 'KeyD':
      return 'east';
  }
  return null;
}

// A programmatic 16x32 stand-in for Emerald's overworld player, built from
// rects at (x, y) in artwork pixels: feet fill the bottom 16x16 cell, torso and
// head rise one cell above it, with a little transparent headroom like the GBA
// sprites. Facing shows in the face: eyes track east/west/south; north shows
// the back of the head.
function drawPlayerSprite(g: Graphics, x: number, y: number, facing: Direction): void {
  // Hair.
  g.rect(x + 3, y + 5, 10, 4).fill(PLAYER_HAIR);
  g.rect(x + 2, y + 7, 12, 3).fill(PLAYER_HAIR);
  // Face.
  g.rect(x + 4, y + 9, 8, 5).fill(PLAYER_SKIN);
  if (facing === 'north') {
    g.rect(x + 4, y + 9, 8, 4).fill(PLAYER_HAIR);
  } else if (facing === 'south') {
    g.rect(x + 5, y + 10, 2, 2).fill(PLAYER_EYE);
    g.rect(x + 9, y + 10, 2, 2).fill(PLAYER_EYE);
  } else if (facing === 'west') {
    g.rect(x + 4, y + 10, 2, 2).fill(PLAYER_EYE);
  } else {
    g.rect(x + 10, y + 10, 2, 2).fill(PLAYER_EYE);
  }
  // Torso and arms (hands in skin).
  g.rect(x + 3, y + 14, 10, 8).fill(PLAYER_SHIRT);
  g.rect(x + 1, y + 15, 2, 6).fill(PLAYER_SHIRT);
  g.rect(x + 13, y + 15, 2, 6).fill(PLAYER_SHIRT);
  g.rect(x + 1, y + 21, 2, 2).fill(PLAYER_SKIN);
  g.rect(x + 13, y + 21, 2, 2).fill(PLAYER_SKIN);
  // Legs and shoes.
  g.rect(x + 4, y + 22, 3, 7).fill(PLAYER_PANTS);
  g.rect(x + 9, y + 22, 3, 7).fill(PLAYER_PANTS);
  g.rect(x + 3, y + 29, 4, 3).fill(PLAYER_SHOE);
  g.rect(x + 9, y + 29, 4, 3).fill(PLAYER_SHOE);
}

/**
 * The PixiJS world for the Canvas. React owns only mounting and prop plumbing;
 * all rendering, zoom, pan, grid, and selection live here.
 *
 * Layout of the scene:
 *   stage
 *     background      - checkerboard, screen space, never scaled
 *     world           - carries pan (position) + zoom (scale)
 *       sprite        - the artwork (child 0, below everything)
 *       occlusionTint - per-pixel occlusion tint (authoring aid)
 *       previewPlayer - the player layer: M7's cursor marker, or the play-mode
 *                       player sprite (M8), always below the top layer
 *       previewTop    - real occluding artwork pixels, drawn over the player
 *     collisionLayer  - collision tint per 16px cell, screen space
 *     gridLayer       - grid lines, redrawn in screen space (crisp 1px)
 *     overlay         - selection outline + anchor crosshair, screen space
 *
 * The occlusion and preview layers live inside `world` (not screen space like
 * collision) so they track pan/zoom automatically and align to artwork pixels;
 * they are rebuilt only when the mask, preview state, or cursor cell changes,
 * never per pan/zoom. Their z-order in `world` is the whole point of the
 * preview: player between the below-player artwork and the above-player pixels.
 */
export class CanvasEngine {
  private app!: Application;
  private world!: Container;
  private background!: TilingSprite;
  private collisionLayer!: Graphics;
  private gridLayer!: Graphics;
  private overlay!: Graphics;

  // Preview backdrop (P2.1): a world-space layer BEHIND the artwork sprite,
  // tiled to fill the artwork bounds so it tracks pan/zoom and aligns to the
  // object. Rebuilt on spec change and on artwork (re)load.
  private backdropLayer!: Container;
  private backdropSpec: BackdropSpec = { kind: 'none' };
  // Textures we own and must destroy on rebuild/teardown.
  private backdropObjectTexture: Texture | null = null;
  private backdropCheckerTexture: Texture | null = null;
  // Guards the async 'object' decode against a newer setBackdrop call.
  private backdropSeq = 0;

  // World-space occlusion + preview layers (created once in init).
  private occlusionTint!: Sprite;
  private previewPlayer!: Graphics;
  private previewTop!: Sprite;
  // Textures we own and must destroy on rebuild (Sprite defaults to EMPTY).
  private occlusionTintTexture: Texture | null = null;
  private previewTopTexture: Texture | null = null;

  private sprite: Sprite | null = null;
  private artW = 0;
  private artH = 0;
  // The decoded artwork's pixels, kept so the preview can rebuild the real
  // above-player ("top layer") image from the mask. Null until artwork loads.
  private artworkPixels: ImageData | null = null;

  private grid: GridConfig = { show8: false, show16: false };
  private selected = false;
  // The selected Object's anchor in artwork pixels; null hides the marker.
  private anchor: { x: number; y: number } | null = null;
  // A highlighted child footprint in artwork pixels (M12); null hides it.
  private childHighlight: { x: number; y: number; width: number; height: number } | null = null;
  // Paintable region in artwork pixels (M12): when the composed view is
  // shown, brushes may only touch the parent's own footprint - painted data
  // lives on the parent, never on a child through the parent's canvas.
  // Null means the whole artwork is paintable.
  private paintBounds: { x: number; y: number; width: number; height: number } | null = null;

  // Collision state. `collisionCells` is the engine's render copy of the sparse
  // grid (row-major index -> value); React pushes it via setCollision and it is
  // mutated locally during a stroke for immediate feedback.
  private collisionCells = new Map<number, CollisionValue>();
  private collisionVisible = true;
  private paintMode: PaintMode = 'select';
  private paintValue: CollisionValue = 'Blocked';

  // Occlusion state. `occlusionPixels` is the engine's render copy of the sparse
  // pixel set (row-major index); React pushes it via setOcclusion and it is
  // mutated locally during a stroke for immediate feedback.
  private occlusionPixels = new Set<number>();
  private occlusionVisible = true;
  private occlusionErase = false;
  private occlusionBrushSize = 4;
  private previewEnabled = false;
  // The grid cell (col,row) under the cursor for the preview marker; null hides.
  private previewCell: { col: number; row: number } | null = null;

  // Play mode (M8). Everything here is ephemeral session state: it never
  // touches the project store, so entering/leaving play changes no data and
  // nothing lands in undo or autosave.
  private playing = false;
  private spawnCell: Cell = { col: 0, row: 0 };
  private playerCell: Cell = { col: 0, row: 0 };
  private facing: Direction = 'south';
  // The in-flight step between two cells; null while standing.
  private tween: {
    from: Cell;
    to: Cell;
    startedAt: number;
    duration: number;
    hop: boolean;
  } | null = null;
  // Held movement keys in press order; the most recent one drives movement
  // (no diagonal: exactly one direction is ever acted on).
  private heldDirs: Direction[] = [];
  // Until this timestamp a fresh direction only changes facing (tap-to-turn).
  private turnUntil = 0;
  private tickerAttached = false;

  // Active stroke: the pointer we captured, the layer it paints, and the cells
  // or pixels it actually changed.
  private painting = false;
  private paintPointerId = -1;
  private strokeMode: 'collision' | 'occlusion' = 'collision';
  private strokeChanges = new Set<number>();

  private viewportW = 0;
  private viewportH = 0;

  private callbacks!: CanvasCallbacks;
  private canvas!: HTMLCanvasElement;

  // Input state.
  private spaceDown = false;
  private panning = false;
  private panPointerId = -1;
  private lastPan = { x: 0, y: 0 };
  private pressStart: { x: number; y: number } | null = null;

  async init(mount: HTMLElement, callbacks: CanvasCallbacks): Promise<void> {
    this.callbacks = callbacks;
    const rect = mount.getBoundingClientRect();
    this.viewportW = Math.max(1, rect.width);
    this.viewportH = Math.max(1, rect.height);

    this.app = new Application();
    await this.app.init({
      // WKWebView advertises WebGPU but Pixi's WebGPU path is unreliable
      // there; WebGL is fully sufficient for this workload.
      preference: 'webgl',
      width: this.viewportW,
      height: this.viewportH,
      background: 0x1e1e20,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    this.canvas = this.app.canvas;
    this.canvas.style.display = 'block';
    mount.appendChild(this.canvas);

    this.background = new TilingSprite({
      texture: this.makeCheckerTexture(),
      width: this.viewportW,
      height: this.viewportH,
    });
    this.world = new Container();
    // World-space layers, in z-order. The backdrop is the bottom-most child so
    // it renders behind everything; the artwork sprite is inserted just above
    // it (below the occlusion/preview layers) in loadArtwork.
    this.backdropLayer = new Container();
    this.occlusionTint = new Sprite();
    this.previewPlayer = new Graphics();
    this.previewTop = new Sprite();
    this.occlusionTint.visible = false;
    this.previewPlayer.visible = false;
    this.previewTop.visible = false;
    this.world.addChild(
      this.backdropLayer,
      this.occlusionTint,
      this.previewPlayer,
      this.previewTop,
    );

    this.collisionLayer = new Graphics();
    this.gridLayer = new Graphics();
    this.overlay = new Graphics();
    this.app.stage.addChild(
      this.background,
      this.world,
      this.collisionLayer,
      this.gridLayer,
      this.overlay,
    );

    this.attachInput();
    this.redraw();
  }

  destroy(): void {
    this.detachInput();
    // Free the backdrop textures we generated ourselves (not attached to the
    // stage tree, so app.destroy would not reach them).
    this.backdropObjectTexture?.destroy(true);
    this.backdropCheckerTexture?.destroy(true);
    // Destroy the app, its canvas, and all GPU resources.
    this.app?.destroy(true, { children: true, texture: true });
  }

  // --- Public control surface (called from React) ---

  resize(width: number, height: number): void {
    this.viewportW = Math.max(1, width);
    this.viewportH = Math.max(1, height);
    this.app.renderer.resize(this.viewportW, this.viewportH);
    this.background.width = this.viewportW;
    this.background.height = this.viewportH;
    this.redraw();
    this.drawCollisionLayer();
  }

  /**
   * Load (or reload) the artwork. `preserveView` keeps the current pan/zoom
   * and selection when the dimensions are unchanged - used when the same
   * object recomposes (M12) so a child nudge does not re-fit the view.
   */
  async loadArtwork(art: ArtworkInput, preserveView = false): Promise<void> {
    const img = new Image();
    img.src = art.url;
    await img.decode();

    const texture = Texture.from(img);
    texture.source.scaleMode = 'nearest'; // pixel art: never blur

    const keepView =
      preserveView &&
      this.sprite !== null &&
      this.artW === art.width &&
      this.artH === art.height;

    if (this.sprite) {
      this.world.removeChild(this.sprite);
      this.sprite.destroy();
    }
    this.sprite = new Sprite(texture);
    this.sprite.roundPixels = true;
    // Insert the artwork just below the occlusion/preview layers but ABOVE the
    // backdrop, so the backdrop stays behind the artwork and the preview's top
    // layer still renders over the player.
    this.world.addChildAt(this.sprite, this.world.getChildIndex(this.occlusionTint));

    this.artW = art.width;
    this.artH = art.height;
    // Grab the raw pixels so the preview can reconstruct the above-player layer
    // (the real artwork pixels under the mask). Kept until the next artwork load.
    this.artworkPixels = readImagePixels(img, art.width, art.height);
    if (!keepView) {
      this.setSelected(false);
      this.fit();
    } else {
      this.redraw();
    }
    // fit() redraws the grid/overlay; the collision tint depends on artW/artH
    // now being set, so draw it once the artwork size is known.
    this.drawCollisionLayer();
    this.refreshOcclusion();
    // The backdrop is sized to the artwork bounds, so rebuild it on any load.
    this.rebuildBackdrop();
    // Switching objects while in play mode respawns the player on the new grid
    // (enterPlay also covers the mount case where play mode was set before the
    // artwork finished loading).
    if (this.paintMode === 'play') this.enterPlay();
  }

  clearArtwork(): void {
    // No artwork means nothing to play on; React resets the mode to 'select'.
    if (this.playing) this.leavePlay();
    if (this.sprite) {
      this.world.removeChild(this.sprite);
      this.sprite.destroy();
      this.sprite = null;
    }
    this.artW = 0;
    this.artH = 0;
    this.artworkPixels = null;
    this.previewCell = null;
    this.setSelected(false);
    this.redraw();
    this.drawCollisionLayer();
    this.refreshOcclusion();
    // No artwork means no bounds to fill; hide the backdrop.
    this.rebuildBackdrop();
  }

  setGrid(config: GridConfig): void {
    this.grid = config;
    this.drawGridLayer();
  }

  /**
   * Set the preview backdrop rendered behind the artwork (P2.1). The 'object'
   * kind decodes its PNG asynchronously; a newer call supersedes an in-flight
   * decode. Preview-only: the backdrop never affects export or any data.
   */
  async setBackdrop(spec: BackdropSpec): Promise<void> {
    const seq = ++this.backdropSeq;
    if (spec.kind === 'object') {
      const img = new Image();
      img.src = spec.url;
      try {
        await img.decode();
      } catch {
        // A bad/blank data URL just means no backdrop; fall back cleanly.
        if (seq === this.backdropSeq) {
          this.backdropSpec = { kind: 'none' };
          this.rebuildBackdrop();
        }
        return;
      }
      if (seq !== this.backdropSeq) return; // superseded while decoding
      this.backdropObjectTexture?.destroy(true);
      const tex = Texture.from(img);
      tex.source.scaleMode = 'nearest';
      this.backdropObjectTexture = tex;
    }
    if (seq !== this.backdropSeq) return;
    this.backdropSpec = spec;
    this.rebuildBackdrop();
  }

  /** Replace the collision grid to render (row-major index -> value). */
  setCollision(cells: Record<string, CollisionValue>): void {
    this.collisionCells = new Map(
      Object.entries(cells).map(([k, v]) => [Number(k), v]),
    );
    this.drawCollisionLayer();
  }

  /** Show or hide the collision tint, independent of paint mode. */
  setCollisionVisible(visible: boolean): void {
    this.collisionVisible = visible;
    this.drawCollisionLayer();
  }

  /** Switch between selection, the two paint brushes, and play mode. */
  setPaintMode(mode: PaintMode): void {
    if (this.paintMode === mode) return;
    const wasPlaying = this.playing;
    this.paintMode = mode;
    if (mode === 'play') this.enterPlay();
    else if (wasPlaying) this.leavePlay();
    this.updateCursor();
  }

  /** Set the value the collision brush paints ('Walkable' erases). */
  setActiveCollisionValue(value: CollisionValue): void {
    this.paintValue = value;
  }

  /** Replace the occlusion mask to render (row-major pixel indices). */
  setOcclusion(pixels: number[]): void {
    this.occlusionPixels = new Set(pixels);
    this.refreshOcclusion();
  }

  /** Show or hide the occlusion tint, independent of paint mode and preview. */
  setOcclusionVisible(visible: boolean): void {
    if (this.occlusionVisible === visible) return;
    this.occlusionVisible = visible;
    this.refreshOcclusion();
  }

  /** Whether the occlusion brush erases occluding pixels rather than paints. */
  setOcclusionErase(erase: boolean): void {
    this.occlusionErase = erase;
  }

  /** Set the occlusion brush's square side in artwork pixels. */
  setOcclusionBrushSize(size: number): void {
    this.occlusionBrushSize = Math.max(1, Math.round(size));
  }

  /** Toggle the player-sized preview marker and its above-player top layer. */
  setPreview(enabled: boolean): void {
    if (this.previewEnabled === enabled) return;
    this.previewEnabled = enabled;
    this.refreshOcclusion();
    this.drawPreviewPlayer();
  }

  /** Show a crosshair at the anchor (artwork pixels); null hides it. */
  setAnchor(anchor: { x: number; y: number } | null): void {
    this.anchor = anchor;
    this.drawOverlay();
  }

  /** Outline a child's footprint (artwork pixels, M12); null hides it. */
  setChildHighlight(
    rect: { x: number; y: number; width: number; height: number } | null,
  ): void {
    this.childHighlight = rect;
    this.drawOverlay();
  }

  /** Restrict brushes to a region (artwork pixels, M12); null = everywhere. */
  setPaintBounds(
    bounds: { x: number; y: number; width: number; height: number } | null,
  ): void {
    this.paintBounds = bounds;
  }

  /** Whether an artwork pixel is inside the paintable region. */
  private paintable(x: number, y: number): boolean {
    const b = this.paintBounds;
    if (!b) return true;
    return x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
  }

  /** Return the play-mode player to its spawn cell. No data is touched. */
  resetPlayer(): void {
    if (!this.playing) return;
    this.playerCell = { ...this.spawnCell };
    this.facing = 'south';
    this.tween = null;
    this.drawPlayer();
    this.centerCameraOnPlayer();
  }

  // --- Play mode (M8) ---

  // Spawn (or respawn) the player and start the movement ticker. Safe to call
  // again while already playing: switching objects re-runs the spawn rule.
  private enterPlay(): void {
    if (!this.sprite) return; // no artwork yet; loadArtwork retries
    this.playing = true;
    this.spawnCell = findSpawn(
      this.collisionCells,
      this.gridCols(),
      this.gridRows(),
      this.anchor,
    );
    this.playerCell = { ...this.spawnCell };
    this.facing = 'south';
    this.tween = null;
    this.heldDirs = [];
    // Force the above-player occlusion layer on while playing, regardless of
    // the Preview toggle: play without the sandwich would lie about rendering.
    this.refreshOcclusion();
    this.drawPlayer();
    this.centerCameraOnPlayer();
    if (!this.tickerAttached) {
      this.app.ticker.add(this.onTick);
      this.tickerAttached = true;
    }
  }

  private leavePlay(): void {
    this.playing = false;
    this.tween = null;
    this.heldDirs = [];
    if (this.tickerAttached) {
      this.app.ticker.remove(this.onTick);
      this.tickerAttached = false;
    }
    // Hand the shared player layer and the top layer back to the M7 preview.
    this.refreshOcclusion();
    this.drawPreviewPlayer();
  }

  private gridCols(): number {
    return Math.ceil(this.artW / COLLISION_CELL);
  }

  private gridRows(): number {
    return Math.ceil(this.artH / COLLISION_CELL);
  }

  // The per-frame movement loop, active only while playing. Advances the
  // current tween and, once standing, starts the next step from held keys.
  private onTick = (): void => {
    if (!this.playing) return;
    const now = performance.now();
    if (this.tween) {
      if (now - this.tween.startedAt >= this.tween.duration) {
        this.playerCell = { ...this.tween.to };
        this.tween = null;
        // Chain the next step immediately so holding a key walks continuously;
        // direction changes mid-walk flow without the standing turn pause.
        this.tryStep(now, true);
      }
      this.drawPlayer();
    } else {
      this.tryStep(now, false);
    }
    this.centerCameraOnPlayer();
  };

  // Attempt one grid step in the most recently held direction. From a
  // standstill, a direction change first turns in place (Emerald taps turn
  // without stepping); mid-walk changes keep moving.
  private tryStep(now: number, cameFromMotion: boolean): void {
    const dir = this.heldDirs[this.heldDirs.length - 1];
    if (!dir) return;
    if (dir !== this.facing) {
      this.facing = dir;
      if (!cameFromMotion) {
        this.turnUntil = now + TURN_MS;
        this.drawPlayer();
        return;
      }
    } else if (!cameFromMotion && now < this.turnUntil) {
      return;
    }
    const outcome = resolveStep(
      this.collisionCells,
      this.gridCols(),
      this.gridRows(),
      this.playerCell,
      dir,
    );
    if (outcome.kind === 'blocked') {
      this.drawPlayer(); // facing may have changed against a wall
      return;
    }
    this.tween = {
      from: { ...this.playerCell },
      to: { col: outcome.col, row: outcome.row },
      startedAt: now,
      duration: outcome.kind === 'hop' ? HOP_MS : WALK_MS,
      hop: outcome.kind === 'hop',
    };
    this.drawPlayer();
  }

  // The player sprite's top-left in artwork pixels (interpolated during a
  // tween) plus the hop lift. The sprite stands on its cell: feet fill the
  // bottom 16px, head rises one cell above.
  private playerRenderPos(): { x: number; y: number; lift: number } {
    const topLeft = (c: Cell) => ({
      x: c.col * COLLISION_CELL,
      y: c.row * COLLISION_CELL - (PLAYER_H - COLLISION_CELL),
    });
    if (!this.tween) return { ...topLeft(this.playerCell), lift: 0 };
    const t = clamp(
      (performance.now() - this.tween.startedAt) / this.tween.duration,
      0,
      1,
    );
    const a = topLeft(this.tween.from);
    const b = topLeft(this.tween.to);
    const lift = this.tween.hop ? Math.sin(Math.PI * t) * HOP_ARC_PX : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, lift };
  }

  // Draw the play-mode player into the shared player layer. Its slot in
  // `world` (above the artwork, below previewTop) is the occlusion sandwich:
  // occluding pixels draw over the player, everything else behind it.
  private drawPlayer(): void {
    const g = this.previewPlayer;
    g.clear();
    if (!this.playing) {
      g.visible = false;
      return;
    }
    const pos = this.playerRenderPos();
    drawPlayerSprite(g, pos.x, pos.y - pos.lift, this.facing);
    g.visible = true;
  }

  // Keep the camera locked to the player (Emerald centers the view on the
  // player; manual panning is disabled while playing, zoom is respected).
  // Cheap no-op when nothing moved, so calling it every tick is fine.
  private centerCameraOnPlayer(): void {
    if (!this.playing) return;
    const pos = this.playerRenderPos();
    const scale = this.world.scale.x;
    const cx = pos.x + PLAYER_W / 2;
    const cy = pos.y + PLAYER_H - COLLISION_CELL / 2;
    const nx = this.viewportW / 2 - cx * scale;
    const ny = this.viewportH / 2 - cy * scale;
    if (Math.abs(nx - this.world.x) < 0.01 && Math.abs(ny - this.world.y) < 0.01) {
      return;
    }
    this.world.x = nx;
    this.world.y = ny;
    this.afterTransform();
  }

  /** Scale the artwork to fit the viewport (with padding) and center it. */
  fit(): void {
    if (!this.sprite) return;
    const scale = clamp(
      Math.min(this.viewportW / this.artW, this.viewportH / this.artH) * FIT_PADDING,
      MIN_SCALE,
      MAX_SCALE,
    );
    this.world.scale.set(scale);
    this.world.x = (this.viewportW - this.artW * scale) / 2;
    this.world.y = (this.viewportH - this.artH * scale) / 2;
    this.afterTransform();
  }

  /** Reset to 1:1 and center the artwork. */
  reset100(): void {
    if (!this.sprite) return;
    this.world.scale.set(1);
    this.world.x = (this.viewportW - this.artW) / 2;
    this.world.y = (this.viewportH - this.artH) / 2;
    this.afterTransform();
  }

  /** Zoom by a factor, centered on the viewport center (buttons/keyboard). */
  zoomStep(factor: number): void {
    this.zoomAt(this.viewportW / 2, this.viewportH / 2, factor);
  }

  // --- Transform helpers ---

  private zoomAt(sx: number, sy: number, factor: number): void {
    const old = this.world.scale.x;
    const next = clamp(old * factor, MIN_SCALE, MAX_SCALE);
    if (next === old) return;
    // Keep the world point under the cursor fixed on screen.
    const wx = (sx - this.world.x) / old;
    const wy = (sy - this.world.y) / old;
    this.world.scale.set(next);
    this.world.x = sx - wx * next;
    this.world.y = sy - wy * next;
    this.afterTransform();
  }

  private panBy(dx: number, dy: number): void {
    this.world.x += dx;
    this.world.y += dy;
    this.afterTransform();
  }

  private afterTransform(): void {
    this.drawCollisionLayer();
    this.drawGridLayer();
    this.drawOverlay();
    this.callbacks.onZoom(Math.round(this.world.scale.x * 100));
  }

  private redraw(): void {
    this.drawGridLayer();
    this.drawOverlay();
  }

  // Collision tint: one translucent rect per non-Walkable cell, in screen
  // space (like the grid) so it tracks pan/zoom. Edge cells on artwork whose
  // size is not a multiple of 16 are clamped to the artwork bounds so the tint
  // never spills past the image.
  private drawCollisionLayer(): void {
    this.collisionLayer.clear();
    if (!this.sprite || !this.collisionVisible || this.collisionCells.size === 0) {
      return;
    }
    const cols = Math.ceil(this.artW / COLLISION_CELL);
    const scale = this.world.scale.x;
    for (const [index, value] of this.collisionCells) {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const ax0 = col * COLLISION_CELL;
      const ay0 = row * COLLISION_CELL;
      const ax1 = Math.min(ax0 + COLLISION_CELL, this.artW);
      const ay1 = Math.min(ay0 + COLLISION_CELL, this.artH);
      if (ax1 <= ax0 || ay1 <= ay0) continue; // cell fully outside artwork
      const sx = this.world.x + ax0 * scale;
      const sy = this.world.y + ay0 * scale;
      const color = typeof value === 'object' ? CUSTOM_COLOR : BLOCKED_COLOR;
      this.collisionLayer
        .rect(sx, sy, (ax1 - ax0) * scale, (ay1 - ay0) * scale)
        .fill({ color, alpha: COLLISION_ALPHA });
    }
  }

  private drawGridLayer(): void {
    drawGrid(this.gridLayer, {
      viewportW: this.viewportW,
      viewportH: this.viewportH,
      offsetX: this.world.x,
      offsetY: this.world.y,
      scale: this.world.scale.x,
      artW: this.artW,
      artH: this.artH,
      config: this.grid,
      resolution: this.app.renderer.resolution,
    });
  }

  // Selection outline and anchor crosshair share the overlay layer.
  private drawOverlay(): void {
    this.overlay.clear();
    if (!this.sprite) return;
    const r = this.app.renderer.resolution;
    const snap = (v: number) => (Math.round(v * r) + 0.5) / r;
    const scale = this.world.scale.x;

    if (this.selected) {
      const x = snap(this.world.x);
      const y = snap(this.world.y);
      const w = snap(this.world.x + this.artW * scale) - x;
      const h = snap(this.world.y + this.artH * scale) - y;
      this.overlay
        .rect(x, y, w, h)
        .stroke({ width: 2 / r, color: SELECTION_COLOR, alpha: 0.95 });
    }

    // A selected child's footprint (M12), between the selection outline and
    // the anchor so all three read at once.
    if (this.childHighlight) {
      const hb = this.childHighlight;
      const x = snap(this.world.x + hb.x * scale);
      const y = snap(this.world.y + hb.y * scale);
      const w = snap(this.world.x + (hb.x + hb.width) * scale) - x;
      const h = snap(this.world.y + (hb.y + hb.height) * scale) - y;
      this.overlay
        .rect(x, y, w, h)
        .stroke({ width: 2 / r, color: CHILD_HIGHLIGHT_COLOR, alpha: 0.95 });
    }

    if (this.anchor) {
      const cx = snap(this.world.x + this.anchor.x * scale);
      const cy = snap(this.world.y + this.anchor.y * scale);
      this.overlay
        .moveTo(cx - ANCHOR_ARM, cy)
        .lineTo(cx + ANCHOR_ARM, cy)
        .moveTo(cx, cy - ANCHOR_ARM)
        .lineTo(cx, cy + ANCHOR_ARM)
        .stroke({ width: 2 / r, color: ANCHOR_COLOR, alpha: 0.95 });
    }
  }

  private setSelected(selected: boolean): void {
    if (this.selected === selected) return;
    this.selected = selected;
    this.drawOverlay();
    this.callbacks.onSelectionChange(selected);
  }

  // --- Input ---

  private attachInput(): void {
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    // context menu off so middle/right drags feel native.
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    // WebKit delivers trackpad pinch as proprietary gesture events, not
    // ctrl+wheel like Chromium. Without these, a trackpad cannot zoom.
    this.canvas.addEventListener('gesturestart', this.onGestureStart as EventListener);
    this.canvas.addEventListener('gesturechange', this.onGestureChange as EventListener);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
  }

  private detachInput(): void {
    this.canvas?.removeEventListener('wheel', this.onWheel);
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas?.removeEventListener('pointermove', this.onPointerMove);
    this.canvas?.removeEventListener('pointerup', this.onPointerUp);
    this.canvas?.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas?.removeEventListener('gesturestart', this.onGestureStart as EventListener);
    this.canvas?.removeEventListener('gesturechange', this.onGestureChange as EventListener);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
  }

  private localPoint(e: { clientX: number; clientY: number }) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // Distinguishing a mouse wheel from trackpad two-finger scroll is heuristic:
  // pinch/ctrl+wheel always zooms; a coarse vertical wheel zooms; a smooth
  // two-axis trackpad gesture pans. See task notes on this rough edge.
  private isMouseWheel(e: WheelEvent): boolean {
    if (e.deltaMode !== 0) return true; // line/page mode = classic wheel
    return e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY);
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const p = this.localPoint(e);
    if (e.ctrlKey || this.isMouseWheel(e)) {
      this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * ZOOM_SENSITIVITY));
    } else if (!this.playing) {
      // The follow camera owns the view while playing; manual pan is disabled
      // (zoom above still works - the next tick recenters on the player).
      this.panBy(-e.deltaX, -e.deltaY);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    // While playing the pointer is inert: no pan, no paint, no select.
    if (this.playing) return;
    const panButton = e.button === 1 || (e.button === 0 && this.spaceDown);
    if (panButton) {
      this.panning = true;
      this.panPointerId = e.pointerId;
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
      this.setCursor('grabbing');
      e.preventDefault();
      return;
    }
    // Paint mode: left-drag paints. (Space+left already panned above, so
    // panning still works while painting.)
    if ((this.paintMode === 'collision' || this.paintMode === 'occlusion') && e.button === 0) {
      this.painting = true;
      this.strokeMode = this.paintMode;
      this.paintPointerId = e.pointerId;
      this.strokeChanges.clear();
      this.canvas.setPointerCapture(e.pointerId);
      this.paintAt(e);
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      this.pressStart = { x: e.clientX, y: e.clientY };
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.panning && e.pointerId === this.panPointerId) {
      this.panBy(e.clientX - this.lastPan.x, e.clientY - this.lastPan.y);
      this.lastPan = { x: e.clientX, y: e.clientY };
      return;
    }
    if (this.painting && e.pointerId === this.paintPointerId) {
      this.paintAt(e);
    }
    // Track the cursor cell so the preview marker follows the pointer (the
    // play-mode player owns the shared layer, so skip while playing).
    if (this.previewEnabled && !this.playing) this.updatePreviewCell(e);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.panning && e.pointerId === this.panPointerId) {
      this.panning = false;
      this.panPointerId = -1;
      this.canvas.releasePointerCapture(e.pointerId);
      this.updateCursor();
      return;
    }
    if (this.painting && e.pointerId === this.paintPointerId) {
      this.painting = false;
      this.paintPointerId = -1;
      this.canvas.releasePointerCapture(e.pointerId);
      // One command per stroke: report only the cells/pixels that actually
      // changed, to the layer this stroke was painting.
      if (this.strokeChanges.size > 0) {
        if (this.strokeMode === 'collision') {
          this.callbacks.onCollisionStroke([...this.strokeChanges], this.paintValue);
        } else {
          this.callbacks.onOcclusionStroke([...this.strokeChanges], !this.occlusionErase);
        }
      }
      this.strokeChanges.clear();
      return;
    }
    if (this.pressStart && e.button === 0) {
      const moved = Math.hypot(
        e.clientX - this.pressStart.x,
        e.clientY - this.pressStart.y,
      );
      if (moved < CLICK_SLOP) this.handleClick(e);
      this.pressStart = null;
    }
  };

  private onContextMenu = (e: Event): void => e.preventDefault();

  // Cumulative pinch scale at the last gesture event; WebKit reports scale
  // relative to gesture start, so we apply the ratio between events.
  private gestureScale = 1;

  private onGestureStart = (e: WebKitGestureEvent): void => {
    e.preventDefault();
    this.gestureScale = 1;
  };

  private onGestureChange = (e: WebKitGestureEvent): void => {
    e.preventDefault();
    if (!e.scale) return;
    const p = this.localPoint(e);
    this.zoomAt(p.x, p.y, e.scale / this.gestureScale);
    this.gestureScale = e.scale;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Never react while the user is typing (e.g. project rename).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      // Photoshop-style: cmd+/- zoom, cmd+0 fit, cmd+1 100%.
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        this.zoomStep(KEY_ZOOM_STEP);
      } else if (e.key === '-') {
        e.preventDefault();
        this.zoomStep(1 / KEY_ZOOM_STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        this.fit();
      } else if (e.key === '1') {
        e.preventDefault();
        this.reset100();
      }
      return;
    }
    if (this.playing) {
      const dir = keyToDirection(e);
      if (dir) {
        e.preventDefault();
        if (!this.heldDirs.includes(dir)) this.heldDirs.push(dir);
        return;
      }
      // Space must not start a pan while playing: the camera owns the view.
      if (e.code === 'Space') {
        e.preventDefault();
        return;
      }
    }
    if (e.code === 'Space' && !this.spaceDown) {
      this.spaceDown = true;
      this.updateCursor();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const dir = keyToDirection(e);
    if (dir) this.heldDirs = this.heldDirs.filter((d) => d !== dir);
    if (e.code === 'Space') {
      this.spaceDown = false;
      this.updateCursor();
    }
  };

  // Losing window focus drops keyup events; clear held state so the player
  // does not keep walking (and space does not stick) on return.
  private onWindowBlur = (): void => {
    this.heldDirs = [];
    this.spaceDown = false;
    this.updateCursor();
  };

  // Click empty space to deselect; click the artwork to select it.
  private handleClick(e: PointerEvent): void {
    if (!this.sprite) {
      this.setSelected(false);
      return;
    }
    const p = this.localPoint(e);
    const wx = (p.x - this.world.x) / this.world.scale.x;
    const wy = (p.y - this.world.y) / this.world.scale.x;
    const hit = wx >= 0 && wy >= 0 && wx < this.artW && wy < this.artH;
    this.setSelected(hit);
  }

  // The row-major collision cell under a pointer event, or null if outside the
  // artwork.
  private cellAt(e: { clientX: number; clientY: number }): number | null {
    if (!this.sprite) return null;
    const p = this.localPoint(e);
    const scale = this.world.scale.x;
    const wx = (p.x - this.world.x) / scale;
    const wy = (p.y - this.world.y) / scale;
    if (wx < 0 || wy < 0 || wx >= this.artW || wy >= this.artH) return null;
    const cols = Math.ceil(this.artW / COLLISION_CELL);
    const col = Math.floor(wx / COLLISION_CELL);
    const row = Math.floor(wy / COLLISION_CELL);
    return row * cols + col;
  }

  // The integer artwork pixel under a pointer event, or null if outside.
  private artPixelAt(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    if (!this.sprite) return null;
    const p = this.localPoint(e);
    const scale = this.world.scale.x;
    const wx = Math.floor((p.x - this.world.x) / scale);
    const wy = Math.floor((p.y - this.world.y) / scale);
    if (wx < 0 || wy < 0 || wx >= this.artW || wy >= this.artH) return null;
    return { x: wx, y: wy };
  }

  // Update the 16px grid cell the preview marker stands on, redrawing only when
  // it changes. The marker snaps to the metatile cell under the cursor.
  private updatePreviewCell(e: { clientX: number; clientY: number }): void {
    if (!this.sprite) return;
    const p = this.localPoint(e);
    const scale = this.world.scale.x;
    const wx = (p.x - this.world.x) / scale;
    const wy = (p.y - this.world.y) / scale;
    const next =
      wx < 0 || wy < 0 || wx >= this.artW || wy >= this.artH
        ? null
        : { col: Math.floor(wx / COLLISION_CELL), row: Math.floor(wy / COLLISION_CELL) };
    const changed =
      (next === null) !== (this.previewCell === null) ||
      (next && this.previewCell && (next.col !== this.previewCell.col || next.row !== this.previewCell.row));
    if (!changed) return;
    this.previewCell = next;
    this.drawPreviewPlayer();
  }

  // Dispatch a paint sample to the layer the active stroke is painting.
  private paintAt(e: PointerEvent): void {
    if (this.strokeMode === 'occlusion') this.paintOcclusionAt(e);
    else this.paintCollisionAt(e);
  }

  // Paint the active value onto the cell under the pointer, updating the local
  // render copy for immediate feedback and recording cells that actually change
  // (so the stroke's undo command carries only real changes).
  private paintCollisionAt(e: PointerEvent): void {
    const cell = this.cellAt(e);
    if (cell === null) return;
    // Composed view (M12): only the parent's own cells are paintable.
    const cols = Math.ceil(this.artW / COLLISION_CELL);
    if (!this.paintable((cell % cols) * COLLISION_CELL, Math.floor(cell / cols) * COLLISION_CELL)) {
      return;
    }
    const current = this.collisionCells.get(cell);
    if (collisionValueEq(current, this.paintValue)) return; // no change
    if (this.paintValue === 'Walkable') this.collisionCells.delete(cell);
    else this.collisionCells.set(cell, this.paintValue);
    this.strokeChanges.add(cell);
    this.drawCollisionLayer();
  }

  // Paint (or erase) a square brush of occluding pixels centered on the pointer,
  // recording only pixels whose state actually flips so the stroke's undo
  // command carries only real changes. Pixel-level, matching occlusion.rs.
  private paintOcclusionAt(e: PointerEvent): void {
    const pt = this.artPixelAt(e);
    if (!pt) return;
    const size = this.occlusionBrushSize;
    const start = -Math.floor((size - 1) / 2);
    let changed = false;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = pt.x + start + dx;
        const y = pt.y + start + dy;
        if (x < 0 || y < 0 || x >= this.artW || y >= this.artH) continue;
        // Composed view (M12): only the parent's own pixels are paintable.
        if (!this.paintable(x, y)) continue;
        const idx = y * this.artW + x;
        const has = this.occlusionPixels.has(idx);
        if (this.occlusionErase) {
          if (!has) continue;
          this.occlusionPixels.delete(idx);
        } else {
          if (has) continue;
          this.occlusionPixels.add(idx);
        }
        this.strokeChanges.add(idx);
        changed = true;
      }
    }
    if (changed) this.refreshOcclusion();
  }

  private setCursor(cursor: string): void {
    this.canvas.style.cursor = cursor;
  }

  private updateCursor(): void {
    if (this.playing) {
      this.setCursor('default');
    } else if (this.spaceDown) {
      this.setCursor('grab');
    } else if (this.paintMode === 'collision' || this.paintMode === 'occlusion') {
      this.setCursor('crosshair');
    } else {
      this.setCursor('default');
    }
  }

  // Rebuild the occlusion tint (authoring overlay) and the preview top layer
  // (real above-player pixels) from the current mask, then set their
  // visibility. Called on mask edits, visibility/preview toggles, and load.
  private refreshOcclusion(): void {
    const hasArt = this.sprite !== null && this.artW > 0;
    const hasPixels = this.occlusionPixels.size > 0;

    if (this.occlusionTintTexture) {
      this.occlusionTintTexture.destroy(true);
      this.occlusionTintTexture = null;
    }
    if (hasArt && hasPixels && this.occlusionVisible) {
      this.occlusionTintTexture = this.textureFromMask((p, src) => {
        src[p] = OCCLUSION_TINT[0];
        src[p + 1] = OCCLUSION_TINT[1];
        src[p + 2] = OCCLUSION_TINT[2];
        src[p + 3] = OCCLUSION_TINT_ALPHA;
      });
      this.occlusionTint.texture = this.occlusionTintTexture;
      this.occlusionTint.visible = true;
    } else {
      this.occlusionTint.texture = Texture.EMPTY;
      this.occlusionTint.visible = false;
    }

    if (this.previewTopTexture) {
      this.previewTopTexture.destroy(true);
      this.previewTopTexture = null;
    }
    // The preview's above-player layer is the real artwork pixels under the
    // mask - honest to compiler.md (occluding pixels -> top.png). A pixel that
    // is transparent in the artwork stays transparent here. Play mode forces
    // the layer on: the sandwich is what makes the runtime preview truthful.
    const art = this.artworkPixels;
    if (hasArt && hasPixels && (this.previewEnabled || this.playing) && art) {
      this.previewTopTexture = this.textureFromMask((p, out) => {
        out[p] = art.data[p] ?? 0;
        out[p + 1] = art.data[p + 1] ?? 0;
        out[p + 2] = art.data[p + 2] ?? 0;
        out[p + 3] = art.data[p + 3] ?? 0;
      });
      this.previewTop.texture = this.previewTopTexture;
      this.previewTop.visible = true;
    } else {
      this.previewTop.texture = Texture.EMPTY;
      this.previewTop.visible = false;
    }
  }

  // Build an artwork-sized texture, writing `paint` into each occluding pixel
  // (leaving the rest transparent). Nearest sampling keeps it crisp when the
  // world scales. The caller owns destroying the returned texture.
  private textureFromMask(paint: (offset: number, data: Uint8ClampedArray) => void): Texture {
    const canvas = document.createElement('canvas');
    canvas.width = this.artW;
    canvas.height = this.artH;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(this.artW, this.artH);
    for (const idx of this.occlusionPixels) {
      if (idx >= this.artW * this.artH) continue; // ignore any stale index
      paint(idx * 4, img.data);
    }
    ctx.putImageData(img, 0, 0);
    const tex = Texture.from(canvas);
    tex.source.scaleMode = 'nearest';
    return tex;
  }

  // Draw the player-sized preview marker in world space at the cursor cell. It
  // stands on the 16x16 cell (bottom) and rises one cell above it (16x32).
  // While playing, the play-mode player owns this layer (see drawPlayer).
  private drawPreviewPlayer(): void {
    if (this.playing) return;
    this.previewPlayer.clear();
    if (!this.sprite || !this.previewEnabled || !this.previewCell) {
      this.previewPlayer.visible = false;
      return;
    }
    const x = this.previewCell.col * COLLISION_CELL;
    const y = this.previewCell.row * COLLISION_CELL - (PLAYER_H - COLLISION_CELL);
    this.previewPlayer
      .rect(x, y, PLAYER_W, PLAYER_H)
      .fill({ color: PLAYER_FILL, alpha: PLAYER_ALPHA });
    this.previewPlayer.visible = true;
  }

  // Rebuild the backdrop layer for the current spec + artwork size. The layer
  // fills the artwork's bounds (0,0)-(artW,artH) in world space, so it tracks
  // pan/zoom and sits exactly behind the object. Filling the artwork bounds
  // (rather than the whole viewport) keeps the preview honest: the backdrop is
  // the ground directly under the object being judged.
  private rebuildBackdrop(): void {
    // Drop the previous child(ren). The checker/object source textures are
    // engine-owned (freed on rebuild/teardown), so do not destroy them here.
    for (const child of this.backdropLayer.removeChildren()) {
      child.destroy({ children: true, texture: false });
    }
    const spec = this.backdropSpec;
    if (!this.sprite || this.artW <= 0 || spec.kind === 'none') {
      this.backdropLayer.visible = false;
      return;
    }
    let child: Container | null = null;
    if (spec.kind === 'color') {
      child = new Graphics().rect(0, 0, this.artW, this.artH).fill(spec.color);
    } else if (spec.kind === 'checker') {
      if (!this.backdropCheckerTexture) {
        this.backdropCheckerTexture = this.makeCheckerTexture();
      }
      child = new TilingSprite({
        texture: this.backdropCheckerTexture,
        width: this.artW,
        height: this.artH,
      });
    } else if (spec.kind === 'object' && this.backdropObjectTexture) {
      child = new TilingSprite({
        texture: this.backdropObjectTexture,
        width: this.artW,
        height: this.artH,
      });
    }
    if (!child) {
      this.backdropLayer.visible = false;
      return;
    }
    this.backdropLayer.addChild(child);
    this.backdropLayer.visible = true;
  }

  private makeCheckerTexture(): Texture {
    // A 16px tile: two diagonal 8px squares over a flat base.
    const tile = new Graphics()
      .rect(0, 0, 16, 16)
      .fill(CHECKER_A)
      .rect(0, 0, 8, 8)
      .fill(CHECKER_B)
      .rect(8, 8, 8, 8)
      .fill(CHECKER_B);
    const texture = this.app.renderer.generateTexture(tile);
    tile.destroy();
    return texture;
  }
}
