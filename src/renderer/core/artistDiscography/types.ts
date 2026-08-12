export type ArtistDiscographySource = 'kg' | 'tx' | 'wy' | 'kw'

export type DiscographyPlanStatus = 'complete' | 'partial' | 'failed' | 'cancelled'

export type DiscographyAlbumStatus = 'complete' | 'incomplete' | 'unknown' | 'failed'

export type DiscographyIssueCode =
  | 'unsupported_source'
  | 'invalid_artist_ref'
  | 'artist_not_found'
  | 'provider_unavailable'
  | 'invalid_provider_response'
  | 'pagination_inconsistent'
  | 'album_incomplete'
  | 'empty_catalog'
  | 'cancelled'
  | 'duplicate_album'
  | 'duplicate_track'
  | 'invalid_album_selection'
  | 'invalid_playlist_target'
  | 'playlist_create_failed'
  | 'playlist_add_failed'
  | 'playlist_rollback_failed'

export type DiscographyIssueStage =
  | 'input'
  | 'artist'
  | 'albums'
  | 'artist_tracks'
  | 'album_tracks'
  | 'assembly'
  | 'apply'

export interface DiscographyIssue {
  code: DiscographyIssueCode
  stage: DiscographyIssueStage
  message: string
  severity: 'warning' | 'error'
  source?: ArtistDiscographySource
  retryable?: boolean
  artistId?: string
  albumId?: string
  trackId?: string
  relatedAlbumId?: string
  expected?: number | null
  actual?: number
}

export class DiscographyError extends Error {
  readonly issue: DiscographyIssue

  constructor(issue: DiscographyIssue) {
    super(issue.message)
    this.name = 'DiscographyError'
    this.issue = issue
  }
}

export interface ArtistRef {
  source: ArtistDiscographySource
  id: string
  name: string
  avatar: string | null
  albumCount: number | null
}

export interface AlbumRef {
  source: ArtistDiscographySource
  id: string
  name: string
  artist: string
  releaseDate: string | null
  image: string | null
  expectedTrackCount: number | null
}

export interface CatalogCollection<T> {
  items: T[]
  reportedTotal: number | null
  complete: boolean
  issues: DiscographyIssue[]
}

export interface ArtistCatalogPort {
  resolveArtist: (ref: string, signal?: AbortSignal) => Promise<ArtistRef>
  getArtistAlbums: (artistId: string, signal?: AbortSignal) => Promise<CatalogCollection<AlbumRef>>
  getArtistTracks?: (artistId: string, signal?: AbortSignal) => Promise<CatalogCollection<LX.Music.MusicInfoOnline>>
  getAlbumTracks: (albumId: string, signal?: AbortSignal) => Promise<CatalogCollection<LX.Music.MusicInfoOnline>>
}

export interface PlaylistPort {
  create: (id: string, name: string) => Promise<void>
  add: (id: string, tracks: LX.Music.MusicInfoOnline[]) => Promise<void>
  remove: (id: string) => Promise<void>
}

export type DiscographyPlanProgress =
  | {
    stage: 'resolving_artist'
  }
  | {
    stage: 'fetching_albums'
    artistId: string
  }
  | {
    stage: 'fetching_album_tracks'
    phase: 'started' | 'completed'
    completed: number
    total: number
    albumId: string
  }
  | {
    stage: 'completed'
    status: DiscographyPlanStatus
    completed: number
    total: number
  }

export interface DiscographyPlanInput {
  source: ArtistDiscographySource
  artistRef: string
  signal?: AbortSignal
  onProgress?: (progress: DiscographyPlanProgress) => void
  confirmArtist?: (artist: ArtistRef) => boolean | Promise<boolean>
}

export interface DiscographyAlbumPlan {
  album: AlbumRef
  tracks: LX.Music.MusicInfoOnline[]
  expectedCount: number | null
  actualCount: number
  status: DiscographyAlbumStatus
  issues: DiscographyIssue[]
}

export interface DiscographyTrackOccurrence {
  source: ArtistDiscographySource
  trackId: string
  providerSongId: string | number
  trackName: string
  singer: string
  albumId: string
  albumName: string
  albumArtist: string
  albumPosition: number
  trackPosition: number
  occurrencePosition: number
  trackNumber: number | null
}

export interface DiscographyTrackDeduplication {
  kind: 'duplicate_track'
  scope: 'source_assembly'
  stableId: string
  kept: DiscographyTrackOccurrence
  removed: DiscographyTrackOccurrence
  reason: 'first_occurrence'
}

export interface DiscographyPlan {
  source: ArtistDiscographySource
  status: DiscographyPlanStatus
  artist: ArtistRef | null
  expectedAlbumCount: number | null
  actualAlbumCount: number
  albums: DiscographyAlbumPlan[]
  tracks: LX.Music.MusicInfoOnline[]
  deduplications: DiscographyTrackDeduplication[]
  rawTrackCount: number
  deduplicatedTrackCount: number
  canApply: boolean
  fetchedAt: number
  issues: DiscographyIssue[]
}

export type DiscographyApplyTarget =
  | { type: 'new', name: string }
  | { type: 'existing', listId: string }

export interface DiscographyApplyInput {
  plan: DiscographyPlan
  albumIds?: string[]
  target: DiscographyApplyTarget
}

export interface DiscographyApplyResult {
  status: 'applied' | 'failed'
  listId: string | null
  residualListId: string | null
  plannedTrackCount: number
  submittedTrackCount: number
  issues: DiscographyIssue[]
}

export interface ArtistDiscographyModule {
  plan: (input: DiscographyPlanInput) => Promise<DiscographyPlan>
  apply: (input: DiscographyApplyInput) => Promise<DiscographyApplyResult>
}

export interface ArtistDiscographyModuleOptions {
  catalog: ArtistCatalogPort
  playlist: PlaylistPort
  albumConcurrency?: number
  now?: () => number
  createPlaylistId?: () => string
}

export interface DiscographyBatchPlanProgress {
  source: ArtistDiscographySource
  progress: DiscographyPlanProgress
}

export interface DiscographyBatchPlanInput {
  artistName: string
  sources: readonly ArtistDiscographySource[]
  signal?: AbortSignal
  onProgress?: (progress: DiscographyBatchPlanProgress) => void
  confirmArtists?: (artists: ArtistRef[]) => boolean | Promise<boolean>
}

export interface DiscographyBatchPlan {
  batchId: string
  artistName: string
  sources: ArtistDiscographySource[]
  status: 'ready' | 'blocked' | 'cancelled'
  plans: Partial<Record<ArtistDiscographySource, DiscographyPlan>>
  fetchedAt: number
  canApply: boolean
}

export interface DiscographyBatchApplyInput {
  plan: DiscographyBatchPlan
  sources: readonly ArtistDiscographySource[]
}

export interface DiscographyBatchApplyResult {
  status: 'applied' | 'validation_failed' | 'failed_rolled_back' | 'failed_with_residuals'
  listIds: Partial<Record<ArtistDiscographySource, string>>
  residualPlaylists: Array<{
    source: ArtistDiscographySource
    id: string
    name: string
  }>
  plannedTrackCounts: Partial<Record<ArtistDiscographySource, number>>
  failedSource: ArtistDiscographySource | null
  issues: DiscographyIssue[]
}

export interface ArtistDiscographyBatchModule {
  plan: (input: DiscographyBatchPlanInput) => Promise<DiscographyBatchPlan>
  apply: (input: DiscographyBatchApplyInput) => Promise<DiscographyBatchApplyResult>
}

export interface ArtistDiscographyBatchModuleOptions {
  catalogs: Record<ArtistDiscographySource, ArtistCatalogPort>
  playlist: PlaylistPort
  albumConcurrency?: number
  now?: () => number
  createPlaylistId?: () => string
}
