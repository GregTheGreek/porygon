"""Thin mGBA helper: locate the emulator and build launch/GDB commands.

Phase 1 is deliberately thin. We build the invocation and a GDB hint; we do not
automate log capture (the macOS .app has no headless/log-to-file mode, and
capturing mgba_printf output would need a Lua bridge + a debug-enabled rebuild -
deferred). Launching the GUI is left to the caller / CLI, not the MCP server.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Optional

_MACOS_DEFAULT = "/Applications/mGBA.app/Contents/MacOS/mGBA"
GDB_PORT = 2345


def mgba_path() -> Optional[str]:
    """Find an mGBA binary: macOS .app, then PATH (mgba / mgba-qt)."""
    if Path(_MACOS_DEFAULT).exists():
        return _MACOS_DEFAULT
    for name in ("mgba-qt", "mgba"):
        found = shutil.which(name)
        if found:
            return found
    return None


def launch_command(rom, gdb: bool = False, mgba: Optional[str] = None) -> list[str]:
    """argv to launch a ROM in mGBA. With gdb=True, starts the GDB stub (:2345)."""
    exe = mgba or mgba_path()
    if exe is None:
        raise FileNotFoundError("mGBA not found (looked in /Applications and PATH)")
    args = [exe]
    if gdb:
        args.append("-g")  # start GDB server on port 2345
    args.append(str(rom))
    return args


def gdb_connect_hint(elf) -> str:
    """The arm-none-eabi-gdb snippet to attach to a running mGBA GDB stub."""
    return (
        f"arm-none-eabi-gdb {elf}\n"
        f"  (gdb) target remote localhost:{GDB_PORT}\n"
        f"  (gdb) break <function>\n"
        f"  (gdb) continue\n"
        f"# requires arm-none-eabi-gdb on PATH and mGBA launched with -g"
    )
