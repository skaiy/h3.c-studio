import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api, type BoardSummary } from '@/lib/api'
import { useI18n } from '@/lib/useI18n'

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
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
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

  const commitRename = async (b: BoardSummary) => {
    const name = renameVal.trim()
    setRenaming(null)
    if (!name || name === b.name) return
    const full = await api.board(b.id)
    await api.saveBoard({ ...full, name })
    onRefresh()
  }

  const duplicate = async (b: BoardSummary) => {
    const copy = await api.duplicateBoard(b.id)
    setOpen(false)
    onRefresh()
    nav(`/b/${copy.id}`)
  }

  const remove = async (b: BoardSummary) => {
    if (confirmDel !== b.id) {
      setConfirmDel(b.id)
      setTimeout(() => setConfirmDel((c) => (c === b.id ? null : c)), 3000)
      return
    }
    setConfirmDel(null)
    await api.deleteBoard(b.id)
    onRefresh()
    if (b.id === currentId) {
      const rest = (await api.boards().catch(() => [] as BoardSummary[])).filter((x) => x.id !== b.id)
      if (rest.length) nav(`/b/${rest[0].id}`)
      else createBoard()
      setOpen(false)
    }
  }

  return (
    <div ref={ref} className="relative flex items-stretch">
      <button onClick={() => setOpen(!open)} className="bar !text-white hover:bg-card/60 max-w-[220px] truncate">
        {current ? current.name : '…'} ▾
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 w-80 bg-popover border border-border shadow-lg">
          {boards.map((b) => (
            <div key={b.id} className={`group flex items-center border-b border-border/50 ${b.id === currentId ? 'bg-card/40' : ''}`}>
              {renaming === b.id ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e) => setRenameVal(e.target.value)}
                  onBlur={() => commitRename(b)}
                  onKeyDown={(e) => e.key === 'Enter' && commitRename(b)}
                  className="flex-1 m-1 h-7 bg-black/40 border border-white px-1 text-[12px] outline-none"
                />
              ) : (
                <button onClick={() => { setOpen(false); nav(`/b/${b.id}`) }} className="flex-1 text-left px-2 py-1.5 hover:bg-card/60">
                  <div className="flex items-center gap-2">
                    {b.status === 'running' && <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />}
                    <span className="text-[12px] truncate">{b.name}</span>
                  </div>
                  <div className="mono text-[10px] text-muted-foreground">
                    {b.shotCount} 镜头 · {b.duration}s · {relTime(b.modifiedAt)}
                  </div>
                </button>
              )}
              <div className="hidden group-hover:flex items-center pr-1 gap-1">
                <button title={t('renameBoard')}
                  onClick={() => { setRenaming(b.id); setRenameVal(b.name) }}
                  className="w-6 h-6 text-[11px] text-muted-foreground hover:text-white border border-border hover:border-white">✎</button>
                <button title={t('duplicateBoard')}
                  onClick={() => duplicate(b)}
                  className="w-6 h-6 text-[11px] text-muted-foreground hover:text-white border border-border hover:border-white">⧉</button>
                <button title={t('delete')}
                  onClick={() => remove(b)}
                  className={`h-6 text-[10px] border ${confirmDel === b.id ? 'text-white bg-black border-white px-1' : 'w-6 text-muted-foreground hover:text-white border-border hover:border-white'}`}>
                  {confirmDel === b.id ? t('confirmDelete') : '✕'}
                </button>
              </div>
            </div>
          ))}
          <button onClick={createBoard}
            className="w-full text-left px-2 py-1.5 text-[12px] text-muted-foreground hover:text-white hover:bg-card/60">
            {t('newBoard')}
          </button>
        </div>
      )}
    </div>
  )
}
