import type { SongOrganizerOperationProgress } from '@common/songOrganizer'
import { normalizeSongOrganizerPathKey, type SongOrganizerOperationIssue } from './viewModel'

export interface ActiveSongOrganizerOperation {
  operationId: string
  sourceTaskId: string
  artistPath: string
}

export const shouldApplySongOrganizerOperationProgress = (
  active: ActiveSongOrganizerOperation | undefined,
  progress: SongOrganizerOperationProgress,
): boolean => {
  if (!active) return false
  return progress.operationId == active.operationId &&
    progress.sourceTaskId == active.sourceTaskId &&
    normalizeSongOrganizerPathKey(progress.artistPath) == normalizeSongOrganizerPathKey(active.artistPath)
}

export const replaceSongOrganizerOperationIssues = (
  current: ReadonlyMap<string, SongOrganizerOperationIssue[]>,
  artistPath: string,
  issues: SongOrganizerOperationIssue[],
): Map<string, SongOrganizerOperationIssue[]> => {
  const next = new Map<string, SongOrganizerOperationIssue[]>()
  for (const [path, currentIssues] of current) next.set(normalizeSongOrganizerPathKey(path), currentIssues)
  const key = normalizeSongOrganizerPathKey(artistPath)
  if (issues.length) next.set(key, issues)
  else next.delete(key)
  return next
}

export const clearSongOrganizerOperationIssues = (): Map<string, SongOrganizerOperationIssue[]> => new Map()
