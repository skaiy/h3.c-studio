import { describe, expect, it } from 'vitest'
import { type Shot } from '@/lib/api'
import { duplicateShotAt, insertShotAt, moveShot, nextSelectedAfterDelete, removeShotAt } from '@/lib/shotOps'

function shot(id: string, overrides: Partial<Shot> = {}): Shot {
  return {
    id, prompt: id, width: 768, height: 768, seconds: 5, steps: 20, layers: 45,
    reuse: 2, seed: 1, turbo: false, first_frame: null, last_frame: null,
    status: 'idle', output: null, job_id: null, ...overrides,
  }
}

describe('insertShotAt', () => {
  it('inserts at the given index without mutating the source array', () => {
    const shots = [shot('a'), shot('b')]
    const next = insertShotAt(shots, 1, shot('x'))
    expect(next.map((s) => s.id)).toEqual(['a', 'x', 'b'])
    expect(shots.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('inserts at the end when at === length', () => {
    const shots = [shot('a')]
    expect(insertShotAt(shots, 1, shot('x')).map((s) => s.id)).toEqual(['a', 'x'])
  })
})

describe('duplicateShotAt', () => {
  it('inserts the copy right after the source shot', () => {
    const shots = [shot('a'), shot('b'), shot('c')]
    const next = duplicateShotAt(shots, 0, (src) => ({ ...src, id: 'a-copy' }))
    expect(next.map((s) => s.id)).toEqual(['a', 'a-copy', 'b', 'c'])
  })

  it('resets generation state on the copy via makeCopy', () => {
    const shots = [shot('a', { status: 'done', output: 'a.mp4', job_id: 'j1' })]
    const next = duplicateShotAt(shots, 0, (src) => ({ ...src, id: 'a-copy', status: 'idle', output: null, job_id: null }))
    expect(next[1]).toMatchObject({ id: 'a-copy', status: 'idle', output: null, job_id: null })
    expect(next[0]).toMatchObject({ status: 'done', output: 'a.mp4' }) // source untouched
  })
})

describe('removeShotAt', () => {
  it('removes only the targeted shot', () => {
    const shots = [shot('a'), shot('b'), shot('c')]
    expect(removeShotAt(shots, 1).map((s) => s.id)).toEqual(['a', 'c'])
  })
})

describe('moveShot', () => {
  it('moves an item forward to land at the target index', () => {
    // Standard reorder semantics: item ends up AT index `to` post-move.
    expect(moveShot(['A', 'B', 'C', 'D'] as unknown as Shot[], 0, 2).map(String)).toEqual(['B', 'C', 'A', 'D'])
  })

  it('moves an item backward to land at the target index', () => {
    expect(moveShot(['A', 'B', 'C', 'D'] as unknown as Shot[], 3, 1).map(String)).toEqual(['A', 'D', 'B', 'C'])
  })

  it('is a no-op when from === to', () => {
    expect(moveShot(['A', 'B', 'C'] as unknown as Shot[], 1, 1).map(String)).toEqual(['A', 'B', 'C'])
  })
})

describe('nextSelectedAfterDelete', () => {
  it('shifts selection left when deleting before the selected shot', () => {
    // shots: [a,b,c], selected=2 (c), delete index 0 (a) -> selection should track c at new index 1
    expect(nextSelectedAfterDelete(2, 0, 3)).toBe(1)
  })

  it('keeps selection when deleting after the selected shot', () => {
    expect(nextSelectedAfterDelete(0, 2, 3)).toBe(0)
  })

  it('clamps to the new last index when the selected shot itself is deleted at the tail', () => {
    // shots: [a,b,c], selected=2 (c), delete index 2 (c) -> clamp to new last index 1 (b)
    expect(nextSelectedAfterDelete(2, 2, 3)).toBe(1)
  })

  it('never goes negative when deleting the only shot', () => {
    expect(nextSelectedAfterDelete(0, 0, 1)).toBe(0)
  })
})
