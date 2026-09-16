import { describe, expect, expectTypeOf, it } from 'vitest'
import type { Board, ReferenceAsset, ReferenceSet, ReferenceSetFields, Shot } from './api'
import { referenceApplyIssue, referenceNeedsReplace, validateReferenceSet } from './referenceSets'
import type { ReferenceMutation } from './referenceSets'

function image(id: string): ReferenceAsset {
  return { id, filename: `${id}.png`, kind: 'image', size: 128, sha256: '0'.repeat(64), created_at: 1 }
}

function audio(id: string, duration: number | null = 5): ReferenceAsset {
  return { ...image(id), filename: `${id}.wav`, kind: 'audio', duration }
}

const images = Array.from({ length: 10 }, (_, i) => image(`image-${i + 1}`))
const clips = Array.from({ length: 4 }, (_, i) => audio(`audio-${i + 1}`))
const assets = [...images, ...clips]
const fields: ReferenceSetFields = {
  name: 'Character', kind: 'character', image_asset_ids: ['image-2', 'image-1'],
  audio_asset_ids: ['audio-2', 'audio-1'], notes: 'Preserve these references.',
}
const referenceSet: ReferenceSet = { ...fields, id: 'set', revision: 2 }
const shot: Shot = {
  id: 'shot', prompt: 'Leave the prompt alone', width: 512, height: 512, seconds: 5,
  steps: 20, layers: 45, reuse: 2, seed: 42, first_frame: null, last_frame: null,
  status: 'done', output: 'chosen.mp4', job_id: null,
}
const matchingShot: Shot = { ...shot, ref_images: ['image-2.png', 'image-1.png'], ref_audio: ['audio-2.wav', 'audio-1.wav'] }

describe('validateReferenceSet', () => {
  it.each(['character', 'scene', 'style', 'other'] as const)('accepts the %s kind and ordered valid selections', (kind) => {
    expect(validateReferenceSet({ ...fields, kind }, assets)).toBeNull()
  })

  it.each(['', ' ', '\t\n\r', '\u3000'])('requires a non-whitespace name: %j', (name) => {
    expect(validateReferenceSet({ ...fields, name }, assets)).toBe('referenceNameRequired')
  })

  it('checks the trimmed name and notes bounds without modifying either', () => {
    const draft = { ...fields, name: `  ${'x'.repeat(160)}\n`, notes: 'n'.repeat(4000) }
    const original = JSON.stringify(draft)
    expect(validateReferenceSet(draft, assets)).toBeNull()
    expect(JSON.stringify(draft)).toBe(original)
    expect(validateReferenceSet({ ...draft, name: ` ${'x'.repeat(161)} ` }, assets)).toBe('referenceInvalidAssets')
    expect(validateReferenceSet({ ...draft, notes: 'n'.repeat(4001) }, assets)).toBe('referenceInvalidAssets')
  })

  it.each([1, 9])('accepts %i images without audio', (count) => {
    expect(validateReferenceSet({
      ...fields, image_asset_ids: images.slice(0, count).map((asset) => asset.id), audio_asset_ids: [],
    }, assets)).toBeNull()
  })

  it.each([0, 10])('rejects %i images, including audio-only sets', (count) => {
    expect(validateReferenceSet({
      ...fields, image_asset_ids: images.slice(0, count).map((asset) => asset.id),
    }, assets)).toBe('referenceImageLimit')
  })

  it.each([0, 1, 2, 3])('accepts %i audio clips within the duration budget', (count) => {
    expect(validateReferenceSet({ ...fields, audio_asset_ids: clips.slice(0, count).map((asset) => asset.id) }, assets)).toBeNull()
  })

  it('rejects a fourth clip even if its total would be within the duration budget', () => {
    const shortClips = clips.map((clip) => ({ ...clip, duration: 2 }))
    expect(validateReferenceSet({ ...fields, audio_asset_ids: shortClips.map((asset) => asset.id) }, [...images, ...shortClips]))
      .toBe('referenceAudioLimit')
  })

  it.each([
    { image_asset_ids: ['image-1', 'image-1'] },
    { audio_asset_ids: ['audio-1', 'audio-1'] },
    { image_asset_ids: ['image-1'], audio_asset_ids: ['image-1'] },
    { image_asset_ids: ['unknown'] },
    { audio_asset_ids: ['unknown'] },
    { image_asset_ids: ['audio-1'] },
    { audio_asset_ids: ['image-1'] },
  ])('rejects duplicate, absent or wrong-kind IDs: %j', (changes) => {
    expect(validateReferenceSet({ ...fields, ...changes }, assets)).toBe('referenceInvalidAssets')
  })

  it.each(['image-1', 'audio-1'])('rejects a missing selected file: %s', (id) => {
    const missing = assets.map((asset) => asset.id === id ? { ...asset, missing: true } : asset)
    expect(validateReferenceSet(fields, missing)).toBe('referenceInvalidAssets')
  })

  it('ignores missing files and invalid durations outside the selection', () => {
    const unrelated = [
      ...assets, { ...image('unselected-image'), missing: true },
      { ...audio('unselected-audio', null), missing: true },
    ]
    expect(validateReferenceSet(fields, unrelated)).toBeNull()
  })

  it.each([2, 15])('accepts the inclusive single-clip boundary of %s seconds', (duration) => {
    expect(validateReferenceSet({ ...fields, audio_asset_ids: ['clip'] }, [...images, audio('clip', duration)])).toBeNull()
  })

  it.each([undefined, null, NaN, Infinity, -Infinity, -1, 0, 1.999, 15.001])('rejects invalid duration %s', (duration) => {
    const clip = { ...audio('clip'), duration }
    expect(validateReferenceSet({ ...fields, audio_asset_ids: ['clip'] }, [...images, clip])).toBe('referenceAudioDuration')
  })

  it.each(['5', true])('does not coerce malformed duration %s', (duration) => {
    const clip = { ...audio('clip'), duration } as unknown as ReferenceAsset
    expect(validateReferenceSet({ ...fields, audio_asset_ids: ['clip'] }, [...images, clip])).toBe('referenceAudioDuration')
  })

  it.each([
    { durations: [7.5, 7.5], expected: null },
    { durations: [2, 6, 7], expected: null },
    { durations: [7.5, 7.501], expected: 'referenceAudioDuration' },
    { durations: [5, 5, 5.001], expected: 'referenceAudioDuration' },
  ])('enforces the total duration: $durations', ({ durations, expected }) => {
    const selected = durations.map((duration, index) => audio(`clip-${index}`, duration))
    expect(validateReferenceSet({ ...fields, audio_asset_ids: selected.map((clip) => clip.id) }, [...images, ...selected])).toBe(expected)
  })
})

describe('referenceApplyIssue', () => {
  it('accepts available references regardless of asset registry order or existing inputs', () => {
    expect(referenceApplyIssue(shot, referenceSet, [...assets].reverse())).toBeNull()
    expect(referenceApplyIssue({ ...shot, ref_images: ['manual.png'] }, referenceSet, assets)).toBeNull()
  })

  it.each([
    { first_frame: 'first.png' }, { last_frame: 'last.png' },
    { first_frame: 'first.png', last_frame: 'last.png' },
    { first_frame: '' }, { last_frame: '' },
  ])('rejects explicit anchors without clearing them: %j', (anchors) => {
    const anchored = { ...matchingShot, ...anchors }
    expect(referenceApplyIssue(anchored, referenceSet, assets)).toBe('referenceAnchorsConflict')
    expect(anchored).toEqual({ ...matchingShot, ...anchors })
  })

  it('gives anchors precedence over unavailable references', () => {
    expect(referenceApplyIssue({ ...shot, first_frame: 'first.png' }, referenceSet, [])).toBe('referenceAnchorsConflict')
  })

  it('honors the set missing annotation even if the asset registry appears available', () => {
    expect(referenceApplyIssue(shot, { ...referenceSet, missing_asset_ids: ['image-1'] }, assets)).toBe('referenceMissing')
    expect(referenceApplyIssue(shot, { ...referenceSet, missing_asset_ids: [] }, assets)).toBeNull()
  })

  it.each(['image-1', 'audio-1'])('blocks absent and missing selected assets: %s', (id) => {
    expect(referenceApplyIssue(shot, referenceSet, assets.filter((asset) => asset.id !== id))).toBe('referenceMissing')
    expect(referenceApplyIssue(shot, referenceSet, assets.map((asset) => asset.id === id ? { ...asset, missing: true } : asset)))
      .toBe('referenceMissing')
  })

  it('blocks wrong-kind and duplicate selections', () => {
    expect(referenceApplyIssue(shot, { ...referenceSet, image_asset_ids: ['audio-1'] }, assets)).toBe('referenceMissing')
    expect(referenceApplyIssue(shot, { ...referenceSet, audio_asset_ids: ['image-1'] }, assets)).toBe('referenceMissing')
    expect(referenceApplyIssue(shot, { ...referenceSet, image_asset_ids: ['image-1', 'image-1'] }, assets)).toBe('referenceMissing')
  })

  it('does not block a healthy new set because an old frozen snapshot is missing', () => {
    const oldSnapshot: Shot = {
      ...shot, reference_snapshot_missing: true,
      reference_snapshot: {
        source_board_id: 'original-board', set_id: 'deleted-set', set_revision: 1, set_name: 'Old',
        images: [{ ...image('old'), missing: true }], audio: [],
      },
    }
    expect(referenceApplyIssue(oldSnapshot, referenceSet, assets)).toBeNull()
    expect(referenceApplyIssue(shot, referenceSet, [...assets, { ...image('unused'), missing: true }])).toBeNull()
  })
})

describe('referenceNeedsReplace', () => {
  it.each([{}, { ref_images: [] }, { ref_audio: [] }, { ref_images: [], ref_audio: [] }])('does not confirm empty or omitted existing references: %j', (refs) => {
    expect(referenceNeedsReplace({ ...shot, ...refs }, referenceSet, assets)).toBe(false)
  })

  it('compares ordered filenames, not registry order, set identity, revision or notes', () => {
    const changedMetadata = { ...referenceSet, id: 'other-set', revision: 99, name: 'Renamed', notes: 'Changed' }
    expect(referenceNeedsReplace(matchingShot, changedMetadata, [...assets].reverse())).toBe(false)
    const renamedIds = assets.map((asset) => ({ ...asset, id: `new-${asset.id}` }))
    const equivalentSet = {
      ...referenceSet, image_asset_ids: fields.image_asset_ids.map((id) => `new-${id}`),
      audio_asset_ids: fields.audio_asset_ids.map((id) => `new-${id}`),
    }
    expect(referenceNeedsReplace(matchingShot, equivalentSet, renamedIds)).toBe(false)
  })

  it.each([
    { ref_images: ['image-1.png', 'image-2.png'] },
    { ref_audio: ['audio-1.wav', 'audio-2.wav'] },
    { ref_images: ['different.png', 'image-1.png'] },
    { ref_audio: ['different.wav', 'audio-1.wav'] },
    { ref_images: ['image-2.png'] }, { ref_audio: ['audio-2.wav'] },
    { ref_images: ['image-2.png', 'image-1.png', 'extra.png'] },
    { ref_audio: ['audio-2.wav', 'audio-1.wav', 'extra.wav'] },
    { ref_images: [] }, { ref_audio: [] },
  ])('requires confirmation for different nonempty existing references: %j', (refs) => {
    expect(referenceNeedsReplace({ ...matchingShot, ...refs }, referenceSet, assets)).toBe(true)
  })

  it('detects order changes in either set list', () => {
    expect(referenceNeedsReplace(matchingShot, { ...referenceSet, image_asset_ids: [...fields.image_asset_ids].reverse() }, assets)).toBe(true)
    expect(referenceNeedsReplace(matchingShot, { ...referenceSet, audio_asset_ids: [...fields.audio_asset_ids].reverse() }, assets)).toBe(true)
  })

  it('confirms removal of existing audio and replacement of audio-only inputs', () => {
    const imageOnly = { ...referenceSet, audio_asset_ids: [] }
    expect(referenceNeedsReplace(matchingShot, imageOnly, assets)).toBe(true)
    expect(referenceNeedsReplace({ ...matchingShot, ref_audio: undefined }, imageOnly, assets)).toBe(false)
    expect(referenceNeedsReplace({ ...shot, ref_audio: ['audio-2.wav'] }, referenceSet, assets)).toBe(true)
  })

  it('never drops unresolved IDs to make a partial selection appear identical', () => {
    const incomplete = { ...referenceSet, image_asset_ids: ['image-2', 'unknown'] }
    expect(referenceNeedsReplace(matchingShot, incomplete, assets)).toBe(true)
    expect(referenceNeedsReplace(shot, incomplete, assets)).toBe(false)
  })

  it('keeps missing-file and anchor errors separate from filename equality', () => {
    const missing = assets.map((asset) => ({ ...asset, missing: true }))
    expect(referenceNeedsReplace(matchingShot, referenceSet, missing)).toBe(false)
    expect(referenceNeedsReplace({ ...matchingShot, first_frame: 'first.png' }, referenceSet, assets)).toBe(false)
  })
})

describe('reference helper isolation', () => {
  it('never mutates frozen shots, fields, asset metadata or selection order', () => {
    const frozenSet = { ...referenceSet, image_asset_ids: [...fields.image_asset_ids], audio_asset_ids: [...fields.audio_asset_ids] }
    const frozenShot = { ...matchingShot, ref_images: [...matchingShot.ref_images!], ref_audio: [...matchingShot.ref_audio!] }
    const frozenAssets = assets.map((asset) => ({ ...asset }))
    for (const value of [frozenSet, frozenShot, frozenSet.image_asset_ids, frozenSet.audio_asset_ids,
      frozenShot.ref_images, frozenShot.ref_audio, frozenAssets, ...frozenAssets]) Object.freeze(value)
    const before = JSON.stringify({ frozenSet, frozenShot, frozenAssets })
    expect(validateReferenceSet(frozenSet, frozenAssets)).toBeNull()
    expect(referenceApplyIssue(frozenShot, frozenSet, frozenAssets)).toBeNull()
    expect(referenceNeedsReplace(frozenShot, frozenSet, frozenAssets)).toBe(false)
    expect(JSON.stringify({ frozenSet, frozenShot, frozenAssets })).toBe(before)
  })

  it('exports the parent-owned async mutation contract', () => {
    expectTypeOf<ReferenceMutation>().toEqualTypeOf<(action: (current: Board) => Promise<Board>) => Promise<boolean>>()
  })
})