import { useId, type ReactNode } from 'react'
import type { Shot } from '@/lib/api'
import type { I18nKey } from '@/lib/i18nData'
import { useI18n } from '@/lib/useI18n'

interface Props {
  shot: Shot
  previewingTakeId: string | null
  disabled: boolean
  onPreview: (takeId: string) => void
  onSelect: (takeId: string) => void
  onDelete: (takeId: string) => void
}

type Translate = (key: I18nKey) => string

const SNAPSHOT_FIELDS: [string, I18nKey][] = [
  ['prompt', 'prompt'], ['seed', 'takeSeed'],
  ['width', 'takeWidth'], ['height', 'takeHeight'], ['steps', 'takeSteps'],
  ['seconds', 'takeSeconds'], ['frames', 'takeFrames'], ['layers', 'takeLayers'],
  ['reuse', 'takeReuse'], ['turbo', 'takeTurbo'], ['token_reduction', 'tokenReduction'],
  ['checkpoint_after_step', 'takeCheckpoint'], ['ref_images', 'refImages'],
  ['ref_audio', 'refAudio'], ['first_frame', 'firstFrame'], ['last_frame', 'lastFrame'],
  ['resume', 'takeResume'], ['label', 'takeRequestLabel'],
]

const controlClass = 'min-h-8 border border-border px-2 py-1 text-[11px] transition-colors enabled:hover:bg-white enabled:hover:text-black disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 focus-visible:outline-offset-2'

// Do not stringify arbitrary objects or infer missing historical values from a live shot.
function scalarText(value: unknown, t: Translate): string {
  if (value === null || value === '') return t('takeNotSet')
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return t(value ? 'takeOn' : 'takeOff')
  return t('takeUnknown')
}

function snapshotText(value: unknown, t: Translate): string {
  if (Array.isArray(value)) return value.length ? value.map((item) => scalarText(item, t)).join('\n') : t('takeNotSet')
  return scalarText(value, t)
}

function Metadata({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 py-0.5">
      <dt className="text-muted-foreground break-words">{label}</dt>
      <dd className="mono min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

export default function TakePanel({ shot, previewingTakeId, disabled, onPreview, onSelect, onDelete }: Props) {
  const { t, lang } = useI18n()
  const headingId = useId()
  const takes = shot.takes ?? []
  const stale = shot.stale || shot.continuity_state === 'stale'

  return (
    <section aria-labelledby={headingId} className="min-w-0 border-t border-border">
      <div className="bar justify-between gap-2">
        <h3 id={headingId}>{t('takeHistory')}</h3>
        <span className="mono">{takes.length}</span>
      </div>
      {stale ? (
        <p role="status" className="px-2 pb-2 text-[11px] text-amber-300">
          <strong>{t('takeStale')}</strong> · {t('takeStaleHint')}
        </p>
      ) : shot.continuity_state === 'unknown' ? (
        <p role="status" className="px-2 pb-2 text-[11px] text-amber-300">
          <strong>{t('takeUnknownSource')}</strong> · {t('takeUnknownSourceHint')}
        </p>
      ) : null}
      {disabled && <p role="status" className="px-2 pb-2 text-[11px] text-muted-foreground">{t('takeBusy')}</p>}
      {takes.length === 0 ? (
        <p className="px-2 pb-3 text-[11px] text-muted-foreground">{t('takeEmpty')}</p>
      ) : (
        <>
          <p className="px-2 pb-2 text-[11px] text-muted-foreground">{t('takePreviewHint')}</p>
          <ol aria-label={t('takeHistory')} tabIndex={0}
            className="max-h-80 overflow-y-auto overscroll-contain space-y-2 p-2 pt-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400 focus-visible:-outline-offset-2">
            {takes.map((take, index) => {
              const selected = take.id === shot.selected_take_id
              const previewing = take.id === previewingTakeId
              const missing = take.missing || !take.output || (selected && !!shot.output_missing)
              const label = `${t('takeLabel')} ${index + 1}`
              const labelId = `${headingId}-${index}`
              const request = !take.request_unknown && take.request && !Array.isArray(take.request) ? take.request : null
              const date = typeof take.created_at === 'number' ? new Date(take.created_at * 1000) : null
              const validDate = date && Number.isFinite(date.getTime()) ? date : null
              return (
                <li key={take.id} data-testid={`take-${take.id}`} aria-labelledby={labelId}
                  className={`min-w-0 border p-2 text-[11px] ${selected ? 'border-white/70 bg-white/5' : 'border-border'}`}>
                  <div className="flex flex-wrap items-center gap-2 pb-1">
                    <h4 id={labelId} className="mono font-semibold">{label}</h4>
                    {selected && <span className="border border-white/50 px-1">{t('takeSelected')}</span>}
                    {previewing && !selected && <span className="border border-amber-400/50 px-1 text-amber-300">{t('takePreviewOnly')}</span>}
                    {take.legacy && <span className="text-muted-foreground">{t('takeLegacy')}</span>}
                    {missing && <span className="text-amber-300">{t('takeMissing')}</span>}
                  </div>
                  <dl>
                    <Metadata label={t('takeJob')}>{scalarText(take.job_id || undefined, t)}</Metadata>
                    <Metadata label={t('takeOutput')}>{scalarText(take.output || undefined, t)}</Metadata>
                    <Metadata label={t('takeCreated')}>
                      {validDate ? <time dateTime={validDate.toISOString()}>{validDate.toLocaleString(lang)}</time> : t('takeUnknown')}
                    </Metadata>
                    <Metadata label={t('takeModel')}>{scalarText(take.model_name || undefined, t)}</Metadata>
                  </dl>
                  {missing && <p className="pt-1 text-amber-300">{t('takeMissingHint')}</p>}
                  {!request && <p className="pt-1 text-muted-foreground">{t('takeMetadataUnknown')}</p>}
                  {take.source_unknown && <p className="pt-1 text-amber-300">{t('takeUnknownSource')}</p>}
                  <details className="mt-2 border-t border-border pt-1">
                    <summary className="cursor-pointer py-1 text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400">
                      {t('takeSnapshot')}
                    </summary>
                    <dl className="pt-1">
                      {SNAPSHOT_FIELDS.map(([field, key]) => (
                        <Metadata key={field} label={t(key)}>{snapshotText(request?.[field], t)}</Metadata>
                      ))}
                      <Metadata label={t('takeSource')}>
                        {take.source_unknown ? t('takeUnknown') : scalarText(take.source_take_id, t)}
                      </Metadata>
                    </dl>
                  </details>
                  <div role="group" aria-label={label} className="mt-2 flex flex-wrap gap-1.5">
                    <button type="button" className={controlClass} aria-label={`${t('play')} · ${label}`} aria-pressed={previewing}
                      disabled={disabled || missing} onClick={() => onPreview(take.id)}>
                      {t('play')}
                    </button>
                    <button type="button" className={controlClass} aria-label={`${t('takeSelect')} · ${label}`}
                      disabled={disabled || selected || missing} onClick={() => onSelect(take.id)}>
                      {t('takeSelect')}
                    </button>
                    <button type="button" className={controlClass} aria-label={`${t('takeDelete')} · ${label}`}
                      disabled={disabled || selected} onClick={() => onDelete(take.id)}>
                      {t('takeDelete')}
                    </button>
                  </div>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </section>
  )
}