import path from 'node:path'
import { resolveSongOrganizerRoot } from '@common/songOrganizerRoot'
import type { SongOrganizerRootSetting } from '@common/songOrganizerRoot'

export { resolveSongOrganizerRoot as resolveSongOrganizerStartupRoot } from '@common/songOrganizerRoot'
export type { SongOrganizerRootSetting } from '@common/songOrganizerRoot'

export const canStartSongOrganizerPrescan = (platform: NodeJS.Platform, arch: string): boolean => platform == 'win32' && arch == 'x64'

const rootSettingKeys = new Set<string>([
  'download.savePath',
  'songOrganizer.useCustomRoot',
  'songOrganizer.customRoot',
])

interface SongOrganizerPrescanControllerOptions {
  platform: NodeJS.Platform
  arch: string
  getSetting: () => SongOrganizerRootSetting
  scan: (root: string) => Promise<unknown>
  onError: (error: unknown) => void
}

export interface SongOrganizerPrescanController {
  start: () => void
  handleConfigChange: (keys: readonly string[]) => void
}

export const createSongOrganizerPrescanController = (options: SongOrganizerPrescanControllerOptions): SongOrganizerPrescanController => {
  let lastRequestedRootKey: string | undefined
  const normalizeRoot = (root: string): string => (options.platform == 'win32' ? path.win32.resolve(root) : path.resolve(root))
    .toLocaleLowerCase('en-US')

  const requestScan = (): void => {
    if (!canStartSongOrganizerPrescan(options.platform, options.arch)) return
    const root = resolveSongOrganizerRoot(options.getSetting())
    if (!root) return
    const rootKey = normalizeRoot(root)
    if (rootKey == lastRequestedRootKey) return
    lastRequestedRootKey = rootKey
    void options.scan(root).catch(options.onError)
  }

  return {
    start: requestScan,
    handleConfigChange(keys) {
      if (keys.some(key => rootSettingKeys.has(key))) requestScan()
    },
  }
}
