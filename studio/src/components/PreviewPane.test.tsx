import { type ComponentProps } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { api, type Job } from '@/lib/api'
import { zh } from '@/lib/i18nData'
import { I18nContext } from '@/lib/i18nContext'
import { translate } from '@/lib/i18nResources'
import PreviewPane from './PreviewPane'

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', label: 'Rendering shot', status: 'running', phase: 'denoising',
    done: 4, total: 10, created: 1, params: {}, log: ['step 4'], ...overrides,
  }
}

function setup(overrides: Partial<ComponentProps<typeof PreviewPane>> = {}) {
  const props: ComponentProps<typeof PreviewPane> = {
    video: 'selected.mp4', runningJob: null, watchJob: false, onWatchJob: vi.fn(),
    draftJob: null, onResume: vi.fn(), hasShots: true, onAddShot: vi.fn(),
    sequencing: false, onSequenceEnded: vi.fn(), ...overrides,
  }
  return { props, ...render(<PreviewPane {...props} />) }
}

describe('PreviewPane', () => {
  const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  })
  afterAll(() => {
    if (scrollToDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  })
  afterEach(() => vi.restoreAllMocks())

  it('encodes the entire selected filename and retains normal playback controls', () => {
    const video = 'take #2/中文?.mp4'
    const { container, props } = setup({ video })
    const player = container.querySelector('video')!
    expect(player).toHaveAttribute('src', `/outputs/${encodeURIComponent(video)}`)
    expect(player).toHaveAttribute('controls')
    expect(player).toHaveAttribute('autoplay')
    expect(player).toHaveAttribute('loop')
    fireEvent.ended(player)
    expect(props.onSequenceEnded).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: zh.takeReturnSelected })).not.toBeInTheDocument()
  })

  it('shows preview context in the header and returns to the selected take on demand', () => {
    const onReturnToSelected = vi.fn()
    setup({ contextLabel: 'Shot 2 · Take 1 · Preview only', onReturnToSelected })
    const context = screen.getByText('Shot 2 · Take 1 · Preview only')
    expect(context).toBeVisible()
    expect(context.parentElement).toContainElement(screen.getByText(zh.preview))
    const button = screen.getByRole('button', { name: zh.takeReturnSelected })
    expect(context.parentElement).toContainElement(button)
    fireEvent.click(button)
    expect(onReturnToSelected).toHaveBeenCalledOnce()
  })

  it('shows context without offering a return action when no handler is supplied', () => {
    setup({ contextLabel: 'Selected take' })
    expect(screen.getByText('Selected take')).toBeVisible()
    expect(screen.queryByRole('button', { name: zh.takeReturnSelected })).not.toBeInTheDocument()
  })

  it.each(['missing.mp4', null])('shows a localized missing message instead of a broken player for %s', (video) => {
    const { container } = setup({ video, missing: true })
    expect(container.querySelector('video')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(zh.takeMissing)
    expect(screen.getByRole('status')).toHaveTextContent(zh.takeMissingHint)
    expect(screen.queryByText(zh.emptyPreview)).not.toBeInTheDocument()
  })

  it('replaces media errors with a message and renders a new source without retaining the error', () => {
    const { container, props, rerender } = setup()
    fireEvent.error(container.querySelector('video')!)
    expect(screen.getByRole('alert')).toHaveTextContent(zh.takeMediaError)
    expect(container.querySelector('video')).toBeNull()
    expect(props.onSequenceEnded).not.toHaveBeenCalled()
    rerender(<PreviewPane {...props} contextLabel="Same source" />)
    expect(screen.getByRole('alert')).toHaveTextContent(zh.takeMediaError)
    rerender(<PreviewPane {...props} video="recovered #2.mp4" />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(container.querySelector('video')).toHaveAttribute('src', '/outputs/recovered%20%232.mp4')
    rerender(<PreviewPane {...props} />)
    expect(container.querySelector('video')).toHaveAttribute('src', '/outputs/selected.mp4')
  })

  it('renders a source again when its missing flag clears', () => {
    const { container, props, rerender } = setup({ missing: true })
    expect(container.querySelector('video')).toBeNull()
    rerender(<PreviewPane {...props} missing={false} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(container.querySelector('video')).toHaveAttribute('src', '/outputs/selected.mp4')
  })

  it('uses the active locale for missing and failed media messages', () => {
    const { props, unmount } = setup()
    unmount()
    const context = { lang: 'en' as const, t: (key: keyof typeof zh) => translate('en', key), setLang: vi.fn() }
    const { container, rerender } = render(
      <I18nContext.Provider value={context}><PreviewPane {...props} missing /></I18nContext.Provider>,
    )
    expect(screen.getByRole('status')).toHaveTextContent(translate('en', 'takeMissing'))
    expect(screen.getByRole('status')).toHaveTextContent(translate('en', 'takeMissingHint'))
    rerender(<I18nContext.Provider value={context}><PreviewPane {...props} /></I18nContext.Provider>)
    fireEvent.error(container.querySelector('video')!)
    expect(screen.getByRole('alert')).toHaveTextContent(translate('en', 'takeMediaError'))
  })

  it('advances only on sequence ended and does not skip media errors', () => {
    const { container, props, rerender } = setup({ sequencing: true })
    const player = container.querySelector('video')!
    expect(player).not.toHaveAttribute('loop')
    fireEvent.ended(player)
    expect(props.onSequenceEnded).toHaveBeenCalledOnce()
    fireEvent.error(player)
    expect(props.onSequenceEnded).toHaveBeenCalledOnce()
    rerender(<PreviewPane {...props} video="next.mp4" />)
    expect(container.querySelector('video')).not.toHaveAttribute('loop')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps a usable previous output previewable while a retry runs without being watched', () => {
    const { container, props } = setup({ runningJob: job(), draftJob: job({ id: 'draft' }) })
    expect(container.querySelector('video')).toHaveAttribute('src', '/outputs/selected.mp4')
    expect(screen.getByText(zh.draftReady)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /denoising.*4\/10.*40%/ }))
    expect(props.onWatchJob).toHaveBeenCalledWith(true)
  })

  it('preserves watched job progress, logs and cancellation over missing media and draft notices', () => {
    const cancel = vi.spyOn(api, 'cancel').mockResolvedValue(undefined)
    const { container } = setup({ runningJob: job(), watchJob: true, missing: true, draftJob: job({ id: 'draft' }) })
    expect(screen.getByRole('progressbar')).toBeVisible()
    expect(container.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({ transform: 'translateX(-60%)' })
    expect(screen.getByText('4/10')).toBeVisible()
    expect(screen.getByText('step 4')).toBeVisible()
    expect(container.querySelector('video')).toBeNull()
    expect(screen.queryByText(zh.takeMissing)).not.toBeInTheDocument()
    expect(screen.queryByText(zh.draftReady)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: zh.cancel }))
    expect(cancel).toHaveBeenCalledWith('job-1')
  })

  it('keeps a draft resumable while showing its preview', () => {
    const draftJob = job({ status: 'done', label: 'Draft ready', output: 'draft.mp4' })
    const { container, props } = setup({ video: draftJob.output!, draftJob })
    expect(screen.getByText(zh.draftReady)).toBeVisible()
    expect(screen.getByText('Draft ready')).toBeVisible()
    expect(container.querySelector('video')).toHaveAttribute('src', '/outputs/draft.mp4')
    fireEvent.click(screen.getByRole('button', { name: zh.resumeRun }))
    expect(props.onResume).toHaveBeenCalledWith(draftJob)
  })

  it('preserves the no-shots add action and configured-shot empty message', () => {
    const { props, rerender } = setup({ video: null, hasShots: false, watchJob: true })
    expect(screen.getByText(zh.selectShotHint)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: zh.addShot2 }))
    expect(props.onAddShot).toHaveBeenCalledOnce()
    rerender(<PreviewPane {...props} hasShots />)
    expect(screen.getByText(zh.emptyPreview)).toBeVisible()
    expect(screen.queryByRole('button', { name: zh.addShot2 })).not.toBeInTheDocument()
  })
})