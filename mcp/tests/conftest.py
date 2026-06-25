"""Test fixtures. Real-project tests run against a local pokeemerald checkout.

Resolution order for the project root:
  1. POKEEMERALD_ROOT env var
  2. the known local checkout path
If neither exists, real-project tests are skipped (unit tests still run).
"""

import os
from pathlib import Path

import pytest

from porygon.core.project import Project

_FALLBACK = Path.home() / "code/github.com/GregTheGreek/pokeemerald"


def _root() -> Path | None:
    env = os.environ.get("POKEEMERALD_ROOT")
    if env and Path(env).exists():
        return Path(env)
    if _FALLBACK.exists():
        return _FALLBACK
    return None


@pytest.fixture(scope="session")
def pokeemerald_root() -> Path:
    root = _root()
    if root is None:
        pytest.skip("no pokeemerald checkout found (set POKEEMERALD_ROOT)")
    return root


@pytest.fixture(scope="session")
def project(pokeemerald_root) -> Project:
    return Project(pokeemerald_root)
