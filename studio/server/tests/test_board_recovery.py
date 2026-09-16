"""Fail-closed board recovery: preserve originals, block writes, restart to recover."""
from copy import deepcopy
import errno
import json
import os
import secrets
import stat
from unittest.mock import Mock

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from .conftest import restart_backend


ORIGINAL_MARKER = "original-board-metadata-must-not-be-exposed"
IO_MARKER = "private-read-diagnostic-must-not-be-exposed"


def collection():
    return {"board": {"id": "board", "name": ORIGINAL_MARKER, "shots": [{
        "id": "s1", "prompt": ORIGINAL_MARKER, "selected_take_id": "t1",
        "takes": [{
            "id": "t1", "shot_id": "s1", "job_id": "persisted",
            "output": "keep.mp4", "created_at": 1.0,
            "request": {"prompt": ORIGINAL_MARKER}, "request_unknown": False,
            "source_take_id": None, "source_unknown": False, "legacy": False,
            "model_name": "MiniMax-H3",
        }],
    }]}}


@pytest.fixture
def originals(app_env):
    """All sentinels are synthetic and live under app_env's isolated directory."""
    app_env.BOARDS_FILE.with_name(app_env.BOARDS_FILE.name + ".tmp").write_bytes(
        b"unfinished write: preserve this too")
    (app_env.OUTPUTS / "keep.mp4").write_bytes(b"original video")
    (app_env.OUTPUTS / "keep.ckpt").write_bytes(b"original checkpoint")
    (app_env.UPLOADS / "keep.png").write_bytes(b"original reference image")
    app_env.JOBS_FILE.write_text(json.dumps({"persisted": {
        "id": "persisted", "label": "history", "status": "done",
        "created": 1.0, "output": "keep.mp4", "log": ["original log"],
        "request": {"prompt": "historical request"},
    }}), encoding="utf-8")
    return app_env.BOARDS_FILE.parent


def disk_state(root):
    """Detect rewrites/renames as well as byte changes, without opening special files."""
    result = {}
    for path in root.rglob("*"):
        info = path.lstat()
        content = None
        if stat.S_ISREG(info.st_mode):
            content = path.read_bytes()
        elif stat.S_ISLNK(info.st_mode):
            content = os.readlink(path)
        result[str(path.relative_to(root))] = (
            info.st_mode, info.st_ino, info.st_mtime_ns, content)
    return result


def assert_unavailable(response, reason):
    assert response.status_code == 503
    payload = response.json()
    assert set(payload) == {"detail", "code", "reason"}
    assert payload["code"] == "board_persistence_unavailable"
    assert payload["reason"] == reason
    detail = payload["detail"]
    assert isinstance(detail, str) and detail.strip()
    assert "restart" in detail.lower()
    assert "back up" in detail.lower() or "backup" in detail.lower()
    assert ORIGINAL_MARKER not in detail
    assert IO_MARKER not in detail
    return payload


def restart_rejected(app_env, root, reason):
    before = disk_state(root)
    restarted = restart_backend()
    assert restarted.BOARDS_LOAD_ERROR == reason
    assert restarted.boards == {}
    with TestClient(restarted.app) as client:
        first = assert_unavailable(client.get("/api/boards"), reason)
        assert assert_unavailable(client.get("/api/boards/board"), reason) == first
        assert assert_unavailable(client.post(
            "/api/generate", content=b"{", headers={"content-type": "application/json"}), reason) == first
        assert str(root) not in first["detail"]
    assert disk_state(root) == before
    return restarted


@pytest.mark.parametrize("raw", [None, b"{}"], ids=["missing-leaf", "empty-object"])
def test_first_run_and_empty_object_are_healthy(app_env, originals, raw):
    if raw is not None:
        app_env.BOARDS_FILE.write_bytes(raw)
    before = disk_state(originals)
    restarted = restart_backend()
    assert restarted.BOARDS_LOAD_ERROR is None
    with TestClient(restarted.app) as client:
        assert client.get("/api/boards").json() == []
        assert disk_state(originals) == before
        response = client.post("/api/boards", json={"id": "", "name": "new"})
        assert response.status_code == 200
    assert json.loads(restarted.BOARDS_FILE.read_text())[response.json()["id"]]


@pytest.mark.parametrize("raw", [
    pytest.param(b"", id="zero-length"),
    pytest.param(b" \t\r\n", id="whitespace"),
    pytest.param(b'{"broken":', id="truncated"),
    pytest.param(b'{"name":"' + ORIGINAL_MARKER.encode() + b'",}', id="malformed"),
    pytest.param(b"{} {}", id="trailing-document"),
    pytest.param(b'{"board":{},"board":{}}', id="duplicate-board-key"),
    pytest.param(b'{"board":{"id":"board","id":"other"}}', id="duplicate-nested-key"),
    pytest.param(b'{"board":NaN}', id="nan"),
    pytest.param(b'{"board":Infinity}', id="positive-infinity"),
    pytest.param(b'{"board":-Infinity}', id="negative-infinity"),
    pytest.param(b'{"board":1e999}', id="overflowing-float"),
    pytest.param(b'{"board":"\xff"}', id="invalid-utf8"),
])
def test_invalid_json_is_not_repaired_or_replaced(app_env, originals, caplog, raw):
    app_env.BOARDS_FILE.write_bytes(raw)
    restart_rejected(app_env, originals, "invalid_json")
    assert ORIGINAL_MARKER not in caplog.text
    assert str(originals) not in caplog.text


@pytest.mark.parametrize("root", [None, [], "boards", 42, True])
def test_non_object_root_is_invalid_schema(app_env, originals, root):
    app_env.BOARDS_FILE.write_text(json.dumps(root), encoding="utf-8")
    restart_rejected(app_env, originals, "invalid_schema")


# A path mutation keeps each case focused without duplicating whole documents.
@pytest.mark.parametrize("path,value", [
    pytest.param(("board",), None, id="null-board"),
    pytest.param(("board",), [], id="array-board"),
    pytest.param(("board",), {}, id="missing-board-id"),
    pytest.param(("board", "id"), "other", id="board-key-mismatch"),
    pytest.param(("board", "id"), 7, id="numeric-board-id"),
    pytest.param(("board", "name"), 7, id="numeric-name"),
    pytest.param(("board", "chain"), "false", id="string-chain"),
    pytest.param(("board", "createdAt"), "1.0", id="string-timestamp"),
    pytest.param(("board", "shots"), {}, id="shots-object"),
    pytest.param(("board", "shots"), [None], id="null-shot"),
    pytest.param(("board", "shots", 0, "id"), "", id="empty-shot-id"),
    pytest.param(("board", "shots", 0, "prompt"), 7, id="numeric-prompt"),
    pytest.param(("board", "shots", 0, "prompt_mode"), "future", id="unknown-prompt-mode"),
    pytest.param(("board", "shots", 0, "prompt_fields"), {"scene": 7}, id="typed-prompt-fields"),
    pytest.param(("board", "shots", 0, "width"), "512", id="string-width"),
    pytest.param(("board", "shots", 0, "height"), 512.5, id="fractional-height"),
    pytest.param(("board", "shots", 0, "width"), True, id="boolean-width"),
    pytest.param(("board", "shots", 0, "seconds"), "6", id="string-seconds"),
    pytest.param(("board", "shots", 0, "frames"), "56", id="string-frames"),
    pytest.param(("board", "shots", 0, "turbo"), 1, id="numeric-boolean"),
    pytest.param(("board", "shots", 0, "first_frame"), {}, id="invalid-media-name"),
    pytest.param(("board", "shots", 0, "ref_images"), "keep.png", id="reference-not-list"),
    pytest.param(("board", "shots", 0, "ref_audio"), [7], id="reference-item-type"),
    pytest.param(("board", "shots", 0, "takes"), {}, id="takes-object"),
    pytest.param(("board", "shots", 0, "takes"), [None], id="null-take"),
    pytest.param(("board", "shots", 0, "selected_take_id"), "missing", id="unknown-selection"),
    pytest.param(("board", "shots", 0, "selected_take_id"), 1, id="selection-type"),
])
def test_invalid_board_and_shot_structure_blocks_collection(app_env, originals, path, value):
    data = collection()
    target = data
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    app_env.BOARDS_FILE.write_text(json.dumps(data), encoding="utf-8")
    restart_rejected(app_env, originals, "invalid_schema")


@pytest.mark.parametrize("field,value", [
    ("id", ""), ("id", 1), ("shot_id", "other-shot"), ("job_id", []),
    ("output", None), ("created_at", "1.0"), ("request", []),
    ("request", {"prompt": 7}), ("request", {"prompt": "p", "width": "512"}),
    ("request_unknown", "false"), ("source_take_id", []), ("legacy", 1),
])
def test_invalid_take_structure_blocks_collection(app_env, originals, field, value):
    data = collection()
    data["board"]["shots"][0]["takes"][0][field] = value
    app_env.BOARDS_FILE.write_text(json.dumps(data), encoding="utf-8")
    restart_rejected(app_env, originals, "invalid_schema")


@pytest.mark.parametrize("case", ["duplicate-shot", "duplicate-take", "cross-shot-take", "cross-shot-selection"])
def test_history_identity_and_selection_are_validated(app_env, originals, case):
    data = collection()
    shots = data["board"]["shots"]
    if case == "duplicate-shot":
        shots.append(deepcopy(shots[0]))
    elif case == "duplicate-take":
        shots[0]["takes"].append(deepcopy(shots[0]["takes"][0]))
    else:
        second = deepcopy(shots[0])
        second["id"] = "s2"
        second["takes"][0]["shot_id"] = "s2"
        if case == "cross-shot-selection":
            second["takes"][0]["id"] = "t2"
            # t1 exists, but only in the other shot.
        shots.append(second)
    app_env.BOARDS_FILE.write_text(json.dumps(data), encoding="utf-8")
    restart_rejected(app_env, originals, "invalid_schema")


@pytest.mark.parametrize("level,field", [
    ("board", "future_metadata"), ("shot", "future_metadata"),
    ("take", "future_metadata"), ("take", "reference_snapshot"),
    ("prompt_fields", "future_metadata"),
])
def test_unknown_nested_metadata_is_a_forward_version_guard(app_env, originals, level, field):
    data = collection()
    board = data["board"]
    shot = board["shots"][0]
    shot["prompt_fields"] = {}
    target = {"board": board, "shot": shot, "take": shot["takes"][0],
              "prompt_fields": shot["prompt_fields"]}[level]
    # No #16 schema import: this backend must refuse metadata it cannot preserve.
    target[field] = {"version": 999, "nested": {"items": [{"original": ORIGINAL_MARKER}]}}
    app_env.BOARDS_FILE.write_text(json.dumps(data), encoding="utf-8")
    restart_rejected(app_env, originals, "invalid_schema")


@pytest.mark.parametrize("invalid_first", [False, True])
def test_one_invalid_record_never_quarantines_or_salvages_others(app_env, originals, invalid_first):
    good = collection()["board"]
    pairs = [("board", good), ("broken", {"id": "broken", "shots": "not-a-list"})]
    if invalid_first:
        pairs.reverse()
    app_env.BOARDS_FILE.write_text(json.dumps(dict(pairs)), encoding="utf-8")
    restart_rejected(app_env, originals, "invalid_schema")


def test_legacy_defaults_missing_media_and_infeasible_drafts_still_load(app_env, originals):
    data = collection()
    shot = data["board"]["shots"][0]
    draft = {"width": 0, "height": 123, "seconds": -1.0, "frames": 0,
             "steps": 0, "layers": 999, "reuse": -3, "seed": -7,
             "checkpoint_after_step": -2}
    shot.update(draft, first_frame="missing-first.png", last_frame="missing-last.png",
                ref_images=["missing-ref.png"], ref_audio=["missing-audio.wav"])
    shot["takes"][0]["output"] = "missing.mp4"
    shot["takes"][0]["request"].update(draft)
    data["legacy"] = {"id": "legacy", "shots": [{"id": "old", "output": "gone.mp4"}]}
    app_env.BOARDS_FILE.write_text(json.dumps(data), encoding="utf-8")
    before = disk_state(originals)
    restarted = restart_backend()
    assert restarted.BOARDS_LOAD_ERROR is None
    assert set(restarted.boards) == {"board", "legacy"}
    with TestClient(restarted.app) as client:
        response = client.get("/api/boards/board")
        assert response.status_code == 200
        restored = response.json()["shots"][0]
        assert all(restored[key] == value for key, value in draft.items())
        assert restored["takes"][0]["missing"] is True
        legacy = client.get("/api/boards/legacy").json()["shots"][0]
        assert legacy["prompt"] == ""
        assert legacy["takes"][0]["legacy"] is True
    assert disk_state(originals) == before


@pytest.mark.parametrize("kind", ["directory", "symlink", "dangling-symlink", "fifo", "missing-parent"])
def test_non_regular_or_inaccessible_locations_fail_closed(app_env, originals, monkeypatch, kind):
    path = app_env.BOARDS_FILE
    if kind == "directory":
        path.mkdir()
        (path / "original.txt").write_bytes(b"do not remove")
    elif kind in ("symlink", "dangling-symlink"):
        target = originals / "symlink-target.json"
        if kind == "symlink":
            target.write_bytes(b"{}")
        path.symlink_to(target)
    elif kind == "fifo":
        if not hasattr(os, "mkfifo"):
            pytest.skip("FIFO creation is unavailable")
        os.mkfifo(path)
    else:
        monkeypatch.setenv("H3_BOARDS_FILE", str(originals / "missing-parent" / path.name))
    restart_rejected(app_env, originals, "io_error")


def test_os_open_failure_is_sanitized_and_never_treated_as_empty(app_env, originals, monkeypatch, caplog):
    app_env.BOARDS_FILE.write_text(json.dumps(collection()), encoding="utf-8")
    real_open = os.open
    attempts = []

    def inaccessible(path, *args, **kwargs):
        if os.fspath(path) == os.fspath(app_env.BOARDS_FILE):
            attempts.append(True)
            raise OSError(errno.EACCES, IO_MARKER, os.fspath(path))
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", inaccessible)
    restart_rejected(app_env, originals, "io_error")
    assert attempts
    assert IO_MARKER not in caplog.text
    assert str(originals) not in caplog.text


@pytest.fixture
def recovery(app_env, originals):
    app_env.BOARDS_FILE.write_bytes(b'{"broken":')
    return restart_rejected(app_env, originals, "invalid_json")


@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("path", [
    "/api/boards", "/api/boards/", "/api/boards/board",
    "/api/boards/board/shots/s1/takes", "/api/boards/future/nested?retry=1",
])
def test_all_board_reads_fail_closed(recovery, method, path):
    with TestClient(recovery.app) as client:
        response = client.request(method, path)
        assert response.status_code == 503
        if method == "GET":
            assert_unavailable(response, "invalid_json")
        else:
            assert response.content == b""


WRITE_ROUTES = [
    ("POST", "/api/boards"), ("DELETE", "/api/boards/board"),
    ("POST", "/api/boards/board/duplicate"), ("POST", "/api/boards/board/run"),
    ("POST", "/api/boards/board/concat"),
    ("POST", "/api/boards/board/shots/s1/generate"),
    ("POST", "/api/boards/board/shots/s1/takes/t1/select"),
    ("DELETE", "/api/boards/board/shots/s1/takes/t1"),
    ("POST", "/api/generate"), ("POST", "/api/upload"),
    ("DELETE", "/api/videos/keep.mp4"), ("DELETE", "/api/jobs/persisted"),
    ("POST", "/api/jobs/persisted/resume"),
    ("POST", "/api/extract-last-frame/keep.mp4"),
    *[(method, "/api/future/unknown") for method in ("POST", "PUT", "PATCH", "DELETE")],
]


@pytest.mark.parametrize("method,path", WRITE_ROUTES)
def test_writes_block_before_body_parsing_or_side_effects(recovery, originals, monkeypatch, method, path):
    before_disk = disk_state(originals)
    # A cancellable in-memory job exposes accidental cancellation/queue mutation.
    recovery.jobs["persisted"]["status"] = "queued"
    recovery.queue.append("persisted")
    before_jobs, before_queue = deepcopy(recovery.jobs), list(recovery.queue)
    forbidden = Mock(side_effect=AssertionError("recovery request reached a side effect"))
    for name in ("enqueue_job", "launch_next", "run_job", "save_jobs", "save_boards",
                 "stop_process", "extract_last_frame_of"):
        monkeypatch.setattr(recovery, name, forbidden)
    monkeypatch.setattr(recovery.subprocess, "Popen", forbidden)
    monkeypatch.setattr(recovery.subprocess, "run", forbidden)
    monkeypatch.setattr(Request, "json", forbidden)
    monkeypatch.setattr(Request, "form", forbidden)
    monkeypatch.setattr(Request, "body", forbidden)
    with TestClient(recovery.app) as client:
        for body in (b'{"invalid":', b'{"prompt":"must not run","id":"","name":"overwrite"}'):
            response = client.request(method, path, content=body,
                                      headers={"content-type": "application/json"})
            assert_unavailable(response, "invalid_json")
    forbidden.assert_not_called()
    assert recovery.jobs == before_jobs
    assert recovery.queue == before_queue
    assert recovery.active_job_id is None
    assert recovery.boards == {}
    assert disk_state(originals) == before_disk


def test_valid_upload_is_blocked_without_creating_a_file(recovery, originals):
    before = disk_state(originals)
    with TestClient(recovery.app) as client:
        response = client.post("/api/upload", files={"file": ("new.png", b"new image", "image/png")})
        assert_unavailable(response, "invalid_json")
    assert disk_state(originals) == before


def test_jobs_media_and_cors_preflight_remain_available(recovery, originals, monkeypatch):
    before = disk_state(originals)
    probe = Mock(return_value=Mock(stdout='{"format":{"duration":"1.0"}}'))
    monkeypatch.setattr(recovery.subprocess, "run", probe)
    with TestClient(recovery.app) as client:
        assert client.get("/api/jobs").json()[0]["id"] == "persisted"
        assert client.get("/api/jobs/persisted").json()["log"] == ["original log"]
        assert client.get("/api/videos").json()[0]["name"] == "keep.mp4"
        assert client.get("/api/uploads").json() == ["keep.png"]
        for path, expected in (("/api/media/keep.mp4", b"original video"),
                               ("/outputs/keep.mp4", b"original video"),
                               ("/uploads/keep.png", b"original reference image")):
            response = client.get(path)
            assert response.status_code == 200 and response.content == expected
        assert client.head("/outputs/keep.mp4").status_code == 200
        for path in ("/api/boards", "/api/generate", "/api/future/unknown"):
            response = client.options(path, headers={
                "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
            assert response.status_code == 200
            assert response.headers["access-control-allow-origin"] == "*"
    assert disk_state(originals) == before


@pytest.mark.parametrize("writer", ["atomic_json", "save_boards"])
def test_direct_persistence_guard_does_not_touch_source_or_tmp(recovery, originals, writer):
    before = disk_state(originals)
    with pytest.raises(HTTPException) as caught:
        if writer == "atomic_json":
            # An unserializable value proves the guard precedes JSON encoding too.
            recovery.atomic_json(recovery.BOARDS_FILE, {"must-not-serialize": object()})
        else:
            recovery.save_boards()
    assert caught.value.status_code == 503
    assert ORIGINAL_MARKER not in str(caught.value.detail)
    assert disk_state(originals) == before


def test_retry_cannot_replace_the_latched_failure_reason(recovery, originals):
    for raw in (b"[]", b"{}"):
        recovery.BOARDS_FILE.write_bytes(raw)
        before = disk_state(originals)
        recovery.load_boards()
        assert recovery.BOARDS_LOAD_ERROR == "invalid_json"
        assert recovery.boards == {}
        with TestClient(recovery.app) as client:
            assert_unavailable(client.get("/api/boards"), "invalid_json")
        assert disk_state(originals) == before


def test_restoring_file_or_retrying_does_not_clear_latch_until_restart(recovery, originals):
    recovery.BOARDS_FILE.write_text(json.dumps(collection()), encoding="utf-8")
    before = disk_state(originals)
    with TestClient(recovery.app) as client:
        for _ in range(2):
            assert_unavailable(client.get("/api/boards?retry=1"), "invalid_json")
            recovery.load_boards()
            assert recovery.BOARDS_LOAD_ERROR == "invalid_json"
            assert recovery.boards == {}
            assert_unavailable(client.post("/api/boards", json={"id": "", "name": "retry"}), "invalid_json")
        with pytest.raises(HTTPException) as caught:
            recovery.atomic_json(recovery.BOARDS_FILE, {})
        assert caught.value.status_code == 503
    assert disk_state(originals) == before
    restarted = restart_backend()
    assert restarted.BOARDS_LOAD_ERROR is None
    with TestClient(restarted.app) as client:
        response = client.get("/api/boards/board")
        assert response.status_code == 200
        assert response.json()["name"] == ORIGINAL_MARKER
        assert disk_state(originals) == before
        assert client.post("/api/boards", json={"id": "", "name": "recovered"}).status_code == 200


def test_authentication_precedes_recovery_without_exposing_credentials(app_env, originals, monkeypatch, caplog):
    # Generate credentials locally; never parametrize, print, or assert their repr.
    credential = secrets.token_urlsafe(32)
    wrong_credential = secrets.token_urlsafe(32)
    monkeypatch.setenv("H3_STUDIO_TOKEN", credential)
    app_env.BOARDS_FILE.write_bytes(b'{"broken":')
    restarted = restart_backend()
    before = disk_state(originals)
    with TestClient(restarted.app) as client:
        for method, path in (("POST", "/api/boards"), ("POST", "/api/upload"),
                             ("DELETE", "/api/jobs/persisted"), ("PATCH", "/api/future/unknown"),
                             ("PUT", "/api/future/unknown")):
            for headers in ({}, {"Authorization": "Bearer " + wrong_credential}):
                response = client.request(method, path, content=b"{", headers=headers)
                leaked = any(value in response.text for value in (credential, wrong_credential))
                assert not leaked, "response exposed an authentication credential"
                assert response.status_code == 401
                assert "code" not in response.json()
            response = client.request(method, path, content=b"{", headers={
                "Authorization": "Bearer " + credential, "content-type": "application/json"})
            leaked = credential in response.text
            assert not leaked, "response exposed an authentication credential"
            assert_unavailable(response, "invalid_json")
        assert_unavailable(client.get("/api/boards"), "invalid_json")
        assert client.get("/api/jobs").status_code == 200
        response = client.options("/api/boards", headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"})
        assert response.status_code == 200
    logged = any(value in caplog.text for value in (credential, wrong_credential))
    assert not logged, "logs exposed an authentication credential"
    assert disk_state(originals) == before