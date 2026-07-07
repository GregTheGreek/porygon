// Pure play-mode movement rules (M8). No Pixi, no store: given the painted
// collision cells, a position, and a direction, return what Emerald would do.
// Kept pure so the movement rules are trivially testable and auditable against
// the GBA ("if the preview would behave differently from the GBA, the preview
// is wrong").
import type { CollisionValue } from '../lib/api';

/** One collision cell / anchor-grid unit, in pixels (mirrors collision.rs). */
export const CELL = 16;

/**
 * How many cells of empty space around the artwork the player may walk on.
 * Cells outside the artwork carry no collision data and are passable; the
 * apron is a chosen editor boundary so the player can walk around and behind
 * the object without wandering off unboundedly. Not a GBA rule.
 */
export const PLAY_APRON = 3;

export type Direction = 'north' | 'south' | 'east' | 'west';
export type Cell = { col: number; row: number };

/** Screen-space deltas: north is up (-row), east is right (+col). */
export const DIR_DELTA: Record<Direction, { dc: number; dr: number }> = {
  north: { dc: 0, dr: -1 },
  south: { dc: 0, dr: 1 },
  east: { dc: 1, dr: 0 },
  west: { dc: -1, dr: 0 },
};

// The one-way ledge tags (pokemon_emerald.rs, MB_JUMP_*): the value is the
// only direction that may enter the cell, and doing so hops over it.
const LEDGE_TAGS: Record<string, Direction> = {
  jump_north: 'north',
  jump_south: 'south',
  jump_east: 'east',
  jump_west: 'west',
};

export type StepOutcome =
  | { kind: 'blocked' }
  | { kind: 'walk'; col: number; row: number }
  | { kind: 'hop'; col: number; row: number };

type CellKind = 'walkable' | 'blocked' | { ledge: Direction };

function cellKind(value: CollisionValue | undefined): CellKind {
  if (value === undefined || value === 'Walkable') return 'walkable';
  if (value === 'Blocked') return 'blocked';
  const ledge = LEDGE_TAGS[value.Custom];
  if (ledge) return { ledge };
  // Every other custom tag (grass, water, ice, sand, puddle, waterfall) is
  // treated as plain Walkable for now: the MVP preview has no surf, slide, or
  // current simulation. Revisit when the runtime grows those behaviors.
  return 'walkable';
}

// The painted value at a cell; cells outside the artwork grid have no data
// (and must not be looked up: a negative col would alias another row's index).
function valueAt(
  cells: ReadonlyMap<number, CollisionValue>,
  cols: number,
  rows: number,
  col: number,
  row: number,
): CollisionValue | undefined {
  if (col < 0 || row < 0 || col >= cols || row >= rows) return undefined;
  return cells.get(row * cols + col);
}

/**
 * Resolve one grid step. Movement is exactly one metatile at a time, never
 * diagonal, never sub-grid (Emerald walks on the 16px grid or not at all):
 *
 * - Walkable cells and cells outside the artwork are entered normally.
 * - Blocked cells refuse the step.
 * - MB_JUMP_* ledges are one-way: stepping in the ledge's jump direction hops
 *   over it to the cell beyond (a two-cell move); entering from any other
 *   direction is refused, exactly like Emerald ledges. The landing cell must
 *   itself be plainly walkable - landing on Blocked or another ledge refuses
 *   the hop (conservative choice).
 * - The playfield is the artwork grid plus PLAY_APRON outside cells.
 */
export function resolveStep(
  cells: ReadonlyMap<number, CollisionValue>,
  cols: number,
  rows: number,
  from: Cell,
  dir: Direction,
): StepOutcome {
  const { dc, dr } = DIR_DELTA[dir];
  const inBounds = (c: Cell) =>
    c.col >= -PLAY_APRON &&
    c.row >= -PLAY_APRON &&
    c.col < cols + PLAY_APRON &&
    c.row < rows + PLAY_APRON;

  const target = { col: from.col + dc, row: from.row + dr };
  if (!inBounds(target)) return { kind: 'blocked' };
  const kind = cellKind(valueAt(cells, cols, rows, target.col, target.row));
  if (kind === 'blocked') return { kind: 'blocked' };
  if (kind === 'walkable') return { kind: 'walk', ...target };

  if (kind.ledge !== dir) return { kind: 'blocked' };
  const landing = { col: target.col + dc, row: target.row + dr };
  if (!inBounds(landing)) return { kind: 'blocked' };
  if (cellKind(valueAt(cells, cols, rows, landing.col, landing.row)) !== 'walkable') {
    return { kind: 'blocked' };
  }
  return { kind: 'hop', ...landing };
}

/**
 * Where play mode spawns the player: the cell whose top-left corner is the
 * object's anchor (the anchor is the object's map attachment point, so it is
 * the most meaningful "here" the object has), clamped into the grid. If that
 * cell is not plainly walkable, fall back to the first walkable cell in
 * row-major order; a fully blocked object spawns just below the artwork
 * (outside cells are walkable and within the apron).
 */
export function findSpawn(
  cells: ReadonlyMap<number, CollisionValue>,
  cols: number,
  rows: number,
  anchor: { x: number; y: number } | null,
): Cell {
  const walkable = (col: number, row: number) =>
    cellKind(valueAt(cells, cols, rows, col, row)) === 'walkable';

  if (anchor) {
    const col = Math.min(Math.floor(anchor.x / CELL), cols - 1);
    const row = Math.min(Math.floor(anchor.y / CELL), rows - 1);
    if (walkable(col, row)) return { col, row };
  }
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (walkable(col, row)) return { col, row };
    }
  }
  return { col: Math.floor(cols / 2), row: rows };
}
