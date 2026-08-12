import path from 'node:path'
import os from 'node:os'
import { promises as fs } from 'node:fs'
import { shell } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIST_IDS } from '@common/constants'
import type { SongOrganizerCapability, SongOrganizerOperationProgress, SongOrganizerSnapshot } from '@common/songOrganizer'
import { AudioFfmpegTerminationError } from '../audioFfmpeg/processTermination'
import { AppExitCoordinator } from '../appExitCoordinator'
import { SongOrganizerService } from './index'
import { createSongOrganizerFileIdentity, getSongOrganizerMtimeMs, lstatWithFileIdentity } from './fileIdentity'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.platform == 'win32' ? 'C:\\__lx-test-app__' : '/__lx-test-app__',
    isPackaged: false,
  },
  shell: { trashItem: vi.fn() },
}))

const tempRoots: string[] = []
const originalLx = Object.getOwnPropertyDescriptor(global, 'lx')
const originalLxDataPath = Object.getOwnPropertyDescriptor(global, 'lxDataPath')

const createTempRoot = async(): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-song-organizer-service-test-'))
  tempRoots.push(root)
  return root
}

const deferred = <T>() => {
  let resolveDeferred!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve
  })
  return { promise, resolve: resolveDeferred }
}

const capability: SongOrganizerCapability = {
  supported: true,
  platform: process.platform,
  arch: process.arch,
  validatorAvailable: true,
  validatorPath: 'unused-in-empty-test-root',
}

const setDownloadList = (getDownloadList: () => Promise<never[]>) => {
  Object.defineProperty(global, 'lx', {
    configurable: true,
    value: { worker: { dbService: { getDownloadList } } },
  })
  Object.defineProperty(global, 'lxDataPath', {
    configurable: true,
    value: process.platform == 'win32' ? 'C:\\__lx-test-data__' : '/__lx-test-data__',
  })
}

afterEach(async() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  ;(Reflect.get(shell, 'trashItem') as ReturnType<typeof vi.fn>).mockReset()
  await Promise.all(tempRoots.splice(0).map(async root => fs.rm(root, { recursive: true, force: true })))
  if (originalLx) Object.defineProperty(global, 'lx', originalLx)
  else Reflect.deleteProperty(global, 'lx')
  if (originalLxDataPath) Object.defineProperty(global, 'lxDataPath', originalLxDataPath)
  else Reflect.deleteProperty(global, 'lxDataPath')
})

describe('song organizer scan concurrency', () => {
  it('keeps the newer invocation current when the older capability check finishes last', async() => {
    const oldRoot = await createTempRoot()
    const newRoot = await createTempRoot()
    const oldCapability = deferred<SongOrganizerCapability>()
    const newCapability = deferred<SongOrganizerCapability>()
    const service = new SongOrganizerService()
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability')
      .mockReturnValueOnce(oldCapability.promise)
      .mockReturnValueOnce(newCapability.promise)

    const oldScan = service.scan({ root: oldRoot, taskId: 'old-task' })
    const newScan = service.scan({ root: newRoot, taskId: 'new-task' })
    newCapability.resolve(capability)
    const newResult = await newScan
    oldCapability.resolve(capability)
    const oldResult = await oldScan

    expect(oldResult.status).toBe('cancelled')
    expect(newResult.status).toBe('complete')
    expect(service.getSnapshot()?.taskId).toBe('new-task')
    expect(service.getSnapshot()?.root).toBe(path.resolve(newRoot))
    expect(service.getRuntimeState()).toMatchObject({
      status: 'complete',
      taskId: 'new-task',
      root: path.resolve(newRoot),
    })
  })

  it('uses each task local signal and suppresses progress from a superseded preflight', async() => {
    const oldRoot = await createTempRoot()
    const newRoot = await createTempRoot()
    const oldDownloads = deferred<never[]>()
    const newDownloads = deferred<never[]>()
    const getDownloadList = vi.fn(async() => [])
      .mockReturnValueOnce(oldDownloads.promise)
      .mockReturnValueOnce(newDownloads.promise)
    const service = new SongOrganizerService()
    const progressTaskIds: string[] = []
    setDownloadList(getDownloadList)
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    service.setProgressListener(progress => progressTaskIds.push(progress.taskId))

    const oldScan = service.scan({ root: oldRoot, taskId: 'old-task' })
    await vi.waitFor(() => {
      expect(getDownloadList).toHaveBeenCalledTimes(1)
    })
    const newScan = service.scan({ root: newRoot, taskId: 'new-task' })
    await vi.waitFor(() => {
      expect(getDownloadList).toHaveBeenCalledTimes(2)
    })
    oldDownloads.resolve([])
    const oldResult = await oldScan
    newDownloads.resolve([])
    const newResult = await newScan

    expect(oldResult.status).toBe('cancelled')
    expect(newResult.status).toBe('complete')
    expect(progressTaskIds.length).toBeGreaterThan(0)
    expect(new Set(progressTaskIds)).toEqual(new Set(['new-task']))
    expect(service.getSnapshot()?.taskId).toBe('new-task')
  })

  it('clears current task state when a preflight rejects', async() => {
    const missingRoot = await createTempRoot()
    await fs.rm(missingRoot, { recursive: true })
    const service = new SongOrganizerService()
    const internalState = service as unknown as { abortController?: AbortController, currentScanTaskId?: string }
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockResolvedValue(capability)

    await expect(service.scan({ root: missingRoot, taskId: 'failed-task' })).rejects.toThrow()

    expect(internalState.currentScanTaskId).toBeUndefined()
    expect(internalState.abortController).toBeUndefined()
    expect(service.cancel('failed-task')).toBe(false)
  })
})

describe('song organizer runtime state', () => {
  it('publishes a quick snapshot even when FFmpeg validation is unavailable', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    await fs.mkdir(artistPath)
    await fs.writeFile(path.join(artistPath, 'song.mp3'), 'not decoded during quick scan')
    const service = new SongOrganizerService()
    setDownloadList(async() => [])
    const capabilityCheck = vi.spyOn(service, 'capability').mockResolvedValue({
      ...capability,
      validatorAvailable: false,
      validatorPath: undefined,
      reason: 'validator_unavailable',
    })

    const result = await service.scan({ root, taskId: 'quick-task' })

    expect(result.status).toBe('complete')
    expect(capabilityCheck).toHaveBeenCalledWith({ probeValidator: false })
    expect(result.validationStatus).toBe('unchecked')
    expect(result.totals.audioCount).toBe(1)
    expect(result.totals.playableCount).toBe(0)
  })

  it('checks only the selected artist and binds the validation to the latest quick snapshot', async() => {
    const root = await createTempRoot()
    const firstArtist = path.join(root, 'First')
    const secondArtist = path.join(root, 'Second')
    await fs.mkdir(firstArtist)
    await fs.mkdir(secondArtist)
    await fs.writeFile(path.join(firstArtist, 'first.mp3'), 'audio')
    await fs.writeFile(path.join(secondArtist, 'second.mp3'), 'audio')
    const validate = vi.fn(async(_filePath: string, _signal: AbortSignal) => ({ status: 'playable' as const }))
    const service = new SongOrganizerService({ createValidator: () => ({ validate }) })
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const quick = await service.scan({ root, taskId: 'quick-task' })

    const checked = await service.check({
      taskId: 'check-task',
      quickSnapshotId: quick.taskId,
      artistPath: firstArtist,
    })

    expect(validate).toHaveBeenCalledTimes(1)
    expect(validate.mock.calls[0]?.[0]).toBe(path.join(firstArtist, 'first.mp3'))
    expect(checked).toMatchObject({
      quickSnapshotId: 'quick-task',
      artistPath: firstArtist,
      status: 'complete',
      checkedCount: 1,
    })
    expect(checked.snapshot.validationStatus).toBe('checked')
    expect(checked.audioFingerprints).toEqual([
      expect.objectContaining({ path: path.join(firstArtist, 'first.mp3') }),
    ])
    expect(checked.snapshot.artists.map(artist => artist.path)).toEqual([firstArtist])
    expect(service.getRuntimeState().validations).toEqual([expect.objectContaining({ artistPath: firstArtist })])
  })

  it('waits for an active artist check to settle before completing read cancellation', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    await fs.mkdir(artistPath)
    await fs.writeFile(path.join(artistPath, 'song.mp3'), 'audio')
    const validationResult = deferred<{ status: 'check_failed', errorCode: string, errorMessage: string }>()
    let validationSignal: AbortSignal | undefined
    const validate = vi.fn(async(_filePath: string, signal: AbortSignal) => {
      validationSignal = signal
      return validationResult.promise
    })
    const service = new SongOrganizerService({ createValidator: () => ({ validate }) })
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const quick = await service.scan({ root, taskId: 'quick-before-cancel' })
    const check = service.check({ quickSnapshotId: quick.taskId, artistPath, taskId: 'cancel-check' })
    await vi.waitFor(() => { expect(validate).toHaveBeenCalledTimes(1) })

    expect(service.isReadBusy()).toBe(true)
    const cancellation = service.cancelReadOperationsAndWait()
    let cancellationSettled = false
    void cancellation.then(() => {
      cancellationSettled = true
    })
    await Promise.resolve()
    expect(validationSignal?.aborted).toBe(true)
    expect(cancellationSettled).toBe(false)
    expect(service.isReadBusy()).toBe(true)

    validationResult.resolve({
      status: 'check_failed',
      errorCode: 'scan_cancelled',
      errorMessage: 'cancelled',
    })
    await expect(check).rejects.toThrow()
    await cancellation

    expect(cancellationSettled).toBe(true)
    expect(service.isReadBusy()).toBe(false)
    await expect(service.cancelReadOperationsAndWait()).resolves.toBeUndefined()
    expect(service.getRuntimeState()).toMatchObject({
      status: 'cancelled',
      snapshot: { taskId: quick.taskId },
      validations: [],
    })
  })

  it('rejects read cancellation when an audio validator cannot confirm FFmpeg termination', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    await fs.mkdir(artistPath)
    await fs.writeFile(path.join(artistPath, 'song.mp3'), 'audio')
    const terminationError = new AudioFfmpegTerminationError('FFmpeg still running')
    const validate = vi.fn(async(_filePath: string, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
      const rejectTermination = () => { reject(terminationError) }
      if (signal.aborted) rejectTermination()
      else signal.addEventListener('abort', rejectTermination, { once: true })
    }))
    const service = new SongOrganizerService({ createValidator: () => ({ validate }) })
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const quick = await service.scan({ root, taskId: 'quick-before-termination-failure' })
    const check = service.check({
      quickSnapshotId: quick.taskId,
      artistPath,
      taskId: 'termination-failure-check',
    })
    const checkOutcome = check.catch(error => error)
    await vi.waitFor(() => { expect(validate).toHaveBeenCalledTimes(1) })

    const cancellation = service.cancelReadOperationsAndWait()

    await expect(checkOutcome).resolves.toBe(terminationError)
    await expect(cancellation).rejects.toBe(terminationError)
    expect(service.isReadBusy()).toBe(false)
  })

  it('retains an unconfirmed validator termination failure after the check is no longer active', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    await fs.mkdir(artistPath)
    await fs.writeFile(path.join(artistPath, 'song.mp3'), 'audio')
    const terminationError = new AudioFfmpegTerminationError('FFmpeg still running')
    const service = new SongOrganizerService({
      createValidator: () => ({ validate: async() => { throw terminationError } }),
    })
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const quick = await service.scan({ root, taskId: 'quick-before-persisted-failure' })

    await expect(service.check({
      quickSnapshotId: quick.taskId,
      artistPath,
      taskId: 'persisted-termination-failure-check',
    })).rejects.toBe(terminationError)

    expect(service.isReadBusy()).toBe(false)
    expect(service.getTerminationFailure()).toBe(terminationError)
  })

  it('invalidates and debounces a Main rescan when download occupancy shrinks', async() => {
    vi.useFakeTimers()
    const root = path.resolve('C:\\Music')
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'stale-download-occupancy',
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
    }
    const service = new SongOrganizerService()
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot
    const scan = vi.spyOn(service, 'scan').mockResolvedValue(snapshot)

    service.notifyDownloadOccupancyChanged(root)
    service.notifyDownloadOccupancyChanged(root)

    expect(service.getSnapshot()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(149)
    expect(scan).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledWith({ root })
  })

  it('lets a configured-root scan supersede a pending occupancy rescan', async() => {
    vi.useFakeTimers()
    const root = await createTempRoot()
    const service = new SongOrganizerService()
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const scan = vi.spyOn(service, 'scan')

    service.notifyDownloadOccupancyChanged(root)
    await service.requestMainScan(root)
    await vi.advanceTimersByTimeAsync(150)

    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledWith({ root })
  })

  it('publishes scanning before preflight awaits and finishes with a cloneable snapshot', async() => {
    const root = await createTempRoot()
    const pendingCapability = deferred<SongOrganizerCapability>()
    const states: Array<ReturnType<SongOrganizerService['getRuntimeState']>> = []
    const service = new SongOrganizerService()
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockReturnValue(pendingCapability.promise)
    service.setStateListener(state => states.push(state))

    const scan = service.scan({ root, taskId: 'runtime-task' })

    expect(service.getRuntimeState()).toMatchObject({
      revision: 1,
      status: 'scanning',
      taskId: 'runtime-task',
      root: path.resolve(root),
    })
    pendingCapability.resolve(capability)
    const result = await scan

    expect(result.status).toBe('complete')
    expect(service.getRuntimeState()).toMatchObject({
      status: 'complete',
      taskId: 'runtime-task',
      snapshot: { taskId: 'runtime-task', status: 'complete' },
    })
    expect(states[0].status).toBe('scanning')
    expect(states.at(-1)?.status).toBe('complete')
    expect(() => structuredClone(service.getRuntimeState())).not.toThrow()
  })

  it('publishes failed when preflight rejects', async() => {
    const missingRoot = await createTempRoot()
    await fs.rm(missingRoot, { recursive: true })
    const service = new SongOrganizerService()
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockResolvedValue(capability)

    await expect(service.scan({ root: missingRoot, taskId: 'failed-runtime-task' })).rejects.toThrow()

    expect(service.getRuntimeState()).toMatchObject({
      status: 'failed',
      taskId: 'failed-runtime-task',
      root: path.resolve(missingRoot),
    })
    expect(service.getRuntimeState().errorMessage).toBeTruthy()
  })

  it('publishes cancelled and supports cancelling the current scan without its task id', async() => {
    const root = await createTempRoot()
    const pendingCapability = deferred<SongOrganizerCapability>()
    const service = new SongOrganizerService()
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockReturnValue(pendingCapability.promise)

    const scan = service.scan({ root, taskId: 'cancel-runtime-task' })
    expect(service.cancelCurrentScan()).toBe(true)
    pendingCapability.resolve(capability)
    const result = await scan

    expect(result.status).toBe('cancelled')
    expect(service.getRuntimeState()).toMatchObject({
      status: 'cancelled',
      taskId: 'cancel-runtime-task',
      snapshot: { status: 'cancelled' },
    })
    expect(service.cancelCurrentScan()).toBe(false)
  })
})

describe('song organizer cleanup preview', () => {
  it('requires the latest checked snapshot before organizing', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    await fs.mkdir(artistPath)
    await fs.writeFile(path.join(artistPath, 'song.mp3'), 'audio')
    const service = new SongOrganizerService({ createValidator: () => ({ validate: async() => ({ status: 'playable' }) }) })
    setDownloadList(async() => [])
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const quick = await service.scan({ root, taskId: 'quick-only' })

    await expect(service.organizePreview({
      taskId: quick.taskId,
      artistPaths: [artistPath],
    })).rejects.toThrow('先检查')

    const validation = await service.check({ quickSnapshotId: quick.taskId, artistPath, taskId: 'checked' })
    await service.scan({ root, taskId: 'newer-quick' })
    await expect(service.organizePreview({
      taskId: 'newer-quick',
      validationId: validation.id,
      artistPaths: [artistPath],
    })).rejects.toThrow('先检查')
  })

  it('rejects a concurrent organize immediately while the first organize is still in preflight', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist（1首）')
    await fs.mkdir(artistPath)
    await fs.writeFile(path.join(artistPath, 'song.mp3'), 'audio')
    const preflightEntered = deferred<boolean>()
    const releasePreflight = deferred<boolean>()
    const getDownloadList = vi.fn(async() => [])
    const service = new SongOrganizerService({
      createValidator: () => ({ validate: async() => ({ status: 'playable' as const }) }),
    })
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList,
            getAllUserList: async() => [],
            getListMusics: async() => [],
            downloadInfoUpdate: async() => {},
          },
        },
        event_list: { list_data_overwrite: async() => {} },
      },
    })
    const dataPath = `${root}-data`
    tempRoots.push(dataPath)
    await fs.mkdir(dataPath)
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: dataPath })
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const quick = await service.scan({ root, taskId: 'quick-before-concurrent-organize' })
    const validation = await service.check({
      quickSnapshotId: quick.taskId,
      artistPath,
      taskId: 'validation-before-concurrent-organize',
    })
    getDownloadList.mockImplementationOnce(async() => {
      preflightEntered.resolve(true)
      await releasePreflight.promise
      return []
    })

    const first = service.organize({
      taskId: quick.taskId,
      validationId: validation.id,
      operationId: 'first-concurrent-organize',
      artistPaths: [artistPath],
      confirmedItemPaths: [],
    })
    await preflightEntered.promise
    const second = service.organize({
      taskId: quick.taskId,
      validationId: validation.id,
      operationId: 'second-concurrent-organize',
      artistPaths: [artistPath],
      confirmedItemPaths: [],
    })
    const secondBeforeRelease = await Promise.race([
      second.then(
        () => ({ status: 'fulfilled' as const, message: '' }),
        (error: unknown) => ({ status: 'rejected' as const, message: (error as Error).message }),
      ),
      new Promise<{ status: 'pending', message: '' }>(resolve => {
        setImmediate(() => { resolve({ status: 'pending', message: '' }) })
      }),
    ])
    releasePreflight.resolve(true)
    await Promise.allSettled([first, second])

    expect(secondBeforeRelease).toEqual({ status: 'rejected', message: '已有磁盘操作正在进行。' })
    expect(service.isBusy()).toBe(false)
  })

  it('blocks application exit while organize is still in fingerprint preflight', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist（1首）')
    await fs.mkdir(artistPath)
    await fs.writeFile(path.join(artistPath, 'song.mp3'), 'audio')
    const preflightEntered = deferred<boolean>()
    const releasePreflight = deferred<boolean>()
    const getDownloadList = vi.fn(async() => [])
    const service = new SongOrganizerService({
      createValidator: () => ({ validate: async() => ({ status: 'playable' as const }) }),
    })
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList,
            getAllUserList: async() => [],
            getListMusics: async() => [],
            downloadInfoUpdate: async() => {},
          },
        },
        event_list: { list_data_overwrite: async() => {} },
      },
    })
    const dataPath = `${root}-data`
    tempRoots.push(dataPath)
    await fs.mkdir(dataPath)
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: dataPath })
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const quick = await service.scan({ root, taskId: 'quick-before-preflight-exit' })
    const validation = await service.check({
      quickSnapshotId: quick.taskId,
      artistPath,
      taskId: 'validation-before-preflight-exit',
    })
    getDownloadList.mockImplementationOnce(async() => {
      preflightEntered.resolve(true)
      await releasePreflight.promise
      return []
    })
    const showOrganizerBusyWarning = vi.fn(async() => {})
    const continueExit = vi.fn()
    const coordinator = new AppExitCoordinator({
      isReadOperationRunning: () => service.isReadBusy(),
      getTerminationFailure: () => service.getTerminationFailure(),
      isOrganizerMutationRunning: () => service.isBusy(),
      isFlacConversionRunning: () => false,
      cancelFlacConversion: async() => {},
      showOrganizerBusyWarning,
      showExitFailureWarning: async() => {},
      reportError: () => {},
    })

    const organizing = service.organize({
      taskId: quick.taskId,
      validationId: validation.id,
      operationId: 'organize-during-preflight-exit',
      artistPaths: [artistPath],
      confirmedItemPaths: [],
    })
    await preflightEntered.promise
    const busyDuringPreflight = service.isBusy()
    const exitAllowed = coordinator.requestExit(continueExit)
    await Promise.resolve()
    releasePreflight.resolve(true)
    await organizing

    expect(busyDuringPreflight).toBe(true)
    expect(exitAllowed).toBe(false)
    expect(showOrganizerBusyWarning).toHaveBeenCalledTimes(1)
    expect(continueExit).not.toHaveBeenCalled()
    expect(service.isBusy()).toBe(false)
  })

  it('rejects organizing when checked audio was added, removed, or replaced', async() => {
    const mutationCases: Array<{
      name: string
      mutate: (songPath: string, artistPath: string) => Promise<void>
    }> = [
      {
        name: 'added',
        mutate: async(_songPath, artistPath) => { await fs.writeFile(path.join(artistPath, 'added.mp3'), 'added') },
      },
      {
        name: 'removed',
        mutate: async(songPath) => { await fs.rm(songPath) },
      },
      {
        name: 'replaced',
        mutate: async(songPath) => {
          await fs.rm(songPath)
          await fs.writeFile(songPath, 'replacement audio with a different fingerprint')
        },
      },
    ]

    for (const mutation of mutationCases) {
      const root = await createTempRoot()
      const artistPath = path.join(root, `Artist-${mutation.name}`)
      const songPath = path.join(artistPath, 'song.mp3')
      await fs.mkdir(artistPath)
      await fs.writeFile(songPath, 'audio')
      const validate = vi.fn(async(_filePath: string, _signal: AbortSignal) => ({ status: 'playable' as const }))
      const service = new SongOrganizerService({ createValidator: () => ({ validate }) })
      Object.defineProperty(global, 'lx', {
        configurable: true,
        value: {
          worker: {
            dbService: {
              getDownloadList: async() => [],
              getAllUserList: async() => [],
              getListMusics: async() => [],
              downloadInfoUpdate: async() => {},
            },
          },
          event_list: { list_data_overwrite: async() => {} },
        },
      })
      const dataPath = `${root}-data`
      tempRoots.push(dataPath)
      await fs.mkdir(dataPath)
      Object.defineProperty(global, 'lxDataPath', { configurable: true, value: dataPath })
      vi.spyOn(service, 'capability').mockResolvedValue(capability)
      const quick = await service.scan({ root, taskId: `quick-${mutation.name}` })
      const validation = await service.check({
        quickSnapshotId: quick.taskId,
        artistPath,
        taskId: `validation-${mutation.name}`,
      })
      await mutation.mutate(songPath, artistPath)

      await expect(service.organize({
        taskId: quick.taskId,
        validationId: validation.id,
        operationId: `organize-${mutation.name}`,
        artistPaths: [artistPath],
        confirmedItemPaths: [],
      })).rejects.toThrow('重新检查')
      expect(validate).toHaveBeenCalledTimes(1)
      expect(service.getRuntimeState()).toMatchObject({
        status: 'complete',
        taskId: quick.taskId,
        root: path.resolve(root),
        validations: [],
      })
      expect(service.isBusy()).toBe(false)
    }
  })

  it('organizes cleanup then rename and performs only one zero-validator quick refresh', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    const albumPath = path.join(artistPath, 'Album')
    await fs.mkdir(albumPath, { recursive: true })
    const songPath = path.join(albumPath, 'song.mp3')
    const coverPath = path.join(albumPath, 'cover.jpg')
    await fs.writeFile(songPath, 'audio')
    await fs.writeFile(coverPath, 'cover')
    const validate = vi.fn(async() => ({ status: 'playable' as const }))
    const service = new SongOrganizerService({ createValidator: () => ({ validate }) })
    const operationProgress: SongOrganizerOperationProgress[] = []
    service.setOperationProgressListener(progress => operationProgress.push(progress))
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [],
            getAllUserList: async() => [],
            getListMusics: async() => [],
            downloadInfoUpdate: async() => {},
          },
        },
        event_list: { list_data_overwrite: async() => {} },
      },
    })
    const dataPath = `${root}-data`
    tempRoots.push(dataPath)
    await fs.mkdir(dataPath)
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: dataPath })
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const trashItem = Reflect.get(shell, 'trashItem') as ReturnType<typeof vi.fn>
    trashItem.mockImplementation(async(target: string) => fs.rm(target, { recursive: true, force: true }))
    const quick = await service.scan({ root, taskId: 'quick' })
    const validation = await service.check({ quickSnapshotId: quick.taskId, artistPath, taskId: 'validation' })
    const preview = await service.organizePreview({
      taskId: quick.taskId,
      validationId: validation.id,
      artistPaths: [artistPath],
    })
    const refreshedSnapshots: SongOrganizerSnapshot[] = []
    service.setStateListener(state => {
      if (state.status == 'complete' && state.snapshot) refreshedSnapshots.push(state.snapshot)
    })

    const response = await service.organize({
      taskId: quick.taskId,
      validationId: validation.id,
      operationId: 'organize-operation',
      artistPaths: [artistPath],
      confirmedItemPaths: preview.items.map(item => item.path),
    })

    expect(preview.items.map(item => item.path)).toEqual([coverPath])
    expect(preview.renameSteps.map(step => step.type)).toEqual(['album', 'artist'])
    expect(response.result.type).toBe('organize')
    expect(response.result.failed).toEqual([])
    expect(refreshedSnapshots).toHaveLength(1)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(response.snapshot?.validationStatus).toBe('unchecked')
    expect(operationProgress
      .filter(progress => progress.type == 'organize' && progress.phase == 'cleanup')
      .map(progress => ({
        completed: progress.completed,
        total: progress.total,
        target: progress.currentRelativeTarget,
      }))).toEqual([
      { completed: 0, total: 1, target: path.relative(root, coverPath) },
      { completed: 1, total: 1, target: undefined },
    ])
    await expect(fs.lstat(path.join(root, 'Artist（1首）', 'Album (1首)', 'song.mp3'))).resolves.toBeTruthy()
    await expect(fs.lstat(coverPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves partial cleanup results and performs a quick refresh when journal persistence fails', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    const albumPath = path.join(artistPath, 'Album')
    await fs.mkdir(albumPath, { recursive: true })
    const songPath = path.join(albumPath, 'song.mp3')
    const coverPath = path.join(albumPath, 'cover.jpg')
    await fs.writeFile(songPath, 'audio')
    await fs.writeFile(coverPath, 'cover')
    const validate = vi.fn(async() => ({ status: 'playable' as const }))
    let journalWriteCount = 0
    const service = new SongOrganizerService({
      createValidator: () => ({ validate }),
      writeJournal: async() => {
        journalWriteCount++
        if (journalWriteCount == 2) throw new Error('journal persistence failed')
      },
      clearJournal: async() => {},
    })
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [],
            getAllUserList: async() => [],
            getListMusics: async() => [],
            downloadInfoUpdate: async() => {},
          },
        },
        event_list: { list_data_overwrite: async() => {} },
      },
    })
    const dataPath = `${root}-data`
    tempRoots.push(dataPath)
    await fs.mkdir(dataPath)
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: dataPath })
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const trashItem = Reflect.get(shell, 'trashItem') as ReturnType<typeof vi.fn>
    trashItem.mockImplementation(async(target: string) => fs.rm(target, { recursive: true, force: true }))
    const quick = await service.scan({ root, taskId: 'quick-before-journal-failure' })
    const validation = await service.check({
      quickSnapshotId: quick.taskId,
      artistPath,
      taskId: 'validation-before-journal-failure',
    })
    const preview = await service.organizePreview({
      taskId: quick.taskId,
      validationId: validation.id,
      artistPaths: [artistPath],
    })
    const refreshedSnapshots: SongOrganizerSnapshot[] = []
    service.setStateListener(state => {
      if (state.status == 'complete' && state.snapshot) refreshedSnapshots.push(state.snapshot)
    })

    const response = await service.organize({
      taskId: quick.taskId,
      validationId: validation.id,
      operationId: 'organize-journal-failure',
      artistPaths: [artistPath],
      confirmedItemPaths: preview.items.map(item => item.path),
    })

    expect(response.result.succeeded).toContainEqual({ path: coverPath, status: 'succeeded' })
    expect(response.result.failed).toContainEqual(expect.objectContaining({
      path: artistPath,
      phase: 'cleanup',
      reason: expect.stringContaining('journal persistence failed'),
    }))
    expect(response.snapshot?.validationStatus).toBe('unchecked')
    expect(refreshedSnapshots).toHaveLength(1)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(service.isBusy()).toBe(false)
    await expect(fs.lstat(coverPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recounts after cleanup before applying the rename plan', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    const albumPath = path.join(artistPath, 'Album')
    const emptyAlbumPath = path.join(artistPath, 'Empty')
    await fs.mkdir(albumPath, { recursive: true })
    await fs.mkdir(emptyAlbumPath)
    await fs.writeFile(path.join(albumPath, 'song.mp3'), 'audio')
    const validate = vi.fn(async(_filePath: string, _signal: AbortSignal) => ({ status: 'playable' as const }))
    const service = new SongOrganizerService({ createValidator: () => ({ validate }) })
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [],
            getAllUserList: async() => [],
            getListMusics: async() => [],
            downloadInfoUpdate: async() => {},
          },
        },
        event_list: { list_data_overwrite: async() => {} },
      },
    })
    const dataPath = `${root}-data`
    tempRoots.push(dataPath)
    await fs.mkdir(dataPath)
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: dataPath })
    vi.spyOn(service, 'capability').mockResolvedValue(capability)
    const trashItem = Reflect.get(shell, 'trashItem') as ReturnType<typeof vi.fn>
    trashItem.mockImplementation(async(target: string) => fs.rm(target, { recursive: true, force: true }))
    const quick = await service.scan({ root, taskId: 'quick-before-recount' })
    const validation = await service.check({ quickSnapshotId: quick.taskId, artistPath, taskId: 'validation-before-recount' })
    const preview = await service.organizePreview({
      taskId: quick.taskId,
      validationId: validation.id,
      artistPaths: [artistPath],
    })

    const response = await service.organize({
      taskId: quick.taskId,
      validationId: validation.id,
      operationId: 'organize-with-recount',
      artistPaths: [artistPath],
      confirmedItemPaths: preview.items.map(item => item.path),
    })

    expect(preview.items.map(item => item.path)).toContain(emptyAlbumPath)
    expect(preview.renameSteps.some(step => step.from == emptyAlbumPath)).toBe(true)
    expect(response.result.failed).toEqual([])
    expect(response.snapshot?.artists[0]?.albums).toHaveLength(1)
    await expect(fs.lstat(emptyAlbumPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('marks active download cleanup targets as blocked in the completed scan snapshot', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    const activeAudioPath = path.join(artistPath, 'active.mp3')
    const activeLyricsPath = path.join(artistPath, 'active.lrc')
    const activeSidecarPaths = [
      `${activeAudioPath}.lxmtemp`,
      `${activeAudioPath}.lxmbackup`,
      `${activeAudioPath}.lxcover.png`,
      `${activeLyricsPath}.lxmtemp`,
      `${activeLyricsPath}.lxmbackup`,
    ]
    const similarPrefixPath = `${activeAudioPath}.lxcoverish.png`
    const oldLyricsPath = path.join(artistPath, 'old.lrc')
    await fs.mkdir(artistPath)
    await fs.writeFile(activeLyricsPath, 'active')
    await Promise.all(activeSidecarPaths.map(async filePath => fs.writeFile(filePath, 'sidecar')))
    await fs.writeFile(similarPrefixPath, 'not a protected cover sidecar')
    await fs.writeFile(oldLyricsPath, 'old')
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [{
              id: 'active-download',
              status: 'run',
              isComplate: false,
              metadata: { filePath: activeAudioPath, fileName: 'active.mp3' },
            }],
          },
        },
      },
    })
    Object.defineProperty(global, 'lxDataPath', {
      configurable: true,
      value: process.platform == 'win32' ? 'C:\\__lx-test-data__' : '/__lx-test-data__',
    })
    const service = new SongOrganizerService()
    vi.spyOn(service, 'capability').mockResolvedValue(capability)

    const snapshot = await service.scan({ root, taskId: 'protected-snapshot' })
    const protectedAnomalies = [activeLyricsPath, ...activeSidecarPaths]
      .map(filePath => snapshot.anomalies.find(item => item.path == filePath))
    const oldLyrics = snapshot.anomalies.find(item => item.path == oldLyricsPath)
    const similarPrefix = snapshot.anomalies.find(item => item.path == similarPrefixPath)

    for (const protectedAnomaly of protectedAnomalies) {
      expect(protectedAnomaly).toMatchObject({
        cleanupEligible: false,
        status: '下载任务占用',
        reason: '下载任务占用',
      })
    }
    expect(oldLyrics).toMatchObject({ status: '不支持' })
    expect(oldLyrics?.cleanupEligible).not.toBe(false)
    expect(similarPrefix?.cleanupEligible).not.toBe(false)
  })

  it('counts distinct affected playlists separately from referenced files', async() => {
    const root = path.resolve('C:\\Music')
    const artistPath = path.join(root, 'Artist')
    const firstPath = path.join(artistPath, 'cover.jpg')
    const secondPath = path.join(artistPath, 'notes.txt')
    const localMusic = (filePath: string) => ({
      id: filePath,
      source: 'local',
      meta: { filePath, songId: filePath },
    }) as unknown as LX.Music.MusicInfo
    const lists = new Map<string, LX.Music.MusicInfo[]>([
      [LIST_IDS.DEFAULT, [localMusic(firstPath), localMusic(secondPath)]],
      [LIST_IDS.LOVE, [localMusic(firstPath)]],
      [LIST_IDS.TEMP, []],
      ['user-list', [localMusic(secondPath)]],
    ])
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getAllUserList: async() => [{ id: 'user-list', name: 'User list' }],
            getListMusics: async(listId: string) => lists.get(listId) ?? [],
            getDownloadList: async() => [],
          },
        },
      },
    })
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'snapshot',
      root,
      status: 'complete',
      checkedCount: 0,
      totalAudioCount: 0,
      artists: [{
        path: artistPath,
        name: 'Artist',
        baseName: 'Artist',
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 2,
        targetName: 'Artist（0首）',
        needsRename: true,
        albums: [],
        blockedReasons: [],
      }],
      anomalies: [firstPath, secondPath].map((filePath, index) => ({
        id: `unsupported-${index}`,
        type: 'unsupported_file',
        path: filePath,
        relativePath: path.relative(root, filePath),
        artistPath,
        artistName: 'Artist',
        size: 1,
        status: '待清理',
        cleanupEligible: true,
      })),
      renamePlan: [],
      totals: {
        artistCount: 1,
        albumCount: 0,
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 2,
        duplicateHardlinkCount: 0,
        reparsePointCount: 0,
        emptyDirectoryCount: 0,
        renameCount: 0,
      },
    }
    const service = new SongOrganizerService()
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot

    const preview = await service.cleanupPreview({ taskId: snapshot.taskId, artistPaths: [artistPath] })

    expect(preview.referencedItemCount).toBe(2)
    expect(preview.referencedListCount).toBe(3)
    expect(preview.items.map(item => item.referencedListCount)).toEqual([2, 2])
  })

  it('keeps unrelated lyrics cleanable while protecting an active download output', async() => {
    const root = path.resolve('C:\\Music')
    const artistPath = path.join(root, 'Artist')
    const incomingPath = path.join(artistPath, 'Incoming')
    const activeAudioPath = path.join(incomingPath, 'active.mp3')
    const activeLyricsPath = path.join(incomingPath, 'active.lrc')
    const activeUnsupportedPath = path.join(artistPath, 'active.ape')
    const oldLyricsPath = path.join(artistPath, 'old.lrc')
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [
              {
                id: 'active-download',
                status: 'run',
                isComplate: false,
                metadata: { filePath: activeAudioPath, fileName: 'active.mp3' },
              },
              {
                id: 'active-unsupported-download',
                status: 'waiting',
                isComplate: false,
                metadata: { filePath: activeUnsupportedPath, fileName: 'active.ape' },
              },
            ],
            getAllUserList: async() => [],
            getListMusics: async() => [],
          },
        },
      },
    })
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'snapshot',
      root,
      status: 'complete',
      checkedCount: 0,
      totalAudioCount: 0,
      artists: [{
        path: artistPath,
        name: 'Artist',
        baseName: 'Artist',
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 2,
        targetName: 'Artist（0首）',
        needsRename: true,
        albums: [],
        blockedReasons: ['下载任务“active.mp3”尚未完成或仍在后处理。'],
      }],
      anomalies: [activeLyricsPath, activeUnsupportedPath, oldLyricsPath].map((filePath, index) => ({
        id: `unsupported-${index}`,
        type: 'unsupported_file',
        path: filePath,
        relativePath: path.relative(root, filePath),
        artistPath,
        artistName: 'Artist',
        size: 1,
        status: '待清理',
        cleanupEligible: true,
      })),
      renamePlan: [{
        artistPath,
        artistName: 'Artist',
        targetName: 'Artist（0首）',
        steps: [{ type: 'artist', from: artistPath, to: `${artistPath}（0首）` }],
        blockedReasons: ['下载任务“active.mp3”尚未完成或仍在后处理。'],
      }],
      totals: {
        artistCount: 1,
        albumCount: 0,
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 3,
        duplicateHardlinkCount: 0,
        reparsePointCount: 0,
        emptyDirectoryCount: 0,
        renameCount: 1,
      },
    }
    snapshot.anomalies.push({
      id: 'incoming-directory',
      type: 'empty_directory',
      path: incomingPath,
      relativePath: path.relative(root, incomingPath),
      artistPath,
      artistName: 'Artist',
      size: 0,
      status: '待清理',
      cleanupEligible: true,
    })
    const service = new SongOrganizerService()
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot

    const preview = await service.cleanupPreview({ taskId: snapshot.taskId, artistPaths: [artistPath] })

    expect(preview.items.map(item => item.path)).toEqual([oldLyricsPath])
    expect(preview.blockedArtists).toEqual([])
  })

  it('never expands cleanup beyond the item paths confirmed by the renderer', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    await fs.mkdir(artistPath)
    const confirmedPath = path.join(artistPath, 'confirmed.lrc')
    const unconfirmedPath = path.join(artistPath, 'unconfirmed.lrc')
    await fs.writeFile(confirmedPath, 'confirmed')
    await fs.writeFile(unconfirmedPath, 'unconfirmed')
    const createAnomaly = async(filePath: string, id: string) => {
      const stat = await lstatWithFileIdentity(filePath)
      return {
        id,
        type: 'unsupported_file' as const,
        path: filePath,
        relativePath: path.relative(root, filePath),
        artistPath,
        artistName: 'Artist',
        size: Number(stat.size),
        mtimeMs: getSongOrganizerMtimeMs(stat),
        fileIdentity: createSongOrganizerFileIdentity(stat),
        status: '待清理',
        cleanupEligible: true,
      }
    }
    const anomalies = await Promise.all([
      createAnomaly(confirmedPath, 'confirmed'),
      createAnomaly(unconfirmedPath, 'unconfirmed'),
    ])
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'snapshot',
      root,
      status: 'complete',
      checkedCount: 0,
      totalAudioCount: 0,
      artists: [{
        path: artistPath,
        name: 'Artist',
        baseName: 'Artist',
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 2,
        targetName: 'Artist（0首）',
        needsRename: false,
        albums: [],
        blockedReasons: [],
      }],
      anomalies,
      renamePlan: [],
      totals: {
        artistCount: 1,
        albumCount: 0,
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 2,
        duplicateHardlinkCount: 0,
        reparsePointCount: 0,
        emptyDirectoryCount: 0,
        renameCount: 0,
      },
    }
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [],
            getAllUserList: async() => [],
            getListMusics: async() => [],
          },
        },
      },
    })
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: root })
    const service = new SongOrganizerService()
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot
    vi.spyOn(service, 'scan').mockResolvedValue(snapshot)

    await service.cleanup({
      taskId: snapshot.taskId,
      artistPaths: [artistPath],
      confirmedItemPaths: [confirmedPath],
    })

    const trashItem = Reflect.get(shell, 'trashItem') as ReturnType<typeof vi.fn>
    expect(trashItem).toHaveBeenCalledTimes(1)
    expect(trashItem).toHaveBeenCalledWith(confirmedPath)

    trashItem.mockClear()
    const playingResult = await service.cleanup({
      taskId: snapshot.taskId,
      artistPaths: [artistPath],
      confirmedItemPaths: [confirmedPath],
      playingFilePath: confirmedPath.toLocaleUpperCase('en-US'),
    })

    expect(trashItem).not.toHaveBeenCalled()
    expect(playingResult.result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: confirmedPath, reason: '当前正在播放，已跳过。' }),
    ]))
  })

  it('rechecks the Main playing path before every cleanup item', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    const firstPath = path.join(artistPath, 'first.lrc')
    const secondPath = path.join(artistPath, 'second.lrc')
    await fs.mkdir(artistPath)
    await fs.writeFile(firstPath, 'first')
    await fs.writeFile(secondPath, 'second')
    const anomalies = await Promise.all([firstPath, secondPath].map(async(filePath, index) => {
      const stat = await lstatWithFileIdentity(filePath)
      return {
        id: `cleanup-${index}`,
        type: 'unsupported_file' as const,
        path: filePath,
        relativePath: path.relative(root, filePath),
        artistPath,
        artistName: 'Artist',
        size: Number(stat.size),
        mtimeMs: getSongOrganizerMtimeMs(stat),
        fileIdentity: createSongOrganizerFileIdentity(stat),
        status: '待清理',
        cleanupEligible: true,
      }
    }))
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'live-playing-cleanup',
      root,
      status: 'complete',
      checkedCount: 0,
      totalAudioCount: 0,
      artists: [{
        path: artistPath,
        name: 'Artist',
        baseName: 'Artist',
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 2,
        targetName: 'Artist（0首）',
        needsRename: false,
        albums: [],
        blockedReasons: [],
      }],
      anomalies,
      renamePlan: [],
      totals: {
        artistCount: 1,
        albumCount: 0,
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 2,
        duplicateHardlinkCount: 0,
        reparsePointCount: 0,
        emptyDirectoryCount: 0,
        renameCount: 0,
      },
    }
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [],
            getAllUserList: async() => [],
            getListMusics: async() => [],
          },
        },
      },
    })
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: root })
    const service = new SongOrganizerService()
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot
    service.setPlayingFilePath(undefined)
    vi.spyOn(service, 'scan').mockResolvedValue(snapshot)
    const trashItem = Reflect.get(shell, 'trashItem') as ReturnType<typeof vi.fn>
    trashItem.mockImplementation(async(trashedPath) => {
      service.setPlayingFilePath(trashedPath == firstPath ? secondPath : firstPath)
    })

    const response = await service.cleanup({
      taskId: snapshot.taskId,
      artistPaths: [artistPath],
      confirmedItemPaths: [firstPath, secondPath],
    })

    expect(trashItem).toHaveBeenCalledTimes(1)
    const trashedPath = trashItem.mock.calls[0]?.[0]
    const protectedPath = trashedPath == firstPath ? secondPath : firstPath
    expect(response.result.skipped).toContainEqual(expect.objectContaining({
      path: protectedPath,
      reason: '当前正在播放，已跳过。',
    }))
  })

  it('rechecks atomic cover sidecars when a download becomes active after preview', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    const activeAudioPath = path.join(artistPath, 'active.mp3')
    const coverSidecarPath = `${activeAudioPath}.lxcover.jpg`
    await fs.mkdir(artistPath)
    await fs.writeFile(coverSidecarPath, 'cover')
    const stat = await lstatWithFileIdentity(coverSidecarPath)
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'late-sidecar-protection',
      root,
      status: 'complete',
      checkedCount: 0,
      totalAudioCount: 0,
      artists: [{
        path: artistPath,
        name: 'Artist',
        baseName: 'Artist',
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 1,
        targetName: 'Artist（0首）',
        needsRename: false,
        albums: [],
        blockedReasons: [],
      }],
      anomalies: [{
        id: 'cover-sidecar',
        type: 'unsupported_file',
        path: coverSidecarPath,
        relativePath: path.relative(root, coverSidecarPath),
        artistPath,
        artistName: 'Artist',
        size: Number(stat.size),
        mtimeMs: getSongOrganizerMtimeMs(stat),
        fileIdentity: createSongOrganizerFileIdentity(stat),
        status: '待清理',
        cleanupEligible: true,
      }],
      renamePlan: [],
      totals: {
        artistCount: 1,
        albumCount: 0,
        audioCount: 0,
        playableCount: 0,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 1,
        duplicateHardlinkCount: 0,
        reparsePointCount: 0,
        emptyDirectoryCount: 0,
        renameCount: 0,
      },
    }
    const activeTask = {
      id: 'late-active-download',
      status: 'run',
      isComplate: true,
      metadata: { filePath: activeAudioPath, fileName: 'active.mp3' },
    }
    const getDownloadList = vi.fn(async() => [activeTask])
      .mockResolvedValueOnce([])
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList,
            getAllUserList: async() => [],
            getListMusics: async() => [],
          },
        },
      },
    })
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: root })
    const service = new SongOrganizerService()
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot
    vi.spyOn(service, 'scan').mockResolvedValue(snapshot)
    const trashItem = Reflect.get(shell, 'trashItem') as ReturnType<typeof vi.fn>

    const response = await service.cleanup({
      taskId: snapshot.taskId,
      artistPaths: [artistPath],
      confirmedItemPaths: [coverSidecarPath],
    })

    expect(trashItem).not.toHaveBeenCalled()
    expect(response.result.skipped).toContainEqual(expect.objectContaining({
      path: coverSidecarPath,
      reason: '目标当前被下载任务占用，已跳过。',
    }))
  })
})

describe('song organizer rename execution blockers', () => {
  it('rechecks active downloads immediately before renaming an artist', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    const targetPath = path.join(root, 'Artist（1首）')
    const activePath = path.join(artistPath, 'song.mp3')
    await fs.mkdir(artistPath)
    await fs.writeFile(activePath, 'audio')
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'snapshot',
      root,
      status: 'complete',
      checkedCount: 1,
      totalAudioCount: 1,
      artists: [{
        path: artistPath,
        name: 'Artist',
        baseName: 'Artist',
        audioCount: 1,
        playableCount: 1,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 0,
        targetName: 'Artist（1首）',
        needsRename: true,
        albums: [],
        blockedReasons: [],
      }],
      anomalies: [],
      renamePlan: [{
        artistPath,
        artistName: 'Artist',
        targetName: 'Artist（1首）',
        steps: [{ type: 'artist', from: artistPath, to: targetPath }],
        blockedReasons: [],
      }],
      totals: {
        artistCount: 1,
        albumCount: 0,
        audioCount: 1,
        playableCount: 1,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 0,
        duplicateHardlinkCount: 0,
        reparsePointCount: 0,
        emptyDirectoryCount: 0,
        renameCount: 1,
      },
    }
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [{
              id: 'active-download',
              status: 'run',
              isComplate: false,
              metadata: { filePath: activePath, fileName: 'song.mp3' },
            }],
            getAllUserList: async() => [],
            getListMusics: async() => [],
            downloadInfoUpdate: async() => {},
          },
        },
        event_list: { list_data_overwrite: async() => {} },
      },
    })
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: root })
    const service = new SongOrganizerService()
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot
    vi.spyOn(service, 'scan').mockResolvedValue(snapshot)

    const response = await service.rename({ taskId: snapshot.taskId, artistPaths: [artistPath] })

    expect(response.result.succeeded).toEqual([])
    expect(response.result.skipped[0]?.reason).toContain('song.mp3')
    await expect(fs.lstat(artistPath)).resolves.toBeTruthy()
    await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rechecks the Main playing path before every artist rename', async() => {
    const root = await createTempRoot()
    const firstArtistPath = path.join(root, 'First')
    const secondArtistPath = path.join(root, 'Second')
    const firstTargetPath = path.join(root, 'First（1首）')
    const secondTargetPath = path.join(root, 'Second（1首）')
    const secondSongPath = path.join(secondArtistPath, 'song.mp3')
    await fs.mkdir(firstArtistPath)
    await fs.mkdir(secondArtistPath)
    await fs.writeFile(path.join(firstArtistPath, 'song.mp3'), 'first')
    await fs.writeFile(secondSongPath, 'second')
    const makeArtist = (artistPath: string) => ({
      path: artistPath,
      name: path.basename(artistPath),
      baseName: path.basename(artistPath),
      audioCount: 1,
      playableCount: 1,
      unplayableCount: 0,
      checkFailedCount: 0,
      unsupportedFileCount: 0,
      targetName: `${path.basename(artistPath)}（1首）`,
      needsRename: true,
      albums: [],
      blockedReasons: [],
    })
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'live-playing-rename',
      root,
      status: 'complete',
      checkedCount: 2,
      totalAudioCount: 2,
      artists: [makeArtist(firstArtistPath), makeArtist(secondArtistPath)],
      anomalies: [],
      renamePlan: [
        {
          artistPath: firstArtistPath,
          artistName: 'First',
          targetName: 'First（1首）',
          steps: [{ type: 'artist', from: firstArtistPath, to: firstTargetPath }],
          blockedReasons: [],
        },
        {
          artistPath: secondArtistPath,
          artistName: 'Second',
          targetName: 'Second（1首）',
          steps: [{ type: 'artist', from: secondArtistPath, to: secondTargetPath }],
          blockedReasons: [],
        },
      ],
      totals: {
        artistCount: 2,
        albumCount: 0,
        audioCount: 2,
        playableCount: 2,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 0,
        duplicateHardlinkCount: 0,
        reparsePointCount: 0,
        emptyDirectoryCount: 0,
        renameCount: 2,
      },
    }
    const service = new SongOrganizerService()
    const listDataOverwrite = vi.fn(async() => {
      service.setPlayingFilePath(secondSongPath)
    })
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [],
            getAllUserList: async() => [],
            getListMusics: async() => [],
            downloadInfoUpdate: async() => {},
          },
        },
        event_list: { list_data_overwrite: listDataOverwrite },
      },
    })
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: root })
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot
    service.setPlayingFilePath(undefined)
    vi.spyOn(service, 'scan').mockResolvedValue(snapshot)

    const response = await service.rename({
      taskId: snapshot.taskId,
      artistPaths: [firstArtistPath, secondArtistPath],
    })

    await expect(fs.lstat(firstTargetPath)).resolves.toBeTruthy()
    await expect(fs.lstat(secondArtistPath)).resolves.toBeTruthy()
    await expect(fs.lstat(secondTargetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(response.result.skipped).toContainEqual(expect.objectContaining({
      path: secondArtistPath,
      reason: '当前播放的本地歌曲位于该歌手目录内。',
    }))
  })

  it('rolls back download paths when playlist reference overwrite fails', async() => {
    const root = await createTempRoot()
    const artistPath = path.join(root, 'Artist')
    const targetPath = path.join(root, 'Artist（1首）')
    const audioPath = path.join(artistPath, 'song.mp3')
    const mappedAudioPath = path.join(targetPath, 'song.mp3')
    await fs.mkdir(artistPath)
    await fs.writeFile(audioPath, 'audio')
    const completedDownload = {
      id: 'completed-download',
      status: 'completed',
      isComplate: true,
      metadata: { filePath: audioPath, fileName: 'song.mp3' },
    }
    const downloadInfoUpdate = vi.fn(async(_items: Array<typeof completedDownload>) => {})
    Object.defineProperty(global, 'lx', {
      configurable: true,
      value: {
        worker: {
          dbService: {
            getDownloadList: async() => [completedDownload],
            getAllUserList: async() => [],
            getListMusics: async() => [],
            downloadInfoUpdate,
          },
        },
        event_list: { list_data_overwrite: vi.fn(async() => { throw new Error('playlist overwrite failed') }) },
      },
    })
    Object.defineProperty(global, 'lxDataPath', { configurable: true, value: root })
    const snapshot: SongOrganizerSnapshot = {
      taskId: 'reference-rollback',
      root,
      status: 'complete',
      checkedCount: 1,
      totalAudioCount: 1,
      artists: [{
        path: artistPath,
        name: 'Artist',
        baseName: 'Artist',
        audioCount: 1,
        playableCount: 1,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 0,
        targetName: 'Artist（1首）',
        needsRename: true,
        albums: [],
        blockedReasons: [],
      }],
      anomalies: [],
      renamePlan: [{
        artistPath,
        artistName: 'Artist',
        targetName: 'Artist（1首）',
        steps: [{ type: 'artist', from: artistPath, to: targetPath }],
        blockedReasons: [],
      }],
      totals: {
        artistCount: 1,
        albumCount: 0,
        audioCount: 1,
        playableCount: 1,
        unplayableCount: 0,
        checkFailedCount: 0,
        unsupportedFileCount: 0,
        duplicateHardlinkCount: 0,
        reparsePointCount: 0,
        emptyDirectoryCount: 0,
        renameCount: 1,
      },
    }
    const service = new SongOrganizerService()
    ;(service as unknown as { snapshot: SongOrganizerSnapshot }).snapshot = snapshot
    vi.spyOn(service, 'scan').mockResolvedValue(snapshot)
    const progressEvents: SongOrganizerOperationProgress[] = []
    service.setOperationProgressListener(progress => progressEvents.push(progress))

    const response = await service.rename({
      taskId: snapshot.taskId,
      operationId: 'rename-operation',
      artistPaths: [artistPath],
    })

    expect(downloadInfoUpdate).toHaveBeenCalledTimes(2)
    expect(downloadInfoUpdate.mock.calls[0]?.[0]?.[0]?.metadata.filePath).toBe(mappedAudioPath)
    expect(downloadInfoUpdate.mock.calls[1]?.[0]?.[0]?.metadata.filePath).toBe(audioPath)
    expect(response.result.failed[0]?.reason).toBe('playlist overwrite failed')
    await expect(fs.lstat(artistPath)).resolves.toBeTruthy()
    await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(progressEvents.map(progress => ({
      operationId: progress.operationId,
      sourceTaskId: progress.sourceTaskId,
      artistPath: progress.artistPath,
      phase: progress.phase,
      completed: progress.completed,
      total: progress.total,
      currentRelativeTarget: progress.currentRelativeTarget,
    }))).toEqual([
      {
        operationId: 'rename-operation',
        sourceTaskId: snapshot.taskId,
        artistPath,
        phase: 'preparing',
        completed: 0,
        total: 1,
        currentRelativeTarget: undefined,
      },
      {
        operationId: 'rename-operation',
        sourceTaskId: snapshot.taskId,
        artistPath,
        phase: 'renaming',
        completed: 0,
        total: 1,
        currentRelativeTarget: path.relative(root, targetPath),
      },
      {
        operationId: 'rename-operation',
        sourceTaskId: snapshot.taskId,
        artistPath,
        phase: 'renaming',
        completed: 1,
        total: 1,
        currentRelativeTarget: path.relative(root, targetPath),
      },
      {
        operationId: 'rename-operation',
        sourceTaskId: snapshot.taskId,
        artistPath,
        phase: 'rollback',
        completed: 0,
        total: 1,
        currentRelativeTarget: path.relative(root, artistPath),
      },
      {
        operationId: 'rename-operation',
        sourceTaskId: snapshot.taskId,
        artistPath,
        phase: 'rollback',
        completed: 1,
        total: 1,
        currentRelativeTarget: path.relative(root, artistPath),
      },
      {
        operationId: 'rename-operation',
        sourceTaskId: snapshot.taskId,
        artistPath,
        phase: 'rescanning',
        completed: 1,
        total: 1,
        currentRelativeTarget: undefined,
      },
      {
        operationId: 'rename-operation',
        sourceTaskId: snapshot.taskId,
        artistPath,
        phase: 'completed',
        completed: 1,
        total: 1,
        currentRelativeTarget: undefined,
      },
    ])
  })
})
