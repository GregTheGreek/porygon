# Contributing to porygon

Thanks for your interest in improving porygon. It is an unofficial community
tool for AI-augmented pokeemerald decomp ROM hacking; contributions that keep it
deterministic, well-tested, and human-in-the-loop are very welcome.

## Ground rules

- **No copyrighted game content.** Do not commit ROMs, save files, ripped
  graphics/audio, or any Nintendo/Game Freak/The Pokémon Company assets. porygon
  operates on a user's own decomp checkout; it ships only code and original
  brand art.
- **Keep the core deterministic.** The binary codecs in `mcp/src/porygon/core`
  must round-trip byte-for-byte. Any change there needs a test proving it.
- **Human in the loop.** porygon augments debugging, scripting, and map wiring;
  it is not an autonomous game builder. Features should preserve that posture.

## Development setup

The packaged code lives in `mcp/` (a `uv`-managed Python project).

```bash
cd mcp
uv sync --extra dev          # install runtime + dev deps (pytest, ruff)
uv run python -m pytest -q   # run the test suite (offline)
uv run ruff check src tests  # lint
```

## Before opening a pull request

1. `uv run ruff check src tests` passes (CI gates on this).
2. `uv run python -m pytest -q` passes.
3. If you touched the plugin or marketplace manifests, run
   `python3 .github/scripts/validate_manifests.py` from the repo root.
4. Keep changes atomic - one logical change per PR.

CI runs the manifest check, ruff, and the test suite across Python 3.10-3.13.

## Commit messages

Use conventional-commit style prefixes (`feat:`, `fix:`, `refactor:`, `docs:`,
`chore:`, `test:`, `ci:`) and the present tense ("add", not "added").

## Reporting bugs

Open an issue using the bug report template. A minimal reproduction against a
clean pokeemerald (or supported fork) checkout helps enormously - include the
command, the expected vs actual output, and your toolchain versions.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license that covers this project.
