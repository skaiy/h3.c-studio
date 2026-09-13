import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'

export interface Shot {
  id: string
  prompt: string
  width: number
  height: number
  seconds: number
  steps: number
  layers: number
  reuse: number
  seed: number
  first_frame: string | null
  last_frame: string | null
  status: string
  output: string | null
  job_id: string | null
}

export interface Board {
  id: string
  name: string
  chain: boolean
  shots: Shot[]
  status: string
  result: string | null
}

const SIZES = [
  { label: '512²', w: 512, h: 512 },
  { label: '768²', w: 768, h: 768 },
  { label: '1344×768', w: 1344, h: 768 },
  { label: '768×1344', w: 768, h: 1344 },
]

const STATUS_COLOR: Record<string, string> = {
  idle: 'text-muted-foreground',
  queued: 'text-muted-foreground',
  running: 'text-white animate-pulse',
  done: 'text-white',
  error: 'text-white bg-black border border-white',
  skipped: 'text-muted-foreground/50',
  cancelled: 'text-muted-foreground/50',
}

function newShot(idx: number): Shot {
  return {
    id: `s${Date.now()}${idx}`,
    prompt: '',
    width: 768,
    height: 768,
    seconds: 10,
    steps: 20,
    layers: 45,
    reuse: 2,
    seed: 42,
    first_frame: null,
    last_frame: null,
    status: 'idle',
    output: null,
    job_id: null,
  }
}

export default function BoardPage() {
  const { t, toggle } = useI18n()
  const [board, setBoard] = useState<Board>({
    id: '', name: '', chain: true, shots: [newShot(0)], status: 'idle', result: null,
  })
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    const boards: Board[] = await fetch('/api/boards').then((r) => r.json())
    if (boards.length && !dirty) setBoard(boards[0])
  }, [dirty])

  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [load])

  const update = (fn: (b: Board) => Board) => {
    setBoard((b) => fn({ ...b, shots: b.shots.map((s) => ({ ...s })) }))
    setDirty(true)
  }

  const save = async (b: Board) => {
    const saved = await fetch('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }).then((r) => r.json())
    setBoard(saved)
    setDirty(false)
    return saved
  }

  const runBoard = async () => {
    const saved = await save(board)
    await fetch(`/api/boards/${saved.id}/run`, { method: 'POST' })
    setBoard((b) => ({ ...b, status: 'running' }))
  }

  const concat = async () => {
    const saved = await save(board)
    const r = await fetch(`/api/boards/${saved.id}/concat`, { method: 'POST' }).then((x) => x.json())
    if (r.output) setBoard((b) => ({ ...b, result: r.output }))
  }

  const doneCount = board.shots.filter((s) => s.status === 'done').length
  const runningShot = board.shots.find((s) => s.status === 'running' || s.status === 'queued')

  return (
    <div className="h-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* header */}
      <div className="flex items-stretch border-b border-border shrink-0">
        <div className="bar-invert">{t('title')}</div>
        <Link to="/" className="bar linkfade">{t('studio')}</Link>
        <div className="bar !text-white border-b border-white -mb-px">{t('board')}</div>
        <div className="flex-1" />
        <button onClick={toggle} className="bar linkfade border-l border-border !text-white">
          {t('langToggle')}
        </button>
      </div>

      {/* board toolbar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <span className="bar">{t('boardName')}</span>
        <input
          value={board.name}
          onChange={(e) => update((b) => ({ ...b, name: e.target.value }))}
          className="h-7 w-56 bg-black/30 border border-border px-2 text-[12px] outline-none"
          placeholder={t('boardName')}
        />
        <div className="flex items-center gap-1 px-2">
          <span className="bar">{t('chainAuto')}</span>
          <Switch checked={board.chain} onCheckedChange={(v) => update((b) => ({ ...b, chain: v }))} />
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" className="rounded-none h-7 text-[11px]"
          onClick={() => save(board)}>{t('saveBoard')}</Button>
        <Button variant="outline" size="sm" className="rounded-none h-7 text-[11px]"
          disabled={board.status === 'running'} onClick={runBoard}>
          {board.status === 'running' ? t('running') : t('runBoard')}
        </Button>
        <Button size="sm" className="rounded-none h-7 text-[11px] bg-white text-black hover:bg-white/85"
          disabled={doneCount < 2 || board.status === 'running'} onClick={concat}>
          {t('concat')} ({doneCount}/{board.shots.length})
        </Button>
      </div>

      {/* result player */}
      {board.result && (
        <div className="border-b border-border shrink-0">
          <div className="bar-invert">{t('boardResult')}</div>
          <div className="flex justify-center bg-black/40 p-2">
            <video key={board.result} src={`/outputs/${board.result}`} controls autoPlay
              className="max-h-[38vh]" />
          </div>
        </div>
      )}

      {/* shot cards */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {board.shots.map((s, i) => (
          <div key={s.id} className={`panel flex gap-2 ${runningShot?.id === s.id ? 'border-white' : ''}`}>
            <div className="w-14 shrink-0 flex flex-col items-center justify-center border-r border-border">
              <span className="mono text-[10px] text-muted-foreground">{t('shot')}</span>
              <span className="mono text-xl">{i + 1}</span>
              <span className={`mono text-[9px] uppercase ${STATUS_COLOR[s.status] ?? ''}`}>
                {t(s.status as never) || s.status}
              </span>
            </div>
            <div className="flex-1 min-w-0 py-1">
              <Textarea
                value={s.prompt}
                onChange={(e) =>
                  update((b) => ({ ...b, shots: b.shots.map((x, xi) => (xi === i ? { ...x, prompt: e.target.value } : x)) }))
                }
                placeholder="Scene / Action / Camera / Look / Audio…"
                className="min-h-[80px] bg-black/30 border-border rounded-none text-[12px] mono"
              />
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <select
                  value={`${s.width}x${s.height}`}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split('x').map(Number)
                    update((b) => ({ ...b, shots: b.shots.map((x, xi) => (xi === i ? { ...x, width: w, height: h } : x)) }))
                  }}
                  className="h-6 bg-black/30 border border-border text-[11px] mono px-1"
                >
                  {SIZES.map((z) => <option key={z.label} value={`${z.w}x${z.h}`}>{z.label}</option>)}
                </select>
                <label className="bar !h-6">秒
                  <input type="number" value={s.seconds} min={1} max={15} step={0.5}
                    onChange={(e) => update((b) => ({ ...b, shots: b.shots.map((x, xi) => (xi === i ? { ...x, seconds: parseFloat(e.target.value) || 6 } : x)) }))}
                    className="w-14 h-6 bg-black/30 border border-border px-1 text-[11px] mono ml-1 outline-none" />
                </label>
                <label className="bar !h-6">seed
                  <input type="number" value={s.seed}
                    onChange={(e) => update((b) => ({ ...b, shots: b.shots.map((x, xi) => (xi === i ? { ...x, seed: parseInt(e.target.value) || 0 } : x)) }))}
                    className="w-20 h-6 bg-black/30 border border-border px-1 text-[11px] mono ml-1 outline-none" />
                </label>
                {board.chain && i > 0 && (
                  <span className="bar !h-6 text-muted-foreground/70">⇢ 首帧自动继承上镜末帧</span>
                )}
                {s.first_frame && (
                  <img src={`/uploads/${s.first_frame}`} className="h-6 border border-border" title="first frame" />
                )}
              </div>
            </div>
            <div className="w-40 shrink-0 flex flex-col border-l border-border">
              {s.output ? (
                <video src={`/outputs/${s.output}`} controls preload="metadata"
                  className="w-full h-[72px] object-cover bg-black" />
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground/40 text-[10px] uppercase tracking-wider">
                  {t(s.status as never) || s.status}
                </div>
              )}
              <button
                className="h-6 text-[10px] text-muted-foreground hover:text-white border-t border-border"
                onClick={() => update((b) => ({ ...b, shots: b.shots.filter((x) => x.id !== s.id) }))}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <button
          onClick={() => update((b) => ({ ...b, shots: [...b.shots, newShot(b.shots.length)] }))}
          className="h-10 border border-dashed border-muted-foreground/50 text-muted-foreground hover:text-white hover:border-white text-[12px] uppercase tracking-[0.15em] transition-colors"
        >
          {t('addShot')}
        </button>
      </div>
    </div>
  )
}
