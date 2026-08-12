import type {
  DiscographyAlbumPlan,
  DiscographyTrackDeduplication,
  DiscographyTrackOccurrence,
} from './types'

const getTrackNumber = (track: LX.Music.MusicInfoOnline): number | null => {
  const trackNumber = track.meta.trackNumber
  return Number.isSafeInteger(trackNumber) && Number(trackNumber) > 0
    ? Number(trackNumber)
    : null
}

export const assembleDiscographyTracks = (albums: DiscographyAlbumPlan[]) => {
  const tracks: LX.Music.MusicInfoOnline[] = []
  const deduplications: DiscographyTrackDeduplication[] = []
  const firstOccurrenceByTrackId = new Map<string, DiscographyTrackOccurrence>()
  let occurrencePosition = 0

  for (const [albumIndex, albumPlan] of albums.entries()) {
    for (const [trackIndex, track] of albumPlan.tracks.entries()) {
      occurrencePosition++
      const occurrence: DiscographyTrackOccurrence = {
        source: albumPlan.album.source,
        trackId: track.id,
        providerSongId: track.meta.songId,
        trackName: track.name,
        singer: track.singer,
        albumId: albumPlan.album.id,
        albumName: albumPlan.album.name,
        albumArtist: albumPlan.album.artist,
        albumPosition: albumIndex + 1,
        trackPosition: trackIndex + 1,
        occurrencePosition,
        trackNumber: getTrackNumber(track),
      }
      const kept = firstOccurrenceByTrackId.get(track.id)
      if (kept) {
        deduplications.push({
          kind: 'duplicate_track',
          scope: 'source_assembly',
          stableId: track.id,
          kept,
          removed: occurrence,
          reason: 'first_occurrence',
        })
        continue
      }
      firstOccurrenceByTrackId.set(track.id, occurrence)
      tracks.push(track)
    }
  }

  return {
    tracks,
    rawTrackCount: occurrencePosition,
    deduplications,
  }
}
