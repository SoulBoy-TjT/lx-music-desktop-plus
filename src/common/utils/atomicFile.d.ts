export function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void>
export function prepareAtomicWrite(filePath: string, tempPath: string, backupPath: string): Promise<void>
export function commitAtomicWrite(filePath: string, tempPath: string, backupPath: string): Promise<void>
