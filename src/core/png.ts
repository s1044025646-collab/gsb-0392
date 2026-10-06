import { PNG } from "pngjs";
import { ApiError } from "./errors.js";
import type { RgbaImage } from "./lsb.js";

export const MAX_DIMENSION = 4096;
export const MAX_PIXELS = 16_777_216;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

function hasChunk(buf: Buffer, type: string): boolean {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (buf.toString("ascii", off + 4, off + 8) === type) return true;
    off += 12 + len;
  }
  return false;
}

export function decodeCarrier(buf: Buffer): RgbaImage {
  if (buf.length > MAX_FILE_BYTES) {
    throw new ApiError("LIMIT_EXCEEDED", `文件 ${buf.length} 字节超过上限 ${MAX_FILE_BYTES}`, 413);
  }
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new ApiError("INVALID_PNG", "不是有效的 PNG 文件");
  }
  if (hasChunk(buf, "acTL")) {
    throw new ApiError("APNG_NOT_SUPPORTED", "不支持 APNG 动图，请提供静态 PNG");
  }
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8) {
    throw new ApiError("UNSUPPORTED_PNG", `不支持 ${bitDepth} 位位深，仅接受 8 位`);
  }
  if (colorType !== 6) {
    throw new ApiError("UNSUPPORTED_PNG", `不支持颜色类型 ${colorType}，仅接受 8 位 RGBA（颜色类型 6）`);
  }
  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch (e) {
    throw new ApiError("INVALID_PNG", `PNG 解析失败: ${(e as Error).message}`);
  }
  if (png.width > MAX_DIMENSION || png.height > MAX_DIMENSION || png.width * png.height > MAX_PIXELS) {
    throw new ApiError("LIMIT_EXCEEDED", `尺寸 ${png.width}x${png.height} 超过限制`, 413);
  }
  return { width: png.width, height: png.height, data: Buffer.from(png.data) };
}

export function encodePng(img: RgbaImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height, bitDepth: 8, colorType: 6 });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}
