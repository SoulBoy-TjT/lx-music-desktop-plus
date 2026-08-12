import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  wyAlbumDetailResponse,
  wyAlbumDetailZeroTrackNumberResponse,
  wyAlbumDetailV1Response,
  wyAlbumDetailV1ZeroTrackNumberResponse,
  wyAlbumPageResponses,
  wyArtistResponse,
  wyArtistSearchResponse,
  wyProviderRefusedResponse,
  wyVerificationRequiredResponse,
} from './__fixtures__/artistDiscography'
import { createWyArtistCatalogAdapter } from './artistDiscography'

const { httpFetchMock } = vi.hoisted(() => ({ httpFetchMock: vi.fn() }))

vi.mock('../../request', () => ({
  httpFetch: httpFetchMock,
}))

interface MockRequestOptions {
  method?: string
  form?: Record<string, unknown>
}

const response = (body: unknown, statusCode = 200) => ({
  promise: Promise.resolve({ statusCode, body }),
  cancelHttp: vi.fn(),
})

const rejectedResponse = (message = 'network failure') => ({
  promise: Promise.reject(new Error(message)),
  cancelHttp: vi.fn(),
})

describe('NetEase artist catalog adapter', () => {
  beforeEach(() => {
    httpFetchMock.mockReset()
  })

  it('resolves only an exact artist-name match and verifies its canonical identity', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url == 'https://music.163.com/api/search/get/web') return response(wyArtistSearchResponse)
      if (url == 'https://music.163.com/api/artist/3060') return response(wyArtistResponse)
      throw new Error(`Unexpected URL: ${url}`)
    })

    await expect(createWyArtistCatalogAdapter().resolveArtist('Fixture Artist')).resolves.toEqual({
      source: 'wy',
      id: '3060',
      name: 'Fixture Artist',
      avatar: 'https://img.example.test/artist.jpg',
      albumCount: 3,
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(2)
    expect(httpFetchMock.mock.calls[0]).toEqual([
      'https://music.163.com/api/search/get/web',
      expect.objectContaining({
        method: 'post',
        form: {
          s: 'Fixture Artist',
          name: 'Fixture Artist',
          type: 100,
          offset: 0,
          total: true,
          limit: 10,
        },
      }),
    ])
  })

  it('normalizes compatibility characters, separator whitespace, and Latin case for a full-name match', async() => {
    const providerName = 'ＦＩＸＴＵＲＥ   ＡＲＴＩＳＴ'
    httpFetchMock.mockImplementation((url: string) => {
      if (url == 'https://music.163.com/api/search/get/web') {
        return response({
          code: 200,
          result: { artists: [{ id: 3060, name: providerName, albumSize: 3 }] },
        })
      }
      if (url == 'https://music.163.com/api/artist/3060') {
        return response({
          code: 200,
          artist: { id: 3060, name: providerName, albumSize: 3 },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    await expect(createWyArtistCatalogAdapter().resolveArtist('fixture artist')).resolves.toMatchObject({
      id: '3060',
      name: providerName,
    })
  })

  it('resolves a Chinese input when NetEase appends the canonical English artist name', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url == 'https://music.163.com/api/search/get/web') {
        return response({
          code: 200,
          result: {
            artists: [{
              id: 123456,
              name: '刘雨昕XIN LIU',
              picUrl: 'https://img.example.test/liu-yuxin-search.jpg',
              albumSize: 41,
            }],
          },
        })
      }
      if (url == 'https://music.163.com/api/artist/123456') {
        return response({
          code: 200,
          artist: {
            id: 123456,
            name: '刘雨昕XIN LIU',
            picUrl: 'https://img.example.test/liu-yuxin.jpg',
            albumSize: 41,
          },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    await expect(createWyArtistCatalogAdapter().resolveArtist('刘雨昕')).resolves.toEqual({
      source: 'wy',
      id: '123456',
      name: '刘雨昕XIN LIU',
      avatar: 'https://img.example.test/liu-yuxin.jpg',
      albumCount: 41,
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    '刘雨昕翻唱',
    '刘雨昕X',
    '刘雨昕123',
  ])('rejects unsafe partial or non-script-boundary candidate %s', async(candidateName) => {
    httpFetchMock.mockReturnValue(response({
      code: 200,
      result: {
        artists: [{ id: 123456, name: candidateName, albumSize: 1 }],
      },
    }))

    await expect(createWyArtistCatalogAdapter().resolveArtist('刘雨昕')).rejects.toMatchObject({
      issue: { code: 'artist_not_found', stage: 'artist', source: 'wy' },
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the first valid provider candidate when an alias precedes a same-name artist', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url == 'https://music.163.com/api/search/get/web') {
        return response({
          code: 200,
          result: {
            artists: [
              { id: 123456, name: '刘雨昕XIN LIU', albumSize: 41 },
              { id: 60333962, name: '刘雨昕', albumSize: 2 },
            ],
          },
        })
      }
      if (url == 'https://music.163.com/api/artist/123456') {
        return response({
          code: 200,
          artist: {
            id: 123456,
            name: '刘雨昕XIN LIU',
            albumSize: 41,
          },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    await expect(createWyArtistCatalogAdapter().resolveArtist('刘雨昕')).resolves.toMatchObject({
      id: '123456',
      name: '刘雨昕XIN LIU',
    })
    expect(httpFetchMock.mock.calls[1]?.[0]).toBe('https://music.163.com/api/artist/123456')
  })

  it('keeps the first valid provider candidate when an exact match precedes an alias', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url == 'https://music.163.com/api/search/get/web') {
        return response({
          code: 200,
          result: {
            artists: [
              { id: 60333962, name: '刘雨昕', albumSize: 2 },
              { id: 123456, name: '刘雨昕XIN LIU', albumSize: 41 },
            ],
          },
        })
      }
      if (url == 'https://music.163.com/api/artist/60333962') {
        return response({
          code: 200,
          artist: {
            id: 60333962,
            name: '刘雨昕',
            albumSize: 2,
          },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    await expect(createWyArtistCatalogAdapter().resolveArtist('刘雨昕')).resolves.toMatchObject({
      id: '60333962',
      name: '刘雨昕',
    })
    expect(httpFetchMock.mock.calls[1]?.[0]).toBe('https://music.163.com/api/artist/60333962')
  })

  it('rejects fuzzy results and never loads their artist details', async() => {
    httpFetchMock.mockReturnValue(response({
      code: 200,
      result: {
        artists: [{ id: 9999, name: 'Fixture Artist Tribute', albumSize: 1 }],
      },
    }))

    await expect(createWyArtistCatalogAdapter().resolveArtist('Fixture Artist')).rejects.toMatchObject({
      issue: { code: 'artist_not_found', stage: 'artist', source: 'wy' },
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts names only and rejects numeric IDs or links before making a request', async() => {
    const adapter = createWyArtistCatalogAdapter()

    await expect(adapter.resolveArtist('3060')).rejects.toMatchObject({
      issue: { code: 'invalid_artist_ref', stage: 'input' },
    })
    await expect(adapter.resolveArtist('https://music.163.com/artist?id=3060')).rejects.toMatchObject({
      issue: { code: 'invalid_artist_ref', stage: 'input' },
    })
    expect(httpFetchMock).not.toHaveBeenCalled()
  })

  it('rejects a canonical artist whose ID or name differs from the exact search result', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/search/get/web')) return response(wyArtistSearchResponse)
      return response({
        ...wyArtistResponse,
        artist: { ...wyArtistResponse.artist, id: 9999 },
      })
    })

    await expect(createWyArtistCatalogAdapter().resolveArtist('Fixture Artist')).rejects.toMatchObject({
      issue: { code: 'invalid_provider_response', stage: 'artist', artistId: '3060' },
    })
  })

  it('pages every album with continuous offset 0/limit values while more is true', async() => {
    const offsets: number[] = []
    const limits: number[] = []
    httpFetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url)
      offsets.push(Number(parsed.searchParams.get('offset')))
      limits.push(Number(parsed.searchParams.get('limit')))
      return response(wyAlbumPageResponses[offsets.length - 1])
    })

    const result = await createWyArtistCatalogAdapter().getArtistAlbums('3060')

    expect(result).toMatchObject({
      reportedTotal: 3,
      complete: true,
      issues: [],
    })
    expect(result.items.map(album => album.id)).toEqual(['101', '102', '103'])
    expect(offsets).toEqual([0, limits[0]])
    expect(limits).toEqual([limits[0], limits[0]])
    expect(limits[0]).toBeGreaterThan(0)
  })

  it('keeps unique albums but marks overlapping pages incomplete', async() => {
    const firstPage = {
      ...wyAlbumPageResponses[0],
      artist: { ...wyAlbumPageResponses[0].artist, albumSize: 3 },
    }
    const secondPage = {
      ...wyAlbumPageResponses[1],
      hotAlbums: [
        wyAlbumPageResponses[0].hotAlbums[1],
        wyAlbumPageResponses[1].hotAlbums[0],
      ],
    }
    httpFetchMock
      .mockReturnValueOnce(response(firstPage))
      .mockReturnValueOnce(response(secondPage))

    const result = await createWyArtistCatalogAdapter().getArtistAlbums('3060')

    expect(result.items.map(album => album.id)).toEqual(['101', '102', '103'])
    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'duplicate_album',
      albumId: '102',
      source: 'wy',
    }))
  })

  it('loads one complete album detail and preserves source, membership, and provider track numbers', async() => {
    httpFetchMock.mockReturnValue(response(wyAlbumDetailResponse))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(httpFetchMock.mock.calls[0]?.[0]).toBe('https://music.163.com/api/album/101')
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ reportedTotal: 4, complete: true, issues: [] })
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'wy_501',
        source: 'wy',
        meta: expect.objectContaining({ albumId: '101', trackNumber: 1 }),
      }),
      expect.objectContaining({
        id: 'wy_504',
        source: 'wy',
        meta: expect.objectContaining({ albumId: '101', trackNumber: 4 }),
      }),
    ]))
  })

  it('keeps primary album tracks whose provider track numbers are zero', async() => {
    httpFetchMock.mockReturnValueOnce(response(wyAlbumDetailZeroTrackNumberResponse))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(httpFetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://music.163.com/api/album/101',
    ])
    expect(result).toMatchObject({ reportedTotal: 2, complete: true, issues: [] })
    expect(result.items.map(track => ({
      id: track.id,
      trackNumber: track.meta.trackNumber,
    }))).toEqual([
      { id: 'wy_705', trackNumber: 1 },
      { id: 'wy_706', trackNumber: 2 },
    ])
  })

  it('falls back to the v1 album detail when the primary endpoint requires verification', async() => {
    httpFetchMock
      .mockReturnValueOnce(response(wyVerificationRequiredResponse))
      .mockReturnValueOnce(response(wyAlbumDetailV1Response))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(httpFetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://music.163.com/api/album/101',
      'https://music.163.com/api/v1/album/101',
    ])
    expect(result).toMatchObject({ reportedTotal: 4, complete: true, issues: [] })
    expect(result.items.map(track => track.id)).toEqual([
      'wy_601',
      'wy_602',
      'wy_603',
      'wy_604',
    ])
  })

  it('keeps v1 fallback tracks whose provider track numbers are zero', async() => {
    httpFetchMock
      .mockReturnValueOnce(response(wyVerificationRequiredResponse))
      .mockReturnValueOnce(response(wyAlbumDetailV1ZeroTrackNumberResponse))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(httpFetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://music.163.com/api/album/101',
      'https://music.163.com/api/v1/album/101',
    ])
    expect(result).toMatchObject({ reportedTotal: 2, complete: true, issues: [] })
    expect(result.items.map(track => ({
      id: track.id,
      trackNumber: track.meta.trackNumber,
    }))).toEqual([
      { id: 'wy_701', trackNumber: 1 },
      { id: 'wy_702', trackNumber: 2 },
    ])
  })

  it('rejects v1 songs whose album ID differs from the canonical album', async() => {
    httpFetchMock
      .mockReturnValueOnce(response(wyVerificationRequiredResponse))
      .mockReturnValueOnce(response({
        ...wyAlbumDetailV1Response,
        songs: [
          {
            ...wyAlbumDetailV1Response.songs[0],
            al: { ...wyAlbumDetailV1Response.songs[0].al, id: 999 },
          },
          ...wyAlbumDetailV1Response.songs.slice(1),
        ],
      }))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(result.complete).toBe(false)
    expect(result.items.map(track => track.id)).toEqual(['wy_602', 'wy_603', 'wy_604'])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_provider_response',
      albumId: '101',
      trackId: '601',
    }))
  })

  it('rejects v1 songs with missing modern duration or artist fields', async() => {
    httpFetchMock
      .mockReturnValueOnce(response(wyVerificationRequiredResponse))
      .mockReturnValueOnce(response({
        ...wyAlbumDetailV1Response,
        songs: [
          { ...wyAlbumDetailV1Response.songs[0], dt: undefined },
          { ...wyAlbumDetailV1Response.songs[1], ar: undefined },
          ...wyAlbumDetailV1Response.songs.slice(2),
        ],
      }))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(result.complete).toBe(false)
    expect(result.items.map(track => track.id)).toEqual(['wy_603', 'wy_604'])
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_provider_response', trackId: '601' }),
      expect.objectContaining({ code: 'invalid_provider_response', trackId: '602' }),
    ]))
  })

  it('rejects a legacy album payload returned by the v1 fallback endpoint', async() => {
    httpFetchMock
      .mockReturnValueOnce(response(wyVerificationRequiredResponse))
      .mockReturnValueOnce(response(wyAlbumDetailResponse))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(httpFetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://music.163.com/api/album/101',
      'https://music.163.com/api/v1/album/101',
    ])
    expect(result).toMatchObject({
      items: [],
      reportedTotal: null,
      complete: false,
      issues: [{
        code: 'invalid_provider_response',
        stage: 'album_tracks',
        source: 'wy',
        albumId: '101',
      }],
    })
  })

  it('returns one provider-unavailable issue when both album detail endpoints require verification', async() => {
    httpFetchMock.mockReturnValue(response(wyVerificationRequiredResponse))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(httpFetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://music.163.com/api/album/101',
      'https://music.163.com/api/v1/album/101',
    ])
    expect(result).toMatchObject({
      items: [],
      reportedTotal: null,
      complete: false,
      issues: [{
        code: 'provider_unavailable',
        stage: 'album_tracks',
        source: 'wy',
        albumId: '101',
        retryable: true,
      }],
    })
    expect(result.issues).toHaveLength(1)
    expect(result.issues.some(issue => issue.code == 'invalid_provider_response')).toBe(false)
  })

  it.each([
    {
      scenario: 'the primary endpoint returns a non-success business code',
      responses: [wyProviderRefusedResponse],
      expectedUrls: ['https://music.163.com/api/album/101'],
      expectedCode: 'provider_unavailable',
    },
    {
      scenario: 'the v1 fallback returns a non-success business code',
      responses: [wyVerificationRequiredResponse, wyProviderRefusedResponse],
      expectedUrls: [
        'https://music.163.com/api/album/101',
        'https://music.163.com/api/v1/album/101',
      ],
      expectedCode: 'provider_unavailable',
    },
    {
      scenario: 'a success envelope has malformed album data',
      responses: [{ code: 200, album: null }],
      expectedUrls: ['https://music.163.com/api/album/101'],
      expectedCode: 'invalid_provider_response',
    },
  ] as const)('classifies $scenario', async({ responses, expectedUrls, expectedCode }) => {
    for (const body of responses) httpFetchMock.mockReturnValueOnce(response(body))

    const result = await createWyArtistCatalogAdapter().getAlbumTracks('101')

    expect(httpFetchMock.mock.calls.map(call => call[0])).toEqual(expectedUrls)
    expect(result).toMatchObject({
      items: [],
      complete: false,
      issues: [{
        code: expectedCode,
        stage: 'album_tracks',
        source: 'wy',
        albumId: '101',
      }],
    })
    expect(result.issues).toHaveLength(1)
  })

  it('cancels an active v1 fallback request without retrying it', async() => {
    let rejectFallback: ((error: Error) => void) | undefined
    let resolveFallbackStarted: () => void = () => {}
    const fallbackStarted = new Promise<void>(resolve => {
      resolveFallbackStarted = resolve
    })
    const cancelFallback = vi.fn(() => rejectFallback?.(new Error('cancelled request')))
    httpFetchMock
      .mockReturnValueOnce(response(wyVerificationRequiredResponse))
      .mockImplementationOnce(() => {
        const promise = new Promise<HttpResponse>((_resolve, reject) => {
          rejectFallback = reject
          resolveFallbackStarted()
        })
        return { promise, cancelHttp: cancelFallback }
      })
    const controller = new AbortController()
    const pending = createWyArtistCatalogAdapter().getAlbumTracks('101', controller.signal)

    await fallbackStarted
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(httpFetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://music.163.com/api/album/101',
      'https://music.163.com/api/v1/album/101',
    ])
    expect(cancelFallback).toHaveBeenCalledTimes(1)
  })

  it('retries transient request failures a finite number of times', async() => {
    let searchAttempts = 0
    httpFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/search/get/web')) {
        searchAttempts++
        return searchAttempts < 3 ? rejectedResponse() : response(wyArtistSearchResponse)
      }
      return response(wyArtistResponse)
    })

    await expect(createWyArtistCatalogAdapter().resolveArtist('Fixture Artist')).resolves.toMatchObject({
      id: '3060',
    })
    expect(searchAttempts).toBe(3)
    expect(httpFetchMock).toHaveBeenCalledTimes(4)
  })

  it('classifies malformed and exhausted requests without leaking TypeError', async() => {
    httpFetchMock.mockReturnValue(response({ code: 200, result: null }))
    await expect(createWyArtistCatalogAdapter().resolveArtist('Fixture Artist')).rejects.toMatchObject({
      issue: { code: 'invalid_provider_response', stage: 'artist' },
    })

    httpFetchMock.mockReset()
    httpFetchMock.mockReturnValue(rejectedResponse())
    const detail = await createWyArtistCatalogAdapter().getAlbumTracks('101')
    expect(detail).toMatchObject({
      items: [],
      complete: false,
      issues: [{ code: 'provider_unavailable', stage: 'album_tracks', albumId: '101' }],
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(3)
  })

  it('cancels the active httpFetch and performs no retry after AbortSignal fires', async() => {
    let cancelHttp: ReturnType<typeof vi.fn> | undefined
    httpFetchMock.mockImplementation((_url: string, _options?: MockRequestOptions) => {
      let rejectRequest: (error: Error) => void = () => {}
      const promise = new Promise<HttpResponse>((_resolve, reject) => {
        rejectRequest = reject
      })
      cancelHttp = vi.fn(() => {
        rejectRequest(new Error('cancelled request'))
      })
      return { promise, cancelHttp }
    })
    const controller = new AbortController()
    const pending = createWyArtistCatalogAdapter().resolveArtist('Fixture Artist', controller.signal)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelHttp).toHaveBeenCalledTimes(1)
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })
})

interface HttpResponse {
  statusCode: number
  body: unknown
}
