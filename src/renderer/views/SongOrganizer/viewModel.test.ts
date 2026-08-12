import { describe, expect, it } from 'vitest'
import type { SongOrganizerOperationResult, SongOrganizerSnapshot, SongOrganizerValidationSnapshot } from '@common/songOrganizer'
import type { I18n } from '@root/lang'
import {
  buildSongOrganizerArtistRows,
  buildSongOrganizerCheckProgress,
  buildSongOrganizerDetailLines,
  buildSongOrganizerOperationIssues,
  buildSongOrganizerReloadControl,
  isPathInDirectory,
  summarizeSongOrganizerOperation,
} from './viewModel'

const snapshot = (overrides: Partial<SongOrganizerSnapshot> = {}): SongOrganizerSnapshot => ({
  taskId: 'task',
  root: 'C:\\Music',
  status: 'complete',
  checkedCount: 2,
  totalAudioCount: 2,
  artists: [{
    path: 'C:\\Music\\Artist',
    name: 'Artist',
    baseName: 'Artist',
    audioCount: 2,
    playableCount: 1,
    unplayableCount: 1,
    checkFailedCount: 0,
    unsupportedFileCount: 1,
    targetName: 'Artist（2首）',
    needsRename: true,
    albums: [],
    blockedReasons: [],
  }],
  anomalies: [
    {
      id: 'unsupported',
      type: 'unsupported_file',
      path: 'C:\\Music\\Artist\\cover.jpg',
      relativePath: 'Artist\\cover.jpg',
      artistPath: 'C:\\Music\\Artist',
      artistName: 'Artist',
      size: 1,
      status: '待清理',
      cleanupEligible: true,
    },
    {
      id: 'broken',
      type: 'unplayable_audio',
      path: 'C:\\Music\\Artist\\broken.mp3',
      relativePath: 'Artist\\broken.mp3',
      artistPath: 'C:\\Music\\Artist',
      artistName: 'Artist',
      size: 1,
      status: '无法播放',
    },
  ],
  renamePlan: [{
    artistPath: 'C:\\Music\\Artist',
    artistName: 'Artist',
    targetName: 'Artist（2首）',
    steps: [{ type: 'artist', from: 'C:\\Music\\Artist', to: 'C:\\Music\\Artist（2首）' }],
    blockedReasons: [],
  }],
  totals: {
    artistCount: 1,
    albumCount: 0,
    audioCount: 2,
    playableCount: 1,
    unplayableCount: 1,
    checkFailedCount: 0,
    unsupportedFileCount: 1,
    duplicateHardlinkCount: 0,
    reparsePointCount: 0,
    emptyDirectoryCount: 0,
    renameCount: 1,
  },
  ...overrides,
})

const detailT: I18n['t'] = (key, values) => `[${String(key)}]${values ? JSON.stringify(values) : ''}`

describe('song organizer row view model', () => {
  it('offers reload only while idle and never turns it into a cancellation action', () => {
    expect(buildSongOrganizerReloadControl({ scanning: false, operating: false })).toEqual({
      disabled: false,
    })
    expect(buildSongOrganizerReloadControl({ scanning: true, operating: false })).toEqual({
      disabled: true,
    })
    expect(buildSongOrganizerReloadControl({ scanning: false, operating: true })).toEqual({
      disabled: true,
    })
    expect(buildSongOrganizerReloadControl({ scanning: true, operating: true })).toEqual({
      disabled: true,
    })
  })

  it('shows progress only while an artist audio check is validating files', () => {
    expect(buildSongOrganizerCheckProgress({
      taskId: 'quick',
      phase: 'discovering',
      checkedCount: 0,
      totalAudioCount: 0,
    })).toBeUndefined()
    expect(buildSongOrganizerCheckProgress({
      taskId: 'check',
      phase: 'validating',
      checkedCount: 3,
      totalAudioCount: 8,
      currentPath: 'C:\\Music\\Artist\\song.mp3',
    })).toEqual({
      checkedCount: 3,
      totalAudioCount: 8,
      currentPath: 'C:\\Music\\Artist\\song.mp3',
    })
  })

  it('shows quick rows as unchecked and enables organize only for the matching latest validation', () => {
    const fullValidationSnapshot = snapshot({ validationStatus: 'checked' })
    const quick = snapshot({
      validationStatus: 'unchecked',
      anomalies: fullValidationSnapshot.anomalies.filter(anomaly => anomaly.type != 'unplayable_audio'),
    })
    const [unchecked] = buildSongOrganizerArtistRows(quick, {
      snapshotOperable: true,
      playingBlockedReason: '正在播放',
    })
    const validation: SongOrganizerValidationSnapshot = {
      id: 'validation',
      taskId: 'validation',
      quickSnapshotId: quick.taskId,
      root: quick.root,
      artistPath: quick.artists[0].path,
      status: 'complete',
      checkedAt: 1,
      checkedCount: 2,
      totalAudioCount: 2,
      audioFingerprints: [],
      snapshot: fullValidationSnapshot,
    }
    const [checked] = buildSongOrganizerArtistRows(quick, {
      snapshotOperable: true,
      playingBlockedReason: '正在播放',
      validations: [validation],
    })

    expect(unchecked.validationStatus).toBe('unchecked')
    expect(unchecked.checkDisabledReason).toBeUndefined()
    expect(unchecked.organizeDisabledReason).toBe('check_required')
    expect(checked.validationStatus).toBe('checked')
    expect(checked.validation?.id).toBe('validation')
    expect(checked.audioAnomalyCount).toBe(1)
    expect(checked.organizeDisabledReason).toBeUndefined()
  })

  it('shows all applicable statuses and enables safe row actions', () => {
    const [row] = buildSongOrganizerArtistRows(snapshot(), {
      snapshotOperable: true,
      playingBlockedReason: '正在播放',
    })

    expect(row.statuses).toEqual(['pending_cleanup', 'pending_rename', 'audio_anomaly'])
    expect(row.cleanupDisabledReason).toBeUndefined()
    expect(row.renameDisabledReason).toBeUndefined()
  })

  it('disables rename for playback and cleanup for a stale snapshot', () => {
    const [playingRow] = buildSongOrganizerArtistRows(snapshot(), {
      snapshotOperable: true,
      playingFilePath: 'c:/music/artist/song.mp3',
      playingBlockedReason: '当前歌手正在播放。',
    })
    const [staleRow] = buildSongOrganizerArtistRows(snapshot(), {
      snapshotOperable: false,
      playingBlockedReason: '正在播放',
    })

    expect(playingRow.statuses).toContain('rename_blocked')
    expect(playingRow.renameDisabledReason).toBe('blocked')
    expect(playingRow.cleanupDisabledReason).toBeUndefined()
    expect(staleRow.cleanupDisabledReason).toBe('snapshot_outdated')
    expect(staleRow.renameDisabledReason).toBe('snapshot_outdated')
  })

  it('surfaces scan-time rename conflicts as visible blockers', () => {
    const conflictSnapshot = snapshot({
      renamePlan: [{ ...snapshot().renamePlan[0], blockedReasons: ['目标目录已存在。'] }],
    })
    const [row] = buildSongOrganizerArtistRows(conflictSnapshot, {
      snapshotOperable: true,
      playingBlockedReason: '正在播放',
    })

    expect(row.blockedReasons).toEqual(['目标目录已存在。'])
    expect(row.cleanupDisabledReason).toBeUndefined()
    expect(row.renameDisabledReason).toBe('blocked')
  })

  it('shows uncleanable cross-scope hardlinks as blockers without blocking rename', () => {
    const hardlinkSnapshot = snapshot({
      anomalies: [{
        id: 'cross-scope-hardlink',
        type: 'duplicate_hardlink',
        path: 'C:\\Music\\Artist\\Album A\\song.mp3',
        relativePath: 'Artist\\Album A\\song.mp3',
        artistPath: 'C:\\Music\\Artist',
        artistName: 'Artist',
        size: 1,
        status: '保留',
        reason: '硬链接跨专辑，禁止自动清理。',
        cleanupEligible: false,
      }],
    })
    const [row] = buildSongOrganizerArtistRows(hardlinkSnapshot, {
      snapshotOperable: true,
      playingBlockedReason: '正在播放',
    })

    expect(row.statuses).toEqual(['pending_rename', 'cleanup_blocked'])
    expect(row.cleanupDisabledReason).toBe('blocked')
    expect(row.cleanupBlockedReasons).toEqual(['硬链接跨专辑，禁止自动清理。'])
    expect(row.renameDisabledReason).toBeUndefined()
    expect(row.renameBlockedReasons).toEqual([])
  })

  it('keeps safe lyrics cleanup enabled when an active download only blocks rename', () => {
    const downloadBlockedSnapshot = snapshot({
      artists: [{
        ...snapshot().artists[0],
        blockedReasons: ['下载任务仍在进行。'],
      }],
      anomalies: [{
        id: 'old-lyrics',
        type: 'unsupported_file',
        path: 'C:\\Music\\Artist\\old.lrc',
        relativePath: 'Artist\\old.lrc',
        artistPath: 'C:\\Music\\Artist',
        artistName: 'Artist',
        size: 1,
        status: '待清理',
        cleanupEligible: true,
      }],
      renamePlan: [{
        ...snapshot().renamePlan[0],
        blockedReasons: ['下载任务仍在进行。'],
      }],
    })

    const [row] = buildSongOrganizerArtistRows(downloadBlockedSnapshot, {
      snapshotOperable: true,
      playingBlockedReason: '正在播放',
    })

    expect(row.statuses).toEqual(['pending_cleanup', 'pending_rename', 'rename_blocked'])
    expect(row.cleanupDisabledReason).toBeUndefined()
    expect(row.renameDisabledReason).toBe('blocked')
    expect(row.cleanupBlockedReasons).toEqual([])
  })

  it('uses action-specific blockers while some cleanup items stay available', () => {
    const mixedSnapshot = snapshot({
      artists: [{
        ...snapshot().artists[0],
        blockedReasons: ['下载任务仍在进行。'],
      }],
      anomalies: [
        {
          id: 'old-lyrics',
          type: 'unsupported_file',
          path: 'C:\\Music\\Artist\\old.lrc',
          relativePath: 'Artist\\old.lrc',
          artistPath: 'C:\\Music\\Artist',
          artistName: 'Artist',
          size: 1,
          status: '待清理',
          cleanupEligible: true,
        },
        {
          id: 'protected-hardlink',
          type: 'duplicate_hardlink',
          path: 'C:\\Music\\Artist\\Album\\song.mp3',
          relativePath: 'Artist\\Album\\song.mp3',
          artistPath: 'C:\\Music\\Artist',
          artistName: 'Artist',
          size: 1,
          status: '保留',
          reason: '硬链接跨专辑，禁止自动清理。',
          cleanupEligible: false,
        },
      ],
      renamePlan: [{
        ...snapshot().renamePlan[0],
        blockedReasons: ['下载任务仍在进行。'],
      }],
    })

    const [row] = buildSongOrganizerArtistRows(mixedSnapshot, {
      snapshotOperable: true,
      playingBlockedReason: '正在播放',
    })

    expect(row.statuses).toEqual(['pending_cleanup', 'pending_rename', 'cleanup_blocked', 'rename_blocked'])
    expect(row.cleanupDisabledReason).toBeUndefined()
    expect(row.renameDisabledReason).toBe('blocked')
  })
})

describe('song organizer detail lines', () => {
  it('shows only the empty state when there are no anomalies or blockers', () => {
    const lines = buildSongOrganizerDetailLines({ anomalies: [], blockedReasons: [] }, detailT)

    expect(lines).toEqual(['[song_organizer__detail_no_extra]'])
  })

  it('shows only blocker and anomaly details with the affected file path', () => {
    const anomaly = {
      ...snapshot().anomalies[1],
      reason: '解码失败。',
    }
    const lines = buildSongOrganizerDetailLines({
      anomalies: [anomaly],
      blockedReasons: ['目标目录已存在。'],
    }, detailT)

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('[song_organizer__detail_blocked]')
    expect(lines[1]).toContain('[song_organizer__detail_anomaly]')
    expect(lines[1]).toContain('Artist\\\\broken.mp3')
    expect(lines[1]).toContain('解码失败。')
    expect(lines.join('\n')).not.toContain('song_organizer__detail_artist')
    expect(lines.join('\n')).not.toContain('song_organizer__detail_target')
    expect(lines.join('\n')).not.toContain('song_organizer__detail_album')
  })

  it('keeps only the latest operation anomalies after a rescan and appends them after scan details', () => {
    const operationResult: SongOrganizerOperationResult = {
      taskId: 'cleanup-operation',
      type: 'cleanup',
      succeeded: [{ path: 'C:\\Music\\Artist\\removed.lrc', status: 'succeeded' }],
      skipped: [
        { path: 'C:\\Music\\Artist\\busy.lrc', status: 'skipped', reason: '文件正在使用。' },
        { path: 'C:\\Music\\Artist\\ignored.lrc', status: 'skipped' },
      ],
      failed: [{ path: 'C:\\Music\\Artist\\cover.jpg', status: 'failed', reason: 'trash_failed' }],
      rollbackFailed: [{ path: 'C:\\Music\\Artist\\song.mp3', status: 'rollback_failed', reason: 'rollback_failed' }],
    }
    const operationIssues = buildSongOrganizerOperationIssues(operationResult, 'C:\\Music')
    const [row] = buildSongOrganizerArtistRows(snapshot(), {
      snapshotOperable: true,
      playingBlockedReason: '正在播放',
      operationIssuesByArtist: new Map([['C:\\Music\\Artist', operationIssues]]),
    })

    const lines = buildSongOrganizerDetailLines(row, detailT)

    expect(operationIssues).toHaveLength(3)
    expect(lines.at(-3)).toContain('Artist\\\\busy.lrc')
    expect(lines.at(-2)).toContain('Artist\\\\cover.jpg')
    expect(lines.at(-1)).toContain('Artist\\\\song.mp3')
    expect(lines.join('\n')).toContain('trash_failed')
    expect(lines.join('\n')).toContain('rollback_failed')
    expect(lines.join('\n')).not.toContain('removed.lrc')
    expect(lines.join('\n')).not.toContain('ignored.lrc')
  })
})

describe('summarizeSongOrganizerOperation', () => {
  it('reports rolled back steps separately from successful steps', () => {
    const result: SongOrganizerOperationResult = {
      taskId: 'operation',
      type: 'rename',
      succeeded: [
        { path: 'A', targetPath: 'B', status: 'rolled_back' },
        { path: 'C', targetPath: 'D', status: 'succeeded' },
      ],
      skipped: [],
      failed: [],
      rollbackFailed: [],
    }

    const summary = summarizeSongOrganizerOperation(result)

    expect(summary.succeeded).toHaveLength(1)
    expect(summary.rolledBack).toHaveLength(1)
  })
})

describe('isPathInDirectory', () => {
  it('uses case-insensitive Windows path boundaries', () => {
    expect(isPathInDirectory('C:\\Music\\Artist', 'c:/music/artist/song.mp3')).toBe(true)
    expect(isPathInDirectory('C:\\Music\\Artist', 'C:\\Music\\Artist 2\\song.mp3')).toBe(false)
  })
})
