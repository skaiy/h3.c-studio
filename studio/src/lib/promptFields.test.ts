import { describe, expect, it } from 'vitest'
import { type Shot } from './api'
import {
  FIELD_DEFAULTS, FIELD_KEYS, assembleStructuredPrompt, changePromptMode,
  editSimplePrompt, editStructuredField, emptyFields, getConditioningIssues,
  getPromptFields, isImportedScene,
} from './promptFields'

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'a', prompt: 'A river at dawn.', width: 768, height: 768, seconds: 5,
    steps: 20, layers: 45, reuse: 2, seed: 42, first_frame: null, last_frame: null,
    status: 'idle', output: null, job_id: null, ...overrides,
  }
}

describe('persisted structured prompts', () => {
  it('imports arbitrary prose verbatim as scene without guessing clause boundaries', () => {
    const prompt = '  Camera: a sign says “Action: go!”.\nAudio: someone reads it aloud.  '
    const original = shot({ prompt })
    const patch = changePromptMode(original, 'structured')
    expect(patch).not.toHaveProperty('prompt')
    expect(patch.prompt_fields).toEqual({ ...emptyFields(), scene: prompt })
    expect(isImportedScene({ ...original, ...patch })).toBe(true)
    expect(original.prompt_fields).toBeUndefined()
  })

  it('does not create a default prompt just by switching modes on an empty shot', () => {
    const original = shot({ prompt: '' })
    const structured = { ...original, ...changePromptMode(original, 'structured') }
    const simple = { ...structured, ...changePromptMode(structured, 'simple') }
    expect(structured.prompt).toBe('')
    expect(simple.prompt).toBe('')
    expect(structured.prompt_fields).toEqual(emptyFields())
    expect(isImportedScene(structured)).toBe(false)
  })

  it('preserves all saved fields and prompt across mode switches and JSON round-trip', () => {
    const fields = { scene: '夜の街', action: '歩く', camera: 'pan', look: 'film', audio: 'rain' }
    const original = shot({ prompt_mode: 'structured', prompt_fields: fields, prompt: assembleStructuredPrompt(fields) })
    const simple = { ...original, ...changePromptMode(original, 'simple') }
    const reloaded: Shot = JSON.parse(JSON.stringify(simple))
    const structured = { ...reloaded, ...changePromptMode(reloaded, 'structured') }
    expect(structured).toEqual(original)
    expect(getPromptFields(structured)).not.toBe(structured.prompt_fields)
    expect(isImportedScene(structured)).toBe(false)
  })

  it('invalidates stale structured fields on simple edits and imports the new prose on reentry', () => {
    const original = shot({ prompt_mode: 'structured', prompt_fields: { ...emptyFields(), scene: 'old scene', camera: 'old camera' } })
    const edited = { ...original, ...editSimplePrompt('New arbitrary text. Camera: not a field.') }
    expect(edited.prompt_fields).toBeNull()
    expect(edited.prompt_mode).toBe('simple')
    const structured = { ...edited, ...changePromptMode(edited, 'structured') }
    expect(structured.prompt_fields).toEqual({ ...emptyFields(), scene: edited.prompt })
    expect(structured.prompt).toBe(edited.prompt)
  })

  it('persists all five fields and an assembled default-filled prompt on the first field edit', () => {
    const original = shot({ prompt: '' })
    const edited = { ...original, ...editStructuredField(original, 'camera', 'slow pan') }
    expect(edited.prompt_mode).toBe('structured')
    expect(edited.prompt_fields).toEqual({ ...emptyFields(), camera: 'slow pan' })
    expect(edited.prompt).toBe(
      'Scene: a softly lit interior room. Action: the subject moves naturally. Camera: slow pan. Look: realistic, cinematic lighting. Audio: ambient sound matching the scene.',
    )
    const reloaded: Shot = JSON.parse(JSON.stringify(edited))
    expect(getPromptFields(reloaded)).toEqual(edited.prompt_fields)
    expect(assembleStructuredPrompt(getPromptFields(reloaded))).toBe(edited.prompt)
  })

  it('retains imported prose when editing a different structured field', () => {
    const original = shot({ prompt: 'A custom paragraph\nwith dialogue: “hello”.' })
    const edited = editStructuredField(original, 'action', 'waves')
    expect(edited.prompt_fields?.scene).toBe(original.prompt)
    expect(edited.prompt).toContain(`Scene: ${original.prompt}`)
    expect(edited.prompt).toContain('Action: waves.')
    expect(original.prompt_fields).toBeUndefined()
  })

  it('uses defaults for whitespace without changing raw field values or doubling punctuation', () => {
    const fields = { ...emptyFields(), scene: '  Rain!  ', action: '\n\t', audio: '静か。' }
    const prompt = assembleStructuredPrompt(fields)
    expect(prompt).toContain('Scene: Rain! Action:')
    expect(prompt).toContain(FIELD_DEFAULTS.action)
    expect(prompt).toContain('Audio: 静か。')
    expect(fields.scene).toBe('  Rain!  ')
    for (const key of FIELD_KEYS) expect(getPromptFields(shot())[key]).toBeTypeOf('string')
  })
})

describe('basic conditioning invariants', () => {
  it('treats absent optional fields as empty/false and only chains subsequent unanchored shots', () => {
    expect(getConditioningIssues(shot())).toEqual({ errors: [], warnings: [], autoChain: false })
    expect(getConditioningIssues(shot(), true, false).autoChain).toBe(true)
    expect(getConditioningIssues(shot(), true, true).autoChain).toBe(false)
    expect(getConditioningIssues(shot(), false, false).autoChain).toBe(false)
    expect(getConditioningIssues(shot({ first_frame: 'first.png' }), true, false).autoChain).toBe(false)
  })

  it.each(['first_frame', 'last_frame'] as const)('rejects %s with any references', (anchor) => {
    for (const references of [{ ref_images: ['ref.png'] }, { ref_audio: ['ref.wav'] }]) {
      const issues = getConditioningIssues(shot({ [anchor]: 'anchor.png', ...references }))
      expect(issues.errors).toContain('conditioningConflict')
    }
  })

  it('requires a reference image for audio, not an anchor or an automatic chain', () => {
    const audio = shot({ ref_audio: ['ref.wav'], first_frame: 'first.png' })
    expect(getConditioningIssues(audio, true, false).errors).toContain('audioNeedsImage')
    const issues = getConditioningIssues(shot({ ref_images: ['ref.png'], ref_audio: ['ref.wav'] }), true, false)
    expect(issues).toEqual({ errors: [], warnings: ['chainSkippedRefs'], autoChain: false })
  })

  it('skips automatic chaining for image or audio references without mutating the shot', () => {
    for (const references of [{ ref_images: ['ref.png'] }, { ref_audio: ['ref.wav'] }]) {
      const original = shot(references)
      const before = JSON.stringify(original)
      expect(getConditioningIssues(original, true, false).warnings).toContain('chainSkippedRefs')
      expect(getConditioningIssues(original, true, false).autoChain).toBe(false)
      expect(getConditioningIssues(original, false, false).warnings).not.toContain('chainSkippedRefs')
      expect(JSON.stringify(original)).toBe(before)
    }
  })

  it('warns empirically about audio plus token reduction without blocking generation', () => {
    const original = shot({ ref_images: ['ref.png'], ref_audio: ['ref.wav'], token_reduction: true })
    expect(getConditioningIssues(original)).toEqual({ errors: [], warnings: ['tokenReductionAudioWarning'], autoChain: false })
    expect(getConditioningIssues({ ...original, token_reduction: false }).warnings).toEqual([])
    expect(getConditioningIssues({ ...original, ref_audio: [] }).warnings).toEqual([])
  })

  it('leaves exact reference count limits to the backend', () => {
    const original = shot({ ref_images: Array(10).fill('image.png'), ref_audio: Array(4).fill('audio.wav') })
    expect(getConditioningIssues(original).errors).toEqual([])
  })
})