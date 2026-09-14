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
OUTPUTS.mkdir(exist_ok=True)  # fresh clones have no outputs dir yet

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
    turbo: bool = False              # use the folded Turbo-LoRA checkpoint (6-step distilled)
    checkpoint_after_step: int | None = None   # pause after N steps, save ckpt + sigma-zero draft
    resume: str | None = None        # checkpoint filename inside outputs/ to continue from
    board_id: str | None = None      # when set, write status/output back to this board shot
    shot_id: str | None = None
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
    model_dir = H3_DIR / "MiniMax-H3-turbo" if req.turbo and (H3_DIR / "MiniMax-H3-turbo").exists() else MODEL_DIR
    cmd = [str(H3_BIN), "--profile", "-d", str(model_dir), "-p", req.prompt,
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
    if req.checkpoint_after_step:
        ckpt = f"studio-{job_id[:8]}.h3ckpt"
        cmd += ["--checkpoint-after-step", str(req.checkpoint_after_step),
                "--checkpoint", str(OUTPUTS / ckpt)]
        job["checkpoint"] = ckpt
    if req.resume:
        cmd += ["--resume", str(resolve_file(req.resume))]

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
    if req.board_id and req.shot_id and req.board_id in boards:
        b = boards[req.board_id]
        for s in b["shots"]:
            if s["id"] == req.shot_id:
                s["status"] = job["status"]
                if job["status"] == "done" and job.get("output"):
                    s["output"] = Path(job["output"]).name
                break
        b["modifiedAt"] = time.time()
        save_boards()
    launch_next()


def launch_next():
    with lock:
        running = any(j.get("status") == "running" for j in jobs.values())
        if running or not queue:
            return
        nxt = queue.pop(0)
    threading.Thread(target=run_job, args=(nxt,), daemon=True).start()


# ---------------------------------------------------------------- routes

# ---------------------------------------------------------------- storyboards

BOARDS_FILE = ROOT / "storyboards.json"
boards: dict[str, dict] = {}
if BOARDS_FILE.exists():
    try:
        boards = json.loads(BOARDS_FILE.read_text())
        now0 = time.time()
        for b in boards.values():
            b.setdefault("createdAt", now0)
            b.setdefault("modifiedAt", b.get("createdAt", now0))
    except Exception:                                            # noqa: BLE001
        boards = {}


def save_boards():
    BOARDS_FILE.write_text(json.dumps(boards, ensure_ascii=False, indent=1))


class Shot(BaseModel):
    id: str
    prompt: str
    width: int = 512
    height: int = 512
    seconds: float = 6
    steps: int = 20
    layers: int = 45
    reuse: int = 2
    seed: int = 42
    turbo: bool = False
    first_frame: str | None = None
    last_frame: str | None = None
    status: str = "idle"          # idle / queued / running / done / error / skipped
    output: str | None = None
    job_id: str | None = None


class Board(BaseModel):
    id: str
    name: str = "未命名分镜"
    chain: bool = True            # auto last-frame -> next first-frame
    shots: list[Shot] = []
    status: str = "idle"          # idle / running / done / error
    result: str | None = None     # concatenated output name
    createdAt: float = 0.0
    modifiedAt: float = 0.0


def extract_last_frame_of(video_name: str) -> str:
    src = OUTPUTS / video_name
    out = UPLOADS / f"chain-{int(time.time())}-{Path(video_name).stem}.png"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-sseof", "-0.05",
                    "-i", str(src), "-vframes", "1", str(out)],
                   capture_output=True, check=True)
    return out.name


def board_run_worker(board_id: str):
    board = boards[board_id]
    prev_output = None
    for idx, shot in enumerate(board["shots"]):
        if not shot["prompt"].strip():
            shot["status"] = "skipped"
            save_boards()
            continue
        if board["chain"] and prev_output:
            shot["first_frame"] = extract_last_frame_of(prev_output)
        req = GenRequest(prompt=shot["prompt"], width=shot["width"], height=shot["height"],
                         seconds=shot["seconds"], steps=shot["steps"], layers=shot["layers"],
                         reuse=shot["reuse"], seed=shot["seed"], turbo=shot.get("turbo", False),
                         first_frame=shot.get("first_frame"), last_frame=shot.get("last_frame"),
                         label=f"[{board['name']}] 镜头 {idx + 1}")
        job_id = uuid.uuid4().hex[:12]
        jobs[job_id] = {"id": job_id, "request": req, "status": "queued",
                        "created": time.time(), "log": [], "phase": None,
                        "done": 0, "total": 0, "label": req.label}
        shot.update(status="queued", job_id=job_id)
        save_boards()
        queue.append(job_id)
        launch_next()
        # wait for this shot to finish before chaining the next
        while True:
            time.sleep(3)
            st = jobs[job_id]["status"]
            shot["status"] = "running" if st == "running" else st
            if st in ("done", "error", "cancelled"):
                break
        if jobs[job_id]["status"] != "done":
            shot["status"] = jobs[job_id]["status"]
            board["status"] = "error"
            save_boards()
            return
        prev_output = jobs[job_id].get("output")
        prev_output = Path(prev_output).name if prev_output else None
        shot.update(status="done", output=prev_output)
        save_boards()
    board["status"] = "done"
    save_boards()


@app.get("/api/boards")
def list_boards():
    out = []
    for b in sorted(boards.values(), key=lambda x: x.get("modifiedAt", 0), reverse=True):
        out.append({"id": b["id"], "name": b["name"], "status": b["status"],
                    "result": b.get("result"), "shotCount": len(b["shots"]),
                    "doneCount": sum(1 for s in b["shots"] if s["status"] == "done"),
                    "duration": round(sum(s.get("seconds", 0) for s in b["shots"]), 1),
                    "createdAt": b.get("createdAt", 0), "modifiedAt": b.get("modifiedAt", 0)})
    return out


@app.get("/api/boards/{board_id}")
def get_board(board_id: str):
    if board_id not in boards:
        raise HTTPException(404)
    return boards[board_id]


@app.post("/api/boards")
def upsert_board(board: Board):
    now = time.time()
    if not board.id:
        board.id = uuid.uuid4().hex[:8]
        board.createdAt = now
        if not board.shots:
            board.shots = [Shot(id="s" + uuid.uuid4().hex[:6], prompt="")]
    board.modifiedAt = now
    if board.id in boards and not board.createdAt:
        board.createdAt = boards[board.id].get("createdAt", now)
    boards[board.id] = board.model_dump()
    save_boards()
    return boards[board.id]


@app.post("/api/boards/{board_id}/duplicate")
def duplicate_board(board_id: str):
    src = boards.get(board_id)
    if not src:
        raise HTTPException(404)
    now = time.time()
    copy = json.loads(json.dumps(src))
    copy["id"] = uuid.uuid4().hex[:8]
    copy["name"] = src["name"] + " 副本"
    copy["status"] = "idle"
    copy["result"] = None
    copy["createdAt"] = copy["modifiedAt"] = now
    for s in copy["shots"]:
        s["id"] = "s" + uuid.uuid4().hex[:6]
        s["status"] = "idle"
        s["output"] = None
        s["job_id"] = None
    boards[copy["id"]] = copy
    save_boards()
    return copy


@app.delete("/api/boards/{board_id}")
def delete_board(board_id: str):
    boards.pop(board_id, None)
    save_boards()
    return {"ok": True}


@app.post("/api/boards/{board_id}/run")
def run_board(board_id: str):
    board = boards.get(board_id)
    if not board:
        raise HTTPException(404)
    if board["status"] == "running":
        raise HTTPException(409, "board already running")
    if not board["shots"]:
        raise HTTPException(400, "no shots")
    board["status"] = "running"
    board["result"] = None
    board["modifiedAt"] = time.time()
    for s in board["shots"]:
        if s["status"] != "done":
            s.update(status="idle", output=None)
    save_boards()
    threading.Thread(target=board_run_worker, args=(board_id,), daemon=True).start()
    return {"ok": True}


@app.post("/api/boards/{board_id}/concat")
def concat_board(board_id: str):
    board = boards.get(board_id)
    if not board:
        raise HTTPException(404)
    outputs = [s["output"] for s in board["shots"] if s.get("output")]
    if len(outputs) < 2:
        raise HTTPException(400, "need at least 2 finished shots")
    list_file = UPLOADS / f"concat-{board_id}.txt"
    list_file.write_text("".join(f"file '{OUTPUTS / o}'\n" for o in outputs))
    out_name = f"board-{board_id}-{int(time.time())}.mp4"
    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                        "-i", str(list_file), "-c", "copy", str(OUTPUTS / out_name)],
                       capture_output=True, text=True)
    list_file.unlink(missing_ok=True)
    if r.returncode != 0:
        raise HTTPException(500, r.stderr[-300:])
    board["result"] = out_name
    board["modifiedAt"] = time.time()
    save_boards()
    return {"output": out_name}


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
            "checkpoint": j.get("checkpoint"),
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


@app.delete("/api/videos/{name}")
def delete_video(name: str):
    if "/" in name or ".." in name:
        raise HTTPException(400, "invalid name")
    target = OUTPUTS / name
    if not target.exists() or target.suffix != ".mp4":
        raise HTTPException(404)
    target.unlink()
    return {"ok": True}


app.mount("/outputs", StaticFiles(directory=OUTPUTS), name="outputs")
app.mount("/uploads", StaticFiles(directory=UPLOADS), name="uploads")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
