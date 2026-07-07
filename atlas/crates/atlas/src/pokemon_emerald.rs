//! The Pokémon Emerald engine module: the first concrete piece of engine
//! knowledge in the crate (Milestone 6).
//!
//! Atlas Core stores an opaque tag on a Custom collision cell; it never learns
//! what a tag means. This module owns the artist-facing vocabulary and its
//! mapping onto real `MB_*` metatile behaviors, so the collision-tag dropdown is
//! sourced from the engine rather than hardcoded in the frontend (per the
//! Bible: "the tag vocabulary is supplied by the engine plugin, not Atlas
//! Core").
//!
//! The `behavior` names below are the exact enum members of pokeemerald's
//! `include/constants/metatile_behaviors.h` (verified against the header, not
//! invented). The exporter (Milestone 10) resolves a cell's `tag` to its
//! `behavior` when emitting `attributes.csv`; Spike 0 confirmed Porytiles reads
//! these `MB_*` names directly.
//!
//! When a second engine target appears this module is extracted into a plugin
//! API. Until then it is a plain module (implementation.md, Repository
//! Structure).

use serde::Serialize;

// --- Tileset budgets (Milestone 9) ------------------------------------------
//
// Every value here is a verified engine constant, not a guess. Sources:
// `include/fieldmap.h` as tabulated in `spikes/spike0/FINDINGS.md` and restated
// in `compiler.md` ("Engine Constraints"). Atlas targets a SECONDARY tileset
// (Spike 0 finding 6 / compiler.md Inputs), which owns the second half of each
// shared budget:
//
//   * NUM_TILES_IN_PRIMARY = 512      -> secondary owns 512 tiles.
//   * NUM_METATILES_IN_PRIMARY = 512  -> secondary owns 512 metatiles.
//   * NUM_PALS_TOTAL 13 - NUM_PALS_IN_PRIMARY 6 = 7 secondary palettes (6-12).
//   * Each 8x8 tile uses one 16-colour palette: 15 usable + 1 transparency.
//   * Geometry: 8px tiles, 16px metatiles (compiler.md "Geometry and layers").
//
// Porytiles PANICS (SIGABRT) when the palette budget is exceeded, so the palette
// prediction is a hard pre-check (compiler.md "Palettes" / FINDINGS finding 3).

/// Tiles a secondary tileset may emit (compiler.md "Tiles and metatiles").
pub const SECONDARY_TILE_BUDGET: u32 = 512;
/// Metatiles a secondary tileset may emit.
pub const SECONDARY_METATILE_BUDGET: u32 = 512;
/// Palette slots a secondary tileset may use (indices 6-12).
pub const SECONDARY_PALETTE_BUDGET: u32 = 7;
/// Usable colours in one palette (the 16th slot is transparency).
pub const COLORS_PER_PALETTE: u32 = 15;
/// Tile edge in pixels.
pub const TILE_PX: u32 = 8;
/// Metatile edge in pixels.
pub const METATILE_PX: u32 = 16;
/// Porytiles' transparency sentinel colour in the layer PNGs (compiler.md
/// "Target"). A pixel of this colour consumes no palette entry.
pub const TRANSPARENT_RGB: [u8; 3] = [255, 0, 255];

/// The budgets that bound one tileset compile. Bundled so the pure budget maths
/// (see `budgets.rs`) takes engine knowledge as data rather than reaching for
/// module constants directly, which keeps a second engine target a drop-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budgets {
    pub tiles: u32,
    pub metatiles: u32,
    pub palettes: u32,
    pub colors_per_palette: u32,
}

/// The budgets for a secondary tileset (Atlas's MVP target).
pub fn secondary_budgets() -> Budgets {
    Budgets {
        tiles: SECONDARY_TILE_BUDGET,
        metatiles: SECONDARY_METATILE_BUDGET,
        palettes: SECONDARY_PALETTE_BUDGET,
        colors_per_palette: COLORS_PER_PALETTE,
    }
}

/// One entry in the custom collision-tag vocabulary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollisionTag {
    /// Stable, opaque identifier stored on the cell (`CollisionValue::Custom`).
    pub tag: String,
    /// Artist-facing name shown in the dropdown.
    pub label: String,
    /// The pokeemerald `MB_*` behavior this tag compiles to.
    pub behavior: String,
}

fn tag(tag: &str, label: &str, behavior: &str) -> CollisionTag {
    CollisionTag {
        tag: tag.to_string(),
        label: label.to_string(),
        behavior: behavior.to_string(),
    }
}

/// The curated custom collision tags Atlas exposes for Pokémon Emerald.
///
/// A deliberately small, artist-meaningful subset of the full behavior table:
/// the terrain and movement behaviors an object author reaches for, each mapped
/// to a real `MB_*` name. It is not the whole enum - obscure map-specific
/// behaviors (gym warps, Sootopolis water, etc.) stay out of the authoring
/// vocabulary.
pub fn collision_tags() -> Vec<CollisionTag> {
    vec![
        tag("tall_grass", "Tall Grass", "MB_TALL_GRASS"),
        tag("long_grass", "Long Grass", "MB_LONG_GRASS"),
        tag("pond_water", "Water (Surfable)", "MB_POND_WATER"),
        tag("deep_water", "Deep Water", "MB_DEEP_WATER"),
        tag("ocean_water", "Ocean Water", "MB_OCEAN_WATER"),
        tag("waterfall", "Waterfall", "MB_WATERFALL"),
        tag("puddle", "Puddle", "MB_PUDDLE"),
        tag("ice", "Ice", "MB_ICE"),
        tag("sand", "Sand", "MB_SAND"),
        tag("jump_north", "Ledge (Jump North)", "MB_JUMP_NORTH"),
        tag("jump_south", "Ledge (Jump South)", "MB_JUMP_SOUTH"),
        tag("jump_east", "Ledge (Jump East)", "MB_JUMP_EAST"),
        tag("jump_west", "Ledge (Jump West)", "MB_JUMP_WEST"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabulary_is_a_sensible_size() {
        // The plan calls for a curated 8-15 tag subset, not the whole enum.
        let tags = collision_tags();
        assert!(
            (8..=15).contains(&tags.len()),
            "expected 8-15 tags, got {}",
            tags.len()
        );
    }

    #[test]
    fn every_entry_is_populated_and_maps_to_an_mb_behavior() {
        for t in collision_tags() {
            assert!(!t.tag.is_empty(), "tag id must not be empty");
            assert!(!t.label.is_empty(), "label must not be empty for {}", t.tag);
            assert!(
                t.behavior.starts_with("MB_"),
                "behavior {} must be an MB_* name",
                t.behavior
            );
        }
    }

    #[test]
    fn tags_and_behaviors_are_unique() {
        let tags = collision_tags();
        let mut ids: Vec<&str> = tags.iter().map(|t| t.tag.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), tags.len(), "tag ids must be unique");

        let mut behaviors: Vec<&str> = tags.iter().map(|t| t.behavior.as_str()).collect();
        behaviors.sort_unstable();
        behaviors.dedup();
        assert_eq!(behaviors.len(), tags.len(), "behaviors must be unique");
    }

    #[test]
    fn secondary_budgets_match_verified_constants() {
        // Guards the Spike 0 / compiler.md numbers against a careless edit.
        let b = secondary_budgets();
        assert_eq!(b.tiles, 512);
        assert_eq!(b.metatiles, 512);
        assert_eq!(b.palettes, 7);
        assert_eq!(b.colors_per_palette, 15);
    }

    #[test]
    fn contains_grounded_examples() {
        // A couple of anchors so a careless rename is caught: these exact MB_*
        // names exist in pokeemerald's metatile_behaviors.h.
        let tags = collision_tags();
        assert!(tags
            .iter()
            .any(|t| t.tag == "tall_grass" && t.behavior == "MB_TALL_GRASS"));
        assert!(tags
            .iter()
            .any(|t| t.behavior == "MB_JUMP_EAST"));
    }
}
