"""Test fixtures. Real-project tests run against a local pokeemerald checkout.

Set POKEEMERALD_ROOT to point at your checkout. If it is unset (or missing),
real-project tests are skipped and the unit tests still run.
"""

import os
from pathlib import Path

import pytest

from porygon.core.project import Project


def _root() -> Path | None:
    env = os.environ.get("POKEEMERALD_ROOT")
    if env and Path(env).exists():
        return Path(env)
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
