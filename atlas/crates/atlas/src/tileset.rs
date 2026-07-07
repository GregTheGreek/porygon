//! Tileset domain model (Milestone 9): the compile primitive.
//!
//! The Bible draws the line: Objects are *authored*, Tilesets are *compiled*.
//! A Tileset is a named, ordered collection of member Object ids that are
//! budgeted and (M10) exported together. Like Objects, a Tileset's metadata is
//! embedded in `project.json` (see project.rs) so the whole project persists in
//! one write; unlike an Object it owns no files on disk, so all of its CRUD is
//! plain list editing on the frontend, undoable through the existing history
//! stack. The only Rust-side work a Tileset needs is the budget computation
//! (see budgets.rs), which reads member artwork from disk.
//!
//! An Object may belong to any number of Tilesets (membership is a list of ids,
//! not ownership), so deleting an Object must scrub its id from every Tileset -
//! see `project::remove_object_from_tilesets`, applied by the delete command.

use serde::{Deserialize, Serialize};

/// A named, ordered set of member Object ids, compiled and budgeted together.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tileset {
    pub id: String,
    pub name: String,
    /// Member Object ids, in a stable authoring order. An id may also appear in
    /// other Tilesets; membership is a reference, never ownership.
    #[serde(default)]
    pub members: Vec<String>,
}

impl Tileset {
    /// Construct a Tileset with a fresh id and no members.
    pub fn new(name: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            members: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_tileset_has_id_and_no_members() {
        let t = Tileset::new("Forest");
        assert_eq!(t.name, "Forest");
        assert!(t.members.is_empty());
        assert!(!t.id.is_empty());
    }

    #[test]
    fn tileset_round_trips_through_json() {
        let mut t = Tileset::new("Forest");
        t.members = vec!["a".into(), "b".into()];
        let json = serde_json::to_string(&t).unwrap();
        let back: Tileset = serde_json::from_str(&json).unwrap();
        assert_eq!(back, t);
    }

    #[test]
    fn tileset_without_members_defaults_empty() {
        // Forward-compatibility guard mirroring the Object/Project pattern.
        let json = r#"{"id":"a","name":"Forest"}"#;
        let t: Tileset = serde_json::from_str(json).unwrap();
        assert!(t.members.is_empty());
    }
}
