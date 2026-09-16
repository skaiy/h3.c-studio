#!/usr/bin/env python3
"""H3 Studio backend — wraps the h3-metal CLI with a job queue and progress API."""
import hashlib
import json
import logging
import math
import os
import re
import struct
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from board_storage import BoardStorageError, read_board_object
from reference_assets import (
    ReferenceAsset, ReferenceSet, ReferenceSnapshot,
    asset_missing, import_asset, validate_asset,
)

ROOT = Path(__file__).resolve().parent.parent          # studio/
# Engine directory: repo root by default (fork layout), overridable via env.
H3_DIR = Path(os.environ.get("H3_ENGINE_DIR", ROOT.parent))
H3_BIN = H3_DIR / "h3"
MODEL_DIR = Path(os.environ.get("H3_MODEL_DIR", H3_DIR / "MiniMax-H3"))
OUTPUTS = Path(os.environ.get("H3_OUTPUTS_DIR", H3_DIR / "outputs"))
# UPLOADS/BOARDS_FILE overrides exist mainly so the test suite (studio/server/tests/)
# can point a whole backend instance at an isolated tmp directory.
UPLOADS = Path(os.environ.get("H3_UPLOADS_DIR", ROOT / "uploads"))
UPLOADS.mkdir(parents=True, exist_ok=True)
OUTPUTS.mkdir(parents=True, exist_ok=True)  # fresh clones have no outputs dir yet

app = FastAPI(title="H3 Studio")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------- auth
#
# Optional bearer-token auth, off by default. This is a single-user local
# tool: with no H3_STUDIO_TOKEN set, behavior is unchanged (no auth at all).
# Set H3_STUDIO_TOKEN to require `Authorization: Bearer <token>` on every
# write request (POST/PUT/PATCH/DELETE) — this protects against anything
# else on the same network/host from submitting jobs, deleting clips, or
# editing boards. Read-only GETs (jobs/boards/videos/media) stay open so
# playback and polling don't need the token wired through everywhere.
STUDIO_TOKEN = os.environ.get("H3_STUDIO_TOKEN")


@app.middleware("http")
async def require_token_for_writes(request: Request, call_next):
    if STUDIO_TOKEN and request.method not in ("GET", "HEAD", "OPTIONS"):
        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {STUDIO_TOKEN}":
            return JSONResponse({"detail": "missing or invalid bearer token"}, status_code=401)
    path = request.url.path
    board_read = path == "/api/boards" or path.startswith("/api/boards/")
    api_write = path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS")
    if BOARDS_LOAD_ERROR and request.method != "OPTIONS" and (board_read or api_write):
        return JSONResponse({"detail": BOARD_STORAGE_DETAIL,
                             "code": "board_persistence_unavailable",
                             "reason": BOARDS_LOAD_ERROR}, status_code=503)
    return await call_next(request)


# ---------------------------------------------------------------- jobs

PROGRESS_RE = re.compile(r"(denoise(?: enqueue)?|video VAE load|FFmpeg|Qwen|video VAE|audio VAE|H3 DiT|load)\s+(\d+)\s*/\s*(\d+)")
PHASE_RE = re.compile(r"h3 profile: (\S+(?: \S+)?)\s")

# JOBS_FILE override exists so the test suite (studio/server/tests/) can point
# a whole backend instance at an isolated tmp directory, same as BOARDS_FILE below.
JOBS_FILE = Path(os.environ.get("H3_JOBS_FILE", ROOT / "jobs.json"))
JOB_LOG_PERSIST_LIMIT = 200  # cap persisted log lines per job so jobs.json can't grow unbounded

jobs: dict[str, dict] = {}
queue: list[str] = []
lock = threading.RLock()
# A cancelled subprocess still owns the slot until its worker has reaped it.
active_job_id: str | None = None
ACTIVE = {"queued", "running"}
TERMINAL = {"done", "error", "cancelled", "interrupted"}


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
    ref_images: list[str] = Field(default_factory=list)
    ref_audio: list[str] = Field(default_factory=list)  # ordered --ref-audio clips
    token_reduction: bool = False
    turbo: bool = False              # use the folded Turbo-LoRA checkpoint (6-step distilled)
    checkpoint_after_step: int | None = None   # pause after N steps, save ckpt + sigma-zero draft
    resume: str | None = None        # checkpoint filename inside outputs/ to continue from
    board_id: str | None = None      # when set, write status/output back to this board shot
    shot_id: str | None = None
    label: str | None = None


def save_jobs():
    """Persist `jobs` to JOBS_FILE so history survives a backend restart.

    `request` is a GenRequest model (not natively JSON-serializable) and `proc`
    is a live subprocess.Popen handle (never serializable, already stripped by
    run_job once a job finishes) — both are handled explicitly here. Logs are
    capped to the last JOB_LOG_PERSIST_LIMIT lines to keep the file bounded.
    """
    with lock:
        serializable = {}
        for job_id, job in jobs.items():
            entry = {k: v for k, v in job.items() if k not in ("request", "proc")}
            entry["request"] = job["request"].model_dump()
            entry["log"] = entry.get("log", [])[-JOB_LOG_PERSIST_LIMIT:]
            serializable[job_id] = entry
        atomic_json(JOBS_FILE, serializable)


def atomic_json(path: Path, value: dict):
    if path == BOARDS_FILE:
        require_board_storage()
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=1))
    temporary.replace(path)


def load_jobs():
    """Restore `jobs` from JOBS_FILE at startup.

    Any job still marked "queued" or "running" belonged to a subprocess that
    no longer exists (the previous backend process is gone), so it is
    reclassified as "interrupted" rather than left to look like it's still
    in progress.
    """
    if not JOBS_FILE.exists():
        return {}
    try:
        raw = json.loads(JOBS_FILE.read_text())
    except Exception:                                              # noqa: BLE001
        return {}
    restored = {}
    for job_id, entry in raw.items():
        entry["request"] = GenRequest(**entry["request"])
        if entry.get("status") in ("queued", "running"):
            entry["status"] = "interrupted"
            entry.setdefault("finished", time.time())
        restored[job_id] = entry
    return restored


jobs = load_jobs()


def resolve_file(name: str, *, outputs_only: bool = False) -> Path:
    if not name or name in (".", "..") or any(c in name for c in ("/", "\\", "\0")):
        raise HTTPException(400, "inputs must be local filenames, not paths or URLs")
    for base in ((OUTPUTS,) if outputs_only else (UPLOADS, OUTPUTS)):
        p = (base / name).resolve()
        if p.parent != base.resolve():
            raise HTTPException(400, "input resolves outside its media directory")
        if p.is_file():
            return p
    raise HTTPException(404, f"file not found: {name}")


def requested_frames(req: GenRequest) -> int:
    if req.frames is not None:
        return req.frames
    if req.seconds is None:
        return 56  # CLI default
    if not math.isfinite(req.seconds) or not 0 < req.seconds <= 362 / 24:
        raise HTTPException(400, "seconds must be positive and within 362 frames at 24 fps")
    return math.floor(req.seconds * 24 + 0.5)  # C llround, not Python's ties-to-even


def audio_duration(path: Path) -> float:
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=codec_type,duration:format=duration", "-of", "json", str(path)],
            capture_output=True, text=True, check=True, timeout=10)
        data = json.loads(probe.stdout)
        stream = data["streams"][0]
        value = stream.get("duration")
        if value in (None, "N/A"):
            value = data.get("format", {}).get("duration")
        duration = float(value)
        if stream.get("codec_type") != "audio" or not math.isfinite(duration):
            raise ValueError("missing audio duration")
        return duration
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError, IndexError) as exc:
        raise HTTPException(400, f"cannot probe reference audio: {path.name}") from exc


def validate_checkpoint(name: str, req: GenRequest):
    path = resolve_file(name, outputs_only=True)
    try:
        with path.open("rb") as stream:
            header = stream.read(128)
        if len(header) != 128 or header[:8] != b"H3CKPT1\n":
            raise ValueError("unsupported header")
        size, endian = struct.unpack_from("<II", header, 8)
        seed = struct.unpack_from("<Q", header, 24)[0]
        steps, next_step, width, height, frames = struct.unpack_from("<IIIII", header, 32)
        video, audio = struct.unpack_from("<QQ", header, 56)
        seconds = struct.unpack_from("<d", header, 72)[0]
        aligned = 5 + ((requested_frames(req) - 5 + 16) // 17) * 17
        if (size != 128 or endian != 0x01020304 or not 0 < next_step < steps
                or (seed, steps, width, height, frames) !=
                (req.seed, req.steps, req.width, req.height, aligned)
                or not video or not audio or not math.isfinite(seconds) or seconds < 0
                or path.stat().st_size != 128 + 4 * (video + audio)):
            raise ValueError("incompatible metadata or truncated payload")
    except (OSError, ValueError, struct.error) as exc:
        raise HTTPException(400, f"invalid checkpoint: {name} ({exc})") from exc
    # The engine verifies the full payload checksum and conditioning/model signature.


def preflight(req: GenRequest) -> list[str]:
    """Submission checks only: never attach these constraints to history models."""
    if not req.prompt.strip():
        raise HTTPException(400, "prompt is empty")
    if any(v < 32 or v % 32 for v in (req.width, req.height)) or req.width * req.height > 768 * 1344:
        raise HTTPException(400, "canvas must use multiples of 32 within 768*1344 pixels")
    if not 6 <= requested_frames(req) <= 362:
        raise HTTPException(400, "frames must align to a trained 22..362 frame chunk (requested 6..362)")
    if not 2 <= req.steps <= 1000 or not 35 <= req.layers <= 50 or not 1 <= req.reuse <= 3:
        raise HTTPException(400, "steps must be 2..1000, layers 35..50, reuse 1..3")
    if not 0 <= req.seed < 2**64:
        raise HTTPException(400, "seed must be an unsigned 64-bit integer")
    if req.checkpoint_after_step is not None and not 0 <= req.checkpoint_after_step < req.steps:
        raise HTTPException(400, "checkpoint_after_step must be zero or smaller than steps")
    if (req.checkpoint_after_step or req.resume) and req.reuse != 1:
        raise HTTPException(400, "progressive checkpoints require reuse=1")
    if len(req.ref_images) > 9 or len(req.ref_audio) > 3:
        raise HTTPException(400, "Ref2VA supports at most 9 images and 3 audio inputs")
    if (req.ref_images or req.ref_audio) and (req.first_frame is not None or req.last_frame is not None):
        raise HTTPException(400, "references cannot be combined with explicit frame anchors")
    if req.ref_audio and not req.ref_images:
        raise HTTPException(400, "reference audio requires an image reference")
    for name in [req.first_frame, req.last_frame, *req.ref_images, *req.ref_audio]:
        if name is not None:
            resolve_file(name)
    durations = [audio_duration(resolve_file(name)) for name in req.ref_audio]
    if any(d < 2 or d > 15 for d in durations) or sum(durations) > 15:
        raise HTTPException(400, "reference audio requires 2..15 seconds per clip and at most 15 seconds total")
    if req.resume is not None:
        validate_checkpoint(req.resume, req)
    return (["token_reduction with reference audio is empirically unreliable; consider disabling it"]
            if req.token_reduction and req.ref_audio else [])


def job_command(job: dict) -> list[str]:
    req: GenRequest = job["request"]
    job_id = job["id"]
    out_name = f"studio-{job_id[:8]}.mp4"
    job["output_name"] = out_name
    model_dir = job.get("model_dir") or (H3_DIR / "MiniMax-H3-turbo" if req.turbo and (H3_DIR / "MiniMax-H3-turbo").exists() else MODEL_DIR)
    job["model_dir"] = str(model_dir)
    cmd = [str(H3_BIN), "--profile", "-d", str(model_dir), "-p", req.prompt,
           "--width", str(req.width), "--height", str(req.height),
           "--steps", str(req.steps), "--layers", str(req.layers),
           "--reuse", str(req.reuse), "--seed", str(req.seed),
           "-o", str(OUTPUTS / out_name)]
    if req.frames is not None:
        cmd += ["--frames", str(req.frames)]
    elif req.seconds is not None:
        cmd += ["--seconds", str(req.seconds)]
    if req.first_frame:
        cmd += ["--first-frame", str(resolve_file(req.first_frame))]
    if req.last_frame:
        cmd += ["--last-frame", str(resolve_file(req.last_frame))]
    for r in req.ref_images:
        cmd += ["--ref-image", str(resolve_file(r))]
    for r in req.ref_audio:
        cmd += ["--ref-audio", str(resolve_file(r))]
    if req.token_reduction:
        cmd.append("--token-reduction")
    if req.checkpoint_after_step:
        ckpt = f"studio-{job_id[:8]}.h3ckpt"
        cmd += ["--checkpoint-after-step", str(req.checkpoint_after_step),
                "--checkpoint", str(OUTPUTS / ckpt)]
        job["checkpoint"] = ckpt
    if req.resume:
        cmd += ["--resume", str(resolve_file(req.resume, outputs_only=True))]
    return cmd


def stop_process(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def persist_job_state(job: dict):
    """A disk failure must not prevent cancellation, finalization, or queue advance."""
    for persist in (lambda: writeback_job(job), save_jobs):
        try:
            persist()
        except Exception as exc:                                  # noqa: BLE001
            job["log"].append(f"backend persistence error: {exc}")


def finish_job(job: dict, status: str, error: str | None = None):
    """Caller holds lock. Terminal cancellation/interruption wins over completion."""
    if job["status"] not in ("cancelled", "interrupted"):
        job["status"] = status
    if error:
        job["log"].append(f"backend error: {error}")
    job["finished"] = time.time()
    job.pop("proc", None)
    persist_job_state(job)


def run_job(job_id: str):
    global active_job_id
    with lock:
        job = jobs.get(job_id)
        if job is None:
            if active_job_id == job_id:
                active_job_id = None
            launch_next()
            return
    proc = None
    status, error = "error", None
    try:
        with lock:
            if job["status"] not in ACTIVE:
                return
            assert_job_target(job)
        req = job["request"]
        validate_reference_snapshot(job.get("reference_snapshot"), req)
        preflight(req)  # queued files may have disappeared since submission
        if job.get("chain_source"):
            req = req.model_copy(update={"first_frame": extract_last_frame_of(job["chain_source"])})
            preflight(req)
            job["request"] = req  # persist the actual request, never mutate the shot
        cmd = job_command(job)
        with lock:
            if job["status"] not in ACTIVE or jobs.get(job_id) is not job:
                return
            assert_job_target(job)
            job.update(started=time.time(), cmd=cmd)
            save_jobs()
            proc = subprocess.Popen(cmd, cwd=H3_DIR, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, bufsize=1)
            job["proc"] = proc
        buf = ""
        while True:
            if job["status"] in ("cancelled", "interrupted") or jobs.get(job_id) is not job:
                break
            ch = proc.stdout.read(1)
            if ch == "" and proc.poll() is not None:
                break
            if ch == "":
                time.sleep(0.01)
                continue
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
        if job["status"] not in ("cancelled", "interrupted") and jobs.get(job_id) is job:
            rc = proc.wait()
            status = "done" if rc == 0 and job.get("output") else "error"
            if status == "done" and job.get("target") is not None:
                expected = job.get("output_name")
                if (Path(job["output"]).name != expected
                        or not (OUTPUTS / expected).is_file()):
                    status = "error"
                    error = "engine did not produce the managed output file"
    except Exception as e:                                     # noqa: BLE001
        error = str(e)
    finally:
        if proc is not None:
            try:
                stop_process(proc)
            except Exception as exc:                              # noqa: BLE001
                error = error or f"process cleanup failed: {exc}"
        with lock:
            if jobs.get(job_id) is job:
                finish_job(job, status, error)
                if active_job_id == job_id:
                    active_job_id = None
        launch_next()


def launch_next():
    global active_job_id
    with lock:
        if active_job_id is not None:
            return
        while queue:
            nxt = queue.pop(0)
            job = jobs.get(nxt)
            if not job or job["status"] != "queued":
                continue
            active_job_id = nxt
            job["status"] = "running"  # reserve before another caller can launch
            try:
                writeback_job(job)
                save_jobs()
                threading.Thread(target=run_job, args=(nxt,), daemon=True).start()
                return
            except Exception as exc:                              # noqa: BLE001
                finish_job(job, "error", str(exc))
                active_job_id = None


# ---------------------------------------------------------------- routes

# ---------------------------------------------------------------- storyboards

BOARDS_FILE = Path(os.environ.get("H3_BOARDS_FILE", ROOT / "storyboards.json"))
boards: dict[str, dict] = {}
BOARDS_LOAD_ERROR: str | None = None  # Latched until a backend restart, never a UI retry.
BOARD_STORAGE_DETAIL = (
    "Storyboard persistence is unavailable; all writes are blocked. Stop the backend, "
    "back up the original file, restore a known-good copy, then restart."
)


def require_board_storage():
    if BOARDS_LOAD_ERROR:
        raise HTTPException(503, BOARD_STORAGE_DETAIL)


def save_boards():
    with lock:
        atomic_json(BOARDS_FILE, boards)


class PromptFields(BaseModel):
    scene: str = ""
    action: str = ""
    camera: str = ""
    look: str = ""
    audio: str = ""


class Take(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str
    shot_id: str
    job_id: str | None
    output: str
    created_at: float | None
    request: dict | None
    request_unknown: bool = False
    source_take_id: str | None = None
    source_unknown: bool = False
    legacy: bool = False
    model_name: str | None = None
    reference_snapshot: ReferenceSnapshot | None = None


class Shot(BaseModel):
    id: str
    prompt: str
    prompt_mode: Literal["simple", "structured"] = "simple"
    prompt_fields: PromptFields | None = None
    width: int = 512
    height: int = 512
    seconds: float | None = 6
    frames: int | None = None
    steps: int = 20
    layers: int = 45
    reuse: int = 2
    seed: int = 42
    turbo: bool = False
    first_frame: str | None = None
    last_frame: str | None = None
    ref_images: list[str] = Field(default_factory=list)
    ref_audio: list[str] = Field(default_factory=list)
    token_reduction: bool = False
    checkpoint_after_step: int | None = None
    status: str = "idle"          # idle / queued / running / done / error / skipped
    output: str | None = None
    job_id: str | None = None
    takes: list[Take] = Field(default_factory=list)
    selected_take_id: str | None = None
    reference_snapshot: ReferenceSnapshot | None = None


class Board(BaseModel):
    id: str
    name: str = "未命名分镜"
    chain: bool = True            # auto last-frame -> next first-frame
    shots: list[Shot] = Field(default_factory=list)
    status: str = "idle"          # idle / running / done / error
    result: str | None = None     # concatenated output name
    createdAt: float = 0.0
    modifiedAt: float = 0.0
    assets: list[ReferenceAsset] = Field(default_factory=list)
    reference_sets: list[ReferenceSet] = Field(default_factory=list)


def managed_output_name(name: str | None) -> bool:
    return bool(name and Path(name).name == name and Path(name).suffix == ".mp4")


def legacy_take(board: dict, shot: dict) -> dict | None:
    output = shot.get("output")
    if not managed_output_name(output):
        return None
    identity = f"{board['id']}\0{shot['id']}\0{output}".encode()
    take_id = "legacy-" + hashlib.sha256(identity).hexdigest()[:16]
    return Take(id=take_id, shot_id=shot["id"], job_id=None, output=output,
                created_at=None, request=None,
                request_unknown=True, source_unknown=True, legacy=True).model_dump()


def normalize_shot_history(board: dict, shot: dict):
    shot["takes"] = [Take(**take).model_dump() for take in shot.get("takes", [])]
    if not shot["takes"]:
        migrated = legacy_take(board, shot)
        if migrated:
            shot["takes"] = [migrated]
            shot["selected_take_id"] = migrated["id"]
    shot.setdefault("selected_take_id", None)
    project_selected_output(shot)


def selected_take(shot: dict) -> dict | None:
    selected_id = shot.get("selected_take_id")
    return next((take for take in shot.get("takes", [])
                 if take["id"] == selected_id), None)


def project_selected_output(shot: dict):
    take = selected_take(shot)
    shot["output"] = take["output"] if take else None


def take_missing(take: dict) -> bool:
    return not managed_output_name(take.get("output")) or not (OUTPUTS / take["output"]).is_file()


def take_is_referenced(take_id: str) -> bool:
    return (any(take.get("source_take_id") == take_id for board in boards.values()
                for shot in board["shots"] for take in shot.get("takes", []))
            or any(job.get("source_take_id") == take_id for job in jobs.values()))


def selected_take_sequence(board: dict) -> list[tuple[str, str]]:
    return [(shot["id"], shot["selected_take_id"]) for shot in board["shots"]
            if selected_take(shot) is not None]


def validate_stored_board(key: str, board: dict):
    """Validate structure, not generation feasibility or media availability."""
    Board.model_validate(board, strict=True)
    if not key or board["id"] != key:
        raise ValueError("invalid board identity")
    # Refuse unknown future metadata instead of silently dropping it on save.
    if board.keys() - Board.model_fields.keys() - {"_run_id", "error"}:
        raise ValueError("unknown board fields")
    if any(not isinstance(board[field], str) for field in ("_run_id", "error") if field in board):
        raise ValueError("invalid runtime metadata")
    shot_ids, take_ids = set(), set()
    for shot in board["shots"]:
        if not shot["id"] or shot["id"] in shot_ids:
            raise ValueError("invalid shot identity")
        shot_ids.add(shot["id"])
        if shot.keys() - Shot.model_fields.keys() - {"_instance_id"}:
            raise ValueError("unknown shot fields")
        if (shot["prompt_fields"] is not None
                and shot["prompt_fields"].keys() - PromptFields.model_fields.keys()):
            raise ValueError("unknown prompt fields")
        if "_instance_id" in shot and (
                not isinstance(shot["_instance_id"], str) or not shot["_instance_id"]):
            raise ValueError("invalid shot instance")
        local_takes = set()
        for take in shot["takes"]:
            if not take["id"] or take["id"] in take_ids or take["shot_id"] != shot["id"]:
                raise ValueError("invalid take identity")
            if take.keys() - Take.model_fields.keys():
                raise ValueError("unknown take fields")
            if take["request"] is not None:
                GenRequest.model_validate(take["request"], strict=True)
            take_ids.add(take["id"])
            local_takes.add(take["id"])
        if shot["selected_take_id"] is not None and shot["selected_take_id"] not in local_takes:
            raise ValueError("invalid selected take")


def load_boards() -> dict[str, dict]:
    global BOARDS_LOAD_ERROR
    if BOARDS_LOAD_ERROR:
        return {}
    try:
        restored = read_board_object(BOARDS_FILE)
        for board_id, board in restored.items():
            defaults = Board(id=board["id"]).model_dump()
            for key, value in defaults.items():
                board.setdefault(key, value)
            for shot in board["shots"]:
                defaults = Shot(id=shot["id"], prompt="").model_dump()
                for key, value in defaults.items():
                    shot.setdefault(key, value)
                if shot["prompt_fields"] is not None:
                    shot["prompt_fields"] = {**PromptFields().model_dump(), **shot["prompt_fields"]}
            validate_stored_board(board_id, board)
            for shot in board["shots"]:
                shot.setdefault("_instance_id", uuid.uuid4().hex)
                normalize_shot_history(board, shot)
                if shot["status"] in ACTIVE:
                    shot["status"] = "interrupted"
            if board["status"] in ACTIVE:
                board["status"] = "interrupted"
            board.pop("_run_id", None)
        return restored
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError) as exc:
        BOARDS_LOAD_ERROR = exc.reason if isinstance(exc, BoardStorageError) else "invalid_schema"
        logging.getLogger(__name__).error(
            "Storyboard persistence unavailable (%s); writes blocked. Preserve the original file before recovery.",
            BOARDS_LOAD_ERROR)
        return {}


boards = load_boards()


def public_board(board: dict) -> dict:
    # Defaults are applied on load, not strict generation validation.
    all_takes = {take["id"]: take for shot in board["shots"] for take in shot.get("takes", [])}
    selected = {shot["id"]: shot.get("selected_take_id") for shot in board["shots"]}

    def continuity(take: dict, visiting: set[str]) -> str:
        if take_missing(take) or take["id"] in visiting:
            return "stale"
        if take.get("source_unknown"):
            return "unknown"
        source_id = take.get("source_take_id")
        if source_id is None:
            return "current"
        source = all_takes.get(source_id)
        if source is None or selected.get(source["shot_id"]) != source_id:
            return "stale"
        source_state = continuity(source, visiting | {take["id"]})
        return source_state if source_state in ("stale", "unknown") else "current"

    public_shots = []
    for shot in board["shots"]:
        item = {k: v for k, v in shot.items() if not k.startswith("_")}
        item["takes"] = [{**take, "missing": take_missing(take)}
                         for take in shot.get("takes", [])]
        take = selected_take(shot)
        state = continuity(take, set()) if take else "none"
        item.update(continuity_state=state, stale=state == "stale",
                    output_missing=bool(take and take_missing(take)))
        snapshot = shot.get("reference_snapshot")
        item["reference_snapshot_missing"] = bool(snapshot and any(
            asset_missing(asset, UPLOADS) for asset in snapshot["images"] + snapshot["audio"]))
        public_shots.append(item)
    return {**{k: v for k, v in board.items() if not k.startswith("_")},
            "shots": public_shots,
            "assets": [{**asset, "missing": asset_missing(asset, UPLOADS)}
                       for asset in board.get("assets", [])],
            "reference_sets": [public_reference_set(board, item)
                               for item in board.get("reference_sets", [])]}


def target_shot(req: GenRequest) -> tuple[dict, dict] | None:
    if req.board_id is None and req.shot_id is None:
        return None
    if not req.board_id or not req.shot_id:
        raise HTTPException(400, "board_id and shot_id must be supplied together")
    board = boards.get(req.board_id)
    matches = [s for s in board["shots"] if s["id"] == req.shot_id] if board else []
    if not matches:
        raise HTTPException(404, "original target board or shot no longer exists")
    if len(matches) != 1:
        raise HTTPException(409, "ambiguous target: duplicate shot IDs")
    return board, matches[0]


def target_identity(board: dict, shot: dict) -> dict:
    return {"board_created": board["createdAt"], "shot_instance": shot["_instance_id"]}


def assert_job_target(job: dict):
    target = target_shot(job["request"])
    if target is not None:
        board, shot = target
        if job.get("target") != target_identity(board, shot) or shot.get("job_id") != job["id"]:
            raise HTTPException(409, "original target was replaced or belongs to another job")
    return target


def board_busy(board: dict) -> bool:
    return bool(board.get("_run_id")) or board["status"] == "running" or any(
        j["request"].board_id == board["id"] and
        (j["status"] in ACTIVE or j["id"] == active_job_id) for j in jobs.values())


def require_idle(board: dict):
    if board_busy(board):
        raise HTTPException(409, "board has active generation; reload after it finishes")


def writeback_job(job: dict):
    try:
        target = assert_job_target(job)
    except HTTPException:
        return  # Never resurrect a deleted target or overwrite a newer job.
    if target is None:
        return
    board, shot = target
    shot["status"] = job["status"]
    if job["status"] == "done" and job.get("output"):
        take_id = "take-" + job["id"]
        if not any(take["id"] == take_id for take in shot["takes"]):
            take = Take(
                id=take_id, shot_id=shot["id"], job_id=job["id"],
                output=job["output_name"], created_at=job["finished"],
                request=job["request"].model_dump(),
                source_take_id=job.get("source_take_id"),
                source_unknown=job.get("source_unknown", False),
                legacy=False, model_name=Path(job["model_dir"]).name,
                reference_snapshot=job.get("reference_snapshot"))
            shot["takes"].append(take.model_dump())
        job["take_id"] = take_id
        if shot.get("selected_take_id") == job.get("selection_at_submit"):
            shot["selected_take_id"] = take_id
        project_selected_output(shot)
    if not board.get("_run_id"):
        board["status"] = ("running" if job["status"] in ACTIVE else
                           "done" if job["status"] == "done" else "error")
    board["modifiedAt"] = time.time()
    save_boards()


def shot_request(board: dict, shot: dict) -> GenRequest:
    """The saved prompt is authoritative; structured fields are editor metadata."""
    values = {key: shot[key] for key in GenRequest.model_fields if key in shot}
    index = next(i for i, item in enumerate(board["shots"]) if item is shot)
    return GenRequest(**values, board_id=board["id"], shot_id=shot["id"],
                      label=f"[{board['name']}] 镜头 {index + 1}")


def chain_source(board: dict, req: GenRequest, previous_take: dict | None) -> dict | None:
    if board["chain"] and not req.first_frame and not req.ref_images and not req.ref_audio:
        return previous_take
    return None


def snapshot_matches(snapshot: dict | None, values: dict) -> bool:
    return bool(snapshot and
                [a["filename"] for a in snapshot["images"]] == values.get("ref_images", []) and
                [a["filename"] for a in snapshot["audio"]] == values.get("ref_audio", []))


def validate_reference_snapshot(snapshot: dict | None, req: GenRequest):
    if snapshot is None:
        return
    if not snapshot_matches(snapshot, req.model_dump()):
        raise HTTPException(409, "reference snapshot does not match request")
    for asset in snapshot["images"] + snapshot["audio"]:
        validate_asset(asset, UPLOADS)


def enqueue_job(req: GenRequest, *, source: dict | None = None,
                source_take_id: str | None = None, source_unknown: bool = False,
                model_dir: str | None = None, reference_snapshot: dict | None = None) -> dict:
    """Caller holds lock and has checked target ownership/board reservation."""
    target = target_shot(req)
    # Provenance comes only from server-owned shot state or the original resume job.
    if target and not req.resume:
        candidate = target[1].get("reference_snapshot")
        reference_snapshot = candidate if snapshot_matches(candidate, req.model_dump()) else None
    validate_reference_snapshot(reference_snapshot, req)
    warnings = preflight(req)
    if source:
        resolve_file(source["output"], outputs_only=True)
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "request": req.model_copy(deep=True), "status": "queued",
           "created": time.time(), "log": [f"warning: {w}" for w in warnings],
           "phase": None, "done": 0, "total": 0, "label": req.label or req.prompt[:40],
           "warnings": warnings, "chain_source": source["output"] if source else None,
           "source_take_id": source["id"] if source else source_take_id,
           "source_unknown": source_unknown,
           "reference_snapshot": json.loads(json.dumps(reference_snapshot))}
    if model_dir:
        job["model_dir"] = model_dir
    if target:
        board, shot = target
        job["target"] = target_identity(board, shot)
        job["selection_at_submit"] = shot.get("selected_take_id")
        # A failed retry must not remove the last usable clip from this shot.
        shot.update(status="queued", job_id=job_id)
        board["status"] = "running"
        board["result"] = None
        board["modifiedAt"] = time.time()
    jobs[job_id] = job
    try:
        save_jobs()
        if target:
            save_boards()
    except Exception as exc:
        finish_job(job, "error", str(exc))
        raise HTTPException(500, "cannot persist submitted job") from exc
    queue.append(job_id)
    return {"job_id": job_id, **({"warnings": warnings} if warnings else {})}


def extract_last_frame_of(video_name: str) -> str:
    src = resolve_file(video_name, outputs_only=True)
    out = UPLOADS / f"chain-{uuid.uuid4().hex}.png"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-sseof", "-0.05",
                    "-i", str(src), "-vframes", "1", str(out)],
                   capture_output=True, check=True, timeout=30)
    if not out.is_file():
        raise RuntimeError("chain frame extraction produced no image")
    return out.name


def board_run_worker(board_id: str, run_id: str):
    board = boards.get(board_id)
    shot = None
    try:
        previous_take = None
        for shot in board["shots"]:
            with lock:
                if boards.get(board_id) is not board or board.get("_run_id") != run_id:
                    return
                if not shot["prompt"].strip():
                    shot["status"] = "skipped"
                    save_boards()
                    continue
                req = shot_request(board, shot)
                result = enqueue_job(req, source=chain_source(board, req, previous_take))
                job_id = result["job_id"]
            launch_next()
            while True:
                with lock:
                    if boards.get(board_id) is not board or board.get("_run_id") != run_id:
                        return
                    job = jobs.get(job_id)
                    if job is None or job["status"] in TERMINAL:
                        break
                time.sleep(0.05)
            if job is None or job["status"] != "done":
                raise RuntimeError(f"shot generation {job['status'] if job else 'interrupted'}")
            previous_take = next(take for take in shot["takes"]
                                 if take["id"] == job["take_id"])
        with lock:
            if boards.get(board_id) is board and board.get("_run_id") == run_id:
                board["status"] = "done"
    except Exception as exc:                                      # noqa: BLE001
        with lock:
            if board is not None and boards.get(board_id) is board and board.get("_run_id") == run_id:
                board["status"] = "error"
                board["error"] = str(exc)
                if shot is not None and shot["status"] not in TERMINAL:
                    shot["status"] = "error"
    finally:
        with lock:
            if board is not None and boards.get(board_id) is board and board.get("_run_id") == run_id:
                board.pop("_run_id", None)
                board["modifiedAt"] = time.time()
                try:
                    save_boards()
                except Exception as exc:                          # noqa: BLE001
                    board["status"] = "error"
                    board["error"] = f"cannot persist board: {exc}"
        launch_next()


@app.get("/api/boards")
def list_boards():
    out = []
    for b in sorted(boards.values(), key=lambda x: x.get("modifiedAt", 0), reverse=True):
        out.append({"id": b["id"], "name": b["name"], "status": b["status"],
                    "result": b.get("result"), "shotCount": len(b["shots"]),
                    "doneCount": sum(1 for s in b["shots"] if s["status"] == "done"),
                    "duration": round(sum(s.get("seconds") or 0 for s in b["shots"]), 1),
                    "createdAt": b.get("createdAt", 0), "modifiedAt": b.get("modifiedAt", 0)})
    return out


@app.get("/api/boards/{board_id}")
def get_board(board_id: str):
    with lock:
        if board_id not in boards:
            raise HTTPException(404)
        return public_board(boards[board_id])


@app.post("/api/boards")
def upsert_board(board: Board):
    with lock:
        previous = boards.get(board.id)
        if previous:
            require_idle(previous)
            if board.modifiedAt != previous["modifiedAt"]:
                raise HTTPException(409, "stale board revision; reload before saving")
        if len({s.id for s in board.shots}) != len(board.shots) or any(not s.id for s in board.shots):
            raise HTTPException(400, "shot IDs must be nonempty and unique")
        now = time.time()
        if not board.id:
            board.id = uuid.uuid4().hex[:8]
            if not board.shots:
                board.shots = [Shot(id="s" + uuid.uuid4().hex[:6], prompt="")]
        board.createdAt = previous["createdAt"] if previous else now
        board.modifiedAt = now
        updated = board.model_dump()
        # Dedicated reference APIs own metadata; old frontend autosaves may omit it.
        updated["assets"] = previous.get("assets", []) if previous else []
        updated["reference_sets"] = previous.get("reference_sets", []) if previous else []
        if previous:
            # Status/output/job ownership belong to the backend, not autosave.
            updated["status"], updated["result"] = previous["status"], previous.get("result")
            retained_ids = {shot["id"] for shot in updated["shots"]}
            removed_takes = [take["id"] for shot in previous["shots"]
                             if shot["id"] not in retained_ids
                             for take in shot.get("takes", [])]
            if any(take_is_referenced(take_id) for take_id in removed_takes):
                raise HTTPException(409, "cannot remove a shot with referenced take history")
        prior_shots = {s["id"]: s for s in previous["shots"]} if previous else {}
        for shot in updated["shots"]:
            prior = prior_shots.get(shot["id"])
            candidate = prior.get("reference_snapshot") if prior else None
            if prior is None and previous:
                # A duplicated shot may retain a trusted matching input snapshot.
                candidate = next((s.get("reference_snapshot") for s in previous["shots"]
                                  if s.get("reference_snapshot") == shot.get("reference_snapshot")
                                  and snapshot_matches(s.get("reference_snapshot"), shot)), None)
            shot["reference_snapshot"] = candidate if snapshot_matches(candidate, shot) else None
            shot["_instance_id"] = prior["_instance_id"] if prior else uuid.uuid4().hex
            if prior:
                for field in ("status", "output", "job_id", "takes", "selected_take_id"):
                    shot[field] = prior.get(field)
            elif previous:
                shot.update(status="idle", output=None, job_id=None, takes=[],
                            selected_take_id=None)
            else:
                # Initial output-only imports are legacy history; supplied take
                # metadata and runtime ownership are never accepted from clients.
                shot["takes"] = []
                shot["selected_take_id"] = None
                shot["job_id"] = None
                normalize_shot_history(updated, shot)
        if previous and selected_take_sequence(updated) != selected_take_sequence(previous):
            updated["result"] = None
        boards[board.id] = updated
        save_boards()
        return public_board(updated)


# ---------------------------------------------------------------- project references

class ReferenceRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_board_revision: float = Field(ge=0, allow_inf_nan=False)


class AssetImport(ReferenceRevision):
    filename: str = Field(min_length=1, max_length=255)
    kind: Literal["image", "audio"]


class ReferenceSetWrite(ReferenceRevision):
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["character", "scene", "style", "other"] = "character"
    image_asset_ids: list[str] = Field(min_length=1, max_length=9)
    audio_asset_ids: list[str] = Field(default_factory=list, max_length=3)
    notes: str = Field(default="", max_length=4000)
    expected_set_revision: int | None = Field(default=None, ge=1)


class ReferenceApply(ReferenceRevision):
    expected_set_revision: int = Field(ge=1)
    replace_existing: bool = False


def reference_board(board_id: str, revision: float | None = None) -> dict:
    board = boards.get(board_id)
    if board is None:
        raise HTTPException(404, "board not found")
    if revision is not None:
        require_idle(board)
        if not math.isfinite(revision) or revision != board["modifiedAt"]:
            raise HTTPException(409, "stale board revision; reload before changing references")
    return board


def reference_item(items: list[dict], item_id: str) -> dict:
    match = next((item for item in items if item["id"] == item_id), None)
    if match is None:
        raise HTTPException(404, "reference item not found in this board")
    return match


def public_reference_set(board: dict, reference_set: dict) -> dict:
    assets = {a["id"]: a for a in board.get("assets", [])}
    ids = reference_set["image_asset_ids"] + reference_set["audio_asset_ids"]
    return {**reference_set, "missing_asset_ids": [
        asset_id for asset_id in ids if asset_id not in assets or asset_missing(assets[asset_id], UPLOADS)]}


def commit_reference_board(board: dict, updated: dict) -> dict:
    """Caller holds lock. Persist first so a failed save cannot change live state."""
    updated["modifiedAt"] = max(time.time(), board["modifiedAt"] + 0.000001)
    try:
        atomic_json(BOARDS_FILE, {**boards, board["id"]: updated})
    except OSError as exc:
        raise HTTPException(500, "cannot persist reference changes") from exc
    boards[board["id"]] = updated
    return public_board(updated)


def reference_set_assets(board: dict, data: ReferenceSetWrite) -> tuple[list[dict], list[dict]]:
    if not data.name.strip():
        raise HTTPException(400, "reference set name is empty")
    images, audio = [], []
    for ids, kind, target in ((data.image_asset_ids, "image", images),
                              (data.audio_asset_ids, "audio", audio)):
        if len(ids) != len(set(ids)):
            raise HTTPException(400, "reference asset IDs must be unique within each list")
        for asset_id in ids:
            asset = reference_item(board.get("assets", []), asset_id)
            if asset["kind"] != kind:
                raise HTTPException(400, "reference asset kind does not match its list")
            target.append(asset)
    if any(type(a.get("duration")) not in (int, float)
           or not 2 <= a["duration"] <= 15 for a in audio):
        raise HTTPException(400, "reference audio duration metadata is invalid")
    if sum(a["duration"] for a in audio) > 15:
        raise HTTPException(400, "reference audio total exceeds 15 seconds")
    return images, audio


@app.get("/api/boards/{board_id}/assets")
def list_reference_assets(board_id: str):
    with lock:
        return public_board(reference_board(board_id))["assets"]


@app.post("/api/boards/{board_id}/assets")
def register_reference_asset(board_id: str, data: AssetImport):
    with lock:
        original = reference_board(board_id, data.expected_board_revision)
        # No arbitrary path reads; registration only copies an already-local upload/output.
        source = resolve_file(data.filename)
        if (UPLOADS / data.filename).is_symlink() or (OUTPUTS / data.filename).is_symlink():
            raise HTTPException(400, "symlink references cannot be registered")
    asset = import_asset(source, UPLOADS, data.kind).model_dump()
    with lock:
        board = reference_board(board_id, data.expected_board_revision)
        if board is not original:
            raise HTTPException(409, "board changed during asset import")
        # A stale revision/save error may leave an unattached managed copy. Never GC
        # media implicitly; the original and all previously referenced bytes are safe.
        return commit_reference_board(board, {**board, "assets": [*board.get("assets", []), asset]})


def reference_asset_in_use(asset: dict) -> bool:
    def snapshot_uses(snapshot):
        return bool(snapshot and any(a["id"] == asset["id"]
                                     for a in snapshot["images"] + snapshot["audio"]))

    def inputs_use(values):
        return asset["filename"] in [values.get("first_frame"), values.get("last_frame"),
                                      *values.get("ref_images", []), *values.get("ref_audio", [])]

    for board in boards.values():
        if any(asset["id"] in r["image_asset_ids"] + r["audio_asset_ids"]
               for r in board.get("reference_sets", [])):
            return True
        for shot in board["shots"]:
            if inputs_use(shot) or snapshot_uses(shot.get("reference_snapshot")):
                return True
            for take in shot.get("takes", []):
                if snapshot_uses(take.get("reference_snapshot")) or inputs_use(take.get("request") or {}):
                    return True
    return any(snapshot_uses(job.get("reference_snapshot")) or inputs_use(job["request"].model_dump())
               for job in jobs.values())


@app.delete("/api/boards/{board_id}/assets/{asset_id}")
def delete_reference_asset(board_id: str, asset_id: str, expected_board_revision: float):
    with lock:
        board = reference_board(board_id, expected_board_revision)
        asset = reference_item(board.get("assets", []), asset_id)
        if reference_asset_in_use(asset):
            raise HTTPException(409, "asset is referenced by a set, shot, take or job")
        return commit_reference_board(board, {**board, "assets": [
            a for a in board["assets"] if a["id"] != asset_id]})


@app.get("/api/boards/{board_id}/reference-sets")
def list_reference_sets(board_id: str):
    with lock:
        return public_board(reference_board(board_id))["reference_sets"]


@app.post("/api/boards/{board_id}/reference-sets")
def create_reference_set(board_id: str, data: ReferenceSetWrite):
    with lock:
        board = reference_board(board_id, data.expected_board_revision)
        reference_set_assets(board, data)
        if data.expected_set_revision is not None:
            raise HTTPException(400, "new reference sets have no previous revision")
        reference_set = ReferenceSet(id=uuid.uuid4().hex, **data.model_dump(
            exclude={"expected_board_revision", "expected_set_revision"})).model_dump()
        return commit_reference_board(board, {**board, "reference_sets": [
            *board.get("reference_sets", []), reference_set]})


@app.put("/api/boards/{board_id}/reference-sets/{set_id}")
def update_reference_set(board_id: str, set_id: str, data: ReferenceSetWrite):
    with lock:
        board = reference_board(board_id, data.expected_board_revision)
        previous = reference_item(board.get("reference_sets", []), set_id)
        if data.expected_set_revision != previous["revision"]:
            raise HTTPException(409, "stale reference set revision")
        reference_set_assets(board, data)
        updated_set = ReferenceSet(id=set_id, revision=previous["revision"] + 1,
                                   **data.model_dump(exclude={"expected_board_revision", "expected_set_revision"})).model_dump()
        return commit_reference_board(board, {**board, "reference_sets": [
            updated_set if item["id"] == set_id else item for item in board["reference_sets"]]})


@app.delete("/api/boards/{board_id}/reference-sets/{set_id}")
def delete_reference_set(board_id: str, set_id: str, expected_board_revision: float):
    with lock:
        board = reference_board(board_id, expected_board_revision)
        reference_item(board.get("reference_sets", []), set_id)
        # Applied shots/jobs/takes embed the full snapshot, not a live alias.
        return commit_reference_board(board, {**board, "reference_sets": [
            item for item in board["reference_sets"] if item["id"] != set_id]})


@app.post("/api/boards/{board_id}/shots/{shot_id}/reference-sets/{set_id}/apply")
def apply_reference_set(board_id: str, shot_id: str, set_id: str, data: ReferenceApply):
    with lock:
        board = reference_board(board_id, data.expected_board_revision)
        _, shot = target_shot(GenRequest(prompt="", board_id=board_id, shot_id=shot_id))
        reference_set = reference_item(board.get("reference_sets", []), set_id)
        if reference_set["revision"] != data.expected_set_revision:
            raise HTTPException(409, "stale reference set revision")
        if shot.get("first_frame") is not None or shot.get("last_frame") is not None:
            raise HTTPException(409, "clear frame anchors explicitly before applying references")
        contents = ReferenceSetWrite(expected_board_revision=data.expected_board_revision,
                                     **{k: v for k, v in reference_set.items() if k not in ("id", "revision")})
        images, audio = reference_set_assets(board, contents)
        snapshot = ReferenceSnapshot(source_board_id=board_id, set_id=set_id,
                                     set_revision=reference_set["revision"], set_name=reference_set["name"],
                                     images=images, audio=audio).model_dump()
        if (shot.get("ref_images") or shot.get("ref_audio")) and not snapshot_matches(snapshot, shot) and not data.replace_existing:
            raise HTTPException(409, "shot already has references; confirm replace_existing explicitly")
        for asset in images + audio:
            validate_asset(asset, UPLOADS)
        updated_shot = {**shot, "ref_images": [a["filename"] for a in images],
                        "ref_audio": [a["filename"] for a in audio], "reference_snapshot": snapshot}
        return commit_reference_board(board, {**board, "shots": [
            updated_shot if s["id"] == shot_id else s for s in board["shots"]]})


@app.post("/api/boards/{board_id}/duplicate")
def duplicate_board(board_id: str):
    with lock:
        src = boards.get(board_id)
        if not src:
            raise HTTPException(404)
        now = time.time()
        copy = json.loads(json.dumps(src))
        copy.pop("_run_id", None)
        copy.pop("error", None)
        copy["id"] = uuid.uuid4().hex[:8]
        copy["name"] = src["name"] + " 副本"
        copy["status"] = "idle"
        copy["result"] = None
        copy["createdAt"] = copy["modifiedAt"] = now
        # Immutable asset identities/files are shared; editable sets get new identities.
        # Applied snapshots retain their original source board/set provenance.
        for reference_set in copy.get("reference_sets", []):
            reference_set["id"] = uuid.uuid4().hex
            reference_set["revision"] = 1
        for s in copy["shots"]:
            s["id"] = "s" + uuid.uuid4().hex[:6]
            s["_instance_id"] = uuid.uuid4().hex
            s["status"] = "idle"
            s["output"] = None
            s["job_id"] = None
            s["takes"] = []
            s["selected_take_id"] = None
        boards[copy["id"]] = copy
        save_boards()
        return public_board(copy)


@app.delete("/api/boards/{board_id}")
def delete_board(board_id: str):
    with lock:
        if board_id in boards:
            require_idle(boards[board_id])
        boards.pop(board_id, None)
        save_boards()
    return {"ok": True}


@app.post("/api/boards/{board_id}/run")
def run_board(board_id: str):
    with lock:
        board = boards.get(board_id)
        if not board:
            raise HTTPException(404)
        require_idle(board)
        if len({s["id"] for s in board["shots"]}) != len(board["shots"]):
            raise HTTPException(400, "shot IDs must be unique")
        if not any(s["prompt"].strip() for s in board["shots"]):
            raise HTTPException(400, "no shots with a nonempty prompt")
        warnings = []
        # Validate the entire board before changing state or starting any job.
        for shot in board["shots"]:
            if shot["prompt"].strip():
                try:
                    req = shot_request(board, shot)
                    validate_reference_snapshot(shot.get("reference_snapshot"), req)
                    warnings.extend(preflight(req))
                except HTTPException as exc:
                    raise HTTPException(exc.status_code, f"shot {shot['id']}: {exc.detail}") from exc
        run_id = uuid.uuid4().hex
        board.update(status="running", result=None, modifiedAt=time.time(), _run_id=run_id)
        board.pop("error", None)
        for shot in board["shots"]:
            shot.update(status="idle", job_id=None)
        try:
            save_boards()
            threading.Thread(target=board_run_worker, args=(board_id, run_id), daemon=True).start()
        except Exception as exc:
            board.pop("_run_id", None)
            board.update(status="error", error=str(exc))
            save_boards()
            raise HTTPException(500, "cannot start board worker") from exc
        return {"ok": True, **({"warnings": list(dict.fromkeys(warnings))} if warnings else {})}


@app.post("/api/boards/{board_id}/shots/{shot_id}/generate")
def generate_shot(board_id: str, shot_id: str):
    with lock:
        board, shot = target_shot(GenRequest(prompt="", board_id=board_id, shot_id=shot_id))
        require_idle(board)
        req = shot_request(board, shot)
        index = board["shots"].index(shot)
        previous = next((s for s in reversed(board["shots"][:index]) if s["prompt"].strip()), None)
        source = chain_source(board, req, selected_take(previous) if previous else None)
        result = enqueue_job(req, source=source)
    launch_next()
    return result


@app.get("/api/boards/{board_id}/shots/{shot_id}/takes")
def get_takes(board_id: str, shot_id: str):
    with lock:
        board, shot = target_shot(GenRequest(
            prompt="", board_id=board_id, shot_id=shot_id))
        public = public_board(board)
        return next(item["takes"] for item in public["shots"]
                    if item["id"] == shot["id"])


@app.post("/api/boards/{board_id}/shots/{shot_id}/takes/{take_id}/select")
def select_shot_take(board_id: str, shot_id: str, take_id: str):
    with lock:
        board, shot = target_shot(GenRequest(
            prompt="", board_id=board_id, shot_id=shot_id))
        require_idle(board)
        take = next((item for item in shot["takes"] if item["id"] == take_id), None)
        if take is None:
            raise HTTPException(404, "take not found")
        if take_missing(take):
            raise HTTPException(409, "take output is missing")
        if shot.get("selected_take_id") != take_id:
            shot["selected_take_id"] = take_id
            project_selected_output(shot)
            board["result"] = None
            board["modifiedAt"] = time.time()
            save_boards()
        return public_board(board)


@app.delete("/api/boards/{board_id}/shots/{shot_id}/takes/{take_id}")
def delete_shot_take(board_id: str, shot_id: str, take_id: str):
    with lock:
        board, shot = target_shot(GenRequest(
            prompt="", board_id=board_id, shot_id=shot_id))
        require_idle(board)
        take = next((item for item in shot["takes"] if item["id"] == take_id), None)
        if take is None:
            raise HTTPException(404, "take not found")
        if shot.get("selected_take_id") == take_id:
            raise HTTPException(409, "cannot delete the selected take")
        if take_is_referenced(take_id):
            raise HTTPException(409, "cannot delete a take referenced by take history")
        shot["takes"] = [item for item in shot["takes"] if item["id"] != take_id]
        board["modifiedAt"] = time.time()
        save_boards()
        return public_board(board)


@app.post("/api/boards/{board_id}/concat")
def concat_board(board_id: str):
    with lock:
        board = boards.get(board_id)
        if not board:
            raise HTTPException(404)
        require_idle(board)
        revision = board["modifiedAt"]
        selected = [selected_take(shot) for shot in board["shots"]]
        outputs = [take["output"] for take in selected if take is not None]
        for output in outputs:
            resolve_file(output, outputs_only=True)
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
    with lock:
        if boards.get(board_id) is not board or board["modifiedAt"] != revision:
            raise HTTPException(409, "board changed during concatenation; result was not attached")
        require_idle(board)
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
    name = f"{uuid.uuid4().hex}-{Path(file.filename or 'upload').name}"
    (UPLOADS / name).write_bytes(await file.read())
    return {"name": name}


@app.get("/api/uploads")
def list_uploads():
    return sorted((p.name for p in UPLOADS.iterdir() if p.suffix.lower() in
                   (".png", ".jpg", ".jpeg", ".webp")), reverse=True)


@app.post("/api/generate")
def generate(req: GenRequest):
    with lock:
        target = target_shot(req)
        if target:
            require_idle(target[0])
        result = enqueue_job(req)
    launch_next()
    return result


@app.post("/api/jobs/{job_id}/resume")
def resume_job(job_id: str):
    with lock:
        original = jobs.get(job_id)
        if original is None:
            raise HTTPException(404, "job not found")
        if original["status"] not in TERMINAL or active_job_id == job_id:
            raise HTTPException(409, "original job is still active")
        checkpoint = original.get("checkpoint")
        if not checkpoint:
            raise HTTPException(400, "original job has no checkpoint")
        req = original["request"].model_copy(deep=True, update={
            "checkpoint_after_step": None, "resume": checkpoint})
        if not req.board_id or not req.shot_id:
            raise HTTPException(400, "original request is missing its board/shot target; cannot retarget")
        board, shot = target_shot(req)
        require_idle(board)
        # Legacy jobs have no identity token: require their persisted job link.
        if ((original.get("target") is not None and original["target"] != target_identity(board, shot))
                or shot.get("job_id") != job_id):
            raise HTTPException(409, "original target was replaced or has a newer job")
        source_take_id = original.get("source_take_id")
        source_unknown = bool(original.get("source_unknown") or
                              (original.get("chain_source") and not source_take_id))
        result = enqueue_job(req, source_take_id=source_take_id,
                             source_unknown=source_unknown,
                             model_dir=original.get("model_dir"),
                             reference_snapshot=original.get("reference_snapshot"))
    launch_next()
    return result


@app.get("/api/jobs")
def list_jobs():
    with lock:
        return [public_job(j) for j in sorted(jobs.values(), key=lambda j: j["created"], reverse=True)]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with lock:
        if job_id not in jobs:
            raise HTTPException(404)
        return {**public_job(jobs[job_id]), "log": jobs[job_id]["log"][-80:]}


@app.delete("/api/jobs/{job_id}")
def cancel_job(job_id: str):
    with lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(404)
        if job["status"] not in ACTIVE:
            return {"ok": True}
        proc = job.get("proc")
        if job_id in queue:
            queue.remove(job_id)
        job["status"] = "cancelled"
        if job_id != active_job_id:
            finish_job(job, "cancelled")
        else:
            persist_job_state(job)
    if proc is not None:
        try:
            # Also handles a child ignoring SIGTERM while its worker blocks on stdout.
            stop_process(proc)
        except Exception as exc:                                  # noqa: BLE001
            with lock:
                job["log"].append(f"backend cancellation error: {exc}")
    launch_next()
    return {"ok": True}


def public_job(j: dict) -> dict:
    req: GenRequest = j["request"]
    return {"id": j["id"], "label": j["label"], "status": j["status"],
            "phase": j.get("phase"), "done": j.get("done"), "total": j.get("total"),
            "created": j["created"], "started": j.get("started"),
            "finished": j.get("finished"), "output": j.get("output"),
            "checkpoint": j.get("checkpoint"),
            "take_id": j.get("take_id"), "source_take_id": j.get("source_take_id"),
            "source_unknown": j.get("source_unknown", False),
            "reference_snapshot": j.get("reference_snapshot"),
            **({"warnings": j["warnings"]} if j.get("warnings") else {}),
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


@app.get("/api/media/{name}")
def media(name: str):
    if "/" in name or ".." in name:
        raise HTTPException(400, "invalid name")
    for base in (UPLOADS, OUTPUTS):
        p = base / name
        if p.exists():
            return FileResponse(p)
    raise HTTPException(404)


@app.delete("/api/videos/{name}")
def delete_video(name: str):
    if "/" in name or ".." in name:
        raise HTTPException(400, "invalid name")
    with lock:
        if any(take["output"] == name for board in boards.values()
               for shot in board["shots"] for take in shot.get("takes", [])):
            raise HTTPException(409, "video is referenced by take history")
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
