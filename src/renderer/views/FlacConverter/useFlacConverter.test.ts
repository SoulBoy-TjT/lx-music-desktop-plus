import { effectScope, nextTick, reactive } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlacConversionPreview, FlacConversionResult, FlacConverterArtistScanResult } from '@common/flacConverter'
import { appSetting } from '@renderer/store/setting'
import { applyFlacConversion, getFlacConversionPreview } from '@renderer/utils/ipc'
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
