import { useEffect, useRef, useState } from 'react'
import { api, ApiError, type VideoItem } from '@/lib/api'
import { useI18n } from '@/lib/useI18n'

interface Props {
  videos: VideoItem[]
  current: string | null
  onPlay: (name: string) => void
  onChain: (v: VideoItem) => void
  onChanged: () => void
}

export default function LibraryStrip({ videos, current, onPlay, onChain, onChanged }: Props) {
  const { t } = useI18n()
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deleteInFlight = useRef(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    if (confirmDel === null) return
    const timer = setTimeout(() => setConfirmDel(null), 3000)
    return () => clearTimeout(timer)
  }, [confirmDel])

  const del = async (name: string) => {
    if (deleteInFlight.current) return
    if (confirmDel !== name) {
      setConfirmDel(name)
      return
    }
    deleteInFlight.current = true
    setDeleting(true)
    setConfirmDel(null)
    setDeleteError(null)
    try {
      await api.deleteVideo(name)
      onChanged()
    } catch (error) {
      setDeleteError(error instanceof ApiError ? error.message : '')
    } finally {
      deleteInFlight.current = false
      setDeleting(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-border">
      <div className="flex items-stretch">
        <div className="bar-invert">{t('library')}</div>
        <div className="bar">{videos.length} {t('items')}</div>
      </div>
      {deleteError !== null && (
        <p role="alert" className="px-2 py-1 text-[11px] text-red-400 break-words">
          {t('takeDeleteFailed')}{deleteError ? `: ${deleteError}` : ''}
        </p>
      )}
      <div className="flex gap-1 overflow-x-auto p-1">
        {videos.map((v) => (
          <div key={v.name}
            className={`group relative shrink-0 w-36 border transition-colors ${current === v.name ? 'border-white' : 'border-border'}`}>
            <button type="button" aria-label={`${t('play')} · ${v.name}`} className="block w-full" onClick={() => onPlay(v.name)}>
              <video src={`/outputs/${encodeURIComponent(v.name)}`} preload="metadata" muted className="w-full h-20 object-cover pointer-events-none" />
            </button>
            <div className="flex justify-between px-1 h-5 items-center">
              <span className="mono text-[9px] text-muted-foreground truncate">{v.name.replace('.mp4', '')}</span>
              <span className="mono text-[9px] text-muted-foreground">{v.duration ? v.duration.toFixed(1) + 's' : ''}</span>
            </div>
            <div className="absolute inset-x-0 top-0 h-20 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
              <button type="button" aria-label={`${t('play')} · ${v.name}`} className="text-[10px] uppercase tracking-wider underline" onClick={() => onPlay(v.name)}>{t('play')}</button>
              <button type="button" aria-label={`${t('chain')} · ${v.name}`} className="text-[10px] uppercase tracking-wider underline" onClick={() => onChain(v)}>{t('chain')}</button>
              <button
                type="button"
                aria-label={`${confirmDel === v.name ? t('confirmDelete') : t('delete')} · ${v.name}`}
                disabled={deleting}
                className={`text-[10px] uppercase tracking-wider underline disabled:opacity-40 disabled:cursor-not-allowed ${confirmDel === v.name ? 'text-white bg-black border border-white px-1' : ''}`}
                onClick={() => del(v.name)}>
                {confirmDel === v.name ? t('confirmDelete') : t('delete')}
              </button>
            </div>
          </div>
        ))}
        {videos.length === 0 && <div className="bar text-muted-foreground/60">{t('emptyLibrary')}</div>}
      </div>
    </div>
  )
}
