import { describe, expect, it, vi } from 'vitest'
import {
  txAlbumPageResponses,
  txAlbumTrackPageResponses,
  txArtistSearchResponse,
  txWrongAlbumTrackResponse,
} from './__fixtures__/artistDiscography'
import {
  mapTxAlbumPage,
  mapTxAlbumTrackPage,
  mapTxArtistSearchResponse,
  normalizeTxArtistName,
} from './artistDiscographyMapper'

vi.hoisted(() => {
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
})

describe('QQ Music artist response mapper', () => {
  it('maps artist candidates in provider order and normalizes names for exact matching', () => {
    const result = mapTxArtistSearchResponse(txArtistSearchResponse)

    expect(result).toMatchObject({
      kind: 'ok',
      artists: [
        {
          source: 'tx',
          id: 'fixture-artist-mid',
          name: 'Fixture Artist',
          avatar: 'https://img.example.test/artist.jpg',
          albumCount: 3,
        },
        {
          id: 'fuzzy-artist-mid',
          name: 'The Fixture Artist Band',
        },
      ],
    })
    expect(normalizeTxArtistName('  ＦＩＸＴＵＲＥ Artist  ')).toBe('fixture artist')
  })

  it('distinguishes an empty search result from a malformed response', () => {
    expect(mapTxArtistSearchResponse({ code: 0, data: { singer: { list: [] } } }))
      .toEqual({ kind: 'ok', artists: [] })
    expect(mapTxArtistSearchResponse({ code: 0, data: { singer: { list: [{}] } } }))
      .toEqual({ kind: 'invalid' })
    expect(mapTxArtistSearchResponse({ code: 1, data: { singer: { list: [] } } }))
      .toEqual({ kind: 'invalid' })
  })
})

describe('QQ Music album response mapper', () => {
  it('uses albumMid as the stable album ID and preserves declared metadata', () => {
    const pages = txAlbumPageResponses.map(page => mapTxAlbumPage(
      page,
      'fixture-artist-mid',
      'Fixture Artist',
    ))

    expect(pages.map(page => page.reportedTotal)).toEqual([3, 3])
    expect(pages.flatMap(page => page.items.map(album => album.id))).toEqual([
      'fixture-album-mid-1',
      'fixture-album-mid-2',
      'fixture-album-mid-3',
    ])
    expect(pages[0].items[0]).toEqual({
      source: 'tx',
      id: 'fixture-album-mid-1',
      name: 'Fixture Album One',
      artist: 'Fixture Artist',
      releaseDate: '2024-02-29',
      image: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000fixture-album-mid-1.jpg',
      expectedTrackCount: 3,
    })
    expect(pages.every(page => page.validResponse && !page.issues.length)).toBe(true)
  })

  it('returns a stable invalid page for malformed musicu envelopes', () => {
    expect(mapTxAlbumPage({ code: 0, req: { code: 0, data: {} } }, 'artist', 'Artist'))
      .toMatchObject({
        validResponse: false,
        items: [],
        reportedTotal: null,
        issues: [expect.objectContaining({ code: 'invalid_provider_response', stage: 'albums' })],
      })
  })
})

describe('QQ Music album track response mapper', () => {
  it('converts album tracks to strict MusicInfoOnline values with album order metadata', () => {
    const pages = txAlbumTrackPageResponses.map(page => mapTxAlbumTrackPage(
      page,
      'fixture-album-mid-1',
    ))
    const tracks = pages.flatMap(page => page.items)

    expect(tracks).toHaveLength(3)
    expect(tracks[0]).toMatchObject({
      id: 'tx_fixture-song-mid-1',
      source: 'tx',
      name: 'Fixture Track One',
      singer: 'Fixture Artist',
      meta: {
        songId: 'fixture-song-mid-1',
        albumId: 'fixture-album-mid-1',
        albumMid: 'fixture-album-mid-1',
        trackNumber: 1,
        trackTotal: 3,
      },
    })
    expect(tracks[0].meta.qualitys.map(quality => quality.type)).toEqual(['128k', '320k'])
    expect(tracks[1].meta.trackNumber).toBe(2)
    expect(pages.every(page => page.validResponse && !page.issues.length)).toBe(true)
  })

  it('rejects a track whose album MID differs from the requested album', () => {
    const page = mapTxAlbumTrackPage(txWrongAlbumTrackResponse, 'fixture-album-mid-1')

    expect(page.items).toEqual([])
    expect(page.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_provider_response',
      stage: 'album_tracks',
      trackId: 'wrong-album-song-mid',
    }))
  })
})
