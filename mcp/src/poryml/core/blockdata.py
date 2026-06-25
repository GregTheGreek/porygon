"""Read/write pokeemerald map grid blockdata (``map.bin`` / ``border.bin``).

Each block is a 16-bit little-endian value packed as (see
``include/global.fieldmap.h``):

    bits 0-9   metatile id   (mask 0x03FF)
    bits 10-11 collision     (mask 0x0C00)
    bits 12-15 elevation     (mask 0xF000)

The encode/decode pair is exact: decoding a ``map.bin`` and re-encoding it
yields byte-identical output (this is the Phase 0 correctness gate).
"""

from __future__ import annotations

from dataclasses import dataclass

# Masks/shifts mirrored verbatim from include/global.fieldmap.h.
MAPGRID_METATILE_ID_MASK = 0x03FF
MAPGRID_COLLISION_MASK = 0x0C00
MAPGRID_ELEVATION_MASK = 0xF000
MAPGRID_METATILE_ID_SHIFT = 0
MAPGRID_COLLISION_SHIFT = 10
MAPGRID_ELEVATION_SHIFT = 12

# An undefined block has all metatile id bits set and nothing else.
MAPGRID_UNDEFINED = MAPGRID_METATILE_ID_MASK

METATILE_ID_MAX = 0x3FF  # 10 bits
COLLISION_MAX = 0x3      # 2 bits
ELEVATION_MAX = 0xF      # 4 bits


@dataclass
class Block:
    """A single map grid block: metatile id + collision + elevation."""

    metatile_id: int
    collision: int
    elevation: int

    @classmethod
    def from_u16(cls, value: int) -> "Block":
        return cls(
            metatile_id=(value & MAPGRID_METATILE_ID_MASK) >> MAPGRID_METATILE_ID_SHIFT,
            collision=(value & MAPGRID_COLLISION_MASK) >> MAPGRID_COLLISION_SHIFT,
            elevation=(value & MAPGRID_ELEVATION_MASK) >> MAPGRID_ELEVATION_SHIFT,
        )

    def to_u16(self) -> int:
        # Validate rather than silently truncate: out-of-range values almost
        # always indicate a caller bug, and silent masking would corrupt maps.
        if not 0 <= self.metatile_id <= METATILE_ID_MAX:
            raise ValueError(f"metatile_id {self.metatile_id} out of range 0..{METATILE_ID_MAX}")
        if not 0 <= self.collision <= COLLISION_MAX:
            raise ValueError(f"collision {self.collision} out of range 0..{COLLISION_MAX}")
        if not 0 <= self.elevation <= ELEVATION_MAX:
            raise ValueError(f"elevation {self.elevation} out of range 0..{ELEVATION_MAX}")
        return (
            (self.metatile_id << MAPGRID_METATILE_ID_SHIFT)
            | (self.collision << MAPGRID_COLLISION_SHIFT)
            | (self.elevation << MAPGRID_ELEVATION_SHIFT)
        )

    def to_dict(self) -> dict:
        return {
            "metatile_id": self.metatile_id,
            "collision": self.collision,
            "elevation": self.elevation,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Block":
        return cls(
            metatile_id=int(d["metatile_id"]),
            collision=int(d["collision"]),
            elevation=int(d["elevation"]),
        )


def decode_blocks(raw: bytes) -> list[Block]:
    """Decode a flat ``.bin`` byte string into a list of blocks (row-major)."""
    if len(raw) % 2 != 0:
        raise ValueError(f"blockdata length {len(raw)} is not a multiple of 2 bytes")
    return [
        Block.from_u16(int.from_bytes(raw[i : i + 2], "little"))
        for i in range(0, len(raw), 2)
    ]


def encode_blocks(blocks: list[Block]) -> bytes:
    return b"".join(b.to_u16().to_bytes(2, "little") for b in blocks)


@dataclass
class Blockdata:
    """A 2D grid of blocks with known dimensions (a layout's ``map.bin``).

    ``trailing`` holds any bytes in the file beyond ``width*height*2``. A
    handful of upstream "unused" layouts ship a ``map.bin`` larger than their
    declared dimensions; Porymap reads the declared grid and ignores the rest.
    We keep those bytes so a no-op decode/encode is byte-identical and never
    silently shrinks a file.
    """

    width: int
    height: int
    blocks: list[Block]
    trailing: bytes = b""

    def __post_init__(self) -> None:
        expected = self.width * self.height
        if len(self.blocks) != expected:
            raise ValueError(
                f"block count {len(self.blocks)} != width*height ({self.width}*{self.height}={expected})"
            )

    @classmethod
    def decode(cls, raw: bytes, width: int, height: int) -> "Blockdata":
        expected = width * height * 2
        if len(raw) < expected:
            raise ValueError(
                f"blockdata is {len(raw)} bytes but width*height*2 = {expected} "
                f"({width}x{height}); file is too small for the declared dimensions"
            )
        return cls(
            width=width,
            height=height,
            blocks=decode_blocks(raw[:expected]),
            trailing=raw[expected:],
        )

    def encode(self) -> bytes:
        return encode_blocks(self.blocks) + self.trailing

    def index(self, x: int, y: int) -> int:
        if not (0 <= x < self.width and 0 <= y < self.height):
            raise IndexError(f"({x},{y}) out of bounds for {self.width}x{self.height}")
        return y * self.width + x

    def get(self, x: int, y: int) -> Block:
        return self.blocks[self.index(x, y)]

    def set(self, x: int, y: int, block: Block) -> None:
        self.blocks[self.index(x, y)] = block

    def to_grid(self) -> list[list[dict]]:
        """Row-major 2D list of block dicts (handy for JSON / inspection)."""
        return [
            [self.get(x, y).to_dict() for x in range(self.width)]
            for y in range(self.height)
        ]

    @classmethod
    def from_grid(cls, grid: list[list[dict]]) -> "Blockdata":
        height = len(grid)
        width = len(grid[0]) if height else 0
        blocks: list[Block] = []
        for row in grid:
            if len(row) != width:
                raise ValueError("grid rows are not all the same width")
            blocks.extend(Block.from_dict(c) for c in row)
        return cls(width=width, height=height, blocks=blocks)
