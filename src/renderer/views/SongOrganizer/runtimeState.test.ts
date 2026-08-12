import { describe, expect, it } from 'vitest'
import type { SongOrganizerRuntimeState, SongOrganizerSnapshot } from '@common/songOrganizer'
import {
  latestSongOrganizerRuntimeState,
  reconcileSongOrganizerRuntimeState,
  shouldApplySongOrganizerRuntimeState,
} from './runtimeState'
import { resolveSongOrganizerRoot } from '@common/songOrganizerRoot'

const snapshot = (root: string): SongOrganizerSnapshot => ({
  taskId: 'startup-task',
  root,
  status: 'complete',
  checkedCount: 0,
  totalAudioCount: 0,
  artists: [],
  anomalies: [],
  renamePlan: [],
  totals: {
    artistCount: 0,
    albumCount: 0,
    audioCount: 0,
    playableCount: 0,
    unplayableCount: 0,
    checkFailedCount: 0,
    unsupportedFileCount: 0,
    duplicateHardlinkCount: 0,
    reparsePointCount: 0,
    emptyDirectoryCount: 0,
    renameCount: 0,
  },
})

describe('song organizer renderer runtime reconciliation', () => {
  it('attaches to a same-root scan and adopts a same-root complete snapshot', () => {
    expect(reconcileSongOrganizerRuntimeState('C:\\Music', {
      revision: 1,
      status: 'scanning',
      taskId: 'startup-task',
      root: 'c:/music/',
    })).toBe('attach')

    expect(reconcileSongOrganizerRuntimeState('C:\\Music', {
      revision: 2,
      status: 'complete',
      taskId: 'startup-task',
      root: 'C:\\Music',
      snapshot: snapshot('C:\\Music'),
    })).toBe('adopt')
  })

  it('waits for Main to own idle, mismatched, or invalid complete root scans', () => {
    expect(reconcileSongOrganizerRuntimeState('C:\\Music', { revision: 0, status: 'idle' })).toBe('wait_for_main')
    expect(reconcileSongOrganizerRuntimeState('C:\\Music', {
      revision: 1,
      status: 'scanning',
      taskId: 'other-task',
      root: 'D:\\Music',
    })).toBe('wait_for_main')
    expect(reconcileSongOrganizerRuntimeState('C:\\Music', {
      revision: 2,
      status: 'complete',
      taskId: 'broken-task',
      root: 'C:\\Music',
    })).toBe('wait_for_main')
  })

  it('preserves an active operation for a same-root idle event but not for a real root change', () => {
    expect(reconcileSongOrganizerRuntimeState('C:\\Music', {
      revision: 3,
      status: 'idle',
      root: 'c:/music/',
    }, true)).toBe('preserve_operation')

    expect(reconcileSongOrganizerRuntimeState('D:\\Music', {
      revision: 4,
      status: 'idle',
      root: 'C:\\Music',
    }, true)).toBe('wait_for_main')
  })

  it('does not let an older queried scanning state replace a newer terminal event', () => {
    const completeEvent: SongOrganizerRuntimeState = {
      revision: 4,
      status: 'complete',
      taskId: 'startup-task',
      root: 'C:\\Music',
      snapshot: snapshot('C:\\Music'),
    }
    const staleQuery: SongOrganizerRuntimeState = {
      revision: 3,
      status: 'scanning',
      taskId: 'startup-task',
      root: 'C:\\Music',
    }

    expect(shouldApplySongOrganizerRuntimeState(0, completeEvent)).toBe(true)
    expect(shouldApplySongOrganizerRuntimeState(completeEvent.revision, staleQuery)).toBe(false)
    expect(latestSongOrganizerRuntimeState(staleQuery, completeEvent)).toBe(completeEvent)
    expect(latestSongOrganizerRuntimeState({ revision: 0, status: 'idle' }, completeEvent)).toBe(completeEvent)
  })

  it('falls back to the download root when the custom renderer root is blank', () => {
    expect(resolveSongOrganizerRoot({
      'download.savePath': 'C:\\Download',
      'songOrganizer.useCustomRoot': true,
      'songOrganizer.customRoot': '  ',
    })).toBe('C:\\Download')
  })
})
