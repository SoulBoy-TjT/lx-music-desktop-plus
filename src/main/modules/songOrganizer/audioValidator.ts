import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { AudioValidationResult } from '@common/songOrganizer'
import { isAudioFfmpegAvailable, resolveBundledAudioFfmpegPath } from '../audioFfmpeg'
import { AudioFfmpegTerminationError, terminateAudioFfmpegProcess } from '../audioFfmpeg/processTermination'

export interface AudioValidator {
  validate: (filePath: string, signal: AbortSignal) => Promise<AudioValidationResult>
}

export class ValidatorUnavailableError extends Error {
  code = 'validator_unavailable'
}

export const resolveFfmpegPath = resolveBundledAudioFfmpegPath
export const isFfmpegAvailable = isAudioFfmpegAvailable

const isDecodeError = (message: string): boolean => /invalid data|error while decoding|could not find codec parameters|failed to read|end of file|moov atom not found|header missing|invalid argument/iu.test(message)

export class FfmpegAudioValidator implements AudioValidator {
  constructor(
    private readonly ffmpegPath: string,
    private readonly timeoutMs = 15 * 60 * 1000,
    private readonly terminateProcess: (child: ChildProcess) => Promise<void> = terminateAudioFfmpegProcess,
  ) {}

  async validate(filePath: string, signal: AbortSignal): Promise<AudioValidationResult> {
    return new Promise((resolve, reject) => {
      let stderr = ''
      let settled = false
      let timedOut = false
      let cancelled = false
      let terminationStarted = false
      const child = spawn(this.ffmpegPath, ['-v', 'error', '-nostdin', '-i', filePath, '-map', '0:a:0', '-f', 'null', '-'], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const settle = (result: AudioValidationResult | Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        result instanceof Error ? reject(result) : resolve(result)
      }
      const finishTermination = () => {
        if (cancelled || signal.aborted) {
          settle({ status: 'check_failed', errorCode: 'scan_cancelled', errorMessage: '音频检查已取消。' })
          return
        }
        if (timedOut) {
          settle({ status: 'check_failed', errorCode: 'decode_timeout', errorMessage: '完整解码超时。' })
          return
        }
        settle({ status: 'check_failed', errorCode: 'scan_cancelled', errorMessage: '音频检查已取消。' })
      }
      const terminate = () => {
        if (settled || terminationStarted) return
        terminationStarted = true
        void this.terminateProcess(child).then(
          finishTermination,
          error => {
            settle(error instanceof AudioFfmpegTerminationError
              ? error
              : new AudioFfmpegTerminationError(error instanceof Error ? error.message : String(error)))
          },
        )
      }
      const abort = () => {
        cancelled = true
        terminate()
      }
      const timer = setTimeout(() => {
        timedOut = true
        terminate()
      }, this.timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      child.stderr?.on('data', chunk => {
        if (stderr.length < 16_384) stderr += String(chunk)
      })
      child.once('error', error => {
        if (terminationStarted) return
        if ((error as NodeJS.ErrnoException).code == 'ENOENT') settle(new ValidatorUnavailableError(`找不到内置 FFmpeg：${this.ffmpegPath}`))
        else settle({ status: 'check_failed', errorCode: 'file_read_failed', errorMessage: error.message })
      })
      child.once('close', code => {
        if (terminationStarted) {
          finishTermination()
          return
        }
        if (code == 0) {
          settle({ status: 'playable' })
          return
        }
        const message = stderr.trim() || `FFmpeg 退出码：${code ?? 'unknown'}`
        settle(isDecodeError(message)
          ? { status: 'unplayable', errorCode: 'decode_failed', errorMessage: message }
          : { status: 'check_failed', errorCode: 'file_read_failed', errorMessage: message })
      })
    })
  }
}
