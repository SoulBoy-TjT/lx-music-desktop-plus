import { formatPlayTime, sizeFormate } from '@common/utils/common'
import { normalizeReleaseDate } from '@common/utils/downloadTarget'
import { toNewMusicInfo } from '@common/utils/tools'
import type {
  AlbumRef,
  ArtistRef,
  CatalogCollection,
  DiscographyIssue,
} from '@renderer/core/artistDiscography/types'

type UnknownRecord = Record<string, unknown>
type AlbumTrackSchema = 'legacy' | 'v1'

export type WyArtistSearchResponseResult =
  | { kind: 'ok', artists: ArtistRef[] }
  | { kind: 'invalid' }

export type WyArtistResponseResult =
  | { kind: 'ok', artist: ArtistRef }
  | { kind: 'invalid' }

export type WyArtistNameMatchType = 'exact' | 'alias_exact'

export interface WyMappedAlbumPage {
  items: AlbumRef[]
  reportedTotal: number | null
  rawItemCount: number
  pageKeys: string[]
  more: boolean
  validResponse: boolean
  issues: DiscographyIssue[]
}

const isRecord = (value: unknown): value is UnknownRecord => {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value != 'string') return null
  const normalized = value.trim()
  return normalized.length ? normalized : null
}

const normalizePositiveId = (value: unknown): string | null => {
  if (typeof value == 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value != 'string') return null
  const normalized = value.trim()
  return /^\d+$/.test(normalized) && BigInt(normalized) > 0n ? normalized : null
}

const normalizeNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value == 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value != 'string' || !/^\d+$/.test(value.trim())) return null
  const normalized = Number(value)
  return Number.isSafeInteger(normalized) ? normalized : null
}

const normalizeReleaseTimestamp = (value: unknown): string | null => {
  const timestamp = typeof value == 'number'
    ? value
    : typeof value == 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : Number.NaN
  if (!Number.isFinite(timestamp) || timestamp < 0) return null
  try {
    return normalizeReleaseDate(new Date(timestamp).toISOString().slice(0, 10))
  } catch {
    return null
  }
}

const createIssue = (
  code: DiscographyIssue['code'],
  stage: DiscographyIssue['stage'],
  message: string,
  details: Partial<Omit<DiscographyIssue, 'code' | 'stage' | 'message' | 'severity' | 'source'>> & {
    severity?: DiscographyIssue['severity']
  } = {},
): DiscographyIssue => ({
  code,
  stage,
  message,
  severity: details.severity ?? 'error',
  source: 'wy',
  ...details,
})

const readCode = (raw: UnknownRecord) => {
  const code = raw.code
  if (typeof code == 'number' && Number.isSafeInteger(code)) return code
  if (typeof code == 'string' && /^-?\d+$/.test(code.trim())) return Number(code)
  return null
}

const mapArtist = (raw: unknown): ArtistRef | null => {
  if (!isRecord(raw)) return null
  const id = normalizePositiveId(raw.id)
  const name = nonEmptyString(raw.name)
  if (!id || !name) return null
  return {
    source: 'wy',
    id,
    name,
    avatar: nonEmptyString(raw.picUrl) ?? nonEmptyString(raw.img1v1Url),
    albumCount: normalizeNonNegativeInteger(raw.albumSize),
  }
}

export const normalizeWyArtistName = (name: string): string => name
  .normalize('NFKC')
  .trim()
  .replace(/\s+/gu, ' ')
  .toLowerCase()

interface WyArtistNameSegments {
  han: string
  latin: string
}

const splitWyHanLatinArtistName = (name: string): WyArtistNameSegments | null => {
  const hanThenLatin = /^(\p{Script=Han}+)\s*(\p{Script=Latin}+(?:\s+\p{Script=Latin}+)*)$/u.exec(name)
  const latinThenHan = /^(\p{Script=Latin}+(?:\s+\p{Script=Latin}+)*)\s*(\p{Script=Han}+)$/u.exec(name)
  const han = hanThenLatin?.[1] ?? latinThenHan?.[2]
  const latin = hanThenLatin?.[2] ?? latinThenHan?.[1]
  if (!han || !latin || Array.from(latin.matchAll(/\p{Script=Latin}/gu)).length < 2) return null
  return { han, latin }
}

export const classifyWyArtistNameMatch = (
  inputName: string,
  providerName: string,
): WyArtistNameMatchType | null => {
  const input = normalizeWyArtistName(inputName)
  const provider = normalizeWyArtistName(providerName)
  if (!input || !provider) return null
  if (input == provider) return 'exact'

  const inputSegments = splitWyHanLatinArtistName(input)
  const providerSegments = splitWyHanLatinArtistName(provider)
  if (!inputSegments && providerSegments && (input == providerSegments.han || input == providerSegments.latin)) {
    return 'alias_exact'
  }
  if (!providerSegments && inputSegments && (provider == inputSegments.han || provider == inputSegments.latin)) {
    return 'alias_exact'
  }
  return null
}

export const mapWyArtistSearchResponse = (raw: unknown): WyArtistSearchResponseResult => {
  if (!isRecord(raw) || readCode(raw) != 200 || !isRecord(raw.result) || !Array.isArray(raw.result.artists)) {
    return { kind: 'invalid' }
  }

  const artists: ArtistRef[] = []
  const seenIds = new Set<string>()
  for (const rawArtist of raw.result.artists) {
    const artist = mapArtist(rawArtist)
    if (!artist || seenIds.has(artist.id)) continue
    seenIds.add(artist.id)
    artists.push(artist)
  }
  if (raw.result.artists.length && !artists.length) return { kind: 'invalid' }
  return { kind: 'ok', artists }
}

export const mapWyArtistResponse = (raw: unknown): WyArtistResponseResult => {
  if (!isRecord(raw) || readCode(raw) != 200) return { kind: 'invalid' }
  const artist = mapArtist(raw.artist)
  return artist ? { kind: 'ok', artist } : { kind: 'invalid' }
}

const invalidAlbumPage = (
  artistId: string,
  message: string,
): WyMappedAlbumPage => ({
  items: [],
  reportedTotal: null,
  rawItemCount: 0,
  pageKeys: [],
  more: false,
  validResponse: false,
  issues: [createIssue(
    'invalid_provider_response',
    'albums',
    message,
    { artistId, retryable: true },
  )],
})

export const mapWyAlbumPage = (
  raw: unknown,
  artistId: string,
  artistName: string,
): WyMappedAlbumPage => {
  if (
    !isRecord(raw) ||
    readCode(raw) != 200 ||
    !Array.isArray(raw.hotAlbums) ||
    typeof raw.more != 'boolean'
  ) return invalidAlbumPage(artistId, 'NetEase returned an invalid artist album page.')

  const issues: DiscographyIssue[] = []
  const providerArtist = isRecord(raw.artist) ? raw.artist : null
  const hasReportedTotal = providerArtist != null && Object.prototype.hasOwnProperty.call(providerArtist, 'albumSize')
  const reportedTotal = providerArtist == null
    ? null
    : normalizeNonNegativeInteger(providerArtist.albumSize)
  if (hasReportedTotal && reportedTotal == null) {
    issues.push(createIssue(
      'invalid_provider_response',
      'albums',
      'NetEase returned an invalid artist album total.',
      { artistId, retryable: true },
    ))
  }

  const items: AlbumRef[] = []
  const pageKeys: string[] = []
  for (const rawAlbum of raw.hotAlbums) {
    if (!isRecord(rawAlbum)) {
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'NetEase returned a non-object album entry.',
        { artistId, retryable: true },
      ))
      continue
    }
    const id = normalizePositiveId(rawAlbum.id)
    const name = nonEmptyString(rawAlbum.name)
    const albumArtist = isRecord(rawAlbum.artist)
      ? nonEmptyString(rawAlbum.artist.name)
      : null
    const expectedTrackCount = normalizeNonNegativeInteger(rawAlbum.size)
    if (!id || !name || expectedTrackCount == null) {
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'A NetEase album entry is missing its stable ID, name, or declared track count.',
        { artistId, albumId: id ?? undefined, retryable: true },
      ))
      continue
    }

    pageKeys.push(id)
    items.push({
      source: 'wy',
      id,
      name,
      artist: albumArtist ?? artistName,
      releaseDate: normalizeReleaseTimestamp(rawAlbum.publishTime),
      image: nonEmptyString(rawAlbum.picUrl),
      expectedTrackCount,
    })
  }

  return {
    items,
    reportedTotal,
    rawItemCount: raw.hotAlbums.length,
    pageKeys,
    more: raw.more,
    validResponse: true,
    issues,
  }
}

const getTrackArtists = (raw: UnknownRecord, schema: AlbumTrackSchema): string | null => {
  const rawArtists = schema == 'v1' ? raw.ar : raw.artists
  if (!Array.isArray(rawArtists) || !rawArtists.length) return null
  const artists: string[] = []
  for (const artist of rawArtists) {
    const name = isRecord(artist) ? nonEmptyString(artist.name) : null
    if (!name) return null
    artists.push(name)
  }
  return artists.length ? artists.join('、') : null
}

const addQuality = (
  types: Array<{ type: LX.Quality, size: string | null }>,
  qualitys: LX.Music._MusicQualityType,
  type: LX.Quality,
  raw: unknown,
) => {
  if (!isRecord(raw)) return
  const sizeValue = typeof raw.size == 'number' && Number.isFinite(raw.size) && raw.size > 0
    ? sizeFormate(raw.size)
    : null
  types.push({ type, size: sizeValue })
  qualitys[type] = { size: sizeValue }
}

const mapTrack = (
  raw: unknown,
  albumId: string,
  albumName: string,
  albumImage: string | null,
  trackTotal: number,
  schema: AlbumTrackSchema,
  responseIndex: number,
): LX.Music.MusicInfoOnline | null => {
  if (!isRecord(raw)) return null
  const rawAlbum = schema == 'v1' ? raw.al : raw.album
  if (!isRecord(rawAlbum)) return null
  const songId = normalizePositiveId(raw.id)
  const name = nonEmptyString(raw.name)
  const singer = getTrackArtists(raw, schema)
  const itemAlbumId = normalizePositiveId(rawAlbum.id)
  const itemAlbumName = nonEmptyString(rawAlbum.name)
  const rawDuration = schema == 'v1' ? raw.dt : raw.duration
  const duration = typeof rawDuration == 'number' && Number.isFinite(rawDuration) && rawDuration >= 0
    ? rawDuration
    : null
  const providerTrackNumber = normalizeNonNegativeInteger(raw.no)
  const trackNumber = raw.no == null || providerTrackNumber == 0
    ? responseIndex + 1
    : providerTrackNumber
  if (
    !songId ||
    !name ||
    !singer ||
    itemAlbumId != albumId ||
    !itemAlbumName ||
    duration == null ||
    trackNumber == null ||
    trackNumber < 1
  ) return null

  const types: Array<{ type: LX.Quality, size: string | null }> = []
  const qualitys: LX.Music._MusicQualityType = {}
  addQuality(types, qualitys, '128k', schema == 'v1' ? raw.l : raw.lMusic)
  addQuality(types, qualitys, '320k', schema == 'v1' ? raw.h : raw.hMusic)
  addQuality(types, qualitys, 'flac', schema == 'v1' ? raw.sq : raw.sqMusic)
  addQuality(types, qualitys, 'flac24bit', schema == 'v1' ? raw.hr : raw.hrMusic)

  try {
    const musicInfo = toNewMusicInfo({
      singer,
      name,
      albumName: itemAlbumName || albumName,
      albumId,
      songmid: typeof raw.id == 'number' ? raw.id : songId,
      source: 'wy',
      interval: formatPlayTime(duration / 1000),
      img: nonEmptyString(rawAlbum.picUrl) ?? albumImage,
      types,
      _types: qualitys,
      typeUrl: {},
      trackNumber,
      trackTotal,
    })
    if (
      musicInfo.source != 'wy' ||
      !musicInfo.id ||
      musicInfo.meta.albumId == null ||
      String(musicInfo.meta.albumId) != albumId ||
      musicInfo.meta.trackNumber != trackNumber ||
      !Array.isArray(musicInfo.meta.qualitys) ||
      !musicInfo.meta._qualitys ||
      typeof musicInfo.meta._qualitys != 'object'
    ) return null
    return musicInfo
  } catch {
    return null
  }
}

export const mapWyAlbumDetailResponse = (
  raw: unknown,
  albumId: string,
  expectedSchema: 'auto' | 'v1' = 'auto',
): CatalogCollection<LX.Music.MusicInfoOnline> => {
  const schema: AlbumTrackSchema = expectedSchema == 'v1'
    ? 'v1'
    : isRecord(raw) && Array.isArray(raw.songs) ? 'v1' : 'legacy'
  const rawSongs = isRecord(raw) && isRecord(raw.album)
    ? schema == 'v1' ? raw.songs : raw.album.songs
    : null
  if (
    !isRecord(raw) ||
    readCode(raw) != 200 ||
    !isRecord(raw.album) ||
    !Array.isArray(rawSongs) ||
    normalizePositiveId(raw.album.id) != albumId
  ) {
    return {
      items: [],
      reportedTotal: null,
      complete: false,
      issues: [createIssue(
        'invalid_provider_response',
        'album_tracks',
        'NetEase returned an invalid album detail response.',
        { albumId, retryable: true },
      )],
    }
  }

  const issues: DiscographyIssue[] = []
  const reportedTotal = normalizeNonNegativeInteger(raw.album.size)
  const albumName = nonEmptyString(raw.album.name)
  const albumImage = nonEmptyString(raw.album.picUrl)
  let complete = reportedTotal != null && albumName != null
  if (reportedTotal == null || !albumName) {
    issues.push(createIssue(
      'invalid_provider_response',
      'album_tracks',
      'NetEase returned invalid album detail metadata.',
      { albumId, retryable: true },
    ))
  }

  const items: LX.Music.MusicInfoOnline[] = []
  const trackIds = new Set<string>()
  for (const [responseIndex, rawTrack] of rawSongs.entries()) {
    const providerTrackId = isRecord(rawTrack) ? normalizePositiveId(rawTrack.id) : null
    const track = albumName && reportedTotal != null
      ? mapTrack(rawTrack, albumId, albumName, albumImage, reportedTotal, schema, responseIndex)
      : null
    if (!track) {
      complete = false
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'A NetEase album track is missing required music fields or belongs to another album.',
        { albumId, trackId: providerTrackId ?? undefined, retryable: true },
      ))
      continue
    }
    if (trackIds.has(track.id)) {
      complete = false
      issues.push(createIssue(
        'duplicate_track',
        'album_tracks',
        'NetEase returned the same stable track ID more than once.',
        { albumId, trackId: track.id },
      ))
      continue
    }
    trackIds.add(track.id)
    items.push(track)
  }

  if (reportedTotal != null && items.length != reportedTotal) {
    complete = false
    issues.push(createIssue(
      'album_incomplete',
      'album_tracks',
      'The NetEase album detail count does not match its unique valid track count.',
      { albumId, expected: reportedTotal, actual: items.length, retryable: true },
    ))
  }

  return { items, reportedTotal, complete, issues }
}
