# h3.c-studio

[English](#english) | [中文](#中文)

---

## 中文

**H3 Studio — [antirez/h3.c](https://github.com/antirez/h3.c)（MiniMax-H3 Apple Silicon 原生推理引擎）的首个图形界面。**

本仓库是 h3.c 的 fork，在原引擎基础上增加了 `studio/` Web 工作台：提示词工作室、条件输入管理（首帧/尾帧/参考图）、实时生成进度、作品库与「末帧接力」分镜工作流，中英双语界面。

> 引擎本体（根目录全部文件）仍为 antirez 的 MIT 项目，未做任何功能修改；我们只做加法。详见 [NOTICE](NOTICE)。

### 功能

<video src="https://github.com/skaiy/h3.c-studio/raw/main/docs/media/h3-studio-demo.mp4" controls muted width="800"></video>

| 统一工作台 · Unified Workspace | 分镜板切换 · Board Switcher |
|---|---|
| ![统一工作台](docs/media/workspace.jpg) | ![分镜板切换](docs/media/board-switcher.jpg) |


- 🎛 **提示词工作室**：Scene / Action / Camera / Look / Audio 五段式编辑，6 种画幅，1–15 秒时长，4 档速度/画质预设，seed 控制
- 🖼 **条件输入**：首帧 / 尾帧锚点、多张参考图（Ref2VA），拖拽上传
- 📈 **实时进度**：分阶段进度条（文本编码 → 去噪 → VAE 解码）+ 日志流，可取消任务
- 🎞 **作品库**：自动索引生成历史，点播播放，支持删除（二次确认）
- 🔗 **末帧接力**：一键抽取任意视频末帧作为下一条的首帧，实现多镜头连贯叙事
- 🎬 **分镜板**：多镜头卡片序列 + 自动末帧接力链 + 一键无损拼接导出，多镜头叙事点几下就完成
- 🌐 **i18n**：中文 / English 一键切换

### 引擎增强（已吸收的上游社区 PR）

- **Turbo LoRA 折叠**（#14）：`tools/fold_turbo_lora.py` 将 5–6 步蒸馏采样直接烘焙进 checkpoint，提速 3–4 倍（Studio 内置「Turbo 6 步 ⚡」预设，一键切换折叠后的模型目录）
- **断点续跑**（#2）：`--checkpoint` / `--resume` 长视频中途暂停出草稿、随时续跑
- **进度与健壮性**：VAE 解码阶段进度上报（#35）、管道模式即时 flush（#62）、RGB 有限值保护（#9）、iPhone .mov 兼容（#31）

### 深度阅读

- [h3.c vs 其他视频生成框架：优劣势分析](docs/h3c-vs-other-stacks.md)——和 SGLang / ComfyUI / VDN / MLX-H3 怎么选

### 快速开始

```bash
# 1. 构建引擎（需要 Apple Silicon Mac + FFmpeg）
make -j8

# 2. 下载模型权重到 ./MiniMax-H3（约 268GB，两套 checkpoint）
#    参考根目录 README.md 的说明

# 3. 启动 Studio
cd studio
npm install
uv venv server/.venv && uv pip install --python server/.venv/bin/python \
  fastapi "uvicorn[standard]" pydantic python-multipart
npm run dev        # 自动拉起 FastAPI 后端(:8765) + Vite 前端
```

打开 Vite 输出的地址（默认 http://localhost:3000）即可使用。

### 协议

- 引擎（根目录）：MIT © antirez（见 [LICENSE](LICENSE)）
- Studio（`studio/`）：Apache-2.0 © skaiy（见 [studio/LICENSE](studio/LICENSE)）
- 模型权重不包含在本仓库中，受 MiniMax H3 Community License 约束（含地域限制），下载前请阅读模型卡

---

## English

**H3 Studio — the first GUI for [antirez/h3.c](https://github.com/antirez/h3.c), the native Apple Silicon inference engine for MiniMax-H3.**

This repository forks h3.c and adds a `studio/` web workbench: a prompt studio, conditioning management (first/last frame + reference images), live generation progress, a clip library, and a "chain last frame" storyboard workflow. Bilingual UI (中文 / English).

> The engine itself (everything at repo root) remains antirez's MIT project, unmodified — we only add on top. See [NOTICE](NOTICE).

### Features

<video src="https://github.com/skaiy/h3.c-studio/raw/main/docs/media/h3-studio-demo.mp4" controls muted width="800"></video>

| Unified Workspace | Board Switcher |
|---|---|
| ![Unified Workspace](docs/media/workspace.jpg) | ![Board Switcher](docs/media/board-switcher.jpg) |


- 🎛 **Prompt studio**: Scene / Action / Camera / Look / Audio structured editing, 6 canvas sizes, 1–15s duration, 4 speed/quality presets, seed control
- 🖼 **Conditioning**: first/last frame anchors and multiple Ref2VA reference images with drag upload
- 📈 **Live progress**: per-phase progress (text encode → denoise → VAE decode) with log stream and cancellable jobs
- 🎞 **Clip library**: automatic history indexing, click-to-play, deletable (two-step confirm)
- 🔗 **Chain last frame**: extract any clip's last frame as the next generation's first frame for coherent multi-shot storytelling
- 🎬 **Storyboard**: multi-shot cards + automatic last-frame chaining + one-click lossless concat export
- 🌐 **i18n**: one-click 中文 / English switch

### Engine enhancements (absorbed upstream community PRs)

- **Turbo LoRA folding** (#14): `tools/fold_turbo_lora.py` bakes 5–6 step distilled sampling into the checkpoint for a 3–4x speedup (Studio ships a one-click "Turbo 6-step ⚡" preset wired to the folded model dir)
- **Resumable checkpoints** (#2): `--checkpoint` / `--resume` pauses long renders with a sigma-zero draft and continues later
- **Progress & robustness**: VAE decode progress reporting (#35), immediate pipe flush (#62), finite-RGB guard (#9), iPhone .mov tolerance (#31)

### Further reading

- [h3.c vs other video generation stacks](docs/h3c-vs-other-stacks.md) — how to choose between h3.c, SGLang, ComfyUI, VDN and MLX-H3

### Quick start

```bash
# 1. Build the engine (Apple Silicon Mac + FFmpeg required)
make -j8

# 2. Download the MiniMax-H3 weights into ./MiniMax-H3 (~268GB)
#    See the root README.md for details

# 3. Start the studio
cd studio
npm install
uv venv server/.venv && uv pip install --python server/.venv/bin/python \
  fastapi "uvicorn[standard]" pydantic python-multipart
npm run dev        # boots FastAPI backend (:8765) + Vite frontend
```

Open the Vite URL (default http://localhost:3000).

### Licensing

- Engine (repo root): MIT © antirez — see [LICENSE](LICENSE)
- Studio (`studio/`): Apache-2.0 © skaiy — see [studio/LICENSE](studio/LICENSE)
- Model weights are NOT included and are governed by the MiniMax H3 Community License (with territorial restrictions) — read the model card before downloading
