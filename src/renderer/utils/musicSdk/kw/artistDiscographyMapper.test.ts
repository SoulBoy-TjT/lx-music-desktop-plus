import { describe, expect, it, vi } from 'vitest'
import {
  kwAlbumPageResponses,
  kwAlbumTrackPageResponses,
  kwArtistSearchResponse,
  kwInvalidPseudoJsonResponse,
  kwZeroBasedAlbumTrackResponse,
} from './__fixtures__/artistDiscography'
import {
  mapKwAlbumPage,
  mapKwAlbumTrackPage,
  mapKwArtistSearchResponse,
  parseKwPseudoJson,
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

describe('Kuwo artist discography mapper', () => {
  it('parses the provider pseudo JSON and preserves candidate order', () => {
    expect(parseKwPseudoJson(kwArtistSearchResponse)).toBeTruthy()
    expect(mapKwArtistSearchResponse(kwArtistSearchResponse)).toMatchObject({
      kind: 'ok',
      artists: [
        { source: 'kw', id: '192980', name: '蔡徐坤', albumCount: 3 },
        { source: 'kw', id: '192981', name: '蔡徐坤', albumCount: 1 },
        { source: 'kw', id: '5667153', name: '伊伊在想蔡徐坤', albumCount: 2 },
      ],
    })
  })

  it('returns an invalid result when the pseudo JSON cannot be parsed', () => {
    expect(parseKwPseudoJson(kwInvalidPseudoJsonResponse)).toBeNull()
    expect(mapKwArtistSearchResponse(kwInvalidPseudoJsonResponse)).toEqual({ kind: 'invalid' })
  })

  it('maps zero-based album pages with strict pagination metadata', () => {
    const first = mapKwAlbumPage(kwAlbumPageResponses[0], '192980', 0)
    const second = mapKwAlbumPage(kwAlbumPageResponses[1], '192980', 1)

    expect(first).toMatchObject({
      reportedTotal: 3,
      rawItemCount: 2,
      validResponse: true,
      issues: [],
    })
    expect([...first.items, ...second.items]).toEqual([
      expect.objectContaining({
        source: 'kw',
        id: '101',
        name: 'Album A',
        artist: 'Fixture Artist',
        releaseDate: '2017-12-15',
        expectedTrackCount: 3,
      }),
      expect.objectContaining({ id: '102' }),
      expect.objectContaining({ id: '103' }),
    ])
    expect(mapKwAlbumPage(kwAlbumPageResponses[1], '192980', 0).validResponse).toBe(false)
  })

  it('strictly converts album tracks and maps every supported format', () => {
    const first = mapKwAlbumTrackPage(kwAlbumTrackPageResponses[0], '101')
    const second = mapKwAlbumTrackPage(kwAlbumTrackPageResponses[1], '101')

    expect(first).toMatchObject({
      reportedTotal: 3,
      rawItemCount: 2,
      validResponse: true,
      issues: [],
    })
    expect(first.items[0]).toEqual(expect.objectContaining({
      id: 'kw_501',
      name: 'Track A',
      source: 'kw',
      interval: '03:00',
      meta: expect.objectContaining({
        songId: '501',
        albumId: '101',
        albumName: 'Album A',
        trackNumber: 1,
        qualitys: [
          { type: '128k', size: null },
          { type: '320k', size: null },
          { type: 'flac', size: null },
          { type: 'flac24bit', size: null },
        ],
      }),
    }))
    expect(first.items[1]).toMatchObject({
      singer: 'Fixture Artist、Guest Artist',
      meta: { trackNumber: 2 },
    })
    expect(second.items[0]).toMatchObject({
      id: 'kw_503',
      meta: { albumId: '101', trackNumber: 3 },
    })
  })

  it('normalizes a complete zero-based album track sequence to one-based positions', () => {
    const mapped = mapKwAlbumTrackPage(kwZeroBasedAlbumTrackResponse, '201')

    expect(mapped).toMatchObject({
      reportedTotal: 19,
      rawItemCount: 19,
      validResponse: true,
      issues: [],
    })
    expect(mapped.items).toHaveLength(19)
    expect(mapped.items.map(track => track.meta.trackNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      11, 12, 13, 14, 15, 16, 17, 18, 19,
    ])
  })

  it('preserves a reliable one-based sequence gap instead of compressing positions', () => {
    const mapped = mapKwAlbumTrackPage({
      musiclist: [1, 2, 3, 5].map((trackNumber, index) => ({
        id: String(1001 + index),
        name: `One Based Track ${trackNumber}`,
        artist: 'Fixture Artist',
        formats: 'MP3128',
        duration: '180',
        track: String(trackNumber),
      })),
      songnum: '4',
      albumid: '203',
      name: 'One Based Gap Album',
      artist: 'Fixture Artist',
    }, '203')

    expect(mapped.issues).toEqual([])
    expect(mapped.items.map(track => track.meta.trackNumber)).toEqual([1, 2, 3, 5])
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['non-numeric', 'invalid'],
  ] as const)('still rejects a %s provider track number', (_scenario, trackNumber) => {
    const mapped = mapKwAlbumTrackPage({
      musiclist: [{
        id: '1101',
        name: 'Invalid Track Number',
        artist: 'Fixture Artist',
        formats: 'MP3128',
        duration: '180',
        track: trackNumber,
      }],
      songnum: '1',
      albumid: '204',
      name: 'Invalid Track Number Album',
      artist: 'Fixture Artist',
    }, '204')

    expect(mapped.items).toEqual([])
    expect(mapped.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_provider_response',
      trackId: '1101',
    }))
  })

  it('rejects a non-contiguous zero-based sequence instead of partially shifting it', () => {
    const mapped = mapKwAlbumTrackPage({
      musiclist: [0, 2].map((trackNumber, index) => ({
        id: String(1201 + index),
        name: `Broken Zero Based Track ${index + 1}`,
        artist: 'Fixture Artist',
        formats: 'MP3128',
        duration: '180',
        track: String(trackNumber),
      })),
      songnum: '2',
      albumid: '205',
      name: 'Broken Zero Based Album',
      artist: 'Fixture Artist',
    }, '205')

    expect(mapped.items).toEqual([])
    expect(mapped.issues).toHaveLength(2)
    expect(mapped.issues.every(issue => issue.code == 'invalid_provider_response')).toBe(true)
  })

  it('upgrades trusted Kuwo 240px album covers before publishing track metadata', () => {
    const mapped = mapKwAlbumTrackPage({
      musiclist: [
        {
          id: '501',
          name: 'Track A',
          artist: 'Fixture Artist',
          formats: 'ALFLAC',
          duration: '180',
          track: '1',
          pic: null,
        },
        {
          id: '502',
          name: 'Track B',
          artist: 'Fixture Artist',
          formats: 'ALFLAC',
          duration: '180',
          track: '2',
          pic: 'https://img1.kwcdn.kuwo.cn/star/albumcover/240/s4s61/67/track.jpg',
        },
      ],
      songnum: '2',
      albumid: '101',
      name: 'Album A',
      artist: 'Fixture Artist',
      img: 'http://img4.sycdn.kuwo.cn/star/albumcover/240/s4s82/31/album.jpg',
    }, '101')

    expect(mapped.issues).toEqual([])
    expect(mapped.items.map(track => track.meta.picUrl)).toEqual([
      'http://img4.sycdn.kuwo.cn/star/albumcover/500/s4s82/31/album.jpg',
      'https://img1.kwcdn.kuwo.cn/star/albumcover/500/s4s61/67/track.jpg',
    ])
  })

  it('leaves non-target album cover URL shapes unchanged', () => {
    const mapped = mapKwAlbumTrackPage({
      musiclist: [
        'https://img1.kuwo.cn.evil.test/star/albumcover/240/untrusted.jpg',
        'https://img1.kuwo.cn/star/albumcover/500/already-sized.jpg',
        'https://img1.kuwo.cn/star/albumcover/1000/already-large.jpg',
        'https://img1.kuwo.cn/star/albumcover/cover.jpg?size=240',
        'https://img1.kuwo.cn/prefix/star/albumcover/240/nested.jpg',
        'https://',
        '/star/albumcover/240/relative.jpg',
        '//img2.kuwo.cn/star/albumcover/240/protocol-relative.jpg',
      ].map((pic, index) => ({
        id: String(601 + index),
        name: `Track ${index + 1}`,
        artist: 'Fixture Artist',
        formats: 'ALFLAC',
        duration: '180',
        track: String(index + 1),
        pic,
      })),
      songnum: '8',
      albumid: '101',
      name: 'Album A',
      artist: 'Fixture Artist',
      img: 'https://img.example.test/fallback.jpg',
    }, '101')

    expect(mapped.issues).toEqual([])
    expect(mapped.items.map(track => track.meta.picUrl)).toEqual([
      'https://img1.kuwo.cn.evil.test/star/albumcover/240/untrusted.jpg',
      'https://img1.kuwo.cn/star/albumcover/500/already-sized.jpg',
      'https://img1.kuwo.cn/star/albumcover/1000/already-large.jpg',
      'https://img1.kuwo.cn/star/albumcover/cover.jpg?size=240',
      'https://img1.kuwo.cn/prefix/star/albumcover/240/nested.jpg',
      'https://',
      'https://img.example.test/fallback.jpg',
      '//img2.kuwo.cn/star/albumcover/500/protocol-relative.jpg',
    ])
  })

  it('rejects a different response album ID and invalid track fields', () => {
    const wrongAlbum = mapKwAlbumTrackPage(kwAlbumTrackPageResponses[0], '999')
    const invalidTrack = mapKwAlbumTrackPage({
      musiclist: [{
        id: '501',
        name: 'Track A',
        artist: 'Fixture Artist',
        formats: 'MP3128',
        duration: '180',
        track: '-1',
      }],
      songnum: '1',
      albumid: '101',
      name: 'Album A',
      artist: 'Fixture Artist',
    }, '101')

    expect(wrongAlbum.validResponse).toBe(false)
    expect(wrongAlbum.items).toEqual([])
    expect(invalidTrack.items).toEqual([])
    expect(invalidTrack.issues).toContainEqual(expect.objectContaining({
      code: 'invalid_provider_response',
      trackId: '501',
    }))
  })
})
