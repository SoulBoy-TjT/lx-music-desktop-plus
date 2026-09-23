import path from 'node:path'
import { promises as fs } from 'node:fs'
import { stripSongCountSuffix } from '../audioWorkspace/generatedMp3Directory'

const nameKey = (name: string) => {
  const base = stripSongCountSuffix(name)
  return process.platform == 'win32' ? base.toLowerCase() : base
}

export const planAlbumDirectories = async(sourceRoot: string, outputRoot: string) => {
  const targets = new Map<string, string>([[sourceRoot, outputRoot]])
  const renames: Array<{ sourceDirectory: string, from: string, to: string }> = []
  const visit = async(source: string, output: string): Promise<void> => {
    const sourceEntries = await fs.readdir(source, { withFileTypes: true })
    const directories: string[] = []
    for (const entry of sourceEntries) {
      const fullPath = path.join(source, entry.name)
      if (fullPath == outputRoot) continue
      const stat = await fs.lstat(fullPath)
      if (stat.isDirectory() && !stat.isSymbolicLink()) directories.push(entry.name)
    }
    let outputEntries: Array<{ name: string }>
    try {
      const stat = await fs.lstat(output)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`专辑输出必须是普通目录：${output}`)
      outputEntries = await fs.readdir(output, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code != 'ENOENT') throw error
      outputEntries = []
    }
    for (const name of directories) {
      const siblings = directories.filter(other => nameKey(other) == nameKey(name))
      if (siblings.length > 1) throw new Error(`来源专辑名称去除数量后缀后冲突：${siblings.map(item => path.join(source, item)).join('；')}`)
      const candidates = outputEntries.filter(entry => nameKey(entry.name) == nameKey(name))
      if (candidates.length > 1) throw new Error(`存在多个专辑输出目录，禁止自动合并：${candidates.map(entry => path.join(output, entry.name)).join('；')}`)
      const sourceChild = path.join(source, name)
      const target = path.join(output, candidates[0]?.name ?? name)
      if (candidates.length) {
        const stat = await fs.lstat(target)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`专辑输出候选必须是普通目录：${target}`)
      }
      targets.set(sourceChild, target)
      const sameName = process.platform == 'win32' ? candidates[0]?.name.toLowerCase() == name.toLowerCase() : candidates[0]?.name == name
      if (candidates.length && !sameName) renames.push({ sourceDirectory: sourceChild, from: target, to: path.join(output, name) })
      await visit(sourceChild, target)
    }
  }
  await visit(sourceRoot, outputRoot)
  return { targets, renames }
}
