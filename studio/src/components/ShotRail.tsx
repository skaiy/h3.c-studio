import { useState } from 'react'
import { type Board, type Shot } from '@/lib/api'
import { selectedOutput, selectedOutputMissing } from '@/lib/takes'
import { useI18n } from '@/lib/useI18n'

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
  disabled?: boolean
  selected: number
  onSelect: (i: number) => void
  onAddShot: () => void
  onInsertShot: (at: number) => void
  onDuplicateShot: (i: number) => void
  onDeleteShot: (i: number) => void
  onReorder: (from: number, to: number) => void
  onRunAll: () => void
  onConcat: () => void
  sequencing: boolean
  onToggleSequence: () => void
}

export default function ShotRail({ board, disabled = false, selected, onSelect, onAddShot, onInsertShot, onDuplicateShot, onDeleteShot, onReorder, onRunAll, onConcat, sequencing, onToggleSequence }: Props) {
  const { t } = useI18n()
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const doneCount = board.shots.filter((s) => selectedOutput(s) && !selectedOutputMissing(s)).length
  const hasMissingOutput = board.shots.some(selectedOutputMissing)

  return (
    <div className="w-[104px] shrink-0 border-r border-border flex flex-col min-h-0">
      <div className="bar">{t('shot')} {board.shots.length}</div>
      <div className="flex-1 overflow-y-auto p-1 flex flex-col">
        {board.shots.map((s, i) => (
          <div key={s.id}>
            <InsertLine testId={`insert-${i}`} active={dropAt === i} onClick={() => { if (!disabled) onInsertShot(i) }}
              onDragOver={(e) => { e.preventDefault(); setDropAt(i) }} />
            <ShotCard
              shot={s}
              disabled={disabled}
              index={i}
              active={i === selected}
              dragging={dragIdx === i}
              onClick={() => onSelect(i)}
              onDragStart={() => setDragIdx(i)}
              onDragEnd={() => { setDragIdx(null); setDropAt(null) }}
              onDragOverCard={(e) => { e.preventDefault(); setDropAt(i) }}
              onDrop={() => {
                if (!disabled && dragIdx !== null && dragIdx !== i) onReorder(dragIdx, i)
                setDragIdx(null); setDropAt(null)
              }}
              onDuplicate={() => onDuplicateShot(i)}
              onDelete={() => onDeleteShot(i)}
              deleteLabel={t('delete')}
              confirmLabel={t('confirmDelete')}
              duplicateTitle="⧉"
            />
          </div>
        ))}
        <InsertLine testId={`insert-${board.shots.length}`} active={dropAt === board.shots.length} onClick={() => { if (!disabled) onInsertShot(board.shots.length) }}
          onDragOver={(e) => { e.preventDefault(); setDropAt(board.shots.length) }} />
        <button
          disabled={disabled}
          onClick={onAddShot}
          className="h-12 shrink-0 border border-dashed border-muted-foreground/50 text-muted-foreground hover:text-white hover:border-white text-[11px] transition-colors"
        >
          {t('addShot2')}
        </button>
      </div>
      <div className="shrink-0 border-t border-border flex flex-col">
        <button onClick={onRunAll} disabled={disabled || board.status === 'running'}
          className="h-8 text-[11px] uppercase tracking-[0.12em] hover:bg-white hover:text-black transition-colors disabled:opacity-40">
          ▶ {t('runAll')}
        </button>
        <button onClick={onToggleSequence} disabled={!sequencing && (doneCount < 1 || hasMissingOutput)}
          title={sequencing ? t('stopSequence') : hasMissingOutput ? t('takeSequenceMissing') : t('sequencePreview')}
          className="h-8 text-[11px] uppercase tracking-[0.12em] border-t border-border hover:bg-white hover:text-black transition-colors disabled:opacity-40">
          {sequencing ? `■ ${t('stopSequence')}` : `▶ ${t('sequencePreview')}`}
        </button>
        <button onClick={onConcat} disabled={disabled || doneCount < 2 || hasMissingOutput || board.status === 'running'}
          title={hasMissingOutput ? t('takeSequenceMissing') : t('concat')}
          className="h-8 text-[11px] uppercase tracking-[0.12em] border-t border-border hover:bg-white hover:text-black transition-colors disabled:opacity-40">
          ⇢ {t('concat')} {doneCount}/{board.shots.length}
        </button>
      </div>
    </div>
  )
}

function InsertLine({ active, onClick, onDragOver, testId }: { active: boolean; onClick: () => void; onDragOver: (e: React.DragEvent) => void; testId: string }) {
  return (
    <div data-testid={testId} onClick={onClick} onDragOver={onDragOver}
      className={`group/ins h-2 flex items-center justify-center cursor-pointer transition-colors ${active ? 'bg-white/30' : 'hover:bg-white/10'}`}>
      <span className="text-[9px] text-transparent group-hover/ins:text-white leading-none">+</span>
    </div>
  )
}

interface CardProps {
  shot: Shot
  disabled: boolean
  index: number
  active: boolean
  dragging: boolean
  onClick: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOverCard: (e: React.DragEvent) => void
  onDrop: () => void
  onDuplicate: () => void
  onDelete: () => void
  deleteLabel: string
  confirmLabel: string
  duplicateTitle: string
}

function ShotCard({ shot, disabled, index, active, dragging, onClick, onDragStart, onDragEnd, onDragOverCard, onDrop, onDuplicate, onDelete, deleteLabel, confirmLabel, duplicateTitle }: CardProps) {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  const output = selectedOutput(shot)
  const missing = selectedOutputMissing(shot)
  const takeCount = shot.takes?.length ?? (output ? 1 : 0)
  const stale = shot.continuity_state === 'stale' || shot.stale
  return (
    <div
      data-testid={`shot-card-${index}`}
      draggable={!disabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOverCard}
      onDrop={(e) => { e.preventDefault(); onDrop() }}
      className={`group relative w-full text-left border transition-colors cursor-pointer ${active ? 'border-white' : 'border-border hover:border-muted-foreground'} ${dragging ? 'opacity-40' : ''}`}
      onClick={onClick}
    >
      {output && !missing ? (
        <video src={`/outputs/${encodeURIComponent(output)}`} preload="metadata" muted className="w-full h-14 object-cover pointer-events-none" />
      ) : (
        <div className="w-full h-14 flex items-center justify-center text-muted-foreground/40 mono text-lg">
          {index + 1}
        </div>
      )}
      <div className="absolute top-0.5 left-0.5 flex items-center gap-1">
        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[shot.status] ?? STATUS_DOT.idle}`} />
        <span className="mono text-[9px] text-white/80 [text-shadow:0_0_2px_black]">{index + 1}</span>
      </div>
      <div className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[8px] text-white/40 opacity-0 group-hover:opacity-100 select-none">⋮⋮</div>
      <div className="absolute top-0.5 right-0.5 hidden group-hover:flex gap-0.5">
        <button data-testid="shot-duplicate" title={duplicateTitle} disabled={disabled}
          onClick={(e) => { e.stopPropagation(); onDuplicate() }}
          className="w-5 h-5 text-[10px] bg-black/70 text-white border border-border hover:border-white">⧉</button>
        <button
          data-testid="shot-delete"
          disabled={disabled}
          title={deleteLabel}
          onClick={(e) => {
            e.stopPropagation()
            if (!confirming) {
              setConfirming(true)
              setTimeout(() => setConfirming(false), 3000)
            } else onDelete()
          }}
          className={`h-5 text-[9px] ${confirming ? 'bg-black text-white border border-white px-0.5' : 'w-5 bg-black/70 text-white border border-border hover:border-white'}`}>
          {confirming ? confirmLabel : '✕'}
        </button>
      </div>
      <div className="px-1 py-0.5 flex flex-col gap-0.5 text-[9px] leading-tight">
        <span className="text-muted-foreground" title={`${t('takeHistory')}: ${takeCount}`}>
          {t('takeLabel')} · {takeCount}
        </span>
        {stale ? (
          <span className="text-amber-400" title={t('takeStaleHint')}>{t('takeStale')}</span>
        ) : shot.continuity_state === 'unknown' ? (
          <span className="text-amber-400" title={t('takeUnknownSource')}>{t('takeUnknownSource')}</span>
        ) : null}
        {missing && (
          <span className="text-amber-400" title={t('takeMissingHint')}>{t('takeMissing')}</span>
        )}
      </div>
    </div>
  )
}
