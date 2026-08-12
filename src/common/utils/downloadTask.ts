import { DOWNLOAD_STATUS } from '@common/constants'

export const isDownloadCompleted = (task: Pick<LX.Download.ListItem, 'status' | 'isComplate'>): boolean => {
  return task.status === DOWNLOAD_STATUS.COMPLETED && task.isComplate
}

export const getDownloadRequestedQuality = (task: {
  metadata: Pick<LX.Download.ListItem['metadata'], 'requestedQuality' | 'formatDowngrade' | 'quality'>
}): LX.Quality => {
  return task.metadata.requestedQuality ?? task.metadata.formatDowngrade?.requestedQuality ?? task.metadata.quality
}

export interface DownloadMusicInfoMetadata {
  requestedQuality?: LX.Quality
  targetFallbacks?: LX.Download.DownloadTargetFallbackReason[]
  actualFormat?: LX.Download.DownloadActualFormat
  formatDowngrade?: LX.Download.DownloadFormatDowngrade
  postProcessingError?: LX.Download.DownloadPostProcessingError
  postProcessingWarning?: LX.Download.DownloadPostProcessingError
  stagingPath?: string
}

interface PersistedDownloadFields {
  __downloadRequestedQuality?: LX.Quality
  __downloadTargetFallbacks?: LX.Download.DownloadTargetFallbackReason[]
  __downloadActualFormat?: LX.Download.DownloadActualFormat
  __downloadFormatDowngrade?: LX.Download.DownloadFormatDowngrade
  __downloadPostProcessingError?: LX.Download.DownloadPostProcessingError
  __downloadPostProcessingWarning?: LX.Download.DownloadPostProcessingError
  __downloadStagingPath?: string
}

type PersistedDownloadMusicInfo<T extends LX.Music.MusicInfoOnline> = T & {
  meta: T['meta'] & PersistedDownloadFields
}

export const encodeDownloadMusicInfoMetadata = <T extends LX.Music.MusicInfoOnline>(
  musicInfo: T,
  metadata: DownloadMusicInfoMetadata,
): PersistedDownloadMusicInfo<T> => {
  const encoded: PersistedDownloadMusicInfo<T> = {
    ...musicInfo,
    meta: {
      ...musicInfo.meta,
      __downloadRequestedQuality: metadata.requestedQuality,
      __downloadTargetFallbacks: metadata.targetFallbacks,
      __downloadActualFormat: metadata.actualFormat,
      __downloadFormatDowngrade: metadata.formatDowngrade,
      __downloadPostProcessingError: metadata.postProcessingError,
      __downloadPostProcessingWarning: metadata.postProcessingWarning,
      __downloadStagingPath: metadata.stagingPath,
    },
  }
  return encoded
}

export const decodeDownloadMusicInfoMetadata = <T extends LX.Music.MusicInfoOnline>(persisted: T): DownloadMusicInfoMetadata & {
  musicInfo: T
} => {
  const musicInfo: PersistedDownloadMusicInfo<T> = {
    ...persisted,
    meta: { ...persisted.meta },
  }
  const requestedQuality = musicInfo.meta.__downloadRequestedQuality
  const targetFallbacks = musicInfo.meta.__downloadTargetFallbacks
  const actualFormat = musicInfo.meta.__downloadActualFormat
  const formatDowngrade = musicInfo.meta.__downloadFormatDowngrade
  const postProcessingError = musicInfo.meta.__downloadPostProcessingError
  const postProcessingWarning = musicInfo.meta.__downloadPostProcessingWarning
  const stagingPath = musicInfo.meta.__downloadStagingPath
  delete musicInfo.meta.__downloadRequestedQuality
  delete musicInfo.meta.__downloadTargetFallbacks
  delete musicInfo.meta.__downloadActualFormat
  delete musicInfo.meta.__downloadFormatDowngrade
  delete musicInfo.meta.__downloadPostProcessingError
  delete musicInfo.meta.__downloadPostProcessingWarning
  delete musicInfo.meta.__downloadStagingPath
  return {
    musicInfo,
    requestedQuality,
    targetFallbacks,
    actualFormat,
    formatDowngrade,
    postProcessingError,
    postProcessingWarning,
    stagingPath,
  }
}
