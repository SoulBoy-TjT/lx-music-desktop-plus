import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createKgArtistCatalogAdapter } from './artistDiscography'

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
    data?: Array<Record<string, unknown>>
  }
}

const response = (body: unknown) => ({
  promise: Promise.resolve({ statusCode: 200, body }),
  cancelHttp: vi.fn(),
})

const expandedTrack = (albumId: string, hash: string, audioId = 501) => ({
  author_name: 'Fixture Artist',
  songname: 'Shared Track',
  album_info: {
    album_id: albumId,
    album_name: albumId == '101' ? 'Album A' : 'Single Release',
  },
  audio_info: {
    audio_id: audioId,
    hash,
    filesize: '1024',
    filesize_320: '0',
    filesize_flac: '0',
    filesize_high: '0',
    timelength: '180000',
  },
})

describe('KuGou artist catalog adapter', () => {
  beforeEach(() => {
    httpFetchMock.mockReset()
  })

  it('resolves an exact Chinese artist name through singer search before loading artist details', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v3/search/singer')) {
        return response({
          status: 1,
          errcode: 0,
          data: [
            { singername: '蔡徐坤', singerid: 192980 },
            { singername: '蔡徐坤', singerid: 999999 },
            { singername: '伊伊在想蔡徐坤', singerid: 5667153 },
          ],
        })
      }
      if (url.includes('/api/v5/singer/info?singerid=192980')) {
        return response({
          status: 1,
          errcode: 0,
          info: {
            singerid: 192980,
            singername: '蔡徐坤',
            albumcount: 12,
            imgurl: 'https://img.example.test/{size}/artist.jpg',
          },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    await expect(createKgArtistCatalogAdapter().resolveArtist('蔡徐坤')).resolves.toEqual({
      source: 'kg',
      id: '192980',
      name: '蔡徐坤',
      avatar: 'https://img.example.test/480/artist.jpg',
      albumCount: 12,
    })
    expect(httpFetchMock.mock.calls[0]?.[0]).toContain('keyword=%E8%94%A1%E5%BE%90%E5%9D%A4')
    expect(httpFetchMock.mock.calls[1]?.[0]).toContain('singerid=192980')
  })

  it('treats a Latin artist name as a search term instead of a legacy token', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v3/search/singer')) {
        return response({ status: 1, errcode: 0, data: [{ singername: 'Adele', singerid: 1961 }] })
      }
      if (url.includes('/api/v5/singer/info?singerid=1961')) {
        return response({ info: { singerid: 1961, singername: 'Adele', albumcount: 5 } })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    await expect(createKgArtistCatalogAdapter().resolveArtist('Adele')).resolves.toMatchObject({
      id: '1961',
      name: 'Adele',
    })
    expect(httpFetchMock.mock.calls.some(([url]) => String(url).includes('/singer/info/Adele/'))).toBe(false)
  })

  it('does not accept a fuzzy singer search result as the requested artist', async() => {
    httpFetchMock.mockReturnValue(response({
      status: 1,
      errcode: 0,
      data: [{ singername: '伊伊在想蔡徐坤', singerid: 5667153 }],
    }))

    await expect(createKgArtistCatalogAdapter().resolveArtist('蔡徐坤')).rejects.toMatchObject({
      issue: { code: 'artist_not_found', stage: 'artist' },
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies the provider empty-search envelope as artist not found', async() => {
    httpFetchMock.mockReturnValue(response({ status: 1, errcode: 0, data: null, error: '' }))

    await expect(createKgArtistCatalogAdapter().resolveArtist('不存在的歌手')).rejects.toMatchObject({
      issue: { code: 'artist_not_found', stage: 'artist' },
    })
    expect(httpFetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps numeric IDs and official artist links on the direct lookup path', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v3/search/singer')) throw new Error('Direct references must not use singer search.')
      if (url.includes('/api/v5/singer/info?singerid=192980')) {
        return response({ info: { singerid: 192980, singername: '蔡徐坤', albumcount: 12 } })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const adapter = createKgArtistCatalogAdapter()
    await expect(adapter.resolveArtist('192980')).resolves.toMatchObject({ id: '192980' })
    await expect(adapter.resolveArtist('https://www.kugou.com/singer/info/192980/')).resolves.toMatchObject({ id: '192980' })
    expect(httpFetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the requested album version when audio is shared by multiple releases', async() => {
    httpFetchMock.mockImplementation((url: string, options?: MockRequestOptions) => {
      if (url.includes('/api/v3/album/song')) {
        return response({
          status: 1,
          errcode: 0,
          data: {
            total: 1,
            info: [{
              audio_id: 501,
              album_audio_id: 9001,
              album_id: '101',
              hash: 'ALBUM_HASH',
              filename: 'Fixture Artist - Shared Track',
            }],
          },
        })
      }

      const requestTrack = options?.body?.data?.[0]
      const hasAlbumAudioId = requestTrack?.album_audio_id == 9001
      return response({
        error_code: 0,
        data: [[hasAlbumAudioId
          ? expandedTrack('101', 'ALBUM_HASH')
          : expandedTrack('202', 'SINGLE_HASH')]],
      })
    })

    const result = await createKgArtistCatalogAdapter().getAlbumTracks('101')

    expect(result).toMatchObject({ reportedTotal: 1, complete: true, issues: [] })
    expect(result.items).toEqual([
      expect.objectContaining({
        id: '501_ALBUM_HASH',
        name: 'Shared Track',
        source: 'kg',
        meta: expect.objectContaining({
          songId: 501,
          albumId: '101',
          hash: 'ALBUM_HASH',
        }),
      }),
    ])
    expect(httpFetchMock.mock.calls[1]?.[1]).toMatchObject({ json: true })
  })

  it('keeps valid expanded tracks when one gateway row is malformed', async() => {
    httpFetchMock.mockImplementation((url: string, options?: MockRequestOptions) => {
      if (url.includes('/api/v3/album/song')) {
        return response({
          status: 1,
          errcode: 0,
          data: {
            total: 2,
            info: [
              {
                audio_id: 501,
                album_audio_id: 9001,
                album_id: '101',
                hash: 'BROKEN_HASH',
                filename: 'Fixture Artist - Broken Track',
              },
              {
                audio_id: 502,
                album_audio_id: 9002,
                album_id: '101',
                hash: 'VALID_HASH',
                filename: 'Fixture Artist - Valid Track',
              },
            ],
          },
        })
      }

      expect(options).toMatchObject({ json: true })
      return response({
        error_code: 0,
        data: [
          [{ audio_info: null }],
          [expandedTrack('101', 'VALID_HASH', 502)],
        ],
      })
    })

    const result = await createKgArtistCatalogAdapter().getAlbumTracks('101')

    expect(result.items).toEqual([
      expect.objectContaining({
        id: '502_VALID_HASH',
        source: 'kg',
        meta: expect.objectContaining({ albumId: '101', songId: 502 }),
      }),
    ])
    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_provider_response',
      stage: 'album_tracks',
      albumId: '101',
      expected: 2,
      actual: 1,
    }))
  })

  it('reports a missing album-audio association as invalid provider data', async() => {
    httpFetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/v3/album/song')) {
        return response({
          status: 1,
          errcode: 0,
          data: {
            total: 1,
            info: [{
              audio_id: 501,
              album_id: '101',
              hash: 'ALBUM_HASH',
              filename: 'Fixture Artist - Shared Track',
            }],
          },
        })
      }
      throw new Error('Tracks without an album-audio association must not resolve a default release.')
    })

    const result = await createKgArtistCatalogAdapter().getAlbumTracks('101')

    expect(result.items).toEqual([])
    expect(result.complete).toBe(false)
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_provider_response',
      stage: 'album_tracks',
      trackId: '501',
    }))
    expect(result.issues.some(issue => issue.code == 'provider_unavailable')).toBe(false)
  })
})
