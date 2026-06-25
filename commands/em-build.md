# Build pokeemerald

Build the ROM and triage any failures using the `debug-loop` skill.

1. Call `mcp__porygon__build` (override the command with `$PORYGON_BUILD_CMD` if set).
2. If it fails, parse the structured `errors[]`, open each cited `file:line`, and propose minimal fixes (spawn `build-doctor` for non-trivial cases).
3. After applying any approved fix, rebuild to confirm. Report the honest final state - only call it done on a clean build.
