# Local reference sets — UI guide and API

Project scope is one board. #8 take UI (#14), #9 backend PR A (#16), and
#15 startup recovery protection (#17) are merged on `main` at `1a1d35f`.
**#9 frontend PR B is implemented in this branch, pending human review/merge.**
This PR leaves the backend unchanged. Local personal use only: no external uploads,
new dependencies, video references or automatic soft-frame chaining; reference sets
do not guarantee identity consistency or lip sync.

## 界面操作 / UI how-to

### 中文

1. 打开分镜板，点击顶部「打开参考集管理」；即使还没有镜头也可使用。用「导入图片」/「导入音频」每次导入一个本地文件，最大 256 MiB。支持 PNG/JPEG/WebP 和 WAV/MP3/FLAC/M4A/OGG/AAC，后端校验实际媒体，不上传外部服务。
2. 点击「新建参考集」，填写名称、类别（角色/场景/风格/其他，可填备注），选择并用上移/下移排列素材：**1–9 张图、0–3 段音频；单段 2–15 秒，音频合计 ≤15 秒**。点击「保存参考集」仅保存集合，**不会应用到镜头**。
3. 选择镜头，在「参考集」中选择并预览集合，再点击「应用到此镜头」。应用先保存镜头草稿；替换不同的已有图片/音频参考须显式确认。若有首帧/尾帧锚点，先手动移除锚点再应用；不会自动清空锚点或删除素材。
4. 应用冻结该修订的有序素材与来源快照，不改提示词、预览、采用版本或启动生成。「镜头已冻结的参考快照」保留旧修订；「版本历史」展开参数快照可查看历史参考来源。编辑/删除参考集不改变已应用镜头、排队任务或历史 take；要更新当前镜头，编辑保存后须明确重新应用。
5. 素材缺失时，恢复完全相同的原始文件；或导入新素材身份、明确更新集合并重新应用。没有原地覆盖/relink；删除参考集或素材记录不删除媒体，仍被集合、镜头、take 或 job 引用的素材记录不能删除。

**失败与恢复：** 409 冲突、参考变更落盘失败（500）或启动恢复保护（503）会显示错误并保留草稿、原修订与选择，不自动重放写入。加载失败横幅的「重试加载」恢复读取，不丢弃草稿，也不重做导入/保存参考集/应用。参考集修订变化时，编辑器的「放弃编辑并加载最新修订」须确认，会丢弃该参考集的未保存编辑；分镜保存错误中的「放弃本地修改并重新加载」则丢弃分镜草稿。先保留需要的编辑，再决定是否放弃；不要用浏览器刷新处理未保存草稿。修复后检查最新状态，明确重试所需操作；「重试保存」只重试分镜保存，不自动应用参考集。

**本地安全边界：** 如配置 `H3_STUDIO_TOKEN`，在设置中填写访问令牌；它仅保护写操作，读取和媒体仍公开，不是对外发布的完整访问控制。仅限本机个人工作流，无外部服务上传，不保证身份一致或口型同步。

### English

1. Open a board and click **Open reference manager** in the header, even when there are no shots. Use **Import image** / **Import audio**, one local file at a time, up to 256 MiB each. Supported formats are PNG/JPEG/WebP and WAV/MP3/FLAC/M4A/OGG/AAC; the backend validates actual media, with no external upload.
2. Choose **New reference set**, enter a name and kind (character/scene/style/other, optional notes), then select and move assets up/down into order: **1–9 images, 0–3 audio clips; each clip 2–15 seconds, total audio ≤15 seconds**. **Save reference set** only saves the set; it **does not apply it to a shot**.
3. Select a shot, choose and preview a set under **Reference sets**, then click **Apply to this shot**. Application saves the shot draft first; replacing different existing image/audio references requires explicit confirmation. Remove any first/last-frame anchors explicitly before applying; anchors are never silently cleared and source media is not deleted.
4. Application freezes that revision's ordered assets and provenance without changing the prompt, preview, adopted take or starting generation. The shot's frozen snapshot retains the old revision; expand a take's parameter snapshot in **Take history** to inspect historical reference provenance. Editing/deleting a set does not alter applied shots, queued jobs or historical takes; edit and save, then explicitly reapply to update the current shot.
5. For missing media, restore the exact original file, or import a new asset identity, explicitly update the set and reapply. There is no overwrite/relink in place. Deleting sets or asset records does not delete media; asset records referenced by a set, shot, take or job cannot be deleted.

**Failures and recovery:** Revision conflicts (409), reference persistence failures (500), and startup recovery protection (503) show an error and retain drafts, original revisions and selections without replaying writes. **Retry loading** in the load-error banner recovers reads without discarding drafts or repeating imports/set saves/application. When a set revision changes, the editor's **Discard edits and load latest revision** requires confirmation and discards that set's unsaved edits; **Discard local changes and reload** in a board-save error discards the board draft instead. Preserve needed edits before choosing either discard action; do not refresh the browser with dirty drafts. After recovery, inspect the current state and explicitly retry the intended operation; **Retry save** only retries the board save, not reference application.

**Local security boundary:** If `H3_STUDIO_TOKEN` is configured, enter the access token in Settings. It protects writes only; reads and media remain public, so it is not complete access control for external hosting. Keep this personal workflow local; no external-service uploads or identity/lip-sync guarantees.

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
GETs and media remain public, consistent with existing local Studio policy;
the token is write protection, not read/media access control.

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

Frontend tests exercise components, the Workspace route, draft handling and the HTTP
contract with mocked HTTP/fetch in jsdom. They cover imports, ordering, explicit
replacement, anchor conflicts, frozen provenance, missing media, 409/503 draft
retention and recovery without write replay; these are not real-browser tests.
Backend tests cover immutable bytes, metadata, timeouts, paths, limits, optimistic
conflicts, save/restart/copy, old clients, apply/replace, queue/resume/take snapshots,
missing files and deletion guards. Real tiny PNG/WAV ffprobe cases run when available.
Validation on 2026-09-16: 435 frontend tests and 383 backend tests, plus build, lint
and i18n checks, all passing.
No real-browser smoke test or GPU generation/identity/lip-sync quality validation
is claimed. See [the roadmap](local-personal-workflow.md) for remaining work.

Startup recovery protection (#15/#17) is already merged on `main`: malformed
persisted reference metadata blocks board reads and all API writes with a safe
503 instead of masquerading as an empty project. Valid frozen snapshots still
load unchanged; missing media alone does not block loading. The original file is
not repaired or overwritten. See [manual recovery](persistence-recovery.md);
per-record salvage and jobs.json recovery remain out of scope.