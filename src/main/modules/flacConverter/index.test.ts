import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlacConverterService, resolveFlacOutputDirectory } from './index'
import { buildFlacConversionArgs } from './ffmpegAdapter'
import { AudioFfmpegTerminationError } from '../audioFfmpeg/processTermination'

const execFileAsync = promisify(execFile)
const ffmpegPath = path.resolve('resources', 'song-organizer', 'ffmpeg.exe')
const tempRoots: string[] = []

const createTempRoot = async(): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-flac-converter-test-'))
  tempRoots.push(root)
  return root
}

const digest = async(filePath: string): Promise<string> => createHash('sha256').update(await fs.readFile(filePath)).digest('hex')

afterEach(async() => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map(async root => fs.rm(root, { recursive: true, force: true })))
})

describe('FLAC conversion arguments', () => {
  it('uses fixed 320 kbps libmp3lame settings and optional cover mapping', () => {
    const args = buildFlacConversionArgs('source.flac', 'target.tmp')
    expect(args).toContain('libmp3lame')
    expect(args).toContain('320k')
    expect(args).toContain('0:v?')
    expect(args.slice(-3)).toEqual(['-f', 'mp3', 'target.tmp'])
  })
})

describe('FLAC directory conversion preview', () => {
  it('defaults to a source-named sibling directory and preserves relative paths', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer（2首）')
    const albumDirectory = path.join(sourceDirectory, 'Album')
    await fs.mkdir(albumDirectory, { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(albumDirectory, '01. Song.flac'), 'first'),
      fs.writeFile(path.join(albumDirectory, 'cover.jpg'), 'ignored'),
    ])
    const service = new FlacConverterService('unused', async() => true)

    const preview = await service.preview({ sourceDirectory })

    const outputDirectory = path.join(root, 'Singer MP3')
    expect(resolveFlacOutputDirectory(sourceDirectory)).toBe(outputDirectory)
    expect(preview.outputDirectory).toBe(outputDirectory)
    expect(preview.readyCount).toBe(1)
    expect(preview.items[0]).toEqual(expect.objectContaining({
      sourcePath: path.join(albumDirectory, '01. Song.flac'),
      targetPath: path.join(outputDirectory, 'Album', '01. Song.mp3'),
      status: 'ready',
    }))
  })

  it('uses a selected output parent and never overwrites an existing MP3', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'lossless', 'Singer')
    const outputParentDirectory = path.join(root, 'exports')
    const outputDirectory = path.join(outputParentDirectory, 'Singer MP3')
    await Promise.all([
      fs.mkdir(sourceDirectory, { recursive: true }),
      fs.mkdir(outputDirectory, { recursive: true }),
    ])
    const sourcePath = path.join(sourceDirectory, 'Song.FLAC')
    await Promise.all([
      fs.writeFile(sourcePath, 'source'),
      fs.writeFile(path.join(outputDirectory, 'Song.mp3'), 'keep'),
    ])
    const service = new FlacConverterService('unused', async() => true)

    const preview = await service.preview({ sourceDirectory, outputParentDirectory })

    expect(preview.outputDirectory).toBe(outputDirectory)
    expect(preview.readyCount).toBe(0)
    expect(preview.items).toEqual([
      expect.objectContaining({ sourcePath, status: 'skipped', reason: expect.stringContaining('禁止覆盖') }),
    ])
  })

  it('excludes the generated output subtree when it is inside the source directory', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const nestedOutputDirectory = path.join(sourceDirectory, 'Singer MP3')
    await fs.mkdir(nestedOutputDirectory, { recursive: true })
    const sourcePath = path.join(sourceDirectory, 'Song.flac')
    await Promise.all([
      fs.writeFile(sourcePath, 'source'),
      fs.writeFile(path.join(nestedOutputDirectory, 'Historical.flac'), 'must not be scanned'),
    ])
    const service = new FlacConverterService('unused', async() => true)

    const preview = await service.preview({
      sourceDirectory,
      outputParentDirectory: sourceDirectory,
    })

    expect(preview.outputDirectory).toBe(nestedOutputDirectory)
    expect(preview.items.map(item => item.sourcePath)).toEqual([sourcePath])
  })

  it('scans first-level artist folders and excludes generated MP3 folders', async() => {
    const root = await createTempRoot()
    const artistDirectory = path.join(root, 'Artist（2首）')
    const generatedOutput = path.join(root, 'Artist MP3')
    const emptyArtist = path.join(root, 'Empty Artist')
    await Promise.all([
      fs.mkdir(artistDirectory, { recursive: true }),
      fs.mkdir(generatedOutput, { recursive: true }),
      fs.mkdir(emptyArtist, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(artistDirectory, 'Song.flac'), 'flac'),
      fs.writeFile(path.join(artistDirectory, 'Existing.mp3'), 'mp3'),
      fs.writeFile(path.join(generatedOutput, 'Output.mp3'), 'ignored'),
    ])
    const service = new FlacConverterService('unused', async() => true)

    const result = await service.scanArtistFolders({ rootDirectory: root })

    expect(result.artists).toEqual([
      expect.objectContaining({ name: 'Artist（2首）', flacCount: 1, mp3Count: 1, songCount: 2 }),
      expect.objectContaining({ name: 'Empty Artist', flacCount: 0, mp3Count: 0, songCount: 0 }),
    ])
  })
})

describe('FLAC conversion output directory naming', () => {
  it('ignores mixed Chinese and ASCII song-count suffix pairs as output candidates', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    await Promise.all([
      fs.mkdir(sourceDirectory),
      fs.mkdir(path.join(root, 'Singer MP3（1首)')),
      fs.mkdir(path.join(root, 'Singer MP3(2首）')),
    ])
    const service = new FlacConverterService('unused', async() => true)

    const preview = await service.preview({ sourceDirectory })

    expect(preview.outputDirectory).toBe(path.join(root, 'Singer MP3'))
  })

  it.skipIf(process.platform != 'win32')('matches output candidates and generated directory names case-insensitively on Windows', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const outputDirectory = path.join(root, 'singer mp3（1首）')
    await Promise.all([
      fs.mkdir(sourceDirectory),
      fs.mkdir(outputDirectory),
    ])
    await Promise.all([
      fs.writeFile(path.join(sourceDirectory, 'Song.mp3'), 'source'),
      fs.writeFile(path.join(outputDirectory, 'Song.mp3'), 'output'),
    ])
    const service = new FlacConverterService('unused', async() => true)

    const result = await service.scanArtistFolders({ rootDirectory: root })

    expect(result.artists).toEqual([
      expect.objectContaining({
        name: 'Singer',
        outputDirectory,
        songCount: 1,
      }),
    ])
  })

  it('blocks a custom output parent whose ancestor is a reparse point', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const targetDirectory = path.join(root, 'external')
    const targetOutputParent = path.join(targetDirectory, 'exports')
    const linkedDirectory = path.join(root, 'linked')
    const outputParentDirectory = path.join(linkedDirectory, 'exports')
    await Promise.all([
      fs.mkdir(sourceDirectory),
      fs.mkdir(targetOutputParent, { recursive: true }),
    ])
    await fs.symlink(targetDirectory, linkedDirectory, process.platform == 'win32' ? 'junction' : 'dir')
    const sourcePath = path.join(sourceDirectory, 'Song.mp3')
    await fs.writeFile(sourcePath, 'source')
    const service = new FlacConverterService('unused', async() => true)
    const params = { sourceDirectory, outputParentDirectory }

    await expect(service.preview(params)).rejects.toThrow('MP3 输出父目录不能包含重解析点')
    await expect(service.convert({ ...params, confirmedSourcePaths: [sourcePath] })).rejects.toThrow('MP3 输出父目录不能包含重解析点')
    await expect(fs.readdir(targetOutputParent)).resolves.toEqual([])
  })

  it('appends the actual output MP3 count after a successful conversion', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, '刘雨昕（1首）')
    const sourcePath = path.join(sourceDirectory, 'Song.mp3')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source mp3')
    const service = new FlacConverterService('unused', async() => true)
    const preview = await service.preview({ sourceDirectory })

    const result = await service.convert({
      sourceDirectory,
      confirmedSourcePaths: preview.items.map(item => item.sourcePath),
    })

    const outputDirectory = path.join(root, '刘雨昕 MP3（1首）')
    const targetPath = path.join(outputDirectory, 'Song.mp3')
    expect(result).toEqual(expect.objectContaining({
      outputDirectory,
      sourceSongCount: 1,
      outputSongCount: 1,
      countMatches: true,
    }))
    expect(result.succeeded).toEqual([{ sourcePath, targetPath }])
    await expect(fs.stat(targetPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(fs.stat(path.join(root, '刘雨昕 MP3'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reuses one existing counted output directory and refreshes its count', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const oldOutputDirectory = path.join(root, 'Singer MP3（1首）')
    await Promise.all([
      fs.mkdir(sourceDirectory),
      fs.mkdir(oldOutputDirectory),
    ])
    const firstSourcePath = path.join(sourceDirectory, 'First.mp3')
    const secondSourcePath = path.join(sourceDirectory, 'Second.mp3')
    await Promise.all([
      fs.writeFile(firstSourcePath, 'first'),
      fs.writeFile(secondSourcePath, 'second'),
      fs.writeFile(path.join(oldOutputDirectory, 'First.mp3'), 'first'),
    ])
    const service = new FlacConverterService('unused', async() => true)
    const preview = await service.preview({ sourceDirectory })

    const result = await service.convert({
      sourceDirectory,
      confirmedSourcePaths: preview.items.filter(item => item.status == 'ready').map(item => item.sourcePath),
    })

    const outputDirectory = path.join(root, 'Singer MP3（2首）')
    expect(preview.outputDirectory).toBe(oldOutputDirectory)
    expect(result.outputDirectory).toBe(outputDirectory)
    expect(result.succeeded).toEqual([{
      sourcePath: secondSourcePath,
      targetPath: path.join(outputDirectory, 'Second.mp3'),
    }])
    expect(result.skipped).toEqual([expect.objectContaining({
      sourcePath: firstSourcePath,
      targetPath: path.join(outputDirectory, 'First.mp3'),
      reason: expect.stringContaining('禁止覆盖'),
    })])
    await expect(fs.stat(path.join(outputDirectory, 'First.mp3'))).resolves.toBeDefined()
    await expect(fs.stat(path.join(outputDirectory, 'Second.mp3'))).resolves.toBeDefined()
    await expect(fs.stat(oldOutputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(root, 'Singer MP3'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reuses an ASCII-counted output directory and normalizes the refreshed final suffix', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const oldOutputDirectory = path.join(root, 'Singer MP3(1首)')
    await Promise.all([
      fs.mkdir(sourceDirectory),
      fs.mkdir(oldOutputDirectory),
    ])
    const firstSourcePath = path.join(sourceDirectory, 'First.mp3')
    const secondSourcePath = path.join(sourceDirectory, 'Second.mp3')
    await Promise.all([
      fs.writeFile(firstSourcePath, 'first'),
      fs.writeFile(secondSourcePath, 'second'),
      fs.writeFile(path.join(oldOutputDirectory, 'First.mp3'), 'first'),
    ])
    const service = new FlacConverterService('unused', async() => true)
    const preview = await service.preview({ sourceDirectory })

    const result = await service.convert({
      sourceDirectory,
      confirmedSourcePaths: preview.items.filter(item => item.status == 'ready').map(item => item.sourcePath),
    })

    const outputDirectory = path.join(root, 'Singer MP3（2首）')
    expect(preview.outputDirectory).toBe(oldOutputDirectory)
    expect(result.outputDirectory).toBe(outputDirectory)
    await expect(fs.stat(path.join(outputDirectory, 'First.mp3'))).resolves.toBeDefined()
    await expect(fs.stat(path.join(outputDirectory, 'Second.mp3'))).resolves.toBeDefined()
    await expect(fs.stat(oldOutputDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adds the final count below a custom output parent without renaming the parent', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer（9首）')
    const outputParentDirectory = path.join(root, 'Exports（7首）')
    const sourcePath = path.join(sourceDirectory, 'Song.mp3')
    await Promise.all([
      fs.mkdir(sourceDirectory),
      fs.mkdir(outputParentDirectory),
    ])
    await fs.writeFile(sourcePath, 'source')
    const service = new FlacConverterService('unused', async() => true)
    const preview = await service.preview({ sourceDirectory, outputParentDirectory })

    const result = await service.convert({
      sourceDirectory,
      outputParentDirectory,
      confirmedSourcePaths: preview.items.map(item => item.sourcePath),
    })

    const outputDirectory = path.join(outputParentDirectory, 'Singer MP3（1首）')
    expect(result.outputDirectory).toBe(outputDirectory)
    await expect(fs.readFile(path.join(outputDirectory, 'Song.mp3'), 'utf8')).resolves.toBe('source')
    expect((await fs.stat(outputParentDirectory)).isDirectory()).toBe(true)
    await expect(fs.stat(path.join(root, 'Exports MP3（1首）'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.stat(sourceDirectory)).isDirectory()).toBe(true)
  })

  it('blocks conversion before writing when multiple output directory candidates exist', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const plainOutputDirectory = path.join(root, 'Singer MP3')
    const countedOutputDirectory = path.join(root, 'Singer MP3（1首）')
    await Promise.all([
      fs.mkdir(sourceDirectory),
      fs.mkdir(plainOutputDirectory),
      fs.mkdir(countedOutputDirectory),
    ])
    const sourcePath = path.join(sourceDirectory, 'Song.mp3')
    await fs.writeFile(sourcePath, 'source')
    const service = new FlacConverterService('unused', async() => true)

    await expect(service.convert({
      sourceDirectory,
      confirmedSourcePaths: [sourcePath],
    })).rejects.toThrow('存在多个 MP3 输出目录候选')

    await expect(fs.readdir(plainOutputDirectory)).resolves.toEqual([])
    await expect(fs.readdir(countedOutputDirectory)).resolves.toEqual([])
  })

  it('blocks a counted output candidate that is a reparse point', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const linkTarget = path.join(root, 'external')
    const countedOutputDirectory = path.join(root, 'Singer MP3（1首）')
    await Promise.all([
      fs.mkdir(sourceDirectory),
      fs.mkdir(linkTarget),
    ])
    await fs.symlink(linkTarget, countedOutputDirectory, process.platform == 'win32' ? 'junction' : 'dir')
    const sourcePath = path.join(sourceDirectory, 'Song.mp3')
    await fs.writeFile(sourcePath, 'source')
    const service = new FlacConverterService('unused', async() => true)

    await expect(service.convert({
      sourceDirectory,
      confirmedSourcePaths: [sourcePath],
    })).rejects.toThrow('必须是普通文件夹')

    await expect(fs.readdir(linkTarget)).resolves.toEqual([])
    await expect(fs.stat(path.join(root, 'Singer MP3'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves both directories and reports a clear error when the final rename target appears concurrently', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const plainOutputDirectory = path.join(root, 'Singer MP3')
    const countedOutputDirectory = path.join(root, 'Singer MP3（1首）')
    const sourcePath = path.join(sourceDirectory, 'Song.mp3')
    const sentinelPath = path.join(countedOutputDirectory, 'keep.txt')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source')
    const service = new FlacConverterService('unused', async() => true)
    let injectedConflict = false
    service.setProgressListener(progress => {
      if (injectedConflict || progress.phase != 'running') return
      injectedConflict = true
      mkdirSync(countedOutputDirectory)
      writeFileSync(sentinelPath, 'keep')
    })

    await expect(service.convert({
      sourceDirectory,
      confirmedSourcePaths: [sourcePath],
    })).rejects.toThrow('MP3 输出目录目标已存在，禁止覆盖或合并')

    await expect(fs.readFile(path.join(plainOutputDirectory, 'Song.mp3'), 'utf8')).resolves.toBe('source')
    await expect(fs.readFile(sentinelPath, 'utf8')).resolves.toBe('keep')
    await expect(fs.stat(path.join(countedOutputDirectory, 'Song.mp3'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('blocks the final rename when a differently counted candidate appears during conversion', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const plainOutputDirectory = path.join(root, 'Singer MP3')
    const conflictingOutputDirectory = path.join(root, 'Singer MP3（9首）')
    const sourcePath = path.join(sourceDirectory, 'Song.mp3')
    const sentinelPath = path.join(conflictingOutputDirectory, 'keep.txt')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source')
    const service = new FlacConverterService('unused', async() => true)
    let injectedConflict = false
    service.setProgressListener(progress => {
      if (injectedConflict || progress.phase != 'running') return
      injectedConflict = true
      mkdirSync(conflictingOutputDirectory)
      writeFileSync(sentinelPath, 'keep')
    })

    await expect(service.convert({
      sourceDirectory,
      confirmedSourcePaths: [sourcePath],
    })).rejects.toThrow('转换期间出现新的 MP3 输出目录候选')

    await expect(fs.readFile(path.join(plainOutputDirectory, 'Song.mp3'), 'utf8')).resolves.toBe('source')
    await expect(fs.readFile(sentinelPath, 'utf8')).resolves.toBe('keep')
    await expect(fs.stat(path.join(root, 'Singer MP3（1首）'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is idempotent when the counted output directory already matches the actual count', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const sourcePath = path.join(sourceDirectory, 'Song.mp3')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source')
    const service = new FlacConverterService('unused', async() => true)
    const firstPreview = await service.preview({ sourceDirectory })
    const firstResult = await service.convert({
      sourceDirectory,
      confirmedSourcePaths: firstPreview.items.map(item => item.sourcePath),
    })

    const secondPreview = await service.preview({ sourceDirectory })
    const secondResult = await service.convert({
      sourceDirectory,
      confirmedSourcePaths: secondPreview.items.filter(item => item.status == 'ready').map(item => item.sourcePath),
    })

    const outputDirectory = path.join(root, 'Singer MP3（1首）')
    expect(firstResult.outputDirectory).toBe(outputDirectory)
    expect(secondPreview.outputDirectory).toBe(outputDirectory)
    expect(secondResult).toEqual(expect.objectContaining({
      outputDirectory,
      sourceSongCount: 1,
      outputSongCount: 1,
      countMatches: true,
      succeeded: [],
    }))
    expect(secondResult.skipped).toEqual([expect.objectContaining({
      sourcePath,
      targetPath: path.join(outputDirectory, 'Song.mp3'),
    })])
    expect((await fs.readdir(root)).sort()).toEqual(['Singer', 'Singer MP3（1首）'])
  })

  it('uses the actual output count and final paths when one source file fails', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const goodSourcePath = path.join(sourceDirectory, 'Good.mp3')
    const brokenSourcePath = path.join(sourceDirectory, 'Broken.flac')
    await fs.mkdir(sourceDirectory)
    await Promise.all([
      fs.writeFile(goodSourcePath, 'good'),
      fs.writeFile(brokenSourcePath, 'not flac'),
    ])
    const service = new FlacConverterService(path.join(root, 'missing-ffmpeg.exe'), async() => true)
    const preview = await service.preview({ sourceDirectory })

    const result = await service.convert({
      sourceDirectory,
      confirmedSourcePaths: preview.items.map(item => item.sourcePath),
    })

    const outputDirectory = path.join(root, 'Singer MP3（1首）')
    expect(result).toEqual(expect.objectContaining({
      outputDirectory,
      sourceSongCount: 2,
      outputSongCount: 1,
      countMatches: false,
    }))
    expect(result.succeeded).toEqual([{
      sourcePath: goodSourcePath,
      targetPath: path.join(outputDirectory, 'Good.mp3'),
    }])
    expect(result.failed).toEqual([expect.objectContaining({
      sourcePath: brokenSourcePath,
      targetPath: path.join(outputDirectory, 'Broken.mp3'),
      reason: expect.any(String),
    })])
    await expect(fs.readFile(path.join(outputDirectory, 'Good.mp3'), 'utf8')).resolves.toBe('good')
  })
})

describe('FLAC conversion safe shutdown', () => {
  it.runIf(process.platform == 'win32' && process.arch == 'x64')('does not turn an ordinary conversion error into a sticky exit failure', async() => {
    let resolveAvailability!: (available: boolean) => void
    const availability = new Promise<boolean>(resolve => { resolveAvailability = resolve })
    const service = new FlacConverterService('unused', async() => await availability)
    const conversionOutcome = service.convert({
      sourceDirectory: 'unused',
      confirmedSourcePaths: [],
    }).then(
      () => undefined,
      error => error as Error,
    )
    expect(service.isBusy()).toBe(true)

    const shutdown = service.cancelAndWait('app-close')
    resolveAvailability(false)

    await expect(shutdown).resolves.toBeUndefined()
    await expect(conversionOutcome).resolves.toEqual(expect.objectContaining({
      message: expect.stringContaining('内置 FFmpeg 不可用'),
    }))
    expect(service.getTerminationFailure()).toBeUndefined()
  })

  it('retains an unconfirmed termination failure after the conversion is no longer busy', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const sourcePath = path.join(sourceDirectory, 'Song.flac')
    const terminationError = new AudioFfmpegTerminationError('FFmpeg still running')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source flac bytes')
    const service = new FlacConverterService('unused', async() => true, () => ({
      convert: async() => { throw terminationError },
    }))

    await expect(service.convert({ sourceDirectory, confirmedSourcePaths: [sourcePath] })).rejects.toBe(terminationError)

    expect(service.isBusy()).toBe(false)
    expect(service.getTerminationFailure()).toBe(terminationError)
  })

  it('treats repeated cancellation without an active conversion as an idempotent no-op', async() => {
    const service = new FlacConverterService('unused', async() => true)

    await Promise.all([
      service.cancelAndWait('app-close'),
      service.cancelAndWait('app-before-quit'),
    ])

    expect(service.isBusy()).toBe(false)
  })

  it('cancels a conversion paused at an item boundary and keeps only published output', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const firstSourcePath = path.join(sourceDirectory, 'First.mp3')
    const secondSourcePath = path.join(sourceDirectory, 'Second.mp3')
    await fs.mkdir(sourceDirectory)
    await Promise.all([
      fs.writeFile(firstSourcePath, 'first'),
      fs.writeFile(secondSourcePath, 'second'),
    ])
    const service = new FlacConverterService('unused', async() => true)
    const preview = await service.preview({ sourceDirectory })
    let resolvePaused!: () => void
    const paused = new Promise<void>(resolve => { resolvePaused = resolve })
    service.setProgressListener(progress => {
      if (progress.phase == 'running' && progress.completedCount == 0) service.setPaused(true)
      if (progress.phase == 'paused') resolvePaused()
    })

    const conversion = service.convert({
      sourceDirectory,
      confirmedSourcePaths: preview.items.map(item => item.sourcePath),
    })
    await paused
    await service.cancelAndWait('app-close')
    const result = await conversion

    expect(service.isBusy()).toBe(false)
    expect(result.succeeded).toEqual([expect.objectContaining({ sourcePath: firstSourcePath })])
    expect(result.succeeded).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: secondSourcePath }),
    ]))
    expect((await fs.readdir(result.outputDirectory)).some(name => name.includes('.lx-converting-'))).toBe(false)
    await expect(fs.readFile(firstSourcePath, 'utf8')).resolves.toBe('first')
    await expect(fs.readFile(secondSourcePath, 'utf8')).resolves.toBe('second')
  })

  it('waits for the active encoder to stop and removes its unpublished temporary file', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const sourcePath = path.join(sourceDirectory, 'Song.flac')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source flac bytes')
    let resolveStarted!: () => void
    let resolveStopped!: () => void
    const started = new Promise<void>(resolve => { resolveStarted = resolve })
    const mayStop = new Promise<void>(resolve => { resolveStopped = resolve })
    const converter = {
      async convert(_sourcePath: string, targetPath: string, signal: AbortSignal): Promise<void> {
        await fs.writeFile(targetPath, 'unpublished bytes')
        resolveStarted()
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            void mayStop.then(() => { reject(new Error(String(signal.reason))) })
          }, { once: true })
        })
      },
    }
    const service = new FlacConverterService('unused', async() => true, () => converter)

    const conversion = service.convert({ sourceDirectory, confirmedSourcePaths: [sourcePath] })
    const firstState = await Promise.race([
      started.then(() => 'started' as const),
      conversion.then(() => 'settled' as const),
    ])

    expect(firstState).toBe('started')
    const shutdown = service.cancelAndWait('app-close')
    let shutdownSettled = false
    void shutdown.then(() => { shutdownSettled = true })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)
    resolveStopped()
    await shutdown
    const result = await conversion

    expect(service.isBusy()).toBe(false)
    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual([expect.objectContaining({
      sourcePath,
      reason: expect.stringContaining('app-close'),
    })])
    expect((await fs.readdir(result.outputDirectory)).some(name => name.includes('.lx-converting-'))).toBe(false)
    expect((await fs.readdir(result.outputDirectory)).some(name => name.endsWith('.mp3'))).toBe(false)
    await expect(fs.readFile(sourcePath, 'utf8')).resolves.toBe('source flac bytes')
  })

  it('propagates an unconfirmed encoder termination so safe exit remains blocked', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const sourcePath = path.join(sourceDirectory, 'Song.flac')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source flac bytes')
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => { resolveStarted = resolve })
    const converter = {
      async convert(_sourcePath: string, targetPath: string, signal: AbortSignal): Promise<void> {
        await fs.writeFile(targetPath, 'unpublished bytes')
        resolveStarted()
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new AudioFfmpegTerminationError('无法确认 FFmpeg 已退出。'))
          }, { once: true })
        })
      },
    }
    const service = new FlacConverterService('unused', async() => true, () => converter)

    const conversion = service.convert({ sourceDirectory, confirmedSourcePaths: [sourcePath] })
    const conversionOutcome = conversion.then(
      () => undefined,
      error => error as Error,
    )
    await started

    await expect(service.cancelAndWait('app-close')).rejects.toThrow('无法确认 FFmpeg 已退出。')
    expect(await conversionOutcome).toEqual(expect.objectContaining({ message: '无法确认 FFmpeg 已退出。' }))
    expect(service.isBusy()).toBe(false)
  })

  it('does not publish an encoder result that finishes concurrently with cancellation', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const sourcePath = path.join(sourceDirectory, 'Song.flac')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source flac bytes')
    let resolveStarted!: () => void
    let resolveCompleted!: () => void
    const started = new Promise<void>(resolve => { resolveStarted = resolve })
    const mayComplete = new Promise<void>(resolve => { resolveCompleted = resolve })
    const converter = {
      async convert(_sourcePath: string, targetPath: string): Promise<void> {
        await fs.writeFile(targetPath, 'unpublished bytes')
        resolveStarted()
        await mayComplete
      },
    }
    const service = new FlacConverterService('unused', async() => true, () => converter)

    const conversion = service.convert({ sourceDirectory, confirmedSourcePaths: [sourcePath] })
    await started
    const shutdown = service.cancelAndWait('app-close')
    resolveCompleted()
    await shutdown
    const result = await conversion

    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual([expect.objectContaining({
      sourcePath,
      reason: expect.stringContaining('app-close'),
    })])
    expect((await fs.readdir(result.outputDirectory)).some(name => name.endsWith('.mp3'))).toBe(false)
  })

  it('retries a transient EPERM while deleting the cancelled item temporary file', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const sourcePath = path.join(sourceDirectory, 'Song.flac')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source flac bytes')
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => { resolveStarted = resolve })
    const converter = {
      async convert(_sourcePath: string, targetPath: string, signal: AbortSignal): Promise<void> {
        await fs.writeFile(targetPath, 'unpublished bytes')
        resolveStarted()
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error(String(signal.reason))) }, { once: true })
        })
      },
    }
    const unlink = fs.unlink.bind(fs)
    let tempUnlinkAttempts = 0
    let resolveFirstCleanupAttempt!: () => void
    const firstCleanupAttempt = new Promise<void>(resolve => { resolveFirstCleanupAttempt = resolve })
    vi.spyOn(fs, 'unlink').mockImplementation(async targetPath => {
      if (String(targetPath).includes('.lx-converting-')) {
        tempUnlinkAttempts++
        if (tempUnlinkAttempts == 1) resolveFirstCleanupAttempt()
      }
      if (String(targetPath).includes('.lx-converting-') && tempUnlinkAttempts < 3) {
        throw Object.assign(new Error('locked'), { code: 'EPERM' })
      }
      await unlink(targetPath)
    })
    const service = new FlacConverterService('unused', async() => true, () => converter)

    const conversion = service.convert({ sourceDirectory, confirmedSourcePaths: [sourcePath] })
    await started
    const shutdown = service.cancelAndWait('app-close')
    await firstCleanupAttempt
    expect(service.isBusy()).toBe(true)
    await shutdown
    const result = await conversion

    expect(tempUnlinkAttempts).toBe(3)
    expect(service.isBusy()).toBe(false)
    expect((await fs.readdir(result.outputDirectory)).some(name => name.includes('.lx-converting-'))).toBe(false)
  })

  it('rejects safe shutdown when temporary-file EPERM retries are exhausted', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Singer')
    const sourcePath = path.join(sourceDirectory, 'Song.flac')
    await fs.mkdir(sourceDirectory)
    await fs.writeFile(sourcePath, 'source flac bytes')
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => { resolveStarted = resolve })
    const converter = {
      async convert(_sourcePath: string, targetPath: string, signal: AbortSignal): Promise<void> {
        await fs.writeFile(targetPath, 'unpublished bytes')
        resolveStarted()
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error(String(signal.reason))) }, { once: true })
        })
      },
    }
    let tempUnlinkAttempts = 0
    vi.spyOn(fs, 'unlink').mockImplementation(async targetPath => {
      if (String(targetPath).includes('.lx-converting-')) {
        tempUnlinkAttempts++
        throw Object.assign(new Error('locked'), { code: 'EPERM' })
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    const service = new FlacConverterService('unused', async() => true, () => converter)

    const conversion = service.convert({ sourceDirectory, confirmedSourcePaths: [sourcePath] })
    const conversionOutcome = conversion.then(
      () => undefined,
      error => error as Error,
    )
    await started

    await expect(service.cancelAndWait('app-close')).rejects.toThrow('临时文件')
    expect(await conversionOutcome).toEqual(expect.objectContaining({ message: expect.stringContaining('临时文件') }))
    expect(tempUnlinkAttempts).toBeGreaterThan(1)
    expect(service.isBusy()).toBe(false)
  })
})

describe.skipIf(process.platform != 'win32' || process.arch != 'x64' || !existsSync(ffmpegPath))('real FLAC conversion', () => {
  it('converts FLAC, copies MP3, and reports matching source/output counts', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Source')
    const albumDirectory = path.join(sourceDirectory, 'Album')
    const sourcePath = path.join(albumDirectory, 'tone.flac')
    const sourceMp3Path = path.join(albumDirectory, 'existing.mp3')
    await fs.mkdir(albumDirectory, { recursive: true })
    await execFileAsync(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-c:a', 'flac', sourcePath,
    ])
    await execFileAsync(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=550:duration=0.2', '-c:a', 'libmp3lame', sourceMp3Path,
    ])
    const sourceDigest = await digest(sourcePath)
    const sourceMp3Digest = await digest(sourceMp3Path)
    const service = new FlacConverterService(ffmpegPath, async() => true)
    const preview = await service.preview({ sourceDirectory })

    const result = await service.convert({
      sourceDirectory,
      confirmedSourcePaths: preview.items.map(item => item.sourcePath),
    })
    const outputDirectory = path.join(root, 'Source MP3（2首）')
    const targetPath = path.join(outputDirectory, 'Album', 'tone.mp3')
    const copiedTargetPath = path.join(outputDirectory, 'Album', 'existing.mp3')

    expect(result).toEqual(expect.objectContaining({
      outputDirectory,
      sourceSongCount: 2,
      outputSongCount: 2,
      countMatches: true,
    }))
    expect(result.succeeded).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath, targetPath }),
      expect.objectContaining({ sourcePath: sourceMp3Path, targetPath: copiedTargetPath }),
    ]))
    expect(await digest(sourcePath)).toBe(sourceDigest)
    expect(await digest(sourceMp3Path)).toBe(sourceMp3Digest)
    expect(await digest(copiedTargetPath)).toBe(sourceMp3Digest)
    await expect(fs.stat(targetPath)).resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }))
    await expect(execFileAsync(ffmpegPath, ['-v', 'error', '-nostdin', '-i', targetPath, '-map', '0:a:0', '-f', 'null', '-'])).resolves.toBeDefined()
    expect((await fs.readdir(path.dirname(targetPath))).some(name => name.includes('.lx-converting-'))).toBe(false)
  })

  it('reports a count mismatch when the output directory contains an extra MP3', async() => {
    const root = await createTempRoot()
    const sourceDirectory = path.join(root, 'Source')
    const outputDirectory = path.join(root, 'Source MP3')
    await Promise.all([
      fs.mkdir(sourceDirectory, { recursive: true }),
      fs.mkdir(outputDirectory, { recursive: true }),
    ])
    await Promise.all([
      fs.writeFile(path.join(sourceDirectory, 'Song.mp3'), 'source mp3'),
      fs.writeFile(path.join(outputDirectory, 'Unexpected.mp3'), 'unexpected output'),
    ])
    const service = new FlacConverterService(ffmpegPath, async() => true)
    const preview = await service.preview({ sourceDirectory })

    const result = await service.convert({
      sourceDirectory,
      confirmedSourcePaths: preview.items.map(item => item.sourcePath),
    })

    expect(result).toEqual(expect.objectContaining({
      sourceSongCount: 1,
      outputSongCount: 2,
      countMatches: false,
    }))
  })
})
