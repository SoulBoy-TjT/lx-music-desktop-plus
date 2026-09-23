import { effectScope, nextTick, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlacConversionPreview, FlacConversionResult, FlacConverterArtistScanResult } from '@common/flacConverter'
import { appSetting } from '@renderer/store/setting'
import { applyFlacConversion, getFlacConversionPreview, openDirInExplorer } from '@renderer/utils/ipc'
import { useFlacConverter } from './useFlacConverter'

const mocks = vi.hoisted(() => ({
  scanArtists: vi.fn(),
  appSetting: { 'download.savePath': 'C:\\Music\\A' },
}))

vi.mock('vue', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    onActivated: vi.fn(),
    onBeforeUnmount: vi.fn(),
    onMounted: vi.fn(),
  }
})

vi.mock('@root/lang', () => ({
  useI18n: () => (key: string) => key,
}))

vi.mock('@renderer/store/setting', () => ({
  appSetting: reactive(mocks.appSetting),
}))

vi.mock('@renderer/utils/ipc', () => ({
  applyFlacConversion: vi.fn(),
  getFlacConversionPreview: vi.fn(),
  getFlacConverterCapability: vi.fn(),
  onFlacConversionProgress: vi.fn(),
  openDirInExplorer: vi.fn(),
  scanFlacConverterArtists: mocks.scanArtists,
  setFlacConversionPaused: vi.fn(),
  showSelectDialog: vi.fn(),
}))

const scanResult = (rootDirectory: string): FlacConverterArtistScanResult => ({
  rootDirectory,
  artists: [{
    name: rootDirectory.endsWith('A') ? 'Artist A' : 'Artist B',
    path: `${rootDirectory}\\Artist`,
    outputDirectory: `${rootDirectory} MP3\\Artist`,
    flacCount: 1,
    mp3Count: 0,
    songCount: 1,
  }],
})

describe('FLAC converter scanning', () => {
  beforeEach(() => {
    mocks.scanArtists.mockReset()
    vi.mocked(applyFlacConversion).mockReset()
    vi.mocked(getFlacConversionPreview).mockReset()
    appSetting['download.savePath'] = 'C:\\Music\\A'
  })

  it('discards an old scan and automatically scans the latest download directory', async() => {
    let resolveFirst: ((value: FlacConverterArtistScanResult) => void) | undefined
    mocks.scanArtists
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce(scanResult('C:\\Music\\B'))

    const scope = effectScope()
    const converter = scope.run(() => useFlacConverter())!
    const firstScan = converter.scanArtists()

    appSetting['download.savePath'] = 'C:\\Music\\B'
    await nextTick()
    await converter.scanArtists()
    resolveFirst?.(scanResult('C:\\Music\\A'))
    await firstScan

    expect(mocks.scanArtists).toHaveBeenNthCalledWith(1, {
      rootDirectory: 'C:\\Music\\A',
      outputParentDirectory: undefined,
    })
    expect(mocks.scanArtists).toHaveBeenNthCalledWith(2, {
      rootDirectory: 'C:\\Music\\B',
      outputParentDirectory: undefined,
    })
    expect(converter.artistRows.value.map(row => row.artist.name)).toEqual(['Artist B'])
    scope.stop()
  })

  it('shows the counted output directory returned after conversion', async() => {
    const result = scanResult('C:\\Music\\A')
    const artist = result.artists[0]
    const sourcePath = `${artist.path}\\Song.flac`
    const targetPath = `${artist.outputDirectory}\\Song.mp3`
    const countedOutputDirectory = `${artist.outputDirectory}（1首）`
    mocks.scanArtists.mockResolvedValue(result)
    vi.mocked(getFlacConversionPreview).mockResolvedValue({
      sourceDirectory: artist.path,
      outputDirectory: artist.outputDirectory,
      items: [{
        sourcePath,
        targetPath,
        kind: 'flac_to_mp3',
        size: 1,
        status: 'ready',
      }],
      readyCount: 1,
      skippedCount: 0,
      totalSize: 1,
      flacCount: 1,
      mp3Count: 0,
    } satisfies FlacConversionPreview)
    vi.mocked(applyFlacConversion).mockResolvedValue({
      taskId: 'task-1',
      outputDirectory: countedOutputDirectory,
      succeeded: [{ sourcePath, targetPath: `${countedOutputDirectory}\\Song.mp3` }],
      skipped: [],
      failed: [],
      sourceSongCount: 1,
      outputSongCount: 1,
      countMatches: true,
    } satisfies FlacConversionResult)

    const scope = effectScope()
    const converter = scope.run(() => useFlacConverter())!
    await converter.scanArtists()
    await converter.convertArtist(converter.artistRows.value[0].artist)

    expect(converter.artistRows.value[0].artist.outputDirectory).toBe(countedOutputDirectory)
    scope.stop()
  })
})


describe('FLAC converter anomaly actions', () => {
  it('retains source paths and requests scoped cleanup retry under the operation lock', async() => {
    vi.clearAllMocks()
    const scan = scanResult('C:\\Music\\A')
    const artist = scan.artists[0]
    const sourcePath = `${artist.path}\\Album\\Broken.flac`
    const addedPath = `${artist.path}\\Album\\Added.mp3`
    const targetPath = `${artist.outputDirectory}\\Album\\Broken.mp3`
    mocks.scanArtists.mockResolvedValue(scan)
    const preview: FlacConversionPreview = {
      sourceDirectory: artist.path,
      outputDirectory: artist.outputDirectory,
      items: [{ sourcePath, targetPath, kind: 'flac_to_mp3', size: 1, status: 'ready' }],
      readyCount: 1,
      skippedCount: 0,
      totalSize: 1,
      flacCount: 1,
      mp3Count: 0,
    }
    vi.mocked(getFlacConversionPreview).mockResolvedValue(preview)
    vi.mocked(applyFlacConversion).mockResolvedValue({
      taskId: 'failed',
      outputDirectory: artist.outputDirectory,
      extraOutputPaths: [`${artist.outputDirectory}\\Extra.mp3`],
      missingSourcePaths: [`${artist.path}\\Missing.flac`],
      succeeded: [],
      skipped: [{ sourcePath: 'other.flac', targetPath, reason: '目标 MP3 已存在，禁止覆盖。' }],
      failed: [{ sourcePath, targetPath, reason: 'invalid audio' }],
      sourceSongCount: 1,
      outputSongCount: 0,
      countMatches: false,
    })
    const scope = effectScope()
    const converter = scope.run(() => useFlacConverter())!
    converter.outputParentDirectory.value = 'C:\\Converted'
    await converter.scanArtists()
    const row = converter.artistRows.value[0]
    await converter.convertArtist(row.artist)
    expect(row.state.status).toBe('anomaly')
    expect(row.state.anomalies[2].sourcePath).toBeUndefined()
    expect(row.state.anomalies).toHaveLength(4)
    expect(row.state.anomalies[0].sourcePath).toBe(`${artist.outputDirectory}\\Extra.mp3`)
    expect(row.state.anomalies[1].sourcePath).toBe(`${artist.path}\\Missing.flac`)
    expect(row.state.anomalies[3].sourcePath).toBe(sourcePath)
    await converter.openAnomaly(row.state.anomalies[2])
    expect(openDirInExplorer).not.toHaveBeenCalled()
    await converter.openAnomaly(row.state.anomalies[3])
    expect(openDirInExplorer).toHaveBeenCalledWith(sourcePath)

    vi.mocked(applyFlacConversion).mockRejectedValueOnce(new Error('cleanup denied'))
    await converter.retryArtistAnomalies(row.artist)
    expect(row.state.status).toBe('failed')
    expect(row.state.retrySourcePaths).toEqual([sourcePath])
    expect(row.state.anomalies.some(item => item.sourcePath == sourcePath)).toBe(true)

    let finishRetry!: (value: FlacConversionResult) => void
    vi.mocked(applyFlacConversion).mockReturnValueOnce(new Promise(resolve => { finishRetry = resolve }))
    const retry = converter.retryArtistAnomalies(row.artist)
    await converter.retryArtistAnomalies(row.artist)
    expect(getFlacConversionPreview).toHaveBeenCalledTimes(1)
    expect(converter.operating.value).toBe(true)
    expect(applyFlacConversion).toHaveBeenLastCalledWith({
      sourceDirectory: artist.path,
      outputParentDirectory: 'C:\\Converted',
      confirmedSourcePaths: [],
      retrySourcePaths: [sourcePath],
    })
    finishRetry({
      taskId: 'retry',
      outputDirectory: `${artist.outputDirectory}（2首）`,
      succeeded: [{ sourcePath, targetPath }, { sourcePath: addedPath, targetPath }],
      skipped: [],
      failed: [],
      sourceSongCount: 2,
      outputSongCount: 2,
      countMatches: true,
    })
    await retry
    expect(row.state.status).toBe('completed')
    expect(row.state.anomalies).toEqual([])
    expect(converter.operating.value).toBe(false)
    scope.stop()
  })
})
