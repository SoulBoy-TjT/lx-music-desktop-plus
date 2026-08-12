import { describe, expect, it } from 'vitest'
import migrateSetting from './migrateSetting'

describe('download setting migration', () => {
  it.each([
    [true, 'playlist'],
    [false, 'root'],
  ] as const)('migrates the legacy playlist grouping flag %s', (legacyValue, expectedMode) => {
    const setting = migrateSetting({
      version: '2.1.0',
      'download.isSavePathGroupByListName': legacyValue,
    }) as Record<string, unknown>

    expect(setting.version).toBe('2.2.0')
    expect(setting['download.savePathMode']).toBe(expectedMode)
    expect(setting).not.toHaveProperty('download.isSavePathGroupByListName')
  })
})
