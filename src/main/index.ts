import { app } from 'electron'
import './utils/logInit'
import '@common/error'
import {
  initGlobalData,
  initSingleInstanceHandle,
  applyElectronEnvParams,
  setUserDataPath,
  registerDeeplink,
  listenerAppEvent,
} from './app'
import { isLinux, log } from '@common/utils'
import { initAppSetting } from '@main/app'
import registerModules from '@main/modules'
import { songOrganizerService } from '@main/modules/songOrganizer'
import { createSongOrganizerPrescanController } from '@main/modules/songOrganizer/startupRoot'

const songOrganizerPrescanController = createSongOrganizerPrescanController({
  platform: process.platform,
  arch: process.arch,
  getSetting: () => global.lx.appSetting,
  scan: async root => songOrganizerService.requestMainScan(root),
  onError: error => {
    log.error('Song organizer startup prescan failed:', error)
  },
})
let songOrganizerPrescanConfigListenerRegistered = false

const registerSongOrganizerPrescan = (): void => {
  if (!songOrganizerPrescanConfigListenerRegistered) {
    songOrganizerPrescanConfigListenerRegistered = true
    global.lx.event_app.on('updated_config', songOrganizerPrescanController.handleConfigChange)
  }
  songOrganizerPrescanController.start()
}

// 初始化应用
const init = () => {
  console.log('init')
  void initAppSetting().then(() => {
    registerModules()
    global.lx.event_app.app_inited()
    registerSongOrganizerPrescan()
  })
}

initGlobalData()
initSingleInstanceHandle()
applyElectronEnvParams()
setUserDataPath()
registerDeeplink(init)
listenerAppEvent(init)


// https://github.com/electron/electron/issues/16809
void app.whenReady().then(() => {
  isLinux ? setTimeout(init, 300) : init()
})
