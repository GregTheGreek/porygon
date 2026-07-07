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

export type CanvasCallbacks = {
  /** Current zoom as a percentage (100 = 1:1). */
  onZoom: (percent: number) => void;
  /** Whether the artwork is currently selected. */
  onSelectionChange: (selected: boolean) => void;
};

export type ArtworkInput = {
  name: string;
  width: number;
  height: number;
  url: string;
};

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
// Crosshair arm length in screen pixels (zoom-independent).
const ANCHOR_ARM = 7;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * The PixiJS world for the Canvas. React owns only mounting and prop plumbing;
 * all rendering, zoom, pan, grid, and selection live here.
 *
 * Layout of the scene:
 *   stage
 *     background  - checkerboard, screen space, never scaled
 *     world       - carries pan (position) + zoom (scale)
 *       sprite    - the artwork, nearest-neighbor sampled
 *     gridLayer   - grid lines, redrawn in screen space (crisp 1px)
 *     overlay     - selection outline + anchor crosshair, screen space
 */
export class CanvasEngine {
  private app!: Application;
  private world!: Container;
  private background!: TilingSprite;
  private gridLayer!: Graphics;
  private overlay!: Graphics;

  private sprite: Sprite | null = null;
  private artW = 0;
  private artH = 0;

  private grid: GridConfig = { show8: false, show16: false };
  private selected = false;
  // The selected Object's anchor in artwork pixels; null hides the marker.
  private anchor: { x: number; y: number } | null = null;

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
    this.gridLayer = new Graphics();
    this.overlay = new Graphics();
    this.app.stage.addChild(this.background, this.world, this.gridLayer, this.overlay);

    this.attachInput();
    this.redraw();
  }

  destroy(): void {
    this.detachInput();
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
  }

  async loadArtwork(art: ArtworkInput): Promise<void> {
    const img = new Image();
    img.src = art.url;
    await img.decode();

    const texture = Texture.from(img);
    texture.source.scaleMode = 'nearest'; // pixel art: never blur

    if (this.sprite) {
      this.world.removeChild(this.sprite);
      this.sprite.destroy();
    }
    this.sprite = new Sprite(texture);
    this.sprite.roundPixels = true;
    this.world.addChild(this.sprite);

    this.artW = art.width;
    this.artH = art.height;
    this.setSelected(false);
    this.fit();
  }

  clearArtwork(): void {
    if (this.sprite) {
      this.world.removeChild(this.sprite);
      this.sprite.destroy();
      this.sprite = null;
    }
    this.artW = 0;
    this.artH = 0;
    this.setSelected(false);
    this.redraw();
  }

  setGrid(config: GridConfig): void {
    this.grid = config;
    this.drawGridLayer();
  }

  /** Show a crosshair at the anchor (artwork pixels); null hides it. */
  setAnchor(anchor: { x: number; y: number } | null): void {
    this.anchor = anchor;
    this.drawOverlay();
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
    this.drawGridLayer();
    this.drawOverlay();
    this.callbacks.onZoom(Math.round(this.world.scale.x * 100));
  }

  private redraw(): void {
    this.drawGridLayer();
    this.drawOverlay();
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
    } else {
      this.panBy(-e.deltaX, -e.deltaY);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
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
    if (e.button === 0) {
      this.pressStart = { x: e.clientX, y: e.clientY };
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.panning && e.pointerId === this.panPointerId) {
      this.panBy(e.clientX - this.lastPan.x, e.clientY - this.lastPan.y);
      this.lastPan = { x: e.clientX, y: e.clientY };
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.panning && e.pointerId === this.panPointerId) {
      this.panning = false;
      this.panPointerId = -1;
      this.canvas.releasePointerCapture(e.pointerId);
      this.updateCursor();
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
    if (e.code === 'Space' && !this.spaceDown) {
      this.spaceDown = true;
      this.updateCursor();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      this.spaceDown = false;
      this.updateCursor();
    }
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

  private setCursor(cursor: string): void {
    this.canvas.style.cursor = cursor;
  }

  private updateCursor(): void {
    this.setCursor(this.spaceDown ? 'grab' : 'default');
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
