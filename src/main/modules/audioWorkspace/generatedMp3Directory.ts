const songCountSuffix = /(?:（\d+首）|\(\d+首\))$/u

export const stripSongCountSuffix = (name: string): string => name.replace(songCountSuffix, '').trim()

const generatedMp3DirectoryName = /^.+ MP3(?:（\d+首）|\(\d+首\))?$/u
const generatedMp3DirectoryNameWindows = /^.+ MP3(?:（\d+首）|\(\d+首\))?$/iu

export const isGeneratedMp3DirectoryName = (name: string): boolean => (process.platform == 'win32'
  ? generatedMp3DirectoryNameWindows
  : generatedMp3DirectoryName).test(name)
