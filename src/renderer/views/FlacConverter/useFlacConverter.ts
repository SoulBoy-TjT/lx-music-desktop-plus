import { computed, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { onActivated } from 'vue'
import type {
  FlacConversionProgress,
  FlacConversionResult,
  FlacConverterArtistFolder,
} from '@common/flacConverter'
import { useI18n } from '@root/lang'
import { appSetting } from '@renderer/store/setting'
import {
  applyFlacConversion,
  getFlacConversionPreview,
  getFlacConverterCapability,
  onFlacConversionProgress,
  scanFlacConverterArtists,
  setFlacConversionPaused,
  showSelectDialog,
} from '@renderer/utils/ipc'
import { summarizeFlacConversionResult } from './resultState'
import { resolveFlacConverterRootDirectory } from './rootDirectory'

type RowStatus = 'idle' | 'preparing' | 'running' | 'pausing' | 'paused' | 'completed' | 'anomaly' | 'failed'

interface ArtistRowState {
  status: RowStatus
  progress?: FlacConversionProgress
  anomalies: string[]
}

const createRowState = (): ArtistRowState => ({ status: 'idle', anomalies: [] })

export const useFlacConverter = () => {
  const t = useI18n()
  const capabilityReady = ref(false)
  const supported = ref(false)
  const ffmpegAvailable = ref(false)
  const scanning = ref(false)
  const operating = ref(false)
  const customRootDirectory = ref('')
  const rootDirectory = computed(() => resolveFlacConverterRootDirectory(
    appSetting['download.savePath'],
    customRootDirectory.value,
  ))
  const isCustomRootDirectory = computed(() => Boolean(customRootDirectory.value))
  const outputParentDirectory = ref('')
  const artists = ref<FlacConverterArtistFolder[]>([])
  const activeSourceDirectory = ref('')
  const errorMessage = ref('')
  const rowStates = ref<Record<string, ArtistRowState>>({})
  let pendingScan = false
  let removeProgressListener: (() => void) | undefined

  const artistRows = computed(() => artists.value.map(artist => ({
    artist,
    state: rowStates.value[artist.path] ?? createRowState(),
  })))

  const resetRows = (nextArtists: FlacConverterArtistFolder[]) => {
    rowStates.value = Object.fromEntries(nextArtists.map(artist => [artist.path, createRowState()]))
  }

  const scanArtists = async() => {
    if (operating.value) {
      pendingScan = true
      return
    }
    if (scanning.value) {
      pendingScan = true
      return
    }
    const nextRoot = rootDirectory.value
    const nextOutputParent = outputParentDirectory.value
    if (!nextRoot) {
      artists.value = []
      resetRows([])
      errorMessage.value = t('flac_conversion__download_root_empty')
      return
    }
    scanning.value = true
    errorMessage.value = ''
    try {
      const result = await scanFlacConverterArtists({
        rootDirectory: nextRoot,
        outputParentDirectory: nextOutputParent || undefined,
      })
      if (nextRoot != rootDirectory.value || nextOutputParent != outputParentDirectory.value) {
        pendingScan = true
        return
      }
      artists.value = result.artists
      resetRows(result.artists)
    } catch (error) {
      if (nextRoot != rootDirectory.value || nextOutputParent != outputParentDirectory.value) {
        pendingScan = true
        return
      }
      artists.value = []
      resetRows([])
      errorMessage.value = (error as Error).message
    } finally {
      scanning.value = false
      if (pendingScan && !operating.value) {
        pendingScan = false
        await scanArtists()
      }
    }
  }

  const selectRootDirectory = async() => {
    if (operating.value || scanning.value) return
    const selected = await showSelectDialog({
      title: t('flac_conversion__select_source'),
      defaultPath: rootDirectory.value || undefined,
      properties: ['openDirectory'],
    })
    if (selected.canceled || !selected.filePaths[0]) return
    customRootDirectory.value = selected.filePaths[0]
    await scanArtists()
  }

  const useDownloadDirectory = async() => {
    if (operating.value || scanning.value || !customRootDirectory.value) return
    customRootDirectory.value = ''
    await scanArtists()
  }

  const selectOutput = async() => {
    if (operating.value || scanning.value) return
    const selected = await showSelectDialog({
      title: t('flac_conversion__select_output'),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selected.canceled || !selected.filePaths[0]) return
    outputParentDirectory.value = selected.filePaths[0]
    await scanArtists()
  }

  const useDefaultOutput = async() => {
    if (operating.value || scanning.value || !outputParentDirectory.value) return
    outputParentDirectory.value = ''
    await scanArtists()
  }

  const anomalyLines = (result: FlacConversionResult): string[] => {
    const lines: string[] = []
    if (!result.countMatches) {
      lines.push(t('flac_conversion__count_mismatch', {
        source: result.sourceSongCount,
        output: result.outputSongCount,
      }))
    }
    for (const item of result.skipped) {
      lines.push(t('flac_conversion__result_item', {
        status: t('flac_conversion__result_skipped'),
        source: item.sourcePath,
        target: item.targetPath,
        reason: item.reason ? `；${item.reason}` : '',
      }))
    }
    for (const item of result.failed) {
      lines.push(t('flac_conversion__result_item', {
        status: t('flac_conversion__result_failed'),
        source: item.sourcePath,
        target: item.targetPath,
        reason: item.reason ? `；${item.reason}` : '',
      }))
    }
    return lines
  }

  const convertArtist = async(artist: FlacConverterArtistFolder) => {
    if (operating.value || scanning.value || !artist.songCount) return
    operating.value = true
    activeSourceDirectory.value = artist.path
    errorMessage.value = ''
    const state = rowStates.value[artist.path] ?? (rowStates.value[artist.path] = createRowState())
    state.status = 'preparing'
    state.progress = undefined
    state.anomalies = []
    try {
      const params = {
        sourceDirectory: artist.path,
        outputParentDirectory: outputParentDirectory.value || undefined,
      }
      const preview = await getFlacConversionPreview(params)
      const result = await applyFlacConversion({
        ...params,
        confirmedSourcePaths: preview.items.filter(item => item.status == 'ready').map(item => item.sourcePath),
      })
      artist.outputDirectory = result.outputDirectory
      const summary = summarizeFlacConversionResult(result)
      state.progress = {
        taskId: result.taskId,
        sourceDirectory: artist.path,
        completedCount: result.succeeded.length,
        totalCount: preview.readyCount,
        phase: 'completed',
      }
      state.anomalies = summary.hasAnomalies ? anomalyLines(result) : []
      state.status = summary.hasAnomalies ? 'anomaly' : 'completed'
    } catch (error) {
      const reason = (error as Error).message
      state.status = 'failed'
      state.anomalies = [t('flac_conversion__operation_failed', { reason })]
    } finally {
      operating.value = false
      activeSourceDirectory.value = ''
      if (pendingScan) {
        pendingScan = false
        await scanArtists()
      }
    }
  }

  const togglePause = async(artist: FlacConverterArtistFolder) => {
    if (activeSourceDirectory.value != artist.path) return
    const state = rowStates.value[artist.path]
    if (!state) return
    const shouldPause = state.status != 'pausing' && state.status != 'paused'
    try {
      const pauseState = await setFlacConversionPaused(shouldPause)
      if (!pauseState.busy) return
      state.status = shouldPause ? (pauseState.paused ? 'paused' : 'pausing') : 'running'
    } catch (error) {
      state.anomalies = [t('flac_conversion__pause_failed', { reason: (error as Error).message })]
    }
  }

  const statusText = (state: ArtistRowState): string => {
    if (state.status == 'running' && state.progress) {
      return t('flac_conversion__row_progress', {
        completed: state.progress.completedCount,
        total: state.progress.totalCount,
      })
    }
    return t(`flac_conversion__row_status_${state.status}`)
  }

  const progressRatio = (state: ArtistRowState): number => {
    if (!state.progress?.totalCount) return 0
    return Math.min(1, state.progress.completedCount / state.progress.totalCount)
  }

  onMounted(async() => {
    removeProgressListener = onFlacConversionProgress(({ params }) => {
      const state = rowStates.value[params.sourceDirectory]
      if (!state) return
      state.progress = params
      if (params.phase == 'pausing') state.status = 'pausing'
      else if (params.phase == 'paused') state.status = 'paused'
      else if (params.phase == 'running') state.status = 'running'
    })
    try {
      const capability = await getFlacConverterCapability()
      supported.value = capability.supported
      ffmpegAvailable.value = capability.ffmpegAvailable
      if (capability.supported && capability.ffmpegAvailable) await scanArtists()
    } catch (error) {
      errorMessage.value = (error as Error).message
    } finally {
      capabilityReady.value = true
    }
  })

  watch(() => appSetting['download.savePath'], () => {
    if (!capabilityReady.value || !supported.value || !ffmpegAvailable.value) return
    if (customRootDirectory.value) return
    void scanArtists()
  })

  onActivated(() => {
    if (!capabilityReady.value || !supported.value || !ffmpegAvailable.value) return
    if (!artists.value.length) void scanArtists()
  })

  onBeforeUnmount(() => {
    removeProgressListener?.()
  })

  return {
    activeSourceDirectory,
    artistRows,
    capabilityReady,
    convertArtist,
    errorMessage,
    ffmpegAvailable,
    isCustomRootDirectory,
    operating,
    outputParentDirectory,
    progressRatio,
    rootDirectory,
    scanArtists,
    scanning,
    selectRootDirectory,
    selectOutput,
    statusText,
    supported,
    togglePause,
    useDownloadDirectory,
    useDefaultOutput,
  }
}
