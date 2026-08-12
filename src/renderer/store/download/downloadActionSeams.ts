import { DOWNLOAD_STATUS } from '@common/constants'
import {
  getDownloadStartupAction,
  isDownloadPostProcessingPending,
  markDownloadPostProcessingFailed,
} from './postProcessState'
import {
  resolveDownloadPublicationRemoval,
  type DownloadPublicationRecoveryAction,
} from './publicationRecovery'
import { proxyObject } from '@renderer/worker/utils'
import type { ProxyMarked } from 'comlink'

export interface DownloadPreparationLifecycle {
  beginTask: () => Promise<LX.Download.DownloadAudioLifecycleResult>
  isTaskCancelled: () => Promise<boolean>
  finishTask: (options: LX.Download.DownloadAudioTaskFinishOptions) => Promise<void>
}

export const createDownloadPreparationLifecycleProxy = (
  lifecycle: DownloadPreparationLifecycle,
): DownloadPreparationLifecycle & ProxyMarked => proxyObject(lifecycle)

interface DownloadTaskRetryIo {
  reconcile: (task: LX.Download.ListItem) => Promise<DownloadPublicationRecoveryAction>
  enqueuePostProcessing: (task: LX.Download.ListItem) => void | Promise<void>
  restartDownload: (task: LX.Download.ListItem) => void | Promise<void>
}

export const coordinateDownloadTaskRetry = async(
  task: LX.Download.ListItem,
  io: DownloadTaskRetryIo,
): Promise<'completed' | 'queued' | 'restarted' | 'blocked'> => {
  if (isDownloadPostProcessingPending(task) && getDownloadStartupAction(task) == 'keep') return 'blocked'
  if (task.metadata.stagingPath) {
    switch (await io.reconcile(task)) {
      case 'complete_final': return 'completed'
      case 'resume_stage':
        await io.enqueuePostProcessing(task)
        return 'queued'
      case 'reset_download':
        await io.restartDownload(task)
        return 'restarted'
      case 'blocked_conflict': return 'blocked'
      default: break
    }
  }
  if (task.status == DOWNLOAD_STATUS.COMPLETED) return 'completed'
  if (isDownloadPostProcessingPending(task)) {
    if (getDownloadStartupAction(task) == 'keep') return 'blocked'
    await io.enqueuePostProcessing(task)
    return 'queued'
  }
  await io.restartDownload(task)
  return 'restarted'
}

interface DownloadTaskRemovalIo {
  inspectPaths: (task: LX.Download.ListItem) => Promise<{ stagingExists: boolean, finalExists: boolean }>
  discard: (task: LX.Download.ListItem) => Promise<void>
  persistBlocked: (task: LX.Download.ListItem) => Promise<void>
}

export const coordinateDownloadTaskRemoval = async(
  task: LX.Download.ListItem,
  io: DownloadTaskRemovalIo,
): Promise<'remove' | 'block'> => {
  const stagingPath = task.metadata.stagingPath
  if (!stagingPath) return 'remove'
  try {
    const removal = resolveDownloadPublicationRemoval(await io.inspectPaths(task))
    if (removal == 'block') return 'block'
    if (removal == 'discard_stage') await io.discard(task)
    return 'remove'
  } catch (error) {
    task.metadata.postProcessingError = {
      phase: 'publication',
      code: 'staging_cleanup_failed',
      message: `删除下载任务前清理暂存文件失败：${(error as Error).message}`,
      taskId: task.id,
      filePath: stagingPath,
    }
    markDownloadPostProcessingFailed(task, task.metadata.postProcessingError.message)
    await io.persistBlocked(task)
    return 'block'
  }
}

export const reserveDownloadTaskStart = (
  runningTasks: Map<string, LX.Download.ListItem>,
  task: LX.Download.ListItem,
): boolean => {
  if (runningTasks.has(task.id)) return false
  runningTasks.set(task.id, task)
  return true
}
