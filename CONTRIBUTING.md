# 贡献指南 / Contributing

[English](#english) | [中文](#中文)

---

## 中文

感谢想为 h3.c-studio 出一份力！本仓库是 [antirez/h3.c](https://github.com/antirez/h3.c) 的 fork，新增了一个 Web 工作台（`studio/`）。

### 仓库结构与协议

- **引擎**（根目录所有文件）：antirez 的 MIT 项目。**引擎逻辑修改请先向上游 [antirez/h3.c](https://github.com/antirez/h3.c) 提 PR**，本 fork 定期吸收上游更新与优秀的社区 PR。
- **Studio**（`studio/`）：Apache-2.0。**你的贡献主要应落在这里**——提交即表示你同意以 Apache-2.0 发布你的代码。

### 开发环境

```bash
# 引擎（需要 Apple Silicon Mac + FFmpeg）
make -j8

# Studio 前端
cd studio && npm install && npm run dev

# Studio 后端（FastAPI，dev 脚本会自动拉起）
# 或手动：uv venv server/.venv && uv pip install --python server/.venv/bin/python \
#   fastapi "uvicorn[standard]" pydantic python-multipart

# 后端单测（不需要真实 h3 引擎/模型权重，mock 了 subprocess）
cd studio/server
uv pip install --python .venv/bin/python pytest httpx
.venv/bin/pytest -v
```

模型权重（`MiniMax-H3/`）不进仓库，下载方式见根目录 [README-ENGINE.md](README-ENGINE.md)。

### 提交规范

- **前端**：`npm run build` 必须通过（含 tsc 类型检查）。UI 文案请走 `src/lib/i18n.tsx` 的字典（中英双语都要加）。
- **后端**：标准 PEP 8 风格即可；改动 `server/main.py` 请跑 `studio/server` 下的 `pytest -v`，新增接口在 `studio/server/tests/` 补对应用例；新增接口也请在 PR 描述里附 `curl` 验证结果。
- **CI**：push 前确保本地 `make -j8`、`npm run build` 和 `pytest`（在 `studio/server/` 下）通过——GitHub Actions 会跑同样的检查。
- **Commit message**：英文，一句话说明做什么 + 为什么；参考 git log 的现有风格。
- **大改动先开 issue 讨论**，避免方向性返工。

### PR 流程

1. Fork → 分支 → 提交 → 开 PR 到 `main`
2. PR 描述写清：动机、改动点、验证方式（截图/日志）
3. CI 全绿 + review 通过后合并（squash）

### 不会写代码也能贡献

- 试用并在 issue 里报告生成质量问题（附 seed/prompt/参数）
- 翻译界面（i18n 字典在 `studio/src/lib/i18n.tsx`）
- 改进文档与演示素材

---

## English

Thanks for contributing to h3.c-studio! This repo forks [antirez/h3.c](https://github.com/antirez/h3.c) and adds a web workbench (`studio/`).

### Layout & licensing

- **Engine** (everything at repo root): antirez's MIT project. **Send engine logic changes upstream to [antirez/h3.c](https://github.com/antirez/h3.c) first**; this fork periodically absorbs upstream updates and valuable community PRs.
- **Studio** (`studio/`): Apache-2.0. **Most contributions belong here** — by submitting, you agree to license your code under Apache-2.0.

### Dev setup

```bash
# Engine (Apple Silicon Mac + FFmpeg required)
make -j8

# Studio frontend
cd studio && npm install && npm run dev

# Studio backend (the dev script starts it automatically)
# Or manually: uv venv server/.venv && uv pip install --python server/.venv/bin/python \
#   fastapi "uvicorn[standard]" pydantic python-multipart

# Backend unit tests (no real h3 engine/model weights needed, subprocess is mocked)
cd studio/server
uv pip install --python .venv/bin/python pytest httpx
.venv/bin/pytest -v
```

Model weights (`MiniMax-H3/`) are not in the repo — see [README-ENGINE.md](README-ENGINE.md) for download instructions.

### Conventions

- **Frontend**: `npm run build` must pass (includes tsc type checking). UI strings go through the `src/lib/i18n.tsx` dictionary — add both Chinese and English.
- **Backend**: plain PEP 8; if you touch `server/main.py`, run `pytest -v` from `studio/server` and add matching cases under `studio/server/tests/` for new endpoints; also include `curl` verification output in your PR description for new endpoints.
- **CI**: make sure `make -j8`, `npm run build`, and `pytest` (from `studio/server/`) pass locally — GitHub Actions runs the same checks.
- **Commit messages**: English, one line on what + why; follow the existing git log style.
- **Open an issue before large changes** to avoid misdirected work.

### PR process

1. Fork → branch → commit → PR against `main`
2. Describe: motivation, changes, verification (screenshots/logs)
3. Merge (squash) after green CI + review

### Non-code contributions

- Report generation quality issues with seed/prompt/params
- Translate the UI (i18n dictionary: `studio/src/lib/i18n.tsx`)
- Improve docs and demo material
