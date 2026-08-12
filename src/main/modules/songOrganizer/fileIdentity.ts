import { promises as fs } from 'node:fs'

export const lstatWithFileIdentity = async(target: string) => fs.lstat(target, { bigint: true })
export type SongOrganizerFileStat = Awaited<ReturnType<typeof lstatWithFileIdentity>>

export const createSongOrganizerFileIdentity = (stat: { dev: bigint, ino: bigint }): string | undefined => {
  if (stat.ino == 0n) return undefined
  return `${stat.dev}:${stat.ino}`
}

export const getSongOrganizerMtimeMs = (stat: { mtimeNs: bigint }): number => {
  const wholeMilliseconds = stat.mtimeNs / 1_000_000n
  const remainingNanoseconds = stat.mtimeNs % 1_000_000n
  return Number(wholeMilliseconds) + Number(remainingNanoseconds) / 1_000_000
}
