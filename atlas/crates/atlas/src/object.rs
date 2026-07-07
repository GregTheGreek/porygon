//! Object domain model and per-object artwork persistence (Milestone 4).
//!
//! An Object is the authoring primitive: a UUID, a name, its artwork's pixel
//! dimensions, and an anchor snapped to the 16px metatile grid (the Unity-pivot
//! equivalent). Object *metadata* is embedded in `project.json` (see project.rs)
//! so the whole project saves in one atomic-ish write; the artwork *pixels* live
//! on disk at `objects/<uuid>/artwork.png`, keyed by UUID so no path is stored.
//!
//! Deletion is soft: an object's directory moves to `.trash/<uuid>` so a delete
//! stays undoable across the session. Trash is left in place (recoverable)
//! rather than purged - it is cheap and never referenced by project.json once
//! the object is removed.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::artwork::{self, Artwork, ArtworkError};
use crate::collision::Collision;
use crate::occlusion::Occlusion;

/// The metatile grid the anchor snaps to, in pixels.
pub const GRID: u32 = 16;
/// Subdirectory holding one directory per object, keyed by UUID.
pub const OBJECTS_DIR: &str = "objects";
/// Subdirectory holding soft-deleted object directories.
pub const TRASH_DIR: &str = ".trash";
/// Artwork filename inside an object directory.
pub const ARTWORK_FILE: &str = "artwork.png";

/// A point on the 16px metatile grid where the object attaches to the map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub x: u32,
    pub y: u32,
}

/// Round a pixel coordinate to the nearest metatile-grid line. Pure.
pub fn snap(value: u32) -> u32 {
    ((value + GRID / 2) / GRID) * GRID
}

/// A reusable authoring Object. Metadata only; the artwork lives on disk.
///
/// `category`/`tags` (M5), `collision` (M6), and `occlusion` (M7) are additive
/// with serde defaults, so pre-M5/M6/M7 files load cleanly without a
/// format_version bump (same rationale as project.rs): a missing field defaults,
/// and the next save writes the current shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Object {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub anchor: Anchor,
    /// Free-text grouping label; empty means uncategorized.
    #[serde(default)]
    pub category: String,
    /// Free-form labels. The frontend trims, drops empties, and dedupes.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Painted collision on the 16px grid (M6). Sparse; empty means all
    /// Walkable. Defaults empty for objects saved before M6.
    #[serde(default)]
    pub collision: Collision,
    /// Painted occlusion at pixel granularity (M7). Sparse; empty means the
    /// whole object renders in front of the player. Defaults empty for objects
    /// saved before M7.
    #[serde(default)]
    pub occlusion: Occlusion,
}

impl Object {
    fn new(name: &str, width: u32, height: u32) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            width,
            height,
            // Default to bottom-centre: the natural attach point for a prop
            // standing on the grid. Editable in the Inspector (M5).
            anchor: Anchor {
                x: snap(width / 2),
                y: snap(height),
            },
            category: String::new(),
            tags: Vec::new(),
            collision: Collision::default(),
            occlusion: Occlusion::default(),
        }
    }

    /// Construct an Object with a fresh id for tests in sibling modules.
    #[cfg(test)]
    pub fn for_test(name: &str, width: u32, height: u32) -> Self {
        Self::new(name, width, height)
    }
}

/// Errors surfaced to the UI. `Display` produces plain, user-facing strings.
#[derive(Debug)]
pub enum ObjectError {
    Io(String),
    Artwork(ArtworkError),
}

impl std::fmt::Display for ObjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ObjectError::Io(msg) => write!(f, "Filesystem error: {msg}"),
            ObjectError::Artwork(e) => write!(f, "{e}"),
        }
    }
}

fn io<E: std::fmt::Display>(e: E) -> ObjectError {
    ObjectError::Io(e.to_string())
}

fn object_dir(project_dir: &str, id: &str) -> PathBuf {
    Path::new(project_dir).join(OBJECTS_DIR).join(id)
}

fn trash_object_dir(project_dir: &str, id: &str) -> PathBuf {
    Path::new(project_dir).join(TRASH_DIR).join(id)
}

/// Move `from` to `to`, replacing any stale directory already at `to`.
fn move_dir(from: &Path, to: &Path) -> Result<(), ObjectError> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(io)?;
    }
    if to.exists() {
        fs::remove_dir_all(to).map_err(io)?;
    }
    fs::rename(from, to).map_err(io)
}

/// Validate `source_png`, create an Object, and copy the artwork into the
/// project at `objects/<uuid>/artwork.png`. The PNG size cap is enforced by the
/// validation read.
pub fn import(project_dir: &str, source_png: &str, name: &str) -> Result<Object, ObjectError> {
    let art = artwork::read(source_png).map_err(ObjectError::Artwork)?;
    let object = Object::new(name, art.width, art.height);
    let dir = object_dir(project_dir, &object.id);
    fs::create_dir_all(&dir).map_err(io)?;
    fs::copy(source_png, dir.join(ARTWORK_FILE)).map_err(io)?;
    Ok(object)
}

/// Copy `source`'s artwork into a fresh object directory and return the new
/// Object (new UUID, "<name> copy", same dimensions and anchor).
pub fn duplicate(project_dir: &str, source: &Object) -> Result<Object, ObjectError> {
    let copy = Object {
        id: uuid::Uuid::new_v4().to_string(),
        name: format!("{} copy", source.name),
        ..source.clone()
    };
    let src_file = object_dir(project_dir, &source.id).join(ARTWORK_FILE);
    let dst_dir = object_dir(project_dir, &copy.id);
    fs::create_dir_all(&dst_dir).map_err(io)?;
    fs::copy(&src_file, dst_dir.join(ARTWORK_FILE)).map_err(io)?;
    Ok(copy)
}

/// Soft-delete: move `objects/<id>` to `.trash/<id>` so a delete is undoable.
pub fn trash(project_dir: &str, id: &str) -> Result<(), ObjectError> {
    move_dir(&object_dir(project_dir, id), &trash_object_dir(project_dir, id))
}

/// Undo a soft-delete: move `.trash/<id>` back to `objects/<id>`.
pub fn restore(project_dir: &str, id: &str) -> Result<(), ObjectError> {
    move_dir(&trash_object_dir(project_dir, id), &object_dir(project_dir, id))
}

/// Read an object's artwork (base64 + dimensions) for the Canvas.
pub fn read_artwork(project_dir: &str, id: &str) -> Result<Artwork, ObjectError> {
    let path = object_dir(project_dir, id).join(ARTWORK_FILE);
    artwork::read(&path.to_string_lossy()).map_err(ObjectError::Artwork)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("atlas-obj-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Minimal valid PNG head: signature + an IHDR chunk declaring `w`x`h`.
    /// Enough for `artwork::read`'s validation; not a decodable image.
    fn write_png(dir: &Path, w: u32, h: u32) -> PathBuf {
        let sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let mut bytes = sig.to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&w.to_be_bytes());
        bytes.extend_from_slice(&h.to_be_bytes());
        bytes.push(8);
        let path = dir.join("source.png");
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn snap_rounds_to_nearest_grid_line() {
        assert_eq!(snap(0), 0);
        assert_eq!(snap(7), 0);
        assert_eq!(snap(8), 16);
        assert_eq!(snap(16), 16);
        assert_eq!(snap(24), 32);
    }

    #[test]
    fn new_object_anchors_bottom_centre_on_grid() {
        let o = Object::new("Tree", 32, 48);
        assert_eq!(o.anchor, Anchor { x: 16, y: 48 });
        assert_eq!(o.anchor.x % GRID, 0);
        assert_eq!(o.anchor.y % GRID, 0);
    }

    #[test]
    fn object_json_without_category_or_tags_defaults_empty() {
        // Objects saved before M5 lack `category` and `tags` entirely.
        let json = r#"{"id":"a","name":"Tree","width":32,"height":48,"anchor":{"x":16,"y":48}}"#;
        let o: Object = serde_json::from_str(json).unwrap();
        assert_eq!(o.category, "");
        assert!(o.tags.is_empty());
    }

    #[test]
    fn pre_m6_object_json_defaults_empty_collision() {
        // Objects saved before M6 lack `collision`; it must default to empty so
        // older projects load without a format_version bump.
        let json = r#"{"id":"a","name":"Tree","width":32,"height":48,
            "anchor":{"x":16,"y":48},"category":"Nature","tags":["tree"]}"#;
        let o: Object = serde_json::from_str(json).unwrap();
        assert!(o.collision.cells.is_empty());
    }

    #[test]
    fn pre_m7_object_json_defaults_empty_occlusion() {
        // Objects saved before M7 lack `occlusion`; it must default to empty so
        // older projects load without a format_version bump.
        let json = r#"{"id":"a","name":"Tree","width":32,"height":48,
            "anchor":{"x":16,"y":48},"category":"Nature","tags":["tree"],
            "collision":{"cells":{"0":"Blocked"}}}"#;
        let o: Object = serde_json::from_str(json).unwrap();
        assert!(o.occlusion.pixels.is_empty());
    }

    #[test]
    fn object_with_occlusion_round_trips() {
        let mut o = Object::new("Tree", 32, 48);
        o.occlusion.pixels.insert(0);
        o.occlusion.pixels.insert(69);
        let json = serde_json::to_string(&o).unwrap();
        let back: Object = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
    }

    #[test]
    fn object_with_collision_round_trips() {
        use crate::collision::CollisionValue;
        let mut o = Object::new("Tree", 32, 48);
        o.collision.cells.insert(0, CollisionValue::Blocked);
        o.collision
            .cells
            .insert(4, CollisionValue::Custom("tall_grass".to_string()));
        let json = serde_json::to_string(&o).unwrap();
        let back: Object = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
    }

    #[test]
    fn object_metadata_round_trips() {
        let mut o = Object::new("Tree", 32, 48);
        o.category = "Nature".to_string();
        o.tags = vec!["tree".to_string(), "tall".to_string()];
        let json = serde_json::to_string(&o).unwrap();
        let back: Object = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
    }

    #[test]
    fn import_copies_artwork_and_reads_dimensions() {
        let proj = temp_dir("import");
        let png = write_png(&proj, 96, 64);

        let obj = import(proj.to_str().unwrap(), png.to_str().unwrap(), "Fence").unwrap();
        assert_eq!(obj.name, "Fence");
        assert_eq!((obj.width, obj.height), (96, 64));

        let stored = object_dir(proj.to_str().unwrap(), &obj.id).join(ARTWORK_FILE);
        assert!(stored.exists());

        let art = read_artwork(proj.to_str().unwrap(), &obj.id).unwrap();
        assert_eq!((art.width, art.height), (96, 64));
    }

    #[test]
    fn duplicate_makes_an_independent_copy() {
        let proj = temp_dir("dup");
        let png = write_png(&proj, 16, 16);
        let mut src = import(proj.to_str().unwrap(), png.to_str().unwrap(), "Rock").unwrap();
        src.category = "Terrain".to_string();
        src.tags = vec!["rock".to_string()];

        let copy = duplicate(proj.to_str().unwrap(), &src).unwrap();
        assert_ne!(copy.id, src.id);
        assert_eq!(copy.name, "Rock copy");
        assert_eq!((copy.width, copy.height), (src.width, src.height));
        assert_eq!(copy.category, src.category);
        assert_eq!(copy.tags, src.tags);
        assert!(object_dir(proj.to_str().unwrap(), &copy.id)
            .join(ARTWORK_FILE)
            .exists());
    }

    #[test]
    fn trash_then_restore_round_trips() {
        let proj = temp_dir("trash");
        let png = write_png(&proj, 16, 16);
        let obj = import(proj.to_str().unwrap(), png.to_str().unwrap(), "Sign").unwrap();
        let live = object_dir(proj.to_str().unwrap(), &obj.id);

        trash(proj.to_str().unwrap(), &obj.id).unwrap();
        assert!(!live.exists());
        assert!(trash_object_dir(proj.to_str().unwrap(), &obj.id).exists());

        restore(proj.to_str().unwrap(), &obj.id).unwrap();
        assert!(live.join(ARTWORK_FILE).exists());
    }
}
