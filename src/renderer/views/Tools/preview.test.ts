import { describe, expect, it } from 'vitest'
import type {
  AlbumRef,
  DiscographyAlbumPlan,
  DiscographyIssue,
  DiscographyPlan,
} from '@renderer/core/artistDiscography'
import {
  createDiscographyDeduplicationPresentation,
  createDiscographyPreview,
} from './preview'
import type { DiscographyDeduplicationPreview } from './preview'

const makeTrack = (
  id: string,
  albumId: string,
  options: {
    name?: string
    singer?: string
    songId?: string | number
    trackNumber?: number
  } = {},
): LX.Music.MusicInfoOnline => ({
  id,
  name: options.name ?? `Track ${id}`,
  singer: options.singer ?? 'Artist',
  source: 'kg',
  interval: '03:00',
  meta: {
    songId: options.songId ?? id,
    albumId,
    albumName: `Album ${albumId}`,
    trackNumber: options.trackNumber,
    picUrl: null,
    qualitys: [{ type: '128k', size: '3 MB', hash: `hash-${id}` }],
    _qualitys: {
      '128k': { size: '3 MB', hash: `hash-${id}` },
    },
    hash: `hash-${id}`,
  },
})

const makeAlbum = (
  id: string,
  tracks: LX.Music.MusicInfoOnline[],
  issues: DiscographyIssue[] = [],
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
    status: 'complete',
    issues,
  }
}

const makePlan = (
  albums: DiscographyAlbumPlan[],
  overrides: Partial<DiscographyPlan> = {},
): DiscographyPlan => ({
  source: 'kg',
  status: 'complete',
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
  tracks: albums.flatMap(album => album.tracks),
  deduplications: [],
  rawTrackCount: albums.reduce((count, album) => count + album.tracks.length, 0),
  deduplicatedTrackCount: albums.reduce((count, album) => count + album.tracks.length, 0),
  canApply: true,
  fetchedAt: 1,
  issues: [],
  ...overrides,
})

describe('discography preview view model', () => {
  it('returns no deduplication cards when the plan contains no duplicates', () => {
    const plan = makePlan([makeAlbum('a', [makeTrack('a1', 'a')])])

    expect(createDiscographyPreview(plan)).toEqual({
      issues: [],
      deduplications: [],
    })
  })

  it('exposes one stable identifier and only visible occurrence fields', () => {
    const audit: DiscographyDeduplicationPreview = {
      key: 'track:kg:source_assembly:shared:1:2',
      kind: 'track',
      scope: 'source_assembly',
      stableId: 'kg_shared',
      name: 'Shared song',
      singer: 'Artist & Guest',
      providerSongId: 101,
      kept: {
        albumId: 'a',
        albumName: 'Album a',
        trackName: 'Shared song',
        singer: 'Artist & Guest',
        providerSongId: 101,
        trackNumber: 2,
        albumPosition: 1,
        trackPosition: 3,
        occurrencePosition: 3,
      },
      removed: {
        albumId: 'b',
        albumName: 'Album b',
        trackName: 'Shared song (deluxe)',
        singer: 'Artist',
        providerSongId: 202,
        trackNumber: 4,
        albumPosition: 2,
        trackPosition: 1,
        occurrencePosition: 5,
      },
      exact: true,
    }

    expect(createDiscographyDeduplicationPresentation(audit)).toEqual({
      key: 'track:kg:source_assembly:shared:1:2',
      kind: 'track',
      scope: 'source_assembly',
      name: 'Shared song',
      singer: 'Artist & Guest',
      identifier: { kind: 'track_id', value: 'kg_shared' },
      kept: {
        albumId: 'a',
        albumName: 'Album a',
        trackNumber: 2,
      },
      removed: {
        albumId: 'b',
        albumName: 'Album b',
        trackNumber: 4,
      },
      limited: false,
    })
  })

  it('falls back to a provider identifier without inventing non-exact fields', () => {
    const audit: DiscographyDeduplicationPreview = {
      key: 'track:kg:album_tracks::album-0-0',
      kind: 'track',
      scope: 'album_tracks',
      stableId: '   ',
      name: 'Shared song',
      singer: 'Artist',
      providerSongId: 0,
      kept: {
        albumId: 'a',
        albumName: 'Album a',
        trackName: 'Shared song',
        singer: 'Artist',
        providerSongId: 0,
        trackNumber: 3,
        albumPosition: null,
        trackPosition: null,
        occurrencePosition: null,
      },
      removed: {
        albumId: 'a',
        albumName: null,
        trackName: null,
        singer: null,
        providerSongId: null,
        trackNumber: null,
        albumPosition: null,
        trackPosition: null,
        occurrencePosition: null,
      },
      exact: false,
    }

    expect(createDiscographyDeduplicationPresentation(audit)).toEqual({
      key: 'track:kg:album_tracks::album-0-0',
      kind: 'track',
      scope: 'album_tracks',
      name: 'Shared song',
      singer: 'Artist',
      identifier: { kind: 'provider_song_id', value: 0 },
      kept: {
        albumId: 'a',
        albumName: 'Album a',
        trackNumber: 3,
      },
      removed: {
        albumId: 'a',
        albumName: null,
        trackNumber: null,
      },
      limited: true,
    })
  })

  it('maps exact source-assembly occurrences without losing positions', () => {
    const keptTrack = makeTrack('shared', 'a', {
      name: 'Shared song',
      singer: 'Artist & Guest',
      songId: 101,
      trackNumber: 2,
    })
    const removedTrack = makeTrack('shared', 'b', {
      name: 'Shared song (deluxe)',
      singer: 'Artist',
      songId: 202,
      trackNumber: 4,
    })
    const plan = makePlan([
      makeAlbum('a', [keptTrack]),
      makeAlbum('b', [removedTrack]),
    ], {
      deduplications: [{
        kind: 'duplicate_track',
        scope: 'source_assembly',
        stableId: 'shared',
        kept: {
          source: 'kg',
          trackId: 'shared',
          providerSongId: 101,
          trackName: 'Shared song',
          singer: 'Artist & Guest',
          albumId: 'a',
          albumName: 'Album a',
          albumArtist: 'Artist',
          albumPosition: 1,
          trackPosition: 1,
          occurrencePosition: 1,
          trackNumber: 2,
        },
        removed: {
          source: 'kg',
          trackId: 'shared',
          providerSongId: 202,
          trackName: 'Shared song (deluxe)',
          singer: 'Artist',
          albumId: 'b',
          albumName: 'Album b',
          albumArtist: 'Artist',
          albumPosition: 2,
          trackPosition: 1,
          occurrencePosition: 2,
          trackNumber: 4,
        },
        reason: 'first_occurrence',
      }],
    })

    expect(createDiscographyPreview(plan).deduplications).toEqual([{
      key: 'track:kg:source_assembly:shared:1:2',
      kind: 'track',
      scope: 'source_assembly',
      stableId: 'shared',
      name: 'Shared song',
      singer: 'Artist & Guest',
      providerSongId: 101,
      kept: {
        albumId: 'a',
        albumName: 'Album a',
        trackName: 'Shared song',
        singer: 'Artist & Guest',
        providerSongId: 101,
        trackNumber: 2,
        albumPosition: 1,
        trackPosition: 1,
        occurrencePosition: 1,
      },
      removed: {
        albumId: 'b',
        albumName: 'Album b',
        trackName: 'Shared song (deluxe)',
        singer: 'Artist',
        providerSongId: 202,
        trackNumber: 4,
        albumPosition: 2,
        trackPosition: 1,
        occurrencePosition: 2,
      },
      exact: true,
    }])
  })

  it('creates a non-exact fallback card for an in-album duplicate track', () => {
    const duplicateIssue: DiscographyIssue = {
      code: 'duplicate_track',
      stage: 'album_tracks',
      message: 'duplicate',
      severity: 'error',
      albumId: 'a',
      trackId: 'shared',
    }
    const album = makeAlbum('a', [makeTrack('shared', 'a', {
      name: 'Shared song',
      singer: 'Artist & Guest',
      songId: 'provider-shared',
      trackNumber: 3,
    })], [duplicateIssue])

    expect(createDiscographyPreview(makePlan([album])).deduplications).toEqual([{
      key: 'track:kg:album_tracks:shared:album-0-0',
      kind: 'track',
      scope: 'album_tracks',
      stableId: 'shared',
      name: 'Shared song',
      singer: 'Artist & Guest',
      providerSongId: 'provider-shared',
      kept: {
        albumId: 'a',
        albumName: 'Album a',
        trackName: 'Shared song',
        singer: 'Artist & Guest',
        providerSongId: 'provider-shared',
        trackNumber: 3,
        albumPosition: null,
        trackPosition: null,
        occurrencePosition: null,
      },
      removed: {
        albumId: 'a',
        albumName: 'Album a',
        trackName: null,
        singer: null,
        providerSongId: null,
        trackNumber: null,
        albumPosition: null,
        trackPosition: null,
        occurrencePosition: null,
      },
      exact: false,
    }])
  })

  it('creates a non-exact fallback card for a duplicate album ID', () => {
    const duplicateIssue: DiscographyIssue = {
      code: 'duplicate_album',
      stage: 'albums',
      message: 'duplicate',
      severity: 'error',
      albumId: 'a',
    }
    const plan = makePlan([makeAlbum('a', [makeTrack('a1', 'a')])], {
      issues: [duplicateIssue],
    })

    expect(createDiscographyPreview(plan).deduplications).toEqual([{
      key: 'album:kg:album_catalog:a:plan-0',
      kind: 'album',
      scope: 'album_catalog',
      stableId: 'a',
      name: 'Album a',
      singer: null,
      providerSongId: null,
      kept: {
        albumId: 'a',
        albumName: 'Album a',
        trackName: null,
        singer: null,
        providerSongId: null,
        trackNumber: null,
        albumPosition: null,
        trackPosition: null,
        occurrencePosition: null,
      },
      removed: {
        albumId: 'a',
        albumName: null,
        trackName: null,
        singer: null,
        providerSongId: null,
        trackNumber: null,
        albumPosition: null,
        trackPosition: null,
        occurrencePosition: null,
      },
      exact: false,
    }])
  })

  it.each(['provider_unavailable', 'invalid_provider_response'] as const)(
    'shows only the %s root cause for an empty album without mutating the plan',
    rootCode => {
      const rootIssue: DiscographyIssue = {
        code: rootCode,
        stage: 'album_tracks',
        message: 'root cause',
        severity: 'error',
        albumId: 'a',
      }
      const incompleteIssue: DiscographyIssue = {
        code: 'album_incomplete',
        stage: 'album_tracks',
        message: 'derived count mismatch',
        severity: 'error',
        albumId: 'a',
        expected: 1,
        actual: 0,
      }
      const emptyIssue: DiscographyIssue = {
        code: 'empty_catalog',
        stage: 'album_tracks',
        message: 'derived empty album',
        severity: 'error',
        albumId: 'a',
      }
      const originalIssues = [rootIssue, incompleteIssue, emptyIssue]
      const emptyAlbum = makeAlbum('a', [], originalIssues)
      const album = {
        ...emptyAlbum,
        album: { ...emptyAlbum.album, expectedTrackCount: 1 },
        expectedCount: 1,
        actualCount: 0,
        status: 'incomplete' as const,
      }
      const plan = makePlan([album])

      expect(createDiscographyPreview(plan).issues).toEqual([
        { issue: rootIssue, albumName: 'Album a' },
      ])
      expect(plan.albums[0].issues).toBe(originalIssues)
      expect(plan.albums[0].issues).toEqual([rootIssue, incompleteIssue, emptyIssue])
    },
  )

  it.each([
    ['missing', undefined],
    ['mismatched', 'b'],
  ] as const)('keeps derived issues when the root albumId is %s', (_case, rootAlbumId) => {
    const rootIssue: DiscographyIssue = {
      code: 'invalid_provider_response',
      stage: 'album_tracks',
      message: 'unlocatable root cause',
      severity: 'error',
      ...(rootAlbumId ? { albumId: rootAlbumId } : {}),
    }
    const incompleteIssue: DiscographyIssue = {
      code: 'album_incomplete',
      stage: 'album_tracks',
      message: 'count mismatch',
      severity: 'error',
      albumId: 'a',
      expected: 1,
      actual: 0,
    }
    const emptyIssue: DiscographyIssue = {
      code: 'empty_catalog',
      stage: 'album_tracks',
      message: 'empty album',
      severity: 'error',
      albumId: 'a',
    }
    const emptyAlbum = makeAlbum('a', [], [rootIssue, incompleteIssue, emptyIssue])
    const album = {
      ...emptyAlbum,
      album: { ...emptyAlbum.album, expectedTrackCount: 1 },
      expectedCount: 1,
      actualCount: 0,
      status: 'incomplete' as const,
    }

    expect(createDiscographyPreview(makePlan([album])).issues).toEqual([
      { issue: rootIssue, albumName: 'Album a' },
      { issue: incompleteIssue, albumName: 'Album a' },
      { issue: emptyIssue, albumName: 'Album a' },
    ])
  })

  it.each([
    ['missing', undefined],
    ['mismatched', 'b'],
  ] as const)('keeps a derived issue when its albumId is %s', (_case, derivedAlbumId) => {
    const rootIssue: DiscographyIssue = {
      code: 'invalid_provider_response',
      stage: 'album_tracks',
      message: 'root cause',
      severity: 'error',
      albumId: 'a',
    }
    const derivedIssue: DiscographyIssue = {
      code: 'album_incomplete',
      stage: 'album_tracks',
      message: 'unlocatable count mismatch',
      severity: 'error',
      ...(derivedAlbumId ? { albumId: derivedAlbumId } : {}),
      expected: 1,
      actual: 0,
    }
    const emptyAlbum = makeAlbum('a', [], [rootIssue, derivedIssue])
    const album = {
      ...emptyAlbum,
      album: { ...emptyAlbum.album, expectedTrackCount: 1 },
      expectedCount: 1,
      actualCount: 0,
      status: 'incomplete' as const,
    }

    expect(createDiscographyPreview(makePlan([album])).issues).toEqual([
      { issue: rootIssue, albumName: 'Album a' },
      { issue: derivedIssue, albumName: 'Album a' },
    ])
  })

  it('keeps independent count and empty issues for an empty album without a root cause', () => {
    const incompleteIssue: DiscographyIssue = {
      code: 'album_incomplete',
      stage: 'album_tracks',
      message: 'independent count mismatch',
      severity: 'error',
      albumId: 'a',
      expected: 1,
      actual: 0,
    }
    const emptyIssue: DiscographyIssue = {
      code: 'empty_catalog',
      stage: 'album_tracks',
      message: 'independent empty album',
      severity: 'error',
      albumId: 'a',
    }
    const emptyAlbum = makeAlbum('a', [], [incompleteIssue, emptyIssue])
    const album = {
      ...emptyAlbum,
      album: { ...emptyAlbum.album, expectedTrackCount: 1 },
      expectedCount: 1,
      actualCount: 0,
      status: 'incomplete' as const,
    }

    expect(createDiscographyPreview(makePlan([album])).issues).toEqual([
      { issue: incompleteIssue, albumName: 'Album a' },
      { issue: emptyIssue, albumName: 'Album a' },
    ])
  })

  it('keeps count issues when an album with a root cause still has valid tracks', () => {
    const rootIssue: DiscographyIssue = {
      code: 'invalid_provider_response',
      stage: 'album_tracks',
      message: 'one track was invalid',
      severity: 'error',
      albumId: 'a',
    }
    const incompleteIssue: DiscographyIssue = {
      code: 'album_incomplete',
      stage: 'album_tracks',
      message: 'one of two tracks remains',
      severity: 'error',
      albumId: 'a',
      expected: 2,
      actual: 1,
    }
    const partialAlbum = makeAlbum('a', [makeTrack('a1', 'a')], [rootIssue, incompleteIssue])
    const album = {
      ...partialAlbum,
      album: { ...partialAlbum.album, expectedTrackCount: 2 },
      expectedCount: 2,
      actualCount: 1,
      status: 'incomplete' as const,
    }

    expect(createDiscographyPreview(makePlan([album])).issues).toEqual([
      { issue: rootIssue, albumName: 'Album a' },
      { issue: incompleteIssue, albumName: 'Album a' },
    ])
  })

  it('aggregates non-duplicate album issues and excludes duplicates from the general list', () => {
    const incompleteIssue: DiscographyIssue = {
      code: 'album_incomplete',
      stage: 'album_tracks',
      message: 'incomplete',
      severity: 'error',
      albumId: 'a',
      expected: 2,
      actual: 1,
    }
    const duplicateIssue: DiscographyIssue = {
      code: 'duplicate_track',
      stage: 'album_tracks',
      message: 'duplicate',
      severity: 'error',
      albumId: 'a',
      trackId: 'a1',
    }
    const providerIssue: DiscographyIssue = {
      code: 'provider_unavailable',
      stage: 'albums',
      message: 'provider unavailable',
      severity: 'error',
    }
    const album = makeAlbum('a', [makeTrack('a1', 'a')], [incompleteIssue, duplicateIssue])
    const plan = makePlan([album], { issues: [providerIssue] })

    expect(createDiscographyPreview(plan).issues).toEqual([
      { issue: providerIssue, albumName: null },
      { issue: incompleteIssue, albumName: 'Album a' },
    ])
  })
})
