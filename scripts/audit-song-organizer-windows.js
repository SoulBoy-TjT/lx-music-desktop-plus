const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { app, shell } = require('electron')

const main = async() => {
  if (process.platform != 'win32' || process.arch != 'x64') throw new Error('This audit requires Windows x64.')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lx-song-organizer-electron-audit-'))
  const source = path.join(root, 'source.mp3')
  const hardlink = path.join(root, 'hardlink.mp3')
  const target = path.join(root, 'target')
  const junction = path.join(root, 'junction')
  await fs.writeFile(source, Buffer.from([1, 2, 3]))
  await fs.link(source, hardlink)
  await fs.mkdir(target)
  await fs.symlink(target, junction, 'junction')
  const sourceStat = await fs.lstat(source)
  const hardlinkStat = await fs.lstat(hardlink)
  const junctionStat = await fs.lstat(junction)
  if (String(sourceStat.dev) != String(hardlinkStat.dev) || String(sourceStat.ino) != String(hardlinkStat.ino) || sourceStat.nlink < 2) {
    throw new Error('Windows file identity did not identify the hardlink pair.')
  }
  if (!junctionStat.isSymbolicLink()) throw new Error('The directory junction was not exposed as a reparse point.')
  await shell.trashItem(root)
  try {
    await fs.lstat(root)
    throw new Error('shell.trashItem returned but the source directory still exists.')
  } catch (error) {
    if (error.code != 'ENOENT') throw error
  }
  console.log(JSON.stringify({
    hardlinkIdentity: `${String(sourceStat.dev)}:${String(sourceStat.ino)}`,
    hardlinkCount: sourceStat.nlink,
    junctionDetected: true,
    recycleBinMoved: true,
  }))
}

app.whenReady().then(main).then(() => app.quit()).catch(error => {
  console.error(error)
  app.exit(1)
})
