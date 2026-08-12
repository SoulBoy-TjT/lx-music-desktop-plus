import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  AudioCheckStatus,
  AudioValidationResult,
  SongOrganizerAnomaly,
  SongOrganizerArtistRenamePlan,
  SongOrganizerArtistSummary,
  SongOrganizerAudioFingerprint,
  SongOrganizerFolderSummary,
  SongOrganizerScanProgress,
  SongOrganizerSnapshot,
} from '@common/songOrganizer'
import type { AudioValidator } from './audioValidator'
import { assertSafeRoot } from './pathSafety'
import { buildAlbumDirectoryName, buildArtistDirectoryName, stripAlbumCountSuffix, stripArtistCountSuffix } from './naming'
import { createSongOrganizerFileIdentity, getSongOrganizerMtimeMs, lstatWithFileIdentity, type SongOrganizerFileStat } from './fileIdentity'
import { isGeneratedMp3DirectoryName } from '../audioWorkspace/generatedMp3Directory'

interface InternalFile {
  path: string
  relativePath: string
  artistPath: string
  artistName: string
  albumPath?: string
  albumName?: string
  ext: string
  size: number
  mtimeMs: number
  identity?: string
  nlink: number
  audioStatus?: AudioCheckStatus
  errorCode?: string
  errorMessage?: string
}

interface InternalDirectory {
  path: string
  artistPath: string
  artistName: string
  albumPath?: string
  albumName?: string
  empty: boolean
}

interface ArtistInternal {
  path: string
  name: string
  files: InternalFile[]
  directories: InternalDirectory[]
  albums: Map<string, { path: string, name: string }>
  blockedReasons: string[]
}

export interface ScanOptions {
  root: string
  validator?: AudioValidator
  signal: AbortSignal
  protectedPaths?: string[]
  blockedArtistPaths?: Map<string, string[]>
  onProgress?: (progress: SongOrganizerScanProgress) => void
  taskId?: string
  lstat?: (target: string) => Promise<SongOrganizerFileStat>
  mode?: 'quick' | 'validate'
  artistPaths?: string[]
}

export interface ScanResult {
  snapshot: SongOrganizerSnapshot
  audioFingerprints: SongOrganizerAudioFingerprint[]
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const audioValidationConcurrency = 2
const compareText = (left: string, right: string): number => collator.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0)
const sortByPath = <T extends { path: string }>(items: T[]): T[] => items.sort((a, b) => compareText(a.path, b.path))
const isAudioExtension = (ext: string): boolean => ext == '.mp3' || ext == '.flac'
const normalizePathKey = (target: string): string => {
  const resolved = path.resolve(target)
  return process.platform == 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}
const cacheKey = (file: InternalFile): string | undefined => file.identity ? `${file.identity}:${file.size}:${file.mtimeMs}` : undefined

const anomalyId = (type: string, target: string): string => `${type}:${target}`

const toAnomaly = (type: SongOrganizerAnomaly['type'], file: InternalFile, status: string, reason?: string): SongOrganizerAnomaly => ({
  id: anomalyId(type, file.path),
  type,
  path: file.path,
  relativePath: file.relativePath,
  artistPath: file.artistPath,
  artistName: file.artistName,
  albumPath: file.albumPath,
  albumName: file.albumName,
  size: file.size,
  status,
  reason,
  fileIdentity: file.identity,
  mtimeMs: file.mtimeMs,
})

const discoverDirectory = async(params: {
  root: string
  currentPath: string
  artist: ArtistInternal
  albumPath?: string
  albumName?: string
  signal: AbortSignal
  anomalies: SongOrganizerAnomaly[]
  lstat: (target: string) => Promise<SongOrganizerFileStat>
}): Promise<boolean> => {
  const { root, currentPath, artist, albumPath, albumName, signal, anomalies, lstat } = params
  if (signal.aborted) return false
  const entries = await fs.readdir(currentPath, { withFileTypes: true })
  let hasEntry = false
  for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
    if (signal.aborted) return false
    const target = path.join(currentPath, entry.name)
    const stat = await lstat(target)
    if (stat.isSymbolicLink()) {
      hasEntry = true
      anomalies.push({
        id: anomalyId('reparse_point', target),
        type: 'reparse_point',
        path: target,
        relativePath: path.relative(root, target),
        artistPath: artist.path,
        artistName: artist.name,
        albumPath,
        albumName,
        size: 0,
        status: '待清理',
        reason: '重解析点未被跟随，只允许处理链接入口。',
        cleanupEligible: true,
      })
      continue
    }
    if (stat.isDirectory()) {
      hasEntry = true
      const childAlbumPath = albumPath ?? (currentPath == artist.path ? target : undefined)
      const childAlbumName = albumName ?? (currentPath == artist.path ? entry.name : undefined)
      if (childAlbumPath && !artist.albums.has(childAlbumPath)) artist.albums.set(childAlbumPath, { path: childAlbumPath, name: childAlbumName! })
      const childHasEntry = await discoverDirectory({
        root,
        currentPath: target,
        artist,
        albumPath: childAlbumPath,
        albumName: childAlbumName,
        signal,
        anomalies,
        lstat,
      })
      artist.directories.push({
        path: target,
        artistPath: artist.path,
        artistName: artist.name,
        albumPath: childAlbumPath,
        albumName: childAlbumName,
        empty: !childHasEntry,
      })
      if (!childHasEntry) {
        anomalies.push({
          id: anomalyId('empty_directory', target),
          type: 'empty_directory',
          path: target,
          relativePath: path.relative(root, target),
          artistPath: artist.path,
          artistName: artist.name,
          albumPath: childAlbumPath,
          albumName: childAlbumName,
          size: 0,
          status: '待清理',
          reason: '空的非歌手目录。',
          cleanupEligible: true,
        })
      }
      continue
    }
    if (!stat.isFile()) continue
    hasEntry = true
    const ext = path.extname(entry.name).toLocaleLowerCase('en-US')
    const file: InternalFile = {
      path: target,
      relativePath: path.relative(root, target),
      artistPath: artist.path,
      artistName: artist.name,
      albumPath,
      albumName,
      ext,
      size: Number(stat.size),
      mtimeMs: getSongOrganizerMtimeMs(stat),
      identity: createSongOrganizerFileIdentity(stat),
      nlink: Number(stat.nlink),
    }
    artist.files.push(file)
    if (!isAudioExtension(ext)) anomalies.push(toAnomaly('unsupported_file', file, '不支持', '仅支持 MP3 与 FLAC，清理前将再次确认文件类型。'))
  }
  return hasEntry
}

const uniqueAudioCount = (files: InternalFile[]): number => {
  const keys = new Set<string>()
  for (const file of files) {
    if (!isAudioExtension(file.ext)) continue
    keys.add(file.identity ?? `path:${file.path}`)
  }
  return keys.size
}

const createFolderSummary = (folderPath: string, name: string, files: InternalFile[], isArtist: boolean): SongOrganizerFolderSummary => {
  const audioFiles = files.filter(file => isAudioExtension(file.ext))
  const audioCount = uniqueAudioCount(audioFiles)
  const uniqueAudioFiles = [...new Map(audioFiles.map(file => [file.identity ?? `path:${file.path}`, file])).values()]
  const baseName = isArtist ? stripArtistCountSuffix(name) : stripAlbumCountSuffix(name)
  const targetName = isArtist ? buildArtistDirectoryName(name, audioCount) : buildAlbumDirectoryName(name, audioCount)
  return {
    path: folderPath,
    name,
    baseName,
    audioCount,
    playableCount: uniqueAudioFiles.filter(file => file.audioStatus == 'playable').length,
    unplayableCount: uniqueAudioFiles.filter(file => file.audioStatus == 'unplayable').length,
    checkFailedCount: uniqueAudioFiles.filter(file => file.audioStatus == 'check_failed' || file.audioStatus == 'skipped').length,
    unsupportedFileCount: files.filter(file => !isAudioExtension(file.ext)).length,
    targetName,
    needsRename: name != targetName,
  }
}

const addHardlinkAnomalies = (artists: ArtistInternal[], anomalies: SongOrganizerAnomaly[]): void => {
  const groups = new Map<string, InternalFile[]>()
  for (const artist of artists) {
    for (const file of artist.files) {
      if (!isAudioExtension(file.ext) || !file.identity || file.nlink < 2) continue
      const group = groups.get(file.identity) ?? []
      group.push(file)
      groups.set(file.identity, group)
    }
  }
  for (const files of groups.values()) {
    if (files.length < 2) continue
    sortByPath(files)
    const artistPaths = new Set(files.map(file => file.artistPath))
    const albumScopes = new Set(files.map(file => file.albumPath ?? `artist-root:${file.artistPath}`))
    const cleanupEligible = artistPaths.size == 1 && albumScopes.size == 1 && files.every(file => Boolean(file.albumPath))
    const keep = [...files].sort((a, b) => {
      const playable = Number(b.audioStatus == 'playable') - Number(a.audioStatus == 'playable')
      if (playable) return playable
      const depth = a.relativePath.split(path.sep).length - b.relativePath.split(path.sep).length
      if (depth) return depth
      const length = a.relativePath.length - b.relativePath.length
      return length || compareText(a.relativePath, b.relativePath)
    })[0]
    for (const file of files) {
      if (cleanupEligible && file.path == keep.path) continue
      const anomaly = toAnomaly('duplicate_hardlink', file, cleanupEligible ? '待清理' : '保留', cleanupEligible
        ? `与保留路径指向同一物理文件：${keep.relativePath}`
        : '硬链接跨歌手、跨专辑或位于歌手根目录，禁止自动清理。')
      anomaly.cleanupEligible = cleanupEligible
      anomaly.keepPath = keep.path
      anomalies.push(anomaly)
    }
  }
}

const buildRenamePlan = async(artists: SongOrganizerArtistSummary[]): Promise<SongOrganizerArtistRenamePlan[]> => Promise.all(artists.map(async artist => {
  const steps: SongOrganizerArtistRenamePlan['steps'] = artist.albums.filter(album => album.needsRename).map(album => ({
    type: 'album' as const,
    from: album.path,
    to: path.join(path.dirname(album.path), album.targetName),
  }))
  if (artist.needsRename) steps.push({ type: 'artist', from: artist.path, to: path.join(path.dirname(artist.path), artist.targetName) })
  const blockedReasons = [
    ...artist.blockedReasons,
    ...artist.albums
      .filter(album => !album.audioCount && album.unsupportedFileCount)
      .map(album => `专辑“${album.name}”没有 MP3/FLAC 且仍含未清理文件。`),
  ]
  for (const step of steps) {
    if (path.resolve(step.from) == path.resolve(step.to)) continue
    try {
      await fs.lstat(step.to)
      blockedReasons.push(`目标路径已存在：${step.to}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code != 'ENOENT') {
        blockedReasons.push(`无法确认目标路径是否可用：${step.to}（${(error as Error).message}）`)
      }
    }
  }
  const uniqueBlockedReasons = [...new Set(blockedReasons)]
  return {
    artistPath: artist.path,
    artistName: artist.name,
    targetName: artist.targetName,
    steps,
    blockedReasons: uniqueBlockedReasons,
  }
}))

export const scanSongOrganizerRoot = async(options: ScanOptions): Promise<ScanResult> => {
  const taskId = options.taskId ?? randomUUID()
  const lstat = options.lstat ?? lstatWithFileIdentity
  const root = await assertSafeRoot(options.root, options.protectedPaths)
  const blockedArtistPaths = new Map([...(options.blockedArtistPaths ?? [])]
    .map(([artistPath, reasons]) => [normalizePathKey(artistPath), reasons] as const))
  const validationResults = new Map<string, Promise<AudioValidationResult>>()
  const artists: ArtistInternal[] = []
  const anomalies: SongOrganizerAnomaly[] = []
  const rootEntries = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => compareText(a.name, b.name))
  const selectedArtistPaths = options.artistPaths?.length
    ? new Set(options.artistPaths.map(normalizePathKey))
    : undefined
  const artistEntries = rootEntries.filter(entry => {
    if (!entry.isDirectory() || entry.isSymbolicLink() || isGeneratedMp3DirectoryName(entry.name)) return false
    return !selectedArtistPaths || selectedArtistPaths.has(normalizePathKey(path.join(root, entry.name)))
  })
  options.onProgress?.({ taskId, phase: 'discovering', checkedCount: 0, totalAudioCount: artistEntries.length })
  let discoveredArtistCount = 0
  for (const entry of artistEntries) {
    if (options.signal.aborted) break
    const artistPath = path.join(root, entry.name)
    const stat = await lstat(artistPath)
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue
    const artist: ArtistInternal = {
      path: artistPath,
      name: entry.name,
      files: [],
      directories: [],
      albums: new Map(),
      blockedReasons: [...(blockedArtistPaths.get(normalizePathKey(artistPath)) ?? [])],
    }
    artists.push(artist)
    await discoverDirectory({ root, currentPath: artistPath, artist, signal: options.signal, anomalies, lstat })
    discoveredArtistCount++
    options.onProgress?.({ taskId, phase: 'discovering', checkedCount: discoveredArtistCount, totalAudioCount: artistEntries.length, currentPath: artistPath })
  }
  const audioFiles = sortByPath(artists.flatMap(artist => artist.files).filter(file => isAudioExtension(file.ext)))
  const shouldValidate = options.mode != 'quick'
  if (shouldValidate) options.onProgress?.({ taskId, phase: 'validating', checkedCount: 0, totalAudioCount: audioFiles.length })
  let checkedCount = 0
  const validationController = new AbortController()
  const abortValidation = () => {
    validationController.abort()
  }
  if (options.signal.aborted) abortValidation()
  else options.signal.addEventListener('abort', abortValidation, { once: true })
  try {
    if (!shouldValidate) {
      validationController.abort()
    } else {
      let nextFileIndex = 0
      let validationError: unknown
      let hasValidationError = false
      const validateFile = async(file: InternalFile): Promise<void> => {
        const artistBlocked = blockedArtistPaths.has(normalizePathKey(file.artistPath))
        if (artistBlocked) {
          file.audioStatus = 'skipped'
          file.errorCode = 'download_task'
          file.errorMessage = '所属歌手存在未完成下载或下载后处理，本次不执行音频校验。'
          checkedCount++
          options.onProgress?.({ taskId, phase: 'validating', checkedCount, totalAudioCount: audioFiles.length, currentPath: file.path })
          return
        }
        const key = cacheKey(file)
        let validation = key ? validationResults.get(key) : undefined
        if (!validation) {
          if (!options.validator) throw new Error('音频检查器不可用。')
          validation = options.validator.validate(file.path, validationController.signal)
          if (key) validationResults.set(key, validation)
        }
        const result = await validation
        file.audioStatus = result.status
        file.errorCode = result.errorCode
        file.errorMessage = result.errorMessage
        checkedCount++
        options.onProgress?.({ taskId, phase: 'validating', checkedCount, totalAudioCount: audioFiles.length, currentPath: file.path })
        if (result.status == 'unplayable') anomalies.push(toAnomaly('unplayable_audio', file, '无法播放', result.errorMessage))
        else if (result.status == 'check_failed') anomalies.push(toAnomaly('audio_check_failed', file, '检查失败', result.errorMessage))
      }
      const validateNext = async(): Promise<void> => {
        while (!validationController.signal.aborted) {
          const fileIndex = nextFileIndex++
          if (fileIndex >= audioFiles.length) return
          try {
            await validateFile(audioFiles[fileIndex])
          } catch (error) {
            if (!hasValidationError) {
              hasValidationError = true
              validationError = error
            }
            abortValidation()
          }
        }
      }
      await Promise.all(Array.from(
        { length: Math.min(audioValidationConcurrency, audioFiles.length) },
        async() => validateNext(),
      ))
      if (hasValidationError) throw validationError
    }
  } finally {
    options.signal.removeEventListener('abort', abortValidation)
  }

  addHardlinkAnomalies(artists, anomalies)
  const artistSummaries: SongOrganizerArtistSummary[] = artists.map(artist => {
    const summary = createFolderSummary(artist.path, artist.name, artist.files, true)
    const albums = [...artist.albums.values()].map(album => {
      const albumFiles = artist.files.filter(file => file.albumPath == album.path)
      return createFolderSummary(album.path, album.name, albumFiles, false)
    })
    return { ...summary, albums, blockedReasons: [...new Set(artist.blockedReasons)] }
  })
  const renamePlan = await buildRenamePlan(artistSummaries)
  const snapshot: SongOrganizerSnapshot = {
    taskId,
    root,
    status: options.signal.aborted ? 'cancelled' : 'complete',
    checkedCount,
    totalAudioCount: audioFiles.length,
    artists: artistSummaries,
    anomalies: anomalies.sort((a, b) => compareText(a.relativePath, b.relativePath)),
    renamePlan,
    totals: {
      artistCount: artistSummaries.length,
      albumCount: artistSummaries.reduce((count, artist) => count + artist.albums.length, 0),
      audioCount: artistSummaries.reduce((count, artist) => count + artist.audioCount, 0),
      playableCount: artistSummaries.reduce((count, artist) => count + artist.playableCount, 0),
      unplayableCount: artistSummaries.reduce((count, artist) => count + artist.unplayableCount, 0),
      checkFailedCount: artistSummaries.reduce((count, artist) => count + artist.checkFailedCount, 0),
      unsupportedFileCount: anomalies.filter(item => item.type == 'unsupported_file').length,
      duplicateHardlinkCount: anomalies.filter(item => item.type == 'duplicate_hardlink').length,
      reparsePointCount: anomalies.filter(item => item.type == 'reparse_point').length,
      emptyDirectoryCount: anomalies.filter(item => item.type == 'empty_directory').length,
      renameCount: renamePlan.reduce((count, plan) => count + plan.steps.length, 0),
    },
    validationStatus: shouldValidate ? 'checked' : 'unchecked',
  }
  return {
    snapshot,
    audioFingerprints: audioFiles.map(file => ({
      path: file.path,
      fileIdentity: file.identity,
      size: file.size,
      mtimeMs: file.mtimeMs,
    })),
  }
}
