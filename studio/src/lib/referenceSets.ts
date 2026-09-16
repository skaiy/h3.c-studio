import type { Board, ReferenceAsset, ReferenceSet, ReferenceSetFields, Shot } from './api'

/** The parent flushes drafts, locks mutations, receives the board and handles errors; failure resolves false. */
export type ReferenceMutation = (action: (current: Board) => Promise<Board>) => Promise<boolean>

type ReferenceSetIssue = 'referenceNameRequired' | 'referenceImageLimit' | 'referenceAudioLimit'
  | 'referenceAudioDuration' | 'referenceInvalidAssets'

function selectedAssets(fields: ReferenceSetFields, assets: ReferenceAsset[]) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  return {
    images: fields.image_asset_ids.map((id) => byId.get(id)),
    audio: fields.audio_asset_ids.map((id) => byId.get(id)),
  }
}

function invalidAssets(fields: ReferenceSetFields, selected: ReturnType<typeof selectedAssets>): boolean {
  const ids = [...fields.image_asset_ids, ...fields.audio_asset_ids]
  return new Set(ids).size !== ids.length
    || selected.images.some((asset) => !asset || asset.kind !== 'image' || asset.missing)
    || selected.audio.some((asset) => !asset || asset.kind !== 'audio' || asset.missing)
}

export function validateReferenceSet(fields: ReferenceSetFields, assets: ReferenceAsset[]): ReferenceSetIssue | null {
  const name = fields.name.trim()
  if (!name) return 'referenceNameRequired'
  if (name.length > 160 || fields.notes.length > 4000) return 'referenceInvalidAssets'
  if (fields.image_asset_ids.length < 1 || fields.image_asset_ids.length > 9) return 'referenceImageLimit'
  if (fields.audio_asset_ids.length > 3) return 'referenceAudioLimit'
  const selected = selectedAssets(fields, assets)
  if (invalidAssets(fields, selected)) return 'referenceInvalidAssets'
  let duration = 0
  for (const asset of selected.audio) {
    const seconds = asset?.duration
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 2 || seconds > 15) {
      return 'referenceAudioDuration'
    }
    duration += seconds
  }
  return duration > 15 ? 'referenceAudioDuration' : null
}

export function referenceApplyIssue(shot: Shot, set: ReferenceSet, assets: ReferenceAsset[]): 'referenceAnchorsConflict' | 'referenceMissing' | null {
  // Match the backend's non-null check, not truthiness (even an empty anchor is explicit).
  if (shot.first_frame != null || shot.last_frame != null) return 'referenceAnchorsConflict'
  if (set.missing_asset_ids?.length || invalidAssets(set, selectedAssets(set, assets))) return 'referenceMissing'
  return null
}

export function referenceNeedsReplace(shot: Shot, set: ReferenceSet, assets: ReferenceAsset[]): boolean {
  const images = shot.ref_images ?? []
  const audio = shot.ref_audio ?? []
  if (images.length === 0 && audio.length === 0) return false
  const selected = selectedAssets(set, assets)
  return images.length !== selected.images.length || audio.length !== selected.audio.length
    || images.some((filename, index) => filename !== selected.images[index]?.filename)
    || audio.some((filename, index) => filename !== selected.audio[index]?.filename)
}