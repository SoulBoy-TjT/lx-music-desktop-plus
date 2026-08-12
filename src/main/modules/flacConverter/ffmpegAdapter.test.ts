import { EventEmitter } from 'node:events'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioFfmpegTerminationError } from '../audioFfmpeg/processTermination'
import { FfmpegFlacConverter } from './ffmpegAdapter'

const createChild = (): ChildProcess => {
  const child = new EventEmitter() as ChildProcess
  child.stderr = new EventEmitter() as ChildProcess['stderr']
  return child
}

afterEach(() => { vi.useRealTimers() })

describe('FFmpeg FLAC converter cancellation', () => {
  it('terminates the active child, waits for close, and does not start the fallback attempt', async() => {
    const child = createChild()
    let spawnedCount = 0
    let killed = false
    child.kill = () => {
      killed = true
      return true
    }
    const spawnProcess = (() => {
      spawnedCount++
      return child
    }) as typeof spawn
    const converter = new FfmpegFlacConverter('unused', 60_000, spawnProcess)
    const controller = new AbortController()

    const conversion = converter.convert('source.flac', 'target.tmp', controller.signal)
    controller.abort('app-close')
    await Promise.resolve()

    expect(killed).toBe(true)
    let settled = false
    void conversion.catch(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('close', null)

    await expect(conversion).rejects.toThrow('app-close')
    expect(spawnedCount).toBe(1)
  })

  it('does not start FFmpeg when cancellation already won the race', async() => {
    let spawnedCount = 0
    const spawnProcess = (() => {
      spawnedCount++
      return createChild()
    }) as typeof spawn
    const converter = new FfmpegFlacConverter('unused', 60_000, spawnProcess)
    const controller = new AbortController()
    controller.abort('app-close')

    await expect(converter.convert('source.flac', 'target.tmp', controller.signal)).rejects.toThrow('app-close')
    expect(spawnedCount).toBe(0)
  })

  it('reports termination failure instead of treating a missing close as safe', async() => {
    vi.useFakeTimers()
    const child = createChild()
    const spawnProcess = (() => child) as typeof spawn
    const terminateProcess = async() => { throw new Error('无法确认 FFmpeg 已退出。') }
    const converter = new FfmpegFlacConverter('unused', 60_000, spawnProcess, terminateProcess)
    const controller = new AbortController()
    const conversion = converter.convert('source.flac', 'target.tmp', controller.signal)
    const rejected = expect(conversion).rejects.toThrow('无法确认 FFmpeg 已退出。')

    controller.abort('app-close')
    await vi.runAllTimersAsync()

    await rejected
  })

  it('does not retry without cover after an unconfirmed timeout termination', async() => {
    const child = createChild()
    let spawnedCount = 0
    const spawnProcess = (() => {
      spawnedCount++
      return child
    }) as typeof spawn
    const terminateProcess = async() => { throw new AudioFfmpegTerminationError('FFmpeg still running') }
    const converter = new FfmpegFlacConverter('unused', 1, spawnProcess, terminateProcess)

    await expect(converter.convert('source.flac', 'target.tmp')).rejects.toThrow('FFmpeg still running')
    expect(spawnedCount).toBe(1)
  })
})
