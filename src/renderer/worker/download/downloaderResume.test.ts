import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Downloader from '@common/utils/download/Downloader'
import { STATUS } from '@common/utils/download/util'

const network = vi.hoisted(() => ({
  requestCount: 0,
  ranges: [] as Array<string | undefined>,
  responses: [] as EventEmitter[],
}))

vi.mock('@common/utils/download/request', async() => {
  const { EventEmitter } = await import('node:events')
  return {
    request: vi.fn((_url: string, options: { headers?: Record<string, string> }) => {
      const request = new EventEmitter() as EventEmitter & {
        destroyed: boolean
        destroy: () => void
        end: () => typeof request
      }
      request.destroyed = false
      request.destroy = () => {
        request.destroyed = true
        queueMicrotask(() => {
          request.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
        })
      }
      request.end = () => {
        network.requestCount++
        network.ranges.push(options.headers?.range)
        const response = Object.assign(new EventEmitter(), {
          statusCode: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-length': '20',
          },
          complete: false,
        })
        network.responses.push(response)
        queueMicrotask(() => { request.emit('response', response) })
        return request
      }
      return request
    }),
  }
})

const tempDirs: string[] = []
const activeTasks: Downloader[] = []

const createFakeWriteStream = (deferClose = false) => {
  const control: {
    closeStarted: boolean
    resolveClose?: () => void
  } = {
    closeStarted: false,
  }
  const stream = new EventEmitter() as EventEmitter & {
    close: (callback?: (error?: NodeJS.ErrnoException | null) => void) => void
    write: (chunk: Buffer, callback?: (error?: Error | null) => void) => boolean
  }
  stream.close = callback => {
    control.closeStarted = true
    const close = () => { queueMicrotask(() => { callback?.(null) }) }
    if (deferClose) control.resolveClose = close
    else close()
  }
  stream.write = (_chunk, callback) => {
    callback?.(null)
    return true
  }
  return { control, stream }
}

const startResumedTask = async(filePath: string) => {
  const task = new Downloader('https://example.test/audio', path.dirname(filePath), path.basename(filePath), {
    forceResume: true,
    timeout: 5_000,
    requestOptions: { method: 'get', headers: {} },
  })
  activeTasks.push(task)
  const responseObserved = new Promise<void>(resolve => { task.once('response', () => { resolve() }) })
  await task.start()
  await responseObserved
  return task
}

afterEach(async() => {
  await Promise.all(activeTasks.splice(0).map(async task => { await task.stop().catch(() => {}) }))
  await Promise.all(tempDirs.splice(0).map(async dir => rm(dir, { recursive: true, force: true })))
  network.requestCount = 0
  network.ranges.length = 0
  network.responses.length = 0
  vi.restoreAllMocks()
})

describe('Downloader resume mismatch handling', () => {
  it('reports the mismatch only after closing the write stream and leaves recovery to the caller', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-downloader-resume-error-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'track.part')
    const partial = Buffer.from('0123456789abcdefghij')
    await writeFile(filePath, partial)
    const writeStream = createFakeWriteStream(true)
    vi.spyOn(fs, 'createWriteStream')
      .mockReturnValueOnce(writeStream.stream as unknown as fs.WriteStream)
      .mockImplementation(() => createFakeWriteStream().stream as unknown as fs.WriteStream)
    const unlink = vi.spyOn(fs, 'unlink')
    const task = await startResumedTask(filePath)
    const onError = vi.fn()
    task.on('error', onError)

    network.responses[0].emit('data', Buffer.from('XXXXXXXXXX'))

    await vi.waitFor(() => { expect(writeStream.control.closeStarted).toBe(true) })
    expect(onError).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(network.requestCount).toBe(1)
    await expect(readFile(filePath)).resolves.toEqual(partial)

    writeStream.control.resolveClose?.()
    await vi.waitFor(() => { expect(onError).toHaveBeenCalledOnce() })

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Resume failed, response chunk does not match.',
    }))
    expect(task.status).toBe(STATUS.error)
    expect(unlink).not.toHaveBeenCalled()
    expect(network.requestCount).toBe(1)
    await expect(readFile(filePath)).resolves.toEqual(partial)
  })

  it('reports an incomplete response end exactly once instead of stopping', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-downloader-incomplete-end-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'track.part')
    await writeFile(filePath, Buffer.from('0123456789abcdefghij'))
    vi.spyOn(fs, 'createWriteStream')
      .mockReturnValue(createFakeWriteStream().stream as unknown as fs.WriteStream)
    const task = await startResumedTask(filePath)
    const onError = vi.fn()
    const onStop = vi.fn()
    task.on('error', onError)
    task.on('stop', onStop)

    network.responses[0].emit('end')

    await vi.waitFor(() => { expect(onError).toHaveBeenCalledOnce() })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'The connection was terminated while the message was still being sent',
    }))
    expect(onStop).not.toHaveBeenCalled()
    expect(task.status).toBe(STATUS.error)

    network.responses[0].emit('error', new Error('late response error'))
    await Promise.resolve()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('waits for the transfer stream to close before reporting a response error', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-downloader-error-close-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'track.part')
    await writeFile(filePath, Buffer.from('0123456789abcdefghij'))
    const writeStream = createFakeWriteStream(true)
    vi.spyOn(fs, 'createWriteStream')
      .mockReturnValue(writeStream.stream as unknown as fs.WriteStream)
    const task = await startResumedTask(filePath)
    const onError = vi.fn()
    task.on('error', onError)

    const responseError = Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
    network.responses[0].emit('error', responseError)

    const reportedBeforeClose = onError.mock.calls.length > 0
    expect(writeStream.control.closeStarted).toBe(true)
    writeStream.control.resolveClose?.()
    await vi.waitFor(() => { expect(onError).toHaveBeenCalledOnce() })
    expect(reportedBeforeClose).toBe(false)
    expect(onError).toHaveBeenCalledWith(responseError)
  })

  it('does not report a transport error after an explicit stop', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-downloader-stop-error-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'track.part')
    await writeFile(filePath, Buffer.from('0123456789abcdefghij'))
    vi.spyOn(fs, 'createWriteStream')
      .mockReturnValue(createFakeWriteStream().stream as unknown as fs.WriteStream)
    const task = await startResumedTask(filePath)
    const onError = vi.fn()
    task.on('error', onError)

    const stopping = task.stop()
    network.responses[0].emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
    await stopping
    await Promise.resolve()

    expect(onError).not.toHaveBeenCalled()
    expect(task.status).toBe(STATUS.stopped)
  })

  it('ignores a late error from an older download attempt', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-downloader-late-error-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'track.part')
    await writeFile(filePath, Buffer.from('0123456789abcdefghij'))
    vi.spyOn(fs, 'createWriteStream')
      .mockImplementation(() => createFakeWriteStream().stream as unknown as fs.WriteStream)
    const task = await startResumedTask(filePath)
    const firstResponse = network.responses[0]
    const onError = vi.fn()
    task.on('error', onError)

    firstResponse.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
    await vi.waitFor(() => { expect(onError).toHaveBeenCalledOnce() })
    const nextResponseObserved = new Promise<void>(resolve => { task.once('response', () => { resolve() }) })
    await task.start()
    await nextResponseObserved
    expect(task.status).toBe(STATUS.running)

    firstResponse.emit('error', new Error('late response error'))
    await Promise.resolve()

    expect(onError).toHaveBeenCalledOnce()
    expect(task.status).toBe(STATUS.running)
  })

  it('ignores a late file stat error from an older initialization attempt', async() => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lx-downloader-late-stat-'))
    tempDirs.push(dir)
    const task = new Downloader('https://example.test/audio', dir, 'track.part', {
      forceResume: true,
      timeout: 10,
      requestOptions: { method: 'get', headers: {} },
    })
    activeTasks.push(task)
    type StatCallback = (error: NodeJS.ErrnoException | null, stats?: fs.Stats) => void
    const statCallbacks: StatCallback[] = []
    vi.spyOn(fs, 'stat').mockImplementation(((_path: fs.PathLike, callback: StatCallback) => {
      statCallbacks.push(callback)
      if (statCallbacks.length === 2) {
        queueMicrotask(() => {
          callback(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        })
      }
    }) as typeof fs.stat)
    const onError = vi.fn()
    task.on('error', onError)

    const firstStart = task.start().catch(() => {})
    await vi.waitFor(() => { expect(onError).toHaveBeenCalledOnce() })
    const nextResponseObserved = new Promise<void>(resolve => { task.once('response', () => { resolve() }) })
    await task.start()
    await nextResponseObserved
    expect(task.status).toBe(STATUS.running)

    statCallbacks[0](Object.assign(new Error('late stat failure'), { code: 'EACCES' }))
    await firstStart
    await Promise.resolve()

    expect(onError).toHaveBeenCalledOnce()
    expect(task.status).toBe(STATUS.running)
  })
})
