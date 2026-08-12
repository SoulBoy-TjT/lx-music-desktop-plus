import { DOWNLOAD_STATUS } from '@common/constants'
import { buildLyrics } from './lrcTool'
import { atomicWriteFile } from '@common/utils/atomicFile'
import { resolveDownloadTarget } from '@common/utils/downloadTarget'
import { resolveDownloadQuality } from '@common/utils/downloadQuality'

/**
 * 保存歌词文件
 */
export const saveLrc = async(lrcData: LX.Music.LyricInfo, info: {
  filePath: string
  format: LX.LyricFormat
  downloadLxlrc: boolean
  downloadTlrc: boolean
  downloadRlrc: boolean
}) => {
  const iconv = (await import('iconv-lite')).default
  const lrc = buildLyrics(lrcData, info.downloadLxlrc, info.downloadTlrc, info.downloadRlrc)
  switch (info.format) {
    case 'gbk':
      await atomicWriteFile(info.filePath, iconv.encode(lrc, 'gbk', { addBOM: true }))
      break
    case 'utf8':
    default:
      await atomicWriteFile(info.filePath, iconv.encode(lrc, 'utf8', { addBOM: true }))
      break
  }
}

export const getExt = (type: string): LX.Download.FileExt => {
  switch (type) {
    case 'ape':
      return 'ape'
    case 'flac':
    case 'flac24bit':
      return 'flac'
    case 'wav':
      return 'wav'
    case '128k':
    case '192k':
    case '320k':
    default:
      return 'mp3'
  }
}

/**
 * 获取音乐音质
 * @param musicInfo
 * @param type
 * @param qualityList
 */
export const getMusicType = (musicInfo: LX.Music.MusicInfoOnline, type: LX.Quality, qualityList: LX.QualityList): LX.Quality => {
  return resolveDownloadQuality(musicInfo, type, qualityList[musicInfo.source]) ?? '128k'
}

// const checkExistList = (list: LX.Download.ListItem[], musicInfo: LX.Music.MusicInfo, type: LX.Quality, ext: string): boolean => {
//   return list.some(s => s.id === musicInfo.id && (s.metadata.type === type || s.metadata.ext === ext))
// }

export const createDownloadInfo = (
  musicInfo: LX.Music.MusicInfoOnline,
  type: LX.Quality,
  options: LX.Download.CreateTaskOptions,
  qualityList: LX.QualityList,
) => {
  type = getMusicType(musicInfo, type, qualityList)
  let ext = getExt(type)
  const key = `${musicInfo.id}_${type}_${ext}`
  const target = resolveDownloadTarget({
    musicInfo,
    ext,
    fileNameFormat: options.fileNameFormat,
    savePath: options.savePath,
    savePathMode: options.savePathMode,
    playlistName: options.playlistName,
  })
  // if (checkExistList(list, musicInfo, type, ext)) return null
  const downloadInfo: LX.Download.ListItem = {
    id: key,
    isComplate: false,
    status: DOWNLOAD_STATUS.WAITING,
    statusText: '待下载',
    downloaded: 0,
    total: 0,
    progress: 0,
    speed: '',
    writeQueue: 0,
    metadata: {
      musicInfo,
      url: null,
      requestedQuality: type,
      quality: type,
      ext,
      filePath: target.filePath,
      listId: options.listId,
      fileName: target.fileName,
      targetFallbacks: target.fallbackReasons,
    },
  }
  // downloadInfo.metadata.filePath = joinPath(savePath, downloadInfo.metadata.fileName)
  // commit('addTask', downloadInfo)

  // 删除同路径下的同名文件
  // TODO
  // void removeFile(downloadInfo.metadata.filePath)
  // .catch(err => {
  //   if (err.code !== 'ENOENT') {
  //     return commit('setStatusText', { downloadInfo, text: '文件删除失败' })
  //   }
  // })

  return downloadInfo
}
