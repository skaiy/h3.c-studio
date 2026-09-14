# H3 Studio v0.2 终版 IA：统一工作区 + 多板管理 + 设置面板
# H3 Studio v0.2 Final IA: Unified Workspace + Multi-Board + Settings Panel

[中文](#中文) | [English](#english)

---

## 中文

> 取代二元「工作室 / 分镜板」分割。核心命题：**分镜板是唯一的文档，镜头是唯一的对象，属性面板跟随选中，作品库是全局产物。**
> 调研基础：LTX Studio（统一工作区 vs Runway 分离工作区的成败对照）、Runway（Session 时间线、Director Mode 参考图锚定）、Notion/Figma（文档切换与深链）、Linear（自动保存状态点）。

### 〇、从两个商业产品学到的四条

1. **LTX 胜在"一个项目里做完一切"**：LTX 对 Runway 的最大攻击点正是 Runway 把生成、分镜、剪辑拆成多个 workspace 来回跳。我们 v0.1 的"工作室/分镜板"分割犯的是同一个错误——统一工作区是被验证过的正确答案。
2. **镜头级重生成（regenerate only that slice）**：LTX 允许点任何一个场景缩略图、改 prompt、只重跑这一镜，其余不动。这是分镜工作流的最高频操作，必须有。
3. **场景卡像索引卡一样拖拽排序**（LTX timeline / Runway session）：序列编排是肌肉记忆级交互，原生 HTML5 drag 即可实现，不上库。
4. **重技术藏在简单开关后面**（LTX 的 "Quality" toggle）：我们的 Turbo/步数/层数参数对普通用户是噪声——预设卡继续保留，高级参数折叠。

### 一、信息架构

```
┌────────────────────────────────────────────────────────┐
│ H3 STUDIO │ [雨巷·深处 ▾] │ ●已保存 │ ⚙ │ 0 任务活动    │
├─────────┬───────────────────────────────┬──────────────┤
│ 镜头条   │  预览区                        │ 镜头检查器    │
│ ┌──┐    │  · 选中镜头回放                 │ PROMPT        │
│ │① │ ✓ │  · 成片（有 result 时默认）      │ 五段式编辑器   │
│ └──┘    │  · 运行进度 + 日志流            │ ──────────   │
│ ┌──┐    │                               │ 画幅 / 时长    │
│ │② │    │                               │ 预设 / seed    │
│ └──┘    │                               │ ⚡Turbo        │
│ ┌──┐    │                               │ 断点暂停 N 步   │
│ │③ │ ●  │                               │ ──────────   │
│ └──┘    │                               │ 条件输入       │
│  [+]    │                               │ 首帧/尾帧/参考图│
├─────────┴───────────────────────────────┴──────────────┤
│ 作品库 FILMSTRIP（横向 · 点播 / 末帧接力 / 删除二次确认） │
└────────────────────────────────────────────────────────┘
```

**五个区域的职责（单一职责，无一重复）**

| 区域 | 职责 | 对应旧 UI |
|---|---|---|
| 顶栏 文档切换器 `[板名 ▾]` | 多板管理：切换 / 新建 / 重命名 / 复制 / 删除（下拉面板，Figma 式） | 新增（v0.2 多板） |
| 左栏 镜头条 | 序列概览：缩略图 + 序号 + 状态点；点击选中；拖拽排序；底部 [+] 添加 | 分镜板卡片（精简为条） |
| 中央 预览区 | 一个屏幕只播一个东西：选中镜头 / 拼接成片 / 生成进度（任务徽章逻辑沿用） | 工作室预览（沿用） |
| 右栏 镜头检查器 | 选中镜头的全部编辑：prompt、画幅、时长、预设、seed、Turbo、断点、首帧/尾帧/参考图上传 | **旧"工作室"左栏整体迁入，per-shot 化** |
| 底部 作品库 | 全局产物索引（含所有板的输出），横向 filmstrip | 右竖栏改横条，预览区更高 |

**关键统一规则**

- **单镜头 = 只有 1 个镜头的板**：旧"工作室"不再存在；新用户进来默认一块单镜板 + 占位提示「点左下 + 添加下一镜」。
- **条件输入 per-shot**：首帧/尾帧/参考图成为镜头属性。「自动末帧接力」= 保存时自动把上一镜末帧填进下一镜的 first_frame（板级开关仍在）。
- **深链**：`/b/:boardId`（板）与 `/b/:boardId/s/:shotIndex`（选中镜）都可分享；`/` 与 `/board` 301 到最近修改板。
- **生成入口两个**：检查器内「生成此镜」（LTX 式单镜重跑）、顶栏/镜头条底部「运行全部」（串行接力沿用现有 board runner）。`/api/generate` 单发端点保留为快捷路径，内部等价于 1 镜板。

### 二、多板管理（文档切换器）

- 下拉面板列出全部板：名称、`N 镜头 · 总时长 · x分钟前`、状态点；按 modifiedAt 倒序
- 面板内操作：`+ 新建分镜`；每项 hover：重命名（行内）/ 复制（结构+参数，输出不复制）/ 删除（二次确认）
- 数据模型只加 `createdAt / modifiedAt`，`storyboards.json` 老数据启动自动回填，零迁移
- API 增量：`GET /api/boards` 改返回摘要（不含 shots 全文）；`GET /api/boards/{id}` 取全量；`POST /{id}/duplicate` 新增；run/concat 沿用并刷新 modifiedAt
- **Linear 式自动保存**：编辑防抖 800ms 落盘，顶栏 `●已保存 / ○保存中`；显式保存按钮移除；运行/拼接前强制 flush

### 三、镜头条交互

- 选中：整卡描边高亮，驱动预览区与检查器
- 排序：卡面左侧 ⋮⋮ 手柄，HTML5 `draggable` 原生实现，落点高亮指示线；松手即保存新顺序，「运行全部」按新序接力
- 插入：两卡间隙 hover 出现细线 +，点击在该位插入新镜
- 右键/悬浮菜单：复制此镜（⧉，连参数一起，改 seed 快速重抽）、删除此镜（二次确认）
- 状态点：idle 灰 / queued 半白 / running 呼吸白 / done 白 / error 黑底白框

### 四、设置面板（⚙）与 i18n 扩展

- 顶栏文字语言按钮 → SVG 齿轮；右侧滑出 320px 抽屉（shadcn Sheet，Esc/遮罩关闭，300ms）
- 配置项注册表驱动渲染（数组声明 section/field/type），本期两项：
  - **语言**：中文 / English / 日本語 / 한국어 单选，即时生效，localStorage 持久化
  - **关于**：Studio 版本、引擎版本（`h3 --info` 首行）、GitHub 链接
- i18n 结构重构：`resources: Record<Lang, Partial<Dict>>`，查找链 `lang → en → key`；新增 `npm run i18n:check` 断言四语言 key 完整性（CI 接入）
- ja/ko 词条首轮全量翻译（工具界面敬体/해요체）；zh/en 手工维护

### 五、组件与代码结构

```
src/
  pages/Workspace.tsx        # 唯一页面（五区布局 + 路由 /b/:id/s/:n）
  components/
    BoardSwitcher.tsx        # 文档切换器下拉
    ShotRail.tsx             # 镜头条（选中/拖拽/插入/菜单）
    ShotInspector.tsx        # 镜头检查器（旧工作室左栏的 per-shot 化）
    PreviewPane.tsx          # 预览区（含任务徽章、草稿续跑横幅）
    LibraryStrip.tsx         # 作品库横条
    SettingsSheet.tsx        # 设置抽屉（注册表驱动）
  lib/{api,i18n,boards}.ts
```

删除 `pages/Home.tsx` 与 `pages/Board.tsx`（其逻辑分别并入 Inspector 与 Workspace）；预览区的任务进度、草稿续跑横幅、删除确认等已验证交互**原样迁移不重做**。

### 六、分期实施

| 期 | 内容 | 出口标准 |
|---|---|---|
| **P1 骨架统一** | Workspace 五区布局；检查器迁入；单镜板=旧工作室；深链；旧路由 301 | 单镜头生成全流程在新 UI 跑通 |
| **P2 多板 + 镜头条** | 文档切换器（增删复制重命名）；拖拽排序；插入/复制镜头；自动保存状态点 | 多板 CRUD、顺序持久化、深链可分享 |
| **P3 设置 + i18n** | ⚙ 抽屉；ja/ko 词条；i18n:check 进 CI | 四语言无缺字；设置即时生效 |
| **P4 打磨** | 单镜重生成按钮（LTX 式）；连续预览；空状态引导 | 任一镜可单独重跑且不碰他镜 |

### 七、验收总表

- 旧"工作室"地址进入自动落到一块单镜板，全部原功能（预设/Turbo/断点/参考图）可用
- 建 3 镜 → 拖拽换序 → 运行全部 → 按新序接力 → 拼接成片
- 板 A 复制出板 B，改 prompt 后互不影响；刷新后两板都在
- 四语言切换即时生效；`npm run i18n:check` 全绿；CI 三个 job 全绿

---

## English

> Supersedes the "Studio / Storyboard" split. Core thesis: **the board is the only document, the shot is the only object, the inspector follows selection, the library is the global product index.**
> Research base: LTX Studio (unified workspace — its winning argument against Runway's split workspaces), Runway (session timeline, Director Mode reference anchoring), Notion/Figma (document switcher & deep links), Linear (autosave indicator).

### Lessons from the two commercial leaders

1. **LTX wins by doing everything in one project** — its main attack on Runway is precisely Runway's multi-workspace hopping. Our v0.1 split made the same mistake; the unified workspace is the validated answer.
2. **Per-shot regeneration** ("regenerate only that slice") is the highest-frequency storyboard operation and is a must-have (P4).
3. **Scene cards shuffle like index cards** — sequence editing is muscle-memory; native HTML5 drag suffices.
4. **Heavy tech hides behind simple toggles** (LTX's "Quality") — keep preset cards, fold advanced params away.

### Information architecture

Five zones, zero overlap: **board switcher** in the header (Figma-style dropdown: switch/new/rename/duplicate/delete, recency-sorted) · **shot rail** on the left (thumbnails, select, drag-reorder, insert, per-shot menu) · **preview pane** center (selected shot / concat result / job progress with the existing badge logic) · **shot inspector** right (the old Studio control panel reborn per-shot: prompt, canvas, duration, preset, seed, Turbo, checkpoint, first/last-frame & reference uploads) · **library filmstrip** bottom (global outputs).

Unification rules: one clip = a board with one shot (the old Studio view retires; `/` and `/board` 301 to the most-recent board); conditioning becomes per-shot, with auto-chain merely pre-filling `first_frame` from the previous shot; deep links `/b/:boardId` and `/b/:boardId/s/:n`.

### Delivery phases

- **P1**: unified skeleton — Workspace layout, inspector migration, single-shot board parity with the old Studio, deep links.
- **P2**: multi-board — switcher CRUD, drag reorder, insert/duplicate shot, Linear-style autosave with status dot.
- **P3**: settings sheet (SVG gear, config-registry driven) + ja/ko dictionaries + `npm run i18n:check` in CI.
- **P4**: polish — per-shot regenerate, sequential preview, empty-state onboarding.

Acceptance: every old Studio capability works in the unified UI; reorder → run-all chains in the new order; duplicate boards diverge independently; four languages switch instantly with zero missing keys; all three CI jobs green.
