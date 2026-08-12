import { describe, expect, it, vi } from 'vitest'
import {
  canStartSongOrganizerPrescan,
  createSongOrganizerPrescanController,
  resolveSongOrganizerStartupRoot,
} from './startupRoot'

describe('song organizer startup root', () => {
  it('uses a non-empty custom root when custom mode is enabled', () => {
    expect(resolveSongOrganizerStartupRoot({
      'download.savePath': 'C:\\Download',
      'songOrganizer.useCustomRoot': true,
      'songOrganizer.customRoot': '  D:\\Music  ',
    })).toBe('D:\\Music')
  })

  it('falls back to the download root when custom mode is disabled or empty', () => {
    expect(resolveSongOrganizerStartupRoot({
      'download.savePath': ' C:\\Download ',
      'songOrganizer.useCustomRoot': false,
      'songOrganizer.customRoot': 'D:\\Music',
    })).toBe('C:\\Download')
    expect(resolveSongOrganizerStartupRoot({
      'download.savePath': 'C:\\Download',
      'songOrganizer.useCustomRoot': true,
      'songOrganizer.customRoot': '   ',
    })).toBe('C:\\Download')
  })

  it('only enables startup prescan on Windows x64', () => {
    expect(canStartSongOrganizerPrescan('win32', 'x64')).toBe(true)
    expect(canStartSongOrganizerPrescan('win32', 'arm64')).toBe(false)
    expect(canStartSongOrganizerPrescan('linux', 'x64')).toBe(false)
  })

  it('rescans in Main when a relevant root setting changes and ignores duplicate roots', () => {
    const setting = {
      'download.savePath': 'C:\\Download',
      'songOrganizer.useCustomRoot': false,
      'songOrganizer.customRoot': '',
    }
    const scan = vi.fn(async(_root: string) => {})
    const controller = createSongOrganizerPrescanController({
      platform: 'win32',
      arch: 'x64',
      getSetting: () => setting,
      scan,
      onError: vi.fn(),
    })

    controller.start()
    controller.start()
    controller.handleConfigChange(['common.langId'])
    setting['download.savePath'] = 'D:\\Music'
    controller.handleConfigChange(['download.savePath'])
    setting['songOrganizer.useCustomRoot'] = true
    controller.handleConfigChange(['songOrganizer.useCustomRoot'])
    setting['songOrganizer.customRoot'] = 'E:\\Library'
    controller.handleConfigChange(['songOrganizer.customRoot'])

    expect(scan.mock.calls.map(([root]) => root)).toEqual([
      'C:\\Download',
      'D:\\Music',
      'E:\\Library',
    ])
  })

  it('does not start background scans on unsupported platforms', () => {
    const scan = vi.fn(async(_root: string) => {})
    const controller = createSongOrganizerPrescanController({
      platform: 'linux',
      arch: 'x64',
      getSetting: () => ({
        'download.savePath': '/music',
        'songOrganizer.useCustomRoot': false,
        'songOrganizer.customRoot': '',
      }),
      scan,
      onError: vi.fn(),
    })

    controller.start()
    controller.handleConfigChange(['download.savePath'])

    expect(scan).not.toHaveBeenCalled()
  })
})
