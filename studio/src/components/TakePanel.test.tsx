import type { ComponentProps } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Shot, Take } from '@/lib/api'
import { I18nContext } from '@/lib/i18nContext'
import { LANGS, type I18nKey, type Lang } from '@/lib/i18nData'
import { resources, translate } from '@/lib/i18nResources'
import TakePanel from './TakePanel'

type Props = ComponentProps<typeof TakePanel>
const t = (key: I18nKey) => translate('en', key)

function take(id: string, overrides: Partial<Take> = {}): Take {
  return {
    id, shot_id: 'shot-1', job_id: `job-${id}`, output: `${id}.mp4`, created_at: 1700000000,
    request: { prompt: `Historical prompt ${id}`, seed: 0, width: 512, height: 288, steps: 6 },
    request_unknown: false, source_take_id: null, source_unknown: false,
    legacy: false, model_name: 'historical-model', missing: false, ...overrides,
  }
}

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1', prompt: 'CURRENT PROMPT MUST NOT APPEAR', width: 1920, height: 1080,
    seconds: 9, steps: 50, layers: 45, reuse: 2, seed: 999,
    first_frame: 'current-first.png', last_frame: 'current-last.png',
    ref_images: ['current-ref.png'], ref_audio: ['current-audio.wav'],
    status: 'done', output: 'a.mp4', job_id: 'current-job',
    takes: [take('a'), take('b')], selected_take_id: 'a', continuity_state: 'current', ...overrides,
  }
}

function panel(props: Props, lang: Lang = 'en') {
  return <I18nContext.Provider value={{ lang, t: (key) => translate(lang, key), setLang: () => {} }}>
    <TakePanel {...props} />
  </I18nContext.Provider>
}

function setup(overrides: Partial<Props> = {}, lang: Lang = 'en') {
  const props: Props = {
    shot: shot(), previewingTakeId: null, disabled: false,
    onPreview: vi.fn(), onSelect: vi.fn(), onDelete: vi.fn(), ...overrides,
  }
  return { props, ...render(panel(props, lang)) }
}

function metadata(card: HTMLElement, key: I18nKey) {
  return within(card).getByText(t(key), { selector: 'dt' }).nextElementSibling
}

function button(card: HTMLElement, key: 'play' | 'takeSelect' | 'takeDelete', ordinal: number) {
  return within(card).getByRole('button', { name: `${t(key)} · Take ${ordinal}` })
}

describe('TakePanel', () => {
  it.each([{ takes: undefined }, { takes: [] as Take[] }])('explains empty history without inventing a take from the output projection (%j)', ({ takes }) => {
    setup({ shot: shot({ takes, selected_take_id: null, output: 'legacy-projection.mp4' }) })
    expect(screen.getByRole('heading', { name: t('takeHistory') })).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText(t('takeEmpty'))).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByText('legacy-projection.mp4')).not.toBeInTheDocument()
  })

  it('keeps server adoption separate from browsing and delegates adoption without optimistically changing it', async () => {
    const user = userEvent.setup()
    const { props, rerender, container } = setup({
      // Neither the output projection nor timestamp order may decide adoption or numbering.
      shot: shot({ output: 'b.mp4', takes: [take('a', { created_at: 200 }), take('b', { created_at: 100 })] }),
    })
    const adopted = screen.getByTestId('take-a'), browsed = screen.getByTestId('take-b')
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(within(adopted).getByRole('heading', { name: 'Take 1' })).toBeInTheDocument()
    expect(within(browsed).getByRole('heading', { name: 'Take 2' })).toBeInTheDocument()
    expect(within(adopted).getByText(t('takeSelected'))).toBeInTheDocument()
    expect(button(adopted, 'takeSelect', 1)).toBeDisabled()
    expect(button(adopted, 'takeDelete', 1)).toBeDisabled()
    expect(button(adopted, 'play', 1)).toBeEnabled()
    await user.click(button(browsed, 'play', 2))
    expect(props.onPreview).toHaveBeenCalledWith('b')
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onDelete).not.toHaveBeenCalled()
    rerender(panel({ ...props, previewingTakeId: 'b' }))
    expect(within(adopted).getByText(t('takeSelected'))).toBeInTheDocument()
    expect(within(browsed).queryByText(t('takeSelected'))).not.toBeInTheDocument()
    expect(within(browsed).getByText(t('takePreviewOnly'))).toBeInTheDocument()
    expect(button(browsed, 'play', 2)).toHaveAttribute('aria-pressed', 'true')
    expect(button(adopted, 'play', 1)).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText(t('takePreviewHint'))).toBeInTheDocument()
    await user.click(button(browsed, 'takeSelect', 2))
    expect(props.onSelect).toHaveBeenCalledOnce()
    expect(props.onSelect).toHaveBeenCalledWith('b')
    expect(within(adopted).getByText(t('takeSelected'))).toBeInTheDocument()
    rerender(panel({ ...props, shot: { ...props.shot, selected_take_id: 'b' }, previewingTakeId: 'b' }))
    expect(within(browsed).getByText(t('takeSelected'))).toBeInTheDocument()
    expect(within(browsed).queryByText(t('takePreviewOnly'))).not.toBeInTheDocument()
    expect(button(browsed, 'takeDelete', 2)).toBeDisabled()
    expect(container.querySelector('video, audio, img')).toBeNull()
    expect(screen.getByRole('list', { name: t('takeHistory') })).toHaveClass('overflow-y-auto', 'max-h-80')
  })

  it('shows historical scalar parameters, references and lineage, never current shot inputs', async () => {
    const prompt = '<img src="example" /> A historical scene & sound.'
    setup({ shot: shot({ takes: [take('a', { source_take_id: 'source-historical', request: {
      prompt, seed: 0, width: 512, height: 288, steps: 6, seconds: 3, frames: 73,
      layers: 20, reuse: 1, turbo: false, token_reduction: true, checkpoint_after_step: null,
      ref_images: ['old-ref.png', 'second-ref.png'], ref_audio: ['old-audio.wav'],
      first_frame: 'old-first.png', last_frame: 'old-last.png', resume: 'old-checkpoint', label: 'old-label',
    } })] }) })
    const card = screen.getByTestId('take-a')
    const details = card.querySelector('details')!
    expect(details).not.toHaveAttribute('open')
    await userEvent.setup().click(within(card).getByText(t('takeSnapshot')))
    expect(details).toHaveAttribute('open')
    for (const [key, value] of [
      ['prompt', prompt], ['takeSeed', '0'], ['takeWidth', '512'], ['takeHeight', '288'], ['takeSteps', '6'],
      ['takeSeconds', '3'], ['takeFrames', '73'], ['takeLayers', '20'], ['takeReuse', '1'],
      ['takeTurbo', t('takeOff')], ['tokenReduction', t('takeOn')], ['takeCheckpoint', t('takeNotSet')],
      ['refImages', 'old-ref.png second-ref.png'], ['refAudio', 'old-audio.wav'],
      ['firstFrame', 'old-first.png'], ['lastFrame', 'old-last.png'], ['takeSource', 'source-historical'],
      ['takeResume', 'old-checkpoint'], ['takeRequestLabel', 'old-label'],
      ['takeModel', 'historical-model'], ['takeJob', 'job-a'], ['takeOutput', 'a.mp4'],
    ] as [I18nKey, string][]) expect(metadata(card, key)).toHaveTextContent(value)
    expect(card.querySelector('time')).toHaveAttribute('datetime', new Date(1700000000 * 1000).toISOString())
    expect(card.querySelector('img')).toBeNull()
    for (const current of ['CURRENT PROMPT', 'current-first.png', 'current-last.png', 'current-ref.png', 'current-audio.wav', 'current-job']) {
      expect(card).not.toHaveTextContent(current)
    }
  })

  it.each([null, { prompt: 'UNTRUSTED SNAPSHOT', seed: 123 }] as Take['request'][])('makes legacy and unknown metadata explicit without fabricating values (%j)', (request) => {
    setup({ shot: shot({ takes: [take('a', {
      request, request_unknown: true, legacy: true, source_unknown: true,
      source_take_id: 'UNTRUSTED SOURCE', created_at: null, model_name: null, job_id: null,
    })] }) })
    const card = screen.getByTestId('take-a')
    expect(within(card).getByText(t('takeLegacy'))).toBeInTheDocument()
    expect(within(card).getByText(t('takeMetadataUnknown'))).toBeInTheDocument()
    expect(within(card).getByText(t('takeUnknownSource'))).toBeInTheDocument()
    for (const key of ['prompt', 'takeSeed', 'takeWidth', 'firstFrame', 'refImages', 'takeSource', 'takeCreated', 'takeModel', 'takeJob'] as const) {
      expect(metadata(card, key)).toHaveTextContent(t('takeUnknown'))
    }
    expect(card.querySelector('time')).toBeNull()
    expect(card).not.toHaveTextContent('CURRENT PROMPT')
    expect(card).not.toHaveTextContent('UNTRUSTED')
  })

  it('renders malformed or omitted snapshot values as unknown, not raw objects, while preserving zero and empty arrays', () => {
    setup({ shot: shot({ takes: [take('a', { created_at: 0, request: {
      prompt: { internal: 'DO_NOT_RENDER_OBJECT' }, width: Number.NaN, steps: 0,
      ref_images: [{ path: 'DO_NOT_RENDER_OBJECT' }, 'safe-ref.png'], ref_audio: [],
    } })] }) })
    const card = screen.getByTestId('take-a')
    for (const key of ['prompt', 'takeSeed', 'takeWidth', 'takeHeight'] as const) {
      expect(metadata(card, key)).toHaveTextContent(t('takeUnknown'))
    }
    expect(metadata(card, 'takeSteps')).toHaveTextContent('0')
    expect(metadata(card, 'refImages')).toHaveTextContent(`${t('takeUnknown')} safe-ref.png`)
    expect(metadata(card, 'refAudio')).toHaveTextContent(t('takeNotSet'))
    expect(card.querySelector('time')).toHaveAttribute('datetime', '1970-01-01T00:00:00.000Z')
    expect(card).not.toHaveTextContent('DO_NOT_RENDER_OBJECT')
    expect(card).not.toHaveTextContent('[object Object]')
  })

  it('blocks play/adoption for missing files but delegates metadata deletion once, without an internal confirmation', async () => {
    const { props } = setup({ shot: shot({ takes: [take('a'), take('b', { missing: true })] }) })
    const card = screen.getByTestId('take-b')
    expect(within(card).getByText(t('takeMissing'))).toBeInTheDocument()
    expect(within(card).getByText(t('takeMissingHint'))).toBeInTheDocument()
    for (const key of ['play', 'takeSelect'] as const) {
      expect(button(card, key, 2)).toBeDisabled()
      fireEvent.click(button(card, key, 2))
    }
    expect(button(card, 'takeDelete', 2)).toBeEnabled()
    await userEvent.setup().click(button(card, 'takeDelete', 2))
    expect(props.onDelete).toHaveBeenCalledOnce()
    expect(props.onDelete).toHaveBeenCalledWith('b')
    expect(props.onPreview).not.toHaveBeenCalled()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('take-b')).toBeInTheDocument()
  })

  it('also respects a missing selected-output projection and never deletes the adopted take', () => {
    const { props } = setup({ shot: shot({ output_missing: true }) })
    const card = screen.getByTestId('take-a')
    for (const key of ['play', 'takeSelect', 'takeDelete'] as const) {
      expect(button(card, key, 1)).toBeDisabled()
      fireEvent.click(button(card, key, 1))
    }
    expect(props.onPreview).not.toHaveBeenCalled()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onDelete).not.toHaveBeenCalled()
    expect(button(screen.getByTestId('take-b'), 'play', 2)).toBeEnabled()
  })

  it('conservatively disables every control while busy', () => {
    const { props } = setup({ disabled: true })
    expect(screen.getByText(t('takeBusy'))).toHaveAttribute('role', 'status')
    for (const control of screen.getAllByRole('button')) {
      expect(control).toBeDisabled()
      fireEvent.click(control)
    }
    expect(props.onPreview).not.toHaveBeenCalled()
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onDelete).not.toHaveBeenCalled()
  })

  it.each(['stale', 'unknown'] as const)('shows the shot-level %s continuity explanation outside collapsed details', (continuity_state) => {
    setup({ shot: shot({ continuity_state }) })
    expect(screen.getByRole('status')).toHaveTextContent(t(continuity_state === 'stale' ? 'takeStaleHint' : 'takeUnknownSourceHint'))
    expect(screen.getByRole('status').closest('details')).toBeNull()
  })

  it.each(LANGS.map(({ code }) => code))('provides every take key and localized panel controls in %s without dictionary fallback', (lang) => {
    setup({ shot: shot({ continuity_state: 'stale' }) }, lang)
    for (const key of Object.keys(resources.zh).filter((key) => key.startsWith('take')) as I18nKey[]) {
      expect(resources[lang][key], `${lang}.${key}`).toBeTruthy()
    }
    expect(screen.getByRole('heading', { name: translate(lang, 'takeHistory') })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(translate(lang, 'takeStaleHint'))
    expect(screen.getByText(translate(lang, 'takePreviewHint'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: `${translate(lang, 'takeDelete')} · ${translate(lang, 'takeLabel')} 2` })).toBeEnabled()
  })
})