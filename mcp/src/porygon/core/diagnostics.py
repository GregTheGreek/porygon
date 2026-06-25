"""Build-error parsing and symbol/crash-address resolution.

Two independent capabilities, both toolchain-free (no arm-none-eabi-* needed):

* ``parse_build_errors`` turns raw ``make`` output into structured entries.
* ``SymbolResolver`` reads an unstripped ELF (``.symtab`` + DWARF) via
  pyelftools to map a name <-> address and an address -> source file:line.

pokeemerald's build pipes C through ``preproc`` and ``cc1 ... -o - -`` (cc1
reads stdin), so a diagnostic can occasionally cite ``<stdin>`` instead of the
real path; cpp ``# <line> "<file>"`` markers normally keep the real path, but we
flag the ``<stdin>`` case so a caller can reconcile it.
"""

from __future__ import annotations

import bisect
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# gcc: path:line:col: sev: msg   |   agbcc: path:line: sev: msg  (col optional)
_DIAG_RE = re.compile(
    r"^(?P<file>[^:\n]+):(?P<line>\d+):(?:(?P<col>\d+):)?\s*"
    r"(?P<sev>fatal error|error|warning|note):\s*(?P<msg>.*)$"
)
# linker: "undefined reference to `Foo'"
_LD_UNDEF_RE = re.compile(r"undefined reference to [`'\"]?(?P<sym>[^'`\"]+)")


@dataclass
class Diagnostic:
    file: Optional[str]
    line: Optional[int]
    col: Optional[int]
    severity: str
    message: str
    kind: str = "compile"  # compile | link
    needs_source_resolution: bool = False  # set when file is <stdin>

    def to_dict(self) -> dict:
        return {
            "file": self.file,
            "line": self.line,
            "col": self.col,
            "severity": self.severity,
            "message": self.message,
            "kind": self.kind,
            "needs_source_resolution": self.needs_source_resolution,
        }


def parse_build_errors(text: str) -> list[dict]:
    """Parse raw build output into a deduped list of diagnostic dicts."""
    out: list[Diagnostic] = []
    seen: set[tuple] = set()

    def add(d: Diagnostic) -> None:
        key = (d.file, d.line, d.col, d.severity, d.message, d.kind)
        if key not in seen:
            seen.add(key)
            out.append(d)

    for raw in text.splitlines():
        line = raw.rstrip()
        m = _DIAG_RE.match(line)
        if m:
            f = m.group("file")
            add(
                Diagnostic(
                    file=f,
                    line=int(m.group("line")),
                    col=int(m.group("col")) if m.group("col") else None,
                    severity=m.group("sev"),
                    message=m.group("msg").strip(),
                    needs_source_resolution=(f == "<stdin>"),
                )
            )
            continue
        um = _LD_UNDEF_RE.search(line)
        if um:
            add(
                Diagnostic(
                    file=None,
                    line=None,
                    col=None,
                    severity="error",
                    message=line.strip(),
                    kind="link",
                )
            )
    return [d.to_dict() for d in out]


@dataclass
class _Func:
    addr: int
    size: int
    name: str


class SymbolError(Exception):
    pass


class SymbolResolver:
    """Resolve symbols/addresses from an unstripped ELF using pyelftools.

    ARM functions are Thumb; their ``.symtab`` value has bit 0 set. We report
    function addresses with that bit cleared so they match the ``.map`` file and
    the addresses a user reads off a crash.
    """

    def __init__(self, elf_path):
        self.elf_path = Path(elf_path)
        if not self.elf_path.exists():
            raise SymbolError(f"ELF not found: {self.elf_path}")
        self._funcs: Optional[list[_Func]] = None
        self._func_addrs: list[int] = []
        self._by_name: dict[str, int] = {}

    # --- lazy load -------------------------------------------------------
    def _load(self) -> None:
        if self._funcs is not None:
            return
        from elftools.elf.elffile import ELFFile

        funcs: list[_Func] = []
        by_name: dict[str, int] = {}
        with open(self.elf_path, "rb") as f:
            elf = ELFFile(f)
            symtab = elf.get_section_by_name(".symtab")
            if symtab is None:
                raise SymbolError(f"{self.elf_path} has no .symtab (stripped?)")
            for sym in symtab.iter_symbols():
                name = sym.name
                if not name:
                    continue
                val = sym["st_value"]
                is_func = sym["st_info"]["type"] == "STT_FUNC"
                norm = val & ~1 if is_func else val
                by_name.setdefault(name, norm)
                if is_func:
                    funcs.append(_Func(addr=val & ~1, size=sym["st_size"], name=name))
        funcs.sort(key=lambda x: x.addr)
        self._funcs = funcs
        self._func_addrs = [fn.addr for fn in funcs]
        self._by_name = by_name

    # --- queries ---------------------------------------------------------
    def lookup_symbol(self, name: str) -> int:
        self._load()
        if name not in self._by_name:
            raise SymbolError(f"symbol {name!r} not found")
        return self._by_name[name]

    def function_at(self, addr: int) -> Optional[dict]:
        """Nearest preceding function containing ``addr`` (Thumb bit ignored)."""
        self._load()
        target = addr & ~1
        i = bisect.bisect_right(self._func_addrs, target) - 1
        if i < 0:
            return None
        fn = self._funcs[i]
        # If the symbol has a known size, require containment; size 0 -> best guess.
        if fn.size and target >= fn.addr + fn.size:
            return {"function": fn.name, "func_addr": fn.addr, "exact": False}
        return {"function": fn.name, "func_addr": fn.addr, "exact": True}

    def resolve_line(self, addr: int) -> Optional[dict]:
        """Map an address to {file, line} using the DWARF line program."""
        from elftools.elf.elffile import ELFFile

        target = addr & ~1
        with open(self.elf_path, "rb") as f:
            elf = ELFFile(f)
            if not elf.has_dwarf_info():
                return None
            dwarf = elf.get_dwarf_info()
            for cu in dwarf.iter_CUs():
                lp = dwarf.line_program_for_CU(cu)
                if lp is None:
                    continue
                prev = None
                for entry in lp.get_entries():
                    st = entry.state
                    if st is None:
                        continue
                    if prev is not None and not prev.end_sequence:
                        if prev.address <= target < st.address:
                            return {
                                "file": _file_name(lp, prev.file),
                                "line": prev.line,
                            }
                    prev = st
        return None

    def resolve_address(self, addr: int) -> dict:
        """Full resolution: {address, function, file, line} (best effort)."""
        self._load()
        result: dict = {"address": addr & ~1}
        fn = self.function_at(addr)
        if fn:
            result.update(fn)
        line = self.resolve_line(addr)
        if line:
            result.update(line)
        return result


def _file_name(lineprog, file_index: int) -> Optional[str]:
    """Resolve a line-program file index to a path (DWARF v<=4 and v5 differ)."""
    header = lineprog.header
    file_entries = header["file_entry"]
    version = lineprog.header.get("version", 4)
    # DWARF<=4: file_entry is 1-based; DWARF5: 0-based.
    idx = file_index if version >= 5 else file_index - 1
    if idx < 0 or idx >= len(file_entries):
        return None
    entry = file_entries[idx]
    name = entry.name
    if isinstance(name, bytes):
        name = name.decode("utf-8", "replace")
    dir_index = entry["dir_index"]
    dirs = header["include_directory"]
    if 0 <= dir_index < len(dirs):
        d = dirs[dir_index]
        if isinstance(d, bytes):
            d = d.decode("utf-8", "replace")
        if d and not name.startswith("/"):
            return f"{d}/{name}"
    return name
