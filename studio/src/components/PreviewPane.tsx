import { useEffect, useRef } from 'react'
import { api, type Job } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { Progress } from '@/components/ui/progress'

interface Props {
  video: string | null          // 当前应播放的成片（选中镜头 / 板 result / 连续预览当前帧）
  runningJob: Job | null
  watchJob: boolean
  onWatchJob: (v: boolean) => void
  draftJob: Job | null
  onResume: (job: Job) => void
  hasShots: boolean
  onAddShot: () => void
  sequencing: boolean
  onSequenceEnded: () => void
}

export default function PreviewPane({
  video, runningJob, watchJob, onWatchJob, draftJob, onResume, hasShots, onAddShot, sequencing, onSequenceEnded,
}: Props) {
  const { t } = useI18n()
  const logRef = useRef<HTMLDivElement>(null)
  const pct = runningJob && runningJob.total ? Math.round((runningJob.done / runningJob.total) * 100) : 0
  const showJob = watchJob && runningJob

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [runningJob])

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-stretch shrink-0">
        <div className="bar-invert">{t('preview')}</div>
        {runningJob && !showJob && (
          <button onClick={() => onWatchJob(true)} className="bar linkfade !text-white border-l border-border">
            ● {runningJob.phase ?? t('starting')} {runningJob.done}/{runningJob.total || '…'} · {pct}%
          </button>
        )}
      </div>
      {draftJob && !showJob && (
        <div className="flex items-center gap-2 px-2 h-8 border-b border-border shrink-0">
          <span className="bar !text-white">{t('draftReady')}</span>
          <span className="mono text-[10px] text-muted-foreground truncate">{draftJob.label}</span>
          <div className="flex-1" />
          <button onClick={() => onResume(draftJob)} className="bar linkfade !text-white underline">
            {t('resumeRun')}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex items-center justify-center bg-black/40 p-4">
        {showJob ? (
          <div className="w-full max-w-xl">
            <div className="flex justify-between items-baseline mb-2">
              <span className="text-[12px] uppercase tracking-[0.15em]">{runningJob.phase ?? t('starting')}</span>
              <span className="mono text-[12px] text-muted-foreground">{runningJob.done}/{runningJob.total || '…'}</span>
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
        ) : video ? (
          <video key={video} src={`/outputs/${video}`} controls autoPlay loop={!sequencing}
            onEnded={sequencing ? onSequenceEnded : undefined} className="max-w-full max-h-full" />
        ) : !hasShots ? (
          <div className="flex flex-col items-center gap-3">
            <div className="text-muted-foreground text-[12px] uppercase tracking-[0.2em]">{t('selectShotHint')}</div>
            <button onClick={onAddShot}
              className="h-9 px-4 border border-dashed border-muted-foreground/50 text-muted-foreground text-[11px] hover:text-white hover:border-white transition-colors">
              {t('addShot2')}
            </button>
          </div>
        ) : (
          <div className="text-muted-foreground text-[12px] uppercase tracking-[0.2em]">
            {t('emptyPreview')}
          </div>
        )}
      </div>
    </div>
  )
}
