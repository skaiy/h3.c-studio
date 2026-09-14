import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Settings } from 'lucide-react'
import { api, type Board, type BoardSummary, type GenParams, type Job, type Shot, type VideoItem } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { insertShotAt, duplicateShotAt, removeShotAt, moveShot, nextSelectedAfterDelete } from '@/lib/shotOps'
import BoardSwitcher from '@/components/BoardSwitcher'
import ShotRail from '@/components/ShotRail'
import ShotInspector from '@/components/ShotInspector'
import PreviewPane from '@/components/PreviewPane'
import LibraryStrip from '@/components/LibraryStrip'
import SettingsSheet from '@/components/SettingsSheet'

function newShot(): Shot {
  return {
    id: `s${Date.now().toString(36)}`, prompt: '', width: 768, height: 768,
    seconds: 10, steps: 20, layers: 45, reuse: 2, seed: 42, turbo: false,
    first_frame: null, last_frame: null, status: 'idle', output: null, job_id: null,
  }
}

export default function Workspace() {
  const { t } = useI18n()
  const nav = useNavigate()
  const { boardId } = useParams()
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [board, setBoard] = useState<Board | null>(null)
  const [selected, setSelected] = useState(0)
  const [jobs, setJobs] = useState<Job[]>([])
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [watchJob, setWatchJob] = useState(false)
  const [resumedFrom, setResumedFrom] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'saving'>('saved')
  const [device, setDevice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const dirtyUntil = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshBoards = useCallback(async () => {
    try { setBoards(await api.boards()) } catch { /* backend down */ }
  }, [])

  const refreshBoard = useCallback(async (id: string) => {
    try {
      const b = await api.board(id)
      if (Date.now() > dirtyUntil.current) setBoard(b)
    } catch { /* deleted elsewhere */ }
  }, [])

  // 路由解析：无 boardId 时跳最近修改板；无板则新建一块
  useEffect(() => {
    (async () => {
      await refreshBoards()
      if (boardId) return
      const list = await api.boards().catch(() => [] as BoardSummary[])
      if (list.length) nav(`/b/${list[0].id}`, { replace: true })
      else {
        const b = await api.saveBoard({ id: '', name: '未命名分镜', chain: true, shots: [], status: 'idle', result: null, createdAt: 0, modifiedAt: 0 })
        nav(`/b/${b.id}`, { replace: true })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId])

  useEffect(() => {
    if (!boardId) return
    refreshBoard(boardId)
    const t = setInterval(() => refreshBoard(boardId), 2500)
    return () => clearInterval(t)
  }, [boardId, refreshBoard])

  const refreshJobs = useCallback(async () => {
    try {
      const [j, v] = await Promise.all([api.jobs(), api.videos()])
      const run = j.find((x) => x.status === 'running')
      if (run) {
        const detail = await api.job(run.id)
        setJobs(j.map((x) => (x.id === run.id ? detail : x)))
      } else setJobs(j)
      setVideos(v)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    refreshJobs()
    api.info().then((r) => {
      const m = r.info.match(/Device: (.+)/)
      if (m) setDevice(m[1])
    }).catch(() => {})
    const t = setInterval(refreshJobs, 2000)
    return () => clearInterval(t)
  }, [refreshJobs])

  const runningJob = jobs.find((j) => j.status === 'running') ?? null
  useEffect(() => {
    if (runningJob) setWatchJob(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningJob?.id])

  // 自动保存（防抖 800ms）
  const persist = useCallback((b: Board) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveState('saving')
    saveTimer.current = setTimeout(async () => {
      await api.saveBoard(b)
      dirtyUntil.current = Date.now() + 1200
      setSaveState('saved')
      refreshBoards()
    }, 800)
  }, [refreshBoards])

  const patchBoard = useCallback((fn: (b: Board) => Board) => {
    setBoard((prev) => {
      if (!prev) return prev
      const next = fn({ ...prev, shots: prev.shots.map((s) => ({ ...s })) })
      persist(next)
      return next
    })
  }, [persist])

  const patchShot = useCallback((patch: Partial<Shot>) => {
    patchBoard((b) => ({
      ...b,
      shots: b.shots.map((s, i) => (i === selected ? { ...s, ...patch } : s)),
    }))
  }, [patchBoard, selected])

  const flushSave = async (): Promise<Board | null> => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (!board) return null
    const saved = await api.saveBoard(board)
    dirtyUntil.current = Date.now() + 1200
    setSaveState('saved')
    setBoard(saved)
    return saved
  }

  const shot = board?.shots[selected] ?? null

  const generateShot = async () => {
    if (!board || !shot) return
    const saved = await flushSave()
    if (!saved) return
    const s = saved.shots[selected]
    // 接力：非首镜且无显式首帧时，自动取上镜末帧
    let firstFrame = s.first_frame
    if (saved.chain && selected > 0 && !firstFrame) {
      const prevOutput = saved.shots[selected - 1]?.output
      if (prevOutput) {
        const r = await api.extractLastFrame(prevOutput)
        firstFrame = r.name
        patchShot({ first_frame: r.name })
        await flushSave()
      }
    }
    const s2 = board?.shots[selected] ?? s
    const params: GenParams = {
      prompt: s2.prompt,
      width: s2.width, height: s2.height,
      seconds: s2.seconds, frames: null,
      steps: s2.steps, layers: s2.layers, reuse: s2.reuse,
      seed: s2.seed,
      first_frame: firstFrame,
      last_frame: s2.last_frame,
      ref_images: (s2 as unknown as { ref_images?: string[] }).ref_images ?? [],
      token_reduction: false,
      turbo: s2.turbo ?? false,
      checkpoint_after_step: (s2 as unknown as { checkpoint_after_step?: number }).checkpoint_after_step || null,
      resume: null,
      board_id: saved.id,
      shot_id: s2.id,
      label: `[${saved.name}] 镜头 ${selected + 1}`,
    } as GenParams
    await api.generate(params)
    patchShot({ status: 'queued' })
    await refreshJobs()
  }

  const insertShot = (at: number) => {
    patchBoard((b) => ({ ...b, shots: insertShotAt(b.shots, at, newShot()) }))
    setSelected(at)
  }

  const duplicateShot = (i: number) => {
    patchBoard((b) => ({
      ...b,
      shots: duplicateShotAt(b.shots, i, (src) => ({
        ...src, id: `s${Date.now().toString(36)}`, status: 'idle', output: null, job_id: null,
      })),
    }))
    setSelected(i + 1)
  }

  const deleteShot = (i: number) => {
    const preDeleteLength = board!.shots.length
    patchBoard((b) => ({ ...b, shots: removeShotAt(b.shots, i) }))
    setSelected((sel) => nextSelectedAfterDelete(sel, i, preDeleteLength))
  }

  const reorderShots = (from: number, to: number) => {
    patchBoard((b) => ({ ...b, shots: moveShot(b.shots, from, to) }))
    setSelected(to)
  }

  const runAll = async () => {
    const saved = await flushSave()
    if (!saved) return
    await api.runBoard(saved.id)
    setBoard((b) => (b ? { ...b, status: 'running' } : b))
  }

  const concat = async () => {
    const saved = await flushSave()
    if (!saved) return
    const r = await api.concatBoard(saved.id)
    if (r.output) {
      setBoard((b) => (b ? { ...b, result: r.output } : b))
      refreshJobs()
    }
  }

  const resumeDraft = async (job: Job) => {
    if (!job.checkpoint || !shot) return
    const p = job.params as Record<string, unknown>
    await api.generate({
      prompt: shot.prompt,
      width: (p.width as number) ?? 512, height: (p.height as number) ?? 512,
      seconds: (p.seconds as number) ?? 6, frames: null,
      steps: (p.steps as number) ?? 20, layers: (p.layers as number) ?? 45,
      reuse: (p.reuse as number) ?? 2, seed: (p.seed as number) ?? 42,
      first_frame: (p.first_frame as string) ?? null, last_frame: (p.last_frame as string) ?? null,
      ref_images: [], token_reduction: false, turbo: (p.turbo as boolean) ?? false,
      checkpoint_after_step: null, resume: job.checkpoint,
      board_id: board?.id ?? null, shot_id: shot.id,
      label: `▶ 续跑 ${job.label}`,
    } as GenParams)
    setResumedFrom(job.checkpoint)
    await refreshJobs()
  }

  const chainFromLibrary = async (v: VideoItem) => {
    const r = await api.extractLastFrame(v.name)
    patchShot({ first_frame: r.name })
  }

  const draftJob = jobs.find((j) => j.status === 'done' && j.checkpoint && j.checkpoint !== resumedFrom) ?? null
  const currentVideo = board?.result ?? shot?.output ?? null

  if (!board) {
    return (
      <div className="h-full flex items-center justify-center bg-background text-muted-foreground text-[12px] uppercase tracking-[0.2em]">
        H3 STUDIO…
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* header */}
      <div className="flex items-stretch border-b border-border shrink-0">
        <div className="bar-invert">{t('title')}</div>
        <BoardSwitcher boards={boards} currentId={board.id} onRefresh={refreshBoards} />
        <div className="bar text-muted-foreground">{saveState === 'saved' ? `● ${t('saved')}` : `○ ${t('saving')}`}</div>
        <input
          value={board.name}
          onChange={(e) => patchBoard((b) => ({ ...b, name: e.target.value }))}
          className="bar bg-transparent outline-none border-b border-transparent hover:border-border focus:border-white text-white min-w-[120px]"
        />
        <div className="flex-1" />
        <div className="bar mono normal-case tracking-normal">{device || '…'}</div>
        <div className="bar">{jobs.filter((j) => j.status === 'queued' || j.status === 'running').length} {t('activeJobs')}</div>
        <button onClick={() => setSettingsOpen(true)} aria-label={t('settingsTitle')} title={t('settingsTitle')}
          className="bar linkfade border-l border-border !text-white">
          <Settings className="size-4" />
        </button>
      </div>
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />

      <div className="flex flex-1 min-h-0">
        <ShotRail
          board={board}
          selected={selected}
          onSelect={setSelected}
          onAddShot={() => {
            patchBoard((b) => ({ ...b, shots: [...b.shots, newShot()] }))
            setSelected(board.shots.length)
          }}
          onInsertShot={insertShot}
          onDuplicateShot={duplicateShot}
          onDeleteShot={deleteShot}
          onReorder={reorderShots}
          onRunAll={runAll}
          onConcat={concat}
        />
        <PreviewPane
          video={currentVideo}
          runningJob={runningJob}
          watchJob={watchJob}
          onWatchJob={setWatchJob}
          draftJob={draftJob}
          onResume={resumeDraft}
        />
        {shot && (
          <ShotInspector
            shot={shot}
            chain={board.chain}
            isFirst={selected === 0}
            onChange={patchShot}
            onGenerate={generateShot}
            generating={false}
          />
        )}
      </div>

      <LibraryStrip
        videos={videos}
        current={currentVideo}
        onPlay={(name) => {
          // 库点播：临时清掉板 result 展示逻辑交给 PreviewPane（currentVideo 优先 result）
          setBoard((b) => (b ? { ...b, result: name } : b))
          setWatchJob(false)
        }}
        onChain={chainFromLibrary}
        onChanged={refreshJobs}
      />
    </div>
  )
}
