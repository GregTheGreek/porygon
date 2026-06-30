"""Error parsing (unit) + symbol/address resolution (against the real ELF)."""

import pytest

from porygon.core.diagnostics import SymbolResolver, parse_build_errors

# --- error parsing: pure unit, no toolchain -----------------------------

def test_parse_gcc_error_with_column():
    diags = parse_build_errors("src/main.c:42:10: error: 'foo' undeclared here")
    assert len(diags) == 1
    d = diags[0]
    assert d == {
        "file": "src/main.c",
        "line": 42,
        "col": 10,
        "severity": "error",
        "message": "'foo' undeclared here",
        "kind": "compile",
        "needs_source_resolution": False,
    }


def test_parse_agbcc_error_without_column():
    diags = parse_build_errors("src/battle.c:128: warning: implicit declaration of function 'Foo'")
    assert len(diags) == 1
    assert diags[0]["line"] == 128
    assert diags[0]["col"] is None
    assert diags[0]["severity"] == "warning"


def test_parse_stdin_flags_reconciliation():
    diags = parse_build_errors("<stdin>:5:1: error: expected ';'")
    assert diags[0]["file"] == "<stdin>"
    assert diags[0]["needs_source_resolution"] is True


def test_parse_linker_undefined_reference():
    diags = parse_build_errors(
        "build/modern/src/foo.o: in function `Foo':\n"
        "foo.c:(.text+0x10): undefined reference to `MissingSym'"
    )
    link = [d for d in diags if d["kind"] == "link"]
    assert link and link[0]["severity"] == "error"


def test_parse_dedupes_repeated_lines():
    text = "src/x.c:1:1: error: boom\nsrc/x.c:1:1: error: boom\n"
    assert len(parse_build_errors(text)) == 1


def test_parse_ignores_noise():
    assert parse_build_errors("gcc -c foo.c -o foo.o\nmake: *** [Makefile:1] Error 1\n") == []


# --- symbol resolution: against the real built ELF ----------------------

# (address, symbol) pairs read from pokeemerald_modern.map
KNOWN = [
    (0x0806B424, "CB2_InitBattle"),
    (0x08046AFC, "CB2_SetUpReshowBattleScreenAfterMenu"),
    (0x08068E38, "Task_HidePartyStatusSummary"),
]


@pytest.fixture(scope="session")
def resolver(project):
    elf = project.elf_path()
    if elf is None:
        pytest.skip("no built ELF (pokeemerald_modern.elf) present")
    return SymbolResolver(elf)


@pytest.mark.parametrize("addr,name", KNOWN)
def test_lookup_symbol_matches_map(resolver, addr, name):
    assert resolver.lookup_symbol(name) == addr


@pytest.mark.parametrize("addr,name", KNOWN)
def test_resolve_address_finds_function(resolver, addr, name):
    r = resolver.resolve_address(addr)
    assert r["function"] == name
    assert r["exact"] is True


def test_resolve_line_works_where_dwarf_exists(resolver):
    # This artifact was built without DINFO=1, so most pokeemerald C has no
    # DWARF; only files carrying -g (e.g. libgcc helpers) do. Verify the DWARF
    # line decoder against whatever IS covered, so the test holds regardless of
    # whether the user builds with debug info.
    resolver._load()
    for fn in resolver._funcs:
        line = resolver.resolve_line(fn.addr)
        if line:
            assert isinstance(line["file"], str) and line["file"]
            assert isinstance(line["line"], int)
            return
    pytest.skip("no DWARF line info in this build (rebuild with DINFO=1 for source lines)")


def test_resolve_roundtrip(resolver):
    for _, name in KNOWN:
        addr = resolver.lookup_symbol(name)
        assert resolver.resolve_address(addr)["function"] == name


def test_address_inside_function_resolves(resolver):
    # A few bytes into a function still resolves to that function.
    r = resolver.resolve_address(0x0806B424 + 4)
    assert r["function"] == "CB2_InitBattle"
