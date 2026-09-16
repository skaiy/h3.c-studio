"""Local-only references: mocked probes plus optional real stdlib media fixtures."""
import hashlib
import io
import json
import os
import shutil
import struct
import subprocess
import wave
import zlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import reference_assets as refs


def image_stream(**updates):
    return {"codec_type": "video", "codec_name": "png", "width": 1, "height": 1, **updates}


def audio_stream(**updates):
    return {"codec_type": "audio", "codec_name": "pcm_s16le", "duration": "3", **updates}


@pytest.fixture
def files(tmp_path):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    source = tmp_path / "original.png"
    source.write_bytes(b"original bytes")
    return source, uploads


@pytest.fixture
def ffprobe(monkeypatch):
    control = SimpleNamespace(payload={"streams": [image_stream()]}, status=0,
                              calls=[], processes=[], error=None)

    class Probe:
        def __init__(self, argv, **kwargs):
            control.calls.append((argv, kwargs))
            if control.error:
                raise control.error
            read_fd, write_fd = os.pipe()
            payload = control.payload
            os.write(write_fd, payload if isinstance(payload, bytes) else json.dumps(payload).encode())
            os.close(write_fd)
            self.stdout = os.fdopen(read_fd, "rb", buffering=0)
            self.returncode, self.killed, self.timeouts = None, False, []
            control.processes.append(self)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.stdout.close()

        def wait(self, timeout=None):
            self.timeouts.append(timeout)
            if self.returncode is None:
                self.returncode = control.status
            return self.returncode

        def poll(self):
            return self.returncode

        def kill(self):
            self.killed, self.returncode = True, -9

    monkeypatch.setattr(refs.subprocess, "Popen", Probe)
    return control


def assert_error(status, action):
    with pytest.raises(HTTPException) as caught:
        action()
    assert caught.value.status_code == status
    assert "/" not in caught.value.detail and "\\" not in caught.value.detail


def test_isolated_copy_models_and_order(files, ffprobe):
    source, uploads = files
    before = source.read_bytes()
    first = refs.import_asset(source, uploads, "image")
    second = refs.import_asset(source, uploads, "image")
    assert first.id != second.id
    assert first.filename == f"asset-{first.id}.png"
    assert (uploads / first.filename).read_bytes() == source.read_bytes() == before
    assert first.size == len(before) and first.sha256 == hashlib.sha256(before).hexdigest()
    assert first.created_at > 0 and (first.width, first.height, first.duration) == (1, 1, None)
    assert list(first.model_dump()) == ["id", "filename", "kind", "size", "sha256",
                                        "created_at", "duration", "width", "height"]
    group = refs.ReferenceSet(id="set", name="Name", kind="character",
                             image_asset_ids=[second.id, first.id], audio_asset_ids=[])
    assert group.notes == "" and group.revision == 1
    snapshot = refs.ReferenceSnapshot(source_board_id="board", set_id=group.id,
                                     set_revision=group.revision, set_name=group.name,
                                     images=[second, first], audio=[])
    assert [asset.id for asset in snapshot.images] == group.image_asset_ids
    assert refs.ReferenceSnapshot.model_validate_json(snapshot.model_dump_json()) == snapshot
    assert str(source.parent) not in snapshot.model_dump_json()
    with pytest.raises(ValidationError):
        first.filename = "replacement.png"
    with pytest.raises(ValidationError):
        snapshot.set_revision = 2
    argv, kwargs = ffprobe.calls[0]
    assert Path(argv[-1]) == (uploads / first.filename).resolve()
    assert argv[argv.index("-protocol_whitelist") + 1] == "file"
    assert argv[argv.index("-format_whitelist") + 1] == "png_pipe,jpeg_pipe,webp_pipe"
    assert kwargs == dict(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, shell=False)
    assert 0 < ffprobe.processes[0].timeouts[0] <= 10


@pytest.mark.parametrize("suffix,kind,codec", [
    (".PNG", "image", "png"), (".jpg", "image", "mjpeg"),
    (".jpeg", "image", "mjpeg"), (".webp", "image", "webp"),
    *[(suffix, "audio", "pcm_s16le") for suffix in (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac")],
])
def test_supported_extensions(files, ffprobe, suffix, kind, codec):
    source, uploads = files
    source = source.with_suffix(suffix)
    source.write_bytes(b"media")
    ffprobe.payload = {"streams": [image_stream(codec_name=codec) if kind == "image" else audio_stream()]}
    asset = refs.import_asset(source, uploads, kind)
    assert asset.filename.endswith(suffix.lower()) and asset.kind == kind
    if kind == "audio":
        assert asset.duration == 3 and asset.width is None and asset.height is None
        argv = ffprobe.calls[0][0]
        assert argv[argv.index("-format_whitelist") + 1] == "wav,mp3,flac,mov,ogg,aac"


@pytest.mark.parametrize("case", ["symlink", "directory", "missing", "playlist", "mismatch", "kind", "fifo"])
def test_reject_source_before_probe(files, ffprobe, case):
    original, uploads = files
    source, kind = original, "image"
    if case in ("symlink", "directory", "missing", "fifo"):
        source = original.with_name("invalid.png")
        if case == "symlink":
            source.symlink_to(original)
        elif case == "directory":
            source.mkdir()
        elif case == "fifo":
            os.mkfifo(source)
    elif case == "playlist":
        source = original.with_suffix(".m3u8")
        source.write_bytes(b"#EXTM3U")
    else:
        kind = "audio" if case == "mismatch" else "video"
    assert_error(400, lambda: refs.import_asset(source, uploads, kind))
    assert original.read_bytes() == b"original bytes"
    assert not list(uploads.iterdir()) and not ffprobe.calls


@pytest.mark.parametrize("name", [None, 123, "", ".", "..", "../original.png", "/tmp/outside.png",
                                       "sub/file.png", "sub\\file.png", "bad\0.png", "missing.png"])
def test_invalid_or_missing_paths(files, name):
    _, uploads = files
    asset = {"filename": name}
    assert refs.asset_missing(asset, uploads)
    assert_error(409, lambda: refs.validate_asset(asset, uploads))


@pytest.mark.parametrize("target", ["inside", "outside", "directory", "broken"])
def test_managed_path_symlink_or_directory(files, ffprobe, target):
    source, uploads = files
    asset = refs.import_asset(source, uploads, "image").model_dump()
    path = uploads / asset["filename"]
    path.unlink()
    if target == "directory":
        path.mkdir()
    else:
        destination = uploads / "other.png" if target == "inside" else source
        if target == "inside":
            destination.write_bytes(source.read_bytes())
        path.symlink_to(source.with_name("absent.png") if target == "broken" else destination)
    assert refs.asset_missing(asset, uploads)
    assert_error(409, lambda: refs.validate_asset(asset, uploads))


@pytest.mark.parametrize("payload", [None, [], {}, {"streams": []}, {"streams": [None]}, b"not json",
    {"streams": [audio_stream()]}, {"streams": [image_stream(codec_name="h264")]},
    {"streams": [image_stream(width=0)]}, {"streams": [image_stream(height=True)]},
    {"streams": [image_stream(width="1")]}, {"streams": [image_stream(), audio_stream()]},
])
def test_bad_image_probe_cleanup(files, ffprobe, payload):
    source, uploads = files
    ffprobe.payload = payload
    assert_error(400, lambda: refs.import_asset(source, uploads, "image"))
    assert not list(uploads.iterdir()) and source.read_bytes() == b"original bytes"


@pytest.mark.parametrize("duration", [None, "N/A", "nan", "inf", "-inf", "bad", True, [],
                                     -2, 0, 1.99, 15.01, 10**400])
def test_bad_audio_durations(files, ffprobe, duration):
    source, uploads = files
    source = source.with_suffix(".wav")
    source.write_bytes(b"audio")
    ffprobe.payload = {"streams": [audio_stream(duration=duration)]}
    assert_error(400, lambda: refs.import_asset(source, uploads, "audio"))
    assert not list(uploads.iterdir())


@pytest.mark.parametrize("cover,duration", [(1, 2), (1, 15), (0, 3), (1, "nan")])
def test_audio_cover_and_container_duration(files, ffprobe, cover, duration):
    source, uploads = files
    source = source.with_suffix(".m4a")
    source.write_bytes(b"audio")
    ffprobe.payload = {"streams": [audio_stream(duration="N/A"),
                                  image_stream(disposition={"attached_pic": cover})],
                       "format": {"duration": duration}}
    if cover and duration in (2, 15):
        assert refs.import_asset(source, uploads, "audio").duration == duration
    else:
        assert_error(400, lambda: refs.import_asset(source, uploads, "audio"))
        assert not list(uploads.iterdir())


@pytest.mark.parametrize("payload", [
    {"streams": [image_stream(disposition={"attached_pic": 1})]},
    {"streams": [audio_stream(), image_stream()]},
    {"streams": [audio_stream()], "format": []},
    {"streams": [audio_stream(), audio_stream(duration="16")]},
    {"streams": [audio_stream()], "format": {"duration": "inf"}},
])
def test_invalid_audio_content(files, ffprobe, payload):
    source, uploads = files
    source = source.with_suffix(".wav")
    source.write_bytes(b"audio")
    ffprobe.payload = payload
    assert_error(400, lambda: refs.import_asset(source, uploads, "audio"))
    assert not list(uploads.iterdir())


@pytest.mark.parametrize("failure", ["timeout", "exit", "unavailable", "output_cap"])
def test_probe_failures_are_bounded_and_clean(files, ffprobe, monkeypatch, failure):
    source, uploads = files
    if failure == "timeout":
        clock = iter([0, 11])
        monkeypatch.setattr(refs.time, "monotonic", lambda: next(clock, 11))
    elif failure == "exit":
        ffprobe.status = 1
    elif failure == "unavailable":
        ffprobe.error = FileNotFoundError("ffprobe unavailable")
    else:
        monkeypatch.setattr(refs, "MAX_PROBE_BYTES", 8)
    assert_error(400, lambda: refs.import_asset(source, uploads, "image"))
    assert not list(uploads.iterdir()) and source.exists()
    if failure in ("timeout", "output_cap"):
        assert ffprobe.processes[0].killed and ffprobe.processes[0].stdout.closed


def test_size_caps_and_growing_source(files, ffprobe, monkeypatch):
    source, uploads = files
    monkeypatch.setattr(refs, "MAX_ASSET_BYTES", 8)
    monkeypatch.setattr(refs, "_CHUNK_BYTES", 3)
    assert_error(413, lambda: refs.import_asset(source, uploads, "image"))
    source.write_bytes(b"12345678")
    asset = refs.import_asset(source, uploads, "image")
    assert asset.size == 8
    digest = refs._digest

    def growing(stream, target=None):
        with source.open("ab") as writer:
            writer.write(b"9")
        return digest(stream, target)

    monkeypatch.setattr(refs, "_digest", growing)
    assert_error(413, lambda: refs.import_asset(source, uploads, "image"))
    assert [path.name for path in uploads.iterdir()] == [asset.filename]
    sink = io.BytesIO()
    with pytest.raises(OverflowError):
        digest(io.BytesIO(b"123456789"), sink)
    assert len(sink.getvalue()) <= 8
    source = uploads / asset.filename
    assert_error(409, lambda: refs.validate_asset(asset.model_dump(), uploads))


@pytest.mark.parametrize("replacement", [b"changed! bytes", b"short", None])
def test_original_replacement_is_independent_and_managed_change_conflicts(files, ffprobe, monkeypatch, replacement):
    source, uploads = files
    asset = refs.import_asset(source, uploads, "image").model_dump()
    source.unlink()
    source.write_bytes(b"new independent source")
    assert refs.validate_asset(asset, uploads) is None
    monkeypatch.setattr(refs, "_probe", lambda *args: pytest.fail("must not probe on reads"))
    path = uploads / asset["filename"]
    if replacement is None:
        path.unlink()
    else:
        path.write_bytes(replacement)
    before = dict(asset)
    assert_error(409, lambda: refs.validate_asset(asset, uploads))
    assert asset == before
    monkeypatch.setattr(refs, "_digest", lambda *args: pytest.fail("listing must not hash"))
    assert refs.asset_missing(asset, uploads) == (replacement is None)


@pytest.mark.parametrize("updates", [{"size": -1}, {"size": True}, {"size": "14"},
    {"size": refs.MAX_ASSET_BYTES + 1}, {"sha256": None}, {"sha256": "bad"}, {"sha256": "a" * 65}])
def test_invalid_identity_metadata(files, ffprobe, monkeypatch, updates):
    source, uploads = files
    asset = refs.import_asset(source, uploads, "image").model_dump()
    monkeypatch.setattr(refs, "_digest", lambda *args: pytest.fail("invalid identity must not hash"))
    assert_error(409, lambda: refs.validate_asset({**asset, **updates}, uploads))


def test_exclusive_creation_never_deletes_existing_copy(files, ffprobe, monkeypatch):
    source, uploads = files
    monkeypatch.setattr(refs.uuid, "uuid4", lambda: SimpleNamespace(hex="fixed"))
    existing = uploads / "asset-fixed.png"
    existing.write_bytes(b"belongs to someone else")
    assert_error(400, lambda: refs.import_asset(source, uploads, "image"))
    assert existing.read_bytes() == b"belongs to someone else" and not ffprobe.calls


def test_failure_cleanup_does_not_delete_replacement(files, monkeypatch):
    source, uploads = files
    paths = []

    def replaced(path, kind):
        path.rename(uploads / "moved-owned-copy.png")
        path.write_bytes(b"unrelated replacement")
        paths.append(path)
        raise ValueError("probe failed")

    monkeypatch.setattr(refs, "_probe", replaced)
    assert_error(400, lambda: refs.import_asset(source, uploads, "image"))
    assert paths[0].read_bytes() == b"unrelated replacement"
    assert source.read_bytes() == b"original bytes"


@pytest.mark.skipif(shutil.which("ffprobe") is None, reason="ffprobe is not installed")
@pytest.mark.parametrize("kind", ["image", "audio"])
def test_real_stdlib_media(tmp_path, kind):
    source = tmp_path / ("tiny.png" if kind == "image" else "tiny.wav")
    if kind == "image":
        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
        source.write_bytes(b"\x89PNG\r\n\x1a\n"
                           + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00")) + chunk(b"IEND", b""))
    else:
        with wave.open(str(source), "wb") as writer:
            writer.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            writer.writeframes(b"\x00\x00" * 8000 * 2)
    uploads = tmp_path / "uploads"
    asset = refs.import_asset(source, uploads, kind)
    assert asset.sha256 == hashlib.sha256(source.read_bytes()).hexdigest()
    assert refs.validate_asset(asset.model_dump(), uploads) is None
    if kind == "image":
        assert (asset.width, asset.height) == (1, 1)
    else:
        assert asset.duration == pytest.approx(2)
    disguised = source.with_suffix(".wav" if kind == "image" else ".png")
    disguised.write_bytes(source.read_bytes())
    assert_error(400, lambda: refs.import_asset(disguised, uploads, "audio" if kind == "image" else "image"))
    assert [path.name for path in uploads.iterdir()] == [asset.filename]