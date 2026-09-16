"""Reference API lifecycles: real local copies/hashes, synthetic media and engine."""
import hashlib
import json
import secrets
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import reference_assets as refs

from .conftest import FakeProc, restart_backend, wait_for_status
from .test_storyboard_generation import checkpoint_file


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def board_url(board):
    return f"/api/boards/{board['id']}"


def current_board(client, board):
    return ok(client.get(board_url(board)))


def create_board(client):
    return ok(client.post("/api/boards", json={
        "id": "", "name": "Reference lifecycle", "chain": False,
        "shots": [{"id": shot_id, "prompt": f"Prompt {shot_id}",
                   "frames": 56, "reuse": 1} for shot_id in ("s1", "s2")]}))


def add_asset(client, app_env, board, filename, kind="image", content=b"image",
              directory=None):
    source = (directory if directory is not None else app_env.UPLOADS) / filename
    source.write_bytes(content)
    updated = ok(client.post(f"{board_url(board)}/assets", json={
        "filename": filename, "kind": kind,
        "expected_board_revision": board["modifiedAt"]}))
    return updated, updated["assets"][-1]


def set_payload(board, reference_set=None, **updates):
    if reference_set is None:
        data = {"name": "Ordered references", "kind": "character", "notes": "Original notes",
                "image_asset_ids": [a["id"] for a in board["assets"] if a["kind"] == "image"],
                "audio_asset_ids": [a["id"] for a in board["assets"] if a["kind"] == "audio"]}
    else:
        data = {key: reference_set[key] for key in (
            "name", "kind", "image_asset_ids", "audio_asset_ids", "notes")}
        data["expected_set_revision"] = reference_set["revision"]
    return {**data, "expected_board_revision": board["modifiedAt"], **updates}


def edit_set(client, board, **updates):
    group = board["reference_sets"][0]
    return ok(client.put(f"{board_url(board)}/reference-sets/{group['id']}",
                         json=set_payload(board, group, **updates)))


def apply_set(client, board, shot_id="s1", reference_set=None, **updates):
    group = reference_set if reference_set is not None else board["reference_sets"][0]
    return client.post(
        f"{board_url(board)}/shots/{shot_id}/reference-sets/{group['id']}/apply",
        json={"expected_board_revision": board["modifiedAt"],
              "expected_set_revision": group["revision"], **updates})


def delete_item(client, board, collection, item_id):
    return client.delete(f"{board_url(board)}/{collection}/{item_id}",
                         params={"expected_board_revision": board["modifiedAt"]})


def generate(client, board, shot_id="s1"):
    result = ok(client.post(f"{board_url(board)}/shots/{shot_id}/generate"))
    wait_for_status(client, result["job_id"], {"done"})
    return result["job_id"]


def persistent_state(app_env):
    return deepcopy(app_env.boards), app_env.BOARDS_FILE.read_bytes()


def corrupt_same_size(path):
    """Exercise frozen hash validation, not just an existence/size check."""
    original = path.read_bytes()
    path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
    return original


def expected_snapshot(board):
    group = board["reference_sets"][0]
    assets = {a["id"]: {k: v for k, v in a.items() if k != "missing"}
              for a in board["assets"]}
    return {"source_board_id": board["id"], "set_id": group["id"],
            "set_revision": group["revision"], "set_name": group["name"],
            "images": [assets[i] for i in group["image_asset_ids"]],
            "audio": [assets[i] for i in group["audio_asset_ids"]]}


@pytest.fixture(autouse=True)
def synthetic_media(app_env, monkeypatch):
    """Stub only probe output; import_asset still copies and hashes fixture bytes."""
    state = SimpleNamespace(probes=[], duration=3.0)

    def probe(path, kind):
        assert path.parent == app_env.UPLOADS.resolve()
        assert path.name.startswith("asset-") and path.is_file()
        state.probes.append((path, kind, path.read_bytes()))
        stream = ({"codec_type": "video", "codec_name": "png", "width": 2, "height": 3}
                  if kind == "image" else
                  {"codec_type": "audio", "duration": str(state.duration)})
        return json.dumps({"streams": [stream]}).encode()

    def run(cmd, **kwargs):
        # Generation has its own audio-duration probe; never launch ffprobe/ffmpeg.
        assert cmd[0] == "ffprobe"
        assert Path(cmd[-1]).is_file()
        return SimpleNamespace(stdout=json.dumps({"streams": [
            {"codec_type": "audio", "duration": str(state.duration)}]}),
            stderr="", returncode=0)

    def unexpected_process(*args, **kwargs):
        raise AssertionError("unexpected subprocess; request the reference_engine fixture")

    monkeypatch.setattr(refs, "_probe_output", probe)
    monkeypatch.setattr(app_env.subprocess, "run", run)
    monkeypatch.setattr(app_env.subprocess, "Popen", unexpected_process)
    return state


@pytest.fixture
def reference_engine(app_env, synthetic_media, monkeypatch):
    commands = []

    def popen(cmd, **kwargs):
        assert cmd[0] == str(app_env.H3_BIN)
        commands.append(cmd)
        output = Path(cmd[cmd.index("-o") + 1])
        output.write_bytes(b"synthetic video")
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

    monkeypatch.setattr(app_env.subprocess, "Popen", popen)
    return commands


@pytest.fixture
def reference_library(client, app_env):
    board = create_board(client)
    for filename, kind, content in (
            ("one.png", "image", b"first image"), ("two.png", "image", b"second image"),
            ("one.wav", "audio", b"first audio"), ("two.wav", "audio", b"second audio")):
        board, _ = add_asset(client, app_env, board, filename, kind, content)
    payload = set_payload(board)
    payload["image_asset_ids"].reverse()
    payload["audio_asset_ids"].reverse()
    return ok(client.post(f"{board_url(board)}/reference-sets", json=payload))


def test_import_copies_real_bytes_and_original_overwrite_cannot_change_asset(
        app_env, client, synthetic_media):
    board = create_board(client)
    original = b"uploaded original image"
    upload = ok(client.post("/api/upload", files={
        "file": ("portrait.png", original, "image/png")}))["name"]
    source = app_env.UPLOADS / upload
    board = ok(client.post(f"{board_url(board)}/assets", json={
        "filename": upload, "kind": "image", "expected_board_revision": board["modifiedAt"]}))
    asset = board["assets"][0]
    managed = app_env.UPLOADS / asset["filename"]
    assert asset["filename"] == f"asset-{asset['id']}.png"
    assert managed != source and managed.read_bytes() == source.read_bytes() == original
    assert asset["size"] == len(original)
    assert asset["sha256"] == hashlib.sha256(original).hexdigest()
    assert (asset["width"], asset["height"], asset["duration"]) == (2, 3, None)
    assert not asset["missing"] and asset["created_at"] > 0
    source.write_bytes(b"overwritten upload")
    board = ok(client.post(f"{board_url(board)}/assets", json={
        "filename": upload, "kind": "image", "expected_board_revision": board["modifiedAt"]}))
    replacement = board["assets"][1]
    assert replacement["id"] != asset["id"] and replacement["sha256"] != asset["sha256"]
    assert replacement["sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert (app_env.UPLOADS / replacement["filename"]).read_bytes() == source.read_bytes()
    assert board["assets"][0] == asset and managed.read_bytes() == original
    assert synthetic_media.probes[0] == (managed.resolve(), "image", original)
    assert ok(client.get(f"{board_url(board)}/assets")) == board["assets"]
    board = ok(client.post(f"{board_url(board)}/reference-sets", json=set_payload(
        board, image_asset_ids=[asset["id"]])))
    applied = ok(apply_set(client, board))
    assert applied["shots"][0]["reference_snapshot"] == expected_snapshot(board)
    assert managed.read_bytes() == original


def test_set_crud_order_and_applied_snapshots_are_not_live_aliases(
        client, reference_library):
    board = reference_library
    original = expected_snapshot(board)
    assert ok(client.get(f"{board_url(board)}/reference-sets")) == board["reference_sets"]
    assert board["reference_sets"][0]["missing_asset_ids"] == []
    for shot_id in ("s1", "s2"):
        board = ok(apply_set(client, board, shot_id))
    for shot in board["shots"]:
        assert shot["reference_snapshot"] == original
        assert shot["ref_images"] == [a["filename"] for a in original["images"]]
        assert shot["ref_audio"] == [a["filename"] for a in original["audio"]]
        assert not shot["reference_snapshot_missing"]
    group = board["reference_sets"][0]
    board = edit_set(client, board, name="New scene", kind="scene", notes="Edited notes",
                     image_asset_ids=list(reversed(group["image_asset_ids"])),
                     audio_asset_ids=list(reversed(group["audio_asset_ids"])))
    changed = board["reference_sets"][0]
    assert changed["id"] == group["id"] and changed["revision"] == 2
    assert (changed["name"], changed["kind"], changed["notes"]) == (
        "New scene", "scene", "Edited notes")
    assert all(s["reference_snapshot"] == original for s in board["shots"])
    new_snapshot = expected_snapshot(board)
    board = ok(apply_set(client, board, "s2", replace_existing=True))
    assert board["shots"][0]["reference_snapshot"] == original
    assert board["shots"][1]["reference_snapshot"] == new_snapshot
    before_shots = deepcopy(board["shots"])
    board = ok(delete_item(client, board, "reference-sets", group["id"]))
    assert board["reference_sets"] == [] and board["shots"] == before_shots
    assert ok(client.get(f"{board_url(board)}/reference-sets")) == []


def test_asset_and_set_ids_are_project_scoped(app_env, client, reference_library):
    source = reference_library
    other, _ = add_asset(client, app_env, create_board(client), "other.png")
    other = ok(client.post(f"{board_url(other)}/reference-sets", json=set_payload(other)))
    foreign = source["reference_sets"][0]
    local = other["reference_sets"][0]
    before = persistent_state(app_env)
    attempts = [
        ("POST", f"{board_url(other)}/reference-sets", {"json": set_payload(
            other, image_asset_ids=foreign["image_asset_ids"])}),
        ("PUT", f"{board_url(other)}/reference-sets/{local['id']}", {"json": set_payload(
            other, local, image_asset_ids=foreign["image_asset_ids"])}),
        ("PUT", f"{board_url(other)}/reference-sets/{foreign['id']}",
         {"json": set_payload(other, local)}),
    ]
    for method, url, kwargs in attempts:
        assert client.request(method, url, **kwargs).status_code == 404
        assert persistent_state(app_env) == before
    for collection, item_id in (("assets", source["assets"][0]["id"]),
                                ("reference-sets", foreign["id"])):
        assert delete_item(client, other, collection, item_id).status_code == 404
    assert apply_set(client, other, reference_set=foreign).status_code == 404
    assert persistent_state(app_env) == before
    assert current_board(client, source) == source and current_board(client, other) == other


def test_duplicate_board_and_restart_share_assets_but_remap_sets(
        client, reference_library):
    source = ok(apply_set(client, reference_library))
    snapshot = source["shots"][0]["reference_snapshot"]
    source = edit_set(client, source, name="Editable new name")
    copied = ok(client.post(f"{board_url(source)}/duplicate"))
    assert copied["id"] != source["id"] and copied["assets"] == source["assets"]
    old_set, new_set = source["reference_sets"][0], copied["reference_sets"][0]
    assert old_set["id"] != new_set["id"]
    assert old_set["revision"] == 2 and new_set["revision"] == 1
    for key in ("name", "kind", "notes", "image_asset_ids", "audio_asset_ids"):
        assert new_set[key] == old_set[key]
    assert {s["id"] for s in copied["shots"]}.isdisjoint(s["id"] for s in source["shots"])
    assert copied["shots"][0]["reference_snapshot"] == snapshot
    assert all(not s["takes"] and s["job_id"] is None for s in copied["shots"])
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        assert current_board(fresh, source) == source
        assert current_board(fresh, copied) == copied
        updated = ok(apply_set(fresh, copied, copied["shots"][0]["id"]))
        assert updated["shots"][0]["reference_snapshot"] == expected_snapshot(copied)
        assert current_board(fresh, source)["shots"][0]["reference_snapshot"] == snapshot
    assert snapshot["source_board_id"] == source["id"]
    assert snapshot["set_id"] == old_set["id"] and snapshot["set_revision"] == 1


def test_old_autosave_omitting_reference_metadata_preserves_trusted_state(
        client, reference_library):
    board = ok(apply_set(client, reference_library))
    draft = deepcopy(board)
    draft.pop("assets")
    draft.pop("reference_sets")
    for shot in draft["shots"]:
        shot.pop("reference_snapshot")
        shot.pop("reference_snapshot_missing")
    draft["shots"][0]["prompt"] = "Only the prompt changed"
    saved = ok(client.post("/api/boards", json=draft))
    assert saved["assets"] == board["assets"]
    assert saved["reference_sets"] == board["reference_sets"]
    assert saved["shots"][0]["reference_snapshot"] == board["shots"][0]["reference_snapshot"]
    assert saved["shots"][0]["prompt"] == draft["shots"][0]["prompt"]


def test_autosave_cannot_spoof_assets_sets_or_snapshot_provenance(
        client, reference_library):
    board = ok(apply_set(client, reference_library))
    draft = deepcopy(board)
    draft["assets"][0].update(filename="forged.png", sha256="0" * 64)
    draft["reference_sets"][0].update(name="Forged", revision=99)
    forged = deepcopy(draft["shots"][0]["reference_snapshot"])
    forged.update(source_board_id="forged-board", set_id="forged-set", set_revision=99)
    forged["images"][0]["sha256"] = "0" * 64
    draft["shots"][0]["reference_snapshot"] = forged
    draft["shots"].append({**deepcopy(draft["shots"][0]), "id": "forged-shot"})
    saved = ok(client.post("/api/boards", json=draft))
    assert saved["assets"] == board["assets"]
    assert saved["reference_sets"] == board["reference_sets"]
    assert saved["shots"][0]["reference_snapshot"] == board["shots"][0]["reference_snapshot"]
    assert saved["shots"][-1]["reference_snapshot"] is None
    draft["id"] = ""
    imported = ok(client.post("/api/boards", json=draft))
    assert imported["assets"] == imported["reference_sets"] == []
    assert all(s["reference_snapshot"] is None for s in imported["shots"])


def test_duplicate_shot_autosave_preserves_snapshot_until_manual_refs_change(
        client, reference_library):
    board = ok(apply_set(client, reference_library))
    snapshot = deepcopy(board["shots"][0]["reference_snapshot"])
    board["shots"].append({**deepcopy(board["shots"][0]), "id": "duplicate"})
    board = ok(client.post("/api/boards", json=board))
    assert board["shots"][-1]["reference_snapshot"] == snapshot
    assert board["shots"][0]["reference_snapshot"] == snapshot
    assert board["shots"][-1]["takes"] == [] and board["shots"][-1]["job_id"] is None
    # An image reorder and an audio removal are both manual reference changes.
    board["shots"][-1]["ref_images"].reverse()
    board = ok(client.post("/api/boards", json=board))
    assert board["shots"][-1]["reference_snapshot"] is None
    assert board["shots"][0]["reference_snapshot"] == snapshot
    board["shots"][0]["ref_audio"] = []
    saved = ok(client.post("/api/boards", json=board))
    assert saved["shots"][0]["reference_snapshot"] is None
    assert saved["shots"][-1]["reference_snapshot"] is None
    assert saved["assets"] == board["assets"] and saved["reference_sets"] == board["reference_sets"]


@pytest.mark.parametrize("anchor", ["first_frame", "last_frame"])
def test_apply_rejects_anchors_even_with_replace_existing(
        app_env, client, reference_library, anchor):
    board = reference_library
    board["shots"][0][anchor] = board["assets"][0]["filename"]
    board = ok(client.post("/api/boards", json=board))
    before = persistent_state(app_env)
    for replace in (False, True):
        response = apply_set(client, board, replace_existing=replace)
        assert response.status_code == 409 and "anchors" in response.json()["detail"]
        assert persistent_state(app_env) == before
        assert current_board(client, board)["shots"][0][anchor] == board["shots"][0][anchor]


def test_apply_requires_explicit_replacement_and_failed_validation_is_atomic(
        app_env, client, reference_library):
    board = reference_library
    board["shots"][0]["ref_images"] = [board["assets"][0]["filename"]]
    board = ok(client.post("/api/boards", json=board))
    before = persistent_state(app_env)
    response = apply_set(client, board)
    assert response.status_code == 409 and "replace_existing" in response.json()["detail"]
    assert persistent_state(app_env) == before
    media = app_env.UPLOADS / board["assets"][1]["filename"]
    original = corrupt_same_size(media)
    response = apply_set(client, board, replace_existing=True)
    assert response.status_code == 409 and "changed or missing" in response.json()["detail"]
    assert persistent_state(app_env) == before
    media.write_bytes(original)
    applied = ok(apply_set(client, board, replace_existing=True))
    assert applied["shots"][0]["reference_snapshot"] == expected_snapshot(board)
    # Identical inputs do not require a redundant replacement confirmation.
    repeated = ok(apply_set(client, applied))
    assert repeated["shots"] == applied["shots"]


def test_set_validation_rejects_bad_membership_counts_and_audio_budget(
        app_env, client, reference_library, synthetic_media):
    board = reference_library
    image, audio = board["assets"][0]["id"], board["assets"][2]["id"]
    group = board["reference_sets"][0]
    invalid = [
        ({"name": "   "}, 400), ({"kind": "invalid"}, 422),
        ({"image_asset_ids": []}, 422), ({"image_asset_ids": [image] * 10}, 422),
        ({"audio_asset_ids": [audio] * 4}, 422),
        ({"image_asset_ids": [image, image]}, 400),
        ({"audio_asset_ids": [audio, audio]}, 400),
        ({"image_asset_ids": [audio]}, 400), ({"audio_asset_ids": [image]}, 400),
        ({"image_asset_ids": ["unknown-asset"]}, 404),
    ]
    before = persistent_state(app_env)
    for changes, status in invalid:
        for method, suffix, previous in (("POST", "", None), ("PUT", f"/{group['id']}", group)):
            response = client.request(method, f"{board_url(board)}/reference-sets{suffix}",
                                      json=set_payload(board, previous, **changes))
            assert response.status_code == status, (changes, response.text)
            assert persistent_state(app_env) == before
    response = client.post(f"{board_url(board)}/reference-sets", json=set_payload(
        board, expected_set_revision=1))
    assert response.status_code == 400 and persistent_state(app_env) == before
    synthetic_media.duration = 8
    board, first = add_asset(client, app_env, board, "long-one.wav", "audio", b"long one")
    board, second = add_asset(client, app_env, board, "long-two.wav", "audio", b"long two")
    assert first["duration"] == second["duration"] == 8
    before = persistent_state(app_env)
    response = client.post(f"{board_url(board)}/reference-sets", json=set_payload(
        board, audio_asset_ids=[first["id"], second["id"]]))
    assert response.status_code == 400 and "15 seconds" in response.json()["detail"]
    assert persistent_state(app_env) == before


@pytest.mark.parametrize("duration", [None, True, "3", 0, 1.99, 15.01])
def test_corrupt_audio_duration_rejected_without_changing_state(
        app_env, client, reference_library, duration):
    board = reference_library
    stored = app_env.boards[board["id"]]
    next(a for a in stored["assets"] if a["kind"] == "audio")["duration"] = duration
    before = persistent_state(app_env)
    group = board["reference_sets"][0]
    for method, suffix, previous in (("POST", "", None), ("PUT", f"/{group['id']}", group)):
        response = client.request(method, f"{board_url(board)}/reference-sets{suffix}",
                                  json=set_payload(board, previous))
        assert response.status_code == 400 and "duration metadata" in response.json()["detail"]
        assert persistent_state(app_env) == before
    assert apply_set(client, board).status_code == 400
    assert persistent_state(app_env) == before


def test_stale_board_and_set_revisions_reject_all_reference_mutations(
        app_env, client, reference_library):
    stale = reference_library
    board = edit_set(client, stale, notes="Advance both revisions")
    group = board["reference_sets"][0]
    before = persistent_state(app_env)
    base = board_url(board)
    stale_revision = {"expected_board_revision": stale["modifiedAt"]}
    attempts = [
        ("POST", f"{base}/assets", {"json": {"filename": "one.png", "kind": "image", **stale_revision}}),
        ("POST", f"{base}/reference-sets", {"json": set_payload(stale)}),
        ("PUT", f"{base}/reference-sets/{group['id']}", {"json": set_payload(stale, group)}),
        ("DELETE", f"{base}/assets/{board['assets'][0]['id']}", {"params": stale_revision}),
        ("DELETE", f"{base}/reference-sets/{group['id']}", {"params": stale_revision}),
        ("POST", f"{base}/shots/s1/reference-sets/{group['id']}/apply", {"json": {
            **stale_revision, "expected_set_revision": group["revision"]}}),
    ]
    for method, url, kwargs in attempts:
        response = client.request(method, url, **kwargs)
        assert response.status_code == 409 and "board revision" in response.json()["detail"]
        assert persistent_state(app_env) == before
    response = client.put(f"{base}/reference-sets/{group['id']}", json=set_payload(
        board, group, expected_set_revision=group["revision"] - 1))
    assert response.status_code == 409 and "set revision" in response.json()["detail"]
    response = apply_set(client, board, expected_set_revision=group["revision"] - 1)
    assert response.status_code == 409 and "set revision" in response.json()["detail"]
    assert persistent_state(app_env) == before


def test_import_rechecks_revision_after_slow_probe_before_attaching(
        app_env, client, monkeypatch, synthetic_media):
    board = create_board(client)
    source = app_env.UPLOADS / "slow.png"
    source.write_bytes(b"slow import bytes")
    real_probe = refs._probe_output
    saved_during_probe = []

    def intervening_save(path, kind):
        # Deterministic interleaving while import has released the board lock.
        draft = current_board(client, board)
        draft["shots"][0]["prompt"] = "Saved while probing"
        saved = ok(client.post("/api/boards", json=draft))
        saved_during_probe.append((saved, persistent_state(app_env), path))
        return real_probe(path, kind)

    monkeypatch.setattr(refs, "_probe_output", intervening_save)
    response = client.post(f"{board_url(board)}/assets", json={
        "filename": source.name, "kind": "image", "expected_board_revision": board["modifiedAt"]})
    assert response.status_code == 409
    assert len(saved_during_probe) == 1
    saved, state, unattached = saved_during_probe[0]
    assert current_board(client, board) == saved and saved["assets"] == []
    assert persistent_state(app_env) == state
    assert unattached.read_bytes() == source.read_bytes() == b"slow import bytes"


def test_reference_persistence_failure_keeps_live_and_disk_state_atomic(
        app_env, client, reference_library, monkeypatch):
    board, unused = add_asset(client, app_env, reference_library, "unused.png")
    group = board["reference_sets"][0]
    before = persistent_state(app_env)
    live = app_env.boards[board["id"]]
    files = {p: p.read_bytes() for p in app_env.UPLOADS.iterdir() if p.is_file()}
    original_replace = Path.replace

    def fail_board_replace(path, target):
        if Path(target) == app_env.BOARDS_FILE:
            raise OSError("synthetic atomic rename failure")
        return original_replace(path, target)

    monkeypatch.setattr(Path, "replace", fail_board_replace)
    base = board_url(board)
    revision = {"expected_board_revision": board["modifiedAt"]}
    attempts = [
        ("POST", f"{base}/assets", {"json": {"filename": "one.png", "kind": "image", **revision}}),
        ("POST", f"{base}/reference-sets", {"json": set_payload(board)}),
        ("PUT", f"{base}/reference-sets/{group['id']}", {"json": set_payload(board, group, name="Lost edit")}),
        ("DELETE", f"{base}/reference-sets/{group['id']}", {"params": revision}),
        ("DELETE", f"{base}/assets/{unused['id']}", {"params": revision}),
        ("POST", f"{base}/shots/s1/reference-sets/{group['id']}/apply", {"json": {
            **revision, "expected_set_revision": group["revision"]}}),
    ]
    for method, url, kwargs in attempts:
        response = client.request(method, url, **kwargs)
        assert response.status_code == 500
        assert response.json()["detail"] == "cannot persist reference changes"
        assert app_env.boards[board["id"]] is live
        assert persistent_state(app_env) == before
        assert current_board(client, board) == board
        assert all(path.read_bytes() == content for path, content in files.items())


def test_generation_freezes_independent_job_and_take_snapshots(
        app_env, client, reference_library, reference_engine):
    board = ok(apply_set(client, reference_library))
    snapshot = expected_snapshot(board)
    job_id = generate(client, board)
    board = current_board(client, board)
    job = ok(client.get(f"/api/jobs/{job_id}"))
    take = board["shots"][0]["takes"][0]
    assert job["reference_snapshot"] == take["reference_snapshot"] == snapshot
    assert take["job_id"] == job_id
    command = reference_engine[0]
    for field, flag, assets in (("ref_images", "--ref-image", snapshot["images"]),
                                ("ref_audio", "--ref-audio", snapshot["audio"])):
        names = [a["filename"] for a in assets]
        assert take["request"][field] == job["params"][field] == names
        assert [Path(command[i + 1]).name for i, value in enumerate(command) if value == flag] == names
    live_shot = app_env.boards[board["id"]]["shots"][0]
    live_job = app_env.jobs[job_id]["reference_snapshot"]
    live_take = live_shot["takes"][0]["reference_snapshot"]
    assert live_job is not live_shot["reference_snapshot"] and live_take is not live_job
    assert live_job["images"][0] is not live_shot["reference_snapshot"]["images"][0]
    assert live_take["images"][0] is not live_job["images"][0]
    board = edit_set(client, board, name="Later set", notes="Not historical metadata")
    board["shots"][0].update(ref_images=[], ref_audio=[], prompt="Later prompt")
    board = ok(client.post("/api/boards", json=board))
    board = ok(delete_item(client, board, "reference-sets", board["reference_sets"][0]["id"]))
    assert board["shots"][0]["reference_snapshot"] is None
    assert board["shots"][0]["takes"][0] == take
    assert ok(client.get(f"/api/jobs/{job_id}"))["reference_snapshot"] == snapshot
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        assert current_board(fresh, board)["shots"][0]["takes"][0] == take
        assert ok(fresh.get(f"/api/jobs/{job_id}"))["reference_snapshot"] == snapshot


def test_resume_keeps_original_snapshot_after_manual_edits_and_restart(
        app_env, client, reference_library, reference_engine):
    board = reference_library
    board["shots"][0]["checkpoint_after_step"] = 3
    board = ok(client.post("/api/boards", json=board))
    board = ok(apply_set(client, board))
    snapshot = expected_snapshot(board)
    original_id = generate(client, board)
    original = ok(client.get(f"/api/jobs/{original_id}"))
    assert (app_env.OUTPUTS / original["checkpoint"]).is_file()
    board = current_board(client, board)
    board["shots"][0].update(prompt="Manual edit after checkpoint", ref_images=["missing-new.png"],
                              ref_audio=[], seed=999, frames=90)
    board = ok(client.post("/api/boards", json=board))
    assert board["shots"][0]["reference_snapshot"] is None
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        result = ok(fresh.post(f"/api/jobs/{original_id}/resume"))
        resumed = wait_for_status(fresh, result["job_id"], {"done"})
        updated = current_board(fresh, board)
        assert resumed["reference_snapshot"] == snapshot
        assert resumed["params"] == {**original["params"], "checkpoint_after_step": None,
                                     "resume": original["checkpoint"]}
        assert ok(fresh.get(f"/api/jobs/{original_id}"))["reference_snapshot"] == snapshot
    shot = updated["shots"][0]
    assert shot["ref_images"] == ["missing-new.png"] and shot["reference_snapshot"] is None
    assert shot["prompt"] == "Manual edit after checkpoint"
    assert [take["reference_snapshot"] for take in shot["takes"]] == [snapshot, snapshot]
    assert shot["takes"][-1]["job_id"] == result["job_id"]
    assert shot["takes"][-1]["request"]["prompt"] == "Prompt s1"
    assert "--resume" in reference_engine[-1] and "--checkpoint" not in reference_engine[-1]


def test_active_set_edit_is_denied_without_changing_queue_or_history(
        app_env, client, reference_library, reference_engine, monkeypatch):
    board = ok(apply_set(client, reference_library))
    old_id = generate(client, board)
    board = current_board(client, board)
    historical = ok(client.get(f"/api/jobs/{old_id}"))
    launch = app_env.launch_next
    monkeypatch.setattr(app_env, "launch_next", lambda: None)
    job_id = ok(client.post(f"{board_url(board)}/shots/s1/generate"))["job_id"]
    try:
        board = current_board(client, board)
        queued = ok(client.get(f"/api/jobs/{job_id}"))
        assert queued["status"] == "queued" and app_env.queue == [job_id]
        before = persistent_state(app_env)
        jobs_before = app_env.JOBS_FILE.read_bytes()
        group = board["reference_sets"][0]
        response = client.put(f"{board_url(board)}/reference-sets/{group['id']}",
                              json=set_payload(board, group, name="Not while active"))
        assert response.status_code == 409 and "active" in response.json()["detail"]
        assert delete_item(client, board, "reference-sets", group["id"]).status_code == 409
        assert persistent_state(app_env) == before and app_env.JOBS_FILE.read_bytes() == jobs_before
        assert app_env.queue == [job_id] and len(reference_engine) == 1
        assert ok(client.get(f"/api/jobs/{job_id}")) == queued
        assert ok(client.get(f"/api/jobs/{old_id}")) == historical
    finally:
        launch()
        wait_for_status(client, job_id, {"done"})
    assert current_board(client, board)["shots"][0]["takes"][-1]["reference_snapshot"] == \
        historical["reference_snapshot"]


def test_batch_checks_later_shot_hash_before_queuing_any_shot(
        app_env, client, reference_library, reference_engine):
    board = ok(apply_set(client, reference_library, "s2"))
    asset = board["shots"][1]["reference_snapshot"]["images"][0]
    path = app_env.UPLOADS / asset["filename"]
    corrupt_same_size(path)
    assert path.stat().st_size == asset["size"]
    before = persistent_state(app_env)
    response = client.post(f"{board_url(board)}/run")
    assert response.status_code == 409 and "s2" in response.json()["detail"]
    assert "changed or missing" in response.json()["detail"]
    assert not app_env.jobs and not app_env.queue and not reference_engine
    assert app_env.active_job_id is None and persistent_state(app_env) == before
    assert current_board(client, board) == board


@pytest.mark.parametrize("route", ["shots/s1/generate", "run"])
def test_changed_audio_is_rejected_before_any_media_probe(
        app_env, client, reference_library, monkeypatch, route):
    board = ok(apply_set(client, reference_library))
    asset = board["shots"][0]["reference_snapshot"]["audio"][0]
    corrupt_same_size(app_env.UPLOADS / asset["filename"])
    monkeypatch.setattr(app_env, "audio_duration", lambda *args: pytest.fail("changed audio must not be probed"))
    response = client.post(f"{board_url(board)}/{route}")
    assert response.status_code == 409
    assert not app_env.jobs and not app_env.queue


def test_queued_job_revalidates_frozen_hash_before_engine_spawn(
        app_env, client, reference_library, reference_engine, monkeypatch):
    board = ok(apply_set(client, reference_library))
    snapshot = expected_snapshot(board)
    launch = app_env.launch_next
    monkeypatch.setattr(app_env, "launch_next", lambda: None)
    job_id = ok(client.post(f"{board_url(board)}/shots/s1/generate"))["job_id"]
    assert app_env.queue == [job_id] and not reference_engine
    path = app_env.UPLOADS / snapshot["images"][0]["filename"]
    corrupt_same_size(path)
    assert path.stat().st_size == snapshot["images"][0]["size"]
    launch()
    failed = wait_for_status(client, job_id, {"error"})
    assert "changed or missing" in " ".join(failed["log"])
    assert failed["reference_snapshot"] == snapshot and not reference_engine
    assert not app_env.queue and app_env.active_job_id is None
    shot = current_board(client, board)["shots"][0]
    assert shot["reference_snapshot"] == snapshot and shot["takes"] == []
    assert shot["ref_images"] == [a["filename"] for a in snapshot["images"]]
    assert shot["ref_audio"] == [a["filename"] for a in snapshot["audio"]]


def test_asset_deletion_blocked_by_set_shot_take_and_job_after_board_deletion(
        app_env, client, reference_library, reference_engine, monkeypatch):
    board = reference_library
    asset = board["assets"][0]
    original_files = {p: p.read_bytes() for p in app_env.UPLOADS.iterdir() if p.is_file()}
    # Set only: neither shot has been given references yet.
    before = persistent_state(app_env)
    assert delete_item(client, board, "assets", asset["id"]).status_code == 409
    assert persistent_state(app_env) == before
    board = ok(apply_set(client, board))
    board = ok(delete_item(client, board, "reference-sets", board["reference_sets"][0]["id"]))
    # Shot only: the set is gone and no jobs/takes exist.
    before = persistent_state(app_env)
    assert not app_env.jobs and not board["shots"][0]["takes"]
    assert delete_item(client, board, "assets", asset["id"]).status_code == 409
    assert persistent_state(app_env) == before
    job_id = generate(client, board)
    board = current_board(client, board)
    output = app_env.OUTPUTS / board["shots"][0]["output"]
    board["shots"][0].update(ref_images=[], ref_audio=[])
    board = ok(client.post("/api/boards", json=board))
    assert board["shots"][0]["reference_snapshot"] is None
    # Isolate the take guard from the otherwise redundant historical job guard.
    with monkeypatch.context() as patch:
        patch.setattr(app_env, "jobs", {})
        before = persistent_state(app_env)
        assert delete_item(client, board, "assets", asset["id"]).status_code == 409
        assert persistent_state(app_env) == before
    copied = ok(client.post(f"{board_url(board)}/duplicate"))
    assert copied["assets"] == board["assets"]
    assert not copied["reference_sets"] and not copied["shots"][0]["takes"]
    assert copied["shots"][0]["reference_snapshot"] is None
    ok(client.delete(board_url(board)))
    assert client.get(board_url(board)).status_code == 404
    # Only the historical job now retains these references, across board removal.
    before = persistent_state(app_env)
    response = delete_item(client, copied, "assets", asset["id"])
    assert response.status_code == 409 and "job" in response.json()["detail"]
    assert persistent_state(app_env) == before
    assert ok(client.get(f"/api/jobs/{job_id}"))["reference_snapshot"]["source_board_id"] == board["id"]
    assert output.read_bytes() == b"synthetic video"
    assert all(path.read_bytes() == content for path, content in original_files.items())


def test_unreferenced_asset_metadata_delete_retains_upload_output_and_managed_files(
        app_env, client):
    board = create_board(client)
    originals = []
    for directory, filename, kind in ((app_env.UPLOADS, "free.png", "image"),
                                      (app_env.OUTPUTS, "free.wav", "audio")):
        board, asset = add_asset(client, app_env, board, filename, kind,
                                  content=b"unreferenced media", directory=directory)
        originals.extend([directory / filename, app_env.UPLOADS / asset["filename"]])
    original_shots = deepcopy(board["shots"])
    for asset in list(board["assets"]):
        previous_revision = board["modifiedAt"]
        board = ok(delete_item(client, board, "assets", asset["id"]))
        assert board["modifiedAt"] > previous_revision
        assert all(a["id"] != asset["id"] for a in board["assets"])
    assert board["assets"] == [] and board["shots"] == original_shots
    assert ok(client.get(f"{board_url(board)}/assets")) == []
    assert json.loads(app_env.BOARDS_FILE.read_text())[board["id"]]["assets"] == []
    assert all(path.read_bytes() == b"unreferenced media" for path in originals)


def test_asset_registration_rejects_paths_urls_symlinks_and_missing_files(
        app_env, client, tmp_path, synthetic_media):
    board = create_board(client)
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside media")
    local = app_env.UPLOADS / "local.png"
    local.write_bytes(b"local media")
    (app_env.UPLOADS / "escape.png").symlink_to(outside)
    (app_env.UPLOADS / "alias.png").symlink_to(local)
    (app_env.UPLOADS / "directory.png").mkdir()
    before = persistent_state(app_env)
    invalid = [("../outside.png", 400), (str(outside), 400),
               ("https://example.invalid/image.png", 400), ("folder\\image.png", 400),
               ("bad\0.png", 400), (".", 400), ("..", 400), ("", 422),
               ("escape.png", 400), ("alias.png", 400),
               ("directory.png", 404), ("missing.png", 404)]
    for filename, status in invalid:
        response = client.post(f"{board_url(board)}/assets", json={
            "filename": filename, "kind": "image", "expected_board_revision": board["modifiedAt"]})
        assert response.status_code == status, (filename, response.text)
        assert persistent_state(app_env) == before
    assert synthetic_media.probes == []
    assert outside.read_bytes() == b"outside media" and local.read_bytes() == b"local media"
    assert not list(app_env.UPLOADS.glob("asset-*"))


@pytest.mark.parametrize("damage", ["missing", "unsafe_metadata"])
def test_missing_or_unsafe_references_are_visible_but_do_not_block_prompt_save(
        app_env, client, reference_library, damage):
    board = ok(apply_set(client, reference_library))
    asset = board["assets"][0]
    path = app_env.UPLOADS / asset["filename"]
    if damage == "missing":
        path.rename(path.with_name("moved-" + path.name))
    else:
        # Simulate a damaged historical record, not a client-authorized metadata edit.
        live = app_env.boards[board["id"]]
        for stored in live["assets"] + live["shots"][0]["reference_snapshot"]["images"]:
            if stored["id"] == asset["id"]:
                stored["filename"] = "../outside.png"
        live["shots"][0]["ref_images"] = [
            a["filename"] for a in live["shots"][0]["reference_snapshot"]["images"]]
        app_env.save_boards()
    restarted = restart_backend()
    with TestClient(restarted.app) as fresh:
        damaged = current_board(fresh, board)
        assets = ok(fresh.get(f"{board_url(board)}/assets"))
        groups = ok(fresh.get(f"{board_url(board)}/reference-sets"))
        assert assets[0]["missing"] and not assets[1]["missing"]
        assert groups[0]["missing_asset_ids"] == [asset["id"]]
        assert damaged["shots"][0]["reference_snapshot_missing"]
        snapshot = deepcopy(damaged["shots"][0]["reference_snapshot"])
        damaged["shots"][0]["prompt"] = "An unrelated prompt edit must still save"
        saved = ok(fresh.post("/api/boards", json=damaged))
        assert saved["shots"][0]["prompt"] == damaged["shots"][0]["prompt"]
        assert saved["shots"][0]["reference_snapshot"] == snapshot
        assert saved["assets"] == assets and saved["reference_sets"] == groups
        assert saved["shots"][0]["reference_snapshot_missing"]
        before = persistent_state(restarted)
        response = apply_set(fresh, saved, "s2")
        assert response.status_code == 409
        assert persistent_state(restarted) == before


@pytest.fixture
def protected_library(reference_library, app_env, monkeypatch):
    # Runtime-only synthetic credential: never returned, printed, or used in assertions.
    monkeypatch.setattr(app_env, "STUDIO_TOKEN", secrets.token_urlsafe(32))
    return reference_library


def test_reference_write_routes_require_auth_while_reads_remain_available(
        app_env, client, protected_library):
    board = protected_library
    group = board["reference_sets"][0]
    base = board_url(board)
    revision = {"expected_board_revision": board["modifiedAt"]}
    before = persistent_state(app_env)
    attempts = [
        ("POST", f"{base}/assets", {"json": {"filename": "one.png", "kind": "image", **revision}}),
        ("POST", f"{base}/reference-sets", {"json": set_payload(board)}),
        ("PUT", f"{base}/reference-sets/{group['id']}", {"json": set_payload(board, group)}),
        ("DELETE", f"{base}/assets/{board['assets'][0]['id']}", {"params": revision}),
        ("DELETE", f"{base}/reference-sets/{group['id']}", {"params": revision}),
        ("POST", f"{base}/shots/s1/reference-sets/{group['id']}/apply", {"json": {
            **revision, "expected_set_revision": group["revision"]}}),
    ]
    for method, url, kwargs in attempts:
        response = client.request(method, url, **kwargs)
        assert response.status_code == 401
        assert persistent_state(app_env) == before
    assert current_board(client, board) == board
    assert ok(client.get(f"{base}/assets")) == board["assets"]
    assert ok(client.get(f"{base}/reference-sets")) == board["reference_sets"]
    assert not app_env.jobs and not app_env.queue