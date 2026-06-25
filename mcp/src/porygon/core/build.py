"""Toolchain-agnostic build orchestration.

Runs a build command in the pokeemerald root and parses its output into
structured diagnostics. The command is configurable so it works with whatever
the user has - a native toolchain, a Docker wrapper, or CI - without baking any
of those in:

    resolution order: explicit `command` arg > $PORYGON_BUILD_CMD > default

The default is `make modern` (+ `DINFO=1` for debug symbols). We never run
`make compare` - a ROM hack won't match the stock `rom.sha1`.
"""

from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path
from typing import Optional

from porygon.core.diagnostics import parse_build_errors

ENV_BUILD_CMD = "PORYGON_BUILD_CMD"
_TAIL = 4000


def build_command(target: str = "modern", dinfo: bool = True, command: Optional[str] = None) -> list[str]:
    """Resolve the argv for the build."""
    cmd = command or os.environ.get(ENV_BUILD_CMD)
    if cmd:
        return shlex.split(cmd)
    args = ["make"]
    if target == "modern":
        args.append("modern")
    elif target and target != "agbcc":
        args.append(target)
    if dinfo:
        args.append("DINFO=1")
    return args


def build(
    root,
    target: str = "modern",
    dinfo: bool = True,
    command: Optional[str] = None,
    timeout: Optional[int] = None,
) -> dict:
    """Run the build in ``root`` and return a structured result.

    Returns: {ok, returncode, command, errors, error_count, warning_count,
    raw_tail, message?}. A missing build command yields ok=False with an
    actionable message rather than an exception.
    """
    root = Path(root)
    args = build_command(target=target, dinfo=dinfo, command=command)
    try:
        proc = subprocess.run(
            args,
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return {
            "ok": False,
            "returncode": None,
            "command": args,
            "errors": [],
            "error_count": 0,
            "warning_count": 0,
            "raw_tail": "",
            "message": (
                f"build command not found: {args[0]!r}. Install a GBA toolchain "
                f"(devkitARM for `make modern`, or agbcc), or set "
                f"${ENV_BUILD_CMD} to a working build command (e.g. a Docker wrapper)."
            ),
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "returncode": None,
            "command": args,
            "errors": [],
            "error_count": 0,
            "warning_count": 0,
            "raw_tail": "",
            "message": f"build timed out after {timeout}s",
        }

    output = (proc.stdout or "") + (proc.stderr or "")
    diags = parse_build_errors(output)
    return {
        "ok": proc.returncode == 0,
        "returncode": proc.returncode,
        "command": args,
        "errors": diags,
        "error_count": sum(1 for d in diags if d["severity"] in ("error", "fatal error")),
        "warning_count": sum(1 for d in diags if d["severity"] == "warning"),
        "raw_tail": output[-_TAIL:],
    }
