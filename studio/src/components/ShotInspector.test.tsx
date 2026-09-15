import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type Shot } from '@/lib/api'
import { I18nContext } from '@/lib/i18nContext'
import { LANGS, type Lang } from '@/lib/i18nData'
import { translate, type StudioI18nKey } from '@/lib/i18nResources'
import { assembleStructuredPrompt, emptyFields } from '@/lib/promptFields'
import ShotInspector from './ShotInspector'

const t = (key: StudioI18nKey) => translate('zh', key)

function shot(id = 'a', overrides: Partial<Shot> = {}): Shot {
  return {
    id, prompt: 'A river at dawn.', width: 768, height: 768, seconds: 5,
    steps: 20, layers: 45, reuse: 2, seed: 42, first_frame: null, last_frame: null,
    status: 'idle', output: null, job_id: null, ...overrides,
  }
}

function setup(initial = shot()) {
  const props = { shot: initial, chain: true, isFirst: false, onChange: vi.fn(), onGenerate: vi.fn(), generating: false }
  const view = render(<ShotInspector {...props} />)
  return { ...view, props }
}

function EditorHarness({ initial }: { initial: Shot }) {
  const [current, setCurrent] = useState(initial)
  return <ShotInspector shot={current} chain={false} isFirst onChange={(patch) => setCurrent((s) => ({ ...s, ...patch }))}
    onGenerate={() => {}} generating={false} />
}

function uploadFile(key: 'firstFrame' | 'lastFrame' | 'refImages' | 'refAudio' = 'refImages') {
  const input = screen.getByLabelText(t(key), { selector: 'input' })
  fireEvent.change(input, { target: { files: [new File(['fixture'], key === 'refAudio' ? 'ref.wav' : 'ref.png')] } })
}

beforeEach(() => {
  // jsdom has no layout observer; keep the real Radix slider mounted in these tests.
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ShotInspector P0', () => {
  it('round-trips structured fields and arbitrary simple edits through the actual editor', () => {
    const original = 'Camera: words on a sign.\nA unique scene.'
    render(<EditorHarness initial={shot('a', { prompt: original })} />)
    fireEvent.click(screen.getByRole('button', { name: t('promptModeStructured') }))
    expect(screen.getByRole('textbox', { name: t('promptFieldScene') })).toHaveValue(original)
    expect(screen.getByText(t('promptImportedScene'))).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: t('promptModeSimple') }))
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue(original)
    fireEvent.click(screen.getByRole('button', { name: t('promptModeStructured') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('promptFieldCamera') }), { target: { value: 'slow pan' } })
    expect(screen.queryByText(t('promptImportedScene'))).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: t('promptModeSimple') }))
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue(
      assembleStructuredPrompt({ ...emptyFields(), scene: original, camera: 'slow pan' }),
    )
    fireEvent.change(screen.getByRole('textbox', { name: t('prompt') }), { target: { value: 'New prose, not the old fields.' } })
    fireEvent.click(screen.getByRole('button', { name: t('promptModeStructured') }))
    expect(screen.getByRole('textbox', { name: t('promptFieldScene') })).toHaveValue('New prose, not the old fields.')
    expect(screen.getByRole('textbox', { name: t('promptFieldCamera') })).toHaveValue('')
  })

  it('reads persisted mode and fields when switching shots, without a reset or leaked draft', () => {
    const a = shot('a', { prompt_mode: 'structured', prompt_fields: { ...emptyFields(), scene: 'Scene A', camera: 'pan A' } })
    const { props, rerender } = setup(a)
    expect(screen.getByRole('textbox', { name: t('promptFieldCamera') })).toHaveValue('pan A')
    rerender(<ShotInspector {...props} shot={shot('b', { prompt: 'Simple B' })} />)
    expect(screen.getByRole('textbox', { name: t('prompt') })).toHaveValue('Simple B')
    expect(screen.getByRole('button', { name: t('promptModeSimple') })).toHaveAttribute('aria-pressed', 'true')
    rerender(<ShotInspector {...props} shot={a} />)
    expect(screen.getByRole('textbox', { name: t('promptFieldScene') })).toHaveValue('Scene A')
    expect(screen.getByRole('textbox', { name: t('promptFieldCamera') })).toHaveValue('pan A')
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('blocks anchor/reference conflicts and audio-only references, but not empirical warnings', () => {
    const { props, rerender } = setup(shot('a', { first_frame: 'first.png', ref_audio: ['ref.wav'] }))
    expect(screen.getByText(t('conditioningConflict'))).toHaveAttribute('role', 'alert')
    expect(screen.getByText(t('audioNeedsImage'))).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('button', { name: t('generateShot') })).toBeDisabled()
    rerender(<ShotInspector {...props} shot={shot('b', { ref_images: ['ref.png'], ref_audio: ['ref.wav'], token_reduction: true })} />)
    expect(screen.queryByText(t('conditioningConflict'))).not.toBeInTheDocument()
    expect(screen.queryByText(t('audioNeedsImage'))).not.toBeInTheDocument()
    expect(screen.getByText(t('chainSkippedRefs'))).toBeInTheDocument()
    expect(screen.queryByText(t('chainAutoHint'))).not.toBeInTheDocument()
    expect(screen.getByText(t('tokenReductionAudioWarning'))).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: t('generateShot') })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: t('generateShot') }))
    expect(props.onGenerate).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('checkbox', { name: t('tokenReduction') }))
    expect(props.onChange).toHaveBeenCalledWith({ token_reduction: false })
  })

  it('serializes uploads per shot and applies a late result only through the captured callback', async () => {
    let resolveUpload!: (value: { name: string }) => void
    const upload = vi.spyOn(api, 'upload').mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve }))
    const { props, rerender } = setup(shot('a', { ref_images: ['existing.png'] }))
    uploadFile()
    expect(screen.getByText(t('uploading'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('generateShot') })).toBeDisabled()
    expect(screen.getByLabelText(t('refImages'), { selector: 'input' })).toBeDisabled()
    uploadFile()
    expect(upload).toHaveBeenCalledOnce()
    const changeB = vi.fn()
    rerender(<ShotInspector {...props} shot={shot('b')} onChange={changeB} />)
    expect(screen.queryByText(t('uploading'))).not.toBeInTheDocument()
    await act(async () => { resolveUpload({ name: 'uploaded.png' }) })
    expect(props.onChange).toHaveBeenCalledOnce()
    expect(props.onChange).toHaveBeenCalledWith({ ref_images: ['existing.png', 'uploaded.png'] })
    expect(changeB).not.toHaveBeenCalled()
  })

  it('shows late upload failures only for the originating shot and lets that shot retry', async () => {
    let rejectUpload!: (reason: Error) => void
    const upload = vi.spyOn(api, 'upload').mockImplementationOnce(() => new Promise((_, reject) => { rejectUpload = reject }))
    const { props, rerender } = setup()
    uploadFile('firstFrame')
    const changeB = vi.fn()
    rerender(<ShotInspector {...props} shot={shot('b')} onChange={changeB} />)
    await act(async () => { rejectUpload(new Error('network failure')) })
    expect(screen.queryByText(t('uploadFailed'))).not.toBeInTheDocument()
    expect(props.onChange).not.toHaveBeenCalled()
    expect(changeB).not.toHaveBeenCalled()
    rerender(<ShotInspector {...props} />)
    expect(screen.getByText(t('uploadFailed'))).toHaveAttribute('role', 'alert')
    upload.mockResolvedValueOnce({ name: 'retry.png' })
    uploadFile('firstFrame')
    await waitFor(() => expect(props.onChange).toHaveBeenCalledWith({ first_frame: 'retry.png' }))
    expect(screen.queryByText(t('uploadFailed'))).not.toBeInTheDocument()
  })

  it('appends typed reference audio and stores checkpoint off as null', async () => {
    vi.spyOn(api, 'upload').mockResolvedValue({ name: 'new.wav' })
    const { props } = setup(shot('a', { ref_images: ['image.png'], ref_audio: ['old.wav'], checkpoint_after_step: 4 }))
    uploadFile('refAudio')
    await waitFor(() => expect(props.onChange).toHaveBeenCalledWith({ ref_audio: ['old.wav', 'new.wav'] }))
    fireEvent.change(screen.getByRole('spinbutton', { name: t('ckptAfter') }), { target: { value: '0' } })
    expect(props.onChange).toHaveBeenCalledWith({ checkpoint_after_step: null })
  })

  it.each(LANGS.map(({ code }) => code))('renders localized notices and editor labels in %s', (lang: Lang) => {
    const current = shot('a', { prompt_mode: 'structured', first_frame: 'frame.png', ref_audio: ['audio.wav'], token_reduction: true })
    render(<I18nContext.Provider value={{ lang, t: (key) => translate(lang, key), setLang: () => {} }}>
      <ShotInspector shot={current} chain isFirst={false} onChange={vi.fn()} onGenerate={vi.fn()} generating={false} />
    </I18nContext.Provider>)
    for (const key of ['promptImportedScene', 'conditioningConflict', 'audioNeedsImage', 'chainSkippedRefs', 'tokenReductionAudioWarning'] as const) {
      expect(screen.getByText(translate(lang, key))).toBeInTheDocument()
    }
    expect(screen.getByRole('textbox', { name: translate(lang, 'promptFieldScene') })).toHaveValue(current.prompt)
  })
})

describe('inspector generation API contracts', () => {
  it('uses encoded IDs and bodyless POSTs for shot generation and resume, preserving warnings', async () => {
    const result = { job_id: 'job-1', warnings: ['chainSkippedRefs'] }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await api.generateShot('board/#', 'shot ?')).toEqual(result)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/boards/board%2F%23/shots/shot%20%3F/generate', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }))
    expect(await api.resumeJob('job/#')).toEqual(result)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/jobs/job%2F%23/resume', expect.objectContaining({ method: 'POST' }))
    expect(fetchMock.mock.calls[1][1]).not.toHaveProperty('body')
  })

  it.each([
    { detail: 'Reference audio needs an image' },
    { detail: { message: 'Reference audio needs an image', input: 'DO_NOT_DISPLAY_INPUT' } },
    { detail: [{ msg: 'Reference audio needs an image', input: 'DO_NOT_DISPLAY_INPUT', ctx: { ignored: true } }] },
  ])('extracts safe string/object/validation messages and retains HTTP status: %j', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 422 })))
    await expect(api.generateShot('board', 'shot')).rejects.toMatchObject({
      name: 'ApiError', status: 422, message: '422 Reference audio needs an image',
    })
  })

  it('does not expose arbitrary error objects, proxy HTML or secret-bearing message fragments', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { input: 'DO_NOT_DISPLAY_INPUT', headers: { ignored: true } } }), { status: 400 }))
      .mockResolvedValueOnce(new Response('<html>proxy internals</html>', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Denied: Bearer TEST_ONLY; api_key=TEST_ONLY' }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.resumeJob('a')).rejects.toEqual(new ApiError(400, 'Request failed'))
    await expect(api.resumeJob('a')).rejects.toEqual(new ApiError(502, 'Request failed'))
    await expect(api.resumeJob('a')).rejects.toMatchObject({ status: 403, message: '403 Denied: [redacted]; [redacted]' })
  })
})