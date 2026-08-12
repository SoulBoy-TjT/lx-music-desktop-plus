import path from 'node:path'
import { MAX_DOWNLOAD_FILE_STEM_LENGTH } from '@common/downloadArtifactPaths'

const WINDOWS_RESERVED_NAME_RXP = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const INVALID_PATH_CHARACTERS = '<>:"/\\|?*'
const MAX_SEGMENT_LENGTH = 100
const MAX_TARGET_PATH_LENGTH = 240
const MIN_FILE_STEM_LENGTH = 32
const FILE_NAME_SEPARATOR = ' - '

export interface ResolveDownloadTargetInput {
  musicInfo: LX.Music.MusicInfoOnline
  ext: LX.Download.FileExt
  fileNameFormat: LX.DownloadFileNameFormat
  savePath: string
  savePathMode: LX.DownloadSavePathMode
  playlistName?: string
}

export interface DownloadTargetResult {
  fileName: string
  directory: string
  filePath: string
  fallbackReasons: LX.Download.DownloadTargetFallbackReason[]
}

interface DownloadTargetTaskLike {
  id: string
  metadata: {
    filePath: string
  }
}

export const deduplicateDownloadTargets = <T extends DownloadTargetTaskLike>(
  list: T[],
  existingList: DownloadTargetTaskLike[],
) => {
  const taskIds = new Set(existingList.map(item => item.id))
  const targetPaths = new Set(existingList
    .map(item => item.metadata.filePath.trim().toLowerCase())
    .filter(Boolean))
  let duplicateTargetCount = 0
  const tasks = list.filter(item => {
    if (taskIds.has(item.id)) return false
    const targetPath = item.metadata.filePath.trim().toLowerCase()
    if (targetPath && targetPaths.has(targetPath)) {
      duplicateTargetCount++
      return false
    }
    taskIds.add(item.id)
    if (targetPath) targetPaths.add(targetPath)
    return true
  })
  return { tasks, duplicateTargetCount }
}

const hashText = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 6)
}

const sliceWithoutSplittingSurrogatePair = (value: string, maxLength: number): string => {
  let end = Math.max(0, Math.min(value.length, maxLength))
  const previousCodeUnit = value.charCodeAt(end - 1)
  const nextCodeUnit = value.charCodeAt(end)
  if (end > 0 && end < value.length &&
    previousCodeUnit >= 0xD800 && previousCodeUnit <= 0xDBFF &&
    nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) end--
  return value.slice(0, end)
}

const truncateWithHash = (value: string, maxLength: number) => {
  if (value.length <= maxLength) return value
  if (maxLength <= 0) return ''
  const hash = hashText(value)
  if (maxLength <= hash.length) return hash.slice(0, maxLength)
  const suffix = `~${hash}`
  return sliceWithoutSplittingSurrogatePair(value, maxLength - suffix.length) + suffix
}

interface DownloadFileNamePlan {
  prefix: string
  fields: string[]
}

const renderFileNamePlan = (plan: DownloadFileNamePlan): string => (
  `${plan.prefix}${plan.fields.join(FILE_NAME_SEPARATOR)}`
)

const truncateReadableField = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value
  const suffix = `...~${hashText(value)}`
  if (maxLength > suffix.length) return sliceWithoutSplittingSurrogatePair(value, maxLength - suffix.length) + suffix
  return truncateWithHash(value, maxLength)
}

const fitFileNamePlan = (plan: DownloadFileNamePlan, maxLength: number): string => {
  const original = renderFileNamePlan(plan)
  if (original.length <= maxLength) return original

  const separatorLength = FILE_NAME_SEPARATOR.length * Math.max(0, plan.fields.length - 1)
  const availableFieldLength = maxLength - plan.prefix.length - separatorLength
  if (availableFieldLength < plan.fields.length) return truncateReadableField(original, maxLength)
  if (plan.fields.length == 1) {
    return `${plan.prefix}${truncateReadableField(plan.fields[0], availableFieldLength)}`
  }

  let firstLength = Math.floor(availableFieldLength / 2)
  let secondLength = availableFieldLength - firstLength
  if (plan.fields[0].length < firstLength) {
    secondLength += firstLength - plan.fields[0].length
    firstLength = plan.fields[0].length
  }
  if (plan.fields[1].length < secondLength) {
    firstLength += secondLength - plan.fields[1].length
    secondLength = plan.fields[1].length
  }
  return `${plan.prefix}${truncateReadableField(plan.fields[0], firstLength)}` +
    `${FILE_NAME_SEPARATOR}${truncateReadableField(plan.fields[1], secondLength)}`
}

export const sanitizePathSegment = (value: unknown, maxLength = MAX_SEGMENT_LENGTH) => {
  if (typeof value != 'string') return ''
  let segment = [...value]
    .map(character => character.charCodeAt(0) < 32 || INVALID_PATH_CHARACTERS.includes(character) ? '_' : character)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!segment || segment == '.' || segment == '..') return ''
  if (WINDOWS_RESERVED_NAME_RXP.test(segment)) segment = `_${segment}`
  return truncateWithHash(segment, maxLength)
}

export const normalizeReleaseDate = (value: unknown): string | null => {
  if (typeof value != 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(value.trim())
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  if (date.getUTCFullYear() != year || date.getUTCMonth() != month - 1 || date.getUTCDate() != day) return null
  return `${match[1]}-${match[2]}-${match[3]}`
}

const addFallback = (
  fallbacks: LX.Download.DownloadTargetFallbackReason[],
  reason: LX.Download.DownloadTargetFallbackReason,
) => {
  if (!fallbacks.includes(reason)) fallbacks.push(reason)
}

const formatTrackNumber = (trackNumber: number, trackTotal?: number | null) => {
  const width = Math.max(2, String(Math.max(trackNumber, trackTotal ?? 0)).length)
  return String(trackNumber).padStart(width, '0')
}

const buildFileNamePlan = (
  input: ResolveDownloadTargetInput,
  fallbacks: LX.Download.DownloadTargetFallbackReason[],
): DownloadFileNamePlan => {
  const name = sanitizePathSegment(input.musicInfo.name, Number.POSITIVE_INFINITY) || 'music'
  const artist = sanitizePathSegment(input.musicInfo.singer, Number.POSITIVE_INFINITY)
  const artistAndName = artist ? [artist, name] : [name]
  if (!artist) addFallback(fallbacks, 'missing_track_artist')

  switch (input.fileNameFormat) {
    case '歌手 - 歌名':
      return { prefix: '', fields: artistAndName }
    case '歌名':
      return { prefix: '', fields: [name] }
    case '曲序. 艺术家 - 歌曲名': {
      const trackNumber = input.musicInfo.meta.trackNumber
      if (!Number.isSafeInteger(trackNumber) || Number(trackNumber) <= 0) {
        addFallback(fallbacks, 'missing_track_number')
        return { prefix: '', fields: artistAndName }
      }
      const trackTotal = input.musicInfo.meta.trackTotal
      return {
        prefix: `${formatTrackNumber(Number(trackNumber), trackTotal)}. `,
        fields: artistAndName,
      }
    }
    case '歌名 - 歌手':
    default:
      return { prefix: '', fields: artist ? [name, artist] : [name] }
  }
}

const buildDirectorySegments = (
  input: ResolveDownloadTargetInput,
  fallbacks: LX.Download.DownloadTargetFallbackReason[],
) => {
  if (input.savePathMode == 'root') return []
  if (input.savePathMode == 'playlist') {
    const playlistName = sanitizePathSegment(input.playlistName)
    if (!playlistName) {
      addFallback(fallbacks, 'missing_playlist_name')
      return []
    }
    return [playlistName]
  }

  const discographyArtistValue = typeof input.musicInfo.meta.discographyArtist == 'string'
    ? input.musicInfo.meta.discographyArtist.trim()
    : ''
  const albumArtistValue = typeof input.musicInfo.meta.albumArtist == 'string'
    ? input.musicInfo.meta.albumArtist.trim()
    : ''
  const trackArtistValue = typeof input.musicInfo.singer == 'string' ? input.musicInfo.singer.trim() : ''
  let artist = sanitizePathSegment(discographyArtistValue) || sanitizePathSegment(albumArtistValue)
  if (!artist) {
    addFallback(fallbacks, 'missing_album_artist')
    artist = sanitizePathSegment(trackArtistValue)
  }
  if (!artist) return []

  const albumName = sanitizePathSegment(input.musicInfo.meta.albumName)
  if (!albumName) {
    addFallback(fallbacks, 'missing_album_name')
    return [artist]
  }

  const rawReleaseDate = input.musicInfo.meta.releaseDate
  const releaseDate = normalizeReleaseDate(rawReleaseDate)
  if (!releaseDate) {
    addFallback(
      fallbacks,
      typeof rawReleaseDate == 'string' && rawReleaseDate.trim() ? 'invalid_release_date' : 'missing_release_date',
    )
  }
  return [artist, releaseDate ? `${releaseDate} ${albumName}` : albumName]
}

const fitTargetPath = (
  root: string,
  originalSegments: string[],
  fileNamePlan: DownloadFileNamePlan,
  ext: LX.Download.FileExt,
) => {
  const segments = [...originalSegments]
  const originalBaseName = renderFileNamePlan(fileNamePlan)
  let baseName = fitFileNamePlan(fileNamePlan, MAX_DOWNLOAD_FILE_STEM_LENGTH)
  const build = () => {
    const directory = path.join(root, ...segments)
    const fileName = `${baseName}.${ext}`
    return { directory, fileName, filePath: path.join(directory, fileName) }
  }

  let target = build()
  let truncated = baseName != originalBaseName
  if (target.filePath.length <= MAX_TARGET_PATH_LENGTH) return { ...target, truncated }

  let overflow = target.filePath.length - MAX_TARGET_PATH_LENGTH
  const nextBaseLength = Math.max(MIN_FILE_STEM_LENGTH, baseName.length - overflow)
  const nextBaseName = fitFileNamePlan(fileNamePlan, nextBaseLength)
  truncated ||= nextBaseName != baseName
  baseName = nextBaseName
  target = build()

  for (let index = segments.length - 1; index >= 0 && target.filePath.length > MAX_TARGET_PATH_LENGTH; index--) {
    overflow = target.filePath.length - MAX_TARGET_PATH_LENGTH
    const nextLength = Math.max(8, segments[index].length - overflow)
    const nextSegment = truncateWithHash(segments[index], nextLength)
    truncated ||= nextSegment != segments[index]
    segments[index] = nextSegment
    target = build()
  }

  return { ...target, truncated }
}

export const resolveDownloadTarget = (input: ResolveDownloadTargetInput): DownloadTargetResult => {
  if (typeof input.savePath != 'string' || !input.savePath.trim()) throw new Error('Invalid download root path.')
  const root = path.resolve(input.savePath)
  const fallbackReasons: LX.Download.DownloadTargetFallbackReason[] = []
  const fileNamePlan = buildFileNamePlan(input, fallbackReasons)
  const segments = buildDirectorySegments(input, fallbackReasons)
  const target = fitTargetPath(root, segments, fileNamePlan, input.ext)
  if (target.truncated) addFallback(fallbackReasons, 'path_truncated')

  const relativePath = path.relative(root, target.filePath)
  if (!relativePath || relativePath == '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error('Download target escaped the configured root path.')
  }

  return {
    fileName: target.fileName,
    directory: target.directory,
    filePath: target.filePath,
    fallbackReasons,
  }
}
