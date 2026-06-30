## Summary

<!-- What does this change and why? Keep it to one logical change. -->

## Test plan

<!-- How did you verify it? -->

- [ ] `uv run ruff check src tests` passes (in `mcp/`)
- [ ] `uv run python -m pytest -q` passes (in `mcp/`)
- [ ] If manifests changed: `python3 .github/scripts/validate_manifests.py` passes
- [ ] No ROMs, save files, or copyrighted game assets are included
