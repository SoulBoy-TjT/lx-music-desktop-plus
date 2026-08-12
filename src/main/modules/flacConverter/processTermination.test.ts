import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateAudioFfmpegProcess } from '../audioFfmpeg/processTermination'

const createChild = (pid: number, killResult: boolean): ChildProcess => {
  const child = new EventEmitter() as ChildProcess
  Object.defineProperties(child, {
    pid: { value: pid },
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  })
  child.kill = () => killResult
  return child
}

afterEach(() => { vi.useRealTimers() })

describe('audio FFmpeg process termination', () => {
  it('observes close continuously while forced termination is in progress', async() => {
    vi.useFakeTimers()
    const child = createChild(2468, false)
    Object.defineProperty(child, 'stdout', {
      value: { closed: false, destroyed: false },
    })
    let alive = true
    const termination = terminateAudioFfmpegProcess(child, {
      platform: 'win32',
      gracefulWaitMs: 10,
      forceWaitMs: 20,
      forceTerminate: async() => {
        ;(child as ChildProcess & { exitCode: number | null }).exitCode = 1
        alive = false
        child.emit('close', 1, 'SIGKILL')
      },
      isProcessAlive: () => alive,
    })
    const completed = expect(termination).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(50)

    await completed
  })

  it('accepts a child that was already closed even when stdio references remain', async() => {
    vi.useFakeTimers()
    const child = createChild(1357, false)
    ;(child as ChildProcess & { exitCode: number | null }).exitCode = 0
    Object.defineProperty(child, 'stdout', {
      value: { closed: true, destroyed: true },
    })
    const kill = vi.spyOn(child, 'kill')
    const termination = terminateAudioFfmpegProcess(child, {
      platform: 'win32',
      gracefulWaitMs: 10,
      forceWaitMs: 20,
      forceTerminate: async() => {},
      isProcessAlive: () => false,
    })
    const completed = expect(termination).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(50)

    await completed
    expect(kill).not.toHaveBeenCalled()
  })

  it('accepts a force-stop only after the operating system confirms the process exited', async() => {
    vi.useFakeTimers()
    const child = createChild(1234, false)
    let alive = true
    let forceCount = 0
    const termination = terminateAudioFfmpegProcess(child, {
      platform: 'win32',
      gracefulWaitMs: 10,
      forceWaitMs: 20,
      forceTerminate: async() => {
        forceCount++
        alive = false
        ;(child as ChildProcess & { exitCode: number | null }).exitCode = 1
        child.emit('close', 1, 'SIGKILL')
      },
      isProcessAlive: () => alive,
    })

    await vi.advanceTimersByTimeAsync(20)
    await expect(termination).resolves.toBeUndefined()
    expect(forceCount).toBe(1)
  })

  it('fails explicitly when taskkill completes but the process is still alive', async() => {
    vi.useFakeTimers()
    const child = createChild(5678, false)
    const termination = terminateAudioFfmpegProcess(child, {
      platform: 'win32',
      gracefulWaitMs: 10,
      forceWaitMs: 20,
      forceTerminate: async() => {},
      isProcessAlive: () => true,
    })
    const rejected = expect(termination).rejects.toThrow('仍在运行')

    await vi.advanceTimersByTimeAsync(20)

    await rejected
  })
})
