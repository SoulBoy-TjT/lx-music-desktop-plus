import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  kwAlbumPageResponses,
  kwAlbumTrackPageResponses,
  kwArtistSearchResponse,
  kwDiscontinuousZeroBasedAlbumTrackPageResponses,
  kwFuzzyArtistSearchResponse,
  kwInvalidPseudoJsonResponse,
  kwZeroBasedAlbumTrackPageResponses,
} from './__fixtures__/artistDiscography'
import { createKwArtistCatalogAdapter } from './artistDiscography'

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

const response = (body: unknown, statusCode = 200) => ({
  promise: Promise.resolve({ statusCode, body }),
  cancelHttp: vi.fn(),
})

describe('Kuwo artist catalog adapter', () => {
  beforeEach(() => {
    httpFetchMock.mockReset()
  })

  it('resolves only the first exact artist-name match', async() => {
    httpFetchMock.mockReturnValue(response(kwArtistSearchResponse))

    await expect(createKwArtistCatalogAdapter().resolveArtist(' 蔡徐坤 ')).resolves.toEqual({
      source: 'kw',
      id: '192980',
      name: '蔡徐坤',
      avatar: 'https://img.example.test/artist.jpg',
      albumCount: 3,
    })
    const url = String(httpFetchMock.mock.calls[0]?.[0])
    expect(url).toBe('https://search.kuwo.cn/r.s?all=%E8%94%A1%E5%BE%90%E5%9D%A4&ft=artist&itemset=web_2013&client=kt&pn=0&rn=10&rformat=json&encoding=utf8')
  })

  it('rejects fuzzy search results and direct URL references', async() => {
    httpFetchMock.mockReturnValue(response(kwFuzzyArtistSearchResponse))

    const adapter = createKwArtistCatalogAdapter()
    await expect(adapter.resolveArtist('蔡徐坤')).rejects.toMatchObject({
      issue: { code: 'artist_not_found', stage: 'artist' },
    })
    await expect(adapter.resolveArtist('https://www.kuwo.cn/singer/192980')).rejects.toMatchObject({
      issue: { code: 'invalid_artist_ref', stage: 'input' },
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('requests every artist album page with continuous zero-based pn values', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      const page = Number(new URL(url).searchParams.get('pn'))
      return response(kwAlbumPageResponses[page])
    })

    const result = await createKwArtistCatalogAdapter().getArtistAlbums('192980')

    expect(result).toMatchObject({ reportedTotal: 3, complete: true, issues: [] })
    expect(result.items.map(album => album.id)).toEqual(['101', '102', '103'])
    expect(httpFetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('pn')))
      .toEqual(['0', '1'])
    expect(httpFetchMock.mock.calls.every(([url]) => String(url).startsWith('https://search.kuwo.cn/'))).toBe(true)
  })

  it('requests every album detail page and preserves strict song fields', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      const page = Number(new URL(url).searchParams.get('pn'))
      return response(kwAlbumTrackPageResponses[page])
    })

    const result = await createKwArtistCatalogAdapter().getAlbumTracks('101')

    expect(result).toMatchObject({ reportedTotal: 3, complete: true, issues: [] })
    expect(result.items).toHaveLength(3)
    expect(result.items[0]).toMatchObject({
      id: 'kw_501',
      source: 'kw',
      meta: {
        songId: '501',
        albumId: '101',
        trackNumber: 1,
      },
    })
    expect(result.items[2]).toMatchObject({
      id: 'kw_503',
      meta: { albumId: '101', trackNumber: 3 },
    })
    expect(httpFetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('pn')))
      .toEqual(['0', '1'])
  })

  it('normalizes one complete zero-based track sequence across album detail pages', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      const page = Number(new URL(url).searchParams.get('pn'))
      return response(kwZeroBasedAlbumTrackPageResponses[page])
    })

    const result = await createKwArtistCatalogAdapter().getAlbumTracks('202')

    expect(result).toMatchObject({ reportedTotal: 4, complete: true, issues: [] })
    expect(result.items.map(track => track.meta.trackNumber)).toEqual([1, 2, 3, 4])
    expect(httpFetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('pn')))
      .toEqual(['0', '1'])
  })

  it('keeps zero-based normalization continuous across the real 100-item page boundary', async() => {
    const makeTrack = (trackNumber: number) => ({
      id: String(2001 + trackNumber),
      name: `Large Paged Track ${trackNumber + 1}`,
      artist: 'Fixture Artist',
      formats: 'MP3128',
      duration: '180',
      track: String(trackNumber),
    })
    const pages = [
      {
        musiclist: Array.from({ length: 100 }, (_, index) => makeTrack(index)),
        songnum: '101',
        albumid: '206',
        name: 'Large Paged Zero Based Album',
        artist: 'Fixture Artist',
      },
      {
        musiclist: [makeTrack(100)],
        songnum: '101',
        albumid: '206',
        name: 'Large Paged Zero Based Album',
        artist: 'Fixture Artist',
      },
    ]
    httpFetchMock.mockImplementation((url: string) => {
      const page = Number(new URL(url).searchParams.get('pn'))
      return response(pages[page])
    })

    const result = await createKwArtistCatalogAdapter().getAlbumTracks('206')

    expect(result).toMatchObject({ reportedTotal: 101, complete: true, issues: [] })
    expect(result.items).toHaveLength(101)
    expect(result.items[99].meta.trackNumber).toBe(100)
    expect(result.items[100].meta.trackNumber).toBe(101)
  })

  it('rejects a zero-based sequence that becomes discontinuous on a later page', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      const page = Number(new URL(url).searchParams.get('pn'))
      return response(kwDiscontinuousZeroBasedAlbumTrackPageResponses[page])
    })

    const result = await createKwArtistCatalogAdapter().getAlbumTracks('202')

    expect(result.reportedTotal).toBe(4)
    expect(result.complete).toBe(false)
    expect(result.items).toEqual([])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_provider_response',
      stage: 'album_tracks',
    }))
  })

  it('classifies an unparseable pseudo JSON response as invalid provider data', async() => {
    httpFetchMock.mockReturnValue(response(kwInvalidPseudoJsonResponse))

    await expect(createKwArtistCatalogAdapter().resolveArtist('蔡徐坤')).rejects.toMatchObject({
      issue: { code: 'invalid_provider_response', stage: 'artist' },
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a temporary request failure only a finite number of times', async() => {
    httpFetchMock.mockImplementation(() => ({
      promise: Promise.reject(new Error('offline')),
      cancelHttp: vi.fn(),
    }))

    await expect(createKwArtistCatalogAdapter().resolveArtist('蔡徐坤')).rejects.toMatchObject({
      issue: { code: 'provider_unavailable', stage: 'artist', retryable: true },
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(3)
  })

  it('cancels the active httpFetch request when its AbortSignal is aborted', async() => {
    let rejectRequest: ((reason: Error) => void) | undefined
    const cancelHttp = vi.fn(() => rejectRequest?.(new Error('cancelled')))
    httpFetchMock.mockReturnValue({
      promise: new Promise((_resolve, reject) => {
        rejectRequest = reject
      }),
      cancelHttp,
    })
    const controller = new AbortController()

    const pending = createKwArtistCatalogAdapter().resolveArtist('蔡徐坤', controller.signal)
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelHttp).toHaveBeenCalledTimes(1)
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('stops and reports a repeated album page instead of looping', async() => {
    const repeatedSecondPage = kwAlbumPageResponses[0].replace("'pn':'0'", "'pn':'1'")
    httpFetchMock
      .mockReturnValueOnce(response(kwAlbumPageResponses[0]))
      .mockReturnValueOnce(response(repeatedSecondPage))

    const result = await createKwArtistCatalogAdapter().getArtistAlbums('192980')

    expect(result.complete).toBe(false)
    expect(result.items.map(album => album.id)).toEqual(['101', '102'])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'pagination_inconsistent',
      stage: 'albums',
    }))
    expect(httpFetchMock).toHaveBeenCalledTimes(2)
  })
})
