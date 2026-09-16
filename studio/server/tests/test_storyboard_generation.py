"""P0 storyboard lifecycle tests: real request/CLI building, fake engine only."""
import json
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from .conftest import FakeProc, restart_backend, wait_for_status


def create_board(client, shots, **options):
    response = client.post("/api/boards", json={"id": "", "name": "P0", "shots": shots, **options})
    assert response.status_code == 200, response.text
    return response.json()


def generate_url(board, shot_id="s1"):
    return f"/api/boards/{board['id']}/shots/{shot_id}/generate"


def wait_board(client, board, status="done"):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = client.get(f"/api/boards/{board['id']}").json()
        if result["status"] == status:
            return result
        time.sleep(0.01)
    raise AssertionError(result)


def checkpoint_file(path, req):
    """Synthetic metadata/payload; the real engine owns signature/hash validation."""
    header = bytearray(128)
    header[:8] = b"H3CKPT1\n"
    struct.pack_into("<II", header, 8, 128, 0x01020304)
    struct.pack_into("<Q", header, 24, req.seed)
    frames = req.frames if req.frames is not None else int((req.seconds or 56 / 24) * 24 + 0.5)
    frames = 5 + ((frames - 5 + 16) // 17) * 17
    struct.pack_into("<IIIII", header, 32, req.steps, 2, req.width, req.height, frames)
    struct.pack_into("<QQd", header, 56, 1, 1, 1.0)
    path.write_bytes(header + bytes(8))


@pytest.fixture
def engine(app_env, monkeypatch):
    state = SimpleNamespace(commands=[], probes=[], extracts=[], durations={})

    def popen(cmd, **kwargs):
        assert cmd[0] == str(app_env.H3_BIN)
        state.commands.append(cmd)
        output = Path(cmd[cmd.index("-o") + 1])
        output.write_bytes(b"fake-video")
        if "--checkpoint" in cmd:
            req = app_env.GenRequest(prompt=cmd[cmd.index("-p") + 1], **{
                key: int(cmd[cmd.index("--" + key) + 1])
                for key in ("width", "height", "steps", "seed")})
            if "--frames" in cmd:
                req.frames = int(cmd[cmd.index("--frames") + 1])
            elif "--seconds" in cmd:
                req.seconds = float(cmd[cmd.index("--seconds") + 1])
            checkpoint_file(Path(cmd[cmd.index("--checkpoint") + 1]), req)
        return FakeProc([f"h3: wrote {output}"])

    def run(cmd, **kwargs):
        if cmd[0] == "ffprobe":
            assert kwargs["timeout"] == 10 and kwargs["check"]
            state.probes.append(cmd)
            duration = state.durations.get(Path(cmd[-1]).name, 3.0)
            data = {"streams": [{"codec_type": "audio", "duration": str(duration)}]}
            return SimpleNamespace(stdout=json.dumps(data), stderr="", returncode=0)
        assert cmd[0] == "ffmpeg"
        assert kwargs["timeout"] == 30 and kwargs["check"]
        state.extracts.append(cmd)
        Path(cmd[-1]).write_bytes(b"fake-frame")
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(app_env.subprocess, "Popen", popen)
    monkeypatch.setattr(app_env.subprocess, "run", run)
    return state


def media_files(app_env, *names):
    for name in names:
        (app_env.UPLOADS / name).write_bytes(b"test-media")


@pytest.mark.parametrize("mode", ["single", "batch"])
def test_failed_retry_preserves_existing_output(app_env, client, monkeypatch, mode):
    board = create_board(client, [{"id": "s1", "prompt": "retry", "output": "old.mp4", "status": "done"}])
    (app_env.OUTPUTS / "old.mp4").write_bytes(b"original")
    monkeypatch.setattr(app_env.subprocess, "Popen", lambda *a, **k: FakeProc(["failure"], returncode=1))
    url = generate_url(board) if mode == "single" else f"/api/boards/{board['id']}/run"
    assert client.post(url).status_code == 200
    failed = wait_board(client, board, "error")
    assert failed["shots"][0]["output"] == "old.mp4"
    assert (app_env.OUTPUTS / "old.mp4").read_bytes() == b"original"


def test_repeated_upload_names_never_overwrite_reference_media(app_env, client):
    first = client.post("/api/upload", files={"file": ("reference.png", b"first", "image/png")}).json()["name"]
    second = client.post("/api/upload", files={"file": ("reference.png", b"second", "image/png")}).json()["name"]
    assert first != second
    assert (app_env.UPLOADS / first).read_bytes() == b"first"
    assert (app_env.UPLOADS / second).read_bytes() == b"second"


def test_shot_fields_roundtrip_duplicate_and_restart(app_env, client):
    fields = {"ref_images": ["b.png", "a.png"], "ref_audio": ["b.wav", "a.wav"],
              "frames": 56, "token_reduction": True, "checkpoint_after_step": 4,
              "prompt_mode": "structured", "prompt_fields": {"scene": "rain", "audio": "music"}}
    board = create_board(client, [{"id": "s1", "prompt": "saved exact prompt", **fields}])
    fields["prompt_fields"].update(action="", camera="", look="")
    copied = client.post(f"/api/boards/{board['id']}/duplicate").json()
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        for item in (board, copied):
            shot = fresh.get(f"/api/boards/{item['id']}").json()["shots"][0]
            for key, value in fields.items():
                assert shot[key] == value


def test_legacy_boards_get_defaults_and_interrupted_state(app_env):
    app_env.BOARDS_FILE.write_text(json.dumps({"old": {
        "id": "old", "status": "running", "shots": [{"id": "s", "prompt": "old", "status": "queued"}]}}))
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        board = fresh.get("/api/boards/old").json()
    shot = board["shots"][0]
    assert board["status"] == shot["status"] == "interrupted"
    assert shot["ref_images"] == shot["ref_audio"] == []
    assert shot["prompt_mode"] == "simple" and shot["prompt_fields"] is None
    assert shot["frames"] is None and shot["checkpoint_after_step"] is None
    assert shot["token_reduction"] is False


@pytest.mark.parametrize("field,value", [("prompt_mode", "invalid"), ("ref_audio", "x.wav"),
                                         ("ref_images", [123]), ("prompt_fields", {"scene": []})])
def test_new_shot_fields_are_typed(client, field, value):
    response = client.post("/api/boards", json={"id": "", "shots": [{
        "id": "s1", "prompt": "p", field: value}]})
    assert response.status_code == 422


@pytest.mark.parametrize("batch", [False, True])
def test_single_and_batch_use_all_saved_cli_params(app_env, client, engine, batch):
    media_files(app_env, "b.png", "a.png", "b.wav", "a.wav")
    shot = {"id": "s1", "prompt": " exact saved prompt ", "width": 640, "height": 384,
            "seconds": 8, "frames": 56, "steps": 12, "layers": 40, "reuse": 1, "seed": 987,
            "ref_images": ["b.png", "a.png"], "ref_audio": ["b.wav", "a.wav"],
            "token_reduction": True, "turbo": True, "checkpoint_after_step": 3,
            "prompt_mode": "structured", "prompt_fields": {"scene": "not the actual prompt"}}
    (app_env.H3_DIR / "MiniMax-H3-turbo").mkdir()
    board = create_board(client, [shot])
    url = f"/api/boards/{board['id']}/run" if batch else generate_url(board)
    response = client.post(url)
    assert response.status_code == 200, response.text
    assert response.json()["warnings"]
    finished = wait_board(client, board)
    job = client.get(f"/api/jobs/{finished['shots'][0]['job_id']}").json()
    assert job["warnings"] and "warning:" in " ".join(job["log"])
    cmd = engine.commands[0]
    for flag, value in (("-p", shot["prompt"]), ("--width", "640"), ("--height", "384"),
                        ("--frames", "56"), ("--steps", "12"), ("--layers", "40"),
                        ("--reuse", "1"), ("--seed", "987"), ("--checkpoint-after-step", "3")):
        assert cmd[cmd.index(flag) + 1] == value
    assert cmd[cmd.index("-d") + 1].endswith("MiniMax-H3-turbo")
    assert "--seconds" not in cmd and "--token-reduction" in cmd
    for flag, expected in (("--ref-image", ["b.png", "a.png"]), ("--ref-audio", ["b.wav", "a.wav"])):
        assert [Path(cmd[i + 1]).name for i, arg in enumerate(cmd) if arg == flag] == expected
    assert "--first-frame" not in cmd and engine.extracts == []
    assert finished["shots"][0]["first_frame"] is None


def test_batch_mixed_refs_and_chain_skips_blank_shots(app_env, client, engine):
    media_files(app_env, "ref.png", "sound.wav", "anchor.png")
    board = create_board(client, [
        {"id": "s1", "prompt": "first"}, {"id": "blank", "prompt": " "},
        {"id": "s2", "prompt": "refs", "ref_images": ["ref.png"], "ref_audio": ["sound.wav"]},
        {"id": "s3", "prompt": "chained"},
        {"id": "s4", "prompt": "explicit", "first_frame": "anchor.png"}])
    assert client.post(f"/api/boards/{board['id']}/run").status_code == 200
    finished = wait_board(client, board)
    assert finished["shots"][1]["status"] == "skipped"
    assert len(engine.commands) == 4 and len(engine.extracts) == 1
    assert "--first-frame" not in engine.commands[1]
    assert "--first-frame" in engine.commands[2]
    assert engine.extracts[0][engine.extracts[0].index("-i") + 1].endswith(finished["shots"][2]["output"])
    assert all(s["first_frame"] is None for s in finished["shots"][:-1])
    assert finished["shots"][-1]["first_frame"] == "anchor.png"


@pytest.mark.parametrize("chain,nearest_output,expected_extracts", [(True, "prev.mp4", 1),
                                                                   (True, None, 0), (False, "prev.mp4", 0)])
def test_single_uses_nearest_nonempty_prompt_not_blank_or_older_output(
        app_env, client, engine, chain, nearest_output, expected_extracts):
    (app_env.OUTPUTS / "prev.mp4").write_bytes(b"clip")
    board = create_board(client, [
        {"id": "old", "prompt": "older", "output": "wrong-older.mp4"},
        {"id": "prev", "prompt": "nearest", "output": nearest_output},
        {"id": "blank", "prompt": " ", "output": "wrong-blank.mp4"},
        {"id": "s1", "prompt": "target"}], chain=chain)
    response = client.post(generate_url(board))
    assert response.status_code == 200, response.text
    wait_for_status(client, response.json()["job_id"], {"done"})
    assert len(engine.extracts) == expected_extracts
    if expected_extracts:
        assert Path(engine.extracts[0][engine.extracts[0].index("-i") + 1]).name == "prev.mp4"
    assert client.get(f"/api/boards/{board['id']}").json()["shots"][-1]["first_frame"] is None


@pytest.mark.parametrize("anchor", ["first_frame", "last_frame"])
@pytest.mark.parametrize("mode", ["single", "batch", "generic"])
def test_explicit_anchors_and_refs_rejected_before_queue(app_env, client, engine, anchor, mode):
    shot = {"id": "s1", "prompt": "refs", "ref_images": ["ref.png"], anchor: "anchor.png"}
    board = create_board(client, [shot])
    if mode == "generic":
        response = client.post("/api/generate", json=shot)
    else:
        url = generate_url(board) if mode == "single" else f"/api/boards/{board['id']}/run"
        response = client.post(url)
    assert response.status_code == 400 and "anchors" in response.json()["detail"]
    assert not app_env.jobs and not app_env.queue and not engine.commands


@pytest.mark.parametrize("invalid", [{"width": 33}, {"frames": 0}, {"steps": 1},
                                      {"ref_images": ["missing.png"]}, {"ref_audio": ["a.wav"]},
                                      {"checkpoint_after_step": 3}, {"ref_images": ["a.png"] * 10}])
def test_whole_board_preflight_starts_nothing(app_env, client, engine, invalid):
    board = create_board(client, [{"id": "s1", "prompt": "valid first"},
                                  {"id": "s2", "prompt": "bad second", **invalid}])
    before = app_env.BOARDS_FILE.read_text()
    response = client.post(f"/api/boards/{board['id']}/run")
    assert response.status_code in (400, 404) and "s2" in response.json()["detail"]
    assert not app_env.jobs and not app_env.queue and not engine.commands
    assert app_env.BOARDS_FILE.read_text() == before


@pytest.mark.parametrize("durations,expected", [([2], 200), ([15], 200), ([5, 5, 5], 200),
                                               ([1.99], 400), ([15.01], 400), ([8, 8], 400),
                                               ([2, 2, 2, 2], 400), ([float("nan")], 400)])
def test_audio_duration_and_count_boundaries(app_env, client, engine, durations, expected):
    names = [f"a{i}.wav" for i in range(len(durations))]
    media_files(app_env, "ref.png", *names)
    engine.durations.update(zip(names, durations))
    response = client.post("/api/generate", json={
        "prompt": "audio", "ref_images": ["ref.png"], "ref_audio": names})
    assert response.status_code == expected, response.text
    if expected == 200:
        wait_for_status(client, response.json()["job_id"], {"done"})
    else:
        assert not app_env.jobs and not engine.commands


@pytest.mark.parametrize("failure", ["timeout", "missing_probe", "nonzero", "no_audio", "unknown_duration"])
def test_audio_probe_failures_are_prequeue_errors(app_env, client, engine, monkeypatch, failure):
    media_files(app_env, "ref.png", "a.wav")

    def fail_probe(cmd, **kwargs):
        assert kwargs["timeout"] == 10
        if failure == "timeout":
            raise app_env.subprocess.TimeoutExpired(cmd, 10)
        if failure == "missing_probe":
            raise FileNotFoundError("ffprobe")
        if failure == "nonzero":
            raise app_env.subprocess.CalledProcessError(1, cmd)
        data = {"streams": []} if failure == "no_audio" else {"streams": [{"codec_type": "audio"}]}
        return SimpleNamespace(stdout=json.dumps(data))

    monkeypatch.setattr(app_env.subprocess, "run", fail_probe)
    board = create_board(client, [{"id": "s1", "prompt": "valid"},
                                  {"id": "s2", "prompt": "audio", "ref_images": ["ref.png"], "ref_audio": ["a.wav"]}])
    response = client.post(f"/api/boards/{board['id']}/run")
    assert response.status_code == 400 and "probe" in response.json()["detail"]
    assert not app_env.jobs and not engine.commands


@pytest.mark.parametrize("name", ["../escape.png", "/tmp/image.png", "https://example.com/x.png",
                                  "folder\\image.png", "", ".", "..", "missing.png"])
def test_generation_inputs_are_local_existing_filenames(app_env, client, engine, name):
    response = client.post("/api/generate", json={"prompt": "p", "ref_images": [name]})
    assert response.status_code in (400, 404)
    assert not app_env.jobs and not engine.commands


def test_generation_rejects_symlink_escape_and_directory(app_env, client, engine, tmp_path):
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"not in media roots")
    (app_env.UPLOADS / "escape.png").symlink_to(outside)
    (app_env.UPLOADS / "directory.png").mkdir()
    for name in ("escape.png", "directory.png"):
        assert client.post("/api/generate", json={"prompt": "p", "first_frame": name}).status_code in (400, 404)
    assert not engine.commands


def test_invalid_historical_requests_still_load(app_env):
    req = app_env.GenRequest(prompt="", width=1, steps=0, ref_audio=["lost.wav"],
                            first_frame="missing.png", checkpoint_after_step=90)
    app_env.jobs["legacy"] = {"id": "legacy", "request": req, "status": "running",
                              "created": 1, "label": "legacy", "log": []}
    app_env.save_jobs()
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        response = fresh.get("/api/jobs/legacy")
    assert response.status_code == 200
    assert response.json()["status"] == "interrupted"
    assert response.json()["params"]["ref_audio"] == ["lost.wav"]
    assert response.json()["params"]["width"] == 1


def test_resume_uses_exact_original_request_after_ui_edits_and_restart(app_env, client, engine):
    media_files(app_env, "original.png", "original.wav")
    board = create_board(client, [{"id": "s1", "prompt": " original prompt ", "reuse": 1,
                                  "frames": 56, "steps": 12, "seed": 123, "token_reduction": True,
                                  "ref_images": ["original.png"], "ref_audio": ["original.wav"],
                                  "checkpoint_after_step": 3}])
    original_id = client.post(generate_url(board)).json()["job_id"]
    wait_for_status(client, original_id, {"done"})
    original = app_env.jobs[original_id]["request"].model_dump()
    edited = client.get(f"/api/boards/{board['id']}").json()
    edited["shots"][0].update(prompt="UI CHANGED", seed=999, ref_images=["missing-new.png"],
                               ref_audio=[], frames=90, reuse=2)
    assert client.post("/api/boards", json=edited).status_code == 200
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        response = fresh.post(f"/api/jobs/{original_id}/resume")
        assert response.status_code == 200, response.text
        resumed_id = response.json()["job_id"]
        wait_for_status(fresh, resumed_id, {"done"})
        actual = restarted.jobs[resumed_id]["request"].model_dump()
        assert actual == {**original, "checkpoint_after_step": None,
                          "resume": restarted.jobs[original_id]["checkpoint"]}
        result = fresh.get(f"/api/boards/{board['id']}").json()
    assert result["shots"][0]["prompt"] == "UI CHANGED"
    assert result["shots"][0]["job_id"] == resumed_id
    cmd = engine.commands[-1]
    assert "--resume" in cmd and "--checkpoint-after-step" not in cmd and "--checkpoint" not in cmd
    assert cmd[cmd.index("-p") + 1] == original["prompt"]
    assert [Path(cmd[i + 1]).name for i, arg in enumerate(cmd) if arg == "--ref-audio"] == ["original.wav"]


@pytest.mark.parametrize("damage,expected", [("missing_checkpoint", 404), ("corrupt", 400),
                                           ("truncated", 400), ("wrong_shape", 400),
                                           ("missing_target", 404), ("replaced_target", 409),
                                           ("missing_original_ids", 400)])
def test_resume_rejects_invalid_checkpoint_or_original_target(app_env, client, engine, damage, expected):
    board = create_board(client, [{"id": "s1", "prompt": "original", "reuse": 1, "checkpoint_after_step": 3}])
    job_id = client.post(generate_url(board)).json()["job_id"]
    wait_for_status(client, job_id, {"done"})
    original = app_env.jobs[job_id]
    checkpoint = app_env.OUTPUTS / original["checkpoint"]
    if damage == "missing_checkpoint":
        checkpoint.unlink()
    elif damage == "corrupt":
        checkpoint.write_bytes(b"not an H3 checkpoint")
    elif damage == "truncated":
        checkpoint.write_bytes(checkpoint.read_bytes()[:-1])
    elif damage == "wrong_shape":
        content = bytearray(checkpoint.read_bytes())
        struct.pack_into("<I", content, 40, 256)
        checkpoint.write_bytes(content)
    elif damage == "missing_original_ids":
        original["request"].board_id = original["request"].shot_id = None
    else:
        assert client.delete(f"/api/boards/{board['id']}").status_code == 200
        if damage == "replaced_target":
            replacement = {**board, "shots": [{"id": "s1", "prompt": "replacement", "job_id": job_id}]}
            assert client.post("/api/boards", json=replacement).status_code == 200
    response = client.post(f"/api/jobs/{job_id}/resume")
    assert response.status_code == expected, response.text
    assert len(engine.commands) == 1 and len(app_env.jobs) == 1 and not app_env.queue


@pytest.fixture
def paused_worker(app_env, monkeypatch):
    original = app_env.run_job
    entered, release = threading.Event(), threading.Event()
    calls = []

    def delayed(job_id):
        calls.append(job_id)
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
        original(job_id)

    monkeypatch.setattr(app_env, "run_job", delayed)
    yield SimpleNamespace(entered=entered, release=release, calls=calls)
    release.set()
    deadline = time.monotonic() + 5
    while app_env.active_job_id is not None and time.monotonic() < deadline:
        time.sleep(0.01)


@pytest.mark.parametrize("failure", ["popen", "file", "extract"])
def test_preparation_failures_terminalize_shot_board_and_advance_queue(
        app_env, client, engine, paused_worker, monkeypatch, failure):
    media_files(app_env, "anchor.png")
    shots = [{"id": "s1", "prompt": "fails", "first_frame": "anchor.png"}]
    if failure == "extract":
        (app_env.OUTPUTS / "prev.mp4").write_bytes(b"clip")
        shots = [{"id": "prev", "prompt": "previous", "output": "prev.mp4"},
                 {"id": "s1", "prompt": "fails"}]
    board = create_board(client, shots)
    first = client.post(generate_url(board)).json()["job_id"]
    assert paused_worker.entered.wait(2)
    second = client.post("/api/generate", json={"prompt": "queue continues"}).json()["job_id"]
    assert client.get(f"/api/jobs/{second}").json()["status"] == "queued"
    if failure == "file":
        (app_env.UPLOADS / "anchor.png").unlink()
    elif failure == "extract":
        def fail_extract(*args, **kwargs):
            raise FileNotFoundError("ffmpeg unavailable")
        monkeypatch.setattr(app_env.subprocess, "run", fail_extract)
    else:
        original_popen = app_env.subprocess.Popen

        def fail_once(cmd, **kwargs):
            if cmd[cmd.index("-p") + 1] == "fails":
                raise OSError("engine launch failed")
            return original_popen(cmd, **kwargs)
        monkeypatch.setattr(app_env.subprocess, "Popen", fail_once)
    paused_worker.release.set()
    final = wait_for_status(client, first, {"error"})
    assert "backend error" in " ".join(final["log"])
    wait_for_status(client, second, {"done"})
    result = wait_board(client, board, "error")
    assert result["shots"][-1]["status"] == "error" and app_env.active_job_id is None


def test_queue_reserves_before_worker_start_and_cancel_does_not_release_early(
        app_env, client, engine, paused_worker):
    first = client.post("/api/generate", json={"prompt": "reserved"}).json()["job_id"]
    assert paused_worker.entered.wait(2)
    with ThreadPoolExecutor(max_workers=8) as pool:
        submitted = list(pool.map(lambda n: app_env.generate(app_env.GenRequest(prompt=f"job {n}")), range(12)))
    assert paused_worker.calls == [first]
    assert len(app_env.queue) == 12 and not engine.commands
    second = submitted[0]["job_id"]
    assert client.delete(f"/api/jobs/{second}").status_code == 200
    assert client.delete(f"/api/jobs/{first}").status_code == 200
    app_env.launch_next()
    assert app_env.active_job_id == first and paused_worker.calls == [first]
    paused_worker.release.set()
    for result in submitted[1:]:
        wait_for_status(client, result["job_id"], {"done"})
    assert client.get(f"/api/jobs/{first}").json()["status"] == "cancelled"
    assert client.get(f"/api/jobs/{second}").json()["status"] == "cancelled"
    assert len(engine.commands) == 11


def test_active_and_stale_autosave_are_rejected_and_runtime_is_server_owned(
        app_env, client, engine, paused_worker):
    board = create_board(client, [{"id": "s1", "prompt": "p"}])
    job_id = client.post(generate_url(board)).json()["job_id"]
    assert paused_worker.entered.wait(2)
    for url in (generate_url(board), f"/api/boards/{board['id']}/run", f"/api/boards/{board['id']}/concat"):
        assert client.post(url).status_code == 409
    assert client.post("/api/boards", json=board).status_code == 409
    assert client.delete(f"/api/boards/{board['id']}").status_code == 409
    paused_worker.release.set()
    wait_for_status(client, job_id, {"done"})
    assert client.post("/api/boards", json=board).status_code == 409
    latest = client.get(f"/api/boards/{board['id']}").json()
    expected_output = latest["shots"][0]["output"]
    latest["shots"][0].update(status="idle", output="wrong.mp4", job_id="wrong")
    latest["status"] = "idle"
    saved = client.post("/api/boards", json=latest)
    assert saved.status_code == 200
    shot = saved.json()["shots"][0]
    assert shot["status"] == "done" and shot["job_id"] == job_id and shot["output"] == expected_output


@pytest.mark.parametrize("damage", ["newer_job", "replaced_shot", "deleted_shot", "deleted_board"])
def test_writeback_never_targets_replaced_or_deleted_shot(app_env, client, engine, paused_worker, damage):
    board = create_board(client, [{"id": "s1", "prompt": "original"}])
    job_id = client.post(generate_url(board)).json()["job_id"]
    assert paused_worker.entered.wait(2)
    # Simulate an out-of-band mutation; public APIs conservatively return 409.
    current = app_env.boards[board["id"]]
    if damage == "newer_job":
        current["shots"][0]["job_id"] = "newer"
    elif damage == "replaced_shot":
        current["shots"][0]["_instance_id"] = "different incarnation"
    elif damage == "deleted_shot":
        current["shots"] = []
    else:
        del app_env.boards[board["id"]]
    before = json.loads(json.dumps(app_env.boards))
    paused_worker.release.set()
    wait_for_status(client, job_id, {"error"})
    assert app_env.boards == before and not engine.commands


@pytest.mark.parametrize("status", ["cancelled", "interrupted"])
def test_batch_stops_on_cancelled_or_interrupted_job(app_env, client, engine, paused_worker, status):
    board = create_board(client, [{"id": "s1", "prompt": "first"}, {"id": "s2", "prompt": "second"}])
    assert client.post(f"/api/boards/{board['id']}/run").status_code == 200
    assert paused_worker.entered.wait(2)
    job_id = paused_worker.calls[0]
    if status == "cancelled":
        client.delete(f"/api/jobs/{job_id}")
    else:
        with app_env.lock:
            app_env.jobs[job_id]["status"] = "interrupted"
            app_env.writeback_job(app_env.jobs[job_id])
    paused_worker.release.set()
    result = wait_board(client, board, "error")
    assert result["shots"][0]["status"] == status
    assert result["shots"][1]["job_id"] is None and not engine.commands


@pytest.mark.parametrize("anchors", [{"first_frame": "first.png"}, {"last_frame": "last.png"},
                                    {"first_frame": "first.png", "last_frame": "last.png"}])
def test_explicit_anchor_flags_are_preserved(app_env, client, engine, anchors):
    media_files(app_env, "first.png", "last.png")
    (app_env.OUTPUTS / "prev.mp4").write_bytes(b"clip")
    board = create_board(client, [{"id": "prev", "prompt": "previous", "output": "prev.mp4"},
                                  {"id": "s1", "prompt": "anchored", **anchors}])
    response = client.post(generate_url(board))
    assert response.status_code == 200
    wait_for_status(client, response.json()["job_id"], {"done"})
    cmd = engine.commands[0]
    for field, name in anchors.items():
        assert Path(cmd[cmd.index("--" + field.replace("_", "-")) + 1]).name == name
    assert len(engine.extracts) == (0 if "first_frame" in anchors else 1)


def test_batch_extract_failure_is_terminal_and_other_jobs_continue(app_env, client, engine, monkeypatch):
    def fail_extract(*args, **kwargs):
        raise app_env.subprocess.TimeoutExpired("ffmpeg", 30)

    monkeypatch.setattr(app_env.subprocess, "run", fail_extract)
    board = create_board(client, [{"id": "s1", "prompt": "first"},
                                  {"id": "s2", "prompt": "fails extraction"},
                                  {"id": "s3", "prompt": "never queued"}])
    assert client.post(f"/api/boards/{board['id']}/run").status_code == 200
    result = wait_board(client, board, "error")
    assert [s["status"] for s in result["shots"]] == ["done", "error", "idle"]
    failed = client.get(f"/api/jobs/{result['shots'][1]['job_id']}").json()
    assert failed["status"] == "error" and failed["finished"]
    unrelated = client.post("/api/generate", json={"prompt": "queue still works"}).json()["job_id"]
    wait_for_status(client, unrelated, {"done"})
    assert len(engine.commands) == 2


def test_board_worker_guards_request_preparation_exceptions(app_env, client, engine, monkeypatch):
    original = app_env.shot_request

    def fail_in_worker(board, shot):
        if board.get("_run_id"):
            raise RuntimeError("request preparation failed")
        return original(board, shot)

    monkeypatch.setattr(app_env, "shot_request", fail_in_worker)
    board = create_board(client, [{"id": "s1", "prompt": "p"}])
    assert client.post(f"/api/boards/{board['id']}/run").status_code == 200
    result = wait_board(client, board, "error")
    assert result["shots"][0]["status"] == "error" and "preparation failed" in result["error"]
    assert not app_env.jobs and not app_env.queue


def test_resume_without_persisted_target_fails_instead_of_inferencing_one(app_env, client, engine):
    job_id = client.post("/api/generate", json={
        "prompt": "legacy standalone", "reuse": 1, "checkpoint_after_step": 3}).json()["job_id"]
    wait_for_status(client, job_id, {"done"})
    response = client.post(f"/api/jobs/{job_id}/resume")
    assert response.status_code == 400 and "target" in response.json()["detail"]
    assert len(engine.commands) == 1


def test_real_ffprobe_audio_duration_without_engine(app_env):
    import shutil
    import wave

    if shutil.which("ffprobe") is None:
        pytest.skip("ffprobe is not installed")
    path = app_env.UPLOADS / "two-seconds.wav"
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(32000)
        stream.writeframes(bytes(32000 * 2 * 2 * 2))
    assert app_env.audio_duration(path) == pytest.approx(2, abs=1 / 32000)


def test_cancel_running_process_keeps_terminal_status_and_advances(app_env, client, engine, monkeypatch):
    started, terminated = threading.Event(), threading.Event()
    original = app_env.subprocess.Popen

    class BlockingProc:
        stdout = None

        def __init__(self):
            self.stdout = self
            started.set()

        def read(self, count):
            assert terminated.wait(5)
            return ""

        def poll(self):
            return -15 if terminated.is_set() else None

        def wait(self, timeout=None):
            assert terminated.wait(timeout or 5)
            return -15

        def terminate(self):
            terminated.set()

    def popen(cmd, **kwargs):
        return BlockingProc() if cmd[cmd.index("-p") + 1] == "blocking" else original(cmd, **kwargs)

    monkeypatch.setattr(app_env.subprocess, "Popen", popen)
    first = client.post("/api/generate", json={"prompt": "blocking"}).json()["job_id"]
    try:
        assert started.wait(2)
        second = client.post("/api/generate", json={"prompt": "next"}).json()["job_id"]
        assert client.delete(f"/api/jobs/{first}").status_code == 200
        wait_for_status(client, second, {"done"})
        job = client.get(f"/api/jobs/{first}").json()
        assert job["status"] == "cancelled" and job["finished"]
    finally:
        terminated.set()