import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type VideoItem } from '@/lib/api'
import { I18nContext } from '@/lib/i18nContext'
import type { I18nKey, Lang } from '@/lib/i18nData'
import { translate } from '@/lib/i18nResources'
import LibraryStrip from './LibraryStrip'

type Props = ComponentProps<typeof LibraryStrip>
const video: VideoItem = { name: 'scene #1?雪&.mp4', size: 1024, mtime: 1, duration: 2 }
const other: VideoItem = { ...video, name: 'other.mp4' }

function setup(overrides: Partial<Props> = {}, lang: Lang = 'en') {
  const props: Props = {
    videos: [video, other], current: null,
    onPlay: vi.fn(), onChain: vi.fn(), onChanged: vi.fn(), ...overrides,
  }
  return { props, ...render(
    <I18nContext.Provider value={{ lang, t: (key) => translate(lang, key), setLang: () => {} }}>
      <LibraryStrip {...props} />
    </I18nContext.Provider>,
  ) }
}

function button(key: I18nKey, item = video, lang: Lang = 'en') {
  return screen.getByRole('button', { name: `${translate(lang, key)} · ${item.name}` })
}

async function confirm(item = video, lang: Lang = 'en') {
  fireEvent.click(button('delete', item, lang))
  await act(async () => { fireEvent.click(button('confirmDelete', item, lang)) })
}

describe('LibraryStrip', () => {
  beforeEach(() => {
    vi.spyOn(api, 'deleteVideo').mockResolvedValue({ ok: true })
    // A component-level raw fetch must never bypass the authenticated API helper.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected raw fetch')))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('only arms confirmation on the first click and never deletes on confirmation expiry', () => {
    vi.useFakeTimers()
    const { props } = setup()
    fireEvent.click(button('delete'))
    expect(button('confirmDelete')).toBeEnabled()
    expect(api.deleteVideo).not.toHaveBeenCalled()
    expect(props.onChanged).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(3000) })
    expect(button('delete')).toBeEnabled()
    expect(api.deleteVideo).not.toHaveBeenCalled()
    fireEvent.click(button('delete'))
    expect(button('confirmDelete')).toBeEnabled()
    expect(api.deleteVideo).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('deletes exactly the confirmed filename through the API helper, then refreshes', async () => {
    const { props } = setup()
    await confirm()
    expect(api.deleteVideo).toHaveBeenCalledExactlyOnceWith(video.name)
    expect(props.onChanged).toHaveBeenCalledOnce()
    expect(props.onPlay).not.toHaveBeenCalled()
    expect(props.onChain).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it.each(['en', 'zh'] as const)('shows a localized 409 failure without refreshing or deleting another file (%s)', async (lang) => {
    const error = new ApiError(409, 'Video is referenced by take history')
    vi.mocked(api.deleteVideo).mockRejectedValueOnce(error)
    const { props } = setup({}, lang)
    await confirm(video, lang)
    expect(screen.getByRole('alert')).toHaveTextContent(`${translate(lang, 'takeDeleteFailed')}: ${error.message}`)
    expect(api.deleteVideo).toHaveBeenCalledExactlyOnceWith(video.name)
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(button('delete', video, lang)).toBeEnabled()
    expect(button('delete', other, lang)).toBeEnabled()
    expect(fetch).not.toHaveBeenCalled()

    await confirm(video, lang)
    expect(props.onChanged).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not expose arbitrary non-API error details', async () => {
    vi.mocked(api.deleteVideo).mockRejectedValueOnce(new Error('Internal transport details'))
    const { props } = setup()
    await confirm()
    expect(screen.getByRole('alert').textContent).toBe(translate('en', 'takeDeleteFailed'))
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(button('delete')).toBeEnabled()
  })

  it('disables all delete controls while pending and refreshes only after success', async () => {
    let resolve!: (value: { ok: boolean }) => void
    const pending = new Promise<{ ok: boolean }>((done) => { resolve = done })
    vi.mocked(api.deleteVideo).mockReturnValueOnce(pending)
    const { props } = setup()
    await confirm()
    for (const item of [video, other]) {
      expect(button('delete', item)).toBeDisabled()
      fireEvent.click(button('delete', item))
      fireEvent.click(button('delete', item))
    }
    expect(api.deleteVideo).toHaveBeenCalledExactlyOnceWith(video.name)
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    await act(async () => { resolve({ ok: true }) })
    expect(props.onChanged).toHaveBeenCalledOnce()
    expect(button('delete')).toBeEnabled()
    expect(button('delete', other)).toBeEnabled()
  })

  it('requires a fresh confirmation when switching filenames', async () => {
    const { props } = setup()
    fireEvent.click(button('delete'))
    fireEvent.click(button('delete', other))
    expect(button('delete')).toBeEnabled()
    expect(api.deleteVideo).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(button('confirmDelete', other)) })
    expect(api.deleteVideo).toHaveBeenCalledExactlyOnceWith(other.name)
    expect(props.onChanged).toHaveBeenCalledOnce()
  })

  it('labels controls, encodes thumbnail URLs, and preserves play/chain callbacks without deleting', () => {
    const { props, container } = setup()
    expect(container.querySelector('video')).toHaveAttribute('src', `/outputs/${encodeURIComponent(video.name)}`)
    for (const control of screen.getAllByRole('button', { name: `${translate('en', 'play')} · ${video.name}` })) {
      fireEvent.click(control)
    }
    expect(props.onPlay).toHaveBeenCalledTimes(2)
    expect(props.onPlay).toHaveBeenCalledWith(video.name)
    fireEvent.click(button('chain'))
    expect(props.onChain).toHaveBeenCalledExactlyOnceWith(video)
    expect(api.deleteVideo).not.toHaveBeenCalled()
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})