# Debug pokeemerald

Resolve a crash/jump address or symbol, or run the ROM, using the `debug-loop` skill.

- Address → source: `$ADDRESS` (e.g. `0x0806b424`) → `mcp__porygon__resolve_address`, then read the source around the result. Source `file:line` requires a `DINFO=1` build; function names work without it.
- Symbol → address: `mcp__porygon__lookup_symbol` for a name like `CB2_InitBattle`.
- Run it: `mcp__porygon__emu_launch_command` (add gdb to start the stub on :2345 and pair with `arm-none-eabi-gdb`).
