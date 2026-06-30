"""pokeemerald-platinum profile for the AI playtester.

EVERYTHING in this file is specific to the pokeemerald-platinum ROM (the
Sinnoh remake hack, ~/Desktop/pokeemerald.gba in dev), NOT vanilla Emerald:

  * PLAYER_OBJ: gObjectEvents[player] lives at a different EWRAM address than
    vanilla/modern pokeemerald (which is 0x02006620). Found by EWRAM scan
    (Emu.scan_player_object); re-derive per build / re-confirm if the ROM is
    rebuilt. Resolve from the build's .elf with porygon's symbol tooling when
    available rather than trusting this constant.
  * Intro sequence + timing constants below are calibrated to platinum's
    intro (Birch monologue with an Eevee, custom name screen).
  * The name screen confirms with START-then-A (START moves the cursor to the
    on-screen OK button; A confirms). START alone does NOT confirm. You cannot
    overshoot the name screen by mashing A -- extra A's only type letters --
    so a generous fixed A-count safely lands on and fills the field.

Run (after loading porygon_io_server.lua in mGBA, ROM at the title/anywhere):
    python3 pokeemerald_platinum.py
"""
from __future__ import annotations

from pathlib import Path

from emu import Emu

# gObjectEvents[player] base for pokeemerald-platinum. BUILD-SPECIFIC.
PLAYER_OBJ = 0x02001678

# Frame gap per dialogue press. Must exceed the slowest intro transition
# (the "So you're <NAME>?" YES/NO menu); 16 was too tight, 36 is reliable.
DIALOGUE_GAP = 36

CHECKPOINT_DIR = Path(__file__).resolve().parent / "checkpoints" / "pokeemerald-platinum"


def intro_to_first_move(e: Emu, verbose: bool = True) -> dict:
    """Drive a fresh game from RESET to first manual player control.

    Deterministic: the intro dialogue is fixed, presses are frame-synced, and
    the name screen cannot be overshot by mashing A. Assumes no in-game battery
    save exists (fresh cartridge) so the main menu's top entry is NEW GAME.
    Returns the player STATE at first movement.
    """
    def log(*a):
        if verbose:
            print(*a)

    e.set_obj(PLAYER_OBJ)
    log("reset…");          e.reset(); e.wait_frames(150)
    log("skip intro…");     [e.press_f("START", 6, 24) for _ in range(6)]
    log("new game…");       e.press_f("A", 6, 30)
    log("clear monologue + fill name…")
    for _ in range(60):     e.press_f("A", 6, DIALOGUE_GAP)  # clears dialogue, then types A's
    log("confirm name (START->OK, A)…")
    e.press_f("START", 6, 24)                                # jump cursor to OK button
    e.press_f("A", 6, 40)                                    # confirm
    log("advance to overworld until player is active…")
    for i in range(70):
        st = e.state()
        if st.get("active") == 1 and 0 < st["x"] < 1000:
            log(f"  player active after {i} presses: {st}")
            return st
        e.press_f("A", 6, DIALOGUE_GAP)
    raise RuntimeError(f"never reached active player; last state={e.state()}")


def verify_first_movement(e: Emu) -> dict:
    """Confirm real control: a D-pad press must change coordinates. The first
    press in a new direction only turns in place, so try a few across two axes."""
    before = e.state()
    after = before
    for k in ("DOWN", "DOWN", "RIGHT", "RIGHT"):
        e.press_f(k, 10, 16)
        after = e.state()
        if (before["x"], before["y"]) != (after["x"], after["y"]):
            return {"before": before, "after": after, "moved": True}
    return {"before": before, "after": after, "moved": False}


if __name__ == "__main__":
    e = Emu()
    print("ping:", e.ping())
    st = intro_to_first_move(e)
    print("first-movement state:", st)
    # Save the checkpoint while the player is idle, BEFORE moving. Savestates
    # captured mid-step resume in an input-locked transient that won't accept
    # input on load, so let the avatar settle first.
    e.wait_frames(30)
    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)
    print("save checkpoint:", e.save(str(CHECKPOINT_DIR / "00_first_movement.ss")))
    # Movement verification runs last (it moves the player off the saved tile).
    print("movement check:", verify_first_movement(e))
