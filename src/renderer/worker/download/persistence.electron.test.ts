/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="../../../main/types/db_service.d.ts" />

import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runElectronSqlite = Boolean(process.versions.electron)
let db: Database.Database | undefined

const createMusicInfo = (name: string): LX.Music.MusicInfoOnline => ({
  id: 'wy_song',
  name,
  singer: '歌手',
  source: 'wy',
  interval: null,
  meta: {
    songId: 'song',
    albumName: '专辑',
    picUrl: 'https://example.test/cover.jpg',
    qualitys: [],
    _qualitys: {},
  },
})

const createTask = (): LX.Download.ListItem => ({
  id: 'download-task',
  isComplate: false,
  status: 'run',
  statusText: 'downloading',
  downloaded: 20,
  total: 100,
  progress: 20,
  speed: '1 MB/s',
  writeQueue: 0,
  metadata: {
    musicInfo: createMusicInfo('原始歌曲'),
    url: 'https://example.test/original.flac',
    requestedQuality: 'flac',
    quality: 'flac',
    ext: 'flac',
    fileName: '原始歌曲.flac',
    filePath: 'C:\\Music\\原始歌曲.flac',
  },
})

afterEach(() => {
  db?.close()
  db = undefined
  vi.resetModules()
  vi.doUnmock('../../../main/worker/dbService/db')
})

describe.runIf(runElectronSqlite)('download SQLite persistence', () => {
  it('reloads every actual-format publication field after a real UPDATE', async() => {
    const Database = (await import('better-sqlite3')).default
    const tables = (await import('../../../main/worker/dbService/tables')).default
    db = new Database(':memory:')
    db.exec(tables.get('download_list')!)
    vi.doMock('../../../main/worker/dbService/db', () => ({ getDB: () => db }))

    const firstModule = await import('../../../main/worker/dbService/modules/download')
    const task = createTask()
    firstModule.downloadInfoSave([task], 'bottom')

    const updated: LX.Download.ListItem = {
      ...task,
      isComplate: true,
      status: 'run',
      statusText: 'post-processing',
      downloaded: 100,
      total: 100,
      progress: 100,
      metadata: {
        ...task.metadata,
        musicInfo: createMusicInfo('最终歌曲'),
        url: 'https://example.test/final.mp3',
        requestedQuality: 'flac',
        quality: '320k',
        ext: 'mp3',
        fileName: '最终歌曲.mp3',
        filePath: 'C:\\Music\\最终歌曲.mp3',
        stagingPath: 'C:\\Music\\最终歌曲.lx-publishing.mp3',
        actualFormat: { container: 'mp3', codec: 'mp3', bitrate: 320_000 },
        formatDowngrade: {
          reason: 'lossless_unavailable',
          requestedQuality: 'flac',
          actualQuality: '320k',
        },
        postProcessingWarning: {
          phase: 'cover',
          code: 'cover_writer_unsupported',
          message: 'cover unsupported',
          taskId: task.id,
          filePath: 'C:\\Music\\最终歌曲.mp3',
        },
      },
    }
    firstModule.downloadInfoUpdate([updated])

    vi.resetModules()
    vi.doMock('../../../main/worker/dbService/db', () => ({ getDB: () => db }))
    const reloadedModule = await import('../../../main/worker/dbService/modules/download')

    expect(reloadedModule.getDownloadList()).toHaveLength(1)
    expect(reloadedModule.getDownloadList()[0]).toMatchObject({
      id: updated.id,
      isComplate: updated.isComplate,
      status: updated.status,
      statusText: updated.statusText,
      downloaded: updated.downloaded,
      total: updated.total,
      metadata: updated.metadata,
    })
  })
})
