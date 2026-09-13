import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type GenParams, type Job, type VideoItem } from '@/lib/api'
import { useI18n, type I18nKey } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'

const SIZES = [
  { label: '512 × 512', w: 512, h: 512 },
  { label: '768 × 768', w: 768, h: 768 },
  { label: '1344 × 768', w: 1344, h: 768 },
  { label: '768 × 1344', w: 768, h: 1344 },
  { label: '1024 × 768', w: 1024, h: 768 },
  { label: '256 × 256 preview', w: 256, h: 256 },
]

const PRESETS: { key: I18nKey; steps: number; layers: number; reuse: number }[] = [
  { key: 'presetBalanced', steps: 20, layers: 45, reuse: 2 },
  { key: 'presetDraft', steps: 6, layers: 40, reuse: 3 },
  { key: 'presetHQ', steps: 20, layers: 50, reuse: 1 },
  { key: 'presetRef', steps: 50, layers: 50, reuse: 1 },
]

const DEFAULT_PROMPT = `Scene: a red fox walks through fresh snow in a pine forest at dawn.
Action: the fox walks steadily left to right and looks toward the camera once.
Camera: medium-height lateral tracking shot, 50mm lens, stable framing.
Look: photorealistic fur, cold blue ambient light, warm sunrise rim light.
Audio: soft footsteps in snow, light wind through pine branches, no music.`

function fmtDur(d: number | null | undefined) {
  if (!d) return ''
  return `${d.toFixed(1)}s`
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
          <div key={f} className="relative group w-16 h-16 border border-border overflow-hidden">
            <img src={`/uploads/${f}`} className="w-full h-full object-cover" />
            <button
              onClick={() => onRemove(f)}
              className="absolute inset-0 bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 transition-opacity"
            >
              {removeLabel}
            </button>
          </div>
        ))}
        {(multiple || files.length === 0) && (
          <button
            onClick={() => inputRef.current?.click()}
            className="w-16 h-16 border border-dashed border-muted-foreground/50 text-muted-foreground text-lg hover:text-white hover:border-white transition-colors"
          >
            +
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onAdd(f)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

export default function Home() {
  const { t, toggle } = useI18n()
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [sizeIdx, setSizeIdx] = useState(0)
  const [seconds, setSeconds] = useState(6)
  const [presetIdx, setPresetIdx] = useState(0)
  const [seed, setSeed] = useState(42)
  const [tokenReduction, setTokenReduction] = useState(false)
  const [firstFrame, setFirstFrame] = useState<string[]>([])
  const [lastFrame, setLastFrame] = useState<string[]>([])
  const [refImages, setRefImages] = useState<string[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [device, setDevice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [j, v] = await Promise.all([api.jobs(), api.videos()])
      const run = j.find((x) => x.status === 'running')
      if (run) {
        const detail = await api.job(run.id)
        setJobs(j.map((x) => (x.id === run.id ? detail : x)))
      } else {
        setJobs(j)
      }
      setVideos(v)
    } catch { /* backend not up yet */ }
  }, [])

  useEffect(() => {
    refresh()
    api.info()
      .then((r) => {
        const m = r.info.match(/Device: (.+)/)
        if (m) setDevice(m[1])
      })
      .catch(() => {})
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [jobs])

  const activeJob = jobs.find((j) => j.status === 'running') ?? jobs.find((j) => j.status === 'queued')
  const runningJob = activeJob?.status === 'running' ? activeJob : null

  useEffect(() => {
    if (!current && videos.length) setCurrent(videos[0].name)
  }, [videos, current])

  const doUpload = (setter: React.Dispatch<React.SetStateAction<string[]>>, multiple: boolean) =>
    async (f: File) => {
      const r = await api.upload(f)
      setter((prev) => (multiple ? [...prev, r.name] : [r.name]))
    }

  const generate = async () => {
    setSubmitting(true)
    const preset = PRESETS[presetIdx]
    const size = SIZES[sizeIdx]
    const params: GenParams = {
      prompt,
      width: size.w,
      height: size.h,
      seconds,
      frames: null,
      steps: preset.steps,
      layers: preset.layers,
      reuse: preset.reuse,
      seed,
      first_frame: firstFrame[0] ?? null,
      last_frame: lastFrame[0] ?? null,
      ref_images: refImages,
      token_reduction: tokenReduction,
      label: null,
    }
    try {
      await api.generate(params)
      await refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const chainFrom = async (v: VideoItem) => {
    const r = await api.extractLastFrame(v.name)
    setFirstFrame([r.name])
    setRefImages([])
    window.scrollTo({ top: 0 })
  }

  const pct = runningJob && runningJob.total ? Math.round((runningJob.done / runningJob.total) * 100) : 0

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* header */}
      <div className="flex items-stretch border-b border-border shrink-0">
        <div className="bar-invert">{t('title')}</div>
        <div className="bar">{t('subtitle')}</div>
        <div className="flex-1" />
        <div className="bar mono normal-case tracking-normal">{device || '…'}</div>
        <div className="bar">{jobs.filter((j) => j.status === 'queued' || j.status === 'running').length} {t('activeJobs')}</div>
        <button onClick={toggle} className="bar linkfade border-l border-border !text-white">
          {t('langToggle')}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* left control panel */}
        <div className="w-[340px] shrink-0 border-r border-border overflow-y-auto">
          <div className="bar-invert">{t('prompt')}</div>
          <div className="p-2">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[180px] bg-black/30 border-border rounded-none text-[13px] leading-relaxed mono"
            />
            <div className="bar !h-5 text-muted-foreground/70 normal-case tracking-normal">
              {t('promptHint')}
            </div>
          </div>

          <div className="bar">{t('canvas')}</div>
          <div className="grid grid-cols-2 gap-1 p-2">
            {SIZES.map((s, i) => (
              <button
                key={s.label}
                onClick={() => setSizeIdx(i)}
                className={`h-8 text-[11px] mono border transition-colors ${
                  i === sizeIdx ? 'bg-white text-black border-white' : 'border-border text-muted-foreground hover:text-white'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="bar">{t('duration')} · {seconds.toFixed(1)}s</div>
          <div className="px-3 pb-2">
            <Slider value={[seconds]} onValueChange={([v]) => setSeconds(v)} min={1} max={15} step={0.5} />
          </div>

          <div className="bar">{t('preset')}</div>
          <div className="grid grid-cols-2 gap-1 p-2">
            {PRESETS.map((p, i) => (
              <button
                key={p.key}
                onClick={() => setPresetIdx(i)}
                className={`h-8 text-[11px] border transition-colors ${
                  i === presetIdx ? 'bg-white text-black border-white' : 'border-border text-muted-foreground hover:text-white'
                }`}
              >
                {t(p.key)}
              </button>
            ))}
          </div>
          <div className="bar !h-5 mono normal-case tracking-normal">
            steps {PRESETS[presetIdx].steps} · layers {PRESETS[presetIdx].layers} · reuse {PRESETS[presetIdx].reuse}
          </div>

          <div className="flex items-center justify-between px-2 py-1">
            <div className="bar">SEED</div>
            <div className="flex items-center gap-1">
              <input
                type="number"
                value={seed}
                onChange={(e) => setSeed(parseInt(e.target.value) || 0)}
                className="w-24 h-7 bg-black/30 border border-border px-2 text-[12px] mono outline-none"
              />
              <Button
                variant="outline"
                size="sm"
                className="rounded-none h-7 text-[11px]"
                onClick={() => setSeed(Math.floor(Math.random() * 1e9))}
              >
                {t('random')}
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between px-2 py-1">
            <div className="bar">{t('tokenReduction')}</div>
            <Switch checked={tokenReduction} onCheckedChange={setTokenReduction} />
          </div>

          <div className="bar-invert mt-1">{t('conditioning')}</div>
          <UploadSlot title={t('firstFrame')} files={firstFrame} removeLabel={t('remove')}
            onAdd={doUpload(setFirstFrame, false)} onRemove={() => setFirstFrame([])} />
          <UploadSlot title={t('lastFrame')} files={lastFrame} removeLabel={t('remove')}
            onAdd={doUpload(setLastFrame, false)} onRemove={() => setLastFrame([])} />
          <UploadSlot title={t('refImages')} files={refImages} multiple removeLabel={t('remove')}
            onAdd={doUpload(setRefImages, true)}
            onRemove={(n) => setRefImages((p) => p.filter((x) => x !== n))} />

          <div className="p-2">
            <Button
              onClick={generate}
              disabled={submitting || !prompt.trim()}
              className="w-full h-10 rounded-none bg-white text-black hover:bg-white/85 text-[12px] font-semibold uppercase tracking-[0.2em]"
            >
              {t('generate')}
            </Button>
          </div>
        </div>

        {/* center preview */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="bar-invert">{t('preview')}</div>
          <div className="flex-1 min-h-0 flex items-center justify-center bg-black/40 p-4">
            {runningJob ? (
              <div className="w-full max-w-xl">
                <div className="flex justify-between items-baseline mb-2">
                  <span className="text-[12px] uppercase tracking-[0.15em]">{runningJob.phase ?? t('starting')}</span>
                  <span className="mono text-[12px] text-muted-foreground">
                    {runningJob.done}/{runningJob.total || '…'}
                  </span>
                </div>
                <Progress value={pct} className="h-1 rounded-none bg-card" />
                <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                  <span className="truncate max-w-[70%]">{runningJob.label}</span>
                  <button className="linkfade underline" onClick={() => api.cancel(runningJob.id)}>{t('cancel')}</button>
                </div>
                <div ref={logRef} className="mt-3 h-40 overflow-y-auto mono text-[10px] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap">
                  {(runningJob.log ?? []).slice(-40).join('\n')}
                </div>
              </div>
            ) : current ? (
              <video
                key={current}
                src={`/outputs/${current}`}
                controls
                autoPlay
                loop
                className="max-w-full max-h-full"
              />
            ) : (
              <div className="text-muted-foreground text-[12px] uppercase tracking-[0.2em]">
                {t('emptyPreview')}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* bottom filmstrip */}
      <div className="shrink-0 border-t border-border">
        <div className="flex items-stretch">
          <div className="bar-invert">{t('library')}</div>
          <div className="bar">{videos.length} {t('items')}</div>
        </div>
        <div className="flex gap-1 overflow-x-auto p-1">
          {videos.map((v) => (
            <div key={v.name} className="group relative shrink-0 w-36 border border-border">
              <button className="block w-full" onClick={() => setCurrent(v.name)}>
                <video src={`/outputs/${v.name}`} preload="metadata" muted
                  className="w-full h-20 object-cover pointer-events-none" />
              </button>
              <div className="flex justify-between px-1 h-5 items-center">
                <span className="mono text-[9px] text-muted-foreground truncate">{v.name.replace('.mp4', '')}</span>
                <span className="mono text-[9px] text-muted-foreground">{fmtDur(v.duration)}</span>
              </div>
              <div className="absolute inset-x-0 top-0 h-20 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                <button className="text-[10px] uppercase tracking-wider underline"
                  onClick={() => setCurrent(v.name)}>{t('play')}</button>
                <button className="text-[10px] uppercase tracking-wider underline"
                  onClick={() => chainFrom(v)}>{t('chain')}</button>
              </div>
            </div>
          ))}
          {videos.length === 0 && (
            <div className="bar text-muted-foreground/60">{t('emptyLibrary')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
