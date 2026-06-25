"""Codec correctness, incl. the Phase 0 gate: byte-identical round-trips."""

import pytest

from porygon.core.attributes import MetatileAttr, decode_attributes, encode_attributes
from porygon.core.blockdata import Block, Blockdata, decode_blocks, encode_blocks


# --- unit: the codec is bijective over the full 16-bit space ------------

def test_block_u16_roundtrip_exhaustive():
    for v in range(0x10000):
        assert Block.from_u16(v).to_u16() == v


def test_attr_u16_roundtrip_exhaustive():
    for v in range(0x10000):
        assert MetatileAttr.from_u16(v).to_u16() == v


def test_block_field_extraction():
    # metatile 0x123, collision 0b10, elevation 0b1011 -> 0xB923
    v = 0xB923
    b = Block.from_u16(v)
    assert b.metatile_id == 0x123
    assert b.collision == 0b10
    assert b.elevation == 0b1011
    assert b.to_u16() == v


def test_block_rejects_out_of_range():
    with pytest.raises(ValueError):
        Block(metatile_id=0x400, collision=0, elevation=0).to_u16()  # 11 bits
    with pytest.raises(ValueError):
        Block(metatile_id=0, collision=4, elevation=0).to_u16()  # 3 bits
    with pytest.raises(ValueError):
        Block(metatile_id=0, collision=0, elevation=16).to_u16()  # 5 bits


def test_blockdata_dimension_mismatch():
    with pytest.raises(ValueError):
        Blockdata.decode(b"\x00\x00\x00\x00", width=3, height=3)  # 4 bytes != 18


def test_grid_roundtrip():
    raw = bytes(range(0, 16))  # 8 blocks
    bd = Blockdata.decode(raw, width=4, height=2)
    assert Blockdata.from_grid(bd.to_grid()).encode() == raw


def test_blocks_helpers_roundtrip():
    raw = bytes(range(0, 32))
    assert encode_blocks(decode_blocks(raw)) == raw


def test_attributes_helpers_roundtrip():
    raw = bytes(range(0, 32))
    assert encode_attributes(decode_attributes(raw)) == raw


# --- real project: decode -> encode must be byte-identical --------------

def test_all_layouts_blockdata_roundtrip(project):
    layouts = project.list_layouts()
    assert layouts, "expected at least one layout"
    for layout in layouts:
        original = project._resolve(layout.blockdata_filepath).read_bytes()
        bd = project.read_layout_blockdata(layout.id)
        assert bd.encode() == original, f"map.bin round-trip mismatch for {layout.id}"


def test_all_layouts_border_roundtrip(project):
    for layout in project.list_layouts():
        original = project._resolve(layout.border_filepath).read_bytes()
        blocks = project.read_layout_border(layout.id)
        assert encode_blocks(blocks) == original, f"border round-trip mismatch for {layout.id}"


def test_all_metatile_attributes_roundtrip(project):
    attr_files = sorted((project.root / "data" / "tilesets").rglob("metatile_attributes.bin"))
    assert attr_files, "expected metatile_attributes.bin files"
    for f in attr_files:
        original = f.read_bytes()
        assert encode_attributes(decode_attributes(original)) == original, f"attr round-trip mismatch for {f}"
