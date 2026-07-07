//! Porymap prefab emission (Milestone 11).
//!
//! After a successful Porytiles compile, Atlas writes one Porymap prefab per
//! member Object into `<project>/prefabs.json`, so the compiled objects drop
//! straight onto a map in Porymap. The on-disk shape is verified against Porymap
//! source in `spikes/spike0/PREFAB-FINDINGS.md`; everything here follows that
//! document exactly.
//!
//! ## Shape (PREFAB-FINDINGS section 2)
//!
//! A top-level JSON **array** of prefab objects, each
//! `{name, width, height, primary_tileset, secondary_tileset, metatiles[]}`
//! with sparse cells `{x, y, metatile_id, collision, elevation}`. Keys are plain
//! decimal numbers; no `id`/`version`/wrapper fields (Porymap drops them).
//!
//! ## Merge strategy (milestone: "must not clobber unrelated prefabs")
//!
//! Existing entries are parsed as opaque JSON values and preserved verbatim,
//! except entries whose `(name, secondary_tileset)` collide with one we are
//! writing - those are replaced, so a re-compile updates its own prefabs in
//! place without duplicating them and without touching anyone else's. A
//! prefabs.json that is not a JSON array is treated as an error rather than
//! overwritten, so unknown content is never lost.
//!
//! ## Value rules (PREFAB-FINDINGS section 5, gotcha 7)
//!
//! * `primary_tileset` is empty (Atlas only emits secondary metatiles, ids from
//!   512 up); `secondary_tileset` is the managed tileset's `gTileset_*` symbol,
//!   which must match the map's tileset label exactly or the prefab stays hidden.
//! * `collision`: painted Blocked -> 1 (impassable), everything else -> 0
//!   (passable). Collision is passability; terrain behaviors like tall grass or
//!   water are passable, so only Blocked maps to 1. (Ambiguity flagged in the
//!   report: Custom terrain tags are treated as passable here.)
//! * `elevation`: 3 for every cell - the vanilla passable-ground elevation
//!   PREFAB-FINDINGS names as the sensible default.
//! * Cells are validated before writing (in-range coords and metatile id);
//!   Porymap silently drops invalid cells, so Atlas checks them itself.
//!
//! ## Config wiring (PREFAB-FINDINGS section 3, gotcha 6)
//!
//! `porymap.project.cfg` needs `prefabs_filepath=prefabs.json` and
//! `prefabs_import_prompted=1` (else Porymap's first-open dialog can overwrite
//! the file with defaults). Both keys are set while preserving every other line.

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::{json, Value};

use crate::exporter::CompiledObject;
use crate::pokemon_emerald::METATILES_TOTAL;

/// The prefabs file at the project root (PREFAB-FINDINGS: default `prefabs.json`).
const PREFABS_FILE: &str = "prefabs.json";
/// Porymap's shared project config that points at the prefabs file.
const PORYMAP_CFG: &str = "porymap.project.cfg";
/// Vanilla passable-ground elevation (PREFAB-FINDINGS gotcha 7).
const DEFAULT_ELEVATION: i64 = 3;

/// Where prefabs landed and how many entries Atlas wrote, for the success
/// message. Serialized to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct PrefabResult {
    pub prefabs_path: String,
    pub written: usize,
}

/// Porymap collision value for a painted collision (Blocked = impassable = 1).
fn collision_value(c: &crate::collision::CollisionValue) -> i64 {
    match c {
        crate::collision::CollisionValue::Blocked => 1,
        _ => 0,
    }
}

/// Build the prefab JSON for one compiled object. Returns `None` if no cell is
/// valid (nothing worth writing). Invalid cells are dropped with the same bounds
/// Porymap would apply, so what Atlas writes is exactly what Porymap will load.
fn build_prefab(secondary_symbol: &str, obj: &CompiledObject) -> Option<Value> {
    let mut cells = Vec::new();
    for cell in &obj.cells {
        if cell.x >= obj.cols || cell.y >= obj.rows || cell.metatile_id >= METATILES_TOTAL {
            continue;
        }
        cells.push(json!({
            "x": cell.x,
            "y": cell.y,
            "metatile_id": cell.metatile_id,
            "collision": collision_value(&cell.collision),
            "elevation": DEFAULT_ELEVATION,
        }));
    }
    if cells.is_empty() {
        return None;
    }
    Some(json!({
        "name": obj.name,
        "width": obj.cols,
        "height": obj.rows,
        "primary_tileset": "",
        "secondary_tileset": secondary_symbol,
        "metatiles": cells,
    }))
}

/// True when `entry` is one of the prefabs we are (re)writing: same name and
/// same secondary tileset. Such an entry is replaced; all others are preserved.
fn is_ours(entry: &Value, secondary_symbol: &str, names: &[String]) -> bool {
    let entry_secondary = entry.get("secondary_tileset").and_then(Value::as_str);
    let entry_name = entry.get("name").and_then(Value::as_str).unwrap_or("");
    entry_secondary == Some(secondary_symbol) && names.iter().any(|n| n == entry_name)
}

/// Load the existing prefabs array, or an empty one if the file is absent.
/// A present-but-non-array file is an error (never silently overwritten).
fn load_existing(path: &Path) -> Result<Vec<Value>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            if text.trim().is_empty() {
                return Ok(Vec::new());
            }
            match serde_json::from_str::<Value>(&text) {
                Ok(Value::Array(items)) => Ok(items),
                Ok(_) => Err(format!(
                    "The prefabs file at {} is not a JSON array, so Porygon will not \
                     overwrite it. Move or fix it, then compile again.",
                    path.display()
                )),
                Err(e) => Err(format!(
                    "The prefabs file at {} could not be read ({e}), so Porygon will not \
                     overwrite it. Fix or remove it, then compile again.",
                    path.display()
                )),
            }
        }
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Could not read the prefabs file: {e}")),
    }
}

/// Emit/merge prefabs for every compiled object into `<project>/prefabs.json`
/// and wire `porymap.project.cfg`. Pure-ish: only touches those two files.
pub fn emit_prefabs(
    project_dir: &str,
    secondary_symbol: &str,
    objects: &[CompiledObject],
) -> Result<PrefabResult, String> {
    let prefabs_path = Path::new(project_dir).join(PREFABS_FILE);

    let ours: Vec<Value> = objects
        .iter()
        .filter_map(|o| build_prefab(secondary_symbol, o))
        .collect();
    let names: Vec<String> = objects.iter().map(|o| o.name.clone()).collect();

    let mut merged: Vec<Value> = load_existing(&prefabs_path)?
        .into_iter()
        .filter(|e| !is_ours(e, secondary_symbol, &names))
        .collect();
    let written = ours.len();
    merged.extend(ours);

    let json = serde_json::to_string_pretty(&Value::Array(merged))
        .map_err(|e| format!("Could not encode prefabs: {e}"))?;
    fs::write(&prefabs_path, json + "\n")
        .map_err(|e| format!("Could not write prefabs.json: {e}"))?;

    wire_porymap_cfg(project_dir)?;

    Ok(PrefabResult {
        prefabs_path: prefabs_path.to_string_lossy().into_owned(),
        written,
    })
}

/// Ensure `porymap.project.cfg` points at the prefabs file and suppresses the
/// default-import prompt, preserving every other line. Creates the file if it is
/// missing.
fn wire_porymap_cfg(project_dir: &str) -> Result<(), String> {
    let path = Path::new(project_dir).join(PORYMAP_CFG);
    let existing = fs::read_to_string(&path).unwrap_or_default();

    let wanted = [
        ("prefabs_filepath", PREFABS_FILE.to_string()),
        ("prefabs_import_prompted", "1".to_string()),
    ];

    let mut lines: Vec<String> = Vec::new();
    let mut seen = [false, false];
    for line in existing.lines() {
        let key = line.split('=').next().unwrap_or("").trim();
        let mut replaced = false;
        for (i, (k, v)) in wanted.iter().enumerate() {
            if key == *k {
                lines.push(format!("{k}={v}"));
                seen[i] = true;
                replaced = true;
                break;
            }
        }
        if !replaced {
            lines.push(line.to_string());
        }
    }
    for (i, (k, v)) in wanted.iter().enumerate() {
        if !seen[i] {
            lines.push(format!("{k}={v}"));
        }
    }

    fs::write(&path, lines.join("\n") + "\n")
        .map_err(|e| format!("Could not update porymap.project.cfg: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collision::CollisionValue;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("atlas-prefab-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// A compiled object built by hand from JSON (CompiledObject's fields are
    /// crate-private but it is Deserialize-free, so go through serde_json).
    fn compiled(name: &str, cols: u32, rows: u32, cells: Value) -> CompiledObject {
        let v = json!({
            "anchor": {"x": 0, "y": 0},
            "cells": cells,
            "cols": cols,
            "format_version": 1,
            "height": rows * 16,
            "id": "id",
            "name": name,
            "rows": rows,
            "tileset": "Set",
            "width": cols * 16,
        });
        serde_json::from_value(v).unwrap()
    }

    fn cell(x: u32, y: u32, id: u32, collision: CollisionValue) -> Value {
        // CompiledCell serializes behavior/collision/metatile_id/x/y.
        json!({
            "behavior": Value::Null,
            "collision": collision,
            "metatile_id": id,
            "x": x,
            "y": y,
        })
    }

    #[test]
    fn writes_a_prefab_per_object_with_expected_shape() {
        let dir = temp_dir("shape");
        let obj = compiled(
            "Tree",
            2,
            1,
            json!([
                cell(0, 0, 512, CollisionValue::Walkable),
                cell(1, 0, 513, CollisionValue::Blocked),
            ]),
        );
        let result = emit_prefabs(dir.to_str().unwrap(), "gTileset_Forest", &[obj]).unwrap();
        assert_eq!(result.written, 1);

        let text = fs::read_to_string(dir.join(PREFABS_FILE)).unwrap();
        let arr: Value = serde_json::from_str(&text).unwrap();
        let p = &arr[0];
        assert_eq!(p["name"], "Tree");
        assert_eq!(p["width"], 2);
        assert_eq!(p["primary_tileset"], "");
        assert_eq!(p["secondary_tileset"], "gTileset_Forest");
        assert_eq!(p["metatiles"][0]["metatile_id"], 512);
        assert_eq!(p["metatiles"][0]["collision"], 0);
        assert_eq!(p["metatiles"][0]["elevation"], 3);
        assert_eq!(p["metatiles"][1]["collision"], 1, "Blocked -> collision 1");
    }

    #[test]
    fn merge_preserves_unrelated_prefabs_and_replaces_own() {
        let dir = temp_dir("merge");
        // Seed with an unrelated prefab plus a stale version of ours.
        let seed = json!([
            {"name": "Other", "width": 1, "height": 1, "primary_tileset": "",
             "secondary_tileset": "gTileset_Cave",
             "metatiles": [{"x": 0, "y": 0, "metatile_id": 600, "collision": 0, "elevation": 3}]},
            {"name": "Tree", "width": 1, "height": 1, "primary_tileset": "",
             "secondary_tileset": "gTileset_Forest",
             "metatiles": [{"x": 0, "y": 0, "metatile_id": 999, "collision": 0, "elevation": 3}]}
        ]);
        fs::write(dir.join(PREFABS_FILE), serde_json::to_string_pretty(&seed).unwrap()).unwrap();

        let obj = compiled("Tree", 1, 1, json!([cell(0, 0, 512, CollisionValue::Walkable)]));
        emit_prefabs(dir.to_str().unwrap(), "gTileset_Forest", &[obj]).unwrap();

        let arr: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(PREFABS_FILE)).unwrap()).unwrap();
        let items = arr.as_array().unwrap();
        assert_eq!(items.len(), 2, "unrelated kept, own replaced not duplicated");
        // The unrelated one survives untouched.
        assert!(items.iter().any(|e| e["name"] == "Other" && e["secondary_tileset"] == "gTileset_Cave"));
        // Ours is the fresh version (metatile 512, not the stale 999).
        let tree = items.iter().find(|e| e["name"] == "Tree").unwrap();
        assert_eq!(tree["metatiles"][0]["metatile_id"], 512);
    }

    #[test]
    fn refuses_to_overwrite_a_non_array_file() {
        let dir = temp_dir("nonarray");
        fs::write(dir.join(PREFABS_FILE), r#"{"not":"an array"}"#).unwrap();
        let obj = compiled("Tree", 1, 1, json!([cell(0, 0, 512, CollisionValue::Walkable)]));
        let err = emit_prefabs(dir.to_str().unwrap(), "gTileset_Forest", &[obj]).unwrap_err();
        assert!(err.contains("not a JSON array"), "got: {err}");
        // The original file is untouched.
        assert_eq!(
            fs::read_to_string(dir.join(PREFABS_FILE)).unwrap(),
            r#"{"not":"an array"}"#
        );
    }

    #[test]
    fn wires_porymap_cfg_preserving_other_keys() {
        let dir = temp_dir("cfg");
        fs::write(
            dir.join(PORYMAP_CFG),
            "base_game_version=pokeemerald\nprefabs_import_prompted=0\n",
        )
        .unwrap();
        let obj = compiled("Tree", 1, 1, json!([cell(0, 0, 512, CollisionValue::Walkable)]));
        emit_prefabs(dir.to_str().unwrap(), "gTileset_Forest", &[obj]).unwrap();

        let cfg = fs::read_to_string(dir.join(PORYMAP_CFG)).unwrap();
        assert!(cfg.contains("base_game_version=pokeemerald"), "other keys kept");
        assert!(cfg.contains("prefabs_filepath=prefabs.json"));
        assert!(cfg.contains("prefabs_import_prompted=1"), "flipped to 1, not duplicated");
        assert_eq!(cfg.matches("prefabs_import_prompted").count(), 1);
    }

    #[test]
    fn drops_out_of_range_cells_before_writing() {
        let dir = temp_dir("range");
        // One valid cell, one out-of-grid, one over the metatile ceiling.
        let obj = compiled(
            "Mix",
            1,
            1,
            json!([
                cell(0, 0, 512, CollisionValue::Walkable),
                cell(5, 5, 513, CollisionValue::Walkable),
                cell(0, 0, METATILES_TOTAL, CollisionValue::Walkable),
            ]),
        );
        emit_prefabs(dir.to_str().unwrap(), "gTileset_Forest", &[obj]).unwrap();
        let arr: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(PREFABS_FILE)).unwrap()).unwrap();
        assert_eq!(arr[0]["metatiles"].as_array().unwrap().len(), 1);
    }
}
