const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assertProductionArtifacts } = require('./production-artifacts')

const read = overrides => file => {
  if (Object.hasOwn(overrides, file)) {
    if (overrides[file] == null) throw new Error(`Missing ${file}`)
    return overrides[file]
  }
  return file.endsWith('.html') ? '<script src="renderer.js"></script><link href="app.css">' : 'production code'
}

test('accepts production entries with local assets', () => {
  assert.doesNotThrow(() => assertProductionArtifacts(read({})))
})
for (const marker of ['eval-source-map', "true ? 'http://localhost:9080' : 0", 'http://localhost:9081/lyric.html', 'webpack-hot-middleware']) {
  test(`rejects development marker ${marker}`, () => {
    assert.throws(() => assertProductionArtifacts(read({ 'main.js': marker })), /Development artifact/)
  })
}
test('rejects missing HTML, worker and referenced CSS', () => {
  for (const file of ['index.html', 'dbService.worker.js', 'app.css']) {
    assert.throws(() => assertProductionArtifacts(read({ [file]: null })), /Missing/)
  }
})
test('rejects remote scripts and missing entry scripts', () => {
  for (const html of ['<script src="http://localhost:9080/renderer.js"></script>', '<html></html>']) {
    assert.throws(() => assertProductionArtifacts(read({ 'index.html': html })))
  }
})
