//! Recent-projects list, persisted as JSON in the app config dir.
//!
//! Most-recent-first, deduped by path, capped. `push`/`prune` are pure so the
//! ordering and pruning rules are unit-testable; `load`/`save` name their I/O.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Maximum number of remembered projects.
pub const RECENTS_CAP: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recent {
    pub path: String,
    pub name: String,
}

/// Insert `entry` at the front, remove any existing entry with the same path,
/// and cap the list length. Pure.
pub fn push(list: Vec<Recent>, entry: Recent, cap: usize) -> Vec<Recent> {
    let mut out = Vec::with_capacity(list.len() + 1);
    out.push(entry.clone());
    for e in list {
        if e.path != entry.path {
            out.push(e);
        }
    }
    out.truncate(cap);
    out
}

/// Drop entries whose project directory no longer exists.
pub fn prune(list: Vec<Recent>) -> Vec<Recent> {
    list.into_iter()
        .filter(|e| Path::new(&e.path).is_dir())
        .collect()
}

/// Load the list, treating a missing or corrupt file as empty.
pub fn load(path: &Path) -> Vec<Recent> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Persist the list, creating the config directory if needed.
pub fn save(path: &Path, list: &[Recent]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(p: &str) -> Recent {
        Recent {
            path: p.to_string(),
            name: p.to_string(),
        }
    }

    #[test]
    fn push_moves_to_front_and_dedups() {
        let list = vec![r("a"), r("b"), r("c")];
        let out = push(list, r("b"), 10);
        let paths: Vec<_> = out.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["b", "a", "c"]);
    }

    #[test]
    fn push_caps_length_keeping_newest() {
        let mut list = Vec::new();
        for i in 0..12 {
            list = push(list, r(&format!("p{i}")), 10);
        }
        assert_eq!(list.len(), 10);
        assert_eq!(list[0].path, "p11");
        assert_eq!(list[9].path, "p2");
    }

    #[test]
    fn prune_drops_missing_dirs() {
        let existing = std::env::temp_dir();
        let list = vec![
            Recent {
                path: existing.to_string_lossy().into_owned(),
                name: "here".into(),
            },
            Recent {
                path: existing
                    .join("atlas-does-not-exist-xyz")
                    .to_string_lossy()
                    .into_owned(),
                name: "gone".into(),
            },
        ];
        let out = prune(list);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "here");
    }

    #[test]
    fn load_missing_file_is_empty() {
        let p = std::env::temp_dir().join("atlas-recents-missing-xyz.json");
        let _ = fs::remove_file(&p);
        assert!(load(&p).is_empty());
    }

    #[test]
    fn save_then_load_round_trips() {
        let p = std::env::temp_dir()
            .join(format!("atlas-recents-{}.json", std::process::id()));
        let list = vec![r("x"), r("y")];
        save(&p, &list).unwrap();
        assert_eq!(load(&p), list);
        let _ = fs::remove_file(&p);
    }
}
