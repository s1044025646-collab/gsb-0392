import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { AppError } from './errors.js';
import { LIMITS } from './config.js';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STATIC_REQUIRED_CHUNK = 'IHDR';
const APNG_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT']);

export function assertStaticRgbaPng(file: Buffer): void {
  if (file.length < 8 || !file.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new AppError('NOT_PNG', '文件不是 PNG（签名不匹配）。', 400);
  }

  let offset = 8;
  let ihdrCount = 0;
  while (offset + 12 <= file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > file.length) {
      throw new AppError('PNG_TRUNCATED', 'PNG 区块长度超出文件范围。', 400);
    }

    if (APNG_CHUNKS.has(type)) {
      throw new AppError('APNG_UNSUPPORTED', '不接受 APNG 动画区块（acTL/fcTL/fdAT）。', 400);
    }

    if (type === STATIC_REQUIRED_CHUNK) {
      ihdrCount += 1;
      if (length !== 13) throw new AppError('PNG_INVALID_IHDR', 'IHDR 长度必须为 13 字节。', 400);
      const width = file.readUInt32BE(dataStart);
      const height = file.readUInt32BE(dataStart + 4);
      const bitDepth = file.readUInt8(dataStart + 8);
      const colorType = file.readUInt8(dataStart + 9);
      const compression = file.readUInt8(dataStart + 10);
      const filter = file.readUInt8(dataStart + 11);
      const interlace = file.readUInt8(dataStart + 12);

      if (width === 0 || height === 0) throw new AppError('PNG_EMPTY', 'PNG 尺寸不能为零。', 400);
      if (width > LIMITS.maxImageDimension || height > LIMITS.maxImageDimension) {
        throw new AppError('IMAGE_TOO_LARGE', `图片宽高均不能超过 ${LIMITS.maxImageDimension} 像素。`, 400);
      }
      if (bitDepth !== 8) throw new AppError('UNSUPPORTED_BIT_DEPTH', `仅接受 8 位 PNG，收到 ${bitDepth} 位。`, 400);
      if (colorType !== 6) throw new AppError('UNSUPPORTED_COLOR_TYPE', `仅接受 RGBA 颜色类型 6，收到类型 ${colorType}。`, 400);
      if (compression !== 0 || filter !== 0) throw new AppError('UNSUPPORTED_PNG_METHOD', '仅接受标准 PNG 压缩/滤波方法 0。', 400);
      if (interlace !== 0) throw new AppError('INTERLACED_PNG_UNSUPPORTED', '不接受隔行扫描 PNG。', 400);
    }

    offset = crcEnd;
    if (type === 'IEND') break;
  }

  if (ihdrCount !== 1) throw new AppError('PNG_INVALID_IHDR', 'PNG 必须包含恰好一个 IHDR。', 400);
}

export function decodePng(file: Buffer): RgbaImage {
  assertStaticRgbaPng(file);
  let decoded: PNG;
  try {
    decoded = PNG.sync.read(file, { checkCRC: true });
  } catch (error) {
    throw new AppError('PNG_DECODE_FAILED', error instanceof Error ? error.message : 'PNG 解码失败。', 400);
  }
  const expected = decoded.width * decoded.height * 4;
  if (expected !== decoded.data.length) {
    throw new AppError('PNG_DECODE_FAILED', `解码像素长度异常：期望 ${expected}，实际 ${decoded.data.length}。`, 400);
  }
  return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) };
}

export async function readPngFile(filePath: string): Promise<{ file: Buffer; image: RgbaImage }> {
  const file = await fs.readFile(filePath);
  if (file.length > LIMITS.maxInputBytes) {
    throw new AppError('INPUT_TOO_LARGE', `PNG 文件不能超过 ${LIMITS.maxInputBytes} 字节。`, 400);
  }
  return { file, image: decodePng(file) };
}

export function encodeRgbaPng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height, bitDepth: 8, colorType: 6, deflateLevel: 9 });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png, { colorType: 6, bitDepth: 8, deflateLevel: 9 });
}
