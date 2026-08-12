import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { createSongOrganizerFileIdentity, getSongOrganizerMtimeMs, lstatWithFileIdentity } from './fileIdentity'

const tempRoots: string[] = []

afterEach(async() => {
  await Promise.all(tempRoots.splice(0).map(async root => fs.rm(root, { recursive: true, force: true })))
})

describe('song organizer file identity', () => {
  it('reads filesystem identities without converting them to Number', async() => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-song-organizer-identity-'))
    tempRoots.push(root)
    const filePath = path.join(root, 'song.flac')
    await fs.writeFile(filePath, 'audio')

    const stat = await lstatWithFileIdentity(filePath)
    const numberStat = await fs.lstat(filePath)

    expect(typeof stat.dev).toBe('bigint')
    expect(typeof stat.ino).toBe('bigint')
    expect(getSongOrganizerMtimeMs(stat)).toBeCloseTo(numberStat.mtimeMs, 3)
  })

  it('keeps distinct 64-bit file ids that collide when coerced to Number', () => {
    const first = 21110623254199041n
    const second = 21110623254199038n

    expect(Number(first)).toBe(Number(second))
    expect(createSongOrganizerFileIdentity({ dev: 123n, ino: first }))
      .not.toBe(createSongOrganizerFileIdentity({ dev: 123n, ino: second }))
  })

  it('does not treat an unavailable zero inode as a stable identity', () => {
    expect(createSongOrganizerFileIdentity({ dev: 123n, ino: 0n })).toBeUndefined()
  })
})
