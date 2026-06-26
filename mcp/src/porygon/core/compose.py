"""Phase 6: compose a walkable map from a high-level MapSpec using stamps + terrain.

For FOREIGN / imperfect source images, where per-cell matching (image_to_existing_map)
fragments structured objects: a pokeemerald house is a fixed mosaic of ~25 specific
metatiles, and matching each cell independently shatters it. Here the AI (vision) emits
a MapSpec describing terrain regions + object placements; this module fills terrain and
places multi-tile STAMPS (prefab objects) as units, so houses/labs stay coherent, then
writes a walkable, ROM-buildable map.

Stamps are RECIPES (source_map + rect) resolved against the user's OWN project at compose
time, so the metatile ids + collision are always valid for that project (fork-safe) and
read straight from real map data - which is also why stamped doors come out walkable.

MapSpec shape:
    {
      "name": "MyTown",
      "group": "aa_image_toMap",            # optional; created if missing (else default group)
      "primary_tileset": "gTileset_General", "secondary_tileset": "gTileset_Petalburg",
      "width": 20, "height": 18,
      "base_terrain": "grass",
      "border_terrain": "tree", "border_thickness": 2,
      "regions": [
        {"terrain": "water", "rect": [13, 4, 5, 4]},   # filled + auto-banked (shoreline)
        {"stamp": "pond_with_shore", "rect": [3, 3]}    # OR drop a real-map chunk verbatim
      ],
      "objects": [{"stamp": "house", "x": 3, "y": 4}],
      "decorations": [{"terrain": "flower", "x": 4, "y": 14}],
      "link": {"to": "MAP_LITTLEROOT_TOWN", "dir": "up", "offset": 0}
    }

Terrain whose palette entry defines `edges` (e.g. water) is autotiled after fill: a
post-pass rewrites boundary cells to the correct edge/corner metatile so water gets a
real rocky shoreline instead of a hard rectangle. Stamped cells are never autotiled.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Optional

from porygon.core.blockdata import Block, Blockdata, encode_blocks
from porygon.core.imaging import ELEVATION_DEFAULT, _OPPOSITE_DIR, names_for, render_match_preview


class ComposeError(Exception):
    pass


# --- data loading (shipped defaults + project-local overrides) ----------

def _load_data(filename: str) -> dict:
    return json.loads(resources.files("porygon").joinpath(f"data/{filename}").read_text())


def _project_stamps_path(project) -> Path:
    return project.root / ".porygon" / "stamps.json"


def load_stamps(project) -> dict:
    """Shipped stamp recipes merged with the project's own (project overrides by name)."""
    stamps = dict(_load_data("stamps.json"))
    pf = _project_stamps_path(project)
    if pf.exists():
        try:
            stamps.update(json.loads(pf.read_text()))
        except (OSError, json.JSONDecodeError) as e:
            raise ComposeError(f"could not read project stamps {pf}: {e}") from e
    return stamps


def terrain_palette(primary: str, secondary: str) -> dict:
    data = _load_data("terrain.json")
    key = f"{primary}+{secondary}"
    if key not in data:
        pairs = [k for k in data if not k.startswith("_")]
        raise ComposeError(
            f"no terrain palette for tileset pair {key!r} (have: {', '.join(pairs)}). "
            f"Add one to data/terrain.json or use a supported pair."
        )
    return data[key]


# --- stamps -------------------------------------------------------------

@dataclass
class Stamp:
    name: str
    width: int
    height: int
    blocks: list[list[Block]]            # row-major [h][w]
    door: Optional[tuple] = None


def resolve_stamp(project, name: str, recipe: dict) -> Stamp:
    """Read a stamp's metatiles from its source map in the CURRENT project.

    Validates the source map exists and uses the recipe's tileset pair (else the
    metatile ids would be invalid in the target map).
    """
    src = recipe["source_map"]
    if not project.map_exists(src):
        raise ComposeError(f"stamp {name!r}: source_map {src!r} not found in this project")
    layout_id = project.read_map(src)["layout"]
    layout = project.get_layout(layout_id)
    want = (recipe["primary_tileset"], recipe["secondary_tileset"])
    have = (layout.primary_tileset, layout.secondary_tileset)
    if have != want:
        raise ComposeError(
            f"stamp {name!r}: source map {src} uses tilesets {have} but recipe expects {want}"
        )
    bd = project.read_layout_blockdata(layout_id)
    x, y, w, h = recipe["rect"]
    if x < 0 or y < 0 or x + w > bd.width or y + h > bd.height:
        raise ComposeError(
            f"stamp {name!r}: rect {recipe['rect']} out of bounds for {layout_id} "
            f"({bd.width}x{bd.height})"
        )
    blocks = [[bd.get(x + i, y + j) for i in range(w)] for j in range(h)]
    door = tuple(recipe["door"]) if recipe.get("door") else None
    return Stamp(name, w, h, blocks, door)


def list_stamps(project) -> list[dict]:
    out = []
    for name, r in sorted(load_stamps(project).items()):
        x, y, w, h = r["rect"]
        out.append({
            "name": name, "width": w, "height": h, "source_map": r["source_map"],
            "tileset": f"{r['primary_tileset']}+{r['secondary_tileset']}",
            "tags": r.get("tags", []),
        })
    return out


def extract_stamp(project, name: str, source_map: str, x: int, y: int, w: int, h: int,
                  door=None) -> dict:
    """Record a new stamp recipe (source map + rect) in <root>/.porygon/stamps.json.

    Stores coordinates, not pixels, so it stays valid as the source map evolves and
    works on this fork's own art. Captures the tileset pair from the source map.
    """
    if not project.map_exists(source_map):
        raise ComposeError(f"source_map {source_map!r} not found")
    layout = project.get_layout(project.read_map(source_map)["layout"])
    bd = project.read_layout_blockdata(layout.id)
    if x < 0 or y < 0 or x + w > bd.width or y + h > bd.height:
        raise ComposeError(f"rect [{x},{y},{w},{h}] out of bounds for {layout.id} ({bd.width}x{bd.height})")
    recipe = {
        "source_map": source_map, "rect": [x, y, w, h],
        "primary_tileset": layout.primary_tileset, "secondary_tileset": layout.secondary_tileset,
    }
    if door:
        recipe["door"] = list(door)
    pf = _project_stamps_path(project)
    pf.parent.mkdir(parents=True, exist_ok=True)
    existing = {}
    if pf.exists():
        existing = json.loads(pf.read_text())
    existing[name] = recipe
    pf.write_text(json.dumps(existing, indent=2) + "\n")
    return {"written": str(pf), "name": name, "recipe": recipe}


# --- composition --------------------------------------------------------

def _terrain_block(entry: dict, gx: int, gy: int) -> Block:
    """A terrain Block at world (gx,gy). entry is a single metatile_id or a tiled block."""
    coll = entry.get("collision", 0)
    elev = entry.get("elevation", ELEVATION_DEFAULT)
    if "block" in entry:
        blk = entry["block"]
        bh, bw = len(blk), len(blk[0])
        mid = blk[gy % bh][gx % bw]
    else:
        mid = entry["metatile_id"]
    return Block(metatile_id=mid, collision=coll, elevation=elev)


# Cells written by a stamp/region-stamp are tagged this class so the autotile pass
# never rewrites verbatim real geometry.
_OBJECT_CLASS = "object"


def _edge_key(n_land: bool, e_land: bool, s_land: bool, w_land: bool):
    """Which outer edge/corner a cell sits on, given which 4-dir neighbours are a
    DIFFERENT terrain class ("land"). Returns None for an interior cell (use fill).

    Handles convex corners + straight sides (the common case: rectangular/strip
    water regions). Concave (inner) corners fall back to fill in v1.
    """
    if n_land and w_land:
        return "NW"
    if n_land and e_land:
        return "NE"
    if s_land and w_land:
        return "SW"
    if s_land and e_land:
        return "SE"
    if n_land:
        return "N"
    if s_land:
        return "S"
    if w_land:
        return "W"
    if e_land:
        return "E"
    return None


def _unique_names(project, base: str) -> dict:
    """Names for `base`, or the same with the lowest free `_NNNNN` suffix if its map/layout
    already exist. Lets the same scene be re-composed without manual renaming. The suffix is
    appended to the derived ids directly so it survives as e.g. MAP_IMAGE_ROUTE_A_00001
    (camel/snake normalization would otherwise swallow the separator before digits).
    """
    names = names_for(base)

    def taken(n: dict) -> bool:
        if project.map_exists(n["map_id"]):
            return True
        return any(layout.id == n["layout_id"] for layout in project.list_layouts())

    if not taken(names):
        return names
    i = 1
    while True:
        suf = f"_{i:05d}"
        cand = dict(names)
        cand["map_id"] = names["map_id"] + suf
        cand["layout_id"] = names["layout_id"] + suf
        cand["map_name"] = names["map_name"] + suf
        cand["layout_name"] = f'{names["map_name"]}{suf}_Layout'
        if not taken(cand):
            return cand
        i += 1


def compose_map(project, spec: dict, preview: bool = True) -> dict:
    """Compose a walkable map from a MapSpec: terrain fill + stamps + reciprocal link.

    preview=True renders match_preview.png (needs the tileset binaries on disk); tests pass
    preview=False to run without them.
    """
    prim = spec["primary_tileset"]
    sec = spec["secondary_tileset"]
    palette = terrain_palette(prim, sec)
    stamps_lib = load_stamps(project)
    W, H = int(spec["width"]), int(spec["height"])
    if W <= 0 or H <= 0:
        raise ComposeError("width and height must be positive")

    def terr(tname: str) -> dict:
        if tname not in palette:
            raise ComposeError(f"unknown terrain {tname!r} (have: {', '.join(palette)})")
        return palette[tname]

    grid: list[list[Optional[Block]]] = [[None] * W for _ in range(H)]
    # Parallel terrain-class grid, used by the autotile pass to find boundaries.
    class_grid: list[list[str]] = [[""] * W for _ in range(H)]

    def fill(tname: str, x0: int, y0: int, w: int, h: int) -> None:
        e = terr(tname)
        for j in range(max(0, y0), min(H, y0 + h)):
            for i in range(max(0, x0), min(W, x0 + w)):
                grid[j][i] = _terrain_block(e, i, j)
                class_grid[j][i] = tname

    # 1. base terrain
    base = spec.get("base_terrain", "grass")
    fill(base, 0, 0, W, H)
    warnings: list[str] = []
    placed: list[dict] = []

    def place_stamp(nm: str, ox: int, oy: int, as_: str) -> None:
        """Blit a resolved stamp verbatim and tag its cells `object` (never autotiled)."""
        if nm not in stamps_lib:
            raise ComposeError(f"unknown stamp {nm!r} (have: {', '.join(sorted(stamps_lib))})")
        st = resolve_stamp(project, nm, stamps_lib[nm])
        if ox < 0 or oy < 0 or ox + st.width > W or oy + st.height > H:
            warnings.append(f"stamp {nm!r} at ({ox},{oy}) [{st.width}x{st.height}] out of bounds; skipped")
            return
        for j in range(st.height):
            for i in range(st.width):
                grid[oy + j][ox + i] = st.blocks[j][i]
                class_grid[oy + j][ox + i] = _OBJECT_CLASS
        placed.append({"stamp": nm, "x": ox, "y": oy, "width": st.width, "height": st.height, "as": as_})

    # 2. terrain regions (in order). A region may name a `stamp` (a macro-region real-map
    #    chunk, e.g. pond_with_shore) instead of a `terrain` fill, in which case the real
    #    geometry is dropped in verbatim and excluded from autotiling.
    for reg in spec.get("regions", []):
        rx, ry = int(reg["rect"][0]), int(reg["rect"][1])
        if reg.get("stamp"):
            place_stamp(reg["stamp"], rx, ry, "region")
        else:
            rw, rh = int(reg["rect"][2]), int(reg["rect"][3])
            fill(reg["terrain"], rx, ry, rw, rh)
    # 3. border rings
    bt = spec.get("border_terrain")
    thick = int(spec.get("border_thickness", 0))
    if bt and thick > 0:
        e = terr(bt)
        for j in range(H):
            for i in range(W):
                if i < thick or i >= W - thick or j < thick or j >= H - thick:
                    grid[j][i] = _terrain_block(e, i, j)
                    class_grid[j][i] = bt
    # 4. object stamps
    for obj in spec.get("objects", []):
        place_stamp(obj["stamp"], int(obj["x"]), int(obj["y"]), "object")
    # 5. single-cell decorations
    for dec in spec.get("decorations", []):
        dx, dy = int(dec["x"]), int(dec["y"])
        if 0 <= dx < W and 0 <= dy < H:
            grid[dy][dx] = _terrain_block(terr(dec["terrain"]), dx, dy)
            class_grid[dy][dx] = dec["terrain"]

    # 6. autotile pass: rewrite terrain boundary cells to the correct edge/corner
    #    metatile so regions (esp. water) get real shorelines instead of hard seams.
    #    Only classes that define `edges` are affected; stamped ("object") cells are
    #    never rewritten. Out-of-bounds counts as same-class (no bank vs the map edge).
    def _same(i: int, j: int, cls: str) -> bool:
        if i < 0 or j < 0 or i >= W or j >= H:
            return True
        return class_grid[j][i] == cls

    for j in range(H):
        for i in range(W):
            cls = class_grid[j][i]
            entry = palette.get(cls)
            if not entry or "edges" not in entry:
                continue
            edges = entry["edges"]
            key = _edge_key(
                not _same(i, j - 1, cls), not _same(i + 1, j, cls),
                not _same(i, j + 1, cls), not _same(i - 1, j, cls),
            )
            mid = edges.get(key) if key else None
            if mid is None:
                mid = edges.get("fill", entry.get("metatile_id"))
            grid[j][i] = Block(
                metatile_id=mid,
                collision=entry.get("collision", 0),
                elevation=entry.get("elevation", ELEVATION_DEFAULT),
            )

    blocks = [grid[j][i] for j in range(H) for i in range(W)]
    bd = Blockdata(width=W, height=H, blocks=blocks)

    # write layout + map (reuse Phase 5 plumbing). Resolve a unique name so re-composing
    # the same scene never collides: append an incremental _NNNNN suffix when taken.
    names = _unique_names(project, spec["name"])
    entry = project.add_layout(
        names["layout_id"], names["layout_name"], W, H,
        primary_tileset=prim, secondary_tileset=sec,
    )
    (project.root / entry["blockdata_filepath"]).write_bytes(bd.encode())
    base_entry = terr(base)
    border_mt = base_entry["metatile_id"] if "metatile_id" in base_entry else base_entry["block"][0][0]
    (project.root / entry["border_filepath"]).write_bytes(
        encode_blocks([Block(border_mt, 0, ELEVATION_DEFAULT)] * 4)
    )
    map_path = project.add_map(names["map_id"], names["map_name"], names["layout_id"],
                               group=spec.get("group"), create_group=True)

    # reciprocal wiring so you can walk in and back out
    wiring: dict = {"linked": False}
    link = spec.get("link")
    if link:
        to = link["to"]
        dirn = link.get("dir", "up")
        off = int(link.get("offset", 0))
        if not project.map_exists(to):
            raise ComposeError(f"link.to map {to!r} not found")
        opp = _OPPOSITE_DIR.get(dirn)
        if opp is None:
            raise ComposeError(f"unknown link dir {dirn!r} (use {', '.join(_OPPOSITE_DIR)})")
        project.edit_connection(names["map_id"], "add", direction=dirn, offset=off, dest_map=to)
        project.edit_connection(to, "add", direction=opp, offset=-off, dest_map=names["map_id"])
        wiring = {"linked": True, "neighbour": to, "direction": dirn,
                  "reciprocal_direction": opp, "offset": off}

    # preview (needs tileset binaries; optional so unit tests can skip it)
    preview_path = None
    if preview:
        from porygon.core import tileset as tilesetmod
        atlas = tilesetmod.render_tileset(project, prim, sec)
        placement = [[grid[j][i].metatile_id for i in range(W)] for j in range(H)]
        preview_path = render_match_preview(
            atlas, placement,
            (project.root / entry["blockdata_filepath"]).parent / "match_preview.png",
        )

    return {
        "ok": True,
        "map": names["map_id"],
        "map_name": names["map_name"],
        "map_json": str(map_path),
        "layout": names["layout_id"],
        "width": W, "height": H,
        "primary_tileset": prim, "secondary_tileset": sec,
        "stamps_placed": placed,
        "match_preview": preview_path,
        "wiring": wiring,
        "warnings": warnings,
        "rom_build_note": (
            "References existing tilesets; the MAP_ constant is auto-generated from "
            "map_groups.json, so a normal `make` builds it into the ROM with no C edits. "
            "Compare match_preview.png against the source."
            + ("" if wiring["linked"] else " Not yet reachable: add a `link` to wire a neighbour.")
        ),
    }
