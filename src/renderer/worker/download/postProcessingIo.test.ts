import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import NodeID3 from 'node-id3'
import { afterEach, describe, expect, it } from 'vitest'
import { setMeta } from '@common/utils/musicMeta'
import downloadCover from '@common/utils/musicMeta/downloader'
import { saveLrc } from './utils'

const tempDirs: string[] = []
const servers: Server[] = []
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex')

const createTempDir = async() => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lx-download-postprocess-'))
  tempDirs.push(dir)
  return dir
}

const listen = async(server: Server) => {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('Missing test server address')
  return address.port
}

afterEach(async() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => {
      resolve()
    }))
  }
  await Promise.all(tempDirs.splice(0).map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('download post-processing I/O', () => {
  it('waits for MP3 metadata and cover cleanup before resolving', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'song.mp3')
    await writeFile(filePath, Buffer.from('audio payload'))
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(png)
    }))

    await setMeta(filePath, {
      title: 'Awaited title',
      artist: 'Artist',
      album: 'Album',
      APIC: `http://127.0.0.1:${port}/cover.png`,
      lyrics: '[00:00.00]line',
    })

    expect(NodeID3.read(filePath).title).toBe('Awaited title')
    await expect(stat(`${filePath}.lxcover.png`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${filePath}.lxmtemp`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${filePath}.lxmbackup`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers an MP3 backup left by an interrupted replacement', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'recovered.mp3')
    await writeFile(`${filePath}.lxmbackup`, Buffer.from('audio payload'))

    await setMeta(filePath, {
      title: 'Recovered MP3 title',
      artist: 'Artist',
      album: 'Album',
      APIC: null,
      lyrics: null,
    })

    expect(NodeID3.read(filePath).title).toBe('Recovered MP3 title')
    await expect(stat(`${filePath}.lxmbackup`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a cover network failure and still rejects target MP3 I/O failure', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'network-fallback.mp3')
    await writeFile(filePath, Buffer.from('audio payload'))
    const port = await listen(createServer((_request, response) => {
      response.writeHead(500)
      response.end('failed')
    }))

    await expect(setMeta(filePath, {
      title: 'Fallback title',
      artist: 'Artist',
      album: 'Album',
      APIC: `http://127.0.0.1:${port}/cover.png`,
      lyrics: null,
    })).rejects.toThrow('status 500')
    expect(NodeID3.read(filePath).title).toBeUndefined()

    await expect(setMeta(path.join(dir, 'missing.mp3'), {
      title: 'Missing target',
      artist: 'Artist',
      album: 'Album',
      APIC: null,
      lyrics: null,
    })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('waits for FLAC replacement and temporary-file cleanup before resolving', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'song.flac')
    const streamInfoHeader = Buffer.alloc(4)
    streamInfoHeader.writeUInt32BE(0x80000022)
    await writeFile(filePath, Buffer.concat([
      Buffer.from('fLaC'),
      streamInfoHeader,
      Buffer.alloc(34),
      Buffer.from('audio payload'),
    ]))
    const port = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(png)
    }))

    await setMeta(filePath, {
      title: 'Awaited FLAC title',
      artist: 'Artist',
      album: 'Album',
      APIC: `http://127.0.0.1:${port}/cover.png`,
      lyrics: '[00:00.00]line',
    })

    expect((await readFile(filePath)).includes(Buffer.from('TITLE=Awaited FLAC title'))).toBe(true)
    await expect(stat(`${filePath}.lxcover.png`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${filePath}.lxmtemp`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${filePath}.lxmbackup`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers a FLAC backup left by an interrupted replacement', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'recovered.flac')
    const streamInfoHeader = Buffer.alloc(4)
    streamInfoHeader.writeUInt32BE(0x80000022)
    await writeFile(`${filePath}.lxmbackup`, Buffer.concat([
      Buffer.from('fLaC'),
      streamInfoHeader,
      Buffer.alloc(34),
      Buffer.from('audio payload'),
    ]))

    await setMeta(filePath, {
      title: 'Recovered title',
      artist: 'Artist',
      album: 'Album',
      APIC: null,
      lyrics: null,
    })

    expect((await readFile(filePath)).includes(Buffer.from('TITLE=Recovered title'))).toBe(true)
    await expect(stat(`${filePath}.lxmbackup`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a lyric write failure instead of resolving early', async() => {
    const dir = await createTempDir()

    await expect(saveLrc({ lyric: '[00:00.00]line' }, {
      filePath: path.join(dir, 'missing', 'song.lrc'),
      format: 'utf8',
      downloadLxlrc: false,
      downloadTlrc: false,
      downloadRlrc: false,
    })).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('atomically replaces lyrics and recovers an interrupted backup', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'song.lrc')
    await writeFile(`${filePath}.lxmbackup`, Buffer.from('old lyric'))

    await saveLrc({ lyric: '[00:00.00]new lyric' }, {
      filePath,
      format: 'utf8',
      downloadLxlrc: false,
      downloadTlrc: false,
      downloadRlrc: false,
    })

    expect((await readFile(filePath)).includes(Buffer.from('new lyric'))).toBe(true)
    await expect(stat(`${filePath}.lxmtemp`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${filePath}.lxmbackup`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent lyric writes that share one target path', async() => {
    const dir = await createTempDir()
    const filePath = path.join(dir, 'shared.lrc')

    await Promise.all([
      saveLrc({ lyric: '[00:00.00]first lyric' }, {
        filePath,
        format: 'utf8',
        downloadLxlrc: false,
        downloadTlrc: false,
        downloadRlrc: false,
      }),
      saveLrc({ lyric: '[00:00.00]second lyric' }, {
        filePath,
        format: 'utf8',
        downloadLxlrc: false,
        downloadTlrc: false,
        downloadRlrc: false,
      }),
    ])

    const saved = await readFile(filePath)
    expect(saved.includes(Buffer.from('second lyric'))).toBe(true)
    await expect(stat(`${filePath}.lxmtemp`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(`${filePath}.lxmbackup`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('settles failed and timed-out cover requests without leaving partial files', async() => {
    const dir = await createTempDir()
    const failedPath = path.join(dir, 'failed.png')
    const failedPort = await listen(createServer((_request, response) => {
      response.writeHead(500)
      response.end('failed')
    }))
    await expect(downloadCover(`http://127.0.0.1:${failedPort}/cover.png`, failedPath)).rejects.toThrow('status 500')
    await expect(stat(failedPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const timeoutPath = path.join(dir, 'timeout.png')
    const timeoutPort = await listen(createServer(() => {}))
    await expect(downloadCover(
      `http://127.0.0.1:${timeoutPort}/cover.png`,
      timeoutPath,
      undefined,
      40,
    )).rejects.toThrow('deadline')
    await expect(stat(timeoutPath)).rejects.toMatchObject({ code: 'ENOENT' })

    const oversizedPath = path.join(dir, 'oversized.png')
    const oversizedPort = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Length': '64' })
      response.end(Buffer.alloc(64))
    }))
    await expect(downloadCover(
      `http://127.0.0.1:${oversizedPort}/cover.png`,
      oversizedPath,
      undefined,
      1_000,
      32,
    )).rejects.toThrow('maximum size')
    await expect(stat(oversizedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
