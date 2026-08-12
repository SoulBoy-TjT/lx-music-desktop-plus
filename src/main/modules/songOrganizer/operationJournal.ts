import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { SongOrganizerRecovery } from '@common/songOrganizer'

export type SongOrganizerJournal = SongOrganizerRecovery

const getJournalPath = (): string => path.join(global.lxDataPath, 'song-organizer-operation.json')

const replaceRetryDelays = [10, 25, 50, 100]

const replaceJournal = async(temp: string, target: string): Promise<void> => {
  let firstError: Error | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temp, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code != 'EPERM' && code != 'EACCES') throw error
      firstError ??= error as Error
      const delay = replaceRetryDelays[attempt]
      if (delay == null) throw firstError
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

const removeTempFile = async(temp: string): Promise<void> => {
  try {
    await fs.unlink(temp)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code != 'ENOENT') throw error
  }
}

export const writeJournal = async(journal: SongOrganizerJournal): Promise<void> => {
  const target = getJournalPath()
  const temp = `${target}.tmp`
  let writeError: Error | undefined
  try {
    await fs.writeFile(temp, JSON.stringify(journal, null, 2), 'utf8')
    await replaceJournal(temp, target)
  } catch (error) {
    writeError = error as Error
  }
  let cleanupError: Error | undefined
  try {
    await removeTempFile(temp)
  } catch (error) {
    cleanupError = error as Error
  }
  if (writeError) throw writeError
  if (cleanupError) throw cleanupError
}

export const readJournal = async(): Promise<SongOrganizerJournal | null> => {
  try {
    return JSON.parse(await fs.readFile(getJournalPath(), 'utf8')) as SongOrganizerJournal
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code == 'ENOENT') return null
    throw error
  }
}

export const clearJournal = async(): Promise<void> => {
  try {
    await fs.unlink(getJournalPath())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code != 'ENOENT') throw error
  }
}
