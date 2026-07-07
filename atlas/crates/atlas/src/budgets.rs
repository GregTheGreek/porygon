//! Tileset budget prediction (Milestone 9) - the Tier 2 heart of Atlas.
//!
//! This module answers compiler.md's decomposition step 6 ("Predict budgets,
//! BEFORE invoking Porytiles") in pure logic over decoded pixels. It is the only
//! thing standing between the artist and a Porytiles SIGABRT: exceeding the
//! palette budget PANICS porytiles 1.0.0 (Spike 0 finding 3), so Atlas must
//! predict palette feasibility rather than pass artwork through and hope.
//!
//! Everything here is engine-agnostic maths: it takes the verified budgets
//! (`pokemon_emerald::Budgets`) as data and decoded RGBA pixels as input, and
//! emits usage meters plus Tier 2 problems in artist terms. No Tauri types, no
//! filesystem in the core - `compute` is exhaustively unit-tested with synthetic
//! pixel buffers. `compute_for_tileset` is the thin fs-touching orchestration
//! the IPC command calls.
//!
//! ## The model (all rules trace to compiler.md / FINDINGS.md)
//!
//! For each member Object, aligned to its 16px grid:
//!   * Route pixels to layers by the occlusion mask: occluding -> top,
//!     everything else -> middle, bottom left empty (compiler.md "Decomposition"
//!     step 3). Layer type is inferred, never authored.
//!   * A pixel is transparent (consumes no colour, no tile) when it is fully
//!     transparent (alpha 0) or the magenta sentinel 255,0,255 (compiler.md
//!     "Target" + the milestone's transparency rule). Colours are keyed by RGB:
//!     the GBA/JASC palette is RGB, so alpha is not part of a palette entry.
//!   * Slice each layer into 8x8 tiles. A fully transparent tile maps to the
//!     shared transparent tile (global id 0) and costs nothing (FINDINGS: "id 0
//!     = shared transparent tile").
//!
//! Then:
//!   * Tiles: Porytiles deduplicates by shape *including h/v flips* (FINDINGS
//!     finding 8 / compiler.md "Tiles and metatiles"). compiler.md prescribes a
//!     range: "distinct shapes ignoring flips = lower bound, counting flips =
//!     upper bound". We report both; the flip-aware lower bound is what Porytiles
//!     actually emits, so the over-budget check uses it. (Tile overflow is a
//!     CLEAN Porytiles error, not a panic, so an exact prediction is safe.)
//!   * Palettes: each 8x8 tile's colours must fit one 15-colour palette; tiles
//!     are packed into at most 7 secondary palettes. compiler.md does not name
//!     Porytiles' packing algorithm, so we take the conservative reading and
//!     predict with deterministic first-fit-decreasing, which yields a feasible
//!     packing and thus an upper bound on the optimum. If FFD needs more than the
//!     budget we fire the (mandatory) Tier 2 error. See the ambiguity note on
//!     `pack_palettes`.
//!   * Metatiles: one 16x16 cell = one metatile. We count every cell in each
//!     member's footprint (no cross-object metatile dedup assumed - the
//!     conservative reading, and metatile overflow is a clean error anyway).

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;

use crate::pokemon_emerald::{Budgets, METATILE_PX, TILE_PX, TRANSPARENT_RGB};
use crate::validity::{Problem, Tier};

/// A member Object decoded and ready for budgeting. Owns its pixels so `compute`
/// stays pure (no fs, no Tauri). Built from disk by `compute_for_tileset` or by
/// hand in tests.
#[derive(Debug, Clone)]
pub struct MemberArt {
    /// Object name, used only to name contributors in artist-facing messages.
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// RGBA8, row-major (`y * width + x`), length `width * height`.
    pub pixels: Vec<[u8; 4]>,
    /// Occluding pixel indices (row-major), i.e. the top layer.
    pub occluding: BTreeSet<u32>,
}

/// A usage meter: `used` against `total`, over budget when `used > total`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Meter {
    pub used: u32,
    pub total: u32,
}

/// The tile meter carries a range because flip-aware dedup gives a lower bound
/// and flip-naive counting an upper bound (compiler.md). `used_min` is what
/// Porytiles actually emits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TileMeter {
    pub used_min: u32,
    pub used_max: u32,
    pub total: u32,
}

/// The full budget report for one tileset: three meters plus Tier 2 problems in
/// artist terms. Serialised straight to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TilesetBudget {
    pub palettes: Meter,
    pub tiles: TileMeter,
    pub metatiles: Meter,
    pub problems: Vec<Problem>,
}

/// One layer a pixel can route to. MVP uses only Top/Middle; Bottom exists in
/// the engine but the occlusion-only decomposition never fills it (see the
/// layer-type note below), so it is not built here.
#[derive(Debug, Clone, Copy)]
enum Layer {
    Top,
    Middle,
}

/// 8x8 tile as row-major colours; `None` is transparent (palette index 0).
type TilePattern = [Option<[u8; 3]>; 64];

/// The layer type Porytiles would infer for a cell from which layers carry
/// pixels (compiler.md "Geometry and layers" / FINDINGS finding 1). Kept as a
/// pure function so the inference is unit-testable even though the MVP's
/// occlusion-only routing never fills the bottom layer, and so can only ever
/// produce `Normal` (middle+top) or `Empty` today. `Unrepresentable` is the
/// three-depth-planes Tier 2 case; it stays dormant until under-detail (bottom)
/// authoring exists, but the rule is encoded now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellLayer {
    Empty,
    Normal,
    Covered,
    Split,
    Unrepresentable,
}

pub fn infer_layer_type(bottom: bool, middle: bool, top: bool) -> CellLayer {
    match (bottom, middle, top) {
        (false, false, false) => CellLayer::Empty,
        (false, true, true) => CellLayer::Normal,
        (true, true, false) => CellLayer::Covered,
        (true, false, true) => CellLayer::Split,
        (true, true, true) => CellLayer::Unrepresentable,
        // Single-layer cells are representable: a lone middle/top/bottom paints
        // as the corresponding dual type with one plane transparent.
        (false, true, false) => CellLayer::Normal,
        (false, false, true) => CellLayer::Normal,
        (true, false, false) => CellLayer::Covered,
    }
}

/// A pixel that consumes no palette entry: fully transparent, or the magenta
/// sentinel that becomes transparency in the layer PNGs. Shared with the
/// exporter (M10) so prediction and emission can never disagree about which
/// pixels exist.
pub(crate) fn is_transparent(px: [u8; 4]) -> bool {
    px[3] == 0 || [px[0], px[1], px[2]] == TRANSPARENT_RGB
}

fn flip_h(p: &TilePattern) -> TilePattern {
    let mut out = [None; 64];
    for row in 0..8 {
        for col in 0..8 {
            out[row * 8 + col] = p[row * 8 + (7 - col)];
        }
    }
    out
}

fn flip_v(p: &TilePattern) -> TilePattern {
    let mut out = [None; 64];
    for row in 0..8 {
        for col in 0..8 {
            out[row * 8 + col] = p[(7 - row) * 8 + col];
        }
    }
    out
}

/// The lexicographically smallest of a tile and its three flips: a stable
/// representative so flip-equivalent tiles collapse to one (Porytiles' dedup).
fn canonical(p: &TilePattern) -> TilePattern {
    let h = flip_h(p);
    let v = flip_v(p);
    let hv = flip_h(&v);
    [*p, h, v, hv].into_iter().min().unwrap()
}

/// Build one 8x8 tile pattern for a member on a layer at cell (col,row),
/// subtile (sx,sy). Returns the pattern; empty (all `None`) means transparent.
fn tile_pattern(m: &MemberArt, layer: Layer, cell_col: u32, cell_row: u32, sx: u32, sy: u32) -> TilePattern {
    let mut pattern = [None; 64];
    let base_x = cell_col * METATILE_PX + sx * TILE_PX;
    let base_y = cell_row * METATILE_PX + sy * TILE_PX;
    for ty in 0..TILE_PX {
        for tx in 0..TILE_PX {
            let gx = base_x + tx;
            let gy = base_y + ty;
            // Pixels past the artwork edge (odd-sized art) are transparent
            // padding: Tier 1 flags off-grid dimensions separately.
            if gx >= m.width || gy >= m.height {
                continue;
            }
            let idx = gy * m.width + gx;
            let occ = m.occluding.contains(&idx);
            let on_layer = match layer {
                Layer::Top => occ,
                Layer::Middle => !occ,
            };
            if !on_layer {
                continue;
            }
            let px = m.pixels[idx as usize];
            if is_transparent(px) {
                continue;
            }
            pattern[(ty * TILE_PX + tx) as usize] = Some([px[0], px[1], px[2]]);
        }
    }
    pattern
}

/// Distinct colours in a tile pattern.
fn tile_colors(p: &TilePattern) -> BTreeSet<[u8; 3]> {
    p.iter().filter_map(|c| *c).collect()
}

fn is_empty(p: &TilePattern) -> bool {
    p.iter().all(|c| c.is_none())
}

/// Pack colour-sets into palettes of at most `cap` colours with deterministic
/// first-fit-decreasing, returning the number of palettes needed.
///
/// AMBIGUITY (flagged per the epistemic rule): compiler.md mandates palette
/// feasibility prediction but does not specify Porytiles' packing algorithm.
/// FFD produces a *feasible* packing, so its count is an upper bound on the
/// optimum - the conservative choice, because under-predicting here means a
/// Porytiles SIGABRT. It may over-report versus an optimal packer; that trades a
/// possible false "over budget" warning for never letting a crash through, which
/// compiler.md's "MANDATORY pre-check" framing demands. Colour-sets larger than
/// `cap` are excluded here (they are the separate per-tile >15-colour Tier 2
/// case) so they do not distort the palette count.
fn pack_palettes(color_sets: &HashSet<BTreeSet<[u8; 3]>>, cap: u32) -> u32 {
    let cap = cap as usize;
    let mut sets: Vec<&BTreeSet<[u8; 3]>> = color_sets
        .iter()
        .filter(|s| !s.is_empty() && s.len() <= cap)
        .collect();
    // Decreasing size, then by contents, for a deterministic packing.
    sets.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.iter().cmp(b.iter())));

    let mut bins: Vec<BTreeSet<[u8; 3]>> = Vec::new();
    for set in sets {
        let mut placed = false;
        for bin in bins.iter_mut() {
            let union = bin.union(set).count();
            if union <= cap {
                bin.extend(set.iter().copied());
                placed = true;
                break;
            }
        }
        if !placed {
            let mut bin = BTreeSet::new();
            bin.extend(set.iter().copied());
            bins.push(bin);
        }
    }
    bins.len() as u32
}

/// A member's contribution to a metric, for "largest contributors" in messages.
struct Contribution {
    name: String,
    metric: u32,
}

/// Format up to three largest contributors as a plain list.
fn contributors(mut items: Vec<Contribution>) -> String {
    items.sort_by(|a, b| b.metric.cmp(&a.metric));
    items
        .into_iter()
        .filter(|c| c.metric > 0)
        .take(3)
        .map(|c| format!("\"{}\"", c.name))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Compute the budget report for a tileset from its decoded members. Pure.
pub fn compute(members: &[MemberArt], budgets: Budgets) -> TilesetBudget {
    let cap = budgets.colors_per_palette;

    // Global accumulators.
    let mut canonical_tiles: HashSet<TilePattern> = HashSet::new();
    let mut raw_tiles: HashSet<TilePattern> = HashSet::new();
    let mut color_sets: HashSet<BTreeSet<[u8; 3]>> = HashSet::new();
    let mut metatile_total: u32 = 0;
    let mut unrepresentable = false;

    // Per-member contribution metrics (index-aligned with `members`).
    let mut member_colors: Vec<BTreeSet<[u8; 3]>> = vec![BTreeSet::new(); members.len()];
    let mut member_tiles: Vec<HashSet<TilePattern>> = vec![HashSet::new(); members.len()];
    let mut member_metatiles: Vec<u32> = vec![0; members.len()];
    // Objects with an 8x8 tile exceeding the per-tile colour limit, and the
    // worst count seen. Keyed by member index to keep one problem per object.
    let mut overcolor: HashMap<usize, u32> = HashMap::new();

    for (mi, m) in members.iter().enumerate() {
        let cols = m.width.div_ceil(METATILE_PX);
        let rows = m.height.div_ceil(METATILE_PX);
        member_metatiles[mi] = cols * rows;
        metatile_total += cols * rows;

        for cell_row in 0..rows {
            for cell_col in 0..cols {
                let mut top_used = false;
                let mut middle_used = false;
                for (layer, used_flag) in
                    [(Layer::Top, true), (Layer::Middle, false)]
                {
                    for sy in 0..2 {
                        for sx in 0..2 {
                            let pattern = tile_pattern(m, layer, cell_col, cell_row, sx, sy);
                            if is_empty(&pattern) {
                                continue;
                            }
                            if used_flag {
                                top_used = true;
                            } else {
                                middle_used = true;
                            }
                            let colors = tile_colors(&pattern);
                            if colors.len() as u32 > cap {
                                let e = overcolor.entry(mi).or_insert(0);
                                *e = (*e).max(colors.len() as u32);
                            }
                            member_colors[mi].extend(colors.iter().copied());
                            color_sets.insert(colors);

                            let canon = canonical(&pattern);
                            canonical_tiles.insert(canon);
                            member_tiles[mi].insert(canon);
                            raw_tiles.insert(pattern);
                        }
                    }
                }
                // Bottom is never painted by occlusion-only routing (MVP), so
                // this can only be Empty or Normal today; the check is honest.
                if infer_layer_type(false, middle_used, top_used) == CellLayer::Unrepresentable {
                    unrepresentable = true;
                }
            }
        }
    }

    let palettes_used = pack_palettes(&color_sets, cap);
    let tiles_min = canonical_tiles.len() as u32;
    let tiles_max = raw_tiles.len() as u32;

    let palettes = Meter {
        used: palettes_used,
        total: budgets.palettes,
    };
    let tiles = TileMeter {
        used_min: tiles_min,
        used_max: tiles_max,
        total: budgets.tiles,
    };
    let metatiles = Meter {
        used: metatile_total,
        total: budgets.metatiles,
    };

    let problems = build_problems(
        members,
        &palettes,
        &tiles,
        &metatiles,
        &member_colors,
        &member_tiles,
        &member_metatiles,
        &overcolor,
        unrepresentable,
    );

    TilesetBudget {
        palettes,
        tiles,
        metatiles,
        problems,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_problems(
    members: &[MemberArt],
    palettes: &Meter,
    tiles: &TileMeter,
    metatiles: &Meter,
    member_colors: &[BTreeSet<[u8; 3]>],
    member_tiles: &[HashSet<TilePattern>],
    member_metatiles: &[u32],
    overcolor: &HashMap<usize, u32>,
    unrepresentable: bool,
) -> Vec<Problem> {
    let mut problems = Vec::new();

    // Three depth planes in one cell (dormant in MVP; see infer_layer_type).
    if unrepresentable {
        problems.push(Problem {
            tier: Tier::Tileset,
            message: "This tileset needs the player both in front of and behind things in one \
                      16x16 area. Simplify the overlap there."
                .to_string(),
        });
    }

    // Per-tile colour limit. This is a hardware limit on a single 8x8 area, not
    // a shared budget, so naming the object is fair and actionable (unlike the
    // budget cases below, which are never a single object's fault).
    let mut over: Vec<(usize, u32)> = overcolor.iter().map(|(&i, &n)| (i, n)).collect();
    over.sort_by_key(|&(i, _)| i);
    for (i, n) in over {
        problems.push(Problem {
            tier: Tier::Tileset,
            message: format!(
                "In \"{}\", a small 8x8 area uses {n} colours; Pokemon Emerald allows 15 per \
                 tile. Reduce the colours in that area.",
                members[i].name
            ),
        });
    }

    // Palette budget: MANDATORY (Porytiles panics past it). Never a single
    // object's fault - list the biggest colour users as shared contributors.
    if palettes.used > palettes.total {
        let contrib = contributors(
            members
                .iter()
                .enumerate()
                .map(|(i, m)| Contribution {
                    name: m.name.clone(),
                    metric: member_colors[i].len() as u32,
                })
                .collect(),
        );
        problems.push(Problem {
            tier: Tier::Tileset,
            message: format!(
                "This tileset needs {} colour groups (palettes); Pokemon Emerald allows {} for a \
                 secondary tileset. Remove objects or align their colours so they share palettes. \
                 Biggest colour users: {contrib}.",
                palettes.used, palettes.total
            ),
        });
    }

    // Tile budget: uses the flip-aware count Porytiles actually emits.
    if tiles.used_min > tiles.total {
        let contrib = contributors(
            members
                .iter()
                .enumerate()
                .map(|(i, m)| Contribution {
                    name: m.name.clone(),
                    metric: member_tiles[i].len() as u32,
                })
                .collect(),
        );
        problems.push(Problem {
            tier: Tier::Tileset,
            message: format!(
                "This tileset has too much unique detail: {} tiles of {} allowed. Reuse artwork \
                 or remove an object. Largest contributors: {contrib}.",
                tiles.used_min, tiles.total
            ),
        });
    }

    // Metatile budget.
    if metatiles.used > metatiles.total {
        let contrib = contributors(
            members
                .iter()
                .enumerate()
                .map(|(i, m)| Contribution {
                    name: m.name.clone(),
                    metric: member_metatiles[i],
                })
                .collect(),
        );
        problems.push(Problem {
            tier: Tier::Tileset,
            message: format!(
                "This tileset has too many 16x16 blocks: {} of {} allowed. Remove an object. \
                 Largest contributors: {contrib}.",
                metatiles.used, metatiles.total
            ),
        });
    }

    problems
}

/// A member Object with its artwork decoded from disk: the shared input for
/// budget prediction (M9) and export (M10). Both paths load members through
/// `load_members`, so they can never disagree about membership, pixel data, or
/// stale-id handling - the reconciliation compiler.md's determinism note asks
/// for is structural, not by convention.
pub struct LoadedMember {
    pub object: crate::object::Object,
    pub art: crate::artwork::DecodedArtwork,
}

impl LoadedMember {
    /// The budget-maths view of this member.
    pub fn member_art(&self) -> MemberArt {
        MemberArt {
            name: self.object.name.clone(),
            width: self.art.width,
            height: self.art.height,
            pixels: self.art.pixels.clone(),
            occluding: self.object.occlusion.pixels.clone(),
        }
    }
}

/// Read a tileset and its members' decoded artwork from disk. Members keep the
/// tileset's stable authoring order (the exporter's layout order). Returns a
/// plain error string for the UI.
pub fn load_members(
    project_dir: &str,
    tileset_id: &str,
) -> Result<(crate::tileset::Tileset, Vec<LoadedMember>), String> {
    let open = crate::project::read(project_dir).map_err(|e| e.to_string())?;
    let tileset = open
        .project
        .tilesets
        .iter()
        .find(|t| t.id == tileset_id)
        .cloned()
        .ok_or_else(|| "Tileset not found.".to_string())?;

    let mut members = Vec::with_capacity(tileset.members.len());
    for member_id in &tileset.members {
        // A membership id that no longer resolves to an Object is skipped
        // rather than fatal: deletion scrubs ids, but a stale hand-edited file
        // should still budget/export the objects it can find.
        let Some(obj) = open.project.objects.iter().find(|o| &o.id == member_id) else {
            continue;
        };
        let art = crate::object::decode_artwork(project_dir, &obj.id)
            .map_err(|e| format!("Could not read artwork for \"{}\": {e}", obj.name))?;
        members.push(LoadedMember {
            object: obj.clone(),
            art,
        });
    }
    Ok((tileset, members))
}

/// Read a tileset's members from disk, decode their artwork, and compute the
/// budget. The fs-touching orchestration behind the IPC command; the maths lives
/// in `compute`. Returns a plain error string for the UI.
pub fn compute_for_tileset(project_dir: &str, tileset_id: &str) -> Result<TilesetBudget, String> {
    let (_tileset, loaded) = load_members(project_dir, tileset_id)?;
    let members: Vec<MemberArt> = loaded.iter().map(LoadedMember::member_art).collect();
    Ok(compute(&members, crate::pokemon_emerald::secondary_budgets()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budgets() -> Budgets {
        crate::pokemon_emerald::secondary_budgets()
    }

    /// A solid `width`x`height` member filled with a single opaque colour, no
    /// occlusion. One colour-set, one distinct tile (all subtiles identical).
    fn solid(name: &str, width: u32, height: u32, color: [u8; 3]) -> MemberArt {
        let px = [color[0], color[1], color[2], 255];
        MemberArt {
            name: name.to_string(),
            width,
            height,
            pixels: vec![px; (width * height) as usize],
            occluding: BTreeSet::new(),
        }
    }

    /// A 16x16 member where every 8x8 tile contains exactly `n` distinct
    /// colours, so each tile needs an `n`-colour palette. The colour is keyed by
    /// the position *within* the 8x8 tile (0..64), guaranteeing all `n` colours
    /// land in one tile rather than aligning to columns. Colours are offset by
    /// `base` so separate members get disjoint colour sets.
    fn palette_hog(name: &str, n: u32, base: u8) -> MemberArt {
        let mut pixels = vec![[0u8, 0, 0, 255]; 256];
        for y in 0..16u32 {
            for x in 0..16u32 {
                let pos = (y % 8) * 8 + (x % 8); // 0..64 within the tile
                let c = (pos % n) as u8;
                pixels[(y * 16 + x) as usize] = [base.wrapping_add(c), 0, 0, 255];
            }
        }
        MemberArt {
            name: name.to_string(),
            width: 16,
            height: 16,
            pixels,
            occluding: BTreeSet::new(),
        }
    }

    #[test]
    fn empty_tileset_uses_nothing() {
        let report = compute(&[], budgets());
        assert_eq!(report.palettes.used, 0);
        assert_eq!(report.tiles.used_min, 0);
        assert_eq!(report.metatiles.used, 0);
        assert!(report.problems.is_empty());
    }

    #[test]
    fn fully_transparent_object_costs_nothing() {
        // Alpha-0 and magenta pixels both consume no colour and emit no tile.
        let mut m = solid("Ghost", 16, 16, [10, 20, 30]);
        for p in m.pixels.iter_mut() {
            p[3] = 0; // fully transparent
        }
        let magenta = solid("Sentinel", 16, 16, [255, 0, 255]);

        let report = compute(&[m], budgets());
        assert_eq!(report.tiles.used_min, 0);
        assert_eq!(report.palettes.used, 0);
        // Metatiles still count: the cell exists in the footprint.
        assert_eq!(report.metatiles.used, 1);
        assert!(report.problems.is_empty());

        let report2 = compute(&[magenta], budgets());
        assert_eq!(report2.tiles.used_min, 0);
        assert_eq!(report2.palettes.used, 0);
    }

    #[test]
    fn solid_object_is_one_tile_one_palette() {
        let report = compute(&[solid("Rock", 16, 16, [1, 2, 3])], budgets());
        assert_eq!(report.tiles.used_min, 1);
        assert_eq!(report.tiles.used_max, 1);
        assert_eq!(report.palettes.used, 1);
        assert_eq!(report.metatiles.used, 1); // one 16x16 cell
        assert!(report.problems.is_empty());
    }

    #[test]
    fn metatile_count_is_footprint_cells() {
        // 32x48 -> 2x3 = 6 cells.
        let report = compute(&[solid("Tree", 32, 48, [1, 2, 3])], budgets());
        assert_eq!(report.metatiles.used, 6);
    }

    #[test]
    fn identical_tiles_dedupe() {
        // Two separate solid objects of the same colour share one tile shape.
        let report = compute(
            &[solid("A", 16, 16, [9, 9, 9]), solid("B", 16, 16, [9, 9, 9])],
            budgets(),
        );
        assert_eq!(report.tiles.used_min, 1);
        assert_eq!(report.palettes.used, 1);
        assert_eq!(report.metatiles.used, 2);
    }

    #[test]
    fn flips_collapse_in_lower_bound_but_not_upper() {
        // A tile that is not symmetric under h-flip, plus its mirror: flip-aware
        // dedup counts 1, flip-naive counts 2.
        let px = [7u8, 7, 7, 255];
        let clear = [0u8, 0, 0, 0];
        // Two members whose single 8x8 top-left tile is asymmetric: A paints the
        // tile's left 4 columns, B paints its right 4 columns. The two tiles are
        // horizontal mirrors, so flip-aware dedup collapses them but flip-naive
        // counting keeps both.
        let mut left = vec![clear; 256];
        let mut right = vec![clear; 256];
        for y in 0..8u32 {
            for x in 0..4u32 {
                left[(y * 16 + x) as usize] = px;
            }
            for x in 4..8u32 {
                right[(y * 16 + x) as usize] = px;
            }
        }
        let a = MemberArt {
            name: "L".into(),
            width: 16,
            height: 16,
            pixels: left,
            occluding: BTreeSet::new(),
        };
        let b = MemberArt {
            name: "R".into(),
            width: 16,
            height: 16,
            pixels: right,
            occluding: BTreeSet::new(),
        };
        let report = compute(&[a, b], budgets());
        assert_eq!(report.tiles.used_min, 1, "flip-aware dedup collapses mirrors");
        assert_eq!(report.tiles.used_max, 2, "flip-naive keeps both");
    }

    #[test]
    fn tile_over_fifteen_colors_fires_named_problem() {
        // 16 distinct colours in one object -> per-tile colour violation.
        let report = compute(&[palette_hog("Rainbow", 16, 0)], budgets());
        assert!(report
            .problems
            .iter()
            .any(|p| p.tier == Tier::Tileset
                && p.message.contains("Rainbow")
                && p.message.contains("colours")));
    }

    #[test]
    fn fifteen_colors_in_one_tile_is_fine() {
        let report = compute(&[palette_hog("Fine", 15, 0)], budgets());
        assert_eq!(report.palettes.used, 1);
        assert!(report.problems.is_empty());
    }

    #[test]
    fn ten_objects_that_fit_alone_overflow_the_palette_budget_together() {
        // The plan's acceptance test: ten objects each with a disjoint 15-colour
        // palette. Each fits alone (1 <= 7 palettes); together they need 10
        // disjoint palettes > the 7-palette secondary budget, and Porytiles
        // would PANIC. Atlas must predict this before any compile.
        let members: Vec<MemberArt> = (0..10u8)
            .map(|k| palette_hog(&format!("Obj{k}"), 15, k * 20))
            .collect();

        // Each alone is well within budget.
        for m in &members {
            let solo = compute(std::slice::from_ref(m), budgets());
            assert_eq!(solo.palettes.used, 1);
            assert!(solo.palettes.used <= solo.palettes.total);
            assert!(solo.problems.is_empty());
        }

        let report = compute(&members, budgets());
        assert_eq!(report.palettes.used, 10, "ten disjoint palettes cannot merge");
        assert!(report.palettes.used > report.palettes.total);
        let palette_problem = report
            .problems
            .iter()
            .find(|p| p.message.contains("colour groups"))
            .expect("palette-budget problem must fire");
        assert_eq!(palette_problem.tier, Tier::Tileset);
        // Never blamed on a single object; framed as the tileset's problem.
        assert!(palette_problem.message.contains("This tileset needs"));
        assert!(palette_problem.message.contains("Biggest colour users"));
    }

    #[test]
    fn disjoint_palettes_pack_one_each() {
        // Two members with disjoint 15-colour sets need two palettes.
        let a = palette_hog("A", 15, 0);
        let b = palette_hog("B", 15, 100);
        let report = compute(&[a, b], budgets());
        assert_eq!(report.palettes.used, 2);
        assert!(report.problems.is_empty());
    }

    #[test]
    fn shared_colors_pack_together() {
        // Two members using the SAME 15 colours share one palette.
        let a = palette_hog("A", 15, 0);
        let b = palette_hog("B", 15, 0);
        let report = compute(&[a, b], budgets());
        assert_eq!(report.palettes.used, 1);
    }

    #[test]
    fn ffd_merges_small_sets_within_capacity() {
        // Three 5-colour disjoint sets pack into one 15-colour palette.
        let mut sets: HashSet<BTreeSet<[u8; 3]>> = HashSet::new();
        sets.insert((0..5u8).map(|c| [c, 0, 0]).collect());
        sets.insert((5..10u8).map(|c| [c, 0, 0]).collect());
        sets.insert((10..15u8).map(|c| [c, 0, 0]).collect());
        assert_eq!(pack_palettes(&sets, 15), 1);
    }

    #[test]
    fn layer_type_inference_matches_engine_rules() {
        assert_eq!(infer_layer_type(false, false, false), CellLayer::Empty);
        assert_eq!(infer_layer_type(false, true, true), CellLayer::Normal);
        assert_eq!(infer_layer_type(true, true, false), CellLayer::Covered);
        assert_eq!(infer_layer_type(true, false, true), CellLayer::Split);
        assert_eq!(
            infer_layer_type(true, true, true),
            CellLayer::Unrepresentable
        );
    }

    #[test]
    fn occlusion_routes_pixels_to_top_layer() {
        // Occluding the whole object moves every pixel to the top layer; colour
        // and tile counts are unchanged (still one tile, one palette). This
        // guards that routing does not drop or double-count pixels.
        let mut m = solid("Canopy", 16, 16, [4, 5, 6]);
        m.occluding = (0..256u32).collect();
        let report = compute(&[m], budgets());
        assert_eq!(report.tiles.used_min, 1);
        assert_eq!(report.palettes.used, 1);
    }

    #[test]
    fn determinism_same_input_same_output() {
        let members = vec![
            palette_hog("A", 15, 0),
            palette_hog("B", 15, 40),
            solid("C", 32, 16, [1, 1, 1]),
        ];
        let first = compute(&members, budgets());
        let second = compute(&members, budgets());
        assert_eq!(first, second);
    }
}
