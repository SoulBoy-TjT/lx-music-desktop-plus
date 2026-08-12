import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioFfmpegTerminationError } from '../audioFfmpeg/processTermination'
import { FfmpegAudioValidator } from './audioValidator'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn }))

const deferred = () => {
  let resolveDeferred!: () => void
  const promise = new Promise<void>(resolve => {
    resolveDeferred = resolve
  })
  return { promise, resolve: resolveDeferred }
}

describe('song organizer FFmpeg audio validator', () => {
  beforeEach(() => {
    spawn.mockReset()
  })

  it('waits for the killed FFmpeg child to close before settling cancellation', async() => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    spawn.mockReturnValue(child)
    const termination = deferred()
    const terminateProcess = vi.fn(async() => { await termination.promise })
    const controller = new AbortController()
    const validation = new FfmpegAudioValidator('ffmpeg.exe', 60_000, terminateProcess).validate('song.flac', controller.signal)
    controller.abort()
    const beforeClose = await Promise.race([
      validation.then(() => 'settled'),
      new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, 0)),
    ])

    expect(beforeClose).toBe('pending')
    termination.resolve()
    child.emit('close', null)
    await expect(validation).resolves.toMatchObject({ errorCode: 'scan_cancelled' })
    expect(terminateProcess).toHaveBeenCalledWith(child)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('rejects cancellation when the FFmpeg process exit cannot be confirmed', async() => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
    }
    child.stderr = new EventEmitter()
    child.kill = vi.fn()
    spawn.mockReturnValue(child)
    const terminationError = new AudioFfmpegTerminationError('FFmpeg still running')
    const terminateProcess = vi.fn(async() => { throw terminationError })
    const controller = new AbortController()
    const validation = new FfmpegAudioValidator('ffmpeg.exe', 60_000, terminateProcess).validate('song.flac', controller.signal)
    const outcomePromise = validation.then(
      value => ({ status: 'resolved' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    )

    controller.abort()
    const outcome = await Promise.race([
      outcomePromise,
      new Promise<{ status: 'pending' }>(resolve => setTimeout(() => { resolve({ status: 'pending' }) }, 0)),
    ])
    child.emit('close', null)

    expect(outcome).toEqual({ status: 'rejected', error: terminationError })
    expect(terminateProcess).toHaveBeenCalledWith(child)
  })
})
