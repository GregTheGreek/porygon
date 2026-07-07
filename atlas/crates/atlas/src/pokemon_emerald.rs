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
