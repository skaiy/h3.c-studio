import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type Board, type BoardSummary, type Job, type Shot, type VideoItem } from '@/lib/api'
import { translate, type StudioI18nKey } from '@/lib/i18nResources'
import Workspace from './Workspace'

const t = (key: StudioI18nKey) => translate('zh', key)
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const readBoard = api.board
const persistenceDetail = 'Storyboard persistence is unavailable; all writes are blocked. Stop the backend, back up the original file, restore a known-good copy, then restart.'

function shot(id: string, overrides: Partial<Shot> = {}): Shot {
  return {
    id, prompt: `Prompt ${id}`, width: 768, height: 768, seconds: 5,
    steps: 20, layers: 45, reuse: 2, seed: 42, first_frame: null, last_frame: null,
    status: 'idle', output: null, job_id: null, ...overrides,
  }
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
  const saved = clone({ ...b, modifiedAt: previous.modifiedAt + 1 })
  server.set(b.id, saved)
  return clone(saved)
}

// Flush React/microtasks without advancing the autosave or polling clocks.
async function settle() { await act(async () => {}) }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

function renderRoute(path = '/') {
  const router = createMemoryRouter([
    { path: '/', element: <Workspace /> },
    { path: '/b/:boardId', element: <Workspace /> },
  ], { initialEntries: [path] })
  return { ...render(<RouterProvider router={router} />), router }
}

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
  // All normal reads/saves are API mocks. Generation/resume intentionally retain
  // their real HTTP implementation so route tests also verify the wire contract.
  vi.spyOn(api, 'boards').mockImplementation(async () => [...server.values()].map(summary))
  vi.spyOn(api, 'board').mockImplementation(async (id) => clone(server.get(id)!))
  vi.spyOn(api, 'saveBoard').mockImplementation(async (b) => persist(b))
  vi.spyOn(api, 'jobs').mockImplementation(async () => clone(jobs))
  vi.spyOn(api, 'videos').mockImplementation(async () => clone(videos))
  vi.spyOn(api, 'info').mockResolvedValue({ info: 'Device: Test CPU' })
  vi.spyOn(api, 'generateShot')
  vi.spyOn(api, 'resumeJob')
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

describe('Workspace load failure recovery', () => {
  it('shows a root list failure without creating a board, keeps Settings accessible, and retries successfully', async () => {
    vi.mocked(api.boards).mockRejectedValueOnce(new ApiError(503, persistenceDetail))
    const { router } = renderRoute()
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent(persistenceDetail)
    expect(screen.getByRole('alert')).toHaveTextContent(t('boardLoadHint'))
    expect(api.boards).toHaveBeenCalledOnce()
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(api.board).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('settingsTitle') }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(t('settingsAuthPlaceholder'))).toHaveAttribute('type', 'password')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: t('retryLoad') }))
    await settle()
    expect(router.state.location.pathname).toBe('/b/b1')
    expect(screen.getByDisplayValue('Board b1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.saveBoard).not.toHaveBeenCalled()
  })

  it('shows the sanitized API detail on a failed deep link and recovers on retry without a save', async () => {
    vi.mocked(api.board).mockImplementationOnce(readBoard)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      detail: persistenceDetail, code: 'board_persistence_unavailable', reason: 'invalid_json',
    }), { status: 503 }))
    const { router } = renderRoute('/b/b1')
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent(`503 ${persistenceDetail}`)
    expect(screen.getByRole('alert')).not.toHaveTextContent('invalid_json')
    expect(screen.queryByDisplayValue('Board b1')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('settingsTitle') })).toBeEnabled()
    expect(api.saveBoard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: t('retryLoad') }))
    await settle()
    expect(router.state.location.pathname).toBe('/b/b1')
    expect(screen.getByDisplayValue('Board b1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.saveBoard).not.toHaveBeenCalled()
  })

  it('creates exactly once when the initial list genuinely succeeds with no boards', async () => {
    server.clear()
    vi.mocked(api.saveBoard).mockImplementationOnce(async (value) => {
      const created = { ...value, id: 'created', createdAt: 1, modifiedAt: 1 }
      server.set(created.id, created)
      return clone(created)
    })
    const { router } = renderRoute()
    await settle()
    expect(api.saveBoard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: '', shots: [] }))
    expect(router.state.location.pathname).toBe('/b/created')
    expect(screen.getByDisplayValue('未命名分镜')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('catches rejected initial creation and does not retry writes automatically', async () => {
    vi.mocked(api.boards).mockResolvedValue([])
    vi.mocked(api.saveBoard).mockRejectedValueOnce(new ApiError(401, 'Authentication required'))
    const { router } = renderRoute()
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('401 Authentication required')
    expect(screen.getByRole('button', { name: t('settingsTitle') })).toBeEnabled()
    expect(screen.getByRole('button', { name: t('retryLoad') })).toBeEnabled()
    await tick(5000)
    expect(api.saveBoard).toHaveBeenCalledOnce()
    expect(router.state.location.pathname).toBe('/')
  })

  it('does not hide a list failure when the deep-linked board loads successfully', async () => {
    vi.mocked(api.boards).mockRejectedValueOnce(new ApiError(503, 'List unavailable'))
    await mountWorkspace()
    expect(screen.getByRole('alert')).toHaveTextContent('503 List unavailable')
    await tick(2500)
    expect(screen.getByRole('alert')).toHaveTextContent('503 List unavailable')
    expect(api.saveBoard).not.toHaveBeenCalled()
  })

  it('ignores an older empty list when overlapping retries resolve out of order', async () => {
    vi.mocked(api.boards).mockRejectedValueOnce(new ApiError(503, 'List unavailable'))
    const { router } = renderRoute()
    await settle()
    const pending = deferred<BoardSummary[]>()
    vi.mocked(api.boards).mockReturnValueOnce(pending.promise)
    fireEvent.click(screen.getByRole('button', { name: t('retryLoad') }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: t('retryLoad') }))
    await settle()
    await act(async () => { pending.resolve([]) })
    expect(router.state.location.pathname).toBe('/b/b1')
    expect(screen.getByDisplayValue('Board b1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.saveBoard).not.toHaveBeenCalled()
  })

  it.each(['empty', 'existing', 'failure'] as const)('ignores a cancelled root list response: %s', async (result) => {
    const pending = deferred<BoardSummary[]>()
    vi.mocked(api.boards).mockReturnValueOnce(pending.promise)
    const { router } = renderRoute()
    await settle()
    await act(async () => { await router.navigate('/b/b2') })
    await act(async () => {
      if (result === 'failure') pending.reject(new ApiError(503, 'Stale root failure'))
      else pending.resolve(result === 'empty' ? [] : [summary(server.get('b1')!)])
    })
    expect(router.state.location.pathname).toBe('/b/b2')
    expect(screen.getByDisplayValue('Board b2')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.saveBoard).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('ignores a cancelled auto-create response: %s', async (result) => {
    const pending = deferred<Board>()
    vi.mocked(api.boards).mockResolvedValueOnce([])
    vi.mocked(api.saveBoard).mockReturnValueOnce(pending.promise)
    const { router } = renderRoute()
    await settle()
    expect(api.saveBoard).toHaveBeenCalledOnce()
    await act(async () => { await router.navigate('/b/b2') })
    await act(async () => {
      if (result === 'failure') pending.reject(new ApiError(503, 'Stale creation failure'))
      else pending.resolve(board('created'))
    })
    expect(router.state.location.pathname).toBe('/b/b2')
    expect(screen.getByDisplayValue('Board b2')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores a late board failure after navigating away and returning to a successful newer read', async () => {
    const pending = deferred<Board>()
    vi.mocked(api.board).mockReturnValueOnce(pending.promise)
    const { router } = renderRoute('/b/b1')
    await settle()
    await act(async () => { await router.navigate('/b/b2') })
    await act(async () => { await router.navigate('/b/b1') })
    await act(async () => { pending.reject(new ApiError(503, 'Stale board failure')) })
    expect(screen.getByDisplayValue('Board b1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(api.saveBoard).not.toHaveBeenCalled()
  })

  it('ignores an old poll failure after retry succeeds and preserves unsaved local edits', async () => {
    await mountWorkspace()
    vi.mocked(api.board).mockRejectedValueOnce(new ApiError(503, persistenceDetail))
    await tick(2500)
    expect(screen.getByRole('alert')).toHaveTextContent(persistenceDetail)
    const pending = deferred<Board>()
    vi.mocked(api.board).mockReturnValueOnce(pending.promise)
    await tick(2500)
    editPrompt('Keep this local edit across retry')
    fireEvent.click(screen.getByRole('button', { name: t('retryLoad') }))
    await settle()
    await act(async () => { pending.reject(new ApiError(503, 'Stale poll failure')) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Keep this local edit across retry')
    expect(api.saveBoard).not.toHaveBeenCalled()
  })

  it('does not create a replacement after deletion if the remaining-board list fails', async () => {
    await mountWorkspace()
    vi.spyOn(api, 'deleteBoard').mockResolvedValue({})
    vi.mocked(api.boards).mockRejectedValue(new ApiError(503, 'List unavailable after deletion'))
    fireEvent.click(screen.getByRole('button', { name: 'Board b1 ▾' }))
    const row = screen.getByText('Board b1', { selector: 'span' }).closest('.group') as HTMLElement
    fireEvent.click(within(row).getByTitle(t('delete')))
    await settle()
    fireEvent.click(within(row).getByRole('button', { name: t('confirmDelete') }))
    await settle()
    expect(api.deleteBoard).toHaveBeenCalledExactlyOnceWith('b1')
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('List unavailable after deletion'))).toBe(true)
    expect(api.saveBoard).not.toHaveBeenCalled()
  })
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
    fireEvent.click(screen.getByRole('button', { name: t('play') }))
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
    fireEvent.click(screen.getByRole('button', { name: t('play') }))
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