const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const releaseTag = 'autobuild-2026-08-06-13-39'
const archiveName = 'ffmpeg-N-125978-g95c43d7df7-win64-lgpl.zip'
const archiveSha256 = '79ab2838ff13a71df85ba452d633b964fe5cc681f7eccb1f3e873649974fbe1f'
const executableSha256 = 'e9da9e22d907a996982f18c7ebd7a4b15483d19ca8d581d295b0bd5e08511fec'
const archiveUrl = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${releaseTag}/${archiveName}`
const archiveRoot = archiveName.replace(/\.zip$/u, '')
const outputDir = path.join(__dirname, '..', 'resources', 'song-organizer')
const executablePath = path.join(outputDir, 'ffmpeg.exe')
const licensePath = path.join(outputDir, 'LICENSE.txt')
const cacheDir = path.join(os.tmpdir(), 'lx-music-song-organizer')
const archivePath = path.join(cacheDir, archiveName)
const extractDir = path.join(cacheDir, archiveRoot)

const hashFile = target => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(target)
  stream.on('data', chunk => hash.update(chunk))
  stream.once('error', reject)
  stream.once('end', () => resolve(hash.digest('hex')))
})

const download = async() => {
  const response = await fetch(archiveUrl, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`FFmpeg download failed: HTTP ${response.status}`)
  const file = fs.createWriteStream(archivePath)
  for await (const chunk of response.body) {
    if (!file.write(chunk)) await new Promise(resolve => file.once('drain', resolve))
  }
  await new Promise((resolve, reject) => file.end(error => error ? reject(error) : resolve()))
}

const verify = async(target, expected, label) => {
  const actual = await hashFile(target)
  if (actual != expected) throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`)
}

const main = async() => {
  if (process.platform != 'win32' || process.arch != 'x64') {
    console.log('Song organizer FFmpeg is only prepared on Windows x64.')
    return
  }
  fs.mkdirSync(outputDir, { recursive: true })
  fs.mkdirSync(cacheDir, { recursive: true })
  if (fs.existsSync(executablePath)) {
    try {
      await verify(executablePath, executableSha256, 'ffmpeg.exe')
      console.log(`Song organizer FFmpeg is ready: ${executablePath}`)
      return
    } catch {
      fs.unlinkSync(executablePath)
    }
  }
  if (!fs.existsSync(archivePath) || await hashFile(archivePath) != archiveSha256) await download()
  await verify(archivePath, archiveSha256, 'FFmpeg archive')
  fs.rmSync(extractDir, { recursive: true, force: true })
  const result = spawnSync('tar.exe', [
    '-xf', archivePath,
    '-C', cacheDir,
    `${archiveRoot}/bin/ffmpeg.exe`,
    `${archiveRoot}/LICENSE.txt`,
  ], { stdio: 'inherit' })
  if (result.status != 0) throw new Error(`Could not extract FFmpeg archive (exit code ${result.status ?? 'unknown'}).`)
  fs.copyFileSync(path.join(extractDir, 'bin', 'ffmpeg.exe'), executablePath)
  fs.copyFileSync(path.join(extractDir, 'LICENSE.txt'), licensePath)
  await verify(executablePath, executableSha256, 'ffmpeg.exe')
  const version = spawnSync(executablePath, ['-version'], { encoding: 'utf8', windowsHide: true })
  if (version.status != 0 || !version.stdout.includes('N-125978-g95c43d7df7-20260806')) throw new Error('FFmpeg version check failed.')
  console.log(`Song organizer FFmpeg prepared: ${executablePath}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
