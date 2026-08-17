import { describe, expect, it } from 'vitest'
import {
  createArtistDiscographyModule,
  type AlbumRef,
  type ArtistCatalogPort,
  type CatalogCollection,
  type DiscographyPlanProgress,
  type PlaylistPort,
} from './index'

const artist = {
  source: 'kg' as const,
  id: 'artist-1',
  name: 'Artist',
  avatar: null,
  albumCount: 2,
}

const makeAlbum = (
  id: string,
  expectedTrackCount: number | null = 1,
  name = `Album ${id}`,
): AlbumRef => ({
  source: 'kg',
  id,
  name,
  artist: artist.name,
  releaseDate: null,
  image: null,
  expectedTrackCount,
})

const makeTrack = (
  id: string,
  albumId: string,
  singer = artist.name,
): LX.Music.MusicInfoOnline => ({
  id,
  name: `Track ${id}`,
  singer,
  source: 'kg',
  interval: '03:00',
  meta: {
    songId: id,
    albumId,
    albumName: `Album ${albumId}`,
    picUrl: null,
    qualitys: [{ type: '128k', size: '3 MB', hash: `hash-${id}` }],
    _qualitys: {
      '128k': { size: '3 MB', hash: `hash-${id}` },
    },
    hash: `hash-${id}`,
  },
})

const collection = <T>(
  items: T[],
  options: Partial<Omit<CatalogCollection<T>, 'items'>> = {},
): CatalogCollection<T> => ({
    items,
    reportedTotal: items.length,
    complete: true,
    issues: [],
    ...options,
  })

const noOpPlaylist: PlaylistPort = {
  create: async() => {},
  add: async() => {},
  remove: async() => {},
}

describe('artist discography plan interface', () => {
  it('validates complete album details before excluding non-participating tracks from source assembly', async() => {
    const albums = [
      { ...makeAlbum('a', 2, 'Same name'), releaseDate: '2020-01-02' },
      makeAlbum('b', 2, 'Same name'),
    ]
    const detailCalls: string[] = []
    let artistTrackCalls = 0
    const progress: DiscographyPlanProgress[] = []
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => artist,
      getArtistAlbums: async() => collection(albums),
      getArtistTracks: async() => {
        artistTrackCalls++
        return collection([
          makeTrack('hint-a1', 'a'),
          makeTrack('hint-a2', 'a'),
          makeTrack('hint-b1', 'b'),
          makeTrack('hint-b2', 'b'),
        ])
      },
      getAlbumTracks: async(albumId) => {
        detailCalls.push(albumId)
        return albumId == 'a'
          ? collection([makeTrack('a1', 'a'), makeTrack('a2', 'a', 'Guest singer')])
          : collection([makeTrack('b1', 'b'), makeTrack('b2', 'b')])
      },
    }
    const module = createArtistDiscographyModule({
      catalog,
      playlist: noOpPlaylist,
      albumConcurrency: 1,
      now: () => 123,
    })

    const plan = await module.plan({
      source: 'kg',
      artistRef: artist.id,
      onProgress: value => progress.push(value),
    })

    expect(plan.status).toBe('complete')
    expect(plan.fetchedAt).toBe(123)
    expect(plan.albums.map(item => item.album.id)).toEqual(['a', 'b'])
    expect(plan.albums.map(item => item.album.name)).toEqual(['Same name', 'Same name'])
    expect(plan.albums[0].tracks[1].singer).toBe('Guest singer')
    expect(plan.albums.map(item => item.status)).toEqual(['complete', 'complete'])
    expect(plan.albums.map(item => item.actualCount)).toEqual([2, 2])
    expect(plan.tracks.map(track => track.id)).toEqual(['a1', 'b1', 'b2'])
    expect(plan.rawTrackCount).toBe(3)
    expect(plan.deduplicatedTrackCount).toBe(3)
    expect(plan.issues).not.toContainEqual(expect.objectContaining({ code: 'album_incomplete' }))
    expect(plan.albums[0].tracks.map(track => track.meta)).toMatchObject([
      { discographyArtist: 'Artist', albumArtist: 'Artist', releaseDate: '2020-01-02', trackNumber: 1, trackTotal: 2 },
      { discographyArtist: 'Artist', albumArtist: 'Artist', releaseDate: '2020-01-02', trackNumber: 2, trackTotal: 2 },
    ])
    expect(artistTrackCalls).toBe(1)
    expect(detailCalls).toEqual(['a', 'b'])
    expect(progress[0]).toEqual({ stage: 'resolving_artist' })
    expect(progress.some(item => item.stage == 'fetching_albums')).toBe(true)
    expect(progress.filter(item => item.stage == 'fetching_album_tracks' && item.phase == 'completed'))
      .toMatchObject([
        { albumId: 'a', completed: 1, total: 2 },
        { albumId: 'b', completed: 2, total: 2 },
      ])
    expect(progress.at(-1)).toEqual({
      stage: 'completed',
      status: 'complete',
      completed: 2,
      total: 2,
    })
  })

  it('blocks a complete nonempty album when every track is excluded by artist participation', async() => {
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => ({ ...artist, albumCount: 1 }),
      getArtistAlbums: async() => collection([makeAlbum('a', 2)]),
      getAlbumTracks: async() => collection([
        makeTrack('a1', 'a', 'Other singer'),
        makeTrack('a2', 'a', 'Artist Studio'),
      ]),
    }
    const module = createArtistDiscographyModule({ catalog, playlist: noOpPlaylist })

    const plan = await module.plan({ source: 'kg', artistRef: artist.id })

    expect(plan.status).toBe('failed')
    expect(plan.canApply).toBe(false)
    expect(plan.tracks).toEqual([])
    expect(plan.rawTrackCount).toBe(0)
    expect(plan.albums[0]).toMatchObject({ status: 'complete', actualCount: 2 })
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'empty_catalog' }))
    expect(plan.issues).not.toContainEqual(expect.objectContaining({ code: 'album_incomplete' }))
  })

  it('validates albums before globally folding the same stable track ID', async() => {
    const albums = [makeAlbum('a', 2), makeAlbum('b', 2)]
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => artist,
      getArtistAlbums: async() => collection(albums),
      getAlbumTracks: async(albumId) => collection(albumId == 'a'
        ? [makeTrack('shared', 'a'), makeTrack('a2', 'a')]
        : [makeTrack('shared', 'b'), makeTrack('b2', 'b')]),
    }
    const module = createArtistDiscographyModule({ catalog, playlist: noOpPlaylist })

    const plan = await module.plan({ source: 'kg', artistRef: artist.id })

    expect(plan.status).toBe('complete')
    expect(plan.albums.map(album => album.actualCount)).toEqual([2, 2])
    expect(plan.rawTrackCount).toBe(4)
    expect(plan.deduplicatedTrackCount).toBe(3)
    expect(plan.tracks.map(track => track.id)).toEqual(['shared', 'a2', 'b2'])
    expect(plan.deduplications).toEqual([
      expect.objectContaining({
        kind: 'duplicate_track',
        scope: 'source_assembly',
        stableId: 'shared',
        reason: 'first_occurrence',
        kept: expect.objectContaining({ albumId: 'a', albumPosition: 1, trackPosition: 1 }),
        removed: expect.objectContaining({ albumId: 'b', albumPosition: 2, trackPosition: 1 }),
      }),
    ])
    expect(plan.issues).toContainEqual(expect.objectContaining({
      code: 'duplicate_track',
      albumId: 'b',
      relatedAlbumId: 'a',
      trackId: 'shared',
      severity: 'warning',
    }))
  })

  it('marks missing declared counts as unknown and count mismatches as incomplete', async() => {
    const fixtureArtist = { ...artist, albumCount: 2 }
    const albums = [makeAlbum('unknown', null), makeAlbum('short', 2)]
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => fixtureArtist,
      getArtistAlbums: async() => collection(albums),
      getAlbumTracks: async(albumId) => collection([makeTrack(`${albumId}-1`, albumId)]),
    }
    const module = createArtistDiscographyModule({ catalog, playlist: noOpPlaylist })

    const plan = await module.plan({ source: 'kg', artistRef: artist.id })

    expect(plan.status).toBe('partial')
    expect(plan.canApply).toBe(true)
    expect(plan.albums.map(album => album.status)).toEqual(['unknown', 'incomplete'])
    expect(plan.albums[1].issues).toContainEqual(expect.objectContaining({
      code: 'album_incomplete',
      expected: 2,
      actual: 1,
    }))
  })

  it('keeps successful albums when one album detail request fails', async() => {
    const albums = [makeAlbum('available'), makeAlbum('offline')]
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => artist,
      getArtistAlbums: async() => collection(albums),
      getAlbumTracks: async(albumId) => {
        if (albumId == 'offline') throw new Error('network details must not escape')
        return collection([makeTrack('available-1', 'available')])
      },
    }
    const module = createArtistDiscographyModule({ catalog, playlist: noOpPlaylist })

    const plan = await module.plan({ source: 'kg', artistRef: artist.id })

    expect(plan.status).toBe('partial')
    expect(plan.canApply).toBe(true)
    expect(plan.tracks.map(track => track.id)).toEqual(['available-1'])
    expect(plan.albums.find(album => album.album.id == 'offline')).toMatchObject({
      status: 'failed',
      actualCount: 0,
      issues: [expect.objectContaining({ code: 'provider_unavailable', retryable: true })],
    })
  })

  it('treats duplicate album IDs and an incomplete catalog as a partial result', async() => {
    const album = makeAlbum('a')
    let detailCalls = 0
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => ({ ...artist, albumCount: 2 }),
      getArtistAlbums: async() => collection([album, { ...album }], {
        reportedTotal: 2,
        complete: false,
      }),
      getAlbumTracks: async() => {
        detailCalls++
        return collection([makeTrack('a1', 'a')])
      },
    }
    const module = createArtistDiscographyModule({ catalog, playlist: noOpPlaylist })

    const plan = await module.plan({ source: 'kg', artistRef: artist.id })

    expect(plan.status).toBe('partial')
    expect(plan.actualAlbumCount).toBe(1)
    expect(detailCalls).toBe(1)
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'duplicate_album' }))
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'pagination_inconsistent' }))
  })

  it('limits album detail concurrency to three', async() => {
    const albums = Array.from({ length: 7 }, (_, index) => makeAlbum(String(index)))
    let active = 0
    let maxActive = 0
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => ({ ...artist, albumCount: albums.length }),
      getArtistAlbums: async() => collection(albums),
      getAlbumTracks: async(albumId) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return collection([makeTrack(`track-${albumId}`, albumId)])
      },
    }
    const module = createArtistDiscographyModule({
      catalog,
      playlist: noOpPlaylist,
      albumConcurrency: 99,
    })

    const plan = await module.plan({ source: 'kg', artistRef: artist.id })

    expect(plan.status).toBe('complete')
    expect(maxActive).toBe(3)
  })

  it('stops dispatching new album requests after cancellation', async() => {
    const controller = new AbortController()
    const albums = [makeAlbum('a'), makeAlbum('b'), makeAlbum('c')]
    const detailCalls: string[] = []
    const progress: DiscographyPlanProgress[] = []
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => ({ ...artist, albumCount: albums.length }),
      getArtistAlbums: async() => collection(albums),
      getAlbumTracks: async(albumId) => {
        detailCalls.push(albumId)
        controller.abort()
        const error = new Error('cancelled')
        error.name = 'AbortError'
        throw error
      },
    }
    const module = createArtistDiscographyModule({
      catalog,
      playlist: noOpPlaylist,
      albumConcurrency: 1,
    })

    const plan = await module.plan({
      source: 'kg',
      artistRef: artist.id,
      signal: controller.signal,
      onProgress: value => progress.push(value),
    })

    expect(plan.status).toBe('cancelled')
    expect(plan.canApply).toBe(false)
    expect(detailCalls).toEqual(['a'])
    expect(progress.filter(item => item.stage == 'fetching_album_tracks' && item.phase == 'started'))
      .toMatchObject([{ albumId: 'a' }])
    expect(progress.at(-1)).toMatchObject({ stage: 'completed', status: 'cancelled' })
  })

  it('does not fetch albums until the resolved artist is confirmed', async() => {
    let albumCalls = 0
    let detailCalls = 0
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => artist,
      getArtistAlbums: async() => {
        albumCalls++
        return collection([makeAlbum('a')])
      },
      getAlbumTracks: async() => {
        detailCalls++
        return collection([makeTrack('a1', 'a')])
      },
    }
    const module = createArtistDiscographyModule({ catalog, playlist: noOpPlaylist })

    const plan = await module.plan({
      source: 'kg',
      artistRef: artist.id,
      confirmArtist: async resolvedArtist => {
        expect(resolvedArtist).toEqual(artist)
        return false
      },
    })

    expect(plan.status).toBe('cancelled')
    expect(plan.canApply).toBe(false)
    expect(albumCalls).toBe(0)
    expect(detailCalls).toBe(0)
  })

  it('keeps plan failures read-only', async() => {
    let playlistCalls = 0
    const playlist: PlaylistPort = {
      create: async() => { playlistCalls++ },
      add: async() => { playlistCalls++ },
      remove: async() => { playlistCalls++ },
    }
    const catalog: ArtistCatalogPort = {
      resolveArtist: async() => { throw new Error('offline') },
      getArtistAlbums: async() => collection([]),
      getAlbumTracks: async() => collection([]),
    }
    const module = createArtistDiscographyModule({ catalog, playlist })

    const plan = await module.plan({ source: 'kg', artistRef: artist.id })

    expect(plan.status).toBe('failed')
    expect(plan.canApply).toBe(false)
    expect(plan.issues).toContainEqual(expect.objectContaining({ code: 'provider_unavailable' }))
    expect(playlistCalls).toBe(0)
  })
})
