import { DOWNLOAD_STATUS } from '@common/constants'
import { getDownloadRequestedQuality } from '@common/utils/downloadTask'
import { markDownloadCompleted, markDownloadPostProcessingFailed } from './postProcessState'

export type DownloadPublicationRecoveryAction =
  | 'resume_stage'
  | 'complete_final'
  | 'blocked_conflict'
  | 'reset_download'
  | 'none'

export const resolveDownloadPublicationRemoval = (paths: {
  stagingExists: boolean
  finalExists: boolean
}): 'discard_stage' | 'remove' | 'block' => {
  if (paths.finalExists) return 'block'
  return paths.stagingExists ? 'discard_stage' : 'remove'
}

interface DownloadPublicationRecoveryIo {
  inspectPaths: (task: LX.Download.ListItem) => Promise<{
    stagingExists: boolean
    finalExists: boolean
  }>
  verifyFinal: (task: LX.Download.ListItem) => Promise<void>
  completedStatusText: string
  retryStatusText: string
}

const qualityToExt = (quality: LX.Quality): LX.Download.FileExt => {
  switch (quality) {
    case 'flac':
    case 'flac24bit': return 'flac'
    case 'wav': return 'wav'
    case 'ape': return 'ape'
    default: return 'mp3'
  }
}

const replaceExtension = (filePath: string, ext: LX.Download.FileExt): string => {
  const separatorIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const extensionIndex = filePath.lastIndexOf('.')
  return `${extensionIndex > separatorIndex ? filePath.slice(0, extensionIndex) : filePath}.${ext}`
}

const setRecoveryError = (
  task: LX.Download.ListItem,
  code: string,
  message: string,
  filePath: string,
): void => {
  task.metadata.postProcessingError = {
    phase: 'publication',
    code,
    message,
    taskId: task.id,
    filePath,
  }
  markDownloadPostProcessingFailed(task, message)
}

export const createCompletedDownloadPersistenceState = (
  task: LX.Download.ListItem,
  statusText: string,
): LX.Download.ListItem => {
  const completed: LX.Download.ListItem = {
    ...task,
    metadata: { ...task.metadata },
  }
  delete completed.metadata.stagingPath
  delete completed.metadata.postProcessingError
  markDownloadCompleted(completed, statusText)
  return completed
}

export const markCommittedPublicationPersistenceFailure = (
  task: LX.Download.ListItem,
  error: unknown,
): void => {
  const persistedError: LX.Download.DownloadPostProcessingError = {
    phase: 'persistence',
    code: 'completed_state_persist_failed',
    message: `音频已发布，但完成状态保存失败：${(error as Error).message}`,
    taskId: task.id,
    filePath: task.metadata.filePath,
  }
  task.metadata.postProcessingError = persistedError
  markDownloadPostProcessingFailed(task, persistedError.message)
}

export const reconcileDownloadPublication = async(
  task: LX.Download.ListItem,
  io: DownloadPublicationRecoveryIo,
): Promise<DownloadPublicationRecoveryAction> => {
  const stagingPath = task.metadata.stagingPath
  if (!stagingPath) return 'none'
  const { stagingExists, finalExists } = await io.inspectPaths(task)

  if (stagingExists && !finalExists) return 'resume_stage'
  if (stagingExists && finalExists) {
    setRecoveryError(
      task,
      'stage_final_conflict',
      `下载发布冲突：暂存文件与最终文件同时存在（${stagingPath}；${task.metadata.filePath}）。`,
      stagingPath,
    )
    return 'blocked_conflict'
  }
  if (finalExists) {
    try {
      await io.verifyFinal(task)
    } catch (error) {
      setRecoveryError(
        task,
        'final_verification_failed',
        `已发布文件重新验证失败：${(error as Error).message}`,
        task.metadata.filePath,
      )
      return 'blocked_conflict'
    }
    const completed = createCompletedDownloadPersistenceState(task, io.completedStatusText)
    Object.assign(task, completed)
    task.metadata = completed.metadata
    return 'complete_final'
  }

  const requestedQuality = getDownloadRequestedQuality(task)
  const ext = qualityToExt(requestedQuality)
  task.isComplate = false
  task.status = DOWNLOAD_STATUS.PAUSE
  task.statusText = io.retryStatusText
  task.downloaded = 0
  task.total = 0
  task.progress = 0
  task.speed = ''
  task.writeQueue = 0
  task.metadata.quality = requestedQuality
  task.metadata.ext = ext
  task.metadata.fileName = replaceExtension(task.metadata.fileName, ext)
  task.metadata.filePath = replaceExtension(task.metadata.filePath, ext)
  delete task.metadata.stagingPath
  delete task.metadata.actualFormat
  delete task.metadata.formatDowngrade
  delete task.metadata.postProcessingError
  return 'reset_download'
}
