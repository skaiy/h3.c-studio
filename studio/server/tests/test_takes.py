"""Take history, selection, dependencies, migration, and media ownership."""
import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from .conftest import FakeProc, restart_backend, wait_for_status


def create_board(client, shots, **options):
    response = client.post("/api/boards", json={
        "id": "", "name": "takes", "shots": shots, **options})
    assert response.status_code == 200, response.text
    return response.json()


def generate(client, board, shot_id):
    response = client.post(
        f"/api/boards/{board['id']}/shots/{shot_id}/generate")
    assert response.status_code == 200, response.text
    wait_for_status(client, response.json()["job_id"], {"done", "error"})
    return response.json()["job_id"]


def board(client, board_id):
    return client.get(f"/api/boards/{board_id}").json()


def select(client, board_id, shot_id, take_id):
    return client.post(
        f"/api/boards/{board_id}/shots/{shot_id}/takes/{take_id}/select")


@pytest.fixture
def take_engine(app_env, monkeypatch):
    state = SimpleNamespace(commands=[], extracts=[], concat_inputs=[], fail=False)

    def popen(cmd, **kwargs):
        state.commands.append(cmd)
        output = Path(cmd[cmd.index("-o") + 1])
        if not state.fail:
            output.write_bytes(output.name.encode())
        lines = ["synthetic failure"] if state.fail else [f"h3: wrote {output}"]
        return FakeProc(lines, returncode=1 if state.fail else 0)

    def run(cmd, **kwargs):
        assert cmd[0] == "ffmpeg"
        output = Path(cmd[-1])
        if "concat" in cmd:
            state.concat_inputs.append(Path(cmd[cmd.index("-i") + 1]).read_text())
            output.write_bytes(b"concat")
        else:
            state.extracts.append(cmd)
            output.write_bytes(b"frame")
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(app_env.subprocess, "Popen", popen)
    monkeypatch.setattr(app_env.subprocess, "run", run)
    return state


def test_generate_twice_select_old_and_restart(app_env, client, take_engine):
    created = create_board(client, [{"id": "s1", "prompt": "first"}])
    first_job = generate(client, created, "s1")
    latest = board(client, created["id"])
    latest["shots"][0]["prompt"] = "second"
    saved = client.post("/api/boards", json=latest)
    assert saved.status_code == 200
    second_job = generate(client, created, "s1")
    shot = board(client, created["id"])["shots"][0]
    assert [take["job_id"] for take in shot["takes"]] == [first_job, second_job]
    first = shot["takes"][0]
    assert first["id"] == f"take-{first_job}"
    assert first["model_name"] == "MiniMax-H3"
    app_env.boards[created["id"]]["result"] = "old-concat.mp4"
    assert select(client, created["id"], "s1", first["id"]).status_code == 200
    assert board(client, created["id"])["result"] is None
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        persisted = board(fresh, created["id"])["shots"][0]
        assert persisted["selected_take_id"] == first["id"]
        assert persisted["output"] == first["output"]
        assert len(fresh.get(
            f"/api/boards/{created['id']}/shots/s1/takes").json()) == 2


def test_snapshot_immutable_and_failed_retry_preserves_history(
        app_env, client, take_engine):
    created = create_board(client, [{
        "id": "s1", "prompt": " original ", "seed": 123, "frames": 56}])
    generate(client, created, "s1")
    original = board(client, created["id"])
    take = original["shots"][0]["takes"][0]
    original["shots"][0].update(prompt="edited", seed=999)
    original["shots"][0]["takes"][0]["request"]["prompt"] = "forged"
    assert client.post("/api/boards", json=original).status_code == 200
    take_engine.fail = True
    failed_job = generate(client, created, "s1")
    result = board(client, created["id"])["shots"][0]
    assert result["status"] == "error"
    assert len(result["takes"]) == 1
    assert result["selected_take_id"] == take["id"]
    assert result["output"] == take["output"]
    assert result["takes"][0]["request"]["prompt"] == " original "
    assert result["takes"][0]["request"]["seed"] == 123
    assert all(item["job_id"] != failed_job for item in result["takes"])


def test_chain_source_stale_without_queue_and_batch_source_id(
        app_env, client, take_engine):
    created = create_board(client, [
        {"id": "s1", "prompt": "upstream"},
        {"id": "s2", "prompt": "downstream"}])
    first_id = generate(client, created, "s1")
    first_take = board(client, created["id"])["shots"][0]["takes"][0]
    second_id = generate(client, created, "s1")
    current_take = board(client, created["id"])["shots"][0]["takes"][-1]
    downstream_job = generate(client, created, "s2")
    downstream = board(client, created["id"])["shots"][1]
    assert downstream["takes"][0]["source_take_id"] == current_take["id"]
    assert app_env.jobs[downstream_job]["source_take_id"] == current_take["id"]
    before_jobs = len(app_env.jobs)
    assert select(client, created["id"], "s1", first_take["id"]).status_code == 200
    stale = board(client, created["id"])["shots"][1]
    assert stale["stale"] and stale["continuity_state"] == "stale"
    assert len(app_env.jobs) == before_jobs and not app_env.queue
    assert first_id != second_id

    batch = create_board(client, [
        {"id": "a", "prompt": "one"}, {"id": "b", "prompt": "two"}])
    assert client.post(f"/api/boards/{batch['id']}/run").status_code == 200
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = board(client, batch["id"])
        if result["status"] in ("done", "error"):
            break
        time.sleep(0.01)
    assert result["status"] == "done"
    assert result["shots"][1]["takes"][0]["source_take_id"] == \
        result["shots"][0]["takes"][0]["id"]


def test_legacy_migration_is_stable_unknown_and_missing(app_env):
    app_env.BOARDS_FILE.write_text(json.dumps({"old": {
        "id": "old", "createdAt": 7, "shots": [{
            "id": "s", "prompt": "current params are unknowable",
            "seed": 999, "output": "gone.mp4", "status": "done"}]}}))
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        first = board(fresh, "old")["shots"][0]
        missing_select = select(fresh, "old", "s", first["takes"][0]["id"])
        assert missing_select.status_code == 409
    take = first["takes"][0]
    assert take["legacy"] and take["request_unknown"] and take["source_unknown"]
    assert take["created_at"] is None and take["request"] is None and take["missing"]
    assert first["selected_take_id"] == take["id"]
    assert first["output"] == "gone.mp4" and first["output_missing"]
    assert first["continuity_state"] == "stale"
    assert "missing" not in app_env.BOARDS_FILE.read_text()
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        assert board(fresh, "old")["shots"][0]["takes"][0]["id"] == take["id"]


def test_autosave_and_duplicate_reset_server_owned_history(
        app_env, client, take_engine):
    created = create_board(client, [{"id": "s1", "prompt": "history"}])
    generate(client, created, "s1")
    current = board(client, created["id"])
    original = current["shots"][0]
    forged = {**original["takes"][0], "id": "forged", "output": "forged.mp4"}
    original.update(status="idle", output="forged.mp4", job_id="forged",
                    takes=[forged], selected_take_id="forged")
    original["request"] = None
    current["shots"].append({
        "id": "new", "prompt": "new", "status": "done", "output": "forged.mp4",
        "job_id": "forged", "takes": [forged], "selected_take_id": "forged"})
    saved = client.post("/api/boards", json=current)
    assert saved.status_code == 200, saved.text
    shots = saved.json()["shots"]
    assert shots[0]["selected_take_id"] != "forged" and len(shots[0]["takes"]) == 1
    assert shots[0]["status"] == "done" and shots[0]["job_id"] != "forged"
    assert shots[1]["takes"] == [] and shots[1]["selected_take_id"] is None
    assert shots[1]["output"] is None and shots[1]["job_id"] is None
    copied = client.post(f"/api/boards/{created['id']}/duplicate").json()
    assert all(not shot["takes"] and shot["selected_take_id"] is None
               and shot["output"] is None and shot["job_id"] is None
               for shot in copied["shots"])


def test_autosave_reorder_invalidates_concat_and_cannot_remove_referenced_shot(
        app_env, client, take_engine):
    created = create_board(client, [
        {"id": "a", "prompt": "source"}, {"id": "b", "prompt": "dependent"}])
    generate(client, created, "a")
    generate(client, created, "b")
    current = board(client, created["id"])
    app_env.boards[created["id"]]["result"] = "old-concat.mp4"
    current["modifiedAt"] = app_env.boards[created["id"]]["modifiedAt"]
    current["result"] = "old-concat.mp4"
    current["shots"].reverse()
    reordered = client.post("/api/boards", json=current)
    assert reordered.status_code == 200 and reordered.json()["result"] is None

    latest = reordered.json()
    latest["shots"] = [shot for shot in latest["shots"] if shot["id"] != "a"]
    rejected = client.post("/api/boards", json=latest)
    assert rejected.status_code == 409 and "referenced" in rejected.json()["detail"]


def test_active_selection_and_completion_selection_guard(
        app_env, client, take_engine, monkeypatch):
    (app_env.OUTPUTS / "legacy.mp4").write_bytes(b"legacy")
    created = create_board(client, [{
        "id": "s1", "prompt": "p", "output": "legacy.mp4", "status": "done"}])
    generate(client, created, "s1")
    takes = board(client, created["id"])["shots"][0]["takes"]
    legacy, generated = takes
    assert select(client, created["id"], "s1", legacy["id"]).status_code == 200
    original_run_job = app_env.run_job
    entered, release = threading.Event(), threading.Event()

    def paused(job_id):
        entered.set()
        assert release.wait(5)
        original_run_job(job_id)

    monkeypatch.setattr(app_env, "run_job", paused)
    response = client.post(
        f"/api/boards/{created['id']}/shots/s1/generate")
    assert response.status_code == 200 and entered.wait(2)
    assert select(client, created["id"], "s1", legacy["id"]).status_code == 409
    app_env.boards[created["id"]]["shots"][0]["selected_take_id"] = generated["id"]
    app_env.project_selected_output(app_env.boards[created["id"]]["shots"][0])
    release.set()
    wait_for_status(client, response.json()["job_id"], {"done"})
    result = board(client, created["id"])["shots"][0]
    assert len(result["takes"]) == 3
    assert result["selected_take_id"] == generated["id"]
    assert result["output"] == generated["output"]


def test_delete_guards_metadata_only_and_video_references(
        app_env, client, take_engine):
    created = create_board(client, [{"id": "s1", "prompt": "p"}])
    generate(client, created, "s1")
    generate(client, created, "s1")
    shot = board(client, created["id"])["shots"][0]
    old, selected_take = shot["takes"]
    old_file = app_env.OUTPUTS / old["output"]
    url = f"/api/boards/{created['id']}/shots/s1/takes"
    assert client.delete(f"{url}/{selected_take['id']}").status_code == 409
    assert client.delete(f"/api/videos/{selected_take['output']}").status_code == 409
    deleted = client.delete(f"{url}/{old['id']}")
    assert deleted.status_code == 200 and old_file.exists()

    linked = create_board(client, [
        {"id": "a", "prompt": "a"}, {"id": "b", "prompt": "b"}])
    generate(client, linked, "a")
    source = board(client, linked["id"])["shots"][0]["takes"][0]
    generate(client, linked, "b")
    generate(client, linked, "a")
    ref_url = f"/api/boards/{linked['id']}/shots/a/takes/{source['id']}"
    assert client.delete(ref_url).status_code == 409
    assert (app_env.OUTPUTS / source["output"]).exists()

    app_env.boards[linked["id"]]["shots"][1]["takes"] = []
    app_env.boards[linked["id"]]["shots"][1]["selected_take_id"] = None
    app_env.jobs[source["job_id"]]["source_take_id"] = source["id"]
    assert client.delete(ref_url).status_code == 409


def test_chain_and_concat_consume_selected_old_take(
        app_env, client, take_engine):
    created = create_board(client, [
        {"id": "s1", "prompt": "first"}, {"id": "s2", "prompt": "second"}])
    generate(client, created, "s1")
    generate(client, created, "s1")
    first_old = board(client, created["id"])["shots"][0]["takes"][0]
    assert select(client, created["id"], "s1", first_old["id"]).status_code == 200
    generate(client, created, "s2")
    extracted = Path(take_engine.extracts[-1][take_engine.extracts[-1].index("-i") + 1])
    assert extracted.name == first_old["output"]
    second = board(client, created["id"])["shots"][1]["takes"][0]
    assert second["source_take_id"] == first_old["id"]
    response = client.post(f"/api/boards/{created['id']}/concat")
    assert response.status_code == 200, response.text
    concat = take_engine.concat_inputs[-1]
    assert first_old["output"] in concat and second["output"] in concat


def test_resume_preserves_original_chain_source_id(app_env, client, take_engine, monkeypatch):
    created = create_board(client, [
        {"id": "s1", "prompt": "source"},
        {"id": "s2", "prompt": "checkpoint", "reuse": 1,
         "checkpoint_after_step": 3}])
    generate(client, created, "s1")
    source = board(client, created["id"])["shots"][0]["takes"][0]

    real_popen = app_env.subprocess.Popen

    def checkpoint_engine(cmd, **kwargs):
        if "--checkpoint" in cmd:
            Path(cmd[cmd.index("--checkpoint") + 1]).write_bytes(b"checkpoint")
        return real_popen(cmd, **kwargs)

    monkeypatch.setattr(app_env.subprocess, "Popen", checkpoint_engine)
    original_id = generate(client, created, "s2")
    monkeypatch.setattr(app_env, "validate_checkpoint", lambda name, req: None)
    response = client.post(f"/api/jobs/{original_id}/resume")
    assert response.status_code == 200, response.text
    resumed_id = response.json()["job_id"]
    wait_for_status(client, resumed_id, {"done", "error"})
    result = board(client, created["id"])["shots"][1]["takes"][-1]
    assert result["job_id"] == resumed_id
    assert result["source_take_id"] == source["id"]


def test_legacy_chained_resume_marks_source_unknown(app_env, client, take_engine, monkeypatch):
    created = create_board(client, [{
        "id": "s1", "prompt": "legacy checkpoint", "reuse": 1,
        "checkpoint_after_step": 3}])
    original_id = generate(client, created, "s1")
    original = app_env.jobs[original_id]
    Path(app_env.OUTPUTS / original["checkpoint"]).write_bytes(b"checkpoint")
    original["chain_source"] = "legacy-upstream.mp4"
    original.pop("source_take_id", None)
    original.pop("source_unknown", None)
    monkeypatch.setattr(app_env, "validate_checkpoint", lambda name, req: None)
    response = client.post(f"/api/jobs/{original_id}/resume")
    assert response.status_code == 200, response.text
    resumed_id = response.json()["job_id"]
    wait_for_status(client, resumed_id, {"done", "error"})
    take = board(client, created["id"])["shots"][0]["takes"][-1]
    assert take["job_id"] == resumed_id
    assert take["source_take_id"] is None and take["source_unknown"]
    assert board(client, created["id"])["shots"][0]["continuity_state"] == "unknown"