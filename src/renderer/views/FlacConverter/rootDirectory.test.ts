import { describe, expect, it } from 'vitest'
import { resolveFlacConverterRootDirectory } from './rootDirectory'

describe('FLAC converter root directory', () => {
  it('uses the current download directory by default', () => {
    expect(resolveFlacConverterRootDirectory(' C:\\Music\\Downloads ', '')).toBe('C:\\Music\\Downloads')
  })

  it('keeps a selected directory independent from download setting changes', () => {
    const customDirectory = ' D:\\Lossless '

    expect(resolveFlacConverterRootDirectory('C:\\Music\\Old', customDirectory)).toBe('D:\\Lossless')
    expect(resolveFlacConverterRootDirectory('C:\\Music\\New', customDirectory)).toBe('D:\\Lossless')
    expect(resolveFlacConverterRootDirectory('C:\\Music\\New', '')).toBe('C:\\Music\\New')
  })
})
