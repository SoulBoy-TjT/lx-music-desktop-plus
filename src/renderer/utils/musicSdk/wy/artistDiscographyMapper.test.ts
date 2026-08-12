import { describe, expect, it } from 'vitest'
import {
  wyAlbumDetailResponse,
  wyAlbumDetailZeroTrackNumberResponse,
  wyAlbumDetailV1Response,
  wyAlbumDetailV1ZeroTrackNumberResponse,
  wyAlbumPageResponses,
  wyArtistResponse,
  wyArtistSearchResponse,
} from './__fixtures__/artistDiscography'
import {
  mapWyAlbumDetailResponse,
  mapWyAlbumPage,
  mapWyArtistResponse,
  mapWyArtistSearchResponse,
} from './artistDiscographyMapper'

describe('NetEase artist response mapper', () => {
  it('maps search candidates and the canonical artist without changing provider order', () => {
    expect(mapWyArtistSearchResponse(wyArtistSearchResponse)).toEqual({
      kind: 'ok',
      artists: [
        {
          source: 'wy',
          id: '3060',
          name: 'Fixture Artist',
          avatar: 'https://img.example.test/artist-search.jpg',
          albumCount: 3,
        },
        {
          source: 'wy',
          id: '9999',
          name: 'Fixture Artist Tribute',
          avatar: 'https://img.example.test/artist-fuzzy.jpg',
          albumCount: 1,
        },
      ],
    })
    expect(mapWyArtistResponse(wyArtistResponse)).toEqual({
      kind: 'ok',
      artist: {
        source: 'wy',
        id: '3060',
        name: 'Fixture Artist',
        avatar: 'https://img.example.test/artist.jpg',
        albumCount: 3,
      },
    })
  })

  it('distinguishes an empty search result from a malformed response', () => {
    expect(mapWyArtistSearchResponse({ code: 200, result: { artists: [] } }))
      .toEqual({ kind: 'ok', artists: [] })
    expect(mapWyArtistSearchResponse({ code: 200, result: {} }))
      .toEqual({ kind: 'invalid' })
    expect(mapWyArtistResponse({ code: 200, artist: { id: 3060 } }))
      .toEqual({ kind: 'invalid' })
  })
})

describe('NetEase album response mapper', () => {
  it('maps album rows with stable string IDs, declared counts, and release dates', () => {
    const mapped = mapWyAlbumPage(wyAlbumPageResponses[0], '3060', 'Fixture Artist')

    expect(mapped).toMatchObject({
      validResponse: true,
      more: true,
      reportedTotal: 3,
      rawItemCount: 2,
      pageKeys: ['101', '102'],
      issues: [],
    })
    expect(mapped.items[0]).toEqual({
      source: 'wy',
      id: '101',
      name: 'Album A',
      artist: 'Fixture Artist',
      releaseDate: '2020-01-02',
      image: 'https://img.example.test/album-101.jpg',
      expectedTrackCount: 4,
    })
  })

  it('returns a stable invalid page instead of throwing on malformed data', () => {
    expect(mapWyAlbumPage({ code: 200, hotAlbums: null, more: false }, '3060', 'Fixture Artist'))
      .toMatchObject({
        items: [],
        validResponse: false,
        issues: [{ code: 'invalid_provider_response', stage: 'albums', source: 'wy' }],
      })
  })

  it('maps complete album tracks to strict MusicInfoOnline values without quality fallthrough', () => {
    const mapped = mapWyAlbumDetailResponse(wyAlbumDetailResponse, '101')

    expect(mapped).toMatchObject({ reportedTotal: 4, complete: true, issues: [] })
    expect(mapped.items.map(track => ({
      id: track.id,
      source: track.source,
      singer: track.singer,
      albumId: track.meta.albumId,
      trackNumber: track.meta.trackNumber,
      trackTotal: track.meta.trackTotal,
      qualitys: track.meta.qualitys.map(quality => quality.type),
    }))).toEqual([
      {
        id: 'wy_501',
        source: 'wy',
        singer: 'Fixture Artist',
        albumId: '101',
        trackNumber: 1,
        trackTotal: 4,
        qualitys: ['128k'],
      },
      {
        id: 'wy_502',
        source: 'wy',
        singer: 'Fixture Artist、Guest Artist',
        albumId: '101',
        trackNumber: 2,
        trackTotal: 4,
        qualitys: ['320k'],
      },
      {
        id: 'wy_503',
        source: 'wy',
        singer: 'Fixture Artist',
        albumId: '101',
        trackNumber: 3,
        trackTotal: 4,
        qualitys: ['flac'],
      },
      {
        id: 'wy_504',
        source: 'wy',
        singer: 'Fixture Artist',
        albumId: '101',
        trackNumber: 4,
        trackTotal: 4,
        qualitys: ['flac24bit'],
      },
    ])
  })

  it('uses stable legacy response order when provider track numbers are zero', () => {
    const mapped = mapWyAlbumDetailResponse(wyAlbumDetailZeroTrackNumberResponse, '101')

    expect(mapped).toMatchObject({ reportedTotal: 2, complete: true, issues: [] })
    expect(mapped.items.map(track => ({
      id: track.id,
      trackNumber: track.meta.trackNumber,
      trackTotal: track.meta.trackTotal,
    }))).toEqual([
      { id: 'wy_705', trackNumber: 1, trackTotal: 2 },
      { id: 'wy_706', trackNumber: 2, trackTotal: 2 },
    ])
  })

  it('maps v1 root songs with modern artist, album, duration, and quality fields', () => {
    const mapped = mapWyAlbumDetailResponse(wyAlbumDetailV1Response, '101')

    expect(mapped).toMatchObject({ reportedTotal: 4, complete: true, issues: [] })
    expect(mapped.items.map(track => ({
      id: track.id,
      singer: track.singer,
      albumId: track.meta.albumId,
      trackNumber: track.meta.trackNumber,
      trackTotal: track.meta.trackTotal,
      qualitys: track.meta.qualitys.map(quality => quality.type),
    }))).toEqual([
      {
        id: 'wy_601',
        singer: 'Fixture Artist',
        albumId: '101',
        trackNumber: 1,
        trackTotal: 4,
        qualitys: ['128k'],
      },
      {
        id: 'wy_602',
        singer: 'Fixture Artist、Guest Artist',
        albumId: '101',
        trackNumber: 2,
        trackTotal: 4,
        qualitys: ['320k'],
      },
      {
        id: 'wy_603',
        singer: 'Fixture Artist',
        albumId: '101',
        trackNumber: 3,
        trackTotal: 4,
        qualitys: ['flac'],
      },
      {
        id: 'wy_604',
        singer: 'Fixture Artist',
        albumId: '101',
        trackNumber: 4,
        trackTotal: 4,
        qualitys: ['flac24bit'],
      },
    ])
  })

  it('uses stable v1 response order when provider track numbers are zero', () => {
    const mapped = mapWyAlbumDetailResponse(wyAlbumDetailV1ZeroTrackNumberResponse, '101', 'v1')

    expect(mapped).toMatchObject({ reportedTotal: 2, complete: true, issues: [] })
    expect(mapped.items.map(track => ({
      id: track.id,
      trackNumber: track.meta.trackNumber,
      trackTotal: track.meta.trackTotal,
    }))).toEqual([
      { id: 'wy_701', trackNumber: 1, trackTotal: 2 },
      { id: 'wy_702', trackNumber: 2, trackTotal: 2 },
    ])
  })

  it('uses stable v1 response order when the provider track number is absent', () => {
    const { no: _no, ...trackWithoutNumber } = wyAlbumDetailV1ZeroTrackNumberResponse.songs[0]
    const mapped = mapWyAlbumDetailResponse({
      ...wyAlbumDetailV1ZeroTrackNumberResponse,
      album: { ...wyAlbumDetailV1ZeroTrackNumberResponse.album, size: 1 },
      songs: [trackWithoutNumber],
    }, '101', 'v1')

    expect(mapped).toMatchObject({ reportedTotal: 1, complete: true, issues: [] })
    expect(mapped.items).toHaveLength(1)
    expect(mapped.items[0].meta.trackNumber).toBe(1)
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['non-numeric', 'invalid'],
  ] as const)('still rejects a %s v1 provider track number', (_scenario, no) => {
    const mapped = mapWyAlbumDetailResponse({
      ...wyAlbumDetailV1ZeroTrackNumberResponse,
      album: { ...wyAlbumDetailV1ZeroTrackNumberResponse.album, size: 1 },
      songs: [{ ...wyAlbumDetailV1ZeroTrackNumberResponse.songs[0], no }],
    }, '101', 'v1')

    expect(mapped.items).toEqual([])
    expect(mapped.complete).toBe(false)
    expect(mapped.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_provider_response', trackId: '701' }),
      expect.objectContaining({ code: 'album_incomplete', expected: 1, actual: 0 }),
    ]))
  })

  it('rejects cross-album rows and reports duplicate stable tracks', () => {
    const firstTrack = wyAlbumDetailResponse.album.songs[0]
    const mapped = mapWyAlbumDetailResponse({
      ...wyAlbumDetailResponse,
      album: {
        ...wyAlbumDetailResponse.album,
        size: 3,
        songs: [
          firstTrack,
          firstTrack,
          {
            ...wyAlbumDetailResponse.album.songs[1],
            album: { ...wyAlbumDetailResponse.album.songs[1].album, id: 999 },
          },
        ],
      },
    }, '101')

    expect(mapped.items).toHaveLength(1)
    expect(mapped.complete).toBe(false)
    expect(mapped.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate_track', trackId: 'wy_501' }),
      expect.objectContaining({ code: 'invalid_provider_response', trackId: '502' }),
      expect.objectContaining({ code: 'album_incomplete', expected: 3, actual: 1 }),
    ]))
  })
})
