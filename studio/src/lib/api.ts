export interface GenParams {
  prompt: string
  width: number
  height: number
  seconds: number | null
  frames: number | null
  steps: number
  layers: number
  reuse: number
  seed: number
  first_frame: string | null
  last_frame: string | null
  ref_images: string[]
  ref_audio: string[]
  token_reduction: boolean
  turbo: boolean
  checkpoint_after_step: number | null
  resume: string | null
  label: string | null
  board_id?: string | null
  shot_id?: string | null
}

export interface GenerateResult {
  job_id: string
  warnings?: string[]
}

export interface PromptFields {
  scene: string
  action: string
  camera: string
  look: string
  audio: string
}

export interface Job {
  id: string
  label: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'interrupted'
  phase: string | null
  done: number
  total: number
  created: number
  started?: number
  finished?: number
  output?: string
  checkpoint?: string
  params: Record<string, unknown>
  log?: string[]
}

export interface VideoItem {
  name: string
  size: number
  mtime: number
  duration: number | null
}

const TOKEN_STORAGE_KEY = 'h3-studio-token'

export function getAuthToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
}

export function setAuthToken(token: string) {
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token)
  else localStorage.removeItem(TOKEN_STORAGE_KEY)
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(`${status} ${message}`)
    this.name = 'ApiError'
    this.status = status
  }
}

// Only read message fields, never serialize validation input, context, headers or logs.
function errorDetail(value: unknown, depth = 0): string {
  if (depth > 3) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => errorDetail(v, depth + 1)).filter(Boolean).join('; ')
  if (value && typeof value === 'object') {
    for (const key of ['detail', 'message', 'msg', 'error'] as const) {
      if (key in value) {
        const detail = errorDetail(Reflect.get(value, key), depth + 1)
        if (detail) return detail
      }
    }
  }
  return ''
}

function safeErrorDetail(value: unknown, token: string): string {
  let message = errorDetail(value)
  if (token) message = message.replaceAll(token, '[redacted]')
  // Proxy HTML / tracebacks are not user-facing API messages.
  if (/<\/?[a-z][^>]*>/i.test(message) || /traceback \(most recent call last\)/i.test(message)) return ''
  return message
    .replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, '[redacted]')
    .replace(/\b(?:[\w-]*(?:token|password|secret)|api[_-]?key)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted]')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/\s+/g, ' ').trim().slice(0, 300)
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken()
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const r = await fetch(url, { ...init, headers })
  if (!r.ok) {
    const payload: unknown = await r.json().catch(() => null)
    throw new ApiError(r.status, safeErrorDetail(payload, token) || 'Request failed')
  }
  return r.json()
}

export interface Shot {
  id: string
  prompt: string
  width: number
  height: number
  seconds: number | null
  steps: number
  layers: number
  reuse: number
  seed: number
  turbo?: boolean
  first_frame: string | null
  last_frame: string | null
  ref_images?: string[]
  ref_audio?: string[]
  frames?: number | null
  token_reduction?: boolean
  checkpoint_after_step?: number | null
  prompt_mode?: 'simple' | 'structured'
  prompt_fields?: PromptFields | null
  status: string
  output: string | null
  job_id: string | null
  takes?: Take[]
  selected_take_id?: string | null
  continuity_state?: 'none' | 'current' | 'unknown' | 'stale'
  stale?: boolean
  output_missing?: boolean
}

/** Historical snapshots may contain unknown/older fields; never fill with live shot inputs. */
export interface Take {
  id: string
  shot_id: string
  job_id: string | null
  output: string
  created_at: number | null
  request: Record<string, unknown> | null
  request_unknown: boolean
  source_take_id: string | null
  source_unknown: boolean
  legacy: boolean
  model_name: string | null
  missing: boolean
}

export interface Board {
  id: string
  name: string
  chain: boolean
  shots: Shot[]
  status: string
  result: string | null
  createdAt: number
  modifiedAt: number
}

export interface BoardSummary {
  id: string
  name: string
  status: string
  result: string | null
  shotCount: number
  doneCount: number
  duration: number
  createdAt: number
  modifiedAt: number
}

export const api = {
  info: () => req<{ info: string }>('/api/info'),
  videos: () => req<VideoItem[]>('/api/videos'),
  jobs: () => req<Job[]>('/api/jobs'),
  job: (id: string) => req<Job>(`/api/jobs/${encodeURIComponent(id)}`),
  generate: (params: GenParams) =>
    req<GenerateResult>('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  generateShot: (boardId: string, shotId: string) =>
    req<GenerateResult>(`/api/boards/${encodeURIComponent(boardId)}/shots/${encodeURIComponent(shotId)}/generate`, { method: 'POST' }),
  takes: (boardId: string, shotId: string) =>
    req<Take[]>(`/api/boards/${encodeURIComponent(boardId)}/shots/${encodeURIComponent(shotId)}/takes`),
  selectTake: (boardId: string, shotId: string, takeId: string) =>
    req<Board>(`/api/boards/${encodeURIComponent(boardId)}/shots/${encodeURIComponent(shotId)}/takes/${encodeURIComponent(takeId)}/select`, { method: 'POST' }),
  deleteTake: (boardId: string, shotId: string, takeId: string) =>
    req<Board>(`/api/boards/${encodeURIComponent(boardId)}/shots/${encodeURIComponent(shotId)}/takes/${encodeURIComponent(takeId)}`, { method: 'DELETE' }),
  deleteVideo: (name: string) => req<{ ok: boolean }>(`/api/videos/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  resumeJob: (jobId: string) =>
    req<GenerateResult>(`/api/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST' }),
  cancel: (id: string) => req(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  uploads: () => req<string[]>('/api/uploads'),
  upload: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<{ name: string }>('/api/upload', { method: 'POST', body: fd })
  },
  extractLastFrame: (name: string) =>
    req<{ name: string }>(`/api/extract-last-frame/${encodeURIComponent(name)}`, { method: 'POST' }),
  boards: () => req<BoardSummary[]>('/api/boards'),
  board: (id: string) => req<Board>(`/api/boards/${encodeURIComponent(id)}`),
  saveBoard: (b: Board) =>
    req<Board>('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }),
  deleteBoard: (id: string) => req(`/api/boards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  duplicateBoard: (id: string) =>
    req<Board>(`/api/boards/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
  runBoard: (id: string) => req(`/api/boards/${encodeURIComponent(id)}/run`, { method: 'POST' }),
  concatBoard: (id: string) =>
    req<{ output: string }>(`/api/boards/${encodeURIComponent(id)}/concat`, { method: 'POST' }),
}
