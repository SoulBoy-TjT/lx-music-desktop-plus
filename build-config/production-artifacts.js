const fs = require('node:fs')
const path = require('node:path')

const entryFiles = ['main.js', 'renderer.js', 'renderer-lyric.js', 'user-api-preload.js', 'dbService.worker.js', 'renderer.main.worker.js', 'renderer.download.worker.js']

const assertProductionArtifacts = (readFile) => {
  for (const file of entryFiles) {
    const content = readFile(file).toString()
    if (/eval-source-map|webpack-hot-middleware|webpack-dev-server|https?:\/\/localhost:908[01]/u.test(content)) {
      throw new Error(`Development artifact cannot be packaged: ${file}. Run the production builds first.`)
    }
  }
  for (const html of ['index.html', 'lyric.html']) {
    const content = readFile(html).toString()
    const assets = [...content.matchAll(/(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/gu)].map(match => match[1])
    if (!assets.some(asset => asset.endsWith('.js'))) throw new Error(`Missing entry script in ${html}`)
    for (const asset of assets) {
      if (/^(?:[a-z]+:|\/)|(?:^|\/)\.\.(?:\/|$)/iu.test(asset)) throw new Error(`Invalid packaged asset: ${asset}`)
      readFile(asset)
    }
  }
}

const assertProductionDirectory = (directory) => {
  assertProductionArtifacts(file => fs.readFileSync(path.join(directory, file)))
}

module.exports = { assertProductionArtifacts, assertProductionDirectory }
