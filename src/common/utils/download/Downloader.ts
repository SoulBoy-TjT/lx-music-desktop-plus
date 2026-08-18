import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { performance } from 'perf_hooks'
import { STATUS } from './util'
import type http from 'http'
import { request, type Options as RequestOptions } from './request'

export interface Options {
  forceResume: boolean
  timeout: number
  requestOptions: RequestOptions
}

const defaultChunkInfo = {
  path: '',
  startByte: '0',
  endByte: '',
}

const defaultRequestOptions: Options['requestOptions'] = {
  method: 'get',
  headers: {},
}
const defaultOptions: Options = {
  forceResume: true,
  timeout: 20_000,
  requestOptions: { ...defaultRequestOptions },
}

class Task extends EventEmitter {
  resumeLastChunk: Buffer | null
  downloadUrl: string
  chunkInfo: { path: string, startByte: string, endByte: string }
  status: typeof STATUS[keyof typeof STATUS]
  options: Options
  requestOptions: Options['requestOptions']
  ws: fs.WriteStream | null = null
  progress = { total: 0, downloaded: 0, speed: 0, progress: 0 }
  statsEstimate = { time: 0, bytes: 0, prevBytes: 0 }
  requestInstance: http.ClientRequest | null = null
  maxRedirectNum = 2
  private redirectNum = 0
  private dataWriteQueueLength = 0
  private closeWaiting = false
  private timeout: null | NodeJS.Timeout = null
  private attemptId = 0
  private writeStreamClosePromise: Promise<void> | null = null


  constructor(url: string, savePath: string, filename: string, options: Partial<Options> = {}) {
    super()

    this.resumeLastChunk = null
    this.downloadUrl = url
    this.chunkInfo = Object.assign({}, defaultChunkInfo, {
      path: path.join(savePath, filename),
      startByte: '0',
    })
    // if (!this.chunkInfo.endByte) this.chunkInfo.endByte = ''

    this.options = Object.assign({}, defaultOptions, options)
    this.requestOptions = Object.assign({}, defaultRequestOptions, this.options.requestOptions || {})
    this.requestOptions.headers = this.requestOptions.headers ? { ...this.requestOptions.headers } : {}

    this.status = STATUS.idle
  }

  async __init(attemptId: number) {
    const { path, startByte, endByte } = this.chunkInfo
    this.redirectNum = 0
    this.progress.downloaded = 0
    this.progress.progress = 0
    this.progress.speed = 0
    this.dataWriteQueueLength = 0
    this.closeWaiting = false
    this.resumeLastChunk = null
    this.__clearTimeout()
    this.__startTimeout(attemptId)
    if (startByte) this.requestOptions.headers!.range = `bytes=${startByte}-${endByte}`

    if (!path) return
    return new Promise<void>((resolve, reject) => {
      fs.stat(path, (errStat, stats) => {
        if (attemptId !== this.attemptId) {
          resolve()
          return
        }
        if (errStat) {
          // console.log(errStat.code)
          if (errStat.code !== 'ENOENT') {
            this.__handleError(errStat, attemptId)
            reject(errStat)
            return
          }
        } else if (stats.size >= 10) {
          fs.open(path, 'r', (errOpen, fd) => {
            if (attemptId !== this.attemptId) {
              if (errOpen) resolve()
              else fs.close(fd, () => { resolve() })
              return
            }
            if (errOpen) {
              this.__handleError(errOpen, attemptId)
              reject(errOpen)
              return
            }
            fs.read(fd, Buffer.alloc(10), 0, 10, stats.size - 10, (errRead, bytesRead, buffer) => {
              if (attemptId !== this.attemptId) {
                fs.close(fd, () => { resolve() })
                return
              }
              if (errRead) {
                this.__handleError(errRead, attemptId)
                reject(errRead)
                return
              }
              fs.close(fd, errClose => {
                if (attemptId !== this.attemptId) {
                  resolve()
                  return
                }
                if (errClose) {
                  this.__handleError(errClose, attemptId)
                  reject(errClose)
                  return
                }

                // resume download
                // console.log(buffer)
                this.resumeLastChunk = buffer
                this.progress.downloaded = stats.size
                this.requestOptions.headers!.range = `bytes=${stats.size - 10}-${endByte || ''}`
                resolve()
              })
            })
          })
          return
        }
        resolve()
      })
    })
  }

  __httpFetch(url: string, options: Options['requestOptions'], attemptId: number) {
    // console.log(options)
    let redirected = false
    this.requestInstance = request(url, options)
      .on('response', response => {
        if (attemptId !== this.attemptId || this.status !== STATUS.running) return
        if (response.statusCode !== 200 && response.statusCode !== 206) {
          if (response.statusCode == 416) {
            fs.unlink(this.chunkInfo.path, (err) => {
              this.__handleError(new Error(response.statusMessage), attemptId)
              this.chunkInfo.startByte = '0'
              this.resumeLastChunk = null
              this.progress.downloaded = 0
              if (err) this.__handleError(err, attemptId)
            })
            return
          }
          if ((response.statusCode == 301 || response.statusCode == 302) && response.headers.location && this.redirectNum < this.maxRedirectNum) {
            console.log('current url:', url)
            console.log('redirect to:', response.headers.location)
            redirected = true
            this.redirectNum++
            const location = response.headers.location
            this.__httpFetch(location, options, attemptId)
            return
          }
          this.status = STATUS.failed
          this.emit('fail', response)
          this.__clearTimeout()
          this.__closeRequest()
          void this.__closeWriteStream().catch(() => {})
          return
        }
        this.emit('response', response)
        try {
          this.__initDownload(response, attemptId)
        } catch (error: any) {
          this.__handleError(error, attemptId)
          return
        }
        if (attemptId !== this.attemptId || this.status !== STATUS.running) return
        this.__startTimeout(attemptId)
        response
          .on('data', chunk => { this.__handleWriteData(chunk, attemptId) })
          .on('error', err => { this.__handleError(err, attemptId) })
          .on('end', () => {
            if (attemptId !== this.attemptId || this.status !== STATUS.running) return
            if (response.complete) {
              this.__handleComplete(attemptId)
            } else {
              this.__handleError(new Error('The connection was terminated while the message was still being sent'), attemptId)
            }
          })
      })
      .on('error', err => {
        if (redirected) return
        this.__handleError(err, attemptId)
      })
      .on('close', () => {
        if (redirected || attemptId !== this.attemptId) return
        void this.__closeWriteStream().catch(error => { this.__handleError(error, attemptId) })
      })
      .end()
  }

  __initDownload(response: http.IncomingMessage, attemptId: number) {
    this.progress.total = response.headers['content-length'] ? parseInt(response.headers['content-length']) : 0
    if (!this.progress.total) {
      this.__handleError(new Error('Content length is 0'), attemptId)
      return
    }
    let options: any = {}
    let isResumable = this.options.forceResume ||
      response.headers['accept-ranges'] !== 'none' ||
      (typeof response.headers['accept-ranges'] == 'string' &&
        parseInt(response.headers['accept-ranges'].replace(/^bytes=(\d+)/, '$1')) > 0)

    if (isResumable) {
      options.flags = 'a'
      if (this.progress.downloaded) this.progress.total -= 10
    } else {
      if (this.chunkInfo.startByte != '0') {
        this.__handleError(new Error('The resource cannot be resumed download.'), attemptId)
        return
      }
    }
    this.progress.total += this.progress.downloaded
    this.statsEstimate.prevBytes = this.progress.downloaded
    if (!this.chunkInfo.path) {
      this.__handleError(new Error('Chunk save Path is not set.'), attemptId)
      return
    }
    const ws = fs.createWriteStream(this.chunkInfo.path, options)
    this.ws = ws
    this.writeStreamClosePromise = null

    ws.once('close', () => {
      if (this.ws === ws) this.ws = null
    })
    ws.on('finish', () => {
      if (attemptId !== this.attemptId) return
      if (this.closeWaiting) return
      void this.__closeWriteStream().catch(error => { this.__handleError(error, attemptId) })
    })
    ws.on('error', err => {
      if (attemptId !== this.attemptId) return
      fs.unlink(this.chunkInfo.path, (unlinkErr: any) => {
        this.__handleError(err, attemptId)
        this.chunkInfo.startByte = '0'
        this.resumeLastChunk = null
        this.progress.downloaded = 0
        if (unlinkErr && unlinkErr.code !== 'ENOENT') this.__handleError(unlinkErr, attemptId)
      })
    })
  }

  __handleComplete(attemptId: number) {
    if (attemptId !== this.attemptId || this.status !== STATUS.running) return
    this.__clearTimeout()
    if (this.progress.progress <= 0) {
      this.__handleError(new Error('Progress is 0, download failed.'), attemptId)
      return
    }
    void this.__closeWriteStream().then(() => {
      if (attemptId !== this.attemptId || this.status !== STATUS.running) return
      if (this.progress.downloaded == this.progress.total) {
        this.status = STATUS.completed
        this.emit('completed')
      } else {
        this.status = STATUS.stopped
        this.emit('stop')
      }
    }).catch(error => { this.__handleError(error, attemptId) })
    // console.log('end')
  }

  __handleError(error: Error, attemptId = this.attemptId) {
    if (
      attemptId !== this.attemptId ||
      (this.status !== STATUS.init && this.status !== STATUS.running)
    ) return
    this.status = STATUS.error
    this.__clearTimeout()
    this.__closeRequest()
    void this.__closeWriteStream().then(() => {
      if (attemptId !== this.attemptId || this.status !== STATUS.error) return
      this.emit('error', error)
    }).catch(closeError => {
      if (attemptId !== this.attemptId || this.status !== STATUS.error) return
      this.emit('error', closeError)
    })
  }

  async __closeWriteStream(): Promise<void> {
    if (this.writeStreamClosePromise) return this.writeStreamClosePromise
    const ws = this.ws
    if (!ws) return Promise.resolve()
    this.writeStreamClosePromise = new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error | null) => {
        if (settled) return
        settled = true
        ws.off('close', handleClose)
        ws.off('error', handleError)
        if (this.ws === ws) this.ws = null
        if (error) reject(error)
        else resolve()
      }
      const handleClose = () => { settle() }
      const handleError = (error: Error) => { settle(error) }
      ws.once('close', handleClose)
      ws.once('error', handleError)
      // console.log('close write stream')
      if (this.closeWaiting || this.dataWriteQueueLength) {
        this.closeWaiting ||= true
      } else {
        ws.close(err => { settle(err) })
      }
    })
    return this.writeStreamClosePromise
  }

  __closeRequest() {
    if (!this.requestInstance || this.requestInstance.destroyed) return
    // console.log('close request')
    this.requestInstance.destroy()
    this.requestInstance = null
  }

  __handleWriteData(chunk: Buffer, attemptId: number) {
    if (attemptId !== this.attemptId || this.status !== STATUS.running) return
    if (this.resumeLastChunk) {
      const result = this.__handleDiffChunk(chunk)
      if (result) chunk = result
      else {
        this.__handleError(new Error('Resume failed, response chunk does not match.'), attemptId)
        return
      }
    }
    // console.log('data', chunk)
    if (this.ws == null) {
      console.log('cancel write')
      return
    }
    this.dataWriteQueueLength++
    this.__startTimeout(attemptId)
    this.__calculateProgress(chunk.length)
    this.ws.write(chunk, err => {
      this.dataWriteQueueLength--
      if (this.status == STATUS.running) this.__calculateProgress(0)
      if (err) {
        console.log(err)
        this.__handleError(err, attemptId)
        return
      }
      if (this.closeWaiting && !this.dataWriteQueueLength) this.ws?.close()
    })
  }

  __handleDiffChunk(chunk: Buffer): Buffer | null {
    // console.log('diff', chunk)
    let resumeLastChunkLen = this.resumeLastChunk!.length
    let chunkLen = chunk.length
    let isOk
    if (chunkLen >= resumeLastChunkLen) {
      isOk = chunk.subarray(0, resumeLastChunkLen).toString('hex') === this.resumeLastChunk!.toString('hex')
      if (!isOk) return null

      this.resumeLastChunk = null
      return chunk.subarray(resumeLastChunkLen)
    } else {
      isOk = chunk.subarray(0, chunkLen).toString('hex') === this.resumeLastChunk!.subarray(0, chunkLen).toString('hex')
      if (!isOk) return null
      this.resumeLastChunk = this.resumeLastChunk!.subarray(chunkLen)
      return chunk.subarray(chunkLen)
    }
  }

  async __handleStop() {
    this.__clearTimeout()
    this.__closeRequest()
    return this.__closeWriteStream()
  }

  private __clearTimeout() {
    if (!this.timeout) return
    clearTimeout(this.timeout)
    this.timeout = null
  }

  private __startTimeout(attemptId = this.attemptId) {
    this.__clearTimeout()
    this.timeout = setTimeout(() => {
      this.__handleError(new Error('download timeout'), attemptId)
    }, this.options.timeout)
  }

  __calculateProgress(receivedBytes: number) {
    const currentTime = performance.now()
    const elaspsedTime = currentTime - this.statsEstimate.time

    const progress = this.progress
    progress.downloaded += receivedBytes
    progress.progress = progress.total ? (progress.downloaded / progress.total) * 100 : -1


    // emit the progress every second or if finished
    if ((progress.downloaded === progress.total && this.dataWriteQueueLength == 0) || elaspsedTime > 1000) {
      this.statsEstimate.time = currentTime
      this.statsEstimate.bytes = progress.downloaded - this.statsEstimate.prevBytes
      this.statsEstimate.prevBytes = progress.downloaded
      this.emit('progress', {
        total: progress.total,
        downloaded: progress.downloaded,
        progress: progress.progress,
        speed: this.statsEstimate.bytes,
        writeQueue: this.dataWriteQueueLength,
      })
    }
  }

  async start() {
    const attemptId = ++this.attemptId
    this.status = STATUS.init
    await this.__init(attemptId)
    if (attemptId !== this.attemptId || this.status !== STATUS.init) return
    this.status = STATUS.running
    this.__httpFetch(this.downloadUrl, this.requestOptions, attemptId)
    this.emit('start')
  }

  async stop() {
    if (this.status == STATUS.stopped || this.status == STATUS.completed) return
    this.attemptId++
    this.status = STATUS.stopped
    await this.__handleStop()
    this.emit('stop')
  }

  refreshUrl(url: string) {
    this.downloadUrl = url
  }

  updateSaveInfo(filePath: string, fileName: string) {
    this.chunkInfo.path = path.join(filePath, fileName)
  }
}

export default Task
