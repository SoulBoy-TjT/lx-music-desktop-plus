export interface SongOrganizerRootSetting {
  'download.savePath': string
  'songOrganizer.useCustomRoot': boolean
  'songOrganizer.customRoot': string
}

export const resolveSongOrganizerRoot = (setting: SongOrganizerRootSetting): string => {
  const customRoot = setting['songOrganizer.customRoot'].trim()
  if (setting['songOrganizer.useCustomRoot'] && customRoot) return customRoot
  return setting['download.savePath'].trim()
}
