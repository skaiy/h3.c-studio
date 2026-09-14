import { useRef } from 'react'
import { api, type Shot } from '@/lib/api'
import { type I18nKey } from '@/lib/i18n'
import { useI18n } from '@/lib/useI18n'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'

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
  const pIdx = presetIndexOf(shot)
  const sizeIdx = (() => { const i = SIZES.findIndex((z) => z.w === shot.width && z.h === shot.height); return i >= 0 ? i : 1 })()
  const firstFrame = shot.first_frame ? [shot.first_frame] : []
  const lastFrame = shot.last_frame ? [shot.last_frame] : []
  const refImages: string[] = (shot as unknown as { ref_images?: string[] }).ref_images ?? []
  const ckptSteps = (shot as unknown as { checkpoint_after_step?: number }).checkpoint_after_step ?? 0

  const up = (key: 'first_frame' | 'last_frame') => async (f: File) => {
    const r = await api.upload(f)
    onChange({ [key]: r.name } as Partial<Shot>)
  }
  const upRef = async (f: File) => {
    const r = await api.upload(f)
    onChange({ ref_images: [...refImages, r.name] } as Partial<Shot>)
  }

  const busy = shot.status === 'running' || shot.status === 'queued'

  return (
    <div className="w-[340px] shrink-0 border-l border-border overflow-y-auto flex flex-col">
      <div className="bar-invert">{t('prompt')}</div>
      <div className="p-2">
        <Textarea value={shot.prompt} onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder="Scene / Action / Camera / Look / Audio…"
          className="min-h-[160px] bg-black/30 border-border rounded-none text-[13px] leading-relaxed mono" />
      </div>

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

      <div className="p-2 mt-auto">
        <Button onClick={onGenerate} disabled={generating || busy || !shot.prompt.trim()}
          className="w-full h-10 rounded-none bg-white text-black hover:bg-white/85 text-[12px] font-semibold uppercase tracking-[0.2em]">
          {busy ? t('running') : shot.output ? t('regenerateShot') : t('generateShot')}
        </Button>
      </div>
    </div>
  )
}
