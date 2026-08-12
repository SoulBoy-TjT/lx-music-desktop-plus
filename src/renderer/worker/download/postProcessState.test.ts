import { describe, expect, it } from 'vitest'
import {
  decodeDownloadMusicInfoMetadata,
  encodeDownloadMusicInfoMetadata,
  getDownloadRequestedQuality,
  isDownloadCompleted,
} from '@common/utils/downloadTask'
import {
  getDownloadStartupAction,
  applyDownloadPublication,
  getDownloadCompletedStatusKey,
  isDownloadPostProcessingFailed,
  isDownloadPostProcessing,
  isDownloadPostProcessingPending,
  markDownloadCompleted,
  markDownloadPostProcessingFailed,
  markDownloadPostProcessing,
  type DownloadPostProcessState,
} from '@renderer/store/download/postProcessState'

const createTask = (status: LX.Download.DownloadTaskStatus, isComplate: boolean): DownloadPostProcessState => ({
  status,
  isComplate,
  progress: 42,
  speed: '1 MB',
  writeQueue: 3,
  statusText: 'old',
})

const createMusicInfo = (): LX.Music.MusicInfoOnline => ({
  id: 'wy_song',
  name: '歌曲',
  singer: '歌手',
  source: 'wy',
  interval: null,
  meta: {
    songId: 'song',
    albumName: '专辑',
    picUrl: '',
    qualitys: [],
    _qualitys: {},
  },
})

describe('download post-processing state', () => {
  it('exposes files only after both completion fields agree', () => {
    expect(isDownloadCompleted(createTask('completed', true))).toBe(true)
    expect(isDownloadCompleted(createTask('run', true))).toBe(false)
    expect(isDownloadCompleted(createTask('completed', false))).toBe(false)
  })

  it('recognizes only the persisted run and completed-transfer combination', () => {
    expect(isDownloadPostProcessing(createTask('run', true))).toBe(true)
    expect(isDownloadPostProcessing(createTask('run', false))).toBe(false)
    expect(isDownloadPostProcessing(createTask('completed', true))).toBe(false)
    expect(isDownloadPostProcessingFailed(createTask('error', true))).toBe(true)
    expect(isDownloadPostProcessingFailed(createTask('error', false))).toBe(false)
    expect(isDownloadPostProcessingPending(createTask('error', true))).toBe(true)
    expect(isDownloadPostProcessingPending(createTask('pause', true))).toBe(true)
    expect(isDownloadPostProcessingPending(createTask('completed', true))).toBe(false)
  })

  it('resumes persisted post-processing while pausing interrupted transfers', () => {
    expect(getDownloadStartupAction(createTask('run', true))).toBe('resume_post_processing')
    expect(getDownloadStartupAction(createTask('error', true))).toBe('resume_post_processing')
    expect(getDownloadStartupAction(createTask('pause', true))).toBe('resume_post_processing')
    expect(getDownloadStartupAction(createTask('run', false))).toBe('pause')
    expect(getDownloadStartupAction(createTask('waiting', false))).toBe('pause')
    expect(getDownloadStartupAction(createTask('completed', true))).toBe('keep')
  })

  it.each(['stage_final_conflict', 'final_verification_failed'])(
    'does not auto-resume a blocking publication recovery error: %s',
    code => {
      expect(getDownloadStartupAction({
        ...createTask('error', true),
        metadata: {
          postProcessingError: {
            phase: 'publication',
            code,
            message: 'blocked',
            taskId: 'blocked-download',
            filePath: 'C:\\Music\\blocked.mp3',
          },
        },
      })).toBe('keep')
    },
  )

  it('creates the persisted marker before transitioning to completed', () => {
    const task = createTask('run', false)

    markDownloadPostProcessing(task, 'processing')
    expect(task).toMatchObject({
      status: 'run',
      isComplate: true,
      progress: 100,
      speed: '',
      writeQueue: 0,
      statusText: 'processing',
    })

    markDownloadCompleted(task, 'completed')
    expect(task).toMatchObject({
      status: 'completed',
      isComplate: true,
      progress: 100,
      speed: '',
      writeQueue: 0,
      statusText: 'completed',
    })

    markDownloadPostProcessingFailed(task, 'failed')
    expect(task).toMatchObject({
      status: 'error',
      isComplate: true,
      progress: 100,
      statusText: 'failed',
    })
  })

  it('applies the actual publication and exposes the downgrade completion status', () => {
    const task = {
      ...createTask('run', false),
      id: 'download_flac_flac',
      downloaded: 0,
      total: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: 'https://example.test/audio',
        requestedQuality: 'flac',
        quality: 'flac',
        ext: 'flac',
        fileName: 'download.flac',
        filePath: 'C:\\Music\\download.flac',
      },
    } satisfies LX.Download.ListItem

    applyDownloadPublication(task, {
      filePath: 'C:\\Music\\download.mp3',
      fileName: 'download.mp3',
      stagingPath: 'C:\\Music\\download.lx-publishing.mp3',
      ext: 'mp3',
      quality: '320k',
      actualFormat: {
        container: 'mp3',
        codec: 'mp3',
        bitrate: 320_000,
      },
      downgrade: {
        reason: 'lossless_unavailable',
        requestedQuality: 'flac',
        actualQuality: '320k',
      },
    })

    expect(task.metadata).toMatchObject({
      filePath: 'C:\\Music\\download.mp3',
      fileName: 'download.mp3',
      stagingPath: 'C:\\Music\\download.lx-publishing.mp3',
      ext: 'mp3',
      quality: '320k',
      actualFormat: { container: 'mp3', codec: 'mp3', bitrate: 320_000 },
      formatDowngrade: {
        reason: 'lossless_unavailable',
        requestedQuality: 'flac',
        actualQuality: '320k',
      },
    })
    expect(getDownloadCompletedStatusKey(task)).toBe('download___status_completed_downgraded_mp3')
    expect(getDownloadRequestedQuality(task)).toBe('flac')
  })

  it('recovers the immutable requested quality from old downgrade metadata', () => {
    const task = {
      metadata: {
        quality: '192k' as const,
        formatDowngrade: {
          reason: 'quality_downgrade' as const,
          requestedQuality: '320k' as const,
          actualQuality: '192k' as const,
        },
      },
    }

    expect(getDownloadRequestedQuality(task)).toBe('320k')
  })

  it('uses an explicit completion status for a same-format quality downgrade', () => {
    const task = {
      ...createTask('run', false),
      id: 'quality-downgrade',
      downloaded: 0,
      total: 0,
      metadata: {
        musicInfo: createMusicInfo(),
        url: 'https://example.test/audio',
        quality: '192k',
        ext: 'mp3',
        fileName: 'download.mp3',
        filePath: 'C:\\Music\\download.mp3',
        formatDowngrade: {
          reason: 'quality_downgrade',
          requestedQuality: '320k',
          actualQuality: '192k',
        },
      },
    } satisfies LX.Download.ListItem

    expect(getDownloadCompletedStatusKey(task)).toBe('download___status_completed_downgraded_quality')
  })

  it('round-trips actual-format publication metadata through download persistence', () => {
    const musicInfo = createMusicInfo()
    const persisted = JSON.parse(JSON.stringify(encodeDownloadMusicInfoMetadata(musicInfo, {
      requestedQuality: 'flac',
      targetFallbacks: ['path_truncated'],
      actualFormat: { container: 'mp3', codec: 'mp3', bitrate: 320_000 },
      formatDowngrade: {
        reason: 'lossless_unavailable',
        requestedQuality: 'flac',
        actualQuality: '320k',
      },
      stagingPath: 'C:\\Music\\download.lx-publishing.mp3',
    }))) as LX.Music.MusicInfoOnline

    const restored = decodeDownloadMusicInfoMetadata(persisted)

    expect(restored).toMatchObject({
      requestedQuality: 'flac',
      targetFallbacks: ['path_truncated'],
      actualFormat: { container: 'mp3', codec: 'mp3', bitrate: 320_000 },
      formatDowngrade: {
        reason: 'lossless_unavailable',
        requestedQuality: 'flac',
        actualQuality: '320k',
      },
      stagingPath: 'C:\\Music\\download.lx-publishing.mp3',
    })
    expect(restored.musicInfo.meta).not.toHaveProperty('__downloadActualFormat')
    expect(restored.musicInfo.meta).not.toHaveProperty('__downloadFormatDowngrade')
    expect(restored.musicInfo.meta).not.toHaveProperty('__downloadRequestedQuality')
  })
})
