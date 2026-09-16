import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { api, type Board, type ReferenceAsset, type ReferenceSet, type ReferenceSetFields } from '@/lib/api'
import { validateReferenceSet, type ReferenceMutation } from '@/lib/referenceSets'
import type { I18nKey } from '@/lib/i18nData'
import { useI18n } from '@/lib/useI18n'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import ReferenceAssetPreview from './ReferenceAssetPreview'

interface Props {
  board: Board
  disabled: boolean
  error?: string
  onMutate: ReferenceMutation
  onClose: () => void
}

interface Editor {
  id?: string
  revision?: number
  fields: ReferenceSetFields
  baseline: string
}

const controlClass = 'min-h-8 border border-border px-2 py-1 text-[11px] enabled:hover:bg-white enabled:hover:text-black disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400'
const fieldClass = 'w-full min-w-0 border border-border bg-background px-2 py-1.5 text-[12px] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400'
const kinds = ['character', 'scene', 'style', 'other'] as const
const kindKeys = { character: 'referenceKindCharacter', scene: 'referenceKindScene', style: 'referenceKindStyle', other: 'referenceKindOther' } as const
const extensions = { image: ['.png', '.jpg', '.jpeg', '.webp'], audio: ['.wav', '.mp3', '.flac', '.m4a', '.ogg', '.aac'] }

function editorFor(set?: ReferenceSet): Editor {
  const fields: ReferenceSetFields = set
    ? { name: set.name, kind: set.kind, notes: set.notes, image_asset_ids: [...set.image_asset_ids], audio_asset_ids: [...set.audio_asset_ids] }
    : { name: '', kind: 'character', notes: '', image_asset_ids: [], audio_asset_ids: [] }
  return { id: set?.id, revision: set?.revision, fields, baseline: JSON.stringify(fields) }
}

// The inner key also isolates late completions if a caller forgets to key by board ID.
export default function ReferenceManager(props: Props) {
  return <Manager key={props.board.id} {...props} />
}

function Manager({ board, disabled, error, onMutate, onClose }: Props) {
  const { t } = useI18n()
  const id = useId()
  const [editor, setEditor] = useState<Editor | null>(null)
  const [pending, setPending] = useState(false)
  const [issue, setIssue] = useState<I18nKey | null>(null)
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const busy = disabled || pending
  const assets = board.assets ?? []
  const sets = board.reference_sets ?? []
  const dirty = !!editor && JSON.stringify(editor.fields) !== editor.baseline
  const liveSet = editor?.id ? sets.find((set) => set.id === editor.id) : undefined
  const changed = !!editor?.id && (!liveSet || liveSet.revision !== editor.revision)

  useEffect(() => {
    if (!dirty) return
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])

  function discardAllowed() {
    return !dirty || window.confirm(t('referenceDiscardConfirm'))
  }

  function close() {
    if (!locked.current && discardAllowed()) onClose()
  }

  function edit(set?: ReferenceSet) {
    if (busy || locked.current || !discardAllowed()) return
    setEditor(editorFor(set))
    setIssue(null)
  }

  function change(fields: Partial<ReferenceSetFields>) {
    if (busy || locked.current) return
    setEditor((current) => current ? { ...current, fields: { ...current.fields, ...fields } } : current)
    setIssue(null)
  }

  async function mutate(action: (current: Board) => Promise<Board>, success?: () => void) {
    if (disabled || locked.current) return
    locked.current = true
    setPending(true)
    setIssue(null)
    const boardId = board.id
    try {
      const ok = await onMutate((current) => {
        if (current.id !== boardId) throw new Error(t('referenceConflict'))
        return action(current)
      })
      if (alive.current) {
        if (ok) success?.()
        else setIssue('referenceMutationFailed')
      }
    } catch {
      // onMutate normally reports the request error and resolves false; keep the draft either way.
      if (alive.current) setIssue('referenceMutationFailed')
    } finally {
      locked.current = false
      if (alive.current) setPending(false)
    }
  }

  function importFile(file: File | undefined, kind: ReferenceAsset['kind']) {
    if (!file || busy || locked.current) return
    if (file.size > 256 * 1024 * 1024) { setIssue('referenceFileSize'); return }
    if (!extensions[kind].some((ext) => file.name.toLowerCase().endsWith(ext))) {
      setIssue('referenceFileType'); return
    }
    const boardId = board.id
    void mutate(async (current) => {
      const uploaded = await api.upload(file)
      return api.importReferenceAsset(boardId, uploaded.name, kind, current.modifiedAt)
    })
  }

  function save(event: FormEvent) {
    event.preventDefault()
    if (!editor || busy || locked.current) return
    const validation = validateReferenceSet(editor.fields, assets)
    if (validation) { setIssue(validation); return }
    // Keep the editor's original expected revision, even if a poll has newer metadata.
    const { id: setId, revision, fields } = editor
    const boardId = board.id
    void mutate((current) => {
      const latestIssue = validateReferenceSet(fields, current.assets ?? [])
      if (latestIssue) throw new Error(t(latestIssue))
      return setId !== undefined && revision !== undefined
        ? api.updateReferenceSet(boardId, setId, fields, current.modifiedAt, revision)
        : api.createReferenceSet(boardId, fields, current.modifiedAt)
    }, () => setEditor(null))
  }

  function deleteSet(set: ReferenceSet) {
    if (busy || locked.current || !window.confirm(`${t('referenceDeleteSetConfirm')}\n${set.name}`)) return
    if (editor?.id === set.id && !discardAllowed()) return
    const boardId = board.id, setId = set.id, setRevision = set.revision
    const editingDeleted = editor?.id === setId
    void mutate((current) => {
      // A flush/poll must not extend deletion consent to a newer set revision.
      if (current.reference_sets?.find((item) => item.id === setId)?.revision !== setRevision) {
        throw new Error(t('referenceConflict'))
      }
      return api.deleteReferenceSet(boardId, setId, current.modifiedAt)
    }, () => {
      if (editingDeleted) setEditor(null)
    })
  }

  function deleteAsset(asset: ReferenceAsset) {
    if (busy || locked.current || !window.confirm(`${t('referenceDeleteAssetConfirm')}\n${asset.filename}`)) return
    const boardId = board.id, assetId = asset.id
    void mutate((current) => api.deleteReferenceAsset(boardId, assetId, current.modifiedAt))
  }

  function orderedSelection(kind: ReferenceAsset['kind']) {
    if (!editor) return null
    const field = kind === 'image' ? 'image_asset_ids' : 'audio_asset_ids'
    const ids = editor.fields[field]
    const label = t(kind === 'image' ? 'referenceImages' : 'referenceAudio')
    const limit = kind === 'image' ? 9 : 3
    const available = assets.filter((asset) => asset.kind === kind && !asset.missing && !ids.includes(asset.id))
    function move(index: number, offset: number) {
      const next = [...ids]
      ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
      change({ [field]: next })
    }
    return <fieldset className="min-w-0 space-y-2" disabled={busy}>
      <legend className="bar !px-0">{label} · {ids.length}/{limit}</legend>
      <ol aria-label={label} className="space-y-1">
        {ids.map((assetId, index) => {
          const asset = assets.find((item) => item.id === assetId)
          const missing = !asset || asset.missing
          return <li key={assetId} className="border border-border p-2 text-[11px]" data-testid={`reference-selected-${assetId}`}>
            <div className="mono break-all">{index + 1}. {asset?.filename ?? assetId}</div>
            {kind === 'audio' && <div>{t('referenceDuration')}: {asset?.duration ?? '—'}</div>}
            {missing && <p className="text-amber-300">{t('referenceMissing')} · {t('referenceRepairHint')}</p>}
            <div className="mt-1 flex flex-wrap gap-1">
              <button type="button" className={controlClass} disabled={busy || index === 0} aria-label={`${t('referenceMoveUp')} · ${index + 1}`} onClick={() => move(index, -1)}>{t('referenceMoveUp')}</button>
              <button type="button" className={controlClass} disabled={busy || index === ids.length - 1} aria-label={`${t('referenceMoveDown')} · ${index + 1}`} onClick={() => move(index, 1)}>{t('referenceMoveDown')}</button>
              <button type="button" className={controlClass} disabled={busy} aria-label={`${t('referenceRemove')} · ${index + 1}`} onClick={() => change({ [field]: ids.filter((_, i) => i !== index) })}>{t('referenceRemove')}</button>
            </div>
          </li>
        })}
      </ol>
      <label className="block text-[11px]">
        {t(kind === 'image' ? 'referenceAddImage' : 'referenceAddAudio')}
        <select className={fieldClass} value="" disabled={busy || ids.length >= limit || !available.length}
          onChange={(event) => { if (event.target.value) change({ [field]: [...ids, event.target.value] }) }}>
          <option value="">{t('referenceChooseAsset')}</option>
          {available.map((asset) => <option key={asset.id} value={asset.id}>{asset.filename}{kind === 'audio' ? ` · ${t('referenceDuration')}: ${asset.duration ?? '—'}` : ''}</option>)}
        </select>
      </label>
      {kind === 'audio' && <p className="mono text-[11px]">{t('referenceAudioTotal')}: {ids.reduce((sum, assetId) => sum + (assets.find((asset) => asset.id === assetId)?.duration ?? 0), 0)} / 15</p>}
    </fieldset>
  }

  return <Dialog open onOpenChange={(open) => { if (!open) close() }}>
    <DialogContent showCloseButton={false} className="max-h-[90dvh] overflow-y-auto rounded-none border-border bg-background p-4 sm:max-w-4xl"
      onEscapeKeyDown={(event) => { event.preventDefault(); close() }}
      onPointerDownOutside={(event) => { event.preventDefault(); close() }}>
      <DialogHeader>
        <div className="flex items-center justify-between gap-2">
          <DialogTitle className="bar !h-auto !px-0">{t('referenceTitle')}</DialogTitle>
          <button type="button" className={controlClass} disabled={pending} onClick={close}>{t('referenceClose')}</button>
        </div>
        <DialogDescription className="text-left text-[11px]">
          <span className="mb-1 block break-words text-foreground">{board.name}</span>
          {t('referenceManagerHint')}
        </DialogDescription>
      </DialogHeader>
      {busy && <p role="status" className="text-[11px] text-muted-foreground">{t('referenceBusy')}</p>}
      {error && <p role="alert" className="break-words text-[11px] text-amber-300">{error}</p>}
      {issue && (!error || issue !== 'referenceMutationFailed') && <p role="alert" className="text-[11px] text-amber-300">{t(issue)}</p>}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <section aria-labelledby={`${id}-assets`} className="min-w-0 space-y-2">
          <h3 id={`${id}-assets`} className="bar !px-0">{t('referenceAssets')}</h3>
          <p className="text-[11px] text-muted-foreground">{t('referenceImportHint')}</p>
          {(['image', 'audio'] as const).map((kind) => <label key={kind} className="block space-y-1 text-[11px]">
            <span>{t(kind === 'image' ? 'referenceImportImage' : 'referenceImportAudio')}</span>
            <input type="file" accept={extensions[kind].join(',')} disabled={busy} className={fieldClass}
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; importFile(file, kind) }} />
          </label>)}
          {assets.length === 0 && <p className="text-[11px] text-muted-foreground">{t('referenceNoAssets')}</p>}
          <ul aria-label={t('referenceAssets')} className="max-h-64 space-y-1 overflow-y-auto">
            {assets.map((asset) => <li key={asset.id} className="border border-border p-2 text-[11px]" data-testid={`reference-asset-${asset.id}`}>
              <div className="mono break-all">{asset.filename}</div>
              <div className="text-muted-foreground">{t(asset.kind === 'image' ? 'referenceImages' : 'referenceAudio')} · {t('referenceSize')}: {asset.size}
                {asset.kind === 'audio' ? ` · ${t('referenceDuration')}: ${asset.duration ?? '—'}` : asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}</div>
              <ReferenceAssetPreview asset={asset} repairHint />
              <button type="button" className={`${controlClass} mt-1`} disabled={busy} onClick={() => deleteAsset(asset)}>{t('referenceDeleteAsset')}</button>
            </li>)}
          </ul>
          <h3 className="bar !px-0">{t('referenceSets')}</h3>
          <button type="button" className={controlClass} disabled={busy} onClick={() => edit()}>{t('referenceNew')}</button>
          {!sets.length && <p className="text-[11px] text-muted-foreground">{t('referenceEmpty')}</p>}
          <ul aria-label={t('referenceSets')} className="max-h-64 space-y-1 overflow-y-auto">
            {sets.map((set) => <li key={set.id} className="border border-border p-2 text-[11px]" data-testid={`reference-set-${set.id}`}>
              <div className="break-words">{set.name} · {t(kindKeys[set.kind])} · {t('referenceRevision')} {set.revision}</div>
              {!!set.missing_asset_ids?.length && <p className="text-amber-300">{t('referenceMissing')} · {t('referenceRepairHint')}</p>}
              <div className="mt-1 flex gap-1">
                <button type="button" className={controlClass} disabled={busy} onClick={() => edit(set)}>{t('referenceEdit')}</button>
                <button type="button" className={controlClass} disabled={busy} onClick={() => deleteSet(set)}>{t('referenceDeleteSet')}</button>
              </div>
            </li>)}
          </ul>
        </section>
        {editor ? <form aria-label={t('referenceEditor')} onSubmit={save} className="min-w-0 space-y-3 border border-border p-3">
          <h3 className="bar !px-0">{t(editor.id ? 'referenceEdit' : 'referenceNew')}{editor.revision !== undefined && ` · ${t('referenceRevision')} ${editor.revision}`}</h3>
          {changed && <div role="status" className="space-y-1 text-[11px] text-amber-300">
            <p>{t('referenceConflict')}</p>
            {liveSet && <button type="button" className={controlClass} disabled={busy} onClick={() => {
              if (!locked.current && window.confirm(t('referenceReloadConfirm'))) { setEditor(editorFor(liveSet)); setIssue(null) }
            }}>{t('referenceReload')}</button>}
          </div>}
          <label className="block text-[11px]">{t('referenceName')}<input className={fieldClass} value={editor.fields.name} maxLength={160} disabled={busy} onChange={(event) => change({ name: event.target.value })} /></label>
          <label className="block text-[11px]">{t('referenceKind')}<select className={fieldClass} value={editor.fields.kind} disabled={busy} onChange={(event) => change({ kind: event.target.value as ReferenceSetFields['kind'] })}>
            {kinds.map((kind) => <option key={kind} value={kind}>{t(kindKeys[kind])}</option>)}
          </select></label>
          <label className="block text-[11px]">{t('referenceNotes')}<textarea className={fieldClass} rows={3} value={editor.fields.notes} maxLength={4000} disabled={busy} onChange={(event) => change({ notes: event.target.value })} /></label>
          <p className="text-[11px] text-muted-foreground">{t('referenceLimits')}</p>
          {orderedSelection('image')}
          {orderedSelection('audio')}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={controlClass} disabled={busy}>{t('referenceSave')}</button>
            <button type="button" className={controlClass} disabled={pending} onClick={() => {
              if (!locked.current && discardAllowed()) { setEditor(null); setIssue(null) }
            }}>{t('referenceCancel')}</button>
          </div>
        </form> : <p className="text-[11px] text-muted-foreground">{t('referenceEditorHint')}</p>}
      </div>
    </DialogContent>
  </Dialog>
}