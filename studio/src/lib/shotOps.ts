import { type Shot } from '@/lib/api'

/** Insert `shot` at index `at`, returning a new array. */
export function insertShotAt(shots: Shot[], at: number, shot: Shot): Shot[] {
  const next = [...shots]
  next.splice(at, 0, shot)
  return next
}

/** Duplicate the shot at index `i` (via `makeCopy`), inserting the copy right after it. */
export function duplicateShotAt(shots: Shot[], i: number, makeCopy: (src: Shot) => Shot): Shot[] {
  const next = [...shots]
  next.splice(i + 1, 0, makeCopy(shots[i]))
  return next
}

/** Remove the shot at index `i`, returning a new array. */
export function removeShotAt(shots: Shot[], i: number): Shot[] {
  return shots.filter((_, xi) => xi !== i)
}

/** Move the shot at index `from` to index `to` (standard reorder algorithm). */
export function moveShot(shots: Shot[], from: number, to: number): Shot[] {
  const next = [...shots]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Compute the selected index after deleting the shot at `deletedIndex`.
 * `preDeleteLength` is the shot count *before* the deletion.
 */
export function nextSelectedAfterDelete(selected: number, deletedIndex: number, preDeleteLength: number): number {
  const postDeleteLastIndex = preDeleteLength - 2
  return Math.max(0, selected > deletedIndex ? selected - 1 : Math.min(selected, postDeleteLastIndex))
}
