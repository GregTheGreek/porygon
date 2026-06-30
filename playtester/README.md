# Playtester

An AI-driven playtester bridge for pokeemerald-family ROMs. Python drives a
running **mGBA** over a TCP socket served by an in-emulator Lua script: read
game state, send input, screenshot, save/load state, reset. No emulator source
changes; no native bindings to build.

> Status: spike. Proven end-to-end on **pokeemerald-platinum** (the Sinnoh
> remake hack) by driving a fresh game from reset to first manual movement,
> fully autonomously. See `games/pokeemerald_platinum/`.

## Layout

```
playtester/
  porygon_io_server.lua        # generic mGBA Lua command server (load once in mGBA)
  emu.py                       # generic, build-agnostic Python client + primitives
  runner.py                    # generic span runner (replay + agent spans)
  README.md  MODEL.md
  games/
    pokeemerald_platinum/      # self-contained per-game package
      profile.py               # addresses + intro sequence (BUILD-SPECIFIC)
      manifest.json            # ordered spans (paths relative to this dir)
      checkpoints/             # 00_..ss .. 04_..ss (numbered = chronological)
      recordings/              # 01_..json .. 04_..json
```

Generic code at the root (transport, primitives, frame-synced timing, the EWRAM
player scan, the span runner) is build-agnostic. Everything ROM-specific (player
object address, intro sequence, timing constants, checkpoints, recordings,
manifest) lives in a self-contained `games/<rom>/` package, so it is never
mistaken for vanilla behavior and each ROM stands alone.

## Requirements

- mGBA **0.10.x** (has the Lua scripting API + socket support; tested on 0.10.5).
- Python 3.10+. Standard library only.

## Usage

1. Launch mGBA with a ROM.
2. Open `Tools > Scripting…`. In the console, load the server **once**:
   ```
   dofile("/abs/path/to/playtester/porygon_io_server.lua")
   ```
   You should see `porygon-io v2: listening on port 8888`. This survives ROM
   swaps (File > Load ROM), so it only needs loading once per mGBA launch.
3. Drive it:
   ```bash
   cd playtester
   python3 games/pokeemerald_platinum/profile.py   # fresh reset -> first manual movement
   python3 runner.py                                # walk the full span manifest
   ```

## Protocol (porygon_io_server.lua)

Newline-terminated request → newline-terminated reply on TCP `127.0.0.1:8888`:

| Command | Effect |
|---|---|
| `PING` | `PONG` |
| `STATE` | `{x,y,facing,map_group,map_num,active}` from `gObjectEvents[player]` |
| `READ8/READ16 0xADDR` | memory read |
| `TAP KEY FRAMES` | hold KEY (A,B,SELECT,START,RIGHT,LEFT,UP,DOWN,R,L) for N frames |
| `HOLD MASK FRAMES` / `RELEASE` | raw key mask / release |
| `SHOT /abs/path.png` | screenshot (path MUST be absolute) |
| `SAVE` / `LOAD /abs/path.ss` | savestate |
| `RESET` | `emu:reset()` |
| `SETOBJ 0xADDR` | point STATE at this build's player-object base |
| `EVAL <lua>` | run arbitrary Lua (dev escape hatch) |

## Known seams (from the spike)

- **One manual script load per mGBA launch.** mGBA 0.10.5's Qt frontend has no
  `--script` CLI flag, so the Lua server is loaded via the scripting console.
- **Paths must be absolute** for `SHOT`/`SAVE`/`LOAD` (relative resolves against
  mGBA's cwd, not the client's).
- **RAM addresses are build-specific.** `STATE` defaults to the vanilla/modern
  `gObjectEvents` (0x02006620); other builds need `SETOBJ`. Use
  `Emu.scan_player_object()` to find it from a running overworld, or resolve the
  symbol from the build's `.elf` with porygon's tooling.
- **Emulation runs at full speed even when mGBA is unfocused** (no focus-pause).

## Adding another ROM

Copy `games/pokeemerald_platinum/` to `games/<your_rom>/`, then in its
`profile.py` set `PLAYER_OBJ` (via `Emu.scan_player_object()` or the `.elf`) and
re-calibrate the intro sequence — name-screen confirm behavior and dialogue
length differ between hacks. Record fresh checkpoints/recordings into that
package and point its `manifest.json` at them.
