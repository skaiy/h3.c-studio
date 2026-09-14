import { useRef, useState } from 'react'
import { api, type Shot } from '@/lib/api'
import { type I18nKey } from '@/lib/i18n'
import { useI18n } from '@/lib/useI18n'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'

// Structured "Context-IR" prompt editor (Scene / Action / Camera / Look / Audio),
// inspired by Henninges/h3-studio's advanced mode: each field falls back to a
// sensible default when left blank, so users don't have to write out every
// clause by hand to get a well-formed five-part prompt.
const FIELD_KEYS = ['scene', 'action', 'camera', 'look', 'audio'] as const
type FieldKey = (typeof FIELD_KEYS)[number]
const FIELD_LABELS: Record<FieldKey, string> = {
  scene: 'Scene', action: 'Action', camera: 'Camera', look: 'Look', audio: 'Audio',
}
const FIELD_DEFAULTS: Record<FieldKey, string> = {
  scene: 'a softly lit interior room',
  action: 'the subject moves naturally',
  camera: 'static medium shot',
  look: 'realistic, cinematic lighting',
  audio: 'ambient sound matching the scene',
}
function emptyFields(): Record<FieldKey, string> {
  return { scene: '', action: '', camera: '', look: '', audio: '' }
}
function assembleStructuredPrompt(fields: Record<FieldKey, string>): string {
  const val = (k: FieldKey) => fields[k].trim() || FIELD_DEFAULTS[k]
  return FIELD_KEYS.map((k) => `${FIELD_LABELS[k]}: ${val(k)}.`).join(' ')
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
}

function UploadSlot({ title, files, removeLabel, onAdd, onRemove, multiple }: SlotProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <div className="bar">{title}</div>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        {files.map((f) => (
          <div key={f} className="relative group w-14 h-14 border border-border overflow-hidden">
            <img src={`/api/media/${f}`} className="w-full h-full object-cover" />
            <button onClick={() => onRemove(f)}
              className="absolute inset-0 bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity">
              {removeLabel}
            </button>
          </div>
        ))}
        {(multiple || files.length === 0) && (
          <button onClick={() => inputRef.current?.click()}
            className="w-14 h-14 border border-dashed border-muted-foreground/50 text-muted-foreground text-lg hover:text-white hover:border-white transition-colors">
            +
          </button>
        )}
        <input ref={inputRef} type="file" accept="image/*" className="hidden"
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
}

/** Ordered standalone Ref2VA audio clips (--ref-audio) — e.g. lip-sync / music-video
 * conditioning. Uses inline <audio controls> instead of the square thumbnails
 * UploadSlot uses for images, since a filename + playhead is more useful than a tile. */
function AudioSlot({ title, files, removeLabel, onAdd, onRemove }: AudioSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <div className="bar">{title}</div>
      <div className="flex flex-col gap-1 px-2 pb-2">
        {files.map((f) => (
          <div key={f} className="flex items-center gap-1.5 border border-border px-1.5 py-1">
            <audio controls src={`/api/media/${f}`} className="h-7 flex-1 min-w-0" />
            <button onClick={() => onRemove(f)}
              className="shrink-0 text-[10px] text-muted-foreground hover:text-white px-1">
              {removeLabel}
            </button>
          </div>
        ))}
        <button onClick={() => inputRef.current?.click()}
          className="h-7 border border-dashed border-muted-foreground/50 text-muted-foreground text-[11px] hover:text-white hover:border-white transition-colors">
          +
        </button>
        <input ref={inputRef} type="file" accept="audio/*" className="hidden"
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
}

export default function ShotInspector({ shot, chain, isFirst, onChange, onGenerate, generating }: Props) {
  const { t } = useI18n()
  const [promptMode, setPromptMode] = useState<'simple' | 'structured'>('simple')
  const [fields, setFields] = useState<Record<FieldKey, string>>(emptyFields())
  // Structured fields are a per-shot input aid, not persisted state: reset them
  // whenever the selected shot changes so they never leak between shots. Done
  // during render (not in an effect) per React's "adjusting state" guidance.
  const [fieldsShotId, setFieldsShotId] = useState(shot.id)
  if (fieldsShotId !== shot.id) {
    setFieldsShotId(shot.id)
    setFields(emptyFields())
  }
  const pIdx = presetIndexOf(shot)
  const sizeIdx = (() => { const i = SIZES.findIndex((z) => z.w === shot.width && z.h === shot.height); return i >= 0 ? i : 1 })()
  const firstFrame = shot.first_frame ? [shot.first_frame] : []
  const lastFrame = shot.last_frame ? [shot.last_frame] : []
  const refImages: string[] = (shot as unknown as { ref_images?: string[] }).ref_images ?? []
  const refAudio: string[] = (shot as unknown as { ref_audio?: string[] }).ref_audio ?? []
  const ckptSteps = (shot as unknown as { checkpoint_after_step?: number }).checkpoint_after_step ?? 0

  const up = (key: 'first_frame' | 'last_frame') => async (f: File) => {
    const r = await api.upload(f)
    onChange({ [key]: r.name } as Partial<Shot>)
  }
  const upRef = async (f: File) => {
    const r = await api.upload(f)
    onChange({ ref_images: [...refImages, r.name] } as Partial<Shot>)
  }
  const upRefAudio = async (f: File) => {
    const r = await api.upload(f)
    onChange({ ref_audio: [...refAudio, r.name] } as Partial<Shot>)
  }

  const busy = shot.status === 'running' || shot.status === 'queued'

  return (
    <div className="w-[340px] shrink-0 border-l border-border overflow-y-auto flex flex-col">
      <div className="bar-invert justify-between">
        <span>{t('prompt')}</span>
        <div className="flex gap-1">
          {(['simple', 'structured'] as const).map((m) => (
            <button key={m} onClick={() => setPromptMode(m)}
              className={`text-[10px] px-1.5 py-0.5 border normal-case tracking-normal font-normal ${m === promptMode ? 'bg-black text-white border-black' : 'border-black/30 text-black/60 hover:text-black'}`}>
              {t(m === 'simple' ? 'promptModeSimple' : 'promptModeStructured')}
            </button>
          ))}
        </div>
      </div>
      {promptMode === 'simple' ? (
        <div className="p-2">
          <Textarea value={shot.prompt} onChange={(e) => onChange({ prompt: e.target.value })}
            placeholder="Scene / Action / Camera / Look / Audio…"
            className="min-h-[160px] bg-black/30 border-border rounded-none text-[13px] leading-relaxed mono" />
        </div>
      ) : (
        <div className="p-2 flex flex-col gap-1.5">
          {FIELD_KEYS.map((k) => (
            <div key={k}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">{FIELD_LABELS[k]}</div>
              <Textarea value={fields[k]}
                onChange={(e) => {
                  const next = { ...fields, [k]: e.target.value }
                  setFields(next)
                  onChange({ prompt: assembleStructuredPrompt(next) })
                }}
                placeholder={FIELD_DEFAULTS[k]}
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

      <div className="bar">{t('duration')} · {shot.seconds.toFixed(1)}s</div>
      <div className="px-3 pb-2">
        <Slider value={[shot.seconds]} onValueChange={([v]) => onChange({ seconds: v })} min={1} max={15} step={0.5} />
      </div>

      <div className="bar">{t('preset')}</div>
      <div className="grid grid-cols-2 gap-1 p-2">
        {PRESETS.map((p, i) => (
          <button key={p.key} onClick={() => onChange({ steps: p.steps, layers: p.layers, reuse: p.reuse, turbo: p.turbo ?? false } as Partial<Shot>)}
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
        <input type="number" value={ckptSteps} min={0} max={shot.steps}
          onChange={(e) => onChange({ checkpoint_after_step: Math.max(0, parseInt(e.target.value) || 0) } as Partial<Shot>)}
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

      <div className="bar-invert mt-1">{t('conditioning')}</div>
      {chain && !isFirst && !firstFrame.length && (
        <div className="bar !h-6 text-muted-foreground/70 normal-case tracking-normal">⇢ 首帧自动继承上镜末帧</div>
      )}
      <UploadSlot title={t('firstFrame')} files={firstFrame} removeLabel={t('remove')}
        onAdd={up('first_frame')} onRemove={() => onChange({ first_frame: null })} />
      <UploadSlot title={t('lastFrame')} files={lastFrame} removeLabel={t('remove')}
        onAdd={up('last_frame')} onRemove={() => onChange({ last_frame: null })} />
      <UploadSlot title={t('refImages')} files={refImages} multiple removeLabel={t('remove')}
        onAdd={upRef} onRemove={(n) => onChange({ ref_images: refImages.filter((x) => x !== n) } as Partial<Shot>)} />
      <AudioSlot title={t('refAudio')} files={refAudio} removeLabel={t('remove')}
        onAdd={upRefAudio} onRemove={(n) => onChange({ ref_audio: refAudio.filter((x) => x !== n) } as Partial<Shot>)} />

      <div className="p-2 mt-auto">
        <Button onClick={onGenerate} disabled={generating || busy || !shot.prompt.trim()}
          className="w-full h-10 rounded-none bg-white text-black hover:bg-white/85 text-[12px] font-semibold uppercase tracking-[0.2em]">
          {busy ? t('running') : shot.output ? t('regenerateShot') : t('generateShot')}
        </Button>
      </div>
    </div>
  )
}
