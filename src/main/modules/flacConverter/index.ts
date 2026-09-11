import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import type {
  FlacConversionApplyParams,
  FlacConversionPreview,
  FlacConversionPreviewItem,
  FlacConversionPreviewParams,
  FlacConversionProgress,
  FlacConversionResult,
  FlacConverterCapability,
  FlacConversionPauseState,
  FlacConverterArtistScanParams,
  FlacConverterArtistScanResult,
} from '@common/flacConverter'
import { isAudioFfmpegAvailable, resolveBundledAudioFfmpegPath } from '../audioFfmpeg'
import { isGeneratedMp3DirectoryName, stripSongCountSuffix } from '../audioWorkspace/generatedMp3Directory'
import { AudioFfmpegTerminationError } from '../audioFfmpeg/processTermination'
import { FfmpegFlacConverter } from './ffmpegAdapter'
import { FlacConversionPauseGate } from './pauseGate'

const normalizePathKey = (filePath: string): string => {
  const resolved = path.resolve(filePath)
  return process.platform == 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

const normalizeDirectoryNameKey = (name: string): string => process.platform == 'win32' ? name.toLocaleLowerCase('en-US') : name

export const resolveFlacOutputDirectory = (sourceDirectory: string, outputParentDirectory = ''): string => {
  const parsed = path.parse(path.resolve(sourceDirectory))
  if (!parsed.base) throw new Error('不支持选择磁盘根目录作为 FLAC 来源目录。')
  const parentDirectory = outputParentDirectory.trim() ? path.resolve(outputParentDirectory) : parsed.dir
  return path.join(parentDirectory, `${stripSongCountSuffix(parsed.base)} MP3`)
}

const resolveCurrentFlacOutputDirectory = async(sourceDirectory: string, outputParentDirectory = ''): Promise<string> => {
  const defaultDirectory = resolveFlacOutputDirectory(sourceDirectory, outputParentDirectory)
  const parentDirectory = path.dirname(defaultDirectory)
  const baseName = path.basename(defaultDirectory)
  const entries = await fs.readdir(parentDirectory, { withFileTypes: true })
  const candidates: string[] = []
  const baseNameKey = normalizeDirectoryNameKey(baseName)
  for (const entry of entries.filter(entry => normalizeDirectoryNameKey(stripSongCountSuffix(entry.name)) == baseNameKey)) {
    const candidate = path.join(parentDirectory, entry.name)
    const stat = await fs.lstat(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`MP3 输出目录候选必须是普通文件夹：${candidate}`)
    candidates.push(candidate)
  }
  if (candidates.length > 1) {
    candidates.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    throw new Error(`存在多个 MP3 输出目录候选，禁止自动合并：${candidates.join('；')}`)
  }
  return candidates[0] ?? defaultDirectory
}

const isSameOrDescendant = (parentPath: string, candidatePath: string): boolean => {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath))
  return relative == '' || (!relative.startsWith(`..${path.sep}`) && relative != '..' && !path.isAbsolute(relative))
}

const fileIdentity = (stat: Awaited<ReturnType<typeof fs.lstat>>): string | undefined => String(stat.ino) == '0'
  ? undefined
  : `${stat.dev}:${stat.ino}`

const pathExists = async(target: string): Promise<boolean> => {
  try {
    await fs.lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code == 'ENOENT') return false
    throw error
  }
}

const tempCleanupRetryDelays = [25, 75, 150]

class FlacConversionTempCleanupError extends Error {}

const isFlacShutdownSafetyError = (error: unknown): error is Error => error instanceof AudioFfmpegTerminationError || error instanceof FlacConversionTempCleanupError

const delay = async(ms: number): Promise<void> => {
  await new Promise<void>(resolve => { setTimeout(() => { resolve() }, ms) })
}

const cleanupConversionTempFile = async(tempPath: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.unlink(tempPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code == 'ENOENT') return
      if (!['EPERM', 'EBUSY'].includes(code ?? '') || attempt >= tempCleanupRetryDelays.length) {
        throw new FlacConversionTempCleanupError(`无法删除 FLAC 转换临时文件：${tempPath}；${(error as Error).message}`)
      }
      await delay(tempCleanupRetryDelays[attempt])
    }
  }
}

const assertPlainDirectory = async(directory: string, label: string): Promise<void> => {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label}必须是普通文件夹。`)
}

const assertPlainDirectoryTree = async(directory: string, label: string): Promise<void> => {
  const resolved = path.resolve(directory)
  const parsed = path.parse(resolved)
  const segments = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`${label}不能包含重解析点：${current}`)
    if (!stat.isDirectory()) throw new Error(`${label}必须是普通文件夹：${current}`)
  }
}

interface SourceAudioFile {
  sourcePath: string
  kind: FlacConversionPreviewItem['kind']
}

const collectSourceAudioFiles = async(sourceDirectory: string, excludedDirectory: string): Promise<SourceAudioFile[]> => {
  const files: SourceAudioFile[] = []
  const excludedKey = normalizePathKey(excludedDirectory)
  const visit = async(directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (normalizePathKey(entryPath) == excludedKey) continue
      const stat = await fs.lstat(entryPath)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        await visit(entryPath)
        continue
      }
      if (!stat.isFile()) continue
      const extension = path.extname(entry.name).toLocaleLowerCase('en-US')
      if (extension == '.flac') files.push({ sourcePath: entryPath, kind: 'flac_to_mp3' })
      else if (extension == '.mp3') files.push({ sourcePath: entryPath, kind: 'copy_mp3' })
    }
  }
  await visit(sourceDirectory)
  return files
}

const countOutputMp3Files = async(outputDirectory: string): Promise<number> => {
  if (!await pathExists(outputDirectory)) return 0
  await assertPlainDirectory(outputDirectory, 'MP3 输出路径')
  let count = 0
  const visit = async(directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      const stat = await fs.lstat(entryPath)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        await visit(entryPath)
      } else if (stat.isFile() && path.extname(entry.name).toLocaleLowerCase('en-US') == '.mp3') {
        count++
      }
    }
  }
  await visit(outputDirectory)
  return count
}

const appendSongCountSuffix = (directory: string, songCount: number): string => `${stripSongCountSuffix(directory)}（${songCount}首）`

const updateResultOutputDirectory = (result: FlacConversionResult, outputDirectory: string): void => {
  const previousDirectory = result.outputDirectory
  const updateTargetPath = (item: FlacConversionResult['succeeded'][number]): void => {
    item.targetPath = path.join(outputDirectory, path.relative(previousDirectory, item.targetPath))
  }
  result.succeeded.forEach(updateTargetPath)
  result.skipped.forEach(updateTargetPath)
  result.failed.forEach(updateTargetPath)
  result.outputDirectory = outputDirectory
}

const findCompetingOutputDirectoryCandidates = async(currentDirectory: string): Promise<string[]> => {
  const parentDirectory = path.dirname(currentDirectory)
  const baseNameKey = normalizeDirectoryNameKey(stripSongCountSuffix(path.basename(currentDirectory)))
  const currentKey = normalizePathKey(currentDirectory)
  const entries = await fs.readdir(parentDirectory, { withFileTypes: true })
  return entries
    .filter(entry => normalizeDirectoryNameKey(stripSongCountSuffix(entry.name)) == baseNameKey)
    .map(entry => path.join(parentDirectory, entry.name))
    .filter(candidate => normalizePathKey(candidate) != currentKey)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

const renameFlacOutputDirectory = async(currentDirectory: string, targetDirectory: string): Promise<void> => {
  const conflictError = () => new Error(`MP3 输出目录目标已存在，禁止覆盖或合并：${targetDirectory}`)
  const competingCandidates = await findCompetingOutputDirectoryCandidates(currentDirectory)
  if (competingCandidates.some(candidate => normalizePathKey(candidate) == normalizePathKey(targetDirectory))) throw conflictError()
  if (competingCandidates.length) throw new Error(`转换期间出现新的 MP3 输出目录候选，禁止自动合并：${competingCandidates.join('；')}`)
  if (await pathExists(targetDirectory)) throw conflictError()
  try {
    await fs.rename(currentDirectory, targetDirectory)
  } catch (error) {
    if (await pathExists(targetDirectory)) throw conflictError()
    throw error
  }
}

const ensureSafeDirectoryTree = async(outputDirectory: string, targetDirectory: string): Promise<void> => {
  const parentDirectory = path.dirname(outputDirectory)
  await assertPlainDirectoryTree(parentDirectory, 'MP3 输出父目录')
  await fs.access(parentDirectory, constants.W_OK)
  if (!isSameOrDescendant(outputDirectory, targetDirectory)) throw new Error('MP3 目标路径超出输出目录。')
  const relative = path.relative(parentDirectory, targetDirectory)
  let current = parentDirectory
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      await assertPlainDirectory(current, 'MP3 输出路径')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code != 'ENOENT') throw error
      await fs.mkdir(current)
      await assertPlainDirectory(current, 'MP3 输出路径')
    }
  }
}

interface RetryCleanupFile {
  path: string
  identity?: string
  size: number
  mtimeMs: number
}

const prepareRetryDirectories = async(preview: FlacConversionPreview, sourcePaths: string[]) => {
  if (!sourcePaths.length) throw new Error('没有可重试的异常歌曲文件夹。')
  await assertPlainDirectoryTree(preview.sourceDirectory, '来源目录')
  const directories = new Map<string, string>()
  for (const sourcePath of sourcePaths) {
    const resolved = path.resolve(sourcePath)
    if (!isSameOrDescendant(preview.sourceDirectory, resolved) ||
      isSameOrDescendant(preview.outputDirectory, resolved) ||
      !['.flac', '.mp3'].includes(path.extname(resolved).toLowerCase())) {
      throw new Error(`异常歌曲路径超出来源范围：${sourcePath}`)
    }
    const directory = path.dirname(resolved)
    await assertPlainDirectoryTree(directory, '异常歌曲文件夹')
    const key = normalizePathKey(directory)
    if (!preview.items.some(item => normalizePathKey(path.dirname(item.sourcePath)) == key)) {
      throw new Error(`异常歌曲文件夹没有可转换的源歌曲，保留已有输出：${directory}`)
    }
    directories.set(key, directory)
  }
  const files: RetryCleanupFile[] = []
  for (const directory of directories.values()) {
    const target = path.resolve(preview.outputDirectory, path.relative(preview.sourceDirectory, directory))
    if (!isSameOrDescendant(preview.outputDirectory, target) || isSameOrDescendant(target, preview.sourceDirectory)) {
      throw new Error(`重试清理路径超出输出范围：${target}`)
    }
    // Validate existing ancestors even when the final output directory is absent.
    let ancestor = target
    while (!await pathExists(ancestor)) ancestor = path.dirname(ancestor)
    await assertPlainDirectoryTree(ancestor, '重试输出目录')
    if (!await pathExists(target)) continue
    await assertPlainDirectoryTree(target, '重试输出目录')
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      if (path.extname(entry.name).toLowerCase() != '.mp3') continue
      const filePath = path.join(target, entry.name)
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`重试输出歌曲必须是普通文件：${filePath}`)
      files.push({ path: filePath, identity: fileIdentity(stat), size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  return { directoryKeys: new Set(directories.keys()), files }
}

const emptyResult = (outputDirectory: string, sourceSongCount: number): FlacConversionResult => ({
  taskId: randomUUID(),
  outputDirectory,
  succeeded: [],
  skipped: [],
  failed: [],
  sourceSongCount,
  outputSongCount: 0,
  countMatches: false,
})

interface FlacAudioConverter {
  convert: (sourcePath: string, targetPath: string, signal: AbortSignal) => Promise<void>
}

export class FlacConverterService {
  private operationRunning = false
  private cancelRequested = false
  private terminationFailure?: AudioFfmpegTerminationError
  private operationSettled?: Promise<{ error?: unknown }>
  private settleOperation?: (settlement: { error?: unknown }) => void
  private cancellationController?: AbortController
  private progressListener?: (progress: FlacConversionProgress) => void
  private readonly pauseGate = new FlacConversionPauseGate()
  private lastProgress?: FlacConversionProgress

  constructor(
    private readonly configuredFfmpegPath?: string,
    private readonly ffmpegAvailable = isAudioFfmpegAvailable,
    private readonly converterFactory: (ffmpegPath: string) => FlacAudioConverter = ffmpegPath => new FfmpegFlacConverter(ffmpegPath),
  ) {}

  private ffmpegPath(): string {
    return this.configuredFfmpegPath ?? resolveBundledAudioFfmpegPath()
  }

  setProgressListener(listener?: (progress: FlacConversionProgress) => void): void {
    this.progressListener = listener
  }

  isBusy(): boolean {
    return this.operationRunning
  }

  getTerminationFailure(): AudioFfmpegTerminationError | undefined {
    return this.terminationFailure
  }

  async cancelAndWait(reason: string): Promise<void> {
    if (!this.operationRunning) return
    this.cancelRequested = true
    this.pauseGate.reset()
    this.cancellationController?.abort(reason)
    const settlement = await this.operationSettled
    if (isFlacShutdownSafetyError(settlement?.error)) throw settlement.error
  }

  private assertNotCancelled(): void {
    const signal = this.cancellationController?.signal
    if (!signal?.aborted) return
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'FLAC 转换已取消。'))
  }

  private emitProgress(progress: FlacConversionProgress): void {
    this.lastProgress = progress
    this.progressListener?.(progress)
  }

  setPaused(paused: boolean): FlacConversionPauseState {
    if (!this.operationRunning) {
      this.pauseGate.reset()
      return { busy: false, pauseRequested: false, paused: false }
    }
    const state = this.pauseGate.request(paused)
    if (this.lastProgress && this.lastProgress.phase != 'completed') {
      this.emitProgress({
        ...this.lastProgress,
        phase: paused ? (state.paused ? 'paused' : 'pausing') : 'running',
      })
    }
    return { busy: true, ...state }
  }

  async capability(): Promise<FlacConverterCapability> {
    const supported = process.platform == 'win32' && process.arch == 'x64'
    if (!supported) return { supported, platform: process.platform, arch: process.arch, ffmpegAvailable: false, reason: 'unsupported_platform' }
    const ffmpegAvailable = await this.ffmpegAvailable(this.ffmpegPath())
    return {
      supported,
      platform: process.platform,
      arch: process.arch,
      ffmpegAvailable,
      reason: ffmpegAvailable ? undefined : 'ffmpeg_unavailable',
    }
  }

  async scanArtistFolders(params: FlacConverterArtistScanParams): Promise<FlacConverterArtistScanResult> {
    const rootDirectory = path.resolve(params.rootDirectory)
    await assertPlainDirectory(rootDirectory, '来源根目录')
    const outputParentDirectory = params.outputParentDirectory?.trim()
      ? path.resolve(params.outputParentDirectory)
      : undefined
    if (outputParentDirectory) {
      await assertPlainDirectoryTree(outputParentDirectory, 'MP3 输出父目录')
      await fs.access(outputParentDirectory, constants.W_OK)
    }
    const entries = await fs.readdir(rootDirectory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const artists: FlacConverterArtistScanResult['artists'] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || isGeneratedMp3DirectoryName(entry.name)) continue
      const sourceDirectory = path.join(rootDirectory, entry.name)
      if (outputParentDirectory && normalizePathKey(sourceDirectory) == normalizePathKey(outputParentDirectory)) continue
      const stat = await fs.lstat(sourceDirectory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      const outputDirectory = await resolveCurrentFlacOutputDirectory(sourceDirectory, params.outputParentDirectory)
      const files = await collectSourceAudioFiles(sourceDirectory, outputDirectory)
      const flacCount = files.filter(file => file.kind == 'flac_to_mp3').length
      const mp3Count = files.length - flacCount
      artists.push({
        name: entry.name,
        path: sourceDirectory,
        outputDirectory,
        flacCount,
        mp3Count,
        songCount: files.length,
      })
    }
    return { rootDirectory, artists }
  }

  async preview(params: FlacConversionPreviewParams): Promise<FlacConversionPreview> {
    const sourceDirectory = path.resolve(params.sourceDirectory)
    await assertPlainDirectory(sourceDirectory, 'FLAC 来源目录')
    const outputParentDirectory = path.dirname(resolveFlacOutputDirectory(sourceDirectory, params.outputParentDirectory))
    await assertPlainDirectoryTree(outputParentDirectory, 'MP3 输出父目录')
    await fs.access(outputParentDirectory, constants.W_OK)
    const outputDirectory = await resolveCurrentFlacOutputDirectory(sourceDirectory, params.outputParentDirectory)
    if (await pathExists(outputDirectory)) await assertPlainDirectory(outputDirectory, 'MP3 输出路径')

    const sourceFiles = await collectSourceAudioFiles(sourceDirectory, outputDirectory)
    const items: FlacConversionPreviewItem[] = []
    for (const sourceFile of sourceFiles) {
      const { sourcePath, kind } = sourceFile
      const relativePath = path.relative(sourceDirectory, sourcePath)
      const targetPath = path.join(outputDirectory, kind == 'flac_to_mp3'
        ? relativePath.slice(0, -path.extname(relativePath).length) + '.mp3'
        : relativePath)
      try {
        const stat = await fs.lstat(sourcePath)
        let reason: string | undefined
        if (!stat.isFile() || stat.isSymbolicLink()) reason = '输入必须是普通音频文件。'
        else if (kind == 'flac_to_mp3' && path.extname(sourcePath).toLocaleLowerCase('en-US') != '.flac') reason = 'FLAC 输入扩展名已变化。'
        else if (kind == 'copy_mp3' && path.extname(sourcePath).toLocaleLowerCase('en-US') != '.mp3') reason = 'MP3 输入扩展名已变化。'
        else if (await pathExists(targetPath)) reason = '目标 MP3 已存在，禁止覆盖。'
        items.push({
          sourcePath,
          targetPath,
          kind,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          fileIdentity: fileIdentity(stat),
          status: reason ? 'skipped' : 'ready',
          reason,
        })
      } catch (error) {
        items.push({
          sourcePath,
          targetPath,
          kind,
          size: 0,
          status: 'skipped',
          reason: `无法读取输入：${(error as Error).message}`,
        })
      }
    }

    const targetGroups = new Map<string, FlacConversionPreviewItem[]>()
    for (const item of items.filter(item => item.status == 'ready')) {
      const key = normalizePathKey(item.targetPath)
      const group = targetGroups.get(key) ?? []
      group.push(item)
      targetGroups.set(key, group)
    }
    for (const group of targetGroups.values()) {
      if (group.length < 2) continue
      for (const item of group) {
        item.status = 'skipped'
        item.reason = '多个输入会生成同一个目标 MP3。'
      }
    }
    return {
      sourceDirectory,
      outputDirectory,
      items,
      readyCount: items.filter(item => item.status == 'ready').length,
      skippedCount: items.filter(item => item.status == 'skipped').length,
      totalSize: items.filter(item => item.status == 'ready').reduce((total, item) => total + item.size, 0),
      flacCount: items.filter(item => item.kind == 'flac_to_mp3').length,
      mp3Count: items.filter(item => item.kind == 'copy_mp3').length,
    }
  }

  async convert(params: FlacConversionApplyParams): Promise<FlacConversionResult> {
    if (this.operationRunning) throw new Error('已有 FLAC 转换正在进行。')
    this.cancelRequested = false
    this.cancellationController = new AbortController()
    this.operationSettled = new Promise(resolve => { this.settleOperation = resolve })
    this.operationRunning = true
    let operationError: unknown
    try {
      const capability = await this.capability()
      if (!capability.supported || !capability.ffmpegAvailable) throw new Error('内置 FFmpeg 不可用。')
      const initialPreview = await this.preview(params)
      let retryDirectories: Set<string> | undefined
      if (params.retrySourcePaths) {
        const cleanup = await prepareRetryDirectories(initialPreview, params.retrySourcePaths)
        retryDirectories = cleanup.directoryKeys
        for (const file of cleanup.files) {
          this.assertNotCancelled()
          await assertPlainDirectoryTree(path.dirname(file.path), '重试输出目录')
          const stat = await fs.lstat(file.path)
          if (!stat.isFile() || stat.isSymbolicLink() || fileIdentity(stat) != file.identity ||
            stat.size != file.size || stat.mtimeMs != file.mtimeMs) throw new Error(`重试清理前输出歌曲发生变化：${file.path}`)
          this.assertNotCancelled()
          await fs.unlink(file.path)
        }
        this.assertNotCancelled()
      }
      const preview = retryDirectories ? await this.preview(params) : initialPreview
      const selectedItems = retryDirectories
        ? preview.items.filter(item => retryDirectories.has(normalizePathKey(path.dirname(item.sourcePath))))
        : preview.items
      const confirmed = new Set(params.confirmedSourcePaths.map(normalizePathKey))
      const readyItems = selectedItems.filter(item => item.status == 'ready' && (retryDirectories != null || confirmed.has(normalizePathKey(item.sourcePath))))
      const result = emptyResult(preview.outputDirectory, preview.items.length)
      for (const item of selectedItems.filter(item => item.status == 'skipped')) {
        result.skipped.push({ sourcePath: item.sourcePath, targetPath: item.targetPath, reason: item.reason })
      }
      const converter = this.converterFactory(this.ffmpegPath())
      for (let index = 0; index < readyItems.length; index++) {
        if (this.cancelRequested) break
        const item = readyItems[index]
        await this.pauseGate.waitIfPaused(() => {
          this.emitProgress({
            taskId: result.taskId,
            sourceDirectory: preview.sourceDirectory,
            completedCount: index,
            totalCount: readyItems.length,
            phase: 'paused',
            currentPath: item.sourcePath,
            currentKind: item.kind,
          })
        })
        if (this.cancelRequested) break
        this.emitProgress({
          taskId: result.taskId,
          sourceDirectory: preview.sourceDirectory,
          completedCount: index,
          totalCount: readyItems.length,
          phase: 'running',
          currentPath: item.sourcePath,
          currentKind: item.kind,
        })
        const tempPath = path.join(path.dirname(item.targetPath), `.${path.basename(item.targetPath)}.lx-converting-${randomUUID()}.tmp`)
        try {
          const before = await fs.lstat(item.sourcePath)
          const expectedExtension = item.kind == 'flac_to_mp3' ? '.flac' : '.mp3'
          if (!before.isFile() || before.isSymbolicLink() || path.extname(item.sourcePath).toLocaleLowerCase('en-US') != expectedExtension) throw new Error('输入已不再是预期的普通音频文件。')
          if (fileIdentity(before) != item.fileIdentity || before.size != item.size || before.mtimeMs != item.mtimeMs) throw new Error('输入文件在确认后发生变化。')
          if (await pathExists(item.targetPath)) throw new Error('目标 MP3 已存在，禁止覆盖。')
          await ensureSafeDirectoryTree(preview.outputDirectory, path.dirname(item.targetPath))
          this.assertNotCancelled()
          if (item.kind == 'flac_to_mp3') await converter.convert(item.sourcePath, tempPath, this.cancellationController.signal)
          else await fs.copyFile(item.sourcePath, tempPath, constants.COPYFILE_EXCL)
          this.assertNotCancelled()
          const after = await fs.lstat(item.sourcePath)
          if (fileIdentity(after) != item.fileIdentity || after.size != item.size || after.mtimeMs != item.mtimeMs) throw new Error('输入文件在转换期间发生变化。')
          this.assertNotCancelled()
          await fs.link(tempPath, item.targetPath)
          result.succeeded.push({ sourcePath: item.sourcePath, targetPath: item.targetPath })
        } catch (error) {
          if (error instanceof AudioFfmpegTerminationError) {
            this.terminationFailure ??= error
            throw error
          }
          result.failed.push({ sourcePath: item.sourcePath, targetPath: item.targetPath, reason: (error as Error).message })
        } finally {
          await cleanupConversionTempFile(tempPath)
        }
      }
      result.sourceSongCount = (await collectSourceAudioFiles(preview.sourceDirectory, preview.outputDirectory)).length
      result.outputSongCount = await countOutputMp3Files(preview.outputDirectory)
      result.countMatches = result.sourceSongCount == result.outputSongCount
      if (await pathExists(preview.outputDirectory)) {
        const countedOutputDirectory = appendSongCountSuffix(preview.outputDirectory, result.outputSongCount)
        if (normalizePathKey(countedOutputDirectory) != normalizePathKey(preview.outputDirectory)) {
          await renameFlacOutputDirectory(preview.outputDirectory, countedOutputDirectory)
          updateResultOutputDirectory(result, countedOutputDirectory)
        }
      }
      this.emitProgress({
        taskId: result.taskId,
        sourceDirectory: preview.sourceDirectory,
        completedCount: readyItems.length,
        totalCount: readyItems.length,
        phase: 'completed',
      })
      return result
    } catch (error) {
      if (error instanceof AudioFfmpegTerminationError) this.terminationFailure ??= error
      operationError = error
      throw error
    } finally {
      this.pauseGate.reset()
      this.lastProgress = undefined
      this.operationRunning = false
      this.cancelRequested = false
      this.cancellationController = undefined
      this.settleOperation?.({ error: operationError })
      this.settleOperation = undefined
      this.operationSettled = undefined
    }
  }
}

export const flacConverterService = new FlacConverterService()
