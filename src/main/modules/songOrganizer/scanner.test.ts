import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AudioValidator } from './audioValidator'
import { scanSongOrganizerRoot } from './scanner'
import { lstatWithFileIdentity, type SongOrganizerFileStat } from './fileIdentity'

const tempRoots: string[] = []
const createTempRoot = async() => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-song-organizer-test-'))
  tempRoots.push(root)
  return root
}

afterEach(async() => {
  await Promise.all(tempRoots.splice(0).map(async root => fs.rm(root, { recursive: true, force: true })))
})

const validator: AudioValidator = {
  async validate(filePath) {
    if (filePath.endsWith('broken.flac')) return { status: 'unplayable', errorCode: 'decode_failed', errorMessage: 'invalid data' }
    return { status: 'playable' }
  },
}

describe('song organizer scanner', () => {
  it('builds a quick snapshot without validating audio and excludes only generated MP3 artist directories', async() => {
    const root = await createTempRoot()
    const includedNames = ['Real Artist', 'MP3 Singer', 'Artist MP3 Live', 'ArtistMP3', 'Artist MP3（1首)', 'Artist MP3 （1首）', 'Artist MP3 (1首)']
    const excludedNames = ['Artist MP3', 'Artist MP3（1首）', 'Artist MP3(2首)']
    await Promise.all([...includedNames, ...excludedNames].map(async name => {
      const artist = path.join(root, name)
      await fs.mkdir(artist)
      await fs.writeFile(path.join(artist, 'song.mp3'), 'audio')
    }))
    const validate = vi.fn(async() => ({ status: 'playable' as const }))

    const snapshot = (await scanSongOrganizerRoot({
      root,
      validator: { validate },
      signal: new AbortController().signal,
      mode: 'quick',
    })).snapshot

    expect(validate).not.toHaveBeenCalled()
    expect(snapshot.validationStatus).toBe('unchecked')
    expect(snapshot.artists.map(artist => artist.name).sort()).toEqual(includedNames.sort())
    expect(snapshot.totals.audioCount).toBe(includedNames.length)
    expect(snapshot.totals.playableCount).toBe(0)
  })

  it.runIf(process.platform == 'win32')('excludes generated MP3 artist directories case-insensitively on Windows', async() => {
    const root = await createTempRoot()
    await fs.mkdir(path.join(root, 'Artist mP3（1首）'))

    const snapshot = (await scanSongOrganizerRoot({
      root,
      validator,
      signal: new AbortController().signal,
      mode: 'quick',
    })).snapshot

    expect(snapshot.artists).toEqual([])
  })

  it('discovers artist/album hierarchy, ignores root files, and builds anomalies and rename plans', async() => {
    const root = await createTempRoot()
    await fs.writeFile(path.join(root, 'ignored.mp3'), 'root file')
    const artist = path.join(root, '歌手')
    const album = path.join(artist, '专辑')
    const disc = path.join(album, 'CD1')
    await fs.mkdir(disc, { recursive: true })
    await fs.mkdir(path.join(album, 'empty'))
    await fs.mkdir(path.join(root, '空歌手'))
    await fs.writeFile(path.join(artist, 'single.mp3'), 'audio')
    await fs.writeFile(path.join(disc, 'broken.flac'), 'audio')
    await fs.writeFile(path.join(album, 'cover.jpg'), 'cover')

    const result = await scanSongOrganizerRoot({ root, validator, signal: new AbortController().signal })
    const snapshot = result.snapshot

    expect(snapshot.status).toBe('complete')
    expect(snapshot.totals.artistCount).toBe(2)
    expect(snapshot.totals.albumCount).toBe(1)
    expect(snapshot.totals.audioCount).toBe(2)
    expect(snapshot.totals.unplayableCount).toBe(1)
    expect(result.audioFingerprints).toHaveLength(2)
    expect(result.audioFingerprints).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: path.join(artist, 'single.mp3') }),
      expect.objectContaining({ path: path.join(disc, 'broken.flac') }),
    ]))
    expect(snapshot.totals.unsupportedFileCount).toBe(1)
    expect(snapshot.anomalies.some(item => item.path.endsWith('ignored.mp3'))).toBe(false)
    expect(snapshot.anomalies.map(item => item.type)).toEqual(expect.arrayContaining(['unplayable_audio', 'unsupported_file', 'empty_directory']))
    expect(snapshot.artists.find(item => item.name == '歌手')?.targetName).toBe('歌手（2首）')
    expect(snapshot.artists.find(item => item.name == '空歌手')?.targetName).toBe('空歌手（0首）')
    expect(snapshot.artists.find(item => item.name == '歌手')?.albums[0].targetName).toBe('专辑 (1首)')
  })

  it.runIf(process.platform == 'win32')('deduplicates a physical hardlink and only cleans links inside one album', async() => {
    const root = await createTempRoot()
    const album = path.join(root, '歌手', '专辑')
    await fs.mkdir(album, { recursive: true })
    const original = path.join(album, '01.mp3')
    const duplicate = path.join(album, '02.mp3')
    await fs.writeFile(original, 'audio')
    await fs.link(original, duplicate)

    const validate = vi.fn(async() => ({ status: 'playable' as const }))
    const snapshot = (await scanSongOrganizerRoot({ root, validator: { validate }, signal: new AbortController().signal })).snapshot
    const duplicateAnomaly = snapshot.anomalies.find(item => item.type == 'duplicate_hardlink')

    expect(validate).toHaveBeenCalledTimes(1)
    expect(snapshot.totals.audioCount).toBe(1)
    expect(snapshot.artists[0].albums[0].audioCount).toBe(1)
    expect(duplicateAnomaly?.cleanupEligible).toBe(true)
    expect(duplicateAnomaly?.keepPath).toBe(original)
  })

  it.runIf(process.platform == 'win32')('reports cross-album hardlinks without making them cleanup eligible', async() => {
    const root = await createTempRoot()
    const firstAlbum = path.join(root, 'Artist', 'Album A')
    const secondAlbum = path.join(root, 'Artist', 'Album B')
    await fs.mkdir(firstAlbum, { recursive: true })
    await fs.mkdir(secondAlbum, { recursive: true })
    const original = path.join(firstAlbum, 'first.flac')
    const hardlink = path.join(secondAlbum, 'second.flac')
    await fs.writeFile(original, 'audio')
    await fs.link(original, hardlink)
    const validate = vi.fn(async() => ({ status: 'playable' as const }))

    const snapshot = (await scanSongOrganizerRoot({ root, validator: { validate }, signal: new AbortController().signal })).snapshot
    const hardlinkAnomalies = snapshot.anomalies.filter(item => item.type == 'duplicate_hardlink')

    expect(validate).toHaveBeenCalledTimes(1)
    expect(snapshot.totals.audioCount).toBe(1)
    expect(snapshot.artists[0].albums.map(album => album.audioCount)).toEqual([1, 1])
    expect(hardlinkAnomalies).toHaveLength(2)
    expect(hardlinkAnomalies.every(item => item.cleanupEligible === false)).toBe(true)
  })

  it('keeps distinct exact file ids when their Number values collide', async() => {
    const root = await createTempRoot()
    const firstAlbum = path.join(root, 'Artist', 'Album A')
    const secondAlbum = path.join(root, 'Artist', 'Album B')
    await fs.mkdir(firstAlbum, { recursive: true })
    await fs.mkdir(secondAlbum, { recursive: true })
    const firstPath = path.join(firstAlbum, 'first.flac')
    const secondPath = path.join(secondAlbum, 'second.flac')
    await fs.writeFile(firstPath, 'audio')
    await fs.link(firstPath, secondPath)
    const exactIds = new Map([
      [path.resolve(firstPath), 21110623254199041n],
      [path.resolve(secondPath), 21110623254199038n],
    ])
    const lstat = async(target: string): Promise<SongOrganizerFileStat> => {
      const stat = await lstatWithFileIdentity(target)
      const ino = exactIds.get(path.resolve(target))
      if (ino == null) return stat
      return new Proxy(stat, {
        get(current, property, receiver) {
          if (property == 'ino') return ino
          if (property == 'nlink') return 1n
          return Reflect.get(current, property, receiver)
        },
      })
    }
    const validate = vi.fn(async() => ({ status: 'playable' as const }))

    const snapshot = (await scanSongOrganizerRoot({
      root,
      validator: { validate },
      signal: new AbortController().signal,
      lstat,
    })).snapshot

    expect(Number(exactIds.get(path.resolve(firstPath))!)).toBe(Number(exactIds.get(path.resolve(secondPath))!))
    expect(validate).toHaveBeenCalledTimes(2)
    expect(snapshot.totals.audioCount).toBe(2)
    expect(snapshot.artists[0].albums.reduce((count, album) => count + album.audioCount, 0)).toBe(2)
    expect(snapshot.anomalies.some(item => item.type == 'duplicate_hardlink')).toBe(false)
  })

  it('validates audio again on every scan', async() => {
    const root = await createTempRoot()
    const artist = path.join(root, '歌手')
    await fs.mkdir(artist)
    await fs.writeFile(path.join(artist, 'song.mp3'), 'audio')
    const validate = vi.fn(async() => ({ status: 'playable' as const }))

    await scanSongOrganizerRoot({ root, validator: { validate }, signal: new AbortController().signal })
    await scanSongOrganizerRoot({ root, validator: { validate }, signal: new AbortController().signal })

    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('validates independent audio with a bounded concurrency of two', async() => {
    const root = await createTempRoot()
    const album = path.join(root, 'Artist', 'Album')
    await fs.mkdir(album, { recursive: true })
    await Promise.all(Array.from({ length: 6 }, async(_, index) => {
      await fs.writeFile(path.join(album, `${index}.flac`), 'audio')
    }))
    let activeCount = 0
    let peakActiveCount = 0
    const validate = vi.fn(async() => {
      activeCount++
      peakActiveCount = Math.max(peakActiveCount, activeCount)
      await new Promise(resolve => setTimeout(resolve, 25))
      activeCount--
      return { status: 'playable' as const }
    })

    const snapshot = (await scanSongOrganizerRoot({
      root,
      validator: { validate },
      signal: new AbortController().signal,
    })).snapshot

    expect(validate).toHaveBeenCalledTimes(6)
    expect(peakActiveCount).toBe(2)
    expect(snapshot.checkedCount).toBe(6)
    expect(snapshot.totals.playableCount).toBe(6)
  })

  it('waits for active validators to settle when a concurrent scan is cancelled', async() => {
    const root = await createTempRoot()
    const album = path.join(root, 'Artist', 'Album')
    await fs.mkdir(album, { recursive: true })
    await Promise.all(Array.from({ length: 4 }, async(_, index) => {
      await fs.writeFile(path.join(album, `${index}.flac`), 'audio')
    }))
    const controller = new AbortController()
    let activeCount = 0
    const validate = vi.fn(async(_filePath: string, signal: AbortSignal) => new Promise<{ status: 'check_failed', errorCode: string, errorMessage: string }>(resolve => {
      activeCount++
      signal.addEventListener('abort', () => {
        activeCount--
        resolve({ status: 'check_failed', errorCode: 'scan_cancelled', errorMessage: '音频检查已取消。' })
      }, { once: true })
    }))

    const scan = scanSongOrganizerRoot({ root, validator: { validate }, signal: controller.signal })
    await vi.waitFor(() => {
      expect(validate).toHaveBeenCalledTimes(2)
    })
    controller.abort()
    const snapshot = (await scan).snapshot

    expect(snapshot.status).toBe('cancelled')
    expect(validate).toHaveBeenCalledTimes(2)
    expect(activeCount).toBe(0)
    expect(snapshot.checkedCount).toBe(2)
  })

  it('aborts sibling validators and rethrows the first validation error after they settle', async() => {
    const root = await createTempRoot()
    const album = path.join(root, 'Artist', 'Album')
    await fs.mkdir(album, { recursive: true })
    await Promise.all(Array.from({ length: 4 }, async(_, index) => {
      await fs.writeFile(path.join(album, `${index}.flac`), 'audio')
    }))
    const expectedError = new Error('validator crashed')
    let activeSiblingCount = 0
    const validate = vi.fn(async(filePath: string, signal: AbortSignal) => {
      if (filePath.endsWith(`${path.sep}0.flac`)) {
        await new Promise(resolve => setTimeout(resolve, 5))
        throw expectedError
      }
      return new Promise<{ status: 'check_failed', errorCode: string, errorMessage: string }>(resolve => {
        activeSiblingCount++
        signal.addEventListener('abort', () => {
          activeSiblingCount--
          resolve({ status: 'check_failed', errorCode: 'scan_cancelled', errorMessage: '音频检查已取消。' })
        }, { once: true })
      })
    })

    await expect(scanSongOrganizerRoot({
      root,
      validator: { validate },
      signal: new AbortController().signal,
    })).rejects.toBe(expectedError)

    expect(validate).toHaveBeenCalledTimes(2)
    expect(activeSiblingCount).toBe(0)
  })

  it('keeps anomaly output ordered when concurrent validations finish out of order', async() => {
    const root = await createTempRoot()
    const album = path.join(root, 'Artist', 'Album')
    await fs.mkdir(album, { recursive: true })
    await fs.writeFile(path.join(album, 'a.flac'), 'audio')
    await fs.writeFile(path.join(album, 'b.flac'), 'audio')
    const validate = vi.fn(async(filePath: string) => {
      await new Promise(resolve => setTimeout(resolve, filePath.endsWith('a.flac') ? 30 : 5))
      return { status: 'unplayable' as const, errorCode: 'decode_failed', errorMessage: 'invalid data' }
    })

    const snapshot = (await scanSongOrganizerRoot({
      root,
      validator: { validate },
      signal: new AbortController().signal,
    })).snapshot

    expect(snapshot.anomalies.filter(item => item.type == 'unplayable_audio').map(item => path.basename(item.path))).toEqual(['a.flac', 'b.flac'])
  })

  it('uses an exact path fallback when locale collation treats distinct paths as equal', async() => {
    const root = await createTempRoot()
    const album = path.join(root, 'Artist', 'Album')
    await fs.mkdir(album, { recursive: true })
    await fs.writeFile(path.join(album, 'e.flac'), 'audio')
    await fs.writeFile(path.join(album, 'é.flac'), 'audio')
    const validate = vi.fn(async(filePath: string) => {
      await new Promise(resolve => setTimeout(resolve, filePath.endsWith(`${path.sep}e.flac`) ? 30 : 5))
      return { status: 'unplayable' as const, errorCode: 'decode_failed', errorMessage: 'invalid data' }
    })

    const snapshot = (await scanSongOrganizerRoot({
      root,
      validator: { validate },
      signal: new AbortController().signal,
    })).snapshot

    expect(snapshot.anomalies.filter(item => item.type == 'unplayable_audio').map(item => path.basename(item.path))).toEqual(['e.flac', 'é.flac'])
  })

  it.runIf(process.platform == 'win32')('matches download blockers case-insensitively on Windows', async() => {
    const root = await createTempRoot()
    const artist = path.join(root, 'Artist')
    await fs.mkdir(artist)
    await fs.writeFile(path.join(artist, 'song.mp3'), 'audio')
    const validate = vi.fn(async() => ({ status: 'playable' as const }))
    const blockedReason = '下载任务仍在进行。'

    const snapshot = (await scanSongOrganizerRoot({
      root,
      validator: { validate },
      signal: new AbortController().signal,
      blockedArtistPaths: new Map([[artist.toLocaleUpperCase('en-US'), [blockedReason]]]),
    })).snapshot

    expect(validate).not.toHaveBeenCalled()
    expect(snapshot.artists[0].blockedReasons).toEqual([blockedReason])
    expect(snapshot.renamePlan[0].blockedReasons).toContain(blockedReason)
  })

  it('blocks a rename plan when its target path already exists', async() => {
    const root = await createTempRoot()
    const artist = path.join(root, '歌手')
    const target = path.join(root, '歌手（1首）')
    await fs.mkdir(artist)
    await fs.mkdir(target)
    await fs.writeFile(path.join(artist, 'song.mp3'), 'audio')

    const snapshot = (await scanSongOrganizerRoot({ root, validator, signal: new AbortController().signal })).snapshot
    const summary = snapshot.artists.find(item => item.path == artist)
    const plan = snapshot.renamePlan.find(item => item.artistPath == artist)
    const reason = `目标路径已存在：${target}`

    expect(summary?.blockedReasons).not.toContain(reason)
    expect(plan?.blockedReasons).toContain(reason)
  })

  it('keeps unsupported-only albums cleanable while blocking their rename plan', async() => {
    const root = await createTempRoot()
    const artist = path.join(root, '歌手')
    const album = path.join(artist, '仅封面专辑')
    await fs.mkdir(album, { recursive: true })
    await fs.writeFile(path.join(album, 'cover.jpg'), 'cover')

    const snapshot = (await scanSongOrganizerRoot({ root, validator, signal: new AbortController().signal })).snapshot
    const summary = snapshot.artists.find(item => item.path == artist)
    const plan = snapshot.renamePlan.find(item => item.artistPath == artist)

    expect(summary?.blockedReasons).toEqual([])
    expect(plan?.blockedReasons).toContain('专辑“仅封面专辑”没有 MP3/FLAC 且仍含未清理文件。')
    expect(snapshot.anomalies.some(item => item.type == 'unsupported_file' && item.artistPath == artist)).toBe(true)
  })
})
