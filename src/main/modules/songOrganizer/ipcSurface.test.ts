import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = async(relativePath: string): Promise<string> => fs.readFile(path.join(process.cwd(), relativePath), 'utf8')

describe('song organizer IPC surface', () => {
  it('exposes direct organize operations without a user or exit cancellation surface', async() => {
    const [names, mainHandlers, rendererWrappers, organizerView, organizerComposable, exitCoordinator, appExit] = await Promise.all([
      readSource('src/common/ipcNames.ts'),
      readSource('src/main/modules/winMain/rendererEvent/songOrganizer.ts'),
      readSource('src/renderer/utils/ipc.ts'),
      readSource('src/renderer/views/SongOrganizer/index.vue'),
      readSource('src/renderer/views/SongOrganizer/useSongOrganizer.ts'),
      readSource('src/main/modules/appExitCoordinator.ts'),
      readSource('src/main/appExit.ts'),
    ])

    for (const legacyName of [
      'song_organizer_cleanup_preview',
      'song_organizer_cleanup_apply',
      'song_organizer_rename_apply',
      'song_organizer_scan_cancel',
      'song_organizer_check_start',
    ]) {
      expect(names).not.toContain(legacyName)
      expect(mainHandlers).not.toContain(legacyName)
      expect(rendererWrappers).not.toContain(legacyName)
    }
    for (const legacyWrapper of [
      'getSongOrganizerCleanupPreview',
      'applySongOrganizerCleanup',
      'applySongOrganizerRename',
      'cancelSongOrganizerScan',
      'startSongOrganizerCheck',
    ]) expect(rendererWrappers).not.toContain(legacyWrapper)
    expect(organizerView).not.toContain('@click="check(row)"')
    expect(organizerView).not.toContain('row.validationStatus')
    expect(organizerView).not.toContain('cancelScan')
    expect(organizerView).not.toContain('song_organizer__cancel')
    expect(organizerComposable).not.toContain('cancelSongOrganizerScan')
    expect(exitCoordinator).not.toContain('cancelReadOperationsAndWait')
    expect(appExit).not.toContain('cancelReadOperationsAndWait')
    expect(appExit).toContain('歌曲整理正在扫描或修改磁盘')
  })
})
