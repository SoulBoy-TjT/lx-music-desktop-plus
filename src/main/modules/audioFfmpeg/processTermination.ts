import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export interface AudioFfmpegTerminationOptions {
  platform?: NodeJS.Platform
  gracefulWaitMs?: number
  forceWaitMs?: number
  forceTerminate?: (pid: number) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
}

export class AudioFfmpegTerminationError extends Error {}

const defaultIsProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code != 'ESRCH'
  }
}

const taskkill = async(pid: number): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5_000,
    }, error => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

const forceTerminateProcess = async(pid: number, platform: NodeJS.Platform): Promise<void> => {
  if (platform == 'win32') {
    await taskkill(pid)
    return
  }
  process.kill(pid, 'SIGKILL')
}

const hasExited = (child: ChildProcess): boolean => child.exitCode != null || child.signalCode != null

const hasAlreadyClosed = (child: ChildProcess): boolean => {
  if (!hasExited(child)) return false
  const streams = [child.stdin, child.stdout, child.stderr].filter(stream => stream != null)
  return streams.every(stream => stream.closed)
}

const observeClose = (child: ChildProcess) => {
  let confirmed = hasAlreadyClosed(child)
  let resolveClose!: () => void
  const closed = new Promise<void>(resolve => { resolveClose = resolve })
  const onClose = () => {
    confirmed = true
    resolveClose()
  }
  if (confirmed) resolveClose()
  else child.once('close', onClose)

  return {
    isConfirmed: (): boolean => confirmed,
    wait: async(timeoutMs: number): Promise<boolean> => {
      if (confirmed) return true
      let timer!: NodeJS.Timeout
      return await Promise.race([
        closed.then(() => {
          clearTimeout(timer)
          return true
        }),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => { resolve(confirmed) }, timeoutMs)
        }),
      ])
    },
    dispose: (): void => { child.removeListener('close', onClose) },
  }
}

export const terminateAudioFfmpegProcess = async(
  child: ChildProcess,
  options: AudioFfmpegTerminationOptions = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform
  const gracefulWaitMs = options.gracefulWaitMs ?? 750
  const forceWaitMs = options.forceWaitMs ?? 2_000
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const forceTerminate = options.forceTerminate ?? (async pid => { await forceTerminateProcess(pid, platform) })
  const close = observeClose(child)

  try {
    if (close.isConfirmed()) return
    let gracefulAccepted = false
    try { gracefulAccepted = child.kill() } catch {}
    if (gracefulAccepted && await close.wait(gracefulWaitMs)) return

    const pid = child.pid
    if (pid == null) throw new AudioFfmpegTerminationError('FFmpeg 进程缺少 PID，无法确认已退出。')
    if (!isProcessAlive(pid)) {
      if (await close.wait(forceWaitMs)) return
      throw new AudioFfmpegTerminationError(`FFmpeg 进程 ${pid} 已退出，但未确认子进程 close。`)
    }

    let forceError: unknown
    try {
      await forceTerminate(pid)
    } catch (error) {
      forceError = error
    }
    if (await close.wait(forceWaitMs)) return
    if (!isProcessAlive(pid)) throw new AudioFfmpegTerminationError(`FFmpeg 进程 ${pid} 已退出，但未确认子进程 close。`)

    const detail = forceError instanceof Error ? `：${forceError.message}` : ''
    throw new AudioFfmpegTerminationError(`强制终止后 FFmpeg 进程 ${pid} 仍在运行${detail}`)
  } finally {
    close.dispose()
  }
}
