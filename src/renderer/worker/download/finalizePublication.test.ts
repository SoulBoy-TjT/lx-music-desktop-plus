import { describe, expect, it, vi } from 'vitest'
import { finalizeDownloadPublication } from '@renderer/store/download/finalizePublication'
import { buildDownloadMetadataWritePlan } from '@renderer/store/download/downloadMetadata'

const publication = {
  filePath: 'C:\\Music\\song.mp3',
  fileName: 'song.mp3',
  stagingPath: 'C:\\Music\\song.lx-publishing.mp3',
  ext: 'mp3',
  quality: '192k',
  actualFormat: { container: 'mp3', codec: 'mp3', bitrate: 160_000 },
  downgrade: {
    reason: 'lossless_unavailable',
    requestedQuality: 'flac',
    actualQuality: '192k',
  },
} satisfies LX.Download.DownloadPublication
const lyricPublication = {
  filePath: 'C:\\Music\\song.lrc',
  stagingPath: 'C:\\Music\\song.lx-publishing.lrc',
} satisfies LX.Download.DownloadPublicationSidecar

describe('renderer download publication finalization', () => {
  it('discards staging and never commits when metadata writing fails', async() => {
    const commit = vi.fn(async() => {})
    const discard = vi.fn(async() => {})

    await expect(finalizeDownloadPublication(publication, lyricPublication, {
      writeMetadata: async() => { throw new Error('tag failed') },
      writeLyric: async stagingPath => {
        expect(stagingPath).toBe(lyricPublication.stagingPath)
        return true
      },
      commit,
      discard,
    })).rejects.toThrow('tag failed')

    expect(commit).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledOnce()
    expect(discard).toHaveBeenCalledWith(publication, lyricPublication)
  })

  it('commits only after metadata and lyric work have both completed', async() => {
    const calls: string[] = []
    await finalizeDownloadPublication(publication, lyricPublication, {
      writeMetadata: async stagingPath => {
        expect(stagingPath).toBe(publication.stagingPath)
        calls.push('metadata')
      },
      writeLyric: async stagingPath => {
        expect(stagingPath).toBe(lyricPublication.stagingPath)
        calls.push('lyric')
        return true
      },
      commit: async(_publication, sidecar) => {
        expect(sidecar).toBe(lyricPublication)
        calls.push('commit')
      },
      discard: async() => { calls.push('discard') },
    })

    expect(calls.slice(0, 2).sort()).toEqual(['lyric', 'metadata'])
    expect(calls.at(-1)).toBe('commit')
    expect(calls).not.toContain('discard')
  })

  it.each(['wav', 'ape'] as const)('commits a valid %s stage even when tag fields and cover embedding are unavailable', async ext => {
    const losslessPublication: LX.Download.DownloadPublication = {
      ...publication,
      filePath: `C:\\Music\\song.${ext}`,
      fileName: `song.${ext}`,
      stagingPath: `C:\\Music\\song.lx-publishing.${ext}`,
      ext,
      quality: ext,
      actualFormat: { container: ext, codec: ext === 'wav' ? 'pcm' : 'ape', bitsPerSample: 16 },
      downgrade: undefined,
    }
    const task: LX.Download.ListItem = {
      id: `finalize-${ext}`,
      isComplate: true,
      status: 'run',
      statusText: '',
      downloaded: 100,
      total: 100,
      progress: 100,
      speed: '',
      writeQueue: 0,
      metadata: {
        musicInfo: {
          id: 'wy_song',
          name: '',
          singer: '',
          source: 'wy',
          interval: null,
          meta: { songId: 'song', albumName: '', picUrl: '', qualitys: [], _qualitys: {} },
        },
        url: '',
        quality: ext,
        ext,
        fileName: losslessPublication.fileName,
        filePath: losslessPublication.filePath,
      },
    }
    const commit = vi.fn(async() => {})
    const discard = vi.fn(async() => {})

    await finalizeDownloadPublication(losslessPublication, undefined, {
      writeMetadata: async() => {
        const plan = await buildDownloadMetadataWritePlan(task, {
          embedPicture: true,
          resolveCoverUrl: async() => { throw new Error('must not fetch') },
        })
        expect(plan.metadata).toBeNull()
        expect(plan.warning?.code).toBe('cover_writer_unsupported')
      },
      writeLyric: async() => false,
      commit,
      discard,
    })

    expect(commit).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()
  })
})
