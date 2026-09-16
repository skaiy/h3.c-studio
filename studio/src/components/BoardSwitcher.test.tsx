import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Board, type BoardSummary } from '@/lib/api'
import BoardSwitcher from './BoardSwitcher'

const navigateMock = vi.fn()
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return { ...actual, useNavigate: () => navigateMock }
})

function summary(overrides: Partial<BoardSummary> = {}): BoardSummary {
  return {
    id: 'b1', name: '雨巷', status: 'idle', result: null, shotCount: 2,
    doneCount: 1, duration: 10, createdAt: 0, modifiedAt: 0, ...overrides,
  }
}

describe('BoardSwitcher', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    navigateMock.mockClear()
  })

  it('opens the dropdown and lists boards', async () => {
    const user = userEvent.setup()
    render(<BoardSwitcher boards={[summary()]} currentId="b1" onRefresh={vi.fn()} />)
    await user.click(screen.getByText('雨巷 ▾'))
    expect(screen.getByText('雨巷', { selector: 'span' })).toBeInTheDocument()
  })

  it('renames a board on Enter and persists via the API', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    vi.spyOn(api, 'board').mockResolvedValue({ id: 'b1', name: '雨巷', chain: true, shots: [], status: 'idle', result: null, createdAt: 0, modifiedAt: 0 } as Board)
    const saveSpy = vi.spyOn(api, 'saveBoard').mockResolvedValue({} as Board)

    render(<BoardSwitcher boards={[summary()]} currentId="b1" onRefresh={onRefresh} />)
    await user.click(screen.getByText('雨巷 ▾'))
    await user.click(screen.getByTitle('重命名'))
    const input = screen.getByDisplayValue('雨巷')
    await user.clear(input)
    await user.type(input, '雨巷·终章')
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1', name: '雨巷·终章' })))
    expect(onRefresh).toHaveBeenCalled()
  })

  it('duplicates a board and navigates to the copy', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    vi.spyOn(api, 'duplicateBoard').mockResolvedValue({ id: 'b1-copy', name: '雨巷 副本' } as Board)

    render(<BoardSwitcher boards={[summary()]} currentId="b1" onRefresh={onRefresh} />)
    await user.click(screen.getByText('雨巷 ▾'))
    await user.click(screen.getByTitle('复制分镜'))

    expect(api.duplicateBoard).toHaveBeenCalledWith('b1')
    expect(onRefresh).toHaveBeenCalled()
    expect(navigateMock).toHaveBeenCalledWith('/b/b1-copy')
  })

  it('requires a second click within the confirm window to delete, then navigates to a remaining board', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const deleteSpy = vi.spyOn(api, 'deleteBoard').mockResolvedValue(undefined)
    vi.spyOn(api, 'boards').mockResolvedValue([summary({ id: 'b2', name: '备用板' })])

    render(<BoardSwitcher boards={[summary()]} currentId="b1" onRefresh={onRefresh} />)
    await user.click(screen.getByText('雨巷 ▾'))
    await user.click(screen.getByTitle('删除'))
    expect(deleteSpy).not.toHaveBeenCalled()
    expect(screen.getByText('确认删除?')).toBeInTheDocument()

    await user.click(screen.getByText('确认删除?'))
    expect(deleteSpy).toHaveBeenCalledWith('b1')
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/b/b2'))
    expect(onRefresh).toHaveBeenCalled()
  })
})

describe('BoardSwitcher mutation preflight regressions', () => {
  const full: Board = {
    id: 'b1', name: '雨巷', chain: true, shots: [], status: 'idle',
    result: null, createdAt: 1, modifiedAt: 15,
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    navigateMock.mockClear()
    vi.spyOn(api, 'board').mockResolvedValue(full)
    vi.spyOn(api, 'saveBoard').mockResolvedValue({ ...full, name: '新名称', modifiedAt: 16 })
    vi.spyOn(api, 'duplicateBoard').mockResolvedValue({ ...full, id: 'copy' })
    vi.spyOn(api, 'deleteBoard').mockResolvedValue(undefined)
    vi.spyOn(api, 'boards').mockResolvedValue([summary({ id: 'b2' })])
  })

  async function requestMutation(kind: 'rename' | 'duplicate' | 'delete') {
    fireEvent.click(screen.getByText('雨巷 ▾'))
    if (kind === 'rename') {
      fireEvent.click(screen.getByTitle('重命名'))
      const input = screen.getByDisplayValue('雨巷')
      fireEvent.change(input, { target: { value: '新名称' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    } else if (kind === 'duplicate') {
      fireEvent.click(screen.getByTitle('复制分镜'))
    } else {
      fireEvent.click(screen.getByTitle('删除'))
      await act(async () => {})
      expect(api.deleteBoard).not.toHaveBeenCalled()
      fireEvent.click(screen.getByText('确认删除?'))
    }
    await act(async () => {})
  }

  function expectNoMutation() {
    expect(api.board).not.toHaveBeenCalled()
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(api.duplicateBoard).not.toHaveBeenCalled()
    expect(api.deleteBoard).not.toHaveBeenCalled()
  }

  it.each(['rename', 'duplicate', 'delete'] as const)('awaits beforeMutate before %s reads or writes server state', async (kind) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const beforeMutate = vi.fn(() => pending)
    const onRefresh = vi.fn()
    render(<BoardSwitcher boards={[summary()]} currentId="b1" onRefresh={onRefresh} beforeMutate={beforeMutate} />)
    await requestMutation(kind)
    expect(beforeMutate).toHaveBeenCalledExactlyOnceWith('b1')
    expectNoMutation()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
    await act(async () => { release() })
    if (kind === 'rename') {
      expect(api.board).toHaveBeenCalledExactlyOnceWith('b1')
      expect(api.saveBoard).toHaveBeenCalledExactlyOnceWith({ ...full, name: '新名称' })
    } else if (kind === 'duplicate') {
      expect(api.duplicateBoard).toHaveBeenCalledExactlyOnceWith('b1')
      expect(navigateMock).toHaveBeenCalledWith('/b/copy')
    } else {
      expect(api.deleteBoard).toHaveBeenCalledExactlyOnceWith('b1')
      expect(navigateMock).toHaveBeenCalledWith('/b/b2')
    }
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it.each(['rename', 'duplicate', 'delete'] as const)('shows a failed preflight and does not %s or navigate', async (kind) => {
    const beforeMutate = vi.fn().mockRejectedValue(new Error('Unsaved board conflict'))
    const onRefresh = vi.fn()
    render(<BoardSwitcher boards={[summary()]} currentId="b1" onRefresh={onRefresh} beforeMutate={beforeMutate} />)
    await requestMutation(kind)
    expect(beforeMutate).toHaveBeenCalledExactlyOnceWith('b1')
    expect(screen.getByRole('alert')).toHaveTextContent('Unsaved board conflict')
    expectNoMutation()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it('shows an API mutation error after a successful preflight and allows an explicit retry', async () => {
    vi.mocked(api.duplicateBoard).mockRejectedValueOnce(new Error('Duplicate rejected'))
    const beforeMutate = vi.fn().mockResolvedValue(undefined)
    const onRefresh = vi.fn()
    render(<BoardSwitcher boards={[summary()]} currentId="b1" onRefresh={onRefresh} beforeMutate={beforeMutate} />)
    await requestMutation('duplicate')
    expect(screen.getByRole('alert')).toHaveTextContent('Duplicate rejected')
    expect(onRefresh).not.toHaveBeenCalled()
    expect(navigateMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('复制分镜'))
    await act(async () => {})
    expect(beforeMutate).toHaveBeenCalledTimes(2)
    expect(api.duplicateBoard).toHaveBeenCalledTimes(2)
    expect(navigateMock).toHaveBeenCalledExactlyOnceWith('/b/copy')
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
