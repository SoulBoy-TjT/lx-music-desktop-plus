import type {
  SongOrganizerAnomaly,
  SongOrganizerArtistRenamePlan,
  SongOrganizerArtistSummary,
  SongOrganizerOperationResult,
  SongOrganizerOperationStepPhase,
  SongOrganizerOperationStepResult,
  SongOrganizerScanProgress,
  SongOrganizerSnapshot,
  SongOrganizerValidationSnapshot,
} from '@common/songOrganizer'
import type { I18n } from '@root/lang'

export type SongOrganizerRowStatus = 'pending_cleanup' | 'pending_rename' | 'audio_anomaly' | 'cleanup_blocked' | 'rename_blocked' | 'blocked'
export type SongOrganizerActionDisabledReason = 'snapshot_outdated' | 'nothing_to_cleanup' | 'nothing_to_rename' | 'blocked'
export type SongOrganizerOrganizeDisabledReason = SongOrganizerActionDisabledReason | 'check_required'

export interface SongOrganizerArtistRow {
  artist: SongOrganizerArtistSummary
  renamePlan?: SongOrganizerArtistRenamePlan
  anomalies: SongOrganizerAnomaly[]
  cleanableAnomalies: SongOrganizerAnomaly[]
  audioAnomalyCount: number
  statuses: SongOrganizerRowStatus[]
  blockedReasons: string[]
  cleanupBlockedReasons: string[]
  renameBlockedReasons: string[]
  operationIssues: SongOrganizerOperationIssue[]
  cleanupDisabledReason?: SongOrganizerActionDisabledReason
  renameDisabledReason?: SongOrganizerActionDisabledReason
  validation?: SongOrganizerValidationSnapshot
  validationStatus: 'unchecked' | 'checked'
  checkDisabledReason?: SongOrganizerActionDisabledReason
  organizeDisabledReason?: SongOrganizerOrganizeDisabledReason
}

export interface SongOrganizerOperationSummary {
  succeeded: SongOrganizerOperationStepResult[]
  rolledBack: SongOrganizerOperationStepResult[]
  skipped: SongOrganizerOperationStepResult[]
  failed: SongOrganizerOperationStepResult[]
  rollbackFailed: SongOrganizerOperationStepResult[]
}

export interface SongOrganizerOperationIssue {
  operation: SongOrganizerOperationResult['type']
  phase: SongOrganizerOperationStepPhase
  status: Extract<SongOrganizerOperationStepResult['status'], 'skipped' | 'failed' | 'rollback_failed'>
  relativePath: string
  reason: string
}

export interface SongOrganizerCheckProgressView {
  checkedCount: number
  totalAudioCount: number
  currentPath?: string
}

export interface SongOrganizerReloadControl {
  disabled: boolean
}

export const buildSongOrganizerReloadControl = (state: {
  scanning: boolean
  operating: boolean
}): SongOrganizerReloadControl => ({ disabled: state.scanning || state.operating })

export const buildSongOrganizerCheckProgress = (
  progress?: SongOrganizerScanProgress,
): SongOrganizerCheckProgressView | undefined => progress?.phase == 'validating'
  ? {
      checkedCount: progress.checkedCount,
      totalAudioCount: progress.totalAudioCount,
      currentPath: progress.currentPath,
    }
  : undefined

export const normalizeSongOrganizerPathKey = (value: string): string => value
  .replace(/\\/g, '/')
  .replace(/\/+$/, '')
  .toLocaleLowerCase('en-US')

const relativeOperationPath = (root: string, target: string): string => {
  const normalizedRoot = root.replace(/[\\/]+$/, '')
  const normalizedTarget = target.replace(/[\\/]+$/, '')
  const rootKey = normalizeSongOrganizerPathKey(normalizedRoot)
  const targetKey = normalizeSongOrganizerPathKey(normalizedTarget)
  if (targetKey == rootKey) return '.'
  if (targetKey.startsWith(`${rootKey}/`)) return normalizedTarget.slice(normalizedRoot.length + 1)
  return target
}

export const buildSongOrganizerOperationIssues = (
  result: SongOrganizerOperationResult,
  root: string,
): SongOrganizerOperationIssue[] => {
  const issues: SongOrganizerOperationIssue[] = []
  const append = (items: SongOrganizerOperationStepResult[], fallbackPhase: SongOrganizerOperationStepPhase): void => {
    for (const item of items) {
      if (item.status == 'skipped' && !item.reason) continue
      if (item.status != 'skipped' && item.status != 'failed' && item.status != 'rollback_failed') continue
      issues.push({
        operation: result.type,
        phase: item.phase ?? fallbackPhase,
        status: item.status,
        relativePath: relativeOperationPath(root, item.path),
        reason: item.reason ?? '',
      })
    }
  }
  append(result.skipped, result.type == 'cleanup' ? 'cleanup' : 'renaming')
  append(result.failed, result.type == 'cleanup' ? 'cleanup' : 'renaming')
  append(result.rollbackFailed, 'rollback')
  return issues
}

export const buildSongOrganizerOperationErrorIssue = (
  operation: SongOrganizerOperationResult['type'],
  root: string,
  targetPath: string,
  reason: string,
): SongOrganizerOperationIssue => ({
  operation,
  phase: 'preparing',
  status: 'failed',
  relativePath: relativeOperationPath(root, targetPath),
  reason,
})

export const buildSongOrganizerDetailLines = (
  row: Pick<SongOrganizerArtistRow, 'anomalies' | 'blockedReasons'> & Partial<Pick<SongOrganizerArtistRow, 'operationIssues'>>,
  t: I18n['t'],
): string[] => {
  const lines = row.blockedReasons.map(reason => t('song_organizer__detail_blocked', { reason }))
  for (const anomaly of row.anomalies) {
    lines.push(t('song_organizer__detail_anomaly', {
      status: anomaly.status,
      type: t(`song_organizer__anomaly_type_${anomaly.type}`),
      size: anomaly.size,
      path: anomaly.relativePath,
      reason: anomaly.reason ? `；${anomaly.reason}` : '',
    }))
  }
  for (const issue of row.operationIssues ?? []) {
    lines.push(t('song_organizer__detail_operation_issue', {
      operation: t(`song_organizer__${issue.operation}`),
      phase: t(`song_organizer__operation_phase_${issue.phase}`),
      status: t(`song_organizer__result_${issue.status}`),
      path: issue.relativePath,
      reason: issue.reason ? `；${issue.reason}` : '',
    }))
  }
  return lines.length ? lines : [t('song_organizer__detail_no_extra')]
}

const cleanableTypes = new Set<SongOrganizerAnomaly['type']>([
  'unsupported_file',
  'duplicate_hardlink',
  'reparse_point',
  'empty_directory',
])

export const isPathInDirectory = (directoryPath: string, targetPath?: string): boolean => {
  if (!targetPath) return false
  const directory = normalizeSongOrganizerPathKey(directoryPath)
  const target = normalizeSongOrganizerPathKey(targetPath)
  return target == directory || target.startsWith(`${directory}/`)
}

const uniqueReasons = (reasons: Array<string | undefined>): string[] => [...new Set(reasons.filter((reason): reason is string => Boolean(reason)))]

export const summarizeSongOrganizerOperation = (result: SongOrganizerOperationResult): SongOrganizerOperationSummary => {
  const steps = [...result.succeeded, ...result.skipped, ...result.failed, ...result.rollbackFailed]
  return {
    succeeded: steps.filter(step => step.status == 'succeeded'),
    rolledBack: steps.filter(step => step.status == 'rolled_back'),
    skipped: steps.filter(step => step.status == 'skipped'),
    failed: steps.filter(step => step.status == 'failed'),
    rollbackFailed: steps.filter(step => step.status == 'rollback_failed'),
  }
}

export const buildSongOrganizerArtistRows = (
  snapshot: SongOrganizerSnapshot | undefined,
  options: {
    snapshotOperable: boolean
    playingFilePath?: string
    playingBlockedReason: string
    operationIssuesByArtist?: ReadonlyMap<string, SongOrganizerOperationIssue[]>
    validations?: SongOrganizerValidationSnapshot[]
  },
): SongOrganizerArtistRow[] => {
  if (!snapshot) return []
  const renamePlans = new Map(snapshot.renamePlan.map(plan => [plan.artistPath, plan]))
  const anomaliesByArtist = new Map<string, SongOrganizerAnomaly[]>()
  for (const anomaly of snapshot.anomalies) {
    const anomalies = anomaliesByArtist.get(anomaly.artistPath) ?? []
    anomalies.push(anomaly)
    anomaliesByArtist.set(anomaly.artistPath, anomalies)
  }
  const operationIssuesByArtist = new Map<string, SongOrganizerOperationIssue[]>()
  for (const [artistPath, issues] of options.operationIssuesByArtist ?? []) {
    operationIssuesByArtist.set(normalizeSongOrganizerPathKey(artistPath), issues)
  }
  const validationsByArtist = new Map((options.validations ?? [])
    .filter(validation => validation.quickSnapshotId == snapshot.taskId)
    .map(validation => [normalizeSongOrganizerPathKey(validation.artistPath), validation]))

  return snapshot.artists.map(artist => {
    const validation = validationsByArtist.get(normalizeSongOrganizerPathKey(artist.path))
    const checkedArtist = validation?.snapshot.artists.find(item =>
      normalizeSongOrganizerPathKey(item.path) == normalizeSongOrganizerPathKey(artist.path))
    const effectiveArtist = checkedArtist ?? artist
    const renamePlan = validation?.snapshot.renamePlan.find(plan =>
      normalizeSongOrganizerPathKey(plan.artistPath) == normalizeSongOrganizerPathKey(artist.path)) ?? renamePlans.get(artist.path)
    const anomalies = validation
      ? validation.snapshot.anomalies.filter(anomaly =>
        normalizeSongOrganizerPathKey(anomaly.artistPath) == normalizeSongOrganizerPathKey(artist.path))
      : (anomaliesByArtist.get(artist.path) ?? [])
    const operationIssues = operationIssuesByArtist.get(normalizeSongOrganizerPathKey(artist.path)) ?? []
    const cleanableAnomalies = anomalies.filter(anomaly => cleanableTypes.has(anomaly.type) && anomaly.cleanupEligible !== false)
    const uncleanableCleanupAnomalies = anomalies.filter(anomaly => cleanableTypes.has(anomaly.type) && anomaly.cleanupEligible === false)
    const audioAnomalyCount = anomalies.filter(anomaly => anomaly.type == 'unplayable_audio' || anomaly.type == 'audio_check_failed').length
    const playingBlocked = isPathInDirectory(artist.path, options.playingFilePath)
    const cleanupBlockedReasons = uniqueReasons(uncleanableCleanupAnomalies.map(anomaly => anomaly.reason || anomaly.status))
    const renameBlockedReasons = uniqueReasons([
      ...effectiveArtist.blockedReasons,
      ...(renamePlan?.blockedReasons ?? []),
      playingBlocked ? options.playingBlockedReason : undefined,
    ])
    const blockedReasons = uniqueReasons([...cleanupBlockedReasons, ...renameBlockedReasons])
    const statuses: SongOrganizerRowStatus[] = []
    if (cleanableAnomalies.length) statuses.push('pending_cleanup')
    if (renamePlan?.steps.length) statuses.push('pending_rename')
    if (audioAnomalyCount) statuses.push('audio_anomaly')
    const cleanupFullyBlocked = cleanupBlockedReasons.length > 0 && cleanableAnomalies.length == 0
    if (cleanupFullyBlocked && renameBlockedReasons.length) statuses.push('blocked')
    else {
      if (cleanupBlockedReasons.length) statuses.push('cleanup_blocked')
      if (renameBlockedReasons.length) statuses.push('rename_blocked')
    }

    let cleanupDisabledReason: SongOrganizerActionDisabledReason | undefined
    if (!options.snapshotOperable) cleanupDisabledReason = 'snapshot_outdated'
    else if (!cleanableAnomalies.length) cleanupDisabledReason = cleanupBlockedReasons.length ? 'blocked' : 'nothing_to_cleanup'

    let renameDisabledReason: SongOrganizerActionDisabledReason | undefined
    if (!options.snapshotOperable) renameDisabledReason = 'snapshot_outdated'
    else if (renameBlockedReasons.length) renameDisabledReason = 'blocked'
    else if (!renamePlan?.steps.length) renameDisabledReason = 'nothing_to_rename'

    const checkDisabledReason = options.snapshotOperable ? undefined : 'snapshot_outdated'
    let organizeDisabledReason: SongOrganizerOrganizeDisabledReason | undefined
    if (!options.snapshotOperable) organizeDisabledReason = 'snapshot_outdated'
    else if (!validation) organizeDisabledReason = 'check_required'
    else if (!cleanableAnomalies.length && renameBlockedReasons.length) organizeDisabledReason = 'blocked'
    else if (!cleanableAnomalies.length && !renamePlan?.steps.length) organizeDisabledReason = 'nothing_to_rename'

    return {
      artist: effectiveArtist,
      renamePlan,
      anomalies,
      cleanableAnomalies,
      audioAnomalyCount,
      statuses,
      blockedReasons,
      cleanupBlockedReasons,
      renameBlockedReasons,
      operationIssues,
      cleanupDisabledReason,
      renameDisabledReason,
      validation,
      validationStatus: validation ? 'checked' : 'unchecked',
      checkDisabledReason,
      organizeDisabledReason,
    }
  })
}
