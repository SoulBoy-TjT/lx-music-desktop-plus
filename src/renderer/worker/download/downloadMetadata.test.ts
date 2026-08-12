import {
  buildDownloadMetadata,
  buildDownloadMetadataWritePlan,
  getDownloadMetadataCapability,
} from '@renderer/store/download/downloadMetadata'
import { describe, expect, it, vi } from 'vitest'

const createTask = (overrides: Partial<LX.Music.MusicInfoOnline> = {}): LX.Download.ListItem => {
  const musicInfo: LX.Music.MusicInfoOnline = {
    id: 'wy_song',
    name: '歌曲',
    singer: '歌手',
    source: 'wy',
    interval: null,
    meta: {
      songId: 'song',
      albumName: '专辑',
      picUrl: '',
      qualitys: [],
      _qualitys: {},
    },
  }
  Object.assign(musicInfo, overrides)
  return {
    id: 'download-metadata-task',
    isComplate: true,
    status: 'run',
    statusText: 'post-processing',
    downloaded: 100,
    total: 100,
    progress: 100,
    speed: '',
    writeQueue: 0,
    metadata: {
      musicInfo,
      url: 'https://example.test/audio.mp3',
      requestedQuality: 'flac',
      quality: '320k',
      ext: 'mp3',
      fileName: '歌曲.mp3',
      filePath: 'C:\\Music\\歌曲.mp3',
    },
  }
}

describe('download metadata publication input', () => {
  it.each(['wav', 'ape'] as const)('keeps %s publishable when cover embedding is enabled but unsupported', ext => {
    expect(getDownloadMetadataCapability(ext, true, 'download-metadata-task', `C:\\Music\\歌曲.${ext}`)).toEqual({
      supportsMetadata: false,
      embedPicture: false,
      warning: expect.objectContaining({
        phase: 'cover',
        code: 'cover_writer_unsupported',
        taskId: 'download-metadata-task',
        filePath: `C:\\Music\\歌曲.${ext}`,
      }),
    })
  })

  it.each(['wav', 'ape'] as const)('short-circuits required tag validation for a valid %s publication', async ext => {
    const task = createTask({ name: '', singer: '', meta: { songId: 'song', albumName: '', picUrl: '', qualitys: [], _qualitys: {} } })
    task.metadata.ext = ext
    task.metadata.filePath = `C:\\Music\\歌曲.${ext}`
    const resolveCoverUrl = vi.fn(async() => { throw new Error('must not fetch') })

    await expect(buildDownloadMetadataWritePlan(task, {
      embedPicture: true,
      resolveCoverUrl,
    })).resolves.toMatchObject({
      metadata: null,
      warning: { code: 'cover_writer_unsupported' },
    })
    expect(resolveCoverUrl).not.toHaveBeenCalled()
  })
  it.each([
    ['title', { name: ' ' }, 'missing_title'],
    ['artist', { singer: '' }, 'missing_artist'],
    ['album', { meta: { songId: 'song', albumName: '', picUrl: '', qualitys: [], _qualitys: {} } }, 'missing_album'],
  ])('rejects an empty required %s with task and path context', async(_field, override, code) => {
    await expect(buildDownloadMetadata(createTask(override as Partial<LX.Music.MusicInfoOnline>), {
      embedPicture: false,
      resolveCoverUrl: async() => null,
    })).rejects.toMatchObject({
      detail: {
        phase: 'metadata',
        code,
        taskId: 'download-metadata-task',
        filePath: 'C:\\Music\\歌曲.mp3',
      },
    })
  })

  it('rejects provider cover failure instead of silently writing tags without a cover', async() => {
    const resolveCoverUrl = vi.fn(async() => { throw new Error('provider timeout') })
    await expect(buildDownloadMetadata(createTask(), {
      embedPicture: true,
      resolveCoverUrl,
    })).rejects.toMatchObject({
      detail: {
        phase: 'cover',
        code: 'cover_fetch_failed',
        taskId: 'download-metadata-task',
      },
    })
  })

  it('returns complete required tags and a non-empty cover URL', async() => {
    await expect(buildDownloadMetadata(createTask(), {
      embedPicture: true,
      resolveCoverUrl: async() => 'https://example.test/cover.jpg',
    })).resolves.toMatchObject({
      title: '歌曲',
      artist: '歌手',
      album: '专辑',
      APIC: 'https://example.test/cover.jpg',
    })
  })
})
