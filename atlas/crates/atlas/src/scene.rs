//! Scene-graph flattening (Milestone 12): the single source of truth for
//! composing an Object with its children.
//!
//! The bible: "Objects form a Scene Graph. Children inherit transforms. ...
//! The exporter flattens the graph. Atlas never does." Authoring data keeps
//! the graph (object.rs stores `children` as references plus offsets); every
//! consumer of flat data - budget prediction (M9), the exporter (M10/M11),
//! and the canvas/play composition view - flattens through `flatten` here, so
//! prediction, emission, and the runtime preview can never disagree
//! (compiler.md decomposition step 1: "Flatten the scene graph into one
//! artwork + one collision mask + one occlusion mask").
//!
//! ## Transform model
//!
//! A placement offset is anchor-to-anchor: the child's anchor lands at
//! `parent.anchor + (x, y)` in the parent's artwork space (see
//! `object::ChildPlacement`). Translation only.
//!
//! ## Flattening rules
//!
//! * The composed space is the union bounding box of every instance's artwork
//!   rect, so the grid grows to cover children that hang past the parent.
//! * Paint order: children render under the parent, in added order (first
//!   child bottom-most), each child's own subtree below that child. The docs
//!   do not specify a z-order; this is the documented choice.
//! * Artwork and occlusion are pixel-level: the topmost non-transparent
//!   contributor at a pixel supplies both its colour and its occlusion bit.
//!   An occluding pixel hidden behind an opaque non-occluding pixel is not
//!   occluding - occlusion follows what is actually visible. Transparency is
//!   `budgets::is_transparent` (alpha 0 or the magenta sentinel), so the
//!   flattened pixels come out already normalised the way the budget maths
//!   and the exporter consume them ([r,g,b,255] or [0,0,0,0]).
//! * Collision is per 16px cell: the topmost contributor that painted the
//!   cell wins. Unpainted cells (Walkable is the sparse default) express no
//!   opinion, exactly as transparent pixels do for artwork, so a child's
//!   Blocked shows through a parent that painted nothing over it.
//!
//! ## Guards
//!
//! A cycle (an object containing itself, directly or transitively) is a hard
//! error here - defense in depth: the frontend refuses to create one, and
//! validity.rs reports it as a Tier 1 problem for hand-edited files. Missing
//! child references compose to nothing, matching how stale tileset members
//! behave. Size, depth, and instance-count caps keep a hand-edited file from
//! allocating unbounded memory (the editor's offset clamp stays well inside
//! them).

use std::collections::{BTreeMap, BTreeSet};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;

use crate::artwork::DecodedArtwork;
use crate::budgets::is_transparent;
use crate::collision::{grid_dims, Collision, CollisionValue, CELL};
use crate::object::{Anchor, Object};
use crate::occlusion::Occlusion;
use crate::project::Project;

/// A composition may not grow past this many pixels per side (hand-edit
/// guard; the editor clamps child offsets well inside it). A childless object
/// is never capped: it composes to exactly its own artwork.
const MAX_COMPOSED_PX: i64 = 4096;
/// Nesting depth cap (hand-edit guard; real hierarchies are a few levels).
const MAX_DEPTH: usize = 32;
/// Total painted-instance cap: a diamond-heavy hand-edited graph could
/// otherwise fan out combinatorially (each path through the graph paints).
const MAX_INSTANCES: usize = 256;

/// One object plus its decoded artwork: the flattening input, keyed by id in
/// the sources map so `flatten` stays pure (no fs, no Tauri).
pub struct Source {
    pub object: Object,
    pub art: DecodedArtwork,
}

/// A direct child's flattened footprint in composed space, for the canvas
/// selection highlight. Index-aligned with the parent's `children` vec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChildFootprint {
    pub object_id: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// An Object flattened with its children: one artwork, one collision mask,
/// one occlusion mask, over the union bounding box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flattened {
    pub width: u32,
    pub height: u32,
    /// The root's anchor re-expressed in composed space.
    pub anchor: Anchor,
    /// The root artwork's top-left in composed space (the composition may
    /// extend above/left of the root when children hang past it).
    pub origin_x: u32,
    pub origin_y: u32,
    /// RGBA, row-major; transparent pixels are [0,0,0,0], everything else
    /// opaque (alpha 255), matching exporter conventions.
    pub pixels: Vec<[u8; 4]>,
    /// Composed collision, keyed by row-major cell index on the composed grid.
    pub collision: BTreeMap<u32, CollisionValue>,
    /// Composed occluding pixels, row-major indices in composed pixel space.
    pub occlusion: BTreeSet<u32>,
    /// Direct child footprints, one entry per placement (None = the child
    /// object no longer exists).
    pub children: Vec<Option<ChildFootprint>>,
}

#[derive(Clone, Copy)]
struct Rect {
    x0: i64,
    y0: i64,
    x1: i64,
    y1: i64,
}

impl Rect {
    fn union(self, o: Rect) -> Rect {
        Rect {
            x0: self.x0.min(o.x0),
            y0: self.y0.min(o.y0),
            x1: self.x1.max(o.x1),
            y1: self.y1.max(o.y1),
        }
    }
}

/// One paint job: an object's artwork placed at a top-left position in
/// root-anchor space. Instances are ordered bottom-most first.
struct Instance {
    id: String,
    x: i64,
    y: i64,
}

/// Walk one subtree, appending its instances in paint order (children first,
/// then the node itself) and returning the subtree's bounding rect. `path`
/// carries the ids currently being expanded, so any revisit is a cycle.
fn collect(
    id: &str,
    anchor_pos: (i64, i64),
    sources: &BTreeMap<String, Source>,
    path: &mut Vec<String>,
    out: &mut Vec<Instance>,
) -> Result<Option<Rect>, String> {
    let Some(src) = sources.get(id) else {
        // A dangling child reference composes to nothing, the same way a
        // stale tileset member budgets/exports to nothing.
        return Ok(None);
    };
    if path.iter().any(|p| p == id) {
        return Err(format!(
            "\"{}\" ends up inside itself through its children. Remove the looping child.",
            src.object.name
        ));
    }
    if path.len() >= MAX_DEPTH {
        return Err("This object's children nest too deeply to compose.".to_string());
    }
    if out.len() >= MAX_INSTANCES {
        return Err("This object has too many nested children to compose.".to_string());
    }
    let tl = (
        anchor_pos.0 - i64::from(src.object.anchor.x),
        anchor_pos.1 - i64::from(src.object.anchor.y),
    );
    let mut bbox = Rect {
        x0: tl.0,
        y0: tl.1,
        x1: tl.0 + i64::from(src.art.width),
        y1: tl.1 + i64::from(src.art.height),
    };
    path.push(id.to_string());
    for p in &src.object.children {
        let child_anchor = (anchor_pos.0 + i64::from(p.x), anchor_pos.1 + i64::from(p.y));
        if let Some(r) = collect(&p.object_id, child_anchor, sources, path, out)? {
            bbox = bbox.union(r);
        }
    }
    path.pop();
    // Children were pushed first: they render under this object.
    out.push(Instance {
        id: id.to_string(),
        x: tl.0,
        y: tl.1,
    });
    Ok(Some(bbox))
}

/// Flatten `root_id` with its children into one artwork + collision +
/// occlusion over the union bounding box. Pure and deterministic: instances
/// paint in placement order, collections are BTree-backed.
pub fn flatten(root_id: &str, sources: &BTreeMap<String, Source>) -> Result<Flattened, String> {
    let root = sources
        .get(root_id)
        .ok_or_else(|| "Object not found.".to_string())?;

    // Work in root-anchor space: the root's anchor sits at (0, 0), so a
    // placement offset (x, y) is directly a child's anchor position.
    let root_tl = (
        -i64::from(root.object.anchor.x),
        -i64::from(root.object.anchor.y),
    );
    let mut bbox = Rect {
        x0: root_tl.0,
        y0: root_tl.1,
        x1: root_tl.0 + i64::from(root.art.width),
        y1: root_tl.1 + i64::from(root.art.height),
    };
    let mut instances = Vec::new();
    let mut path = vec![root_id.to_string()];
    let mut footprint_rects: Vec<Option<Rect>> = Vec::with_capacity(root.object.children.len());
    for p in &root.object.children {
        let rect = collect(
            &p.object_id,
            (i64::from(p.x), i64::from(p.y)),
            sources,
            &mut path,
            &mut instances,
        )?;
        if let Some(r) = rect {
            bbox = bbox.union(r);
        }
        footprint_rects.push(rect);
    }
    instances.push(Instance {
        id: root_id.to_string(),
        x: root_tl.0,
        y: root_tl.1,
    });

    let width_px = bbox.x1 - bbox.x0;
    let height_px = bbox.y1 - bbox.y0;
    let cap_w = MAX_COMPOSED_PX.max(i64::from(root.art.width));
    let cap_h = MAX_COMPOSED_PX.max(i64::from(root.art.height));
    if width_px > cap_w || height_px > cap_h {
        return Err(
            "This object's children spread too far apart to compose. Move them closer together."
                .to_string(),
        );
    }
    let width = width_px as u32;
    let height = height_px as u32;

    let mut pixels = vec![[0u8; 4]; (width as usize) * (height as usize)];
    let mut occlusion: BTreeSet<u32> = BTreeSet::new();
    let mut collision: BTreeMap<u32, CollisionValue> = BTreeMap::new();
    let (comp_cols, comp_rows) = grid_dims(width, height);

    for inst in &instances {
        // Instances only name resolved sources (collect skipped the rest).
        let src = &sources[inst.id.as_str()];
        let off_x = (inst.x - bbox.x0) as u32;
        let off_y = (inst.y - bbox.y0) as u32;

        // Artwork + occlusion: painter's algorithm with is_transparent as the
        // mask, so the topmost non-transparent pixel supplies colour AND
        // occlusion (an opaque non-occluding pixel clears occlusion beneath).
        for sy in 0..src.art.height {
            for sx in 0..src.art.width {
                let sidx = sy * src.art.width + sx;
                let p = src.art.pixels[sidx as usize];
                if is_transparent(p) {
                    continue;
                }
                let didx = (off_y + sy) * width + (off_x + sx);
                pixels[didx as usize] = [p[0], p[1], p[2], 255];
                if src.object.occlusion.pixels.contains(&sidx) {
                    occlusion.insert(didx);
                } else {
                    occlusion.remove(&didx);
                }
            }
        }

        // Collision: the topmost painted cell wins; unpainted cells (sparse
        // Walkable) contribute nothing. Offsets are cell-aligned because
        // anchors and placement offsets snap to the 16px grid in the editor.
        let (scols, srows) = grid_dims(src.art.width, src.art.height);
        let cell_off_x = off_x / CELL;
        let cell_off_y = off_y / CELL;
        for (&ci, value) in &src.object.collision.cells {
            let (c, r) = (ci % scols, ci / scols);
            if r >= srows {
                continue; // out-of-grid painted cell: Tier 1 flags it
            }
            let (dc, dr) = (cell_off_x + c, cell_off_y + r);
            if dc >= comp_cols || dr >= comp_rows {
                continue;
            }
            collision.insert(dr * comp_cols + dc, value.clone());
        }
    }

    let children = footprint_rects
        .iter()
        .zip(&root.object.children)
        .map(|(rect, placement)| {
            rect.map(|r| ChildFootprint {
                object_id: placement.object_id.clone(),
                x: (r.x0 - bbox.x0) as u32,
                y: (r.y0 - bbox.y0) as u32,
                width: (r.x1 - r.x0) as u32,
                height: (r.y1 - r.y0) as u32,
            })
        })
        .collect();

    Ok(Flattened {
        width,
        height,
        anchor: Anchor {
            x: (-bbox.x0) as u32,
            y: (-bbox.y0) as u32,
        },
        origin_x: (root_tl.0 - bbox.x0) as u32,
        origin_y: (root_tl.1 - bbox.y0) as u32,
        pixels,
        collision,
        occlusion,
        children,
    })
}

/// Decode artwork for every object reachable from `roots` through children
/// (a cycle-tolerant walk; `flatten` reports cycles properly). Missing
/// referenced objects are skipped. The shared loader behind budgets, export,
/// and the canvas composition, so membership resolution never diverges.
pub fn load_sources<'a>(
    project_dir: &str,
    objects: &'a [Object],
    roots: impl IntoIterator<Item = &'a str>,
) -> Result<BTreeMap<String, Source>, String> {
    let by_id: BTreeMap<&str, &Object> = objects.iter().map(|o| (o.id.as_str(), o)).collect();
    let mut queue: Vec<&str> = roots.into_iter().collect();
    let mut seen: BTreeSet<&str> = queue.iter().copied().collect();
    let mut sources = BTreeMap::new();
    while let Some(id) = queue.pop() {
        let Some(obj) = by_id.get(id) else { continue };
        let art = crate::object::decode_artwork(project_dir, &obj.id, &obj.active_variant)
            .map_err(|e| format!("Could not read artwork for \"{}\": {e}", obj.name))?;
        sources.insert(
            obj.id.clone(),
            Source {
                object: (*obj).clone(),
                art,
            },
        );
        for c in &obj.children {
            if seen.insert(c.object_id.as_str()) {
                queue.push(c.object_id.as_str());
            }
        }
    }
    Ok(sources)
}

/// The objects reachable from `root_id` through children, excluding the root
/// itself, deduplicated, in a stable breadth-first order. Cycle-tolerant.
/// The export gate sweeps these for Tier 1 problems.
pub fn descendants(root_id: &str, objects: &[Object]) -> Vec<Object> {
    let by_id: BTreeMap<&str, &Object> = objects.iter().map(|o| (o.id.as_str(), o)).collect();
    let mut seen: BTreeSet<&str> = BTreeSet::from([root_id]);
    let mut queue: Vec<&str> = Vec::new();
    if let Some(root) = by_id.get(root_id) {
        for c in &root.children {
            if seen.insert(c.object_id.as_str()) {
                queue.push(c.object_id.as_str());
            }
        }
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i < queue.len() {
        let id = queue[i];
        i += 1;
        let Some(obj) = by_id.get(id) else { continue };
        out.push((*obj).clone());
        for c in &obj.children {
            if seen.insert(c.object_id.as_str()) {
                queue.push(c.object_id.as_str());
            }
        }
    }
    out
}

/// The composed view of one Object for the canvas: flattened artwork as a
/// PNG (base64), composed collision/occlusion, the anchor and the root's
/// origin in composed space, and direct child footprints for the selection
/// highlight. Serialized straight to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ComposedObject {
    pub width: u32,
    pub height: u32,
    pub anchor: Anchor,
    pub origin_x: u32,
    pub origin_y: u32,
    pub art_data: String,
    pub collision: Collision,
    pub occlusion: Occlusion,
    pub children: Vec<Option<ChildFootprint>>,
}

/// Compose one Object for the canvas. The project state comes in-memory from
/// the frontend (edits may not have autosaved yet); only the immutable
/// artwork pixels are read from disk. Same flattening path as budgets/export.
pub fn compose_for_canvas(
    project_dir: &str,
    project: &Project,
    object_id: &str,
) -> Result<ComposedObject, String> {
    let sources = load_sources(project_dir, &project.objects, std::iter::once(object_id))?;
    let flat = flatten(object_id, &sources)?;
    let png = crate::exporter::encode_png(flat.width, flat.height, &flat.pixels)?;
    Ok(ComposedObject {
        width: flat.width,
        height: flat.height,
        anchor: flat.anchor,
        origin_x: flat.origin_x,
        origin_y: flat.origin_y,
        art_data: STANDARD.encode(png),
        collision: Collision {
            cells: flat.collision,
        },
        occlusion: Occlusion {
            pixels: flat.occlusion,
        },
        children: flat.children,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object::{ChildPlacement, Object};

    /// A source with explicit anchor and solid-colour pixels.
    fn source(name: &str, w: u32, h: u32, anchor: (u32, u32), rgb: [u8; 3]) -> Source {
        let mut object = Object::for_test(name, w, h);
        object.anchor = Anchor {
            x: anchor.0,
            y: anchor.1,
        };
        Source {
            object,
            art: DecodedArtwork {
                width: w,
                height: h,
                pixels: vec![[rgb[0], rgb[1], rgb[2], 255]; (w * h) as usize],
            },
        }
    }

    fn sources(list: Vec<Source>) -> BTreeMap<String, Source> {
        list.into_iter()
            .map(|s| (s.object.id.clone(), s))
            .collect()
    }

    fn place(parent: &mut Source, child: &Source, x: i32, y: i32) {
        parent.object.children.push(ChildPlacement {
            object_id: child.object.id.clone(),
            x,
            y,
        });
    }

    #[test]
    fn childless_object_flattens_to_itself() {
        let s = source("Rock", 32, 16, (16, 16), [9, 8, 7]);
        let id = s.object.id.clone();
        let flat = flatten(&id, &sources(vec![s])).unwrap();
        assert_eq!((flat.width, flat.height), (32, 16));
        assert_eq!(flat.anchor, Anchor { x: 16, y: 16 });
        assert_eq!((flat.origin_x, flat.origin_y), (0, 0));
        assert_eq!(flat.pixels.len(), 32 * 16);
        assert_eq!(flat.pixels[0], [9, 8, 7, 255]);
        assert!(flat.collision.is_empty());
        assert!(flat.occlusion.is_empty());
        assert!(flat.children.is_empty());
    }

    #[test]
    fn transparent_and_magenta_pixels_normalise_to_empty() {
        let mut s = source("Ghost", 16, 16, (0, 0), [5, 5, 5]);
        s.art.pixels[0] = [255, 0, 255, 255]; // magenta sentinel
        s.art.pixels[1] = [9, 9, 9, 0]; // alpha-0
        let id = s.object.id.clone();
        let flat = flatten(&id, &sources(vec![s])).unwrap();
        assert_eq!(flat.pixels[0], [0, 0, 0, 0]);
        assert_eq!(flat.pixels[1], [0, 0, 0, 0]);
        assert_eq!(flat.pixels[2], [5, 5, 5, 255]);
    }

    #[test]
    fn child_places_anchor_to_anchor_and_grid_grows_to_union() {
        // Parent 32x32, anchor (16, 32). Child 16x16, anchor (0, 0), placed at
        // offset (16, 0): the child's anchor lands on parent px (32, 32) - the
        // child hangs off the parent's right-bottom corner. Union bbox is
        // (0,0)..(48,48).
        let mut parent = source("House", 32, 32, (16, 32), [1, 1, 1]);
        let child = source("Sign", 16, 16, (0, 0), [2, 2, 2]);
        place(&mut parent, &child, 16, 0);
        let id = parent.object.id.clone();
        let flat = flatten(&id, &sources(vec![parent, child])).unwrap();

        assert_eq!((flat.width, flat.height), (48, 48));
        assert_eq!(flat.anchor, Anchor { x: 16, y: 32 });
        assert_eq!((flat.origin_x, flat.origin_y), (0, 0));
        // Parent pixel at (0, 0); child pixel at (32, 32); gap transparent.
        assert_eq!(flat.pixels[0], [1, 1, 1, 255]);
        assert_eq!(flat.pixels[(32 * 48 + 32) as usize], [2, 2, 2, 255]);
        assert_eq!(flat.pixels[(40 * 48 + 8) as usize][3], 0);
        // Footprint aligns with the placement.
        let fp = flat.children[0].as_ref().unwrap();
        assert_eq!((fp.x, fp.y, fp.width, fp.height), (32, 32, 16, 16));
    }

    #[test]
    fn child_left_of_the_parent_shifts_the_origin() {
        // Parent anchor bottom-left (0, 16); child anchor bottom-right
        // (16, 16). Offset (0, 0) overlays the anchors, so the child's rect
        // spans (-16, -16)..(0, 0) in parent-anchor space, directly left of
        // the parent's (0, -16)..(16, 0): the union extends left and the
        // parent's origin shifts right accordingly.
        let mut parent = source("Tree", 16, 16, (0, 16), [1, 1, 1]);
        let child = source("Bird", 16, 16, (16, 16), [2, 2, 2]);
        place(&mut parent, &child, 0, 0);
        let id = parent.object.id.clone();
        let flat = flatten(&id, &sources(vec![parent, child])).unwrap();
        assert_eq!((flat.width, flat.height), (32, 16));
        assert_eq!((flat.origin_x, flat.origin_y), (16, 0));
        assert_eq!(flat.anchor, Anchor { x: 16, y: 16 });
        assert_eq!(flat.pixels[0], [2, 2, 2, 255]); // child at the left
        assert_eq!(flat.pixels[16], [1, 1, 1, 255]); // parent at the right
    }

    #[test]
    fn parent_paints_over_children_and_later_children_over_earlier() {
        let mut parent = source("P", 16, 16, (0, 0), [3, 3, 3]);
        // Parent's top-left quarter is transparent so children show through.
        for y in 0..8u32 {
            for x in 0..8u32 {
                parent.art.pixels[(y * 16 + x) as usize] = [0, 0, 0, 0];
            }
        }
        let a = source("A", 16, 16, (0, 0), [10, 0, 0]);
        let b = source("B", 8, 8, (0, 0), [0, 20, 0]);
        place(&mut parent, &a, 0, 0);
        place(&mut parent, &b, 0, 0);
        let id = parent.object.id.clone();
        let flat = flatten(&id, &sources(vec![parent, a, b])).unwrap();
        // In the transparent quarter: B (added later) covers A.
        assert_eq!(flat.pixels[0], [0, 20, 0, 255]);
        // Outside B's 8x8 but inside the transparent quarter... B covers the
        // whole quarter, so check below the quarter instead: parent wins.
        assert_eq!(flat.pixels[(8 * 16) as usize], [3, 3, 3, 255]);
    }

    #[test]
    fn occlusion_follows_the_topmost_visible_pixel() {
        let mut parent = source("P", 16, 16, (0, 0), [3, 3, 3]);
        // Parent transparent on the left half, opaque (non-occluding) right.
        for y in 0..16u32 {
            for x in 0..8u32 {
                parent.art.pixels[(y * 16 + x) as usize] = [0, 0, 0, 0];
            }
        }
        let mut child = source("C", 16, 16, (0, 0), [7, 7, 7]);
        child.object.occlusion.pixels = (0..256u32).collect(); // fully occluding
        place(&mut parent, &child, 0, 0);
        let id = parent.object.id.clone();
        let flat = flatten(&id, &sources(vec![parent, child])).unwrap();
        // Left half: the child is visible, so its occlusion survives.
        assert!(flat.occlusion.contains(&0));
        // Right half: the parent's opaque non-occluding pixel is on top, so
        // the cell does not occlude even though the hidden child did.
        assert!(!flat.occlusion.contains(&8));
        assert_eq!(flat.pixels[8], [3, 3, 3, 255]);
    }

    #[test]
    fn collision_topmost_painted_cell_wins_and_unpainted_shows_through() {
        let mut parent = source("P", 32, 16, (0, 0), [1, 1, 1]);
        // Parent paints only its cell 1 (right cell).
        parent
            .object
            .collision
            .cells
            .insert(1, CollisionValue::Custom("tall_grass".to_string()));
        let mut child = source("C", 32, 16, (0, 0), [2, 2, 2]);
        // Child paints both of its cells Blocked.
        child.object.collision.cells.insert(0, CollisionValue::Blocked);
        child.object.collision.cells.insert(1, CollisionValue::Blocked);
        place(&mut parent, &child, 0, 0);
        let id = parent.object.id.clone();
        let flat = flatten(&id, &sources(vec![parent, child])).unwrap();
        // Cell 0: parent unpainted, child's Blocked shows through.
        assert_eq!(flat.collision.get(&0), Some(&CollisionValue::Blocked));
        // Cell 1: parent painted on top, its value wins.
        assert_eq!(
            flat.collision.get(&1),
            Some(&CollisionValue::Custom("tall_grass".to_string()))
        );
    }

    #[test]
    fn child_collision_lands_at_the_offset_cell() {
        // Parent 16x16 with a child 16x16 to its right: the child's Blocked
        // cell 0 maps to composed cell 1.
        let mut parent = source("P", 16, 16, (0, 0), [1, 1, 1]);
        let mut child = source("C", 16, 16, (0, 0), [2, 2, 2]);
        child.object.collision.cells.insert(0, CollisionValue::Blocked);
        place(&mut parent, &child, 16, 0);
        let id = parent.object.id.clone();
        let flat = flatten(&id, &sources(vec![parent, child])).unwrap();
        assert_eq!((flat.width, flat.height), (32, 16));
        assert!(!flat.collision.contains_key(&0));
        assert_eq!(flat.collision.get(&1), Some(&CollisionValue::Blocked));
    }

    #[test]
    fn nested_children_flatten_recursively() {
        // grandchild under child under parent, each shifted one cell right.
        let mut parent = source("P", 16, 16, (0, 0), [1, 0, 0]);
        let mut child = source("C", 16, 16, (0, 0), [0, 2, 0]);
        let grand = source("G", 16, 16, (0, 0), [0, 0, 3]);
        place(&mut child, &grand, 16, 0);
        place(&mut parent, &child, 16, 0);
        let id = parent.object.id.clone();
        let flat = flatten(&id, &sources(vec![parent, child, grand])).unwrap();
        assert_eq!((flat.width, flat.height), (48, 16));
        assert_eq!(flat.pixels[0], [1, 0, 0, 255]);
        assert_eq!(flat.pixels[16], [0, 2, 0, 255]);
        assert_eq!(flat.pixels[32], [0, 0, 3, 255]);
        // The direct child's footprint covers its whole subtree (child+grand).
        let fp = flat.children[0].as_ref().unwrap();
        assert_eq!((fp.x, fp.width), (16, 32));
    }

    #[test]
    fn direct_cycle_is_rejected() {
        let mut a = source("A", 16, 16, (0, 0), [1, 1, 1]);
        let a_id = a.object.id.clone();
        a.object.children.push(ChildPlacement {
            object_id: a_id.clone(),
            x: 0,
            y: 16,
        });
        let err = flatten(&a_id, &sources(vec![a])).unwrap_err();
        assert!(err.contains("inside itself"), "got: {err}");
    }

    #[test]
    fn transitive_cycle_is_rejected() {
        let mut a = source("A", 16, 16, (0, 0), [1, 1, 1]);
        let mut b = source("B", 16, 16, (0, 0), [2, 2, 2]);
        let a_id = a.object.id.clone();
        place(&mut a, &b, 16, 0);
        b.object.children.push(ChildPlacement {
            object_id: a_id.clone(),
            x: 16,
            y: 0,
        });
        let err = flatten(&a_id, &sources(vec![a, b])).unwrap_err();
        assert!(err.contains("inside itself"), "got: {err}");
    }

    #[test]
    fn diamond_sharing_is_not_a_cycle() {
        // A -> B, A -> C, B -> D, C -> D: D appears twice, legitimately.
        let mut a = source("A", 16, 16, (0, 0), [1, 1, 1]);
        let mut b = source("B", 16, 16, (0, 0), [2, 2, 2]);
        let mut c = source("C", 16, 16, (0, 0), [3, 3, 3]);
        let d = source("D", 16, 16, (0, 0), [4, 4, 4]);
        place(&mut b, &d, 0, 16);
        place(&mut c, &d, 0, 16);
        place(&mut a, &b, 16, 0);
        place(&mut a, &c, 32, 0);
        let a_id = a.object.id.clone();
        let flat = flatten(&a_id, &sources(vec![a, b, c, d])).unwrap();
        assert_eq!(flat.width, 48);
    }

    #[test]
    fn missing_child_composes_to_nothing() {
        let mut parent = source("P", 16, 16, (0, 0), [1, 1, 1]);
        parent.object.children.push(ChildPlacement {
            object_id: "gone".to_string(),
            x: 160,
            y: 0,
        });
        let id = parent.object.id.clone();
        let flat = flatten(&id, &sources(vec![parent])).unwrap();
        assert_eq!((flat.width, flat.height), (16, 16));
        assert_eq!(flat.children, vec![None]);
    }

    #[test]
    fn oversized_composition_is_rejected() {
        let mut parent = source("P", 16, 16, (0, 0), [1, 1, 1]);
        let child = source("C", 16, 16, (0, 0), [2, 2, 2]);
        place(&mut parent, &child, 100_000, 0);
        let id = parent.object.id.clone();
        let err = flatten(&id, &sources(vec![parent, child])).unwrap_err();
        assert!(err.contains("too far apart"), "got: {err}");
    }

    #[test]
    fn flatten_is_deterministic() {
        let mut parent = source("P", 32, 32, (16, 32), [1, 1, 1]);
        let mut child = source("C", 16, 16, (8, 16), [2, 2, 2]);
        child.object.collision.cells.insert(0, CollisionValue::Blocked);
        child.object.occlusion.pixels.insert(5);
        place(&mut parent, &child, 0, -16);
        let id = parent.object.id.clone();
        let srcs = sources(vec![parent, child]);
        assert_eq!(flatten(&id, &srcs).unwrap(), flatten(&id, &srcs).unwrap());
    }

    #[test]
    fn descendants_walks_the_graph_without_looping() {
        let mut a = Object::for_test("A", 16, 16);
        let mut b = Object::for_test("B", 16, 16);
        let c = Object::for_test("C", 16, 16);
        b.children.push(ChildPlacement {
            object_id: c.id.clone(),
            x: 0,
            y: 0,
        });
        // A cycle back to A must not loop the walk.
        b.children.push(ChildPlacement {
            object_id: a.id.clone(),
            x: 0,
            y: 0,
        });
        a.children.push(ChildPlacement {
            object_id: b.id.clone(),
            x: 0,
            y: 0,
        });
        let a_id = a.id.clone();
        let all = vec![a, b, c];
        let d = descendants(&a_id, &all);
        let names: Vec<&str> = d.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["B", "C"]);
    }
}
