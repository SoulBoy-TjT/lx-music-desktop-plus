import { formatPlayTime } from '@common/utils/common'
import { normalizeReleaseDate } from '@common/utils/downloadTarget'
import { toNewMusicInfo } from '@common/utils/tools'
import type {
  AlbumRef,
  ArtistRef,
  DiscographyIssue,
  DiscographyIssueStage,
} from '@renderer/core/artistDiscography/types'
import { decodeName } from '../../index'
import { formatSinger, objStr2JSON } from './util'

type UnknownRecord = Record<string, unknown>

export interface KwMappedPage<T> {
  items: T[]
  reportedTotal: number | null
  rawItemCount: number
  pageKeys: string[]
  validResponse: boolean
  issues: DiscographyIssue[]
  trackNumbering?: KwTrackNumbering
}

export type KwTrackNumbering = 'zero_based' | 'one_based' | 'invalid'

export type KwArtistSearchResponseResult =
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

const decodeText = (value: unknown): string | null => {
  const text = nonEmptyString(value)
  if (!text) return null
  const decoded = decodeName(text)
  return nonEmptyString(decoded)
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

const normalizePositiveInteger = (value: unknown): number | null => {
  const number = normalizeNonNegativeInteger(value)
  return number != null && number > 0 ? number : null
}

const normalizeImage = (value: unknown): string | null => {
  const image = decodeText(value)
  return image && /^(https?:)?\/\//i.test(image) ? image : null
}

const normalizeKwAlbumCoverImage = (value: unknown): string | null => {
  const image = normalizeImage(value)
  if (!image) return null

  let url: URL
  try {
    url = new URL(image.startsWith('//') ? `https:${image}` : image)
  } catch {
    return image
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname != 'kuwo.cn' && !hostname.endsWith('.kuwo.cn')) return image
  if (!/^\/star\/albumcover\/240\//i.test(url.pathname)) return image
  return image.replace(/\/star\/albumcover\/240\//i, '/star/albumcover/500/')
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

export const parseKwPseudoJson = (raw: unknown): UnknownRecord | null => {
  if (isRecord(raw)) return raw
  if (typeof raw != 'string' || !raw.trim()) return null
  try {
    const parsed = objStr2JSON(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const normalizeKwArtistName = (name: string): string => name
  .normalize('NFKC')
  .trim()
  .toLowerCase()

const mapArtistCandidate = (raw: UnknownRecord): ArtistRef | null => {
  const id = normalizePositiveId(raw.ARTISTID)
  const name = decodeText(raw.ARTIST)
  const albumCount = normalizeNonNegativeInteger(raw.ALBUMNUM)
  if (!id || !name || albumCount == null) return null

  return {
    source: 'kw',
    id,
    name,
    avatar: normalizeImage(raw.hts_PICPATH),
    albumCount,
  }
}

export const mapKwArtistSearchResponse = (raw: unknown): KwArtistSearchResponseResult => {
  const payload = parseKwPseudoJson(raw)
  if (!payload || !Array.isArray(payload.abslist)) return { kind: 'invalid' }

  const total = normalizeNonNegativeInteger(payload.TOTAL)
  if (total == null || total < payload.abslist.length || (total > 0 && payload.abslist.length == 0)) {
    return { kind: 'invalid' }
  }

  const artists: ArtistRef[] = []
  const seenIds = new Set<string>()
  for (const rawArtist of payload.abslist) {
    if (!isRecord(rawArtist)) return { kind: 'invalid' }
    const artist = mapArtistCandidate(rawArtist)
    if (!artist || seenIds.has(artist.id)) return { kind: 'invalid' }
    seenIds.add(artist.id)
    artists.push(artist)
  }
  return { kind: 'ok', artists }
}

export const mapKwAlbumPage = (
  raw: unknown,
  artistId: string,
  expectedPage: number,
): KwMappedPage<AlbumRef> => {
  const payload = parseKwPseudoJson(raw)
  const issues: DiscographyIssue[] = []
  if (!payload || !Array.isArray(payload.albumlist)) {
    return {
      items: [],
      reportedTotal: null,
      rawItemCount: 0,
      pageKeys: [],
      validResponse: false,
      issues: [createIssue(
        'invalid_provider_response',
        'albums',
        'Kuwo returned an invalid artist album page.',
        { artistId, retryable: true },
      )],
    }
  }

  const reportedTotal = normalizeNonNegativeInteger(payload.total)
  const responsePage = normalizeNonNegativeInteger(payload.pn)
  const returned = normalizeNonNegativeInteger(payload.return)
  const validEnvelope = reportedTotal != null &&
    responsePage == expectedPage &&
    returned == payload.albumlist.length
  if (!validEnvelope) {
    issues.push(createIssue(
      'invalid_provider_response',
      'albums',
      'Kuwo returned invalid album pagination metadata.',
      { artistId, retryable: true },
    ))
  }

  const items: AlbumRef[] = []
  const pageKeys: string[] = []
  for (const [index, rawAlbum] of payload.albumlist.entries()) {
    if (!isRecord(rawAlbum)) {
      pageKeys.push(`invalid:${index}`)
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'Kuwo returned a non-object album entry.',
        { artistId, retryable: true },
      ))
      continue
    }

    const id = normalizePositiveId(rawAlbum.albumid)
    pageKeys.push(id ?? `invalid:${index}`)
    const name = decodeText(rawAlbum.name)
    const rawArtist = decodeText(rawAlbum.artist)
    const artist = rawArtist ? formatSinger(rawArtist) : null
    const expectedTrackCount = normalizeNonNegativeInteger(rawAlbum.musiccnt)
    if (!id || !name || !artist || expectedTrackCount == null) {
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'A Kuwo album entry is missing its stable ID, name, artist, or track count.',
        { artistId, albumId: id ?? undefined, retryable: true },
      ))
      continue
    }

    items.push({
      source: 'kw',
      id,
      name,
      artist,
      releaseDate: normalizeReleaseDate(rawAlbum.pub),
      image: normalizeImage(rawAlbum.img) ?? normalizeImage(rawAlbum.hts_img),
      expectedTrackCount,
    })
  }

  return {
    items,
    reportedTotal,
    rawItemCount: payload.albumlist.length,
    pageKeys,
    validResponse: validEnvelope,
    issues,
  }
}

const mapFormats = (formats: string) => {
  const available = new Set(formats.split('|').map(format => format.trim()).filter(Boolean))
  const qualityMap: Array<[string, LX.Quality]> = [
    ['MP3128', '128k'],
    ['MP3H', '320k'],
    ['ALFLAC', 'flac'],
    ['HIRFLAC', 'flac24bit'],
  ]
  const types: LX.Music.MusicQualityType[] = []
  const qualitys: LX.Music._MusicQualityType = {}
  for (const [format, quality] of qualityMap) {
    if (!available.has(format)) continue
    types.push({ type: quality, size: null })
    qualitys[quality] = { size: null }
  }
  return { types, qualitys }
}

const mapAlbumTrack = (
  raw: UnknownRecord,
  albumId: string,
  albumName: string,
  albumImage: string | null,
  trackNumberOverride?: number,
): LX.Music.MusicInfoOnline | null => {
  const songId = normalizePositiveId(raw.id)
  const name = decodeText(raw.name)
  const rawArtist = decodeText(raw.artist)
  const singer = rawArtist ? formatSinger(rawArtist) : null
  const formats = nonEmptyString(raw.formats)
  const duration = normalizePositiveInteger(raw.duration)
  const trackNumber = trackNumberOverride ?? normalizePositiveInteger(raw.track)
  if (!songId || !name || !singer || !formats || duration == null || trackNumber == null) return null

  const mappedFormats = mapFormats(formats)
  try {
    const mapped = toNewMusicInfo({
      singer,
      name,
      albumName,
      albumId,
      songmid: songId,
      source: 'kw',
      interval: formatPlayTime(duration),
      img: normalizeKwAlbumCoverImage(raw.pic) ?? albumImage,
      lrc: null,
      otherSource: null,
      types: mappedFormats.types,
      _types: mappedFormats.qualitys,
      typeUrl: {},
      trackNumber,
    })
    if (
      mapped.source != 'kw' ||
      mapped.id != `kw_${songId}` ||
      !nonEmptyString(mapped.name) ||
      !nonEmptyString(mapped.singer) ||
      !mapped.meta ||
      String(mapped.meta.songId) != songId ||
      String(mapped.meta.albumId) != albumId ||
      mapped.meta.albumName != albumName ||
      mapped.meta.trackNumber != trackNumber ||
      !Array.isArray(mapped.meta.qualitys) ||
      !isRecord(mapped.meta._qualitys)
    ) return null
    return mapped
  } catch {
    return null
  }
}

export const mapKwAlbumTrackPage = (
  raw: unknown,
  albumId: string,
  rawOffset = 0,
  expectedTrackNumbering: Exclude<KwTrackNumbering, 'invalid'> | null = null,
): KwMappedPage<LX.Music.MusicInfoOnline> => {
  const payload = parseKwPseudoJson(raw)
  const issues: DiscographyIssue[] = []
  if (!payload || !Array.isArray(payload.musiclist)) {
    return {
      items: [],
      reportedTotal: null,
      rawItemCount: 0,
      pageKeys: [],
      validResponse: false,
      issues: [createIssue(
        'invalid_provider_response',
        'album_tracks',
        'Kuwo returned an invalid album detail page.',
        { albumId, retryable: true },
      )],
    }
  }

  const responseAlbumId = normalizePositiveId(payload.albumid)
  const reportedTotal = normalizeNonNegativeInteger(payload.songnum)
  const albumName = decodeText(payload.name)
  const rawArtist = decodeText(payload.artist)
  const albumArtist = rawArtist ? formatSinger(rawArtist) : null
  const validEnvelope = responseAlbumId == albumId &&
    reportedTotal != null &&
    albumName != null &&
    albumArtist != null
  if (!validEnvelope) {
    issues.push(createIssue(
      'invalid_provider_response',
      'album_tracks',
      'Kuwo returned invalid album detail metadata.',
      { albumId, retryable: true },
    ))
  }

  const items: LX.Music.MusicInfoOnline[] = []
  const pageKeys: string[] = []
  const mappedAlbumName = albumName ?? ''
  const albumImage = normalizeKwAlbumCoverImage(payload.img)
  const rawTrackNumbers = payload.musiclist.map(rawTrack =>
    isRecord(rawTrack) ? normalizeNonNegativeInteger(rawTrack.track) : null,
  )
  const hasZeroTrackNumber = rawTrackNumbers.some(trackNumber => trackNumber == 0)
  const zeroBasedCandidate = expectedTrackNumbering == 'zero_based' || hasZeroTrackNumber
  const completeZeroBasedSequence = zeroBasedCandidate && rawTrackNumbers.every(
    (trackNumber, index) => trackNumber == rawOffset + index,
  )
  const trackNumbering: KwTrackNumbering = completeZeroBasedSequence
    ? 'zero_based'
    : zeroBasedCandidate
      ? 'invalid'
      : 'one_based'
  for (const [index, rawTrack] of payload.musiclist.entries()) {
    if (!isRecord(rawTrack)) {
      pageKeys.push(`invalid:${index}`)
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'Kuwo returned a non-object album track entry.',
        { albumId, retryable: true },
      ))
      continue
    }
    const rawTrackId = normalizePositiveId(rawTrack.id)
    pageKeys.push(rawTrackId ?? `invalid:${index}`)
    const track = validEnvelope && trackNumbering != 'invalid'
      ? mapAlbumTrack(
        rawTrack,
        albumId,
        mappedAlbumName,
        albumImage,
        completeZeroBasedSequence ? rawOffset + index + 1 : undefined,
      )
      : null
    if (!track) {
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'A Kuwo album track is missing required music fields or could not be converted.',
        { albumId, trackId: rawTrackId ?? undefined, retryable: true },
      ))
      continue
    }
    items.push(track)
  }

  return {
    items,
    reportedTotal,
    rawItemCount: payload.musiclist.length,
    pageKeys,
    validResponse: validEnvelope,
    issues,
    trackNumbering,
  }
}
