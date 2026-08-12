import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { deduplicateDownloadTargets, normalizeReleaseDate, resolveDownloadTarget, sanitizePathSegment } from './index'
import { formatMusicName } from '@common/utils/tools'
import {
  DOWNLOAD_TRANSFER_SUFFIX,
  MAX_DOWNLOAD_FILE_STEM_LENGTH,
  WINDOWS_MAX_PATH_COMPONENT_LENGTH,
  getDownloadFlacRepairOwnerPath,
  getDownloadFlacRepairPath,
} from '@common/downloadArtifactPaths'

const makeMusic = (meta: Partial<LX.Music.MusicInfoMeta_kg> = {}): LX.Music.MusicInfo_kg => ({
  id: 'track-1',
  name: 'I Wanna Get Love',
  singer: '蔡徐坤',
  source: 'kg',
  interval: '03:00',
  meta: {
    songId: '1',
    albumName: 'I Wanna Get Love',
    albumId: '10',
    discographyArtist: '蔡徐坤',
    albumArtist: '合作专辑艺术家',
    releaseDate: '2017-12-15',
    trackNumber: 1,
    trackTotal: 8,
    hash: 'HASH',
    qualitys: [{ type: 'flac', size: '10 MB', hash: 'HASH' }],
    _qualitys: { flac: { size: '10 MB', hash: 'HASH' } },
    ...meta,
  },
})

describe('download target', () => {
  it('builds the confirmed album path and track filename', () => {
    const target = resolveDownloadTarget({
      musicInfo: makeMusic(),
      ext: 'flac',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'C:\\Users',
      savePathMode: 'album',
    })

    expect(target.fileName).toBe('01. 蔡徐坤 - I Wanna Get Love.flac')
    expect(target.filePath).toBe(path.resolve('C:\\Users', '蔡徐坤', '2017-12-15 I Wanna Get Love', target.fileName))
    expect(target.fallbackReasons).toEqual([])
  })

  it('uses album-wide width and falls back without inventing track or date values', () => {
    const target = resolveDownloadTarget({
      musicInfo: makeMusic({
        discographyArtist: null,
        trackNumber: null,
        trackTotal: 120,
        releaseDate: '2017-12',
        albumArtist: null,
      }),
      ext: 'mp3',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'album',
    })

    expect(target.fileName).toBe('蔡徐坤 - I Wanna Get Love.mp3')
    expect(target.directory).toBe(path.resolve('D:\\Music', '蔡徐坤', 'I Wanna Get Love'))
    expect(target.fallbackReasons).toEqual([
      'missing_track_number',
      'missing_album_artist',
      'invalid_release_date',
    ])
  })

  it('expands the track width for albums over 99 tracks', () => {
    const target = resolveDownloadTarget({
      musicInfo: makeMusic({ trackNumber: 7, trackTotal: 120 }),
      ext: 'flac',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'root',
    })
    expect(target.fileName.startsWith('007. ')).toBe(true)
  })

  it('uses the album artist for ordinary downloads without a discography artist', () => {
    const target = resolveDownloadTarget({
      musicInfo: makeMusic({ discographyArtist: null, albumArtist: '普通专辑艺术家' }),
      ext: 'flac',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'album',
    })

    expect(target.directory).toBe(path.resolve('D:\\Music', '普通专辑艺术家', '2017-12-15 I Wanna Get Love'))
    expect(target.fileName).toBe('01. 蔡徐坤 - I Wanna Get Love.flac')
    expect(target.fallbackReasons).toEqual([])
  })

  it.each([
    ['歌名 - 歌手', 'I Wanna Get Love - 蔡徐坤'],
    ['歌手 - 歌名', '蔡徐坤 - I Wanna Get Love'],
    ['歌名', 'I Wanna Get Love'],
  ] as const)('keeps the existing filename format %s', (fileNameFormat, expectedName) => {
    const target = resolveDownloadTarget({
      musicInfo: makeMusic(),
      ext: 'mp3',
      fileNameFormat,
      savePath: 'D:\\Music',
      savePathMode: 'root',
    })
    expect(target.fileName).toBe(`${expectedName}.mp3`)
  })

  it('sanitizes traversal, reserved names and trailing dots without escaping the root', () => {
    const target = resolveDownloadTarget({
      musicInfo: makeMusic({ discographyArtist: null, albumArtist: '..', albumName: 'CON. ' }),
      ext: 'flac',
      fileNameFormat: '歌名',
      savePath: 'D:\\Music',
      savePathMode: 'album',
    })
    const root = path.resolve('D:\\Music')
    expect(path.relative(root, target.filePath).startsWith('..')).toBe(false)
    expect(target.directory).toBe(path.join(root, '蔡徐坤', '2017-12-15 _CON'))
    expect(target.fallbackReasons).toContain('missing_album_artist')
    expect(sanitizePathSegment('NUL')).toBe('_NUL')
    expect(sanitizePathSegment('name. ')).toBe('name')
  })

  it('validates real calendar dates', () => {
    expect(normalizeReleaseDate('2024-02-29 00:00:00')).toBe('2024-02-29')
    expect(normalizeReleaseDate('2023-02-29')).toBeNull()
    expect(normalizeReleaseDate('0000-00-00')).toBeNull()
  })

  it('falls back to the root without inventing missing artist or album folders', () => {
    const target = resolveDownloadTarget({
      musicInfo: {
        ...makeMusic({
          discographyArtist: null,
          albumArtist: null,
          albumName: '',
          releaseDate: null,
          trackNumber: null,
        }),
        singer: '',
      },
      ext: 'mp3',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'album',
    })

    expect(target.directory).toBe(path.resolve('D:\\Music'))
    expect(target.fileName).toBe('I Wanna Get Love.mp3')
    expect(target.fallbackReasons).toEqual([
      'missing_track_artist',
      'missing_track_number',
      'missing_album_artist',
    ])
  })

  it('falls back to the artist folder when the album name is missing', () => {
    const target = resolveDownloadTarget({
      musicInfo: makeMusic({ albumName: '' }),
      ext: 'flac',
      fileNameFormat: '歌名',
      savePath: 'D:\\Music',
      savePathMode: 'album',
    })

    expect(target.directory).toBe(path.resolve('D:\\Music', '蔡徐坤'))
    expect(target.fallbackReasons).toContain('missing_album_name')
  })

  it('keeps the extension and safely shortens an overlong target path', () => {
    const longText = '很长的名称'.repeat(60)
    const target = resolveDownloadTarget({
      musicInfo: {
        ...makeMusic({ discographyArtist: longText, albumArtist: longText, albumName: longText }),
        name: longText,
      },
      ext: 'flac',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'album',
    })

    expect(target.filePath.length).toBeLessThanOrEqual(240)
    expect(target.fileName.endsWith('.flac')).toBe(true)
    expect(target.fallbackReasons).toContain('path_truncated')
  })

  it('keeps a readable song title when the track artist list is overlong', () => {
    const target = resolveDownloadTarget({
      musicInfo: {
        ...makeMusic(),
        name: '从现在 到未来',
        singer: '韦唯、周深、萧敬腾、郁可唯、王祖蓝、李亚男、黄霄雲、张远、沙宝亮、张云龙、刘雨昕、李小冉、王鸥、吴宣仪、李晨、孙怡、杜江、沈月、张紫宁、乃万、陈数、马伯骞、付辛博、黄子弘凡、炎明熹、郑棋元、段奥娟、吉克隽逸、于朦胧、钟丽缇、王晰、海陆、阿朵、毛晓彤、弦'.repeat(4),
      },
      ext: 'flac',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'root',
    })

    expect(target.fileName).toMatch(/^01\. .+\.\.\.~[a-z0-9]+ - 从现在 到未来\.flac$/u)
    expect(target.fallbackReasons).toContain('path_truncated')
  })

  it('marks an overlong song title as abbreviated while retaining its artist', () => {
    const target = resolveDownloadTarget({
      musicInfo: {
        ...makeMusic(),
        name: '11111111111111111111'.repeat(20),
        singer: '刘雨昕',
      },
      ext: 'flac',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'root',
    })

    expect(target.fileName).toMatch(/^01\. 刘雨昕 - 1+\.\.\.~[a-z0-9]+\.flac$/u)
    expect(target.fallbackReasons).toContain('path_truncated')
  })

  it('reserves the Windows component budget for the longest validation artifact without collapsing distinct names', () => {
    const longPrefix = '相同且很长的歌曲标题'.repeat(40)
    const resolve = (name: string) => resolveDownloadTarget({
      musicInfo: {
        ...makeMusic(),
        name,
        singer: '韦唯、周深、萧敬腾、郁可唯、王祖蓝、李亚男'.repeat(12),
      },
      ext: 'flac',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'root',
    })
    const first = resolve(`${longPrefix}甲`)
    const repeated = resolve(`${longPrefix}甲`)
    const differentTail = resolve(`${longPrefix}乙`)
    const stem = path.parse(first.fileName).name
    const transferFileName = `${stem}${DOWNLOAD_TRANSFER_SUFFIX}`
    const repairFileName = getDownloadFlacRepairPath(transferFileName, '00000000-0000-4000-8000-000000000000')
    const ownerFileName = getDownloadFlacRepairOwnerPath(repairFileName)

    expect(first.fileName).toBe(repeated.fileName)
    expect(first.fileName).not.toBe(differentTail.fileName)
    expect(stem.length).toBeLessThanOrEqual(MAX_DOWNLOAD_FILE_STEM_LENGTH)
    expect(ownerFileName.length).toBeLessThanOrEqual(WINDOWS_MAX_PATH_COMPONENT_LENGTH)
  })

  it('keeps heavily shortened semantic fields collision-resistant in a deep target path', () => {
    const artistPrefix = '相同且很长的歌手名称'.repeat(40)
    const resolve = (artist: string) => resolveDownloadTarget({
      musicInfo: {
        ...makeMusic({
          discographyArtist: '相同且很长的目录歌手'.repeat(40),
          albumName: '相同且很长的专辑名称'.repeat(40),
        }),
        name: '相同且很长的歌曲标题'.repeat(40),
        singer: artist,
      },
      ext: 'flac',
      fileNameFormat: '曲序. 艺术家 - 歌曲名',
      savePath: 'D:\\Music',
      savePathMode: 'album',
    })
    const first = resolve(`${artistPrefix}甲`)
    const differentTail = resolve(`${artistPrefix}乙`)

    expect(first.filePath.length).toBeLessThanOrEqual(240)
    expect(first.fileName).toContain(' - ')
    expect(first.fileName).toContain('...')
    expect(first.fileName).not.toBe(differentTail.fileName)
  })

  it('deduplicates stable task IDs and case-insensitive target paths', () => {
    const existing = [{ id: 'existing', metadata: { filePath: 'D:\\Music\\Song.flac' } }]
    const result = deduplicateDownloadTargets([
      { id: 'existing', metadata: { filePath: 'D:\\Music\\Other.flac' } },
      { id: 'same-path', metadata: { filePath: 'd:\\music\\song.flac' } },
      { id: 'kept', metadata: { filePath: 'D:\\Music\\Kept.flac' } },
      { id: 'batch-duplicate', metadata: { filePath: 'd:\\music\\kept.flac' } },
    ], existing)

    expect(result.tasks.map(task => task.id)).toEqual(['kept'])
    expect(result.duplicateTargetCount).toBe(2)
  })

  it('keeps non-download display text readable when the download format needs album context', () => {
    expect(formatMusicName('曲序. 艺术家 - 歌曲名', 'Song', 'Artist')).toBe('Song - Artist')
  })
})
