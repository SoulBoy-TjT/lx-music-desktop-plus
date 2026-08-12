import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

export const maxRepairableFlacTrailingBytes = 256
// STREAMINFO may report an unknown maximum frame size. Keep that legal case
// repairable within a bounded implementation scan window and otherwise fail closed.
const maxScannableFlacFrameSize = 16 * 1024 * 1024
const maxTerminalFrameHeaderCandidates = 4
const maxTerminalFrameBoundaryCandidates = 4
const maxScannableFlacMetadataBlocks = 1_024
const maxScannableFlacMetadataBytes = 64 * 1024 * 1024

interface FlacStreamInfo {
  audioOffset: number
  minBlockSize: number
  maxBlockSize: number
  minFrameSize: number
  maxFrameSize: number
  sampleRate: number
  channels: number
  bitsPerSample: number
  totalSamples: bigint
}

export interface FlacTrailingDataEvidence {
  candidates: Array<{
    endOffset: number
    trailingBytes: number
  }>
  expectedDecodedBytes: bigint
}

interface FlacFrameHeader {
  endOffset: number
}

const readExactly = async(
  handle: FileHandle,
  length: number,
  position: number,
  signal?: AbortSignal,
): Promise<Buffer | null> => {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    throwIfAborted(signal)
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset)
    if (bytesRead === 0) return null
    offset += bytesRead
  }
  return buffer
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'FLAC trailing-data inspection cancelled'))
}

const readUInt24BE = (buffer: Buffer, offset: number): number => (
  buffer[offset] * 0x10000 + buffer[offset + 1] * 0x100 + buffer[offset + 2]
)

const parseStreamInfo = async(
  handle: FileHandle,
  fileSize: number,
  signal?: AbortSignal,
): Promise<FlacStreamInfo | null> => {
  const marker = await readExactly(handle, 4, 0, signal)
  if (!marker?.equals(Buffer.from('fLaC', 'ascii'))) return null
  let offset = 4
  let blockIndex = 0
  let streamInfo: Omit<FlacStreamInfo, 'audioOffset'> | undefined
  while (offset + 4 <= fileSize) {
    throwIfAborted(signal)
    if (blockIndex >= maxScannableFlacMetadataBlocks || offset > maxScannableFlacMetadataBytes) return null
    const header = await readExactly(handle, 4, offset, signal)
    if (!header) return null
    const isLast = (header[0] & 0x80) !== 0
    const type = header[0] & 0x7f
    if (type === 0x7f) return null
    const length = readUInt24BE(header, 1)
    const dataOffset = offset + 4
    const nextOffset = dataOffset + length
    if (nextOffset > fileSize || nextOffset > maxScannableFlacMetadataBytes) return null
    if (type === 0) {
      if (blockIndex !== 0 || streamInfo != null || length !== 34) return null
      const data = await readExactly(handle, length, dataOffset, signal)
      if (!data) return null
      const packed = data.readBigUInt64BE(10)
      streamInfo = {
        minBlockSize: data.readUInt16BE(0),
        maxBlockSize: data.readUInt16BE(2),
        minFrameSize: readUInt24BE(data, 4),
        maxFrameSize: readUInt24BE(data, 7),
        sampleRate: Number(packed >> 44n),
        channels: Number((packed >> 41n) & 0x7n) + 1,
        bitsPerSample: Number((packed >> 36n) & 0x1fn) + 1,
        totalSamples: packed & ((1n << 36n) - 1n),
      }
    }
    offset = nextOffset
    blockIndex++
    if (isLast) break
  }
  if (!streamInfo || streamInfo.totalSamples === 0n || streamInfo.sampleRate === 0 ||
    streamInfo.bitsPerSample < 4 || streamInfo.bitsPerSample > 32 ||
    streamInfo.minBlockSize < 16 || streamInfo.maxBlockSize < streamInfo.minBlockSize || offset >= fileSize) return null
  return { ...streamInfo, audioOffset: offset }
}

const crc8 = (buffer: Buffer, start: number, end: number): number => {
  let value = 0
  for (let index = start; index < end; index++) {
    value ^= buffer[index]
    for (let bit = 0; bit < 8; bit++) value = value & 0x80 ? ((value << 1) ^ 0x07) & 0xff : (value << 1) & 0xff
  }
  return value
}

const updateCrc16 = (value: number, byte: number): number => {
  value ^= byte << 8
  for (let bit = 0; bit < 8; bit++) value = value & 0x8000 ? ((value << 1) ^ 0x8005) & 0xffff : (value << 1) & 0xffff
  return value
}

const parseUtf8Integer = (buffer: Buffer, offset: number): { value: bigint, offset: number } | null => {
  if (offset >= buffer.length) return null
  const first = buffer[offset]
  if ((first & 0x80) === 0) return { value: BigInt(first), offset: offset + 1 }
  let byteCount = 0
  for (let mask = 0x80; (first & mask) !== 0; mask >>= 1) byteCount++
  if (byteCount < 2 || byteCount > 7 || offset + byteCount > buffer.length) return null
  const payloadBits = 7 - byteCount
  let value = BigInt(first & (payloadBits === 0 ? 0 : (1 << payloadBits) - 1))
  for (let index = 1; index < byteCount; index++) {
    const byte = buffer[offset + index]
    if ((byte & 0xc0) !== 0x80) return null
    value = (value << 6n) | BigInt(byte & 0x3f)
  }
  const minimumValues = [0n, 0n, 0x80n, 0x800n, 0x10000n, 0x200000n, 0x4000000n, 0x80000000n]
  if (value < minimumValues[byteCount]) return null
  return { value, offset: offset + byteCount }
}

const resolveBlockSize = (
  code: number,
  buffer: Buffer,
  offset: number,
): { value: number, offset: number } | null => {
  if (code === 0) return null
  if (code === 1) return { value: 192, offset }
  if (code >= 2 && code <= 5) return { value: 576 << (code - 2), offset }
  if (code === 6) {
    if (offset >= buffer.length) return null
    return { value: buffer[offset] + 1, offset: offset + 1 }
  }
  if (code === 7) {
    if (offset + 2 > buffer.length) return null
    return { value: buffer.readUInt16BE(offset) + 1, offset: offset + 2 }
  }
  return { value: 256 << (code - 8), offset }
}

const fixedSampleRates = [0, 88_200, 176_400, 192_000, 8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 96_000]

const resolveSampleRate = (
  code: number,
  buffer: Buffer,
  offset: number,
  streamInfoRate: number,
): { value: number, offset: number } | null => {
  if (code === 0) return { value: streamInfoRate, offset }
  if (code < 12) return { value: fixedSampleRates[code], offset }
  if (code === 12) {
    if (offset >= buffer.length) return null
    return { value: buffer[offset] * 1_000, offset: offset + 1 }
  }
  if (code === 13 || code === 14) {
    if (offset + 2 > buffer.length) return null
    const value = buffer.readUInt16BE(offset) * (code === 14 ? 10 : 1)
    return { value, offset: offset + 2 }
  }
  return null
}

const resolveBitsPerSample = (code: number, streamInfoBits: number): number | null => {
  if (code === 0) return streamInfoBits
  return [0, 8, 12, 0, 16, 20, 24, 32][code] || null
}

const parseTerminalFrameHeader = (
  buffer: Buffer,
  start: number,
  streamInfo: FlacStreamInfo,
): FlacFrameHeader | null => {
  if (start + 6 > buffer.length || buffer[start] !== 0xff || (buffer[start + 1] & 0xfe) !== 0xf8) return null
  const variableBlockSize = (buffer[start + 1] & 0x01) !== 0
  const blockSizeCode = buffer[start + 2] >> 4
  const sampleRateCode = buffer[start + 2] & 0x0f
  const channelAssignment = buffer[start + 3] >> 4
  const sampleSizeCode = (buffer[start + 3] >> 1) & 0x07
  if ((buffer[start + 3] & 0x01) !== 0 || channelAssignment > 10 || sampleSizeCode === 3) return null
  const channels = channelAssignment <= 7 ? channelAssignment + 1 : 2
  const bitsPerSample = resolveBitsPerSample(sampleSizeCode, streamInfo.bitsPerSample)
  if (channels !== streamInfo.channels || bitsPerSample !== streamInfo.bitsPerSample) return null
  const encodedNumber = parseUtf8Integer(buffer, start + 4)
  if (!encodedNumber) return null
  const maximumNumber = variableBlockSize ? (1n << 36n) - 1n : 0x7fffffffn
  if (encodedNumber.value > maximumNumber) return null
  const blockSize = resolveBlockSize(blockSizeCode, buffer, encodedNumber.offset)
  if (!blockSize || blockSize.value > streamInfo.maxBlockSize) return null
  const sampleRate = resolveSampleRate(sampleRateCode, buffer, blockSize.offset, streamInfo.sampleRate)
  if (!sampleRate || sampleRate.value !== streamInfo.sampleRate || sampleRate.offset >= buffer.length) return null
  if (crc8(buffer, start, sampleRate.offset) !== buffer[sampleRate.offset]) return null
  const finalSample = variableBlockSize
    ? encodedNumber.value + BigInt(blockSize.value)
    : encodedNumber.value * BigInt(streamInfo.maxBlockSize) + BigInt(blockSize.value)
  if (finalSample !== streamInfo.totalSamples) return null
  return { endOffset: sampleRate.offset + 1 }
}

const findFrameEnd = (
  buffer: Buffer,
  frameStart: number,
  headerEnd: number,
  streamInfo: FlacStreamInfo,
  signal?: AbortSignal,
): number[] => {
  const ends: number[] = []
  let crc = 0
  for (let index = frameStart; index + 2 < buffer.length; index++) {
    if ((index - frameStart & 0xffff) === 0) throwIfAborted(signal)
    crc = updateCrc16(crc, buffer[index])
    const end = index + 3
    if (index + 1 < headerEnd) continue
    const trailingBytes = buffer.length - end
    const frameSize = end - frameStart
    if (trailingBytes < 1 || trailingBytes > maxRepairableFlacTrailingBytes ||
      frameSize > (streamInfo.maxFrameSize === 0 ? maxScannableFlacFrameSize : streamInfo.maxFrameSize) ||
      (streamInfo.minFrameSize > 0 && frameSize < streamInfo.minFrameSize)) continue
    if (buffer.readUInt16BE(index + 1) === crc) ends.push(end)
  }
  return ends
}

export const findRepairableFlacTrailingData = async(
  filePath: string,
  decodedBytes: number,
  signal?: AbortSignal,
): Promise<FlacTrailingDataEvidence | null> => {
  throwIfAborted(signal)
  const handle = await open(filePath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || !Number.isSafeInteger(stat.size)) return null
    const streamInfo = await parseStreamInfo(handle, stat.size, signal)
    if (!streamInfo) return null
    const expectedDecodedBytes = streamInfo.totalSamples * BigInt(streamInfo.channels) * 2n
    if (BigInt(decodedBytes) !== expectedDecodedBytes) return null
    const windowSize = Math.min(
      stat.size - streamInfo.audioOffset,
      (streamInfo.maxFrameSize === 0 ? maxScannableFlacFrameSize : streamInfo.maxFrameSize) + maxRepairableFlacTrailingBytes,
    )
    if (windowSize <= 0) return null
    const windowOffset = stat.size - windowSize
    const buffer = await readExactly(handle, windowSize, windowOffset, signal)
    if (!buffer) return null
    const terminalHeaders: Array<{ start: number, end: number }> = []
    for (let start = 0; start + 6 <= buffer.length; start++) {
      if ((start & 0xffff) === 0) throwIfAborted(signal)
      const header = parseTerminalFrameHeader(buffer, start, streamInfo)
      if (!header) continue
      terminalHeaders.push({ start, end: header.endOffset })
      if (terminalHeaders.length > maxTerminalFrameHeaderCandidates) return null
    }
    const candidateEndOffsets = new Set<number>()
    for (const header of terminalHeaders) {
      for (const end of findFrameEnd(buffer, header.start, header.end, streamInfo, signal)) {
        const endOffset = windowOffset + end
        const trailingBytes = stat.size - endOffset
        if (endOffset <= streamInfo.audioOffset || trailingBytes < 1 ||
          trailingBytes > maxRepairableFlacTrailingBytes) continue
        candidateEndOffsets.add(endOffset)
        if (candidateEndOffsets.size > maxTerminalFrameBoundaryCandidates) return null
      }
    }
    if (candidateEndOffsets.size === 0) return null
    const candidates = [...candidateEndOffsets]
      .sort((left, right) => left - right)
      .map(endOffset => ({ endOffset, trailingBytes: stat.size - endOffset }))
    return { candidates, expectedDecodedBytes }
  } finally {
    await handle.close()
  }
}
