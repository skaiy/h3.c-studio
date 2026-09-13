#!/usr/bin/env python3
"""H3 Studio backend — wraps the h3-metal CLI with a job queue and progress API."""
import json
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent          # studio/
# Engine directory: repo root by default (fork layout), overridable via env.
H3_DIR = Path(os.environ.get("H3_ENGINE_DIR", ROOT.parent))
H3_BIN = H3_DIR / "h3"
MODEL_DIR = Path(os.environ.get("H3_MODEL_DIR", H3_DIR / "MiniMax-H3"))
OUTPUTS = Path(os.environ.get("H3_OUTPUTS_DIR", H3_DIR / "outputs"))
UPLOADS = ROOT / "uploads"
UPLOADS.mkdir(exist_ok=True)

app = FastAPI(title="H3 Studio")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------- jobs

PROGRESS_RE = re.compile(r"(denoise(?: enqueue)?|video VAE load|FFmpeg|Qwen|video VAE|audio VAE|H3 DiT|load)\s+(\d+)\s*/\s*(\d+)")
PHASE_RE = re.compile(r"h3 profile: (\S+(?: \S+)?)\s")

jobs: dict[str, dict] = {}
queue: list[str] = []
lock = threading.Lock()


class GenRequest(BaseModel):
    prompt: str
    width: int = 512
    height: int = 512
    seconds: float | None = 6
    frames: int | None = None
    steps: int = 20
    layers: int = 45
    reuse: int = 2
    seed: int = 42
    first_frame: str | None = None     # filename inside uploads/ or outputs/
    last_frame: str | None = None
    ref_images: list[str] = []
    token_reduction: bool = False
    label: str | None = None


def resolve_file(name: str) -> Path:
    for base in (UPLOADS, OUTPUTS):
        p = base / name
        if p.exists():
            return p
    raise HTTPException(404, f"file not found: {name}")


def run_job(job_id: str):
    job = jobs[job_id]
    req: GenRequest = job["request"]
    out_name = f"studio-{job_id[:8]}.mp4"
    cmd = [str(H3_BIN), "--profile", "-d", str(MODEL_DIR), "-p", req.prompt,
           "--width", str(req.width), "--height", str(req.height),
           "--steps", str(req.steps), "--layers", str(req.layers),
           "--reuse", str(req.reuse), "--seed", str(req.seed),
           "-o", str(OUTPUTS / out_name)]
    if req.frames:
        cmd += ["--frames", str(req.frames)]
    elif req.seconds:
        cmd += ["--seconds", str(req.seconds)]
    if req.first_frame:
        cmd += ["--first-frame", str(resolve_file(req.first_frame))]
    if req.last_frame:
        cmd += ["--last-frame", str(resolve_file(req.last_frame))]
    for r in req.ref_images:
        cmd += ["--ref-image", str(resolve_file(r))]
    if req.token_reduction:
        cmd.append("--token-reduction")

    job.update(status="running", started=time.time(), cmd=cmd)
    proc = subprocess.Popen(cmd, cwd=H3_DIR, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    job["proc"] = proc
    buf = ""
    try:
        while True:
            ch = proc.stdout.read(1)
            if ch == "" and proc.poll() is not None:
                break
            buf += ch
            if ch in "\r\n":
                line = buf.strip()
                buf = ""
                if line:
                    job["log"].append(line)
                    m = PROGRESS_RE.search(line)
                    if m:
                        job["phase"], job["done"], job["total"] = m.group(1), int(m.group(2)), int(m.group(3))
                    if "h3: wrote" in line:
                        job["output"] = line.split("h3: wrote")[-1].strip()
        rc = proc.wait()
        job["status"] = "done" if rc == 0 and job.get("output") else "error"
    except Exception as e:                                     # noqa: BLE001
        job["status"] = "error"
        job["log"].append(f"backend error: {e}")
    job["finished"] = time.time()
    job.pop("proc", None)
    launch_next()


def launch_next():
    with lock:
        running = any(j.get("status") == "running" for j in jobs.values())
        if running or not queue:
            return
        nxt = queue.pop(0)
    threading.Thread(target=run_job, args=(nxt,), daemon=True).start()


# ---------------------------------------------------------------- routes

@app.get("/api/info")
def info():
    out = subprocess.run([str(H3_BIN), "--info", "-d", str(MODEL_DIR)],
                         capture_output=True, text=True, timeout=120)
    return {"info": out.stdout + out.stderr}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    name = f"{int(time.time())}-{Path(file.filename).name}"
    (UPLOADS / name).write_bytes(await file.read())
    return {"name": name}


@app.get("/api/uploads")
def list_uploads():
    return sorted((p.name for p in UPLOADS.iterdir() if p.suffix.lower() in
                   (".png", ".jpg", ".jpeg", ".webp")), reverse=True)


@app.post("/api/generate")
def generate(req: GenRequest):
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")
    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = {"id": job_id, "request": req, "status": "queued",
                    "created": time.time(), "log": [], "phase": None,
                    "done": 0, "total": 0, "label": req.label or req.prompt[:40]}
    queue.append(job_id)
    launch_next()
    return {"job_id": job_id}


@app.get("/api/jobs")
def list_jobs():
    return [public_job(j) for j in sorted(jobs.values(), key=lambda j: j["created"], reverse=True)]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404)
    return {**public_job(jobs[job_id]), "log": jobs[job_id]["log"][-80:]}


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404)
    proc = job.get("proc")
    if proc and proc.poll() is None:
        proc.terminate()
    if job["status"] == "queued" and job_id in queue:
        queue.remove(job_id)
    job["status"] = "cancelled"
    return {"ok": True}


def public_job(j: dict) -> dict:
    req: GenRequest = j["request"]
    return {"id": j["id"], "label": j["label"], "status": j["status"],
            "phase": j.get("phase"), "done": j.get("done"), "total": j.get("total"),
            "created": j["created"], "started": j.get("started"),
            "finished": j.get("finished"), "output": j.get("output"),
            "params": req.model_dump(exclude={"prompt"})}


@app.post("/api/extract-last-frame/{name}")
def extract_last_frame(name: str):
    src = OUTPUTS / name
    if not src.exists():
        raise HTTPException(404)
    out = UPLOADS / f"last-{int(time.time())}-{Path(name).stem}.png"
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-sseof", "-0.05",
                        "-i", str(src), "-vframes", "1", str(out)],
                       capture_output=True, text=True)
    if r.returncode != 0 or not out.exists():
        raise HTTPException(500, r.stderr[-300:])
    return {"name": out.name}


@app.get("/api/videos")
def videos():
    items = []
    for p in sorted(OUTPUTS.glob("*.mp4"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            probe = subprocess.run(["ffprobe", "-v", "error", "--show_entries",
                                    "format=duration", "-of", "json", str(p)],
                                   capture_output=True, text=True, timeout=10)
            dur = float(json.loads(probe.stdout)["format"]["duration"])
        except Exception:                                       # noqa: BLE001
            dur = None
        items.append({"name": p.name, "size": p.stat().st_size,
                      "mtime": p.stat().st_mtime, "duration": dur})
    return items


app.mount("/outputs", StaticFiles(directory=OUTPUTS), name="outputs")
app.mount("/uploads", StaticFiles(directory=UPLOADS), name="uploads")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
