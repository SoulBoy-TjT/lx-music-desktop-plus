import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'
import { LIST_IDS } from '@common/constants'
import type {
  SongOrganizerApplyParams,
  SongOrganizerAudioFingerprint,
  SongOrganizerCapability,
  SongOrganizerCheckParams,
  SongOrganizerCleanupApplyParams,
  SongOrganizerCleanupItem,
  SongOrganizerCleanupPreview,
  SongOrganizerOperationProgress,
  SongOrganizerOperationResult,
  SongOrganizerOrganizeApplyParams,
  SongOrganizerOrganizePreview,
  SongOrganizerRuntimeState,
  SongOrganizerScanParams,
  SongOrganizerScanProgress,
  SongOrganizerSnapshot,
  SongOrganizerValidationSnapshot,
} from '@common/songOrganizer'
import { FfmpegAudioValidator, isFfmpegAvailable, resolveFfmpegPath } from './audioValidator'
import type { AudioValidator } from './audioValidator'
import { AudioFfmpegTerminationError } from '../audioFfmpeg/processTermination'
import { assertPathInArtist, assertSafeRoot, isPathInside, SongOrganizerPathError } from './pathSafety'
import { scanSongOrganizerRoot } from './scanner'
import { clearJournal, readJournal, writeJournal, type SongOrganizerJournal } from './operationJournal'
import { createSongOrganizerFileIdentity, getSongOrganizerMtimeMs, lstatWithFileIdentity } from './fileIdentity'

interface ApplyResult {
  result: SongOrganizerOperationResult
  snapshot?: SongOrganizerSnapshot
}

interface OperationExecutionOptions {
  manageLock?: boolean
  refresh?: boolean
  snapshot?: SongOrganizerSnapshot
  result?: SongOrganizerOperationResult
}

interface CleanupProtectedPaths {
  exactPaths: string[]
  pathPrefixes: string[]
}

const completedResult = (taskId: string, type: SongOrganizerOperationResult['type']): SongOrganizerOperationResult => ({
  taskId,
  type,
  succeeded: [],
  skipped: [],
  failed: [],
  rollbackFailed: [],
})

const prefixReplace = (target: string, from: string, to: string): string => {
  if (!isPathInside(from, target)) return target
  const relative = path.relative(from, target)
  return relative ? path.join(to, relative) : to
}

const remapPath = (target: string, mappings: Array<{ from: string, to: string }>): string => {
  let current = target
  for (const mapping of mappings) current = prefixReplace(current, mapping.from, mapping.to)
  return current
}

const getListData = async(): Promise<LX.List.ListDataFull> => {
  const userLists = await global.lx.worker.dbService.getAllUserList()
  return {
    defaultList: await global.lx.worker.dbService.getListMusics(LIST_IDS.DEFAULT),
    loveList: await global.lx.worker.dbService.getListMusics(LIST_IDS.LOVE),
    tempList: await global.lx.worker.dbService.getListMusics(LIST_IDS.TEMP),
    userList: await Promise.all(userLists.map(async info => ({ ...info, list: await global.lx.worker.dbService.getListMusics(info.id) }))),
  }
}

const mapLocalMusic = (musicInfo: LX.Music.MusicInfo, mappings: Array<{ from: string, to: string }>): LX.Music.MusicInfo => {
  if (musicInfo.source != 'local') return musicInfo
  const filePath = musicInfo.meta.filePath || String(musicInfo.meta.songId || musicInfo.id)
  const mapped = remapPath(filePath, mappings)
  if (mapped == filePath) return musicInfo
  const mappedMusicInfo: LX.Music.MusicInfoLocal = {
    ...musicInfo,
    id: mapped,
    meta: { ...musicInfo.meta, songId: mapped, filePath: mapped },
  }
  return mappedMusicInfo
}

const mapListData = (data: LX.List.ListDataFull, mappings: Array<{ from: string, to: string }>): LX.List.ListDataFull => ({
  defaultList: data.defaultList.map(item => mapLocalMusic(item, mappings)),
  loveList: data.loveList.map(item => mapLocalMusic(item, mappings)),
  tempList: data.tempList.map(item => mapLocalMusic(item, mappings)),
  userList: data.userList.map(list => ({ ...list, list: list.list.map(item => mapLocalMusic(item, mappings)) })),
})

const normalizeReferencePath = (filePath: string): string => path.resolve(filePath).toLocaleLowerCase('en-US')
const normalizePathKey = (filePath: string): string => {
  const resolved = path.resolve(filePath)
  return process.platform == 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}
const cleanupConfirmationPathKey = (filePath: string): string => path.resolve(filePath)
const cleanupItemTypes = new Set<SongOrganizerCleanupItem['type']>([
  'unsupported_file',
  'duplicate_hardlink',
  'reparse_point',
  'empty_directory',
])

const getLocalReferences = (data: LX.List.ListDataFull): Map<string, Set<string>> => {
  const references = new Map<string, Set<string>>()
  const collect = (listId: string, list: LX.Music.MusicInfo[]) => {
    for (const musicInfo of list) {
      if (musicInfo.source != 'local') continue
      const filePath = musicInfo.meta.filePath || String(musicInfo.meta.songId || musicInfo.id)
      if (!path.isAbsolute(filePath)) continue
      const key = normalizeReferencePath(filePath)
      const listIds = references.get(key) ?? new Set<string>()
      listIds.add(listId)
      references.set(key, listIds)
    }
  }
  collect(LIST_IDS.DEFAULT, data.defaultList)
  collect(LIST_IDS.LOVE, data.loveList)
  collect(LIST_IDS.TEMP, data.tempList)
  for (const list of data.userList) collect(list.id, list.list)
  return references
}

export class SongOrganizerService {
  private snapshot?: SongOrganizerSnapshot
  private abortController?: AbortController
  private operationRunning = false
  private currentScanTaskId?: string
  private progressListener?: (progress: SongOrganizerScanProgress) => void
  private operationProgressListener?: (progress: SongOrganizerOperationProgress) => void
  private stateListener?: (state: SongOrganizerRuntimeState) => void
  private runtimeState: SongOrganizerRuntimeState = { revision: 0, status: 'idle' }
  private playingFilePath?: string
  private playingFilePathInitialized = false
  private scanSequence = 0
  private downloadOccupancyRescanTimer?: ReturnType<typeof setTimeout>
  private readonly validations = new Map<string, SongOrganizerValidationSnapshot>()
  private readonly activeReadOperations = new Set<Promise<AudioFfmpegTerminationError | undefined>>()
  private terminationFailure?: AudioFfmpegTerminationError
  private readonly createValidator: (ffmpegPath: string) => AudioValidator
  private readonly writeOperationJournal: typeof writeJournal
  private readonly clearOperationJournal: typeof clearJournal

  constructor(options: {
    createValidator?: (ffmpegPath: string) => AudioValidator
    writeJournal?: typeof writeJournal
    clearJournal?: typeof clearJournal
  } = {}) {
    this.createValidator = options.createValidator ?? (ffmpegPath => new FfmpegAudioValidator(ffmpegPath))
    this.writeOperationJournal = options.writeJournal ?? writeJournal
    this.clearOperationJournal = options.clearJournal ?? clearJournal
  }

  setProgressListener(listener?: (progress: SongOrganizerScanProgress) => void): void {
    this.progressListener = listener
  }

  setOperationProgressListener(listener?: (progress: SongOrganizerOperationProgress) => void): void {
    this.operationProgressListener = listener
  }

  setStateListener(listener?: (state: SongOrganizerRuntimeState) => void): void {
    this.stateListener = listener
  }

  getRuntimeState(): SongOrganizerRuntimeState {
    return structuredClone(this.runtimeState)
  }

  setPlayingFilePath(filePath?: string): void {
    this.playingFilePathInitialized = true
    this.playingFilePath = filePath && path.isAbsolute(filePath) ? path.resolve(filePath) : undefined
  }

  private currentPlayingFilePath(fallback?: string): string | undefined {
    return this.playingFilePathInitialized ? this.playingFilePath : fallback
  }

  private publishRuntimeState(state: Omit<SongOrganizerRuntimeState, 'revision'>): void {
    this.runtimeState = {
      ...state,
      validations: [...this.validations.values()],
      revision: this.runtimeState.revision + 1,
    }
    this.stateListener?.(this.getRuntimeState())
  }

  isBusy(): boolean {
    return this.operationRunning
  }

  isReadBusy(): boolean {
    return this.activeReadOperations.size > 0
  }

  getTerminationFailure(): AudioFfmpegTerminationError | undefined {
    return this.terminationFailure
  }

  private beginReadOperation(): (terminationError?: AudioFfmpegTerminationError) => void {
    let settle!: (terminationError?: AudioFfmpegTerminationError) => void
    const settled = new Promise<AudioFfmpegTerminationError | undefined>(resolve => {
      settle = resolve
    })
    this.activeReadOperations.add(settled)
    let finished = false
    return terminationError => {
      if (finished) return
      finished = true
      this.activeReadOperations.delete(settled)
      settle(terminationError)
    }
  }

  async cancelReadOperationsAndWait(): Promise<void> {
    this.abortController?.abort()
    let terminationError = this.terminationFailure
    while (this.activeReadOperations.size) {
      const results = await Promise.all([...this.activeReadOperations])
      terminationError ??= results.find((error): error is AudioFfmpegTerminationError => error != null)
    }
    if (terminationError) throw terminationError
  }

  private clearDownloadOccupancyRescan(): void {
    if (!this.downloadOccupancyRescanTimer) return
    clearTimeout(this.downloadOccupancyRescanTimer)
    this.downloadOccupancyRescanTimer = undefined
  }

  private scheduleDownloadOccupancyRescan(root: string, scanSequenceAtChange: number): void {
    this.clearDownloadOccupancyRescan()
    this.downloadOccupancyRescanTimer = setTimeout(() => {
      this.downloadOccupancyRescanTimer = undefined
      if (this.operationRunning) {
        this.scheduleDownloadOccupancyRescan(root, scanSequenceAtChange)
        return
      }
      const runtimeRoot = this.runtimeState.root ? normalizePathKey(this.runtimeState.root) : undefined
      if (this.scanSequence > scanSequenceAtChange && runtimeRoot == normalizePathKey(root)) return
      void this.scan({ root }).catch(error => {
        console.error('Song organizer download occupancy rescan failed', error)
      })
    }, 150)
  }

  notifyDownloadOccupancyChanged(root: string): void {
    const resolvedRoot = path.resolve(root)
    const scanSequenceAtChange = this.scanSequence
    this.abortController?.abort()
    this.abortController = undefined
    this.currentScanTaskId = undefined
    this.snapshot = undefined
    this.publishRuntimeState({ status: 'idle', root: resolvedRoot })
    this.scheduleDownloadOccupancyRescan(resolvedRoot, scanSequenceAtChange)
  }

  async requestMainScan(root: string): Promise<void> {
    const resolvedRoot = path.resolve(root)
    this.clearDownloadOccupancyRescan()
    if (this.operationRunning) {
      this.notifyDownloadOccupancyChanged(resolvedRoot)
      return
    }
    await this.scan({ root: resolvedRoot })
  }

  async capability(options: { probeValidator?: boolean } = {}): Promise<SongOrganizerCapability> {
    const supported = process.platform == 'win32' && process.arch == 'x64'
    if (!supported) return { supported, platform: process.platform, arch: process.arch, validatorAvailable: false, reason: 'unsupported_platform' }
    if (options.probeValidator === false) return { supported, platform: process.platform, arch: process.arch, validatorAvailable: false }
    const validatorPath = resolveFfmpegPath()
    const validatorAvailable = await isFfmpegAvailable(validatorPath)
    return {
      supported,
      platform: process.platform,
      arch: process.arch,
      validatorAvailable,
      validatorPath,
      reason: validatorAvailable ? undefined : 'validator_unavailable',
    }
  }

  private protectedPaths(): string[] {
    return [app.getAppPath(), process.resourcesPath, global.lxDataPath].filter(Boolean)
  }

  private async blockedArtists(root: string): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>()
    for (const task of await this.activeDownloadTasks(root)) {
      const filePath = task.metadata.filePath
      const relative = path.relative(root, filePath)
      const artistName = relative.split(path.sep)[0]
      if (!artistName || artistName == '..') continue
      const artistPath = path.join(root, artistName)
      const artistKey = normalizePathKey(artistPath)
      const reasons = result.get(artistKey) ?? []
      reasons.push(`下载任务“${task.metadata.fileName}”尚未完成或仍在后处理。`)
      result.set(artistKey, reasons)
    }
    return result
  }

  private async activeDownloadTasks(root: string): Promise<LX.Download.ListItem[]> {
    const tasks = await global.lx.worker.dbService.getDownloadList()
    return tasks.filter(task => {
      if (task.status == 'completed' && task.isComplate) return false
      const filePath = task.metadata.filePath
      return typeof filePath == 'string' && path.isAbsolute(filePath) && filePath != root && isPathInside(root, filePath)
    })
  }

  private async cleanupProtectedPaths(root: string): Promise<CleanupProtectedPaths> {
    const exactPaths = new Map<string, string>()
    const pathPrefixes = new Map<string, string>()
    const addExactPath = (filePath: string): void => {
      exactPaths.set(normalizePathKey(filePath), filePath)
    }
    const addPathPrefix = (filePath: string): void => {
      pathPrefixes.set(normalizePathKey(filePath), filePath)
    }
    for (const task of await this.activeDownloadTasks(root)) {
      const outputPath = path.resolve(task.metadata.filePath)
      const parsed = path.parse(outputPath)
      const lyricPath = path.join(parsed.dir, `${parsed.name}.lrc`)
      for (const filePath of [outputPath, lyricPath]) {
        addExactPath(filePath)
        addExactPath(`${filePath}.lxmtemp`)
        addExactPath(`${filePath}.lxmbackup`)
      }
      addPathPrefix(`${outputPath}.lxcover.`)
    }
    return {
      exactPaths: [...exactPaths.values()],
      pathPrefixes: [...pathPrefixes.values()],
    }
  }

  private isCleanupItemProtected(itemPath: string, protectedPaths: CleanupProtectedPaths): boolean {
    if (protectedPaths.exactPaths.some(protectedPath => isPathInside(itemPath, protectedPath))) return true
    const itemPathKey = normalizePathKey(itemPath)
    return protectedPaths.pathPrefixes.some(pathPrefix => itemPathKey.startsWith(normalizePathKey(pathPrefix)) || isPathInside(itemPath, pathPrefix))
  }

  private applyCleanupProtection(snapshot: SongOrganizerSnapshot, protectedPaths: CleanupProtectedPaths): SongOrganizerSnapshot {
    if (snapshot.status != 'complete' || (!protectedPaths.exactPaths.length && !protectedPaths.pathPrefixes.length)) return snapshot
    let changed = false
    const anomalies = snapshot.anomalies.map(anomaly => {
      if (!cleanupItemTypes.has(anomaly.type as SongOrganizerCleanupItem['type']) || anomaly.cleanupEligible === false || !this.isCleanupItemProtected(anomaly.path, protectedPaths)) return anomaly
      changed = true
      return {
        ...anomaly,
        cleanupEligible: false,
        status: '下载任务占用',
        reason: '下载任务占用',
      }
    })
    return changed ? { ...snapshot, anomalies } : snapshot
  }

  async scan(params: SongOrganizerScanParams): Promise<SongOrganizerSnapshot> {
    if (this.operationRunning) throw new Error('磁盘操作进行中，暂时不能开始新扫描。')
    return this.runQuickScan(params)
  }

  private async runQuickScan(params: SongOrganizerScanParams): Promise<SongOrganizerSnapshot> {
    this.scanSequence++
    const taskId = params.taskId ?? randomUUID()
    const requestedRoot = path.resolve(params.root)
    const abortController = new AbortController()
    this.abortController?.abort()
    this.abortController = abortController
    this.currentScanTaskId = taskId
    this.snapshot = undefined
    this.validations.clear()
    this.publishRuntimeState({
      status: 'scanning',
      taskId,
      root: requestedRoot,
      progress: { taskId, phase: 'discovering', checkedCount: 0, totalAudioCount: 0 },
    })
    const isCurrentTask = () => this.currentScanTaskId == taskId && this.abortController == abortController
    const finishReadOperation = this.beginReadOperation()
    let terminationError: AudioFfmpegTerminationError | undefined
    try {
      const capability = await this.capability({ probeValidator: false })
      if (!capability.supported) throw new SongOrganizerPathError('unsupported_platform', '歌曲整理仅支持 Windows x64。')
      const root = await assertSafeRoot(params.root, this.protectedPaths())
      const blockedArtistPaths = await this.blockedArtists(root)
      const result = await scanSongOrganizerRoot({
        ...params,
        root,
        validator: undefined,
        mode: 'quick',
        signal: abortController.signal,
        protectedPaths: this.protectedPaths(),
        blockedArtistPaths,
        onProgress: progress => {
          if (!isCurrentTask()) return
          this.progressListener?.(progress)
          this.publishRuntimeState({
            status: 'scanning',
            taskId,
            root,
            progress,
          })
        },
        taskId,
      })
      const resultSnapshot = result.snapshot.status == 'complete'
        ? this.applyCleanupProtection(result.snapshot, await this.cleanupProtectedPaths(root))
        : result.snapshot
      if (isCurrentTask()) {
        this.snapshot = resultSnapshot
        this.publishRuntimeState({
          status: resultSnapshot.status,
          taskId,
          root,
          snapshot: resultSnapshot,
        })
      }
      return resultSnapshot
    } catch (error) {
      if (error instanceof AudioFfmpegTerminationError) {
        terminationError = error
        this.terminationFailure ??= error
      }
      if (isCurrentTask()) {
        this.publishRuntimeState({
          status: 'failed',
          taskId,
          root: requestedRoot,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    } finally {
      if (isCurrentTask()) {
        this.currentScanTaskId = undefined
        this.abortController = undefined
      }
      finishReadOperation(terminationError)
    }
  }

  async check(params: SongOrganizerCheckParams): Promise<SongOrganizerValidationSnapshot> {
    if (this.operationRunning) throw new Error('磁盘操作进行中，暂时不能开始检查。')
    const quickSnapshot = this.assertCurrentSnapshot(params.quickSnapshotId)
    const artist = quickSnapshot.artists.find(item => normalizePathKey(item.path) == normalizePathKey(params.artistPath))
    if (!artist) throw new Error('歌手不属于当前快速统计结果。')
    const taskId = params.taskId ?? randomUUID()
    const abortController = new AbortController()
    this.abortController?.abort()
    this.abortController = abortController
    this.currentScanTaskId = taskId
    this.validations.delete(normalizePathKey(artist.path))
    this.publishRuntimeState({
      status: 'scanning',
      taskId,
      root: quickSnapshot.root,
      snapshot: quickSnapshot,
      progress: { taskId, phase: 'validating', checkedCount: 0, totalAudioCount: artist.audioCount },
    })
    const isCurrentTask = () => this.currentScanTaskId == taskId && this.abortController == abortController
    const finishReadOperation = this.beginReadOperation()
    let terminationError: AudioFfmpegTerminationError | undefined
    try {
      const capability = await this.capability()
      if (!capability.validatorAvailable || !capability.validatorPath) throw new SongOrganizerPathError('validator_unavailable', '内置 FFmpeg 不可用，无法检查音频。')
      const result = await scanSongOrganizerRoot({
        root: quickSnapshot.root,
        validator: this.createValidator(capability.validatorPath),
        signal: abortController.signal,
        protectedPaths: this.protectedPaths(),
        blockedArtistPaths: await this.blockedArtists(quickSnapshot.root),
        artistPaths: [artist.path],
        mode: 'validate',
        taskId,
        onProgress: progress => {
          if (!isCurrentTask()) return
          this.progressListener?.(progress)
          this.publishRuntimeState({
            status: 'scanning',
            taskId,
            root: quickSnapshot.root,
            snapshot: quickSnapshot,
            progress,
          })
        },
      })
      if (result.snapshot.status != 'complete') throw new Error('音频检查已取消。')
      const validation: SongOrganizerValidationSnapshot = {
        id: taskId,
        taskId,
        quickSnapshotId: quickSnapshot.taskId,
        root: quickSnapshot.root,
        artistPath: artist.path,
        status: 'complete',
        checkedAt: Date.now(),
        checkedCount: result.snapshot.checkedCount,
        totalAudioCount: result.snapshot.totalAudioCount,
        audioFingerprints: result.audioFingerprints,
        snapshot: result.snapshot,
      }
      if (isCurrentTask()) {
        this.validations.set(normalizePathKey(artist.path), validation)
        this.publishRuntimeState({
          status: 'complete',
          taskId: quickSnapshot.taskId,
          root: quickSnapshot.root,
          snapshot: quickSnapshot,
        })
      }
      return validation
    } catch (error) {
      if (error instanceof AudioFfmpegTerminationError) {
        terminationError = error
        this.terminationFailure ??= error
      }
      if (isCurrentTask()) {
        this.publishRuntimeState({
          status: abortController.signal.aborted ? 'cancelled' : 'failed',
          taskId,
          root: quickSnapshot.root,
          snapshot: quickSnapshot,
          errorMessage: abortController.signal.aborted ? undefined : (error as Error).message,
        })
      }
      throw error
    } finally {
      if (isCurrentTask()) {
        this.currentScanTaskId = undefined
        this.abortController = undefined
      }
      finishReadOperation(terminationError)
    }
  }

  cancel(taskId: string): boolean {
    if (this.currentScanTaskId == taskId) {
      this.abortController?.abort()
      return true
    }
    return false
  }

  cancelCurrentScan(): boolean {
    return this.currentScanTaskId ? this.cancel(this.currentScanTaskId) : false
  }

  getSnapshot(taskId?: string): SongOrganizerSnapshot | undefined {
    return !taskId || this.snapshot?.taskId == taskId ? this.snapshot : undefined
  }

  private assertCurrentSnapshot(taskId: string): SongOrganizerSnapshot {
    if (!this.snapshot || this.snapshot.taskId != taskId || this.snapshot.status != 'complete') {
      throw new Error('只有最新完整扫描结果允许修改磁盘。')
    }
    return this.snapshot
  }

  private assertCurrentValidation(params: SongOrganizerApplyParams): SongOrganizerValidationSnapshot {
    const snapshot = this.assertCurrentSnapshot(params.taskId)
    if (params.artistPaths.length != 1) throw new Error('整理一次只能处理一个歌手。')
    const artistPath = params.artistPaths[0]
    const validation = this.validations.get(normalizePathKey(artistPath))
    if (
      !params.validationId ||
      !validation ||
      validation.id != params.validationId ||
      validation.quickSnapshotId != snapshot.taskId ||
      normalizePathKey(validation.root) != normalizePathKey(snapshot.root)
    ) throw new Error('请先检查该歌手，再使用最新检查结果整理。')
    return validation
  }

  private async scanArtistsQuick(
    root: string,
    artistPaths: string[],
    taskId: string,
  ): Promise<Awaited<ReturnType<typeof scanSongOrganizerRoot>>> {
    const result = await scanSongOrganizerRoot({
      root,
      validator: undefined,
      signal: new AbortController().signal,
      protectedPaths: this.protectedPaths(),
      blockedArtistPaths: await this.blockedArtists(root),
      artistPaths,
      mode: 'quick',
      taskId,
    })
    return {
      ...result,
      snapshot: this.applyCleanupProtection(
        result.snapshot,
        await this.cleanupProtectedPaths(root),
      ),
    }
  }

  private assertCheckedAudioUnchanged(
    expected: SongOrganizerAudioFingerprint[],
    actual: SongOrganizerAudioFingerprint[],
  ): void {
    const expectedByPath = new Map(expected.map(item => [normalizePathKey(item.path), item]))
    const actualByPath = new Map(actual.map(item => [normalizePathKey(item.path), item]))
    const added = [...actualByPath.keys()].filter(key => !expectedByPath.has(key))
    const removed = [...expectedByPath.keys()].filter(key => !actualByPath.has(key))
    const changed = [...expectedByPath].filter(([key, item]) => {
      const current = actualByPath.get(key)
      return current != null && (
        current.fileIdentity != item.fileIdentity ||
        current.size != item.size ||
        current.mtimeMs != item.mtimeMs
      )
    })
    if (!added.length && !removed.length && !changed.length) return
    throw new Error(`歌曲文件已变化（新增 ${added.length}，移除 ${removed.length}，替换或修改 ${changed.length}），请重新检查该歌手后再整理。`)
  }

  private invalidateValidation(artistPath: string, snapshot: SongOrganizerSnapshot): void {
    if (!this.validations.delete(normalizePathKey(artistPath))) return
    this.publishRuntimeState({
      status: 'complete',
      taskId: snapshot.taskId,
      root: snapshot.root,
      snapshot,
    })
  }

  private async buildCleanupPreview(
    snapshot: SongOrganizerSnapshot,
    params: SongOrganizerApplyParams,
  ): Promise<SongOrganizerCleanupPreview> {
    const selected = new Set(params.artistPaths)
    const [protectedPaths, listData] = await Promise.all([
      this.cleanupProtectedPaths(snapshot.root),
      getListData(),
    ])
    const localReferences = getLocalReferences(listData)
    const items = snapshot.anomalies
      .filter(item => selected.has(item.artistPath) && cleanupItemTypes.has(item.type as SongOrganizerCleanupItem['type']) && item.cleanupEligible !== false)
      .filter(item => !this.isCleanupItemProtected(item.path, protectedPaths))
      .map(item => ({
        path: item.path,
        type: item.type as SongOrganizerCleanupItem['type'],
        artistPath: item.artistPath,
        size: item.size,
        keepPath: item.keepPath,
        fileIdentity: item.fileIdentity,
        mtimeMs: item.mtimeMs,
        referencedListCount: localReferences.get(normalizeReferencePath(item.path))?.size ?? 0,
      }))
      .sort((a, b) => {
        if (a.type == 'empty_directory' && b.type != 'empty_directory') return 1
        if (a.type != 'empty_directory' && b.type == 'empty_directory') return -1
        return b.path.length - a.path.length
      })
    const referencedListIds = new Set<string>()
    for (const item of items) {
      for (const listId of localReferences.get(normalizeReferencePath(item.path)) ?? []) referencedListIds.add(listId)
    }
    return {
      taskId: params.taskId,
      items,
      totalSize: items.reduce((total, item) => total + item.size, 0),
      referencedItemCount: items.filter(item => item.referencedListCount > 0).length,
      referencedListCount: referencedListIds.size,
      blockedArtists: [],
    }
  }

  async cleanupPreview(params: SongOrganizerApplyParams): Promise<SongOrganizerCleanupPreview> {
    return this.buildCleanupPreview(this.assertCurrentSnapshot(params.taskId), params)
  }

  async organizePreview(params: SongOrganizerApplyParams): Promise<SongOrganizerOrganizePreview> {
    const validation = this.assertCurrentValidation(params)
    const preview = await this.buildCleanupPreview(validation.snapshot, params)
    const selected = new Set(params.artistPaths.map(normalizePathKey))
    return {
      ...preview,
      validationId: validation.id,
      renameSteps: validation.snapshot.renamePlan
        .filter(plan => selected.has(normalizePathKey(plan.artistPath)))
        .flatMap(plan => plan.steps),
    }
  }

  private async validateCleanupItem(root: string, item: SongOrganizerCleanupItem): Promise<void> {
    assertPathInArtist(root, item.artistPath, item.path)
    const stat = await lstatWithFileIdentity(item.path)
    switch (item.type) {
      case 'unsupported_file':
        if (!stat.isFile() || ['.mp3', '.flac'].includes(path.extname(item.path).toLocaleLowerCase('en-US'))) throw new Error('文件类型已经变化。')
        if (item.fileIdentity && createSongOrganizerFileIdentity(stat) != item.fileIdentity) throw new Error('文件身份已经变化。')
        if (Number(stat.size) != item.size || getSongOrganizerMtimeMs(stat) != item.mtimeMs) throw new Error('文件内容或修改时间已经变化。')
        break
      case 'duplicate_hardlink': {
        if (!stat.isFile() || !item.keepPath) throw new Error('硬链接清理计划已经失效。')
        const keepStat = await lstatWithFileIdentity(item.keepPath)
        if (createSongOrganizerFileIdentity(stat) != createSongOrganizerFileIdentity(keepStat) || stat.nlink < 2n) throw new Error('硬链接身份已经变化。')
        break
      }
      case 'reparse_point':
        if (!stat.isSymbolicLink()) throw new Error('目标已不再是重解析点。')
        break
      case 'empty_directory':
        if (!stat.isDirectory() || (await fs.readdir(item.path)).length) throw new Error('目录已不为空。')
        if (item.path == item.artistPath) throw new Error('歌手目录永不自动清理。')
        break
    }
  }

  async cleanup(params: SongOrganizerCleanupApplyParams, options: OperationExecutionOptions = {}): Promise<ApplyResult> {
    const snapshot = options.snapshot ?? this.assertCurrentSnapshot(params.taskId)
    const manageLock = options.manageLock !== false
    if (this.operationRunning && manageLock) throw new Error('已有磁盘操作正在进行。')
    if (manageLock) this.operationRunning = true
    const result = options.result ?? completedResult(params.operationId ?? randomUUID(), 'cleanup')
    try {
      const preview = await this.buildCleanupPreview(snapshot, params)
      const confirmedPathKeys = new Set((params.confirmedItemPaths ?? []).map(cleanupConfirmationPathKey))
      const items = preview.items.filter(item => confirmedPathKeys.has(cleanupConfirmationPathKey(item.path)))
      const currentSafePathKeys = new Set(items.map(item => cleanupConfirmationPathKey(item.path)))
      const selectedArtists = new Set(params.artistPaths)
      const snapshotCleanablePaths = new Map(snapshot.anomalies
        .filter(item => selectedArtists.has(item.artistPath) && item.cleanupEligible !== false)
        .map(item => [cleanupConfirmationPathKey(item.path), item.path]))
      for (const confirmedPath of params.confirmedItemPaths ?? []) {
        const key = cleanupConfirmationPathKey(confirmedPath)
        const snapshotPath = snapshotCleanablePaths.get(key)
        if (snapshotPath && !currentSafePathKeys.has(key)) {
          result.skipped.push({ path: snapshotPath, status: 'skipped', phase: 'cleanup', reason: '目标当前被下载任务占用或已不再满足安全清理条件。' })
        }
      }
      const journal: SongOrganizerJournal = {
        operationId: result.taskId,
        type: 'cleanup',
        root: snapshot.root,
        startedAt: Date.now(),
        completed: false,
        steps: items.map(item => ({ from: item.path, status: 'planned' })),
      }
      let completedItems = 0
      const publishCleanupProgress = (currentTarget?: string): void => {
        if (result.type != 'organize') return
        this.operationProgressListener?.({
          operationId: result.taskId,
          sourceTaskId: params.taskId,
          type: 'organize',
          phase: 'cleanup',
          artistPath: items[0]?.artistPath ?? params.artistPaths[0] ?? snapshot.root,
          completed: completedItems,
          total: items.length,
          currentRelativeTarget: currentTarget ? path.relative(snapshot.root, currentTarget) : undefined,
        })
      }
      publishCleanupProgress(items[0]?.path)
      await this.writeOperationJournal(journal)
      for (let index = 0; index < items.length; index++) {
        const item = items[index]
        try {
          if (this.isCleanupItemProtected(item.path, await this.cleanupProtectedPaths(snapshot.root))) {
            result.skipped.push({ path: item.path, status: 'skipped', phase: 'cleanup', reason: '目标当前被下载任务占用，已跳过。' })
            continue
          }
          await this.validateCleanupItem(snapshot.root, item)
          const playingFilePath = this.currentPlayingFilePath(params.playingFilePath)
          if (playingFilePath && normalizePathKey(playingFilePath) == normalizePathKey(item.path)) {
            result.skipped.push({ path: item.path, status: 'skipped', phase: 'cleanup', reason: '当前正在播放，已跳过。' })
            continue
          }
          await shell.trashItem(item.path)
          result.succeeded.push({ path: item.path, status: 'succeeded' })
          journal.steps[index].status = 'succeeded'
        } catch (error) {
          const reason = (error as Error).message
          result.failed.push({ path: item.path, status: 'failed', phase: 'cleanup', reason })
          journal.steps[index].status = 'failed'
          journal.steps[index].reason = reason
        } finally {
          completedItems++
          publishCleanupProgress(items[index + 1]?.path)
        }
        await this.writeOperationJournal(journal)
      }
      journal.completed = true
      await this.writeOperationJournal(journal)
      await this.clearOperationJournal()
    } finally {
      if (manageLock) this.operationRunning = false
    }
    if (options.refresh === false) return { result }
    let rescanned: SongOrganizerSnapshot | undefined
    try {
      rescanned = await this.scan({ root: snapshot.root })
    } catch (error) {
      result.failed.push({ path: snapshot.root, status: 'failed', phase: 'rescanning', reason: `自动重新扫描失败：${(error as Error).message}` })
    }
    return { result, snapshot: rescanned }
  }

  private async updatePathReferences(mappings: Array<{ from: string, to: string }>): Promise<() => Promise<void>> {
    const downloads = await global.lx.worker.dbService.getDownloadList()
    const completedDownloads = downloads.filter(item => item.status == 'completed' && item.isComplate)
    const changedDownloadPairs = completedDownloads.map(item => {
      const mapped = remapPath(item.metadata.filePath, mappings)
      return { original: item, mapped: mapped == item.metadata.filePath ? item : { ...item, metadata: { ...item.metadata, filePath: mapped } } }
    }).filter(pair => pair.original.metadata.filePath != pair.mapped.metadata.filePath)
    const changedDownloads = changedDownloadPairs.map(pair => pair.mapped)
    const originalChangedDownloads = changedDownloadPairs.map(pair => pair.original)
    const originalListData = await getListData()
    const mappedListData = mapListData(originalListData, mappings)
    await global.lx.worker.dbService.downloadInfoUpdate(changedDownloads)
    try {
      await global.lx.event_list.list_data_overwrite(mappedListData, false)
    } catch (error) {
      await global.lx.worker.dbService.downloadInfoUpdate(originalChangedDownloads)
      throw error
    }
    return async() => {
      await global.lx.worker.dbService.downloadInfoUpdate(originalChangedDownloads)
      await global.lx.event_list.list_data_overwrite(originalListData, false)
    }
  }

  async rename(params: SongOrganizerApplyParams, options: OperationExecutionOptions = {}): Promise<ApplyResult> {
    const snapshot = options.snapshot ?? this.assertCurrentSnapshot(params.taskId)
    const manageLock = options.manageLock !== false
    if (this.operationRunning && manageLock) throw new Error('已有磁盘操作正在进行。')
    const selected = new Set(params.artistPaths)
    const result = options.result ?? completedResult(params.operationId ?? randomUUID(), 'rename')
    const plans = snapshot.renamePlan.filter(plan => selected.has(plan.artistPath))
    const totalSteps = plans.reduce((total, plan) => total + plan.steps.length, 0)
    const primaryArtistPath = plans[0]?.artistPath ?? params.artistPaths[0] ?? snapshot.root
    let completedSteps = 0
    const publishProgress = (
      phase: SongOrganizerOperationProgress['phase'],
      options: {
        artistPath?: string
        completed?: number
        total?: number
        currentTarget?: string
      } = {},
    ): void => {
      this.operationProgressListener?.({
        operationId: result.taskId,
        sourceTaskId: params.taskId,
        type: result.type == 'organize' ? 'organize' : 'rename',
        phase,
        artistPath: options.artistPath ?? primaryArtistPath,
        completed: options.completed ?? completedSteps,
        total: options.total ?? totalSteps,
        currentRelativeTarget: options.currentTarget ? path.relative(snapshot.root, options.currentTarget) : undefined,
      })
    }
    const journal: SongOrganizerJournal = {
      operationId: result.taskId,
      type: 'rename',
      root: snapshot.root,
      startedAt: Date.now(),
      completed: false,
      steps: plans.flatMap(plan => plan.steps.map(step => ({ from: step.from, to: step.to, status: 'planned' as const }))),
    }
    if (manageLock) this.operationRunning = true
    let journalIndex = 0
    try {
      publishProgress('preparing')
      await this.writeOperationJournal(journal)
      for (const plan of plans) {
        const liveBlockedReasons = (await this.blockedArtists(snapshot.root)).get(normalizePathKey(plan.artistPath)) ?? []
        const blockedReasons = [...new Set([...plan.blockedReasons, ...liveBlockedReasons])]
        if (blockedReasons.length) {
          result.skipped.push({ path: plan.artistPath, status: 'skipped', phase: 'renaming', reason: blockedReasons.join('；') })
          journalIndex += plan.steps.length
          continue
        }
        const playingFilePath = this.currentPlayingFilePath(params.playingFilePath)
        if (playingFilePath && isPathInside(plan.artistPath, playingFilePath)) {
          result.skipped.push({ path: plan.artistPath, status: 'skipped', phase: 'renaming', reason: '当前播放的本地歌曲位于该歌手目录内。' })
          journalIndex += plan.steps.length
          continue
        }
        const mappings: Array<{ from: string, to: string }> = []
        const executed: Array<{ from: string, to: string, journalIndex: number }> = []
        let restoreReferences: (() => Promise<void>) | undefined
        try {
          for (const step of plan.steps) {
            assertPathInArtist(snapshot.root, plan.artistPath, step.from)
            try {
              await fs.lstat(step.to)
              throw new Error(`目标已存在：${step.to}`)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code != 'ENOENT') throw error
            }
          }
          const latestPlayingFilePath = this.currentPlayingFilePath(params.playingFilePath)
          if (latestPlayingFilePath && isPathInside(plan.artistPath, latestPlayingFilePath)) {
            result.skipped.push({ path: plan.artistPath, status: 'skipped', phase: 'renaming', reason: '当前播放的本地歌曲位于该歌手目录内。' })
            journalIndex += plan.steps.length
            continue
          }
          for (const step of plan.steps) {
            publishProgress('renaming', { artistPath: plan.artistPath, currentTarget: step.to })
            await fs.rename(step.from, step.to)
            completedSteps++
            publishProgress('renaming', { artistPath: plan.artistPath, currentTarget: step.to })
            mappings.push({ from: step.from, to: step.to })
            executed.push({ from: step.from, to: step.to, journalIndex })
            result.succeeded.push({ path: step.from, targetPath: step.to, status: 'succeeded' })
            journal.steps[journalIndex].status = 'succeeded'
            journalIndex++
            await this.writeOperationJournal(journal)
          }
          restoreReferences = await this.updatePathReferences(mappings)
        } catch (error) {
          const reason = (error as Error).message
          result.failed.push({ path: plan.artistPath, status: 'failed', phase: 'renaming', reason })
          if (restoreReferences) {
            try { await restoreReferences() } catch (rollbackError) {
              result.rollbackFailed.push({ path: plan.artistPath, status: 'rollback_failed', phase: 'rollback', reason: `路径引用回滚失败：${(rollbackError as Error).message}` })
            }
          }
          let rollbackCompleted = 0
          const rollbackTotal = executed.length
          for (const step of [...executed].reverse()) {
            publishProgress('rollback', {
              artistPath: plan.artistPath,
              completed: rollbackCompleted,
              total: rollbackTotal,
              currentTarget: step.from,
            })
            try {
              await fs.rename(step.to, step.from)
              rollbackCompleted++
              publishProgress('rollback', {
                artistPath: plan.artistPath,
                completed: rollbackCompleted,
                total: rollbackTotal,
                currentTarget: step.from,
              })
              journal.steps[step.journalIndex].status = 'rolled_back'
              const succeeded = result.succeeded.find(item => item.path == step.from)
              if (succeeded) succeeded.status = 'rolled_back'
            } catch (rollbackError) {
              journal.steps[step.journalIndex].status = 'rollback_failed'
              journal.steps[step.journalIndex].reason = (rollbackError as Error).message
              result.rollbackFailed.push({ path: step.to, targetPath: step.from, status: 'rollback_failed', phase: 'rollback', reason: (rollbackError as Error).message })
            }
          }
          journalIndex += Math.max(0, plan.steps.length - executed.length)
          await this.writeOperationJournal(journal)
        }
      }
      if (result.rollbackFailed.length) {
        await this.writeOperationJournal(journal)
      } else {
        journal.completed = true
        await this.writeOperationJournal(journal)
        await this.clearOperationJournal()
      }
    } catch (error) {
      publishProgress('failed')
      throw error
    } finally {
      if (manageLock) this.operationRunning = false
    }
    if (options.refresh === false) {
      publishProgress('completed')
      return { result }
    }
    let rescanned: SongOrganizerSnapshot | undefined
    publishProgress('rescanning')
    try {
      rescanned = await this.scan({ root: snapshot.root })
    } catch (error) {
      result.failed.push({ path: snapshot.root, status: 'failed', phase: 'rescanning', reason: `自动重新扫描失败：${(error as Error).message}` })
    }
    publishProgress('completed')
    return { result, snapshot: rescanned }
  }

  async organize(params: SongOrganizerOrganizeApplyParams): Promise<ApplyResult> {
    const validation = this.assertCurrentValidation(params)
    if (this.operationRunning) throw new Error('已有磁盘操作正在进行。')
    const sourceSnapshot = this.assertCurrentSnapshot(params.taskId)
    const operationId = params.operationId ?? randomUUID()
    const result = completedResult(operationId, 'organize')
    this.operationRunning = true
    try {
      const preflight = await this.scanArtistsQuick(sourceSnapshot.root, params.artistPaths, params.taskId)
      try {
        this.assertCheckedAudioUnchanged(validation.audioFingerprints, preflight.audioFingerprints)
      } catch (error) {
        this.invalidateValidation(params.artistPaths[0], sourceSnapshot)
        throw error
      }
      let cleanupCompleted = false
      try {
        await this.cleanup(
          { ...params, operationId },
          { manageLock: false, refresh: false, snapshot: validation.snapshot, result },
        )
        cleanupCompleted = true
      } catch (error) {
        result.failed.push({
          path: params.artistPaths[0] ?? sourceSnapshot.root,
          status: 'failed',
          phase: 'cleanup',
          reason: `清理阶段失败：${(error as Error).message}`,
        })
      }
      if (cleanupCompleted && !result.failed.length && !result.rollbackFailed.length) {
        let recounted: SongOrganizerSnapshot | undefined
        try {
          recounted = (await this.scanArtistsQuick(sourceSnapshot.root, params.artistPaths, params.taskId)).snapshot
        } catch (error) {
          result.failed.push({
            path: sourceSnapshot.root,
            status: 'failed',
            phase: 'rescanning',
            reason: `清理后重新统计失败：${(error as Error).message}`,
          })
        }
        if (recounted) {
          try {
            await this.rename(
              { ...params, operationId },
              { manageLock: false, refresh: false, snapshot: recounted, result },
            )
          } catch (error) {
            result.failed.push({
              path: params.artistPaths[0] ?? sourceSnapshot.root,
              status: 'failed',
              phase: 'renaming',
              reason: `重命名阶段失败：${(error as Error).message}`,
            })
          }
        }
      }
      let refreshed: SongOrganizerSnapshot | undefined
      try {
        refreshed = await this.runQuickScan({ root: sourceSnapshot.root })
      } catch (error) {
        result.failed.push({
          path: sourceSnapshot.root,
          status: 'failed',
          phase: 'rescanning',
          reason: `轻量目录刷新失败：${(error as Error).message}`,
        })
      }
      return { result, snapshot: refreshed }
    } finally {
      this.operationRunning = false
    }
  }

  async recovery(): Promise<SongOrganizerJournal | null> {
    return readJournal()
  }

  async rollbackRecovery(operationId: string): Promise<SongOrganizerOperationResult> {
    if (this.operationRunning) throw new Error('已有磁盘操作正在进行。')
    const journal = await readJournal()
    if (!journal || journal.operationId != operationId) throw new Error('未找到对应的恢复记录。')
    if (journal.type != 'rename') throw new Error('清理操作只能由用户从 Windows 回收站恢复。')
    await assertSafeRoot(journal.root, this.protectedPaths())
    const result = completedResult(operationId, 'rename')
    this.operationRunning = true
    try {
      const reverseMappings: Array<{ from: string, to: string }> = []
      for (const step of [...journal.steps].reverse()) {
        if (step.status != 'succeeded' || !step.to) continue
        try {
          let sourceExists = true
          let targetExists = true
          try { await fs.lstat(step.to) } catch (error) { if ((error as NodeJS.ErrnoException).code == 'ENOENT') sourceExists = false; else throw error }
          try { await fs.lstat(step.from) } catch (error) { if ((error as NodeJS.ErrnoException).code == 'ENOENT') targetExists = false; else throw error }
          if (!sourceExists && targetExists) {
            step.status = 'rolled_back'
            continue
          }
          if (!sourceExists || targetExists) throw new Error('恢复源不存在或原路径已被占用。')
          await fs.rename(step.to, step.from)
          reverseMappings.push({ from: step.to, to: step.from })
          step.status = 'rolled_back'
          result.succeeded.push({ path: step.to, targetPath: step.from, status: 'rolled_back' })
          await this.writeOperationJournal(journal)
        } catch (error) {
          result.rollbackFailed.push({ path: step.to, targetPath: step.from, status: 'rollback_failed', reason: (error as Error).message })
        }
      }
      if (!result.rollbackFailed.length) {
        await this.updatePathReferences(reverseMappings)
        await this.clearOperationJournal()
      } else {
        await this.writeOperationJournal(journal)
      }
    } finally {
      this.operationRunning = false
    }
    return result
  }

  async dismissRecovery(operationId: string): Promise<boolean> {
    const journal = await readJournal()
    if (journal?.operationId == operationId) await this.clearOperationJournal()
    return journal?.operationId == operationId
  }
}

export const songOrganizerService = new SongOrganizerService()
export type { ApplyResult }
