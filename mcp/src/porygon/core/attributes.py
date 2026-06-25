"""Read/write tileset ``metatile_attributes.bin``.

In pokeemerald each metatile attribute is a 16-bit little-endian value (see
``include/global.fieldmap.h``):

    bits 0-7   behavior    (mask 0x00FF)
    bits 8-11  unused      (preserved verbatim for round-trip fidelity)
    bits 12-15 layer type  (mask 0xF000)

Note: pokefirered uses 32-bit attributes; this module is emerald-format
(2 bytes). The ``entry_size`` argument is reserved for future firered support.
"""

from __future__ import annotations

from dataclasses import dataclass

METATILE_ATTR_BEHAVIOR_MASK = 0x00FF
METATILE_ATTR_LAYER_MASK = 0xF000
METATILE_ATTR_UNUSED_MASK = 0x0F00
METATILE_ATTR_BEHAVIOR_SHIFT = 0
METATILE_ATTR_LAYER_SHIFT = 12
METATILE_ATTR_UNUSED_SHIFT = 8

# Layer types (enum in global.fieldmap.h).
LAYER_TYPE_NAMES = {0: "NORMAL", 1: "COVERED", 2: "SPLIT"}

BEHAVIOR_MAX = 0xFF
LAYER_MAX = 0xF


@dataclass
class MetatileAttr:
    behavior: int
    layer_type: int
    unused: int = 0  # bits 8-11, preserved so encode is byte-exact

    @classmethod
    def from_u16(cls, value: int) -> "MetatileAttr":
        return cls(
            behavior=(value & METATILE_ATTR_BEHAVIOR_MASK) >> METATILE_ATTR_BEHAVIOR_SHIFT,
            layer_type=(value & METATILE_ATTR_LAYER_MASK) >> METATILE_ATTR_LAYER_SHIFT,
            unused=(value & METATILE_ATTR_UNUSED_MASK) >> METATILE_ATTR_UNUSED_SHIFT,
        )

    def to_u16(self) -> int:
        if not 0 <= self.behavior <= BEHAVIOR_MAX:
            raise ValueError(f"behavior {self.behavior} out of range 0..{BEHAVIOR_MAX}")
        if not 0 <= self.layer_type <= LAYER_MAX:
            raise ValueError(f"layer_type {self.layer_type} out of range 0..{LAYER_MAX}")
        return (
            (self.behavior << METATILE_ATTR_BEHAVIOR_SHIFT)
            | ((self.unused & 0xF) << METATILE_ATTR_UNUSED_SHIFT)
            | (self.layer_type << METATILE_ATTR_LAYER_SHIFT)
        )

    @property
    def layer_type_name(self) -> str:
        return LAYER_TYPE_NAMES.get(self.layer_type, f"UNKNOWN({self.layer_type})")

    def to_dict(self) -> dict:
        return {
            "behavior": self.behavior,
            "layer_type": self.layer_type,
            "layer_type_name": self.layer_type_name,
            "unused": self.unused,
        }


def decode_attributes(raw: bytes, entry_size: int = 2) -> list[MetatileAttr]:
    if entry_size != 2:
        raise NotImplementedError("only 2-byte (emerald) attributes are supported")
    if len(raw) % entry_size != 0:
        raise ValueError(f"attributes length {len(raw)} not a multiple of {entry_size}")
    return [
        MetatileAttr.from_u16(int.from_bytes(raw[i : i + entry_size], "little"))
        for i in range(0, len(raw), entry_size)
    ]


def encode_attributes(attrs: list[MetatileAttr], entry_size: int = 2) -> bytes:
    if entry_size != 2:
        raise NotImplementedError("only 2-byte (emerald) attributes are supported")
    return b"".join(a.to_u16().to_bytes(entry_size, "little") for a in attrs)
