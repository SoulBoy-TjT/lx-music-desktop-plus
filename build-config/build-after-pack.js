const fs = require('fs').promises
const path = require('path')
const asar = require('@electron/asar')
const { assertProductionArtifacts } = require('./production-artifacts')

// https://github.com/electron-userland/electron-builder/issues/4630
// https://github.com/electron-userland/electron-builder/issues/4630#issuecomment-782020139

module.exports = async(context) => {
  const { electronPlatformName, appOutDir } = context
  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${context.packager.appInfo.productFilename}.app/Contents/Resources`)
    : path.join(appOutDir, 'resources')
  assertProductionArtifacts(file => asar.extractFile(path.join(resources, 'app.asar'), `dist/${file}`))
  if (electronPlatformName !== 'darwin') return
  const {
    productFilename,
    info: {
      _metadata: { macLanguagesInfoPlistStrings },
    },
  } = context.packager.appInfo

  const resPath = `${appOutDir}/${productFilename}.app/Contents/Resources`

  // 创建APP语言包文件
  return Promise.all(
    Object.entries(macLanguagesInfoPlistStrings).map(([lang, config]) => {
      let infos = Object.entries(config).map(([k, v]) => `"${k}" = "${v}";`).join('\n')
      return fs.writeFile(`${resPath}/${lang}.lproj/InfoPlist.strings`, infos)
    }),
  )
}
