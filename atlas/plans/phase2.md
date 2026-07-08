# Atlas Phase 2 Plan

> Where Atlas goes after the MVP, and where it deliberately does not.

Version: 0.2

> **Naming:** Atlas is the internal codename. The product ships as **Porygon**.

Status: draft for discussion. Nothing here is committed work until promoted into implementation.md.

---

# The Positioning Decision

The question Phase 2 must answer first: does Porygon grow drawing tools and compete with Aseprite?

**No. Porygon never owns artwork creation. It owns everything the artwork means.**

The reasoning, recorded so we do not relitigate it:

* Aseprite is a decade of drawing tools, animation, palettes, brushes, and Lua scripting with a devoted community, priced at 20 dollars. A credible fraction of that surface would consume multiple Porygon-lifetimes and produce a worse Aseprite attached to our actual product.
* Pixel artists do not switch art tools. Asking a romhacker to abandon Aseprite is a huge ask; asking them to add Porygon downstream of it is a small one.
* Nothing in Porygon's differentiated value - Object semantics, collision and occlusion, budget prediction, the grid-truth runtime preview, the Porytiles compile loop - requires owning the pixels.
* The Bible's own test applies: a feature that makes Atlas feel like a competing paint program is the wrong abstraction.

The strategic posture instead: **make the seam with the art tool invisible**. Every improvement Aseprite ships should make Porygon better, not threaten it.

---

# Headline Features

## 1. Hot Reload

The real pain in the current flow is the round trip: export a PNG from the art tool, import into Porygon, repeat on every edit.

* An Object remembers the source path it was imported from.
* Porygon watches that file. On save, the artwork re-imports automatically: canvas refreshes, budgets recompute, play preview updates.
* The artist keeps Aseprite on one monitor and Porygon on the other. Porygon becomes the live "engine view" of the art tool.
* Dimension changes on reload follow the variant dimension rule: same-size reloads are silent; a size change surfaces as a clear choice (accept and invalidate masks, or reject), never silent mask corruption.

## 2. Native .ase / .aseprite Import

Remove the export step entirely.

* The .aseprite format is documented; parse it directly (flattened composite). Fallback: shell out to the Aseprite CLI for headless export when parsing falls short.
* An Object may point at a .ase file as its source; hot reload then watches the .ase itself.
* Layer-name conventions, opt-in and boring: a layer named `occlusion` seeds the occlusion mask on first import. Nothing else is inferred.

## 3. Grounds: Bottom-Layer Authoring

"Rock on sand, rock on dirt, rock behind water" - background swapping - is an engine concept, not an artistic one, and it belongs in Porygon.

Why not bake backgrounds in the art tool:

* Baking multiplies budgets. Rock-on-sand, rock-on-dirt, and rock-on-water as three PNGs are three sets of unique tiles; every 8x8 mixing rock edge with ground is a distinct tile with a blended palette, and Porytiles can dedupe none of it. Kept as separate planes, one set of rock tiles plus one set of ground tiles serves every combination, and ground tiles dedupe across the whole tileset.
* Ground carries behavior. Sand is MB_SAND, pond water is surfable. A ground that is a first-class object updates collision semantics on swap; a flattened PNG cannot express that.
* The engine already has the slot. Emerald metatiles have a bottom layer, and the COVERED layer type (bottom + middle) exists precisely so a prop sits on ground in a separate plane. The MVP decomposition deliberately left bottom empty; compiler.md reserved it for under-detail, and the dormant three-plane validity check is waiting for it.

Two stages:

**3a. Preview backdrop (cheap, ships first).** A canvas option showing the selected object against a backdrop: checkerboard, flat color, or another object's artwork tiled underneath. Pure canvas feature, zero schema impact. Answers "does this rock read well on sand?" immediately.

**3b. Ground objects (the real feature).** Mark an Object as Ground: tileable, no occlusion, its own behavior tags. A prop (or a tileset) references a ground; ground pixels route to bottom.png in the decomposition. Metatiles become COVERED where ground shows under the prop. The three-plane check goes live: ground + prop + occlusion in one 16x16 cell is the one illegal combination, surfaced as the Tier 2 diagnostic already written. Swapping a prop's ground becomes a one-click, near-zero-budget operation. M12 scene children are most of the machinery; this is approximately a placement that targets the bottom layer.

Out of scope within grounds: partially submerged looks (water lapping over a rock's base). That is water animation territory, an explicit non-goal; hand-drawn artwork handles it better.

---

# Carried Forward from Beta

Deferred items recorded in docs/beta-checklist.md, now scheduled into Phase 2 rather than left floating:

* **Primary-palette sharing in Tier 2 prediction.** The paired partner primary's palettes effectively extend capacity; the meter currently ignores this and over-warns. Lives in budgets.rs / pokemon_emerald::secondary_budgets (budgets are already data).
* **Read budgets from the target project's fieldmap.h** instead of the verified stock constants, so modified bases (raised NUM_PALS_TOTAL etc.) meter correctly. Lives in pokemon_emerald.rs, plumbed through the persisted compile target.
* **Unified toast/error surface.** Store errors currently render only on the start screen and canvas pill; a store error raised elsewhere can be invisible. Small notification layer, one home for project.error.
* **compiler.md residual risks**, unchanged: runtime occlusion visual confirmed in an emulator; the in-app Porymap prefab check.

---

# Explicit Non-Goals (Phase 2)

* **Drawing tools.** Recorded hypothesis, not plan: if Porygon ever draws, it must be only the drawing Aseprite structurally cannot do - budget-aware editing (live palette meters while placing colors, warnings when a stroke pushes an 8x8 tile past 15 colors, visibility into which regions dedupe for free). Trigger condition to revisit: repeated, unprompted demand from beta users. Until then, not even a pencil.
* **Tile animation.** Unchanged from the Bible.
* **Maps inside Atlas.** Unchanged from the Bible. Grounds are per-object semantics, not map editing.
* **Generic plugin API.** Unchanged: extracted only when a second engine target exists.

---

# Milestone Sketch (order by risk and value, to be firmed up)

* **P2.1** Preview backdrop + unified toast surface (small, immediate quality of life)
* **P2.2** Hot reload (file watching, reload rules, dimension-change handling)
* **P2.3** .ase import (parser, CLI fallback, occlusion layer convention; hot reload watches .ase)
* **P2.4** Grounds (Ground objects, bottom-layer routing, COVERED emission, three-plane check live, ground swap UX)
* **P2.5** Budget model fidelity (primary-palette sharing, fieldmap.h budgets)
* **P2.6** Residual-risk confirmations (emulator occlusion check, in-app prefab verification) - can run any time alongside the above

Each milestone keeps the MVP rules: shippable at every step, Rust owns schemas, additive serde defaults, every mutation undoable, exact version pins, all claims traced to compiler.md or new spikes.

---

# Resolved Decisions (2026-07-08)

1. **Ground attachment**: Tileset-level default ground with per-prop override.
2. **Grounds and variants are orthogonal.** Atlas does not model paired seasonal ground/artwork combinations; a ground swap and a variant switch are independent operations that happen to compose. No pairing mechanism.
3. **Hot reload is undoable.** A reload pushes an undo entry restoring the previous pixels; artwork bytes are cheap to keep for one step.
4. **.ase import starts flattened.** Layer-groups-as-scene-children is a possible later convenience, not Phase 2 scope.
