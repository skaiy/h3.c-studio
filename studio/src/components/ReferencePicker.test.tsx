import type { ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type Board, type ReferenceAsset, type ReferenceSet, type ReferenceSnapshot, type Shot } from '@/lib/api'
import type { ReferenceMutation } from '@/lib/referenceSets'
import { I18nContext } from '@/lib/i18nContext'
import { LANGS, type I18nKey, type Lang } from '@/lib/i18nData'
import { translate } from '@/lib/i18nResources'
import ReferencePicker from './ReferencePicker'

type Props = ComponentProps<typeof ReferencePicker>
const t = (key: I18nKey) => translate('en', key)
function asset(id: string, kind: ReferenceAsset['kind'] = 'image', extra: Partial<ReferenceAsset> = {}): ReferenceAsset {
  return { id, filename: `${id}.${kind === 'image' ? 'png' : 'wav'}`, kind, size: 100, sha256: 'a'.repeat(64), created_at: 1, ...(kind === 'audio' ? { duration: 5 } : { width: 64, height: 64 }), ...extra }
}
function set(extra: Partial<ReferenceSet> = {}): ReferenceSet {
  return { id: 'set-a', name: 'Hero', kind: 'character', notes: 'Keep image order', image_asset_ids: ['i2', 'i1'], audio_asset_ids: ['a2', 'a1'], revision: 3, ...extra }
}
function snapshot(extra: Partial<ReferenceSnapshot> = {}): ReferenceSnapshot {
  return { source_board_id: 'board-a', set_id: 'set-a', set_revision: 2, set_name: 'Original hero', images: [asset('old2'), asset('old1')], audio: [asset('old-audio', 'audio')], ...extra }
}
function shot(extra: Partial<Shot> = {}): Shot {
  return { id: 'shot-a', prompt: 'Keep this prompt', width: 512, height: 512, seconds: 5, steps: 20, layers: 45, reuse: 2, seed: 1,
    first_frame: null, last_frame: null, ref_images: [], ref_audio: [], status: 'done', output: 'adopted.mp4', job_id: 'job-a', takes: [], selected_take_id: 'take-a', ...extra }
}
function board(extra: Partial<Board> = {}): Board {
  return { id: 'board-a', name: 'Board A', chain: false, shots: [shot()], status: 'idle', result: null, createdAt: 1, modifiedAt: 10,
    assets: [asset('i1'), asset('i2'), asset('a1', 'audio'), asset('a2', 'audio')], reference_sets: [set()], ...extra }
}
function mutation(current: Board) {
  return vi.fn<ReferenceMutation>(async (action) => { try { await action(current); return true } catch { return false } })
}
function panel(props: Props, lang: Lang = 'en') {
  return <I18nContext.Provider value={{ lang, t: (key) => translate(lang, key), setLang: () => {} }}><ReferencePicker {...props} /></I18nContext.Provider>
}
function setup(extra: Partial<Props> = {}, lang: Lang = 'en') {
  const current = extra.board ?? board({ shots: [extra.shot ?? shot()] })
  const props: Props = { board: current, shot: current.shots[0], disabled: false, onMutate: mutation(current), onManage: vi.fn(), ...extra }
  return { props, ...render(panel(props, lang)) }
}
const choose = (id = 'set-a') => fireEvent.change(screen.getByRole('combobox', { name: t('referenceChooseSet') }), { target: { value: id } })
const apply = () => fireEvent.click(screen.getByRole('button', { name: t('referenceApply') }))

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(api, 'applyReferenceSet').mockResolvedValue(board())
  vi.spyOn(api, 'generateShot').mockResolvedValue({ job_id: 'never' })
  vi.spyOn(api, 'saveBoard').mockResolvedValue(board())
})
afterEach(() => vi.restoreAllMocks())

describe('ReferencePicker', () => {
  it('shows empty old-board state and delegates management without any mutation', () => {
    const { props } = setup({ board: board({ assets: undefined, reference_sets: undefined }) })
    expect(screen.getByText(t('referenceEmpty'))).toBeInTheDocument()
    expect(screen.getByText(t('referenceNoSnapshot'))).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: t('referenceApply') })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: t('referenceManage') }))
    expect(props.onManage).toHaveBeenCalledOnce()
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it('previews name/kind/revision and ordered images/audio while rendering the frozen snapshot independently', () => {
    const currentShot = shot({ reference_snapshot: snapshot() })
    const before = JSON.stringify(currentShot)
    const { props, container } = setup({ shot: currentShot })
    expect(screen.getByRole('button', { name: t('referenceApply') })).toBeDisabled()
    choose()
    const preview = screen.getByTestId('reference-set-preview'), frozen = screen.getByTestId('reference-shot-snapshot')
    expect(preview).toHaveTextContent(`Hero · ${t('referenceKindCharacter')} · ${t('referenceRevision')} 3`)
    expect(preview).toHaveTextContent('Keep image order')
    expect(within(preview).getAllByRole('listitem').map((item) => item.firstChild?.textContent)).toEqual(['i2.png', 'i1.png', 'a2.wav', 'a1.wav'])
    expect(within(frozen).getAllByRole('listitem').map((item) => item.firstChild?.textContent)).toEqual(['old2.png', 'old1.png', 'old-audio.wav'])
    expect(frozen).toHaveTextContent(`Original hero · ${t('referenceRevision')} 2`)
    expect(frozen).toHaveTextContent(t('referenceStale'))
    expect(frozen).not.toHaveTextContent('Keep image order')
    expect(frozen).not.toHaveTextContent('Keep this prompt')
    expect(props.onMutate).not.toHaveBeenCalled()
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
    expect(JSON.stringify(currentShot)).toBe(before)
    expect(container.querySelector('video')).toBeNull()
    expect(container.querySelectorAll('img')).toHaveLength(4)
    const players = container.querySelectorAll('audio')
    expect(players).toHaveLength(3)
    for (const player of players) {
      expect(player).toHaveAttribute('controls')
      expect(player).toHaveAttribute('preload', 'none')
      expect(player).not.toHaveAttribute('autoplay')
    }
  })

  it('encodes local filenames in set and frozen snapshot previews without relinking their media', () => {
    const images = [asset('i1', 'image', { filename: 'look #1? 50%+.png' })]
    const audio = [asset('a1', 'audio', { filename: '声 #1?.wav' })]
    // Snapshot IDs deliberately match live assets, but its frozen filenames do not.
    const currentShot = shot({ reference_snapshot: snapshot({ images, audio }) })
    const before = JSON.stringify(currentShot)
    const current = board({ shots: [currentShot], assets: [asset('i1', 'image', { filename: 'live #1?.png' }), asset('a1', 'audio', { filename: 'live 50%+.wav' })],
      reference_sets: [set({ image_asset_ids: ['i1'], audio_asset_ids: ['a1'] })] })
    const { props } = setup({ board: current })
    choose()
    const preview = screen.getByTestId('reference-set-preview'), frozen = screen.getByTestId('reference-shot-snapshot')
    expect(within(preview).getByRole('img', { name: 'live #1?.png' })).toHaveAttribute('src', '/uploads/live%20%231%3F.png')
    expect(within(preview).getByLabelText('live 50%+.wav')).toHaveAttribute('src', '/uploads/live%2050%25%2B.wav')
    expect(within(frozen).getByRole('img', { name: images[0].filename })).toHaveAttribute('src', '/uploads/look%20%231%3F%2050%25%2B.png')
    expect(within(frozen).getByLabelText(audio[0].filename)).toHaveAttribute('src', '/uploads/%E5%A3%B0%20%231%3F.wav')
    expect(within(frozen).getByText(images[0].filename)).toBeInTheDocument()
    expect(within(frozen).getByText(audio[0].filename)).toBeInTheDocument()
    expect(within(preview).getAllByRole('listitem')).toHaveLength(2)
    expect(within(frozen).getAllByRole('listitem')).toHaveLength(2)
    expect(JSON.stringify(currentShot)).toBe(before)
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it.each(['reference-set-preview', 'reference-shot-snapshot'])('shows localized image/audio load fallbacks without retries or snapshot changes in %s', (target) => {
    const currentShot = shot({ reference_snapshot: snapshot() })
    const before = JSON.stringify(currentShot)
    const { props, rerender } = setup({ shot: currentShot }, 'ja')
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'set-a' } })
    const preview = screen.getByTestId(target)
    const image = within(preview).getAllByRole('img')[0]
    const audio = preview.querySelector('audio')!
    const imageRow = image.closest('li')!, audioRow = audio.closest('li')!
    fireEvent.error(image)
    fireEvent.error(audio)
    for (const row of [imageRow, audioRow]) {
      expect(row.querySelector('img, audio')).toBeNull()
      expect(within(row).getByText(translate('ja', 'referenceMissing'))).toBeInTheDocument()
    }
    rerender(panel({ ...props, board: { ...props.board, modifiedAt: 99, assets: props.board.assets!.map((item) => ({ ...item })) },
      shot: { ...currentShot, reference_snapshot: snapshot() } }, 'ja'))
    expect(imageRow.querySelector('img')).toBeNull()
    expect(audioRow.querySelector('audio')).toBeNull()
    expect(props.onMutate).not.toHaveBeenCalled()
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
    expect(JSON.stringify(currentShot)).toBe(before)
  })

  it('does not request flagged or absent assets in either set or snapshot previews', () => {
    const current = board({ assets: [asset('i1', 'image', { missing: true }), asset('a1', 'audio', { missing: true })],
      shots: [shot({ reference_snapshot: snapshot({ images: [asset('old', 'image', { missing: true })], audio: [asset('old-audio', 'audio', { missing: true })] }) })] })
    setup({ board: current })
    choose()
    for (const target of ['reference-set-preview', 'reference-shot-snapshot']) {
      const preview = screen.getByTestId(target)
      expect(preview.querySelector('img, audio')).toBeNull()
      expect(preview).toHaveTextContent(t('referenceMissing'))
    }
    expect(screen.getByRole('button', { name: t('referenceApply') })).toBeDisabled()
  })

  it.each([
    '409: The reference set changed. Reload before retrying.',
    '401: Authentication is required.',
    '503: Reference storage is unavailable.',
    'Could not save the project. Your edits are retained.',
    'Could not load the reference library.',
  ])('shows the sanitized parent error without duplicating a generic mutation failure (%s)', async (error) => {
    const onMutate = vi.fn<ReferenceMutation>().mockResolvedValue(false)
    const { props, rerender } = setup({ error, onMutate })
    expect(screen.getByRole('alert')).toHaveTextContent(error)
    expect(onMutate).not.toHaveBeenCalled()
    choose()
    apply()
    await waitFor(() => expect(screen.getByRole('button', { name: t('referenceApply') })).toBeEnabled())
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent(error)
    expect(screen.queryByText(t('referenceMutationFailed'))).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveValue('set-a')
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
    rerender(panel({ ...props, error: undefined }))
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceMutationFailed'))
  })

  it.each([
    { label: 'empty', ref_images: [], ref_audio: [] },
    { label: 'identical', ref_images: ['i2.png', 'i1.png'], ref_audio: ['a2.wav', 'a1.wav'] },
  ])('applies $label references explicitly without unnecessary replacement confirmation or optimistic changes', async ({ ref_images, ref_audio }) => {
    const currentShot = shot({ ref_images, ref_audio })
    const current = board({ shots: [currentShot], modifiedAt: 99 })
    const before = JSON.stringify(currentShot)
    const { props } = setup({ shot: currentShot, onMutate: mutation(current) })
    choose()
    apply()
    await waitFor(() => expect(api.applyReferenceSet).toHaveBeenCalledWith('board-a', 'shot-a', 'set-a', 99, 3, false))
    expect(props.onMutate).toHaveBeenCalledOnce()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(screen.getByText(t('referenceNoSnapshot'))).toBeInTheDocument()
    expect(JSON.stringify(currentShot)).toBe(before)
    expect(api.saveBoard).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
  })

  it.each([
    { ref_images: ['manual.png'], ref_audio: [] },
    { ref_images: ['i1.png', 'i2.png'], ref_audio: ['a2.wav', 'a1.wav'] },
    { ref_images: ['i2.png', 'i1.png'], ref_audio: ['a1.wav', 'a2.wav'] },
  ])('requires replacement confirmation for different images/audio or order and respects cancellation (%j)', async (refs) => {
    const { props } = setup({ shot: shot(refs) })
    choose()
    vi.mocked(window.confirm).mockReturnValue(false)
    apply()
    expect(window.confirm).toHaveBeenCalledWith(t('referenceReplaceConfirm'))
    expect(props.onMutate).not.toHaveBeenCalled()
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox')).toHaveValue('set-a')
    vi.mocked(window.confirm).mockReturnValue(true)
    apply()
    await waitFor(() => expect(api.applyReferenceSet).toHaveBeenCalledWith('board-a', 'shot-a', 'set-a', 10, 3, true))
    expect(api.applyReferenceSet).toHaveBeenCalledOnce()
  })

  it.each([{ first_frame: 'first.png' }, { last_frame: 'last.png' }, { first_frame: '' }])('blocks explicit anchors before requesting or confirming replacement (%j)', (anchors) => {
    const { props } = setup({ shot: shot({ ...anchors, ref_images: ['old.png'] }) })
    choose()
    expect(screen.getByRole('status')).toHaveTextContent(t('referenceAnchorsConflict'))
    expect(screen.getByRole('button', { name: t('referenceApply') })).toBeDisabled()
    apply()
    expect(props.onMutate).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it.each(['flag', 'absent', 'set-flag'] as const)('blocks missing assets (%s) and explains nondestructive repair', (mode) => {
    const current = board()
    if (mode === 'flag') current.assets![0].missing = true
    if (mode === 'absent') current.assets = current.assets!.filter((item) => item.id !== 'i1')
    if (mode === 'set-flag') current.reference_sets![0].missing_asset_ids = ['i1']
    const { props } = setup({ board: current })
    choose()
    expect(screen.getByRole('status')).toHaveTextContent(t('referenceMissing'))
    expect(screen.getByRole('status')).toHaveTextContent(t('referenceRepairHint'))
    expect(screen.getByRole('button', { name: t('referenceApply') })).toBeDisabled()
    apply()
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it.each([
    { source_board_id: 'original-other-board', set_id: 'set-a', issue: 'referenceOtherBoard' },
    { source_board_id: 'board-a', set_id: 'deleted-set', issue: 'referenceSetDeleted' },
  ] as { source_board_id: string; set_id: string; issue: I18nKey }[])('preserves frozen provenance rather than linking by name/ID ($issue)', ({ issue, ...source }) => {
    setup({ shot: shot({ reference_snapshot: snapshot(source), reference_snapshot_missing: true }) })
    const frozen = screen.getByTestId('reference-shot-snapshot')
    expect(frozen).toHaveTextContent(t(issue))
    expect(frozen).toHaveTextContent(source.source_board_id)
    expect(frozen).toHaveTextContent(source.set_id)
    expect(frozen).toHaveTextContent('Original hero')
    expect(frozen).toHaveTextContent('old2.png')
    expect(frozen).toHaveTextContent(t('referenceRepairHint'))
    expect(frozen).not.toHaveTextContent(t('referenceStale'))
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
  })

  it('shows a deleted selected set without silently selecting/applying a replacement after polling', () => {
    const { props, rerender } = setup()
    choose()
    rerender(panel({ ...props, board: board({ reference_sets: [set({ id: 'replacement', name: 'Hero' })] }) }))
    expect(screen.getByRole('combobox')).toHaveValue('set-a')
    expect(screen.getByRole('status')).toHaveTextContent(t('referenceSetDeleted'))
    expect(screen.getByRole('button', { name: t('referenceApply') })).toBeDisabled()
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it('captures displayed set revision and target identities before a pending flush, blocks duplicate apply and retains selection after 409', async () => {
    let flush!: (value: Board) => void
    const flushed = new Promise<Board>((resolve) => { flush = resolve })
    const onMutate = vi.fn<ReferenceMutation>(async (action) => { try { await action(await flushed); return true } catch { return false } })
    const { props, rerender } = setup({ onMutate })
    choose()
    apply()
    apply()
    expect(onMutate).toHaveBeenCalledOnce()
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('button', { name: t('referenceManage') })).toBeDisabled()
    const latest = board({ modifiedAt: 99, reference_sets: [set({ revision: 4 })] })
    rerender(panel({ ...props, board: latest }))
    vi.mocked(api.applyReferenceSet).mockRejectedValue(new ApiError(409, 'changed revision'))
    await act(async () => { flush(latest) })
    expect(api.applyReferenceSet).toHaveBeenCalledWith('board-a', 'shot-a', 'set-a', 99, 3, false)
    expect(api.applyReferenceSet).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceMutationFailed'))
    expect(screen.getByRole('combobox')).toHaveValue('set-a')
    expect(screen.getByRole('button', { name: t('referenceApply') })).toBeEnabled()
  })

  it.each(['anchors', 'references', 'missing', 'wrong-board', 'deleted-shot'] as const)('rechecks the flushed board and aborts safely when %s changed', async (change) => {
    const latest = board({ modifiedAt: 99 })
    if (change === 'anchors') latest.shots[0].last_frame = 'new-anchor.png'
    if (change === 'references') latest.shots[0].ref_images = ['new-manual.png']
    if (change === 'missing') latest.assets![0].missing = true
    if (change === 'wrong-board') latest.id = 'board-b'
    if (change === 'deleted-shot') latest.shots = []
    setup({ onMutate: mutation(latest) })
    choose()
    apply()
    await screen.findByRole('alert')
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox')).toHaveValue('set-a')
  })

  it('does not extend replacement consent to different inputs introduced during the flush', async () => {
    setup({ shot: shot({ ref_images: ['confirmed-old.png'] }), onMutate: mutation(board({ shots: [shot({ ref_images: ['unconfirmed-new.png'] })] })) })
    choose()
    apply()
    await screen.findByRole('alert')
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
  })

  it('keeps a late request bound to the original shot and never changes a newly selected shot’s picker', async () => {
    let flush!: (value: Board) => void
    const flushed = new Promise<Board>((resolve) => { flush = resolve })
    const onMutate = vi.fn<ReferenceMutation>(async (action) => { await action(await flushed); return true })
    const original = board({ shots: [shot(), shot({ id: 'shot-b' })] })
    const { props, rerender } = setup({ board: original, onMutate })
    choose()
    apply()
    rerender(panel({ ...props, shot: original.shots[1] }))
    expect(screen.getByRole('combobox')).toHaveValue('')
    choose()
    await act(async () => { flush({ ...original, modifiedAt: 88 }) })
    expect(api.applyReferenceSet).toHaveBeenCalledWith('board-a', 'shot-a', 'set-a', 88, 3, false)
    expect(screen.getByRole('combobox')).toHaveValue('set-a')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('honors disabled and parent rejection without implicit retries', async () => {
    const onMutate = vi.fn<ReferenceMutation>().mockResolvedValue(false)
    const { props, rerender } = setup({ onMutate })
    choose()
    apply()
    await screen.findByRole('alert')
    expect(screen.getByRole('combobox')).toHaveValue('set-a')
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
    rerender(panel({ ...props, disabled: true }))
    expect(screen.getByRole('combobox')).toBeDisabled()
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
    apply()
    expect(onMutate).toHaveBeenCalledOnce()
  })

  it.each(LANGS.map(({ code }) => code))('localizes picker, provenance and apply controls in %s', (lang) => {
    setup({ shot: shot({ reference_snapshot: snapshot() }) }, lang)
    expect(screen.getByRole('heading', { name: translate(lang, 'referenceSnapshot') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: translate(lang, 'referenceManage') })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent(translate(lang, 'referenceStale'))
    expect(screen.getByRole('button', { name: translate(lang, 'referenceApply') })).toBeDisabled()
  })
})