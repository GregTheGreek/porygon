"""Metatile rendering + perceptual matching (porygon's half; no Porytiles)."""

import pytest

PIL = pytest.importorskip("PIL")  # imaging extra
np = pytest.importorskip("numpy")
from PIL import Image  # noqa: E402

from porygon.core import tileset as ts  # noqa: E402


# --- naming + bitfields -------------------------------------------------

def test_label_to_folder():
    assert ts.label_to_folder("gTileset_General") == "general"
    assert ts.label_to_folder("gTileset_PetalburgGym") == "petalburg_gym"
    assert ts.label_to_folder("gTileset_Mauville") == "mauville"


def test_tile_entry_bitfields():
    entry = 0x123 | ts.TILE_ENTRY_HFLIP | ts.TILE_ENTRY_VFLIP | (0xA << ts.TILE_ENTRY_PAL_SHIFT)
    assert (entry & ts.TILE_ENTRY_INDEX) == 0x123
    assert entry & ts.TILE_ENTRY_HFLIP
    assert entry & ts.TILE_ENTRY_VFLIP
    assert (entry & ts.TILE_ENTRY_PAL) >> ts.TILE_ENTRY_PAL_SHIFT == 0xA


def test_is_blank_metatile():
    assert ts.is_blank_metatile([0] * 8)
    assert not ts.is_blank_metatile([1, 0, 0, 0, 0, 0, 0, 0])
    # pal bits set (non-zero palette) also counts as non-blank
    assert not ts.is_blank_metatile([0x1000, 0, 0, 0, 0, 0, 0, 0])


# --- palette parsing ----------------------------------------------------

def test_load_palettes(tmp_path):
    pals = tmp_path / "palettes"
    pals.mkdir()
    (pals / "00.pal").write_text("JASC-PAL\n0100\n16\n" + "\n".join(["0 0 0", "255 0 0"] + ["1 2 3"] * 14))
    (pals / "06.pal").write_text("JASC-PAL\n0100\n16\n" + "\n".join(["9 9 9"] * 16))
    loaded = ts.load_palettes(tmp_path)
    assert loaded[0][1] == (255, 0, 0)
    assert loaded[6][0] == (9, 9, 9)


# --- rendering ----------------------------------------------------------

def _two_tiles():
    """A 2-tile 'P' sheet: tile 0 = solid index 1, tile 1 = solid index 0 (transparent)."""
    img = Image.new("P", (16, 8), 0)
    img.putpalette([0, 0, 0, 255, 0, 0] + [0, 0, 0] * 14)
    for x in range(8):
        for y in range(8):
            img.putpixel((x, y), 1)  # tile 0 -> palette index 1
    return img


def _pals():
    return {0: [(0, 0, 0), (255, 0, 0)] + [(0, 0, 0)] * 14}


def test_render_metatile_composites_and_transparency():
    tiles = _two_tiles()
    # bottom layer: sub0=tile0 (red), sub1/2/3 = tile1 (transparent); top all transparent.
    entries = [0, 1, 1, 1, 1, 1, 1, 1]
    out = ts.render_metatile(entries, 8, tiles, _pals(), 512, 6)
    assert out.size == (16, 16)
    assert out.getpixel((0, 0)) == (255, 0, 0, 255)   # tile 0 painted
    assert out.getpixel((8, 0))[3] == 0               # tile 1 = transparent


def test_render_metatile_hflip():
    # 2-tile sheet: tile 0 has only its top-left pixel set (index 1 = red); tile 1 is
    # all index 0 (transparent) and fills every other sub/layer so nothing overpaints.
    img = Image.new("P", (16, 8), 0)
    img.putpalette([0, 0, 0, 255, 0, 0] + [0, 0, 0] * 14)
    img.putpixel((0, 0), 1)
    entries = [0 | ts.TILE_ENTRY_HFLIP, 1, 1, 1, 1, 1, 1, 1]
    out = ts.render_metatile(entries, 8, img, _pals(), 512, 6)
    # hflip moves the red pixel from x=0 to x=7 within the 8px tile
    assert out.getpixel((7, 0)) == (255, 0, 0, 255)
    assert out.getpixel((0, 0))[3] == 0


def test_render_metatile_secondary_tile_index_offset():
    # primary 2-tile sheet: tile 0 = red, tile 1 = transparent (filler). Secondary tile 0
    # = green via palette slot 6. Entry tile index 512 -> secondary[0]; fillers use the
    # transparent primary tile 1 so only the secondary tile shows at (0,0).
    primary = Image.new("P", (16, 8), 0)
    primary.putpalette([0, 0, 0, 255, 0, 0] + [0, 0, 0] * 14)
    for x in range(8):
        for y in range(8):
            primary.putpixel((x, y), 1)  # tile 0 solid red; tile 1 stays transparent
    secondary = Image.new("P", (8, 8), 1)
    secondary.putpalette([0, 0, 0, 0, 255, 0] + [0, 0, 0] * 14)
    sec_pals = {6: [(0, 0, 0), (0, 255, 0)] + [(0, 0, 0)] * 14}
    entries = [512 | (6 << ts.TILE_ENTRY_PAL_SHIFT), 1, 1, 1, 1, 1, 1, 1]
    out = ts.render_metatile(entries, 8, primary, _pals(), 512, 6, secondary, sec_pals)
    assert out.getpixel((0, 0)) == (0, 255, 0, 255)


# --- feature + matching -------------------------------------------------

def test_feature_vector_shape_and_match():
    red = Image.new("RGBA", (16, 16), (200, 20, 20, 255))
    blue = Image.new("RGBA", (16, 16), (20, 20, 200, 255))
    feats = np.stack([ts.feature_vector(red), ts.feature_vector(blue)])
    assert feats.shape == (2, 48)
    atlas = ts.MetatileAtlas(ids=[10, 11], images=[red, blue], features=feats)
    # a reddish cell should match the red metatile (id 10), not the blue one
    cell = Image.new("RGBA", (16, 16), (180, 30, 30, 255))
    mid, dist = atlas.match(cell)
    assert mid == 10 and dist >= 0
    assert atlas.image_for(11) is blue


# --- real repo (read-only) ----------------------------------------------

def test_render_real_primary_tileset(project):
    atlas = ts.render_tileset(project, "gTileset_General")
    assert len(atlas.ids) > 50  # general has hundreds of usable metatiles
    assert atlas.features.shape == (len(atlas.ids), 48)
    # every rendered metatile is a 16x16 image
    assert all(img.size == (16, 16) for img in atlas.images)
    # matching a mid-gray cell returns a real candidate id
    mid, dist = atlas.match(Image.new("RGBA", (16, 16), (120, 120, 120, 255)))
    assert mid in set(atlas.ids)


def test_render_real_with_secondary_offsets_ids(project):
    atlas = ts.render_tileset(project, "gTileset_General", "gTileset_Petalburg")
    base = project.num_metatiles_in_primary()
    assert any(mid >= base for mid in atlas.ids)   # secondary ids are offset
    assert any(mid < base for mid in atlas.ids)    # primary ids present too
