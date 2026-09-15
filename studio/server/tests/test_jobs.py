"""Job lifecycle: generate -> running -> done/error, cancel, queueing."""
from .conftest import make_fake_popen, wait_for_status


def test_generate_rejects_empty_prompt(client):
    r = client.post("/api/generate", json={"prompt": "   "})
    assert r.status_code == 400


def test_generate_returns_job_id(app_env, client, monkeypatch):
    monkeypatch.setattr(
        app_env.subprocess, "Popen",
        make_fake_popen(["h3: wrote /tmp/out.mp4"], returncode=0),
    )
    r = client.post("/api/generate", json={"prompt": "a red fox in snow"})
    assert r.status_code == 200
    job_id = r.json()["job_id"]
    assert job_id

    final = wait_for_status(client, job_id, {"done", "error"})
    assert final["status"] == "done"
    assert final["output"] == "/tmp/out.mp4"


def test_generate_marks_error_on_nonzero_exit(app_env, client, monkeypatch):
    monkeypatch.setattr(
        app_env.subprocess, "Popen",
        make_fake_popen(["some failure"], returncode=1),
    )
    r = client.post("/api/generate", json={"prompt": "a broken run"})
    job_id = r.json()["job_id"]
    final = wait_for_status(client, job_id, {"done", "error"})
    assert final["status"] == "error"


def test_generate_reports_progress_fields(app_env, client, monkeypatch):
    monkeypatch.setattr(
        app_env.subprocess, "Popen",
        make_fake_popen(
            ["h3 profile: denoise", "denoise 3/10", "h3: wrote /tmp/p.mp4"],
            returncode=0,
        ),
    )
    r = client.post("/api/generate", json={"prompt": "progress test"})
    job_id = r.json()["job_id"]
    final = wait_for_status(client, job_id, {"done", "error"})
    assert final["status"] == "done"
    # PROGRESS_RE should have captured the last "denoise 3/10" line at some point;
    # by completion done/total reflect the last match seen.
    assert final["done"] == 3
    assert final["total"] == 10


def test_get_job_includes_log_tail(app_env, client, monkeypatch):
    monkeypatch.setattr(
        app_env.subprocess, "Popen",
        make_fake_popen(["line one", "line two", "h3: wrote /tmp/x.mp4"], returncode=0),
    )
    job_id = client.post("/api/generate", json={"prompt": "log test"}).json()["job_id"]
    wait_for_status(client, job_id, {"done", "error"})
    detail = client.get(f"/api/jobs/{job_id}").json()
    assert "line one" in detail["log"]
    assert "line two" in detail["log"]


def test_get_missing_job_404(client):
    assert client.get("/api/jobs/does-not-exist").status_code == 404


def test_cancel_missing_job_404(client):
    assert client.delete("/api/jobs/does-not-exist").status_code == 404


def test_cancel_queued_job_removes_from_queue(app_env, client, monkeypatch):
    # Block the first job forever (never reaches EOF) so the second stays queued.
    import io

    class Never:
        def __init__(self):
            self.stdout = io.StringIO("")
        def poll(self):
            return None
        def wait(self):
            return 0
        def terminate(self):
            pass

    monkeypatch.setattr(app_env.subprocess, "Popen", lambda *a, **k: Never())

    first = client.post("/api/generate", json={"prompt": "first, never finishes"}).json()["job_id"]
    second = client.post("/api/generate", json={"prompt": "second, stays queued"}).json()["job_id"]

    assert client.get(f"/api/jobs/{second}").json()["status"] == "queued"
    r = client.delete(f"/api/jobs/{second}")
    assert r.status_code == 200
    assert client.get(f"/api/jobs/{second}").json()["status"] == "cancelled"

    # Clean up the still-"running" first job so the test process doesn't leak
    # a thread stuck reading from an infinite stdout.
    client.delete(f"/api/jobs/{first}")


def test_generate_includes_ref_audio_flag(app_env, client, monkeypatch):
    """--ref-audio (inspired by Henninges/h3-studio's audio-conditioning
    workflow) should be appended once per ordered ref_audio entry, resolved
    against the uploads dir just like --ref-image already is."""
    (app_env.UPLOADS / "song.mp3").write_bytes(b"fake-audio")
    (app_env.UPLOADS / "singer.png").write_bytes(b"fake-image")
    monkeypatch.setattr(app_env, "audio_duration", lambda path: 3.0)
    captured = []
    monkeypatch.setattr(
        app_env.subprocess, "Popen",
        make_fake_popen(["h3: wrote /tmp/audio-out.mp4"], returncode=0, capture=captured),
    )
    r = client.post("/api/generate", json={
        "prompt": "a singer performing on stage",
        "ref_images": ["singer.png"],
        "ref_audio": ["song.mp3"],
    })
    job_id = r.json()["job_id"]
    wait_for_status(client, job_id, {"done", "error"})

    assert len(captured) == 1
    cmd = captured[0]
    assert "--ref-audio" in cmd
    idx = cmd.index("--ref-audio")
    assert cmd[idx + 1].endswith("song.mp3")


def test_list_jobs_sorted_newest_first(app_env, client, monkeypatch):
    monkeypatch.setattr(
        app_env.subprocess, "Popen",
        make_fake_popen(["h3: wrote /tmp/a.mp4"], returncode=0),
    )
    first = client.post("/api/generate", json={"prompt": "first"}).json()["job_id"]
    wait_for_status(client, first, {"done", "error"})
    second = client.post("/api/generate", json={"prompt": "second"}).json()["job_id"]
    wait_for_status(client, second, {"done", "error"})

    ids = [j["id"] for j in client.get("/api/jobs").json()]
    assert ids.index(second) < ids.index(first)
