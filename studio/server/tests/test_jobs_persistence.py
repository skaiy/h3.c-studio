"""jobs.json persistence: survive a simulated backend restart."""
from fastapi.testclient import TestClient

from .conftest import make_fake_popen, restart_backend, wait_for_status


def test_jobs_file_created_on_generate(app_env, client, monkeypatch):
    monkeypatch.setattr(
        app_env.subprocess, "Popen",
        make_fake_popen(["h3: wrote /tmp/out.mp4"], returncode=0),
    )
    job_id = client.post("/api/generate", json={"prompt": "persist me"}).json()["job_id"]
    wait_for_status(client, job_id, {"done", "error"})
    assert app_env.JOBS_FILE.exists()


def test_finished_job_survives_restart(app_env, client, monkeypatch):
    monkeypatch.setattr(
        app_env.subprocess, "Popen",
        make_fake_popen(["h3: wrote /tmp/out.mp4"], returncode=0),
    )
    job_id = client.post("/api/generate", json={"prompt": "survive restart"}).json()["job_id"]
    wait_for_status(client, job_id, {"done", "error"})

    restarted = restart_backend()
    assert job_id in restarted.jobs
    assert restarted.jobs[job_id]["status"] == "done"
    assert restarted.jobs[job_id]["output"] == "/tmp/out.mp4"

    # And the restarted app's API surface reflects it too.
    with TestClient(restarted.app) as new_client:
        detail = new_client.get(f"/api/jobs/{job_id}").json()
        assert detail["status"] == "done"


def test_running_job_becomes_interrupted_after_restart(app_env, client, monkeypatch):
    # A process that never reaches EOF, so the job is still "running" when we
    # simulate the restart (as if the backend process had been killed).
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
    job_id = client.post("/api/generate", json={"prompt": "stuck running"}).json()["job_id"]

    # Give run_job's background thread a moment to flip status to "running"
    # and persist it, without waiting for completion (which never happens).
    import time as _time
    deadline = _time.time() + 2.0
    while _time.time() < deadline:
        if client.get(f"/api/jobs/{job_id}").json()["status"] == "running":
            break
        _time.sleep(0.02)
    assert client.get(f"/api/jobs/{job_id}").json()["status"] == "running"

    restarted = restart_backend()
    assert restarted.jobs[job_id]["status"] == "interrupted"


def test_queued_job_becomes_interrupted_after_restart(app_env, client, monkeypatch):
    # Block the first job forever so the second job stays "queued".
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
    client.post("/api/generate", json={"prompt": "first, blocks forever"})
    second_id = client.post("/api/generate", json={"prompt": "second, stays queued"}).json()["job_id"]
    assert client.get(f"/api/jobs/{second_id}").json()["status"] == "queued"

    restarted = restart_backend()
    assert restarted.jobs[second_id]["status"] == "interrupted"


def test_log_is_truncated_on_persist(app_env, client, monkeypatch):
    many_lines = [f"line {i}" for i in range(app_env.JOB_LOG_PERSIST_LIMIT + 50)]
    many_lines.append("h3: wrote /tmp/big.mp4")
    monkeypatch.setattr(app_env.subprocess, "Popen", make_fake_popen(many_lines, returncode=0))
    job_id = client.post("/api/generate", json={"prompt": "chatty job"}).json()["job_id"]
    wait_for_status(client, job_id, {"done", "error"})

    restarted = restart_backend()
    assert len(restarted.jobs[job_id]["log"]) <= restarted.JOB_LOG_PERSIST_LIMIT


def test_corrupt_jobs_file_does_not_crash_startup(app_env, monkeypatch):
    app_env.JOBS_FILE.write_text("{not valid json")
    restarted = restart_backend()
    assert restarted.jobs == {}
