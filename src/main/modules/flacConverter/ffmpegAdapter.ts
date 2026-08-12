import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { AudioFfmpegTerminationError, terminateAudioFfmpegProcess } from '../audioFfmpeg/processTermination'

const stderrLimit = 16_384

export const buildFlacConversionArgs = (sourcePath: string, targetPath: string, includeCover = true): string[] => [
  '-v', 'error',
  '-nostdin',
  '-y',
  '-i', sourcePath,
  '-map', '0:a:0',
  ...(includeCover ? ['-map', '0:v?'] : ['-vn']),
  '-map_metadata', '0',
  '-c:a', 'libmp3lame',
  '-b:a', '320k',
  ...(includeCover ? ['-c:v', 'copy', '-disposition:v', 'attached_pic'] : []),
  '-id3v2_version', '3',
  '-f', 'mp3',
  targetPath,
]

const abortError = (signal: AbortSignal): Error => signal.reason instanceof Error
  ? signal.reason
  : new Error(String(signal.reason ?? 'FLAC 转换已取消。'))

const runFfmpeg = async(
  ffmpegPath: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  spawnProcess: typeof spawn,
  terminateProcess: (child: ChildProcess) => Promise<void>,
): Promise<void> => {
  if (signal?.aborted) throw abortError(signal)
  return new Promise((resolve, reject) => {
    let stderr = ''
    let settled = false
    let terminationError: Error | undefined
    const child = spawnProcess(ffmpegPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve()
    }
    const terminate = (error: Error) => {
      if (terminationError) return
      terminationError = error
      void terminateProcess(child).then(
        () => { finish(terminationError) },
        terminateError => {
          finish(terminateError instanceof AudioFfmpegTerminationError
            ? terminateError
            : new AudioFfmpegTerminationError((terminateError as Error).message))
        },
      )
    }
    const onAbort = () => { terminate(abortError(signal!)) }
    const timer = setTimeout(() => { terminate(new Error('FLAC 转 MP3 超时。')) }, timeoutMs)
    child.stderr?.on('data', chunk => {
      if (stderr.length < stderrLimit) stderr += String(chunk).slice(0, stderrLimit - stderr.length)
    })
    child.once('error', error => {
      if (!terminationError) finish(error)
    })
    child.once('close', code => {
      if (terminationError) {
        finish(terminationError)
        return
      }
      if (code == 0) {
        finish()
        return
      }
      finish(new Error(stderr.trim() || `FFmpeg 退出码：${code ?? 'unknown'}`))
    })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class FfmpegFlacConverter {
  constructor(
    private readonly ffmpegPath: string,
    private readonly timeoutMs = 60 * 60 * 1000,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly terminateProcess: (child: ChildProcess) => Promise<void> = terminateAudioFfmpegProcess,
  ) {}

  async convert(sourcePath: string, targetPath: string, signal?: AbortSignal): Promise<void> {
    try {
      await runFfmpeg(this.ffmpegPath, buildFlacConversionArgs(sourcePath, targetPath), this.timeoutMs, signal, this.spawnProcess, this.terminateProcess)
    } catch (coverError) {
      if (signal?.aborted) throw coverError
      if (coverError instanceof AudioFfmpegTerminationError) throw coverError
      try {
        await runFfmpeg(this.ffmpegPath, buildFlacConversionArgs(sourcePath, targetPath, false), this.timeoutMs, signal, this.spawnProcess, this.terminateProcess)
      } catch (audioOnlyError) {
        throw new Error(`保留封面转换失败：${(coverError as Error).message}；纯音频重试失败：${(audioOnlyError as Error).message}`)
      }
    }
  }
}
