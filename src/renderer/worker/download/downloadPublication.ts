import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import {
  DOWNLOAD_FLAC_REPAIR_SUFFIX,
  DOWNLOAD_PUBLICATION_PREFIX,
  DOWNLOAD_TRANSFER_SUFFIX,
} from '@common/downloadArtifactPaths'

interface DownloadPublicationInput {
  transferPath: string
  filePath: string
  fileName: string
  ext: LX.Download.FileExt
  quality: LX.Quality
  validate: (filePath: string) => Promise<LX.Download.DownloadAudioValidationResult>
  artifactCleanupOwner?: 'worker' | 'lifecycle'
}

type DownloadActualFormat = LX.Download.DownloadActualFormat
export type DownloadPublicationResult = LX.Download.DownloadPublication

const LOSSLESS_QUALITIES = new Set<LX.Quality>(['flac', 'flac24bit', 'wav', 'ape'])
const QUALITY_RANK: Record<LX.Quality, number> = {
  '128k': 128,
  '192k': 192,
  '320k': 320,
  flac: 1_000,
  ape: 1_000,
  wav: 1_000,
  flac24bit: 2_000,
}
const publicationCleanupRetryDelays = [10, 25, 50, 100]

export class DownloadPublicationCleanupError extends Error {
  readonly code: string

  constructor(readonly filePath: string, cause: unknown) {
    super(`Unable to remove temporary download artifact: ${filePath}`, { cause })
    this.code = (cause as NodeJS.ErrnoException).code ?? 'EIO'
  }
}

const removePublicationArtifact = async(filePath: string): Promise<void> => {
  let firstError: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rm(filePath, { force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) {
        throw new DownloadPublicationCleanupError(filePath, error)
      }
      firstError ??= error
      const delay = publicationCleanupRetryDelays[attempt]
      if (delay == null) throw new DownloadPublicationCleanupError(filePath, firstError)
      await new Promise<void>(resolve => { setTimeout(resolve, delay) })
    }
  }
}

const removePublicationArtifacts = async(filePaths: string[]): Promise<void> => {
  const results = await Promise.allSettled([...new Set(filePaths)].map(removePublicationArtifact))
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
}

const createExistsError = (filePath: string): NodeJS.ErrnoException => {
  const error = new Error(`Target already exists: ${filePath}`) as NodeJS.ErrnoException
  error.code = 'EEXIST'
  return error
}

const moveFileWithWindowsNoClobber = async(sourcePath: string, targetPath: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    let stderr = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      error ? reject(error) : resolve()
    }
    const command = Buffer.from(
      "$ErrorActionPreference = 'Stop'; [System.IO.File]::Move($env:LX_MOVE_SOURCE_PATH, $env:LX_MOVE_TARGET_PATH)",
      'utf16le',
    ).toString('base64')
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      command,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        LX_MOVE_SOURCE_PATH: sourcePath,
        LX_MOVE_TARGET_PATH: targetPath,
      },
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < 16_384) stderr += String(chunk)
    })
    child.once('error', error => {
      finish(error)
    })
    child.once('close', code => {
      if (code === 0) {
        finish()
        return
      }
      void Promise.all([
        fs.promises.lstat(sourcePath).then(() => true).catch(() => false),
        fs.promises.lstat(targetPath).then(() => true).catch(() => false),
      ]).then(([sourceExists, targetExists]) => {
        finish(sourceExists && targetExists
          ? createExistsError(targetPath)
          : new Error(stderr.trim() || `Windows no-clobber move exited with code ${code ?? 'unknown'}`))
      }, error => {
        finish(error as Error)
      })
    })
  })
}

export const moveFileWithoutOverwrite = async(sourcePath: string, targetPath: string): Promise<void> => {
  if (process.platform === 'win32') {
    await moveFileWithWindowsNoClobber(sourcePath, targetPath)
    return
  }
  await fs.promises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
  try {
    await fs.promises.unlink(sourcePath)
  } catch (error) {
    await fs.promises.rm(targetPath, { force: true }).catch(() => {})
    throw error
  }
}

const assertPathMissing = async(filePath: string): Promise<void> => {
  try {
    await fs.promises.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw createExistsError(filePath)
}

const replaceExtension = (value: string, ext: LX.Download.FileExt): string => {
  const parsed = path.parse(value)
  return path.join(parsed.dir, `${parsed.name}.${ext}`)
}

const getArtifactBase = (filePath: string): string => {
  const parsed = path.parse(filePath)
  return path.join(parsed.dir, parsed.name)
}

export const getDownloadTransferPath = (plannedFilePath: string): string => `${getArtifactBase(plannedFilePath)}${DOWNLOAD_TRANSFER_SUFFIX}`

const getDownloadStagingPath = (plannedFilePath: string, actualExt: LX.Download.FileExt): string => {
  return `${getArtifactBase(plannedFilePath)}${DOWNLOAD_PUBLICATION_PREFIX}${actualExt}`
}

export const getDownloadLyricPublication = (finalAudioPath: string): LX.Download.DownloadPublicationSidecar => {
  const artifactBase = getArtifactBase(finalAudioPath)
  return {
    filePath: `${artifactBase}.lrc`,
    stagingPath: `${artifactBase}${DOWNLOAD_PUBLICATION_PREFIX}lrc`,
  }
}

const normalizeBitrate = (bitrate: number | undefined): number | undefined => {
  return bitrate != null && Number.isFinite(bitrate) && bitrate > 0 ? Math.round(bitrate) : undefined
}

export const inspectDownloadedAudio = async(filePath: string): Promise<DownloadActualFormat> => {
  const metadata = await parseFile(filePath, { duration: true, skipCovers: true })
  const format = metadata.format
  const container = format.container?.toLowerCase()
  const codec = format.codec?.toLowerCase()
  const bitrate = normalizeBitrate(format.bitrate)
  const bitsPerSample = format.bitsPerSample

  if (format.hasAudio !== true) throw new Error('Missing audio stream')
  if (container === 'mpeg' && codec?.includes('layer 3') && bitrate) {
    return {
      container: 'mp3',
      codec: 'mp3',
      bitrate,
      bitrateMode: format.codecProfile?.toLowerCase() === 'cbr' ? 'cbr' : format.codecProfile ? 'vbr' : undefined,
    }
  }
  if (container === 'flac' && codec === 'flac' && bitsPerSample != null && bitsPerSample >= 4 && bitsPerSample <= 32) {
    return {
      container: 'flac',
      codec: 'flac',
      bitrate,
      bitsPerSample,
    }
  }
  if (container === 'wave' && codec === 'pcm' && bitsPerSample != null && bitsPerSample > 0) {
    return {
      container: 'wav',
      codec: 'pcm',
      bitrate,
      bitsPerSample,
    }
  }
  if (container === "monkey's audio" && format.lossless === true && bitsPerSample != null && bitsPerSample > 0) {
    return {
      container: 'ape',
      codec: 'ape',
      bitrate,
      bitsPerSample,
    }
  }
  throw new Error(`Unsupported audio metadata: ${format.container ?? 'unknown'} / ${format.codec ?? 'unknown'}`)
}

const pathExists = async(filePath: string): Promise<boolean> => {
  try {
    await fs.promises.lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export const inspectDownloadPublicationPaths = async(
  publication: Pick<DownloadPublicationResult, 'stagingPath' | 'filePath'>,
): Promise<{ stagingExists: boolean, finalExists: boolean }> => {
  const [stagingExists, finalExists] = await Promise.all([
    pathExists(publication.stagingPath),
    pathExists(publication.filePath),
  ])
  return { stagingExists, finalExists }
}

export const verifyDownloadedAudioFormat = async(
  filePath: string,
  expected: DownloadActualFormat,
): Promise<DownloadActualFormat> => {
  const actual = await inspectDownloadedAudio(filePath)
  if (actual.container !== expected.container || actual.codec !== expected.codec) {
    throw new Error(`Published audio format changed: expected ${expected.container}/${expected.codec}, got ${actual.container}/${actual.codec}`)
  }
  if (expected.bitsPerSample != null && actual.bitsPerSample !== expected.bitsPerSample) {
    throw new Error(`Published audio bit depth changed: expected ${expected.bitsPerSample}, got ${actual.bitsPerSample ?? 'unknown'}`)
  }
  return actual
}

export const resolveActualQuality = (actualFormat: DownloadActualFormat): LX.Quality => {
  switch (actualFormat.container) {
    case 'mp3':
      if ((actualFormat.bitrate ?? 0) >= 320_000) return '320k'
      if ((actualFormat.bitrate ?? 0) >= 192_000) return '192k'
      return '128k'
    case 'flac':
      return (actualFormat.bitsPerSample ?? 0) > 16 ? 'flac24bit' : 'flac'
    case 'wav':
      return 'wav'
    case 'ape':
      return 'ape'
  }
}

export const resolveFormatDowngrade = (
  requestedQuality: LX.Quality,
  actualQuality: LX.Quality,
  actualFormat: DownloadActualFormat,
): LX.Download.DownloadFormatDowngrade | undefined => {
  if (LOSSLESS_QUALITIES.has(requestedQuality) && actualFormat.container === 'mp3') {
    return { reason: 'lossless_unavailable', requestedQuality, actualQuality }
  }
  if (QUALITY_RANK[actualQuality] < QUALITY_RANK[requestedQuality]) {
    return { reason: 'quality_downgrade', requestedQuality, actualQuality }
  }
  return undefined
}

const moveToStagingWithoutOverwrite = async(sourcePath: string, stagingPath: string): Promise<void> => {
  await assertPathMissing(stagingPath)
  await moveFileWithoutOverwrite(sourcePath, stagingPath)
}

const copyToStagingWithoutOverwrite = async(sourcePath: string, stagingPath: string): Promise<void> => {
  await assertPathMissing(stagingPath)
  await fs.promises.copyFile(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL)
}

const normalizePathForComparison = (filePath: string): string => {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

export const prepareDownloadedAudio = async(input: DownloadPublicationInput): Promise<DownloadPublicationResult> => {
  let actualFormat: DownloadActualFormat
  let normalizedPath: string | undefined
  let artifactPath = input.transferPath
  try {
    const validation = await input.validate(input.transferPath)
    if (validation.status === 'cancelled') {
      const error = new Error('Downloaded audio validation cancelled') as NodeJS.ErrnoException
      error.code = 'ECANCELED'
      throw error
    }
    const candidateNormalizedPath = validation.normalizedPath
    if (candidateNormalizedPath) {
      const transferDirectory = normalizePathForComparison(path.dirname(input.transferPath))
      const normalizedDirectory = normalizePathForComparison(path.dirname(candidateNormalizedPath))
      const normalizedFileName = path.basename(candidateNormalizedPath)
      const expectedPrefix = `${path.basename(input.transferPath)}.`
      if (transferDirectory !== normalizedDirectory ||
        normalizePathForComparison(candidateNormalizedPath) === normalizePathForComparison(input.transferPath) ||
        !normalizedFileName.startsWith(expectedPrefix) ||
        !normalizedFileName.endsWith(DOWNLOAD_FLAC_REPAIR_SUFFIX)) {
        throw new Error('Invalid normalized download artifact path')
      }
      normalizedPath = candidateNormalizedPath
      artifactPath = candidateNormalizedPath
    }
    actualFormat = await inspectDownloadedAudio(artifactPath)
  } catch (error) {
    let cleanupError: unknown
    if (input.artifactCleanupOwner !== 'lifecycle') {
      const cleanupPaths = normalizedPath ? [normalizedPath] : []
      if ((error as NodeJS.ErrnoException).code !== 'ECANCELED') cleanupPaths.push(input.transferPath)
      try {
        await removePublicationArtifacts(cleanupPaths)
      } catch (currentCleanupError) {
        cleanupError = currentCleanupError
      }
    }
    const message = `Unsupported or damaged downloaded audio: ${(error as Error).message}` +
      (cleanupError ? `; ${(cleanupError as Error).message}` : '')
    const wrapped = new Error(message, { cause: cleanupError ?? error }) as NodeJS.ErrnoException
    wrapped.code = (cleanupError as NodeJS.ErrnoException | undefined)?.code ?? (error as NodeJS.ErrnoException).code
    throw wrapped
  }

  const actualExt = actualFormat.container
  const filePath = replaceExtension(input.filePath, actualExt)
  const fileName = replaceExtension(input.fileName, actualExt)
  const stagingPath = getDownloadStagingPath(input.filePath, actualExt)
  const quality = resolveActualQuality(actualFormat)
  let stagingCreated = false
  try {
    await assertPathMissing(filePath)
    if (normalizedPath) {
      await moveToStagingWithoutOverwrite(artifactPath, stagingPath)
    } else {
      await copyToStagingWithoutOverwrite(artifactPath, stagingPath)
    }
    stagingCreated = true
  } catch (error) {
    if (!stagingCreated && (error as NodeJS.ErrnoException).code !== 'EEXIST') {
      stagingCreated = await pathExists(stagingPath)
    }
    const cleanupPaths = stagingCreated ? [stagingPath] : []
    if (input.artifactCleanupOwner !== 'lifecycle') cleanupPaths.push(artifactPath, input.transferPath)
    await removePublicationArtifacts(cleanupPaths)
    throw error
  }

  return {
    filePath,
    fileName,
    stagingPath,
    ext: actualExt,
    quality,
    actualFormat,
    downgrade: resolveFormatDowngrade(input.quality, quality, actualFormat),
  }
}

export const discardDownloadedAudio = async(
  publication: Pick<DownloadPublicationResult, 'stagingPath'>,
  sidecar?: LX.Download.DownloadPublicationSidecar,
): Promise<void> => {
  await Promise.all([
    removePublicationArtifact(publication.stagingPath),
    sidecar ? removePublicationArtifact(sidecar.stagingPath) : Promise.resolve(),
  ])
}

export const commitDownloadedAudio = async(
  publication: Pick<DownloadPublicationResult, 'stagingPath' | 'filePath'>,
  sidecar?: LX.Download.DownloadPublicationSidecar,
): Promise<void> => {
  let audioPublished = false
  let sidecarPublished = false
  try {
    await assertPathMissing(publication.filePath)
    if (sidecar) await assertPathMissing(sidecar.filePath)
    if (process.platform === 'win32') {
      await moveFileWithoutOverwrite(publication.stagingPath, publication.filePath)
      audioPublished = true
      if (sidecar) {
        await moveFileWithoutOverwrite(sidecar.stagingPath, sidecar.filePath)
        sidecarPublished = true
      }
    } else {
      await fs.promises.copyFile(publication.stagingPath, publication.filePath, fs.constants.COPYFILE_EXCL)
      audioPublished = true
      if (sidecar) {
        await fs.promises.copyFile(sidecar.stagingPath, sidecar.filePath, fs.constants.COPYFILE_EXCL)
        sidecarPublished = true
      }
      await discardDownloadedAudio(publication, sidecar)
    }
  } catch (error) {
    if (sidecarPublished && sidecar) await fs.promises.rm(sidecar.filePath, { force: true }).catch(() => {})
    if (audioPublished) await fs.promises.rm(publication.filePath, { force: true }).catch(() => {})
    const conflictPath = await Promise.all([
      fs.promises.lstat(publication.filePath).then(() => publication.filePath).catch(() => null),
      sidecar ? fs.promises.lstat(sidecar.filePath).then(() => sidecar.filePath).catch(() => null) : Promise.resolve(null),
    ]).then(paths => paths.find((candidate): candidate is string => candidate != null))
    await discardDownloadedAudio(publication, sidecar).catch(() => {})
    if (conflictPath) throw createExistsError(conflictPath)
    throw error
  }
}

export const finalizeDownloadedAudio = async(
  publication: DownloadPublicationResult,
  writeMetadata: (stagingPath: string) => Promise<void>,
): Promise<void> => {
  try {
    await writeMetadata(publication.stagingPath)
    await commitDownloadedAudio(publication)
  } catch (error) {
    await discardDownloadedAudio(publication).catch(() => {})
    throw error
  }
}
