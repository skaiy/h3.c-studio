# 本地个人视频工作流 / Local personal video workflow

2026-09-15 · 用户已确认方向：本机、个人项目、先可靠生成，再复用与轻量剪辑。

**Status (2026-09-16):** #7, #8 backend PR A (#13) and UI PR B (#14), #9 backend PR A (#16), and #15 startup recovery protection (#17) are merged; `main` at `1a1d35f` includes #14/#16/#17. #9 frontend PR B is implemented in this branch, pending human review/merge, with no backend changes in this PR. #10–#11 are not delivered. GitHub tracks current merge status; no real-browser or GPU validation is claimed for this reference UI, nor real GPU validation of Song Storyboard.

## 路线图与 PR 依赖 / Roadmap & dependencies

| Issue | 状态 | 范围与 PR 拆分 | 前置依赖 |
|---|---|---|---|
| [#7 · P0](https://github.com/skaiy/h3.c-studio/issues/7) | 已合并 | 输入/结构化提示词持久化、单条/批量共用请求构建与预检、按原任务安全续跑 | 当前可靠性基础；不含 take 选择 |
| [#8 · Local takes](https://github.com/skaiy/h3.c-studio/issues/8) | A (#13)、B (#14) 均已合并 | A：后端 take schema、旧数据迁移与选择 API；B：比较/采用 UI、下游连续性警告 | #7、A、B 已合并到 main |
| [#9 · Local reference sets](https://github.com/skaiy/h3.c-studio/issues/9) | A (#16) 已合并；B 本分支实现，待人工评审/合并 | A：本地 assets/参考集 API；B：项目内管理、导入、有序编辑、选择/显式应用与历史参考快照 UI | 基于 main `1a1d35f`，已含 #14/#16/#17；本 PR 不改后端 |
| [#10 · Lightweight edit/export](https://github.com/skaiy/h3.c-studio/issues/10) | 规划中 | A：edit manifest、后端导出与 fixture 测试；B：最小 trim/配乐 UI | #7、#8 的选定 take 语义合并；B 等 A 合并 |
| [#11 · Song Storyboard](https://github.com/skaiy/h3.c-studio/issues/11) | 规划中，仅可行性实验 | 小型离线切段/对齐原型，记录实验结果后再决定产品 UI | 先 #7；产品化前需 #9 参考集与 #10 基础导出契约 |

- #7 是共同前置；#8 与 #9 不必人为串行，但涉及共享数据契约时先明确依赖，避免重复实现。
- 分支遵循用户确认的 `fix/<issue>-slug` / `feat/<issue>-slug`；**所有 PR 只到 `main`**。
- 依赖 PR 必须先合并，再从更新的 `main` 开发并提交下游代码 PR，避免重复 diff；不提交堆叠的依赖代码 PR。
- CI 与 review 通过后由人类维护者合并，agent 不合并。具体贡献流程见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 目标与边界 / Scope

目标闭环：保存镜头输入 → 可靠生成/续跑 → 比较并采用本地 take → 复用参考集 → 非破坏性剪辑/配乐 → 可追溯导出。

先做个人项目内复用，不做云账号、协作、全球素材平台、模型训练或完整多轨 NLE。参考集不保证身份/口型一致；本地 take 比较不是模型级 Retake。保持原引擎边界，不以路线图承诺无缝长视频。

## 数据契约 / Data contracts

以下是跨 PR 的设计约束；实际可用性以状态表和 GitHub 合并状态为准，#9 后端 schema 已合并，#10 仍是规划 schema。

### #7：镜头输入与原任务续跑

- 保存镜头的最终 prompt、`prompt_mode`、五个 `prompt_fields`、有序 `ref_images`/`ref_audio`、首尾帧及支持的生成选项（含 seed、frames、token reduction、checkpoint）。结构化字段是编辑元数据，最终 prompt 是生成依据。
- 单条与批量从已保存镜头走同一个后端请求构建器和 preflight；排队时固定请求，执行前复查文件。Ref2VA 跳过自动 FL2VA 末帧接力并提示；显式首尾帧与参考输入冲突时在排队前拒绝，不静默清空素材。
- 续跑只使用原 job 的请求快照、checkpoint 和原 board/shot 身份，不读取当前 UI 选中镜头的参数。原目标缺失、被替换或已归属其他任务时拒绝回写，不重定向到别的镜头。
- 旧 board 保持可读；无结构化字段时保留原 prompt，不猜测拆分。保存失败必须可见，切镜头/切板/轮询不能覆盖未保存编辑。

### #8：不可变 take 与选择

- 成功 take 保存不可变的 `id`、`shot_id`、`job_id`、`output`、`created_at` 和原始请求快照：prompt、条件输入、seed，以及可取得的引擎/模型元数据。后续修改镜头输入不能改写历史快照。
- `selected_take_id` 是镜头当前采用版本的唯一依据：预览、连续播放、拼接/导出、下游接力均使用它。迁移期间 `shot.output` 仅作兼容投影，不作为另一份独立选择状态。
- 接力生成记录 `source_take_id`，指向真正提供首帧的上游 take，不能只记录可复用的文件名。上游选择变更使相关下游镜头标记 stale 并提示；不自动重生成、不自动消耗 GPU。
- 旧 output 导入为一个 legacy take；无法从历史记录确认的参数/来源明确标为 unknown，不拿当前镜头参数补写，不伪造可复现性。无接力来源与“历史来源未知”必须可区分。
- 失败/中断属于 job 历史，不冒充成功 take。失败重试保留旧 take 和选择；选择操作不能排队生成，运行中任务完成也不能静默覆盖用户选择。
- 复制 board/shot 时明确新身份与 take/来源映射；丢失媒体进入缺失/修复状态，不暗中采用其他 take。删除涉及引用时必须有显式处理策略，不能连带删除个人源素材。
- 后端 PR A (#13) 已合并，提供镜头 take 列表、bodyless 采用和元数据删除端点；采用返回整板最新投影与连续性状态。删除 take 不删除视频文件，已采用或被 take/job 历史引用的版本返回冲突。
- 前端 PR B (#14) 已合并：右侧版本历史按生成顺序浏览，展开只读参数快照；播放仅临时预览，采用先保存草稿再调用选择接口，不改 prompt、不生成。返回已采用版本后继续跟随 canonical 选择；旧异步响应不抢占新预览。运行/排队时禁用修改；stale/unknown 显示文字说明，缺失的采用文件阻止连续预览/拼接而非跳过。元数据删除经确认且不删除原片；媒体库删除使用鉴权接口并显示引用冲突。

### #9：本地 assets 与参考集快照

- Asset 使用稳定 ID、受管理的本地文件名、媒体类型、可取得的大小/时长。可移植 manifest 不写绝对路径；校验路径，媒体探测限时。
- Reference set 保存 `id`、名称、kind、**有序**图像/音频 asset IDs、可选 notes 与 revision。
- 应用参考集时复制明确的素材引用快照并记录来源集 ID/revision，**不是 live alias**。编辑参考集不能改变已应用镜头、排队请求或历史 take；更新需显式重新应用。
- 历史请求保留稳定素材引用；替换素材应产生新身份，不能用同一别名悄悄指向新文件。缺失媒体显示修复提示：恢复完全相同的原件，或导入新身份、更新参考集并显式重新应用；无破坏性原地 relink，不删除源媒体。
- 应用前展示 Ref2VA/FL2VA 冲突；不静默清空用户原条件输入，不上传外部服务。
- B 已实现本分支 UI：顶部管理入口在无镜头时也可用；本地图片/音频导入（每文件 ≤256 MiB），按名称/kind 创建参考集并排序（1–9 张图、0–3 段音频，单段 2–15 秒、合计 ≤15 秒）。保存不应用；镜头选择后显式应用，不同已有参考须确认覆盖，首尾帧锚点须先手动移除。已应用镜头显示冻结旧修订，版本历史显示只读参考快照；编辑后须显式重新应用。
- 409 冲突、参考变更落盘失败（500）或启动恢复保护（503）保留草稿、原修订和选择，不自动重放写入。「重试加载」恢复读取，不丢草稿也不重做应用；参考集编辑器的「放弃编辑并加载最新修订」须确认且会丢弃该编辑草稿。不要刷新浏览器来处理未保存草稿。现有 token 仅保护写操作，读取/媒体仍公开；仅供本机个人使用，不保证身份或口型一致。
- A 的具体接口、复制/修复边界与 B 的中英操作指南见 [reference-sets-api.md](reference-sets-api.md)：以 board 为项目，登记时独立复制并校验内容指纹，应用固定来源版本；本 PR 不改后端。软末帧接力仍只属 #11 实验规划。

### #10：edit manifest 与固定 take 的导出

- 非破坏性 edit manifest 保存有序 cut list、每段 take 引用及 in/out、片段原声音量/静音、一个连续项目配乐及其对齐信息；保存/重启保留编辑意图，原视频/音频不变。
- 预览与导出消费同一 manifest 语义；开始导出时创建不可变快照，固定选定的 take IDs、素材引用、剪切点、音频与输出设置。中途换选择不能改变正在导出的内容。
- 镜头选择或编辑变更使旧导出结果标记过期，不能把旧拼接结果当成当前预览。缺失 take/素材、越界剪切和不兼容设置在长任务开始前报错。
- 探测实际 streams/时长：仅兼容的流允许 stream-copy；精确剪切、混音或重排格式需明确报告重编码路径，不一概承诺无损。
- FFmpeg 导出作为可取消 job，具有一致的进度与终态错误，不覆盖源文件。Manifest/EDL + 素材交给外部 NLE 可后续考虑，不属于首个剪辑 PR。

## 验收门槛 / Acceptance gates

这些是合并前必须提供的证据，不是已通过声明。默认使用隔离临时数据、mock subprocess 和小型媒体 fixture，不触碰个人项目。

| 工作项 | 最小验收证据 |
|---|---|
| #7 | 保存 → 读取 → 复制 → 后端重启保留输入；切镜头/模式与轮询不丢编辑；单条/批量请求与预检一致；引用/接力冲突可见；续跑保留原请求且不误写目标；缺失文件/准备失败进入终态、不阻塞队列 |
| #8 | 两次生成后采用旧 take，重载/重启仍用同一版本预览与导出；失败重试保留旧片；上游切换产生下游警告且不生成；运行中选择不被覆盖；覆盖复制、缺失/删除媒体 |
| #9 | 多镜头应用同一有序参考集，保存/复制/重启不丢引用；修改参考集不变更已应用/排队/历史请求；冲突提示、路径校验和限时探测有测试 |
| #10 | 三段 fixture 经 trim/重排/配乐后，用 ffprobe + 媒体测试核对顺序、时长、音频；预览/导出一致；保存重启、过期结果、缺失媒体、取消/失败和原件不变有覆盖 |
| #11 | 无 GPU 的切段/对齐测试先通过；真实实验另获许可，报告可追溯结果与失败案例后才决定产品化 |

- 前端/API 回归必须覆盖用户请求生命周期，不只测试 CLI flag。涉及 UI 的改动覆盖 zh/en/ja/ko/de 五语言。
- 在 `studio/` 运行 `npm test`、`npm run lint`、`npm run i18n:check`、`npm run build`；后端在 `studio/server/` 运行 `.venv/bin/pytest -v`（安装见贡献指南）。PR 记录实际命令、退出码、结果及未验证部分；失败不能写成通过。
- 引擎硬约束以实际源码为准：参考数量、音频规则、Ref2VA/FL2VA 互斥；音频用限时 ffprobe 检查。社区对 token reduction + 音频的经验警告应与硬性拒绝规则区分。
- **未经单独明确 opt-in，不运行真实 GPU 生成、模型下载或昂贵长任务。** 新外部依赖须另获批准；不自动云上传、不暴露凭据。

本分支验证（2026-09-16）：435 项前端测试、383 项后端测试，以及 build、lint、i18n 检查均通过。前端使用 mocked HTTP/jsdom，并非真实浏览器；后端包含可用时运行的小型真实 PNG/WAV 媒体测试。它们不证明真实 GPU 生成质量、身份一致或口型同步。

## #11：有界 Song Storyboard 实验

2026-09-16 经用户同意吸收 [Henninges 的建议](https://github.com/antirez/h3.c/issues/65#issuecomment-5681191815)，作为后续实验，不打乱 #8 → #9 → #10 主线。对方报告的单条 10 秒 take 稳定性不是跨段验证；本项目自动化测试也不是音频提示词/token reduction 的真实 GPU 实测。

1. **离线先行**：使用用户拥有/获授权的 30–45 秒音频，先手工指定乐句/停顿边界。当前每条参考音频 2–15 秒、每次请求参考音频合计不超过 15 秒；短尾段和超长乐句显式处理，不静默丢弃。保存原曲采样级起止、切片身份、输出帧数/实际时长，测试边界取整与累计漂移。
2. **获准后做小型 A/B**：起步三个片段，A 组固定有序角色参考集＋各段音频；B 组在相同基础上追加经确认的上一段末帧作为 `--ref-image`，绝不作为 `--first-frame`。预先约定生成/重试预算，固定模型与其他设置；这是软视觉引导，不保证匹配起始像素或平滑接缝。
3. **软接力安全**：为额外参考图预留容量，不静默替换角色参考。记录派生帧的 asset、source take、帧/时间与用途；上游采用变更只标记下游过期。当前硬首帧 `source_take_id` 逻辑不足以覆盖此依赖，自动软接力须先补契约。背身/变形末帧可能传播错误，保留失败样本，不只选好结果。
4. **分别评估**：段内与跨段身份、姿态偏移、口型、视觉接缝及音画累计漂移。比较生成分段音频与完整原曲 master；不默认交叉淡化，但必要修复需记录，回贴原轨不保证口型同步。唱/说措辞、非英语语音、token reduction/audio 另做控制变量实验，不从个例推出通用保证或硬性禁用。
5. **导出边界**：限时 ffprobe 检查 streams、编码、time base、采样率和声道；只对兼容完整片段 stream-copy。任意裁切、crossfade、混音可能重编码；`-c copy` 不修复视觉/口型接缝，也不能一概保证任意帧精确剪切。
6. **结论再产品化**：报告 wall time、可取得的峰值内存、accepted-take ratio、测得漂移、重编码路径及失败案例。身份/时序不达标就报告边界，不宣称无缝超过 15 秒生成。对方若建立音乐视频跟踪 issue，在 #11 链接协作；不替对方承诺交付，不把未执行实验写成已通过。

## 官方学习材料 / Learning sources

下列仅为官方产品材料中的交互/工作流参考，**不是亲手使用后的测评或 hands-on benchmarks**，也不能证明本地 h3.c 的质量、速度或功能等价。

| 来源 | 学习方向（不承诺对等实现） |
|---|---|
| [Google Flow](https://blog.google/innovation-and-ai/products/veo-updates-flow/) | 素材复用与连续镜头组织，参考 #9 的本地参考集思路 |
| [LTX Studio tutorial](https://ltx.io/blog/ltx-studio-tutorial) | 分镜迭代、选片与 Elements 复用，参考 #8/#9 的个人项目闭环 |
| [Adobe Firefly AI video editor](https://www.adobe.com/products/firefly/features/ai-video-editor.html) | 生成后的编排与轻量剪辑，参考 #10 的范围边界 |
| [Runway Edit Studio](https://help.runwayml.com/hc/en-us/articles/51683104370451-Creating-with-Edit-Studio) | 编辑意图与素材衔接的交互参考，不据此承诺模型级视频编辑 |

Song Storyboard 另受 [Henninges/h3-studio](https://github.com/Henninges/h3-studio) 的音乐视频工作流启发；实验结论必须来自本项目获准执行后的可追溯证据。