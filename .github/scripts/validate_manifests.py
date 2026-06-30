#!/usr/bin/env python3
"""Validate the Claude Code plugin + marketplace manifests.

Run from the repository root:

    python .github/scripts/validate_manifests.py

Checks that both manifests parse, that the paths they reference exist, and that
the plugin version is consistent between them. Exits non-zero on any failure so
it can gate CI.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / ".claude-plugin" / "plugin.json"
MARKETPLACE = ROOT / ".claude-plugin" / "marketplace.json"

errors: list[str] = []


def load(path: Path) -> dict:
    if not path.exists():
        errors.append(f"missing manifest: {path.relative_to(ROOT)}")
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        errors.append(f"invalid JSON in {path.relative_to(ROOT)}: {exc}")
        return {}


def check_path(manifest_key: str, rel: str) -> None:
    target = (ROOT / rel).resolve()
    if not target.exists():
        errors.append(f"plugin.json {manifest_key!r} -> {rel!r} does not exist")


plugin = load(PLUGIN)
marketplace = load(MARKETPLACE)

# plugin.json: referenced component directories must exist.
for key in ("commands", "skills", "agents"):
    rel = plugin.get(key)
    if rel:
        check_path(key, rel)

# The MCP server launches `uv run --directory ${CLAUDE_PLUGIN_ROOT}/mcp`; make
# sure that package directory is actually present.
if not (ROOT / "mcp" / "pyproject.toml").exists():
    errors.append("mcp/pyproject.toml does not exist (MCP server source missing)")

# Version must agree between plugin.json and the marketplace plugin entry.
plugin_version = plugin.get("version")
mp_plugins = marketplace.get("plugins", [])
mp_entry = next((p for p in mp_plugins if p.get("name") == "porygon"), None)
if mp_entry is None:
    errors.append("marketplace.json has no plugin entry named 'porygon'")
elif plugin_version and mp_entry.get("version") != plugin_version:
    errors.append(
        f"version mismatch: plugin.json={plugin_version!r} "
        f"marketplace.json={mp_entry.get('version')!r}"
    )

# marketplace source path must exist.
if mp_entry and mp_entry.get("source"):
    src = (ROOT / mp_entry["source"]).resolve()
    if not src.exists():
        errors.append(f"marketplace source {mp_entry['source']!r} does not exist")

if errors:
    print("Manifest validation FAILED:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)

print(f"Manifest validation OK (plugin version {plugin_version}).")
