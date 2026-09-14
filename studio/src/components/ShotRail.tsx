import { type Board, type Shot } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

const STATUS_DOT: Record<string, string> = {
  idle: 'bg-muted-foreground/40',
  queued: 'bg-white/50',
  running: 'bg-white animate-pulse',
  done: 'bg-white',
  error: 'bg-transparent border border-white',
  skipped: 'bg-muted-foreground/20',
  cancelled: 'bg-muted-foreground/20',
}

interface Props {
  board: Board
  selected: number
  onSelect: (i: number) => void
  onAddShot: () => void
  onRunAll: () => void
  onConcat: () => void
}

export default function ShotRail({ board, selected, onSelect, onAddShot, onRunAll, onConcat }: Props) {
  const { t } = useI18n()
  const doneCount = board.shots.filter((s) => s.status === 'done').length
  return (
    <div className="w-[104px] shrink-0 border-r border-border flex flex-col min-h-0">
      <div className="bar">{t('shot')} {board.shots.length}</div>
      <div className="flex-1 overflow-y-auto p-1 flex flex-col gap-1">
        {board.shots.map((s, i) => (
          <ShotCard key={s.id} shot={s} index={i} active={i === selected} onClick={() => onSelect(i)} />
        ))}
        <button
          onClick={onAddShot}
          className="h-12 border border-dashed border-muted-foreground/50 text-muted-foreground hover:text-white hover:border-white text-[11px] transition-colors"
        >
          {t('addShot2')}
        </button>
      </div>
      <div className="shrink-0 border-t border-border flex flex-col">
        <button onClick={onRunAll} disabled={board.status === 'running'}
          className="h-8 text-[11px] uppercase tracking-[0.12em] hover:bg-white hover:text-black transition-colors disabled:opacity-40">
          ▶ {t('runAll')}
        </button>
        <button onClick={onConcat} disabled={doneCount < 2 || board.status === 'running'}
          className="h-8 text-[11px] uppercase tracking-[0.12em] border-t border-border hover:bg-white hover:text-black transition-colors disabled:opacity-40">
          ⇢ {t('concat')} {doneCount}/{board.shots.length}
        </button>
      </div>
    </div>
  )
}

function ShotCard({ shot, index, active, onClick }: { shot: Shot; index: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative w-full text-left border transition-colors ${active ? 'border-white' : 'border-border hover:border-muted-foreground'}`}
    >
      {shot.output ? (
        <video src={`/outputs/${shot.output}`} preload="metadata" muted className="w-full h-14 object-cover pointer-events-none" />
      ) : (
        <div className="w-full h-14 flex items-center justify-center text-muted-foreground/40 mono text-lg">
          {index + 1}
        </div>
      )}
      <div className="absolute top-0.5 left-0.5 flex items-center gap-1">
        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[shot.status] ?? STATUS_DOT.idle}`} />
        <span className="mono text-[9px] text-white/80 [text-shadow:0_0_2px_black]">{index + 1}</span>
      </div>
    </button>
  )
}
