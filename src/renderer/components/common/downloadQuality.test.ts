import { describe, expect, it } from 'vitest'
import { getBatchDownloadQualityState } from './downloadQuality'

const createTrack = (qualitys: LX.Quality[]): LX.Music.MusicInfoOnline => ({
  id: 'kg_song_hash',
  name: 'Song',
  singer: 'Artist',
  source: 'kg',
  interval: null,
  meta: {
    songId: 'song',
    albumId: 'album',
    albumName: 'Album',
    hash: 'hash',
    qualitys: qualitys.map(type => ({ type, size: null, hash: `${type}_hash` })),
    _qualitys: Object.fromEntries(qualitys.map(type => [type, { size: null, hash: `${type}_hash` }])),
  },
})

describe('getBatchDownloadQualityState', () => {
  it('全部歌曲都支持目标音质时无需降级提示', () => {
    expect(getBatchDownloadQualityState(
      [createTrack(['128k', 'flac']), createTrack(['128k', 'flac'])],
      'flac',
      { kg: ['128k', 'flac'] },
    )).toEqual({ available: true, reason: null })
  })

  it('区分音源不可用与歌曲没有任何共同音质', () => {
    expect(getBatchDownloadQualityState(
      [createTrack(['128k'])],
      'flac',
      {},
    ).reason).toBe('source_unsupported')

    expect(getBatchDownloadQualityState(
      [createTrack(['128k'])],
      'flac',
      { kg: ['flac'] },
    ).reason).toBe('track_unsupported')
  })

  it('部分歌曲缺少目标音质时仍允许选择并提示自动降级', () => {
    expect(getBatchDownloadQualityState(
      [createTrack(['128k', 'flac', 'flac24bit']), createTrack(['128k', 'flac'])],
      'flac24bit',
      { kg: ['128k', 'flac', 'flac24bit'] },
    )).toEqual({ available: true, reason: 'track_fallback' })
  })

  it('音源没有目标音质但支持较低音质时仍允许选择并提示自动降级', () => {
    expect(getBatchDownloadQualityState(
      [createTrack(['128k', 'flac'])],
      'flac24bit',
      { kg: ['128k', 'flac'] },
    )).toEqual({ available: true, reason: 'track_fallback' })
  })

  it('没有在线歌曲时禁用下载', () => {
    const localTrack: LX.Music.MusicInfoLocal = {
      id: 'local_song',
      name: 'Local song',
      singer: 'Artist',
      source: 'local',
      interval: null,
      meta: {
        songId: 'C:\\Music\\song.mp3',
        albumName: 'Album',
        filePath: 'C:\\Music\\song.mp3',
        ext: 'mp3',
      },
    }
    expect(getBatchDownloadQualityState([localTrack], '128k', { kg: ['128k'] }))
      .toEqual({ available: false, reason: 'no_online_tracks' })
  })
})
