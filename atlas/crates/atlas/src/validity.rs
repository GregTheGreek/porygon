//! Object-validity checks (Tier 1), the seed of the Problems surface.
//!
//! The Bible defines three validity tiers. Tier 1 is authoring-time: "is the
//! object internally coherent?", fixed on the Canvas. Milestone 6 begins with a
//! single honest check - artwork whose dimensions are not a multiple of 16px, so
//! the collision grid's edge cells only partially cover the artwork.
//!
//! Tier 2 (Tileset) and Tier 3 (Export) validity arrive with their milestones
//! (9 and 11); this module intentionally covers only Tier 1 for now.

use serde::Serialize;

use crate::collision::{grid_dims, CELL};
use crate::object::Object;
use crate::occlusion::pixel_count;

/// Which validity tier a problem belongs to. `Object` (Tier 1) is authoring-time
/// and fixed on the Canvas; `Tileset` (Tier 2, M9) is compile-time and fixed in
/// the Tileset view; `Export` (Tier 3, M11) is round-trip-time - a Porytiles
/// outcome mapped back to artist terms (bible: raw compiler output never reaches
/// the artist).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Tier {
    Object,
    Tileset,
    Export,
}

/// A single validity problem, in artist terms. Never engine/compiler jargon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub tier: Tier,
    pub message: String,
}

/// Tier 1 problems for one Object. Empty means the object is internally
/// coherent as far as the current checks go. `all` is the project's object
/// list, needed because the M12 cycle check follows child references; the
/// object itself does not have to be in `all`.
pub fn object_problems(object: &Object, all: &[Object]) -> Vec<Problem> {
    let mut problems = Vec::new();

    if !object.width.is_multiple_of(CELL) || !object.height.is_multiple_of(CELL) {
        problems.push(Problem {
            tier: Tier::Object,
            // Wording mirrors compiler.md's Tier 1 table.
            message: "This artwork doesn't fit the tile grid. Extend the canvas \
                      to the next 16px boundary."
                .to_string(),
        });
    }

    // A well-formed collision mask paints only cells that exist on the grid.
    // The editor never paints out of bounds; this catches a hand-edited or
    // stale project.json before it becomes a confusing export failure.
    let (cols, rows) = grid_dims(object.width, object.height);
    let cell_count = cols * rows;
    if object.collision.cells.keys().any(|&i| i >= cell_count) {
        problems.push(Problem {
            tier: Tier::Object,
            message: "Some painted collision falls outside the artwork. \
                      Re-paint the collision layer to fix it."
                .to_string(),
        });
    }

    // Same coherence guarantee for the occlusion mask: every occluding pixel
    // index must land inside the artwork. The editor never paints out of
    // bounds; this catches a hand-edited or stale project.json.
    //
    // The "three depth planes in one cell" case compiler.md calls out is a
    // Tier 2 (Tileset) problem, not Tier 1 - it depends on the bottom layer,
    // which the MVP decomposition never paints from occlusion alone, so a
    // single object's occlusion (top/middle only) can never trigger it. That
    // check arrives with the Tileset milestone (M9), not here.
    let pixels = pixel_count(object.width, object.height);
    if object.occlusion.pixels.iter().any(|&i| i >= pixels) {
        problems.push(Problem {
            tier: Tier::Object,
            message: "Some painted occlusion falls outside the artwork. \
                      Re-paint the occlusion layer to fix it."
                .to_string(),
        });
    }

    // A cycle in the scene graph (an object containing itself, directly or
    // transitively) makes composition impossible (M12). The editor refuses to
    // create one; this catches hand-edited files. The only child-placement
    // rule the milestone adds.
    if has_child_cycle(object, all) {
        problems.push(Problem {
            tier: Tier::Object,
            message: "This object's children contain a loop: an object ends up \
                      inside itself. Remove the looping child."
                .to_string(),
        });
    }

    problems
}

/// True when any cycle is reachable from `object` through child references.
/// Gray/black DFS: `path` holds the ids being expanded (a revisit is a
/// cycle), `done` the ids fully explored, so each object is visited once
/// even in diamond-shaped graphs.
fn has_child_cycle(object: &Object, all: &[Object]) -> bool {
    use std::collections::{BTreeMap, BTreeSet};

    fn visit<'a>(
        id: &'a str,
        by_id: &BTreeMap<&'a str, &'a Object>,
        path: &mut Vec<&'a str>,
        done: &mut BTreeSet<&'a str>,
    ) -> bool {
        if path.contains(&id) {
            return true;
        }
        if done.contains(id) {
            return false;
        }
        let Some(obj) = by_id.get(id) else {
            return false; // dangling reference: composes to nothing
        };
        path.push(id);
        for c in &obj.children {
            if visit(c.object_id.as_str(), by_id, path, done) {
                return true;
            }
        }
        path.pop();
        done.insert(id);
        false
    }

    let mut by_id: BTreeMap<&str, &Object> = all.iter().map(|o| (o.id.as_str(), o)).collect();
    by_id.insert(object.id.as_str(), object);
    visit(
        object.id.as_str(),
        &by_id,
        &mut Vec::new(),
        &mut BTreeSet::new(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::object::Object;

    #[test]
    fn artwork_on_grid_has_no_problems() {
        let obj = Object::for_test("Tree", 32, 48);
        assert!(object_problems(&obj, &[]).is_empty());
    }

    #[test]
    fn artwork_off_grid_warns_tier_one() {
        let obj = Object::for_test("Odd", 30, 48);
        let problems = object_problems(&obj, &[]);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].tier, Tier::Object);
        assert!(problems[0].message.contains("16px"));
    }

    #[test]
    fn either_dimension_off_grid_warns() {
        assert_eq!(object_problems(&Object::for_test("W", 31, 32), &[]).len(), 1);
        assert_eq!(object_problems(&Object::for_test("H", 32, 31), &[]).len(), 1);
    }

    #[test]
    fn in_bounds_collision_is_not_flagged() {
        use crate::collision::CollisionValue;
        // 32x48 -> 2x3 = 6 cells (indices 0..=5).
        let mut obj = Object::for_test("Tree", 32, 48);
        obj.collision.cells.insert(5, CollisionValue::Blocked);
        assert!(object_problems(&obj, &[]).is_empty());
    }

    #[test]
    fn out_of_bounds_collision_warns() {
        use crate::collision::CollisionValue;
        let mut obj = Object::for_test("Tree", 32, 48);
        obj.collision.cells.insert(6, CollisionValue::Blocked); // index 6 == cols*rows
        let problems = object_problems(&obj, &[]);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].message.contains("outside the artwork"));
    }

    #[test]
    fn in_bounds_occlusion_is_not_flagged() {
        // 32x48 = 1536 px, valid indices 0..=1535.
        let mut obj = Object::for_test("Tree", 32, 48);
        obj.occlusion.pixels.insert(0);
        obj.occlusion.pixels.insert(1535);
        assert!(object_problems(&obj, &[]).is_empty());
    }

    #[test]
    fn child_cycle_warns_tier_one() {
        use crate::object::ChildPlacement;
        let mut a = Object::for_test("A", 16, 16);
        let mut b = Object::for_test("B", 16, 16);
        a.children.push(ChildPlacement {
            object_id: b.id.clone(),
            x: 0,
            y: 0,
        });
        b.children.push(ChildPlacement {
            object_id: a.id.clone(),
            x: 0,
            y: 0,
        });
        let all = vec![a.clone(), b];
        let problems = object_problems(&a, &all);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].tier, Tier::Object);
        assert!(problems[0].message.contains("loop"));
    }

    #[test]
    fn diamond_children_are_not_a_cycle() {
        use crate::object::ChildPlacement;
        let mut a = Object::for_test("A", 16, 16);
        let mut b = Object::for_test("B", 16, 16);
        let mut c = Object::for_test("C", 16, 16);
        let d = Object::for_test("D", 16, 16);
        let child = |o: &Object| ChildPlacement {
            object_id: o.id.clone(),
            x: 0,
            y: 0,
        };
        b.children.push(child(&d));
        c.children.push(child(&d));
        a.children.push(child(&b));
        a.children.push(child(&c));
        let all = vec![a.clone(), b, c, d];
        assert!(object_problems(&a, &all).is_empty());
    }

    #[test]
    fn missing_child_reference_is_not_flagged() {
        use crate::object::ChildPlacement;
        let mut a = Object::for_test("A", 16, 16);
        a.children.push(ChildPlacement {
            object_id: "gone".to_string(),
            x: 0,
            y: 0,
        });
        assert!(object_problems(&a, &[a.clone()]).is_empty());
    }

    #[test]
    fn out_of_bounds_occlusion_warns() {
        let mut obj = Object::for_test("Tree", 32, 48);
        obj.occlusion.pixels.insert(1536); // index 1536 == width*height
        let problems = object_problems(&obj, &[]);
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].tier, Tier::Object);
        assert!(problems[0].message.contains("occlusion"));
    }
}
