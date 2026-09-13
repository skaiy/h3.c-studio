import { createContext, useContext, useState, type ReactNode } from 'react'

export type Lang = 'zh' | 'en'

const dict = {
  zh: {
    title: 'H3 STUDIO',
    subtitle: 'MINIMAX-H3 · NATIVE METAL',
    activeJobs: '个任务活动',
    prompt: '提示词 · PROMPT',
    promptHint: 'Scene / Action / Camera / Look / Audio 五段式效果最佳',
    canvas: '画幅 · CANVAS',
    duration: '时长',
    preset: '速度 / 画质预设',
    presetBalanced: '平衡 · 推荐',
    presetDraft: '激进草稿',
    presetTurbo: 'Turbo 6 步 ⚡',
    presetHQ: '高画质',
    presetRef: '参考级 · 慢',
    random: '随机',
    tokenReduction: 'TOKEN 削减 · 激进',
    conditioning: '条件输入 · CONDITIONING',
    firstFrame: '首帧 FIRST FRAME',
    lastFrame: '尾帧 LAST FRAME',
    refImages: '参考图 REF IMAGES（与首尾帧互斥）',
    generate: '生成视频 →',
    preview: '预览 · PREVIEW',
    starting: '启动中',
    cancel: '取消',
    emptyPreview: '配置参数 → 生成视频',
    library: '作品库 · LIBRARY',
    items: '条',
    emptyLibrary: '暂无作品',
    play: '播放',
    chain: '末帧接力',
    remove: '移除',
    delete: '删除',
    confirmDelete: '确认删除?',
    queued: '排队中',
    langToggle: 'EN',
    studio: '工作室',
    board: '分镜板',
    boardName: '分镜名称',
    addShot: '+ 添加镜头',
    shot: '镜头',
    runBoard: '▶ 运行全部镜头',
    running: '运行中…',
    concat: '⇢ 拼接导出',
    chainAuto: '自动末帧接力',
    boardResult: '拼接成片',
    needTwo: '至少 2 个完成镜头',
    deleteBoard: '删除分镜',
    saveBoard: '保存',
    idle: '待生成',
    skipped: '跳过',
    done: '完成',
    error: '失败',
  },
  en: {
    title: 'H3 STUDIO',
    subtitle: 'MINIMAX-H3 · NATIVE METAL',
    activeJobs: 'active jobs',
    prompt: 'PROMPT',
    promptHint: 'Scene / Action / Camera / Look / Audio structure works best',
    canvas: 'CANVAS',
    duration: 'DURATION',
    preset: 'SPEED / QUALITY PRESET',
    presetBalanced: 'Balanced',
    presetDraft: 'Draft',
    presetTurbo: 'Turbo 6-step ⚡',
    presetHQ: 'Quality',
    presetRef: 'Reference',
    random: 'Rand',
    tokenReduction: 'TOKEN REDUCTION · AGGRESSIVE',
    conditioning: 'CONDITIONING',
    firstFrame: 'FIRST FRAME',
    lastFrame: 'LAST FRAME',
    refImages: 'REF IMAGES (exclusive w/ anchors)',
    generate: 'GENERATE →',
    preview: 'PREVIEW',
    starting: 'starting',
    cancel: 'cancel',
    emptyPreview: 'Configure → Generate',
    library: 'LIBRARY',
    items: 'clips',
    emptyLibrary: 'No clips yet',
    play: 'Play',
    chain: 'Chain last frame',
    remove: 'Remove',
    delete: 'Delete',
    confirmDelete: 'Confirm?',
    queued: 'queued',
    langToggle: '中',
    studio: 'STUDIO',
    board: 'STORYBOARD',
    boardName: 'Board name',
    addShot: '+ Add shot',
    shot: 'Shot',
    runBoard: '▶ Run all shots',
    running: 'Running…',
    concat: '⇢ Concat & export',
    chainAuto: 'Auto chain last frame',
    boardResult: 'Board result',
    needTwo: 'Need 2+ finished shots',
    deleteBoard: 'Delete board',
    saveBoard: 'Save',
    idle: 'idle',
    skipped: 'skipped',
    done: 'done',
    error: 'error',
  },
} as const

export type I18nKey = keyof (typeof dict)['zh']

interface I18nCtx {
  lang: Lang
  t: (k: I18nKey) => string
  toggle: () => void
}

const Ctx = createContext<I18nCtx>({ lang: 'zh', t: (k) => dict.zh[k], toggle: () => {} })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() =>
    (localStorage.getItem('h3-studio-lang') as Lang) || 'zh'
  )
  const toggle = () =>
    setLang((l) => {
      const next = l === 'zh' ? 'en' : 'zh'
      localStorage.setItem('h3-studio-lang', next)
      return next
    })
  return <Ctx.Provider value={{ lang, t: (k) => dict[lang][k], toggle }}>{children}</Ctx.Provider>
}

export const useI18n = () => useContext(Ctx)
