import type { Shot } from './api'

export function selectedTake(shot: Shot | null | undefined) {
  return shot?.takes?.find((take) => take.id === shot.selected_take_id) ?? null
}

/** Only pre-take API responses may fall back to the legacy output projection. */
export function selectedOutput(shot: Shot | null | undefined): string | null {
  if (!shot) return null
  if (shot.takes !== undefined || shot.selected_take_id !== undefined) return selectedTake(shot)?.output ?? null
  return shot.output
}

export function selectedOutputMissing(shot: Shot): boolean {
  return !!(shot.output_missing || selectedTake(shot)?.missing ||
    (shot.selected_take_id && !selectedTake(shot)))
}