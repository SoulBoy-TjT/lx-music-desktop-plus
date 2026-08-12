import type { SongOrganizerApplyParams } from '@common/songOrganizer'

export const createSongOrganizerApplyParams = (
  taskId: string,
  artistPaths: readonly string[],
  playingFilePath?: string,
  operationId?: string,
): SongOrganizerApplyParams => ({
  taskId,
  operationId,
  artistPaths: [...artistPaths],
  playingFilePath,
})
