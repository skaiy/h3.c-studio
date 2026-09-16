import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, setAuthToken } from './api'

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

describe('take HTTP helpers', () => {
  it('encodes path components, uses bodyless operations and shares authentication', async () => {
    // Ephemeral fixture only; boolean assertions avoid printing credentials on failure.
    const credential = crypto.randomUUID()
    setAuthToken(credential)
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await api.takes('board #1', 'shot ?')
    await api.selectTake('board #1', 'shot ?', 'take #2')
    await api.deleteTake('board #1', 'shot ?', 'take #2')
    await api.deleteVideo('video #2.mp4')
    const base = '/api/boards/board%20%231/shots/shot%20%3F/takes'
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      base, `${base}/take%20%232/select`, `${base}/take%20%232`, '/api/videos/video%20%232.mp4',
    ])
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'POST', 'DELETE', 'DELETE'])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.body === undefined).toBe(true)
      expect(new Headers(init?.headers).get('Authorization') === `Bearer ${credential}`).toBe(true)
    }
  })

  it.each([409, 503])('propagates a %i failure rather than treating a rejected delete as successful', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'Take is referenced' }), { status })))
    await expect(api.deleteTake('b', 's', 't')).rejects.toEqual(new ApiError(status, 'Take is referenced'))
  })
})