import { useRef, useState, type ReactNode } from 'react'
import { api, type Shot } from '@/lib/api'
import { type I18nKey } from '@/lib/i18n'
import { useI18n } from '@/lib/useI18n'
import { translate, type StudioI18nKey } from '@/lib/i18nResources'
import {
  FIELD_KEYS, type FieldKey, changePromptMode, editSimplePrompt, editStructuredField,
  getPromptFields, getConditioningIssues, isImportedScene,
} from '@/lib/promptFields'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'

const FIELD_LABEL_KEYS: Record<FieldKey, StudioI18nKey> = {
  scene: 'promptFieldScene', action: 'promptFieldAction', camera: 'promptFieldCamera',
  look: 'promptFieldLook', audio: 'promptFieldAudio',
}
const FIELD_PLACEHOLDER_KEYS: Record<FieldKey, StudioI18nKey> = {
  scene: 'promptDefaultScene', action: 'promptDefaultAction', camera: 'promptDefaultCamera',
  look: 'promptDefaultLook', audio: 'promptDefaultAudio',
}

const SIZES = [
  { label: '512 × 512', w: 512, h: 512 },
  { label: '768 × 768', w: 768, h: 768 },
  { label: '1344 × 768', w: 1344, h: 768 },
  { label: '768 × 1344', w: 768, h: 1344 },
  { label: '1024 × 768', w: 1024, h: 768 },
  { label: '256 × 256 preview', w: 256, h: 256 },
]

const PRESETS: { key: I18nKey; steps: number; layers: number; reuse: number; turbo?: boolean }[] = [
  { key: 'presetTurbo', steps: 6, layers: 50, reuse: 1, turbo: true },
  { key: 'presetBalanced', steps: 20, layers: 45, reuse: 2 },
  { key: 'presetDraft', steps: 6, layers: 40, reuse: 3 },
  { key: 'presetHQ', steps: 20, layers: 50, reuse: 1 },
  { key: 'presetRef', steps: 50, layers: 50, reuse: 1 },
]

function presetIndexOf(s: Shot): number {
  const i = PRESETS.findIndex((p) => p.steps === s.steps && p.layers === s.layers && p.reuse === s.reuse && !!p.turbo === !!s.turbo)
  return i >= 0 ? i : 1
}

interface SlotProps {
  title: string
  files: string[]
  removeLabel: string
  onAdd: (f: File) => void
  onRemove: (name: string) => void
  multiple?: boolean
  disabled?: boolean
}

function UploadSlot({ title, files, removeLabel, onAdd, onRemove, multiple, disabled }: SlotProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <div className="bar">{title}</div>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        {files.map((f) => (
          <div key={f} className="relative group w-14 h-14 border border-border overflow-hidden">
            <img src={`/api/media/${encodeURIComponent(f)}`} alt={title} className="w-full h-full object-cover" />
            <button disabled={disabled} onClick={() => onRemove(f)}
              className="absolute inset-0 bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity">
              {removeLabel}
            </button>
          </div>
        ))}
        {(multiple || files.length === 0) && (
          <button disabled={disabled} aria-label={title} onClick={() => inputRef.current?.click()}
            className="w-14 h-14 border border-dashed border-muted-foreground/50 text-muted-foreground text-lg hover:text-white hover:border-white transition-colors">
            +
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/*" aria-label={title} disabled={disabled} className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onAdd(f); e.target.value = '' }} />
      </div>
    </div>
  )
}

interface AudioSlotProps {
  title: string
  files: string[]
  removeLabel: string
  onAdd: (f: File) => void
  onRemove: (name: string) => void
  disabled?: boolean
}

/** Ordered standalone Ref2VA audio clips (--ref-audio) — e.g. lip-sync / music-video
 * conditioning. Uses inline <audio controls> instead of the square thumbnails
 * UploadSlot uses for images, since a filename + playhead is more useful than a tile. */
function AudioSlot({ title, files, removeLabel, onAdd, onRemove, disabled }: AudioSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <div className="bar">{title}</div>
      <div className="flex flex-col gap-1 px-2 pb-2">
        {files.map((f) => (
          <div key={f} className="flex items-center gap-1.5 border border-border px-1.5 py-1">
            <audio controls src={`/api/media/${encodeURIComponent(f)}`} className="h-7 flex-1 min-w-0" />
            <button disabled={disabled} onClick={() => onRemove(f)}
              className="shrink-0 text-[10px] text-muted-foreground hover:text-white px-1">
              {removeLabel}
            </button>
          </div>
        ))}
        <button disabled={disabled} aria-label={title} onClick={() => inputRef.current?.click()}
          className="h-7 border border-dashed border-muted-foreground/50 text-muted-foreground text-[11px] hover:text-white hover:border-white transition-colors">
          +
        </button>
        <input ref={inputRef} type="file" accept="audio/*" aria-label={title} disabled={disabled} className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onAdd(f); e.target.value = '' }} />
      </div>
    </div>
  )
}

interface Props {
  shot: Shot
  chain: boolean
  isFirst: boolean
  onChange: (patch: Partial<Shot>) => void
  onGenerate: () => void
  generating: boolean
  takePanel?: ReactNode
  referencePanel?: ReactNode
}

export default function ShotInspector({ shot, chain, isFirst, onChange, onGenerate, generating, takePanel, referencePanel }: Props) {
  const { lang } = useI18n()
  const t = (key: StudioI18nKey) => translate(lang, key)
  const promptMode = shot.prompt_mode ?? 'simple'
  const fields = getPromptFields(shot)
  const conditioning = getConditioningIssues(shot, chain, isFirst)
  const pendingUploads = useRef(new Set<string>())
  const [uploadStates, setUploadStates] = useState<Record<string, 'uploading' | 'failed' | undefined>>({})
  const uploading = uploadStates[shot.id] === 'uploading'
  const pIdx = presetIndexOf(shot)
  const sizeIdx = (() => { const i = SIZES.findIndex((z) => z.w === shot.width && z.h === shot.height); return i >= 0 ? i : 1 })()
  const firstFrame = shot.first_frame ? [shot.first_frame] : []
  const lastFrame = shot.last_frame ? [shot.last_frame] : []
  const refImages = shot.ref_images ?? []
  const refAudio = shot.ref_audio ?? []
  const ckptSteps = shot.checkpoint_after_step ?? 0
  const seconds = shot.frames != null ? shot.frames / 24 : shot.seconds ?? 56 / 24

  const upload = (patch: (name: string) => Partial<Shot>) => async (file: File) => {
    // The parent binds onChange to a shot ID. Capture that callback before awaiting,
    // rather than using the newly selected shot's callback when the upload finishes.
    const changeShot = onChange
    const shotId = shot.id
    if (pendingUploads.current.has(shotId)) return
    pendingUploads.current.add(shotId)
    setUploadStates((states) => ({ ...states, [shotId]: 'uploading' }))
    try {
      const result = await api.upload(file)
      changeShot(patch(result.name))
      setUploadStates((states) => ({ ...states, [shotId]: undefined }))
    } catch {
      setUploadStates((states) => ({ ...states, [shotId]: 'failed' }))
    } finally {
      pendingUploads.current.delete(shotId)
    }
  }

  const busy = shot.status === 'running' || shot.status === 'queued'

  return (
    <div className="w-[340px] shrink-0 border-l border-border overflow-y-auto flex flex-col">
      {takePanel}
      <div className="bar-invert justify-between">
        <span>{t('prompt')}</span>
        <div className="flex gap-1">
          {(['simple', 'structured'] as const).map((m) => (
            <button key={m} aria-pressed={m === promptMode} onClick={() => onChange(changePromptMode(shot, m))}
              className={`text-[10px] px-1.5 py-0.5 border normal-case tracking-normal font-normal ${m === promptMode ? 'bg-black text-white border-black' : 'border-black/30 text-black/60 hover:text-black'}`}>
              {t(m === 'simple' ? 'promptModeSimple' : 'promptModeStructured')}
            </button>
          ))}
        </div>
      </div>
      {promptMode === 'simple' ? (
        <div className="p-2">
          <Textarea value={shot.prompt} aria-label={t('prompt')} onChange={(e) => onChange(editSimplePrompt(e.target.value))}
            placeholder={t('promptHint')}
            className="min-h-[160px] bg-black/30 border-border rounded-none text-[13px] leading-relaxed mono" />
        </div>
      ) : (
        <div className="p-2 flex flex-col gap-1.5">
          {isImportedScene(shot) && (
            <p role="status" className="text-[11px] text-muted-foreground">{t('promptImportedScene')}</p>
          )}
          {FIELD_KEYS.map((k) => (
            <div key={k}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">{t(FIELD_LABEL_KEYS[k])}</div>
              <Textarea value={fields[k]} aria-label={t(FIELD_LABEL_KEYS[k])}
                onChange={(e) => onChange(editStructuredField(shot, k, e.target.value))}
                placeholder={t(FIELD_PLACEHOLDER_KEYS[k])}
                className="min-h-[36px] bg-black/30 border-border rounded-none text-[12px] leading-snug mono" />
            </div>
          ))}
        </div>
      )}

      <div className="bar">{t('canvas')}</div>
      <div className="grid grid-cols-2 gap-1 p-2">
        {SIZES.map((z, i) => (
          <button key={z.label} onClick={() => onChange({ width: z.w, height: z.h })}
            className={`h-8 text-[11px] mono border transition-colors ${i === sizeIdx ? 'bg-white text-black border-white' : 'border-border text-muted-foreground hover:text-white'}`}>
            {z.label}
          </button>
        ))}
      </div>

      <div className="bar">{t('duration')} · {seconds.toFixed(1)}s{shot.frames != null ? ` · ${shot.frames}f` : ''}</div>
      <div className="px-3 pb-2">
        <Slider value={[seconds]} onValueChange={([v]) => onChange({ seconds: v, frames: null })} min={1} max={15} step={0.5} />
      </div>

      <div className="bar">{t('preset')}</div>
      <div className="grid grid-cols-2 gap-1 p-2">
        {PRESETS.map((p, i) => (
          <button key={p.key} onClick={() => onChange({ steps: p.steps, layers: p.layers, reuse: p.reuse, turbo: p.turbo ?? false })}
            className={`h-8 text-[11px] border transition-colors ${i === pIdx ? 'bg-white text-black border-white' : 'border-border text-muted-foreground hover:text-white'}`}>
            {t(p.key)}
          </button>
        ))}
      </div>
      <div className="bar !h-5 mono normal-case tracking-normal">
        steps {shot.steps} · layers {shot.layers} · reuse {shot.reuse}
      </div>

      <div className="flex items-center justify-between px-2 py-1">
        <div className="bar">{t('ckptAfter')}</div>
        <input type="number" value={ckptSteps} min={0} max={shot.steps - 1} aria-label={t('ckptAfter')}
          onChange={(e) => onChange({ checkpoint_after_step: Math.max(0, parseInt(e.target.value) || 0) || null })}
          className="w-16 h-7 bg-black/30 border border-border px-2 text-[12px] mono outline-none" />
      </div>

      <div className="flex items-center justify-between px-2 py-1">
        <div className="bar">SEED</div>
        <div className="flex items-center gap-1">
          <input type="number" value={shot.seed}
            onChange={(e) => onChange({ seed: parseInt(e.target.value) || 0 })}
            className="w-24 h-7 bg-black/30 border border-border px-2 text-[12px] mono outline-none" />
          <Button variant="outline" size="sm" className="rounded-none h-7 text-[11px]"
            onClick={() => onChange({ seed: Math.floor(Math.random() * 1e9) })}>
            {t('random')}
          </Button>
        </div>
      </div>

      <label className="flex items-center gap-2 px-2 py-2 text-[11px]">
        <input type="checkbox" checked={shot.token_reduction ?? false}
          onChange={(e) => onChange({ token_reduction: e.target.checked })} />
        {t('tokenReduction')}
      </label>

      <div className="bar-invert mt-1">{t('conditioning')}</div>
      {conditioning.autoChain && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">{t('chainAutoHint')}</p>
      )}
      {conditioning.errors.map((key) => (
        <p key={key} role="alert" className="px-2 py-1 text-[11px] text-red-400">{t(key)}</p>
      ))}
      {conditioning.warnings.map((key) => (
        <p key={key} role="status" className="px-2 py-1 text-[11px] text-amber-300">{t(key)}</p>
      ))}
      {uploading && <p role="status" className="px-2 py-1 text-[11px] text-muted-foreground">{t('uploading')}</p>}
      {uploadStates[shot.id] === 'failed' && (
        <p role="alert" className="px-2 py-1 text-[11px] text-red-400">{t('uploadFailed')}</p>
      )}
      {referencePanel}
      <UploadSlot title={t('firstFrame')} files={firstFrame} removeLabel={t('remove')} disabled={uploading}
        onAdd={upload((name) => ({ first_frame: name }))} onRemove={() => onChange({ first_frame: null })} />
      <UploadSlot title={t('lastFrame')} files={lastFrame} removeLabel={t('remove')} disabled={uploading}
        onAdd={upload((name) => ({ last_frame: name }))} onRemove={() => onChange({ last_frame: null })} />
      <UploadSlot title={t('refImages')} files={refImages} multiple removeLabel={t('remove')} disabled={uploading}
        onAdd={upload((name) => ({ ref_images: [...refImages, name] }))}
        onRemove={(n) => onChange({ ref_images: refImages.filter((x) => x !== n) })} />
      <AudioSlot title={t('refAudio')} files={refAudio} removeLabel={t('remove')} disabled={uploading}
        onAdd={upload((name) => ({ ref_audio: [...refAudio, name] }))}
        onRemove={(n) => onChange({ ref_audio: refAudio.filter((x) => x !== n) })} />

      <div className="p-2 mt-auto">
        <Button onClick={onGenerate} disabled={generating || busy || uploading || conditioning.errors.length > 0 || !shot.prompt.trim()}
          className="w-full h-10 rounded-none bg-white text-black hover:bg-white/85 text-[12px] font-semibold uppercase tracking-[0.2em]">
          {busy ? t('running') : shot.output ? t('regenerateShot') : t('generateShot')}
        </Button>
      </div>
    </div>
  )
}
