const fs = require('fs')
const fsPromises = fs.promises
const path = require('path')
const { pipeline } = require('stream/promises')
const getImgSize = require('image-size')
const download = require('./downloader')

const FlacProcessor = require('./flac-metadata/index')

const extReg = /^(\.(?:jpe?g|png)).*$/
const vendor = 'reference libFLAC 1.2.1 20070917'

const recoverInterruptedReplacement = async(filePath, backupPath) => {
  try {
    await fsPromises.access(backupPath)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  try {
    await fsPromises.access(filePath)
    await fsPromises.rm(backupPath, { force: true })
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    await fsPromises.rename(backupPath, filePath)
  }
}

const writeMeta = async(filePath, meta, picPath) => {
  const comments = Object.keys(meta).map(key => `${key.toUpperCase()}=${meta[key] || ''}`)
  const data = {
    vorbis: {
      vendor,
      comments,
    },
  }
  if (picPath) {
    const apicData = await fsPromises.readFile(picPath)
    let imgSize = getImgSize(apicData)
    let mime_type
    let bitsPerPixel
    if (apicData[0] == 0xff && apicData[1] == 0xd8 && apicData[2] == 0xff) {
      mime_type = 'image/jpeg'
      bitsPerPixel = 24
    } else {
      mime_type = 'image/png'
      bitsPerPixel = 32
    }
    data.picture = {
      pictureType: 3,
      mimeType: mime_type,
      description: '',
      width: imgSize.width,
      height: imgSize.height,
      bitsPerPixel,
      colors: 0,
      pictureData: apicData,
    }
  }

  const tempPath = filePath + '.lxmtemp'
  const backupPath = filePath + '.lxmbackup'
  await fsPromises.rm(tempPath, { force: true })
  await recoverInterruptedReplacement(filePath, backupPath)
  try {
    const reader = fs.createReadStream(filePath)
    const writer = fs.createWriteStream(tempPath)
    const flacProcessor = new FlacProcessor()
    flacProcessor.writeMeta(data)
    await pipeline(reader, flacProcessor, writer)
    await fsPromises.rename(filePath, backupPath)
    try {
      await fsPromises.rename(tempPath, filePath)
    } catch (err) {
      await fsPromises.rename(backupPath, filePath)
      throw err
    }
    await fsPromises.rm(backupPath, { force: true })
  } catch (err) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
}

const getCoverExtension = (url) => {
  try {
    return path.extname(new URL(url).pathname).replace(extReg, '$1') || '.jpg'
  } catch {
    return '.jpg'
  }
}

module.exports = async(filePath, meta, proxy) => {
  meta = { ...meta }
  if (!meta.APIC) {
    delete meta.APIC
    return writeMeta(filePath, meta)
  }
  let picUrl = meta.APIC
  delete meta.APIC
  if (!/^http/.test(picUrl)) {
    return writeMeta(filePath, meta)
  }
  const picPath = `${filePath}.lxcover${getCoverExtension(picUrl)}`

  if (picUrl.includes('music.126.net')) picUrl += `${picUrl.includes('?') ? '&' : '?'}param=500y500`
  try {
    await download(picUrl, picPath, proxy)
    await writeMeta(filePath, meta, picPath)
  } finally {
    await fsPromises.unlink(picPath).catch(err => {
      if (err.code !== 'ENOENT') throw err
    })
  }
}

