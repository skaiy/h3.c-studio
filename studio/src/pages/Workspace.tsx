import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Settings } from 'lucide-react'
import { api, type Board, type BoardSummary, type Job, type Shot, type VideoItem } from '@/lib/api'
import { BoardDrafts } from '@/lib/boardDrafts'
import { selectedOutput, selectedOutputMissing, selectedTake } from '@/lib/takes'
import { useI18n } from '@/lib/useI18n'
import { insertShotAt, duplicateShotAt, removeShotAt, moveShot, nextSelectedAfterDelete } from '@/lib/shotOps'
import BoardSwitcher from '@/components/BoardSwitcher'
import ShotRail from '@/components/ShotRail'
import ShotInspector from '@/components/ShotInspector'
import PreviewPane from '@/components/PreviewPane'
import LibraryStrip from '@/components/LibraryStrip'
import SettingsSheet from '@/components/SettingsSheet'
import TakePanel from '@/components/TakePanel'

function newShot(): Shot {
  return {
    id: `s${crypto.randomUUID()}`, prompt: '', width: 768, height: 768,
    seconds: 10, steps: 20, layers: 45, reuse: 2, seed: 42, turbo: false,
    first_frame: null, last_frame: null, status: 'idle', output: null, job_id: null,
  }
}

export default function Workspace() {
  const { t } = useI18n()
  const nav = useNavigate()
  const { boardId } = useParams()
  const [boards, setBoards] = useState<BoardSummary[]>([])
  const [drafts] = useState(() => new BoardDrafts(api.saveBoard))
  useSyncExternalStore(drafts.subscribe, drafts.snapshot)
  const board = drafts.get(boardId)
  const saveState = drafts.state(boardId)
  const [selected, setSelected] = useState(0)
  const [jobs, setJobs] = useState<Job[]>([])
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [watchJob, setWatchJob] = useState(false)
  const [resumedFrom, setResumedFrom] = useState<string | null>(null)
  const [device, setDevice] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sequenceIdx, setSequenceIdx] = useState<number | null>(null)
  const [operationBoards, setOperationBoards] = useState<string[]>([])
  const [operationErrors, setOperationErrors] = useState<Record<string, string>>({})
  const operationError = boardId ? operationErrors[boardId] : ''
  const [libraryVideo, setLibraryVideo] = useState<string | null>(null)
  // A null takeId follows the canonical selection, overriding an assembled board result.
  const [takePreview, setTakePreview] = useState<{ boardId: string; shotId: string; takeId: string | null } | null>(null)
  const previewRevision = useRef(0)
  const currentView = useRef('')
  const operationLock = useRef(new Set<string>())
  const jobsRequest = useRef(0)
  const boardsRequest = useRef(0)
  const boardRequests = useRef(new Map<string, number>())
  const [listError, setListError] = useState<string | null>(null)
  const [boardLoadErrors, setBoardLoadErrors] = useState<Record<string, string | undefined>>({})
  const [loadAttempt, setLoadAttempt] = useState(0)
  const loadError = (boardId ? boardLoadErrors[boardId] : undefined) ?? listError

  const refreshBoards = useCallback(async (isCurrent: () => boolean = () => true) => {
    const request = ++boardsRequest.current
    const isLatest = () => isCurrent() && request === boardsRequest.current
    try {
      const list = await api.boards()
      if (!isLatest()) return
      setBoards(list)
      setListError(null)
      return list
    } catch (error) {
      if (isLatest()) setListError(error instanceof Error ? error.message : '')
    }
  }, [])

  const refreshBoard = useCallback(async (id: string, isCurrent: () => boolean = () => true) => {
    const request = (boardRequests.current.get(id) ?? 0) + 1
    boardRequests.current.set(id, request)
    const isLatest = () => isCurrent() && request === boardRequests.current.get(id)
    try {
      const loaded = await api.board(id)
      if (!isLatest()) return
      drafts.receive(loaded)
      setBoardLoadErrors((errors) => ({ ...errors, [id]: undefined }))
    } catch (error) {
      if (isLatest()) setBoardLoadErrors((errors) => ({ ...errors, [id]: error instanceof Error ? error.message : '' }))
    }
  }, [drafts])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (drafts.hasUnsaved()) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn); drafts.dispose() }
  }, [drafts])

  // 路由解析：无 boardId 时跳最近修改板；无板则新建一块
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const list = await refreshBoards(() => !cancelled)
      // Only a successful empty list permits creation, never an unavailable list.
      if (cancelled || !list || boardId) return
      if (list.length) nav(`/b/${list[0].id}`, { replace: true })
      else {
        try {
          const b = await api.saveBoard({ id: '', name: '未命名分镜', chain: true, shots: [], status: 'idle', result: null, createdAt: 0, modifiedAt: 0 })
          if (!cancelled) nav(`/b/${b.id}`, { replace: true })
        } catch (error) {
          if (!cancelled) setListError(error instanceof Error ? error.message : '')
        }
      }
    })()
    return () => { cancelled = true }
  }, [boardId, loadAttempt, nav, refreshBoards])

  useEffect(() => {
    if (!boardId) return
    let cancelled = false
    // The per-board store rejects stale polls and retains dirty drafts.
    const refresh = () => refreshBoard(boardId, () => !cancelled)
    refresh()
    const t = setInterval(refresh, 2500)
    return () => { cancelled = true; clearInterval(t) }
  }, [boardId, loadAttempt, refreshBoard])

  // Reset sequence-preview when switching boards. Derived from a render-time comparison
  // (react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
  // instead of an Effect, so it applies before paint with no extra render round-trip.
  const [seenBoardId, setSeenBoardId] = useState(boardId)
  if (boardId !== seenBoardId) {
    setSeenBoardId(boardId)
    setSequenceIdx(null)
    setSelected(0)
    setLibraryVideo(null)
    setTakePreview(null)
  }

  const refreshJobs = useCallback(async () => {
    const request = ++jobsRequest.current
    try {
      const [j, v] = await Promise.all([api.jobs(), api.videos()])
      const run = j.find((x) => x.status === 'running')
      let updated = j
      if (run) {
        const detail = await api.job(run.id)
        updated = j.map((x) => (x.id === run.id ? detail : x))
      }
      if (request !== jobsRequest.current) return
      setJobs(updated)
      setVideos(v)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    // Ignore out-of-order job responses, just as board revisions ignore stale polls.
    refreshJobs()
    api.info().then((r) => {
      const m = r.info.match(/Device: (.+)/)
      if (m) setDevice(m[1])
    }).catch(() => {})
    const t = setInterval(refreshJobs, 2000)
    return () => clearInterval(t)
  }, [refreshJobs])

  const runningJob = jobs.find((j) => j.status === 'running') ?? null
  // Auto-open the job-progress view the moment a new job starts running — derived at render
  // time (same technique as the sequence-reset above) instead of an Effect.
  const [seenRunningJobId, setSeenRunningJobId] = useState<string | null>(null)
  if ((runningJob?.id ?? null) !== seenRunningJobId) {
    setSeenRunningJobId(runningJob?.id ?? null)
    if (runningJob) setWatchJob(true)
  }

  // Every mutation captures board/shot identity, never a selection index across awaits.
  const patchBoard = useCallback((fn: (b: Board) => Board) => {
    if (!boardId) return
    if (operationLock.current.has(boardId) || drafts.get(boardId)?.status === 'running') throw new Error(t('running'))
    drafts.edit(boardId, fn)
  }, [boardId, drafts, t])

  const shot = board?.shots[selected] ?? null
  const selectedShotId = shot?.id
  const viewKey = JSON.stringify([boardId, selectedShotId])
  useEffect(() => { currentView.current = viewKey }, [viewKey])
  const patchShot = useCallback((patch: Partial<Shot>) => {
    patchBoard((b) => ({
      ...b,
      shots: b.shots.map((s) => (s.id === selectedShotId ? { ...s, ...patch } : s)),
    }))
  }, [patchBoard, selectedShotId])

  const operate = async (id: string, action: () => Promise<unknown>) => {
    if (operationLock.current.has(id)) return
    operationLock.current.add(id)
    setOperationBoards((ids) => [...ids, id])
    setOperationErrors((errors) => ({ ...errors, [id]: '' }))
    try { await action() }
    catch (error) { setOperationErrors((errors) => ({ ...errors, [id]: error instanceof Error ? error.message : t('operationFailed') })) }
    finally {
      await Promise.all([refreshBoard(id), refreshJobs(), refreshBoards()])
      operationLock.current.delete(id)
      setOperationBoards((ids) => ids.filter((pending) => pending !== id))
    }
  }

  const generateShot = async () => {
    if (!board || !shot) return
    const id = board.id, shotId = shot.id
    await operate(id, async () => {
      await drafts.flush(id)
      await api.generateShot(id, shotId)
      setLibraryVideo(null)
    })
  }

  const previewTake = (takeId: string) => {
    if (!board || !shot) return
    previewRevision.current++
    setTakePreview({ boardId: board.id, shotId: shot.id, takeId: takeId === shot.selected_take_id ? null : takeId })
    setSequenceIdx(null)
    setLibraryVideo(null)
    setWatchJob(false)
  }

  const mutateTake = async (takeId: string, remove: boolean) => {
    if (!board || !shot || boardBusy) return
    if (remove && !window.confirm(t('takeDeleteConfirm'))) return
    const id = board.id, shotId = shot.id, origin = viewKey
    const revision = ++previewRevision.current
    await operate(id, async () => {
      await drafts.flush(id)
      try {
        const updated = await (remove ? api.deleteTake(id, shotId, takeId) : api.selectTake(id, shotId, takeId))
        drafts.receive(updated)
        if (currentView.current === origin && previewRevision.current === revision) {
          setTakePreview(remove ? null : { boardId: id, shotId, takeId: null })
          setSequenceIdx(null)
          setLibraryVideo(null)
          setWatchJob(false)
        }
      } catch (error) {
        throw new Error(`${t(remove ? 'takeDeleteFailed' : 'takeSelectFailed')}: ${error instanceof Error ? error.message : t('operationFailed')}`)
      }
    })
  }

  const insertShot = (at: number) => {
    patchBoard((b) => ({ ...b, shots: insertShotAt(b.shots, at, newShot()) }))
    setSelected(at)
  }

  const duplicateShot = (i: number) => {
    patchBoard((b) => ({
      ...b,
      shots: duplicateShotAt(b.shots, i, (src) => ({
        ...src, id: `s${crypto.randomUUID()}`, status: 'idle', output: null, job_id: null,
        takes: [], selected_take_id: null, continuity_state: 'none', stale: false, output_missing: false,
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

  const addShot = () => {
    patchBoard((b) => ({ ...b, shots: [...b.shots, newShot()] }))
    setSelected(board?.shots.length ?? 0)
  }

  const runAll = async () => {
    if (!board) return
    const id = board.id
    await operate(id, async () => { await drafts.flush(id); await api.runBoard(id) })
  }

  const concat = async () => {
    if (!board) return
    const id = board.id, origin = viewKey, revision = previewRevision.current
    await operate(id, async () => {
      await drafts.flush(id)
      await api.concatBoard(id)
      if (currentView.current === origin && previewRevision.current === revision) {
        setLibraryVideo(null)
        setTakePreview(null)
      }
    })
  }

  const resumeDraft = async (job: Job) => {
    if (!job.checkpoint || typeof job.params.board_id !== 'string') return
    const id = job.params.board_id
    await operate(id, async () => {
      if (drafts.get(id)) await drafts.flush(id)
      await api.resumeJob(job.id)
      setResumedFrom(job.checkpoint!)
    })
  }

  const chainFromLibrary = async (v: VideoItem) => {
    if (!boardId) return
    const id = boardId
    try {
      const r = await api.extractLastFrame(v.name)
      patchShot({ first_frame: r.name })
    } catch (error) { setOperationErrors((errors) => ({ ...errors, [id]: error instanceof Error ? error.message : t('operationFailed') })) }
  }

  const draftJob = jobs.find((j) => j.status === 'done' && j.checkpoint && j.checkpoint !== resumedFrom
    && j.params.board_id === board?.id && j.params.shot_id === shot?.id) ?? null
  const boardMissing = board?.shots.some(selectedOutputMissing) ?? false
  const doneOutputs = board?.shots.map(selectedOutput).filter((output): output is string => !!output) ?? []
  const sequencing = sequenceIdx !== null
  const browsedTake = takePreview && takePreview.boardId === boardId && takePreview.shotId === shot?.id
    ? (takePreview.takeId === null ? selectedTake(shot) : shot?.takes?.find((take) => take.id === takePreview.takeId) ?? null) : null
  const currentVideo = sequencing ? (doneOutputs[sequenceIdx!] ?? null)
    : (libraryVideo ?? browsedTake?.output ?? board?.result ?? selectedOutput(shot))
  const previewMissing = sequencing ? boardMissing : !libraryVideo && (browsedTake
    ? browsedTake.missing : !board?.result && !!shot && selectedOutputMissing(shot))
  const shownTake = sequencing || libraryVideo || (!browsedTake && board?.result) ? null : browsedTake ?? selectedTake(shot)
  const previewContext = shownTake ? `${t('takeLabel')} ${(shot?.takes?.findIndex((take) => take.id === shownTake.id) ?? -1) + 1} · ${t(shownTake.id === shot?.selected_take_id ? 'takeSelected' : 'takePreviewOnly')}` : undefined
  const boardBusy = board?.status === 'running' || board?.shots.some((s) => s.status === 'queued' || s.status === 'running') || operationBoards.includes(boardId ?? '')

  const reloadDiscardingDraft = async () => {
    if (!board || !window.confirm(t('discardDraftConfirm'))) return
    try { drafts.discard(await api.board(board.id)) }
    catch (error) { setOperationErrors((errors) => ({ ...errors, [board.id]: error instanceof Error ? error.message : t('operationFailed') })) }
  }

  const toggleSequence = () => {
    previewRevision.current++
    if (sequencing) { setSequenceIdx(null); return }
    if (doneOutputs.length === 0 || boardMissing) return
    setTakePreview(null)
    setLibraryVideo(null)
    setWatchJob(false)
    setSequenceIdx(0)
  }
  const advanceSequence = () => {
    setSequenceIdx((i) => {
      if (i === null) return null
      const next = i + 1
      return next < doneOutputs.length ? next : null
    })
  }

  const settingsButton = (
    <button onClick={() => setSettingsOpen(true)} aria-label={t('settingsTitle')} title={t('settingsTitle')}
      className="bar linkfade border-l border-border !text-white">
      <Settings className="size-4" />
    </button>
  )
  const loadErrorBanner = loadError !== null && (
    <div role="alert" className="px-3 py-2 text-xs text-red-300 border-b border-border">
      <p>{t('boardLoadFailed')}{loadError && `: ${loadError}`}</p>
      <p className="mt-1">{t('boardLoadHint')}</p>
      <button className="mt-2 underline" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>{t('retryLoad')}</button>
    </div>
  )

  if (!board) {
    return (
      <div className="h-full flex flex-col bg-background text-foreground">
        <div className="flex items-stretch border-b border-border shrink-0">
          <div className="bar-invert">{t('title')}</div>
          <div className="flex-1" />
          {settingsButton}
        </div>
        <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
        {loadErrorBanner}
        {loadError === null && <div className="flex-1 flex items-center justify-center text-muted-foreground text-[12px] uppercase tracking-[0.2em]">H3 STUDIO…</div>}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* header */}
      <div className="flex items-stretch border-b border-border shrink-0">
        <div className="bar-invert">{t('title')}</div>
        <BoardSwitcher boards={boards} currentId={board.id} onRefresh={refreshBoards}
          beforeMutate={async (id) => { if (drafts.get(id)) await drafts.flush(id) }} />
        <div className="bar text-muted-foreground">{saveState.error ? t('saveFailed') : saveState.dirty || saveState.saving ? `○ ${t('saving')}` : `● ${t('saved')}`}</div>
        <input
          value={board.name}
          disabled={boardBusy}
          onChange={(e) => patchBoard((b) => ({ ...b, name: e.target.value }))}
          className="bar bg-transparent outline-none border-b border-transparent hover:border-border focus:border-white text-white min-w-[120px]"
        />
        <div className="flex-1" />
        <div className="bar mono normal-case tracking-normal">{device || '…'}</div>
        <div className="bar">{jobs.filter((j) => j.status === 'queued' || j.status === 'running').length} {t('activeJobs')}</div>
        {settingsButton}
      </div>
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
      {loadErrorBanner}
      {(saveState.error || operationError) && (
        <div role="alert" className="px-3 py-2 text-xs text-red-300 border-b border-border">
          {saveState.error ? `${t('saveFailed')}: ${saveState.error.message}` : operationError}
          {saveState.error && <>
            <button className="ml-3 underline" disabled={saveState.saving} onClick={() => operate(board.id, () => drafts.flush(board.id))}>{t('retrySave')}</button>
            <button className="ml-3 underline" disabled={saveState.saving} onClick={reloadDiscardingDraft}>{t('reloadBoard')}</button>
          </>}
        </div>
      )}
      {boardMissing && <div role="status" className="px-3 py-2 text-xs text-amber-300 border-b border-border">{t('takeSequenceMissing')}</div>}

      <div className="flex flex-1 min-h-0">
        <ShotRail
          board={board}
          disabled={boardBusy}
          selected={selected}
          onSelect={(i) => { previewRevision.current++; setSequenceIdx(null); setLibraryVideo(null); setTakePreview(null); setSelected(i) }}
          onAddShot={addShot}
          onInsertShot={insertShot}
          onDuplicateShot={duplicateShot}
          onDeleteShot={deleteShot}
          onReorder={reorderShots}
          onRunAll={runAll}
          onConcat={concat}
          sequencing={sequencing}
          onToggleSequence={toggleSequence}
        />
        <PreviewPane
          video={currentVideo}
          contextLabel={previewContext}
          missing={previewMissing}
          onReturnToSelected={browsedTake && browsedTake.id !== shot?.selected_take_id ? () => {
            const adopted = selectedTake(shot)
            if (adopted) previewTake(adopted.id)
            else { previewRevision.current++; setTakePreview(null) }
          } : undefined}
          runningJob={runningJob}
          watchJob={watchJob}
          onWatchJob={setWatchJob}
          draftJob={boardBusy ? null : draftJob}
          onResume={resumeDraft}
          hasShots={board.shots.length > 0}
          onAddShot={addShot}
          sequencing={sequencing}
          onSequenceEnded={advanceSequence}
        />
        {shot && (
          <fieldset disabled={boardBusy} className="border-0 p-0 m-0 flex min-h-0 shrink-0">
          <ShotInspector
            key={board.id}
            shot={shot}
            chain={board.chain}
            isFirst={selected === 0}
            onChange={patchShot}
            onGenerate={generateShot}
            generating={boardBusy}
            takePanel={<TakePanel key={`${board.id}/${shot.id}`} shot={shot}
              previewingTakeId={browsedTake?.id ?? null} disabled={boardBusy}
              onPreview={previewTake} onSelect={(id) => { void mutateTake(id, false) }}
              onDelete={(id) => { void mutateTake(id, true) }} />}
          />
          </fieldset>
        )}
      </div>

      <LibraryStrip
        videos={videos}
        current={currentVideo}
        onPlay={(name) => {
          previewRevision.current++
          setSequenceIdx(null)
          setTakePreview(null)
          setLibraryVideo(name)
          setWatchJob(false)
        }}
        onChain={chainFromLibrary}
        onChanged={refreshJobs}
      />
    </div>
  )
}
