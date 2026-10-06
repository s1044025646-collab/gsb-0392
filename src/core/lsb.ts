import { createHash } from "node:crypto";
import { ApiError } from "./errors.js";

export const MAGIC = Buffer.from("LSB1", "ascii");
export const HEADER_LEN = 40; // 4 magic + 4 length + 32 sha256
export const OPERATION_VERSION = 1;

export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer; // RGBA, 4 bytes per pixel
}

/** 可用载荷字节数（不含包头） */
export function payloadCapacity(width: number, height: number): number {
  return Math.floor((width * height * 3) / 8) - HEADER_LEN;
}

export function buildHeader(payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header.writeUInt32BE(payload.length, 4);
  createHash("sha256").update(payload).digest().copy(header, 8);
  return header;
}

function setBit(data: Buffer, bitIndex: number, bit: number): void {
  const pixel = Math.floor(bitIndex / 3);
  const channel = bitIndex % 3; // 0=R 1=G 2=B
  const off = pixel * 4 + channel;
  data[off] = (data[off] & 0xfe) | bit;
}

function getBit(data: Buffer, bitIndex: number): number {
  const pixel = Math.floor(bitIndex / 3);
  const channel = bitIndex % 3;
  return data[pixel * 4 + channel] & 1;
}

function embedBytes(data: Buffer, bytes: Buffer, startBit: number): void {
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 7; b >= 0; b--) {
      setBit(data, startBit + i * 8 + (7 - b), (bytes[i] >> b) & 1);
    }
  }
}

function extractBytes(data: Buffer, startBit: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | getBit(data, startBit + i * 8 + b);
    out[i] = v;
  }
  return out;
}

/** 就地嵌入，返回修改过的通道字节数 */
export function embed(img: RgbaImage, payload: Buffer): number {
  const capacity = payloadCapacity(img.width, img.height);
  if (payload.length > capacity) {
    throw new ApiError(
      "PAYLOAD_TOO_LARGE",
      `载荷 ${payload.length} 字节超出容量 ${capacity} 字节`,
      413,
    );
  }
  const blob = Buffer.concat([buildHeader(payload), payload]);
  embedBytes(img.data, blob, 0);
  return blob.length * 8;
}

export type ExtractResult =
  | { ok: true; payload: Buffer; declaredLength: number; digest: string }
  | { ok: false; code: "MAGIC_NOT_FOUND" | "LENGTH_INVALID" | "PAYLOAD_CORRUPT"; message: string };

export function extract(img: RgbaImage): ExtractResult {
  const totalBits = img.width * img.height * 3;
  if (totalBits < HEADER_LEN * 8) {
    return { ok: false, code: "MAGIC_NOT_FOUND", message: "图片容量不足，无法容纳包头" };
  }
  const header = extractBytes(img.data, 0, HEADER_LEN);
  if (!header.subarray(0, 4).equals(MAGIC)) {
    return { ok: false, code: "MAGIC_NOT_FOUND", message: "未找到 LSB1 魔数，图片不含本工具嵌入的载荷" };
  }
  const declaredLength = header.readUInt32BE(4);
  const capacity = payloadCapacity(img.width, img.height);
  if (declaredLength > capacity) {
    return {
      ok: false,
      code: "LENGTH_INVALID",
      message: `声明长度 ${declaredLength} 超过像素容量 ${capacity}，数据已损坏或被伪造`,
    };
  }
  const payload = extractBytes(img.data, HEADER_LEN * 8, declaredLength);
  const digest = createHash("sha256").update(payload).digest("hex");
  if (!Buffer.from(digest, "hex").equals(header.subarray(8, 40))) {
    return { ok: false, code: "PAYLOAD_CORRUPT", message: "SHA-256 摘要不匹配，载荷已损坏" };
  }
  return { ok: true, payload, declaredLength, digest };
}

export interface BitMapping {
  byteOffset: number; // 相对载荷起点（负值表示包头区）
  bit: number; // 0..7，7 为最高位
  pixelIndex: number;
  x: number;
  y: number;
  channel: "R" | "G" | "B";
  before: number;
  after: number;
}

/** 查看指定载荷字节对应的像素通道及嵌入前后低位变化 */
export function mapPayloadBytes(
  before: RgbaImage,
  after: RgbaImage,
  byteOffset: number,
  count: number,
): BitMapping[] {
  const out: BitMapping[] = [];
  const channels = ["R", "G", "B"] as const;
  for (let i = 0; i < count; i++) {
    const absByte = HEADER_LEN + byteOffset + i;
    for (let b = 7; b >= 0; b--) {
      const bitIndex = absByte * 8 + (7 - b);
      const pixel = Math.floor(bitIndex / 3);
      const ch = bitIndex % 3;
      const off = pixel * 4 + ch;
      out.push({
        byteOffset: byteOffset + i,
        bit: b,
        pixelIndex: pixel,
        x: pixel % before.width,
        y: Math.floor(pixel / before.width),
        channel: channels[ch],
        before: before.data[off],
        after: after.data[off],
      });
    }
  }
  return out;
}
