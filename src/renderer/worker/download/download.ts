import { createDownload, type DownloaderType, type Options as DownloadOptions } from '@common/utils/download'
import path from 'node:path'
// import music from '@renderer/utils/musicSdk'
import { createDownloadInfo } from './utils'
// import {
//   filterFileName,
// } from '@common/utils/common'
// import {
//   assertApiSupport,
//   getExt,
// } from '..'
import { checkAndCreateDir, checkPath, getFileStats, removeFile } from '@common/utils/nodejs'
import { DOWNLOAD_STATUS } from '@common/constants'
import {
  discardDownloadedAudio,
  DownloadPublicationCleanupError,
  getDownloadTransferPath,
  prepareDownloadedAudio,
} from './downloadPublication'
import { getDownloadRequestedQuality } from '@common/utils/downloadTask'
import { releaseProxy, type Remote } from 'comlink'
// import { download as eventDownloadNames } from '@renderer/event/names'

// window.downloadList = []
// window.downloadListFull = []
// window.downloadListFullMap = new Map()

const dls = new Map<string, DownloaderType>()
const tryNum = new Map<string, number>()
type DownloadTaskActionCallback = (
  action: LX.Download.DownloadTaskActions,
) => unknown | Promise<unknown>
type ValidateDownloadedAudio = (filePath: string) => Promise<LX.Download.DownloadAudioValidationResult>

interface DownloadTaskRemoteResources {
  callback: Remote<DownloadTaskActionCallback>
  validateAudio?: Remote<ValidateDownloadedAudio>
}

interface DownloadTaskGeneration {
  cancelled: boolean
}

const taskActions = new Map<string, DownloadTaskActionCallback>()
const tasks = new Map<string, LX.Download.ListItem>()
const preparationTasks = new Map<string, Promise<void>>()
const taskRemoteResources = new Map<string, DownloadTaskRemoteResources>()
const taskGenerations = new Map<string, DownloadTaskGeneration>()
const taskTeardowns = new Map<string, Promise<void>>()
interface DownloadPreparationLifecycle {
  beginTask: () => Promise<LX.Download.DownloadAudioLifecycleResult>
  isTaskCancelled: () => Promise<boolean>
  finishTask: (options: LX.Download.DownloadAudioTaskFinishOptions) => Promise<void>
}

type RemoteDownloadPreparationLifecycle = Remote<DownloadPreparationLifecycle>

const preparationLifecycles = new Map<string, RemoteDownloadPreparationLifecycle>()

const releasePreparationLifecycle = (
  taskId: string,
  expected?: DownloadPreparationLifecycle,
): void => {
  const lifecycle = preparationLifecycles.get(taskId)
  if (!lifecycle) return
  if (expected && lifecycle !== expected as unknown as RemoteDownloadPreparationLifecycle) return
  preparationLifecycles.delete(taskId)
  const release = lifecycle[releaseProxy]
  if (typeof release === 'function') release.call(lifecycle)
}

const registerPreparationLifecycle = (
  taskId: string,
  lifecycle?: DownloadPreparationLifecycle,
): void => {
  if (!lifecycle) return
  const remoteLifecycle = lifecycle as unknown as RemoteDownloadPreparationLifecycle
  const previous = preparationLifecycles.get(taskId)
  if (previous && previous !== remoteLifecycle) releasePreparationLifecycle(taskId)
  preparationLifecycles.set(taskId, remoteLifecycle)
}

const releaseRemoteFunction = <T extends (...args: any[]) => any>(remote?: Remote<T>): void => {
  if (!remote) return
  const release = remote[releaseProxy]
  if (typeof release === 'function') release.call(remote)
}

const releaseTaskRemoteResources = (
  taskId: string,
  expected?: DownloadTaskRemoteResources,
): void => {
  const resources = taskRemoteResources.get(taskId)
  if (!resources || (expected && resources !== expected)) return
  taskRemoteResources.delete(taskId)
  if (taskActions.get(taskId) === resources.callback as unknown as DownloadTaskActionCallback) taskActions.delete(taskId)
  releaseRemoteFunction(resources.callback)
  releaseRemoteFunction(resources.validateAudio)
}

const registerTaskRemoteResources = (
  taskId: string,
  callback: DownloadTaskActionCallback,
  validateAudio?: ValidateDownloadedAudio,
): DownloadTaskRemoteResources => {
  releaseTaskRemoteResources(taskId)
  const resources: DownloadTaskRemoteResources = {
    callback: callback as Remote<DownloadTaskActionCallback>,
    validateAudio: validateAudio as Remote<ValidateDownloadedAudio> | undefined,
  }
  taskRemoteResources.set(taskId, resources)
  return resources
}

const releaseTaskGeneration = (taskId: string, expected?: DownloadTaskGeneration): void => {
  if (expected && taskGenerations.get(taskId) === expected) taskGenerations.delete(taskId)
}

const enqueueTaskTeardown = async(taskId: string, operation: () => Promise<void>): Promise<void> => {
  const previous = taskTeardowns.get(taskId) ?? Promise.resolve()
  const teardown = previous.catch(() => {}).then(operation)
  taskTeardowns.set(taskId, teardown)
  return teardown.finally(() => {
    if (taskTeardowns.get(taskId) === teardown) taskTeardowns.delete(taskId)
  })
}

export const checkList = (list: LX.Download.ListItem[], musicInfo: LX.Music.MusicInfo, quality: LX.Quality, ext: string): boolean => {
  return list.some(s => s.id === musicInfo.id && (s.metadata.quality === quality || s.metadata.ext === ext))
}

// const removeTask = (id: string) => {
//   dls.delete(id)
//   tryNum.delete(id)
//   taskActions.delete(id)
//   tasks.delete(id)
// }
const sendAction = (id: string, action: LX.Download.DownloadTaskActions) => {
  const callback = taskActions.get(id)
  if (!callback) return
  void callback(action)
}

const sendActionAndWait = async(
  id: string,
  action: LX.Download.DownloadTaskActions,
): Promise<unknown> => {
  return await taskActions.get(id)?.(action)
}

const sendTerminalAction = (
  id: string,
  action: LX.Download.DownloadTaskActions,
  preparationLifecycle: DownloadPreparationLifecycle | undefined,
  remoteResources: DownloadTaskRemoteResources,
  generation?: DownloadTaskGeneration,
): void => {
  const terminalAction = Promise.resolve(remoteResources.callback(action)).then(() => {}).catch(() => {}).finally(() => {
    releasePreparationLifecycle(id, preparationLifecycle)
    releaseTaskRemoteResources(id, remoteResources)
    releaseTaskGeneration(id, generation)
  })
  preparationTasks.set(id, terminalAction)
  void terminalAction.finally(() => {
    if (preparationTasks.get(id) === terminalAction) preparationTasks.delete(id)
  }).catch(() => {})
}

export const createDownloadTasks = (
  list: LX.Music.MusicInfoOnline[],
  quality: LX.Quality,
  options: LX.Download.CreateTaskOptions,
  qualityList: LX.QualityList,
): LX.Download.ListItem[] => {
  return list.map(musicInfo => {
    return createDownloadInfo(musicInfo, quality, options, qualityList)
  }).filter(task => task)
  // commit('addTasks', { list: taskList, addMusicLocationType: rootState.setting.list.addMusicLocationType })
  // let result = getStartTask(downloadList, DOWNLOAD_STATUS, rootState.setting.download.maxDownloadNum)
  // while (result) {
  //   dispatch('startTask', result)
  //   result = getStartTask(downloadList, DOWNLOAD_STATUS, rootState.setting.download.maxDownloadNum)
  // }
}

const createTask = async(
  downloadInfo: LX.Download.ListItem,
  savePath: string,
  skipExistFile: boolean,
  proxy?: { host: string, port: number },
  validateAudio?: ValidateDownloadedAudio,
  preparationLifecycle?: DownloadPreparationLifecycle,
  remoteResources?: DownloadTaskRemoteResources,
  generation?: DownloadTaskGeneration,
) => {
  const isCurrentGeneration = (): boolean => {
    return generation != null &&
      !generation.cancelled &&
      taskGenerations.get(downloadInfo.id) === generation &&
      tasks.get(downloadInfo.id) === downloadInfo
  }
  // console.log('createTask', downloadInfo, savePath)
  // 开始任务
  /* commit('onStart', downloadInfo)
  commit('setStatusText', { downloadInfo, text: '任务初始化中' }) */
  const savePathReady = await checkAndCreateDir(savePath)
  if (!isCurrentGeneration()) return
  if (!savePathReady) {
    await sendActionAndWait(downloadInfo.id, {
      action: 'error',
      data: {
        error: 'download_status_error_check_path',
      },
    })
    return
  }

  if (downloadInfo.downloaded == 0) {
    if (skipExistFile) {
      const stats = await getFileStats(downloadInfo.metadata.filePath)
      if (!isCurrentGeneration()) return
      if (stats) {
        await sendActionAndWait(downloadInfo.id, {
          action: 'error',
          data: {
            error: 'download_status_error_check_path_exist',
          },
        })
        return
      }
    } else {
      const targetExists = await checkPath(downloadInfo.metadata.filePath)
      if (!isCurrentGeneration()) return
      if (targetExists) {
        try {
          await removeFile(downloadInfo.metadata.filePath)
          if (!isCurrentGeneration()) return
        } catch (err) {
          if (!isCurrentGeneration()) return
          await sendActionAndWait(downloadInfo.id, {
            action: 'error',
            data: {
              error: 'download_status_error_check_path',
            },
          })
          return
        }
      }
    }
  }

  if (!isCurrentGeneration()) return

  const transferPath = getDownloadTransferPath(downloadInfo.metadata.filePath)
  const transferFileName = path.basename(transferPath)
  const downloadOptions: DownloadOptions = {
    url: downloadInfo.metadata.url ?? '',
    path: savePath,
    fileName: transferFileName,
    method: 'get',
    proxy,
    onCompleted() {
      if (!isCurrentGeneration()) return
      // if (downloadInfo.progress.progress != '100.00') {
      //   delete.get(downloadInfo.id)?
      //   return dispatch('startTask', downloadInfo)
      // }
      const preparation = (async() => {
        let lifecycleActive = false
        let sourceDisposition: LX.Download.DownloadAudioSourceDisposition = 'preserve'
        let cancellationWon = false
        const artifactPathsToDiscard = new Set<string>()
        try {
          if (preparationLifecycle) {
            const lifecycle = await preparationLifecycle.beginTask()
            if (lifecycle.status == 'cancelled') return
            lifecycleActive = true
          }
          if (!isCurrentGeneration()) return
          if (await preparationLifecycle?.isTaskCancelled()) return
          if (!validateAudio) throw new Error('Main download audio validator is unavailable')
          const publication = await prepareDownloadedAudio({
            transferPath,
            filePath: downloadInfo.metadata.filePath,
            fileName: downloadInfo.metadata.fileName,
            ext: downloadInfo.metadata.ext,
            quality: getDownloadRequestedQuality(downloadInfo),
            validate: validateAudio,
            artifactCleanupOwner: lifecycleActive ? 'lifecycle' : 'worker',
          })
          if (!isCurrentGeneration()) {
            cancellationWon = true
            await discardDownloadedAudio(publication)
            return
          }
          if (await preparationLifecycle?.isTaskCancelled()) {
            cancellationWon = true
            await discardDownloadedAudio(publication)
            return
          }
          downloadInfo.isComplate = true
          downloadInfo.status = DOWNLOAD_STATUS.COMPLETED
          Object.assign(downloadInfo.metadata, {
            filePath: publication.filePath,
            fileName: publication.fileName,
            ext: publication.ext,
            quality: publication.quality,
            stagingPath: publication.stagingPath,
            actualFormat: publication.actualFormat,
            formatDowngrade: publication.downgrade,
          })
          const publicationAccepted = await sendActionAndWait(
            downloadInfo.id,
            { action: 'complete', data: publication },
          ) === true
          if (publicationAccepted) sourceDisposition = 'discard'
          console.log('on complate')
        } catch (err) {
          const error = err as NodeJS.ErrnoException
          if (error instanceof DownloadPublicationCleanupError) artifactPathsToDiscard.add(error.filePath)
          if (error.code === 'ECANCELED') return
          if (!isCurrentGeneration()) return
          if (!cancellationWon) sourceDisposition = 'discard'
          await sendActionAndWait(downloadInfo.id, {
            action: 'error',
            data: {
              error: error.code === 'EEXIST'
                ? 'download_status_error_check_path_exist'
                : 'download_status_error_invalid_audio',
              message: error.message,
            },
          })
        } finally {
          try {
            if (lifecycleActive) {
              await preparationLifecycle?.finishTask({
                sourceDisposition,
                artifactPathsToDiscard: [...artifactPathsToDiscard],
              })
            }
          } finally {
            releasePreparationLifecycle(downloadInfo.id, preparationLifecycle)
            if (remoteResources) releaseTaskRemoteResources(downloadInfo.id, remoteResources)
            releaseTaskGeneration(downloadInfo.id, generation)
          }
        }
      })().finally(() => { preparationTasks.delete(downloadInfo.id) })
      preparationTasks.set(downloadInfo.id, preparation)
    },
    onError(err: any) {
      if (!isCurrentGeneration()) return
      console.error(err)
      if (err.code == 'EPERM') {
        if (!remoteResources) return
        sendTerminalAction(downloadInfo.id, {
          action: 'error',
          data: {
            error: 'download_status_error_write',
            message: err.message,
          },
          // data: `歌曲保存位置被占用或没有写入权限，请尝试更改歌曲保存目录或重启软件或重启电脑，错误详情：${err.message as string}`,
        }, preparationLifecycle, remoteResources, generation)
        return
      }
      // console.log(tryNum[downloadInfo.id])
      let retryNum = tryNum.get(downloadInfo.id) ?? 0
      tryNum.set(downloadInfo.id, ++retryNum)
      if (retryNum > 2) {
        if (!remoteResources) return
        sendTerminalAction(downloadInfo.id, {
          action: 'error',
          data: {
            message: err.message,
          },
        }, preparationLifecycle, remoteResources, generation)
        // dispatch('startTask')
        return
      }
      if (err.message?.startsWith('Resume failed')) {
        const dl = dls.get(downloadInfo.id)
        if (!dl) return
        void enqueueTaskTeardown(downloadInfo.id, async() => {
          if (!isCurrentGeneration() || dls.get(downloadInfo.id) !== dl) return
          try {
            await removeFile(transferPath)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (!isCurrentGeneration() || dls.get(downloadInfo.id) !== dl || !remoteResources) return
            sendTerminalAction(downloadInfo.id, {
              action: 'error',
              data: {
                error: 'download_status_error_write',
                message,
              },
            }, preparationLifecycle, remoteResources, generation)
            return
          }
          if (!isCurrentGeneration() || dls.get(downloadInfo.id) !== dl) return
          console.log('正在重试')
          await dl.start()
          // sendAction(downloadInfo.id, {
          //   action: 'statusText',
          //   data: 'download_status_error_retrying',
          // })
        }).catch(err => { console.log(err) })
        return
      }
      if (err.code == 'ENOTFOUND') {
        sendAction(downloadInfo.id, { action: 'refreshUrl' })
      } else {
        console.log('Download failed, Attempting Retry')
        setTimeout(() => {
          if (!isCurrentGeneration()) return
          void dls.get(downloadInfo.id)?.start()
        }, 1000)
      }
    },
    onFail(response) {
      if (!isCurrentGeneration()) return
      let retryNum = tryNum.get(downloadInfo.id) ?? 0
      tryNum.set(downloadInfo.id, ++retryNum)
      if (retryNum > 2) {
        if (!remoteResources) return
        if (response.statusCode) {
          sendTerminalAction(downloadInfo.id, {
            action: 'error',
            data: {
              error: 'download_status_error_response',
              message: String(response.statusCode),
            },
          }, preparationLifecycle, remoteResources, generation)
        } else {
          sendTerminalAction(downloadInfo.id, {
            action: 'error',
            data: {},
          }, preparationLifecycle, remoteResources, generation)
        }
        return
      }
      switch (response.statusCode) {
        case 401:
        case 403:
        case 410:
          sendAction(downloadInfo.id, { action: 'refreshUrl' })
          // commit('onError', { downloadInfo, errorMsg: '链接失效' })
          // refreshUrl.call(_this, commit, downloadInfo, rootState.setting.download.isUseOtherSource)
          break
        default:
          void dls.get(downloadInfo.id)?.start()
          console.log('正在重试')
          // commit('setStatusText', { downloadInfo, text: '正在重试' })
          break
      }
    },
    onStart() {
      if (!isCurrentGeneration()) return
      sendAction(downloadInfo.id, { action: 'start' })
      console.log('on start')
    },
    onProgress(status) {
      if (!isCurrentGeneration()) return
      downloadInfo.total = status.total
      downloadInfo.downloaded = status.downloaded
      downloadInfo.progress = status.progress
      downloadInfo.speed = status.speed
      downloadInfo.writeQueue = status.writeQueue
      sendAction(downloadInfo.id, { action: 'progress', data: status })
      // console.log(status)
    },
    onStop() {
      if (!isCurrentGeneration()) return
      console.log('on stop')
      // sendAction(downloadInfo.id, { action: 'pause' })
      // commit('pauseTask', downloadInfo)
      // dispatch('startTask')
    },
  }
  // commit('setStatusText', { downloadInfo, text: '获取URL中...' })

  tryNum.set(downloadInfo.id, 0)
  dls.set(downloadInfo.id, createDownload(downloadOptions))
}

export const updateUrl = (id: string, url: string) => {
  const task = tasks.get(id)
  if (!task) return
  task.metadata.url = url
  // commit('setStatusText', { downloadInfo, text: '链接刷新成功' })
  const dl = dls.get(id)
  if (!dl) return
  dl.refreshUrl(url)
  dl.start().catch(err => {
    sendAction(id, {
      action: 'error',
      data: {
        message: err.message,
      },
    })
  })
}

export const startTask = async(
  downloadInfo: LX.Download.ListItem,
  savePath: string,
  skipExistFile: boolean,
  callback: DownloadTaskActionCallback,
  proxy?: { host: string, port: number },
  validateAudio?: ValidateDownloadedAudio,
  preparationLifecycle?: DownloadPreparationLifecycle,
) => {
  await pauseTask(downloadInfo.id)

  const generation: DownloadTaskGeneration = { cancelled: false }
  taskGenerations.set(downloadInfo.id, generation)
  registerPreparationLifecycle(downloadInfo.id, preparationLifecycle)
  const remoteResources = registerTaskRemoteResources(downloadInfo.id, callback, validateAudio)
  tasks.set(downloadInfo.id, downloadInfo)
  taskActions.set(downloadInfo.id, callback)
  // 检查是否可以开始任务
  // if (!downloadInfo.isComplate && downloadInfo.status != DOWNLOAD_STATUS.RUN) {
  //   const result = getStartTask(downloadList, DOWNLOAD_STATUS, rootState.setting.download.maxDownloadNum)
  //   if (result === false) {
  //     commit('setStatus', { downloadInfo, status: DOWNLOAD_STATUS.WAITING })
  //     return
  //   }
  // } else {
  //   const result = getStartTask(downloadList, DOWNLOAD_STATUS, rootState.setting.download.maxDownloadNum)
  //   if (!result) return
  //   downloadInfo = result
  // }
  // commit('setStatus', { downloadInfo, status: DOWNLOAD_STATUS.RUN })

  let lifecycleRetained = false
  try {
    const dl = dls.get(downloadInfo.id)
    if (dl) {
      lifecycleRetained = true
      // commit('updateFilePath', {
      //   downloadInfo,
      //   filePath: path.join(rootState.setting.download.savePath, downloadInfo.metadata.fileName),
      // })
      const transferPath = getDownloadTransferPath(downloadInfo.metadata.filePath)
      dl.updateSaveInfo(savePath, path.basename(transferPath))
      if (tryNum.has(downloadInfo.id)) tryNum.set(downloadInfo.id, 0)
      try {
        await dl.start()
      } catch (error) {
        // commit('onError', { downloadInfo, errorMsg: error.message })
        // commit('setStatusText', error.message)
        // await dispatch('startTask')
      }
    } else {
      await createTask(downloadInfo, savePath, skipExistFile, proxy, validateAudio, preparationLifecycle, remoteResources, generation)
      lifecycleRetained = dls.has(downloadInfo.id)
      // await dispatch('handleStartTask', downloadInfo)
    }
  } finally {
    if (!lifecycleRetained) {
      releasePreparationLifecycle(downloadInfo.id, preparationLifecycle)
      releaseTaskRemoteResources(downloadInfo.id, remoteResources)
      releaseTaskGeneration(downloadInfo.id, generation)
    }
  }
}

const pauseTaskCore = async(id: string): Promise<void> => {
  const generation = taskGenerations.get(id)
  const preparation = preparationTasks.get(id)
  const dl = dls.get(id)
  const lifecycle = preparationLifecycles.get(id)
  const remoteResources = taskRemoteResources.get(id)
  if (generation) generation.cancelled = true
  await preparation?.catch(() => {})
  if (taskGenerations.get(id) === generation) {
    tasks.delete(id)
    taskActions.delete(id)
    tryNum.delete(id)
  }
  if (dl) {
    if (dls.get(id) === dl) dls.delete(id)

    try {
      await dl.stop()
    } catch (e) {
      console.log(e)
    }
  }
  if (lifecycle) releasePreparationLifecycle(id, lifecycle as unknown as DownloadPreparationLifecycle)
  if (remoteResources) releaseTaskRemoteResources(id, remoteResources)
  releaseTaskGeneration(id, generation)
  // commit('setStatus', { downloadInfo: downloadInfo, status: DOWNLOAD_STATUS.PAUSE })
}

export const pauseTask = async(id: string): Promise<void> => {
  const generation = taskGenerations.get(id)
  if (generation) generation.cancelled = true
  await enqueueTaskTeardown(id, async() => pauseTaskCore(id))
}

export const removeTask = async(id: string) => {
  const generation = taskGenerations.get(id)
  if (generation) generation.cancelled = true
  await enqueueTaskTeardown(id, async() => {
    const downloadInfo = tasks.get(id)
    const generation = taskGenerations.get(id)
    await pauseTaskCore(id)

    if (downloadInfo) {
      const currentGeneration = taskGenerations.get(id)
      if (currentGeneration && currentGeneration !== generation) return
      // 没有未完成、已下载大于1k
      if (!downloadInfo.isComplate && downloadInfo.total && downloadInfo.downloaded > 1024) {
        try {
          await removeFile(getDownloadTransferPath(downloadInfo.metadata.filePath))
        } catch (_) {}
      }
    }
  })
}
