"""Thin mGBA helper - command construction only (no GUI spawned)."""

from porygon.core.emu import GDB_PORT, gdb_connect_hint, launch_command, mgba_path


def test_launch_command_basic():
    assert launch_command("rom.gba", mgba="/x/mGBA") == ["/x/mGBA", "rom.gba"]


def test_launch_command_with_gdb():
    assert launch_command("rom.gba", gdb=True, mgba="/x/mGBA") == ["/x/mGBA", "-g", "rom.gba"]


def test_gdb_hint_mentions_port():
    hint = gdb_connect_hint("pokeemerald_modern.elf")
    assert f"localhost:{GDB_PORT}" in hint
    assert "target remote" in hint


def test_mgba_path_returns_str_or_none():
    p = mgba_path()
    assert p is None or isinstance(p, str)
