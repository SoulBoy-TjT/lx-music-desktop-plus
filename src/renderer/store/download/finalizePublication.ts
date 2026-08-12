interface DownloadPublicationFinalizationIo {
  writeMetadata: (stagingPath: string) => Promise<void>
  writeLyric: (stagingPath?: string) => Promise<boolean>
  commit: (publication: LX.Download.DownloadPublication, sidecar?: LX.Download.DownloadPublicationSidecar) => Promise<void>
  discard: (publication: Pick<LX.Download.DownloadPublication, 'stagingPath'>, sidecar?: LX.Download.DownloadPublicationSidecar) => Promise<void>
}

export const finalizeDownloadPublication = async(
  publication: LX.Download.DownloadPublication,
  lyricPublication: LX.Download.DownloadPublicationSidecar | undefined,
  io: DownloadPublicationFinalizationIo,
): Promise<void> => {
  try {
    const results = await Promise.allSettled([
      io.writeMetadata(publication.stagingPath),
      io.writeLyric(lyricPublication?.stagingPath),
    ])
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failure) throw failure.reason
    const lyricStaged = results[1].status === 'fulfilled' && results[1].value
    await io.commit(publication, lyricStaged ? lyricPublication : undefined)
    if (lyricPublication && !lyricStaged) await io.discard(publication, lyricPublication).catch(() => {})
  } catch (error) {
    await io.discard(publication, lyricPublication).catch(() => {})
    throw error
  }
}
