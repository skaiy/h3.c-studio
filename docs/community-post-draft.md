# 发布帖草稿（拟发于 antirez/h3.c Issues）

**Title:**
`[Community] h3.c-studio — a bilingual web GUI for h3-metal`

**Body:**

---

Hi Salvatore & community — first of all, thank you for h3-metal. The clean public API in `h3.h` (frame/progress callbacks, cache control, the full `h3_params` surface) made it a joy to build on.

I've put together **h3.c-studio**, the first web GUI for h3-metal, as a fork that adds a `studio/` directory without touching the engine itself:

🔗 https://github.com/skaiy/h3.c-studio

**What it does**

- 🎛 **Prompt studio** — Scene / Action / Camera / Look / Audio structured editing (Context-IR style), canvas sizes, 1–15s duration, speed/quality presets, seed control
- 🖼 **Conditioning UI** — first/last frame anchors and ordered Ref2VA reference images with drag upload
- 📈 **Live progress** — per-phase progress bar (text encode → denoise → VAE decode) with streaming logs, cancellable jobs, serial GPU queue
- 🎞 **Clip library** — auto-indexed generation history with in-browser playback
- 🔗 **Chain last frame** — one click extracts any clip's last frame into the next generation's `--first-frame`, which makes the multi-shot storyboard workflow (validated in the README tutorial) practical
- 🌐 **i18n** — 中文 / English switch

**Stack**: React + TypeScript + Vite + Tailwind frontend, FastAPI backend wrapping the CLI (moving to a direct `libh3.a` binding is on the roadmap, since the public API already exposes everything needed for in-process previews).

**Licensing**: engine stays MIT © antirez, untouched; everything in `studio/` is Apache-2.0. Model weights are not included and the README links to the MiniMax community license.

**What's next**: this is very much a living experiment. I plan to keep evolving the studio — direct `libh3.a` binding for in-process live previews, a multi-shot storyboard board, prompt templates, maybe a job queue with presets — I honestly don't know how far it will go, but I want to try, and I'll keep shipping in the open.

Feedback, issues and PRs are very welcome — and if you'd ever like to link it in the README, I'd be honored. 🙇

---

**中文版**

首先感谢 h3-metal —— `h3.h` 里干净的公共 API（帧/进度回调、缓存控制、完整的 `h3_params`）让二次开发非常愉快。

我做了 **h3.c-studio**——h3-metal 的第一个图形界面，以 fork 方式新增 `studio/` 目录，引擎本体零改动：

🔗 https://github.com/skaiy/h3.c-studio

- 🎛 提示词工作室：五段式结构编辑、画幅/时长/预设/seed
- 🖼 条件输入：首尾帧锚点 + Ref2VA 参考图拖拽上传
- 📈 实时进度：分阶段进度条 + 日志流 + 任务队列
- 🎞 作品库 + 🔗 末帧接力（一键用上一条末帧做下一条首帧，多镜头叙事工作流）
- 🌐 中英双语

协议：引擎保持 MIT 不动，`studio/` 为 Apache-2.0；仓库不含模型权重。

后续计划：这会是一个持续更新的实验——直连 `libh3.a` 做进程内实时预览、多镜头分镜板、提示词模板库……说实话不知道最终会做成什么样，但想试一试，会持续在开源中迭代。

欢迎 issue / PR，如果 README 愿意收录链接，不胜荣幸 🙇
