export class DownloadPostProcessingError extends Error {
  constructor(readonly detail: LX.Download.DownloadPostProcessingError) {
    super(detail.message)
    this.name = 'DownloadPostProcessingError'
  }
}

export const getDownloadMetadataCapability = (
  ext: LX.Download.FileExt,
  embedPicture: boolean,
  taskId: string,
  filePath: string,
): {
  supportsMetadata: boolean
  embedPicture: boolean
  warning?: LX.Download.DownloadPostProcessingError
} => {
  const supportsMetadata = ext === 'mp3' || ext === 'flac'
  if (supportsMetadata || !embedPicture) return { supportsMetadata, embedPicture: embedPicture && supportsMetadata }
  return {
    supportsMetadata,
    embedPicture: false,
    warning: {
      phase: 'cover',
      code: 'cover_writer_unsupported',
      message: `下载任务 ${taskId} 的 ${ext.toUpperCase()} 格式不支持封面写入，音频将保持原格式发布：${filePath}`,
      taskId,
      filePath,
    },
  }
}

const fail = (
  task: Pick<LX.Download.ListItem, 'id' | 'metadata'>,
  phase: LX.Download.DownloadPostProcessingError['phase'],
  code: string,
  message: string,
  cause?: unknown,
): never => {
  const error = new DownloadPostProcessingError({
    phase,
    code,
    message,
    taskId: task.id,
    filePath: task.metadata.filePath,
  })
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause })
  throw error
}

export const buildDownloadMetadata = async(
  task: Pick<LX.Download.ListItem, 'id' | 'metadata'>,
  options: {
    embedPicture: boolean
    resolveCoverUrl: () => Promise<string | null>
  },
): Promise<{ title: string, artist: string, album: string, APIC: string | null }> => {
  const title = task.metadata.musicInfo.name?.trim()
  const artist = task.metadata.musicInfo.singer?.trim().replaceAll('、', ';')
  const album = task.metadata.musicInfo.meta.albumName?.trim()
  if (!title) fail(task, 'metadata', 'missing_title', `下载任务 ${task.id} 缺少歌曲标题：${task.metadata.filePath}`)
  if (!artist) fail(task, 'metadata', 'missing_artist', `下载任务 ${task.id} 缺少歌手：${task.metadata.filePath}`)
  if (!album) fail(task, 'metadata', 'missing_album', `下载任务 ${task.id} 缺少专辑：${task.metadata.filePath}`)
  if (!options.embedPicture) return { title, artist, album, APIC: null }

  let coverUrl = task.metadata.musicInfo.meta.picUrl?.trim() ?? ''
  if (!coverUrl) {
    try {
      coverUrl = (await options.resolveCoverUrl())?.trim() ?? ''
    } catch (error) {
      fail(task, 'cover', 'cover_fetch_failed', `下载任务 ${task.id} 获取封面失败：${(error as Error).message}`, error)
    }
  }
  if (!coverUrl) fail(task, 'cover', 'cover_missing', `下载任务 ${task.id} 未获取到可写入的封面：${task.metadata.filePath}`)
  if (!/^https?:\/\//iu.test(coverUrl)) fail(task, 'cover', 'cover_invalid_url', `下载任务 ${task.id} 的封面地址无效：${coverUrl}`)
  return { title, artist, album, APIC: coverUrl }
}

export const buildDownloadMetadataWritePlan = async(
  task: Pick<LX.Download.ListItem, 'id' | 'metadata'>,
  options: {
    embedPicture: boolean
    resolveCoverUrl: () => Promise<string | null>
  },
): Promise<{
  metadata: Awaited<ReturnType<typeof buildDownloadMetadata>> | null
  warning?: LX.Download.DownloadPostProcessingError
}> => {
  const capability = getDownloadMetadataCapability(
    task.metadata.ext,
    options.embedPicture,
    task.id,
    task.metadata.filePath,
  )
  if (!capability.supportsMetadata) return { metadata: null, warning: capability.warning }
  return {
    metadata: await buildDownloadMetadata(task, {
      embedPicture: capability.embedPicture,
      resolveCoverUrl: options.resolveCoverUrl,
    }),
  }
}

export const serializeDownloadPostProcessingError = (
  task: Pick<LX.Download.ListItem, 'id' | 'metadata'>,
  error: unknown,
  fallbackPhase: LX.Download.DownloadPostProcessingError['phase'] = 'publication',
): LX.Download.DownloadPostProcessingError => {
  if (error instanceof DownloadPostProcessingError) return error.detail
  return {
    phase: fallbackPhase,
    code: 'unexpected_failure',
    message: (error as Error).message || String(error),
    taskId: task.id,
    filePath: task.metadata.filePath,
  }
}
