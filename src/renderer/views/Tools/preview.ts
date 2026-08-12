import type {
  DiscographyAlbumPlan,
  DiscographyIssue,
  DiscographyPlan,
} from '@renderer/core/artistDiscography'

export interface DiscographyDeduplicationOccurrencePreview {
  albumId: string | null
  albumName: string | null
  trackName: string | null
  singer: string | null
  providerSongId: string | number | null
  trackNumber: number | null
  albumPosition: number | null
  trackPosition: number | null
  occurrencePosition: number | null
}

export interface DiscographyDeduplicationPreview {
  key: string
  kind: 'album' | 'track'
  scope: 'album_catalog' | 'album_tracks' | 'source_assembly'
  stableId: string
  name: string | null
  singer: string | null
  providerSongId: string | number | null
  kept: DiscographyDeduplicationOccurrencePreview | null
  removed: DiscographyDeduplicationOccurrencePreview | null
  exact: boolean
}

export interface DiscographyDeduplicationIdentifierPresentation {
  kind: 'track_id' | 'album_id' | 'provider_song_id'
  value: string | number
}

export interface DiscographyDeduplicationOccurrencePresentation {
  albumId: string | null
  albumName: string | null
  trackNumber: number | null
}

export interface DiscographyDeduplicationPresentation {
  key: string
  kind: DiscographyDeduplicationPreview['kind']
  scope: DiscographyDeduplicationPreview['scope']
  name: string | null
  singer: string | null
  identifier: DiscographyDeduplicationIdentifierPresentation | null
  kept: DiscographyDeduplicationOccurrencePresentation | null
  removed: DiscographyDeduplicationOccurrencePresentation | null
  limited: boolean
}

export interface DiscographyIssuePreview {
  issue: DiscographyIssue
  albumName: string | null
}

export interface DiscographyPreview {
  issues: DiscographyIssuePreview[]
  deduplications: DiscographyDeduplicationPreview[]
}

const createDeduplicationOccurrencePresentation = (
  occurrence: DiscographyDeduplicationOccurrencePreview | null,
): DiscographyDeduplicationOccurrencePresentation | null => occurrence == null
  ? null
  : {
      albumId: occurrence.albumId,
      albumName: occurrence.albumName,
      trackNumber: occurrence.trackNumber,
    }

export const createDiscographyDeduplicationPresentation = (
  audit: DiscographyDeduplicationPreview,
): DiscographyDeduplicationPresentation => {
  const stableId = audit.stableId.trim()
  const identifier: DiscographyDeduplicationIdentifierPresentation | null = stableId
    ? {
        kind: audit.kind == 'track' ? 'track_id' : 'album_id',
        value: stableId,
      }
    : audit.providerSongId == null
      ? null
      : { kind: 'provider_song_id', value: audit.providerSongId }

  return {
    key: audit.key,
    kind: audit.kind,
    scope: audit.scope,
    name: audit.name,
    singer: audit.singer,
    identifier,
    kept: createDeduplicationOccurrencePresentation(audit.kept),
    removed: createDeduplicationOccurrencePresentation(audit.removed),
    limited: !audit.exact,
  }
}

interface LocatedIssue {
  issue: DiscographyIssue
  ownerAlbum: DiscographyAlbumPlan | null
  key: string
}

const isDuplicateIssue = (issue: DiscographyIssue) => {
  return issue.code == 'duplicate_album' || issue.code == 'duplicate_track'
}

const isAlbumRootCauseIssue = (issue: DiscographyIssue) => {
  return issue.code == 'provider_unavailable' || issue.code == 'invalid_provider_response'
}

const isDerivedEmptyAlbumIssue = (issue: DiscographyIssue) => {
  return issue.stage == 'album_tracks' &&
    (issue.code == 'album_incomplete' || issue.code == 'empty_catalog')
}

const getProviderSongId = (track: LX.Music.MusicInfoOnline | null) => {
  const songId = track?.meta.songId
  return typeof songId == 'string' || typeof songId == 'number' ? songId : null
}

const getTrackNumber = (track: LX.Music.MusicInfoOnline | null) => {
  const trackNumber = track?.meta.trackNumber
  return typeof trackNumber == 'number' && Number.isSafeInteger(trackNumber) && trackNumber > 0
    ? trackNumber
    : null
}

const locateIssues = (plan: DiscographyPlan): LocatedIssue[] => {
  const albumsById = new Map(plan.albums.map(album => [album.album.id, album]))
  const located: LocatedIssue[] = plan.issues.map((issue, index) => ({
    issue,
    ownerAlbum: issue.albumId ? albumsById.get(issue.albumId) ?? null : null,
    key: `plan-${index}`,
  }))

  for (const [albumIndex, album] of plan.albums.entries()) {
    for (const [issueIndex, issue] of album.issues.entries()) {
      located.push({
        issue,
        ownerAlbum: album,
        key: `album-${albumIndex}-${issueIndex}`,
      })
    }
  }
  return located
}

const exactOccurrencePreview = (
  occurrence: DiscographyPlan['deduplications'][number]['kept'],
): DiscographyDeduplicationOccurrencePreview => ({
  albumId: occurrence.albumId,
  albumName: occurrence.albumName,
  trackName: occurrence.trackName,
  singer: occurrence.singer,
  providerSongId: occurrence.providerSongId,
  trackNumber: occurrence.trackNumber,
  albumPosition: occurrence.albumPosition,
  trackPosition: occurrence.trackPosition,
  occurrencePosition: occurrence.occurrencePosition,
})

const fallbackOccurrencePreview = (
  albumId: string | null,
  album: DiscographyAlbumPlan | null,
  track: LX.Music.MusicInfoOnline | null,
): DiscographyDeduplicationOccurrencePreview | null => {
  if (!albumId && !album) return null
  return {
    albumId: album?.album.id ?? albumId,
    albumName: album?.album.name ?? null,
    trackName: track?.name ?? null,
    singer: track?.singer ?? null,
    providerSongId: getProviderSongId(track),
    trackNumber: getTrackNumber(track),
    albumPosition: null,
    trackPosition: null,
    occurrencePosition: null,
  }
}

const createExactDeduplicationPreviews = (
  plan: DiscographyPlan,
): DiscographyDeduplicationPreview[] => plan.deduplications.map(deduplication => ({
  key: [
    'track',
    plan.source,
    deduplication.scope,
    deduplication.stableId,
    deduplication.kept.occurrencePosition,
    deduplication.removed.occurrencePosition,
  ].join(':'),
  kind: 'track',
  scope: deduplication.scope,
  stableId: deduplication.stableId,
  name: deduplication.kept.trackName ?? deduplication.removed.trackName ?? null,
  singer: deduplication.kept.singer ?? deduplication.removed.singer ?? null,
  providerSongId: deduplication.kept.providerSongId ?? deduplication.removed.providerSongId ?? null,
  kept: exactOccurrencePreview(deduplication.kept),
  removed: exactOccurrencePreview(deduplication.removed),
  exact: true,
}))

const createFallbackTrackPreview = (
  plan: DiscographyPlan,
  located: LocatedIssue,
): DiscographyDeduplicationPreview => {
  const { issue, ownerAlbum } = located
  const albumsById = new Map(plan.albums.map(album => [album.album.id, album]))
  const removedAlbumId = issue.albumId ?? ownerAlbum?.album.id ?? null
  const keptAlbumId = issue.relatedAlbumId ?? removedAlbumId
  const removedAlbum = removedAlbumId ? albumsById.get(removedAlbumId) ?? ownerAlbum : ownerAlbum
  const keptAlbum = keptAlbumId ? albumsById.get(keptAlbumId) ?? removedAlbum : removedAlbum
  const stableId = issue.trackId ?? ''
  const findTrack = (album: DiscographyAlbumPlan | null) => {
    return album?.tracks.find(track => track.id == stableId) ?? null
  }
  const removedTrack = findTrack(removedAlbum)
  const keptTrack = findTrack(keptAlbum) ?? removedTrack ?? plan.albums
    .flatMap(album => album.tracks)
    .find(track => track.id == stableId) ?? null
  const displayTrack = keptTrack ?? removedTrack

  return {
    key: ['track', plan.source, 'album_tracks', stableId, located.key].join(':'),
    kind: 'track',
    scope: 'album_tracks',
    stableId,
    name: displayTrack?.name ?? null,
    singer: displayTrack?.singer ?? null,
    providerSongId: getProviderSongId(displayTrack),
    kept: fallbackOccurrencePreview(keptAlbumId, keptAlbum, keptTrack),
    removed: fallbackOccurrencePreview(removedAlbumId, removedAlbum, null),
    exact: false,
  }
}

const createFallbackAlbumPreview = (
  plan: DiscographyPlan,
  located: LocatedIssue,
): DiscographyDeduplicationPreview => {
  const { issue, ownerAlbum } = located
  const stableId = issue.albumId ?? ownerAlbum?.album.id ?? ''
  const album = plan.albums.find(item => item.album.id == stableId) ?? ownerAlbum
  const keptOccurrence = fallbackOccurrencePreview(stableId || null, album, null)
  const removedOccurrence = fallbackOccurrencePreview(stableId || null, null, null)
  return {
    key: ['album', plan.source, 'album_catalog', stableId, located.key].join(':'),
    kind: 'album',
    scope: 'album_catalog',
    stableId,
    name: album?.album.name ?? null,
    singer: null,
    providerSongId: null,
    kept: keptOccurrence,
    removed: removedOccurrence,
    exact: false,
  }
}

export const createDiscographyPreview = (plan: DiscographyPlan): DiscographyPreview => {
  const locatedIssues = locateIssues(plan)
  const emptyAlbumsWithRootCause = new Set(locatedIssues
    .filter(({ issue, ownerAlbum }) => ownerAlbum != null &&
      ownerAlbum.actualCount == 0 &&
      issue.albumId == ownerAlbum.album.id &&
      isAlbumRootCauseIssue(issue))
    .map(({ ownerAlbum }) => ownerAlbum))
  const issues = locatedIssues
    .filter(({ issue, ownerAlbum }) => !isDuplicateIssue(issue) && !(
      ownerAlbum &&
      issue.albumId == ownerAlbum.album.id &&
      emptyAlbumsWithRootCause.has(ownerAlbum) &&
      isDerivedEmptyAlbumIssue(issue)
    ))
    .map(({ issue, ownerAlbum }) => ({
      issue,
      albumName: ownerAlbum?.album.name ?? null,
    }))
  const fallbackDeduplications = locatedIssues
    .filter(({ issue }) => isDuplicateIssue(issue) && issue.stage != 'assembly')
    .map(located => located.issue.code == 'duplicate_album'
      ? createFallbackAlbumPreview(plan, located)
      : createFallbackTrackPreview(plan, located))

  return {
    issues,
    deduplications: [
      ...createExactDeduplicationPreviews(plan),
      ...fallbackDeduplications,
    ],
  }
}
