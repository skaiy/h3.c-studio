import type { Board } from './api'

interface Draft {
  board: Board
  version: number
  dirty: boolean
  error: Error | null
  flight: Promise<Board> | null
  timer: ReturnType<typeof setTimeout> | null
}

/** Per-board drafts survive route switches. Saves are serialized against server revisions. */
export class BoardDrafts {
  private drafts = new Map<string, Draft>()
  private listeners = new Set<() => void>()
  private revision = 0
  private save: (board: Board) => Promise<Board>

  constructor(save: (board: Board) => Promise<Board>) { this.save = save }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  snapshot = () => this.revision
  private notify() {
    this.revision++
    this.listeners.forEach((listener) => listener())
  }
  get(id: string | undefined) { return id ? this.drafts.get(id)?.board ?? null : null }
  state(id: string | undefined) {
    const draft = id ? this.drafts.get(id) : undefined
    return { dirty: draft?.dirty ?? false, saving: !!draft?.flight, error: draft?.error ?? null }
  }
  hasUnsaved() { return [...this.drafts.values()].some((d) => d.dirty || d.flight) }

  receive(board: Board) {
    const prior = this.drafts.get(board.id)
    // An old poll must not erase a local edit, failed save, or a newer save response.
    if (prior && (prior.dirty || prior.flight || prior.board.modifiedAt > board.modifiedAt)) return
    this.drafts.set(board.id, { board, version: 0, dirty: false, error: null, flight: null, timer: null })
    this.notify()
  }

  edit(id: string, update: (board: Board) => Board) {
    const draft = this.drafts.get(id)
    if (!draft) return
    draft.board = update(draft.board)
    draft.version++
    draft.dirty = true
    draft.error = null
    if (draft.timer) clearTimeout(draft.timer)
    draft.timer = setTimeout(() => { void this.flush(id).catch(() => {}) }, 800)
    this.notify()
  }

  async flush(id: string): Promise<Board> {
    const draft = this.drafts.get(id)
    if (!draft) throw new Error('Board is not loaded')
    if (draft.timer) clearTimeout(draft.timer)
    draft.timer = null
    if (draft.flight) return draft.flight
    if (!draft.dirty) return draft.board
    draft.error = null
    draft.flight = Promise.resolve().then(async () => {
      try {
        while (draft.dirty) {
          const version = draft.version
          const saved = await this.save(draft.board)
          if (version === draft.version) {
            draft.board = saved
            draft.dirty = false
          } else {
            // More edits arrived during the request: keep them, advance only the revision.
            draft.board = { ...draft.board, modifiedAt: saved.modifiedAt, createdAt: saved.createdAt }
          }
          this.notify()
        }
        return draft.board
      } catch (error) {
        draft.error = error instanceof Error ? error : new Error('Save failed')
        throw draft.error
      } finally {
        draft.flight = null
        this.notify()
      }
    })
    this.notify()
    return draft.flight
  }

  /** Only after explicit user confirmation. Never used as automatic conflict resolution. */
  discard(board: Board) {
    const prior = this.drafts.get(board.id)
    if (prior?.flight) return
    if (prior?.timer) clearTimeout(prior.timer)
    this.drafts.delete(board.id)
    this.receive(board)
  }

  dispose() {
    this.drafts.forEach((draft) => { if (draft.timer) clearTimeout(draft.timer) })
  }
}