import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type Board, type BoardSummary, type Job, type Shot, type Take, type VideoItem } from '@/lib/api'
import { translate, type StudioI18nKey } from '@/lib/i18nResources'
import Workspace from './Workspace'

const t = (key: StudioI18nKey) => translate('zh', key)
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

function shot(id: string, overrides: Partial<Shot> = {}): Shot {
  return {
    id, prompt: `Prompt ${id}`, width: 768, height: 768, seconds: 5,
    steps: 20, layers: 45, reuse: 2, seed: 42, first_frame: null, last_frame: null,
    status: 'idle', output: null, job_id: null, ...overrides,
  }
}

function take(id: string, shotId: string, overrides: Partial<Take> = {}): Take {
  return {
    id, shot_id: shotId, job_id: `job-${id}`, output: `${id}.mp4`, created_at: 1700000000,
    request: { prompt: `Historical prompt ${id}`, seed: 7, width: 512, height: 512, steps: 6 },
    request_unknown: false, source_take_id: null, source_unknown: false,
    legacy: false, model_name: 'historical-model', missing: false, ...overrides,
  }
}

function takenShot(id: string, overrides: Partial<Shot> = {}): Shot {
  const old = take(`${id}-old`, id)
  const adopted = take(`${id}-adopted`, id, { created_at: 1700000010 })
  return shot(id, {
    status: 'done', output: adopted.output, job_id: adopted.job_id,
    takes: [old, adopted], selected_take_id: adopted.id,
    continuity_state: 'current', stale: false, output_missing: false, ...overrides,
  })
}

function takeControl(id: string, key: 'play' | 'takeSelect' | 'takeDelete', ordinal: number) {
  return within(screen.getByTestId(`take-${id}`)).getByRole('button', {
    name: `${t(key)} · ${t('takeLabel')} ${ordinal}`,
  })
}

function board(id: string, overrides: Partial<Board> = {}): Board {
  return {
    id, name: `Board ${id}`, chain: false, shots: [shot(`${id}-s1`), shot(`${id}-s2`)],
    status: 'idle', result: null, createdAt: 1, modifiedAt: 10, ...overrides,
  }
}

function summary(b: Board): BoardSummary {
  return {
    id: b.id, name: b.name, status: b.status, result: b.result,
    shotCount: b.shots.length, doneCount: b.shots.filter((s) => s.status === 'done').length,
    duration: b.shots.reduce((sum, s) => sum + (s.seconds ?? 0), 0), createdAt: b.createdAt, modifiedAt: b.modifiedAt,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let server: Map<string, Board>
let jobs: Job[]
let videos: VideoItem[]
const fetchMock = vi.fn<typeof fetch>()

function persist(b: Board): Board {
  const previous = server.get(b.id)!
  if (b.modifiedAt !== previous.modifiedAt) throw new ApiError(409, 'Board changed on server')
  // Draft saves cannot adopt a take, rewrite historical requests, or claim runtime output.
  const saved = clone({
    ...b, status: previous.status, result: previous.result,
    createdAt: previous.createdAt, modifiedAt: previous.modifiedAt + 1,
    shots: b.shots.map((s) => {
      const prior = previous.shots.find((item) => item.id === s.id)
      return prior ? {
        ...s, status: prior.status, output: prior.output, job_id: prior.job_id,
        takes: prior.takes, selected_take_id: prior.selected_take_id,
        continuity_state: prior.continuity_state, stale: prior.stale, output_missing: prior.output_missing,
      } : {
        ...s, status: 'idle', output: null, job_id: null, takes: [], selected_take_id: null,
        continuity_state: 'none' as const, stale: false, output_missing: false,
      }
    }),
  })
  server.set(b.id, saved)
  return clone(saved)
}

function updateServerShot(boardId: string, shotId: string, patch: Partial<Shot>, boardPatch: Partial<Board> = {}): Board {
  const previous = server.get(boardId)!
  const updated = clone({
    ...previous, ...boardPatch, modifiedAt: previous.modifiedAt + 1,
    shots: previous.shots.map((s) => s.id === shotId ? { ...s, ...patch } : s),
  })
  server.set(boardId, updated)
  return clone(updated)
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status })
}

// Flush React/microtasks without advancing the autosave or polling clocks.
async function settle() { await act(async () => {}) }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

async function mountWorkspace(id = 'b1') {
  const view = render(<MemoryRouter initialEntries={[`/b/${encodeURIComponent(id)}`]}>
    <Routes><Route path="/b/:boardId" element={<Workspace />} /></Routes>
  </MemoryRouter>)
  await settle()
  expect(screen.getByDisplayValue(server.get(id)!.name)).toBeInTheDocument()
  return view
}

async function switchBoard(from: string, to: string) {
  fireEvent.click(screen.getByRole('button', { name: `Board ${from} ▾` }))
  fireEvent.click(screen.getByText(`Board ${to}`, { selector: 'span' }))
  await settle()
  expect(screen.getByRole('button', { name: `Board ${to} ▾` })).toBeInTheDocument()
}

function editPrompt(value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: t('prompt') }), { target: { value } })
}

function generate() { fireEvent.click(screen.getByRole('button', { name: t('generateShot') })) }

function expectNoQueue() {
  expect(screen.getByText(`0 ${t('activeJobs')}`)).toBeInTheDocument()
  expect(api.generate).not.toHaveBeenCalled()
  expect(api.runBoard).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.useFakeTimers()
  server = new Map(['b1', 'b2'].map((id) => [id, board(id)]))
  jobs = []
  videos = []
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  // Reads/saves use the board store. Generation/resume and take mutations retain
  // their real HTTP implementation so route tests also verify the wire contract.
  vi.spyOn(api, 'boards').mockImplementation(async () => [...server.values()].map(summary))
  vi.spyOn(api, 'board').mockImplementation(async (id) => clone(server.get(id)!))
  vi.spyOn(api, 'saveBoard').mockImplementation(async (b) => persist(b))
  vi.spyOn(api, 'jobs').mockImplementation(async () => clone(jobs))
  vi.spyOn(api, 'videos').mockImplementation(async () => clone(videos))
  vi.spyOn(api, 'info').mockResolvedValue({ info: 'Device: Test CPU' })
  vi.spyOn(api, 'generateShot')
  vi.spyOn(api, 'resumeJob')
  vi.spyOn(api, 'selectTake')
  vi.spyOn(api, 'deleteTake')
  vi.spyOn(api, 'deleteVideo')
  vi.spyOn(api, 'concatBoard')
  vi.spyOn(api, 'generate').mockRejectedValue(new Error('Legacy generation must not be used'))
  vi.spyOn(api, 'runBoard').mockResolvedValue({})
  fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify({ job_id: 'queued-job' }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Workspace draft and generation regressions through the real route', () => {
  it('flushes the edited shot before a bodyless generateShot request with encoded endpoint identifiers', async () => {
    const id = 'board #1', shotId = 'shot /?'
    server.set(id, board(id, { shots: [shot(shotId)] }))
    const pending = deferred<Board>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => pending.promise)
    await mountWorkspace(id)
    editPrompt('This edit must be saved before queueing')
    generate()
    await settle()
    expect(api.saveBoard).toHaveBeenCalledOnce()
    const submitted = vi.mocked(api.saveBoard).mock.calls[0][0]
    expect(submitted).toMatchObject({ id, modifiedAt: 10, shots: [expect.objectContaining({ id: shotId, prompt: 'This edit must be saved before queueing' })] })
    expect(api.generateShot).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: t('generateShot') })).toBeDisabled()
    await act(async () => { pending.resolve(persist(submitted)) })
    expect(api.generateShot).toHaveBeenCalledExactlyOnceWith(id, shotId)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/boards/board%20%231/shots/shot%20%2F%3F/generate', expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
    expect(api.generate).not.toHaveBeenCalled()
    expect(api.resumeJob).not.toHaveBeenCalled()
  })

  it('round-trips all structured fields through shot switches, a save, and a fresh route mount', async () => {
    const view = await mountWorkspace()
    fireEvent.click(screen.getByRole('button', { name: t('promptModeStructured') }))
    const fields = { scene: 'River at dawn', action: 'Boat drifts', camera: 'Slow pan', look: 'Soft light', audio: 'Birdsong' }
    const labels = { scene: 'promptFieldScene', action: 'promptFieldAction', camera: 'promptFieldCamera', look: 'promptFieldLook', audio: 'promptFieldAudio' } as const
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      fireEvent.change(screen.getByRole('textbox', { name: t(labels[key]) }), { target: { value: fields[key] } })
    }
    fireEvent.click(screen.getByTestId('shot-card-1'))
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Prompt b1-s2')
    editPrompt('Independent simple shot')
    fireEvent.click(screen.getByTestId('shot-card-0'))
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      expect(screen.getByRole('textbox', { name: t(labels[key]) })).toHaveValue(fields[key])
    }
    await tick(800)
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expect(server.get('b1')?.shots[0]).toMatchObject({
      prompt_mode: 'structured', prompt_fields: fields,
      prompt: 'Scene: River at dawn. Action: Boat drifts. Camera: Slow pan. Look: Soft light. Audio: Birdsong.',
    })
    expect(server.get('b1')?.shots[1]).toMatchObject({ prompt: 'Independent simple shot', prompt_mode: 'simple', prompt_fields: null })
    view.unmount()
    await mountWorkspace()
    expect(screen.getByRole('button', { name: t('promptModeStructured') })).toHaveAttribute('aria-pressed', 'true')
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      expect(screen.getByRole('textbox', { name: t(labels[key]) })).toHaveValue(fields[key])
    }
    fireEvent.click(screen.getByTestId('shot-card-1'))
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Independent simple shot')
  })

  it.each([409, 503])('shows a %s save rejection, retains the edit through polls, and never queues generation', async (status) => {
    vi.mocked(api.saveBoard).mockRejectedValueOnce(new ApiError(status, 'Save rejected'))
    await mountWorkspace()
    editPrompt('Do not lose this edit')
    generate()
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent(`${status} Save rejected`)
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Do not lose this edit')
    await tick(5000)
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expect(api.generateShot).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Do not lose this edit')
    expectNoQueue()
    fireEvent.click(screen.getByRole('button', { name: t('retrySave') }))
    await settle()
    expect(api.saveBoard).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.saveBoard).mock.calls[1][0].shots[0].prompt).toBe('Do not lose this edit')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.generateShot).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it('shows a generation rejection after saving without falling back to legacy generation or adding a queue entry', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ detail: 'Generation validation rejected' }), { status: 422 }))
    await mountWorkspace()
    editPrompt('Valid local edit')
    generate()
    await settle()
    expect(server.get('b1')?.shots[0].prompt).toBe('Valid local edit')
    expect(api.generateShot).toHaveBeenCalledExactlyOnceWith('b1', 'b1-s1')
    expect(screen.getByRole('alert')).toHaveTextContent('422 Generation validation rejected')
    expect(screen.getByRole('button', { name: t('generateShot') })).toBeEnabled()
    expectNoQueue()
    await tick(5000)
    expect(api.generateShot).toHaveBeenCalledOnce()
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expectNoQueue()
  })

  it('does not let polls overwrite dirty data, an in-flight save, or a newer saved revision', async () => {
    const stale = clone(server.get('b1')!)
    const pending = deferred<Board>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => pending.promise)
    await mountWorkspace()
    await tick(2250)
    editPrompt('Survives all stale polls')
    await tick(250)
    expect(api.board).toHaveBeenCalledTimes(2)
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Survives all stale polls')
    await tick(550)
    expect(api.saveBoard).toHaveBeenCalledOnce()
    await tick(1950)
    expect(api.board).toHaveBeenCalledTimes(3)
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Survives all stale polls')
    await act(async () => { pending.resolve(persist(vi.mocked(api.saveBoard).mock.calls[0][0])) })
    vi.mocked(api.board).mockResolvedValueOnce(stale)
    await tick(2500)
    expect(api.board).toHaveBeenCalledTimes(4)
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Survives all stale polls')
    expect(api.saveBoard).toHaveBeenCalledOnce()
  })

  it('never retargets generation when the board and shot selection change while flushing an existing save', async () => {
    const pending = deferred<Board>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => pending.promise)
    await mountWorkspace()
    editPrompt('Generate original shot')
    await tick(800)
    generate()
    await settle()
    await switchBoard('b1', 'b2')
    fireEvent.click(screen.getByTestId('shot-card-1'))
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Prompt b2-s2')
    expect(api.generateShot).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(persist(vi.mocked(api.saveBoard).mock.calls[0][0])) })
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expect(api.generateShot).toHaveBeenCalledExactlyOnceWith('b1', 'b1-s1')
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Prompt b2-s2')
    expect(server.get('b2')).toEqual(board('b2'))
  })

  it('saves each original board independently when switched during an autosave and responses arrive out of order', async () => {
    const first = deferred<Board>(), second = deferred<Board>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    await mountWorkspace()
    editPrompt('A while saving')
    await tick(800)
    await switchBoard('b1', 'b2')
    editPrompt('B while A saves')
    await tick(800)
    expect(api.saveBoard).toHaveBeenCalledTimes(2)
    const [a, b] = vi.mocked(api.saveBoard).mock.calls.map(([value]) => value)
    expect(a).toMatchObject({ id: 'b1', shots: [expect.objectContaining({ id: 'b1-s1', prompt: 'A while saving' }), expect.anything()] })
    expect(b).toMatchObject({ id: 'b2', shots: [expect.objectContaining({ id: 'b2-s1', prompt: 'B while A saves' }), expect.anything()] })
    await act(async () => { second.resolve(persist(b)) })
    await act(async () => { first.resolve(persist(a)) })
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('B while A saves')
    await switchBoard('b2', 'b1')
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('A while saving')
    expect(api.saveBoard).toHaveBeenCalledTimes(2)
  })

  it('keeps a late flush rejection on the originating board instead of displaying it on the newly selected board', async () => {
    const pending = deferred<Board>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => pending.promise)
    await mountWorkspace()
    editPrompt('Original board unsaved edit')
    generate()
    await settle()
    await switchBoard('b1', 'b2')
    await act(async () => { pending.reject(new ApiError(409, 'Original board save conflict')) })
    expect(api.generateShot).not.toHaveBeenCalled()
    expectNoQueue()
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Prompt b2-s1')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await switchBoard('b2', 'b1')
    expect(screen.getByRole('alert')).toHaveTextContent('409 Original board save conflict')
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Original board unsaved edit')
    expect(api.saveBoard).toHaveBeenCalledOnce()
  })

  it('applies a late upload only to its original board and shot after both selections have changed', async () => {
    const pending = deferred<{ name: string }>()
    vi.spyOn(api, 'upload').mockReturnValueOnce(pending.promise)
    await mountWorkspace()
    const file = new File(['image fixture'], 'original.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText(t('refImages'), { selector: 'input' }), { target: { files: [file] } })
    expect(api.upload).toHaveBeenCalledExactlyOnceWith(file)
    expect(screen.getByRole('button', { name: t('generateShot') })).toBeDisabled()
    fireEvent.click(screen.getByTestId('shot-card-1'))
    await switchBoard('b1', 'b2')
    fireEvent.click(screen.getByTestId('shot-card-1'))
    await act(async () => { pending.resolve({ name: 'original-upload.png' }) })
    expect(screen.queryByRole('img', { name: t('refImages') })).not.toBeInTheDocument()
    await tick(800)
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expect(vi.mocked(api.saveBoard).mock.calls[0][0].id).toBe('b1')
    expect(server.get('b1')?.shots[0].ref_images).toEqual(['original-upload.png'])
    expect(server.get('b1')?.shots[1].ref_images).toBeUndefined()
    expect(server.get('b2')).toEqual(board('b2'))
    await switchBoard('b2', 'b1')
    expect(screen.getByRole('img', { name: t('refImages') })).toHaveAttribute('src', '/api/media/original-upload.png')
  })

  it('scopes resumable jobs to the selected board/shot and resumes the captured job ID, not reconstructed parameters', async () => {
    const makeJob = (id: string, params: Job['params']): Job => ({
      id, label: `Draft ${id}`, status: 'done', phase: null, done: 4, total: 20,
      created: 1, checkpoint: `${id}.checkpoint`, params,
    })
    jobs = [
      makeJob('unscoped', { prompt: 'Legacy unscoped job' }),
      makeJob('wrong-board', { board_id: 'b2', shot_id: 'b1-s1' }),
      makeJob('wrong-shot', { board_id: 'b1', shot_id: 'missing-shot' }),
      makeJob('job /#', { board_id: 'b1', shot_id: 'b1-s2', prompt: 'Original generation prompt', seed: 123, steps: 20 }),
    ]
    const pending = deferred<Board>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => pending.promise)
    await mountWorkspace()
    expect(screen.queryByRole('button', { name: t('resumeRun') })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('shot-card-1'))
    expect(screen.getByText('Draft job /#')).toBeInTheDocument()
    editPrompt('Current editor differs from original job params')
    fireEvent.click(screen.getByRole('button', { name: t('resumeRun') }))
    await settle()
    expect(api.resumeJob).not.toHaveBeenCalled()
    await switchBoard('b1', 'b2')
    expect(screen.queryByRole('button', { name: t('resumeRun') })).not.toBeInTheDocument()
    await act(async () => { pending.resolve(persist(vi.mocked(api.saveBoard).mock.calls[0][0])) })
    expect(api.resumeJob).toHaveBeenCalledExactlyOnceWith('job /#')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/jobs/job%20%2F%23/resume', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
    expect(api.generate).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
    expect(server.get('b1')?.shots[1].prompt).toBe('Current editor differs from original job params')
    expect(server.get('b2')).toEqual(board('b2'))
  })

  it('uses each successful modifiedAt for the next save rather than reusing the initial revision', async () => {
    await mountWorkspace()
    editPrompt('First save')
    await tick(800)
    expect(server.get('b1')?.modifiedAt).toBe(11)
    editPrompt('Second save')
    await tick(800)
    expect(api.saveBoard).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.saveBoard).mock.calls.map(([b]) => b.modifiedAt)).toEqual([10, 11])
    expect(server.get('b1')).toMatchObject({ modifiedAt: 12, createdAt: 1 })
    expect(server.get('b1')?.shots[0].prompt).toBe('Second save')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps library playback transient and never persists it as the board result on a later edit', async () => {
    server.set('b1', board('b1', { result: 'board-result.mp4' }))
    videos = [{ name: 'library-only.mp4', size: 10, mtime: 1, duration: 5 }]
    const { container } = await mountWorkspace()
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/board-result.mp4')
    fireEvent.click(screen.getAllByRole('button', { name: `${t('play')} · library-only.mp4` })[0])
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/library-only.mp4')
    await tick(800)
    expect(api.saveBoard).not.toHaveBeenCalled()
    editPrompt('An unrelated persisted edit')
    await tick(800)
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expect(vi.mocked(api.saveBoard).mock.calls[0][0].result).toBe('board-result.mp4')
    expect(server.get('b1')?.result).toBe('board-result.mp4')
    fireEvent.click(screen.getByTestId('shot-card-1'))
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/board-result.mp4')
    fireEvent.click(screen.getAllByRole('button', { name: `${t('play')} · library-only.mp4` })[0])
    await switchBoard('b1', 'b2')
    await switchBoard('b2', 'b1')
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/board-result.mp4')
  })

  it('warns before unload for dirty or in-flight drafts even on another board, and removes the listener on unmount', async () => {
    const pending = deferred<Board>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => pending.promise)
    const view = await mountWorkspace()
    const warned = () => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(warned()).toBe(false)
    editPrompt('Unsaved at unload')
    expect(warned()).toBe(true)
    await tick(800)
    expect(warned()).toBe(true)
    await switchBoard('b1', 'b2')
    expect(warned()).toBe(true)
    await act(async () => { pending.resolve(persist(vi.mocked(api.saveBoard).mock.calls[0][0])) })
    expect(warned()).toBe(false)
    editPrompt('Dirty again before unmount')
    expect(warned()).toBe(true)
    view.unmount()
    expect(warned()).toBe(false)
  })

  it('discards a conflicted edit only after explicit confirmation, not on polling or a cancelled reload', async () => {
    vi.mocked(api.saveBoard).mockRejectedValueOnce(new ApiError(409, 'Board changed on server'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mountWorkspace()
    editPrompt('Conflicting local edit')
    await tick(800)
    server.set('b1', board('b1', { shots: [shot('b1-s1', { prompt: 'Other writer' }), shot('b1-s2')], modifiedAt: 11 }))
    await tick(1700)
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Conflicting local edit')
    const reads = vi.mocked(api.board).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: t('reloadBoard') }))
    await settle()
    expect(confirm).toHaveBeenCalledExactlyOnceWith(t('discardDraftConfirm'))
    expect(api.board).toHaveBeenCalledTimes(reads)
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Conflicting local edit')
    confirm.mockReturnValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: t('reloadBoard') }))
    await settle()
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Other writer')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expect(api.generateShot).not.toHaveBeenCalled()
  })
})

describe('Workspace take integration through the real route', () => {
  it.each(['play selected', 'return selected', 'adopt'] as const)('follows a newer canonical selection after %s and reload, without pinning an old take', async (action) => {
    const s = takenShot('b1-s1'), [old, adopted] = s.takes!
    server.set('b1', board('b1', { shots: [s], result: 'assembled.mp4' }))
    const view = await mountWorkspace()
    if (action === 'adopt') {
      fetchMock.mockImplementationOnce(async () => jsonResponse(updateServerShot('b1', s.id,
        { selected_take_id: old.id, output: old.output }, { result: null })))
      fireEvent.click(takeControl(old.id, 'takeSelect', 1))
      await settle()
    } else if (action === 'return selected') {
      fireEvent.click(takeControl(old.id, 'play', 1))
      fireEvent.click(screen.getByRole('button', { name: t('takeReturnSelected') }))
    } else {
      fireEvent.click(takeControl(adopted.id, 'play', 2))
    }
    const newer = take('new-success', s.id)
    // A successful later generation or another client adopts a new canonical take.
    updateServerShot('b1', s.id, { takes: [...s.takes!, newer], selected_take_id: newer.id, output: newer.output }, { result: null })
    await tick(2500)
    expect(view.container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/new-success.mp4')
    expect(screen.getByTitle(`${t('takeLabel')} 3 · ${t('takeSelected')}`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('takeReturnSelected') })).not.toBeInTheDocument()
    view.unmount()
    const reloaded = await mountWorkspace()
    expect(reloaded.container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/new-success.mp4')
    expect(api.generateShot).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it('does not let a late concat response clear a historical preview on another board', async () => {
    server.set('b1', board('b1', { shots: [takenShot('b1-s1'), takenShot('b1-s2')] }))
    const s = takenShot('b2-s1'), [old] = s.takes!
    server.set('b2', board('b2', { shots: [s] }))
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const { container } = await mountWorkspace()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('concat')) }))
    await settle()
    expect(api.concatBoard).toHaveBeenCalledExactlyOnceWith('b1')
    await switchBoard('b1', 'b2')
    fireEvent.click(takeControl(old.id, 'play', 1))
    await act(async () => { pending.resolve(jsonResponse({ output: 'b1-export.mp4' })) })
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${old.output}`)
    expect(screen.getByRole('button', { name: t('takeReturnSelected') })).toBeInTheDocument()
    expect(api.selectTake).not.toHaveBeenCalled()
  })

  it('previews an old take only on the client, labels it preview-only, and returns to the adopted take rather than the board result', async () => {
    const s = takenShot('b1-s1'), [old, adopted] = s.takes!
    const original = board('b1', { shots: [s], result: 'assembled.mp4' })
    server.set('b1', clone(original))
    const { container } = await mountWorkspace()
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/assembled.mp4')
    fireEvent.click(takeControl(old.id, 'play', 1))
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(old.output)}`)
    expect(screen.getByTitle(`${t('takeLabel')} 1 · ${t('takePreviewOnly')}`)).toBeInTheDocument()
    expect(takeControl(old.id, 'play', 1)).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByTestId(`take-${old.id}`)).queryByText(t('takeSelected'))).not.toBeInTheDocument()
    expect(within(screen.getByTestId(`take-${adopted.id}`)).getByText(t('takeSelected'))).toBeInTheDocument()
    fireEvent.click(within(screen.getByTestId(`take-${old.id}`)).getByText(t('takeSnapshot')))
    expect(within(screen.getByTestId(`take-${old.id}`)).getByText(t('prompt'), { selector: 'dt' }).nextElementSibling)
      .toHaveTextContent(`Historical prompt ${old.id}`)
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue(s.prompt)
    await tick(5000)
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(old.output)}`)
    fireEvent.click(screen.getByRole('button', { name: t('takeReturnSelected') }))
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(adopted.output)}`)
    expect(screen.getByTitle(`${t('takeLabel')} 2 · ${t('takeSelected')}`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('takeReturnSelected') })).not.toBeInTheDocument()
    await tick(800)
    expect(server.get('b1')).toEqual(original)
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(api.selectTake).not.toHaveBeenCalled()
    expect(api.deleteTake).not.toHaveBeenCalled()
    expect(api.deleteVideo).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
    expect(api.resumeJob).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it('flushes a dirty prompt before the encoded bodyless adoption POST and keeps its returned snapshot over stale polls', async () => {
    const id = 'board #1', shotId = 'shot /?', takeId = 'take /?#'
    const old = take(takeId, shotId, { output: 'historical take #1.mp4' }), adopted = take('adopted', shotId)
    const s = takenShot(shotId, { takes: [old, adopted], selected_take_id: adopted.id, output: adopted.output })
    server.set(id, board(id, { shots: [s], result: 'outdated-concat.mp4' }))
    const pendingSave = deferred<Board>(), pendingSelect = deferred<Response>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => pendingSave.promise)
    fetchMock.mockReturnValueOnce(pendingSelect.promise)
    const { container } = await mountWorkspace(id)
    editPrompt('New editor prompt, not historical request')
    fireEvent.click(takeControl(old.id, 'takeSelect', 1))
    await settle()
    expect(api.saveBoard).toHaveBeenCalledOnce()
    const submitted = vi.mocked(api.saveBoard).mock.calls[0][0]
    expect(submitted.shots[0]).toMatchObject({ prompt: 'New editor prompt, not historical request', selected_take_id: adopted.id })
    expect(submitted.shots[0].takes).toEqual(s.takes)
    expect(api.selectTake).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(takeControl(old.id, 'takeSelect', 1)).toBeDisabled()
    await act(async () => { pendingSave.resolve(persist(submitted)) })
    expect(api.selectTake).toHaveBeenCalledExactlyOnceWith(id, shotId, takeId)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/boards/board%20%231/shots/shot%20%2F%3F/takes/take%20%2F%3F%23/select', expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
    expect(within(screen.getByTestId(`take-${adopted.id}`)).getByText(t('takeSelected'))).toBeInTheDocument()
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/outdated-concat.mp4')
    for (const control of within(screen.getByTestId(`take-${old.id}`)).getAllByRole('button')) {
      expect(control).toBeDisabled()
    }
    const stale = clone(server.get(id)!)
    vi.mocked(api.board).mockResolvedValue(stale)
    await act(async () => {
      pendingSelect.resolve(jsonResponse(updateServerShot(id, shotId, { selected_take_id: old.id, output: old.output }, { result: null })))
    })
    await tick(5000)
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(old.output)}`)
    expect(screen.getByTitle(`${t('takeLabel')} 1 · ${t('takeSelected')}`)).toBeInTheDocument()
    expect(takeControl(old.id, 'takeSelect', 1)).toBeDisabled()
    expect(takeControl(adopted.id, 'takeSelect', 2)).toBeEnabled()
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('New editor prompt, not historical request')
    expect(within(screen.getByTestId(`take-${old.id}`)).getByText(t('prompt'), { selector: 'dt' }).nextElementSibling)
      .toHaveTextContent(`Historical prompt ${old.id}`)
    expect(server.get(id)?.shots[0].takes).toEqual(s.takes)
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expect(api.selectTake).toHaveBeenCalledOnce()
    expect(api.deleteTake).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it.each(['shot', 'board'] as const)('applies a late adoption only to its original board/shot after %s navigation without stealing playback', async (navigation) => {
    const first = takenShot('b1-s1'), old = first.takes![0]
    const original = board('b1', { shots: [first, takenShot('b1-s2')] })
    const other = board('b2', { shots: [takenShot('b2-s1'), takenShot('b2-s2')] })
    server.set('b1', clone(original))
    server.set('b2', clone(other))
    videos = [{ name: 'navigation-preview.mp4', size: 10, mtime: 1, duration: 5 }]
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const { container } = await mountWorkspace()
    fireEvent.click(takeControl(old.id, 'takeSelect', 1))
    await settle()
    fireEvent.click(screen.getByTestId('shot-card-1'))
    if (navigation === 'board') {
      await switchBoard('b1', 'b2')
      fireEvent.click(screen.getByTestId('shot-card-1'))
    }
    fireEvent.click(screen.getAllByRole('button', { name: `${t('play')} · ${videos[0].name}` })[0])
    await act(async () => {
      pending.resolve(jsonResponse(updateServerShot('b1', first.id, { selected_take_id: old.id, output: old.output }, { result: null })))
    })
    const current = navigation === 'board' ? other.shots[1] : original.shots[1]
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue(current.prompt)
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/navigation-preview.mp4')
    expect(within(screen.getByTestId(`take-${current.selected_take_id}`)).getByText(t('takeSelected'))).toBeInTheDocument()
    expect(server.get('b1')?.shots[1]).toEqual(original.shots[1])
    expect(server.get('b2')).toEqual(other)
    // Returning must use the mutation response, even if the navigation read is stale.
    vi.mocked(api.board).mockImplementation(async (id) => clone(id === 'b1' ? original : server.get(id)!))
    if (navigation === 'board') await switchBoard('b2', 'b1')
    else fireEvent.click(screen.getByTestId('shot-card-0'))
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(old.output)}`)
    expect(within(screen.getByTestId(`take-${old.id}`)).getByText(t('takeSelected'))).toBeInTheDocument()
    expect(api.selectTake).toHaveBeenCalledExactlyOnceWith('b1', first.id, old.id)
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(api.deleteTake).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it('does not steal a newer library preview when deletion finishes on the same board and shot', async () => {
    const s = takenShot('b1-s1'), [old, adopted] = s.takes!
    server.set('b1', board('b1', { shots: [s] }))
    videos = [{ name: 'newer-preview.mp4', size: 10, mtime: 1, duration: 5 }]
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const { container } = await mountWorkspace()
    fireEvent.click(takeControl(old.id, 'play', 1))
    fireEvent.click(takeControl(old.id, 'takeDelete', 1))
    await settle()
    expect(api.deleteTake).toHaveBeenCalledExactlyOnceWith('b1', s.id, old.id)
    expect(screen.getByTestId(`take-${old.id}`)).toBeInTheDocument()
    expect(takeControl(old.id, 'takeDelete', 1)).toBeDisabled()
    fireEvent.click(screen.getAllByRole('button', { name: `${t('play')} · newer-preview.mp4` })[0])
    await act(async () => { pending.resolve(jsonResponse(updateServerShot('b1', s.id, { takes: [adopted] }))) })
    expect(screen.queryByTestId(`take-${old.id}`)).not.toBeInTheDocument()
    expect(within(screen.getByTestId(`take-${adopted.id}`)).getByText(t('takeSelected'))).toBeInTheDocument()
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', '/outputs/newer-preview.mp4')
    expect(screen.queryByRole('button', { name: t('takeReturnSelected') })).not.toBeInTheDocument()
    expect(api.deleteVideo).not.toHaveBeenCalled()
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('disables selected/missing take mutations and locks every take control while this board or any of its shots is active', async () => {
    const s = takenShot('b1-s1'), [old, adopted] = s.takes!
    const missing = take('missing', s.id, { missing: true })
    s.takes!.push(missing)
    const original = board('b1', { shots: [s, shot('b1-s2')] })
    server.set('b1', clone(original))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mountWorkspace()
    expect(takeControl(adopted.id, 'play', 2)).toBeEnabled()
    expect(takeControl(old.id, 'takeSelect', 1)).toBeEnabled()
    expect(takeControl(missing.id, 'takeDelete', 3)).toBeEnabled()
    for (const [id, key, ordinal] of [
      [adopted.id, 'takeSelect', 2], [adopted.id, 'takeDelete', 2],
      [missing.id, 'play', 3], [missing.id, 'takeSelect', 3],
    ] as const) {
      expect(takeControl(id, key, ordinal)).toBeDisabled()
      fireEvent.click(takeControl(id, key, ordinal))
    }
    for (const [boardStatus, shotStatus] of [['running', 'idle'], ['idle', 'queued'], ['idle', 'running']]) {
      updateServerShot('b1', 'b1-s2', { status: shotStatus }, { status: boardStatus })
      await tick(2500)
      expect(screen.getByText(t('takeBusy'))).toHaveAttribute('role', 'status')
      for (const item of s.takes!) {
        for (const control of within(screen.getByTestId(`take-${item.id}`)).getAllByRole('button')) {
          expect(control).toBeDisabled()
          fireEvent.click(control)
        }
      }
    }
    updateServerShot('b1', 'b1-s2', { status: 'idle' }, { status: 'idle' })
    await tick(2500)
    expect(takeControl(old.id, 'takeSelect', 1)).toBeEnabled()
    expect(takeControl(old.id, 'takeDelete', 1)).toBeEnabled()
    expect(takeControl(adopted.id, 'takeDelete', 2)).toBeDisabled()
    expect(takeControl(missing.id, 'takeSelect', 3)).toBeDisabled()
    expect(confirm).not.toHaveBeenCalled()
    expect(api.selectTake).not.toHaveBeenCalled()
    expect(api.deleteTake).not.toHaveBeenCalled()
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it('cancels metadata deletion without a request, then confirms an encoded bodyless DELETE while retaining the original video', async () => {
    const id = 'board #1', shotId = 'shot /?'
    const old = take('take /?#', shotId, { output: 'retained take #1.mp4' }), adopted = take('adopted', shotId)
    const s = takenShot(shotId, { takes: [old, adopted], selected_take_id: adopted.id, output: adopted.output })
    const original = board(id, { shots: [s] })
    server.set(id, clone(original))
    videos = [{ name: old.output, size: 10, mtime: 1, duration: 5 }]
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container } = await mountWorkspace(id)
    fireEvent.click(takeControl(old.id, 'play', 1))
    fireEvent.click(takeControl(old.id, 'takeDelete', 1))
    await settle()
    expect(confirm).toHaveBeenCalledExactlyOnceWith(t('takeDeleteConfirm'))
    expect(api.deleteTake).not.toHaveBeenCalled()
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(server.get(id)).toEqual(original)
    expect(screen.getByTestId(`take-${old.id}`)).toBeInTheDocument()
    confirm.mockReturnValueOnce(true)
    fetchMock.mockImplementationOnce(async () => jsonResponse(updateServerShot(id, shotId, { takes: [adopted] })))
    fireEvent.click(takeControl(old.id, 'takeDelete', 1))
    await settle()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(api.deleteTake).toHaveBeenCalledExactlyOnceWith(id, shotId, old.id)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/boards/board%20%231/shots/shot%20%2F%3F/takes/take%20%2F%3F%23', expect.objectContaining({ method: 'DELETE' }),
    )
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
    expect(screen.queryByTestId(`take-${old.id}`)).not.toBeInTheDocument()
    expect(within(screen.getByTestId(`take-${adopted.id}`)).getByText(t('takeSelected'))).toBeInTheDocument()
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(adopted.output)}`)
    expect(server.get(id)?.shots[0].takes).toEqual([adopted])
    fireEvent.click(screen.getAllByRole('button', { name: `${t('play')} · ${old.output}` })[0])
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(old.output)}`)
    expect(api.deleteVideo).not.toHaveBeenCalled()
    expect(api.selectTake).not.toHaveBeenCalled()
    expect(api.saveBoard).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it.each([409, 503])('shows %s adoption and deletion failures without changing the adopted take or removing history', async (status) => {
    const s = takenShot('b1-s1'), [old, adopted] = s.takes!
    const original = board('b1', { shots: [s] })
    server.set('b1', clone(original))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { container } = await mountWorkspace()
    fireEvent.click(takeControl(old.id, 'play', 1))
    for (const [action, failure] of [['takeSelect', 'takeSelectFailed'], ['takeDelete', 'takeDeleteFailed']] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse({ detail: 'Take mutation rejected' }, status))
      fireEvent.click(takeControl(old.id, action, 1))
      await settle()
      expect(screen.getByRole('alert')).toHaveTextContent(`${t(failure)}: ${status} Take mutation rejected`)
      await tick(5000)
      expect(screen.getByRole('alert')).toHaveTextContent(`${status} Take mutation rejected`)
      expect(server.get('b1')).toEqual(original)
      expect(within(screen.getByTestId(`take-${adopted.id}`)).getByText(t('takeSelected'))).toBeInTheDocument()
      expect(within(screen.getByTestId(`take-${old.id}`)).queryByText(t('takeSelected'))).not.toBeInTheDocument()
      expect(takeControl(old.id, 'takeSelect', 1)).toBeEnabled()
      expect(takeControl(old.id, 'takeDelete', 1)).toBeEnabled()
      expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(old.output)}`)
    }
    fireEvent.click(screen.getByRole('button', { name: t('takeReturnSelected') }))
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(adopted.output)}`)
    expect(api.selectTake).toHaveBeenCalledExactlyOnceWith('b1', s.id, old.id)
    expect(api.deleteTake).toHaveBeenCalledExactlyOnceWith('b1', s.id, old.id)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(api.deleteVideo).not.toHaveBeenCalled()
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it('blocks concat and sequence for a missing adopted output even with two playable shots, until another take is actually adopted', async () => {
    const s = takenShot('b1-s1', { output_missing: true }), [old, adopted] = s.takes!
    adopted.missing = true
    const second = takenShot('b1-s2'), third = takenShot('b1-s3')
    server.set('b1', board('b1', { shots: [s, second, third] }))
    const { container } = await mountWorkspace()
    expect(screen.getByText(t('takeSequenceMissing'))).toHaveAttribute('role', 'status')
    expect(container.querySelector('video[controls]')).toBeNull()
    expect(takeControl(adopted.id, 'play', 2)).toBeDisabled()
    expect(within(screen.getByTestId(`take-${adopted.id}`)).getByText(t('takeMissing'))).toBeInTheDocument()
    fireEvent.click(takeControl(old.id, 'play', 1))
    const concat = screen.getByRole('button', { name: `⇢ ${t('concat')} 2/3` })
    const sequence = screen.getByRole('button', { name: `▶ ${t('sequencePreview')}` })
    for (const control of [concat, sequence]) {
      expect(control).toBeDisabled()
      expect(control).toHaveAttribute('title', t('takeSequenceMissing'))
      fireEvent.click(control)
    }
    await settle()
    expect(api.concatBoard).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: `■ ${t('stopSequence')}` })).not.toBeInTheDocument()
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(old.output)}`)
    fetchMock.mockImplementationOnce(async () => jsonResponse(updateServerShot('b1', s.id, {
      selected_take_id: old.id, output: old.output, output_missing: false,
    }, { result: null })))
    fireEvent.click(takeControl(old.id, 'takeSelect', 1))
    await settle()
    expect(screen.queryByText(t('takeSequenceMissing'))).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: `⇢ ${t('concat')} 3/3` })).toBeEnabled()
    expect(sequence).toBeEnabled()
    fireEvent.click(sequence)
    for (const output of [old.output, second.output!, third.output!]) {
      const video = container.querySelector('video[controls]')!
      expect(video).toHaveAttribute('src', `/outputs/${encodeURIComponent(output)}`)
      expect(video).not.toHaveAttribute('loop')
      fireEvent.ended(video)
    }
    expect(screen.queryByRole('button', { name: `■ ${t('stopSequence')}` })).not.toBeInTheDocument()
    expect(api.selectTake).toHaveBeenCalledExactlyOnceWith('b1', s.id, old.id)
    expect(api.generateShot).not.toHaveBeenCalled()
    expect(api.saveBoard).not.toHaveBeenCalled()
    expectNoQueue()
  })

  it('keeps successful old takes playable and adoptable after a queued regeneration fails', async () => {
    const s = takenShot('b1-s1'), [old, adopted] = s.takes!
    server.set('b1', board('b1', { shots: [s] }))
    const retry: Job = {
      id: 'failed-retry', label: 'Retry', status: 'queued', phase: null, done: 0, total: 20,
      created: 2, params: { board_id: 'b1', shot_id: s.id },
    }
    fetchMock.mockImplementationOnce(async () => {
      jobs = [clone(retry)]
      updateServerShot('b1', s.id, { status: 'queued', job_id: retry.id }, { status: 'running' })
      return jsonResponse({ job_id: retry.id })
    })
    const { container } = await mountWorkspace()
    fireEvent.click(screen.getByRole('button', { name: t('regenerateShot') }))
    await settle()
    expect(api.generateShot).toHaveBeenCalledExactlyOnceWith('b1', s.id)
    expect(takeControl(old.id, 'takeSelect', 1)).toBeDisabled()
    jobs = [{ ...retry, status: 'error', finished: 3 }]
    updateServerShot('b1', s.id, { status: 'error' }, { status: 'error' })
    await tick(2500)
    expect(server.get('b1')?.shots[0]).toMatchObject({
      status: 'error', job_id: retry.id, output: adopted.output, selected_take_id: adopted.id, takes: s.takes,
    })
    expect(within(screen.getByRole('list', { name: t('takeHistory') })).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('button', { name: t('regenerateShot') })).toBeEnabled()
    expect(takeControl(old.id, 'play', 1)).toBeEnabled()
    expect(takeControl(old.id, 'takeSelect', 1)).toBeEnabled()
    fireEvent.click(takeControl(old.id, 'play', 1))
    expect(container.querySelector('video[controls]')).toHaveAttribute('src', `/outputs/${encodeURIComponent(old.output)}`)
    fetchMock.mockImplementationOnce(async () => jsonResponse(updateServerShot('b1', s.id, {
      selected_take_id: old.id, output: old.output,
    }, { result: null })))
    fireEvent.click(takeControl(old.id, 'takeSelect', 1))
    await settle()
    expect(screen.getByTitle(`${t('takeLabel')} 1 · ${t('takeSelected')}`)).toBeInTheDocument()
    expect(server.get('b1')?.shots[0].takes).toEqual(s.takes)
    expect(api.generateShot).toHaveBeenCalledOnce()
    expect(api.selectTake).toHaveBeenCalledExactlyOnceWith('b1', s.id, old.id)
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(api.deleteTake).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expectNoQueue()
  })

  it('clears duplicated server-owned take/output/job/continuity fields immediately, before any save response can sanitize them', async () => {
    const source = takenShot('b1-s1', { status: 'error', job_id: 'failed-job', continuity_state: 'stale', stale: true, output_missing: true })
    source.takes![1].missing = true
    const original = board('b1', { shots: [source] })
    server.set('b1', clone(original))
    const pending = deferred<Board>()
    vi.mocked(api.saveBoard).mockImplementationOnce(() => pending.promise)
    const { container } = await mountWorkspace()
    fireEvent.click(within(screen.getByTestId('shot-card-0')).getByTestId('shot-duplicate'))
    expect(screen.getByText(t('takeEmpty'))).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: t('takeHistory') })).not.toBeInTheDocument()
    expect(container.querySelector('video[controls]')).toBeNull()
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue(source.prompt)
    const duplicateCard = within(screen.getByTestId('shot-card-1'))
    expect(duplicateCard.getByText(`${t('takeLabel')} · 0`)).toBeInTheDocument()
    expect(duplicateCard.queryByText(t('takeStale'))).not.toBeInTheDocument()
    expect(duplicateCard.queryByText(t('takeMissing'))).not.toBeInTheDocument()
    expect(api.saveBoard).not.toHaveBeenCalled()
    await tick(800)
    expect(api.saveBoard).toHaveBeenCalledOnce()
    const submitted = vi.mocked(api.saveBoard).mock.calls[0][0]
    const duplicate = submitted.shots[1]
    expect(duplicate.id).not.toBe(source.id)
    expect(duplicate).toEqual({
      ...source, id: duplicate.id, status: 'idle', output: null, job_id: null,
      takes: [], selected_take_id: null, continuity_state: 'none', stale: false, output_missing: false,
    })
    expect(submitted.shots[0]).toEqual(source)
    expect(server.get('b1')).toEqual(original)
    await act(async () => { pending.resolve(persist(submitted)) })
    expect(server.get('b1')?.shots).toEqual([source, duplicate])
    expect(api.selectTake).not.toHaveBeenCalled()
    expect(api.deleteTake).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expectNoQueue()
  })
})