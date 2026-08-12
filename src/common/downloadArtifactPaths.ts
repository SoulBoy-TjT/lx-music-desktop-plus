export const WINDOWS_MAX_PATH_COMPONENT_LENGTH = 255
export const DOWNLOAD_PUBLICATION_PREFIX = '.lx-publishing.'
export const DOWNLOAD_TRANSFER_SUFFIX = `${DOWNLOAD_PUBLICATION_PREFIX}download`
export const DOWNLOAD_FLAC_REPAIR_SUFFIX = '.lx-flac-tail-normalizing'
export const DOWNLOAD_FLAC_REPAIR_OWNER_SUFFIX = '.lx-owner-v1'
export const DOWNLOAD_FLAC_REPAIR_ID_LENGTH = 36

export const MAX_DOWNLOAD_FILE_STEM_LENGTH = WINDOWS_MAX_PATH_COMPONENT_LENGTH -
  DOWNLOAD_TRANSFER_SUFFIX.length -
  1 -
  DOWNLOAD_FLAC_REPAIR_ID_LENGTH -
  DOWNLOAD_FLAC_REPAIR_SUFFIX.length -
  DOWNLOAD_FLAC_REPAIR_OWNER_SUFFIX.length

export const getDownloadFlacRepairPath = (transferPath: string, repairId: string): string => (
  `${transferPath}.${repairId}${DOWNLOAD_FLAC_REPAIR_SUFFIX}`
)

export const getDownloadFlacRepairOwnerPath = (repairPath: string): string => (
  `${repairPath}${DOWNLOAD_FLAC_REPAIR_OWNER_SUFFIX}`
)
