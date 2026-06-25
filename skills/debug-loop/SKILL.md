---
name: debug-loop
description: >
  Build pokeemerald and triage failures, and resolve crash/jump addresses to
  source. Use when the user says "build it", "why won't it compile", "fix the
  build", pastes a make/compiler error log, or asks "what's at 0x0806xxxx",
  "where did it crash", "what function is this address". Augments the workflow -
  it proposes fixes and resolves symbols; the human approves changes.
allowed-tools:
  - Read
  - Edit
  - Grep
  - Glob
  - Bash
  - Agent
  - mcp__porygon__project_info
  - mcp__porygon__build
  - mcp__porygon__parse_build_log
  - mcp__porygon__resolve_address
  - mcp__porygon__lookup_symbol
  - mcp__porygon__emu_launch_command
---

# debug-loop

Two workflows, both backed by the deterministic `porygon` tools.

## A. Build → triage → fix → rebuild

1. **Build**: call `mcp__porygon__build` (runs `make modern` by default; honors
   `$PORYGON_BUILD_CMD`). If it returns `ok: false` with a "command not found"
   message, the toolchain isn't wired up - tell the user to install devkitARM or
   set `$PORYGON_BUILD_CMD`, and stop.
2. **Triage**: read the structured `errors[]` (`{file, line, col, severity,
   message, kind}`). For each error, open the cited `file:line` with Read and
   inspect. If a diagnostic has `needs_source_resolution: true` (file is
   `<stdin>`), the real path is in the nearby cpp `# <line> "<file>"` marker -
   reconcile before editing.
3. **Fix**: propose the *minimal* change. For anything non-trivial or with
   several plausible causes, spawn the `build-doctor` agent with the failing
   `errors[]` + repo access and let it root-cause.
4. **Confirm with the user**, apply with Edit, then **rebuild** to verify.
   Repeat until `ok: true`. Report the final result honestly (don't claim
   success without a clean build).

If the user pastes a log instead of building, use `mcp__porygon__parse_build_log`.

## B. Address / symbol resolution

- "What's at `0x0806b424`?" → `mcp__porygon__resolve_address` → `{function,
  file, line}`. Then Read the source around it.
- "Where is `CB2_InitBattle`?" → `mcp__porygon__lookup_symbol` → address.
- **Source lines need a `DINFO=1` build.** Function names come from the symbol
  table (always present in an unstripped ELF), but `file:line` needs DWARF. If
  `resolve_address` returns a function but no `file`/`line`, tell the user to
  rebuild with `DINFO=1` (or set `$PORYGON_BUILD_CMD` accordingly) for source mapping.

## Running the ROM

`mcp__porygon__emu_launch_command` returns the mGBA invocation (use `gdb: true`
to start the GDB stub on :2345 and pair with `arm-none-eabi-gdb`). It also
reports whether debug prints are compiled in (`NDEBUG`). The server never spawns
the GUI - hand the command to the user (or run via Bash if they ask).
Note: automated `mgba_printf` log capture is not yet implemented.
