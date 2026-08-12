const path = require('path')
const mp3Meta = require('./mp3Meta')
const flacMeta = require('./flacMeta')

exports.setMeta = async(filePath, meta, proxy) => {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp3':
      await mp3Meta(filePath, meta, proxy)
      break
    case '.flac':
      await flacMeta(filePath, meta, proxy)
      break
  }
}
