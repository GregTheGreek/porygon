# Event scripting

Add/edit/validate map event scripts using the `event-scripting` skill.

- Add a scripted NPC/sign/trigger: scaffold the `.inc` (`scaffold_script`), refine the logic (use `lookup_macro` for real signatures), wire the label into the map via `add_object_event`/`add_sign`/`add_trigger`, then `validate_scripts` and build.
- Audit a map: `validate_scripts $MAP` - flags dangling labels and undefined constants before you build. For messy reports, spawn `script-doctor`.
- Poryscript: `poryscript_status` first - these repos use hand-written `.inc`; if a project has Poryscript, author/compile `.pory` instead.
