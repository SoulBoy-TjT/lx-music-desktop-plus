import path from 'node:path'
import { access, constants } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { app } from 'electron'

interface AudioFfmpegPathContext {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
  exists?: (candidate: string) => boolean
}

const relativeFfmpegPath = path.join('song-organizer', 'ffmpeg.exe')

export const resolveAudioFfmpegPath = ({
  isPackaged,
  appPath,
  resourcesPath,
  exists = existsSync,
}: AudioFfmpegPathContext): string => {
  if (isPackaged) return path.join(resourcesPath, relativeFfmpegPath)
  const candidates = [
    path.join(appPath, 'resources', relativeFfmpegPath),
    path.join(path.dirname(appPath), 'resources', relativeFfmpegPath),
  ]
  return candidates.find(exists) ?? candidates[0]
}

export const resolveBundledAudioFfmpegPath = (): string => resolveAudioFfmpegPath({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
})

export const isAudioFfmpegAvailable = async(ffmpegPath = resolveBundledAudioFfmpegPath()): Promise<boolean> => {
  try {
    await access(ffmpegPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}
