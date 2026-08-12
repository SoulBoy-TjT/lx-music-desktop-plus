import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import { downloadAudioValidatorService, resolveDownloadAudioFfmpegPath } from '@main/modules/downloadAudioValidator'


export default () => {
  mainHandle<LX.Download.ListItem[]>(WIN_MAIN_RENDERER_EVENT_NAME.download_list_get, async() => {
    return global.lx.worker.dbService.getDownloadList()
  })
  mainHandle<LX.Download.saveDownloadMusicInfo>(WIN_MAIN_RENDERER_EVENT_NAME.download_list_add, async({ params: { list, addMusicLocationType } }) => {
    await global.lx.worker.dbService.downloadInfoSave(list, addMusicLocationType)
  })
  mainHandle<LX.Download.ListItem[]>(WIN_MAIN_RENDERER_EVENT_NAME.download_list_update, async({ params: list }) => {
    await global.lx.worker.dbService.downloadInfoUpdate(list)
  })
  mainHandle<string[]>(WIN_MAIN_RENDERER_EVENT_NAME.download_list_remove, async({ params: ids }) => {
    await global.lx.worker.dbService.downloadInfoRemove(ids)
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.download_list_clear, async() => {
    await global.lx.worker.dbService.downloadInfoClear()
  })
  mainHandle<string | null>(WIN_MAIN_RENDERER_EVENT_NAME.download_audio_validator_path_get, async() => {
    return await resolveDownloadAudioFfmpegPath()
  })
  mainHandle<string, undefined>(WIN_MAIN_RENDERER_EVENT_NAME.download_audio_task_reset, async({ params: taskId }) => {
    downloadAudioValidatorService.resetTask(taskId)
    return undefined
  })
  mainHandle<string, LX.Download.DownloadAudioLifecycleResult>(WIN_MAIN_RENDERER_EVENT_NAME.download_audio_task_begin, async({ params: taskId }) => {
    return downloadAudioValidatorService.beginTask(taskId)
  })
  mainHandle<string, boolean>(WIN_MAIN_RENDERER_EVENT_NAME.download_audio_task_cancelled_get, async({ params: taskId }) => {
    return downloadAudioValidatorService.isTaskCancelled(taskId)
  })
  mainHandle<LX.Download.DownloadAudioTaskFinishParams, undefined>(WIN_MAIN_RENDERER_EVENT_NAME.download_audio_task_finish, async({ params }) => {
    await downloadAudioValidatorService.finishTask(params.taskId, params.options)
    return undefined
  })
  mainHandle<LX.Download.DownloadAudioValidationParams, LX.Download.DownloadAudioValidationResult>(
    WIN_MAIN_RENDERER_EVENT_NAME.download_audio_validate,
    async({ params }) => downloadAudioValidatorService.validate(params),
  )
  mainHandle<string, boolean>(WIN_MAIN_RENDERER_EVENT_NAME.download_audio_validate_cancel, async({ params: taskId }) => {
    return await downloadAudioValidatorService.cancelAndWait(taskId)
  })
}
