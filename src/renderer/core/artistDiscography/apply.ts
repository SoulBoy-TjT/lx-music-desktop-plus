import type {
  DiscographyAlbumPlan,
  DiscographyApplyInput,
  DiscographyApplyResult,
  DiscographyIssue,
  DiscographyTrackDeduplication,
  PlaylistPort,
} from './types'
import { assembleDiscographyTracks } from './assembly'

interface ApplyOptions {
  playlist: PlaylistPort
  createPlaylistId: () => string
}

export interface PreparedDiscographyApply {
  tracks: LX.Music.MusicInfoOnline[]
  deduplications: DiscographyTrackDeduplication[]
  issues: DiscographyIssue[]
}

const createIssue = (
  code: DiscographyIssue['code'],
  message: string,
  details: Partial<Omit<DiscographyIssue, 'code' | 'stage' | 'message' | 'severity'>> & {
    severity?: DiscographyIssue['severity']
  } = {},
): DiscographyIssue => ({
  code,
  stage: 'apply',
  message,
  severity: details.severity ?? 'error',
  ...details,
})

const failedResult = (
  issues: DiscographyIssue[],
  plannedTrackCount = 0,
  listId: string | null = null,
  residualListId: string | null = null,
): DiscographyApplyResult => ({
  status: 'failed',
  listId,
  residualListId,
  plannedTrackCount,
  submittedTrackCount: 0,
  issues,
})

const selectAlbums = (input: DiscographyApplyInput): {
  albums: DiscographyAlbumPlan[]
  issue: DiscographyIssue | null
} => {
  if (input.albumIds == null) {
    if (input.plan.albums.length) return { albums: input.plan.albums, issue: null }
    return {
      albums: [],
      issue: createIssue('invalid_album_selection', 'At least one album must be selected.'),
    }
  }

  const selectedIds = new Set(input.albumIds.filter(id => typeof id == 'string' && id.trim().length))
  if (!selectedIds.size) {
    return {
      albums: [],
      issue: createIssue('invalid_album_selection', 'At least one album must be selected.'),
    }
  }

  const albumsById = new Map(input.plan.albums.map(album => [album.album.id, album]))
  for (const albumId of selectedIds) {
    if (albumsById.has(albumId)) continue
    return {
      albums: [],
      issue: createIssue(
        'invalid_album_selection',
        'A selected album does not belong to this plan.',
        { albumId },
      ),
    }
  }

  return {
    albums: input.plan.albums.filter(album => selectedIds.has(album.album.id)),
    issue: null,
  }
}

const findAlbumWithInvalidTrackId = (albums: DiscographyAlbumPlan[]) => {
  for (const album of albums) {
    for (const track of album.tracks) {
      if (!track || typeof track.id != 'string' || !track.id.trim().length) {
        return album
      }
    }
  }
  return null
}

export const prepareArtistDiscographyApply = (
  input: DiscographyApplyInput,
): PreparedDiscographyApply => {
  if (!input.plan.artist || input.plan.artist.source != input.plan.source) {
    return {
      tracks: [],
      deduplications: [],
      issues: [createIssue('invalid_provider_response', 'The discography plan is invalid.')],
    }
  }

  if (input.plan.status == 'cancelled' || input.plan.status == 'failed') {
    return {
      tracks: [],
      deduplications: [],
      issues: [createIssue('album_incomplete', 'A cancelled or failed plan cannot be applied.')],
    }
  }

  const selected = selectAlbums(input)
  if (selected.issue) return { tracks: [], deduplications: [], issues: [selected.issue] }

  const invalidAlbum = findAlbumWithInvalidTrackId(selected.albums)
  if (invalidAlbum) {
    return {
      tracks: [],
      deduplications: [],
      issues: [createIssue(
        'invalid_provider_response',
        'A selected album contains a track without a stable ID.',
        { albumId: invalidAlbum.album.id },
      )],
    }
  }

  const assembled = assembleDiscographyTracks(selected.albums, input.plan.artist.name)
  if (!assembled.tracks.length) {
    return {
      tracks: [],
      deduplications: [],
      issues: [createIssue('empty_catalog', 'The selected albums contain no valid tracks.')],
    }
  }

  return {
    tracks: assembled.tracks,
    deduplications: assembled.deduplications,
    issues: [],
  }
}

const applyToExistingPlaylist = async(
  listId: string,
  tracks: LX.Music.MusicInfoOnline[],
  playlist: PlaylistPort,
): Promise<DiscographyApplyResult> => {
  if (!listId.trim()) {
    return failedResult([
      createIssue('invalid_playlist_target', 'A valid local playlist ID is required.'),
    ], tracks.length)
  }
  try {
    await playlist.add(listId, tracks)
  } catch {
    return failedResult([
      createIssue(
        'playlist_add_failed',
        'The tracks could not be added to the existing playlist.',
        { retryable: true },
      ),
    ], tracks.length, listId)
  }
  return {
    status: 'applied',
    listId,
    residualListId: null,
    plannedTrackCount: tracks.length,
    submittedTrackCount: tracks.length,
    issues: [],
  }
}

const applyToNewPlaylist = async(
  name: string,
  tracks: LX.Music.MusicInfoOnline[],
  options: ApplyOptions,
): Promise<DiscographyApplyResult> => {
  if (!name.trim()) {
    return failedResult([
      createIssue('invalid_playlist_target', 'A local playlist name is required.'),
    ], tracks.length)
  }

  let listId: string
  try {
    listId = options.createPlaylistId()
  } catch {
    return failedResult([
      createIssue('playlist_create_failed', 'A local playlist ID could not be created.'),
    ], tracks.length)
  }
  if (typeof listId != 'string' || !listId.trim()) {
    return failedResult([
      createIssue('playlist_create_failed', 'A local playlist ID could not be created.'),
    ], tracks.length)
  }

  try {
    await options.playlist.create(listId, name.trim())
  } catch {
    return failedResult([
      createIssue(
        'playlist_create_failed',
        'The local playlist could not be created.',
        { retryable: true },
      ),
    ], tracks.length)
  }

  try {
    await options.playlist.add(listId, tracks)
  } catch {
    const issues = [createIssue(
      'playlist_add_failed',
      'The tracks could not be added to the new playlist.',
      { retryable: true },
    )]
    try {
      await options.playlist.remove(listId)
      return failedResult(issues, tracks.length)
    } catch {
      issues.push(createIssue(
        'playlist_rollback_failed',
        'The empty playlist could not be removed automatically.',
        { retryable: true },
      ))
      return failedResult(issues, tracks.length, listId, listId)
    }
  }

  return {
    status: 'applied',
    listId,
    residualListId: null,
    plannedTrackCount: tracks.length,
    submittedTrackCount: tracks.length,
    issues: [],
  }
}

export const applyArtistDiscography = async(
  input: DiscographyApplyInput,
  options: ApplyOptions,
): Promise<DiscographyApplyResult> => {
  const prepared = prepareArtistDiscographyApply(input)
  if (prepared.issues.length) return failedResult(prepared.issues)

  if (input.target.type == 'existing') {
    return applyToExistingPlaylist(input.target.listId, prepared.tracks, options.playlist)
  }
  return applyToNewPlaylist(input.target.name, prepared.tracks, options)
}
