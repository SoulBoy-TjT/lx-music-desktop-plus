import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { releaseProxy } from 'comlink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pauseTask, removeTask, startTask } from './download'
import { getDownloadTransferPath } from './downloadPublication'

const downloadMock = vi.hoisted(() => ({
  blockFirstStop: false,
  blockPreflight: false,
  blockRemove: false,
  createCount: 0,
  events: [] as string[],
  firstStopStarted: false,
  options: [] as unknown[],
  preflightStarted: false,
  removeError: undefined as Error | undefined,
  removePaths: [] as string[],
  removeStarted: false,
  resolveFirstStop: undefined as (() => void) | undefined,
  resolvePreflight: undefined as (() => void) | undefined,
  resolveRemove: undefined as (() => void) | undefined,
  starts: [] as unknown[],
  stops: [] as unknown[],
}))

vi.mock('@common/utils/download', () => ({
  createDownload: vi.fn((options: unknown) => {
    const createIndex = ++downloadMock.createCount
    const start = vi.fn(async() => { downloadMock.events.push('start') })
    const stop = vi.fn(async() => {
      if (!downloadMock.blockFirstStop || createIndex !== 1) return
      downloadMock.firstStopStarted = true
      await new Promise<void>(resolve => { downloadMock.resolveFirstStop = resolve })
    })
    downloadMock.options.push(options)
    downloadMock.starts.push(start)
    downloadMock.stops.push(stop)
    return {
      refreshUrl: vi.fn(),
      start,
      stop,
      updateSaveInfo: vi.fn(),
    }
  }),
}))

vi.mock('@common/utils/nodejs', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown> & {
    getFileStats: (filePath: string) => Promise<unknown>
    removeFile: (filePath: string) => Promise<void>
  }>()
  return {
    ...actual,
    getFileStats: vi.fn(async(filePath: string) => {
      if (downloadMock.blockPreflight) {
        downloadMock.preflightStarted = true
        await new Promise<void>(resolve => { downloadMock.resolvePreflight = resolve })
      }
      return actual.getFileStats(filePath)
    }),
    removeFile: vi.fn(async(filePath: string) => {
      downloadMock.removePaths.push(filePath)
      downloadMock.removeStarted = true
      if (downloadMock.blockRemove) {
        await new Promise<void>(resolve => { downloadMock.resolveRemove = resolve })
      }
      if (downloadMock.removeError) throw downloadMock.removeError
      await actual.removeFile(filePath)
      downloadMock.events.push('remove')
    }),
  }
})

const tempDirs: string[] = []

const createTask = (id: string, filePath: string): LX.Download.ListItem => ({
  id,
  isComplate: false,
  status: 'waiting',
  statusText: '',
  downloaded: 0,
  total: 0,
  progress: 0,
  speed: '',
  writeQueue: 0,
  metadata: {
    musicInfo: {
      id: 'wy_song',
      name: 'Song',
      singer: 'Singer',
      source: 'wy',
      interval: null,
      meta: {
        songId: 'song',
        albumName: 'Album',
        picUrl: '',
        qualitys: [],
        _qualitys: {},
      },
    },
    url: 'https://example.test/audio',
    requestedQuality: '128k',
    quality: '128k',
    ext: 'mp3',
    fileName: path.basename(filePath),
    filePath,
  },
})

const createRemoteResources = () => {
  const action = vi.fn(async() => {})
  const releaseAction = vi.fn()
  const releaseValidation = vi.fn()
  const releaseLifecycle = vi.fn()
  return {
    action: Object.assign(action, { [releaseProxy]: releaseAction }),
    lifecycle: {
      beginTask: async() => ({ status: 'active' as const }),
      isTaskCancelled: async() => false,
      finishTask: async() => {},
      [releaseProxy]: releaseLifecycle,
    },
    releaseAction,
    releaseLifecycle,
    releaseValidation,
    validate: Object.assign(async() => ({ status: 'valid' as const }), { [releaseProxy]: releaseValidation }),
  }
}

afterEach(async() => {
  downloadMock.blockFirstStop = false
  downloadMock.blockPreflight = false
  downloadMock.blockRemove = false
  downloadMock.createCount = 0
  downloadMock.events.splice(0)
  downloadMock.firstStopStarted = false
  downloadMock.options.splice(0)
  downloadMock.preflightStarted = false
  downloadMock.removeError = undefined
  downloadMock.removePaths.splice(0)
  downloadMock.removeStarted = false
  downloadMock.resolveFirstStop = undefined
  downloadMock.resolvePreflight = undefined
  downloadMock.resolveRemove = undefined
  downloadMock.starts.splice(0)
  downloadMock.stops.splice(0)
  await Promise.all(tempDirs.splice(0).map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('download Worker remote resource generations', () => {
  it('does not start a downloader after removal cancels an in-flight preflight', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-preflight-'))
    tempDirs.push(dir)
    const id = `preflight-${Date.now()}`
    const resources = createRemoteResources()
    downloadMock.blockPreflight = true

    const start = startTask(createTask(id, path.join(dir, 'preflight.mp3')), dir, true, resources.action, undefined, resources.validate, resources.lifecycle)
    await vi.waitFor(() => { expect(downloadMock.preflightStarted).toBe(true) })
    await removeTask(id)
    expect(resources.releaseAction).toHaveBeenCalledOnce()
    expect(resources.releaseValidation).toHaveBeenCalledOnce()
    expect(resources.releaseLifecycle).toHaveBeenCalledOnce()

    downloadMock.resolvePreflight?.()
    await start
    expect(downloadMock.createCount).toBe(0)
    expect(resources.releaseAction).toHaveBeenCalledOnce()
    expect(resources.releaseValidation).toHaveBeenCalledOnce()
    expect(resources.releaseLifecycle).toHaveBeenCalledOnce()
  })

  it('does not release retry proxies when an older removal settles late', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-generation-'))
    tempDirs.push(dir)
    const id = `generation-${Date.now()}`
    const first = createRemoteResources()
    downloadMock.blockFirstStop = true
    const filePath = path.join(dir, 'shared.mp3')
    const transferPath = getDownloadTransferPath(filePath)
    const firstTask = createTask(id, filePath)
    firstTask.downloaded = 2_048
    firstTask.total = 4_096
    await writeFile(transferPath, 'partial-new-generation-data')
    await startTask(firstTask, dir, true, first.action, undefined, first.validate, first.lifecycle)

    const oldRemoval = removeTask(id)
    await vi.waitFor(() => { expect(downloadMock.firstStopStarted).toBe(true) })

    const retry = createRemoteResources()
    let retrySettled = false
    const retryStart = startTask(createTask(id, filePath), dir, true, retry.action, undefined, retry.validate, retry.lifecycle)
      .finally(() => { retrySettled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(retrySettled).toBe(false)
    expect(downloadMock.createCount).toBe(1)
    expect(retry.releaseAction).not.toHaveBeenCalled()
    expect(retry.releaseValidation).not.toHaveBeenCalled()
    expect(retry.releaseLifecycle).not.toHaveBeenCalled()

    downloadMock.resolveFirstStop?.()
    await Promise.all([oldRemoval, retryStart])
    expect(downloadMock.createCount).toBe(2)
    expect(first.releaseAction).toHaveBeenCalledOnce()
    expect(first.releaseValidation).toHaveBeenCalledOnce()
    expect(first.releaseLifecycle).toHaveBeenCalledOnce()
    expect(retry.releaseAction).not.toHaveBeenCalled()
    expect(retry.releaseValidation).not.toHaveBeenCalled()
    expect(retry.releaseLifecycle).not.toHaveBeenCalled()
    await expect(stat(transferPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const staleOptions = downloadMock.options[0] as {
      onFail: (response: { statusCode?: number }) => void
      onStart: () => void
    }
    const retryDownloaderStart = downloadMock.starts[1] as ReturnType<typeof vi.fn>
    staleOptions.onStart()
    staleOptions.onFail({ statusCode: 500 })
    expect(retry.action).not.toHaveBeenCalled()
    expect(retryDownloaderStart).not.toHaveBeenCalled()

    await pauseTask(id)
    expect(retry.releaseAction).toHaveBeenCalledOnce()
    expect(retry.releaseValidation).toHaveBeenCalledOnce()
    expect(retry.releaseLifecycle).toHaveBeenCalledOnce()
  })

  it.each([
    ['pause', pauseTask],
    ['remove', removeTask],
  ] as const)('waits for an in-flight resume cleanup and prevents a late restart after %s', async(action, stopTask) => {
    const dir = await mkdtemp(path.join(tmpdir(), `lx-download-resume-${action}-`))
    tempDirs.push(dir)
    const id = `resume-${action}-${Date.now()}`
    const resources = createRemoteResources()
    const filePath = path.join(dir, 'resume-pause.mp3')
    const transferPath = getDownloadTransferPath(filePath)
    await writeFile(transferPath, 'mismatched-partial')
    await startTask(createTask(id, filePath), dir, true, resources.action, undefined, resources.validate, resources.lifecycle)
    downloadMock.blockRemove = true
    const options = downloadMock.options[0] as { onError: (error: Error) => void }

    options.onError(new Error('Resume failed, response chunk does not match.'))
    await vi.waitFor(() => { expect(downloadMock.removeStarted).toBe(true) })

    let stopSettled = false
    const stop = stopTask(id).finally(() => { stopSettled = true })
    await new Promise<void>(resolve => { setImmediate(resolve) })
    const settledBeforeRemove = stopSettled

    downloadMock.resolveRemove?.()
    await stop
    await vi.waitFor(() => { expect(downloadMock.events).toContain('remove') })

    expect(settledBeforeRemove).toBe(false)
    expect(downloadMock.removePaths).toEqual([transferPath])
    expect(downloadMock.starts[0]).not.toHaveBeenCalled()
    expect(downloadMock.stops[0]).toHaveBeenCalledOnce()
    await expect(stat(transferPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const eventSnapshot = [...downloadMock.events]
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(downloadMock.events).toEqual(eventSnapshot)
    expect(downloadMock.starts[0]).not.toHaveBeenCalled()
  })

  it('removes a mismatched partial file before retrying the current generation from zero', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-resume-retry-'))
    tempDirs.push(dir)
    const id = `resume-retry-${Date.now()}`
    const resources = createRemoteResources()
    const filePath = path.join(dir, 'resume-retry.mp3')
    const transferPath = getDownloadTransferPath(filePath)
    await writeFile(transferPath, 'mismatched-partial')
    await startTask(createTask(id, filePath), dir, true, resources.action, undefined, resources.validate, resources.lifecycle)
    const options = downloadMock.options[0] as { onError: (error: Error) => void }

    options.onError(new Error('Resume failed, response chunk does not match.'))

    await vi.waitFor(() => { expect(downloadMock.starts[0]).toHaveBeenCalledOnce() })
    expect(downloadMock.removePaths).toEqual([transferPath])
    expect(downloadMock.events).toEqual(['remove', 'start'])
    await expect(stat(transferPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await pauseTask(id)
  })

  it('reports a terminal write error and releases resources when mismatch cleanup fails', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-resume-remove-error-'))
    tempDirs.push(dir)
    const id = `resume-remove-error-${Date.now()}`
    const resources = createRemoteResources()
    const filePath = path.join(dir, 'resume-remove-error.mp3')
    const transferPath = getDownloadTransferPath(filePath)
    await writeFile(transferPath, 'mismatched-partial')
    await startTask(createTask(id, filePath), dir, true, resources.action, undefined, resources.validate, resources.lifecycle)
    const removeError = new Error('mismatched transfer is locked')
    downloadMock.removeError = removeError
    const options = downloadMock.options[0] as { onError: (error: Error) => void }

    try {
      options.onError(new Error('Resume failed, response chunk does not match.'))
      await vi.waitFor(() => {
        const start = downloadMock.starts[0] as ReturnType<typeof vi.fn>
        expect(start.mock.calls.length + resources.action.mock.calls.length).toBeGreaterThan(0)
      })

      expect(downloadMock.removePaths).toEqual([transferPath])
      expect(downloadMock.starts[0]).not.toHaveBeenCalled()
      expect(resources.action).toHaveBeenCalledWith({
        action: 'error',
        data: {
          error: 'download_status_error_write',
          message: removeError.message,
        },
      })
      await vi.waitFor(() => {
        expect(resources.releaseAction).toHaveBeenCalledOnce()
        expect(resources.releaseValidation).toHaveBeenCalledOnce()
        expect(resources.releaseLifecycle).toHaveBeenCalledOnce()
      })
    } finally {
      await pauseTask(id)
    }
  })
})
