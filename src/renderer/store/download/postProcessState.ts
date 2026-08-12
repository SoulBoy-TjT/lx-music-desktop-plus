import { DOWNLOAD_STATUS } from '@common/constants'

export type DownloadStartupAction = 'resume_post_processing' | 'pause' | 'keep'
export type DownloadCompletedStatusKey = 'download___status_completed' | 'download___status_completed_downgraded_mp3' | 'download___status_completed_downgraded_quality'
export type DownloadPostProcessState = Pick<
LX.Download.ListItem,
'status' | 'isComplate' | 'progress' | 'speed' | 'writeQueue' | 'statusText'
>

export const isDownloadPostProcessing = (task: Pick<LX.Download.ListItem, 'status' | 'isComplate'>): boolean => {
  return task.status === DOWNLOAD_STATUS.RUN && task.isComplate
}

export const isDownloadPostProcessingFailed = (task: Pick<LX.Download.ListItem, 'status' | 'isComplate'>): boolean => {
  return task.status === DOWNLOAD_STATUS.ERROR && task.isComplate
}

export const isDownloadPostProcessingPending = (task: Pick<LX.Download.ListItem, 'status' | 'isComplate'>): boolean => {
  return task.isComplate && task.status !== DOWNLOAD_STATUS.COMPLETED
}

const BLOCKING_PUBLICATION_ERROR_CODES = new Set([
  'stage_final_conflict',
  'final_verification_failed',
  'publication_recovery_failed',
  'staging_cleanup_failed',
])

export const getDownloadStartupAction = (task: Pick<LX.Download.ListItem, 'status' | 'isComplate'> & {
  metadata?: Pick<LX.Download.ListItem['metadata'], 'postProcessingError'>
}): DownloadStartupAction => {
  if (task.metadata?.postProcessingError && BLOCKING_PUBLICATION_ERROR_CODES.has(task.metadata.postProcessingError.code)) return 'keep'
  if (isDownloadPostProcessingPending(task)) return 'resume_post_processing'
  if (task.status === DOWNLOAD_STATUS.RUN || task.status === DOWNLOAD_STATUS.WAITING) return 'pause'
  return 'keep'
}

export const applyDownloadPublication = (task: Pick<LX.Download.ListItem, 'metadata'>, publication: LX.Download.DownloadPublication): void => {
  Object.assign(task.metadata, {
    filePath: publication.filePath,
    fileName: publication.fileName,
    stagingPath: publication.stagingPath,
    ext: publication.ext,
    quality: publication.quality,
    actualFormat: publication.actualFormat,
    formatDowngrade: publication.downgrade,
  })
}

export const getDownloadCompletedStatusKey = (task: Pick<LX.Download.ListItem, 'metadata'>): DownloadCompletedStatusKey => {
  switch (task.metadata.formatDowngrade?.reason) {
    case 'lossless_unavailable': return 'download___status_completed_downgraded_mp3'
    case 'quality_downgrade': return 'download___status_completed_downgraded_quality'
    default: return 'download___status_completed'
  }
}

export const markDownloadPostProcessing = (task: DownloadPostProcessState, statusText: string): void => {
  task.isComplate = true
  task.status = DOWNLOAD_STATUS.RUN
  task.statusText = statusText
  task.progress = 100
  task.speed = ''
  task.writeQueue = 0
}

export const markDownloadCompleted = (task: DownloadPostProcessState, statusText: string): void => {
  task.isComplate = true
  task.status = DOWNLOAD_STATUS.COMPLETED
  task.statusText = statusText
  task.progress = 100
  task.speed = ''
  task.writeQueue = 0
}

export const markDownloadPostProcessingFailed = (task: DownloadPostProcessState, statusText: string): void => {
  task.isComplate = true
  task.status = DOWNLOAD_STATUS.ERROR
  task.statusText = statusText
  task.progress = 100
  task.speed = ''
  task.writeQueue = 0
}
