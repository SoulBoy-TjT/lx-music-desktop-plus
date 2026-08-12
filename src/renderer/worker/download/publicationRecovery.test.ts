import {
  createCompletedDownloadPersistenceState,
  markCommittedPublicationPersistenceFailure,
  reconcileDownloadPublication,
  resolveDownloadPublicationRemoval,
} from '@renderer/store/download/publicationRecovery'
import { describe, expect, it, vi } from 'vitest'

const createTask = (): LX.Download.ListItem => ({
  id: 'recover-download',
  isComplate: true,
  status: 'run',
  statusText: 'post-processing',
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
    formatDowngrade: {
      reason: 'lossless_unavailable',
      requestedQuality: 'flac',
      actualQuality: '320k',
    },
  },
})

describe('download publication recovery', () => {
  it('never drops a failed task locator while a final or conflicting stage is present', () => {
    expect(resolveDownloadPublicationRemoval({ stagingExists: true, finalExists: true })).toBe('block')
    expect(resolveDownloadPublicationRemoval({ stagingExists: false, finalExists: true })).toBe('block')
    expect(resolveDownloadPublicationRemoval({ stagingExists: true, finalExists: false })).toBe('discard_stage')
    expect(resolveDownloadPublicationRemoval({ stagingExists: false, finalExists: false })).toBe('remove')
  })
  it('resumes post-processing when only the durable stage exists', async() => {
    const task = createTask()
    const verifyFinal = vi.fn(async() => {})
    await expect(reconcileDownloadPublication(task, {
      inspectPaths: async() => ({ stagingExists: true, finalExists: false }),
      verifyFinal,
      completedStatusText: 'completed',
      retryStatusText: 'retry',
    })).resolves.toBe('resume_stage')
    expect(verifyFinal).not.toHaveBeenCalled()
    expect(task.metadata.stagingPath).toContain('lx-publishing')
  })

  it('verifies an already published final and completes without requiring the vanished stage', async() => {
    const task = createTask()
    const verifyFinal = vi.fn(async() => {})
    await expect(reconcileDownloadPublication(task, {
      inspectPaths: async() => ({ stagingExists: false, finalExists: true }),
      verifyFinal,
      completedStatusText: 'completed downgraded',
      retryStatusText: 'retry',
    })).resolves.toBe('complete_final')
    expect(verifyFinal).toHaveBeenCalledWith(task)
    expect(task).toMatchObject({ status: 'completed', isComplate: true, statusText: 'completed downgraded' })
    expect(task.metadata.stagingPath).toBeUndefined()
    expect(task.metadata.quality).toBe('320k')
  })

  it('keeps both paths and records a blocking conflict for manual recovery', async() => {
    const task = createTask()
    await expect(reconcileDownloadPublication(task, {
      inspectPaths: async() => ({ stagingExists: true, finalExists: true }),
      verifyFinal: async() => {},
      completedStatusText: 'completed',
      retryStatusText: 'retry',
    })).resolves.toBe('blocked_conflict')
    expect(task.metadata.stagingPath).toContain('lx-publishing')
    expect(task.metadata.postProcessingError).toMatchObject({
      phase: 'publication',
      code: 'stage_final_conflict',
      taskId: task.id,
    })
  })

  it('keeps the durable intent blocked when an existing final cannot be revalidated', async() => {
    const task = createTask()
    await expect(reconcileDownloadPublication(task, {
      inspectPaths: async() => ({ stagingExists: false, finalExists: true }),
      verifyFinal: async() => { throw new Error('decoder rejected final') },
      completedStatusText: 'completed',
      retryStatusText: 'retry',
    })).resolves.toBe('blocked_conflict')
    expect(task.metadata.stagingPath).toContain('lx-publishing')
    expect(task.metadata.postProcessingError).toMatchObject({
      phase: 'publication',
      code: 'final_verification_failed',
      taskId: task.id,
      filePath: task.metadata.filePath,
    })
  })

  it('resets to the immutable requested quality when neither artifact exists', async() => {
    const task = createTask()
    await expect(reconcileDownloadPublication(task, {
      inspectPaths: async() => ({ stagingExists: false, finalExists: false }),
      verifyFinal: async() => {},
      completedStatusText: 'completed',
      retryStatusText: 'retry download',
    })).resolves.toBe('reset_download')
    expect(task).toMatchObject({ status: 'pause', isComplate: false, downloaded: 0, total: 0, progress: 0 })
    expect(task.metadata).toMatchObject({
      requestedQuality: 'flac',
      quality: 'flac',
      ext: 'flac',
      fileName: '歌曲.flac',
      filePath: 'C:\\Music\\歌曲.flac',
    })
    expect(task.metadata.stagingPath).toBeUndefined()
    expect(task.metadata.actualFormat).toBeUndefined()
    expect(task.metadata.formatDowngrade).toBeUndefined()
  })

  it('keeps the durable stage intent until the completed DB state succeeds', () => {
    const task = createTask()
    const completed = createCompletedDownloadPersistenceState(task, 'completed')

    expect(task.metadata.stagingPath).toContain('lx-publishing')
    expect(completed.metadata.stagingPath).toBeUndefined()
    expect(completed).toMatchObject({ status: 'completed', isComplate: true, statusText: 'completed' })
  })

  it('retains the durable stage locator when the completed DB update fails after commit', () => {
    const task = createTask()
    markCommittedPublicationPersistenceFailure(task, new Error('sqlite busy'))

    expect(task.metadata.stagingPath).toContain('lx-publishing')
    expect(task).toMatchObject({ status: 'error', isComplate: true })
    expect(task.metadata.postProcessingError).toMatchObject({
      phase: 'persistence',
      code: 'completed_state_persist_failed',
      filePath: task.metadata.filePath,
    })
  })
})
