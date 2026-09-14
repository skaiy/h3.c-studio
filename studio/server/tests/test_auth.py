"""Optional bearer-token auth: off by default, protects writes when enabled."""
import sys

import pytest
from fastapi.testclient import TestClient


def import_with_token(monkeypatch, token):
    """Re-import main with H3_STUDIO_TOKEN set to `token` (or unset if None)."""
    import importlib
    if token is None:
        monkeypatch.delenv("H3_STUDIO_TOKEN", raising=False)
    else:
        monkeypatch.setenv("H3_STUDIO_TOKEN", token)
    return importlib.reload(sys.modules["main"])


def test_no_token_configured_writes_are_open(app_env, client):
    # app_env fixture already ensures H3_STUDIO_TOKEN is unset.
    r = client.post("/api/boards", json={
        "id": "", "name": "no auth needed", "chain": True, "shots": [],
        "status": "idle", "result": None, "createdAt": 0, "modifiedAt": 0,
    })
    assert r.status_code == 200


def test_token_configured_write_without_header_401(app_env, monkeypatch):
    module = import_with_token(monkeypatch, "secret123")
    with TestClient(module.app) as client:
        r = client.post("/api/boards", json={
            "id": "", "name": "x", "chain": True, "shots": [],
            "status": "idle", "result": None, "createdAt": 0, "modifiedAt": 0,
        })
        assert r.status_code == 401


def test_token_configured_write_with_wrong_token_401(app_env, monkeypatch):
    module = import_with_token(monkeypatch, "secret123")
    with TestClient(module.app) as client:
        r = client.post(
            "/api/boards",
            json={"id": "", "name": "x", "chain": True, "shots": [],
                  "status": "idle", "result": None, "createdAt": 0, "modifiedAt": 0},
            headers={"Authorization": "Bearer wrong"},
        )
        assert r.status_code == 401


def test_token_configured_write_with_correct_token_succeeds(app_env, monkeypatch):
    module = import_with_token(monkeypatch, "secret123")
    with TestClient(module.app) as client:
        r = client.post(
            "/api/boards",
            json={"id": "", "name": "x", "chain": True, "shots": [],
                  "status": "idle", "result": None, "createdAt": 0, "modifiedAt": 0},
            headers={"Authorization": "Bearer secret123"},
        )
        assert r.status_code == 200


def test_token_configured_reads_stay_open(app_env, monkeypatch):
    module = import_with_token(monkeypatch, "secret123")
    with TestClient(module.app) as client:
        assert client.get("/api/boards").status_code == 200
        assert client.get("/api/jobs").status_code == 200
        assert client.get("/api/videos").status_code == 200


def test_token_configured_delete_without_header_401(app_env, monkeypatch):
    module = import_with_token(monkeypatch, "secret123")
    with TestClient(module.app) as client:
        r = client.delete("/api/boards/some-id")
        assert r.status_code == 401


@pytest.fixture(autouse=True)
def _restore_no_auth_after_test(monkeypatch):
    """Ensure later tests in the same session don't inherit a token left set
    by import_with_token, since main is a shared module across the process."""
    yield
    import importlib
    monkeypatch.delenv("H3_STUDIO_TOKEN", raising=False)
    if "main" in sys.modules:
        importlib.reload(sys.modules["main"])
