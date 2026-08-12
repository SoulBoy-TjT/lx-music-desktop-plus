import { describe, expect, it } from 'vitest'
import {
  ARTIST_DISCOGRAPHY_SOURCES,
  createArtistDiscographyBatchModule,
  createArtistDiscographyPlaylistNames,
  type AlbumRef,
  type ArtistCatalogPort,
  type ArtistDiscographySource,
  type CatalogCollection,
  type DiscographyBatchApplyInput,
  type DiscographyBatchPlan,
  type PlaylistPort,
} from './index'

const collection = <T>(items: T[]): CatalogCollection<T> => ({
  items,
  reportedTotal: items.length,
  complete: true,
  issues: [],
})

const makeTrack = (
  source: ArtistDiscographySource,
  albumId: string,
  songId = `${source}-track`,
): LX.Music.MusicInfoOnline => {
  const meta: Record<string, unknown> = {
    songId,
    albumId,
    albumName: `${source} album`,
    qualitys: [{ type: '128k', size: '3 MB' }],
    _qualitys: { '128k': { size: '3 MB' } },
  }
  if (source == 'kg') meta.hash = 'hash'
  if (source == 'tx') meta.strMediaMid = 'media-mid'
  return {
    id: `${source}_${songId}`,
    name: `${source} track`,
    singer: 'Artist',
    source,
    interval: '03:00',
    meta,
  } as unknown as LX.Music.MusicInfoOnline
}

const makeCatalog = (source: ArtistDiscographySource): ArtistCatalogPort => {
  const albumId = `${source}-album`
  return {
    resolveArtist: async() => ({
      source,
      id: `${source}-artist`,
      name: 'Artist',
      avatar: null,
      albumCount: 1,
    }),
    getArtistAlbums: async() => collection<AlbumRef>([{
      source,
      id: albumId,
      name: `${source} album`,
      artist: 'Artist',
      releaseDate: null,
      image: null,
      expectedTrackCount: 1,
    }]),
    getAlbumTracks: async() => collection([makeTrack(source, albumId)]),
  }
}

const noOpPlaylist: PlaylistPort = {
  create: async() => {},
  add: async() => {},
  remove: async() => {},
}

const catalogs = () => Object.fromEntries(ARTIST_DISCOGRAPHY_SOURCES.map(source => [
  source,
  makeCatalog(source),
])) as Record<ArtistDiscographySource, ArtistCatalogPort>

const planBatch = async(playlist: PlaylistPort = noOpPlaylist) => {
  const module = createArtistDiscographyBatchModule({
    catalogs: catalogs(),
    playlist,
    now: () => 123,
  })
  const batch = await module.plan({ artistName: 'Artist', sources: ARTIST_DISCOGRAPHY_SOURCES })
  return { module, batch }
}

const applyInput = (plan: DiscographyBatchPlan): DiscographyBatchApplyInput => ({
  plan,
  sources: plan.sources,
})

describe('artist discography batch module', () => {
  it('builds count-aware playlist names for all four sources without spaces', () => {
    expect(createArtistDiscographyPlaylistNames(' 薛之谦 ', {
      kg: 77,
      tx: 68,
      wy: 55,
      kw: 42,
    })).toEqual({
      kg: '薛之谦-酷狗-77首',
      tx: '薛之谦-qq-68首',
      wy: '薛之谦-网易-55首',
      kw: '薛之谦-酷我-42首',
    })
  })

  it('resolves four sources and confirms all artist identities once', async() => {
    const confirmedSources: ArtistDiscographySource[][] = []
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist: noOpPlaylist,
      now: () => 123,
    })

    const batch = await module.plan({
      artistName: ' Artist ',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
      confirmArtists: async artists => {
        confirmedSources.push(artists.map(artist => artist.source))
        return true
      },
    })

    expect(confirmedSources).toEqual([['kg', 'tx', 'wy', 'kw']])
    expect(batch.artistName).toBe('Artist')
    expect(batch.batchId).toMatch(/^discography_batch_/)
    expect(batch.status).toBe('ready')
    expect(batch.canApply).toBe(true)
    expect(ARTIST_DISCOGRAPHY_SOURCES.map(source => batch.plans[source]!.status))
      .toEqual(['complete', 'complete', 'complete', 'complete'])
  })

  it('plans only the normalized selected source subset', async() => {
    const confirmedSources: ArtistDiscographySource[][] = []
    const fixtureCatalogs = catalogs()
    fixtureCatalogs.kg = {
      ...fixtureCatalogs.kg,
      resolveArtist: async() => { throw new Error('unselected source must not be requested') },
    }
    fixtureCatalogs.kw = {
      ...fixtureCatalogs.kw,
      resolveArtist: async() => { throw new Error('unselected source must not be requested') },
    }
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: noOpPlaylist,
      now: () => 123,
    })

    const batch = await module.plan({
      artistName: 'Artist',
      sources: ['wy', 'tx', 'wy'],
      confirmArtists: artists => {
        confirmedSources.push(artists.map(artist => artist.source))
        return true
      },
    })

    expect(batch.sources).toEqual(['tx', 'wy'])
    expect(confirmedSources).toEqual([['tx', 'wy']])
    expect(Object.keys(batch.plans)).toEqual(['tx', 'wy'])
    expect(batch.status).toBe('ready')
    expect(batch.canApply).toBe(true)
  })

  it('rejects an empty fetch selection before requesting any provider', async() => {
    let artistRequests = 0
    const fixtureCatalogs = catalogs()
    for (const source of ARTIST_DISCOGRAPHY_SOURCES) {
      fixtureCatalogs[source] = {
        ...fixtureCatalogs[source],
        resolveArtist: async() => {
          artistRequests++
          return await makeCatalog(source).resolveArtist('Artist')
        },
      }
    }
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: noOpPlaylist,
    })

    await expect(module.plan({ artistName: 'Artist', sources: [] }))
      .rejects.toThrow('At least one music source is required.')
    expect(artistRequests).toBe(0)
  })

  it('confirms resolved identities and applies them when one selected source cannot resolve an artist', async() => {
    const fixtureCatalogs = catalogs()
    const albumRequestSources: ArtistDiscographySource[] = []
    for (const source of ARTIST_DISCOGRAPHY_SOURCES) {
      const catalog = fixtureCatalogs[source]
      fixtureCatalogs[source] = {
        ...catalog,
        getArtistAlbums: async(...args) => {
          albumRequestSources.push(source)
          return await catalog.getArtistAlbums(...args)
        },
      }
    }
    fixtureCatalogs.tx = {
      ...fixtureCatalogs.tx,
      resolveArtist: async() => { throw new Error('offline') },
    }
    const confirmedSources: ArtistDiscographySource[][] = []
    let mutations = 0
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: {
        create: async() => { mutations++ },
        add: async() => { mutations++ },
        remove: async() => { mutations++ },
      },
    })

    const batch = await module.plan({
      artistName: 'Artist',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
      confirmArtists: artists => {
        confirmedSources.push(artists.map(artist => artist.source))
        return true
      },
    })

    expect(confirmedSources).toEqual([['kg', 'wy', 'kw']])
    expect(albumRequestSources).toEqual(['kg', 'wy', 'kw'])
    expect(batch.plans.tx!.status).toBe('failed')
    expect(batch.plans.kg!.status).toBe('complete')
    expect(batch.status).toBe('blocked')
    expect(batch.canApply).toBe(true)

    const result = await module.apply({ plan: batch, sources: ['kg', 'wy', 'kw'] })

    expect(result.status).toBe('applied')
    expect(mutations).toBe(6)
  })

  it('does not request confirmation when every selected artist identity fails', async() => {
    const fixtureCatalogs = catalogs()
    for (const source of ARTIST_DISCOGRAPHY_SOURCES) {
      fixtureCatalogs[source] = {
        ...fixtureCatalogs[source],
        resolveArtist: async() => { throw new Error('offline') },
      }
    }
    let confirmationCount = 0
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: noOpPlaylist,
    })

    const batch = await module.plan({
      artistName: 'Artist',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
      confirmArtists: () => {
        confirmationCount++
        return true
      },
    })

    expect(confirmationCount).toBe(0)
    expect(ARTIST_DISCOGRAPHY_SOURCES.map(source => batch.plans[source]!.status))
      .toEqual(['failed', 'failed', 'failed', 'failed'])
    expect(batch.status).toBe('blocked')
    expect(batch.canApply).toBe(false)
  })

  it('settles every source when the combined confirmation throws synchronously', async() => {
    let albumRequests = 0
    const fixtureCatalogs = catalogs()
    for (const source of ARTIST_DISCOGRAPHY_SOURCES) {
      const catalog = fixtureCatalogs[source]
      fixtureCatalogs[source] = {
        ...catalog,
        getArtistAlbums: async(...args) => {
          albumRequests++
          return await catalog.getArtistAlbums(...args)
        },
      }
    }
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: noOpPlaylist,
    })

    const batch = await module.plan({
      artistName: 'Artist',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
      confirmArtists: () => { throw new Error('dialog failed') },
    })

    expect(albumRequests).toBe(0)
    expect(batch.status).toBe('cancelled')
    expect(ARTIST_DISCOGRAPHY_SOURCES.map(source => batch.plans[source]!.status))
      .toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled'])
  })

  it('cancels sources waiting for an unresolved combined confirmation', async() => {
    const controller = new AbortController()
    let markConfirmationStarted: (() => void) | null = null
    const confirmationStarted = new Promise<void>(resolve => {
      markConfirmationStarted = resolve
    })
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist: noOpPlaylist,
    })

    const planning = module.plan({
      artistName: 'Artist',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
      signal: controller.signal,
      confirmArtists: async() => {
        markConfirmationStarted?.()
        return await new Promise<boolean>(() => {})
      },
    })
    await confirmationStarted
    controller.abort()
    const batch = await planning

    expect(batch.status).toBe('cancelled')
    expect(ARTIST_DISCOGRAPHY_SOURCES.map(source => batch.plans[source]!.status))
      .toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled'])
  })

  it('applies a partial source automatically when it contains valid tracks', async() => {
    let mutations = 0
    const fixtureCatalogs = catalogs()
    const wyCatalog = fixtureCatalogs.wy
    fixtureCatalogs.wy = {
      ...wyCatalog,
      getAlbumTracks: async(...args) => ({
        ...await wyCatalog.getAlbumTracks(...args),
        complete: false,
      }),
    }
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: {
        create: async() => { mutations++ },
        add: async() => { mutations++ },
        remove: async() => { mutations++ },
      },
    })
    const batch = await module.plan({ artistName: 'Artist', sources: ARTIST_DISCOGRAPHY_SOURCES })

    expect(batch.status).toBe('ready')
    expect(batch.canApply).toBe(true)
    expect(batch.plans.wy!.status).toBe('partial')
    const result = await module.apply(applyInput(batch))
    expect(result.status).toBe('applied')
    expect(mutations).toBe(8)
  })

  it('rejects a stale batch after a newer plan is created', async() => {
    let mutations = 0
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist: {
        create: async() => { mutations++ },
        add: async() => { mutations++ },
        remove: async() => { mutations++ },
      },
      now: () => 123,
    })
    const first = await module.plan({ artistName: 'Artist', sources: ARTIST_DISCOGRAPHY_SOURCES })
    const second = await module.plan({ artistName: 'Artist', sources: ARTIST_DISCOGRAPHY_SOURCES })

    expect(first.batchId).not.toBe(second.batchId)
    const result = await module.apply(applyInput(first))
    expect(result.status).toBe('validation_failed')
    expect(mutations).toBe(0)
  })

  it('creates four source playlists with one shared collision-free ID sequence', async() => {
    const created: Array<{ id: string, name: string }> = []
    const playlist: PlaylistPort = {
      create: async(id, name) => { created.push({ id, name }) },
      add: async() => {},
      remove: async() => {},
    }
    const { module, batch } = await planBatch(playlist)

    const result = await module.apply(applyInput(batch))

    expect(result.status).toBe('applied')
    expect(created).toEqual([
      { id: 'userlist_123', name: 'Artist-酷狗-1首' },
      { id: 'userlist_123_1', name: 'Artist-qq-1首' },
      { id: 'userlist_123_2', name: 'Artist-网易-1首' },
      { id: 'userlist_123_3', name: 'Artist-酷我-1首' },
    ])
    expect(result.plannedTrackCounts).toEqual({ kg: 1, tx: 1, wy: 1, kw: 1 })
    expect(new Set(Object.values(result.listIds))).toHaveLength(4)
  })

  it('creates playlists only for the selected source subset in canonical order', async() => {
    const created: Array<{ id: string, name: string }> = []
    const ids = ['list-tx', 'list-wy']
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist: {
        create: async(id, name) => { created.push({ id, name }) },
        add: async() => {},
        remove: async() => {},
      },
      createPlaylistId: () => ids.shift()!,
    })
    const batch = await module.plan({
      artistName: 'Artist',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
    })

    const result = await module.apply({ plan: batch, sources: ['wy', 'tx'] })

    expect(result.status).toBe('applied')
    expect(created).toEqual([
      { id: 'list-tx', name: 'Artist-qq-1首' },
      { id: 'list-wy', name: 'Artist-网易-1首' },
    ])
    expect(result.plannedTrackCounts).toEqual({ tx: 1, wy: 1 })
    expect(result.listIds).toEqual({ tx: 'list-tx', wy: 'list-wy' })
  })

  it('applies eligible selected sources when another fetched source failed', async() => {
    let mutations = 0
    const fixtureCatalogs = catalogs()
    fixtureCatalogs.kw = {
      ...fixtureCatalogs.kw,
      getAlbumTracks: async() => collection([]),
    }
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: {
        create: async() => { mutations++ },
        add: async() => { mutations++ },
        remove: async() => { mutations++ },
      },
    })
    const batch = await module.plan({
      artistName: 'Artist',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
    })

    expect(batch.status).toBe('blocked')
    expect(batch.canApply).toBe(true)
    expect(batch.plans.kw?.status).toBe('failed')

    const result = await module.apply({ plan: batch, sources: ['kg', 'tx', 'wy'] })

    expect(result.status).toBe('applied')
    expect(Object.keys(result.listIds)).toEqual(['kg', 'tx', 'wy'])
    expect(mutations).toBe(6)
  })

  it('rejects a selected failed source before any playlist mutation', async() => {
    let mutations = 0
    const fixtureCatalogs = catalogs()
    fixtureCatalogs.kw = {
      ...fixtureCatalogs.kw,
      getAlbumTracks: async() => collection([]),
    }
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: {
        create: async() => { mutations++ },
        add: async() => { mutations++ },
        remove: async() => { mutations++ },
      },
    })
    const batch = await module.plan({
      artistName: 'Artist',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
    })

    const result = await module.apply({ plan: batch, sources: ['kw'] })

    expect(result.status).toBe('validation_failed')
    expect(result.failedSource).toBe('kw')
    expect(result.listIds).toEqual({})
    expect(mutations).toBe(0)
  })

  it.each<[
    string,
    readonly ArtistDiscographySource[],
    readonly ArtistDiscographySource[],
  ]>([
    ['empty', ARTIST_DISCOGRAPHY_SOURCES, []],
    ['duplicate', ARTIST_DISCOGRAPHY_SOURCES, ['tx', 'tx']],
    ['not fetched', ['tx'], ['wy']],
    ['unsupported', ARTIST_DISCOGRAPHY_SOURCES, ['tx', 'unsupported' as ArtistDiscographySource]],
  ])('rejects an %s playlist source selection before any mutation', async(
    _label,
    fetchSources,
    applySources,
  ) => {
    let mutations = 0
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist: {
        create: async() => { mutations++ },
        add: async() => { mutations++ },
        remove: async() => { mutations++ },
      },
    })
    const batch = await module.plan({ artistName: 'Artist', sources: fetchSources })

    const result = await module.apply({ plan: batch, sources: applySources })

    expect(result.status).toBe('validation_failed')
    expect(result.listIds).toEqual({})
    expect(mutations).toBe(0)
  })

  it('names and submits each source by its final deduplicated prepared track count', async() => {
    const fixtureCatalogs = catalogs()
    const kgAlbums: AlbumRef[] = ['kg-album-a', 'kg-album-b'].map(id => ({
      source: 'kg',
      id,
      name: id,
      artist: 'Artist',
      releaseDate: null,
      image: null,
      expectedTrackCount: 1,
    }))
    fixtureCatalogs.kg = {
      ...fixtureCatalogs.kg,
      getArtistAlbums: async() => collection(kgAlbums),
      getAlbumTracks: async albumId => collection([makeTrack('kg', albumId, 'kg-shared')]),
    }
    fixtureCatalogs.tx = {
      ...fixtureCatalogs.tx,
      getAlbumTracks: async albumId => collection([
        makeTrack('tx', albumId, 'tx-track-a'),
        makeTrack('tx', albumId, 'tx-track-b'),
      ]),
    }
    const created: Array<{ id: string, name: string }> = []
    const submittedCounts: Record<string, number> = {}
    const ids = ['list-kg', 'list-tx', 'list-wy', 'list-kw']
    const module = createArtistDiscographyBatchModule({
      catalogs: fixtureCatalogs,
      playlist: {
        create: async(id, name) => { created.push({ id, name }) },
        add: async(id, tracks) => { submittedCounts[id] = tracks.length },
        remove: async() => {},
      },
      createPlaylistId: () => ids.shift()!,
    })
    const batch = await module.plan({ artistName: 'Artist', sources: ARTIST_DISCOGRAPHY_SOURCES })

    expect(batch.plans.kg!.rawTrackCount).toBe(2)
    expect(batch.plans.kg!.deduplicatedTrackCount).toBe(1)
    expect(batch.plans.tx!.deduplicatedTrackCount).toBe(2)

    const result = await module.apply(applyInput(batch))

    expect(result.status).toBe('applied')
    expect(created.map(item => item.name)).toEqual([
      'Artist-酷狗-1首',
      'Artist-qq-2首',
      'Artist-网易-1首',
      'Artist-酷我-1首',
    ])
    expect(submittedCounts).toEqual({
      'list-kg': 1,
      'list-tx': 2,
      'list-wy': 1,
      'list-kw': 1,
    })
    expect(result.plannedTrackCounts).toEqual({ kg: 1, tx: 2, wy: 1, kw: 1 })
  })

  it('preflights every source before creating any playlist', async() => {
    let mutations = 0
    const playlist: PlaylistPort = {
      create: async() => { mutations++ },
      add: async() => { mutations++ },
      remove: async() => { mutations++ },
    }
    const { module, batch } = await planBatch(playlist)
    batch.plans.wy!.albums[0].tracks = []

    const result = await module.apply(applyInput(batch))

    expect(result.status).toBe('validation_failed')
    expect(result.failedSource).toBe('wy')
    expect(result.issues).toContainEqual(expect.objectContaining({
      source: 'wy',
      code: 'empty_catalog',
    }))
    expect(mutations).toBe(0)
  })

  it('blocks a batch before mutations when a displayed track count no longer matches prepared tracks', async() => {
    let mutations = 0
    const playlist: PlaylistPort = {
      create: async() => { mutations++ },
      add: async() => { mutations++ },
      remove: async() => { mutations++ },
    }
    const { module, batch } = await planBatch(playlist)
    batch.plans.kg!.deduplicatedTrackCount = 99

    const result = await module.apply(applyInput(batch))

    expect(result.status).toBe('validation_failed')
    expect(result.failedSource).toBe('kg')
    expect(result.issues).toContainEqual(expect.objectContaining({
      source: 'kg',
      code: 'invalid_provider_response',
    }))
    expect(result.plannedTrackCounts).toEqual({ kg: 1, tx: 1, wy: 1, kw: 1 })
    expect(mutations).toBe(0)
  })

  it('generates every playlist ID before creating any playlist', async() => {
    let mutations = 0
    const playlist: PlaylistPort = {
      create: async() => { mutations++ },
      add: async() => { mutations++ },
      remove: async() => { mutations++ },
    }
    const ids = ['list-kg', 'list-tx', '', 'list-kw']
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist,
      createPlaylistId: () => ids.shift()!,
    })
    const batch = await module.plan({ artistName: 'Artist', sources: ARTIST_DISCOGRAPHY_SOURCES })

    const result = await module.apply(applyInput(batch))

    expect(result.status).toBe('validation_failed')
    expect(result.failedSource).toBe('wy')
    expect(result.issues).toContainEqual(expect.objectContaining({
      source: 'wy',
      code: 'playlist_create_failed',
    }))
    expect(mutations).toBe(0)
  })

  it('rejects colliding playlist IDs before creating any playlist', async() => {
    let mutations = 0
    const playlist: PlaylistPort = {
      create: async() => { mutations++ },
      add: async() => { mutations++ },
      remove: async() => { mutations++ },
    }
    const ids = ['list-shared', 'list-tx', 'list-shared', 'list-kw']
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist,
      createPlaylistId: () => ids.shift()!,
    })
    const batch = await module.plan({ artistName: 'Artist', sources: ARTIST_DISCOGRAPHY_SOURCES })

    const result = await module.apply(applyInput(batch))

    expect(result.status).toBe('validation_failed')
    expect(result.failedSource).toBe('wy')
    expect(mutations).toBe(0)
  })

  it('rolls back every playlist when a later source write fails and reports residuals', async() => {
    const calls: string[] = []
    const playlist: PlaylistPort = {
      create: async id => { calls.push(`create:${id}`) },
      add: async id => {
        calls.push(`add:${id}`)
        if (id == 'list-wy') throw new Error('add failed')
      },
      remove: async id => {
        calls.push(`remove:${id}`)
        if (id == 'list-tx') throw new Error('remove failed')
      },
    }
    const ids = ['list-kg', 'list-tx', 'list-wy', 'list-kw']
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist,
      createPlaylistId: () => ids.shift()!,
    })
    const batch = await module.plan({ artistName: 'Artist', sources: ARTIST_DISCOGRAPHY_SOURCES })

    const result = await module.apply(applyInput(batch))

    expect(result.status).toBe('failed_with_residuals')
    expect(result.failedSource).toBe('wy')
    expect(result.residualPlaylists).toEqual([{
      source: 'tx',
      id: 'list-tx',
      name: 'Artist-qq-1首',
    }])
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'wy', code: 'playlist_add_failed' }),
      expect.objectContaining({ source: 'tx', code: 'playlist_rollback_failed' }),
    ]))
    expect(calls).toEqual([
      'create:list-kg',
      'add:list-kg',
      'create:list-tx',
      'add:list-tx',
      'create:list-wy',
      'add:list-wy',
      'remove:list-wy',
      'remove:list-tx',
      'remove:list-kg',
    ])
  })

  it('limits all-or-nothing compensation to the selected playlist subset', async() => {
    const calls: string[] = []
    const ids = ['list-tx', 'list-wy']
    const module = createArtistDiscographyBatchModule({
      catalogs: catalogs(),
      playlist: {
        create: async id => { calls.push(`create:${id}`) },
        add: async id => {
          calls.push(`add:${id}`)
          if (id == 'list-wy') throw new Error('add failed')
        },
        remove: async id => { calls.push(`remove:${id}`) },
      },
      createPlaylistId: () => ids.shift()!,
    })
    const batch = await module.plan({
      artistName: 'Artist',
      sources: ARTIST_DISCOGRAPHY_SOURCES,
    })

    const result = await module.apply({ plan: batch, sources: ['wy', 'tx'] })

    expect(result.status).toBe('failed_rolled_back')
    expect(result.failedSource).toBe('wy')
    expect(result.residualPlaylists).toEqual([])
    expect(calls).toEqual([
      'create:list-tx',
      'add:list-tx',
      'create:list-wy',
      'add:list-wy',
      'remove:list-wy',
      'remove:list-tx',
    ])
  })
})
