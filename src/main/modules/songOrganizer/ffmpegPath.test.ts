import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSongOrganizerFfmpegPath } from './ffmpegPath'

describe('song organizer FFmpeg path', () => {
  it('finds the repository resource when the development app path is dist', () => {
    const repositoryRoot = path.resolve('C:/workspace/lx-music-desktop')
    const expected = path.join(repositoryRoot, 'resources', 'song-organizer', 'ffmpeg.exe')

    expect(resolveSongOrganizerFfmpegPath({
      isPackaged: false,
      appPath: path.join(repositoryRoot, 'dist'),
      resourcesPath: path.join(repositoryRoot, 'node_modules', 'electron', 'dist', 'resources'),
      exists: candidate => candidate == expected,
    })).toBe(expected)
  })

  it('uses process.resourcesPath for a packaged application', () => {
    const resourcesPath = path.resolve('C:/Program Files/LX Music/resources')

    expect(resolveSongOrganizerFfmpegPath({
      isPackaged: true,
      appPath: path.dirname(resourcesPath),
      resourcesPath,
      exists: () => false,
    })).toBe(path.join(resourcesPath, 'song-organizer', 'ffmpeg.exe'))
  })
})
