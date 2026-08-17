import { describe, expect, it } from 'vitest'
import {
  assembleDiscographyTracks,
  createArtistDiscographyModule,
  type AlbumRef,
  type ArtistCatalogPort,
  type DiscographyAlbumPlan,
  type DiscographyPlan,
  type PlaylistPort,
} from './index'
import { prepareArtistDiscographyApply } from './apply'

const makeTrack = (
  id: string,
  albumId: string,
  name = `Track ${id}`,
): LX.Music.MusicInfoOnline => ({
  id,
  name,
  singer: 'Artist',
  source: 'kg',
  interval: '03:00',
  meta: {
    songId: id,
    albumId,
    albumName: `Album ${albumId}`,
    qualitys: [{ type: '128k', size: '3 MB', hash: `hash-${id}` }],
    _qualitys: {
      '128k': { size: '3 MB', hash: `hash-${id}` },
    },
    hash: `hash-${id}`,
  },
})

const makeAlbumPlan = (
  id: string,
  tracks: LX.Music.MusicInfoOnline[],
  status: DiscographyAlbumPlan['status'] = 'complete',
): DiscographyAlbumPlan => {
  const album: AlbumRef = {
    source: 'kg',
    id,
    name: `Album ${id}`,
    artist: 'Artist',
    releaseDate: null,
    image: null,
    expectedTrackCount: tracks.length,
  }
  return {
    album,
    tracks,
    expectedCount: tracks.length,
    actualCount: tracks.length,
    status,
    issues: [],
  }
}

const makePlan = (
  albums: DiscographyAlbumPlan[],
  status: DiscographyPlan['status'] = 'complete',
): DiscographyPlan => {
  const assembled = assembleDiscographyTracks(albums, 'Artist')
  return {
    source: 'kg',
    status,
    artist: {
      source: 'kg',
      id: 'artist-1',
      name: 'Artist',
      avatar: null,
      albumCount: albums.length,
    },
    expectedAlbumCount: albums.length,
    actualAlbumCount: albums.length,
    albums,
    tracks: assembled.tracks,
    deduplications: assembled.deduplications,
    rawTrackCount: assembled.rawTrackCount,
    deduplicatedTrackCount: assembled.tracks.length,
    canApply: (status == 'complete' || status == 'partial') && assembled.tracks.length > 0,
    fetchedAt: 123,
    issues: [],
  }
}

const unusedCatalog: ArtistCatalogPort = {
  resolveArtist: async() => { throw new Error('not used') },
  getArtistAlbums: async() => { throw new Error('not used') },
  getAlbumTracks: async() => { throw new Error('not used') },
}

describe('artist discography apply interface', () => {
  it('writes only selected albums and re-deduplicates selected tracks', async() => {
    const added: Array<{ id: string, tracks: LX.Music.MusicInfoOnline[] }> = []
    const playlist: PlaylistPort = {
      create: async() => {},
      add: async(id, tracks) => { added.push({ id, tracks }) },
      remove: async() => {},
    }
    const albumA = makeAlbumPlan('a', [makeTrack('shared', 'a'), makeTrack('a2', 'a')])
    const albumB = makeAlbumPlan('b', [makeTrack('shared', 'b'), makeTrack('b2', 'b')])
    const module = createArtistDiscographyModule({ catalog: unusedCatalog, playlist })
    const plan = makePlan([albumA, albumB])

    const selectedResult = await module.apply({
      plan,
      albumIds: ['b'],
      target: { type: 'existing', listId: 'existing-b' },
    })
    const allResult = await module.apply({
      plan,
      albumIds: ['a', 'b'],
      target: { type: 'existing', listId: 'existing-all' },
    })

    expect(selectedResult.status).toBe('applied')
    expect(selectedResult.plannedTrackCount).toBe(2)
    expect(allResult.status).toBe('applied')
    expect(allResult.plannedTrackCount).toBe(3)
    expect(added).toHaveLength(2)
    expect(added[0].tracks.map(track => track.id)).toEqual(['shared', 'b2'])
    expect(added[1].tracks.map(track => track.id)).toEqual(['shared', 'a2', 'b2'])
  })

  it('recomputes selection deduplications and submits the exact assembled tracks', async() => {
    const added: LX.Music.MusicInfoOnline[][] = []
    const playlist: PlaylistPort = {
      create: async() => {},
      add: async(_id, tracks) => { added.push(tracks) },
      remove: async() => {},
    }
    const albumA = makeAlbumPlan('a', [makeTrack('shared', 'a', 'Shared from A')])
    const albumB = makeAlbumPlan('b', [
      makeTrack('shared', 'b', 'Shared from B'),
      makeTrack('b2', 'b'),
    ])
    const albumC = makeAlbumPlan('c', [makeTrack('shared', 'c', 'Shared from C')])
    const plan = makePlan([albumA, albumB, albumC])
    const selectedAssembly = assembleDiscographyTracks([albumB, albumC], 'Artist')
    const input = {
      plan,
      albumIds: ['c', 'b'],
      target: { type: 'existing' as const, listId: 'existing-selected' },
    }

    const prepared = prepareArtistDiscographyApply(input)
    const module = createArtistDiscographyModule({ catalog: unusedCatalog, playlist })
    const result = await module.apply(input)

    expect(plan.deduplications[0]).toMatchObject({
      stableId: 'shared',
      kept: { albumId: 'a', trackName: 'Shared from A' },
      removed: { albumId: 'b', trackName: 'Shared from B' },
    })
    expect(prepared.issues).toEqual([])
    expect(prepared.deduplications).toEqual(selectedAssembly.deduplications)
    expect(prepared.deduplications).toHaveLength(1)
    expect(prepared.deduplications[0]).toMatchObject({
      stableId: 'shared',
      kept: { albumId: 'b', trackName: 'Shared from B', albumPosition: 1 },
      removed: { albumId: 'c', trackName: 'Shared from C', albumPosition: 2 },
    })
    expect(prepared.tracks.map(track => [track.id, track.name])).toEqual([
      ['shared', 'Shared from B'],
      ['b2', 'Track b2'],
    ])
    expect(result.status).toBe('applied')
    expect(added).toEqual([selectedAssembly.tracks])
  })

  it('rejects an empty selection without touching playlists', async() => {
    let playlistCalls = 0
    const playlist: PlaylistPort = {
      create: async() => { playlistCalls++ },
      add: async() => { playlistCalls++ },
      remove: async() => { playlistCalls++ },
    }
    const module = createArtistDiscographyModule({ catalog: unusedCatalog, playlist })
    const plan = makePlan([makeAlbumPlan('a', [makeTrack('a1', 'a')])])

    const result = await module.apply({
      plan,
      albumIds: [],
      target: { type: 'new', name: 'Discography' },
    })

    expect(result.status).toBe('failed')
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'invalid_album_selection' }))
    expect(playlistCalls).toBe(0)
  })

  it('applies a partial plan automatically when it contains valid tracks', async() => {
    const calls: string[] = []
    const playlist: PlaylistPort = {
      create: async(id) => { calls.push(`create:${id}`) },
      add: async(id) => { calls.push(`add:${id}`) },
      remove: async(id) => { calls.push(`remove:${id}`) },
    }
    const module = createArtistDiscographyModule({
      catalog: unusedCatalog,
      playlist,
      createPlaylistId: () => 'userlist-fixed',
    })
    const plan = makePlan([
      makeAlbumPlan('a', [makeTrack('a1', 'a')], 'incomplete'),
    ], 'partial')

    const result = await module.apply({
      plan,
      target: { type: 'new', name: 'Discography' },
    })

    expect(result).toMatchObject({
      status: 'applied',
      listId: 'userlist-fixed',
      plannedTrackCount: 1,
      submittedTrackCount: 1,
    })
    expect(calls).toEqual(['create:userlist-fixed', 'add:userlist-fixed'])
  })

  it.each(['failed', 'cancelled'] as const)(
    'blocks a %s plan even when it contains valid tracks',
    async status => {
      let playlistCalls = 0
      const playlist: PlaylistPort = {
        create: async() => { playlistCalls++ },
        add: async() => { playlistCalls++ },
        remove: async() => { playlistCalls++ },
      }
      const module = createArtistDiscographyModule({ catalog: unusedCatalog, playlist })
      const plan = makePlan([makeAlbumPlan('a', [makeTrack('a1', 'a')])], status)

      const result = await module.apply({
        plan,
        target: { type: 'new', name: 'Discography' },
      })

      expect(result.status).toBe('failed')
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'album_incomplete' }))
      expect(playlistCalls).toBe(0)
    },
  )

  it('blocks a partial plan when its selected albums assemble to zero tracks', async() => {
    let playlistCalls = 0
    const playlist: PlaylistPort = {
      create: async() => { playlistCalls++ },
      add: async() => { playlistCalls++ },
      remove: async() => { playlistCalls++ },
    }
    const module = createArtistDiscographyModule({ catalog: unusedCatalog, playlist })
    const plan = makePlan([makeAlbumPlan('a', [], 'incomplete')], 'partial')

    const result = await module.apply({
      plan,
      target: { type: 'new', name: 'Discography' },
    })

    expect(result.status).toBe('failed')
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'empty_catalog' }))
    expect(playlistCalls).toBe(0)
  })

  it('rolls back a newly created playlist when adding tracks fails', async() => {
    const calls: string[] = []
    const playlist: PlaylistPort = {
      create: async(id) => { calls.push(`create:${id}`) },
      add: async(id) => {
        calls.push(`add:${id}`)
        throw new Error('add failed')
      },
      remove: async(id) => { calls.push(`remove:${id}`) },
    }
    const module = createArtistDiscographyModule({
      catalog: unusedCatalog,
      playlist,
      createPlaylistId: () => 'userlist-fixed',
    })
    const plan = makePlan([makeAlbumPlan('a', [makeTrack('a1', 'a')])])

    const result = await module.apply({
      plan,
      target: { type: 'new', name: 'Discography' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      listId: null,
      residualListId: null,
      plannedTrackCount: 1,
      submittedTrackCount: 0,
    })
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'playlist_add_failed' }))
    expect(calls).toEqual([
      'create:userlist-fixed',
      'add:userlist-fixed',
      'remove:userlist-fixed',
    ])
  })

  it('reports the residual playlist ID when rollback also fails', async() => {
    const playlist: PlaylistPort = {
      create: async() => {},
      add: async() => { throw new Error('add failed') },
      remove: async() => { throw new Error('remove failed') },
    }
    const module = createArtistDiscographyModule({
      catalog: unusedCatalog,
      playlist,
      createPlaylistId: () => 'userlist-residual',
    })
    const plan = makePlan([makeAlbumPlan('a', [makeTrack('a1', 'a')])])

    const result = await module.apply({
      plan,
      target: { type: 'new', name: 'Discography' },
    })

    expect(result).toMatchObject({
      status: 'failed',
      listId: 'userlist-residual',
      residualListId: 'userlist-residual',
    })
    expect(result.issues.map(issue => issue.code)).toEqual([
      'playlist_add_failed',
      'playlist_rollback_failed',
    ])
  })

  it('never removes an existing playlist after an add failure', async() => {
    let removeCalls = 0
    const playlist: PlaylistPort = {
      create: async() => {},
      add: async() => { throw new Error('add failed') },
      remove: async() => { removeCalls++ },
    }
    const module = createArtistDiscographyModule({ catalog: unusedCatalog, playlist })
    const plan = makePlan([makeAlbumPlan('a', [makeTrack('a1', 'a')])])

    const result = await module.apply({
      plan,
      target: { type: 'existing', listId: 'existing' },
    })

    expect(result.status).toBe('failed')
    expect(result.listId).toBe('existing')
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'playlist_add_failed' }))
    expect(removeCalls).toBe(0)
  })

  it('does not add or remove tracks when playlist creation fails', async() => {
    let addCalls = 0
    let removeCalls = 0
    const playlist: PlaylistPort = {
      create: async() => { throw new Error('create failed') },
      add: async() => { addCalls++ },
      remove: async() => { removeCalls++ },
    }
    const module = createArtistDiscographyModule({ catalog: unusedCatalog, playlist })
    const plan = makePlan([makeAlbumPlan('a', [makeTrack('a1', 'a')])])

    const result = await module.apply({
      plan,
      target: { type: 'new', name: 'Discography' },
    })

    expect(result.status).toBe('failed')
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'playlist_create_failed' }))
    expect(addCalls).toBe(0)
    expect(removeCalls).toBe(0)
  })
})
