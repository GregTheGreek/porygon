//! Occlusion layer stored on an Object (Milestone 7).
//!
//! Occlusion answers one question per pixel: "should the player render *behind*
//! this?" compiler.md is explicit that this mask is **pixel-level**, not per
//! metatile like collision:
//!
//!   * Inputs: "Occlusion mask (pixel-level: 'player renders behind these
//!     pixels')".
//!   * Priority/occlusion: "Occlusion boundaries need not align to tile edges -
//!     within a cell, non-occluding pixels are simply transparent on the top
//!     layer."
//!   * Decomposition step 3 routes *pixels*: occluding pixels -> top.png,
//!     non-occluding pixels -> middle.png. The routing IS the layer-type choice.
//!
//! So the granularity here is a single artwork pixel. Choosing per-metatile
//! (like collision) would quantise the canopy edge to 16px blocks and feed the
//! decomposition a coarser mask than the one it consumes - the exact mismatch
//! the milestone warns against. The preview (frontend) therefore occludes per
//! pixel too, matching this storage exactly.
//!
//! Storage is sparse, reusing collision.rs's philosophy: "not occluding" (render
//! in front of / below the player) dominates a typical object, so we persist
//! only the occluding pixels, as a `BTreeSet` of row-major pixel indices
//! (`y * width + x`). Occlusion is binary, so a set suffices where collision
//! needs a value map. The `BTreeSet` keeps the serialized order stable (sorted),
//! which keeps project.json diffs deterministic and supports the exporter's
//! byte-identical-output rule.
//!
//! Encoding tradeoff: a large contiguous occluding region (a full tree canopy)
//! serializes to a long index array, heavier than collision's handful of cells.
//! For MVP-scale prop artwork this stays small and keeps everything - undo,
//! IPC, migration - parallel to M6 with no new dependencies. If large objects
//! become common, switch the encoding to per-row run-lengths without changing
//! the public shape. This is deliberately the simplest correct storage, not the
//! densest.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// A per-object occlusion mask, stored sparsely as its occluding pixels.
///
/// The set holds only occluding pixels (absence means "render in front of the
/// player"). That sparse invariant is maintained where the painting happens -
/// the frontend removes an index when it erases - so Rust simply serializes and
/// deserializes whatever crosses the IPC boundary.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Occlusion {
    /// Occluding pixels keyed by row-major index (`y * width + x`).
    #[serde(default)]
    pub pixels: BTreeSet<u32>,
}

/// The number of pixels an artwork of `width` x `height` contains, i.e. the
/// exclusive upper bound for a valid occlusion pixel index.
pub fn pixel_count(width: u32, height: u32) -> u32 {
    width * height
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_count_is_area() {
        assert_eq!(pixel_count(32, 48), 1536);
        assert_eq!(pixel_count(16, 16), 256);
    }

    #[test]
    fn occlusion_round_trips_through_json() {
        let mut o = Occlusion::default();
        o.pixels.insert(0);
        o.pixels.insert(69);
        o.pixels.insert(5);

        let json = serde_json::to_string(&o).unwrap();
        let back: Occlusion = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
        assert_eq!(back.pixels.len(), 3);
        assert!(back.pixels.contains(&69));
    }

    #[test]
    fn serialization_is_sparse_and_ordered() {
        // Only occluding pixels appear, sorted ascending (BTreeSet), so diffs
        // stay minimal and stable across saves.
        let mut o = Occlusion::default();
        o.pixels.insert(9);
        o.pixels.insert(2);
        o.pixels.insert(9); // duplicate is absorbed by the set
        let json = serde_json::to_string(&o).unwrap();
        assert_eq!(json, r#"{"pixels":[2,9]}"#);
    }

    #[test]
    fn deserializing_dedupes_and_sorts() {
        // An unsorted array with a duplicate normalises on load, so an untidy
        // payload from the frontend can never break determinism.
        let o: Occlusion = serde_json::from_str(r#"{"pixels":[9,2,9,2]}"#).unwrap();
        assert_eq!(o.pixels.len(), 2);
        assert_eq!(o.pixels.iter().copied().collect::<Vec<_>>(), vec![2, 9]);
    }
}
