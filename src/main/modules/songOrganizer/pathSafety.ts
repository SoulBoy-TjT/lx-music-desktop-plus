import path from 'node:path'
import { promises as fs } from 'node:fs'

export class SongOrganizerPathError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

const normalizeForCompare = (target: string): string => {
  const resolved = path.resolve(target)
  return process.platform == 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

export const isPathInside = (parent: string, target: string): boolean => {
  const normalizedParent = normalizeForCompare(parent)
  const normalizedTarget = normalizeForCompare(target)
  const relative = path.relative(normalizedParent, normalizedTarget)
  return relative == '' || (!relative.startsWith(`..${path.sep}`) && relative != '..' && !path.isAbsolute(relative))
}

const isVolumeRoot = (target: string): boolean => path.parse(target).root == target

const isUncShareRoot = (target: string): boolean => {
  if (!target.startsWith('\\\\')) return false
  return target.replace(/[\\/]+$/u, '').split(/[\\/]+/u).filter(Boolean).length <= 2
}

export const assertSafeRoot = async(root: string, protectedPaths: string[] = []): Promise<string> => {
  if (!root?.trim()) throw new SongOrganizerPathError('root_not_found', '未设置歌曲整理根目录。')
  const resolved = path.resolve(root)
  let stat
  try {
    stat = await fs.stat(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new SongOrganizerPathError(code == 'EACCES' || code == 'EPERM' ? 'root_permission_denied' : 'root_not_found', `无法访问歌曲整理根目录：${resolved}`)
  }
  if (!stat.isDirectory()) throw new SongOrganizerPathError('root_not_directory', `歌曲整理根目录不是文件夹：${resolved}`)
  if (isVolumeRoot(resolved) || isUncShareRoot(resolved)) throw new SongOrganizerPathError('dangerous_root', '不能把磁盘卷根目录或共享根目录作为歌曲整理根目录。')

  const systemPaths = process.platform == 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    : ['/bin', '/etc', '/usr', '/var']
  const candidates = [...systemPaths, ...protectedPaths].filter((item): item is string => Boolean(item))
  for (const protectedPath of candidates) {
    const normalizedProtected = path.resolve(protectedPath)
    if (isPathInside(resolved, normalizedProtected) || isPathInside(normalizedProtected, resolved)) {
      throw new SongOrganizerPathError('dangerous_root', `歌曲整理根目录与受保护目录存在包含关系：${normalizedProtected}`)
    }
  }
  return resolved
}

export const assertPathInArtist = (root: string, artistPath: string, target: string): void => {
  if (!isPathInside(root, artistPath) || root == artistPath || !isPathInside(artistPath, target)) {
    throw new SongOrganizerPathError('path_outside_root', `目标路径超出选中歌手目录：${target}`)
  }
}
