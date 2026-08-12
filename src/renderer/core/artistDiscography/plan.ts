import type {
  AlbumRef,
  ArtistCatalogPort,
  ArtistDiscographySource,
  ArtistRef,
  CatalogCollection,
  DiscographyAlbumPlan,
  DiscographyIssue,
  DiscographyIssueStage,
  DiscographyPlan,
  DiscographyPlanInput,
  DiscographyPlanProgress,
} from './types'
import { DiscographyError } from './types'
import { assembleDiscographyTracks } from './assembly'
import { normalizeReleaseDate } from '@common/utils/downloadTarget'

interface PlanOptions {
  catalog: ArtistCatalogPort
  albumConcurrency: number
  now: () => number
}

interface ScheduledAlbum {
  album: AlbumRef
  index: number
  priority: number
}

const createIssue = (
  code: DiscographyIssue['code'],
  stage: DiscographyIssueStage,
  message: string,
  details: Partial<Omit<DiscographyIssue, 'code' | 'stage' | 'message' | 'severity'>> & {
    severity?: DiscographyIssue['severity']
  } = {},
): DiscographyIssue => ({
  code,
  stage,
  message,
  severity: details.severity ?? 'error',
  ...details,
})

const cancelledIssue = (details: Pick<DiscographyIssue, 'artistId' | 'albumId'> = {}): DiscographyIssue => createIssue(
  'cancelled',
  details.albumId ? 'album_tracks' : 'input',
  'Discography collection was cancelled.',
  details,
)

const isNonNegativeInteger = (value: unknown): value is number => {
  return typeof value == 'number' && Number.isInteger(value) && value >= 0
}

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value == 'string' && value.trim().length > 0
}

const isAbortError = (error: unknown) => {
  return error instanceof Error && error.name == 'AbortError'
}

const normalizeError = (
  error: unknown,
  stage: DiscographyIssueStage,
  signal?: AbortSignal,
  details: Pick<DiscographyIssue, 'artistId' | 'albumId'> = {},
): DiscographyIssue => {
  if ((signal?.aborted ?? false) || isAbortError(error)) return cancelledIssue(details)
  if (error instanceof DiscographyError) {
    return {
      ...error.issue,
      artistId: error.issue.artistId ?? details.artistId,
      albumId: error.issue.albumId ?? details.albumId,
    }
  }
  return createIssue(
    'provider_unavailable',
    stage,
    'The music provider is temporarily unavailable.',
    { ...details, retryable: true },
  )
}

const emitProgress = (callback: DiscographyPlanInput['onProgress'], progress: DiscographyPlanProgress) => {
  try {
    callback?.(progress)
  } catch {
    // Progress observers must not change the read-only plan result.
  }
}

const createEmptyPlan = (source: ArtistDiscographySource, fetchedAt: number): DiscographyPlan => ({
  source,
  status: 'failed',
  artist: null,
  expectedAlbumCount: null,
  actualAlbumCount: 0,
  albums: [],
  tracks: [],
  deduplications: [],
  rawTrackCount: 0,
  deduplicatedTrackCount: 0,
  canApply: false,
  fetchedAt,
  issues: [],
})

const finishPlan = (
  plan: DiscographyPlan,
  onProgress: DiscographyPlanInput['onProgress'],
  completed: number,
  total: number,
) => {
  emitProgress(onProgress, {
    stage: 'completed',
    status: plan.status,
    completed,
    total,
  })
  return plan
}

const normalizeCollection = <T>(
  collection: CatalogCollection<T> | null | undefined,
  stage: DiscographyIssueStage,
): CatalogCollection<T> => {
  if (
    !collection ||
    !Array.isArray(collection.items) ||
    typeof collection.complete != 'boolean' ||
    !Array.isArray(collection.issues) ||
    !(collection.reportedTotal == null || isNonNegativeInteger(collection.reportedTotal))
  ) {
    throw new DiscographyError(createIssue(
      'invalid_provider_response',
      stage,
      'The music provider returned an invalid collection.',
      { retryable: true },
    ))
  }
  return collection
}

const validateArtist = (artist: ArtistRef | null | undefined, source: ArtistDiscographySource) => {
  if (
    !artist ||
    artist.source != source ||
    !isNonEmptyString(artist.id) ||
    !isNonEmptyString(artist.name) ||
    !(artist.albumCount == null || isNonNegativeInteger(artist.albumCount))
  ) {
    throw new DiscographyError(createIssue(
      'invalid_provider_response',
      'artist',
      'The music provider returned an invalid artist.',
      { retryable: true },
    ))
  }
  return artist
}

const validateAlbum = (album: AlbumRef, source: ArtistDiscographySource): boolean => {
  return album?.source == source &&
    isNonEmptyString(album.id) &&
    isNonEmptyString(album.name) &&
    isNonEmptyString(album.artist) &&
    (album.releaseDate == null || normalizeReleaseDate(album.releaseDate) == album.releaseDate) &&
    (album.expectedTrackCount == null || isNonNegativeInteger(album.expectedTrackCount))
}

const collectAlbums = (
  collection: CatalogCollection<AlbumRef>,
  artist: ArtistRef,
) => {
  const issues = [...collection.issues]
  const albums: AlbumRef[] = []
  const albumIds = new Set<string>()
  let complete = collection.complete && !collection.issues.some(issue => issue.severity == 'error')

  for (const album of collection.items) {
    if (!validateAlbum(album, artist.source)) {
      complete = false
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'An album entry is missing required fields.',
        { artistId: artist.id, retryable: true },
      ))
      continue
    }
    if (albumIds.has(album.id)) {
      complete = false
      issues.push(createIssue(
        'duplicate_album',
        'albums',
        'The provider returned the same album ID more than once.',
        { artistId: artist.id, albumId: album.id },
      ))
      continue
    }
    albumIds.add(album.id)
    albums.push(album)
  }

  if (!collection.complete && !collection.issues.some(issue => issue.severity == 'error')) {
    issues.push(createIssue(
      'pagination_inconsistent',
      'albums',
      'The album collection is incomplete.',
      { artistId: artist.id, retryable: true },
    ))
  }

  const declaredCounts = [artist.albumCount, collection.reportedTotal]
    .filter((count): count is number => count != null)
  for (const expected of declaredCounts) {
    if (expected == albums.length) continue
    complete = false
    issues.push(createIssue(
      'pagination_inconsistent',
      'albums',
      'The reported album count does not match the unique album count.',
      {
        artistId: artist.id,
        expected,
        actual: albums.length,
        retryable: true,
      },
    ))
  }

  if (
    artist.albumCount != null &&
    collection.reportedTotal != null &&
    artist.albumCount != collection.reportedTotal
  ) {
    complete = false
    issues.push(createIssue(
      'pagination_inconsistent',
      'albums',
      'The artist and album endpoints reported different album counts.',
      {
        artistId: artist.id,
        expected: artist.albumCount,
        actual: collection.reportedTotal,
        retryable: true,
      },
    ))
  }

  return {
    albums,
    complete,
    issues,
    expectedAlbumCount: artist.albumCount ?? collection.reportedTotal,
  }
}

const getTrackAlbumId = (track: LX.Music.MusicInfoOnline) => {
  const albumId = track?.meta?.albumId
  return albumId == null ? null : String(albumId)
}

const isValidTrack = (track: LX.Music.MusicInfoOnline, album: AlbumRef) => {
  if (
    !track ||
    track.source != album.source ||
    !isNonEmptyString(track.id) ||
    !isNonEmptyString(track.name) ||
    !isNonEmptyString(track.singer) ||
    !(track.interval == null || typeof track.interval == 'string') ||
    !track.meta ||
    !(typeof track.meta.songId == 'string' || typeof track.meta.songId == 'number') ||
    String(track.meta.songId).trim().length == 0 ||
    typeof track.meta.albumName != 'string' ||
    !Array.isArray(track.meta.qualitys) ||
    !track.meta._qualitys ||
    typeof track.meta._qualitys != 'object'
  ) return false

  if (getTrackAlbumId(track) != album.id) return false
  return track.source != 'kg' || isNonEmptyString(track.meta.hash)
}

const enrichAlbumTrack = (
  track: LX.Music.MusicInfoOnline,
  discographyArtist: string,
  album: AlbumRef,
  trackNumber: number,
  trackTotal: number,
): LX.Music.MusicInfoOnline => Object.assign({}, track, {
  meta: Object.assign({}, track.meta, {
    discographyArtist,
    albumArtist: album.artist,
    releaseDate: album.releaseDate,
    trackNumber,
    trackTotal,
  }),
})

const collectAlbumTracks = (
  discographyArtist: string,
  album: AlbumRef,
  collection: CatalogCollection<LX.Music.MusicInfoOnline>,
): DiscographyAlbumPlan => {
  const issues = [...collection.issues]
  const tracks: LX.Music.MusicInfoOnline[] = []
  const trackIds = new Set<string>()
  let collectionComplete = collection.complete && !collection.issues.some(issue => issue.severity == 'error')

  for (const [trackIndex, track] of collection.items.entries()) {
    if (!isValidTrack(track, album)) {
      collectionComplete = false
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'An album track is missing required fields or has a different album ID.',
        {
          albumId: album.id,
          trackId: isNonEmptyString(track?.id) ? track.id : undefined,
          retryable: true,
        },
      ))
      continue
    }
    if (trackIds.has(track.id)) {
      collectionComplete = false
      issues.push(createIssue(
        'duplicate_track',
        'album_tracks',
        'The album detail returned the same track ID more than once.',
        { albumId: album.id, trackId: track.id },
      ))
      continue
    }
    trackIds.add(track.id)
    const providerTrackNumber = track.meta.trackNumber
    const trackNumber = Number.isSafeInteger(providerTrackNumber) && Number(providerTrackNumber) > 0
      ? Number(providerTrackNumber)
      : trackIndex + 1
    tracks.push(enrichAlbumTrack(
      track,
      discographyArtist,
      album,
      trackNumber,
      album.expectedTrackCount ?? collection.reportedTotal ?? collection.items.length,
    ))
  }

  if (!collection.complete && !collection.issues.some(issue => issue.severity == 'error')) {
    issues.push(createIssue(
      'pagination_inconsistent',
      'album_tracks',
      'The album track collection is incomplete.',
      { albumId: album.id, retryable: true },
    ))
  }

  if (collection.reportedTotal != null && collection.reportedTotal != tracks.length) {
    collectionComplete = false
    issues.push(createIssue(
      'pagination_inconsistent',
      'album_tracks',
      'The album detail total does not match its unique valid track count.',
      {
        albumId: album.id,
        expected: collection.reportedTotal,
        actual: tracks.length,
        retryable: true,
      },
    ))
  }

  if (
    album.expectedTrackCount != null &&
    collection.reportedTotal != null &&
    album.expectedTrackCount != collection.reportedTotal
  ) {
    collectionComplete = false
    issues.push(createIssue(
      'album_incomplete',
      'album_tracks',
      'The album list and album detail endpoints reported different track counts.',
      {
        albumId: album.id,
        expected: album.expectedTrackCount,
        actual: collection.reportedTotal,
        retryable: true,
      },
    ))
  }

  if (album.expectedTrackCount != null && album.expectedTrackCount != tracks.length) {
    collectionComplete = false
    issues.push(createIssue(
      'album_incomplete',
      'album_tracks',
      'The album declared track count does not match its unique valid track count.',
      {
        albumId: album.id,
        expected: album.expectedTrackCount,
        actual: tracks.length,
        retryable: true,
      },
    ))
  }

  if (!tracks.length) {
    issues.push(createIssue(
      'empty_catalog',
      'album_tracks',
      'The album detail contains no valid tracks.',
      {
        albumId: album.id,
        severity: album.expectedTrackCount == 0 && collectionComplete ? 'warning' : 'error',
        retryable: album.expectedTrackCount != 0,
      },
    ))
    if (album.expectedTrackCount != 0) collectionComplete = false
  }

  let status: DiscographyAlbumPlan['status']
  if (!collectionComplete) status = 'incomplete'
  else if (album.expectedTrackCount == null) status = 'unknown'
  else status = 'complete'

  return {
    album,
    tracks,
    expectedCount: album.expectedTrackCount,
    actualCount: tracks.length,
    status,
    issues,
  }
}

const failedAlbum = (album: AlbumRef, issue: DiscographyIssue): DiscographyAlbumPlan => ({
  album,
  tracks: [],
  expectedCount: album.expectedTrackCount,
  actualCount: 0,
  status: 'failed',
  issues: [issue],
})

const getArtistTrackHintCounts = async(
  catalog: ArtistCatalogPort,
  artist: ArtistRef,
  signal: AbortSignal | undefined,
  issues: DiscographyIssue[],
) => {
  const hintCounts = new Map<string, Set<string>>()
  if (!catalog.getArtistTracks) return hintCounts

  try {
    const collection = normalizeCollection(
      await catalog.getArtistTracks(artist.id, signal),
      'artist_tracks',
    )
    for (const issue of collection.issues) issues.push({ ...issue, severity: 'warning' })
    if (!collection.complete && !collection.issues.length) {
      issues.push(createIssue(
        'pagination_inconsistent',
        'artist_tracks',
        'The optional artist track hint collection is incomplete.',
        { artistId: artist.id, retryable: true, severity: 'warning' },
      ))
    }
    for (const track of collection.items) {
      const albumId = getTrackAlbumId(track)
      if (!albumId || !isNonEmptyString(track?.id)) continue
      let trackIds = hintCounts.get(albumId)
      if (!trackIds) {
        trackIds = new Set<string>()
        hintCounts.set(albumId, trackIds)
      }
      trackIds.add(track.id)
    }
  } catch (error) {
    if (
      (signal?.aborted ?? false) ||
      isAbortError(error) ||
      (error instanceof DiscographyError && error.issue.code == 'cancelled')
    ) throw error
    issues.push({
      ...normalizeError(error, 'artist_tracks', signal, { artistId: artist.id }),
      severity: 'warning',
    })
  }
  return hintCounts
}

const createSchedule = (albums: AlbumRef[], hintCounts: Map<string, Set<string>>): ScheduledAlbum[] => {
  return albums
    .map((album, index) => {
      const hintedCount = hintCounts.get(album.id)?.size
      return {
        album,
        index,
        priority: hintedCount == null || (
          album.expectedTrackCount != null && hintedCount != album.expectedTrackCount
        ) ? 0 : 1,
      }
    })
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
}

const collectAlbumDetails = async(
  schedule: ScheduledAlbum[],
  discographyArtist: string,
  catalog: ArtistCatalogPort,
  concurrency: number,
  signal: AbortSignal | undefined,
  onProgress: DiscographyPlanInput['onProgress'],
) => {
  const results = new Array<DiscographyAlbumPlan | undefined>(schedule.length)
  let nextIndex = 0
  let completed = 0

  const worker = async() => {
    while (true) {
      if (signal?.aborted) return
      const scheduleIndex = nextIndex++
      if (scheduleIndex >= schedule.length) return
      const target = schedule[scheduleIndex]
      if (signal?.aborted) return

      emitProgress(onProgress, {
        stage: 'fetching_album_tracks',
        phase: 'started',
        completed,
        total: schedule.length,
        albumId: target.album.id,
      })

      let result: DiscographyAlbumPlan
      try {
        const collection = normalizeCollection(
          await catalog.getAlbumTracks(target.album.id, signal),
          'album_tracks',
        )
        if (signal?.aborted) result = failedAlbum(target.album, cancelledIssue({ albumId: target.album.id }))
        else result = collectAlbumTracks(discographyArtist, target.album, collection)
      } catch (error) {
        result = failedAlbum(target.album, normalizeError(
          error,
          'album_tracks',
          signal,
          { albumId: target.album.id },
        ))
      }
      results[target.index] = result
      completed++
      emitProgress(onProgress, {
        stage: 'fetching_album_tracks',
        phase: 'completed',
        completed,
        total: schedule.length,
        albumId: target.album.id,
      })
    }
  }

  const workerCount = Math.min(concurrency, schedule.length)
  await Promise.all(Array.from({ length: workerCount }, worker))

  if (signal?.aborted) {
    for (const target of schedule) {
      results[target.index] ??= failedAlbum(target.album, cancelledIssue({ albumId: target.album.id }))
    }
  }

  return {
    completed,
    results: results.filter((result): result is DiscographyAlbumPlan => result != null),
  }
}

export const planArtistDiscography = async(
  input: DiscographyPlanInput,
  options: PlanOptions,
): Promise<DiscographyPlan> => {
  const source = input.source
  const basePlan = createEmptyPlan(source, options.now())
  emitProgress(input.onProgress, { stage: 'resolving_artist' })

  if (!isNonEmptyString(input.artistRef)) {
    basePlan.issues.push(createIssue(
      'invalid_artist_ref',
      'input',
      'An artist name is required.',
    ))
    return finishPlan(basePlan, input.onProgress, 0, 0)
  }
  if (input.signal?.aborted) {
    basePlan.status = 'cancelled'
    basePlan.issues.push(cancelledIssue())
    return finishPlan(basePlan, input.onProgress, 0, 0)
  }

  let artist: ArtistRef
  try {
    artist = validateArtist(
      await options.catalog.resolveArtist(input.artistRef.trim(), input.signal),
      source,
    )
  } catch (error) {
    const issue = normalizeError(error, 'artist', input.signal)
    basePlan.status = issue.code == 'cancelled' ? 'cancelled' : 'failed'
    basePlan.issues.push(issue)
    return finishPlan(basePlan, input.onProgress, 0, 0)
  }
  basePlan.artist = artist

  if (input.confirmArtist) {
    let confirmed = false
    try {
      confirmed = await input.confirmArtist(artist)
    } catch {
      confirmed = false
    }
    if (!confirmed || input.signal?.aborted) {
      basePlan.status = 'cancelled'
      basePlan.issues.push(cancelledIssue({ artistId: artist.id }))
      return finishPlan(basePlan, input.onProgress, 0, 0)
    }
  }

  if (input.signal?.aborted) {
    basePlan.status = 'cancelled'
    basePlan.issues.push(cancelledIssue({ artistId: artist.id }))
    return finishPlan(basePlan, input.onProgress, 0, 0)
  }

  emitProgress(input.onProgress, { stage: 'fetching_albums', artistId: artist.id })
  let albumCollection: CatalogCollection<AlbumRef>
  try {
    albumCollection = normalizeCollection(
      await options.catalog.getArtistAlbums(artist.id, input.signal),
      'albums',
    )
  } catch (error) {
    const issue = normalizeError(error, 'albums', input.signal, { artistId: artist.id })
    basePlan.status = issue.code == 'cancelled' ? 'cancelled' : 'failed'
    basePlan.issues.push(issue)
    return finishPlan(basePlan, input.onProgress, 0, 0)
  }

  const albumCatalog = collectAlbums(albumCollection, artist)
  basePlan.expectedAlbumCount = albumCatalog.expectedAlbumCount
  basePlan.actualAlbumCount = albumCatalog.albums.length
  basePlan.issues.push(...albumCatalog.issues)

  if (!albumCatalog.albums.length) {
    basePlan.status = input.signal?.aborted ? 'cancelled' : 'failed'
    basePlan.issues.push(input.signal?.aborted
      ? cancelledIssue({ artistId: artist.id })
      : createIssue(
        'empty_catalog',
        'albums',
        'The artist album catalog is empty.',
        { artistId: artist.id, retryable: true },
      ))
    return finishPlan(basePlan, input.onProgress, 0, 0)
  }

  let hintCounts: Map<string, Set<string>>
  try {
    hintCounts = await getArtistTrackHintCounts(
      options.catalog,
      artist,
      input.signal,
      basePlan.issues,
    )
  } catch (error) {
    basePlan.status = 'cancelled'
    basePlan.albums = albumCatalog.albums.map(album => failedAlbum(album, cancelledIssue({ albumId: album.id })))
    basePlan.issues.push(normalizeError(error, 'artist_tracks', input.signal, { artistId: artist.id }))
    return finishPlan(basePlan, input.onProgress, 0, albumCatalog.albums.length)
  }

  if (input.signal?.aborted) {
    basePlan.status = 'cancelled'
    basePlan.albums = albumCatalog.albums.map(album => failedAlbum(album, cancelledIssue({ albumId: album.id })))
    basePlan.issues.push(cancelledIssue({ artistId: artist.id }))
    return finishPlan(basePlan, input.onProgress, 0, albumCatalog.albums.length)
  }

  const details = await collectAlbumDetails(
    createSchedule(albumCatalog.albums, hintCounts),
    artist.name,
    options.catalog,
    options.albumConcurrency,
    input.signal,
    input.onProgress,
  )
  basePlan.albums = details.results

  const assembled = assembleDiscographyTracks(basePlan.albums)
  basePlan.tracks = assembled.tracks
  basePlan.deduplications = assembled.deduplications
  basePlan.rawTrackCount = assembled.rawTrackCount
  basePlan.deduplicatedTrackCount = assembled.tracks.length
  basePlan.issues.push(...assembled.deduplications.map(deduplication => createIssue(
    'duplicate_track',
    'assembly',
    'A track ID appears in more than one album and was folded in the playlist.',
    {
      albumId: deduplication.removed.albumId,
      relatedAlbumId: deduplication.kept.albumId,
      trackId: deduplication.stableId,
      severity: 'warning',
    },
  )))

  if (input.signal?.aborted) {
    basePlan.status = 'cancelled'
    basePlan.issues.push(cancelledIssue({ artistId: artist.id }))
  } else if (!assembled.tracks.length) {
    basePlan.status = 'failed'
    basePlan.issues.push(createIssue(
      'empty_catalog',
      'assembly',
      'The discography contains no valid tracks.',
      { artistId: artist.id, retryable: true },
    ))
  } else if (
    !albumCatalog.complete ||
    basePlan.albums.length != albumCatalog.albums.length ||
    basePlan.albums.some(album => album.status != 'complete')
  ) {
    basePlan.status = 'partial'
  } else {
    basePlan.status = 'complete'
  }
  basePlan.canApply = (
    basePlan.status == 'complete' || basePlan.status == 'partial'
  ) && assembled.tracks.length > 0

  return finishPlan(
    basePlan,
    input.onProgress,
    details.completed,
    albumCatalog.albums.length,
  )
}
