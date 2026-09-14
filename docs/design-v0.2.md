# H3 Studio v0.2 设计：多板管理 + 设置面板（i18n 扩展）
# H3 Studio v0.2 Design: Multi-Board Management + Settings Panel (i18n)

[中文](#中文) | [English](#english)

---

## 中文

### 一、分镜板多板管理

**现状**：后端 `boards` 已是字典（`storyboards.json`），但前端只加载 `boards[0]`，等于单板。本次把它做成完整的"项目式"多板管理。

**参考的业界模式**

| 来源 | 借鉴点 |
|---|---|
| Notion 侧边栏 | 文档列表 + 按修改时间排序 + hover 浮出操作（重命名/复制/删除） |
| CapCut / Premiere 项目面板 | 一个"分镜"即一个项目卡片：名称、镜头数、总时长、最近修改 |
| Figma | URL 可寻址（`/board/:id` 深链分享）、复制即派生副本 |
| Linear | 自动保存 + 防抖 + 「已保存/保存中」状态点，消灭显式保存按钮 |

#### 1. 数据模型（向后兼容）

```jsonc
{
  "id": "rainalley",
  "name": "《雨巷·深处》",
  "chain": true,
  "shots": [ /* 现有 Shot 结构不变 */ ],
  "status": "done",
  "result": "board-rainalley-xxx.mp4",
  "createdAt": 1789300000.0,   // 新增，缺省按现时间回填
  "modifiedAt": 1789347632.0   // 新增，每次 upsert 刷新
}
```

`storyboards.json` 格式不变（dict），老数据启动时自动补字段，无迁移脚本。

#### 2. 后端 API

| 端点 | 说明 |
|---|---|
| `GET /api/boards` | 改为返回**按 modifiedAt 倒序的摘要列表**（id/name/shotCount/duration/status/result/modifiedAt），不含 shots 全文 |
| `GET /api/boards/{id}` | 单板全量 |
| `POST /api/boards` | upsert（沿用）；`id` 为空时新建空板并预置一个空镜头 |
| `POST /api/boards/{id}/duplicate` | 深拷贝为新板（名称加「副本」，镜头状态/output 清空还是保留——**保留 output 引用但状态置 done**，复制的是"结构"） |
| `DELETE /api/boards/{id}` | 沿用（前端做二次确认） |
| run / concat | 沿用，自动置 `modifiedAt` |

总时长 `duration` = Σ shot.seconds，后端算好直接给前端。

#### 3. 前端布局

```
┌──────────────────────────────────────────────────┐
│ H3 STUDIO  工作室 [分镜板]              ⚙ 中/EN   │
├──────────┬───────────────────────────────────────┤
│ 分镜列表  │  板工具条（名称/接力/运行/拼接）        │
│ ──────── │ ──────────────────────────────────── │
│ + 新建    │  成片播放器（有 result 时）            │
│ ──────── │ ──────────────────────────────────── │
│ ▸雨巷·深处 │  镜头卡片 1                         │
│  3镜·30s │  镜头卡片 2（拖拽手柄 ⋮⋮ 排序）        │
│  2分钟前  │  镜头卡片 3                         │
│ ▸测试板   │  [+ 添加镜头]                        │
└──────────┴───────────────────────────────────────┘
```

**分镜列表（左栏 200px）**
- 每条：名称（单行截断）+ meta 行（`N 镜头 · 总秒数 · x分钟前`）+ 状态点（运行中呼吸白点）
- hover 浮出：重命名（行内变输入框）、复制、删除（二次确认，与作品库删除同款交互）
- 「+ 新建」置顶；当前板高亮描边

**路由**：`/board` → 重定向到最近修改板；`/board/:id` → 指定板（可分享深链）。

**保存**：输入防抖 800ms 自动保存，工具条右侧显示 `● 已保存` / `○ 保存中…`；「保存」按钮移除（自动保存已覆盖），运行/拼接前自动 flush 一次。

#### 4. 镜头交互增强（同批落地）

- **拖拽排序**：卡片左侧序号区作为 drag handle（⋮⋮），HTML5 `draggable` 原生实现，不落第三方库
- **插入镜头**：两镜头之间的间隙 hover 出现细线「+」，点击在该位置插入
- **复制镜头**：卡片右上「⧉」，快速变体微调（改 seed 重抽）
- 播放全部：成片播放器对无 result 的板提供「连续预览」（按序连播各 shot output，纯前端实现）

#### 5. 验收标准

- 可创建/切换/重命名/复制/删除多块板，刷新后状态保持
- 深链 `/board/rainalley` 直达；列表按修改时间排序正确
- 拖拽排序后顺序被持久化；运行全部时按新顺序接力
- 自动保存期间无丢字（防抖验证）

---

### 二、多语言扩展（日语/韩语）+ 设置面板

**现状**：`i18n.tsx` 是扁平 `{zh, en}` 字典 + 顶栏文字切换按钮。本次：① 字典扩展到 4 语言并加回退链；② 切换入口改为 ⚙ 设置图标呼出抽屉面板，为未来设置项留好骨架。

#### 1. i18n 结构重构

```ts
type Lang = 'zh' | 'en' | 'ja' | 'ko'
const resources: Record<Lang, Partial<Record<I18nKey, string>>> = { zh, en, ja, ko }
// 查找链：lang → en → key 本身（永远有兜底，新增语言不会炸界面）
t(k) = resources[lang][k] ?? resources.en[k] ?? k
```

- `zh` / `en`：手工维护（现有 60+ 词条全量）
- `ja` / `ko`：首轮翻译全量词条（敬体/해요체，工具界面语气），README 与 CONTRIBUTING 注明欢迎母语者 PR 润色
- `localStorage` key 沿用 `h3-studio-lang`，老用户无感

#### 2. 设置面板（⚙ Settings Drawer）

**入口**：顶栏右侧的语言文字按钮 → 替换为 ⚙ 图标按钮（SVG 齿轮，不用 emoji，契合工业灰设计语言）。

**形态**：右侧滑出抽屉（shadcn `Sheet`，w=320px），点击遮罩或 ✕ 关闭，`Esc` 关闭。

**结构**（为扩展分区）：

```
┌─ 设置 SETTINGS ──────────────── ✕ ─┐
│ 语言 LANGUAGE                       │
│ ( ) 中文  ( ) English               │
│ ( ) 日本語  ( ) 한국어               │
│ ────────────────────────────────── │
│ 关于 ABOUT                          │
│ h3.c-studio v0.2 · engine h3-metal  │
│ GitHub ↗                           │
└────────────────────────────────────┘
```

- 语言区：单选列表，点击即切换并持久化（即时生效，无需确认）
- 关于区：版本号 + 引擎版本 + 仓库链接
- 预留 `设置项注册` 结构（数组配置驱动渲染），未来加「主题/默认画幅/后端地址/通知」时只需加配置项

#### 3. 验收标准

- 4 语言全部界面词条无 fallback 漏字（构建期可对 zh/en 全量、ja/ko 全量做 key 完整性断言脚本 `npm run i18n:check`）
- 切换即时生效并跨会话保持
- ⚙ 面板开关动画 300ms，抽屉不遮挡主操作区

---

## English

### 1. Multi-board management

**Today**: backend stores a `boards` dict but the frontend loads only `boards[0]` — effectively single-board. This iteration turns it into project-style multi-board management.

**Borrowed patterns**: Notion sidebar (recency-sorted doc list, hover actions), CapCut project panel (board = project card: name, shot count, total duration, last modified), Figma (URL-addressable `/board/:id` deep links, duplicate-to-fork), Linear (debounced autosave with saved/saving indicator, no save button).

- **Model**: add `createdAt`/`modifiedAt` (backfilled on load, no migration script).
- **API**: `GET /api/boards` returns recency-sorted *summaries*; `GET /api/boards/{id}` full board; `POST /{id}/duplicate` deep-copies structure; run/concat touch `modifiedAt`.
- **Layout**: 200px board rail (new/rename/duplicate/delete with two-step confirm, status dot) + editor; `/board` redirects to most-recent board; `/board/:id` deep link.
- **Saving**: 800ms debounced autosave with `● saved / ○ saving…` indicator; explicit save button removed.
- **Shot interactions**: native-HTML5 drag reorder via handle, insert-between hover affordance, duplicate-shot for seed re-rolls, sequential preview without concat.
- **Acceptance**: full CRUD across boards with persistence, deep links, drag order persisted and honored by run-all, no keystroke loss under autosave.

### 2. i18n (ja/ko) + settings panel

- **Dictionary**: `resources: Record<Lang, Partial<...>>` with fallback chain `lang → en → key`; zh/en hand-maintained, ja/ko first-pass translated (native-speaker PRs welcomed in CONTRIBUTING).
- **Settings drawer**: header text button replaced by an SVG gear ⚙; right slide-over (shadcn Sheet, 320px, Esc/backdrop close). Sections: Language (instant-switch radio list), About (versions + repo link). Config-driven item registry so future settings (theme, defaults, backend URL) are one entry away.
- **Acceptance**: `npm run i18n:check` asserts key completeness for all four languages; switching is instant and persists across sessions.
