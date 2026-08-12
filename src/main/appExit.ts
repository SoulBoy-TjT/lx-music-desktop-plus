import { dialog } from 'electron'
import { log } from '@common/utils'
import { AppExitCoordinator } from '@main/modules/appExitCoordinator'
import { flacConverterService } from '@main/modules/flacConverter'
import { songOrganizerService } from '@main/modules/songOrganizer'
import { downloadAudioValidatorService } from '@main/modules/downloadAudioValidator'

export const appExitCoordinator = new AppExitCoordinator({
  isReadOperationRunning: () => songOrganizerService.isReadBusy(),
  getTerminationFailure: () => songOrganizerService.getTerminationFailure() ??
    flacConverterService.getTerminationFailure() ??
    downloadAudioValidatorService.getTerminationFailure(),
  isOrganizerMutationRunning: () => songOrganizerService.isBusy(),
  isFlacConversionRunning: () => flacConverterService.isBusy(),
  cancelFlacConversion: async() => { await flacConverterService.cancelAndWait('app-close') },
  beginDownloadValidationShutdown: () => { downloadAudioValidatorService.beginShutdown() },
  endDownloadValidationShutdown: () => { downloadAudioValidatorService.endShutdown() },
  isDownloadValidationRunning: () => downloadAudioValidatorService.isBusy(),
  cancelDownloadValidation: async() => { await downloadAudioValidatorService.cancelAndWait() },
  showOrganizerBusyWarning: async() => {
    await dialog.showMessageBox({
      type: 'warning',
      title: '歌曲整理进行中',
      message: '歌曲整理正在扫描、检查或修改磁盘，完成前不能退出应用。',
      buttons: ['知道了'],
    })
  },
  showExitFailureWarning: async() => {
    await dialog.showMessageBox({
      type: 'error',
      title: '无法安全退出',
      message: '音频处理未能安全结束，应用已保持运行。请稍后重试；若持续出现，请先结束残留的 FFmpeg 进程。',
      buttons: ['知道了'],
    })
  },
  reportError: error => { log.error('Application exit coordination failed:', error) },
})
