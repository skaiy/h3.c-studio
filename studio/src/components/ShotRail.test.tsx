import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type Board, type Shot } from '@/lib/api'
import ShotRail from './ShotRail'

function shot(id: string, overrides: Partial<Shot> = {}): Shot {
  return {
    id, prompt: id, width: 768, height: 768, seconds: 5, steps: 20, layers: 45,
    reuse: 2, seed: 1, turbo: false, first_frame: null, last_frame: null,
    status: 'idle', output: null, job_id: null, ...overrides,
  }
}

function board(shots: Shot[]): Board {
  return { id: 'b1', name: 'test', chain: true, shots, status: 'idle', result: null, createdAt: 0, modifiedAt: 0 }
}

function setup(shots = [shot('a'), shot('b'), shot('c')], overrides: { sequencing?: boolean } = {}) {
  const props = {
    board: board(shots), selected: 0,
    onSelect: vi.fn(), onAddShot: vi.fn(), onInsertShot: vi.fn(),
    onDuplicateShot: vi.fn(), onDeleteShot: vi.fn(), onReorder: vi.fn(),
    onRunAll: vi.fn(), onConcat: vi.fn(),
    sequencing: overrides.sequencing ?? false, onToggleSequence: vi.fn(),
  }
  render(<ShotRail {...props} />)
  return props
}

describe('ShotRail', () => {
  it('selects a shot on click', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByTestId('shot-card-1'))
    expect(props.onSelect).toHaveBeenCalledWith(1)
  })

  it('adds a shot via the trailing + button', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByText('+ 添加'))
    expect(props.onAddShot).toHaveBeenCalled()
  })

  it('inserts a shot at the clicked gap', () => {
    const props = setup()
    fireEvent.click(screen.getByTestId('insert-1'))
    expect(props.onInsertShot).toHaveBeenCalledWith(1)
  })

  it('duplicates the clicked shot', async () => {
    const user = userEvent.setup()
    const props = setup()
    const card = screen.getByTestId('shot-card-2')
    await user.click(within(card).getByTestId('shot-duplicate'))
    expect(props.onDuplicateShot).toHaveBeenCalledWith(2)
  })

  it('deletes only after a confirming second click', async () => {
    const user = userEvent.setup()
    const props = setup()
    const card = screen.getByTestId('shot-card-0')
    const del = within(card).getByTestId('shot-delete')
    await user.click(del)
    expect(props.onDeleteShot).not.toHaveBeenCalled()
    await user.click(within(card).getByTestId('shot-delete'))
    expect(props.onDeleteShot).toHaveBeenCalledWith(0)
  })

  it('reorders via drag from one card and dropping on another', () => {
    const props = setup()
    const from = screen.getByTestId('shot-card-0')
    const to = screen.getByTestId('shot-card-2')
    fireEvent.dragStart(from)
    fireEvent.dragOver(to)
    fireEvent.drop(to)
    expect(props.onReorder).toHaveBeenCalledWith(0, 2)
  })

  it('disables concat until at least two shots are done', () => {
    setup([shot('a', { status: 'done' }), shot('b'), shot('c')])
    expect(screen.getByText(/拼接导出/).closest('button')).toBeDisabled()
  })

  it('disables sequence preview when no shot is done yet', () => {
    setup([shot('a'), shot('b')])
    expect(screen.getByText(/连续预览/).closest('button')).toBeDisabled()
  })

  it('enables sequence preview once at least one shot is done, and toggles it', async () => {
    const user = userEvent.setup()
    const props = setup([shot('a', { status: 'done', output: 'a.mp4' }), shot('b')])
    const btn = screen.getByText(/连续预览/).closest('button')!
    expect(btn).toBeEnabled()
    await user.click(btn)
    expect(props.onToggleSequence).toHaveBeenCalled()
  })

  it('shows a stop label while sequencing', () => {
    setup([shot('a', { status: 'done', output: 'a.mp4' })], { sequencing: true })
    expect(screen.getByText(/停止预览/)).toBeInTheDocument()
  })
})
