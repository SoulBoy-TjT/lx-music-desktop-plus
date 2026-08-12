import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readJournal, writeJournal, type SongOrganizerJournal } from './operationJournal'

const tempRoots: string[] = []
const originalLxDataPath = Object.getOwnPropertyDescriptor(global, 'lxDataPath')

const createJournal = (operationId: string): SongOrganizerJournal => ({
  operationId,
  type: 'rename',
  root: 'C:\\Music',
  startedAt: 1,
  completed: false,
  steps: [],
})

afterEach(async() => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.splice(0).map(async root => fs.rm(root, { recursive: true, force: true })))
  if (originalLxDataPath) Object.defineProperty(global, 'lxDataPath', originalLxDataPath)
  else Reflect.deleteProperty(global, 'lxDataPath')
})

describe('song organizer operation journal', () => {
  it.each(['EPERM', 'EACCES'] as const)('retries a transient Windows %s while replacing an existing journal', async(code) => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-song-organizer-journal-test-'))
    tempRoots.push(dataPath)
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: dataPath })
    await writeJournal(createJournal('old-operation'))

    const target = path.join(dataPath, 'song-organizer-operation.json')
    const originalRename = fs.rename.bind(fs)
    let replacementAttempts = 0
    vi.spyOn(fs, 'rename').mockImplementation(async(from, to) => {
      if (path.resolve(String(to)) == path.resolve(target)) {
        replacementAttempts++
        if (replacementAttempts == 1) {
          const error = new Error(`${code}: operation not permitted, rename '${String(from)}' -> '${String(to)}'`) as NodeJS.ErrnoException
          error.code = code
          throw error
        }
      }
      await originalRename(from, to)
    })

    await expect(writeJournal(createJournal('new-operation'))).resolves.toBeUndefined()
    await expect(readJournal()).resolves.toMatchObject({ operationId: 'new-operation' })
    expect(replacementAttempts).toBe(2)
  })

  it('keeps the existing journal and returns the original error after persistent EPERM', async() => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-song-organizer-journal-test-'))
    tempRoots.push(dataPath)
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: dataPath })
    await writeJournal(createJournal('old-operation'))

    const target = path.join(dataPath, 'song-organizer-operation.json')
    const temp = `${target}.tmp`
    const error = new Error(`EPERM: operation not permitted, rename '${temp}' -> '${target}'`) as NodeJS.ErrnoException
    error.code = 'EPERM'
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(error)

    await expect(writeJournal(createJournal('new-operation'))).rejects.toBe(error)
    await expect(readJournal()).resolves.toMatchObject({ operationId: 'old-operation' })
    await expect(fs.lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(rename).toHaveBeenCalledTimes(5)
  })
})
