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
      request.destroy = () => { request.destroyed = true }
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
})
