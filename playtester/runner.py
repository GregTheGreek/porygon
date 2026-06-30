"""Span runner for the playtester execution model (see MODEL.md).

Walks a manifest of spans. Deterministic spans (`script`, `replay`) run
hands-off; `agent` spans hand control to a pluggable decision function that
observes live state and acts until it converges on the span's target. Each
span re-anchors by saving its checkpoint (fresh RNG state) for the next span.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from emu import Emu


# --- helpers -------------------------------------------------------------
def load_recording(path: str) -> list[list[int]]:
    return json.load(open(path))["events"]


def state_matches(state: dict, target: dict) -> bool:
    """Target is a subset predicate over STATE fields."""
    return all(state.get(k) == v for k, v in target.items())


@dataclass
class Observation:
    """What an agent span sees each step."""
    state: dict
    screenshot: Optional[str] = None   # absolute path, if captured
    battle: bool = False               # gated battle sub-state lives here later
    target: dict = field(default_factory=dict)
    goal: str = ""


# An agent decision function: given an observation, return the next inputs to
# apply as a list of (key, frames). Returning [] means "no-op / wait". The real
# implementation is wired to Claude (or a heuristic policy); this module just
# defines the contract and the convergence loop around it.
AgentFn = Callable[[Observation], list[tuple[str, int]]]


def _stub_agent(obs: Observation) -> list[tuple[str, int]]:
    raise NotImplementedError(
        "agent span requires an agent_fn; none was provided. "
        f"goal={obs.goal!r} target={obs.target}"
    )


class Runner:
    def __init__(
        self,
        emu: Emu,
        manifest_path: str,
        scripts: Optional[dict[str, Callable[[Emu], dict]]] = None,
        agent_fn: AgentFn = _stub_agent,
        base_dir: Optional[str] = None,
        shot_dir: str = "/tmp",
    ):
        self.e = emu
        self.manifest = json.load(open(manifest_path))
        self.base = Path(base_dir or os.path.dirname(os.path.abspath(manifest_path)))
        self.scripts = scripts or {}
        self.agent_fn = agent_fn
        self.shot_dir = shot_dir
        obj = self.manifest.get("player_obj")
        if obj:
            self.e.set_obj(int(obj, 16) if isinstance(obj, str) else obj)

    def _abs(self, rel: str) -> str:
        return str(self.base / rel)

    def run(self, stop_on_fail: bool = True) -> list[tuple[str, bool]]:
        results = []
        for span in self.manifest["spans"]:
            ok = self.run_span(span)
            results.append((span["id"], ok))
            if not ok and stop_on_fail:
                break
        return results

    def run_span(self, span: dict) -> bool:
        if span.get("from"):
            self.e.load(self._abs(span["from"]))
            time.sleep(0.4)

        t = span["type"]
        if t == "script":
            self.scripts[span["fn"]](self.e)
        elif t == "replay":
            self.e.replay(load_recording(self._abs(span["recording"])))
        elif t == "agent":
            self._run_agent(span)
        else:
            raise ValueError(f"unknown span type: {t}")

        target = span.get("target", {})
        ok = state_matches(self.e.state(), target) if target else True
        if ok and span.get("checkpoint"):
            self.e.wait_frames(20)            # settle to idle before snapshotting
            self.e.save(self._abs(span["checkpoint"]))
        return ok

    def _run_agent(self, span: dict, max_steps: int = 200) -> None:
        """Observe -> act -> check loop until the span's target is reached."""
        target = span.get("target", {})
        for _ in range(max_steps):
            st = self.e.state()
            if state_matches(st, target):
                return
            shot = os.path.join(self.shot_dir, f"agent_{span['id']}.png")
            self.e.shot(shot)
            obs = Observation(
                state=st, screenshot=shot,
                battle=bool(st.get("battle")),
                target=target, goal=span.get("goal", ""),
            )
            for key, frames in self.agent_fn(obs):
                self.e.press_f(key, frames, 12)
        raise RuntimeError(f"agent span {span['id']} did not converge on {target}")


if __name__ == "__main__":
    import pokeemerald_platinum as P
    e = Emu()
    runner = Runner(
        e,
        manifest_path=os.path.join(os.path.dirname(__file__), "manifest.example.json"),
        scripts={"intro_to_first_move": P.intro_to_first_move},
        # agent_fn=<wire Claude or a policy here>,
    )
    for span_id, ok in runner.run():
        print(("PASS" if ok else "FAIL"), span_id)
