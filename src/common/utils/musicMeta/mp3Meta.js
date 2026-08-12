const NodeID3 = require('node-id3')
const path = require('path')
const fs = require('fs')
const fsPromises = fs.promises
const download = require('./downloader')
const { commitAtomicWrite, prepareAtomicWrite } = require('../atomicFile')
const extReg = /^(\.(?:jpe?g|png)).*$/

const handleWriteMeta = async(meta, filePath) => {
  if (meta.lyrics) {
    meta.unsynchronisedLyrics = {
      language: 'zho',
      text: meta.lyrics,
    }
    delete meta.lyrics
  }
  const tempPath = filePath + '.lxmtemp'
  const backupPath = filePath + '.lxmbackup'
  await prepareAtomicWrite(filePath, tempPath, backupPath)
  try {
    await fsPromises.copyFile(filePath, tempPath)
    await NodeID3.Promise.write(meta, tempPath)
    await commitAtomicWrite(filePath, tempPath, backupPath)
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
  if (!meta.APIC) return handleWriteMeta(meta, filePath)
  if (!/^http/.test(meta.APIC)) {
    delete meta.APIC
    return handleWriteMeta(meta, filePath)
  }
  const picPath = `${filePath}.lxcover${getCoverExtension(meta.APIC)}`

  let picUrl = meta.APIC
  if (picUrl.includes('music.126.net')) picUrl += `${picUrl.includes('?') ? '&' : '?'}param=500y500`
  try {
    await download(picUrl, picPath, proxy)
    meta.APIC = picPath
    await handleWriteMeta(meta, filePath)
  } finally {
    await fsPromises.unlink(picPath).catch(err => {
      if (err.code !== 'ENOENT') throw err
    })
  }
}
