import crypto from 'node:crypto';
import type { RgbaImage } from './png.js';
import { AppError } from './errors.js';

export const MAGIC = Buffer.from('LSB1', 'ascii');
export const HEADER_LENGTH = 40;
export const MAGIC_LENGTH = 4;
export const LENGTH_LENGTH = 4;
export const DIGEST_LENGTH = 32;

export interface Capacity {
  width: number;
  height: number;
  colorBits: number;
  headerBytes: number;
  payloadCapacityBytes: number;
}

export interface BitLocation {
  absoluteBit: number;
  section: 'header' | 'payload';
  payloadByteIndex?: number;
  payloadBitInByte?: number;
  pixelIndex: number;
  x: number;
  y: number;
  channel: 0 | 1 | 2;
  channelName: 'R' | 'G' | 'B';
  bitInChannel: 0;
}

export interface ChannelChange {
  x: number;
  y: number;
  channelName: 'R' | 'G' | 'B';
  before: number;
  after: number;
  delta: number;
  beforeLsb: number;
  afterLsb: number;
}

export function capacity(width: number, height: number): Capacity {
  const colorBits = width * height * 3;
  return {
    width,
    height,
    colorBits,
    headerBytes: HEADER_LENGTH,
    payloadCapacityBytes: Math.floor(colorBits / 8) - HEADER_LENGTH,
  };
}

export function assertPayloadFits(image: Pick<RgbaImage, 'width' | 'height'>, payload: Buffer): Capacity {
  const result = capacity(image.width, image.height);
  if (result.payloadCapacityBytes < 0) {
    throw new AppError('CAPACITY_TOO_SMALL', '像素位容量不足以容纳 40 字节包头。', 400);
  }
  if (payload.length > result.payloadCapacityBytes) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `载荷长度 ${payload.length} 超过可用容量 ${result.payloadCapacityBytes} 字节。`,
      413,
    );
  }
  return result;
}

export function buildHeader(payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(payload.length, MAGIC_LENGTH);
  crypto.createHash('sha256').update(payload).digest().copy(header, MAGIC_LENGTH + LENGTH_LENGTH);
  return header;
}

function setLsb(byte: number, bit: number): number {
  return (byte & 0xfe) | (bit & 1);
}

function readBit(data: Uint8Array, absoluteBit: number): number {
  const pixelIndex = Math.floor(absoluteBit / 3);
  const channel = absoluteBit % 3;
  return data[pixelIndex * 4 + channel] & 1;
}

function writeStreamBits(image: RgbaImage, stream: Buffer): void {
  for (let byteIndex = 0; byteIndex < stream.length; byteIndex += 1) {
    const value = stream[byteIndex];
    for (let bitInByte = 7; bitInByte >= 0; bitInByte -= 1) {
      const absoluteBit = byteIndex * 8 + (7 - bitInByte);
      const pixelIndex = Math.floor(absoluteBit / 3);
      const channel = absoluteBit % 3;
      const byteOffset = pixelIndex * 4 + channel;
      image.data[byteOffset] = setLsb(image.data[byteOffset], (value >>> bitInByte) & 1);
    }
  }
}

export function embedPayload(source: RgbaImage, payload: Buffer): RgbaImage {
  assertPayloadFits(source, payload);
  const image: RgbaImage = { width: source.width, height: source.height, data: new Uint8Array(source.data) };
  writeStreamBits(image, Buffer.concat([buildHeader(payload), payload]));
  return image;
}

function readStreamBits(data: Uint8Array, byteLength: number, startBit = 0): Buffer {
  const output = Buffer.alloc(byteLength);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
    let value = 0;
    for (let bitInByte = 0; bitInByte < 8; bitInByte += 1) {
      value = (value << 1) | readBit(data, startBit + byteIndex * 8 + bitInByte);
    }
    output[byteIndex] = value;
  }
  return output;
}

export interface ExtractionResult {
  valid: boolean;
  status: 'valid' | 'magic_not_found' | 'length_exceeds_capacity' | 'digest_mismatch';
  declaredLength: number | null;
  expectedDigest?: string;
  actualDigest?: string;
  payload: Buffer;
  capacity: Capacity;
}

export function extractPayload(image: RgbaImage): ExtractionResult {
  const imageCapacity = capacity(image.width, image.height);
  const base: ExtractionResult = {
    valid: false,
    status: 'magic_not_found',
    declaredLength: null,
    payload: Buffer.alloc(0),
    capacity: imageCapacity,
  };
  if (imageCapacity.payloadCapacityBytes < 0) return base;

  const header = readStreamBits(image.data, HEADER_LENGTH);
  if (!header.subarray(0, 4).equals(MAGIC)) return base;

  const declaredLength = header.readUInt32BE(4);
  base.declaredLength = declaredLength;
  if (declaredLength > imageCapacity.payloadCapacityBytes) {
    base.status = 'length_exceeds_capacity';
    return base;
  }

  const payload = readStreamBits(image.data, declaredLength, HEADER_LENGTH * 8);
  const expectedDigest = header.subarray(8, 40).toString('hex');
  const actualDigest = crypto.createHash('sha256').update(payload).digest('hex');
  base.payload = payload;
  base.expectedDigest = expectedDigest;
  base.actualDigest = actualDigest;
  if (expectedDigest !== actualDigest) {
    base.status = 'digest_mismatch';
    return base;
  }

  base.valid = true;
  base.status = 'valid';
  return base;
}

export function locatePayloadBit(image: RgbaImage, payloadByteIndex: number, payloadBitInByte: number): BitLocation {
  const cap = capacity(image.width, image.height);
  if (!Number.isInteger(payloadByteIndex) || payloadByteIndex < 0 || payloadByteIndex >= cap.payloadCapacityBytes) {
    throw new AppError('INVALID_PAYLOAD_OFFSET', '载荷字节下标超出容量范围。', 400);
  }
  if (!Number.isInteger(payloadBitInByte) || payloadBitInByte < 0 || payloadBitInByte > 7) {
    throw new AppError('INVALID_BIT_INDEX', '字节内位序号必须为 0 到 7，其中 0 表示最高位。', 400);
  }
  const absoluteBit = HEADER_LENGTH * 8 + payloadByteIndex * 8 + payloadBitInByte;
  const pixelIndex = Math.floor(absoluteBit / 3);
  const channel = absoluteBit % 3 as 0 | 1 | 2;
  return {
    absoluteBit,
    section: 'payload',
    payloadByteIndex,
    payloadBitInByte,
    pixelIndex,
    x: pixelIndex % image.width,
    y: Math.floor(pixelIndex / image.width),
    channel,
    channelName: (['R', 'G', 'B'] as const)[channel],
    bitInChannel: 0,
  };
}

export function diffRgb(before: RgbaImage, after: RgbaImage): { changes: ChannelChange[]; alphaChanged: boolean; maxDelta: number } {
  if (before.width !== after.width || before.height !== after.height || before.data.length !== after.data.length) {
    throw new AppError('IMAGE_MISMATCH', '比较图片的尺寸或像素数组长度不一致。', 400);
  }
  const changes: ChannelChange[] = [];
  let alphaChanged = false;
  let maxDelta = 0;
  for (let pixel = 0; pixel < before.width * before.height; pixel += 1) {
    const baseOffset = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const offset = baseOffset + channel;
      if (before.data[offset] !== after.data[offset]) {
        const delta = after.data[offset] - before.data[offset];
        maxDelta = Math.max(maxDelta, Math.abs(delta));
        changes.push({
          x: pixel % before.width,
          y: Math.floor(pixel / before.width),
          channelName: (['R', 'G', 'B'] as const)[channel],
          before: before.data[offset],
          after: after.data[offset],
          delta,
          beforeLsb: before.data[offset] & 1,
          afterLsb: after.data[offset] & 1,
        });
      }
    }
    if (before.data[baseOffset + 3] !== after.data[baseOffset + 3]) alphaChanged = true;
  }
  return { changes, alphaChanged, maxDelta };
}

export function unusedBytesEqual(before: RgbaImage, after: RgbaImage, usedBits: number): boolean {
  for (let absoluteBit = usedBits; absoluteBit < before.width * before.height * 3; absoluteBit += 1) {
    const pixelIndex = Math.floor(absoluteBit / 3);
    const channel = absoluteBit % 3;
    const offset = pixelIndex * 4 + channel;
    if (before.data[offset] !== after.data[offset]) return false;
  }
  for (let pixel = 0; pixel < before.width * before.height; pixel += 1) {
    if (before.data[pixel * 4 + 3] !== after.data[pixel * 4 + 3]) return false;
  }
  return true;
}
