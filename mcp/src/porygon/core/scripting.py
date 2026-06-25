"""Event-scripting primitives: label cross-ref validation, macro vocabulary,
and optional Poryscript compile.

Works on the hand-written `.inc` workflow both repos use today; Poryscript is
supported only if a project already has it (detected, never required).
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from porygon.core.constants import ConstantsIndex

# A label definition at column 0: `Name::` (global) or `Name:` (local).
_LABEL_DEF_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)::?(?:\s|$)")
# A `.macro name args...` line.
_MACRO_RE = re.compile(r"^\s*\.macro\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*?)\s*$")
# Constant-like tokens worth validating (these fail the build if undefined).
_CONST_TOKEN_RE = re.compile(
    r"\b(FLAG_[A-Z0-9_]+|VAR_[A-Z0-9_]+|ITEM_[A-Z0-9_]+|OBJ_EVENT_GFX_[A-Z0-9_]+"
    r"|MOVEMENT_TYPE_[A-Z0-9_]+|SPECIES_[A-Z0-9_]+)\b"
)
# Constant values that are literals/sentinels, never #defined names.
_CONST_ALLOWLIST = {"0"}


# --- label parsing ------------------------------------------------------

def parse_labels(inc_text: str) -> dict[str, bool]:
    """Return {label_name: is_global} for every label defined in an .inc file."""
    labels: dict[str, bool] = {}
    for line in inc_text.splitlines():
        if not line or line[0].isspace():
            continue
        m = _LABEL_DEF_RE.match(line)
        if m:
            name = m.group(1)
            labels[name] = line[: m.end()].rstrip().endswith("::")
    return labels


# --- validation ---------------------------------------------------------

@dataclass
class Finding:
    severity: str  # error | warning
    kind: str      # dangling_label | unknown_constant | unused_label | no_scripts_file
    message: str
    detail: Optional[str] = None

    def to_dict(self) -> dict:
        return {"severity": self.severity, "kind": self.kind, "message": self.message, "detail": self.detail}


# Null/no-script sentinels used in map.json event `script` fields.
_NULL_SCRIPT = {"0", "0x0", "0x00", "NULL", "null", ""}


def _event_script_refs(map_json: dict) -> list[str]:
    refs = []
    for arr in ("object_events", "coord_events", "bg_events"):
        for ev in map_json.get(arr) or []:
            s = ev.get("script")
            if s and str(s) not in _NULL_SCRIPT:
                refs.append(s)
    return refs


def validate_map_scripts(project, map_id: str) -> dict:
    """Cross-reference a map's events against its scripts.inc and the constants.

    Errors: event script labels not defined in scripts.inc; referenced
    FLAG_/VAR_/ITEM_/gfx/movement constants that don't exist.
    Warnings: labels defined but never referenced.
    """
    map_json = project.read_map(map_id)
    scripts_path = project.map_scripts_path(map_id)
    consts = ConstantsIndex(project.root)

    findings: list[Finding] = []
    inc_text = ""
    if scripts_path and scripts_path.exists():
        inc_text = scripts_path.read_text(errors="replace")
    else:
        findings.append(Finding("warning", "no_scripts_file",
                                f"no scripts.inc found for {map_id}"))

    defined = parse_labels(inc_text)
    event_refs = _event_script_refs(map_json)

    # 1. every event script label must be defined
    for ref in event_refs:
        if ref not in defined:
            findings.append(Finding("error", "dangling_label",
                                    f"event references undefined script label {ref!r}",
                                    detail=f"define {ref} in {scripts_path}"))

    # 2. constants referenced in map.json + scripts.inc must exist
    import json as _json
    blob = _json.dumps(map_json) + "\n" + inc_text
    seen_const: set[str] = set()
    for tok in _CONST_TOKEN_RE.findall(blob):
        if tok in seen_const or tok in _CONST_ALLOWLIST:
            continue
        seen_const.add(tok)
        if not consts.is_defined(tok):
            findings.append(Finding("error", "unknown_constant",
                                    f"undefined constant {tok!r}",
                                    detail=consts.category_of(tok)))

    # 3. labels defined but never referenced (coarse: appears only at its def)
    ref_blob = _json.dumps(map_json) + "\n" + inc_text
    for label in defined:
        # count occurrences; a used label appears at least twice (def + ref)
        if ref_blob.count(label) <= 1:
            findings.append(Finding("warning", "unused_label",
                                    f"label {label!r} is defined but never referenced"))

    errors = [f for f in findings if f.severity == "error"]
    return {
        "map": map_id,
        "scripts_file": str(scripts_path) if scripts_path else None,
        "ok": not errors,
        "error_count": len(errors),
        "warning_count": len(findings) - len(errors),
        "defined_labels": len(defined),
        "event_refs": len(event_refs),
        "constants_checked": len(seen_const),
        "findings": [f.to_dict() for f in findings],
    }


# --- macro vocabulary ---------------------------------------------------

def _parse_macro_args(arg_str: str) -> list[dict]:
    args = []
    for raw in arg_str.split(","):
        tok = raw.strip()
        if not tok:
            continue
        if tok.endswith(":req"):
            args.append({"name": tok[: -len(":req")].strip(), "required": True, "default": None})
        elif ":" in tok and "=" not in tok:
            # e.g. name:vararg or other GAS qualifiers - treat as optional
            args.append({"name": tok.split(":")[0].strip(), "required": False, "default": None})
        elif "=" in tok:
            name, _, default = tok.partition("=")
            args.append({"name": name.strip(), "required": False, "default": default.strip()})
        else:
            args.append({"name": tok, "required": False, "default": None})
    return args


def load_macros(project) -> dict[str, list[dict]]:
    """Parse the project's own event.inc + movement.inc into {macro: [args]}."""
    macros: dict[str, list[dict]] = {}
    for rel in ("asm/macros/event.inc", "asm/macros/movement.inc"):
        path = project.root / rel
        if not path.exists():
            continue
        for line in path.read_text(errors="replace").splitlines():
            m = _MACRO_RE.match(line)
            if m:
                macros[m.group(1)] = _parse_macro_args(m.group(2))
    return macros


def lookup_macro(project, name: str) -> Optional[dict]:
    macros = load_macros(project)
    if name not in macros:
        return None
    return {"name": name, "args": macros[name]}


# --- scaffolding --------------------------------------------------------

def scaffold_script(kind: str, label: str, text: str = "PLACEHOLDER TEXT") -> str:
    """Return a boilerplate .inc block. Claude fills in the specifics/logic.

    kind: 'sign' (a readable sign) or 'npc' (lock/faceplayer/msgbox/release).
    The label is what you wire into the map.json event's `script` field.
    """
    esc = text.replace('"', '\\"')
    if kind == "sign":
        return (
            f"{label}::\n"
            f"\tmsgbox {label}_Text, MSGBOX_SIGN\n"
            f"\tend\n\n"
            f"{label}_Text:\n"
            f'\t.string "{esc}$"\n'
        )
    if kind == "npc":
        return (
            f"{label}::\n"
            f"\tlock\n"
            f"\tfaceplayer\n"
            f"\tmsgbox {label}_Text, MSGBOX_DEFAULT\n"
            f"\trelease\n"
            f"\tend\n\n"
            f"{label}_Text:\n"
            f'\t.string "{esc}$"\n'
        )
    raise ValueError(f"unknown scaffold kind {kind!r} (use 'sign' or 'npc')")


# --- poryscript (detected, optional) ------------------------------------

def poryscript_available(project) -> Optional[str]:
    """Path to a poryscript binary if the project/host has one, else None."""
    candidates = [
        project.root / "tools" / "poryscript" / "poryscript",
        Path.home() / "go" / "bin" / "poryscript",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    found = shutil.which("poryscript")
    return found


def poryscript_status(project) -> dict:
    binary = poryscript_available(project)
    tools = project.root / "tools" / "poryscript"
    uses_pory = any(project.root.glob("data/**/*.pory")) if (project.root / "data").exists() else False
    return {
        "available": binary is not None,
        "binary": binary,
        "font_config": str(tools / "font_config.json") if (tools / "font_config.json").exists() else None,
        "command_config": str(tools / "command_config.json") if (tools / "command_config.json").exists() else None,
        "project_uses_poryscript": uses_pory,
    }


def compile_poryscript(project, pory_path, inc_path) -> dict:
    """Compile a .pory to a .inc. Requires poryscript to be available."""
    binary = poryscript_available(project)
    if binary is None:
        return {"ok": False, "message": "poryscript not found (project uses hand-written .inc; this is optional)"}
    tools = project.root / "tools" / "poryscript"
    args = [binary, "-i", str(pory_path), "-o", str(inc_path)]
    fc, cc = tools / "font_config.json", tools / "command_config.json"
    if fc.exists():
        args += ["-fc", str(fc)]
    if cc.exists():
        args += ["-cc", str(cc)]
    try:
        proc = subprocess.run(args, cwd=str(project.root), capture_output=True, text=True)
    except FileNotFoundError:
        return {"ok": False, "message": f"poryscript binary not executable: {binary}"}
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "command": args,
        "output": ((proc.stdout or "") + (proc.stderr or ""))[-4000:],
    }
