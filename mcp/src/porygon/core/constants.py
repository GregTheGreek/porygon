"""Index of C `#define` constants from include/constants/*.h.

Used by script validation to confirm that a referenced FLAG_/VAR_/ITEM_/...
constant actually exists (an undefined one fails the ROM build). Parsing is a
simple, fork-agnostic regex over the project's own headers, so expansion forks
that add constants are handled automatically.
"""

from __future__ import annotations

import re
from pathlib import Path

# `#define NAME value` / `#define NAME(args) ...` - capture the NAME.
_DEFINE_RE = re.compile(r"^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)")

# Map a constant prefix to the header(s) most likely to define it. Validation
# falls back to the full index, so this is only a hint for category_of().
_PREFIX_HINTS = {
    "FLAG_": "flags.h",
    "VAR_": "vars.h",
    "ITEM_": "items.h",
    "OBJ_EVENT_GFX_": "event_objects.h",
    "MOVEMENT_TYPE_": "event_object_movement.h",
    "SPECIES_": "species.h",
    "MUS_": "songs.h",
    "SE_": "songs.h",
    "MB_": "metatile_behaviors.h",
}


class ConstantsIndex:
    """Lazily parse include/constants/*.h and answer existence queries."""

    def __init__(self, root):
        self.root = Path(root)
        self._names: set[str] | None = None

    def _dir(self) -> Path:
        return self.root / "include" / "constants"

    def _load(self) -> None:
        if self._names is not None:
            return
        names: set[str] = set()
        d = self._dir()
        if d.is_dir():
            for header in d.glob("*.h"):
                try:
                    text = header.read_text(errors="replace")
                except OSError:
                    continue
                for line in text.splitlines():
                    m = _DEFINE_RE.match(line)
                    if m:
                        names.add(m.group(1))
        self._names = names

    def is_defined(self, name: str) -> bool:
        self._load()
        return name in self._names

    def category_of(self, name: str) -> str | None:
        for prefix, header in _PREFIX_HINTS.items():
            if name.startswith(prefix):
                return header
        return None

    def count(self) -> int:
        self._load()
        return len(self._names)
