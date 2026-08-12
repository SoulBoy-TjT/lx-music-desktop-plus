import { describe, expect, it } from 'vitest'
import { assembleDiscographyTracks } from './assembly'
import type { AlbumRef, DiscographyAlbumPlan } from './types'

const makeTrack = (
  id: string,
  albumId: string,
  songId: string | number,
  name: string,
  singer: string,
  trackNumber?: number,
): LX.Music.MusicInfoOnline => ({
  id,
  name,
  singer,
  source: 'kg',
  interval: '03:00',
  meta: {
    songId,
    albumId,
    albumName: `Track album ${albumId}`,
    trackNumber,
    qualitys: [{ type: '128k', size: '3 MB', hash: `hash-${id}` }],
    _qualitys: {
      '128k': { size: '3 MB', hash: `hash-${id}` },
    },
    hash: `hash-${id}`,
  },
})

const makeAlbum = (
  id: string,
  artist: string,
  tracks: LX.Music.MusicInfoOnline[],
): DiscographyAlbumPlan => {
  const album: AlbumRef = {
    source: 'kg',
    id,
    name: `Album ${id.toUpperCase()}`,
    artist,
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
    issues: [],
  }
}

describe('assembleDiscographyTracks', () => {
  it('keeps the first A/B/C occurrence and records both removals with stable order details', () => {
    const albumA = makeAlbum('a', 'Album Artist A', [
      makeTrack('shared', 'a', 101, 'Shared from A', 'Singer A', 7),
      makeTrack('unique-a', 'a', 201, 'Same Name', 'Singer A'),
    ])
    const albumB = makeAlbum('b', 'Album Artist B', [
      makeTrack('unique-b', 'b', 202, 'Same Name', 'Singer B', 1),
      makeTrack('shared', 'b', 102, 'Shared from B', 'Singer B', 2),
    ])
    const albumC = makeAlbum('c', 'Album Artist C', [
      makeTrack('shared', 'c', 103, 'Shared from C', 'Singer C', 3),
    ])

    const result = assembleDiscographyTracks([albumA, albumB, albumC])

    expect(result.rawTrackCount).toBe(5)
    expect(result.tracks.map(track => [track.id, track.name])).toEqual([
      ['shared', 'Shared from A'],
      ['unique-a', 'Same Name'],
      ['unique-b', 'Same Name'],
    ])
    expect(result.deduplications).toHaveLength(2)
    expect(result.deduplications[0]).toEqual({
      kind: 'duplicate_track',
      scope: 'source_assembly',
      stableId: 'shared',
      reason: 'first_occurrence',
      kept: {
        source: 'kg',
        trackId: 'shared',
        providerSongId: 101,
        trackName: 'Shared from A',
        singer: 'Singer A',
        albumId: 'a',
        albumName: 'Album A',
        albumArtist: 'Album Artist A',
        albumPosition: 1,
        trackPosition: 1,
        occurrencePosition: 1,
        trackNumber: 7,
      },
      removed: {
        source: 'kg',
        trackId: 'shared',
        providerSongId: 102,
        trackName: 'Shared from B',
        singer: 'Singer B',
        albumId: 'b',
        albumName: 'Album B',
        albumArtist: 'Album Artist B',
        albumPosition: 2,
        trackPosition: 2,
        occurrencePosition: 4,
        trackNumber: 2,
      },
    })
    expect(result.deduplications[1]).toEqual({
      kind: 'duplicate_track',
      scope: 'source_assembly',
      stableId: 'shared',
      reason: 'first_occurrence',
      kept: result.deduplications[0].kept,
      removed: {
        source: 'kg',
        trackId: 'shared',
        providerSongId: 103,
        trackName: 'Shared from C',
        singer: 'Singer C',
        albumId: 'c',
        albumName: 'Album C',
        albumArtist: 'Album Artist C',
        albumPosition: 3,
        trackPosition: 1,
        occurrencePosition: 5,
        trackNumber: 3,
      },
    })
  })
})
