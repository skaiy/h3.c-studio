# Local reference sets — backend PR A

Project scope is one board. This backend is independent of the #8 take UI PR;
the reference picker/management UI is a subsequent PR after A merges.
No external services, new dependencies, video references or automatic soft-frame chaining.

## Data and ownership

- `Board.assets`: immutable `id`, managed `filename`, image/audio `kind`, `size`,
  SHA-256, `created_at`, and available dimensions/duration. No absolute source paths.
- Registration copies an already uploaded/local media file to a fresh `asset-<uuid>`
  name under uploads. It never edits the original or overwrites an existing copy.
- Supported images: PNG/JPEG/WebP. Audio: WAV/MP3/FLAC/M4A/OGG/AAC.
  Actual media is checked, not merely its extension. Audio is 2–15 seconds.
- Registration caps each asset at 256 MiB. ffprobe is local-file/demuxer restricted,
  limited to 10 seconds and 64 KiB output; errors do not echo paths or raw stderr.
- `Board.reference_sets`: `id`, `name`, `kind` (character/scene/style/other),
  ordered `image_asset_ids` / `audio_asset_ids`, `notes`, integer `revision`.
  First scope requires 1–9 images, 0–3 audio clips, no duplicate IDs in either list,
  and no more than 15 seconds total reference audio. Audio-only sets are not supported.
- Shot `reference_snapshot` embeds source board ID, set ID/revision/name, and full
  ordered immutable image/audio asset metadata. It is not a live link to the set.
- The job and take each retain an independent `reference_snapshot` alongside the
  frozen generation request. Requests still contain ordinary managed filenames.
  Checkpoints resume the original job snapshot, never current editor references.

## Endpoints

All writes use the existing optional Bearer-token middleware. Mutations return
the entire updated board, suitable for the per-board frontend draft store.
GETs remain read-only and public, consistent with existing local Studio policy.

| Method / path | Input |
|---|---|
| GET `/api/boards/{board}/assets` | none |
| POST `/api/boards/{board}/assets` | `filename`, `kind`, `expected_board_revision` |
| DELETE `/api/boards/{board}/assets/{asset}` | query: `expected_board_revision` |
| GET `/api/boards/{board}/reference-sets` | none |
| POST `/api/boards/{board}/reference-sets` | set fields + `expected_board_revision` |
| PUT `/api/boards/{board}/reference-sets/{set}` | all editable set fields + both expected revisions |
| DELETE `/api/boards/{board}/reference-sets/{set}` | query: `expected_board_revision` |
| POST `/api/boards/{board}/shots/{shot}/reference-sets/{set}/apply` | `expected_board_revision`, `expected_set_revision`, optional `replace_existing` |

`expected_board_revision` is the last returned `modifiedAt`; `expected_set_revision`
is the displayed set `revision`. Creation omits the latter. Stale revisions return
409, as do active generation and changed/missing frozen files. Unknown project-local
IDs return 404. Do not silently resolve conflicts by fetching and retrying a write.

## Applying safely

1. Flush the board's unsaved draft. Use the returned revision for the apply call.
2. If first/last anchors are set, reject application—even with `replace_existing`.
   The user must remove anchors explicitly first; no source material is removed.
3. Different existing image/audio inputs require `replace_existing: true` after
   explicit UI confirmation. Identical inputs require no redundant confirmation.
4. Validate asset bytes against their frozen size/SHA-256, then atomically save
   the filenames and source snapshot. No prompt change, generation, take adoption,
   or concatenation occurs. A valid existing selected output is retained.
5. Validate the frozen bytes again before submission and engine execution, before
   probing audio. Batch preflight checks every nonempty shot before queueing any.

## Editing, copying, missing files and deletion

- Editing/deleting a set never changes applied shots, queued jobs, or history.
  Reapply explicitly to use a different set revision.
- Old frontend autosave can omit the new fields without erasing them. Metadata and
  source provenance cannot be forged via board saves. Changing image/audio inputs
  manually clears the current shot's set provenance, not any historical snapshot.
- Duplicating a shot retains a trusted matching snapshot. Duplicating a board shares
  immutable asset identities/files but gives editable sets new IDs/revision 1;
  applied snapshots preserve their original source provenance until reapplied.
- GET supplies `assets[].missing`, `reference_sets[].missing_asset_ids` and
  `shots[].reference_snapshot_missing`. These are cheap presence checks, not a
  checksum audit; application/generation detects same-size content changes too.
- Restore the exact original file to recover old snapshots, or register a new asset,
  explicitly update the set, and reapply. There is no destructive relink-in-place API.
- Asset metadata deletion is rejected while any set, shot, take or job references
  it. Set/asset/board deletion never garbage-collects media files.
- Reference mutations persist before changing live state. A late revision conflict
  or disk failure after successful import can leave an unattached managed copy;
  it is retained conservatively, not attached to a different board or auto-deleted.

## Verification

Backend tests cover immutable bytes, metadata, timeouts, paths, limits, optimistic
conflicts, save/restart/copy, old clients, apply/replace, queue/resume/take snapshots,
missing files and deletion guards. Real tiny PNG/WAV ffprobe cases run when available.
UI interaction and true GPU generation quality are not validated by these tests.
See [the roadmap](local-personal-workflow.md) and issues #9/#11 for later work.

Known inherited recovery limitation: malformed persisted take metadata (including a
structurally invalid reference snapshot) makes the existing board loader return an
empty collection. A subsequent save may overwrite that file. Do not hand-edit the
JSON; keep backups. Per-record quarantine and fail-closed recovery are tracked in
[#15](https://github.com/skaiy/h3.c-studio/issues/15), not delivered by this API.