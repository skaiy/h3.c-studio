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
```

Studio 后端（FastAPI）的安装见 [快速开始](README.md#快速开始)，dev 脚本会自动拉起。

后端单测（另开终端，从仓库根目录开始；不需要真实引擎/模型权重，mock 了 subprocess）：

```bash
cd studio/server
uv pip install --python .venv/bin/python pytest httpx
.venv/bin/pytest -v
```

模型权重（`MiniMax-H3/`）不进仓库，下载方式见根目录 [README-ENGINE.md](README-ENGINE.md)。

### 提交规范

- **前端**：在 `studio/` 运行 `npm test`、`npm run lint`、`npm run i18n:check` 和 `npm run build`（含 tsc 类型检查）；为改动补回归测试。
- **i18n**：源字典在 `studio/src/lib/i18nData.ts`（语言列表、基础中文与类型）和 `studio/src/lib/i18nResources.ts`（扩展文案及翻译），不是 `i18n.tsx`。新增文案覆盖 zh/en/ja/ko/de 五语言。
- **后端**：标准 PEP 8；改动后运行上述 `studio/server` 单测，为接口与请求生命周期在 `studio/server/tests/` 补用例；PR 附脱敏验证结果，不贴令牌或个人素材。
- **验证边界**：默认使用 mock、临时数据和小型媒体 fixture；真实 GPU 生成、模型下载或长时间任务必须另获明确许可。引擎改动另跑 `make -j8`；不要为验证触碰个人项目数据。
- **Commit message**：英文，一句话说明做什么 + 为什么；参考 git log 的现有风格。
- **大改动先开 issue 讨论**，避免方向性返工。

### PR 流程

1. 用户已确认分支约定：修复用 `fix/<issue>-slug`，功能用 `feat/<issue>-slug`（`<issue>` 为 issue 编号）；所有 PR 只以 `main` 为目标。
2. 按[本地个人工作流路线图](docs/local-personal-workflow.md)拆分；依赖 PR **合并后**再从更新的 `main` 开发并提交下游代码 PR，避免重复 diff；不以依赖分支为 PR 目标。
3. PR 描述关联 issue，写清动机、改动点、验收结果与未验证项（截图/脱敏日志）。push 后检查 CI 状态。
4. CI 全绿 + review 通过后，由**人类维护者**合并（squash）；agent 不执行合并。

### 不会写代码也能贡献

- 试用并在 issue 里报告生成质量问题（附 seed/prompt/参数）
- 翻译界面（字典：`studio/src/lib/i18nData.ts` / `studio/src/lib/i18nResources.ts`，共五语言）
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
```

See [Quick start](README.md#quick-start) to install the FastAPI backend; the dev script starts it automatically.

Backend unit tests (new terminal, starting at the repo root; no real engine/model weights, subprocess is mocked):

```bash
cd studio/server
uv pip install --python .venv/bin/python pytest httpx
.venv/bin/pytest -v
```

Model weights (`MiniMax-H3/`) are not in the repo — see [README-ENGINE.md](README-ENGINE.md) for download instructions.

### Conventions

- **Frontend**: from `studio/`, run `npm test`, `npm run lint`, `npm run i18n:check` and `npm run build` (includes tsc); add regression coverage for changes.
- **i18n**: source dictionaries are `studio/src/lib/i18nData.ts` (languages, base Chinese and types) and `studio/src/lib/i18nResources.ts` (extended strings and translations), not `i18n.tsx`. Add new strings in all five languages: zh/en/ja/ko/de.
- **Backend**: plain PEP 8; run the `studio/server` tests above and cover endpoints and the request lifecycle under `studio/server/tests/`. Include sanitized verification results in PRs, never tokens or personal media.
- **Validation boundary**: default to mocks, temporary data and small media fixtures. Real GPU generation, model downloads and long jobs need separate explicit opt-in. Run `make -j8` for engine changes; do not touch personal project data to validate work.
- **Commit messages**: English, one line on what + why; follow the existing git log style.
- **Open an issue before large changes** to avoid misdirected work.

### PR process

1. User-confirmed branch convention: `fix/<issue>-slug` for fixes, `feat/<issue>-slug` for features (`<issue>` is the issue number). **All PRs target `main` only.**
2. Follow the [local personal workflow roadmap](docs/local-personal-workflow.md). Dependency PRs must **merge first**; then develop and open downstream code PRs from updated `main` to avoid duplicated diffs. Do not target a dependency branch.
3. Link the issue; describe motivation, changes, acceptance results and unverified items (screenshots/sanitized logs). Check CI status after pushing.
4. A **human maintainer** merges (squash) after green CI + review. Agents never merge.

### Non-code contributions

- Report generation quality issues with seed/prompt/params
- Translate the UI (five-language dictionaries: `studio/src/lib/i18nData.ts` / `studio/src/lib/i18nResources.ts`)
- Improve docs and demo material
