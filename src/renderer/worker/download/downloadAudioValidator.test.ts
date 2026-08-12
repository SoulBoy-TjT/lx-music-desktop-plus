import { AudioFfmpegTerminationError, terminateAudioFfmpegProcess } from '../../../main/modules/audioFfmpeg/processTermination'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChildProcess, spawn as spawnAudioProcess } from 'node:child_process'
import { AppExitCoordinator } from '../../../main/modules/appExitCoordinator'
import {
  DownloadAudioValidatorService,
  resolveDownloadAudioFfmpegPath,
} from '../../../main/modules/downloadAudioValidator'
import { describe, expect, it, vi } from 'vitest'
import { getAudioFixture } from './__fixtures__/audioFixtures'
import {
  DOWNLOAD_TRANSFER_SUFFIX,
  MAX_DOWNLOAD_FILE_STEM_LENGTH,
  WINDOWS_MAX_PATH_COMPONENT_LENGTH,
  getDownloadFlacRepairOwnerPath,
} from '@common/downloadArtifactPaths'

const deferred = <T = void>() => {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void
  let rejectDeferred!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}

const createFfmpegDecodeProcess = (pcm: Buffer, exitCode: number, stderr = ''): ChildProcess => {
  const child = new EventEmitter() as ChildProcess
  const stdout = new EventEmitter()
  const stderrStream = new EventEmitter()
  Object.defineProperties(child, {
    pid: { value: undefined },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
    stdout: { value: stdout },
    stderr: { value: stderrStream },
  })
  child.kill = () => false
  queueMicrotask(() => {
    stdout.emit('data', pcm)
    if (stderr) stderrStream.emit('data', Buffer.from(stderr))
    child.emit('close', exitCode, null)
  })
  return child
}

const providerTrailingBytes = Buffer.from('F000FF0F4740384048463C362323243C494B5A56253E3B563B3A0E55FFF0', 'hex')

const withFlacTotalSamples = (bytes: Buffer, totalSamples: bigint): Buffer => {
  const result = Buffer.from(bytes)
  const sampleInfo = result.readBigUInt64BE(18)
  result.writeBigUInt64BE((sampleInfo & ~((1n << 36n) - 1n)) | totalSamples, 18)
  return result
}

const withFlacBlockSizes = (bytes: Buffer, minBlockSize: number, maxBlockSize: number): Buffer => {
  const result = Buffer.from(bytes)
  result.writeUInt16BE(minBlockSize, 8)
  result.writeUInt16BE(maxBlockSize, 10)
  return result
}

const withUnknownFlacMaxFrameSize = (bytes: Buffer): Buffer => {
  const result = Buffer.from(bytes)
  result.fill(0, 15, 18)
  return result
}

const withForbiddenFlacMetadataType = (bytes: Buffer): Buffer => {
  const result = Buffer.from(bytes)
  result[42] = 0xff
  return result
}

const withExcessiveFlacMetadataBlocks = (bytes: Buffer): Buffer => {
  const metadataEnd = 90
  const prefix = Buffer.from(bytes.subarray(0, metadataEnd))
  prefix[42] &= 0x7f
  const paddingBlocks = Buffer.alloc(1_025 * 4)
  for (let index = 0; index < 1_025; index++) paddingBlocks[index * 4] = index === 1_024 ? 0x81 : 0x01
  return Buffer.concat([prefix, paddingBlocks, bytes.subarray(metadataEnd)])
}

describe('download audio validator lifecycle', () => {
  it('normalizes bounded bytes after the final valid FLAC frame before accepting the download', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-tail-'))
    const filePath = path.join(dir, 'trailing-data.flac')
    const cleanFlac = getAudioFixture('flac24')
    const original = Buffer.concat([cleanFlac, providerTrailingBytes])
    await writeFile(filePath, original)
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })

    try {
      const validation = await service.validate({ taskId: 'flac-tail', filePath })
      expect(validation).toMatchObject({ status: 'valid', normalizedPath: expect.any(String) })
      await expect(readFile(filePath)).resolves.toEqual(original)
      await expect(readFile(validation.normalizedPath!)).resolves.toEqual(cleanFlac)
      await rm(validation.normalizedPath!, { force: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates the longest supported FLAC repair owner component without Windows ENOENT', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-long-name-'))
    const filePath = path.join(dir, `${'a'.repeat(MAX_DOWNLOAD_FILE_STEM_LENGTH)}${DOWNLOAD_TRANSFER_SUFFIX}`)
    const cleanFlac = getAudioFixture('flac24')
    await writeFile(filePath, Buffer.concat([cleanFlac, providerTrailingBytes]))
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })

    try {
      const validation = await service.validate({ taskId: 'flac-tail-long-name', filePath })
      expect(validation).toMatchObject({ status: 'valid', normalizedPath: expect.any(String) })
      const ownerPath = getDownloadFlacRepairOwnerPath(validation.normalizedPath!)
      expect(path.basename(ownerPath).length).toBe(WINDOWS_MAX_PATH_COMPONENT_LENGTH)
      await expect(readFile(ownerPath)).resolves.toBeInstanceOf(Buffer)
      await expect(readFile(validation.normalizedPath!)).resolves.toEqual(cleanFlac)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes the second observed bounded FLAC tail through the same public validator seam', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-tail-'))
    const filePath = path.join(dir, 'trailing-data.flac')
    const cleanFlac = getAudioFixture('flac16')
    const original = Buffer.concat([cleanFlac, providerTrailingBytes.subarray(0, 15)])
    await writeFile(filePath, original)
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })

    try {
      const validation = await service.validate({ taskId: 'flac-tail-15', filePath })
      expect(validation).toMatchObject({ status: 'valid', normalizedPath: expect.any(String) })
      await expect(readFile(filePath)).resolves.toEqual(original)
      await expect(readFile(validation.normalizedPath!)).resolves.toEqual(cleanFlac)
      await rm(validation.normalizedPath!, { force: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes a zero-prefixed FLAC tail with adjacent CRC-valid terminal boundaries', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-ambiguous-tail-'))
    const filePath = path.join(dir, 'ambiguous-trailing-data.flac')
    const cleanFlac = withUnknownFlacMaxFrameSize(getAudioFixture('flac16'))
    const original = Buffer.concat([cleanFlac, Buffer.from([0x00]), providerTrailingBytes])
    await writeFile(filePath, original)
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })

    try {
      const validation = await service.validate({ taskId: 'flac-tail-ambiguous-crc', filePath })
      expect(validation).toMatchObject({ status: 'valid', normalizedPath: expect.any(String) })
      await expect(readFile(filePath)).resolves.toEqual(original)
      await expect(readFile(validation.normalizedPath!)).resolves.toEqual(cleanFlac)
      await rm(validation.normalizedPath!, { force: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['strict decoding fails', Buffer.alloc(480, 0x11), 1, 'invalid frame CRC'],
    ['decoded PCM hash differs', Buffer.alloc(480, 0x22), 0, ''],
  ])('skips a candidate when %s before accepting the next boundary', async(_label, firstPcm, firstExitCode, firstStderr) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-candidate-hash-'))
    const filePath = path.join(dir, 'candidate-hash.flac')
    const cleanFlac = withUnknownFlacMaxFrameSize(getAudioFixture('flac16'))
    const original = Buffer.concat([cleanFlac, Buffer.from([0x00]), providerTrailingBytes])
    const expectedPcm = Buffer.alloc(480, 0x11)
    const decodeResults = [
      { pcm: expectedPcm, exitCode: 1, stderr: 'invalid frame header' },
      { pcm: firstPcm, exitCode: firstExitCode, stderr: firstStderr },
      { pcm: expectedPcm, exitCode: 0 },
    ]
    let decodeIndex = 0
    await writeFile(filePath, original)
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      spawnAudioProcess: (() => {
        const result = decodeResults[decodeIndex++]
        if (!result) throw new Error('Unexpected FFmpeg invocation')
        return createFfmpegDecodeProcess(result.pcm, result.exitCode, result.stderr)
      }) as typeof spawnAudioProcess,
    })

    try {
      const validation = await service.validate({ taskId: 'flac-tail-candidate-hash', filePath })
      expect(validation).toMatchObject({ status: 'valid', normalizedPath: expect.any(String) })
      expect(decodeIndex).toBe(3)
      await expect(readFile(filePath)).resolves.toEqual(original)
      await expect(readFile(validation.normalizedPath!))
        .resolves.toEqual(Buffer.concat([cleanFlac, Buffer.from([0x00])]))
      await rm(validation.normalizedPath!, { force: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reclaims only a prior validator-owned same-source repair artifact after restart', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-orphan-'))
    const filePath = path.join(dir, 'provider.flac')
    const cleanFlac = getAudioFixture('flac16')
    const original = Buffer.concat([cleanFlac, providerTrailingBytes.subarray(0, 15)])
    const decoyPath = `${filePath}.11111111-1111-4111-8111-111111111111.lx-flac-tail-normalizing`
    await Promise.all([
      writeFile(filePath, original),
      writeFile(decoyPath, cleanFlac),
    ])
    const firstService = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })
    const restartedService = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })

    try {
      expect(firstService.beginTask('orphan-before-restart')).toEqual({ status: 'active' })
      const firstValidation = await firstService.validate({ taskId: 'orphan-before-restart', filePath })
      expect(firstValidation).toMatchObject({ status: 'valid', normalizedPath: expect.any(String) })
      await expect(readFile(firstValidation.normalizedPath!)).resolves.toEqual(cleanFlac)

      expect(restartedService.beginTask('orphan-after-restart')).toEqual({ status: 'active' })
      const restartedValidation = await restartedService.validate({ taskId: 'orphan-after-restart', filePath })
      expect(restartedValidation).toMatchObject({ status: 'valid', normalizedPath: expect.any(String) })
      await expect(readFile(firstValidation.normalizedPath!)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(decoyPath)).resolves.toEqual(cleanFlac)

      await restartedService.finishTask('orphan-after-restart')
      await firstService.finishTask('orphan-before-restart')
      expect((await readdir(dir)).sort()).toEqual([
        path.basename(decoyPath),
        path.basename(filePath),
      ].sort())
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['a legal short final fixed-block frame', withFlacBlockSizes(getAudioFixture('flac16'), 256, 256)],
    ['a legal unknown STREAMINFO maximum frame size', withUnknownFlacMaxFrameSize(getAudioFixture('flac16'))],
    ['a legal 32-bit FLAC frame', getAudioFixture('flac32')],
  ])('normalizes trailing data after %s', async(label, cleanFlac) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-compatible-'))
    const filePath = path.join(dir, `${label}.flac`)
    const original = Buffer.concat([cleanFlac, providerTrailingBytes.subarray(0, 15)])
    await writeFile(filePath, original)
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })

    try {
      const validation = await service.validate({ taskId: `compatible-${label}`, filePath })
      expect(validation).toMatchObject({ status: 'valid', normalizedPath: expect.any(String) })
      await expect(readFile(filePath)).resolves.toEqual(original)
      await expect(readFile(validation.normalizedPath!)).resolves.toEqual(cleanFlac)
      await rm(validation.normalizedPath!, { force: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts the clean multi-frame FLAC fixture before using it for corruption coverage', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-multiframe-'))
    const filePath = path.join(dir, 'clean-multiframe.flac')
    const cleanFlac = getAudioFixture('flac16MultiFrame')
    await writeFile(filePath, cleanFlac)
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })

    try {
      await expect(service.validate({ taskId: 'clean-multiframe', filePath }))
        .resolves.toEqual({ status: 'valid', normalizedPath: undefined })
      await expect(readFile(filePath)).resolves.toEqual(cleanFlac)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.each([
    ['final frame CRC mismatch', (() => {
      const bytes = Buffer.from(getAudioFixture('flac16'))
      bytes[bytes.length - 1] ^= 0x01
      return bytes
    })(), providerTrailingBytes.subarray(0, 15)],
    ['final frame header CRC mismatch', (() => {
      const bytes = Buffer.from(getAudioFixture('flac16'))
      bytes[96] ^= 0x01
      return bytes
    })(), providerTrailingBytes.subarray(0, 15)],
    ['truncated final frame', getAudioFixture('flac16').subarray(0, -1), providerTrailingBytes.subarray(0, 15)],
    ['declared sample count mismatch', withFlacTotalSamples(getAudioFixture('flac16'), 241n), providerTrailingBytes.subarray(0, 15)],
    ['unknown declared sample count', withFlacTotalSamples(getAudioFixture('flac16'), 0n), providerTrailingBytes.subarray(0, 15)],
    ['forbidden metadata block type', withForbiddenFlacMetadataType(getAudioFixture('flac16')), providerTrailingBytes.subarray(0, 15)],
    ['excessive metadata block chain', withExcessiveFlacMetadataBlocks(getAudioFixture('flac16')), providerTrailingBytes.subarray(0, 15)],
    ['damaged non-terminal frame', (() => {
      const bytes = Buffer.from(getAudioFixture('flac16MultiFrame'))
      bytes[475] ^= 0x01
      return bytes
    })(), providerTrailingBytes.subarray(0, 15)],
    ['tail beyond the repair limit', getAudioFixture('flac16'), Buffer.alloc(257, 0x55)],
  ])('rejects %s without changing the downloaded artifact', async(label, flac, tail) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-reject-'))
    const filePath = path.join(dir, `${label}.flac`)
    const original = Buffer.concat([flac, tail])
    await writeFile(filePath, original)
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => path.resolve('resources/song-organizer/ffmpeg.exe'),
    })

    try {
      await expect(service.validate({ taskId: `reject-${label}`, filePath })).rejects.toThrow()
      await expect(readFile(filePath)).resolves.toEqual(original)
      await expect(readdir(dir)).resolves.toEqual([`${label}.flac`])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('waits for child close before releasing a decoder whose PID has exited', async() => {
    const child = new EventEmitter() as ChildProcess
    Object.defineProperties(child, {
      pid: { value: 4321 },
      exitCode: { value: null, writable: true },
      signalCode: { value: null, writable: true },
      stdout: { value: new EventEmitter() },
    })
    child.kill = () => false
    const termination = terminateAudioFfmpegProcess(child, {
      platform: 'win32',
      gracefulWaitMs: 1,
      forceWaitMs: 100,
      forceTerminate: async() => {},
      isProcessAlive: () => false,
    })
    let settled = false
    void termination.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    child.emit('close', 0, null)
    await expect(termination).resolves.toBeUndefined()
  })

  it('does not finish cancellation from a child error emitted during process termination', async() => {
    const child = new EventEmitter() as ChildProcess
    Object.defineProperties(child, {
      pid: { value: undefined },
      exitCode: { value: null, writable: true },
      signalCode: { value: null, writable: true },
      stdout: { value: new EventEmitter() },
      stderr: { value: new EventEmitter() },
    })
    child.kill = () => {
      child.emit('error', new Error('kill signal could not be delivered'))
      return false
    }
    const spawned = deferred<undefined>()
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      spawnAudioProcess: (() => {
        spawned.resolve(undefined)
        return child
      }) as typeof spawnAudioProcess,
    })

    const validation = service.validate({ taskId: 'termination-error-race', filePath: 'audio.tmp' })
    await spawned.promise
    const cancellation = service.cancelAndWait('termination-error-race')
    const [validationResult, cancellationResult] = await Promise.allSettled([validation, cancellation])

    expect(validationResult).toMatchObject({
      status: 'rejected',
      reason: expect.any(AudioFfmpegTerminationError),
    })
    expect(cancellationResult).toMatchObject({
      status: 'rejected',
      reason: expect.any(AudioFfmpegTerminationError),
    })
  })

  it('cancels one task and waits until its decoder has terminated', async() => {
    const decoderSettled = deferred<undefined>()
    let signal: AbortSignal | undefined
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async(_ffmpegPath, _filePath, currentSignal) => {
        signal = currentSignal
        await decoderSettled.promise
        if (currentSignal.aborted) throw currentSignal.reason
        return {}
      },
    })

    const validation = service.validate({ taskId: 'download-1', filePath: 'audio.tmp' })
    await vi.waitFor(() => { expect(service.isBusy()).toBe(true) })
    const cancellation = service.cancelAndWait('download-1')
    await vi.waitFor(() => { expect(signal?.aborted).toBe(true) })
    let cancelled = false
    void cancellation.then(() => { cancelled = true })
    await Promise.resolve()
    expect(cancelled).toBe(false)

    decoderSettled.resolve(undefined)
    await expect(cancellation).resolves.toBe(true)
    await expect(validation).resolves.toEqual({ status: 'cancelled' })
    expect(service.isBusy()).toBe(false)
  })

  it('removes an unpublished normalized artifact when cancellation wins after validation', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-cancel-'))
    const filePath = path.join(dir, 'provider.flac')
    const normalizedPath = path.join(dir, 'provider.normalized.flac')
    const original = Buffer.concat([getAudioFixture('flac16'), providerTrailingBytes.subarray(0, 15)])
    const validationReady = deferred<undefined>()
    const releaseValidation = deferred<undefined>()
    await Promise.all([
      writeFile(filePath, original),
      writeFile(normalizedPath, getAudioFixture('flac16')),
    ])
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => {
        validationReady.resolve(undefined)
        await releaseValidation.promise
        return { normalizedPath }
      },
    })

    try {
      const validation = service.validate({ taskId: 'cancel-normalized', filePath })
      await validationReady.promise
      const cancellation = service.cancelAndWait('cancel-normalized')
      releaseValidation.resolve(undefined)

      await expect(validation).resolves.toEqual({ status: 'cancelled' })
      await expect(cancellation).resolves.toBe(true)
      await expect(readFile(filePath)).resolves.toEqual(original)
      await expect(readFile(normalizedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cleans an unconsumed normalized artifact when the explicit publication lifecycle finishes', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-finish-'))
    const filePath = path.join(dir, 'provider.flac')
    const normalizedPath = path.join(dir, 'unconsumed.normalized.flac')
    const original = Buffer.concat([getAudioFixture('flac16'), providerTrailingBytes.subarray(0, 15)])
    await Promise.all([
      writeFile(filePath, original),
      writeFile(normalizedPath, getAudioFixture('flac16')),
    ])
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => ({ normalizedPath }),
    })

    try {
      expect(service.beginTask('finish-normalized')).toEqual({ status: 'active' })
      await expect(service.validate({ taskId: 'finish-normalized', filePath }))
        .resolves.toEqual({ status: 'valid', normalizedPath })
      await expect(readFile(normalizedPath)).resolves.toEqual(getAudioFixture('flac16'))

      await expect(service.finishTask('finish-normalized')).resolves.toBeUndefined()
      await expect(readFile(normalizedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(filePath)).resolves.toEqual(original)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('removes the original transfer only after the publication intent is accepted', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-accepted-'))
    const filePath = path.join(dir, 'provider.flac')
    const normalizedPath = path.join(dir, 'accepted.normalized.flac')
    await Promise.all([
      writeFile(filePath, Buffer.concat([getAudioFixture('flac16'), providerTrailingBytes.subarray(0, 15)])),
      writeFile(normalizedPath, getAudioFixture('flac16')),
    ])
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => ({ normalizedPath }),
    })

    try {
      expect(service.beginTask('accepted-normalized')).toEqual({ status: 'active' })
      await expect(service.validate({ taskId: 'accepted-normalized', filePath }))
        .resolves.toEqual({ status: 'valid', normalizedPath })
      await expect(service.finishTask('accepted-normalized', { sourceDisposition: 'discard' })).resolves.toBeUndefined()
      await expect(readFile(normalizedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('registers the source before validation so Main can discard it after a publication failure', async() => {
    const removeArtifact = vi.fn(async() => {})
    const validationError = new Error('provider artifact is damaged')
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => { throw validationError },
      removeNormalizedArtifact: removeArtifact,
    })
    expect(service.beginTask('discard-failed-source')).toEqual({ status: 'active' })
    await expect(service.validate({ taskId: 'discard-failed-source', filePath: 'provider.flac' }))
      .rejects.toBe(validationError)

    await expect(service.finishTask('discard-failed-source', { sourceDisposition: 'discard' })).resolves.toBeUndefined()
    expect(removeArtifact).toHaveBeenCalledOnce()
    expect(removeArtifact).toHaveBeenCalledWith('provider.flac')
  })

  it('cleans a reported owned staging artifact while preserving the original transfer', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-stage-cleanup-'))
    const sourcePath = path.join(dir, 'song.lx-publishing.download')
    const stagingPath = path.join(dir, 'song.lx-publishing.flac')
    const removeArtifact = vi.fn(async() => {})
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => ({}),
      removeNormalizedArtifact: removeArtifact,
    })

    try {
      expect(service.beginTask('stage-cleanup')).toEqual({ status: 'active' })
      await service.validate({ taskId: 'stage-cleanup', filePath: sourcePath })
      await expect(service.finishTask('stage-cleanup', {
        sourceDisposition: 'preserve',
        artifactPathsToDiscard: [stagingPath],
      })).resolves.toBeUndefined()
      expect(removeArtifact).toHaveBeenCalledOnce()
      expect(removeArtifact).toHaveBeenCalledWith(stagingPath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('remains busy and makes cancellation wait until lifecycle artifact cleanup settles', async() => {
    const cleanupStarted = deferred<undefined>()
    const releaseCleanup = deferred<undefined>()
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => ({ normalizedPath: 'normalized.flac' }),
      removeNormalizedArtifact: async() => {
        cleanupStarted.resolve(undefined)
        await releaseCleanup.promise
      },
    })
    expect(service.beginTask('cleanup-pending')).toEqual({ status: 'active' })
    await expect(service.validate({ taskId: 'cleanup-pending', filePath: 'provider.flac' }))
      .resolves.toEqual({ status: 'valid', normalizedPath: 'normalized.flac' })

    const finish = service.finishTask('cleanup-pending')
    await cleanupStarted.promise
    expect(service.isBusy()).toBe(true)
    const cancellation = service.cancelAndWait('cleanup-pending')
    let settled = false
    void cancellation.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseCleanup.resolve(undefined)
    await expect(finish).resolves.toBeUndefined()
    await expect(cancellation).resolves.toBe(true)
    expect(service.isBusy()).toBe(false)
  })

  it('persists lifecycle cleanup failure and blocks later cancellation or exit', async() => {
    const cleanupError = new Error('artifact cleanup failed')
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => ({ normalizedPath: 'normalized.flac' }),
      removeNormalizedArtifact: async() => { throw cleanupError },
    })
    expect(service.beginTask('cleanup-failed')).toEqual({ status: 'active' })
    await service.validate({ taskId: 'cleanup-failed', filePath: 'provider.flac' })

    await expect(service.finishTask('cleanup-failed')).rejects.toBe(cleanupError)
    expect(service.isBusy()).toBe(false)
    expect(service.getTerminationFailure()).toBe(cleanupError)
    await expect(service.cancelAndWait()).rejects.toBe(cleanupError)
  })

  it('rejects and cleans a normalized sidecar when validating an already-published final', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-flac-published-'))
    const normalizedPath = path.join(dir, 'published.normalized.flac')
    await writeFile(normalizedPath, getAudioFixture('flac16'))
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => ({ normalizedPath }),
    })

    try {
      await expect(service.validate({
        taskId: 'published-normalized',
        filePath: path.join(dir, 'published.flac'),
        allowNormalization: false,
      })).rejects.toThrow('requires normalization')
      await expect(readFile(normalizedPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(service.isBusy()).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists a fatal decoder termination failure and fails closed without FFmpeg', async() => {
    const terminationError = new AudioFfmpegTerminationError('decoder survived')
    const fatalService = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => { throw terminationError },
    })
    await expect(fatalService.validate({ taskId: 'fatal', filePath: 'audio.tmp' })).rejects.toBe(terminationError)
    expect(fatalService.getTerminationFailure()).toBe(terminationError)

    const validateAudio = vi.fn(async() => ({}))
    const missingService = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => null,
      validateAudio,
    })
    await expect(missingService.validate({ taskId: 'missing', filePath: 'audio.tmp' }))
      .rejects.toThrow('FFmpeg')
    expect(validateAudio).not.toHaveBeenCalled()
  })

  it('resolves PATH FFmpeg on non-Windows and otherwise returns no unsafe fallback', async() => {
    await expect(resolveDownloadAudioFfmpegPath({
      platform: 'linux',
      bundledPath: 'unused',
      bundledAvailable: async() => false,
      resolveCommand: async() => '/usr/bin/ffmpeg',
    })).resolves.toBe('/usr/bin/ffmpeg')
    await expect(resolveDownloadAudioFfmpegPath({
      platform: 'darwin',
      bundledPath: 'unused',
      bundledAvailable: async() => false,
      resolveCommand: async() => null,
    })).resolves.toBeNull()
  })

  it('fails closed on Windows when the bundled FFmpeg is unavailable', async() => {
    const resolveCommand = vi.fn(async() => 'C:\\unsafe\\ffmpeg.exe')

    await expect(resolveDownloadAudioFfmpegPath({
      platform: 'win32',
      bundledPath: 'C:\\app\\ffmpeg.exe',
      bundledAvailable: async() => false,
      resolveCommand,
    })).resolves.toBeNull()
    expect(resolveCommand).not.toHaveBeenCalled()
  })

  it('linearizes cancellation that arrives before validation registration', async() => {
    const validateAudio = vi.fn(async() => ({}))
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio,
    })

    await expect(service.cancelAndWait('late-download')).resolves.toBe(true)
    expect(service.beginTask('late-download')).toEqual({ status: 'cancelled' })
    await expect(service.validate({ taskId: 'late-download', filePath: 'audio.tmp' }))
      .resolves.toEqual({ status: 'cancelled' })
    expect(validateAudio).not.toHaveBeenCalled()

    service.resetTask('late-download')
    expect(service.beginTask('late-download')).toEqual({ status: 'active' })
    await service.finishTask('late-download')
  })

  it('closes the shutdown gate before waiting and rejects late publication work', async() => {
    const service = new DownloadAudioValidatorService({
      resolveFfmpegPath: async() => 'ffmpeg',
      validateAudio: async() => ({}),
    })
    expect(service.beginTask('active-publication')).toEqual({ status: 'active' })

    service.beginShutdown()
    const shutdown = service.cancelAndWait()
    let settled = false
    void shutdown.then(() => { settled = true })
    await Promise.resolve()

    expect(service.beginTask('late-publication')).toEqual({ status: 'cancelled' })
    await expect(service.validate({ taskId: 'late-validation', filePath: 'late.tmp' }))
      .resolves.toEqual({ status: 'cancelled' })
    expect(settled).toBe(false)

    await service.finishTask('active-publication')
    await expect(shutdown).resolves.toBe(true)
  })

  it('starts the download shutdown gate even when no validator is active yet', () => {
    let shutdownStarted = 0
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => false,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => false,
      isFlacConversionRunning: () => false,
      cancelFlacConversion: async() => {},
      beginDownloadValidationShutdown: () => { shutdownStarted++ },
      isDownloadValidationRunning: () => false,
      cancelDownloadValidation: async() => {},
      showOrganizerBusyWarning: async() => {},
      showExitFailureWarning: async() => {},
      reportError: () => {},
    })

    expect(coordinator.requestExit(() => {})).toBe(true)
    expect(shutdownStarted).toBe(1)
  })

  it('reopens the validation gate when a newly-started organizer mutation aborts exit', async() => {
    const service = new DownloadAudioValidatorService()
    let organizerBusy = false
    let finishCancellation!: () => void
    let warningShown!: () => void
    const cancellation = new Promise<undefined>(resolve => { finishCancellation = () => { resolve(undefined) } })
    const warning = new Promise<undefined>(resolve => { warningShown = () => { resolve(undefined) } })
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => false,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => organizerBusy,
      isFlacConversionRunning: () => true,
      cancelFlacConversion: async() => { await cancellation },
      beginDownloadValidationShutdown: () => { service.beginShutdown() },
      endDownloadValidationShutdown: () => { service.endShutdown() },
      isDownloadValidationRunning: () => false,
      cancelDownloadValidation: async() => {},
      showOrganizerBusyWarning: async() => { warningShown() },
      showExitFailureWarning: async() => {},
      reportError: () => {},
    })

    expect(coordinator.requestExit(() => {})).toBe(false)
    organizerBusy = true
    finishCancellation()
    await warning

    organizerBusy = false
    expect(service.beginTask('download-after-aborted-exit')).toEqual({ status: 'active' })
    await service.finishTask('download-after-aborted-exit')
  })

  it('makes app exit wait for active download validation cancellation', async() => {
    const cancelled = deferred<undefined>()
    let continued = 0
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => false,
      getTerminationFailure: () => undefined,
      isOrganizerMutationRunning: () => false,
      isFlacConversionRunning: () => false,
      cancelFlacConversion: async() => {},
      isDownloadValidationRunning: () => true,
      cancelDownloadValidation: async() => { await cancelled.promise },
      showOrganizerBusyWarning: async() => {},
      showExitFailureWarning: async() => {},
      reportError: () => {},
    })

    expect(coordinator.requestExit(() => { continued++ })).toBe(false)
    expect(continued).toBe(0)
    cancelled.resolve(undefined)
    await vi.waitFor(() => { expect(continued).toBe(1) })
  })
})
