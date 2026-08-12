export const resolveFlacConverterRootDirectory = (
  downloadDirectory: string,
  customDirectory: string,
): string => customDirectory.trim() || downloadDirectory.trim()
