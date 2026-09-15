import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type Board } from './api'
import { BoardDrafts } from './boardDrafts'

function board(id = 'a', overrides: Partial<Board> = {}): Board {
  return {
    id, name: `Board ${id}`, chain: false, shots: [], status: 'idle',
    result: null, createdAt: 1, modifiedAt: 10, ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let drafts: BoardDrafts
const save = vi.fn<(value: Board) => Promise<Board>>()

beforeEach(() => {
  vi.useFakeTimers()
  save.mockReset().mockImplementation(async (value) => ({ ...value, modifiedAt: value.modifiedAt + 1 }))
  drafts = new BoardDrafts(save)
  drafts.receive(board())
})

afterEach(() => {
  drafts.dispose()
  vi.useRealTimers()
})

describe('BoardDrafts regression coverage', () => {
  it('serializes concurrent flushes and retains edits arriving during a save with the returned revision', async () => {
    const first = deferred<Board>(), second = deferred<Board>()
    save.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    drafts.edit('a', (b) => ({ ...b, name: 'First edit' }))
    const flush = drafts.flush('a')
    const concurrentFlush = drafts.flush('a')
    await Promise.resolve()
    expect(save).toHaveBeenCalledOnce()
    expect(drafts.state('a')).toMatchObject({ dirty: true, saving: true })

    drafts.edit('a', (b) => ({ ...b, name: 'Mid-flight edit', chain: true }))
    await vi.advanceTimersByTimeAsync(800)
    expect(save).toHaveBeenCalledOnce()
    first.resolve({ ...save.mock.calls[0][0], createdAt: 2, modifiedAt: 11 })
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[0][0]).toMatchObject({ name: 'First edit', modifiedAt: 10 })
    expect(save.mock.calls[1][0]).toMatchObject({ name: 'Mid-flight edit', chain: true, createdAt: 2, modifiedAt: 11 })
    expect(drafts.get('a')?.name).toBe('Mid-flight edit')
    expect(drafts.hasUnsaved()).toBe(true)

    const saved = { ...save.mock.calls[1][0], modifiedAt: 12 }
    second.resolve(saved)
    await expect(flush).resolves.toEqual(saved)
    await expect(concurrentFlush).resolves.toEqual(saved)
    expect(drafts.state('a')).toEqual({ dirty: false, saving: false, error: null })
    expect(drafts.hasUnsaved()).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('keeps both board debounce timers independent, including when one board is still saving', async () => {
    const first = deferred<Board>()
    save.mockImplementationOnce(() => first.promise)
    drafts.receive(board('b'))
    drafts.edit('a', (b) => ({ ...b, name: 'A edited' }))
    await vi.advanceTimersByTimeAsync(400)
    drafts.edit('b', (b) => ({ ...b, name: 'B edited' }))
    await vi.advanceTimersByTimeAsync(399)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'a', name: 'A edited' }))
    await vi.advanceTimersByTimeAsync(399)
    expect(save).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toMatchObject({ id: 'b', name: 'B edited' })
    expect(drafts.state('a').saving).toBe(true)
    expect(drafts.state('b').dirty).toBe(false)
    first.resolve({ ...save.mock.calls[0][0], modifiedAt: 11 })
    await drafts.flush('a')
    expect(drafts.get('a')?.name).toBe('A edited')
    expect(drafts.get('b')?.name).toBe('B edited')
  })

  it('ignores polls while dirty or saving, and ignores older revisions arriving after a successful save', async () => {
    const pending = deferred<Board>()
    save.mockImplementationOnce(() => pending.promise)
    drafts.edit('a', (b) => ({ ...b, name: 'Local edit' }))
    drafts.receive(board('a', { name: 'Poll while dirty', modifiedAt: 100 }))
    expect(drafts.get('a')).toMatchObject({ name: 'Local edit', modifiedAt: 10 })
    const flush = drafts.flush('a')
    await Promise.resolve()
    drafts.receive(board('a', { name: 'Poll while saving', modifiedAt: 100 }))
    expect(drafts.get('a')).toMatchObject({ name: 'Local edit', modifiedAt: 10 })
    pending.resolve({ ...save.mock.calls[0][0], modifiedAt: 11 })
    await flush
    drafts.receive(board('a', { name: 'Delayed old poll', modifiedAt: 10 }))
    expect(drafts.get('a')).toMatchObject({ name: 'Local edit', modifiedAt: 11 })
    drafts.receive(board('a', { name: 'Fresh server edit', modifiedAt: 12 }))
    expect(drafts.get('a')).toMatchObject({ name: 'Fresh server edit', modifiedAt: 12 })
  })

  it('retains a mid-flight edit after rejection and retries that edit rather than the failed request snapshot', async () => {
    const pending = deferred<Board>()
    const failure = new Error('Save unavailable')
    save.mockImplementationOnce(() => pending.promise)
    drafts.edit('a', (b) => ({ ...b, name: 'Request snapshot' }))
    const flush = drafts.flush('a')
    const rejected = expect(flush).rejects.toBe(failure)
    await Promise.resolve()
    drafts.edit('a', (b) => ({ ...b, name: 'Keep this newer edit' }))
    await vi.advanceTimersByTimeAsync(800)
    pending.reject(failure)
    await rejected
    expect(drafts.state('a')).toEqual({ dirty: true, saving: false, error: failure })
    expect(drafts.hasUnsaved()).toBe(true)
    drafts.receive(board('a', { name: 'Stale poll' }))
    expect(drafts.get('a')?.name).toBe('Keep this newer edit')
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledOnce()

    await drafts.flush('a')
    expect(save.mock.calls[1][0]).toMatchObject({ name: 'Keep this newer edit', modifiedAt: 10 })
    expect(drafts.get('a')).toMatchObject({ name: 'Keep this newer edit', modifiedAt: 11 })
    expect(drafts.state('a')).toEqual({ dirty: false, saving: false, error: null })
  })

  it('does not automatically overwrite a 409 conflict or adopt a poll revision to force a retry', async () => {
    const conflict = new ApiError(409, 'Board changed on server')
    save.mockRejectedValue(conflict)
    drafts.edit('a', (b) => ({ ...b, name: 'Keep conflicting edit' }))
    await vi.advanceTimersByTimeAsync(800)
    expect(drafts.state('a')).toEqual({ dirty: true, saving: false, error: conflict })
    drafts.receive(board('a', { name: 'Other writer', modifiedAt: 11 }))
    await vi.advanceTimersByTimeAsync(10000)
    expect(save).toHaveBeenCalledOnce()
    expect(drafts.get('a')).toMatchObject({ name: 'Keep conflicting edit', modifiedAt: 10 })
    await expect(drafts.flush('a')).rejects.toBe(conflict)
    expect(save.mock.calls[1][0]).toMatchObject({ name: 'Keep conflicting edit', modifiedAt: 10 })
    expect(drafts.hasUnsaved()).toBe(true)
  })

  it('replaces unsaved data only on explicit discard and cancels the discarded debounce timer', async () => {
    drafts.edit('a', (b) => ({ ...b, name: 'Local edit' }))
    const remote = board('a', { name: 'Explicitly reloaded', modifiedAt: 11 })
    drafts.receive(remote)
    expect(drafts.get('a')?.name).toBe('Local edit')
    drafts.discard(remote)
    expect(drafts.get('a')).toEqual(remote)
    expect(drafts.state('a')).toEqual({ dirty: false, saving: false, error: null })
    expect(drafts.hasUnsaved()).toBe(false)
    await vi.advanceTimersByTimeAsync(800)
    expect(save).not.toHaveBeenCalled()
  })

  it('does not discard an in-flight save, including its more recent local edits', async () => {
    const pending = deferred<Board>()
    save.mockImplementationOnce(() => pending.promise)
    drafts.edit('a', (b) => ({ ...b, name: 'Saving' }))
    const flush = drafts.flush('a')
    await Promise.resolve()
    drafts.edit('a', (b) => ({ ...b, name: 'Newer local edit' }))
    drafts.discard(board('a', { name: 'Must not replace', modifiedAt: 100 }))
    expect(drafts.get('a')).toMatchObject({ name: 'Newer local edit', modifiedAt: 10 })
    expect(drafts.state('a')).toMatchObject({ dirty: true, saving: true })
    pending.resolve({ ...save.mock.calls[0][0], modifiedAt: 11 })
    await flush
    expect(save.mock.calls[1][0]).toMatchObject({ name: 'Newer local edit', modifiedAt: 11 })
    expect(drafts.get('a')).toMatchObject({ name: 'Newer local edit', modifiedAt: 12 })
  })
})