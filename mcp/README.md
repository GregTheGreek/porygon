# porygon (MCP server + CLI)

Deterministic primitives for AI-augmented pokeemerald ROM hacking. Pure-Python
`core` library (binary blockdata/attribute codecs, project parsing) wrapped by a
CLI and an MCP server. See the repository root README for the full toolkit.

```bash
uv sync                       # install (adds the mcp package)
uv run python -m porygon.server   # run the MCP server (stdio)
uv run porygon info            # CLI, from inside a pokeemerald checkout
uv run --with pytest --no-project python -m pytest   # tests (offline)
```
