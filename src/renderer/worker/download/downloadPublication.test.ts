import { createServer, type Server } from 'node:http'
import fs, { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import NodeID3 from 'node-id3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMeta } from '@common/utils/musicMeta'
import { getAudioFixture } from './__fixtures__/audioFixtures'
import {
  commitDownloadedAudio,
  discardDownloadedAudio,
  finalizeDownloadedAudio,
  getDownloadLyricPublication,
  getDownloadTransferPath,
  moveFileWithoutOverwrite,
  inspectDownloadPublicationPaths,
  prepareDownloadedAudio,
  resolveActualQuality,
  resolveFormatDowngrade,
  verifyDownloadedAudioFormat,
} from './downloadPublication'
import { pauseTask, removeTask, startTask } from './download'
import { DownloadAudioValidatorService } from '../../../main/modules/downloadAudioValidator'
import { releaseProxy } from 'comlink'

const tempDirs: string[] = []
const servers: Server[] = []
const ffmpegPath = path.resolve('resources/song-organizer/ffmpeg.exe')
let validationSequence = 0
const providerTrailingBytes = Buffer.from('F000FF0F4740384048463C362323243C494B5A56253E3B563B3A0E55FFF0', 'hex')
const validateFixtureAudio = async(filePath: string): Promise<LX.Download.DownloadAudioValidationResult> => {
  const validator = new DownloadAudioValidatorService({ resolveFfmpegPath: async() => ffmpegPath })
  return validator.validate({ taskId: `fixture-validation-${++validationSequence}`, filePath })
}
const acceptFixtureAudio = async(): Promise<LX.Download.DownloadAudioValidationResult> => ({ status: 'valid' })
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex')

const createTempDir = async() => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-publication-'))
  tempDirs.push(dir)
  return dir
}

const createMusicInfo = (): LX.Music.MusicInfoOnline => ({
  id: 'wy_song',
  name: '歌曲',
  singer: '歌手',
  source: 'wy',
  interval: null,
  meta: {
    songId: 'song',
    albumName: '专辑',
    picUrl: '',
    qualitys: [],
    _qualitys: {},
  },
})

const createPreparationLifecycle = () => {
  const beginTask = vi.fn(async() => ({ status: 'active' as const }))
  const isTaskCancelled = vi.fn(async() => false)
  const finishTask = vi.fn(async() => {})
  const release = vi.fn()
  return {
    beginTask,
    finishTask,
    isTaskCancelled,
    lifecycle: {
      beginTask,
      isTaskCancelled,
      finishTask,
      [releaseProxy]: release,
    },
    release,
  }
}

const createReleasableFunction = <T extends (...args: never[]) => unknown>(callback: T) => {
  const release = vi.fn()
  return {
    callback: Object.assign(callback, { [releaseProxy]: release }),
    release,
  }
}

const listen = async(server: Server) => {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('Missing test server address')
  return address.port
}

const prepareFixture = async(
  dir: string,
  bytes: Buffer,
  plannedFileName: string,
  ext: LX.Download.FileExt,
  quality: LX.Quality,
) => {
  const filePath = path.join(dir, plannedFileName)
  const transferPath = getDownloadTransferPath(filePath)
  await writeFile(transferPath, bytes)
  const taskId = `fixture-publication-${++validationSequence}`
  const validator = new DownloadAudioValidatorService({ resolveFfmpegPath: async() => ffmpegPath })
  expect(validator.beginTask(taskId)).toEqual({ status: 'active' })
  try {
    return await prepareDownloadedAudio({
      transferPath,
      filePath,
      fileName: plannedFileName,
      ext,
      quality,
      validate: async candidate => validator.validate({ taskId, filePath: candidate }),
      artifactCleanupOwner: 'lifecycle',
    })
  } finally {
    await validator.finishTask(taskId)
  }
}

const createBrokenTwoFrameMp3 = () => {
  const frameLength = Math.floor(144 * 320_000 / 44_100)
  const bytes = Buffer.alloc(frameLength * 2, 0xaa)
  bytes.set([0xff, 0xfb, 0xe0, 0x00], 0)
  bytes.set([0xff, 0xfb, 0xe0, 0x00], frameLength)
  return bytes
}

const createFakeApe = () => {
  const ape = Buffer.alloc(92)
  ape.write('MAC ', 0, 'ascii')
  ape.writeUInt16LE(3_990, 4)
  ape.writeUInt32LE(52, 8)
  ape.writeUInt32LE(24, 12)
  ape.writeUInt32LE(16, 24)
  ape.writeUInt16LE(2_000, 52)
  ape.writeUInt32LE(73_728, 56)
  ape.writeUInt32LE(100, 60)
  ape.writeUInt32LE(1, 64)
  ape.writeUInt16LE(16, 68)
  ape.writeUInt16LE(2, 70)
  ape.writeUInt32LE(44_100, 72)
  return ape
}

const withUnknownFlacSampleCount = (bytes: Buffer) => {
  const result = Buffer.from(bytes)
  const sampleInfo = result.readBigUInt64BE(18)
  result.writeBigUInt64BE(sampleInfo & ~((1n << 36n) - 1n), 18)
  return result
}

const deferred = <T>() => {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolve => { resolveDeferred = resolve })
  return { promise, resolve: resolveDeferred }
}

afterEach(async() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  }
  await Promise.all(tempDirs.splice(0).map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('download actual-format staging publication', () => {
  it('keeps actual MP3 in staging until tags and cover succeed, then publishes an MP3 atomically', async() => {
    expect(existsSync(ffmpegPath)).toBe(true)
    const dir = await createTempDir()
    const publication = await prepareFixture(dir, getAudioFixture('mp3Cbr160'), 'song.flac', 'flac', 'flac')
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(png)
    }))

    expect(publication).toMatchObject({
      filePath: path.join(dir, 'song.mp3'),
      fileName: 'song.mp3',
      stagingPath: path.join(dir, 'song.lx-publishing.mp3'),
      ext: 'mp3',
      quality: '128k',
      actualFormat: {
        container: 'mp3',
        codec: 'mp3',
        bitrate: 160_000,
      },
      downgrade: {
        reason: 'lossless_unavailable',
        requestedQuality: 'flac',
        actualQuality: '128k',
      },
    })
    await expect(stat(publication.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(publication.stagingPath)).resolves.toBeTruthy()

    await finalizeDownloadedAudio(publication, async stagingPath => {
      await setMeta(stagingPath, {
        title: '真实格式歌曲',
        artist: '测试歌手',
        album: '测试专辑',
        APIC: `http://127.0.0.1:${port}/cover.png`,
        lyrics: null,
      })
    })

    await expect(stat(publication.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const tags = NodeID3.read(publication.filePath)
    expect(tags.title).toBe('真实格式歌曲')
    expect(tags.artist).toBe('测试歌手')
    expect(tags.album).toBe('测试专辑')
    expect(tags.image && typeof tags.image === 'object' && tags.image.imageBuffer.equals(png)).toBe(true)
  })

  it('removes staging and leaves no final artifact when tag writing fails', async() => {
    const dir = await createTempDir()
    const publication = await prepareFixture(dir, getAudioFixture('mp3Cbr160'), 'tag-failure.flac', 'flac', 'flac')

    await expect(finalizeDownloadedAudio(publication, async() => {
      throw new Error('tag write failed')
    })).rejects.toThrow('tag write failed')

    await expect(stat(publication.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(publication.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('derives lossless quality from actual FLAC bit depth', async() => {
    const dir = await createTempDir()
    const flac16 = await prepareFixture(dir, getAudioFixture('flac16'), 'flac16.flac', 'flac', 'flac24bit')
    const flac24 = await prepareFixture(dir, getAudioFixture('flac24'), 'flac24.flac', 'flac', 'flac24bit')

    expect(flac16).toMatchObject({
      quality: 'flac',
      actualFormat: { container: 'flac', codec: 'flac', bitsPerSample: 16 },
      downgrade: { reason: 'quality_downgrade', requestedQuality: 'flac24bit', actualQuality: 'flac' },
    })
    expect(flac24).toMatchObject({
      quality: 'flac24bit',
      actualFormat: { container: 'flac', codec: 'flac', bitsPerSample: 24 },
      downgrade: undefined,
    })
    await commitDownloadedAudio(flac16)
    await commitDownloadedAudio(flac24)
    expect(await readFile(flac16.filePath)).toEqual(getAudioFixture('flac16'))
    expect(await readFile(flac24.filePath)).toEqual(getAudioFixture('flac24'))
  })

  it('stages the exact normalized FLAC prefix and leaves no repair artifact', async() => {
    const dir = await createTempDir()
    const cleanFlac = getAudioFixture('flac16')
    const publication = await prepareFixture(
      dir,
      Buffer.concat([cleanFlac, providerTrailingBytes.subarray(0, 15)]),
      'trailing.flac',
      'flac',
      'flac',
    )

    expect(publication).toMatchObject({
      fileName: 'trailing.flac',
      ext: 'flac',
      quality: 'flac',
    })
    expect(await readFile(publication.stagingPath)).toEqual(cleanFlac)
    await expect(readFile(getDownloadTransferPath(path.join(dir, 'trailing.flac'))))
      .resolves.toEqual(Buffer.concat([cleanFlac, providerTrailingBytes.subarray(0, 15)]))
    expect(await readdir(dir)).toEqual([
      'trailing.lx-publishing.download',
      'trailing.lx-publishing.flac',
    ])
    await discardDownloadedAudio(publication)
  })

  it('accepts a real decodable FLAC whose STREAMINFO total sample count is unknown', async() => {
    const dir = await createTempDir()
    const bytes = withUnknownFlacSampleCount(getAudioFixture('flac16'))
    const publication = await prepareFixture(dir, bytes, 'streaming.flac', 'flac', 'flac')

    expect(publication).toMatchObject({
      ext: 'flac',
      quality: 'flac',
      actualFormat: { container: 'flac', codec: 'flac', bitsPerSample: 16 },
    })
    await commitDownloadedAudio(publication)
    expect(await readFile(publication.filePath)).toEqual(bytes)
  })

  it('accepts a fully decodable PCM WAV and records its bit depth', async() => {
    const dir = await createTempDir()
    const publication = await prepareFixture(dir, getAudioFixture('wavPcm16'), 'audio.wav', 'wav', 'wav')

    expect(publication).toMatchObject({
      ext: 'wav',
      quality: 'wav',
      actualFormat: { container: 'wav', codec: 'pcm', bitsPerSample: 16, bitrate: 128_000 },
      downgrade: undefined,
    })
    await commitDownloadedAudio(publication)
    expect(await readFile(publication.filePath)).toEqual(getAudioFixture('wavPcm16'))
  })

  it('uses music-metadata average bitrate and VBR profile for the persisted MP3 quality', async() => {
    const dir = await createTempDir()
    const publication = await prepareFixture(dir, getAudioFixture('mp3Vbr'), 'variable.mp3', 'mp3', '320k')

    expect(publication).toMatchObject({
      ext: 'mp3',
      quality: '128k',
      actualFormat: {
        container: 'mp3',
        codec: 'mp3',
        bitrate: 110_189,
        bitrateMode: 'vbr',
      },
      downgrade: {
        reason: 'quality_downgrade',
        requestedQuality: '320k',
        actualQuality: '128k',
      },
    })
    await commitDownloadedAudio(publication)
    expect(await readFile(publication.filePath)).toEqual(getAudioFixture('mp3Vbr'))
  })

  it.each([
    ['two-frame pseudo MP3', createBrokenTwoFrameMp3(), 'broken.flac'],
    ['FLAC metadata without audio frames', getAudioFixture('flac16').subarray(0, 90), 'broken.flac'],
    ['truncated WAV', getAudioFixture('wavPcm16').subarray(0, 100), 'broken.wav'],
    ['pseudo APE', createFakeApe(), 'broken.ape'],
    ['unknown bytes', Buffer.from('not audio'), 'broken.flac'],
  ])('rejects %s without publishing any artifact', async(_label, bytes, plannedFileName) => {
    const dir = await createTempDir()
    const filePath = path.join(dir, plannedFileName)
    const transferPath = getDownloadTransferPath(filePath)
    await writeFile(transferPath, bytes)

    await expect(prepareDownloadedAudio({
      transferPath,
      filePath,
      fileName: plannedFileName,
      ext: path.extname(plannedFileName).slice(1) as LX.Download.FileExt,
      quality: plannedFileName.endsWith('.flac') ? 'flac' : plannedFileName.endsWith('.wav') ? 'wav' : 'ape',
      validate: validateFixtureAudio,
    })).rejects.toThrow('Unsupported or damaged downloaded audio')

    expect(await readdir(dir)).toEqual([])
  })

  it('reports a transfer cleanup failure instead of hiding a temporary orphan', async() => {
    const dir = await createTempDir()
    const transferPath = path.join(dir, 'cleanup-failure.download')
    await writeFile(transferPath, Buffer.alloc(256, 0x5a))
    const originalRm = fs.promises.rm.bind(fs.promises)
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockImplementation(async(filePath, options) => {
      if (String(filePath) === transferPath) {
        const error = new Error('temporary file is locked') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      await originalRm(filePath, options)
    })

    try {
      await expect(prepareDownloadedAudio({
        transferPath,
        filePath: path.join(dir, 'cleanup-failure.flac'),
        fileName: 'cleanup-failure.flac',
        ext: 'flac',
        quality: 'flac',
        validate: async() => ({ status: 'valid' }),
      })).rejects.toThrow('Unable to remove temporary download artifact')
      await expect(stat(transferPath)).resolves.toBeTruthy()
    } finally {
      rmSpy.mockRestore()
    }
  })

  it('removes a partial stage when a no-clobber copy fails after creating it', async() => {
    const dir = await createTempDir()
    const transferPath = path.join(dir, 'partial-copy.lx-publishing.download')
    const stagingPath = path.join(dir, 'partial-copy.lx-publishing.mp3')
    await writeFile(transferPath, getAudioFixture('mp3Cbr160'))
    const originalCopyFile = fs.promises.copyFile.bind(fs.promises)
    const copySpy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async(source, target, mode) => {
      if (String(target) === stagingPath) {
        await writeFile(stagingPath, Buffer.from('partial'))
        const error = new Error('copy failed after target creation') as NodeJS.ErrnoException
        error.code = 'EIO'
        throw error
      }
      await originalCopyFile(source, target, mode)
    })

    try {
      await expect(prepareDownloadedAudio({
        transferPath,
        filePath: path.join(dir, 'partial-copy.flac'),
        fileName: 'partial-copy.flac',
        ext: 'flac',
        quality: 'flac',
        validate: validateFixtureAudio,
        artifactCleanupOwner: 'lifecycle',
      })).rejects.toThrow('copy failed after target creation')
      await expect(stat(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(transferPath)).resolves.toEqual(getAudioFixture('mp3Cbr160'))
    } finally {
      copySpy.mockRestore()
    }
  })

  it('preserves an existing final target when it exists before preparation', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'conflict.flac')
    const targetPath = path.join(dir, 'conflict.mp3')
    const transferPath = getDownloadTransferPath(filePath)
    const existing = Buffer.from('existing target')
    await writeFile(transferPath, getAudioFixture('mp3Cbr160'))
    await writeFile(targetPath, existing)

    await expect(prepareDownloadedAudio({
      transferPath,
      filePath,
      fileName: 'conflict.flac',
      ext: 'flac',
      quality: 'flac',
      validate: validateFixtureAudio,
    })).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(targetPath)).toEqual(existing)
    await expect(stat(transferPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a pre-existing staging artifact when preparation loses a no-clobber race', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'stage-conflict.flac')
    const transferPath = getDownloadTransferPath(filePath)
    const stagingPath = path.join(dir, 'stage-conflict.lx-publishing.mp3')
    const existing = Buffer.from('existing staging artifact')
    await Promise.all([
      writeFile(transferPath, getAudioFixture('mp3Cbr160')),
      writeFile(stagingPath, existing),
    ])

    await expect(prepareDownloadedAudio({
      transferPath,
      filePath,
      fileName: 'stage-conflict.flac',
      ext: 'flac',
      quality: 'flac',
      validate: validateFixtureAudio,
    })).rejects.toMatchObject({ code: 'EEXIST' })

    await expect(readFile(stagingPath)).resolves.toEqual(existing)
    await expect(stat(transferPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a target created during post-processing and cleans staging', async() => {
    const dir = await createTempDir()
    const publication = await prepareFixture(dir, getAudioFixture('mp3Cbr160'), 'race.flac', 'flac', 'flac')
    const existing = Buffer.from('racing target')
    await writeFile(publication.filePath, existing)

    await expect(commitDownloadedAudio(publication)).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(publication.filePath)).toEqual(existing)
    await expect(stat(publication.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform === 'win32')('uses a Windows no-clobber move primitive at the publication boundary', async() => {
    const dir = await createTempDir()
    const sourcePath = path.join(dir, 'source.lx-publishing.mp3')
    const targetPath = path.join(dir, 'target.mp3')
    const source = Buffer.from('new publication')
    const existing = Buffer.from('racing target')
    await writeFile(sourcePath, source)
    await writeFile(targetPath, existing)

    await expect(moveFileWithoutOverwrite(sourcePath, targetPath)).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(targetPath)).toEqual(existing)
    expect(await readFile(sourcePath)).toEqual(source)
  })

  it('does not publish an orphan lyric when the audio target wins a commit race', async() => {
    const dir = await createTempDir()
    const publication = await prepareFixture(dir, getAudioFixture('mp3Cbr160'), 'lyric-race.flac', 'flac', 'flac')
    const lyric = getDownloadLyricPublication(publication.filePath)
    const existing = Buffer.from('racing audio target')
    await writeFile(publication.filePath, existing)
    await writeFile(lyric.stagingPath, Buffer.from('staged lyric'))

    await expect(commitDownloadedAudio(publication, lyric)).rejects.toMatchObject({ code: 'EEXIST' })

    expect(await readFile(publication.filePath)).toEqual(existing)
    await expect(stat(lyric.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(publication.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(lyric.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes a staged lyric under the successful audio final basename', async() => {
    const dir = await createTempDir()
    const publication = await prepareFixture(dir, getAudioFixture('mp3Cbr160'), 'with-lyric.flac', 'flac', 'flac')
    const lyric = getDownloadLyricPublication(publication.filePath)
    const lyricBytes = Buffer.from('[00:00.00]line')
    await writeFile(lyric.stagingPath, lyricBytes)

    await commitDownloadedAudio(publication, lyric)

    await expect(stat(publication.filePath)).resolves.toBeTruthy()
    expect(lyric.filePath).toBe(path.join(dir, 'with-lyric.lrc'))
    expect(await readFile(lyric.filePath)).toEqual(lyricBytes)
    await expect(stat(lyric.stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reinspects a published final for startup reconciliation', async() => {
    const dir = await createTempDir()
    const publication = await prepareFixture(dir, getAudioFixture('mp3Cbr160'), 'reconcile.flac', 'flac', 'flac')
    await commitDownloadedAudio(publication)

    await expect(inspectDownloadPublicationPaths(publication)).resolves.toEqual({
      stagingExists: false,
      finalExists: true,
    })
    await expect(verifyDownloadedAudioFormat(publication.filePath, publication.actualFormat)).resolves.toMatchObject({
      container: 'mp3',
      codec: 'mp3',
    })
  })

  it.runIf(process.platform === 'win32')('fails closed when Windows full-decode validation has no FFmpeg path', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'missing-validator.flac')
    const transferPath = getDownloadTransferPath(filePath)
    await writeFile(transferPath, getAudioFixture('mp3Cbr160'))

    await expect(prepareDownloadedAudio({
      transferPath,
      filePath,
      fileName: 'missing-validator.flac',
      ext: 'flac',
      quality: 'flac',
      validate: async() => { throw new Error('FFmpeg 不可用，无法完整验证下载音频。') },
    })).rejects.toThrow('Unsupported or damaged downloaded audio')

    expect(await readdir(dir)).toEqual([])
  })

  it('maps actual CBR/VBR bitrate and every planned lossless tier deterministically', () => {
    expect(resolveActualQuality({ container: 'mp3', codec: 'mp3', bitrate: 160_000, bitrateMode: 'cbr' })).toBe('128k')
    expect(resolveActualQuality({ container: 'mp3', codec: 'mp3', bitrate: 256_000, bitrateMode: 'cbr' })).toBe('192k')
    expect(resolveActualQuality({ container: 'mp3', codec: 'mp3', bitrate: 180_000, bitrateMode: 'vbr' })).toBe('128k')
    for (const requestedQuality of ['flac', 'flac24bit', 'wav', 'ape'] as const) {
      expect(resolveFormatDowngrade(requestedQuality, '128k', { container: 'mp3', codec: 'mp3', bitrate: 160_000 })).toEqual({
        reason: 'lossless_unavailable',
        requestedQuality,
        actualQuality: '128k',
      })
    }
    expect(resolveFormatDowngrade('320k', '128k', { container: 'mp3', codec: 'mp3', bitrate: 160_000 })).toEqual({
      reason: 'quality_downgrade',
      requestedQuality: '320k',
      actualQuality: '128k',
    })
  })

  it('never overwrites or removes an existing <=100-byte target when skipExistFile is enabled', async() => {
    const dir = await createTempDir()
    const plannedPath = path.join(dir, 'existing.mp3')
    const existing = Buffer.from([0x01])
    await writeFile(plannedPath, existing)
    let requestCount = 0
    const port = await listen(createServer((_request, response) => {
      requestCount++
      response.writeHead(200, { 'Content-Length': '1' })
      response.end('x')
    }))
    const task = {
      id: `small-existing-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        quality: '128k',
        ext: 'mp3',
        fileName: 'existing.mp3',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem
    const lifecycle = createPreparationLifecycle()
    const actionRelease = vi.fn()
    const validateAudio = createReleasableFunction(validateFixtureAudio)

    const error = await new Promise<Extract<LX.Download.DownloadTaskActions, { action: 'error' }>['data']>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('download error timeout'))
      }, 2_000)
      const callback = Object.assign((event: LX.Download.DownloadTaskActions) => {
        if (event.action === 'error') {
          clearTimeout(timeout)
          resolve(event.data)
        }
      }, { [releaseProxy]: actionRelease })
      void startTask(task, dir, true, callback, undefined, validateAudio.callback, lifecycle.lifecycle)
    })

    expect(error.error).toBe('download_status_error_check_path_exist')
    expect(requestCount).toBe(0)
    expect(await readFile(plannedPath)).toEqual(existing)
    expect(lifecycle.beginTask).not.toHaveBeenCalled()
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(actionRelease).toHaveBeenCalledOnce()
    expect(validateAudio.release).toHaveBeenCalledOnce()
    await removeTask(task.id)
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(actionRelease).toHaveBeenCalledOnce()
    expect(validateAudio.release).toHaveBeenCalledOnce()
  })

  it('releases the preparation lifecycle after a terminal transfer response error', async() => {
    const dir = await createTempDir()
    const plannedPath = path.join(dir, 'terminal-error.mp3')
    let requestCount = 0
    const port = await listen(createServer((_request, response) => {
      requestCount++
      response.writeHead(500)
      response.end()
    }))
    const task = {
      id: `terminal-error-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: '128k',
        quality: '128k',
        ext: 'mp3',
        fileName: 'terminal-error.mp3',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem
    const lifecycle = createPreparationLifecycle()
    const actionRelease = vi.fn()
    const validateAudio = createReleasableFunction(validateFixtureAudio)

    const error = await new Promise<Extract<LX.Download.DownloadTaskActions, { action: 'error' }>['data']>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('terminal response timeout'))
      }, 3_000)
      const callback = Object.assign((event: LX.Download.DownloadTaskActions) => {
        if (event.action !== 'error') return
        clearTimeout(timeout)
        resolve(event.data)
      }, { [releaseProxy]: actionRelease })
      void startTask(task, dir, true, callback, undefined, validateAudio.callback, lifecycle.lifecycle)
    })

    expect(error).toMatchObject({
      error: 'download_status_error_response',
      message: '500',
    })
    expect(requestCount).toBe(3)
    expect(lifecycle.beginTask).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(lifecycle.release).toHaveBeenCalledOnce()
      expect(actionRelease).toHaveBeenCalledOnce()
      expect(validateAudio.release).toHaveBeenCalledOnce()
    })
    await removeTask(task.id)
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(actionRelease).toHaveBeenCalledOnce()
    expect(validateAudio.release).toHaveBeenCalledOnce()
  })

  it('automatically resumes a partially transferred response after the connection is interrupted', async() => {
    const dir = await createTempDir()
    const audio = getAudioFixture('mp3Cbr256')
    const splitAt = Math.floor(audio.length / 2)
    const plannedPath = path.join(dir, 'interrupted-transfer.mp3')
    const ranges: Array<string | undefined> = []
    const port = await listen(createServer((request, response) => {
      const range = request.headers.range
      ranges.push(range)
      if (ranges.length === 1) {
        response.writeHead(200, {
          'Accept-Ranges': 'bytes',
          'Content-Length': String(audio.length),
        })
        response.write(audio.subarray(0, splitAt), () => {
          setTimeout(() => { response.destroy() }, 5)
        })
        return
      }

      const match = typeof range === 'string' ? /^bytes=(\d+)-$/.exec(range) : null
      if (!match) {
        response.writeHead(400)
        response.end()
        return
      }
      const start = Number(match[1])
      response.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': String(audio.length - start),
        'Content-Range': `bytes ${start}-${audio.length - 1}/${audio.length}`,
      })
      response.end(audio.subarray(start))
    }))
    const task = {
      id: `interrupted-transfer-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: '192k',
        quality: '192k',
        ext: 'mp3',
        fileName: 'interrupted-transfer.mp3',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem

    try {
      const publication = await new Promise<LX.Download.DownloadPublication>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('interrupted transfer retry timeout'))
        }, 3_000)
        void startTask(task, dir, true, event => {
          if (event.action === 'complete') {
            clearTimeout(timeout)
            resolve(event.data)
            return true
          } else if (event.action === 'error') {
            clearTimeout(timeout)
            reject(new Error(event.data.message ?? event.data.error ?? 'download failed'))
          }
        }, undefined, acceptFixtureAudio)
      })

      expect(ranges).toHaveLength(2)
      expect(ranges[0]).toBe('bytes=0-')
      expect(ranges[1]).toBe(`bytes=${splitAt - 10}-`)
      expect(await readFile(publication.stagingPath)).toEqual(audio)
      await discardDownloadedAudio(publication)
    } finally {
      await removeTask(task.id)
    }
  })

  it('reports a terminal error after the socket closes for all three attempts', async() => {
    const dir = await createTempDir()
    const plannedPath = path.join(dir, 'socket-hang-up.mp3')
    const ranges: Array<string | undefined> = []
    const port = await listen(createServer((request) => {
      ranges.push(request.headers.range)
      request.socket.destroy()
    }))
    const task = {
      id: `socket-hang-up-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: '192k',
        quality: '192k',
        ext: 'mp3',
        fileName: 'socket-hang-up.mp3',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem

    try {
      const error = await new Promise<Extract<LX.Download.DownloadTaskActions, { action: 'error' }>['data']>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('socket hang up terminal error timeout'))
        }, 5_000)
        void startTask(task, dir, true, event => {
          if (event.action === 'complete') {
            clearTimeout(timeout)
            reject(new Error('unexpected download completion'))
          } else if (event.action === 'error') {
            clearTimeout(timeout)
            resolve(event.data)
          }
        })
      })

      expect(ranges).toEqual(['bytes=0-', 'bytes=0-', 'bytes=0-'])
      expect(error.message).toBe('socket hang up')
    } finally {
      await removeTask(task.id)
    }
  })

  it('emits a compatible complete event that references staging, not a premature final artifact', async() => {
    const dir = await createTempDir()
    const audio = getAudioFixture('mp3Cbr256')
    const plannedPath = path.join(dir, 'transfer.flac')
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': String(audio.length) })
      response.end(audio)
    }))
    const task = {
      id: `publication-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        quality: 'flac',
        ext: 'flac',
        fileName: 'transfer.flac',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem

    const publication = await new Promise<LX.Download.DownloadPublication>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('download completion timeout'))
      }, 3_000)
      void startTask(task, dir, true, event => {
        if (event.action === 'complete') {
          clearTimeout(timeout)
          resolve(event.data)
        } else if (event.action === 'error') {
          clearTimeout(timeout)
          reject(new Error(event.data.message ?? event.data.error ?? 'download failed'))
        }
      }, undefined, validateFixtureAudio)
    })

    expect(publication).toMatchObject({
      filePath: path.join(dir, 'transfer.mp3'),
      stagingPath: path.join(dir, 'transfer.lx-publishing.mp3'),
      ext: 'mp3',
      quality: '192k',
      downgrade: { reason: 'lossless_unavailable' },
    })
    await expect(stat(publication.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(publication.stagingPath)).resolves.toBeTruthy()
    await discardDownloadedAudio(publication)
    await removeTask(task.id)
  })

  it('waits for a cancelled Main validation and leaves no stage when pausing', async() => {
    const dir = await createTempDir()
    const audio = getAudioFixture('mp3Cbr160')
    const plannedPath = path.join(dir, 'paused.flac')
    const transferPath = getDownloadTransferPath(plannedPath)
    const validation = deferred<LX.Download.DownloadAudioValidationResult>()
    const validationStarted = deferred<undefined>()
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': String(audio.length) })
      response.end(audio)
    }))
    const task = {
      id: `pause-validation-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: 'flac',
        quality: 'flac',
        ext: 'flac',
        fileName: 'paused.flac',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem
    const lifecycle = createPreparationLifecycle()
    const actionCallback = createReleasableFunction(() => {})
    const validateAudio = createReleasableFunction(async(filePath: string) => {
      expect(filePath).toBe(transferPath)
      validationStarted.resolve(undefined)
      return validation.promise
    })

    void startTask(task, dir, true, actionCallback.callback, undefined, validateAudio.callback, lifecycle.lifecycle)
    await validationStarted.promise
    validation.resolve({ status: 'cancelled' })
    await pauseTask(task.id)

    await expect(stat(transferPath)).resolves.toBeTruthy()
    await expect(stat(plannedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(dir, 'paused.lx-publishing.mp3'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(lifecycle.finishTask).toHaveBeenCalledOnce()
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(actionCallback.release).toHaveBeenCalledOnce()
    expect(validateAudio.release).toHaveBeenCalledOnce()
  })

  it('preserves the original transfer when cancellation wins after a normalized stage is prepared', async() => {
    const dir = await createTempDir()
    const cleanFlac = getAudioFixture('flac16')
    const original = Buffer.concat([cleanFlac, providerTrailingBytes.subarray(0, 15)])
    const plannedPath = path.join(dir, 'cancel-after-normalization.flac')
    const transferPath = getDownloadTransferPath(plannedPath)
    const normalizedPath = `${transferPath}.test.lx-flac-tail-normalizing`
    const lifecycleFinished = deferred<undefined>()
    const isTaskCancelled = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const finishTask = vi.fn(async(options: LX.Download.DownloadAudioTaskFinishOptions) => {
      expect(options).toEqual({ sourceDisposition: 'preserve', artifactPathsToDiscard: [] })
      lifecycleFinished.resolve(undefined)
    })
    const lifecycleRelease = vi.fn()
    const lifecycle = {
      beginTask: async() => ({ status: 'active' as const }),
      isTaskCancelled,
      finishTask,
      [releaseProxy]: lifecycleRelease,
    }
    const actionCallback = createReleasableFunction(() => {})
    const validateAudio = createReleasableFunction(async(filePath: string) => {
      expect(filePath).toBe(transferPath)
      await writeFile(normalizedPath, cleanFlac)
      return { status: 'valid' as const, normalizedPath }
    })
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': String(original.length) })
      response.end(original)
    }))
    const task = {
      id: `cancel-normalized-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: 'flac',
        quality: 'flac',
        ext: 'flac',
        fileName: 'cancel-after-normalization.flac',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem

    void startTask(task, dir, true, actionCallback.callback, undefined, validateAudio.callback, lifecycle)
    await lifecycleFinished.promise

    await expect(readFile(transferPath)).resolves.toEqual(original)
    await expect(stat(normalizedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(dir, 'cancel-after-normalization.lx-publishing.flac')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(isTaskCancelled).toHaveBeenCalledTimes(2)
    expect(finishTask).toHaveBeenCalledWith({ sourceDisposition: 'preserve', artifactPathsToDiscard: [] })
    expect(lifecycleRelease).toHaveBeenCalledOnce()
    expect(actionCallback.release).toHaveBeenCalledOnce()
    expect(validateAudio.release).toHaveBeenCalledOnce()
    await removeTask(task.id)
  })

  it('preserves an unnormalized transfer when cancellation wins after staging', async() => {
    const dir = await createTempDir()
    const audio = getAudioFixture('mp3Cbr160')
    const plannedPath = path.join(dir, 'cancel-after-staging.flac')
    const transferPath = getDownloadTransferPath(plannedPath)
    const stagingPath = path.join(dir, 'cancel-after-staging.lx-publishing.mp3')
    const lifecycleFinished = deferred<undefined>()
    let cancellationChecks = 0
    const lifecycleRelease = vi.fn()
    const lifecycle = {
      beginTask: async() => ({ status: 'active' as const }),
      isTaskCancelled: async() => {
        cancellationChecks++
        if (cancellationChecks === 1) return false
        await expect(stat(stagingPath)).resolves.toBeTruthy()
        return true
      },
      finishTask: async(options: LX.Download.DownloadAudioTaskFinishOptions) => {
        expect(options).toEqual({ sourceDisposition: 'preserve', artifactPathsToDiscard: [] })
        lifecycleFinished.resolve(undefined)
      },
      [releaseProxy]: lifecycleRelease,
    }
    const actionCallback = createReleasableFunction(() => {})
    const validateAudio = createReleasableFunction(async() => ({ status: 'valid' as const }))
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': String(audio.length) })
      response.end(audio)
    }))
    const task = {
      id: `cancel-staged-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: 'flac',
        quality: 'flac',
        ext: 'flac',
        fileName: 'cancel-after-staging.flac',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem

    void startTask(task, dir, true, actionCallback.callback, undefined, validateAudio.callback, lifecycle)
    await lifecycleFinished.promise

    await expect(readFile(transferPath)).resolves.toEqual(audio)
    await expect(stat(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(lifecycleRelease).toHaveBeenCalledOnce()
    expect(actionCallback.release).toHaveBeenCalledOnce()
    expect(validateAudio.release).toHaveBeenCalledOnce()
    await removeTask(task.id)
  })

  it('keeps cancellation semantics and reports a stage that cannot be cleaned', async() => {
    const dir = await createTempDir()
    const audio = getAudioFixture('mp3Cbr160')
    const plannedPath = path.join(dir, 'cancel-cleanup-failure.flac')
    const transferPath = getDownloadTransferPath(plannedPath)
    const stagingPath = path.join(dir, 'cancel-cleanup-failure.lx-publishing.mp3')
    const lifecycleFinished = deferred<undefined>()
    let cancellationChecks = 0
    const finishTask = vi.fn(async(options: LX.Download.DownloadAudioTaskFinishOptions) => {
      lifecycleFinished.resolve(undefined)
      expect(options).toEqual({
        sourceDisposition: 'preserve',
        artifactPathsToDiscard: [stagingPath],
      })
    })
    const lifecycle = {
      beginTask: async() => ({ status: 'active' as const }),
      isTaskCancelled: async() => ++cancellationChecks > 1,
      finishTask,
      [releaseProxy]: vi.fn(),
    }
    const actionCallback = createReleasableFunction(() => {})
    const validateAudio = createReleasableFunction(async() => ({ status: 'valid' as const }))
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': String(audio.length) })
      response.end(audio)
    }))
    const task = {
      id: `cancel-cleanup-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: 'flac',
        quality: 'flac',
        ext: 'flac',
        fileName: 'cancel-cleanup-failure.flac',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem
    const originalRm = fs.promises.rm.bind(fs.promises)
    const rmSpy = vi.spyOn(fs.promises, 'rm').mockImplementation(async(filePath, options) => {
      if (String(filePath) === stagingPath) {
        const error = new Error('stage is locked') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      await originalRm(filePath, options)
    })

    try {
      void startTask(task, dir, true, actionCallback.callback, undefined, validateAudio.callback, lifecycle)
      await lifecycleFinished.promise
      await expect(readFile(transferPath)).resolves.toEqual(audio)
      await expect(readFile(stagingPath)).resolves.toEqual(audio)
      expect(finishTask).toHaveBeenCalledOnce()
    } finally {
      rmSpy.mockRestore()
      await removeTask(task.id)
    }
  })

  it('preserves the transfer when pause wins while a later preparation check fails', async() => {
    const dir = await createTempDir()
    const invalidAudio = Buffer.alloc(256, 0x5a)
    const plannedPath = path.join(dir, 'pause-before-inspection.flac')
    const transferPath = getDownloadTransferPath(plannedPath)
    const validationStarted = deferred<undefined>()
    const releaseValidation = deferred<undefined>()
    const lifecycle = createPreparationLifecycle()
    const actionCallback = createReleasableFunction(() => {})
    const validateAudio = createReleasableFunction(async() => {
      validationStarted.resolve(undefined)
      await releaseValidation.promise
      return { status: 'valid' as const }
    })
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': String(invalidAudio.length) })
      response.end(invalidAudio)
    }))
    const task = {
      id: `pause-inspection-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: 'flac',
        quality: 'flac',
        ext: 'flac',
        fileName: 'pause-before-inspection.flac',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem

    void startTask(task, dir, true, actionCallback.callback, undefined, validateAudio.callback, lifecycle.lifecycle)
    await validationStarted.promise
    const pause = pauseTask(task.id)
    releaseValidation.resolve(undefined)
    await pause

    await expect(readFile(transferPath)).resolves.toEqual(invalidAudio)
    expect(lifecycle.finishTask).toHaveBeenCalledWith({ sourceDisposition: 'preserve', artifactPathsToDiscard: [] })
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(actionCallback.release).toHaveBeenCalledOnce()
    expect(validateAudio.release).toHaveBeenCalledOnce()
    await removeTask(task.id)
  })

  it('removes a cancelled validated transfer without leaving a stage when deleting', async() => {
    const dir = await createTempDir()
    const audio = getAudioFixture('mp3Cbr160')
    const plannedPath = path.join(dir, 'deleted.flac')
    const transferPath = getDownloadTransferPath(plannedPath)
    const validation = deferred<LX.Download.DownloadAudioValidationResult>()
    const validationStarted = deferred<undefined>()
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': String(audio.length) })
      response.end(audio)
    }))
    const task = {
      id: `delete-validation-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: 'flac',
        quality: 'flac',
        ext: 'flac',
        fileName: 'deleted.flac',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem
    const lifecycle = createPreparationLifecycle()
    const actionCallback = createReleasableFunction(() => {})
    const validateAudio = createReleasableFunction(async() => {
      validationStarted.resolve(undefined)
      return validation.promise
    })

    void startTask(task, dir, true, actionCallback.callback, undefined, validateAudio.callback, lifecycle.lifecycle)
    await validationStarted.promise
    validation.resolve({ status: 'cancelled' })
    await removeTask(task.id)

    await expect(stat(transferPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(plannedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(dir, 'deleted.lx-publishing.mp3'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(lifecycle.finishTask).toHaveBeenCalledOnce()
    expect(lifecycle.release).toHaveBeenCalledOnce()
    expect(actionCallback.release).toHaveBeenCalledOnce()
    expect(validateAudio.release).toHaveBeenCalledOnce()
  })

  it('keeps preparation observable until the Renderer durably accepts the publication intent', async() => {
    const dir = await createTempDir()
    const audio = getAudioFixture('mp3Cbr160')
    const plannedPath = path.join(dir, 'observable.flac')
    const accepted = deferred<undefined>()
    const completeSeen = deferred<undefined>()
    const finishTask = vi.fn()
    const releaseLifecycle = vi.fn()
    const actionCallback = createReleasableFunction(async(event: LX.Download.DownloadTaskActions) => {
      if (event.action !== 'complete') return
      completeSeen.resolve(undefined)
      await accepted.promise
      return true
    })
    const validateAudio = createReleasableFunction(validateFixtureAudio)
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': String(audio.length) })
      response.end(audio)
    }))
    const task = {
      id: `observable-${Date.now()}`,
      isComplate: false,
      status: 'waiting',
      statusText: '',
      downloaded: 0,
      total: 0,
      progress: 0,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: `http://127.0.0.1:${port}/audio`,
        requestedQuality: 'flac',
        quality: 'flac',
        ext: 'flac',
        fileName: 'observable.flac',
        filePath: plannedPath,
      },
    } satisfies LX.Download.ListItem

    const lifecycle = {
      beginTask: async() => ({ status: 'active' as const }),
      isTaskCancelled: async() => false,
      finishTask: async(options: LX.Download.DownloadAudioTaskFinishOptions) => { finishTask(options) },
      [releaseProxy]: releaseLifecycle,
    }
    void startTask(task, dir, true, actionCallback.callback, undefined, validateAudio.callback, lifecycle)

    await completeSeen.promise
    expect(finishTask).not.toHaveBeenCalled()
    expect(releaseLifecycle).not.toHaveBeenCalled()
    accepted.resolve(undefined)
    await vi.waitFor(() => {
      expect(finishTask).toHaveBeenCalledOnce()
      expect(finishTask).toHaveBeenCalledWith({ sourceDisposition: 'discard', artifactPathsToDiscard: [] })
      expect(releaseLifecycle).toHaveBeenCalledOnce()
      expect(actionCallback.release).toHaveBeenCalledOnce()
      expect(validateAudio.release).toHaveBeenCalledOnce()
    })
    await discardDownloadedAudio({ stagingPath: path.join(dir, 'observable.lx-publishing.mp3') })
    await removeTask(task.id)
  })
})
