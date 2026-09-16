# Storyboard persistence recovery / 分镜持久化恢复

Issue [#15](https://github.com/skaiy/h3.c-studio/issues/15), implemented in this
branch pending maintainer review/merge. This is a safety gate, not an automatic
repair tool or a backup system.

## Behaviour / 行为

- Only an absent file in an accessible existing parent directory, or a valid JSON
  object `{}`, means an empty project. Zero-length/whitespace/truncated files do not.
- Startup decodes UTF-8 JSON without duplicate keys or non-finite numbers, then
  validates board/shot/take structure and identity. Known old fields get defaults;
  missing media and type-valid drafts that cannot yet generate remain loadable.
- Unknown board/shot/take or structured-prompt fields are refused, not silently
  discarded by an older server. Keep compatible server/data versions together.
- Read errors, symlinks, non-regular files and invalid JSON/schema latch a recovery
  error until the backend restarts. The source and any `.tmp` sibling are untouched.
- No record is automatically skipped, quarantined, renamed, rewritten or repaired.
  One bad record blocks the whole collection; valid records remain in the original.

加载损坏数据时不再伪装成空项目。整个集合阻止写入，不自动跳过坏记录或另造新文件；
原文件与临时文件保留不动。缺失素材本身不等于分镜数据损坏，旧版合法数据仍会补默认值。

## API and UI

- Board GET/HEAD routes and **all API writes** return HTTP 503 during recovery.
  Writes are blocked before body parsing, queueing, probing or file mutation.
- The response includes `code: board_persistence_unavailable`, a safe `detail`,
  and `reason: invalid_json | invalid_schema | io_error`. No original record,
  absolute path, raw exception or credential is included. Logs use only the reason.
- Existing authentication still runs first: unauthenticated writes return 401.
- Jobs/media reads, static playback and CORS preflight remain available. Cancellation
  is also a write and is blocked: at startup old queued/running jobs are restored as
  interrupted, never restarted. This is not a live filesystem monitor.
- A low-level guard prevents board persistence helpers from bypassing the API gate.
- Workspace displays failed list/deep-link reads instead of treating failure as `[]`.
  Initial auto-creation only follows a successful empty list. Settings remains
  accessible, and retry only re-reads; it cannot unlock backend persistence.

前端提供五语言错误提示与只读重试，不再在列表失败后自动创建分镜。
鉴权设置仍可打开；重试不会修复数据，也不会解除后端的写入保护。

## Manual recovery / 人工恢复

1. Stop the affected backend process. Preserve unsaved editor text separately.
2. Locate the configured `H3_BOARDS_FILE` (default `studio/storyboards.json`).
   Keep a separate backup of the original and any `.tmp` sibling **before** recovery.
   Treat those files as private: they contain prompts and project metadata.
3. Diagnose permissions/location/version mismatch without modifying the original.
   Restore a verified compatible, known-good backup only after explicit approval.
   Partial record salvage requires a separately reviewed recovery procedure.
4. Restart the backend, then retry the UI. Confirm expected boards and selected
   takes before making edits. If validation still fails, leave writes blocked.

先停后端并备份原件，再经确认恢复已验证的兼容备份，最后重启并检查分镜与采用版本。
**不要通过删除文件、写入空对象、清除浏览器草稿或反复保存来“消除”错误。**

## Boundaries / 边界

This change covers startup storyboard loading. It does not provide automatic backups,
per-record salvage, jobs.json corruption recovery, live detection of external file
edits, rollback for ordinary disk-full save failures, or recovery of data already lost.
No GPU execution, personal-media manipulation or destructive recovery is required.
Tests use isolated synthetic files and assert original bytes survive rejected writes.

#16 and #17 are now on main and integrated with #14's take UI in this branch.
Combined tests cover reference metadata restart/rejection, preview and dirty-draft
retention across loading retries, and failed saves blocking take mutations without
replaying them on recovery. Retain the fail-closed loader and rerun these tests on
future updates; #14 remains pending human review/merge.