import { normalizeReleaseDate } from '@common/utils/downloadTarget'
import { formatPlayTime, sizeFormate } from '@common/utils/common'
import { toNewMusicInfo } from '@common/utils/tools'
import type {
  AlbumRef,
  ArtistDiscographySource,
  ArtistRef,
  DiscographyIssue,
} from '@renderer/core/artistDiscography/types'

type UnknownRecord = Record<string, unknown>

const TX_SOURCE = 'tx' as ArtistDiscographySource

export interface TxMappedPage<T> {
  items: T[]
  reportedTotal: number | null
  rawItemCount: number
  pageKeys: string[]
  validResponse: boolean
  issues: DiscographyIssue[]
}

export type TxArtistSearchResponseResult =
  | { kind: 'ok', artists: ArtistRef[] }
  | { kind: 'invalid' }

const isRecord = (value: unknown): value is UnknownRecord => {
  return value != null && typeof value == 'object' && !Array.isArray(value)
}

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value != 'string') return null
  const normalized = value.trim()
  return normalized.length ? normalized : null
}

const normalizeInteger = (value: unknown): number | null => {
  if (typeof value == 'number') {
    return Number.isSafeInteger(value) ? value : null
  }
  if (typeof value != 'string' || !/^-?\d+$/.test(value.trim())) return null
  const normalized = Number(value)
  return Number.isSafeInteger(normalized) ? normalized : null
}

const normalizeNonNegativeInteger = (value: unknown): number | null => {
  const normalized = normalizeInteger(value)
  return normalized != null && normalized >= 0 ? normalized : null
}

const normalizePositiveInteger = (value: unknown): number | null => {
  const normalized = normalizeInteger(value)
  return normalized != null && normalized > 0 ? normalized : null
}

const createIssue = (
  code: DiscographyIssue['code'],
  stage: DiscographyIssue['stage'],
  message: string,
  details: Partial<Omit<DiscographyIssue, 'code' | 'stage' | 'message' | 'severity'>> = {},
): DiscographyIssue => ({
  code,
  stage,
  message,
  severity: 'error',
  ...details,
})

const readSuccessCode = (value: unknown) => normalizeInteger(value) == 0

const readMusicuData = (raw: unknown): UnknownRecord | null => {
  if (!isRecord(raw) || !readSuccessCode(raw.code)) return null
  const request = isRecord(raw.req) ? raw.req : null
  if (!request || !readSuccessCode(request.code) || !isRecord(request.data)) return null
  return request.data
}

const normalizeArtistImage = (value: unknown): string | null => nonEmptyString(value)

const albumImage = (albumMid: string) => {
  return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
}

const normalizeFileSize = (value: unknown): number => {
  if (typeof value == 'number') return Number.isFinite(value) && value > 0 ? value : 0
  if (typeof value != 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return 0
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized > 0 ? normalized : 0
}

const mapSingerNames = (value: unknown): string => {
  if (!Array.isArray(value)) return ''
  return value
    .map(item => isRecord(item) ? nonEmptyString(item.name) : null)
    .filter((name): name is string => name != null)
    .join('、')
}

const mapQuality = (
  types: Array<{ type: LX.Quality, size: string }>,
  qualitys: Partial<Record<LX.Quality, { size: string }>>,
  type: LX.Quality,
  rawSize: unknown,
) => {
  const size = normalizeFileSize(rawSize)
  if (!size) return
  const formattedSize = sizeFormate(size)
  types.push({ type, size: formattedSize })
  qualitys[type] = { size: formattedSize }
}

const mapTxTrack = (
  songInfo: UnknownRecord,
  albumMid: string,
  reportedTotal: number | null,
) => {
  const file = isRecord(songInfo.file) ? songInfo.file : null
  const album = isRecord(songInfo.album) ? songInfo.album : null
  const songMid = nonEmptyString(songInfo.mid)
  const songName = nonEmptyString(songInfo.title)
  const singer = mapSingerNames(songInfo.singer)
  const mediaMid = nonEmptyString(file?.media_mid)
  const songId = typeof songInfo.id == 'number' || typeof songInfo.id == 'string'
    ? songInfo.id
    : null
  if (!file || !album || !songMid || !songName || !singer || !mediaMid || songId == null) return null

  const types: Array<{ type: LX.Quality, size: string }> = []
  const qualitys: Partial<Record<LX.Quality, { size: string }>> = {}
  mapQuality(types, qualitys, '128k', file.size_128mp3)
  mapQuality(types, qualitys, '320k', file.size_320mp3)
  mapQuality(types, qualitys, 'flac', file.size_flac)
  mapQuality(types, qualitys, 'flac24bit', file.size_hires)

  const oldMusicInfo = {
    source: 'tx',
    singer,
    name: songName,
    albumName: typeof album.name == 'string' ? album.name : '',
    albumId: albumMid,
    albumMid,
    interval: typeof songInfo.interval == 'number' ? formatPlayTime(songInfo.interval) : null,
    songId,
    songmid: songMid,
    strMediaMid: mediaMid,
    img: albumImage(albumMid),
    types,
    _types: qualitys,
    typeUrl: {},
    trackNumber: normalizePositiveInteger(songInfo.index_album) ?? undefined,
    trackTotal: reportedTotal ?? undefined,
  }
  return toNewMusicInfo(oldMusicInfo)
}

export const normalizeTxArtistName = (name: string): string => name
  .normalize('NFKC')
  .trim()
  .toLowerCase()

export const mapTxArtistSearchResponse = (raw: unknown): TxArtistSearchResponseResult => {
  if (!isRecord(raw) || !readSuccessCode(raw.code)) return { kind: 'invalid' }
  const data = isRecord(raw.data) ? raw.data : null
  const singer = data && isRecord(data.singer) ? data.singer : null
  if (!singer || !Array.isArray(singer.list)) return { kind: 'invalid' }

  const artists: ArtistRef[] = []
  const seenIds = new Set<string>()
  for (const rawArtist of singer.list) {
    if (!isRecord(rawArtist)) continue
    const id = nonEmptyString(rawArtist.singerMID)
    const name = nonEmptyString(rawArtist.singerName)
    if (!id || !name || seenIds.has(id)) continue
    seenIds.add(id)
    artists.push({
      source: TX_SOURCE,
      id,
      name,
      avatar: normalizeArtistImage(rawArtist.singerPic),
      albumCount: normalizeNonNegativeInteger(rawArtist.albumNum),
    })
  }

  if (singer.list.length && !artists.length) return { kind: 'invalid' }
  return { kind: 'ok', artists }
}

export const mapTxAlbumPage = (
  raw: unknown,
  artistId: string,
  artistName: string,
): TxMappedPage<AlbumRef> => {
  const data = readMusicuData(raw)
  const issues: DiscographyIssue[] = []
  if (!data || !Array.isArray(data.albumList)) {
    return {
      items: [],
      reportedTotal: null,
      rawItemCount: 0,
      pageKeys: [],
      validResponse: false,
      issues: [createIssue(
        'invalid_provider_response',
        'albums',
        'QQ Music returned an invalid artist album page.',
        { artistId, retryable: true },
      )],
    }
  }

  const reportedTotal = normalizeNonNegativeInteger(data.total)
  if (reportedTotal == null) {
    issues.push(createIssue(
      'invalid_provider_response',
      'albums',
      'QQ Music returned an invalid album total.',
      { artistId, retryable: true },
    ))
  }

  const items: AlbumRef[] = []
  const pageKeys: string[] = []
  for (const [index, rawAlbum] of data.albumList.entries()) {
    if (!isRecord(rawAlbum)) {
      pageKeys.push(`invalid:${index}`)
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'QQ Music returned a non-object album entry.',
        { artistId, retryable: true },
      ))
      continue
    }

    const id = nonEmptyString(rawAlbum.albumMid)
    pageKeys.push(id ?? `invalid:${index}`)
    const name = nonEmptyString(rawAlbum.albumName)
    const author = nonEmptyString(rawAlbum.singerName) ?? nonEmptyString(artistName)
    if (!id || !name || !author) {
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'A QQ Music album entry is missing its stable MID, name, or artist.',
        { artistId, albumId: id ?? undefined, retryable: true },
      ))
      continue
    }

    const expectedTrackCount = normalizeNonNegativeInteger(rawAlbum.totalNum)
    if (expectedTrackCount == null) {
      issues.push(createIssue(
        'invalid_provider_response',
        'albums',
        'A QQ Music album entry has no valid declared track count.',
        { artistId, albumId: id, retryable: true },
      ))
    }

    items.push({
      source: TX_SOURCE,
      id,
      name,
      artist: author,
      releaseDate: normalizeReleaseDate(nonEmptyString(rawAlbum.publishDate)),
      image: albumImage(id),
      expectedTrackCount,
    })
  }

  return {
    items,
    reportedTotal,
    rawItemCount: data.albumList.length,
    pageKeys,
    validResponse: true,
    issues,
  }
}

const isValidTxMusicInfo = (
  musicInfo: LX.Music.MusicInfo,
  albumMid: string,
): musicInfo is LX.Music.MusicInfoOnline => {
  if (
    musicInfo.source != 'tx' ||
    !nonEmptyString(musicInfo.id) ||
    !nonEmptyString(musicInfo.name) ||
    !nonEmptyString(musicInfo.singer) ||
    !musicInfo.meta ||
    (typeof musicInfo.meta.songId != 'string' && typeof musicInfo.meta.songId != 'number') ||
    !String(musicInfo.meta.songId).trim() ||
    nonEmptyString(musicInfo.meta.albumId) != albumMid ||
    nonEmptyString(musicInfo.meta.albumMid) != albumMid ||
    nonEmptyString(musicInfo.meta.strMediaMid) == null ||
    (typeof musicInfo.meta.id != 'string' && typeof musicInfo.meta.id != 'number') ||
    !String(musicInfo.meta.id).trim() ||
    !Array.isArray(musicInfo.meta.qualitys) ||
    !isRecord(musicInfo.meta._qualitys)
  ) return false
  return true
}

export const mapTxAlbumTrackPage = (
  raw: unknown,
  albumMid: string,
): TxMappedPage<LX.Music.MusicInfoOnline> => {
  const data = readMusicuData(raw)
  const issues: DiscographyIssue[] = []
  if (!data || !Array.isArray(data.songList)) {
    return {
      items: [],
      reportedTotal: null,
      rawItemCount: 0,
      pageKeys: [],
      validResponse: false,
      issues: [createIssue(
        'invalid_provider_response',
        'album_tracks',
        'QQ Music returned an invalid album detail page.',
        { albumId: albumMid, retryable: true },
      )],
    }
  }

  const reportedTotal = normalizeNonNegativeInteger(data.totalNum)
  if (reportedTotal == null) {
    issues.push(createIssue(
      'invalid_provider_response',
      'album_tracks',
      'QQ Music returned an invalid album track total.',
      { albumId: albumMid, retryable: true },
    ))
  }

  const items: LX.Music.MusicInfoOnline[] = []
  const pageKeys: string[] = []
  for (const [index, rawTrack] of data.songList.entries()) {
    const songInfo = isRecord(rawTrack) && isRecord(rawTrack.songInfo)
      ? rawTrack.songInfo
      : null
    const rawSongMid = songInfo ? nonEmptyString(songInfo.mid) : null
    pageKeys.push(rawSongMid ?? `invalid:${index}`)
    if (!songInfo || !rawSongMid) {
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'A QQ Music album track is missing its stable song MID.',
        { albumId: albumMid, retryable: true },
      ))
      continue
    }

    const rawAlbum = isRecord(songInfo.album) ? songInfo.album : null
    if (nonEmptyString(rawAlbum?.mid) != albumMid) {
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'A QQ Music album track belongs to a different album MID.',
        { albumId: albumMid, trackId: rawSongMid, retryable: true },
      ))
      continue
    }

    try {
      const musicInfo = mapTxTrack(songInfo, albumMid, reportedTotal)
      if (!musicInfo) throw new Error('invalid raw track')
      if (!isValidTxMusicInfo(musicInfo, albumMid)) throw new Error('invalid music info')
      items.push(musicInfo)
    } catch {
      issues.push(createIssue(
        'invalid_provider_response',
        'album_tracks',
        'A QQ Music album track could not be converted to MusicInfoOnline.',
        { albumId: albumMid, trackId: rawSongMid, retryable: true },
      ))
    }
  }

  return {
    items,
    reportedTotal,
    rawItemCount: data.songList.length,
    pageKeys,
    validResponse: true,
    issues,
  }
}
