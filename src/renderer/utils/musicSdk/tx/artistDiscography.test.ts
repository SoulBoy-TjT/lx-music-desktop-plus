import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  txAlbumPageResponses,
  txAlbumTrackPageResponses,
  txArtistSearchResponse,
  txFuzzyArtistSearchResponse,
} from './__fixtures__/artistDiscography'
import { createTxArtistCatalogAdapter } from './artistDiscography'

const { httpFetchMock } = vi.hoisted(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { getElementsByTagName: () => [{ innerText: '' }] },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      DOMParser: class {
        parseFromString(value: string) {
          return { body: { textContent: value } }
        }
      },
      innerWidth: 1920,
    },
  })
  return { httpFetchMock: vi.fn() }
})

vi.mock('../../request', () => ({
  httpFetch: httpFetchMock,
}))

interface MockRequestOptions {
  json?: boolean
  body?: {
    req?: {
      module?: string
      method?: string
      param?: Record<string, unknown>
    }
  }
}

const response = (body: unknown, cancelHttp = vi.fn()) => ({
  promise: Promise.resolve({ statusCode: 200, body }),
  cancelHttp,
})

const failedRequest = () => ({
  promise: Promise.reject(new Error('fixture network failure')),
  cancelHttp: vi.fn(),
})

const getParam = (options?: MockRequestOptions) => options?.body?.req?.param ?? {}

const withReportedTotal = (page: typeof txAlbumPageResponses[number], total: number) => ({
  ...page,
  req: {
    ...page.req,
    data: {
      ...page.req.data,
      total,
    },
  },
})

describe('QQ Music artist catalog adapter', () => {
  beforeEach(() => {
    httpFetchMock.mockReset()
  })

  it('resolves only the first exact artist-name match', async() => {
    httpFetchMock.mockReturnValue(response(txArtistSearchResponse))

    await expect(createTxArtistCatalogAdapter().resolveArtist('  Fixture Artist  ')).resolves.toEqual({
      source: 'tx',
      id: 'fixture-artist-mid',
      name: 'Fixture Artist',
      avatar: 'https://img.example.test/artist.jpg',
      albumCount: 3,
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
    expect(httpFetchMock.mock.calls[0]?.[0]).toContain('w=Fixture%20Artist')
    expect(httpFetchMock.mock.calls[0]?.[0]).toContain('t=9')
  })

  it('rejects fuzzy-only results and does not interpret a URL as an artist ID', async() => {
    httpFetchMock.mockReturnValue(response(txFuzzyArtistSearchResponse))
    const adapter = createTxArtistCatalogAdapter()

    await expect(adapter.resolveArtist('Fixture Artist')).rejects.toMatchObject({
      issue: { code: 'artist_not_found', stage: 'artist' },
    })
    await expect(adapter.resolveArtist('https://y.qq.com/n/ryqq/singer/example'))
      .rejects.toMatchObject({ issue: { code: 'invalid_artist_ref', stage: 'input' } })
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('collects every artist album page with continuous begin offsets', async() => {
    const begins: unknown[] = []
    httpFetchMock.mockImplementation((_url: string, options?: MockRequestOptions) => {
      const param = getParam(options)
      begins.push(param.begin)
      return response(param.begin == 0 ? txAlbumPageResponses[0] : txAlbumPageResponses[1])
    })

    const result = await createTxArtistCatalogAdapter().getArtistAlbums('fixture-artist-mid')

    expect(begins).toEqual([0, 2])
    expect(result).toMatchObject({ reportedTotal: 3, complete: true, issues: [] })
    expect(result.items.map(album => album.id)).toEqual([
      'fixture-album-mid-1',
      'fixture-album-mid-2',
      'fixture-album-mid-3',
    ])
    expect(httpFetchMock.mock.calls.every(([, options]) => {
      const requestOptions = options as MockRequestOptions
      const request = requestOptions.body?.req
      return requestOptions.json === true &&
        request?.module == 'music.musichallAlbum.AlbumListServer' &&
        request.method == 'GetAlbumList' &&
        request.param?.singerMid == 'fixture-artist-mid'
    })).toBe(true)
  })

  it('loads complete album details by albumMid and emits valid ordered tracks', async() => {
    const begins: unknown[] = []
    httpFetchMock.mockImplementation((_url: string, options?: MockRequestOptions) => {
      const param = getParam(options)
      begins.push(param.begin)
      return response(param.begin == 0 ? txAlbumTrackPageResponses[0] : txAlbumTrackPageResponses[1])
    })

    const result = await createTxArtistCatalogAdapter().getAlbumTracks('fixture-album-mid-1')

    expect(begins).toEqual([0, 2])
    expect(result).toMatchObject({ reportedTotal: 3, complete: true, issues: [] })
    expect(result.items.map(track => track.id)).toEqual([
      'tx_fixture-song-mid-1',
      'tx_fixture-song-mid-2',
      'tx_fixture-song-mid-3',
    ])
    expect(result.items[0]).toMatchObject({
      source: 'tx',
      meta: {
        albumId: 'fixture-album-mid-1',
        trackNumber: 1,
        trackTotal: 3,
      },
    })
    expect(httpFetchMock.mock.calls.every(([, options]) => {
      const requestOptions = options as MockRequestOptions
      const request = requestOptions.body?.req
      return requestOptions.json === true &&
        request?.module == 'music.musichallAlbum.AlbumSongList' &&
        request.method == 'GetAlbumSongList' &&
        request.param?.albumMid == 'fixture-album-mid-1'
    })).toBe(true)
  })

  it('retains a collected prefix after three finite retries fail', async() => {
    const begins: unknown[] = []
    httpFetchMock.mockImplementation((_url: string, options?: MockRequestOptions) => {
      const begin = getParam(options).begin
      begins.push(begin)
      return begin == 0 ? response(txAlbumPageResponses[0]) : failedRequest()
    })

    const result = await createTxArtistCatalogAdapter().getArtistAlbums('fixture-artist-mid')

    expect(begins).toEqual([0, 2, 2, 2])
    expect(result.items).toHaveLength(2)
    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'provider_unavailable',
      stage: 'albums',
      retryable: true,
    }))
  })

  it('cancels the active HTTP request and does not retry after AbortSignal fires', async() => {
    const controller = new AbortController()
    let rejectPending: ((reason?: unknown) => void) | undefined
    const cancelHttp = vi.fn(() => {
      rejectPending?.(new Error('fixture cancelled'))
    })
    httpFetchMock.mockReturnValue({
      promise: new Promise((_resolve, reject) => {
        rejectPending = reject
      }),
      cancelHttp,
    })

    const task = createTxArtistCatalogAdapter().getArtistAlbums('fixture-artist-mid', controller.signal)
    await vi.waitFor(() => {
      expect(httpFetchMock).toHaveBeenCalledTimes(1)
    })
    controller.abort()

    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelHttp).toHaveBeenCalledTimes(1)
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops and marks the catalog partial when QQ repeats a page', async() => {
    const repeatedPage = withReportedTotal(txAlbumPageResponses[0], 4)
    const begins: unknown[] = []
    httpFetchMock.mockImplementation((_url: string, options?: MockRequestOptions) => {
      begins.push(getParam(options).begin)
      return response(repeatedPage)
    })

    const result = await createTxArtistCatalogAdapter().getArtistAlbums('fixture-artist-mid')

    expect(begins).toEqual([0, 2])
    expect(result.items).toHaveLength(2)
    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'pagination_inconsistent',
      stage: 'albums',
    }))
  })
})
