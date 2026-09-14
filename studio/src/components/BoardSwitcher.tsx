import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, type BoardSummary } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

function relTime(ts: number) {
  const d = Date.now() / 1000 - ts
  if (d < 60) return '<1m'
  if (d < 3600) return `${Math.floor(d / 60)}m`
  if (d < 86400) return `${Math.floor(d / 3600)}h`
  return `${Math.floor(d / 86400)}d`
}

interface Props {
  boards: BoardSummary[]
  currentId: string | null
  onRefresh: () => void
}

export default function BoardSwitcher({ boards, currentId, onRefresh }: Props) {
  const { t } = useI18n()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = boards.find((b) => b.id === currentId)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const createBoard = async () => {
    const b = await api.saveBoard({
      id: '', name: '未命名分镜', chain: true, shots: [], status: 'idle',
      result: null, createdAt: 0, modifiedAt: 0,
    })
    setOpen(false)
    onRefresh()
    nav(`/b/${b.id}`)
  }

  return (
    <div ref={ref} className="relative flex items-stretch">
      <button
        onClick={() => setOpen(!open)}
        className="bar !text-white hover:bg-card/60 max-w-[220px] truncate"
      >
        {current ? current.name : '…'} ▾
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 w-72 bg-popover border border-border shadow-lg">
          {boards.map((b) => (
            <button
              key={b.id}
              onClick={() => { setOpen(false); nav(`/b/${b.id}`) }}
              className={`w-full text-left px-2 py-1.5 hover:bg-card/60 border-b border-border/50 ${b.id === currentId ? 'bg-card/40' : ''}`}
            >
              <div className="flex items-center gap-2">
                {b.status === 'running' && <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />}
                <span className="text-[12px] truncate">{b.name}</span>
              </div>
              <div className="mono text-[10px] text-muted-foreground">
                {b.shotCount} 镜头 · {b.duration}s · {relTime(b.modifiedAt)}
              </div>
            </button>
          ))}
          <button
            onClick={createBoard}
            className="w-full text-left px-2 py-1.5 text-[12px] text-muted-foreground hover:text-white hover:bg-card/60"
          >
            {t('newBoard')}
          </button>
        </div>
      )}
    </div>
  )
}
