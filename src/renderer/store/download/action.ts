import {
  downloadTasksGet,
  // downloadListClear,
  downloadTasksCreate,
  downloadTasksRemove,
  downloadTasksUpdate,
  notifySongOrganizerDownloadOccupancyChanged,
  cancelDownloadAudioValidation,
  resetDownloadAudioTask,
  beginDownloadAudioTask,
  isDownloadAudioTaskCancelled,
  finishDownloadAudioTask,
  validateDownloadAudio,
} from '@renderer/utils/ipc'
import {
  downloadList,
} from './state'
import { markRaw, toRaw } from '@common/utils/vueTools'
import { getMusicUrl, getPicUrl, getLyricInfo } from '@renderer/core/music/online'
import { appSetting } from '../setting'
import { qualityList } from '..'
import { proxyCallback } from '@renderer/worker/utils'
import { arrPush, arrUnshift, dirname, joinPath } from '@renderer/utils'
import { DOWNLOAD_STATUS } from '@common/constants'
import { proxy } from '../index'
import { buildSavePath, getPlaylistName } from './utils'
import { dialog } from '@renderer/plugins/Dialog'
import { deduplicateDownloadTargets } from '@common/utils/downloadTarget'
import type { Message } from '@root/lang'
import {
  applyDownloadPublication,
  getDownloadCompletedStatusKey,
  getDownloadStartupAction,
  isDownloadPostProcessing,
  isDownloadPostProcessingPending,
  markDownloadPostProcessing,
  markDownloadPostProcessingFailed,
} from './postProcessState'
import { awaitProviderSettlement } from './providerDeadline'
import { finalizeDownloadPublication } from './finalizePublication'
import { getDownloadRequestedQuality } from '@common/utils/downloadTask'
import {
  buildDownloadMetadataWritePlan,
  DownloadPostProcessingError,
  serializeDownloadPostProcessingError,
} from './downloadMetadata'
import {
  createCompletedDownloadPersistenceState,
  markCommittedPublicationPersistenceFailure,
  reconcileDownloadPublication,
  type DownloadPublicationRecoveryAction,
} from './publicationRecovery'
import {
  coordinateDownloadTaskRemoval,
  coordinateDownloadTaskRetry,
  createDownloadPreparationLifecycleProxy,
  reserveDownloadTaskStart,
} from './downloadActionSeams'

const DOWNLOAD_PROVIDER_DEADLINE_MS = 30_000

const TARGET_FALLBACK_MESSAGE_KEYS: Record<LX.Download.DownloadTargetFallbackReason, keyof Message> = {
  missing_track_number: 'download_target_fallback_missing_track_number',
  missing_track_artist: 'download_target_fallback_missing_track_artist',
  missing_album_artist: 'download_target_fallback_missing_album_artist',
  missing_release_date: 'download_target_fallback_missing_release_date',
  invalid_release_date: 'download_target_fallback_invalid_release_date',
  missing_album_name: 'download_target_fallback_missing_album_name',
  missing_playlist_name: 'download_target_fallback_missing_playlist_name',
  path_truncated: 'download_target_fallback_path_truncated',
}

const waitingUpdateTasks = new Map<string, LX.Download.ListItem>()
let timer: NodeJS.Timeout | null = null
const throttleUpdateTask = (tasks: LX.Download.ListItem[]) => {
  for (const task of tasks) waitingUpdateTasks.set(task.id, toRaw(task))
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void downloadTasksUpdate(Array.from(waitingUpdateTasks.values()))
    waitingUpdateTasks.clear()
  }, 100)
}

const runingTask = new Map<string, LX.Download.ListItem>()
const queuedPostProcessingTasks = new Map<string, LX.Download.ListItem>()
let isDownloadListInitialized = false
let downloadListInitialization: Promise<LX.Download.ListItem[]> | null = null

// const initDownloadList = (list: LX.Download.ListItem[]) => {
//   downloadList.splice(0, downloadList.length, ...list)
// }

const recoverDownloadPublicationTask = async(
  downloadInfo: LX.Download.ListItem,
): Promise<DownloadPublicationRecoveryAction> => {
  const durableStagingPath = downloadInfo.metadata.stagingPath
  if (!durableStagingPath) return 'none'
  await resetDownloadAudioTask(downloadInfo.id)
  const lifecycle = await beginDownloadAudioTask(downloadInfo.id)
  if (lifecycle.status != 'active') return 'none'
  try {
    const recoveryAction = await reconcileDownloadPublication(downloadInfo, {
      inspectPaths: async task => window.lx.worker.download.inspectDownloadPublicationPaths({
        stagingPath: task.metadata.stagingPath!,
        filePath: task.metadata.filePath,
      }),
      verifyFinal: async task => {
        const actualFormat = task.metadata.actualFormat
        if (!actualFormat) throw new Error('Missing persisted actual audio format')
        await window.lx.worker.download.verifyDownloadedAudioFormat(task.metadata.filePath, actualFormat)
        const validation = await validateDownloadAudio({
          taskId: task.id,
          filePath: task.metadata.filePath,
          allowNormalization: false,
        })
        if (validation.status == 'cancelled') throw new Error('Published audio verification cancelled')
      },
      completedStatusText: window.i18n.t(
        getDownloadCompletedStatusKey(downloadInfo),
        { quality: downloadInfo.metadata.quality },
      ),
      retryStatusText: window.i18n.t('download___status_paused'),
    })
    if (recoveryAction !== 'resume_stage' && recoveryAction !== 'none') {
      await downloadTasksUpdate([downloadInfo])
    }
    return recoveryAction
  } catch (error) {
    downloadInfo.metadata.stagingPath = durableStagingPath
    downloadInfo.metadata.postProcessingError = {
      phase: 'persistence',
      code: 'publication_recovery_failed',
      message: `下载发布恢复失败：${(error as Error).message}`,
      taskId: downloadInfo.id,
      filePath: downloadInfo.metadata.filePath,
    }
    markDownloadPostProcessingFailed(downloadInfo, downloadInfo.metadata.postProcessingError.message)
    await downloadTasksUpdate([downloadInfo]).catch(persistError => {
      console.error('Failed to persist download publication recovery error', persistError)
    })
    return 'blocked_conflict'
  } finally {
    await finishDownloadAudioTask({
      taskId: downloadInfo.id,
      options: { sourceDisposition: 'preserve' },
    })
  }
}

const initDownloadList = async(): Promise<LX.Download.ListItem[]> => {
  const list = await downloadTasksGet()
  const resumedPostProcessingTasks: LX.Download.ListItem[] = []
  for (const downloadInfo of list) {
    if (downloadInfo.metadata.stagingPath) {
      await recoverDownloadPublicationTask(downloadInfo)
    }
    markRaw(downloadInfo.metadata)
    switch (getDownloadStartupAction(downloadInfo)) {
      case 'resume_post_processing':
        downloadInfo.progress = 100
        downloadInfo.speed = ''
        downloadInfo.writeQueue = 0
        resumedPostProcessingTasks.push(downloadInfo)
        break
      case 'pause':
        downloadInfo.status = DOWNLOAD_STATUS.PAUSE
        downloadInfo.statusText = window.i18n.t('download___status_paused')
        break
      default:
        break
    }
  }
  arrPush(downloadList, list)
  for (const downloadInfo of resumedPostProcessingTasks) {
    queuedPostProcessingTasks.set(downloadInfo.id, downloadInfo)
  }
  void checkStartTask()
  isDownloadListInitialized = true
  return downloadList
}

export const getDownloadList = async(): Promise<LX.Download.ListItem[]> => {
  if (isDownloadListInitialized) return downloadList
  if (!downloadListInitialization) {
    downloadListInitialization = initDownloadList().catch(err => {
      downloadListInitialization = null
      throw err
    })
  }
  return downloadListInitialization
}

const addTasks = async(list: LX.Download.ListItem[]) => {
  const addMusicLocationType = appSetting['list.addMusicLocationType']

  await downloadTasksCreate(list.map(i => toRaw(i)), addMusicLocationType)
  notifySongOrganizerDownloadOccupancyChanged()

  if (addMusicLocationType === 'top') {
    arrUnshift(downloadList, list)
  } else {
    arrPush(downloadList, list)
  }
  window.app_event.downloadListUpdate()
}

const setStatusText = (downloadInfo: LX.Download.ListItem, text: string) => { // 设置状态文本
  downloadInfo.statusText = text
  throttleUpdateTask([downloadInfo])
}

const setUrl = (downloadInfo: LX.Download.ListItem, url: string) => {
  downloadInfo.metadata.url = url
  throttleUpdateTask([downloadInfo])
}

const updateFilePath = (downloadInfo: LX.Download.ListItem, filePath: string) => {
  downloadInfo.metadata.filePath = filePath
  throttleUpdateTask([downloadInfo])
}

const setProgress = (downloadInfo: LX.Download.ListItem, progress: LX.Download.ProgressInfo) => {
  downloadInfo.total = progress.total
  downloadInfo.downloaded = progress.downloaded
  downloadInfo.writeQueue = progress.writeQueue
  if (progress.progress == 100) {
    downloadInfo.speed = ''
    downloadInfo.progress = 99.99
    setStatusText(downloadInfo, window.i18n.t('download_status_write_queue', { num: progress.writeQueue }))
  } else {
    downloadInfo.speed = progress.speed
    downloadInfo.progress = progress.progress
  }
  throttleUpdateTask([downloadInfo])
}

const setStatus = (downloadInfo: LX.Download.ListItem, status: LX.Download.DownloadTaskStatus, statusText?: string) => { // 设置状态及状态文本
  if (statusText == null) {
    switch (status) {
      case DOWNLOAD_STATUS.RUN:
        statusText = window.i18n.t('download___status_running')
        break
      case DOWNLOAD_STATUS.WAITING:
        statusText = window.i18n.t('download___status_waiting')
        break
      case DOWNLOAD_STATUS.PAUSE:
        statusText = window.i18n.t('download___status_paused')
        break
      case DOWNLOAD_STATUS.ERROR:
        statusText = window.i18n.t('download___status_error')
        break
      case DOWNLOAD_STATUS.COMPLETED:
        statusText = window.i18n.t('download___status_completed')
        break
      default:
        statusText = ''
        break
    }
  }

  if (downloadInfo.statusText == statusText && downloadInfo.status == status) return

  if (status == DOWNLOAD_STATUS.COMPLETED) downloadInfo.isComplate = true
  downloadInfo.statusText = statusText
  downloadInfo.status = status
  throttleUpdateTask([downloadInfo])
}

// 修复 1.1.x版本 酷狗源歌词格式
const fixKgLyric = (lrc: string) => /\[00:\d\d:\d\d.\d+\]/.test(lrc) ? lrc.replace(/(?:\[00:(\d\d:\d\d.\d+\]))/gm, '[$1') : lrc

const getProxy = () => {
  return proxy.enable && proxy.host ? {
    host: proxy.host,
    port: parseInt(proxy.port || '80'),
  } : proxy.envProxy ? {
    host: proxy.envProxy.host,
    port: parseInt(proxy.envProxy.port || '80'),
  } : undefined
}
/**
 * 设置歌曲meta信息
 * @param downloadInfo 下载任务信息
 */
const saveMeta = async(downloadInfo: LX.Download.ListItem, filePath = downloadInfo.metadata.filePath): Promise<void> => {
  const isUseOtherSource = appSetting['download.isUseOtherSource']
  const embedPicture = appSetting['download.isEmbedPic']
  const metadataPlan = await buildDownloadMetadataWritePlan(downloadInfo, {
    embedPicture,
    resolveCoverUrl: async() => awaitProviderSettlement(
      getPicUrl({ musicInfo: downloadInfo.metadata.musicInfo, isRefresh: false, allowToggleSource: isUseOtherSource }),
      DOWNLOAD_PROVIDER_DEADLINE_MS,
      'download cover provider',
    ),
  })
  if (metadataPlan.warning) {
    downloadInfo.metadata.postProcessingWarning = metadataPlan.warning
    console.warn(metadataPlan.warning.message)
  } else {
    delete downloadInfo.metadata.postProcessingWarning
  }
  if (!metadataPlan.metadata) return
  const lyrics = appSetting['download.isEmbedLyric']
    ? await awaitProviderSettlement(
      getLyricInfo({ musicInfo: downloadInfo.metadata.musicInfo, isRefresh: false, allowToggleSource: isUseOtherSource }),
      DOWNLOAD_PROVIDER_DEADLINE_MS,
      'embedded lyric provider',
    ).catch(() => null)
    : null
  const info = {
    filePath,
    isEmbedLyricLx: appSetting['download.isEmbedLyricLx'],
    isEmbedLyricT: appSetting['download.isEmbedLyricT'],
    isEmbedLyricR: appSetting['download.isEmbedLyricR'],
    ...metadataPlan.metadata,
  }
  try {
    await window.lx.worker.download.writeMeta(info, lyrics ?? { lyric: '' }, getProxy())
  } catch (error) {
    throw new DownloadPostProcessingError({
      phase: embedPicture ? 'cover' : 'metadata',
      code: embedPicture ? 'cover_write_failed' : 'metadata_write_failed',
      message: `下载任务 ${downloadInfo.id} 写入${embedPicture ? '封面或标签' : '标签'}失败：${(error as Error).message}`,
      taskId: downloadInfo.id,
      filePath,
    })
  }
}

/**
 * 保存歌词文件
 * @param downloadInfo 下载任务信息
 */
const downloadLyric = async(downloadInfo: LX.Download.ListItem, stagingPath?: string): Promise<boolean> => {
  if (!appSetting['download.isDownloadLrc']) return false
  const lrcs = await awaitProviderSettlement(
    getLyricInfo({
      musicInfo: downloadInfo.metadata.musicInfo,
      isRefresh: false,
      allowToggleSource: appSetting['download.isUseOtherSource'],
    }),
    DOWNLOAD_PROVIDER_DEADLINE_MS,
    'download lyric provider',
  ).catch(() => null)
  if (!lrcs) return false
  if (!lrcs.lyric) return false
  lrcs.lyric = fixKgLyric(lrcs.lyric)
  const info = {
    filePath: stagingPath ?? downloadInfo.metadata.filePath.substring(0, downloadInfo.metadata.filePath.lastIndexOf('.')) + '.lrc',
    format: appSetting['download.lrcFormat'],
    downloadLxlrc: appSetting['download.isDownloadLxLrc'],
    downloadTlrc: appSetting['download.isDownloadTLrc'],
    downloadRlrc: appSetting['download.isDownloadRLrc'],
  }
  await window.lx.worker.download.saveLrc(lrcs, info)
  return true
}

const postProcessingTasks = new Set<string>()
const persistPostProcessingFailure = async(
  downloadInfo: LX.Download.ListItem,
  error: unknown,
  sidecar?: LX.Download.DownloadPublicationSidecar,
): Promise<void> => {
  console.error('Download post-processing failed', error)
  waitingUpdateTasks.delete(downloadInfo.id)
  const stagingPath = downloadInfo.metadata.stagingPath
  let persistedError = serializeDownloadPostProcessingError(downloadInfo, error)
  if (stagingPath) {
    let cleaned = false
    await window.lx.worker.download.discardDownloadedAudio({ stagingPath }, sidecar).then(() => {
      cleaned = true
    }).catch(cleanupError => {
      console.error('Failed to discard download publication staging', cleanupError)
      persistedError = {
        phase: 'publication',
        code: 'staging_cleanup_failed',
        message: `${persistedError.message}；清理暂存文件失败：${(cleanupError as Error).message}`,
        taskId: downloadInfo.id,
        filePath: stagingPath,
      }
    })
    if (cleaned) delete downloadInfo.metadata.stagingPath
  }
  downloadInfo.metadata.postProcessingError = persistedError
  markDownloadPostProcessingFailed(downloadInfo, persistedError.message)
  if (stagingPath && !downloadInfo.metadata.stagingPath) {
    downloadInfo.isComplate = false
    downloadInfo.downloaded = 0
    downloadInfo.total = 0
    downloadInfo.progress = 0
  }
  try {
    await downloadTasksUpdate([toRaw(downloadInfo)])
  } catch (persistError) {
    console.error('Failed to persist download post-processing failure', persistError)
  }
}

const persistCommittedPublicationFailure = async(
  downloadInfo: LX.Download.ListItem,
  error: unknown,
): Promise<void> => {
  waitingUpdateTasks.delete(downloadInfo.id)
  markCommittedPublicationPersistenceFailure(downloadInfo, error)
  try {
    await downloadTasksUpdate([toRaw(downloadInfo)])
  } catch (persistError) {
    console.error('Failed to persist committed download recovery intent', persistError)
  }
}

const completeDownloadTask = async(
  downloadInfo: LX.Download.ListItem,
  onPublicationIntentSettled?: (accepted: boolean) => void,
): Promise<void> => {
  let publicationIntentSettled = false
  const settlePublicationIntent = (accepted: boolean) => {
    if (publicationIntentSettled) return
    publicationIntentSettled = true
    onPublicationIntentSettled?.(accepted)
  }
  if (postProcessingTasks.has(downloadInfo.id)) {
    settlePublicationIntent(true)
    return
  }
  postProcessingTasks.add(downloadInfo.id)
  runingTask.set(downloadInfo.id, downloadInfo)
  try {
    waitingUpdateTasks.delete(downloadInfo.id)
    markDownloadPostProcessing(downloadInfo, window.i18n.t('download_status_write_queue', { num: 0 }))
    delete downloadInfo.metadata.postProcessingError
    try {
      await downloadTasksUpdate([toRaw(downloadInfo)])
    } catch (err) {
      await persistPostProcessingFailure(downloadInfo, err)
      settlePublicationIntent(false)
      return
    }
    settlePublicationIntent(true)

    const stagingPath = downloadInfo.metadata.stagingPath
    if (!stagingPath) throw new Error('Missing download publication staging path')
    const publication: LX.Download.DownloadPublication = {
      filePath: downloadInfo.metadata.filePath,
      fileName: downloadInfo.metadata.fileName,
      stagingPath,
      ext: downloadInfo.metadata.ext,
      quality: downloadInfo.metadata.quality,
      actualFormat: downloadInfo.metadata.actualFormat ?? { container: downloadInfo.metadata.ext, codec: downloadInfo.metadata.ext === 'wav' ? 'pcm' : downloadInfo.metadata.ext },
      downgrade: downloadInfo.metadata.formatDowngrade,
    }
    const lyricPublication = appSetting['download.isDownloadLrc']
      ? await window.lx.worker.download.getDownloadLyricPublication(publication.filePath)
      : undefined
    try {
      await finalizeDownloadPublication(publication, lyricPublication, {
        writeMetadata: async path => saveMeta(downloadInfo, path),
        writeLyric: async path => downloadLyric(downloadInfo, path),
        commit: async(value, sidecar) => window.lx.worker.download.commitDownloadedAudio(value, sidecar),
        discard: async(value, sidecar) => window.lx.worker.download.discardDownloadedAudio(value, sidecar),
      })
    } catch (err) {
      await persistPostProcessingFailure(downloadInfo, err, lyricPublication)
      return
    }

    const completedInfo = createCompletedDownloadPersistenceState(downloadInfo, window.i18n.t(
      getDownloadCompletedStatusKey(downloadInfo),
      { quality: downloadInfo.metadata.quality },
    ))
    try {
      waitingUpdateTasks.delete(downloadInfo.id)
      await downloadTasksUpdate([completedInfo])
    } catch (err) {
      await persistCommittedPublicationFailure(downloadInfo, err)
      return
    }

    Object.assign(downloadInfo, completedInfo)
    downloadInfo.metadata = completedInfo.metadata
    notifySongOrganizerDownloadOccupancyChanged()
  } catch (err) {
    await persistPostProcessingFailure(downloadInfo, err)
  } finally {
    settlePublicationIntent(false)
    postProcessingTasks.delete(downloadInfo.id)
    runingTask.delete(downloadInfo.id)
    void checkStartTask()
    try {
      await window.lx.worker.download.removeTask(downloadInfo.id)
    } catch (err) {
      console.error('Failed to release completed download worker task', err)
    }
  }
}

const getUrl = async(downloadInfo: LX.Download.ListItem, isRefresh: boolean = false) => {
  let toggleMusicInfo = downloadInfo.metadata.musicInfo.meta.toggleMusicInfo
  return (toggleMusicInfo ? getMusicUrl({
    musicInfo: toggleMusicInfo,
    isRefresh,
    quality: getDownloadRequestedQuality(downloadInfo),
    allowToggleSource: false,
  }) : Promise.reject(new Error('not found'))).catch(() => {
    return getMusicUrl({
      musicInfo: downloadInfo.metadata.musicInfo,
      isRefresh: false,
      quality: getDownloadRequestedQuality(downloadInfo),
      allowToggleSource: appSetting['download.isUseOtherSource'],
    })
  }).catch(() => '')
}
const handleRefreshUrl = (downloadInfo: LX.Download.ListItem) => {
  setStatusText(downloadInfo, window.i18n.t('download_status_error_refresh_url'))
  let toggleMusicInfo = downloadInfo.metadata.musicInfo.meta.toggleMusicInfo
  ;(toggleMusicInfo ? getMusicUrl({
    musicInfo: toggleMusicInfo,
    isRefresh: true,
    quality: getDownloadRequestedQuality(downloadInfo),
    allowToggleSource: false,
  }) : Promise.reject(new Error('not found'))).catch(() => {
    return getMusicUrl({
      musicInfo: downloadInfo.metadata.musicInfo,
      isRefresh: true,
      quality: getDownloadRequestedQuality(downloadInfo),
      allowToggleSource: appSetting['download.isUseOtherSource'],
    })
  })
    .catch(() => '')
    .then(url => {
    // commit('setStatusText', { downloadInfo, text: '链接刷新成功' })
      setUrl(downloadInfo, url)
      void window.lx.worker.download.updateUrl(downloadInfo.id, url)
    })
    .catch(err => {
      console.log(err)
      handleError(downloadInfo, err.message)
    })
}
const handleError = (downloadInfo: LX.Download.ListItem, message?: string) => {
  setStatus(downloadInfo, DOWNLOAD_STATUS.ERROR, message)
  void window.lx.worker.download.removeTask(downloadInfo.id)
  runingTask.delete(downloadInfo.id)
  void checkStartTask()
}

const handleStartTask = async(downloadInfo: LX.Download.ListItem) => {
  if (!downloadInfo.metadata.url) {
    setStatusText(downloadInfo, window.i18n.t('download_status_url_getting'))
    const url = await getUrl(downloadInfo)
    if (!url) {
      handleError(downloadInfo, window.i18n.t('download_status_error_url_failed'))
      return
    }
    setUrl(downloadInfo, url)
    if (downloadInfo.status != DOWNLOAD_STATUS.RUN) return
  }

  const savePath = downloadInfo.metadata.filePath
    ? dirname(downloadInfo.metadata.filePath)
    : buildSavePath(downloadInfo)
  if (!downloadInfo.metadata.filePath) {
    updateFilePath(downloadInfo, joinPath(savePath, downloadInfo.metadata.fileName))
  }

  setStatusText(downloadInfo, window.i18n.t('download_status_start'))

  await window.lx.worker.download.startTask(toRaw(downloadInfo), savePath, appSetting['download.skipExistFile'], proxyCallback(async(event: LX.Download.DownloadTaskActions) => {
    // console.log(event)
    switch (event.action) {
      case 'start':
        setStatus(downloadInfo, DOWNLOAD_STATUS.RUN)
        break
      case 'complete':
        applyDownloadPublication(downloadInfo, event.data)
        return await new Promise<boolean>(resolve => {
          void completeDownloadTask(downloadInfo, resolve).catch(err => {
            console.error('Unexpected download post-processing failure', err)
            resolve(false)
          })
        })
      case 'refreshUrl':
        handleRefreshUrl(downloadInfo)
        break
      case 'statusText':
        setStatusText(downloadInfo, event.data)
        break
      case 'progress':
        setProgress(downloadInfo, event.data)
        break
      case 'error':
        handleError(downloadInfo, event.data.error
          ? window.i18n.t(event.data.error) + (event.data.message ?? '')
          : event.data.message,
        )
        break
      default:
        break
    }
  }), getProxy(), proxyCallback(async filePath => {
    return await validateDownloadAudio({ taskId: downloadInfo.id, filePath })
  }) as unknown as (filePath: string) => Promise<LX.Download.DownloadAudioValidationResult>, createDownloadPreparationLifecycleProxy({
    beginTask: async() => beginDownloadAudioTask(downloadInfo.id),
    isTaskCancelled: async() => isDownloadAudioTaskCancelled(downloadInfo.id),
    finishTask: async options => {
      await finishDownloadAudioTask({ taskId: downloadInfo.id, options })
    },
  }))
}
const startTask = async(downloadInfo: LX.Download.ListItem) => {
  if (!reserveDownloadTaskStart(runingTask, downloadInfo)) return
  setStatus(downloadInfo, DOWNLOAD_STATUS.RUN)
  try {
    await resetDownloadAudioTask(downloadInfo.id)
  } catch (error) {
    handleError(downloadInfo, (error as Error).message)
    return
  }
  void handleStartTask(downloadInfo).catch(error => { handleError(downloadInfo, (error as Error).message) })
}

const getStartTask = (list: LX.Download.ListItem[]): LX.Download.ListItem | null => {
  let downloadCount = 0
  const waitList = list.filter(item => {
    if (item.status == DOWNLOAD_STATUS.WAITING) return true
    if (item.status == DOWNLOAD_STATUS.RUN) ++downloadCount
    return false
  })
  // console.log(downloadCount, waitList)
  return downloadCount < appSetting['download.maxDownloadNum'] ? waitList.shift() ?? null : null
}

const checkStartTask = async() => {
  while (runingTask.size < appSetting['download.maxDownloadNum']) {
    const postProcessingTask = queuedPostProcessingTasks.values().next().value
    if (postProcessingTask) {
      queuedPostProcessingTasks.delete(postProcessingTask.id)
      void completeDownloadTask(postProcessingTask).catch(err => {
        console.error('Unexpected queued download post-processing failure', err)
      })
      continue
    }
    const result = getStartTask(downloadList)
    if (!result) break
    await startTask(result)
  }
}

/**
 * 过滤重复任务
 * @param list
 */
/**
 * 创建下载任务
 * @param list 要下载的歌曲
 * @param quality 下载音质
 */
export const createDownloadTasks = async(list: LX.Music.MusicInfoOnline[], quality: LX.Quality, listId?: string) => {
  if (!list.length) return
  const filtered = deduplicateDownloadTargets(await window.lx.worker.download.createDownloadTasks(list, quality,
    {
      fileNameFormat: appSetting['download.fileName'],
      savePath: appSetting['download.savePath'],
      savePathMode: appSetting['download.savePathMode'],
      playlistName: getPlaylistName(listId),
      listId,
    },
    toRaw(qualityList.value)), downloadList,
  )
  const tasks = filtered.tasks
  for (const task of tasks) markRaw(task.metadata)

  if (tasks.length) await addTasks(tasks)
  void checkStartTask()

  const notices: string[] = []
  const fallbackReasonSet = new Set<LX.Download.DownloadTargetFallbackReason>()
  for (const task of tasks) {
    for (const reason of task.metadata.targetFallbacks ?? []) fallbackReasonSet.add(reason)
  }
  const fallbackReasons = [...fallbackReasonSet]
  if (fallbackReasons.length) {
    const reasons = fallbackReasons.map(reason => window.i18n.t(TARGET_FALLBACK_MESSAGE_KEYS[reason])).join('；')
    notices.push(window.i18n.t('download_target_fallback_tip', { reasons }))
  }
  if (filtered.duplicateTargetCount) {
    notices.push(window.i18n.t('download_target_duplicate_tip', { count: filtered.duplicateTargetCount }))
  }
  if (notices.length) void dialog(notices.join('\n'))
}

/**
 * 开始下载任务
 * @param list
 */
export const startDownloadTasks = async(list: LX.Download.ListItem[]) => {
  for (const downloadInfo of list) {
    if (isDownloadPostProcessing(downloadInfo)) continue
    await coordinateDownloadTaskRetry(downloadInfo, {
      reconcile: recoverDownloadPublicationTask,
      enqueuePostProcessing: task => { queuedPostProcessingTasks.set(task.id, task) },
      restartDownload: task => { setStatus(task, DOWNLOAD_STATUS.WAITING) },
    })
  }
  void checkStartTask()
}

/**
 * 暂停下载任务
 * @param list
 */
export const pauseDownloadTasks = async(list: LX.Download.ListItem[]) => {
  for (const downloadInfo of list) {
    if (isDownloadPostProcessingPending(downloadInfo)) continue
    switch (downloadInfo.status) {
      case DOWNLOAD_STATUS.RUN:
        await cancelDownloadAudioValidation(downloadInfo.id)
        await window.lx.worker.download.pauseTask(downloadInfo.id)
        runingTask.delete(downloadInfo.id)
      case DOWNLOAD_STATUS.WAITING:
      case DOWNLOAD_STATUS.ERROR:
        setStatus(downloadInfo, DOWNLOAD_STATUS.PAUSE)
      default:
        break
    }
  }
  void checkStartTask()
}

/**
 * 移除下载任务
 * @param ids 要移除的任务Id
 */
export const removeDownloadTasks = async(ids: string[]) => {
  const taskMap = new Map(downloadList.map(task => [task.id, task]))
  const candidates = ids.filter(id => {
    const task = taskMap.get(id)
    return task == null || !isDownloadPostProcessing(task)
  })
  const blockedIds = new Set<string>()
  for (const id of candidates) {
    const task = taskMap.get(id)
    if (!task) continue
    const removal = await coordinateDownloadTaskRemoval(task, {
      inspectPaths: async value => window.lx.worker.download.inspectDownloadPublicationPaths({
        stagingPath: value.metadata.stagingPath!,
        filePath: value.metadata.filePath,
      }),
      discard: async value => {
        const lyricPublication = await window.lx.worker.download.getDownloadLyricPublication(value.metadata.filePath)
        await window.lx.worker.download.discardDownloadedAudio({ stagingPath: value.metadata.stagingPath! }, lyricPublication)
      },
      persistBlocked: async value => {
        await downloadTasksUpdate([toRaw(value)]).catch(persistError => {
          console.error('Failed to persist blocked download removal', persistError)
        })
      },
    })
    if (removal == 'block') blockedIds.add(id)
  }
  const removableIds = candidates.filter(id => !blockedIds.has(id))
  if (!removableIds.length) return
  for (const id of removableIds) {
    const task = taskMap.get(id)
    if (!task || !runingTask.has(id)) continue
    await cancelDownloadAudioValidation(id)
    await window.lx.worker.download.removeTask(id)
    runingTask.delete(id)
  }
  await downloadTasksRemove(removableIds)
  notifySongOrganizerDownloadOccupancyChanged()

  const idsSet = new Set<string>(removableIds)
  const newList = downloadList.filter(task => {
    if (idsSet.has(task.id)) queuedPostProcessingTasks.delete(task.id)
    return !idsSet.has(task.id)
  })
  downloadList.splice(0, downloadList.length)
  arrPush(downloadList, newList)


  void checkStartTask()
  window.app_event.downloadListUpdate()
}
