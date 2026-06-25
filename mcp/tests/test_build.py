"""Build orchestration - toolchain-free via stub commands."""

from porygon.core.build import build, build_command


def test_default_command_is_make_modern_dinfo():
    assert build_command() == ["make", "modern", "DINFO=1"]


def test_no_dinfo():
    assert build_command(dinfo=False) == ["make", "modern"]


def test_explicit_command_overrides(monkeypatch):
    assert build_command(command="docker compose run build") == ["docker", "compose", "run", "build"]


def test_env_override(monkeypatch):
    monkeypatch.setenv("PORYGON_BUILD_CMD", "ninja -C build")
    assert build_command() == ["ninja", "-C", "build"]


def test_build_success(tmp_path):
    r = build(tmp_path, command="true")
    assert r["ok"] is True
    assert r["returncode"] == 0


def test_build_failure_parses_errors(tmp_path):
    r = build(tmp_path, command="sh -c 'echo src/x.c:5:3: error: boom; exit 1'")
    assert r["ok"] is False
    assert r["error_count"] == 1
    assert r["errors"][0]["file"] == "src/x.c"
    assert r["errors"][0]["line"] == 5


def test_build_missing_command_is_graceful(tmp_path):
    r = build(tmp_path, command="porygon_no_such_build_cmd_xyz")
    assert r["ok"] is False
    assert "not found" in r["message"].lower()
