# h3.c vs 其他视频生成框架：优劣势分析
# h3.c vs Other Video Generation Stacks: An Honest Comparison

[中文](#中文) | [English](#english)

---

## 中文

> 数据构成：M5 Max 128GB 一个月实测 + h3.c README 官方基准 + 2026-09 社区公开基准（SGLang 文档、MiniMax 官方集成索引、Spheron 实测）。最后更新：2026-09-14。

### 坐标系：比的是"H3 推理栈"，不是"视频模型"

h3.c 不是模型，是 MiniMax-H3 的**推理引擎**。真正的对比对象是同一模型的其他运行方式：

| 栈 | 定位 | 硬件门槛 | 实测参考 |
|---|---|---|---|
| **h3.c** | 纯 C+Metal 原生引擎 | 一台 128GB Apple Silicon Mac | 512² 20 步去噪 10.4s（实测）；4 步 3.5s |
| **SGLang Diffusion** | 数据中心服务化 | 4×H200 常驻 / 8×B200 参考 | 4×H200 端到端 74s（1344×768） |
| **ComfyUI**（官方原生） | 节点式工作流平台 | 量化版 ~24GB VRAM 起 | RTX 4090 约 250s/请求；Mac MPS 上 1 小时+ |
| **VDN**（OpenVDN） | 数据中心极限提速 | H200/B200 | 14.4s 片去噪 51s（B200）、11.2s（8×B200） |
| **MLX-H3** | MLX 框架移植 | ~70GB 统一内存 | pre-alpha，明显更慢 |
| **diffusers/vLLM** | 参考实现/服务化 | 同 SGLang 量级 | 研究基线 |

### 优势（按含金量排序）

1. **Apple Silicon 上唯一可用的满血路线**。ComfyUI 在 Mac 走 PyTorch MPS，同一片段 1 小时以上；h3.c 是秒到分钟级，差 2–3 个数量级。MLX-H3 仍是 pre-alpha。Mac 上跑 H3 没有第二个选择。
2. **零依赖部署**。`make -j8` 出单二进制；没有 Python / PyTorch / CUDA / conda 环境地狱。
3. **直接吃原始 BF16 权重，无量化折损**。ComfyUI 的 24GB 路线必须 pruned INT8 + NVFP4（有损，且社区报告过 ConvRot 布局导致的语义错乱 bug）；h3.c 用官方原版 checkpoint，每条数值路径标注了与 MLX oracle 的相对 L2 误差并附 `make parity` 对拍测试。int8 是可选加速，不是被迫妥协。
4. **大师级内存工程**。统一内存零拷贝权重映射、分阶段加载（33B DiT 与 32B 文本编码器永不同时驻留）、SSD streaming（DiT 驻留 36.5→2.0 GiB，读速 13–14.6 GB/s）。同参数量 BF16 在 NVIDIA 上要 4×H200。
5. **可嵌入性**。MIT + 194 行干净 C API（帧/进度回调、缓存常驻、完整参数面）。ComfyUI 是平台，h3.c 是引擎——后者才能塞进自己的产品（本仓库的 Studio 就是证明）。
6. **原生音频完整链路**。BigVGAN / AudioVAE 原生 Metal 实现，音视频同炉生成；很多量化路线音频是残缺或后补的。

### 劣势（按影响排序）

1. **平台锁定 Apple Silicon**。CUDA 为零（社区在自救：PR #43 CUDA 后端、#20–24 cuBLAS 系列，均未合并）。
2. **生态薄——与 ComfyUI 的最大差距**。无节点工作流、无 ControlNet、无 LanPaint 局部重绘、无 Motion-Context 长视频块链、无 Director 模板、无 LoRA 运行时（Turbo 需折叠进权重）。
3. **无服务化**。单请求、单设备、无 OpenAI 兼容 API、无并发、无多卡。数据中心服务请用 SGLang/VDN。
4. **分辨率与官方完整工作流缺失**。上限 768p；H3-Context-IR 与 Regenerate-2K 仅 MiniMax 托管 API 提供（所有本地栈都缺）。
5. **Mac 阵营内门槛也不低**。舒适起点 128GB 统一内存 + ~300GB 磁盘；64GB 机型需 SSD streaming 换时间。
6. **项目成熟度**。2026-08-10 发布，单人主导、API 仍在演进；不保证与 PyTorch/MLX 逐位一致；测试覆盖天然薄于 PyTorch 栈。
7. **模型 license 地域限制随之继承**（美/欧/英/韩排除本地部署）——选任何栈前都要先过这关。

### 选型结论

| 你是谁 | 选什么 |
|---|---|
| Mac 用户想本地跑 H3 | **h3.c，没有备选** |
| 要在 Mac 上做产品/工具 | **h3.c + 自研 UI**（引擎可嵌入是决定性优势） |
| NVIDIA 单卡玩家（24–48GB） | ComfyUI 量化路线，接受画质折损换生态 |
| 要工作流编排（ControlNet / inpaint / 长视频） | ComfyUI |
| 数据中心 API 服务 | SGLang / VDN（h3.c 不在赛场内） |
| 数值参考 / 研究基线 | 官方 diffusers |

**给社区 fork 的启示**：别和 ComfyUI 拼节点生态；补「引擎能力强但 CLI 门槛高」的 Mac 原生工作流（分镜板、断点续跑、Turbo 预设的界面化）才是差异化护城河。

---

## English

> Sources: one month of hands-on benchmarking on an M5 Max 128GB, the h3.c README's official figures, and public community benchmarks as of 2026-09 (SGLang docs, MiniMax's official integration index, Spheron's measurements). Last updated: 2026-09-14.

### Frame of reference: this compares H3 *inference stacks*, not video models

h3.c is not a model — it is an **inference engine** for MiniMax-H3. The real comparison is against other ways of running the same model:

| Stack | Role | Hardware floor | Reference numbers |
|---|---|---|---|
| **h3.c** | Pure C+Metal native engine | One 128GB Apple Silicon Mac | 512² 20-step denoise 10.4s (measured); 3.5s at 4 steps |
| **SGLang Diffusion** | Datacenter serving | 4×H200 resident / 8×B200 reference | 74s end-to-end on 4×H200 (1344×768) |
| **ComfyUI** (official native) | Node-based workflow platform | ~24GB VRAM with quantized checkpoints | ~250s/request on RTX 4090; 1h+ on Mac MPS |
| **VDN** (OpenVDN) | Datacenter speed record | H200/B200 | 14.4s clip denoise: 51s (B200), 11.2s (8×B200) |
| **MLX-H3** | MLX-framework port | ~70GB unified memory | pre-alpha, markedly slower |
| **diffusers/vLLM** | Reference impl / serving | SGLang-class | Research baseline |

### Strengths (ranked by weight)

1. **The only viable full-quality route on Apple Silicon.** ComfyUI on Mac MPS takes 1h+ for what h3.c does in seconds-to-minutes — a 2–3 order-of-magnitude gap. MLX-H3 is pre-alpha. On a Mac there is no second choice.
2. **Zero-dependency deployment.** `make -j8` yields a single binary; no Python/PyTorch/CUDA/conda hell.
3. **Runs the original BF16 checkpoints — no forced quantization.** ComfyUI's 24GB path requires pruned INT8 + NVFP4 (lossy, and the community hit ConvRot-layout semantic bugs); h3.c consumes the official checkpoints, documents relative-L2 error against the MLX oracle per path, and ships `make parity`. int8 is an optional accelerator, not a compromise.
4. **Master-class memory engineering.** Zero-copy file-backed weight mapping on unified memory, phase-separated loading (33B DiT and 32B text encoder never co-resident), SSD streaming (DiT residency 36.5→2.0 GiB at 13–14.6 GB/s). The same BF16 footprint needs 4×H200 in NVIDIA-land.
5. **Embeddability.** MIT license plus a clean 194-line C API (frame/progress callbacks, cache residency, full parameter surface). ComfyUI is a platform; h3.c is an engine — only the latter can be embedded into a product (this repo's Studio is the proof).
6. **Complete native audio pipeline.** BigVGAN / AudioVAE in native Metal, audiovisual generation in one pass; many quantized routes ship audio incomplete or bolted-on.

### Weaknesses (ranked by impact)

1. **Apple Silicon only.** Zero CUDA (community attempts — PR #43's CUDA backend, #20–24 cuBLAS series — are unmerged).
2. **Thin ecosystem — the biggest gap vs ComfyUI.** No node workflows, no ControlNet, no LanPaint inpainting, no Motion-Context long-video chaining, no Director templates, no LoRA runtime (Turbo must be folded into the weights).
3. **No serving story.** Single request, single device, no OpenAI-compatible API, no concurrency, no multi-GPU. For datacenter APIs use SGLang/VDN.
4. **Resolution and full hosted workflow missing.** 768p ceiling; H3-Context-IR and Regenerate-2K are hosted-API exclusives (missing from every local stack).
5. **Non-trivial floor even within the Mac camp.** Comfortable baseline is 128GB unified memory + ~300GB disk; 64GB machines trade time via SSD streaming.
6. **Maturity.** Released 2026-08-10, single lead author, API still evolving; no bit-exact guarantee vs PyTorch/MLX; thinner test coverage than PyTorch stacks by nature.
7. **The model license's territorial restrictions are inherited** (US/EU/UK/KR excluded from local deployment) — a gate for every stack.

### Verdict

| You are | Choose |
|---|---|
| A Mac user who wants local H3 | **h3.c — no alternative** |
| Building a product/tool on Mac | **h3.c + your own UI** (embeddability is decisive) |
| An NVIDIA single-GPU hobbyist (24–48GB) | ComfyUI quantized path; trade quality for ecosystem |
| Workflow orchestration (ControlNet / inpaint / long video) | ComfyUI |
| Datacenter API serving | SGLang / VDN (h3.c is not in this race) |
| Numerical reference / research baseline | Official diffusers |

**Note for community forks**: don't fight ComfyUI on node ecosystems. The defensible niche is Mac-native workflows that surface engine strengths locked behind the CLI — storyboards, resumable checkpoints, Turbo presets — as UI. That is exactly what this repository is doing.
