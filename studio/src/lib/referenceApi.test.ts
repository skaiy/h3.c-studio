import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { api, ApiError, setAuthToken } from './api'
import type { Board, Job, ReferenceAsset, ReferenceSet, ReferenceSetFields, ReferenceSnapshot, Shot, Take } from './api'

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

const boardId = 'board #/一?'
const shotId = 'shot /?'
const setId = 'set #/?'
const assetId = 'asset #/?'
const base = '/api/boards/board%20%23%2F%E4%B8%80%3F'
const setPath = `${base}/reference-sets/set%20%23%2F%3F`
const boardRevision = 1234.125
const setRevision = 7
const fields: ReferenceSetFields = {
  name: 'Character', kind: 'character', image_asset_ids: ['image-2', 'image-1'],
  audio_asset_ids: ['audio-2', 'audio-1'], notes: 'Keep this order.',
}
const referenceSet: ReferenceSet = { ...fields, id: setId, revision: setRevision, missing_asset_ids: [] }
const asset: ReferenceAsset = {
  id: assetId, filename: 'asset-image.png', kind: 'image', size: 128,
  sha256: '0'.repeat(64), created_at: 1234, width: 64, height: 64, duration: null, missing: false,
}
const board: Board = {
  id: boardId, name: 'Project', chain: false, shots: [], status: 'idle', result: null,
  createdAt: 1234, modifiedAt: boardRevision + 1, assets: [asset], reference_sets: [referenceSet],
}
const writes: {
  name: string
  run: () => Promise<Board>
  url: string
  method: string
  body?: Record<string, unknown>
}[] = [
  {
    name: 'import image', run: () => api.importReferenceAsset(boardId, 'upload #一.png', 'image', boardRevision),
    url: `${base}/assets`, method: 'POST',
    body: { filename: 'upload #一.png', kind: 'image', expected_board_revision: boardRevision },
  },
  {
    name: 'import audio', run: () => api.importReferenceAsset(boardId, 'upload #一.wav', 'audio', boardRevision),
    url: `${base}/assets`, method: 'POST',
    body: { filename: 'upload #一.wav', kind: 'audio', expected_board_revision: boardRevision },
  },
  {
    name: 'delete asset', run: () => api.deleteReferenceAsset(boardId, assetId, boardRevision),
    url: `${base}/assets/asset%20%23%2F%3F?expected_board_revision=1234.125`, method: 'DELETE',
  },
  {
    name: 'create set', run: () => api.createReferenceSet(boardId, fields, boardRevision),
    url: `${base}/reference-sets`, method: 'POST', body: { ...fields, expected_board_revision: boardRevision },
  },
  {
    name: 'update set', run: () => api.updateReferenceSet(boardId, setId, fields, boardRevision, setRevision),
    url: setPath, method: 'PUT',
    body: { ...fields, expected_board_revision: boardRevision, expected_set_revision: setRevision },
  },
  {
    name: 'delete set', run: () => api.deleteReferenceSet(boardId, setId, boardRevision),
    url: `${setPath}?expected_board_revision=1234.125`, method: 'DELETE',
  },
  {
    name: 'apply set', run: () => api.applyReferenceSet(boardId, shotId, setId, boardRevision, setRevision),
    url: `${base}/shots/shot%20%2F%3F/reference-sets/set%20%23%2F%3F/apply`, method: 'POST',
    body: { expected_board_revision: boardRevision, expected_set_revision: setRevision, replace_existing: false },
  },
]

describe('reference HTTP contract', () => {
  it.each(writes)('$name encodes routes, sends revisions and returns the complete board with shared auth', async ({ run, url, method, body }) => {
    // Generated in memory; boolean assertions never print auth material on failure.
    const credential = crypto.randomUUID()
    setAuthToken(credential)
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(board)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(run()).resolves.toEqual(board)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [actualUrl, init] = fetchMock.mock.calls[0]
    expect(actualUrl).toBe(url)
    expect(init?.method).toBe(method)
    expect(new Headers(init?.headers).get('Authorization') === `Bearer ${credential}`).toBe(true)
    if (body) {
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toEqual(body)
    } else {
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false)
    }
  })

  it('provides public, encoded, bodyless asset and set reads', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([asset])))
      .mockResolvedValueOnce(new Response(JSON.stringify([referenceSet])))
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.assets(boardId)).resolves.toEqual([asset])
    await expect(api.referenceSets(boardId)).resolves.toEqual([referenceSet])
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${base}/assets`, `${base}/reference-sets`])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.body).toBeUndefined()
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    }
  })

  it('uses the latest optional token for reads and writes instead of caching it', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const first = crypto.randomUUID()
    const second = crypto.randomUUID()
    setAuthToken(first)
    await api.assets(boardId)
    setAuthToken(second)
    await api.referenceSets(boardId)
    setAuthToken('')
    await api.deleteReferenceAsset(boardId, assetId, boardRevision)
    const auth = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization'))
    expect(auth[0] === `Bearer ${first}`).toBe(true)
    expect(auth[1] === `Bearer ${second}`).toBe(true)
    expect(auth[2] === null).toBe(true)
  })

  it.each([false, true])('sends replace_existing=%s only as explicitly supplied', async (replaceExisting) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(board)))
    vi.stubGlobal('fetch', fetchMock)
    await api.applyReferenceSet(boardId, shotId, setId, boardRevision, setRevision, replaceExisting)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      expected_board_revision: boardRevision, expected_set_revision: setRevision, replace_existing: replaceExisting,
    })
  })

  it('sends only editable fields even when supplied a complete set, without mutating it', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(board)))
    vi.stubGlobal('fetch', fetchMock)
    const original = JSON.stringify(referenceSet)
    await api.createReferenceSet(boardId, referenceSet, boardRevision)
    await api.updateReferenceSet(boardId, setId, referenceSet, boardRevision, setRevision)
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { ...fields, expected_board_revision: boardRevision },
      { ...fields, expected_board_revision: boardRevision, expected_set_revision: setRevision },
    ])
    expect(JSON.stringify(referenceSet)).toBe(original)
  })

  it('query-encodes numeric revisions including exponent signs', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(board)))
    vi.stubGlobal('fetch', fetchMock)
    await api.deleteReferenceAsset('b', 'a', 1e21)
    await api.deleteReferenceSet('b', 'r', 1e21)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/boards/b/assets/a?expected_board_revision=1e%2B21',
      '/api/boards/b/reference-sets/r?expected_board_revision=1e%2B21',
    ])
  })

  it('keeps reference metadata optional for old API responses and nullable snapshots', () => {
    expectTypeOf<Board['assets']>().toEqualTypeOf<ReferenceAsset[] | undefined>()
    expectTypeOf<Board['reference_sets']>().toEqualTypeOf<ReferenceSet[] | undefined>()
    expectTypeOf<Shot['reference_snapshot_missing']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<Shot['reference_snapshot']>().toEqualTypeOf<ReferenceSnapshot | null | undefined>()
    expectTypeOf<Take['reference_snapshot']>().toEqualTypeOf<ReferenceSnapshot | null | undefined>()
    expectTypeOf<Job['reference_snapshot']>().toEqualTypeOf<ReferenceSnapshot | null | undefined>()
  })
})

describe('reference HTTP failures', () => {
  describe.each([400, 401, 404, 409, 422, 503])('status %i', (status) => {
    it.each(writes)('$name rejects without retrying or fetching a fresh revision', async ({ run }) => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
        JSON.stringify({ detail: 'Reference operation rejected' }), { status },
      ))
      vi.stubGlobal('fetch', fetchMock)
      await expect(run()).rejects.toEqual(new ApiError(status, 'Reference operation rejected'))
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  it('sanitizes echoed auth and ignores validation input, context, headers and logs', async () => {
    const credential = crypto.randomUUID()
    const privateInput = crypto.randomUUID()
    setAuthToken(credential)
    const payload = {
      detail: [{ msg: `stale revision ${credential}`, input: privateInput, ctx: { token: privateInput } }],
      headers: { authorization: privateInput }, log: [privateInput],
    }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 409 })))
    const error: unknown = await api.applyReferenceSet('b', 's', 'r', 1, 1).catch((error: unknown) => error)
    expect(error instanceof ApiError).toBe(true)
    const message = error instanceof Error ? error.message : ''
    expect(message === '409 stale revision [redacted]').toBe(true)
    expect(message.includes(credential) || message.includes(privateInput)).toBe(false)
  })

  it('redacts unrelated bearer strings, secret fields and URLs in messages', async () => {
    const ephemeral = crypto.randomUUID()
    const payload = { detail: `Bearer ${ephemeral}; api_key=${ephemeral}; https://invalid.example/${ephemeral}` }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 400 })))
    const error: unknown = await api.importReferenceAsset('b', 'file.png', 'image', 1).catch((error: unknown) => error)
    const message = error instanceof Error ? error.message : ''
    expect(error instanceof ApiError).toBe(true)
    expect(message.includes(ephemeral)).toBe(false)
    expect(message.includes('[redacted]') && message.includes('[URL]')).toBe(true)
  })

  it.each([
    '<html>proxy failed</html>',
    JSON.stringify({ detail: '<html>proxy failed</html>' }),
    JSON.stringify({ detail: 'Traceback (most recent call last)' }),
    JSON.stringify({ unexpected: 'not an API message' }),
  ])('uses a safe fallback for non-message responses: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 503 })))
    await expect(api.deleteReferenceSet('b', 'r', 1)).rejects.toEqual(new ApiError(503, 'Request failed'))
  })

  it('propagates transport failure without retrying', async () => {
    const failure = new TypeError('Network unavailable')
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(failure)
    vi.stubGlobal('fetch', fetchMock)
    await expect(api.createReferenceSet('b', fields, 1)).rejects.toBe(failure)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})