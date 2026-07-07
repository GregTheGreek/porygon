//! Project domain model and filesystem persistence.
//!
//! A project is a directory containing a single `project.json` manifest. Rust
//! owns the schema; the frontend never parses it. The functions here are pure
//! apart from the filesystem I/O they name explicitly, so the format is
//! unit-testable without Tauri.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::object::Object;
use crate::tileset::Tileset;

/// Current on-disk schema version. Bump only alongside a migration path.
///
/// v1: name/created/modified only.
/// v2: adds `objects` (Milestone 4). v1 files migrate forward on load: the
/// missing `objects` field defaults to empty and the version is stamped to
/// current (see `parse`).
/// M5 adds per-object `category`/`tags` within v2: purely additive with serde
/// defaults, so pre-M5 v2 files load unchanged and no version bump is needed.
/// M9 adds top-level `tilesets` within v2: same additive story - a missing
/// field defaults to empty, so pre-M9 projects load unchanged with no bump.
pub const FORMAT_VERSION: u32 = 2;

/// Name of the manifest inside a project directory.
pub const PROJECT_FILE: &str = "project.json";

/// The project manifest. Objects are embedded here (rather than one JSON per
/// object directory) so the whole project state persists in a single write via
/// `save`, keeping autosave atomic-ish. Only object *metadata* lives here; the
/// artwork pixels live on disk under `objects/<uuid>/` (see object.rs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Project {
    pub format_version: u32,
    pub name: String,
    /// Creation time, Unix milliseconds.
    pub created: u64,
    /// Last-modified time, Unix milliseconds.
    pub modified: u64,
    /// Reusable Objects (M4). Absent in v1 files; defaults to empty on load.
    #[serde(default)]
    pub objects: Vec<Object>,
    /// Tilesets (M9): the compile primitive. Absent in pre-M9 files; defaults
    /// to empty on load.
    #[serde(default)]
    pub tilesets: Vec<Tileset>,
}

impl Project {
    fn new(name: &str) -> Self {
        let now = now_millis();
        Self {
            format_version: FORMAT_VERSION,
            name: name.to_string(),
            created: now,
            modified: now,
            objects: Vec::new(),
            tilesets: Vec::new(),
        }
    }
}

/// A project paired with the directory it lives in. Returned to the UI so the
/// frontend can save back to the same location without owning path logic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenProject {
    pub path: String,
    pub project: Project,
}

/// Errors surfaced to the UI. `Display` produces plain, user-facing strings.
#[derive(Debug)]
pub enum ProjectError {
    Io(String),
    Parse(String),
    /// The file was written by a newer build than this one.
    UnsupportedVersion { found: u32, supported: u32 },
    AlreadyExists(String),
    Invalid(String),
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::Io(msg) => write!(f, "Filesystem error: {msg}"),
            ProjectError::Parse(msg) => write!(f, "Could not read project file: {msg}"),
            ProjectError::UnsupportedVersion { found, supported } => write!(
                f,
                "This project was created by a newer version of Porygon (format v{found}; \
                 this build supports up to v{supported}). Please update Porygon."
            ),
            ProjectError::AlreadyExists(name) => {
                write!(f, "A folder named \"{name}\" already exists in that location.")
            }
            ProjectError::Invalid(msg) => write!(f, "{msg}"),
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse a manifest, rejecting anything written by a newer schema version and
/// migrating older ones forward. Migration today is defaulting-only (v1 gains an
/// empty `objects` via `#[serde(default)]`); we stamp the version to current so
/// the next save writes the new schema.
pub fn parse(json: &str) -> Result<Project, ProjectError> {
    let mut project: Project =
        serde_json::from_str(json).map_err(|e| ProjectError::Parse(e.to_string()))?;
    if project.format_version > FORMAT_VERSION {
        return Err(ProjectError::UnsupportedVersion {
            found: project.format_version,
            supported: FORMAT_VERSION,
        });
    }
    project.format_version = FORMAT_VERSION;
    Ok(project)
}

fn to_json(project: &Project) -> Result<String, ProjectError> {
    serde_json::to_string_pretty(project).map_err(|e| ProjectError::Parse(e.to_string()))
}

fn write_manifest(dir: &Path, project: &Project) -> Result<(), ProjectError> {
    let json = to_json(project)?;
    fs::write(dir.join(PROJECT_FILE), json).map_err(|e| ProjectError::Io(e.to_string()))
}

/// Create a new project directory `<location>/<name>` and write its manifest.
pub fn create(location: &str, name: &str) -> Result<OpenProject, ProjectError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ProjectError::Invalid("Project name cannot be empty.".into()));
    }
    if trimmed.contains(['/', '\\']) {
        return Err(ProjectError::Invalid(
            "Project name cannot contain slashes.".into(),
        ));
    }

    let dir: PathBuf = Path::new(location).join(trimmed);
    if dir.exists() {
        return Err(ProjectError::AlreadyExists(trimmed.to_string()));
    }
    fs::create_dir_all(&dir).map_err(|e| ProjectError::Io(e.to_string()))?;

    let project = Project::new(trimmed);
    write_manifest(&dir, &project)?;
    Ok(OpenProject {
        path: dir.to_string_lossy().into_owned(),
        project,
    })
}

/// Read the manifest from an existing project directory.
pub fn read(dir: &str) -> Result<OpenProject, ProjectError> {
    let manifest = Path::new(dir).join(PROJECT_FILE);
    let text = fs::read_to_string(&manifest).map_err(|e| {
        ProjectError::Io(format!("{} ({})", e, manifest.display()))
    })?;
    let project = parse(&text)?;
    Ok(OpenProject {
        path: dir.to_string(),
        project,
    })
}

/// Persist the given project state, stamping a fresh `modified` time and the
/// current schema version (so a migrated v1 project is written back as v2).
pub fn save(dir: &str, mut project: Project) -> Result<Project, ProjectError> {
    project.format_version = FORMAT_VERSION;
    project.modified = now_millis();
    write_manifest(Path::new(dir), &project)?;
    Ok(project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "atlas-proj-{tag}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn create_then_read_round_trips() {
        let loc = temp_dir("rt");
        let op = create(loc.to_str().unwrap(), "My Project").unwrap();
        let back = read(&op.path).unwrap();
        assert_eq!(back.project.name, "My Project");
        assert_eq!(back.project.format_version, FORMAT_VERSION);
        assert_eq!(back.project.created, back.project.modified);
        assert_eq!(back.project, op.project);
    }

    #[test]
    fn parse_migrates_v1_file_without_objects() {
        // A format_version 1 manifest predates the `objects` field entirely.
        let json = r#"{"format_version":1,"name":"Legacy","created":1,"modified":2}"#;
        let project = parse(json).unwrap();
        assert_eq!(project.name, "Legacy");
        assert!(project.objects.is_empty());
        // Migrated forward so the next save writes the current schema.
        assert_eq!(project.format_version, FORMAT_VERSION);
    }

    #[test]
    fn parse_v2_object_without_category_or_tags_defaults() {
        // A v2 manifest written before M5: objects lack `category` and `tags`.
        let json = r#"{"format_version":2,"name":"P","created":1,"modified":2,
            "objects":[{"id":"a","name":"Tree","width":32,"height":48,"anchor":{"x":16,"y":48}}]}"#;
        let project = parse(json).unwrap();
        assert_eq!(project.objects.len(), 1);
        assert_eq!(project.objects[0].category, "");
        assert!(project.objects[0].tags.is_empty());
    }

    #[test]
    fn parse_pre_m9_file_defaults_empty_tilesets() {
        // A v2 manifest written before M9 has no `tilesets` field.
        let json = r#"{"format_version":2,"name":"P","created":1,"modified":2,
            "objects":[{"id":"a","name":"Tree","width":32,"height":48,"anchor":{"x":16,"y":48}}]}"#;
        let project = parse(json).unwrap();
        assert!(project.tilesets.is_empty());
        assert_eq!(project.format_version, FORMAT_VERSION);
    }

    #[test]
    fn project_with_tilesets_round_trips() {
        use crate::tileset::Tileset;
        let loc = temp_dir("tilesets");
        let op = create(loc.to_str().unwrap(), "P").unwrap();
        let mut edited = op.project.clone();
        let mut ts = Tileset::new("Forest");
        ts.members = vec!["a".into(), "b".into()];
        edited.tilesets.push(ts.clone());
        save(&op.path, edited).unwrap();

        let back = read(&op.path).unwrap();
        assert_eq!(back.project.tilesets.len(), 1);
        assert_eq!(back.project.tilesets[0].name, "Forest");
        assert_eq!(back.project.tilesets[0].members, vec!["a", "b"]);
    }

    #[test]
    fn parse_rejects_newer_version() {
        let json = r#"{"format_version":999,"name":"x","created":1,"modified":1}"#;
        match parse(json) {
            Err(ProjectError::UnsupportedVersion { found, supported }) => {
                assert_eq!(found, 999);
                assert_eq!(supported, FORMAT_VERSION);
            }
            other => panic!("expected UnsupportedVersion, got {other:?}"),
        }
    }

    #[test]
    fn save_updates_modified_and_persists_rename() {
        let loc = temp_dir("save");
        let op = create(loc.to_str().unwrap(), "Before").unwrap();

        let mut edited = op.project.clone();
        edited.name = "After".to_string();
        std::thread::sleep(std::time::Duration::from_millis(2));

        let saved = save(&op.path, edited).unwrap();
        assert_eq!(saved.name, "After");
        assert_eq!(saved.created, op.project.created);
        assert!(saved.modified >= op.project.modified);

        let back = read(&op.path).unwrap();
        assert_eq!(back.project.name, "After");
        assert_eq!(back.project.modified, saved.modified);
    }

    #[test]
    fn create_rejects_existing_dir() {
        let loc = temp_dir("dup");
        create(loc.to_str().unwrap(), "Dup").unwrap();
        assert!(matches!(
            create(loc.to_str().unwrap(), "Dup"),
            Err(ProjectError::AlreadyExists(_))
        ));
    }

    #[test]
    fn create_rejects_empty_name() {
        let loc = temp_dir("empty");
        assert!(matches!(
            create(loc.to_str().unwrap(), "   "),
            Err(ProjectError::Invalid(_))
        ));
    }
}
