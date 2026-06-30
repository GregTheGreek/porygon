"""Build-agnostic client for the porygon_io_server Lua socket (see
porygon_io_server.lua). Pure transport + primitives; nothing here is specific
to any ROM or to any machine. ROM-specific addresses and intro sequences live
in their own profile modules (e.g. games/<rom>/profile.py).
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
from pathlib import Path

# Defaults; override per call (Emu(host=, port=)) or via env. No machine paths.
HOST = os.environ.get("PORYGON_PT_HOST", "127.0.0.1")
PORT = int(os.environ.get("PORYGON_PT_PORT", "8888"))


def find_mgba(mgba: str | None = None) -> str | None:
    """Locate an mGBA binary: explicit arg, then $MGBA, macOS .app, then PATH."""
    for cand in (mgba, os.environ.get("MGBA"),
                 "/Applications/mGBA.app/Contents/MacOS/mGBA"):
        if cand and (os.path.isabs(cand) and os.path.exists(cand) or shutil.which(cand)):
            return cand if os.path.exists(cand) else shutil.which(cand)
    for name in ("mgba-qt", "mgba"):
        found = shutil.which(name)
        if found:
            return found
    return None


def launch_mgba(rom: str, mgba: str | None = None) -> subprocess.Popen:
    """Launch mGBA on a ROM. The Lua server still must be loaded once by hand
    (Tools > Scripting -> dofile), since 0.10.x has no --script CLI flag."""
    exe = find_mgba(mgba)
    if not exe:
        raise FileNotFoundError("mGBA not found; pass --mgba or set $MGBA")
    if not os.path.exists(rom):
        raise FileNotFoundError(f"ROM not found: {rom}")
    return subprocess.Popen([exe, rom])


def wait_for_server(host: str = HOST, port: int = PORT, timeout: float = 120.0) -> "Emu":
    """Block until the Lua server accepts a connection (e.g. after a manual load)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return Emu(host, port)
        except OSError:
            time.sleep(1.0)
    raise TimeoutError(f"no porygon-io server on {host}:{port} within {timeout}s")


class Emu:
    """Talks to the mGBA Lua command server over TCP.

    The server must be loaded once in mGBA's scripting console:
        dofile("/abs/path/to/porygon_io_server.lua")
    It survives ROM swaps, so it only needs loading once per mGBA launch.
    """

    def __init__(self, host=HOST, port=PORT):
        self.host, self.port = host, port
        self._connect()

    def _connect(self):
        self.s = socket.create_connection((self.host, self.port), timeout=5)
        self.s.settimeout(5)
        self.f = self.s.makefile("rwb", buffering=0)

    def cmd(self, line: str) -> str:
        """Send a command; transparently reconnect+retry once on a dropped socket."""
        for attempt in (1, 2):
            try:
                self.f.write((line + "\n").encode())
                resp = self.f.readline().decode().strip()
                if resp == "":
                    raise ConnectionResetError("empty reply")
                return resp
            except (ConnectionResetError, BrokenPipeError, OSError):
                if attempt == 2:
                    raise
                time.sleep(0.2)
                self._connect()
        raise RuntimeError("unreachable")

    # --- primitives -------------------------------------------------------
    def ping(self) -> str:
        return self.cmd("PING")

    def state(self) -> dict:
        """Player state from gObjectEvents[<player>]. Call set_obj() first on
        builds where the player object is not at the server's default address."""
        return json.loads(self.cmd("STATE"))

    def read8(self, addr: int) -> int:
        return int(self.cmd(f"READ8 {addr}"))

    def read16(self, addr: int) -> int:
        return int(self.cmd(f"READ16 {addr}"))

    def tap(self, key: str, frames: int = 6) -> str:
        return self.cmd(f"TAP {key} {frames}")

    def release(self) -> str:
        return self.cmd("RELEASE")

    def shot(self, abs_path: str) -> str:
        return self.cmd(f"SHOT {abs_path}")  # path MUST be absolute

    def save(self, abs_path: str) -> str:
        return self.cmd(f"SAVE {abs_path}")

    def load(self, abs_path: str) -> str:
        return self.cmd(f"LOAD {abs_path}")

    def reset(self) -> str:
        return self.cmd("RESET")

    def set_obj(self, addr: int) -> str:
        """Point STATE at this build's gObjectEvents[player] base address."""
        return self.cmd(f"SETOBJ {addr}")

    def eval(self, lua: str) -> str:
        return self.cmd(f"EVAL {lua}")

    # --- record / replay --------------------------------------------------
    def rec_start(self) -> int:
        """Begin recording the GBA key mask (logged on every change)."""
        return int(self.cmd("RECSTART").split()[-1])

    def rec_stop(self) -> int:
        """Stop recording; returns the number of logged key-changes."""
        return int(self.cmd("RECSTOP").split()[-1])

    def rec_dump(self) -> list[list[int]]:
        """Fetch the recording as [[frame_offset, key_mask], ...]."""
        body = self.cmd("RECDUMP")
        out = []
        for tok in filter(None, body.split(",")):
            df, k = tok.split(":")
            out.append([int(df), int(k)])
        return out

    def replay(self, events: list[list[int]], poll: float = 0.1) -> None:
        """Schedule a frame-accurate input replay and block until it finishes.

        `events` is [[frame_offset, key_mask], ...] as produced by rec_dump.
        Replay runs at emulator speed (real time); the player must be at the
        same state the recording started from (load that checkpoint first).
        """
        data = ",".join(f"{df}:{k}" for df, k in events)
        n = int(self.cmd(f"REPLAY {data}").split()[-1])
        if n == 0:
            return
        while self.cmd("REPDONE") == "0":
            time.sleep(poll)

    # --- frame-synced (deterministic) timing ------------------------------
    def frame(self) -> int:
        return int(self.eval("return emu:currentFrame()").split()[-1])

    def wait_frames(self, n: int, poll: float = 0.02):
        target = self.frame() + n
        while self.frame() < target:
            time.sleep(poll)

    def press(self, key: str, frames: int = 6, settle: float = 0.45):
        """Wall-clock press: tap then sleep. Simple; use press_f for determinism."""
        self.tap(key, frames)
        time.sleep(frames / 60.0 + settle)

    def press_f(self, key: str, hold: int = 6, gap: int = 18):
        """Deterministic press: hold KEY, then wait an exact emulator-frame budget,
        so a sequence replays identically regardless of wall-clock jitter."""
        self.tap(key, hold)
        self.wait_frames(hold + gap)

    # --- helpers ----------------------------------------------------------
    def scan_player_object(self, lo=0x02000000, hi=0x02040000) -> list[dict]:
        """Locate candidate gObjectEvents[player] bases by scanning EWRAM for an
        active+isPlayer ObjectEvent with plausible coords. Used to derive the
        per-build player address when no ELF/.map is handy. Run while in the
        overworld. Returns dicts {addr,x,y,facing}."""
        lua = (
            "local lo=%d local hi=%d local h={} "
            "for a=lo,hi,4 do "
            " if (emu:read8(a)&1)==1 and (emu:read8(a+2)&1)==1 then "
            "  local x=emu:read16(a+0x10) local y=emu:read16(a+0x12) "
            "  local fc=emu:read16(a+0x18)&0xF "
            "  if x>0 and x<1000 and y>0 and y<1000 and fc>=1 and fc<=4 then "
            "   h[#h+1]=string.format('%%08X,%%d,%%d,%%d',a,x,y,fc) end "
            " end end "
            "return table.concat(h,'|')"
        ) % (lo, hi)
        out = self.eval(lua)
        body = out[3:] if out.startswith("OK ") else out
        rows = []
        for tok in filter(None, body.split("|")):
            a, x, y, fc = tok.split(",")
            rows.append({"addr": int(a, 16), "x": int(x), "y": int(y), "facing": int(fc)})
        return rows


# --- CLI helpers (shared by runnable scripts) ----------------------------
def add_connection_args(parser) -> None:
    """Register the connection/launch flags every runnable script accepts."""
    parser.add_argument("--host", default=HOST, help="server host (default %(default)s)")
    parser.add_argument("--port", type=int, default=PORT, help="server port (default %(default)s)")
    parser.add_argument("--rom", help="launch mGBA on this ROM first (Lua server still loaded by hand)")
    parser.add_argument("--mgba", help="mGBA binary path (else auto-detect / $MGBA)")


def connect(args) -> "Emu":
    """Build an Emu from parsed args, optionally launching mGBA on --rom first."""
    if getattr(args, "rom", None):
        launch_mgba(args.rom, getattr(args, "mgba", None))
        print(f"launched mGBA on {args.rom}; load the Lua server "
              "(Tools > Scripting -> dofile), waiting for it…")
        return wait_for_server(args.host, args.port)
    return Emu(args.host, args.port)
