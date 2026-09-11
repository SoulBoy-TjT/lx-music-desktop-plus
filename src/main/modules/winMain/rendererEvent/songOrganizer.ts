import { mainHandle, mainOn } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import type {
  SongOrganizerApplyParams,
  SongOrganizerCapability,
  SongOrganizerOperationProgress,
  SongOrganizerScanParams,
  SongOrganizerSnapshot,
  SongOrganizerOperationResult,
  SongOrganizerOrganizeApplyParams,
  SongOrganizerOrganizePreview,
  SongOrganizerRuntimeState,
} from '@common/songOrganizer'
import { songOrganizerService, type ApplyResult } from '@main/modules/songOrganizer'
import type { SongOrganizerJournal } from '@main/modules/songOrganizer/operationJournal'
import { resolveSongOrganizerRoot } from '@common/songOrganizerRoot'
import { canStartSongOrganizerPrescan } from '@main/modules/songOrganizer/startupRoot'
import { sendEvent } from '../main'

export default () => {
  songOrganizerService.setProgressListener(progress => {
    sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_scan_progress, progress)
  })
  songOrganizerService.setOperationProgressListener((progress: SongOrganizerOperationProgress) => {
    sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_operation_progress, progress)
  })
  songOrganizerService.setStateListener(state => {
    sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_state_changed, state)
  })
  mainHandle<never, SongOrganizerCapability>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_capability_get, async() => songOrganizerService.capability())
  mainHandle<SongOrganizerScanParams, SongOrganizerSnapshot>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_scan_start, async({ params }) => songOrganizerService.scan(params))
  mainHandle<string | undefined, SongOrganizerSnapshot | undefined>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_snapshot_get, async({ params }) => songOrganizerService.getSnapshot(params))
  mainHandle<never, SongOrganizerRuntimeState>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_state_get, async() => songOrganizerService.getRuntimeState())
  mainOn<string | null>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_playing_path_set, ({ params }) => {
    songOrganizerService.setPlayingFilePath(params ?? undefined)
  })
  mainOn(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_download_occupancy_changed, () => {
    if (!canStartSongOrganizerPrescan(process.platform, process.arch)) return
    const root = resolveSongOrganizerRoot(global.lx.appSetting)
    if (root) songOrganizerService.notifyDownloadOccupancyChanged(root)
  })
  mainHandle<SongOrganizerApplyParams, SongOrganizerOrganizePreview>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_organize_preview, async({ params }) => songOrganizerService.organizePreview(params))
  mainHandle<SongOrganizerOrganizeApplyParams, ApplyResult>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_organize_apply, async({ params }) => songOrganizerService.organize(params))
  mainHandle<never, SongOrganizerJournal | null>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_recovery_get, async() => songOrganizerService.recovery())
  mainHandle<string, SongOrganizerOperationResult>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_recovery_rollback, async({ params }) => songOrganizerService.rollbackRecovery(params))
  mainHandle<string, boolean>(WIN_MAIN_RENDERER_EVENT_NAME.song_organizer_recovery_dismiss, async({ params }) => songOrganizerService.dismissRecovery(params))
}
