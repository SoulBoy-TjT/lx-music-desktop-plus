import { describe, expect, it } from 'vitest'
import type { SongOrganizerOperationProgress } from '@common/songOrganizer'
import {
  clearSongOrganizerOperationIssues,
  replaceSongOrganizerOperationIssues,
  shouldApplySongOrganizerOperationProgress,
  type ActiveSongOrganizerOperation,
} from './operationFeedback'
import type { SongOrganizerOperationIssue } from './viewModel'

const activeOperation: ActiveSongOrganizerOperation = {
  operationId: 'operation-new',
  sourceTaskId: 'scan-new',
  artistPath: 'C:\\Music\\Artist',
}

const progress = (overrides: Partial<SongOrganizerOperationProgress> = {}): SongOrganizerOperationProgress => ({
  operationId: 'operation-new',
  sourceTaskId: 'scan-new',
  type: 'rename',
  phase: 'renaming',
  artistPath: 'C:\\Music\\Artist',
  completed: 1,
  total: 2,
  currentRelativeTarget: 'Artist（2首）',
  ...overrides,
})

describe('song organizer operation feedback', () => {
  it('rejects stale operation, stale scan task, and other artist progress events', () => {
    expect(shouldApplySongOrganizerOperationProgress(activeOperation, progress())).toBe(true)
    expect(shouldApplySongOrganizerOperationProgress(activeOperation, progress({ operationId: 'operation-old' }))).toBe(false)
    expect(shouldApplySongOrganizerOperationProgress(activeOperation, progress({ sourceTaskId: 'scan-old' }))).toBe(false)
    expect(shouldApplySongOrganizerOperationProgress(activeOperation, progress({ artistPath: 'C:\\Music\\Other' }))).toBe(false)
  })

  it('replaces the same artist issues and clears all issues on root change', () => {
    const oldIssue: SongOrganizerOperationIssue = {
      operation: 'cleanup',
      phase: 'cleanup',
      status: 'failed',
      relativePath: 'Artist\\old.lrc',
      reason: 'old failure',
    }
    const newIssue: SongOrganizerOperationIssue = {
      operation: 'rename',
      phase: 'renaming',
      status: 'failed',
      relativePath: 'Artist',
      reason: 'new failure',
    }
    const initial = new Map([['C:\\Music\\Artist', [oldIssue]]])

    const replaced = replaceSongOrganizerOperationIssues(initial, 'c:/music/artist', [newIssue])
    const removedByNextSuccessfulOperation = replaceSongOrganizerOperationIssues(replaced, 'C:\\Music\\Artist', [])
    const clearedForRootChange = clearSongOrganizerOperationIssues()

    expect(replaced.size).toBe(1)
    expect([...replaced.values()][0]).toEqual([newIssue])
    expect(removedByNextSuccessfulOperation.size).toBe(0)
    expect(clearedForRootChange.size).toBe(0)
  })
})
