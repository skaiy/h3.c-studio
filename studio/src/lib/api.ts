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
  token_reduction: boolean
  turbo: boolean
  checkpoint_after_step: number | null
  resume: string | null
  label: string | null
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

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init)
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return r.json()
}

export interface Shot {
  id: string
  prompt: string
  width: number
  height: number
  seconds: number
  steps: number
  layers: number
  reuse: number
  seed: number
  turbo?: boolean
  first_frame: string | null
  last_frame: string | null
  status: string
  output: string | null
  job_id: string | null
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
  job: (id: string) => req<Job>(`/api/jobs/${id}`),
  generate: (params: GenParams) =>
    req<{ job_id: string }>('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
  cancel: (id: string) => req(`/api/jobs/${id}`, { method: 'DELETE' }),
  uploads: () => req<string[]>('/api/uploads'),
  upload: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<{ name: string }>('/api/upload', { method: 'POST', body: fd })
  },
  extractLastFrame: (name: string) =>
    req<{ name: string }>(`/api/extract-last-frame/${encodeURIComponent(name)}`, { method: 'POST' }),
  boards: () => req<BoardSummary[]>('/api/boards'),
  board: (id: string) => req<Board>(`/api/boards/${id}`),
  saveBoard: (b: Board) =>
    req<Board>('/api/boards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    }),
  deleteBoard: (id: string) => req(`/api/boards/${id}`, { method: 'DELETE' }),
  duplicateBoard: (id: string) =>
    req<Board>(`/api/boards/${id}/duplicate`, { method: 'POST' }),
  runBoard: (id: string) => req(`/api/boards/${id}/run`, { method: 'POST' }),
  concatBoard: (id: string) =>
    req<{ output: string }>(`/api/boards/${id}/concat`, { method: 'POST' }),
}
