import { toNewMusicInfo } from '@common/utils/tools'
import { normalizeReleaseDate } from '@common/utils/downloadTarget'
import type {
  AlbumRef,
  ArtistRef,
  DiscographyIssue,
  DiscographyIssueStage,
} from '@renderer/core/artistDiscography/types'

type UnknownRecord = Record<string, unknown>

export interface KgArtistReference {
  kind: 'numeric' | 'token'
  value: string
}

export interface KgMappedPage<T> {
  items: T[]
  reportedTotal: number | null
  rawItemCount: number
  pageKeys: string[]
  validResponse: boolean
  issues: DiscographyIssue[]
}

export interface KgRawAlbumTrack {
  raw: UnknownRecord
  key: string
  albumAudioId: string | number
}

export type KgArtistResponseResult =
  | { kind: 'ok', artist: ArtistRef }
  | { kind: 'not_found' }
  | { kind: 'invalid' }

export type KgArtistSearchResponseResult =
  | { kind: 'ok', artists: ArtistRef[] }
  | { kind: 'invalid' }

const isRecord = (value: unknown): value is UnknownRecord => {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value != 'string') return null
  const result = value.trim()
  return result.length ? result : null
}

const normalizePositiveId = (value: unknown): string | null => {
  if (typeof value == 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value != 'string') return null
  const result = value.trim()
  if (!/^\d{1,20}$/.test(result) || !/[1-9]/.test(result)) return null
  return result.replace(/^0+(?=\d)/, '')
}

const normalizeNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value == 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value != 'string') return null
  const result = value.trim()
  if (!/^\d{1,16}$/.test(result)) return null
  const number = Number(result)
  return Number.isSafeInteger(number) ? number : null
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

const unwrapData = (raw: unknown): UnknownRecord | null => {
  if (!isRecord(raw)) return null
  return isRecord(raw.data) ? raw.data : raw
}

const readPage = (raw: unknown) => {
  const payload = unwrapData(raw)
  const rawItems = payload?.info
  const hasTotal = payload != null && Object.prototype.hasOwnProperty.call(payload, 'total')
  const reportedTotal = hasTotal ? normalizeNonNegativeInteger(payload.total) : null
  return {
    payload,
    rawItems: Array.isArray(rawItems) ? rawItems : null,
    reportedTotal,
    invalidTotal: hasTotal && reportedTotal == null,
  }
}

export const normalizeKgImage = (value: unknown, size: number): string | null => {
  const image = nonEmptyString(value)
  return image ? image.replace('{size}', String(size)) : null
}

export const parseKgArtistReference = (rawRef: string): KgArtistReference | null => {
  const ref = rawRef.trim()
  const numericId = normalizePositiveId(ref)
  if (numericId) return { kind: 'numeric', value: numericId }

  if (/^[a-zA-Z0-9]{1,64}$/.test(ref)) return { kind: 'token', value: ref }

  let url: URL
  try {
    url = new URL(ref)
  } catch {
    return null
  }
  if (url.protocol != 'https:' && url.protocol != 'http:') return null
  const hostname = url.hostname.toLowerCase()
  if (hostname != 'www.kugou.com' && hostname != 'm.kugou.com') return null

  const match = /^\/singer\/info\/([^/]+)\/?$/.exec(url.pathname)
  if (!match) return null
  let value: string
  try {
    value = decodeURIComponent(match[1])
  } catch {
    return null
  }
  const linkNumericId = normalizePositiveId(value)
  if (linkNumericId) return { kind: 'numeric', value: linkNumericId }
  return /^[a-zA-Z0-9]{1,64}$/.test(value)
    ? { kind: 'token', value }
    : null
}

const mapKgArtistCandidate = (raw: UnknownRecord): ArtistRef | null => {
  const data = isRecord(raw.data) ? raw.data : null
  const info = isRecord(raw.info) ? raw.info : null
  const candidate = data ?? info ?? raw
  const id = normalizePositiveId(candidate.singerid)
  const name = nonEmptyString(candidate.singername)
  if (!id || !name) return null

  return {
    source: 'kg',
    id,
    name,
    avatar: normalizeKgImage(candidate.imgurl, 480),
    albumCount: normalizeNonNegativeInteger(candidate.albumcount),
  }
}

export const normalizeKgArtistName = (name: string): string => name
  .normalize('NFKC')
  .trim()
  .toLowerCase()

export const mapKgArtistSearchResponse = (raw: unknown): KgArtistSearchResponseResult => {
  if (!isRecord(raw)) return { kind: 'invalid' }

  const status = readEnvelopeNumber(raw, 'status')
  const errcode = readEnvelopeNumber(raw, 'errcode')
  if (Number.isNaN(status) || Number.isNaN(errcode)) return { kind: 'invalid' }
  if ((status != null && status != 1) || (errcode != null && errcode != 0)) return { kind: 'invalid' }

  const data = isRecord(raw.data) ? raw.data : null
  const explicitlyEmpty = Object.prototype.hasOwnProperty.call(raw, 'data') &&
    raw.data == null &&
    status == 1 &&
    (errcode == null || errcode == 0)
  const rawArtists = Array.isArray(raw.data)
    ? raw.data
    : Array.isArray(data?.info)
      ? data.info
      : Array.isArray(raw.info)
        ? raw.info
        : explicitlyEmpty
          ? []
          : null
  if (!rawArtists) return { kind: 'invalid' }

  const artists: ArtistRef[] = []
  const seenIds = new Set<string>()
  for (const rawArtist of rawArtists) {
    if (!isRecord(rawArtist)) continue
    const artist = mapKgArtistCandidate(rawArtist)
    if (!artist || seenIds.has(artist.id)) continue
    seenIds.add(artist.id)
    artists.push(artist)
  }
  if (rawArtists.length && !artists.length) return { kind: 'invalid' }
  return { kind: 'ok', artists }
}

const readEnvelopeNumber = (raw: UnknownRecord, key: 'status' | 'errcode') => {
  if (!Object.prototype.hasOwnProperty.call(raw, key)) return null
  const value = raw[key]
  if (typeof value == 'number' && Number.isSafeInteger(value)) return value
  if (typeof value == 'string' && /^-?\d+$/.test(value.trim())) return Number(value)
  return Number.NaN
}

export const mapKgArtistResponse = (raw: unknown): KgArtistResponseResult => {
  if (!isRecord(raw)) return { kind: 'invalid' }

  const status = readEnvelopeNumber(raw, 'status')
  const errcode = readEnvelopeNumber(raw, 'errcode')
  if (Number.isNaN(status) || Number.isNaN(errcode)) return { kind: 'invalid' }
  const explicitFailure = (status != null && status != 1) || (errcode != null && errcode != 0)
  if (explicitFailure) {
    const errorMessage = nonEmptyString(raw.error)
    const isKnownMissingArtist = status == 0 &&
      (errcode == null || errcode == 0) &&
      raw.data == null &&
      raw.info == null &&
      errorMessage == '参数不合法'
    return isKnownMissingArtist
      ? { kind: 'not_found' }
      : { kind: 'invalid' }
  }
  const artist = mapKgArtistCandidate(raw)
  return artist ? { kind: 'ok', artist } : { kind: 'invalid' }
}

export const mapKgArtist = (raw: unknown): ArtistRef | null => {
  const result = mapKgArtistResponse(raw)
  return result.kind == 'ok' ? result.artist : null
}

export const mapKgAlbumPage = (
  raw: unknown,
  artistId: string,
  artistName: string,
): KgMappedPage<AlbumRef> => {
  const page = readPage(raw)
  const issues: DiscographyIssue[] = []
  if (!page.payload || !page.rawItems) {
    issues.push(createIssue(
      'invalid_provider_response',
      'albums',
      'KuGou returned an invalid artist album page.',
      { artistId, retryable: true },
    ))
    return {
      items: [],
      reportedTotal: null,
      rawItemCount: 0,
      pageKeys: [],
      validResponse: false,
      issues,
    }
  }
  if (page.invalidTotal) {
    issues.push(createIssue(
      'invalid_provider_response',
      'albums',
      'KuGou returned an invalid album total.',
      { artistId, retryable: true },
    ))
  }

  const items: AlbumRef[] = []
  const pageKeys: string[] = []
  for (const rawItem of page.rawItems) {
    if (!isRecord(rawItem)) {
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'KuGou returned a non-object album entry.',
        { artistId, retryable: true },
      ))
      continue
    }
    const id = normalizePositiveId(rawItem.albumid)
    const name = nonEmptyString(rawItem.albumname)
    const author = nonEmptyString(rawItem.singername) ?? nonEmptyString(artistName)
    if (!id || !name || !author) {
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'A KuGou album entry is missing its stable ID, name, or artist.',
        { artistId, albumId: id ?? undefined, retryable: true },
      ))
      continue
    }

    const expectedTrackCount = normalizeNonNegativeInteger(rawItem.songcount)
    if (expectedTrackCount == null) {
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'A KuGou album entry has no valid declared track count.',
        { artistId, albumId: id, retryable: true },
      ))
    }
    pageKeys.push(id)
    items.push({
      source: 'kg',
      id,
      name,
      artist: author,
      releaseDate: normalizeReleaseDate(rawItem.publishtime),
      image: normalizeKgImage(rawItem.imgurl, 480),
      expectedTrackCount,
    })
  }

  return {
    items,
    reportedTotal: page.reportedTotal,
    rawItemCount: page.rawItems.length,
    pageKeys,
    validResponse: true,
    issues,
  }
}

export const mapKgRawAlbumTrackPage = (
  raw: unknown,
  albumId: string,
): KgMappedPage<KgRawAlbumTrack> => {
  const page = readPage(raw)
  const issues: DiscographyIssue[] = []
  if (!page.payload || !page.rawItems) {
    issues.push(createIssue(
      'invalid_provider_response',
      'album_tracks',
      'KuGou returned an invalid album detail page.',
      { albumId, retryable: true },
    ))
    return {
      items: [],
      reportedTotal: null,
      rawItemCount: 0,
      pageKeys: [],
      validResponse: false,
      issues,
    }
  }
  if (page.invalidTotal) {
    issues.push(createIssue(
      'invalid_provider_response',
      'album_tracks',
      'KuGou returned an invalid album track total.',
      { albumId, retryable: true },
    ))
  }

  const items: KgRawAlbumTrack[] = []
  const pageKeys: string[] = []
  for (const rawItem of page.rawItems) {
    if (!isRecord(rawItem)) {
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'KuGou returned a non-object album track entry.',
        { albumId, retryable: true },
      ))
      continue
    }
    const hash = nonEmptyString(rawItem.hash)
    const itemAlbumId = normalizePositiveId(rawItem.album_id)
    const audioId = normalizePositiveId(rawItem.audio_id)
    const normalizedAlbumAudioId = normalizePositiveId(rawItem.album_audio_id)
    if (!hash || !normalizedAlbumAudioId || itemAlbumId != albumId) {
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'A KuGou album track is missing its hash or album audio ID, or belongs to a different album.',
        { albumId, trackId: audioId ?? undefined, retryable: true },
      ))
      continue
    }
    const key = audioId ? `${audioId}_${hash}` : hash
    pageKeys.push(key)
    items.push({
      raw: rawItem,
      key,
      albumAudioId: typeof rawItem.album_audio_id == 'number'
        ? rawItem.album_audio_id
        : normalizedAlbumAudioId,
    })
  }

  return {
    items,
    reportedTotal: page.reportedTotal,
    rawItemCount: page.rawItems.length,
    pageKeys,
    validResponse: true,
    issues,
  }
}

const isValidOldKgMusicInfo = (raw: UnknownRecord, albumId: string) => {
  const songId = typeof raw.songmid == 'number' || typeof raw.songmid == 'string'
    ? String(raw.songmid).trim()
    : ''
  return raw.source == 'kg' &&
    songId.length > 0 &&
    nonEmptyString(raw.hash) != null &&
    nonEmptyString(raw.name) != null &&
    nonEmptyString(raw.singer) != null &&
    typeof raw.albumName == 'string' &&
    normalizePositiveId(raw.albumId) == albumId &&
    Array.isArray(raw.types) &&
    isRecord(raw._types)
}

export const mapKgExpandedTracks = (
  raw: unknown,
  albumId: string,
): { items: LX.Music.MusicInfoOnline[], issues: DiscographyIssue[] } => {
  const issues: DiscographyIssue[] = []
  if (!Array.isArray(raw)) {
    return {
      items: [],
      issues: [createIssue(
        'invalid_provider_response',
        'album_tracks',
        'KuGou returned an invalid expanded track list.',
        { albumId, retryable: true },
      )],
    }
  }

  const items: LX.Music.MusicInfoOnline[] = []
  for (const rawItem of raw) {
    if (!isRecord(rawItem) || !isValidOldKgMusicInfo(rawItem, albumId)) {
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'A KuGou expanded track is missing required music fields.',
        {
          albumId,
          trackId: isRecord(rawItem) && rawItem.songmid != null ? String(rawItem.songmid) : undefined,
          retryable: true,
        },
      ))
      continue
    }

    try {
      const musicInfo = toNewMusicInfo(rawItem)
      if (musicInfo.source != 'kg') throw new Error('invalid music source')
      const meta = musicInfo.meta
      if (
        !nonEmptyString(musicInfo.id) ||
        !nonEmptyString(musicInfo.name) ||
        !nonEmptyString(musicInfo.singer) ||
        !meta ||
        (typeof meta.songId != 'string' && typeof meta.songId != 'number') ||
        String(meta.songId).trim().length == 0 ||
        normalizePositiveId(meta.albumId) != albumId ||
        !nonEmptyString(meta.hash) ||
        !Array.isArray(meta.qualitys) ||
        !isRecord(meta._qualitys)
      ) throw new Error('invalid music info')
      items.push(musicInfo)
    } catch {
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'A KuGou track could not be converted to MusicInfoOnline.',
        { albumId, trackId: String(rawItem.songmid), retryable: true },
      ))
    }
  }
  return { items, issues }
}
