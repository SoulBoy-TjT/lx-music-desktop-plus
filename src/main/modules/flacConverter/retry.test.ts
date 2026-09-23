import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlacConverterService } from './index'

// All filesystem calls are mocked: these tests never delete local files.
interface Entry { kind: 'directory' | 'file' | 'link', data: string }
const entries = new Map<string, Entry>()
const root = path.resolve('virtual-flac-retry')
const source = path.join(root, 'Singer')
const outputParent = path.join(root, 'exports')
const output = path.join(outputParent, 'Singer MP3（4首）')
const key = (value: string) => path.resolve(value)
const addDirectory = (value: string) => {
  const resolved = key(value)
  if (entries.has(resolved)) return
  const parent = path.dirname(resolved)
  if (parent != resolved) addDirectory(parent)
  entries.set(resolved, { kind: 'directory', data: '' })
}
const addFile = (value: string, data = 'source') => {
  addDirectory(path.dirname(value))
  entries.set(key(value), { kind: 'file', data })
}
const lookup = (value: unknown) => {
  const entry = entries.get(key(String(value)))
  if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  return entry
}

beforeEach(() => {
  entries.clear()
  for (const file of ['Album/broken.flac', 'Album/good.mp3', 'Other/keep.mp3', 'Album/Nested/keep.mp3']) addFile(path.join(source, file))
  for (const file of ['Album/broken.mp3', 'Album/good.mp3', 'Other/keep.mp3', 'Album/Nested/keep.mp3']) addFile(path.join(output, file), 'old')
  addFile(path.join(output, 'Album/cover.jpg'), 'cover')
  vi.spyOn(fs, 'lstat').mockImplementation(async value => {
    const entry = lookup(value)
    const stat = {
      isDirectory: () => entry.kind == 'directory',
      isFile: () => entry.kind == 'file',
      isSymbolicLink: () => entry.kind == 'link',
      ino: 1,
      dev: 1,
      size: entry.data.length,
      mtimeMs: 1,
    }
    return stat as Awaited<ReturnType<typeof fs.lstat>>
  })
  vi.spyOn(fs, 'readdir').mockImplementation((async(value: unknown) => {
    lookup(value)
    return [...entries].filter(([name]) => path.dirname(name) == key(String(value)) && name != key(String(value)))
      .map(([name, entry]) => ({ name: path.basename(name), isDirectory: () => entry.kind == 'directory' }))
  }) as unknown as typeof fs.readdir)
  vi.spyOn(fs, 'access').mockResolvedValue(undefined)
  vi.spyOn(fs, 'mkdir').mockImplementation((async(value: unknown) => { addDirectory(String(value)) }) as typeof fs.mkdir)
  vi.spyOn(fs, 'unlink').mockImplementation(async value => { entries.delete(key(String(value))) })
  vi.spyOn(fs, 'copyFile').mockImplementation(async(from, to) => { addFile(String(to), lookup(from).data) })
  vi.spyOn(fs, 'link').mockImplementation(async(from, to) => { addFile(String(to), lookup(from).data) })
  vi.spyOn(fs, 'rename').mockImplementation(async(from, to) => {
    for (const [name, entry] of [...entries]) {
      if (name == key(String(from)) || name.startsWith(key(String(from)) + path.sep)) {
        entries.set(key(String(to)) + name.slice(key(String(from)).length), entry)
        entries.delete(name)
      }
    }
  })
})

afterEach(() => { vi.restoreAllMocks() })

const makeService = () => {
  const convert = vi.fn(async(_from: string, to: string) => { addFile(to, 'new') })
  const service = new FlacConverterService('unused', async() => true, () => ({ convert }))
  vi.spyOn(service, 'capability').mockResolvedValue({ supported: true, platform: 'win32', arch: 'x64', ffmpegAvailable: true })
  return { service, convert }
}
const params = (retrySourcePaths = [path.join(source, 'Album/broken.flac')]) => ({
  sourceDirectory: source,
  outputParentDirectory: outputParent,
  confirmedSourcePaths: [],
  retrySourcePaths,
})

describe('scoped FLAC retry cleanup', () => {
  it('reuses and renames an album after its count suffix changes, without duplicate output', async() => {
    await fs.rename(path.join(source, 'Album'), path.join(source, 'Album (7首)'))
    await fs.rename(path.join(output, 'Album'), path.join(output, 'Album（8首）'))
    vi.mocked(fs.rename).mockClear()
    const { service, convert } = makeService()
    const request = { sourceDirectory: source, outputParentDirectory: outputParent }
    const preview = await service.preview(request)
    expect(preview.readyCount).toBe(0)
    expect(fs.rename).not.toHaveBeenCalled()
    const result = await service.convert({ ...request, confirmedSourcePaths: [] })
    expect(result.outputSongCount).toBe(4)
    expect(convert).not.toHaveBeenCalled()
    expect(lookup(path.join(output, 'Album (7首)/broken.mp3')).data).toBe('old')
    expect(entries.has(path.join(output, 'Album（8首）'))).toBe(false)
  })

  it('blocks coexisting album candidates before retry cleanup even when an exact name exists', async() => {
    addFile(path.join(output, 'Album (8首)/duplicate.mp3'))
    const { service, convert } = makeService()
    await expect(service.convert(params())).rejects.toThrow('多个专辑输出目录')
    expect(fs.unlink).not.toHaveBeenCalled()
    expect(fs.rename).not.toHaveBeenCalled()
    expect(convert).not.toHaveBeenCalled()
  })

  it('keeps unselected nested and sibling album names during scoped retry', async() => {
    await fs.rename(path.join(source, 'Album/Nested'), path.join(source, 'Album/Nested (1首)'))
    await fs.rename(path.join(source, 'Album'), path.join(source, 'Album (3首)'))
    await fs.rename(path.join(source, 'Other'), path.join(source, 'Other (1首)'))
    const { service } = makeService()
    const result = await service.convert(params([path.join(source, 'Album (3首)/broken.flac')]))
    expect(result.succeeded).toHaveLength(2)
    expect(lookup(path.join(output, 'Album (3首)/Nested/keep.mp3')).data).toBe('old')
    expect(lookup(path.join(output, 'Other/keep.mp3')).data).toBe('old')
  })

  it('synchronizes nested albums before parents in a normal conversion', async() => {
    await fs.rename(path.join(source, 'Album/Nested'), path.join(source, 'Album/Nested (1首)'))
    await fs.rename(path.join(source, 'Album'), path.join(source, 'Album (3首)'))
    const { service } = makeService()
    await service.convert({ sourceDirectory: source, outputParentDirectory: outputParent, confirmedSourcePaths: [] })
    expect(lookup(path.join(output, 'Album (3首)/Nested (1首)/keep.mp3')).data).toBe('old')
  })

  it.each(['source collision', 'output link', 'output file'])('blocks %s before renaming', async scenario => {
    if (scenario == 'source collision') addFile(path.join(source, 'Album (2首)/other.mp3'))
    else entries.set(path.join(output, 'Album'), { kind: scenario == 'output link' ? 'link' : 'file', data: '' })
    const { service } = makeService()
    await expect(service.convert(params())).rejects.toThrow()
    expect(fs.rename).not.toHaveBeenCalled()
    expect(fs.unlink).not.toHaveBeenCalled()
  })

  it('stops without conversion or cleanup when album rename fails', async() => {
    await fs.rename(path.join(source, 'Album'), path.join(source, 'Album (3首)'))
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('rename denied'))
    const { service, convert } = makeService()
    await expect(service.convert(params([path.join(source, 'Album (3首)/broken.flac')]))).rejects.toThrow('rename denied')
    expect(convert).not.toHaveBeenCalled()
    expect(fs.unlink).not.toHaveBeenCalled()
  })

  it('locates extra output and missing source files on a count mismatch', async() => {
    addFile(path.join(source, 'Missing.flac'))
    addFile(path.join(output, 'Extra.mp3'))
    addFile(path.join(output, 'Extra2.mp3'))
    const { service } = makeService()
    const result = await service.convert({ sourceDirectory: source, outputParentDirectory: outputParent, confirmedSourcePaths: [] })
    expect(result.extraOutputPaths).toEqual(expect.arrayContaining([
      path.join(result.outputDirectory, 'Extra.mp3'), path.join(result.outputDirectory, 'Extra2.mp3'),
    ]))
    expect(result.missingSourcePaths).toEqual([path.join(source, 'Missing.flac')])
  })

  it('clears only direct MP3 output and reconverts every song in deduplicated anomaly folders', async() => {
    const { service, convert } = makeService()
    const result = await service.convert(params([path.join(source, 'Album/broken.flac'), path.join(source, 'Album/good.mp3')]))
    expect(result.succeeded).toHaveLength(2)
    expect(result.skipped).toEqual([])
    expect(result.countMatches).toBe(true)
    expect(convert).toHaveBeenCalledTimes(1)
    expect(lookup(path.join(output, 'Album/broken.mp3')).data).toBe('new')
    expect(lookup(path.join(output, 'Album/good.mp3')).data).toBe('source')
    for (const file of ['Other/keep.mp3', 'Album/Nested/keep.mp3']) expect(lookup(path.join(output, file)).data).toBe('old')
    expect(lookup(path.join(output, 'Album/cover.jpg')).data).toBe('cover')
    expect(lookup(path.join(source, 'Album/broken.flac')).data).toBe('source')
    const deletedMp3s = vi.mocked(fs.unlink).mock.calls.map(([name]) => String(name)).filter(name => name.endsWith('.mp3'))
    expect(deletedMp3s.sort()).toEqual([path.join(output, 'Album/broken.mp3'), path.join(output, 'Album/good.mp3')].sort())
  })

  it('keeps child albums when an anomaly is directly in the artist root', async() => {
    addFile(path.join(source, 'root.flac'))
    addFile(path.join(output, 'root.mp3'), 'old')
    const { service } = makeService()
    const result = await service.convert(params([path.join(source, 'root.flac')]))
    expect(result.succeeded).toHaveLength(1)
    expect(lookup(path.join(result.outputDirectory, 'Album/good.mp3')).data).toBe('old')
    expect(lookup(path.join(result.outputDirectory, 'Other/keep.mp3')).data).toBe('old')
    expect(result.outputSongCount).toBe(5)
  })

  it.each(['outside', 'empty', 'junction', 'symlink'])('blocks %s before any cleanup', async scenario => {
    let retryPaths = [path.join(source, 'Album/broken.flac')]
    if (scenario == 'outside') retryPaths.push(path.join(root, 'outside/song.flac'))
    if (scenario == 'empty') {
      addDirectory(path.join(source, 'Empty'))
      retryPaths.push(path.join(source, 'Empty/missing.flac'))
    }
    if (scenario == 'junction') entries.set(path.join(output, 'Album'), { kind: 'link', data: '' })
    if (scenario == 'symlink') entries.set(path.join(output, 'Album/broken.mp3'), { kind: 'link', data: '' })
    const { service, convert } = makeService()
    await expect(service.convert(params(retryPaths))).rejects.toThrow()
    expect(fs.unlink).not.toHaveBeenCalled()
    expect(convert).not.toHaveBeenCalled()
    expect(service.isBusy()).toBe(false)
  })

  it('does not convert after cleanup fails', async() => {
    vi.mocked(fs.unlink).mockRejectedValueOnce(new Error('access denied'))
    const { service, convert } = makeService()
    await expect(service.convert(params())).rejects.toThrow('access denied')
    expect(convert).not.toHaveBeenCalled()
    expect(service.isBusy()).toBe(false)
  })
})
