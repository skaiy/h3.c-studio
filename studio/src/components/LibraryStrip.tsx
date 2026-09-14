import { useState } from 'react'
import { type VideoItem } from '@/lib/api'
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

  const del = async (name: string) => {
    if (confirmDel !== name) {
      setConfirmDel(name)
      setTimeout(() => setConfirmDel((c) => (c === name ? null : c)), 3000)
      return
    }
    setConfirmDel(null)
    await fetch(`/api/videos/${encodeURIComponent(name)}`, { method: 'DELETE' })
    onChanged()
  }

  return (
    <div className="shrink-0 border-t border-border">
      <div className="flex items-stretch">
        <div className="bar-invert">{t('library')}</div>
        <div className="bar">{videos.length} {t('items')}</div>
      </div>
      <div className="flex gap-1 overflow-x-auto p-1">
        {videos.map((v) => (
          <div key={v.name}
            className={`group relative shrink-0 w-36 border transition-colors ${current === v.name ? 'border-white' : 'border-border'}`}>
            <button className="block w-full" onClick={() => onPlay(v.name)}>
              <video src={`/outputs/${v.name}`} preload="metadata" muted className="w-full h-20 object-cover pointer-events-none" />
            </button>
            <div className="flex justify-between px-1 h-5 items-center">
              <span className="mono text-[9px] text-muted-foreground truncate">{v.name.replace('.mp4', '')}</span>
              <span className="mono text-[9px] text-muted-foreground">{v.duration ? v.duration.toFixed(1) + 's' : ''}</span>
            </div>
            <div className="absolute inset-x-0 top-0 h-20 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
              <button className="text-[10px] uppercase tracking-wider underline" onClick={() => onPlay(v.name)}>{t('play')}</button>
              <button className="text-[10px] uppercase tracking-wider underline" onClick={() => onChain(v)}>{t('chain')}</button>
              <button
                className={`text-[10px] uppercase tracking-wider underline ${confirmDel === v.name ? 'text-white bg-black border border-white px-1' : ''}`}
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
