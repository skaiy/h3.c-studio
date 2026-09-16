import { describe, expect, it } from 'vitest'
import type { Shot, Take } from './api'
import { selectedOutput, selectedOutputMissing, selectedTake } from './takes'

const take: Take = {
  id: 'chosen', shot_id: 'shot', job_id: null, output: 'canonical.mp4', created_at: null,
  request: null, request_unknown: true, source_take_id: null, source_unknown: true,
  legacy: true, model_name: null, missing: false,
}
const shot: Shot = {
  id: 'shot', prompt: '', width: 512, height: 512, seconds: 5, steps: 20, layers: 45,
  reuse: 2, seed: 42, first_frame: null, last_frame: null, status: 'error',
  job_id: null, output: 'legacy.mp4',
}

describe('canonical take projection', () => {
  it('permits output-only compatibility only for an old API shape', () => {
    expect(selectedOutput(shot)).toBe('legacy.mp4')
    expect(selectedOutputMissing(shot)).toBe(false)
    expect(selectedOutput({ ...shot, takes: [] })).toBeNull()
    expect(selectedOutput({ ...shot, selected_take_id: null })).toBeNull()
    expect(selectedOutput(null)).toBeNull()
    expect(selectedTake(undefined)).toBeNull()
  })

  it('uses the adopted take regardless of stale output projection and latest job status', () => {
    const current = { ...shot, takes: [take], selected_take_id: take.id }
    expect(selectedTake(current)).toBe(take)
    expect(selectedOutput(current)).toBe(take.output)
    expect(selectedOutputMissing(current)).toBe(false)
  })

  it('never falls back from a dangling selection and reports both missing flags', () => {
    const current = { ...shot, takes: [take], selected_take_id: 'lost-take' }
    expect(selectedOutput(current)).toBeNull()
    expect(selectedOutputMissing(current)).toBe(true)
    expect(selectedOutputMissing({ ...current, selected_take_id: take.id, output_missing: true })).toBe(true)
    expect(selectedOutputMissing({ ...current, selected_take_id: take.id, takes: [{ ...take, missing: true }] })).toBe(true)
  })
})