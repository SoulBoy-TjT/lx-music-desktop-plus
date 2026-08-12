const fsPromises = require('fs').promises
const path = require('path')

const writeLocks = new Map()

const withFileWriteLock = async(filePath, write) => {
  const resolvedPath = path.resolve(filePath)
  const lockKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
  const previousWrite = writeLocks.get(lockKey) ?? Promise.resolve()
  const currentWrite = previousWrite.catch(() => {}).then(write)
  writeLocks.set(lockKey, currentWrite)
  try {
    return await currentWrite
  } finally {
    if (writeLocks.get(lockKey) === currentWrite) writeLocks.delete(lockKey)
  }
}

const exists = async(filePath) => {
  try {
    await fsPromises.access(filePath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

const recoverInterruptedReplacement = async(filePath, backupPath) => {
  if (!await exists(backupPath)) return
  if (await exists(filePath)) {
    await fsPromises.rm(backupPath, { force: true })
  } else {
    await fsPromises.rename(backupPath, filePath)
  }
}

const prepareAtomicWrite = async(filePath, tempPath, backupPath) => {
  await recoverInterruptedReplacement(filePath, backupPath)
  await fsPromises.rm(tempPath, { force: true })
}

const commitAtomicWrite = async(filePath, tempPath, backupPath) => {
  let hasBackup = false
  try {
    await fsPromises.rename(filePath, backupPath)
    hasBackup = true
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  try {
    await fsPromises.rename(tempPath, filePath)
  } catch (err) {
    if (hasBackup) await fsPromises.rename(backupPath, filePath)
    throw err
  }
  if (hasBackup) await fsPromises.rm(backupPath, { force: true })
}

const atomicWriteFile = async(filePath, data) => {
  return withFileWriteLock(filePath, async() => {
    const tempPath = filePath + '.lxmtemp'
    const backupPath = filePath + '.lxmbackup'
    await prepareAtomicWrite(filePath, tempPath, backupPath)
    try {
      await fsPromises.writeFile(tempPath, data)
      await commitAtomicWrite(filePath, tempPath, backupPath)
    } catch (err) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => {})
      throw err
    }
  })
}

module.exports = {
  atomicWriteFile,
  commitAtomicWrite,
  prepareAtomicWrite,
}
