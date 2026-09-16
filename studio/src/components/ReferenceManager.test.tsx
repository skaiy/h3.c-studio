import type { ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type Board, type ReferenceAsset, type ReferenceSet } from '@/lib/api'
import type { ReferenceMutation } from '@/lib/referenceSets'
import { I18nContext } from '@/lib/i18nContext'
import { LANGS, type I18nKey, type Lang } from '@/lib/i18nData'
import { resources, translate } from '@/lib/i18nResources'
import ReferenceManager from './ReferenceManager'

type Props = ComponentProps<typeof ReferenceManager>
const t = (key: I18nKey) => translate('en', key)
function asset(id: string, kind: ReferenceAsset['kind'] = 'image', extra: Partial<ReferenceAsset> = {}): ReferenceAsset {
  return { id, filename: `${id}.${kind === 'image' ? 'png' : 'wav'}`, kind, size: 100, sha256: 'a'.repeat(64), created_at: 1, ...(kind === 'audio' ? { duration: 5 } : { width: 64, height: 64 }), ...extra }
}
function set(extra: Partial<ReferenceSet> = {}): ReferenceSet {
  return { id: 'set-a', name: 'Hero', kind: 'character', notes: 'Original notes', image_asset_ids: ['i1', 'i2'], audio_asset_ids: ['a1'], revision: 3, ...extra }
}
function board(extra: Partial<Board> = {}): Board {
  return { id: 'board-a', name: 'Board A', shots: [], chain: false, status: 'idle', result: null, createdAt: 1, modifiedAt: 10,
    assets: [asset('i1'), asset('i2'), asset('i3'), asset('a1', 'audio'), asset('a2', 'audio')], reference_sets: [set()], ...extra }
}
function mutation(current: Board) {
  return vi.fn<ReferenceMutation>(async (action) => { try { await action(current); return true } catch { return false } })
}
function panel(props: Props, lang: Lang = 'en') {
  return <I18nContext.Provider value={{ lang, t: (key) => translate(lang, key), setLang: () => {} }}><ReferenceManager {...props} /></I18nContext.Provider>
}
function setup(extra: Partial<Props> = {}, lang: Lang = 'en') {
  const current = extra.board ?? board()
  const props: Props = { board: current, disabled: false, onMutate: mutation(current), onClose: vi.fn(), ...extra }
  return { props, ...render(panel(props, lang)) }
}
const click = (key: I18nKey) => fireEvent.click(screen.getByRole('button', { name: t(key) }))
const edit = () => fireEvent.click(within(screen.getByTestId('reference-set-set-a')).getByRole('button', { name: t('referenceEdit') }))
const change = (key: I18nKey, value: string) => fireEvent.change(screen.getByLabelText(t(key)), { target: { value } })
function upload(file: File, kind: ReferenceAsset['kind'] = 'image') {
  fireEvent.change(screen.getByLabelText(t(kind === 'image' ? 'referenceImportImage' : 'referenceImportAudio')), { target: { files: [file] } })
}
function unloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(api, 'upload').mockResolvedValue({ name: 'uploaded.png' })
  vi.spyOn(api, 'importReferenceAsset').mockResolvedValue(board())
  vi.spyOn(api, 'createReferenceSet').mockResolvedValue(board())
  vi.spyOn(api, 'updateReferenceSet').mockResolvedValue(board())
  vi.spyOn(api, 'deleteReferenceSet').mockResolvedValue(board())
  vi.spyOn(api, 'deleteReferenceAsset').mockResolvedValue(board())
  vi.spyOn(api, 'applyReferenceSet').mockResolvedValue(board())
  vi.spyOn(api, 'generateShot').mockResolvedValue({ job_id: 'never' })
})
afterEach(() => vi.restoreAllMocks())

describe('ReferenceManager', () => {
  it('supports old boards without reference metadata and has two single-file local import controls', () => {
    const { props } = setup({ board: board({ assets: undefined, reference_sets: undefined }) })
    expect(screen.getByRole('dialog', { name: t('referenceTitle') })).toBeInTheDocument()
    expect(screen.getByText(t('referenceNoAssets'))).toBeInTheDocument()
    expect(screen.getByText(t('referenceEmpty'))).toBeInTheDocument()
    const images = screen.getByLabelText(t('referenceImportImage')), audio = screen.getByLabelText(t('referenceImportAudio'))
    expect(images).toHaveAttribute('accept', '.png,.jpg,.jpeg,.webp')
    expect(audio).toHaveAttribute('accept', '.wav,.mp3,.flac,.m4a,.ogg,.aac')
    expect(images).not.toHaveAttribute('multiple')
    expect(audio).not.toHaveAttribute('multiple')
    expect(props.onMutate).not.toHaveBeenCalled()
    click('referenceClose')
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('renders local image thumbnails and playable audio with encoded filenames, without autoplay or mutation', () => {
    const image = asset('i1', 'image', { filename: 'hero #1? 50%+.png' })
    const audio = asset('a1', 'audio', { filename: '声 #1? 50%+.wav' })
    const { props } = setup({ board: board({ assets: [image, audio] }) })
    const list = screen.getByRole('list', { name: t('referenceAssets') })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByRole('img', { name: image.filename })).toHaveAttribute('src', '/uploads/hero%20%231%3F%2050%25%2B.png')
    const player = within(list).getByLabelText(audio.filename)
    expect(player.tagName).toBe('AUDIO')
    expect(player).toHaveAttribute('src', '/uploads/%E5%A3%B0%20%231%3F%2050%25%2B.wav')
    expect(player).toHaveAttribute('controls')
    expect(player).toHaveAttribute('preload', 'none')
    expect(player).not.toHaveAttribute('autoplay')
    expect(within(list).getByText(image.filename)).toBeInTheDocument()
    expect(within(list).getByText(audio.filename)).toBeInTheDocument()
    expect(list.querySelector('video')).toBeNull()
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it.each(['image', 'audio'] as const)('shows localized missing guidance for %s load errors and does not retry on polls', (kind) => {
    const media = asset('preview', kind)
    const current = board({ assets: [media, asset('missing', kind, { missing: true })] })
    const { props, rerender } = setup({ board: current }, 'ja')
    const row = screen.getByTestId('reference-asset-preview')
    const missing = screen.getByTestId('reference-asset-missing')
    expect(missing.querySelector('img, audio')).toBeNull()
    expect(missing).toHaveTextContent(translate('ja', 'referenceMissing'))
    expect(missing).toHaveTextContent(translate('ja', 'referenceRepairHint'))
    fireEvent.error(row.querySelector('img, audio')!)
    expect(row.querySelector('img, audio')).toBeNull()
    expect(row).toHaveTextContent(media.filename)
    expect(row).toHaveTextContent(translate('ja', 'referenceMissing'))
    expect(row).toHaveTextContent(translate('ja', 'referenceRepairHint'))
    rerender(panel({ ...props, board: { ...current, modifiedAt: 99, assets: current.assets!.map((item) => ({ ...item })) } }, 'ja'))
    expect(row.querySelector('img, audio')).toBeNull()
    expect(props.onMutate).not.toHaveBeenCalled()
    // A genuinely different source may load; rerendering the failed source may not.
    rerender(panel({ ...props, board: board({ assets: [{ ...media, filename: `new-${media.filename}` }] }) }, 'ja'))
    expect(row.querySelector('img, audio')).toHaveAttribute('src', `/uploads/new-${media.filename}`)
    expect(within(row).queryByText(translate('ja', 'referenceMissing'))).not.toBeInTheDocument()
  })

  it.each([
    '409: This reference set changed. Reload before retrying.',
    '401: Authentication is required.',
    '503: Reference storage is unavailable.',
    'Could not save the project. Your edits are retained.',
    'Could not load the reference library.',
  ])('shows the parent error inside the named project modal without a duplicate generic failure (%s)', async (error) => {
    const onMutate = vi.fn<ReferenceMutation>().mockResolvedValue(false)
    const { props, rerender } = setup({ error, onMutate })
    const dialog = screen.getByRole('dialog', { name: t('referenceTitle') })
    expect(within(dialog).getByText('Board A')).toBeInTheDocument()
    expect(within(dialog).getByRole('alert')).toHaveTextContent(error)
    expect(onMutate).not.toHaveBeenCalled()
    edit()
    change('referenceNotes', 'Keep my draft')
    click('referenceSave')
    await waitFor(() => expect(screen.getByRole('button', { name: t('referenceSave') })).toBeEnabled())
    expect(within(dialog).getAllByRole('alert')).toHaveLength(1)
    expect(within(dialog).getByRole('alert')).toHaveTextContent(error)
    expect(within(dialog).queryByText(t('referenceMutationFailed'))).not.toBeInTheDocument()
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Keep my draft')
    expect(api.updateReferenceSet).not.toHaveBeenCalled()
    rerender(panel({ ...props, error: undefined }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent(t('referenceMutationFailed'))
  })

  it.each(['png', 'JPG', 'jpeg', 'webp', 'wav', 'mp3', 'flac', 'm4a', 'ogg', 'aac'])('imports %s through upload and registration in one mutation using the flushed board revision', async (extension) => {
    const kind = ['png', 'JPG', 'jpeg', 'webp'].includes(extension) ? 'image' : 'audio'
    const current = board({ modifiedAt: 99 })
    const { props } = setup({ onMutate: mutation(current) })
    const file = new File(['media'], `original.${extension}`)
    vi.mocked(api.upload).mockResolvedValue({ name: `uploaded.${extension}` })
    upload(file, kind)
    await waitFor(() => expect(api.importReferenceAsset).toHaveBeenCalledWith('board-a', `uploaded.${extension}`, kind, 99))
    expect(api.upload).toHaveBeenCalledWith(file)
    expect(props.onMutate).toHaveBeenCalledOnce()
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
  })

  it('rejects oversize and unsupported files before any upload, and file-dialog cancellation does nothing', () => {
    const { props } = setup()
    const large = new File(['x'], 'large.png')
    Object.defineProperty(large, 'size', { value: 256 * 1024 * 1024 + 1 })
    upload(large)
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceFileSize'))
    upload(new File(['x'], 'video.mp4'))
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceFileType'))
    upload(new File(['x'], 'audio.wav'))
    fireEvent.change(screen.getByLabelText(t('referenceImportImage')), { target: { files: [] } })
    expect(api.upload).not.toHaveBeenCalled()
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it('allows exactly 256 MiB and retains a dirty editor after failed registration without retrying upload', async () => {
    setup()
    edit()
    change('referenceNotes', 'Keep this note')
    vi.mocked(api.importReferenceAsset).mockRejectedValue(new ApiError(409, 'revision conflict'))
    const file = new File(['x'], 'limit.png')
    Object.defineProperty(file, 'size', { value: 256 * 1024 * 1024 })
    upload(file)
    await screen.findByRole('alert')
    expect(api.upload).toHaveBeenCalledOnce()
    expect(api.importReferenceAsset).toHaveBeenCalledOnce()
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Keep this note')
  })

  it('creates explicitly with ordered add/up/down/remove controls, notes and kind; never applies or generates', async () => {
    setup({ onMutate: mutation(board({ modifiedAt: 77 })) })
    click('referenceNew')
    change('referenceName', 'New look')
    change('referenceKind', 'style')
    change('referenceNotes', 'Keep the light')
    for (const id of ['i1', 'i2', 'i3']) change('referenceAddImage', id)
    const images = screen.getByRole('list', { name: t('referenceImages') })
    fireEvent.click(within(images).getByRole('button', { name: `${t('referenceMoveUp')} · 3` }))
    fireEvent.click(within(images).getByRole('button', { name: `${t('referenceMoveDown')} · 1` }))
    fireEvent.click(within(images).getByRole('button', { name: `${t('referenceRemove')} · 3` }))
    expect(within(images).getAllByRole('listitem').map((item) => item.firstElementChild?.textContent)).toEqual(['1. i3.png', '2. i1.png'])
    expect(within(images).getByRole('button', { name: `${t('referenceMoveUp')} · 1` })).toBeDisabled()
    expect(within(images).getByRole('button', { name: `${t('referenceMoveDown')} · 2` })).toBeDisabled()
    change('referenceAddAudio', 'a2')
    change('referenceAddAudio', 'a1')
    const audio = screen.getByRole('list', { name: t('referenceAudio') })
    fireEvent.click(within(audio).getByRole('button', { name: `${t('referenceMoveUp')} · 2` }))
    expect(api.createReferenceSet).not.toHaveBeenCalled()
    click('referenceSave')
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
    expect(api.createReferenceSet).toHaveBeenCalledWith('board-a', { name: 'New look', kind: 'style', notes: 'Keep the light', image_asset_ids: ['i3', 'i1'], audio_asset_ids: ['a1', 'a2'] }, 77)
    expect(api.applyReferenceSet).not.toHaveBeenCalled()
    expect(api.generateShot).not.toHaveBeenCalled()
  })

  it('requires a name and at least one image before saving, with no implicit save on input', () => {
    const { props } = setup()
    click('referenceNew')
    click('referenceSave')
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceNameRequired'))
    change('referenceName', 'Draft')
    change('referenceAddAudio', 'a1')
    click('referenceSave')
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceImageLimit'))
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it('caps additions at 9 images and 3 audio clips, excludes duplicates, and validates the 15-second total', async () => {
    const images = Array.from({ length: 10 }, (_, index) => asset(`i${index}`))
    const audio = Array.from({ length: 4 }, (_, index) => asset(`a${index}`, 'audio', { duration: 6 }))
    const { props } = setup({ board: board({ assets: [...images, ...audio], reference_sets: [] }) })
    click('referenceNew')
    change('referenceName', 'Limit test')
    for (const item of images.slice(0, 9)) change('referenceAddImage', item.id)
    for (const item of audio.slice(0, 3)) change('referenceAddAudio', item.id)
    expect(screen.getByLabelText(t('referenceAddImage'))).toBeDisabled()
    expect(screen.getByLabelText(t('referenceAddAudio'))).toBeDisabled()
    expect(within(screen.getByLabelText(t('referenceAddImage'))).queryByRole('option', { name: 'i0.png' })).not.toBeInTheDocument()
    click('referenceSave')
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceAudioDuration'))
    expect(props.onMutate).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('list', { name: t('referenceAudio') })).getByRole('button', { name: `${t('referenceRemove')} · 3` }))
    expect(screen.getByLabelText(t('referenceAddAudio'))).toBeEnabled()
    click('referenceSave')
    await waitFor(() => expect(api.createReferenceSet).toHaveBeenCalledOnce())
  })

  it.each([
    { image_asset_ids: Array.from({ length: 10 }, (_, i) => `i${i}`), issue: 'referenceImageLimit' },
    { audio_asset_ids: ['a1', 'a2', 'a3', 'a4'], issue: 'referenceAudioLimit' },
    { image_asset_ids: ['unknown'], issue: 'referenceInvalidAssets' },
  ] as (Partial<ReferenceSet> & { issue: I18nKey })[])('rejects invalid persisted selections ($issue)', ({ issue, ...fields }) => {
    const { props } = setup({ board: board({ reference_sets: [set(fields)] }) })
    edit()
    click('referenceSave')
    expect(screen.getByRole('alert')).toHaveTextContent(t(issue))
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it('preserves a dirty form and its captured set revision across polls and 409; reload requires confirmation', async () => {
    const latest = board({ modifiedAt: 99, reference_sets: [set({ name: 'Server name', revision: 4 })] })
    const { props, rerender } = setup({ onMutate: mutation(latest) })
    edit()
    change('referenceName', 'Unsaved name')
    rerender(panel({ ...props, board: latest }))
    expect(screen.getByText(t('referenceConflict'))).toBeInTheDocument()
    expect(screen.getByLabelText(t('referenceName'))).toHaveValue('Unsaved name')
    vi.mocked(api.updateReferenceSet).mockRejectedValue(new ApiError(409, 'revision conflict'))
    click('referenceSave')
    await screen.findByRole('alert')
    expect(api.updateReferenceSet).toHaveBeenCalledWith('board-a', 'set-a', expect.objectContaining({ name: 'Unsaved name' }), 99, 3)
    expect(api.updateReferenceSet).toHaveBeenCalledOnce()
    expect(screen.getByLabelText(t('referenceName'))).toHaveValue('Unsaved name')
    vi.mocked(window.confirm).mockReturnValue(false)
    click('referenceReload')
    expect(screen.getByLabelText(t('referenceName'))).toHaveValue('Unsaved name')
    vi.mocked(window.confirm).mockReturnValue(true)
    click('referenceReload')
    expect(window.confirm).toHaveBeenLastCalledWith(t('referenceReloadConfirm'))
    expect(screen.getByLabelText(t('referenceName'))).toHaveValue('Server name')
    vi.mocked(api.updateReferenceSet).mockResolvedValue(latest)
    click('referenceSave')
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
    expect(api.updateReferenceSet).toHaveBeenLastCalledWith('board-a', 'set-a', expect.objectContaining({ name: 'Server name' }), 99, 4)
  })

  it('retains the original revision even when polling changes an unmodified open editor', async () => {
    const latest = board({ modifiedAt: 22, reference_sets: [set({ revision: 4, notes: 'Changed remotely' })] })
    const { props, rerender } = setup({ onMutate: mutation(latest) })
    edit()
    rerender(panel({ ...props, board: latest }))
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Original notes')
    click('referenceSave')
    await waitFor(() => expect(api.updateReferenceSet).toHaveBeenCalledWith('board-a', 'set-a', expect.objectContaining({ notes: 'Original notes' }), 22, 3))
  })

  it('keeps a draft when its set is deleted by a poll, rather than converting an update into a create', async () => {
    const latest = board({ modifiedAt: 23, reference_sets: [] })
    const { props, rerender } = setup({ onMutate: mutation(latest) })
    edit()
    change('referenceNotes', 'Do not discard or recreate')
    rerender(panel({ ...props, board: latest }))
    expect(screen.getByText(t('referenceConflict'))).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: t('referenceReload') })).not.toBeInTheDocument()
    vi.mocked(api.updateReferenceSet).mockRejectedValue(new ApiError(404, 'not found'))
    click('referenceSave')
    await screen.findByRole('alert')
    expect(api.updateReferenceSet).toHaveBeenCalledWith('board-a', 'set-a', expect.objectContaining({ notes: 'Do not discard or recreate' }), 23, 3)
    expect(api.createReferenceSet).not.toHaveBeenCalled()
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Do not discard or recreate')
  })

  it.each([null, 1, 16])('rejects unknown or invalid per-clip audio duration %s', (duration) => {
    const { props } = setup({ board: board({ assets: [asset('i1'), asset('i2'), asset('a1', 'audio', { duration })] }) })
    edit()
    click('referenceSave')
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceAudioDuration'))
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it.each(['wrong-board', 'missing-asset'] as const)('rechecks the flushed board before saving (%s)', async (problem) => {
    const current = board()
    if (problem === 'wrong-board') current.id = 'board-b'
    else current.assets![0].missing = true
    setup({ onMutate: mutation(current) })
    edit()
    change('referenceNotes', 'Retain this')
    click('referenceSave')
    await screen.findByRole('alert')
    expect(api.updateReferenceSet).not.toHaveBeenCalled()
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Retain this')
  })

  it('guards dirty cancellation, new/edit navigation, close, Escape and backdrop; accepted cancel discards without saving', async () => {
    const user = userEvent.setup()
    const { props } = setup()
    await user.click(screen.getByRole('button', { name: t('referenceEdit') }))
    await user.type(screen.getByLabelText(t('referenceNotes')), ' dirty')
    vi.mocked(window.confirm).mockReturnValue(false)
    for (const key of ['referenceCancel', 'referenceNew', 'referenceClose', 'referenceEdit'] as const) click(key)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    const beforeBackdrop = vi.mocked(window.confirm).mock.calls.length
    expect(beforeBackdrop).toBe(5)
    // Radix defers primary-button outside handling until click. userEvent supplies
    // a complete mouse/pointer sequence (also when jsdom needs a PointerEvent fallback).
    await user.click(document.querySelector('[data-slot="dialog-overlay"]')!)
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(beforeBackdrop + 1))
    expect(window.confirm).toHaveBeenLastCalledWith(t('referenceDiscardConfirm'))
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Original notes dirty')
    expect(props.onMutate).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValue(true)
    click('referenceCancel')
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(api.updateReferenceSet).not.toHaveBeenCalled()
  })

  it('guards unloading only dirty new/existing set drafts, including rejected cancellation, and cleans up on unmount', () => {
    const { unmount } = setup()
    expect(unloadPrevented()).toBe(false)
    click('referenceNew')
    expect(unloadPrevented()).toBe(false)
    change('referenceName', 'Unsaved set')
    expect(unloadPrevented()).toBe(true)
    change('referenceName', '')
    expect(unloadPrevented()).toBe(false)
    change('referenceName', 'Unsaved set')
    expect(unloadPrevented()).toBe(true)
    expect(window.confirm).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValue(false)
    click('referenceCancel')
    expect(unloadPrevented()).toBe(true)
    vi.mocked(window.confirm).mockReturnValue(true)
    click('referenceCancel')
    expect(unloadPrevented()).toBe(false)
    edit()
    expect(unloadPrevented()).toBe(false)
    change('referenceNotes', 'Unsaved notes')
    expect(unloadPrevented()).toBe(true)
    unmount()
    expect(unloadPrevented()).toBe(false)
  })

  it('retains the unload guard during a pending or failed save and removes it only after a successful save', async () => {
    let reject!: (error: Error) => void
    vi.mocked(api.updateReferenceSet).mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    setup()
    edit()
    change('referenceNotes', 'Unsaved notes')
    click('referenceSave')
    expect(unloadPrevented()).toBe(true)
    await act(async () => { reject(new ApiError(503, 'unavailable')) })
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceMutationFailed'))
    expect(unloadPrevented()).toBe(true)
    vi.mocked(api.updateReferenceSet).mockResolvedValue(board())
    click('referenceSave')
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
    expect(unloadPrevented()).toBe(false)
  })

  it('deletes only metadata after confirmation and retains drafts on deletion failure', async () => {
    setup()
    edit()
    change('referenceNotes', 'Keep draft')
    vi.mocked(window.confirm).mockReturnValue(false)
    click('referenceDeleteSet')
    const removeAsset = within(screen.getByTestId('reference-asset-i3')).getByRole('button')
    fireEvent.click(removeAsset)
    expect(api.deleteReferenceSet).not.toHaveBeenCalled()
    expect(api.deleteReferenceAsset).not.toHaveBeenCalled()
    vi.mocked(window.confirm).mockReturnValue(true)
    vi.mocked(api.deleteReferenceSet).mockRejectedValue(new ApiError(409, 'busy'))
    click('referenceDeleteSet')
    await screen.findByRole('alert')
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Keep draft')
    fireEvent.click(removeAsset)
    await waitFor(() => expect(api.deleteReferenceAsset).toHaveBeenCalledWith('board-a', 'i3', 10))
    expect(window.confirm).toHaveBeenLastCalledWith(`${t('referenceDeleteAssetConfirm')}\ni3.png`)
    await waitFor(() => expect(removeAsset).toBeEnabled())
    vi.mocked(api.deleteReferenceSet).mockResolvedValue(board())
    click('referenceDeleteSet')
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
    expect(api.deleteReferenceSet).toHaveBeenLastCalledWith('board-a', 'set-a', 10)
  })

  it.each(['updated', 'deleted'] as const)('aborts deletion when the confirmed set is %s during flush/poll and retains the draft', async (outcome) => {
    let flush!: (value: Board) => void
    const flushed = new Promise<Board>((resolve) => { flush = resolve })
    const onMutate = vi.fn<ReferenceMutation>(async (action) => { try { await action(await flushed); return true } catch { return false } })
    const { props, rerender } = setup({ onMutate })
    edit()
    change('referenceNotes', 'Retain this draft')
    click('referenceDeleteSet')
    expect(onMutate).toHaveBeenCalledOnce()
    expect(api.deleteReferenceSet).not.toHaveBeenCalled()
    expect(window.confirm).toHaveBeenNthCalledWith(1, `${t('referenceDeleteSetConfirm')}\nHero`)
    expect(window.confirm).toHaveBeenNthCalledWith(2, t('referenceDiscardConfirm'))
    const latest = board({ modifiedAt: 99, reference_sets: outcome === 'updated' ? [set({ revision: 4, name: 'Newer hero' })] : [] })
    rerender(panel({ ...props, board: latest }))
    await act(async () => { flush(latest) })
    expect(api.deleteReferenceSet).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceMutationFailed'))
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Retain this draft')
    expect(unloadPrevented()).toBe(true)
    expect(window.confirm).toHaveBeenCalledTimes(2)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('allows deletion after a board-only revision change when the displayed set revision still matches', async () => {
    setup({ onMutate: mutation(board({ modifiedAt: 99 })) })
    click('referenceDeleteSet')
    await waitFor(() => expect(api.deleteReferenceSet).toHaveBeenCalledWith('board-a', 'set-a', 99))
    expect(api.deleteReferenceSet).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows missing repair guidance, excludes missing assets from additions and keeps invalid drafts', () => {
    const { props } = setup({ board: board({ assets: [asset('i1', 'image', { missing: true }), asset('i2')], reference_sets: [set({ audio_asset_ids: [], missing_asset_ids: ['i1'] })] }) })
    edit()
    expect(screen.getAllByText(new RegExp(t('referenceRepairHint').slice(0, 24))).length).toBeGreaterThan(0)
    expect(screen.getByTestId('reference-selected-i1')).toHaveTextContent(t('referenceMissing'))
    click('referenceSave')
    expect(screen.getByRole('alert')).toHaveTextContent(t('referenceInvalidAssets'))
    expect(props.onMutate).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByTestId('reference-selected-i1')).getByRole('button', { name: `${t('referenceRemove')} · 1` }))
    expect(within(screen.getByLabelText(t('referenceAddImage'))).queryByRole('option', { name: 'i1.png' })).not.toBeInTheDocument()
  })

  it('locks pending imports and closing, captures the old board and never resets a new board editor on late completion', async () => {
    const user = userEvent.setup()
    let finish!: (result: { name: string }) => void
    vi.mocked(api.upload).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { props, rerender } = setup()
    edit()
    upload(new File(['x'], 'old.png'))
    upload(new File(['x'], 'double.png'))
    expect(api.upload).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: t('referenceClose') })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await user.click(document.querySelector('[data-slot="dialog-overlay"]')!)
    expect(props.onClose).not.toHaveBeenCalled()
    const next = board({ id: 'board-b' })
    rerender(panel({ ...props, board: next, onMutate: mutation(next) }))
    click('referenceNew')
    change('referenceName', 'Board B draft')
    await act(async () => { finish({ name: 'old-upload.png' }) })
    expect(api.importReferenceAsset).toHaveBeenCalledWith('board-a', 'old-upload.png', 'image', 10)
    expect(screen.getByLabelText(t('referenceName'))).toHaveValue('Board B draft')
  })

  it('honors disabled and a rejected parent mutation without clearing edits or calling APIs', async () => {
    const onMutate = vi.fn<ReferenceMutation>().mockResolvedValue(false)
    const { props, rerender } = setup({ onMutate })
    edit()
    change('referenceNotes', 'Retain me')
    click('referenceSave')
    await screen.findByRole('alert')
    expect(screen.getByLabelText(t('referenceNotes'))).toHaveValue('Retain me')
    expect(api.updateReferenceSet).not.toHaveBeenCalled()
    rerender(panel({ ...props, disabled: true }))
    for (const key of ['referenceSave', 'referenceNew', 'referenceDeleteSet'] as const) expect(screen.getByRole('button', { name: t(key) })).toBeDisabled()
    expect(screen.getByLabelText(t('referenceImportImage'))).toBeDisabled()
    expect(screen.getByLabelText(t('referenceName'))).toBeDisabled()
  })

  it('guards double saves and does not clear a new board draft after the old save succeeds', async () => {
    let finish!: (value: Board) => void
    vi.mocked(api.updateReferenceSet).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { props, rerender } = setup()
    edit()
    change('referenceNotes', 'Old board edit')
    click('referenceSave')
    click('referenceSave')
    expect(api.updateReferenceSet).toHaveBeenCalledOnce()
    expect(unloadPrevented()).toBe(true)
    expect(screen.getByRole('button', { name: t('referenceCancel') })).toBeDisabled()
    const next = board({ id: 'board-b' })
    rerender(panel({ ...props, board: next, onMutate: mutation(next) }))
    expect(unloadPrevented()).toBe(false)
    click('referenceNew')
    change('referenceName', 'New board draft')
    await act(async () => { finish(board()) })
    expect(screen.getByLabelText(t('referenceName'))).toHaveValue('New board draft')
    expect(unloadPrevented()).toBe(true)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(LANGS.map(({ code }) => code))('has complete reference translations and localized manager controls in %s', (lang) => {
    setup({}, lang)
    const keys = Object.keys(resources.zh).filter((key) => key.startsWith('reference')) as I18nKey[]
    for (const key of keys) expect(resources[lang][key], `${lang}.${key}`).toBeTruthy()
    expect(screen.getByRole('dialog', { name: translate(lang, 'referenceTitle') })).toBeInTheDocument()
    expect(screen.getByLabelText(translate(lang, 'referenceImportAudio'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: translate(lang, 'referenceClose') })).toBeEnabled()
  })
})