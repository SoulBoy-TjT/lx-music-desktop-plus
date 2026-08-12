import { type Message } from '@root/lang'

// interface DownloadList {

// }


declare global {
  namespace LX {
    namespace Download {
      type DownloadTaskStatus = 'run'
      | 'waiting'
      | 'pause'
      | 'error'
      | 'completed'

      type FileExt = 'mp3' | 'flac' | 'wav' | 'ape'

      interface ProgressInfo {
        progress: number
        speed: string
        downloaded: number
        total: number
        writeQueue: number
      }

      interface DownloadTaskActionBase <A> {
        action: A
      }
      interface DownloadTaskActionData<A, D> extends DownloadTaskActionBase<A> {
        data: D
      }
      type DownloadTaskAction<A, D = undefined> = D extends undefined ? DownloadTaskActionBase<A> : DownloadTaskActionData<A, D>

      interface DownloadActualFormat {
        container: FileExt
        codec: 'mp3' | 'flac' | 'pcm' | 'ape'
        bitrate?: number
        bitrateMode?: 'cbr' | 'vbr'
        bitsPerSample?: number
      }

      interface DownloadFormatDowngrade {
        reason: 'lossless_unavailable' | 'quality_downgrade'
        requestedQuality: LX.Quality
        actualQuality: LX.Quality
      }

      interface DownloadPublication {
        filePath: string
        fileName: string
        stagingPath: string
        ext: FileExt
        quality: LX.Quality
        actualFormat: DownloadActualFormat
        downgrade?: DownloadFormatDowngrade
      }

      interface DownloadPublicationSidecar {
        filePath: string
        stagingPath: string
      }

      interface DownloadAudioValidationParams {
        taskId: string
        filePath: string
        allowNormalization?: boolean
      }

      interface DownloadAudioTaskFinishParams {
        taskId: string
        options: DownloadAudioTaskFinishOptions
      }

      type DownloadAudioSourceDisposition = 'preserve' | 'discard'

      interface DownloadAudioTaskFinishOptions {
        sourceDisposition: DownloadAudioSourceDisposition
        artifactPathsToDiscard?: string[]
      }

      interface DownloadAudioValidationResult {
        status: 'valid' | 'cancelled'
        normalizedPath?: string
      }

      interface DownloadAudioLifecycleResult {
        status: 'active' | 'cancelled'
      }

      interface DownloadPostProcessingError {
        phase: 'metadata' | 'cover' | 'publication' | 'persistence'
        code: string
        message: string
        taskId: string
        filePath: string
      }

      type DownloadTaskActions = DownloadTaskAction<'start'>
      | DownloadTaskAction<'complete', DownloadPublication>
      | DownloadTaskAction<'refreshUrl'>
      | DownloadTaskAction<'statusText', string>
      | DownloadTaskAction<'progress', ProgressInfo>
      | DownloadTaskAction<'error', {
        error?: keyof Message
        message?: string
      }>

      interface ListItem {
        id: string
        isComplate: boolean
        status: DownloadTaskStatus
        statusText: string
        downloaded: number
        total: number
        progress: number
        speed: string
        writeQueue: number
        metadata: {
          musicInfo: LX.Music.MusicInfoOnline
          url: string | null
          requestedQuality?: LX.Quality
          quality: LX.Quality
          ext: FileExt
          fileName: string
          filePath: string
          stagingPath?: string
          actualFormat?: DownloadActualFormat
          formatDowngrade?: DownloadFormatDowngrade
          postProcessingError?: DownloadPostProcessingError
          postProcessingWarning?: DownloadPostProcessingError
          targetFallbacks?: DownloadTargetFallbackReason[]
          listId?: string
        }
      }

      type DownloadTargetFallbackReason = 'missing_track_number'
      | 'missing_track_artist'
      | 'missing_album_artist'
      | 'missing_release_date'
      | 'invalid_release_date'
      | 'missing_album_name'
      | 'missing_playlist_name'
      | 'path_truncated'

      interface CreateTaskOptions {
        fileNameFormat: LX.DownloadFileNameFormat
        savePath: string
        savePathMode: LX.DownloadSavePathMode
        playlistName?: string
        listId?: string
      }

      interface saveDownloadMusicInfo {
        list: ListItem[]
        addMusicLocationType: LX.AddMusicLocationType
      }
    }
  }
}
