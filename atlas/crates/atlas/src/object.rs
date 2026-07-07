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
//!
//! ## Variants (Milestone 13)
//!
//! An Object holds one or more named artwork *variants* (e.g. a tree's Summer /
//! Winter). The bible is decisive: "Variants share metadata. Only artwork
//! changes." So everything except the artwork pixels - name, category, tags,
//! anchor, collision, occlusion, children, AND dimensions - is shared at the
//! Object level; a variant is nothing but a name plus its own artwork file. In
//! particular collision and occlusion are SHARED: they describe gameplay
//! semantics, which a seasonal/palette artwork swap does not change. Because the
//! shared masks are dimension-bound, every variant must match the object's
//! dimensions; `import_variant` enforces that with an artist-facing error.
//!
//! On-disk layout keeps pre-M13 projects working with zero file moves: the
//! default variant is served by the legacy `objects/<uuid>/artwork.png`, and
//! every *added* variant lives at `objects/<uuid>/variants/<variant-uuid>.png`.
//! `artwork_read_path` prefers the per-variant file and falls back to the legacy
//! path, so a migrated (or freshly imported) object's default variant reads its
//! original artwork with no migration step touching the filesystem. Deleting a
//! variant only removes its record (the PNG is left in place, recoverable, the
//! same "never purge" story as `.trash`); the active variant flows through the
//! one shared read path so the canvas, budgets, export, and play all follow it.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::artwork::{self, Artwork, ArtworkError, DecodedArtwork};
use crate::collision::Collision;
use crate::occlusion::Occlusion;

/// The metatile grid the anchor snaps to, in pixels.
pub const GRID: u32 = 16;
/// Subdirectory holding one directory per object, keyed by UUID.
pub const OBJECTS_DIR: &str = "objects";
/// Subdirectory holding soft-deleted object directories.
pub const TRASH_DIR: &str = ".trash";
/// Artwork filename inside an object directory. This is the default variant's
/// artwork (M13): pre-M13 objects keep their pixels here, so the layout change
/// needs no file move.
pub const ARTWORK_FILE: &str = "artwork.png";
/// Subdirectory (inside an object directory) holding added variants' artwork,
/// one PNG per variant keyed by variant UUID.
pub const VARIANTS_DIR: &str = "variants";
/// The name given to the single variant a pre-M13 (or freshly imported) object
/// starts with.
pub const DEFAULT_VARIANT_NAME: &str = "Default";

/// A point on the 16px metatile grid where the object attaches to the map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub x: u32,
    pub y: u32,
}

/// One child instance placed on an Object (M12, Scene Graph). `object_id`
/// references another Object in the same project; membership is a reference,
/// never ownership (the same object can be a child of many parents).
///
/// `x`/`y` are the offset, in pixels on the 16px grid, from the parent's
/// anchor to the child's anchor. The bible derives child transforms from the
/// Anchor ("Everything derives from it: Placement, Child transforms") and
/// equates the Anchor with a Unity pivot / Godot origin, so the point that
/// attaches an object to a map is the same point that attaches it inside a
/// parent. Signed: children may sit above or left of the anchor.
///
/// Translation is the only transform: flips/rotation do not exist for Emerald
/// metatile artwork authoring, and neither the bible nor compiler.md names any
/// other child transform.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChildPlacement {
    pub object_id: String,
    pub x: i32,
    pub y: i32,
}

/// One named artwork variation of an Object (M13). Only the artwork changes
/// between variants; everything else is shared on the Object (see the module
/// docs). No path is stored: the artwork is keyed by `id` under the object
/// directory (or the legacy `artwork.png` for the default variant).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Variant {
    pub id: String,
    pub name: String,
}

impl Variant {
    fn new(name: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
        }
    }
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
    /// Child instances composited under this object's artwork (M12). Additive
    /// with a serde default, so pre-M12 files load unchanged with no
    /// format_version bump (same story as category/collision/occlusion).
    #[serde(default)]
    pub children: Vec<ChildPlacement>,
    /// Named artwork variants (M13). Never empty after load: a pre-M13 object
    /// (or any file missing this field) migrates to a single default variant in
    /// `migrate_variants`, called from `project::parse`. Additive with a serde
    /// default, so pre-M13 files load unchanged with no format_version bump.
    #[serde(default)]
    pub variants: Vec<Variant>,
    /// The id of the active variant: the one shown on the canvas and consumed by
    /// budgets, export, and play. Empty in pre-M13 files; set to the default
    /// variant's id on migration.
    #[serde(default)]
    pub active_variant: String,
}

impl Object {
    fn new(name: &str, width: u32, height: u32) -> Self {
        let variant = Variant::new(DEFAULT_VARIANT_NAME);
        let active_variant = variant.id.clone();
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
            children: Vec::new(),
            variants: vec![variant],
            active_variant,
        }
    }

    /// Ensure the object has at least one variant and a resolvable active
    /// variant (M13). Pre-M13 objects (empty `variants`) migrate to a single
    /// default variant whose artwork is the legacy `artwork.png`; a dangling
    /// `active_variant` (hand-edited file) is repaired to the first variant.
    /// Idempotent, pure, no filesystem work - the default variant is served by
    /// the legacy path so migration never moves a file. Returns whether it
    /// changed anything.
    pub fn migrate_variants(&mut self) -> bool {
        let mut changed = false;
        if self.variants.is_empty() {
            let v = Variant::new(DEFAULT_VARIANT_NAME);
            self.active_variant = v.id.clone();
            self.variants.push(v);
            changed = true;
        }
        if !self.variants.iter().any(|v| v.id == self.active_variant) {
            self.active_variant = self.variants[0].id.clone();
            changed = true;
        }
        changed
    }

    /// Remove a variant, refusing the last one (an object must always keep at
    /// least one) and reassigning the active variant when the active one is
    /// removed. The authoritative rule; the frontend mirrors it to keep the
    /// delete button disabled, exactly as `wouldCreateCycle` mirrors the M12
    /// cycle guard. The variant's PNG is left on disk (recoverable, never
    /// purged - the same story as `.trash`).
    pub fn remove_variant(&mut self, variant_id: &str) -> Result<(), String> {
        if self.variants.len() <= 1 {
            return Err(
                "An object must keep at least one variant. Add another variant before \
                 deleting this one."
                    .to_string(),
            );
        }
        let Some(pos) = self.variants.iter().position(|v| v.id == variant_id) else {
            return Err("That variant no longer exists.".to_string());
        };
        self.variants.remove(pos);
        if self.active_variant == variant_id {
            self.active_variant = self.variants[0].id.clone();
        }
        Ok(())
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
    /// An artist-facing rule violation (e.g. a variant that is the wrong size).
    Invalid(String),
}

impl std::fmt::Display for ObjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ObjectError::Io(msg) => write!(f, "Filesystem error: {msg}"),
            ObjectError::Artwork(e) => write!(f, "{e}"),
            ObjectError::Invalid(msg) => write!(f, "{msg}"),
        }
    }
}

fn io<E: std::fmt::Display>(e: E) -> ObjectError {
    ObjectError::Io(e.to_string())
}

fn object_dir(project_dir: &str, id: &str) -> PathBuf {
    Path::new(project_dir).join(OBJECTS_DIR).join(id)
}

/// The directory holding an object's added-variant artwork.
fn variants_dir(project_dir: &str, object_id: &str) -> PathBuf {
    object_dir(project_dir, object_id).join(VARIANTS_DIR)
}

/// Where an added variant's artwork is stored: `objects/<id>/variants/<vid>.png`.
fn variant_file(project_dir: &str, object_id: &str, variant_id: &str) -> PathBuf {
    variants_dir(project_dir, object_id).join(format!("{variant_id}.png"))
}

/// Resolve a variant's artwork file for reading. Added variants have their own
/// `variants/<vid>.png`; the default variant is served by the legacy
/// `objects/<id>/artwork.png`, so fall back to it when the per-variant file is
/// absent. This is what keeps pre-M13 projects working without a file move (see
/// the module docs).
fn artwork_read_path(project_dir: &str, object_id: &str, variant_id: &str) -> PathBuf {
    let per_variant = variant_file(project_dir, object_id, variant_id);
    if per_variant.exists() {
        per_variant
    } else {
        object_dir(project_dir, object_id).join(ARTWORK_FILE)
    }
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
/// Object (new UUID, "<name> copy", same dimensions, anchor, and variants).
/// Every variant's artwork is copied - the default's `artwork.png` and the
/// whole `variants/` directory - so the copy is fully independent. Variant ids
/// are reused (they are scoped to the object directory, so no collision).
pub fn duplicate(project_dir: &str, source: &Object) -> Result<Object, ObjectError> {
    let copy = Object {
        id: uuid::Uuid::new_v4().to_string(),
        name: format!("{} copy", source.name),
        ..source.clone()
    };
    let src_dir = object_dir(project_dir, &source.id);
    let dst_dir = object_dir(project_dir, &copy.id);
    fs::create_dir_all(&dst_dir).map_err(io)?;

    // The default variant's legacy artwork, if present.
    let src_art = src_dir.join(ARTWORK_FILE);
    if src_art.exists() {
        fs::copy(&src_art, dst_dir.join(ARTWORK_FILE)).map_err(io)?;
    }
    // Every added variant's artwork.
    let src_variants = src_dir.join(VARIANTS_DIR);
    if src_variants.is_dir() {
        let dst_variants = dst_dir.join(VARIANTS_DIR);
        fs::create_dir_all(&dst_variants).map_err(io)?;
        for entry in fs::read_dir(&src_variants).map_err(io)? {
            let path = entry.map_err(io)?.path();
            if path.is_file() {
                if let Some(name) = path.file_name() {
                    fs::copy(&path, dst_variants.join(name)).map_err(io)?;
                }
            }
        }
    }
    Ok(copy)
}

/// Import a PNG as a new variant of `object`: validate that its dimensions
/// match the object (the shared collision/occlusion masks are dimension-bound,
/// so variants must be the same size), copy it into
/// `objects/<id>/variants/<vid>.png`, and return the new Variant. The frontend
/// adds the returned Variant to the object and switches to it as an undoable
/// edit.
pub fn import_variant(
    project_dir: &str,
    object: &Object,
    source_png: &str,
    name: &str,
) -> Result<Variant, ObjectError> {
    let art = artwork::read(source_png).map_err(ObjectError::Artwork)?;
    if art.width != object.width || art.height != object.height {
        return Err(ObjectError::Invalid(format!(
            "This image is {}x{} px, but \"{}\" is {}x{} px. Every variant of an object must be \
             the same size, because collision and occlusion are shared across variants.",
            art.width, art.height, object.name, object.width, object.height
        )));
    }
    let variant = Variant::new(name);
    fs::create_dir_all(variants_dir(project_dir, &object.id)).map_err(io)?;
    fs::copy(
        source_png,
        variant_file(project_dir, &object.id, &variant.id),
    )
    .map_err(io)?;
    Ok(variant)
}

/// Duplicate one of `object`'s variants: copy its artwork to a fresh
/// `variants/<vid>.png` and return the new Variant. Reads the source through
/// the same resolver used everywhere, so duplicating the default variant (whose
/// pixels live at the legacy `artwork.png`) works too.
pub fn duplicate_variant(
    project_dir: &str,
    object: &Object,
    source_variant_id: &str,
    name: &str,
) -> Result<Variant, ObjectError> {
    let src = artwork_read_path(project_dir, &object.id, source_variant_id);
    let variant = Variant::new(name);
    fs::create_dir_all(variants_dir(project_dir, &object.id)).map_err(io)?;
    fs::copy(&src, variant_file(project_dir, &object.id, &variant.id)).map_err(io)?;
    Ok(variant)
}

/// Soft-delete: move `objects/<id>` to `.trash/<id>` so a delete is undoable.
pub fn trash(project_dir: &str, id: &str) -> Result<(), ObjectError> {
    move_dir(&object_dir(project_dir, id), &trash_object_dir(project_dir, id))
}

/// Undo a soft-delete: move `.trash/<id>` back to `objects/<id>`.
pub fn restore(project_dir: &str, id: &str) -> Result<(), ObjectError> {
    move_dir(&trash_object_dir(project_dir, id), &object_dir(project_dir, id))
}

/// Read a variant's artwork (base64 + dimensions) for the Canvas. Resolves the
/// active variant's file through `artwork_read_path` (M13).
pub fn read_artwork(
    project_dir: &str,
    id: &str,
    variant_id: &str,
) -> Result<Artwork, ObjectError> {
    let path = artwork_read_path(project_dir, id, variant_id);
    artwork::read(&path.to_string_lossy()).map_err(ObjectError::Artwork)
}

/// Decode a variant's artwork to RGBA pixels for the budget/compose path (M9,
/// M12). Resolves the given variant's file through `artwork_read_path` (M13),
/// so budgets, export, and the composition all follow the active variant.
pub fn decode_artwork(
    project_dir: &str,
    id: &str,
    variant_id: &str,
) -> Result<DecodedArtwork, ObjectError> {
    let path = artwork_read_path(project_dir, id, variant_id);
    artwork::decode_rgba(&path.to_string_lossy()).map_err(ObjectError::Artwork)
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
    fn pre_m12_object_json_defaults_empty_children() {
        // Objects saved before M12 lack `children`; it must default to empty so
        // older projects load without a format_version bump.
        let json = r#"{"id":"a","name":"Tree","width":32,"height":48,
            "anchor":{"x":16,"y":48},"category":"Nature","tags":["tree"],
            "collision":{"cells":{"0":"Blocked"}},"occlusion":{"pixels":[3]}}"#;
        let o: Object = serde_json::from_str(json).unwrap();
        assert!(o.children.is_empty());
    }

    #[test]
    fn object_with_children_round_trips() {
        let mut o = Object::new("House", 64, 64);
        o.children.push(ChildPlacement {
            object_id: "chimney".to_string(),
            x: 16,
            y: -48,
        });
        o.children.push(ChildPlacement {
            object_id: "door".to_string(),
            x: 0,
            y: 0,
        });
        let json = serde_json::to_string(&o).unwrap();
        let back: Object = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
        assert_eq!(back.children.len(), 2);
        assert_eq!(back.children[0].y, -48);
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
        // A fresh object starts with one default variant, active.
        assert_eq!(obj.variants.len(), 1);
        assert_eq!(obj.active_variant, obj.variants[0].id);

        let stored = object_dir(proj.to_str().unwrap(), &obj.id).join(ARTWORK_FILE);
        assert!(stored.exists());

        // The default variant's pixels are served by the legacy artwork.png.
        let art = read_artwork(proj.to_str().unwrap(), &obj.id, &obj.active_variant).unwrap();
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

    // --- Variants (M13) ---

    #[test]
    fn pre_m13_object_json_migrates_to_one_default_variant() {
        // Objects saved before M13 lack `variants` and `active_variant`; both
        // default to empty on load, then migrate to a single default variant.
        let json = r#"{"id":"a","name":"Tree","width":32,"height":48,
            "anchor":{"x":16,"y":48},"category":"Nature","tags":["tree"]}"#;
        let mut o: Object = serde_json::from_str(json).unwrap();
        assert!(o.variants.is_empty());
        assert_eq!(o.active_variant, "");
        assert!(o.migrate_variants());
        assert_eq!(o.variants.len(), 1);
        assert_eq!(o.variants[0].name, DEFAULT_VARIANT_NAME);
        assert_eq!(o.active_variant, o.variants[0].id);
        // Idempotent: a second migration changes nothing.
        assert!(!o.migrate_variants());
    }

    #[test]
    fn migrate_repairs_a_dangling_active_variant() {
        let mut o = Object::new("Tree", 16, 16);
        o.active_variant = "does-not-exist".to_string();
        assert!(o.migrate_variants());
        assert_eq!(o.active_variant, o.variants[0].id);
    }

    #[test]
    fn object_with_variants_round_trips() {
        let mut o = Object::new("Tree", 16, 16);
        o.variants.push(Variant {
            id: "winter".to_string(),
            name: "Winter".to_string(),
        });
        o.active_variant = "winter".to_string();
        let json = serde_json::to_string(&o).unwrap();
        let back: Object = serde_json::from_str(&json).unwrap();
        assert_eq!(back, o);
        assert_eq!(back.variants.len(), 2);
        assert_eq!(back.active_variant, "winter");
    }

    #[test]
    fn import_variant_enforces_matching_dimensions() {
        let proj = temp_dir("var-dims");
        let png = write_png(&proj, 32, 48);
        let obj = import(proj.to_str().unwrap(), png.to_str().unwrap(), "Tree").unwrap();

        let wrong = write_png(&proj, 16, 16);
        let err = import_variant(proj.to_str().unwrap(), &obj, wrong.to_str().unwrap(), "Winter")
            .unwrap_err();
        assert!(matches!(err, ObjectError::Invalid(_)));
        assert!(err.to_string().contains("same size"), "got: {err}");
    }

    #[test]
    fn import_variant_writes_a_per_variant_file() {
        let proj = temp_dir("var-import");
        let png = write_png(&proj, 32, 48);
        let obj = import(proj.to_str().unwrap(), png.to_str().unwrap(), "Tree").unwrap();

        let same = write_png(&proj, 32, 48);
        let variant =
            import_variant(proj.to_str().unwrap(), &obj, same.to_str().unwrap(), "Winter").unwrap();
        assert_eq!(variant.name, "Winter");
        assert!(variant_file(proj.to_str().unwrap(), &obj.id, &variant.id).exists());
        // Reading the new variant resolves its own file, not the default's.
        let art = read_artwork(proj.to_str().unwrap(), &obj.id, &variant.id).unwrap();
        assert_eq!((art.width, art.height), (32, 48));
    }

    #[test]
    fn duplicate_variant_copies_source_artwork() {
        let proj = temp_dir("var-dup");
        let png = write_png(&proj, 16, 16);
        let obj = import(proj.to_str().unwrap(), png.to_str().unwrap(), "Tree").unwrap();
        // Duplicating the default variant reads its legacy artwork.png.
        let copy =
            duplicate_variant(proj.to_str().unwrap(), &obj, &obj.active_variant, "Copy").unwrap();
        assert!(variant_file(proj.to_str().unwrap(), &obj.id, &copy.id).exists());
    }

    #[test]
    fn remove_variant_refuses_the_last_and_reassigns_active() {
        let mut o = Object::new("Tree", 16, 16);
        let default_id = o.active_variant.clone();
        // The lone default variant cannot be removed.
        assert!(o.remove_variant(&default_id).is_err());

        o.variants.push(Variant {
            id: "winter".to_string(),
            name: "Winter".to_string(),
        });
        // Removing the active (default) variant reassigns active to the survivor.
        o.remove_variant(&default_id).unwrap();
        assert_eq!(o.variants.len(), 1);
        assert_eq!(o.active_variant, "winter");
    }

    #[test]
    fn duplicate_object_copies_every_variant_file() {
        let proj = temp_dir("dup-variants");
        let png = write_png(&proj, 16, 16);
        let mut src = import(proj.to_str().unwrap(), png.to_str().unwrap(), "Tree").unwrap();
        let same = write_png(&proj, 16, 16);
        let variant =
            import_variant(proj.to_str().unwrap(), &src, same.to_str().unwrap(), "Winter").unwrap();
        src.variants.push(variant.clone());

        let copy = duplicate(proj.to_str().unwrap(), &src).unwrap();
        // Both the default (artwork.png) and the added variant travel with it.
        assert!(object_dir(proj.to_str().unwrap(), &copy.id)
            .join(ARTWORK_FILE)
            .exists());
        assert!(variant_file(proj.to_str().unwrap(), &copy.id, &variant.id).exists());
        assert_eq!(copy.variants.len(), 2);
    }
}
