//! Collision layer stored on an Object (Milestone 6).
//!
//! The engine resolves collision per metatile, so Atlas paints per metatile: a
//! grid of 16x16 cells covering the artwork (`cols = ceil(width/16)`,
//! `rows = ceil(height/16)`). Every cell is Walkable by default; the artist
//! paints Blocked or a Custom semantic tag onto the exceptions.
//!
//! Storage is sparse. Walkable dominates a typical object, so we persist only
//! the non-Walkable cells, keyed by row-major cell index, in a `BTreeMap`. The
//! `BTreeMap` keeps the serialized order stable (sorted by index), which keeps
//! project.json diffs minimal and supports the exporter's determinism rule.
//!
//! Core stores an opaque tag string for Custom cells; it never learns what a
//! tag means. The `pokemon_emerald` module owns the tag vocabulary and the
//! mapping to engine behavior values (see `pokemon_emerald.rs`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Collision cell size in pixels: one metatile, matching the anchor grid.
pub const CELL: u32 = 16;

/// One collision cell's value. Mirrors `CollisionValue` in the frontend.
///
/// `Walkable` is the default and is never stored in the sparse map (its absence
/// means Walkable) - it is the value the frontend paints to erase a cell, and is
/// modelled here so the shared value type round-trips if one is ever present.
/// Custom carries an opaque tag the engine module resolves to a behavior.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CollisionValue {
    Walkable,
    Blocked,
    Custom(String),
}

/// A per-object collision grid, stored sparsely as its non-Walkable cells.
///
/// The map holds only non-Walkable cells (Walkable is the absence of a key).
/// That sparse invariant is maintained where the painting happens - the
/// frontend deletes a cell's key when it paints Walkable/erase - so Rust simply
/// serializes and deserializes whatever crosses the IPC boundary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Collision {
    /// Non-Walkable cells keyed by row-major cell index (`row * cols + col`).
    #[serde(default)]
    pub cells: BTreeMap<u32, CollisionValue>,
}

/// The collision grid dimensions (cols, rows) that cover the given artwork.
///
/// `ceil(dim / 16)`, so a partially-filled edge metatile still gets a cell.
pub fn grid_dims(width: u32, height: u32) -> (u32, u32) {
    (width.div_ceil(CELL), height.div_ceil(CELL))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_dims_ceil_to_cover_partial_edges() {
        assert_eq!(grid_dims(32, 48), (2, 3)); // exact multiples
        assert_eq!(grid_dims(16, 16), (1, 1));
        assert_eq!(grid_dims(1, 1), (1, 1)); // tiny artwork still gets one cell
        assert_eq!(grid_dims(33, 17), (3, 2)); // 33 -> 3 cols, 17 -> 2 rows
    }

    #[test]
    fn collision_round_trips_through_json() {
        let mut c = Collision::default();
        c.cells.insert(0, CollisionValue::Blocked);
        c.cells
            .insert(3, CollisionValue::Custom("tall_grass".to_string()));
        c.cells.insert(7, CollisionValue::Blocked);

        let json = serde_json::to_string(&c).unwrap();
        let back: Collision = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c);
        assert_eq!(back.cells.len(), 3);
        assert_eq!(
            back.cells.get(&3),
            Some(&CollisionValue::Custom("tall_grass".to_string()))
        );
    }

    #[test]
    fn serialization_is_sparse_and_ordered() {
        // Only non-Walkable cells appear, sorted by index (BTreeMap), so diffs
        // stay minimal and stable across saves.
        let mut c = Collision::default();
        c.cells.insert(9, CollisionValue::Blocked);
        c.cells.insert(2, CollisionValue::Blocked);
        let json = serde_json::to_string(&c).unwrap();
        assert_eq!(json, r#"{"cells":{"2":"Blocked","9":"Blocked"}}"#);
    }
}
