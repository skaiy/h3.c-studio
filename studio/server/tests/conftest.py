"""Shared fixtures for the H3 Studio backend test suite.

Every test gets a freshly re-imported `main` module with all persistent
paths (uploads/, outputs/, storyboards.json) redirected into an isolated
tmp_path, so tests never touch the real repo's data and never see state
left over from a previous test.
"""
import importlib
import io
import sys

import pytest


@pytest.fixture
def app_env(tmp_path, monkeypatch):
    """(Re)import `main` with H3_* env vars pointed at an isolated tmp dir."""
    engine_dir = tmp_path / "engine"
    engine_dir.mkdir()
    monkeypatch.setenv("H3_ENGINE_DIR", str(engine_dir))
    monkeypatch.setenv("H3_MODEL_DIR", str(engine_dir / "MiniMax-H3"))
    monkeypatch.setenv("H3_OUTPUTS_DIR", str(tmp_path / "outputs"))
    monkeypatch.setenv("H3_UPLOADS_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("H3_BOARDS_FILE", str(tmp_path / "storyboards.json"))
    monkeypatch.setenv("H3_JOBS_FILE", str(tmp_path / "jobs.json"))
    # Auth is off by default in tests unless a test explicitly opts in via
    # monkeypatch.setenv("H3_STUDIO_TOKEN", ...) before calling this fixture.
    monkeypatch.delenv("H3_STUDIO_TOKEN", raising=False)

    if "main" in sys.modules:
        module = importlib.reload(sys.modules["main"])
    else:
        module = importlib.import_module("main")
    return module


@pytest.fixture
def client(app_env):
    from fastapi.testclient import TestClient
    with TestClient(app_env.app) as c:
        yield c


def restart_backend():
    """Re-import `main` against the *same* env vars (same tmp files) to
    simulate a process restart: module-level state is rebuilt from scratch,
    so anything not persisted to disk is lost, and load_jobs()/BOARDS_FILE
    reload from whatever was last written."""
    import sys
    return importlib.reload(sys.modules["main"])


class FakeProc:
    """Stands in for subprocess.Popen(...) so tests never shell out to the
    real h3 binary. Feeds `output_lines` through .stdout like a real process
    would, then exposes `returncode` via .poll()/.wait()."""

    def __init__(self, output_lines, returncode=0):
        text = "".join(line + "\n" for line in output_lines)
        self.stdout = io.StringIO(text)
        self.returncode = returncode
        self.terminated = False

    def poll(self):
        if self.stdout.tell() >= len(self.stdout.getvalue()):
            return self.returncode
        return None

    def wait(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -15


def make_fake_popen(output_lines, returncode=0):
    """Returns a function suitable for monkeypatch.setattr(module.subprocess, "Popen", ...)."""
    def _fake_popen(*args, **kwargs):
        return FakeProc(output_lines, returncode=returncode)
    return _fake_popen


def wait_for_status(client, job_id, statuses, timeout=5.0):
    """Poll GET /api/jobs/{job_id} until status is in `statuses` or timeout."""
    import time
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        r = client.get(f"/api/jobs/{job_id}")
        last = r.json()
        if last["status"] in statuses:
            return last
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} did not reach {statuses} in {timeout}s, last={last}")
