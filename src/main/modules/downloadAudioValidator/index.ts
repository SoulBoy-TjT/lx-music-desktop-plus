import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DOWNLOAD_FLAC_REPAIR_OWNER_SUFFIX,
  DOWNLOAD_FLAC_REPAIR_SUFFIX,
  DOWNLOAD_PUBLICATION_PREFIX,
  DOWNLOAD_TRANSFER_SUFFIX,
  getDownloadFlacRepairOwnerPath,
  getDownloadFlacRepairPath,
} from '@common/downloadArtifactPaths'
import { isAudioFfmpegAvailable, resolveBundledAudioFfmpegPath } from '../audioFfmpeg'
import { AudioFfmpegTerminationError, terminateAudioFfmpegProcess } from '../audioFfmpeg/processTermination'
import { findRepairableFlacTrailingData } from './flacTrailingData'

export interface DownloadAudioValidationParams {
  taskId: string
  filePath: string
  allowNormalization?: boolean
}

export interface DownloadAudioValidationResult {
  status: 'valid' | 'cancelled'
  normalizedPath?: string
}

interface DownloadAudioFfmpegPathOptions {
  platform?: NodeJS.Platform
  bundledPath?: string
  bundledAvailable?: (candidate: string) => Promise<boolean>
  resolveCommand?: () => Promise<string | null>
}

const resolveCommand = async(platform = process.platform): Promise<string | null> => {
  const command = platform == 'win32' ? 'where.exe' : 'which'
  return await new Promise(resolve => {
    execFile(command, ['ffmpeg'], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      resolve(String(stdout).split(/\r?\n/u).map(value => value.trim()).find(Boolean) ?? null)
    })
  })
}

export const resolveDownloadAudioFfmpegPath = async(
  options: DownloadAudioFfmpegPathOptions = {},
): Promise<string | null> => {
  const platform = options.platform ?? process.platform
  const bundledPath = options.bundledPath ?? resolveBundledAudioFfmpegPath()
  const bundledAvailable = options.bundledAvailable ?? isAudioFfmpegAvailable
  if (platform == 'win32') return await bundledAvailable(bundledPath) ? bundledPath : null
  return await (options.resolveCommand ?? (async() => resolveCommand(platform)))()
}

interface ValidatedAudioArtifact {
  normalizedPath?: string
}

type ValidateAudio = (
  ffmpegPath: string,
  filePath: string,
  signal: AbortSignal,
) => Promise<ValidatedAudioArtifact>

interface DownloadAudioDecodeEvidence {
  decodedBytes: number
  decodedHash: string
}

class DownloadAudioDecodeError extends Error {
  constructor(message: string, readonly decodedBytes: number, readonly decodedHash: string) {
    super(message)
  }
}

const decodeAudioWithFfmpeg = async(
  ffmpegPath: string,
  filePath: string,
  signal: AbortSignal,
  spawnAudioProcess: typeof spawn = spawn,
): Promise<DownloadAudioDecodeEvidence> => {
  if (signal.aborted) throw signal.reason
  return await new Promise<DownloadAudioDecodeEvidence>((resolve, reject) => {
    let stderr = ''
    let decodedBytes = 0
    const decodedHash = createHash('sha256')
    let settled = false
    let stopping = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child: ChildProcess = spawnAudioProcess(ffmpegPath, [
      '-v', 'error',
      '-xerror',
      '-err_detect', 'crccheck+explode',
      '-nostdin',
      '-i', filePath,
      '-map', '0:a:0',
      '-vn', '-sn', '-dn',
      '-f', 's16le',
      '-',
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const finish = (error?: unknown, evidence?: DownloadAudioDecodeEvidence) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve(evidence!)
    }
    const stopAndFinish = async(error: unknown) => {
      if (stopping || settled) return
      stopping = true
      try {
        await terminateAudioFfmpegProcess(child)
        finish(error)
      } catch (terminationError) {
        finish(terminationError)
      }
    }
    const onAbort = () => { void stopAndFinish(signal.reason ?? new Error('下载音频验证已取消。')) }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      void stopAndFinish(new Error('FFmpeg decode timeout'))
    }, 15 * 60 * 1_000)
    child.stdout?.on('data', chunk => {
      const buffer = chunk as Buffer
      decodedBytes += buffer.length
      decodedHash.update(buffer)
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < 16_384) stderr += String(chunk)
    })
    child.once('error', error => {
      if (!stopping) finish(error)
    })
    child.once('close', code => {
      if (stopping) return
      const digest = decodedHash.digest('hex')
      if (code === 0 && decodedBytes > 0) {
        finish(undefined, { decodedBytes, decodedHash: digest })
        return
      }
      finish(new DownloadAudioDecodeError(stderr.trim() || (decodedBytes === 0
        ? 'No decoded audio samples'
        : `FFmpeg exited with code ${code ?? 'unknown'}`), decodedBytes, digest))
    })
  })
}

const repairPathLocks = new Map<string, Promise<void>>()
const artifactCleanupRetryDelays = [10, 25, 50, 100]
const flacRepairOwnerMarker = Buffer.from('lx-music-desktop:flac-tail-normalizing:v1\n', 'utf8')
const randomUuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'

class DownloadAudioArtifactCleanupError extends Error {
  constructor(readonly filePath: string, cause: unknown) {
    super(`Unable to remove normalized download artifact: ${filePath}`, { cause })
  }
}

const isFatalDownloadAudioError = (
  error: unknown,
): error is AudioFfmpegTerminationError | DownloadAudioArtifactCleanupError => (
  error instanceof AudioFfmpegTerminationError || error instanceof DownloadAudioArtifactCleanupError
)

const normalizePathKey = (filePath: string): string => {
  const resolved = path.resolve(filePath)
  return process.platform == 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

const isOwnedDownloadStagingPath = (sourcePaths: Set<string>, candidatePath: string): boolean => {
  const candidateKey = normalizePathKey(candidatePath)
  return [...sourcePaths].some(sourcePath => {
    const sourceKey = normalizePathKey(sourcePath)
    if (!sourceKey.endsWith(DOWNLOAD_TRANSFER_SUFFIX)) return false
    const baseKey = sourceKey.slice(0, -DOWNLOAD_TRANSFER_SUFFIX.length)
    return ['mp3', 'flac', 'wav', 'ape'].some(ext => candidateKey === `${baseKey}${DOWNLOAD_PUBLICATION_PREFIX}${ext}`)
  })
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (!signal.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'Download audio validation cancelled'))
}

const removeDownloadArtifact = async(filePath: string): Promise<void> => {
  let firstError: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(filePath, { force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) {
        throw new DownloadAudioArtifactCleanupError(filePath, error)
      }
      firstError ??= error
      const delay = artifactCleanupRetryDelays[attempt]
      if (delay == null) throw new DownloadAudioArtifactCleanupError(filePath, firstError)
      await new Promise<void>(resolve => { setTimeout(resolve, delay) })
    }
  }
}

const removeNormalizedArtifact = async(filePath: string): Promise<void> => {
  await removeDownloadArtifact(filePath)
  if (filePath.endsWith(DOWNLOAD_FLAC_REPAIR_SUFFIX)) {
    await removeDownloadArtifact(getDownloadFlacRepairOwnerPath(filePath))
  }
}

const createFlacRepairOwnerMarker = async(repairPath: string): Promise<void> => {
  const ownerPath = getDownloadFlacRepairOwnerPath(repairPath)
  const marker = await fs.open(ownerPath, 'wx')
  let markerError: unknown
  try {
    await marker.writeFile(flacRepairOwnerMarker)
    await marker.sync()
  } catch (error) {
    markerError = error
  }
  try {
    await marker.close()
  } catch (error) {
    markerError ??= error
  }
  if (!markerError) return
  await removeDownloadArtifact(ownerPath)
  throw markerError instanceof Error ? markerError : new Error(String(markerError))
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

const isFilePrefix = async(
  sourcePath: string,
  candidatePath: string,
  signal: AbortSignal,
): Promise<boolean> => {
  const [sourceStat, candidateStat] = await Promise.all([
    fs.lstat(sourcePath),
    fs.lstat(candidatePath),
  ])
  if (!sourceStat.isFile() || !candidateStat.isFile() || candidateStat.size >= sourceStat.size) return false
  if (candidateStat.size === 0) return true
  const source = await fs.open(sourcePath, 'r')
  const candidate = await fs.open(candidatePath, 'r')
  try {
    const bufferSize = Math.min(1024 * 1024, candidateStat.size)
    const sourceBuffer = Buffer.allocUnsafe(bufferSize)
    const candidateBuffer = Buffer.allocUnsafe(bufferSize)
    let offset = 0
    while (offset < candidateStat.size) {
      throwIfAborted(signal)
      const requested = Math.min(bufferSize, candidateStat.size - offset)
      const [sourceRead, candidateRead] = await Promise.all([
        source.read(sourceBuffer, 0, requested, offset),
        candidate.read(candidateBuffer, 0, requested, offset),
      ])
      if (sourceRead.bytesRead !== requested || candidateRead.bytesRead !== requested ||
        !sourceBuffer.subarray(0, requested).equals(candidateBuffer.subarray(0, requested))) return false
      offset += requested
    }
    return true
  } finally {
    await Promise.allSettled([source.close(), candidate.close()])
  }
}

const removeOwnedFlacRepairOrphans = async(filePath: string, signal: AbortSignal): Promise<void> => {
  const directory = path.dirname(filePath)
  const sourceFileName = path.basename(filePath)
  const ownerPattern = new RegExp(
    `^${escapeRegExp(sourceFileName)}\\.${randomUuidPattern}` +
    `${escapeRegExp(DOWNLOAD_FLAC_REPAIR_SUFFIX + DOWNLOAD_FLAC_REPAIR_OWNER_SUFFIX)}$`,
    process.platform === 'win32' ? 'iu' : 'u',
  )
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    throwIfAborted(signal)
    if (!entry.isFile() || !ownerPattern.test(entry.name)) continue
    const ownerPath = path.join(directory, entry.name)
    const ownerStat = await fs.lstat(ownerPath)
    if (!ownerStat.isFile() || ownerStat.size !== flacRepairOwnerMarker.length) continue
    const marker = await fs.readFile(ownerPath)
    if (!marker.equals(flacRepairOwnerMarker)) continue
    const repairPath = ownerPath.slice(0, -DOWNLOAD_FLAC_REPAIR_OWNER_SUFFIX.length)
    let repairExists = true
    try {
      await fs.lstat(repairPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      repairExists = false
    }
    if (!repairExists) {
      await removeDownloadArtifact(ownerPath)
      continue
    }
    if (await isFilePrefix(filePath, repairPath, signal)) {
      await removeNormalizedArtifact(repairPath)
    }
  }
}

const withRepairPathLock = async<T>(filePath: string, action: () => Promise<T>): Promise<T> => {
  const key = normalizePathKey(filePath)
  const previous = repairPathLocks.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(action)
  const settled = operation.then(() => {}, () => {})
  repairPathLocks.set(key, settled)
  try {
    return await operation
  } finally {
    if (repairPathLocks.get(key) === settled) repairPathLocks.delete(key)
  }
}

const copyFilePrefix = async(
  sourcePath: string,
  targetPath: string,
  length: number,
  signal: AbortSignal,
  onTargetCreated?: () => void,
): Promise<void> => {
  const source = await fs.open(sourcePath, 'r')
  let target: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    target = await fs.open(targetPath, 'wx')
    onTargetCreated?.()
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, length))
    let readOffset = 0
    while (readOffset < length) {
      throwIfAborted(signal)
      const requested = Math.min(buffer.length, length - readOffset)
      const { bytesRead } = await source.read(buffer, 0, requested, readOffset)
      if (bytesRead === 0) throw new Error('Unexpected end of FLAC while removing trailing data')
      let written = 0
      while (written < bytesRead) {
        throwIfAborted(signal)
        const result = await target.write(buffer, written, bytesRead - written, readOffset + written)
        if (result.bytesWritten === 0) throw new Error('Unable to write normalized FLAC')
        written += result.bytesWritten
      }
      readOffset += bytesRead
    }
    await target.sync()
  } finally {
    await Promise.allSettled([source.close(), target?.close() ?? Promise.resolve()])
  }
}

const validateAndNormalizeAudioWithFfmpeg = async(
  ffmpegPath: string,
  filePath: string,
  signal: AbortSignal,
  spawnAudioProcess: typeof spawn = spawn,
): Promise<ValidatedAudioArtifact> => {
  return await withRepairPathLock(filePath, async() => {
    throwIfAborted(signal)
    let initialError: DownloadAudioDecodeError
    try {
      await decodeAudioWithFfmpeg(ffmpegPath, filePath, signal, spawnAudioProcess)
      return {}
    } catch (error) {
      if (!(error instanceof DownloadAudioDecodeError)) throw error
      initialError = error
    }
    await removeOwnedFlacRepairOrphans(filePath, signal)
    const repairPath = getDownloadFlacRepairPath(filePath, randomUUID())
    let keepRepair = false
    let ownerCreated = false
    let repairCreated = false
    try {
      const evidence = await findRepairableFlacTrailingData(filePath, initialError.decodedBytes, signal)
      if (!evidence) throw initialError
      await createFlacRepairOwnerMarker(repairPath)
      ownerCreated = true
      for (const candidate of evidence.candidates) {
        await copyFilePrefix(filePath, repairPath, candidate.endOffset, signal, () => { repairCreated = true })
        let normalized: DownloadAudioDecodeEvidence
        try {
          normalized = await decodeAudioWithFfmpeg(ffmpegPath, repairPath, signal, spawnAudioProcess)
        } catch (error) {
          if (!(error instanceof DownloadAudioDecodeError)) throw error
          await removeDownloadArtifact(repairPath)
          repairCreated = false
          continue
        }
        if (BigInt(normalized.decodedBytes) === evidence.expectedDecodedBytes &&
          normalized.decodedHash === initialError.decodedHash) {
          throwIfAborted(signal)
          keepRepair = true
          return { normalizedPath: repairPath }
        }
        await removeDownloadArtifact(repairPath)
        repairCreated = false
      }
      throw initialError
    } finally {
      if (!keepRepair) {
        if (repairCreated) await removeNormalizedArtifact(repairPath)
        else if (ownerCreated) await removeDownloadArtifact(getDownloadFlacRepairOwnerPath(repairPath))
      }
    }
  })
}

interface DownloadAudioValidatorDependencies {
  resolveFfmpegPath?: () => Promise<string | null>
  validateAudio?: ValidateAudio
  removeNormalizedArtifact?: (filePath: string) => Promise<void>
  spawnAudioProcess?: typeof spawn
}

interface ActiveValidation {
  controller: AbortController
  settled: Promise<{ error?: unknown }>
  settle: (result: { error?: unknown }) => void
  validationRunning: boolean
  normalizedPaths: Set<string>
  sourcePaths: Set<string>
  finishPromise?: Promise<void>
  operationError?: unknown
}

export class DownloadAudioValidatorService {
  private readonly active = new Map<string, ActiveValidation>()
  private readonly cancelled = new Set<string>()
  private shuttingDown = false
  private terminationFailure?: AudioFfmpegTerminationError | DownloadAudioArtifactCleanupError
  private readonly resolveFfmpegPath: () => Promise<string | null>
  private readonly validateAudio: ValidateAudio
  private readonly removeNormalizedArtifact: (filePath: string) => Promise<void>

  constructor(dependencies: DownloadAudioValidatorDependencies = {}) {
    this.resolveFfmpegPath = dependencies.resolveFfmpegPath ?? resolveDownloadAudioFfmpegPath
    this.validateAudio = dependencies.validateAudio ?? (async(ffmpegPath, filePath, signal) => {
      return await validateAndNormalizeAudioWithFfmpeg(
        ffmpegPath,
        filePath,
        signal,
        dependencies.spawnAudioProcess,
      )
    })
    this.removeNormalizedArtifact = dependencies.removeNormalizedArtifact ?? removeNormalizedArtifact
  }

  isBusy(): boolean {
    return this.active.size > 0
  }

  getTerminationFailure(): AudioFfmpegTerminationError | DownloadAudioArtifactCleanupError | undefined {
    return this.terminationFailure
  }

  beginTask(taskId: string): LX.Download.DownloadAudioLifecycleResult {
    if (this.shuttingDown || this.cancelled.has(taskId)) return { status: 'cancelled' }
    if (this.active.has(taskId)) throw new Error(`Download audio publication task already exists: ${taskId}`)
    let settle!: ActiveValidation['settle']
    const settled = new Promise<{ error?: unknown }>(resolve => { settle = resolve })
    this.active.set(taskId, {
      controller: new AbortController(),
      settled,
      settle,
      validationRunning: false,
      normalizedPaths: new Set(),
      sourcePaths: new Set(),
    })
    return { status: 'active' }
  }

  async finishTask(
    taskId: string,
    options: LX.Download.DownloadAudioTaskFinishOptions = { sourceDisposition: 'preserve' },
  ): Promise<void> {
    const operation = this.active.get(taskId)
    if (!operation) return
    operation.finishPromise ??= (async() => {
      let cleanupError: DownloadAudioArtifactCleanupError | undefined
      const cleanupPaths = new Set(operation.normalizedPaths)
      if (options.sourceDisposition === 'discard') {
        for (const sourcePath of operation.sourcePaths) cleanupPaths.add(sourcePath)
      }
      for (const artifactPath of options.artifactPathsToDiscard ?? []) {
        if (isOwnedDownloadStagingPath(operation.sourcePaths, artifactPath)) {
          cleanupPaths.add(artifactPath)
        } else {
          cleanupError ??= new DownloadAudioArtifactCleanupError(
            artifactPath,
            new Error('Untrusted download staging artifact path'),
          )
        }
      }
      for (const normalizedPath of cleanupPaths) {
        try {
          await this.removeNormalizedArtifact(normalizedPath)
        } catch (error) {
          cleanupError ??= error as DownloadAudioArtifactCleanupError
        }
      }
      if (cleanupError) {
        this.terminationFailure ??= cleanupError
        operation.operationError = cleanupError
      }
      this.active.delete(taskId)
      operation.settle({ error: operation.operationError })
      if (cleanupError) throw cleanupError
    })()
    try {
      await operation.finishPromise
    } finally {
      if (this.active.get(taskId) !== operation) operation.finishPromise = undefined
    }
  }

  isTaskCancelled(taskId: string): boolean {
    return this.shuttingDown || this.cancelled.has(taskId) || this.active.get(taskId)?.controller.signal.aborted === true
  }

  resetTask(taskId: string): void {
    if (this.shuttingDown) return
    if (this.active.has(taskId)) throw new Error(`Cannot reset an active download publication task: ${taskId}`)
    this.cancelled.delete(taskId)
  }

  beginShutdown(): void {
    this.shuttingDown = true
  }

  endShutdown(): void {
    this.shuttingDown = false
  }

  async validate(params: DownloadAudioValidationParams): Promise<DownloadAudioValidationResult> {
    if (this.terminationFailure) throw this.terminationFailure
    if (this.shuttingDown || this.cancelled.has(params.taskId)) return { status: 'cancelled' }
    const isImplicitTask = !this.active.has(params.taskId)
    if (isImplicitTask && this.beginTask(params.taskId).status == 'cancelled') return { status: 'cancelled' }
    const operation = this.active.get(params.taskId)!
    if (operation.validationRunning) throw new Error(`Download audio validation already exists: ${params.taskId}`)
    operation.validationRunning = true
    if (!isImplicitTask) operation.sourcePaths.add(params.filePath)
    const { controller } = operation
    let operationError: unknown
    try {
      const ffmpegPath = await this.resolveFfmpegPath()
      if (controller.signal.aborted) return { status: 'cancelled' }
      if (!ffmpegPath) throw new Error('FFmpeg 不可用，无法完整验证下载音频。')
      const artifact = await this.validateAudio(ffmpegPath, params.filePath, controller.signal)
      if (artifact.normalizedPath && params.allowNormalization === false) {
        await this.removeNormalizedArtifact(artifact.normalizedPath)
        throw new Error('Published audio requires normalization before it can be accepted')
      }
      if (controller.signal.aborted) {
        if (artifact.normalizedPath) await this.removeNormalizedArtifact(artifact.normalizedPath)
        return { status: 'cancelled' }
      }
      if (!isImplicitTask && artifact.normalizedPath) {
        operation.normalizedPaths.add(artifact.normalizedPath)
      }
      return { status: 'valid', normalizedPath: artifact.normalizedPath }
    } catch (error) {
      if (isFatalDownloadAudioError(error)) {
        this.terminationFailure ??= error
        operationError = error
        operation.operationError = error
        throw error
      }
      if (controller.signal.aborted) return { status: 'cancelled' }
      operationError = error
      throw error
    } finally {
      operation.validationRunning = false
      if (operationError) operation.operationError = operationError
      if (isImplicitTask) await this.finishTask(params.taskId)
    }
  }

  async cancelAndWait(taskId?: string): Promise<boolean> {
    if (taskId == null) this.beginShutdown()
    if (taskId) this.cancelled.add(taskId)
    const targets = taskId
      ? [...this.active.entries()].filter(([id]) => id == taskId)
      : [...this.active.entries()]
    if (!targets.length) {
      if (this.terminationFailure) throw this.terminationFailure
      return taskId != null
    }
    for (const [id, operation] of targets) {
      this.cancelled.add(id)
      operation.controller.abort(new Error('下载音频验证已取消。'))
    }
    const results = await Promise.all(targets.map(async([, operation]) => await operation.settled))
    const terminationError = results
      .map(result => result.error)
      .find(isFatalDownloadAudioError) ??
      this.terminationFailure
    if (terminationError) throw terminationError
    return true
  }
}

export const downloadAudioValidatorService = new DownloadAudioValidatorService()
