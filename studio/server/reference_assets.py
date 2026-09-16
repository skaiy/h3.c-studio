"""Isolated local references; persisted identities never contain source paths."""
import hashlib
import json
import math
import os
import re
import selectors
import stat
import subprocess
import time
import uuid
from pathlib import Path
from typing import BinaryIO, Literal

from fastapi import HTTPException
from pydantic import BaseModel

MAX_ASSET_BYTES = 256 * 1024 * 1024
MAX_PROBE_BYTES = 64 * 1024
_CHUNK_BYTES = 1024 * 1024
_EXTENSIONS = {
    "image": {".png", ".jpg", ".jpeg", ".webp"},
    "audio": {".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac"},
}
_DEMUXERS = {
    "image": "png_pipe,jpeg_pipe,webp_pipe",
    "audio": "wav,mp3,flac,mov,ogg,aac",
}


class ReferenceAsset(BaseModel, frozen=True):
    id: str
    filename: str
    kind: Literal["image", "audio"]
    size: int
    sha256: str
    created_at: float
    duration: float | None = None
    width: int | None = None
    height: int | None = None


class ReferenceSet(BaseModel):
    id: str
    name: str
    kind: Literal["character", "scene", "style", "other"]
    image_asset_ids: list[str]
    audio_asset_ids: list[str]
    notes: str = ""
    revision: int = 1


class ReferenceSnapshot(BaseModel, frozen=True):
    source_board_id: str
    set_id: str
    set_revision: int
    set_name: str
    images: list[ReferenceAsset]
    audio: list[ReferenceAsset]


def _open_regular(path: Path) -> BinaryIO:
    # O_NONBLOCK avoids hanging on a FIFO substituted between checking/opening.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not a regular file")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def _digest(stream: BinaryIO, target: BinaryIO | None = None) -> tuple[int, str]:
    size, digest = 0, hashlib.sha256()
    while True:
        chunk = stream.read(min(_CHUNK_BYTES, MAX_ASSET_BYTES - size + 1))
        if not chunk:
            return size, digest.hexdigest()
        size += len(chunk)
        if size > MAX_ASSET_BYTES:
            raise OverflowError("asset exceeds size limit")
        if target is not None:
            target.write(chunk)
        digest.update(chunk)


def _probe_output(path: Path, kind: str) -> bytes:
    argv = [
        "ffprobe", "-v", "error", "-protocol_whitelist", "file",
        "-format_whitelist", _DEMUXERS[kind], "-show_entries",
        "stream=codec_type,codec_name,width,height,duration:"
        "stream_disposition=attached_pic:format=duration", "-of", "json", str(path),
    ]
    deadline = time.monotonic() + 10
    with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, shell=False) as process:
        try:
            output = bytearray()
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise subprocess.TimeoutExpired("ffprobe", 10)
                    chunk = os.read(process.stdout.fileno(),
                                    min(4096, MAX_PROBE_BYTES - len(output) + 1))
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > MAX_PROBE_BYTES:
                        raise ValueError("probe output exceeds limit")
            if process.wait(timeout=max(0, deadline - time.monotonic())) != 0:
                raise ValueError("probe failed")
            return bytes(output)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def _probe(path: Path, kind: str) -> dict:
    data = json.loads(_probe_output(path, kind))
    if not isinstance(data, dict):
        raise ValueError("invalid probe")
    streams = data.get("streams")
    if not isinstance(streams, list) or not streams or any(
            not isinstance(stream, dict) for stream in streams):
        raise ValueError("invalid streams")
    if kind == "image":
        stream = streams[0]
        width, height = stream.get("width"), stream.get("height")
        if (len(streams) != 1 or stream.get("codec_type") != "video"
                or stream.get("codec_name") not in ("png", "mjpeg", "webp")
                or type(width) is not int or type(height) is not int
                or width <= 0 or height <= 0):
            raise ValueError("not an image")
        return {"width": width, "height": height}
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
    for stream in streams:
        if stream.get("codec_type") == "video":
            disposition = stream.get("disposition")
            if not isinstance(disposition, dict) or disposition.get("attached_pic") != 1:
                raise ValueError("non-cover video")
    if not audio:
        raise ValueError("missing audio")
    # The container duration covers the entire asset, not only its first track.
    container = data.get("format", {})
    if not isinstance(container, dict):
        raise ValueError("invalid format")
    durations = [container.get("duration")] + [s.get("duration") for s in audio]
    values = []
    for value in durations:
        if value in (None, "N/A"):
            continue
        if isinstance(value, bool):
            raise ValueError("invalid duration")
        try:
            duration = float(value)
        except OverflowError:
            raise ValueError("invalid duration") from None
        if not math.isfinite(duration) or not 2 <= duration <= 15:
            raise ValueError("invalid duration")
        values.append(duration)
    if not values:
        raise ValueError("missing duration")
    return {"duration": max(values)}


def _remove_owned(path: Path, identity: tuple[int, int]) -> None:
    try:
        current = path.lstat()
        if (current.st_dev, current.st_ino) == identity:
            path.unlink()
    except OSError:
        pass


def import_asset(source: Path, uploads: Path, kind: str) -> ReferenceAsset:
    """Copy once, hash the copied bytes, and probe only the newly owned file."""
    if kind not in _EXTENSIONS or source.suffix.lower() not in _EXTENSIONS[kind]:
        raise HTTPException(400, "unsupported reference asset")
    destination, identity = None, None
    complete = False
    try:
        with _open_regular(source) as original:
            if os.fstat(original.fileno()).st_size > MAX_ASSET_BYTES:
                raise OverflowError("asset exceeds size limit")
            uploads.mkdir(parents=True, exist_ok=True)
            asset_id = uuid.uuid4().hex
            destination = uploads.resolve(strict=True) / f"asset-{asset_id}{source.suffix.lower()}"
            with destination.open("xb") as copied:
                owned = os.fstat(copied.fileno())
                identity = (owned.st_dev, owned.st_ino)
                size, digest = _digest(original, copied)
        metadata = _probe(destination, kind)
        asset = ReferenceAsset(id=asset_id, filename=destination.name, kind=kind,
                               size=size, sha256=digest, created_at=time.time(), **metadata)
        complete = True
        return asset
    except OverflowError:
        raise HTTPException(413, "reference asset exceeds size limit") from None
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError):
        raise HTTPException(400, "unsupported or unreadable reference asset") from None
    finally:
        if not complete and destination is not None and identity is not None:
            _remove_owned(destination, identity)


def _asset_path(asset: dict, uploads: Path) -> Path:
    name = asset.get("filename") if isinstance(asset, dict) else None
    if (not isinstance(name, str) or not name or name in (".", "..")
            or any(char in name for char in ("/", "\\", "\0"))):
        raise ValueError("invalid filename")
    base = uploads.resolve(strict=True)
    path = base / name
    if path.is_symlink() or path.resolve(strict=True).parent != base or not path.is_file():
        raise ValueError("missing asset")
    return path


def asset_missing(asset: dict, uploads: Path) -> bool:
    """Cheap presence check for listing; deliberately does not hash or probe."""
    try:
        _asset_path(asset, uploads)
        return False
    except (OSError, ValueError, RuntimeError):
        return True


def validate_asset(asset: dict, uploads: Path) -> None:
    """Reject changed/missing frozen references without replacing their metadata."""
    try:
        path = _asset_path(asset, uploads)
        expected_size, expected_digest = asset.get("size"), asset.get("sha256")
        if (type(expected_size) is not int or not 0 <= expected_size <= MAX_ASSET_BYTES
                or not isinstance(expected_digest, str)
                or re.fullmatch(r"[0-9a-f]{64}", expected_digest) is None):
            raise ValueError("invalid asset identity")
        with _open_regular(path) as stream:
            if os.fstat(stream.fileno()).st_size != expected_size:
                raise ValueError("asset size changed")
            size, digest = _digest(stream)
        if size != expected_size or digest != expected_digest:
            raise ValueError("asset contents changed")
    except (OSError, ValueError, TypeError, RuntimeError, OverflowError):
        raise HTTPException(409, "reference asset changed or missing") from None