import { describe, expect, it } from 'vitest'
import {
  kgAlbumPageResponses,
  kgAlbumTrackPageResponses,
  kgExpandedTracks,
  kgInvalidExpandedTracks,
  kgNumericArtistResponseWithoutAvatar,
  kgTokenArtistResponse,
} from './__fixtures__/artistDiscography'
import {
  mapKgAlbumPage,
  mapKgArtist,
  mapKgArtistResponse,
  mapKgArtistSearchResponse,
  mapKgExpandedTracks,
  mapKgRawAlbumTrackPage,
  normalizeKgImage,
  parseKgArtistReference,
} from './artistDiscographyMapper'

describe('KuGou artist reference mapper', () => {
  it('accepts numeric IDs, current tokens, and only official artist links', () => {
    expect(parseKgArtistReference('3060')).toEqual({ kind: 'numeric', value: '3060' })
    expect(parseKgArtistReference('2VKKFCC4A8D4')).toEqual({ kind: 'token', value: '2VKKFCC4A8D4' })
    expect(parseKgArtistReference('https://www.kugou.com/singer/info/2VKKFCC4A8D4/'))
      .toEqual({ kind: 'token', value: '2VKKFCC4A8D4' })
    expect(parseKgArtistReference('https://m.kugou.com/singer/info/3060/?from=test'))
      .toEqual({ kind: 'numeric', value: '3060' })
    expect(parseKgArtistReference('https://www.kugou.com.evil.test/singer/info/3060/')).toBeNull()
    expect(parseKgArtistReference('https://www.kugou.com/song/info/3060/')).toBeNull()
    expect(parseKgArtistReference('Fixture Artist')).toBeNull()
  })

  it('maps token and legacy artist responses without inferring gender from grade', () => {
    expect(mapKgArtist(kgTokenArtistResponse)).toEqual({
      source: 'kg',
      id: '3060',
      name: 'Fixture Artist',
      avatar: 'https://img.example.test/480/artist.jpg',
      albumCount: 5,
    })
    expect(mapKgArtist(kgNumericArtistResponseWithoutAvatar)).toEqual({
      source: 'kg',
      id: '3060',
      name: 'Fixture Artist',
      avatar: null,
      albumCount: 5,
    })
    expect(mapKgArtist({ info: { singerid: 0, singername: '' } })).toBeNull()
  })

  it('distinguishes an explicit missing artist from a malformed successful response', () => {
    expect(mapKgArtistResponse({ status: 0, errcode: 0, data: null, error: '参数不合法' }))
      .toEqual({ kind: 'not_found' })
    expect(mapKgArtistResponse({ status: 0, errcode: 0, data: null, error: '系统繁忙' }))
      .toEqual({ kind: 'invalid' })
    expect(mapKgArtistResponse({ status: 0, errcode: 500, data: null, error: '参数不合法' }))
      .toEqual({ kind: 'invalid' })
    expect(mapKgArtistResponse({ status: 2, errcode: 0, data: null, error: 'unknown status' }))
      .toEqual({ kind: 'invalid' })
    expect(mapKgArtistResponse({ status: 1, errcode: 0, data: null }))
      .toEqual({ kind: 'invalid' })
    expect(mapKgArtistResponse({ status: 'invalid', data: null }))
      .toEqual({ kind: 'invalid' })
    expect(mapKgArtistResponse({ status: 1, data: { singerid: 3060 } }))
      .toEqual({ kind: 'invalid' })
  })

  it('maps current and legacy singer-search envelopes in provider order', () => {
    const current = mapKgArtistSearchResponse({
      status: 1,
      errcode: 0,
      data: [
        { singername: '蔡徐坤', singerid: 192980 },
        { singername: '伊伊在想蔡徐坤', singerid: 5667153 },
      ],
    })
    const legacy = mapKgArtistSearchResponse({
      data: { info: [{ singername: 'Adele', singerid: 1961 }] },
    })

    expect(current).toMatchObject({
      kind: 'ok',
      artists: [
        { id: '192980', name: '蔡徐坤' },
        { id: '5667153', name: '伊伊在想蔡徐坤' },
      ],
    })
    expect(legacy).toMatchObject({ kind: 'ok', artists: [{ id: '1961', name: 'Adele' }] })
  })

  it('distinguishes empty singer search results from malformed responses', () => {
    expect(mapKgArtistSearchResponse({ status: 1, errcode: 0, data: [] }))
      .toEqual({ kind: 'ok', artists: [] })
    expect(mapKgArtistSearchResponse({ status: 1, errcode: 0, data: null, error: '' }))
      .toEqual({ kind: 'ok', artists: [] })
    expect(mapKgArtistSearchResponse({ status: 1, errcode: 0, data: [{}] }))
      .toEqual({ kind: 'invalid' })
    expect(mapKgArtistSearchResponse({ status: 0, errcode: 500, data: [] }))
      .toEqual({ kind: 'invalid' })
  })
})

describe('KuGou album response mapper', () => {
  it('maps first, middle, and final album pages in provider order', () => {
    const pages = kgAlbumPageResponses.map(page => mapKgAlbumPage(page, '3060', 'Fixture Artist'))

    expect(pages.map(page => page.reportedTotal)).toEqual([5, 5, 5])
    expect(pages.flatMap(page => page.items.map(album => album.id)))
      .toEqual(['101', '102', '103', '104', '105'])
    expect(pages[0].items[0]).toMatchObject({
      id: '101',
      name: 'Album A',
      image: 'https://img.example.test/480/a.jpg',
      releaseDate: '2017-12-15',
      expectedTrackCount: 2,
    })
    expect(pages[0].items[1].image).toBeNull()
    expect(pages.every(page => page.validResponse && !page.issues.length)).toBe(true)
  })

  it('keeps only complete valid album release dates', () => {
    const page = mapKgAlbumPage({
      data: {
        total: 2,
        info: [
          { albumid: 101, albumname: 'Valid', singername: 'Fixture Artist', songcount: 1, publishtime: '2024-02-29 00:00:00' },
          { albumid: 102, albumname: 'Invalid', singername: 'Fixture Artist', songcount: 1, publishtime: '2024-02-30' },
        ],
      },
    }, '3060', 'Fixture Artist')

    expect(page.items.map(album => album.releaseDate)).toEqual(['2024-02-29', null])
  })

  it('reports malformed rows and never calls string methods on album objects', () => {
    const page = mapKgAlbumPage({
      data: {
        total: 2,
        info: [
          { albumid: 101, albumname: 'Valid', singername: 'Fixture Artist', songcount: 'invalid' },
          { albumname: 'Missing ID', singername: 'Fixture Artist', songcount: 1 },
        ],
      },
    }, '3060', 'Fixture Artist')

    expect(page.items).toHaveLength(1)
    expect(page.items[0].expectedTrackCount).toBeNull()
    expect(page.issues).toHaveLength(2)
    expect(normalizeKgImage(undefined, 480)).toBeNull()
  })

  it('returns a stable invalid response instead of throwing a TypeError', () => {
    expect(mapKgAlbumPage({ data: { info: null } }, '3060', 'Fixture Artist')).toMatchObject({
      validResponse: false,
      items: [],
      reportedTotal: null,
    })
  })
})

describe('KuGou album track response mapper', () => {
  it('maps every raw detail page and preserves album membership', () => {
    const pages = kgAlbumTrackPageResponses.map(page => mapKgRawAlbumTrackPage(page, '101'))

    expect(pages.map(page => page.reportedTotal)).toEqual([3, 3])
    expect(pages.flatMap(page => page.pageKeys)).toEqual([
      '501_HASH_A',
      '502_HASH_B',
      '503_HASH_C',
    ])
    expect(pages.every(page => page.validResponse && !page.issues.length)).toBe(true)
  })

  it('rejects raw tracks without a hash or with a different album ID', () => {
    const page = mapKgRawAlbumTrackPage({
      data: {
        total: 2,
        info: [
          { audio_id: 501, album_audio_id: 1501, album_id: '101' },
          { audio_id: 502, album_audio_id: 1502, hash: 'HASH_B', album_id: '999' },
        ],
      },
    }, '101')

    expect(page.items).toEqual([])
    expect(page.issues).toHaveLength(2)
  })

  it('converts expanded tracks to strict MusicInfoOnline values', () => {
    const mapped = mapKgExpandedTracks(kgExpandedTracks, '101')

    expect(mapped.issues).toEqual([])
    expect(mapped.items).toHaveLength(2)
    expect(mapped.items[0]).toMatchObject({
      id: '501_HASH_A',
      name: 'Track 501',
      source: 'kg',
      meta: {
        songId: 501,
        albumId: 101,
        hash: 'HASH_A',
      },
    })
    expect(mapped.items[1].singer).toContain('Guest Artist')
  })

  it('reports invalid expanded tracks without leaking them into the catalog', () => {
    const mapped = mapKgExpandedTracks(kgInvalidExpandedTracks, '101')

    expect(mapped.items).toEqual([])
    expect(mapped.issues).toHaveLength(2)
    expect(mapped.issues.every(issue => issue.code == 'invalid_provider_response')).toBe(true)
  })
})
