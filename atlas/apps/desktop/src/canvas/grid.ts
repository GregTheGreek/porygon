import type { Graphics } from 'pixi.js';

// Below this many on-screen pixels per cell a grid is illegible, so we hide it.
const MIN_CELL_PX = 4;

// The 8px grid is the tile grid; the 16px grid is the metatile grid and reads
// noticeably stronger, matching how artists think about Pokémon tilesets.
const TILE_ALPHA = 0.09;
const METATILE_ALPHA = 0.26;
const GRID_COLOR = 0xffffff;

export type GridConfig = { show8: boolean; show16: boolean };

type GridDraw = {
  /** Screen (logical px) viewport size. */
  viewportW: number;
  viewportH: number;
  /** World transform: screen = offset + world * scale. */
  offsetX: number;
  offsetY: number;
  scale: number;
  /** Artwork size in world (source) pixels. */
  artW: number;
  artH: number;
  config: GridConfig;
  /** Renderer resolution (device px per logical px) for crisp 1px lines. */
  resolution: number;
};

/**
 * Redraw the pixel grid into `g` in screen space. Drawing in screen space (not
 * scaling a world-space graphic) keeps every line exactly 1 device pixel wide
 * at any zoom. Lines are clamped to the artwork rectangle and to the viewport.
 */
export function drawGrid(g: Graphics, d: GridDraw): void {
  g.clear();
  if (d.artW === 0 || d.artH === 0) return;

  // Center a 1-device-px line on a device pixel so it renders crisp.
  const snap = (v: number) => (Math.round(v * d.resolution) + 0.5) / d.resolution;
  const lineWidth = 1 / d.resolution;

  const rx0 = d.offsetX;
  const ry0 = d.offsetY;
  const rx1 = d.offsetX + d.artW * d.scale;
  const ry1 = d.offsetY + d.artH * d.scale;

  const x0 = Math.max(0, rx0);
  const y0 = Math.max(0, ry0);
  const x1 = Math.min(d.viewportW, rx1);
  const y1 = Math.min(d.viewportH, ry1);
  if (x1 <= x0 || y1 <= y0) return; // artwork fully off-screen

  const drawCells = (cell: number, alpha: number) => {
    if (cell * d.scale < MIN_CELL_PX) return; // too dense to read
    for (let x = 0; x <= d.artW + 1e-6; x += cell) {
      const sx = snap(d.offsetX + Math.min(x, d.artW) * d.scale);
      if (sx < x0 - 1 || sx > x1 + 1) continue;
      g.moveTo(sx, y0).lineTo(sx, y1);
    }
    for (let y = 0; y <= d.artH + 1e-6; y += cell) {
      const sy = snap(d.offsetY + Math.min(y, d.artH) * d.scale);
      if (sy < y0 - 1 || sy > y1 + 1) continue;
      g.moveTo(x0, sy).lineTo(x1, sy);
    }
    g.stroke({ width: lineWidth, color: GRID_COLOR, alpha });
  };

  // 8px first so the 16px metatile lines overdraw them and stay dominant.
  if (d.config.show8) drawCells(8, TILE_ALPHA);
  if (d.config.show16) drawCells(16, METATILE_ALPHA);
}
