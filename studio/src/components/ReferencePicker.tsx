import { useEffect, useId, useRef, useState } from 'react'
import { api, type Board, type ReferenceAsset, type Shot } from '@/lib/api'
import { referenceApplyIssue, referenceNeedsReplace, type ReferenceMutation } from '@/lib/referenceSets'
import type { I18nKey } from '@/lib/i18nData'
import { useI18n } from '@/lib/useI18n'
import ReferenceAssetPreview from './ReferenceAssetPreview'

interface Props {
  board: Board
  shot: Shot
  disabled: boolean
  error?: string
  // Workspace already announces this error; do not announce it again in the inspector.
  errorInParent?: boolean
  onMutate: ReferenceMutation
  onManage: () => void
}

const controlClass = 'min-h-8 border border-border px-2 py-1 text-[11px] enabled:hover:bg-white enabled:hover:text-black disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400'
const kindKeys = { character: 'referenceKindCharacter', scene: 'referenceKindScene', style: 'referenceKindStyle', other: 'referenceKindOther' } as const

function AssetList({ assets, label }: { assets: (ReferenceAsset | undefined)[]; label: string }) {
  const { t } = useI18n()
  return <div className="space-y-1">
    <h5 className="text-muted-foreground">{label}</h5>
    {assets.length ? <ol aria-label={label} className="list-decimal space-y-1 pl-5">
      {assets.map((asset, index) => <li key={`${asset?.id ?? 'missing'}-${index}`} className="mono break-all">
        {asset?.filename ?? t('referenceMissing')}
        {asset && <span className="block text-muted-foreground">{t('referenceSize')}: {asset.size}
          {asset.kind === 'audio' ? ` · ${t('referenceDuration')}: ${asset.duration ?? '—'}` : asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}</span>}
        {asset && <ReferenceAssetPreview asset={asset} />}
      </li>)}
    </ol> : <p className="text-muted-foreground">{t('referenceNone')}</p>}
  </div>
}

export default function ReferencePicker(props: Props) {
  return <Picker key={`${props.board.id}/${props.shot.id}`} {...props} />
}

function Picker({ board, shot, disabled, error, errorInParent = false, onMutate, onManage }: Props) {
  const { t } = useI18n()
  const id = useId()
  const [selectedId, setSelectedId] = useState('')
  const [pending, setPending] = useState(false)
  const [issue, setIssue] = useState<I18nKey | null>(null)
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const busy = disabled || pending
  const sets = board.reference_sets ?? []
  const assets = board.assets ?? []
  const selected = sets.find((set) => set.id === selectedId)
  const applyIssue = selected ? referenceApplyIssue(shot, selected, assets) : null
  const snapshot = shot.reference_snapshot
  const source = snapshot?.source_board_id === board.id ? sets.find((set) => set.id === snapshot.set_id) : undefined
  const snapshotMissing = shot.reference_snapshot_missing || snapshot?.images.some((asset) => asset.missing) || snapshot?.audio.some((asset) => asset.missing)

  async function apply() {
    if (disabled || locked.current || !selected) return
    const problem = referenceApplyIssue(shot, selected, assets)
    if (problem) { setIssue(problem); return }
    const replace = referenceNeedsReplace(shot, selected, assets)
    if (replace && !window.confirm(t('referenceReplaceConfirm'))) return
    // Nothing is changed optimistically. The request uses exactly what was displayed/confirmed.
    const boardId = board.id, shotId = shot.id
    const set = { ...selected, image_asset_ids: [...selected.image_asset_ids], audio_asset_ids: [...selected.audio_asset_ids], missing_asset_ids: selected.missing_asset_ids?.slice() }
    const confirmedInputs = JSON.stringify([shot.ref_images ?? [], shot.ref_audio ?? []])
    locked.current = true
    setPending(true)
    setIssue(null)
    try {
      const ok = await onMutate((current) => {
        const target = current.shots.find((item) => item.id === shotId)
        if (current.id !== boardId || !target) throw new Error(t('referenceConflict'))
        const latestIssue = referenceApplyIssue(target, set, current.assets ?? [])
        if (latestIssue) throw new Error(t(latestIssue))
        const needsReplace = referenceNeedsReplace(target, set, current.assets ?? [])
        if (needsReplace && (!replace || JSON.stringify([target.ref_images ?? [], target.ref_audio ?? []]) !== confirmedInputs)) {
          throw new Error(t('referenceConflict'))
        }
        return api.applyReferenceSet(boardId, shotId, set.id, current.modifiedAt, set.revision, replace)
      })
      if (!ok && alive.current) setIssue('referenceMutationFailed')
    } catch {
      if (alive.current) setIssue('referenceMutationFailed')
    } finally {
      locked.current = false
      if (alive.current) setPending(false)
    }
  }

  return <section aria-labelledby={`${id}-title`} className="min-w-0 border-t border-border text-[11px]">
    <div className="bar justify-between gap-2">
      <h3 id={`${id}-title`}>{t('referenceSets')}</h3>
      <button type="button" className={controlClass} disabled={busy} onClick={onManage}>{t('referenceManage')}</button>
    </div>
    <div className="space-y-2 p-2 pt-0">
      <p className="text-muted-foreground">{t('referencePickerHint')}</p>
      {busy && <p role="status" className="text-muted-foreground">{t('referenceBusy')}</p>}
      {error && !errorInParent && <p role="alert" className="break-words text-amber-300">{error}</p>}
      {issue && (!error || issue !== 'referenceMutationFailed') && <p role="alert" className="text-amber-300">{t(issue)}</p>}
      {!sets.length && <p className="text-muted-foreground">{t('referenceEmpty')}</p>}
      <label className="block space-y-1">
        <span>{t('referenceChooseSet')}</span>
        <select className="w-full min-w-0 border border-border bg-background px-2 py-1.5 text-[12px] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
          value={selectedId} disabled={busy || !sets.length} onChange={(event) => { setSelectedId(event.target.value); setIssue(null) }}>
          <option value="">{t('referenceChooseSet')}</option>
          {selectedId && !selected && <option value={selectedId}>{t('referenceSetDeleted')}</option>}
          {sets.map((set) => <option key={set.id} value={set.id}>{set.name} · {t(kindKeys[set.kind])} · {t('referenceRevision')} {set.revision}</option>)}
        </select>
      </label>
      {selected && <div className="space-y-2 border border-border p-2" data-testid="reference-set-preview">
        <h4 className="break-words font-semibold">{selected.name} · {t(kindKeys[selected.kind])} · {t('referenceRevision')} {selected.revision}</h4>
        {selected.notes && <p className="whitespace-pre-wrap break-words">{selected.notes}</p>}
        <AssetList label={t('referenceImages')} assets={selected.image_asset_ids.map((assetId) => assets.find((asset) => asset.id === assetId))} />
        <AssetList label={t('referenceAudio')} assets={selected.audio_asset_ids.map((assetId) => assets.find((asset) => asset.id === assetId))} />
      </div>}
      {selectedId && !selected && <p role="status" className="text-amber-300">{t('referenceSetDeleted')}</p>}
      {applyIssue && <p role="status" className="text-amber-300">{t(applyIssue)}{applyIssue === 'referenceMissing' && ` · ${t('referenceRepairHint')}`}</p>}
      <button type="button" className={controlClass} disabled={busy || !selected || !!applyIssue} onClick={() => { void apply() }}>{t('referenceApply')}</button>
      <section aria-labelledby={`${id}-snapshot`} className="space-y-2 border-t border-border pt-2" data-testid="reference-shot-snapshot">
        <h4 id={`${id}-snapshot`} className="font-semibold">{t('referenceSnapshot')}</h4>
        <p className="text-muted-foreground">{t('referenceSnapshotHint')}</p>
        {snapshot ? <>
          <div className="break-words">{snapshot.set_name} · {t('referenceRevision')} {snapshot.set_revision}</div>
          <dl className="mono break-all">
            <dt className="text-muted-foreground">{t('referenceSourceBoard')}</dt><dd>{snapshot.source_board_id}</dd>
            <dt className="text-muted-foreground">{t('referenceSourceSet')}</dt><dd>{snapshot.set_id}</dd>
          </dl>
          {snapshot.source_board_id !== board.id
            ? <p role="status" className="text-amber-300">{t('referenceOtherBoard')}</p>
            : !source ? <p role="status" className="text-amber-300">{t('referenceSetDeleted')}</p>
              : source.revision !== snapshot.set_revision && <p role="status" className="text-amber-300">{t('referenceStale')}</p>}
          {snapshotMissing && <p role="status" className="text-amber-300">{t('referenceMissing')} · {t('referenceRepairHint')}</p>}
          <AssetList label={t('referenceImages')} assets={snapshot.images} />
          <AssetList label={t('referenceAudio')} assets={snapshot.audio} />
        </> : <p className="text-muted-foreground">{t('referenceNoSnapshot')}</p>}
      </section>
    </div>
  </section>
}