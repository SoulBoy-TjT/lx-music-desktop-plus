import { computed, onBeforeUnmount, onMounted, ref, watch } from '@common/utils/vueTools'
import { onActivated, onDeactivated } from 'vue'
import type {
  SongOrganizerCleanupPreview,
  SongOrganizerOperationProgress,
  SongOrganizerOperationResult,
  SongOrganizerRecovery,
  SongOrganizerRuntimeState,
  SongOrganizerScanProgress,
  SongOrganizerSnapshot,
  SongOrganizerValidationSnapshot,
} from '@common/songOrganizer'
import { resolveSongOrganizerRoot } from '@common/songOrganizerRoot'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { playMusicInfo } from '@renderer/store/player/state'
import { useI18n } from '@root/lang'
import {
  applySongOrganizerOrganize,
  getSongOrganizerCapability,
  getSongOrganizerOrganizePreview,
  getSongOrganizerRecovery,
  getSongOrganizerRuntimeState,
  rollbackSongOrganizerRecovery,
  dismissSongOrganizerRecovery,
  onSongOrganizerRuntimeStateChanged,
  onSongOrganizerOperationProgress,
  onSongOrganizerScanProgress,
  openDirInExplorer,
  showSelectDialog,
  startSongOrganizerScan,
  startSongOrganizerCheck,
} from '@renderer/utils/ipc'
import { createSongOrganizerApplyParams } from './applyParams'
import {
  buildSongOrganizerArtistRows,
  buildSongOrganizerCheckProgress,
  buildSongOrganizerDetailLines,
  buildSongOrganizerOperationErrorIssue,
  buildSongOrganizerOperationIssues,
  buildSongOrganizerReloadControl,
  summarizeSongOrganizerOperation,
  type SongOrganizerActionDisabledReason,
  type SongOrganizerArtistRow,
  type SongOrganizerOrganizeDisabledReason,
  normalizeSongOrganizerPathKey,
} from './viewModel'
import {
  clearSongOrganizerOperationIssues,
  replaceSongOrganizerOperationIssues,
  shouldApplySongOrganizerOperationProgress,
  type ActiveSongOrganizerOperation,
} from './operationFeedback'
import {
  latestSongOrganizerRuntimeState,
  normalizeSongOrganizerRoot,
  reconcileSongOrganizerRuntimeState,
  shouldApplySongOrganizerRuntimeState,
} from './runtimeState'
import { createOperationDetailDialogController } from '@renderer/components/common/operationDetailDialogState'

const currentPlayingPath = (): string | undefined => {
  const musicInfo = playMusicInfo.musicInfo
  if (!musicInfo) return undefined
  if ('progress' in musicInfo) return musicInfo.metadata.filePath
  return musicInfo.source == 'local' ? musicInfo.meta.filePath : undefined
}

const emptyRecovery: SongOrganizerRecovery = { operationId: '', type: 'cleanup', root: '', startedAt: 0, completed: false, steps: [] }
export const useSongOrganizer = () => {
  const t = useI18n()
  const capabilityReady = ref(false)
  const supported = ref(false)
  const validatorAvailable = ref(false)
  const scanning = ref(false)
  const operating = ref(false)
  const snapshotOperable = ref(false)
  const progress = ref<SongOrganizerScanProgress>()
  const operationProgress = ref<SongOrganizerOperationProgress>()
  const snapshot = ref<SongOrganizerSnapshot>()
  const validations = ref<SongOrganizerValidationSnapshot[]>([])
  const errorMessage = ref('')
  const statusMessage = ref(t('song_organizer__status_idle'))
  const detailLines = ref<string[]>([])
  const detailDialogVisible = ref(false)
  const detailDialogConfirmation = ref(false)
  const detailDialogTitle = ref(t('song_organizer__latest_detail'))
  const recovery = ref<SongOrganizerRecovery>()
  const operationIssuesByArtist = ref(new Map<string, ReturnType<typeof buildSongOrganizerOperationIssues>>())
  const ignoredTaskIds = new Set<string>()
  let activeProgressTaskId: string | undefined
  let activeOperation: ActiveSongOrganizerOperation | undefined
  let operationSequence = 0
  let removeProgressListener: (() => void) | undefined
  let removeOperationProgressListener: (() => void) | undefined
  let removeRuntimeStateListener: (() => void) | undefined
  let appliedRuntimeRevision = -1
  let pendingRuntimeState: SongOrganizerRuntimeState | undefined

  const root = computed(() => resolveSongOrganizerRoot(appSetting))
  let observedRoot = normalizeSongOrganizerRoot(root.value)

  const visibleRecovery = computed(() => recovery.value ?? emptyRecovery)
  const reloadControl = computed(() => buildSongOrganizerReloadControl({
    scanning: scanning.value,
    operating: operating.value,
  }))
  const checkProgress = computed(() => buildSongOrganizerCheckProgress(progress.value))
  const checkProgressLabel = computed(() => checkProgress.value
    ? t('song_organizer__check_progress', {
      completed: checkProgress.value.checkedCount,
      total: checkProgress.value.totalAudioCount,
    })
    : '')
  const checkProgressTarget = computed(() => checkProgress.value?.currentPath ?? '')
  const operationProgressLabel = computed(() => {
    const value = operationProgress.value
    return value
      ? t('song_organizer__operation_progress', {
        phase: t(`song_organizer__operation_phase_${value.phase}`),
        completed: value.completed,
        total: value.total,
      })
      : ''
  })
  const operationProgressTarget = computed(() => operationProgress.value?.currentRelativeTarget ?? '')
  const artistRows = computed(() => buildSongOrganizerArtistRows(snapshot.value, {
    snapshotOperable: snapshotOperable.value,
    playingFilePath: currentPlayingPath(),
    playingBlockedReason: t('song_organizer__playing_blocked'),
    operationIssuesByArtist: operationIssuesByArtist.value,
    validations: validations.value,
  }))

  const scanSummary = (value: SongOrganizerSnapshot): string => t('song_organizer__status_complete', {
    artists: value.totals.artistCount,
    songs: value.totals.audioCount,
    anomalies: value.anomalies.length,
  })

  const resetProgressTask = () => {
    if (activeProgressTaskId) ignoredTaskIds.add(activeProgressTaskId)
    activeProgressTaskId = undefined
    progress.value = undefined
  }

  const detailDialogController = createOperationDetailDialogController({
    setContent: content => {
      detailDialogTitle.value = content.title
      detailLines.value = content.lines
      detailDialogConfirmation.value = content.confirmation
    },
    setVisible: visible => {
      detailDialogVisible.value = visible
      if (!visible) detailDialogConfirmation.value = false
    },
  })
  const showDetailDialog = detailDialogController.show
  const confirmDetailDialog = detailDialogController.confirm
  const resolveDetailDialog = detailDialogController.resolve

  const clearForRootChange = () => {
    snapshot.value = undefined
    validations.value = []
    snapshotOperable.value = false
    resolveDetailDialog(false)
    detailLines.value = []
    errorMessage.value = ''
    activeOperation = undefined
    operationProgress.value = undefined
    operationIssuesByArtist.value = clearSongOrganizerOperationIssues()
  }

  const nextOperationId = (taskId: string): string => `${taskId}:renderer:${++operationSequence}`

  const replaceOperationIssues = (
    artistPath: string,
    issues: ReturnType<typeof buildSongOrganizerOperationIssues>,
  ): void => {
    operationIssuesByArtist.value = replaceSongOrganizerOperationIssues(operationIssuesByArtist.value, artistPath, issues)
  }

  const postOperationArtistPath = (
    row: SongOrganizerArtistRow,
    nextSnapshot?: SongOrganizerSnapshot,
  ): string => {
    if (!nextSnapshot) return row.artist.path
    const currentPath = nextSnapshot.artists.find(artist => artist.path == row.artist.path)?.path
    if (currentPath) return currentPath
    const targetPath = row.renamePlan?.steps.find(step => step.type == 'artist')?.to
    return nextSnapshot.artists.find(artist => artist.path == targetPath)?.path ?? row.artist.path
  }

  const retainOperationIssues = (
    row: SongOrganizerArtistRow,
    result: SongOrganizerOperationResult,
    nextSnapshot?: SongOrganizerSnapshot,
  ): void => {
    replaceOperationIssues(
      postOperationArtistPath(row, nextSnapshot),
      buildSongOrganizerOperationIssues(result, nextSnapshot?.root ?? snapshot.value?.root ?? root.value),
    )
  }

  const selectRoot = async(): Promise<string | undefined> => {
    const result = await showSelectDialog({
      title: t('song_organizer__select_root'),
      defaultPath: root.value,
      properties: ['openDirectory'],
    })
    return result.canceled ? undefined : result.filePaths[0]
  }

  const applyRuntimeState = (state: SongOrganizerRuntimeState): void => {
    if (!shouldApplySongOrganizerRuntimeState(appliedRuntimeRevision, state)) return
    appliedRuntimeRevision = state.revision
    const decision = reconcileSongOrganizerRuntimeState(root.value, state, operating.value)
    if (decision == 'preserve_operation') return
    validations.value = state.validations ?? []
    if (decision == 'wait_for_main') {
      if (operating.value) {
        clearForRootChange()
        return
      }
      observedRoot = normalizeSongOrganizerRoot(root.value)
      clearForRootChange()
      scanning.value = false
      resetProgressTask()
      statusMessage.value = t('song_organizer__status_scanning')
      return
    }
    observedRoot = normalizeSongOrganizerRoot(root.value)
    if (decision == 'attach') {
      if (activeProgressTaskId && activeProgressTaskId != state.taskId) ignoredTaskIds.add(activeProgressTaskId)
      if (state.taskId) ignoredTaskIds.delete(state.taskId)
      activeProgressTaskId = state.taskId
      progress.value = state.progress ?? (state.taskId
        ? { taskId: state.taskId, phase: 'discovering', checkedCount: 0, totalAudioCount: 0 }
        : undefined)
      scanning.value = true
      snapshotOperable.value = false
      errorMessage.value = ''
      statusMessage.value = t('song_organizer__status_scanning')
      return
    }

    scanning.value = false
    resetProgressTask()
    if (state.status == 'complete' && state.snapshot) {
      snapshot.value = state.snapshot
      snapshotOperable.value = !operating.value
      errorMessage.value = ''
      statusMessage.value = scanSummary(state.snapshot)
      return
    }
    if (state.snapshot?.status == 'complete') snapshot.value = state.snapshot
    snapshotOperable.value = state.snapshot?.status == 'complete' && !operating.value
    if (state.status == 'cancelled') {
      errorMessage.value = ''
      statusMessage.value = t('song_organizer__status_cancelled')
      return
    }
    errorMessage.value = state.errorMessage ?? t('song_organizer__status_failed')
    statusMessage.value = t('song_organizer__status_failed_with_reason', { reason: errorMessage.value })
  }

  const syncChangedRoot = () => {
    const currentRoot = normalizeSongOrganizerRoot(root.value)
    if (!capabilityReady.value || !supported.value || currentRoot == observedRoot) return
    if (operating.value) {
      clearForRootChange()
      return
    }
    observedRoot = currentRoot
    clearForRootChange()
    scanning.value = false
    resetProgressTask()
    statusMessage.value = t('song_organizer__status_scanning')
  }

  const chooseSpecifiedRoot = async() => {
    if (scanning.value || operating.value) return
    const selected = await selectRoot()
    if (!selected) return
    const changed = normalizeSongOrganizerRoot(selected) != normalizeSongOrganizerRoot(root.value)
    observedRoot = normalizeSongOrganizerRoot(selected)
    if (changed) {
      clearForRootChange()
      scanning.value = false
      resetProgressTask()
      statusMessage.value = t('song_organizer__status_scanning')
    }
    updateSetting({ 'songOrganizer.useCustomRoot': true, 'songOrganizer.customRoot': selected })
    if (!changed) void startSongOrganizerScan({ root: selected }).catch(() => {})
  }

  const useDownloadRoot = async() => {
    if (scanning.value || operating.value) return
    const downloadRoot = appSetting['download.savePath']
    const changed = normalizeSongOrganizerRoot(downloadRoot) != normalizeSongOrganizerRoot(root.value)
    observedRoot = normalizeSongOrganizerRoot(downloadRoot)
    if (changed) {
      clearForRootChange()
      scanning.value = false
      resetProgressTask()
      statusMessage.value = t('song_organizer__status_scanning')
    }
    updateSetting({ 'songOrganizer.useCustomRoot': false })
    if (!changed) void startSongOrganizerScan({ root: downloadRoot }).catch(() => {})
  }

  const reload = async() => {
    if (reloadControl.value.disabled || !root.value) return
    const scanRoot = root.value
    const taskId = nextOperationId(snapshot.value?.taskId ?? 'reload')
    scanning.value = true
    snapshotOperable.value = false
    validations.value = []
    errorMessage.value = ''
    statusMessage.value = t('song_organizer__status_scanning')
    resetProgressTask()
    activeProgressTaskId = taskId
    try {
      const nextSnapshot = await startSongOrganizerScan({ root: scanRoot, taskId })
      if (activeProgressTaskId != taskId || normalizeSongOrganizerRoot(scanRoot) != normalizeSongOrganizerRoot(root.value)) return
      if (nextSnapshot.status == 'complete') {
        snapshot.value = nextSnapshot
        snapshotOperable.value = true
        statusMessage.value = scanSummary(nextSnapshot)
      } else if (nextSnapshot.status == 'cancelled') {
        statusMessage.value = t('song_organizer__status_cancelled')
      }
    } catch (error) {
      if (activeProgressTaskId != taskId) return
      errorMessage.value = (error as Error).message
      statusMessage.value = t('song_organizer__status_failed_with_reason', { reason: errorMessage.value })
    } finally {
      if (activeProgressTaskId == taskId) {
        scanning.value = false
        resetProgressTask()
      }
      syncChangedRoot()
    }
  }

  const detailOperationResult = (operation: string, artistName: string, result: SongOrganizerOperationResult): string[] => {
    const summary = summarizeSongOrganizerOperation(result)
    const lines = [
      t('song_organizer__detail_operation', { operation, artist: artistName }),
      t('song_organizer__operation_summary', {
        succeeded: summary.succeeded.length,
        rolledBack: summary.rolledBack.length,
        skipped: summary.skipped.length,
        failed: summary.failed.length,
        rollback: summary.rollbackFailed.length,
      }),
    ]
    const append = (label: string, items: SongOrganizerOperationResult['succeeded']) => {
      for (const item of items) {
        lines.push(t('song_organizer__detail_operation_item', {
          status: label,
          path: item.path,
          target: item.targetPath ? ` → ${item.targetPath}` : '',
          reason: item.reason ? `；${item.reason}` : '',
        }))
      }
    }
    append(t('song_organizer__result_succeeded'), summary.succeeded)
    append(t('song_organizer__result_rolled_back'), summary.rolledBack)
    append(t('song_organizer__result_skipped'), summary.skipped)
    append(t('song_organizer__result_failed'), summary.failed)
    append(t('song_organizer__result_rollback_failed'), summary.rollbackFailed)
    return lines
  }

  const detailCleanupPreview = (row: SongOrganizerArtistRow, preview: SongOrganizerCleanupPreview): string[] => [
    t('song_organizer__detail_cleanup_preview', {
      artist: row.artist.name,
      count: preview.items.length,
      size: preview.totalSize,
      referencedItems: preview.referencedItemCount,
      referencedLists: preview.referencedListCount,
    }),
    ...preview.blockedArtists.flatMap(item => item.reasons.map(reason => t('song_organizer__detail_blocked', { reason }))),
    ...preview.items.map(item => t('song_organizer__detail_cleanup_item', {
      type: item.type,
      path: item.path,
      keep: item.keepPath ? `；${t('song_organizer__detail_keep_path', { path: item.keepPath })}` : '',
      referenced: item.referencedListCount ? `；${t('song_organizer__detail_referenced', { count: item.referencedListCount })}` : '',
    })),
  ]

  const showDetails = (row: SongOrganizerArtistRow) => {
    showDetailDialog(t('song_organizer__latest_detail'), buildSongOrganizerDetailLines(row, t))
  }

  const check = async(row: SongOrganizerArtistRow) => {
    if (!snapshot.value || !validatorAvailable.value || Boolean(row.checkDisabledReason) || scanning.value || operating.value) return
    const quickSnapshot = snapshot.value
    const checkTaskId = nextOperationId(quickSnapshot.taskId)
    scanning.value = true
    snapshotOperable.value = false
    errorMessage.value = ''
    statusMessage.value = t('song_organizer__status_checking', { artist: row.artist.name })
    resetProgressTask()
    activeProgressTaskId = checkTaskId
    try {
      const validation = await startSongOrganizerCheck({
        taskId: checkTaskId,
        quickSnapshotId: quickSnapshot.taskId,
        artistPath: row.artist.path,
      })
      const artistKey = normalizeSongOrganizerPathKey(row.artist.path)
      validations.value = [
        ...validations.value.filter(item => normalizeSongOrganizerPathKey(item.artistPath) != artistKey),
        validation,
      ]
      snapshotOperable.value = true
      statusMessage.value = t('song_organizer__status_check_complete', {
        artist: row.artist.name,
        songs: validation.totalAudioCount,
        anomalies: validation.snapshot.anomalies.length,
      })
    } catch (error) {
      errorMessage.value = (error as Error).message
      snapshotOperable.value = true
      statusMessage.value = t('song_organizer__status_failed_with_reason', { reason: errorMessage.value })
    } finally {
      scanning.value = false
      resetProgressTask()
      syncChangedRoot()
    }
  }

  const organize = async(row: SongOrganizerArtistRow) => {
    if (!snapshot.value || !row.validation || Boolean(row.organizeDisabledReason) || scanning.value || operating.value) return
    const sourceSnapshot = snapshot.value
    const sourceTaskId = sourceSnapshot.taskId
    const operationId = nextOperationId(sourceTaskId)
    const params = {
      ...createSongOrganizerApplyParams(sourceTaskId, [row.artist.path], currentPlayingPath(), operationId),
      validationId: row.validation.id,
    }
    operating.value = true
    snapshotOperable.value = false
    errorMessage.value = ''
    statusMessage.value = t('song_organizer__status_organizing', { artist: row.artist.name })
    resetProgressTask()
    try {
      const preview = await getSongOrganizerOrganizePreview(params)
      const previewLines = [
        t('song_organizer__detail_organize_preview', {
          artist: row.artist.name,
          cleanup: preview.items.length,
          rename: preview.renameSteps.length,
        }),
        ...detailCleanupPreview(row, preview),
      ]
      if (!preview.items.length && !preview.renameSteps.length) {
        statusMessage.value = t('song_organizer__nothing_to_organize')
        snapshotOperable.value = true
        return
      }
      if (preview.items.length) {
        const confirmed = await confirmDetailDialog(t('song_organizer__organize'), previewLines)
        if (!confirmed) {
          statusMessage.value = t('song_organizer__organize_cancelled')
          snapshotOperable.value = true
          return
        }
      }
      replaceOperationIssues(row.artist.path, [])
      activeOperation = { operationId, sourceTaskId, artistPath: row.artist.path }
      operationProgress.value = {
        operationId,
        sourceTaskId,
        type: 'organize',
        phase: 'preparing',
        artistPath: row.artist.path,
        completed: 0,
        total: preview.renameSteps.length,
      }
      const response = await applySongOrganizerOrganize({
        ...params,
        confirmedItemPaths: preview.items.map(item => item.path),
        playingFilePath: currentPlayingPath(),
      })
      retainOperationIssues(row, response.result, response.snapshot)
      validations.value = []
      if (operationProgress.value?.operationId == operationId) {
        operationProgress.value = { ...operationProgress.value, phase: 'completed', currentRelativeTarget: undefined }
      }
      showDetailDialog(
        t('song_organizer__latest_detail'),
        detailOperationResult(t('song_organizer__organize'), row.artist.name, response.result),
      )
      if (response.snapshot?.status == 'complete') {
        snapshot.value = response.snapshot
        snapshotOperable.value = true
        statusMessage.value = scanSummary(response.snapshot)
      } else {
        statusMessage.value = t('song_organizer__operation_rescan_failed')
      }
    } catch (error) {
      errorMessage.value = (error as Error).message
      replaceOperationIssues(row.artist.path, [buildSongOrganizerOperationErrorIssue(
        'organize',
        snapshot.value?.root ?? root.value,
        row.artist.path,
        errorMessage.value,
      )])
      if (operationProgress.value?.operationId == operationId) {
        operationProgress.value = { ...operationProgress.value, phase: 'failed', currentRelativeTarget: undefined }
      }
      statusMessage.value = t('song_organizer__status_failed_with_reason', { reason: errorMessage.value })
      showDetailDialog(t('song_organizer__latest_detail'), [
        t('song_organizer__detail_operation_error', {
          operation: t('song_organizer__organize'),
          artist: row.artist.name,
          reason: errorMessage.value,
        }),
      ])
    } finally {
      if (activeOperation?.operationId == operationId) activeOperation = undefined
      operating.value = false
      if (snapshot.value?.status == 'complete') snapshotOperable.value = true
      resetProgressTask()
      syncChangedRoot()
    }
  }

  const actionDisabledText = (
    reason: SongOrganizerActionDisabledReason | SongOrganizerOrganizeDisabledReason | undefined,
    row: SongOrganizerArtistRow,
    action: 'check' | 'organize',
  ): string => {
    if (!reason) return ''
    if (reason == 'blocked') {
      const reasons = action == 'check' ? [] : row.blockedReasons
      return reasons.join('；') || t('song_organizer__operation_blocked')
    }
    return t(`song_organizer__${reason}`)
  }

  const rollbackRecovery = async() => {
    if (!recovery.value) return
    const activeRecovery = recovery.value
    operating.value = true
    errorMessage.value = ''
    try {
      const result = await rollbackSongOrganizerRecovery(activeRecovery.operationId)
      showDetailDialog(
        t('song_organizer__latest_detail'),
        detailOperationResult(t('song_organizer__try_rollback'), activeRecovery.root, result),
      )
      const summary = summarizeSongOrganizerOperation(result)
      statusMessage.value = t('song_organizer__operation_summary', {
        succeeded: summary.succeeded.length,
        rolledBack: summary.rolledBack.length,
        skipped: summary.skipped.length,
        failed: summary.failed.length,
        rollback: summary.rollbackFailed.length,
      })
      if (!result.rollbackFailed.length) recovery.value = undefined
    } catch (error) {
      errorMessage.value = (error as Error).message
      statusMessage.value = t('song_organizer__status_failed_with_reason', { reason: errorMessage.value })
      showDetailDialog(t('song_organizer__latest_detail'), [
        t('song_organizer__detail_operation_error', {
          operation: t('song_organizer__try_rollback'),
          artist: activeRecovery.root,
          reason: errorMessage.value,
        }),
      ])
    } finally {
      operating.value = false
      syncChangedRoot()
    }
  }

  const dismissRecovery = async() => {
    if (!recovery.value) return
    await dismissSongOrganizerRecovery(recovery.value.operationId)
    recovery.value = undefined
  }

  onMounted(async() => {
    removeProgressListener = onSongOrganizerScanProgress(({ params }) => {
      if (ignoredTaskIds.has(params.taskId) || (!scanning.value && !operating.value)) return
      if (!activeProgressTaskId && operating.value) activeProgressTaskId = params.taskId
      if (params.taskId != activeProgressTaskId) return
      progress.value = params
    })
    removeOperationProgressListener = onSongOrganizerOperationProgress(({ params }) => {
      if (!shouldApplySongOrganizerOperationProgress(activeOperation, params)) return
      operationProgress.value = params
    })
    removeRuntimeStateListener = onSongOrganizerRuntimeStateChanged(({ params }) => {
      if (!capabilityReady.value) {
        if (!pendingRuntimeState || params.revision > pendingRuntimeState.revision) pendingRuntimeState = params
        return
      }
      if (supported.value) applyRuntimeState(params)
    })
    const runtimeStateResult = getSongOrganizerRuntimeState().then(
      state => ({ state }),
      error => ({ error: error as Error }),
    )
    try {
      const capability = await getSongOrganizerCapability()
      supported.value = capability.supported
      validatorAvailable.value = capability.validatorAvailable
      recovery.value = (await getSongOrganizerRecovery()) ?? undefined
    } catch (error) {
      errorMessage.value = (error as Error).message
    } finally {
      capabilityReady.value = true
    }
    const queriedRuntimeState = await runtimeStateResult
    if (!supported.value) return
    const latestRuntimeState = latestSongOrganizerRuntimeState(
      'state' in queriedRuntimeState ? queriedRuntimeState.state : undefined,
      pendingRuntimeState,
    )
    if (latestRuntimeState) applyRuntimeState(latestRuntimeState)
    else {
      errorMessage.value = 'error' in queriedRuntimeState ? queriedRuntimeState.error.message : ''
      observedRoot = normalizeSongOrganizerRoot(root.value)
      clearForRootChange()
      statusMessage.value = errorMessage.value
        ? t('song_organizer__status_failed_with_reason', { reason: errorMessage.value })
        : t('song_organizer__status_scanning')
    }
  })

  watch(root, () => {
    syncChangedRoot()
  })

  onActivated(() => {
    syncChangedRoot()
    detailDialogController.activate()
  })

  onDeactivated(() => {
    detailDialogController.deactivate()
  })

  onBeforeUnmount(() => {
    detailDialogController.dispose()
    removeProgressListener?.()
    removeOperationProgressListener?.()
    removeRuntimeStateListener?.()
  })

  return {
    actionDisabledText,
    artistRows,
    capabilityReady,
    check,
    checkProgressLabel,
    checkProgressTarget,
    chooseSpecifiedRoot,
    detailDialogConfirmation,
    detailDialogTitle,
    detailDialogVisible,
    detailLines,
    dismissRecovery,
    openDirInExplorer,
    operationProgress,
    operationProgressLabel,
    operationProgressTarget,
    operating,
    organize,
    recovery,
    reload,
    reloadControl,
    resolveDetailDialog,
    rollbackRecovery,
    root,
    scanning,
    showDetails,
    snapshot,
    supported,
    useDownloadRoot,
    validatorAvailable,
    visibleRecovery,
  }
}
