import {
  coordinateDownloadTaskRemoval,
  coordinateDownloadTaskRetry,
  reserveDownloadTaskStart,
} from '@renderer/store/download/downloadActionSeams'
import { describe, expect, it, vi } from 'vitest'

const createTask = (code = 'completed_state_persist_failed'): LX.Download.ListItem => ({
  id: 'action-download',
  isComplate: true,
  status: 'error',
  statusText: 'failed',
  downloaded: 100,
  total: 100,
  progress: 100,
  speed: '',
  writeQueue: 0,
  metadata: {
    musicInfo: {
      id: 'wy_song',
      name: '歌曲',
      singer: '歌手',
      source: 'wy',
      interval: null,
      meta: { songId: 'song', albumName: '专辑', picUrl: '', qualitys: [], _qualitys: {} },
    },
    url: 'https://example.test/audio',
    requestedQuality: 'flac',
    quality: '320k',
    ext: 'mp3',
    fileName: '歌曲.mp3',
    filePath: 'C:\\Music\\歌曲.mp3',
    stagingPath: 'C:\\Music\\歌曲.lx-publishing.mp3',
    actualFormat: { container: 'mp3', codec: 'mp3', bitrate: 320_000 },
    postProcessingError: {
      phase: 'persistence',
      code,
      message: 'failed',
      taskId: 'action-download',
      filePath: 'C:\\Music\\歌曲.mp3',
    },
  },
})

describe('download action executable seams', () => {
  it('reconciles a same-session completed-state retry without queueing post-processing or restarting download', async() => {
    const task = createTask()
    const reconcile = vi.fn(async() => {
      task.status = 'completed'
      delete task.metadata.stagingPath
      return 'complete_final' as const
    })
    const enqueuePostProcessing = vi.fn()
    const restartDownload = vi.fn()

    await expect(coordinateDownloadTaskRetry(task, {
      reconcile,
      enqueuePostProcessing,
      restartDownload,
    })).resolves.toBe('completed')
    expect(reconcile).toHaveBeenCalledOnce()
    expect(enqueuePostProcessing).not.toHaveBeenCalled()
    expect(restartDownload).not.toHaveBeenCalled()
  })

  it.each([
    'stage_final_conflict',
    'final_verification_failed',
    'publication_recovery_failed',
    'staging_cleanup_failed',
  ])('never queues a blocking publication error: %s', async code => {
    const task = createTask(code)
    const reconcile = vi.fn(async() => 'resume_stage' as const)
    const enqueuePostProcessing = vi.fn()
    await expect(coordinateDownloadTaskRetry(task, {
      reconcile,
      enqueuePostProcessing,
      restartDownload: vi.fn(),
    })).resolves.toBe('blocked')
    expect(reconcile).not.toHaveBeenCalled()
    expect(enqueuePostProcessing).not.toHaveBeenCalled()
  })

  it('discards stage-only removal but blocks final-only and conflicting artifacts', async() => {
    const discard = vi.fn(async() => {})
    const persistBlocked = vi.fn(async() => {})
    const stageTask = createTask()
    await expect(coordinateDownloadTaskRemoval(stageTask, {
      inspectPaths: async() => ({ stagingExists: true, finalExists: false }),
      discard,
      persistBlocked,
    })).resolves.toBe('remove')
    expect(discard).toHaveBeenCalledOnce()

    for (const paths of [
      { stagingExists: false, finalExists: true },
      { stagingExists: true, finalExists: true },
    ]) {
      const blockedTask = createTask()
      await expect(coordinateDownloadTaskRemoval(blockedTask, {
        inspectPaths: async() => paths,
        discard,
        persistBlocked,
      })).resolves.toBe('block')
      expect(blockedTask.metadata.stagingPath).toContain('lx-publishing')
    }
  })

  it('reserves a task synchronously before any asynchronous startup work', async() => {
    const running = new Map<string, LX.Download.ListItem>()
    const task = createTask()
    expect(reserveDownloadTaskStart(running, task)).toBe(true)
    expect(reserveDownloadTaskStart(running, task)).toBe(false)
    expect(running.get(task.id)).toBe(task)
  })
})
