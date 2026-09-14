"""Path-traversal protection for the filename-based media/video endpoints.

The `{name}` route parameter is a single path segment: any request whose
decoded value contains a literal "/" (e.g. "sub%2Ffile.png" or
"..%2Fsecret") never matches the route at all and gets a generic
framework-level 404 before our handler runs. Traversal attempts that stay
within one segment (e.g. the literal string ".." with no slash) do reach
the handler, which explicitly rejects them with 400. Both outcomes mean
the attacker gets no file back — this test suite checks both mechanisms.
"""


def test_media_rejects_dotdot_within_single_segment(client):
    # A literal ".." segment gets collapsed by URL normalization before the
    # request is even sent, so use the percent-encoded form to reach our
    # handler's explicit ".." check with the segment intact.
    r = client.get("/api/media/%2e%2e")
    assert r.status_code == 400


def test_media_rejects_embedded_slash_via_routing(client):
    # "sub%2Ffile.png" decodes to "sub/file.png", which contains "/" and so
    # never matches the single-segment {name} route -> framework 404.
    r = client.get("/api/media/sub%2Ffile.png")
    assert r.status_code == 404


def test_media_rejects_traversal_with_embedded_slash_via_routing(client):
    r = client.get("/api/media/..%2Fsecret")
    assert r.status_code == 404


def test_media_missing_file_404(client):
    r = client.get("/api/media/does-not-exist.png")
    assert r.status_code == 404


def test_media_serves_existing_upload(app_env, client):
    upload_path = app_env.UPLOADS / "hello.png"
    upload_path.write_bytes(b"fake-png-bytes")
    r = client.get("/api/media/hello.png")
    assert r.status_code == 200
    assert r.content == b"fake-png-bytes"


def test_media_serves_existing_output(app_env, client):
    out_path = app_env.OUTPUTS / "clip.mp4"
    out_path.write_bytes(b"fake-mp4-bytes")
    r = client.get("/api/media/clip.mp4")
    assert r.status_code == 200
    assert r.content == b"fake-mp4-bytes"


def test_delete_video_rejects_dotdot_within_single_segment(client):
    r = client.delete("/api/videos/%2e%2e")
    assert r.status_code == 400


def test_delete_video_rejects_traversal_with_embedded_slash_via_routing(client):
    r = client.delete("/api/videos/..%2Fsecret.mp4")
    assert r.status_code == 404


def test_delete_video_rejects_non_mp4(app_env, client):
    p = app_env.OUTPUTS / "not-a-video.txt"
    p.write_text("hi")
    r = client.delete("/api/videos/not-a-video.txt")
    assert r.status_code == 404
    assert p.exists()  # untouched


def test_delete_video_missing_404(client):
    r = client.delete("/api/videos/missing.mp4")
    assert r.status_code == 404


def test_delete_video_removes_existing_file(app_env, client):
    p = app_env.OUTPUTS / "deleteme.mp4"
    p.write_bytes(b"x")
    r = client.delete("/api/videos/deleteme.mp4")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert not p.exists()


def test_videos_lists_mp4_outputs(app_env, client):
    (app_env.OUTPUTS / "a.mp4").write_bytes(b"aaaa")
    (app_env.OUTPUTS / "b.txt").write_text("not a video")
    r = client.get("/api/videos")
    assert r.status_code == 200
    names = [v["name"] for v in r.json()]
    assert "a.mp4" in names
    assert "b.txt" not in names


def test_uploads_lists_images_only(app_env, client):
    (app_env.UPLOADS / "photo.png").write_bytes(b"x")
    (app_env.UPLOADS / "notes.txt").write_text("not an image")
    r = client.get("/api/uploads")
    assert r.status_code == 200
    assert "photo.png" in r.json()
    assert "notes.txt" not in r.json()


def test_upload_stores_file_with_timestamp_prefix(client):
    files = {"file": ("my pic.png", b"binary-data", "image/png")}
    r = client.post("/api/upload", files=files)
    assert r.status_code == 200
    name = r.json()["name"]
    assert name.endswith("my pic.png")
    assert "-" in name
