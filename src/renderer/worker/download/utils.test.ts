import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDownloadInfo } from './utils'

const musicInfo: LX.Music.MusicInfo_kg = {
  id: '501_HASH',
  name: 'Track',
  singer: 'Track Artist',
  source: 'kg',
  interval: '03:00',
  meta: {
    songId: 501,
    albumId: 101,
    albumName: 'Album',
    albumArtist: 'Album Artist',
    releaseDate: '2024-01-02',
    trackNumber: 1,
    trackTotal: 10,
    hash: 'HASH',
    qualitys: [{ type: 'flac', size: '10 MB', hash: 'HASH_FLAC' }],
    _qualitys: { flac: { size: '10 MB', hash: 'HASH_FLAC' } },
  },
}

describe('download task target', () => {
  it('solidifies the final file name and path after resolving the actual quality', () => {
    const qualityList: LX.QualityList = { kg: ['128k', 'flac'] }
    const task = createDownloadInfo(musicInfo, 'flac', {
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'album',
      listId: 'list-1',
    }, qualityList)

    expect(task.metadata.requestedQuality).toBe('flac')
    expect(task.metadata.quality).toBe('flac')
    expect(task.metadata.fileName).toBe('01. Track Artist - Track.flac')
    expect(task.metadata.filePath).toBe(path.resolve(
      'D:\\Music',
      'Album Artist',
      '2024-01-02 Album',
      task.metadata.fileName,
    ))
    expect(task.metadata.targetFallbacks).toEqual([])
  })

  it('falls back each track to its highest available quality below the batch selection', () => {
    const qualityList: LX.QualityList = { kg: ['128k', '320k', 'flac', 'flac24bit'] }
    const highResolutionMusic: LX.Music.MusicInfo_kg = {
      ...musicInfo,
      id: '501_HASH_HIRES',
      meta: {
        ...musicInfo.meta,
        qualitys: [
          { type: 'flac', size: '10 MB', hash: 'HASH_FLAC' },
          { type: 'flac24bit', size: '20 MB', hash: 'HASH_HIRES' },
        ],
        _qualitys: {
          flac: { size: '10 MB', hash: 'HASH_FLAC' },
          flac24bit: { size: '20 MB', hash: 'HASH_HIRES' },
        },
      },
    }

    const highResolutionTask = createDownloadInfo(highResolutionMusic, 'flac24bit', {
      fileNameFormat: '歌名 - 歌手',
      savePath: 'D:\\Music',
      savePathMode: 'root',
    }, qualityList)
    const fallbackTask = createDownloadInfo(musicInfo, 'flac24bit', {
      fileNameFormat: '歌名 - 歌手',
      savePath: 'D:\\Music',
      savePathMode: 'root',
    }, qualityList)

    expect(highResolutionTask.metadata.requestedQuality).toBe('flac24bit')
    expect(highResolutionTask.metadata.quality).toBe('flac24bit')
    expect(fallbackTask.metadata.requestedQuality).toBe('flac')
    expect(fallbackTask.metadata.quality).toBe('flac')

    const sourceFallbackTask = createDownloadInfo(highResolutionMusic, 'flac24bit', {
      fileNameFormat: '歌名 - 歌手',
      savePath: 'D:\\Music',
      savePathMode: 'root',
    }, { kg: ['128k', 'flac'] })
    expect(sourceFallbackTask.metadata.requestedQuality).toBe('flac')
    expect(sourceFallbackTask.metadata.quality).toBe('flac')
  })
})
