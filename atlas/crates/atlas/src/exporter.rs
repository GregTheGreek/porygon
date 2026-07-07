//! The Pokemon exporter (Milestone 10): compiler.md's decomposition as real
//! files on disk. M10 writes the Porytiles-ready source project plus Atlas's
//! Compiled Object artifacts; it never invokes Porytiles (that is M11).
//!
//! ## What is emitted (all shapes trace to compiler.md / Spike 0 FINDINGS)
//!
//! `<dest>/<tileset-slug>/`
//!   `porytiles_src/bottom.png` `middle.png` `top.png`
//!       Layer PNGs: a shared grid of 16x16 metatile cells, row-major, RGBA
//!       8-bit non-interlaced (compiler.md "Target"; golden snapshot
//!       `spikes/spike0/tree_tileset/porytiles_src/`). Transparency is written
//!       as fully-transparent pixels (0,0,0,0), matching the verified golden
//!       snapshot byte-for-byte in convention; source pixels that are alpha-0
//!       OR the magenta 255,0,255 sentinel both count as transparent (the same
//!       rule the M9 budget maths uses, shared via `budgets::is_transparent`).
//!   `porytiles_src/attributes.csv`
//!       Header exactly `id,behavior`; sparse rows; `id` = 0-based metatile
//!       index in the layer-sheet row-major order; behavior = `MB_*` enum name
//!       resolved from the cell's Custom collision tag via the pokemon_emerald
//!       vocabulary (compiler.md decomposition step 5 / FINDINGS attributes.csv
//!       section).
//!   `<object-slug>.atlasobject` (one per member Object)
//!       The Compiled Object: how the Object maps onto the emitted metatiles -
//!       global metatile ids (secondary ids start at 512), arrangement,
//!       dimensions, anchor (compiler.md "Compiled Objects and Prefabs").
//!
//! ## Layout rule (compiler.md decomposition step 4)
//!
//! "Lay out all metatiles into the three layer PNGs (row-major, shared grid)."
//! Cells are emitted as one flat sequence: members in the tileset's stable
//! authoring order, each member's cells row-major over its own 16px grid. The
//! sequence fills a sheet `min(total, 8)` metatiles wide, row-major. compiler.md
//! fixes the order but not the sheet width; 8 cells (128px) matches Porytiles'
//! own bootstrap sheet width (FINDINGS "Bootstrap default 128x16") and is the
//! conservative choice. Trailing cells in the last row are fully transparent
//! padding; they carry no attributes and belong to no object. Padding can never
//! break the 512-metatile gate: rounding up to a multiple of 8 cannot cross 512.
//!
//! ## Pixel routing (compiler.md decomposition step 3)
//!
//! Occluding pixels -> top.png, everything else -> middle.png; bottom.png is
//! reserved for under-detail and stays empty in the MVP. Layer type is never
//! authored - Porytiles infers it from which layers carry pixels.
//!
//! ## Determinism
//!
//! Byte-identical output for identical input: members and cells iterate in
//! stable order, collision/occlusion are BTree collections, PNG encoding pins
//! its settings explicitly (RGBA8, non-interlaced, Balanced compression,
//! NoFilter), JSON fields are declared in sorted-key order, and nothing in the
//! output carries a timestamp. compiler.md: "Re-exporting an unchanged project
//! must produce an empty diff."
//!
//! ## Gating (no partial output)
//!
//! Export refuses when any member has Tier 1 problems, when the Tier 2 budget
//! prediction reports problems (compiler.md's tiers; the palette pre-check is
//! mandatory because Porytiles panics past the budget), or when a collision tag
//! cannot be resolved to an MB_* behavior. All bytes are composed in memory
//! first, written to a temp directory beside the destination, and moved into
//! place only on success - the artist never sees a half-written export.
//!
//! ## Ambiguities resolved conservatively (flagged per the epistemic rule)
//!
//! * Sheet width: compiler.md does not fix it; 8 cells matches the Porytiles
//!   bootstrap default (see Layout rule above).
//! * Walkable/Blocked cells emit NO attributes.csv row: compiler.md maps only
//!   "collision tags -> MB_* names", passability is a Porymap-side property,
//!   and rows are explicitly sparse (absent id = behavior 0 = MB_NORMAL).
//! * `.atlasobject` encoding: the docs specify content, not encoding; this
//!   module uses pretty-printed JSON with keys in sorted order.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::budgets::{self, LoadedMember, MemberArt};
use crate::collision::{grid_dims, CollisionValue};
use crate::object::Anchor;
use crate::pokemon_emerald::{self, METATILE_PX};

/// Widest the layer sheets grow, in metatile cells (128px). See module docs.
const SHEET_MAX_WIDTH_CELLS: u32 = 8;
/// First global metatile id of a secondary tileset (compiler.md "Compiled
/// Objects and Prefabs": secondary IDs start at 512).
pub(crate) const SECONDARY_METATILE_BASE: u32 = 512;
/// Schema version stamped into every .atlasobject.
const ATLASOBJECT_VERSION: u32 = 1;
/// The Porytiles source subdirectory name (compiler.md "Target").
const PORYTILES_SRC_DIR: &str = "porytiles_src";

/// Returned to the UI on success: where the export landed.
#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub path: String,
}

/// One cell of a Compiled Object. Field declaration order is alphabetical so
/// the serialized JSON has sorted keys.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct CompiledCell {
    /// MB_* behavior emitted for this cell, or null (Walkable/Blocked).
    behavior: Option<String>,
    /// The authored collision value (serde shape shared with project.json).
    pub(crate) collision: CollisionValue,
    /// Global metatile id (secondary base 512 + row-major sheet index).
    pub(crate) metatile_id: u32,
    /// Cell column within the object's own 16px grid.
    pub(crate) x: u32,
    /// Cell row within the object's own 16px grid.
    pub(crate) y: u32,
}

/// A Compiled Object (.atlasobject): the mapping from one Object to the
/// emitted metatiles. Fields alphabetical for sorted-key JSON. Also the input
/// to prefab emission (M11), so its fields are crate-visible.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct CompiledObject {
    anchor: Anchor,
    /// Cells row-major over the object's grid; ids are global and contiguous.
    pub(crate) cells: Vec<CompiledCell>,
    pub(crate) cols: u32,
    format_version: u32,
    height: u32,
    id: String,
    pub(crate) name: String,
    pub(crate) rows: u32,
    /// The tileset this object was compiled into (name, for humans).
    tileset: String,
    width: u32,
}

/// Everything an export writes, composed fully in memory before any fs work so
/// a failure can never leave partial output.
pub(crate) struct Bundle {
    pub(crate) bottom_png: Vec<u8>,
    pub(crate) middle_png: Vec<u8>,
    pub(crate) top_png: Vec<u8>,
    pub(crate) attributes_csv: String,
    /// (file name, pretty JSON) per member object, in member order.
    objects: Vec<(String, String)>,
}

/// Export one tileset into `<dest_dir>/<tileset-slug>/`. Reads project state
/// from disk (the caller persists first), never mutates it.
pub fn export_tileset(
    project_dir: &str,
    tileset_id: &str,
    dest_dir: &str,
) -> Result<ExportResult, String> {
    let (tileset, members) = budgets::load_members(project_dir, tileset_id)?;
    gate(&members)?;
    let (bundle, _compiled) = compose(&tileset.name, &members)?;

    let dest = Path::new(dest_dir);
    if !dest.is_dir() {
        return Err("The destination folder does not exist.".to_string());
    }
    let slug = slugify(&tileset.name, "tileset");
    let final_dir = dest.join(&slug);
    // Stage in a sibling temp dir (same filesystem, so the final rename is
    // atomic-ish) and clean it up on any failure: no partial output, ever.
    let tmp_dir = dest.join(format!(".{slug}.export-tmp"));
    if tmp_dir.exists() {
        fs::remove_dir_all(&tmp_dir).map_err(|e| fs_err("clear a stale temp folder", &e))?;
    }

    let staged = write_bundle(&tmp_dir, &bundle).and_then(|()| {
        if final_dir.exists() {
            fs::remove_dir_all(&final_dir)
                .map_err(|e| fs_err("replace the previous export", &e))?;
        }
        fs::rename(&tmp_dir, &final_dir).map_err(|e| fs_err("move the export into place", &e))
    });
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    Ok(ExportResult {
        path: final_dir.to_string_lossy().into_owned(),
    })
}

fn fs_err(what: &str, e: &std::io::Error) -> String {
    format!("Export failed: could not {what} ({e}). Nothing was exported.")
}

/// Refuse the export while anything would make it invalid, listing every
/// blocker in artist terms. Tier 1 problems are prefixed with the object's
/// name; Tier 2 problems come straight from the budget prediction (the same
/// messages the Problems panel shows).
pub(crate) fn gate(members: &[LoadedMember]) -> Result<(), String> {
    let mut blockers: Vec<String> = Vec::new();

    if members.is_empty() {
        blockers.push("This tileset has no objects. Add objects before exporting.".to_string());
    }

    for m in members {
        // Tier 1 sweeps the member and everything composed into it (M12): a
        // child's problem corrupts the flattened result just the same. The
        // member + descendants set is exactly the graph reachable through
        // children, which is all the cycle check needs to see.
        let scope: Vec<crate::object::Object> = std::iter::once(m.object.clone())
            .chain(m.descendants.iter().cloned())
            .collect();
        for p in crate::validity::object_problems(&m.object, &scope) {
            blockers.push(format!("\"{}\": {}", m.object.name, p.message));
        }
        for d in &m.descendants {
            for p in crate::validity::object_problems(d, &scope) {
                blockers.push(format!(
                    "\"{}\" (inside \"{}\"): {}",
                    d.name, m.object.name, p.message
                ));
            }
        }
    }

    if !members.is_empty() {
        let art: Vec<MemberArt> = members.iter().map(LoadedMember::member_art).collect();
        let budget = budgets::compute(&art, pokemon_emerald::secondary_budgets());
        blockers.extend(budget.problems.into_iter().map(|p| p.message));
    }

    // Pre-resolve every Custom tag: an unknown tag would otherwise surface as a
    // raw Porytiles "unknown metatile behavior" error at Tier 3. The flattened
    // collision is checked (not just the member's own) so tags painted on
    // children are covered too - it is what compose actually emits.
    let behaviors = behavior_map();
    for m in members {
        for value in m.flat.collision.values() {
            if let CollisionValue::Custom(tag) = value {
                if !behaviors.contains_key(tag.as_str()) {
                    blockers.push(format!(
                        "\"{}\" uses a collision tag (\"{tag}\") this version of Porygon does \
                         not recognize. Re-paint that collision cell.",
                        m.object.name
                    ));
                }
            }
        }
    }

    if blockers.is_empty() {
        Ok(())
    } else {
        blockers.dedup();
        Err(format!(
            "Export was stopped, so no files were written:\n- {}",
            blockers.join("\n- ")
        ))
    }
}

/// Custom collision tag -> MB_* behavior name, from the engine vocabulary.
fn behavior_map() -> BTreeMap<String, String> {
    pokemon_emerald::collision_tags()
        .into_iter()
        .map(|t| (t.tag, t.behavior))
        .collect()
}

/// One emitted cell: which member it came from and its cell coordinates on
/// that member's own 16px grid.
struct CellRef {
    member: usize,
    col: u32,
    row: u32,
}

/// Compose the full export in memory. Pure apart from reading the engine
/// vocabulary; deterministic by construction.
pub(crate) fn compose(
    tileset_name: &str,
    members: &[LoadedMember],
) -> Result<(Bundle, Vec<CompiledObject>), String> {
    // Flat cell sequence: members in authoring order, cells row-major each,
    // over each member's COMPOSED grid (children flattened in, M12).
    let mut cells: Vec<CellRef> = Vec::new();
    for (mi, m) in members.iter().enumerate() {
        let (cols, rows) = grid_dims(m.flat.width, m.flat.height);
        for row in 0..rows {
            for col in 0..cols {
                cells.push(CellRef {
                    member: mi,
                    col,
                    row,
                });
            }
        }
    }
    let total = cells.len() as u32;
    if total == 0 {
        return Err("This tileset has no artwork to export.".to_string());
    }

    let sheet_cols = total.min(SHEET_MAX_WIDTH_CELLS);
    let sheet_rows = total.div_ceil(sheet_cols);
    let width = sheet_cols * METATILE_PX;
    let height = sheet_rows * METATILE_PX;
    let blank = vec![[0u8; 4]; (width * height) as usize];
    let (mut middle, mut top) = (blank.clone(), blank.clone());
    let bottom = blank; // reserved for under-detail; empty in the MVP

    for (i, c) in cells.iter().enumerate() {
        let m = &members[c.member];
        let dest_x = (i as u32 % sheet_cols) * METATILE_PX;
        let dest_y = (i as u32 / sheet_cols) * METATILE_PX;
        for py in 0..METATILE_PX {
            for px in 0..METATILE_PX {
                let gx = c.col * METATILE_PX + px;
                let gy = c.row * METATILE_PX + py;
                // Pixels past the artwork edge stay transparent padding; the
                // Tier 1 gate already refused off-grid artwork.
                if gx >= m.flat.width || gy >= m.flat.height {
                    continue;
                }
                let idx = gy * m.flat.width + gx;
                let p = m.flat.pixels[idx as usize];
                if budgets::is_transparent(p) {
                    continue;
                }
                let dest = ((dest_y + py) * width + dest_x + px) as usize;
                // Alpha is normalised to opaque: the GBA palette is RGB and the
                // budget maths keys colours by RGB for the same reason.
                let out = [p[0], p[1], p[2], 255];
                if m.flat.occlusion.contains(&idx) {
                    top[dest] = out;
                } else {
                    middle[dest] = out;
                }
            }
        }
    }

    // attributes.csv (sparse) and the Compiled Objects, in one pass over the
    // same cell sequence so ids can never drift between the two.
    let behaviors = behavior_map();
    let mut csv = String::from("id,behavior\n");
    let mut compiled: Vec<Vec<CompiledCell>> = members.iter().map(|_| Vec::new()).collect();
    for (i, c) in cells.iter().enumerate() {
        let m = &members[c.member];
        let (cols, _) = grid_dims(m.flat.width, m.flat.height);
        let cell_index = c.row * cols + c.col;
        let collision = m
            .flat
            .collision
            .get(&cell_index)
            .cloned()
            .unwrap_or(CollisionValue::Walkable);
        let behavior = match &collision {
            CollisionValue::Custom(tag) => Some(
                behaviors
                    .get(tag.as_str())
                    .ok_or_else(|| {
                        // The gate already refused this; kept as a hard error
                        // so compose alone can never emit an unknown name.
                        format!("Unknown collision tag \"{tag}\".")
                    })?
                    .clone(),
            ),
            CollisionValue::Walkable | CollisionValue::Blocked => None,
        };
        if let Some(b) = &behavior {
            csv.push_str(&format!("{i},{b}\n"));
        }
        compiled[c.member].push(CompiledCell {
            behavior,
            collision,
            metatile_id: SECONDARY_METATILE_BASE + i as u32,
            x: c.col,
            y: c.row,
        });
    }

    let mut objects = Vec::with_capacity(members.len());
    let mut compiled_objects = Vec::with_capacity(members.len());
    let mut used_names: Vec<String> = Vec::new();
    for (m, obj_cells) in members.iter().zip(compiled) {
        let (cols, rows) = grid_dims(m.flat.width, m.flat.height);
        let base = slugify(&m.object.name, "object");
        let name = dedupe_name(&base, &mut used_names);
        // The Compiled Object records the FLATTENED object (compiler.md: the
        // exporter flattens the graph): composed dims, composed anchor.
        let compiled_object = CompiledObject {
            anchor: m.flat.anchor,
            cells: obj_cells,
            cols,
            format_version: ATLASOBJECT_VERSION,
            height: m.flat.height,
            id: m.object.id.clone(),
            name: m.object.name.clone(),
            rows,
            tileset: tileset_name.to_string(),
            width: m.flat.width,
        };
        let json = serde_json::to_string_pretty(&compiled_object)
            .map_err(|e| format!("Could not encode \"{}\": {e}", m.object.name))?;
        objects.push((format!("{name}.atlasobject"), json + "\n"));
        compiled_objects.push(compiled_object);
    }

    Ok((
        Bundle {
            bottom_png: encode_png(width, height, &bottom)?,
            middle_png: encode_png(width, height, &middle)?,
            top_png: encode_png(width, height, &top)?,
            attributes_csv: csv,
            objects,
        },
        compiled_objects,
    ))
}

/// Encode RGBA pixels to PNG bytes with every setting pinned (RGBA 8-bit,
/// non-interlaced, Balanced compression, NoFilter) so encoding is
/// settings-stable: identical pixels always produce identical bytes. Also
/// used by the canvas composition (scene.rs), so preview and export share
/// one encoder.
pub(crate) fn encode_png(width: u32, height: u32, pixels: &[[u8; 4]]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Balanced);
    // set_compression resets the filter, so pin the filter after it.
    encoder.set_filter(png::Filter::NoFilter);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("Could not encode a layer image: {e}"))?;
    let flat: Vec<u8> = pixels.iter().flatten().copied().collect();
    writer
        .write_image_data(&flat)
        .map_err(|e| format!("Could not encode a layer image: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("Could not encode a layer image: {e}"))?;
    Ok(bytes)
}

/// Write the composed bundle under `dir` (created fresh by the caller's temp
/// path). Any error aborts; the caller removes the temp directory.
fn write_bundle(dir: &Path, bundle: &Bundle) -> Result<(), String> {
    let src = dir.join(PORYTILES_SRC_DIR);
    fs::create_dir_all(&src).map_err(|e| fs_err("create the export folder", &e))?;
    let write = |path: &Path, data: &[u8]| -> Result<(), String> {
        fs::write(path, data).map_err(|e| fs_err("write an export file", &e))
    };
    write(&src.join("bottom.png"), &bundle.bottom_png)?;
    write(&src.join("middle.png"), &bundle.middle_png)?;
    write(&src.join("top.png"), &bundle.top_png)?;
    write(&src.join("attributes.csv"), bundle.attributes_csv.as_bytes())?;
    for (name, json) in &bundle.objects {
        write(&dir.join(name), json.as_bytes())?;
    }
    Ok(())
}

/// Lowercase a free-text name into a filesystem-safe snake_case slug
/// (compiler.md's slug convention covers gTileset_* symbols; free-text names
/// get the same shape: lowercase alphanumerics joined by single underscores).
pub(crate) fn slugify(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut pending_sep = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_sep && !out.is_empty() {
                out.push('_');
            }
            pending_sep = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_sep = true;
        }
    }
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

/// A free-text tileset name to its Porytiles `gTileset_*` symbol: the slug's
/// words CamelCased and prefixed (compiler.md "Symbol-to-slug" run in reverse -
/// `slug` strips `gTileset_` and snake-cases, so this is the inverse and stays
/// consistent with `slugify`: `slugify(symbolize(n)-minus-prefix) == slugify(n)`).
/// Falls back to `Tileset` so an all-punctuation name still yields a valid C
/// identifier.
pub(crate) fn symbolize(name: &str) -> String {
    let slug = slugify(name, "tileset");
    let mut camel = String::new();
    for word in slug.split('_') {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            camel.push(first.to_ascii_uppercase());
            camel.extend(chars);
        }
    }
    format!("gTileset_{camel}")
}

/// Write only the Porytiles source assets (the four layer/attribute files) into
/// an existing `porytiles_src` directory - the M11 compile path writes them
/// straight into the managed tileset rather than into a fresh export tree.
pub(crate) fn write_source_layers(src_dir: &Path, bundle: &Bundle) -> Result<(), String> {
    fs::create_dir_all(src_dir).map_err(|e| fs_err("create the tileset source folder", &e))?;
    let write = |path: PathBuf, data: &[u8]| -> Result<(), String> {
        fs::write(path, data).map_err(|e| fs_err("write a tileset source file", &e))
    };
    write(src_dir.join("bottom.png"), &bundle.bottom_png)?;
    write(src_dir.join("middle.png"), &bundle.middle_png)?;
    write(src_dir.join("top.png"), &bundle.top_png)?;
    write(src_dir.join("attributes.csv"), bundle.attributes_csv.as_bytes())?;
    Ok(())
}

/// Deduplicate a slug against names already taken, deterministically:
/// second occurrence becomes `<base>_2`, then `<base>_3`, in member order.
fn dedupe_name(base: &str, used: &mut Vec<String>) -> String {
    let mut candidate = base.to_string();
    let mut n = 1;
    while used.contains(&candidate) {
        n += 1;
        candidate = format!("{base}_{n}");
    }
    used.push(candidate.clone());
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object::{Object, ARTWORK_FILE, OBJECTS_DIR};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("atlas-exp-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Write a real RGBA PNG for an object's artwork.
    fn write_artwork(project: &Path, id: &str, w: u32, h: u32, pixels: &[[u8; 4]]) {
        let dir = project.join(OBJECTS_DIR).join(id);
        fs::create_dir_all(&dir).unwrap();
        let file = fs::File::create(dir.join(ARTWORK_FILE)).unwrap();
        let mut enc = png::Encoder::new(file, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().unwrap();
        let flat: Vec<u8> = pixels.iter().flatten().copied().collect();
        writer.write_image_data(&flat).unwrap();
        writer.finish().unwrap();
    }

    /// Build a project on disk with the given objects (artwork included) and
    /// one tileset containing all of them, returning (project_dir, tileset_id).
    fn project_with(objects: Vec<(Object, Vec<[u8; 4]>)>) -> (PathBuf, String) {
        let loc = temp_dir("proj");
        let open = crate::project::create(loc.to_str().unwrap(), "P").unwrap();
        let project_dir = PathBuf::from(&open.path);
        let mut project = open.project;
        let mut tileset = crate::tileset::Tileset::new("Forest Set");
        for (obj, pixels) in objects {
            write_artwork(&project_dir, &obj.id, obj.width, obj.height, &pixels);
            tileset.members.push(obj.id.clone());
            project.objects.push(obj);
        }
        let tileset_id = tileset.id.clone();
        project.tilesets.push(tileset);
        crate::project::save(open.path.as_str(), project).unwrap();
        (project_dir, tileset_id)
    }

    /// A solid-colour object; `occlude_all` routes every pixel to the top layer.
    fn solid_object(name: &str, w: u32, h: u32, rgb: [u8; 3], occlude_all: bool) -> (Object, Vec<[u8; 4]>) {
        let mut obj = Object::for_test(name, w, h);
        if occlude_all {
            obj.occlusion.pixels = (0..w * h).collect();
        }
        let pixels = vec![[rgb[0], rgb[1], rgb[2], 255]; (w * h) as usize];
        (obj, pixels)
    }

    fn decode(path: &Path) -> (u32, u32, Vec<[u8; 4]>) {
        let d = crate::artwork::decode_rgba(path.to_str().unwrap()).unwrap();
        (d.width, d.height, d.pixels)
    }

    /// Recursively collect (relative path, bytes) sorted by path.
    fn snapshot(dir: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for entry in fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(base, &path, out);
                } else {
                    let rel = path.strip_prefix(base).unwrap().to_string_lossy().into_owned();
                    out.push((rel, fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    #[test]
    fn export_writes_the_porytiles_source_tree() {
        let (project, tileset_id) =
            project_with(vec![solid_object("Rock", 16, 16, [10, 20, 30], false)]);
        let dest = temp_dir("dest");
        let result =
            export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
                .unwrap();
        let root = PathBuf::from(&result.path);
        assert!(root.ends_with("forest_set"));
        for f in ["bottom.png", "middle.png", "top.png", "attributes.csv"] {
            assert!(root.join(PORYTILES_SRC_DIR).join(f).exists(), "missing {f}");
        }
        assert!(root.join("rock.atlasobject").exists());
    }

    #[test]
    fn golden_shape_single_object_routes_layers_and_pads_nothing() {
        // One 16x16 object: left half plain, right half occluded. Hand-computed
        // expectations: a 16x16 sheet (1 cell, no padding), middle carries the
        // left half, top the right half, bottom fully transparent.
        let mut obj = Object::for_test("Tree", 16, 16);
        let mut pixels = vec![[0u8; 4]; 256];
        for y in 0..16u32 {
            for x in 0..16u32 {
                pixels[(y * 16 + x) as usize] = [100, 150, 200, 255];
                if x >= 8 {
                    obj.occlusion.pixels.insert(y * 16 + x);
                }
            }
        }
        let (project, tileset_id) = project_with(vec![(obj, pixels)]);
        let dest = temp_dir("golden");
        let result =
            export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
                .unwrap();
        let src = PathBuf::from(&result.path).join(PORYTILES_SRC_DIR);

        let (w, h, top) = decode(&src.join("top.png"));
        assert_eq!((w, h), (16, 16), "one cell means a 16x16 sheet, no padding");
        let (_, _, middle) = decode(&src.join("middle.png"));
        let (_, _, bottom) = decode(&src.join("bottom.png"));
        for y in 0..16u32 {
            for x in 0..16u32 {
                let i = (y * 16 + x) as usize;
                let (on, off) = if x >= 8 { (&top, &middle) } else { (&middle, &top) };
                assert_eq!(on[i], [100, 150, 200, 255], "painted layer at {x},{y}");
                assert_eq!(off[i][3], 0, "other layer transparent at {x},{y}");
                assert_eq!(bottom[i][3], 0, "bottom stays empty in the MVP");
            }
        }
        assert_eq!(
            fs::read_to_string(src.join("attributes.csv")).unwrap(),
            "id,behavior\n",
            "no custom tags means a header-only sparse csv"
        );
    }

    #[test]
    fn attributes_csv_maps_custom_tags_and_skips_walkable_blocked() {
        // 32x16 object = cells 0,1. Cell 0: Custom tall_grass; cell 1: Blocked.
        let (mut obj, pixels) = solid_object("Grass", 32, 16, [1, 2, 3], false);
        obj.collision
            .cells
            .insert(0, CollisionValue::Custom("tall_grass".to_string()));
        obj.collision.cells.insert(1, CollisionValue::Blocked);
        let (project, tileset_id) = project_with(vec![(obj, pixels)]);
        let dest = temp_dir("csv");
        let result =
            export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
                .unwrap();
        let csv = fs::read_to_string(
            PathBuf::from(&result.path).join(PORYTILES_SRC_DIR).join("attributes.csv"),
        )
        .unwrap();
        // Blocked (like Walkable) is passability, not behavior: no row.
        assert_eq!(csv, "id,behavior\n0,MB_TALL_GRASS\n");
    }

    #[test]
    fn atlasobject_records_global_ids_arrangement_and_attributes() {
        let (mut a, pa) = solid_object("Tree", 16, 16, [1, 2, 3], false);
        a.collision
            .cells
            .insert(0, CollisionValue::Custom("ice".to_string()));
        let (b, pb) = solid_object("Rock", 32, 16, [4, 5, 6], false);
        let (project, tileset_id) = project_with(vec![(a, pa), (b, pb)]);
        let dest = temp_dir("obj");
        let result =
            export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
                .unwrap();
        let root = PathBuf::from(&result.path);

        let tree: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("tree.atlasobject")).unwrap())
                .unwrap();
        assert_eq!(tree["format_version"], 1);
        assert_eq!(tree["name"], "Tree");
        assert_eq!(tree["tileset"], "Forest Set");
        assert_eq!(tree["cells"][0]["metatile_id"], 512);
        assert_eq!(tree["cells"][0]["behavior"], "MB_ICE");
        assert_eq!(tree["cells"][0]["collision"], serde_json::json!({"Custom": "ice"}));

        // Rock's two cells follow Tree's single cell in the shared sheet.
        let rock: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("rock.atlasobject")).unwrap())
                .unwrap();
        assert_eq!(rock["cols"], 2);
        assert_eq!(rock["rows"], 1);
        assert_eq!(rock["cells"][0]["metatile_id"], 513);
        assert_eq!(rock["cells"][0]["x"], 0);
        assert_eq!(rock["cells"][1]["metatile_id"], 514);
        assert_eq!(rock["cells"][1]["x"], 1);
        assert_eq!(rock["cells"][0]["behavior"], serde_json::Value::Null);
        assert_eq!(rock["cells"][0]["collision"], "Walkable");
    }

    #[test]
    fn layout_appends_members_row_major_and_pads_the_last_row() {
        // 9 cells total (one 48x48 = 9 cells... use 3 objects: 4+4+1) -> sheet
        // 8 cells wide, 2 rows, cells 9..15 transparent padding.
        let (a, pa) = solid_object("A", 32, 32, [10, 0, 0], false); // 4 cells
        let (b, pb) = solid_object("B", 32, 32, [0, 10, 0], false); // 4 cells
        let (c, pc) = solid_object("C", 16, 16, [0, 0, 10], false); // 1 cell
        let (project, tileset_id) = project_with(vec![(a, pa), (b, pb), (c, pc)]);
        let dest = temp_dir("layout");
        let result =
            export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
                .unwrap();
        let src = PathBuf::from(&result.path).join(PORYTILES_SRC_DIR);
        let (w, h, middle) = decode(&src.join("middle.png"));
        assert_eq!((w, h), (128, 32));

        // Sample one pixel per emitted cell: colour identifies the member.
        let sample = |cell: u32| middle[((cell / 8) * 16 * 128 + (cell % 8) * 16) as usize];
        // A's 4 cells (row-major over its own 2x2 grid) occupy sheet cells 0-3.
        for cell in 0..4 {
            assert_eq!(sample(cell), [10, 0, 0, 255], "A at sheet cell {cell}");
        }
        for cell in 4..8 {
            assert_eq!(sample(cell), [0, 10, 0, 255], "B at sheet cell {cell}");
        }
        assert_eq!(sample(8), [0, 0, 10, 255], "C at sheet cell 8");
        for cell in 9..16 {
            assert_eq!(sample(cell)[3], 0, "padding cell {cell} is transparent");
        }
    }

    #[test]
    fn export_is_byte_identical_across_runs() {
        let (mut a, pa) = solid_object("Tree", 32, 48, [30, 60, 90], false);
        a.occlusion.pixels = (0..(32 * 32)).collect(); // canopy occludes
        a.collision
            .cells
            .insert(4, CollisionValue::Custom("tall_grass".to_string()));
        a.collision.cells.insert(5, CollisionValue::Blocked);
        let (b, pb) = solid_object("Rock", 16, 16, [7, 7, 7], false);
        let (project, tileset_id) = project_with(vec![(a, pa), (b, pb)]);

        let dest1 = temp_dir("det1");
        let dest2 = temp_dir("det2");
        let r1 = export_tileset(project.to_str().unwrap(), &tileset_id, dest1.to_str().unwrap())
            .unwrap();
        let r2 = export_tileset(project.to_str().unwrap(), &tileset_id, dest2.to_str().unwrap())
            .unwrap();

        let s1 = snapshot(Path::new(&r1.path));
        let s2 = snapshot(Path::new(&r2.path));
        assert!(!s1.is_empty());
        assert_eq!(s1.len(), s2.len());
        for ((p1, b1), (p2, b2)) in s1.iter().zip(s2.iter()) {
            assert_eq!(p1, p2);
            assert_eq!(b1, b2, "file {p1} differs between identical exports");
        }
    }

    #[test]
    fn re_export_replaces_the_previous_output() {
        let (project, tileset_id) =
            project_with(vec![solid_object("Rock", 16, 16, [9, 9, 9], false)]);
        let dest = temp_dir("replace");
        let r1 = export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
            .unwrap();
        let r2 = export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
            .unwrap();
        assert_eq!(r1.path, r2.path);
        assert_eq!(snapshot(Path::new(&r1.path)), snapshot(Path::new(&r2.path)));
    }

    #[test]
    fn over_budget_tileset_is_refused_with_no_output() {
        // 16 distinct colours inside one 8x8 tile: a Tier 2 per-tile colour
        // violation, so the gate must refuse and write nothing.
        let mut obj = Object::for_test("Rainbow", 16, 16);
        let mut pixels = vec![[0u8, 0, 0, 255]; 256];
        for y in 0..16u32 {
            for x in 0..16u32 {
                let pos = (y % 8) * 8 + (x % 8);
                pixels[(y * 16 + x) as usize] = [(pos % 16) as u8, 0, 0, 255];
            }
        }
        obj.occlusion.pixels.clear();
        let (project, tileset_id) = project_with(vec![(obj, pixels)]);
        let dest = temp_dir("gate");
        let err = export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
            .unwrap_err();
        assert!(err.contains("no files were written"), "got: {err}");
        assert!(err.contains("Rainbow"), "problem names the object: {err}");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "no partial output");
    }

    #[test]
    fn tier_one_problem_is_refused_with_no_output() {
        // Off-grid artwork (30x16) is a Tier 1 problem: export refuses it
        // rather than silently padding.
        let (project, tileset_id) =
            project_with(vec![solid_object("Odd", 30, 16, [1, 1, 1], false)]);
        let dest = temp_dir("tier1");
        let err = export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
            .unwrap_err();
        assert!(err.contains("\"Odd\""), "blocker names the object: {err}");
        assert!(err.contains("16px"), "got: {err}");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
    }

    #[test]
    fn unknown_collision_tag_is_refused_with_no_output() {
        let (mut obj, pixels) = solid_object("Sign", 16, 16, [1, 1, 1], false);
        obj.collision
            .cells
            .insert(0, CollisionValue::Custom("not_a_real_tag".to_string()));
        let (project, tileset_id) = project_with(vec![(obj, pixels)]);
        let dest = temp_dir("tag");
        let err = export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
            .unwrap_err();
        assert!(err.contains("not_a_real_tag"), "got: {err}");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
    }

    #[test]
    fn empty_tileset_is_refused() {
        let (project, tileset_id) = project_with(vec![]);
        let dest = temp_dir("empty");
        let err = export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
            .unwrap_err();
        assert!(err.contains("no objects"), "got: {err}");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
    }

    #[test]
    fn transparent_and_magenta_pixels_emit_as_transparency() {
        // Alpha-0 and magenta source pixels both become fully transparent in
        // the emitted sheets (the shared is_transparent rule).
        let mut pixels = vec![[5u8, 5, 5, 255]; 256];
        pixels[0] = [255, 0, 255, 255]; // magenta sentinel
        pixels[1] = [9, 9, 9, 0]; // alpha-0
        let obj = Object::for_test("Mix", 16, 16);
        let (project, tileset_id) = project_with(vec![(obj, pixels)]);
        let dest = temp_dir("transp");
        let result =
            export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
                .unwrap();
        let (_, _, middle) =
            decode(&PathBuf::from(&result.path).join(PORYTILES_SRC_DIR).join("middle.png"));
        assert_eq!(middle[0], [0, 0, 0, 0]);
        assert_eq!(middle[1], [0, 0, 0, 0]);
        assert_eq!(middle[2], [5, 5, 5, 255]);
    }

    #[test]
    fn duplicate_object_names_get_deterministic_files() {
        let (a, pa) = solid_object("Tree", 16, 16, [1, 1, 1], false);
        let (b, pb) = solid_object("Tree", 16, 16, [2, 2, 2], false);
        let (project, tileset_id) = project_with(vec![(a, pa), (b, pb)]);
        let dest = temp_dir("dup");
        let result =
            export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
                .unwrap();
        let root = PathBuf::from(&result.path);
        assert!(root.join("tree.atlasobject").exists());
        assert!(root.join("tree_2.atlasobject").exists());
    }

    #[test]
    fn slugify_is_stable_and_safe() {
        assert_eq!(slugify("Forest Set", "tileset"), "forest_set");
        assert_eq!(slugify("  My--Cool  Set!! ", "tileset"), "my_cool_set");
        assert_eq!(slugify("!!!", "tileset"), "tileset");
        assert_eq!(slugify("Tileset 1", "tileset"), "tileset_1");
    }

    #[test]
    fn symbolize_camel_cases_the_slug_words() {
        // Porytiles derives the on-disk slug from the symbol by snake-casing the
        // CamelCase (gTileset_ForestSet -> forest_set), which must match the slug
        // the exporter computes with `slugify` from the same name. Both derive
        // from the name, so they agree by construction; these anchor the shape.
        assert_eq!(symbolize("Forest Set"), "gTileset_ForestSet");
        assert_eq!(symbolize("atlas spike"), "gTileset_AtlasSpike");
        assert_eq!(symbolize("!!!"), "gTileset_Tileset");
    }

    /// Build a project whose objects may reference each other as children,
    /// with one tileset containing only `member_ids`.
    fn project_with_graph(
        objects: Vec<(Object, Vec<[u8; 4]>)>,
        member_ids: Vec<String>,
    ) -> (PathBuf, String) {
        let loc = temp_dir("graph");
        let open = crate::project::create(loc.to_str().unwrap(), "P").unwrap();
        let project_dir = PathBuf::from(&open.path);
        let mut project = open.project;
        let mut tileset = crate::tileset::Tileset::new("Set");
        tileset.members = member_ids;
        for (obj, pixels) in objects {
            write_artwork(&project_dir, &obj.id, obj.width, obj.height, &pixels);
            project.objects.push(obj);
        }
        let tileset_id = tileset.id.clone();
        project.tilesets.push(tileset);
        crate::project::save(open.path.as_str(), project).unwrap();
        (project_dir, tileset_id)
    }

    #[test]
    fn children_flatten_into_the_member_before_decomposition() {
        use crate::object::{Anchor, ChildPlacement};
        // A 16x16 parent with a 16x16 child to its right. The child is NOT a
        // tileset member but is composed into the parent (M12): the emitted
        // sheet, attributes.csv, budgets, and the .atlasobject all reflect
        // the flattened 2x1 grid, through the one shared flattening path.
        let (mut parent, ppx) = solid_object("House", 16, 16, [1, 1, 1], false);
        parent.anchor = Anchor { x: 0, y: 0 };
        let (mut child, cpx) = solid_object("Sign", 16, 16, [2, 2, 2], false);
        child.anchor = Anchor { x: 0, y: 0 };
        child
            .collision
            .cells
            .insert(0, CollisionValue::Custom("tall_grass".to_string()));
        parent.children.push(ChildPlacement {
            object_id: child.id.clone(),
            x: 16,
            y: 0,
        });
        let member_ids = vec![parent.id.clone()];
        let (project, tileset_id) =
            project_with_graph(vec![(parent, ppx), (child, cpx)], member_ids);

        // Budgets see the composed grid: 2 metatiles, 2 tile shapes.
        let budget =
            budgets::compute_for_tileset(project.to_str().unwrap(), &tileset_id).unwrap();
        assert_eq!(budget.metatiles.used, 2);
        assert!(budget.problems.is_empty());

        let dest = temp_dir("m12");
        let result =
            export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
                .unwrap();
        let root = PathBuf::from(&result.path);

        // Sheet: parent pixels in cell 0, child pixels in cell 1.
        let (w, h, middle) = decode(&root.join(PORYTILES_SRC_DIR).join("middle.png"));
        assert_eq!((w, h), (32, 16));
        assert_eq!(middle[0], [1, 1, 1, 255]);
        assert_eq!(middle[16], [2, 2, 2, 255]);

        // The child's custom tag flows into attributes.csv at the composed cell.
        let csv = fs::read_to_string(root.join(PORYTILES_SRC_DIR).join("attributes.csv"))
            .unwrap();
        assert_eq!(csv, "id,behavior\n1,MB_TALL_GRASS\n");

        // One .atlasobject (members only), reflecting the flattened object.
        let house: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("house.atlasobject")).unwrap())
                .unwrap();
        assert_eq!(house["cols"], 2);
        assert_eq!(house["rows"], 1);
        assert_eq!(house["width"], 32);
        assert_eq!(house["cells"][1]["behavior"], "MB_TALL_GRASS");
        assert!(!root.join("sign.atlasobject").exists());

        // Determinism holds for composed objects too.
        let dest2 = temp_dir("m12det");
        let r2 = export_tileset(project.to_str().unwrap(), &tileset_id, dest2.to_str().unwrap())
            .unwrap();
        assert_eq!(snapshot(&root), snapshot(Path::new(&r2.path)));
    }

    #[test]
    fn cyclic_children_are_refused_with_no_output() {
        use crate::object::ChildPlacement;
        let (mut a, pa) = solid_object("A", 16, 16, [1, 1, 1], false);
        let (mut b, pb) = solid_object("B", 16, 16, [2, 2, 2], false);
        a.children.push(ChildPlacement {
            object_id: b.id.clone(),
            x: 16,
            y: 0,
        });
        b.children.push(ChildPlacement {
            object_id: a.id.clone(),
            x: 16,
            y: 0,
        });
        let member_ids = vec![a.id.clone()];
        let (project, tileset_id) = project_with_graph(vec![(a, pa), (b, pb)], member_ids);
        let dest = temp_dir("cycle");
        let err = export_tileset(project.to_str().unwrap(), &tileset_id, dest.to_str().unwrap())
            .unwrap_err();
        assert!(err.contains("inside itself"), "got: {err}");
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "no partial output");
    }

    #[test]
    fn compose_returns_one_compiled_object_per_member() {
        let members = {
            let (project, tileset_id) = project_with(vec![
                solid_object("Tree", 16, 16, [1, 2, 3], false),
                solid_object("Rock", 32, 16, [4, 5, 6], false),
            ]);
            budgets::load_members(project.to_str().unwrap(), &tileset_id).unwrap().1
        };
        let (_, compiled) = compose("Set", &members).unwrap();
        assert_eq!(compiled.len(), 2);
        assert_eq!(compiled[0].name, "Tree");
        assert_eq!(compiled[0].cells[0].metatile_id, SECONDARY_METATILE_BASE);
        // Rock's first cell follows Tree's single cell.
        assert_eq!(compiled[1].cells[0].metatile_id, SECONDARY_METATILE_BASE + 1);
        assert_eq!(compiled[1].cols, 2);
    }
}
