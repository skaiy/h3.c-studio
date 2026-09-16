import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type Board, type Shot, type Take } from '@/lib/api'
import { zh } from '@/lib/i18nData'
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

function take(id: string, overrides: Partial<Take> = {}): Take {
  return {
    id, shot_id: 'a', job_id: null, output: `${id}.mp4`, created_at: 1,
    request: null, request_unknown: true, source_take_id: null, source_unknown: false,
    legacy: false, model_name: null, missing: false, ...overrides,
  }
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

  it('does not count done shots without selected outputs toward concat', () => {
    setup([shot('a', { status: 'done' }), shot('b'), shot('c')])
    expect(screen.getByText(/拼接导出/).closest('button')).toBeDisabled()
  })

  it('disables sequence preview when no shot has a selected output', () => {
    setup([shot('a'), shot('b')])
    expect(screen.getByText(/连续预览/).closest('button')).toBeDisabled()
  })

  it('enables sequence preview with a legacy selected output, and toggles it', async () => {
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

  it.each(['error', 'running'])('counts previous selected takes during an %s retry for concat and sequence preview', (status) => {
    const props = setup([
      shot('a', { status, takes: [take('a-old')], selected_take_id: 'a-old' }),
      shot('b', { status, takes: [take('b-old', { shot_id: 'b' })], selected_take_id: 'b-old' }),
    ])
    const concat = screen.getByRole('button', { name: /拼接导出/ })
    const sequence = screen.getByRole('button', { name: /连续预览/ })
    expect(concat).toBeEnabled()
    expect(concat).toHaveTextContent('2/2')
    expect(sequence).toBeEnabled()
    fireEvent.click(concat)
    fireEvent.click(sequence)
    expect(props.onConcat).toHaveBeenCalledOnce()
    expect(props.onToggleSequence).toHaveBeenCalledOnce()
    expect(screen.getByTestId('shot-card-0').querySelector('video')).toHaveAttribute('src', '/outputs/a-old.mp4')
  })

  it('uses and encodes the canonical selected take rather than the stale output projection', () => {
    const output = 'take #2/中文?.mp4'
    setup([shot('a', {
      output: 'stale.mp4', takes: [take('other', { missing: true }), take('selected', { output })],
      selected_take_id: 'selected',
    })])
    const card = screen.getByTestId('shot-card-0')
    expect(card.querySelector('video')).toHaveAttribute('src', `/outputs/${encodeURIComponent(output)}`)
    expect(within(card).getByTitle(`${zh.takeHistory}: 2`)).toHaveTextContent(`${zh.takeLabel} · 2`)
    expect(screen.getByRole('button', { name: /连续预览/ })).toBeEnabled()
    expect(screen.queryByText(zh.takeMissing)).not.toBeInTheDocument()
  })

  it('does not revive a stale legacy projection when canonical selection is empty', () => {
    setup([shot('a', { status: 'done', output: 'stale.mp4', takes: [], selected_take_id: null })])
    expect(screen.getByTestId('shot-card-0').querySelector('video')).toBeNull()
    expect(screen.getByRole('button', { name: /连续预览/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /拼接导出/ })).toHaveTextContent('0/1')
  })

  it('keeps encoded legacy thumbnails and counts when take history is absent', () => {
    const output = 'legacy #1.mp4'
    setup([shot('a', { status: 'error', output }), shot('b', { status: 'running', output: 'b.mp4' })])
    const card = screen.getByTestId('shot-card-0')
    expect(card.querySelector('video')).toHaveAttribute('src', `/outputs/${encodeURIComponent(output)}`)
    expect(within(card).getByTitle(`${zh.takeHistory}: 1`)).toHaveTextContent(`${zh.takeLabel} · 1`)
    expect(screen.getByRole('button', { name: /拼接导出/ })).toBeEnabled()
  })

  it.each<Partial<Shot>>([
    { takes: [take('missing', { missing: true })], selected_take_id: 'missing' },
    { output: 'missing.mp4', output_missing: true },
    { output: 'stale.mp4', takes: [], selected_take_id: 'unknown-id' },
  ])('blocks start and concat for a missing selection without silently skipping it: %j', (missingShot) => {
    const props = setup([
      shot('a', { status: 'done', ...missingShot }),
      shot('b', { output: 'b.mp4' }), shot('c', { output: 'c.mp4' }),
    ])
    for (const name of [/连续预览/, /拼接导出/]) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute('title', zh.takeSequenceMissing)
      fireEvent.click(button)
    }
    expect(props.onToggleSequence).not.toHaveBeenCalled()
    expect(props.onConcat).not.toHaveBeenCalled()
    const card = screen.getByTestId('shot-card-0')
    expect(card.querySelector('video')).toBeNull()
    const badge = within(card).getByText(zh.takeMissing)
    expect(badge).toBeVisible()
    expect(badge).toHaveClass('text-amber-400')
    expect(badge).toHaveAttribute('title', zh.takeMissingHint)
  })

  it('allows stopping the sequence even when the selected output goes missing', () => {
    const props = setup([shot('a', { output: 'a.mp4', output_missing: true })], { sequencing: true })
    const stop = screen.getByRole('button', { name: /停止预览/ })
    expect(stop).toBeEnabled()
    expect(stop).toHaveAttribute('title', zh.stopSequence)
    fireEvent.click(stop)
    expect(props.onToggleSequence).toHaveBeenCalledOnce()
  })

  it.each<{ state: Partial<Shot>; label: string; title: string }>([
    { state: { continuity_state: 'stale' }, label: zh.takeStale, title: zh.takeStaleHint },
    { state: { stale: true }, label: zh.takeStale, title: zh.takeStaleHint },
    { state: { continuity_state: 'unknown' }, label: zh.takeUnknownSource, title: zh.takeUnknownSource },
  ])('shows a visible textual amber continuity badge for $state', ({ state, label, title }) => {
    setup([shot('a', { output: 'a.mp4', ...state })])
    const badge = within(screen.getByTestId('shot-card-0')).getByText(label)
    expect(badge).toBeVisible()
    expect(badge).toHaveClass('text-amber-400')
    expect(badge).toHaveAttribute('title', title)
    expect(screen.getByRole('button', { name: /连续预览/ })).toBeEnabled()
  })

  it('blocks every mutation while disabled, including synthetic drag/drop and insert gaps, but permits selection and preview', () => {
    const props = {
      board: board([shot('a', { status: 'done', output: 'a.mp4' }), shot('b', { status: 'done', output: 'b.mp4' })]),
      disabled: true, selected: 0,
      onSelect: vi.fn(), onAddShot: vi.fn(), onInsertShot: vi.fn(),
      onDuplicateShot: vi.fn(), onDeleteShot: vi.fn(), onReorder: vi.fn(),
      onRunAll: vi.fn(), onConcat: vi.fn(), sequencing: false, onToggleSequence: vi.fn(),
    }
    render(<ShotRail {...props} />)
    const first = screen.getByTestId('shot-card-0'), second = screen.getByTestId('shot-card-1')
    expect(first).toHaveAttribute('draggable', 'false')
    for (const button of [
      screen.getByText('+ 添加'), screen.getByText(/运行全部/), screen.getByText(/拼接导出/),
      ...screen.getAllByTestId('shot-duplicate'), ...screen.getAllByTestId('shot-delete'),
    ]) {
      expect(button).toBeDisabled()
      fireEvent.click(button)
      fireEvent.click(button)
    }
    for (const index of [0, 1, 2]) fireEvent.click(screen.getByTestId(`insert-${index}`))
    fireEvent.dragStart(first)
    fireEvent.dragOver(second)
    fireEvent.drop(second)
    for (const callback of [props.onAddShot, props.onInsertShot, props.onDuplicateShot, props.onDeleteShot, props.onReorder, props.onRunAll, props.onConcat]) {
      expect(callback).not.toHaveBeenCalled()
    }
    fireEvent.click(second)
    expect(props.onSelect).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByText(/连续预览/))
    expect(props.onToggleSequence).toHaveBeenCalledOnce()
  })
})
