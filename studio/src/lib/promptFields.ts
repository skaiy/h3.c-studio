import { type PromptFields, type Shot } from './api'

export const FIELD_KEYS = ['scene', 'action', 'camera', 'look', 'audio'] as const
export type FieldKey = (typeof FIELD_KEYS)[number]

// Canonical prompt clauses stay language-independent; editor labels are localized.
const FIELD_LABELS: Record<FieldKey, string> = {
  scene: 'Scene', action: 'Action', camera: 'Camera', look: 'Look', audio: 'Audio',
}
export const FIELD_DEFAULTS: PromptFields = {
  scene: 'a softly lit interior room',
  action: 'the subject moves naturally',
  camera: 'static medium shot',
  look: 'realistic, cinematic lighting',
  audio: 'ambient sound matching the scene',
}

type PromptSource = Pick<Shot, 'prompt' | 'prompt_mode' | 'prompt_fields'>

export function emptyFields(): PromptFields {
  return { scene: '', action: '', camera: '', look: '', audio: '' }
}

/** Never guess how arbitrary prose (including clause-like text) should be parsed. */
export function getPromptFields(shot: PromptSource): PromptFields {
  return shot.prompt_fields ? { ...shot.prompt_fields } : { ...emptyFields(), scene: shot.prompt }
}

export function assembleStructuredPrompt(fields: PromptFields): string {
  return FIELD_KEYS.map((key) => {
    const value = fields[key].trim() || FIELD_DEFAULTS[key]
    return `${FIELD_LABELS[key]}: ${value}${/[.!?。！？]$/.test(value) ? '' : '.'}`
  }).join(' ')
}

/** Mode changes only affect the editor, never the generation prompt itself. */
export function changePromptMode(shot: PromptSource, mode: NonNullable<Shot['prompt_mode']>): Partial<Shot> {
  return mode === 'structured'
    ? { prompt_mode: mode, prompt_fields: getPromptFields(shot) }
    : { prompt_mode: mode }
}

export function editSimplePrompt(prompt: string): Partial<Shot> {
  return { prompt, prompt_mode: 'simple', prompt_fields: null }
}

export function editStructuredField(shot: PromptSource, key: FieldKey, value: string): Partial<Shot> {
  const fields = { ...getPromptFields(shot), [key]: value }
  return { prompt_mode: 'structured', prompt_fields: fields, prompt: assembleStructuredPrompt(fields) }
}

export function isImportedScene(shot: PromptSource): boolean {
  const fields = getPromptFields(shot)
  return !!shot.prompt.trim() && fields.scene === shot.prompt &&
    FIELD_KEYS.every((key) => key === 'scene' || fields[key] === '')
}

export type ConditioningError = 'conditioningConflict' | 'audioNeedsImage'
export type ConditioningWarning = 'chainSkippedRefs' | 'tokenReductionAudioWarning'
type ConditioningSource = Pick<Shot, 'ref_images' | 'ref_audio' | 'first_frame' | 'last_frame' | 'token_reduction'>

/** Basic engine invariants only; exact counts and media validation remain server-owned. */
export function getConditioningIssues(shot: ConditioningSource, chain = false, isFirst = true) {
  const hasImages = !!shot.ref_images?.length
  const hasAudio = !!shot.ref_audio?.length
  const hasRefs = hasImages || hasAudio
  const errors: ConditioningError[] = []
  const warnings: ConditioningWarning[] = []
  if (hasRefs && (shot.first_frame || shot.last_frame)) errors.push('conditioningConflict')
  if (hasAudio && !hasImages) errors.push('audioNeedsImage')
  if (chain && !isFirst && hasRefs) warnings.push('chainSkippedRefs')
  if (shot.token_reduction && hasAudio) warnings.push('tokenReductionAudioWarning')
  return { errors, warnings, autoChain: chain && !isFirst && !hasRefs && !shot.first_frame }
}