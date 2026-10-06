import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { PNG } from 'pngjs';
import { diffRgb, embedPayload, extractPayload, HEADER_LENGTH, locatePayloadBit, unusedBytesEqual } from '../src/lsb.js';
import { decodePng, encodeRgbaPng } from '../src/png.js';
import type { RgbaImage } from '../src/png.js';

function makePng(width: number, height: number, seed = 5, transparent = false): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = (i * 31 + seed) & 0xfe;
    data[i * 4 + 1] = (i * 47 + seed * 3) & 0xfe;
    data[i * 4 + 2] = (i * 59 + seed * 7) & 0xfe;
    data[i * 4 + 3] = transparent && i % 5 === 0 ? 0 : 255;
  }
  return decodePng(encodeRgbaPng({ width, height, data }));
}

test('按 R、G、B 且 MSB first 写入魔数字节 L', () => {
  const image = embedPayload(makePng(64, 2), Buffer.alloc(0));
  const expectedL = [0, 1, 0, 0, 1, 1, 0, 0];
  for (let bit = 0; bit < 8; bit += 1) {
    const pixel = Math.floor(bit / 3);
    const channel = bit % 3;
    assert.equal(image.data[pixel * 4 + channel] & 1, expectedL[bit]);
  }
});

test('空载荷长度为大端 32 位零且可完整提取', () => {
  const original = makePng(11, 10);
  const stego = embedPayload(original, Buffer.alloc(0));
  for (let bit = 32; bit < 64; bit += 1) {
    assert.equal(stego.data[Math.floor(bit / 3) * 4 + (bit % 3)] & 1, 0);
  }
  const result = extractPayload(decodePng(encodeRgbaPng(stego)));
  assert.equal(result.valid, true);
  assert.equal(result.payload.length, 0);
});

test('长度 1 的大端末位位于第 63 个颜色位', () => {
  const original = makePng(12, 10);
  const stego = embedPayload(original, Buffer.from([0]));
  assert.equal(stego.data[Math.floor(63 / 3) * 4 + (63 % 3)] & 1, 1);
  for (let bit = 32; bit < 63; bit += 1) {
    assert.equal(stego.data[Math.floor(bit / 3) * 4 + (bit % 3)] & 1, 0);
  }
});

for (const payload of [
  ['中文 UTF-8', Buffer.from('你好，LSB！', 'utf8')],
  ['含零字节', Buffer.from([0, 1, 2, 0, 255, 0, 128])],
  ['空载荷', Buffer.alloc(0)],
] as const) {
  test(`PNG 重编码后重读得到完全相同字节：${payload[0]}`, () => {
    const original = makePng(96, 24, 11, true);
    const stego = embedPayload(original, payload[1]);
    const reopened = decodePng(encodeRgbaPng(stego));
    const result = extractPayload(reopened);
    assert.equal(result.valid, true);
    assert.ok(result.payload.equals(payload[1]));
  });
}

test('透明像素也参与，Alpha 完全不变，RGB 差值不超过一，未用区域不变', () => {
  const original = makePng(96, 24, 19, true);
  const payload = Buffer.from('透明区域也承载比特', 'utf8');
  const stego = embedPayload(original, payload);
  const comparison = diffRgb(original, stego);
  assert.equal(comparison.alphaChanged, false);
  assert.ok(comparison.maxDelta <= 1);
  assert.equal(unusedBytesEqual(original, stego, (HEADER_LENGTH + payload.length) * 8), true);
});

test('恰好容量成功，超一字节拒绝', () => {
  const width = 80;
  const height = 20;
  const capacityBytes = Math.floor((width * height * 3) / 8) - HEADER_LENGTH;
  const image = makePng(width, height);
  assert.equal(extractPayload(embedPayload(image, Buffer.alloc(capacityBytes))).valid, true);
  assert.throws(() => embedPayload(image, Buffer.alloc(capacityBytes + 1)), { code: 'PAYLOAD_TOO_LARGE' });
});

test('区分魔数不存在与摘要损坏', () => {
  const image = makePng(96, 24);
  const stego = embedPayload(image, Buffer.from('abc'));
  assert.equal(extractPayload(stego).status, 'valid');

  const noMagic = new Uint8Array(stego.data);
  noMagic[0] = noMagic[0] ^ 1;
  assert.equal(extractPayload({ ...stego, data: noMagic }).status, 'magic_not_found');

  const damaged = new Uint8Array(stego.data);
  const location = locatePayloadBit(stego, 0, 7);
  damaged[location.pixelIndex * 4 + location.channel] ^= 1;
  const result = extractPayload({ ...stego, data: damaged });
  assert.equal(result.status, 'digest_mismatch');
  assert.notEqual(result.expectedDigest, result.actualDigest);
});

test('伪造超过容量的巨大长度被拒绝', () => {
  const stego = embedPayload(makePng(12, 10), Buffer.from([0]));
  for (let bit = 32; bit < 64; bit += 1) stego.data[Math.floor(bit / 3) * 4 + (bit % 3)] |= 1;
  assert.equal(extractPayload(stego).status, 'length_exceeds_capacity');
});

test('拒绝十六位、非 RGBA、APNG 和非 PNG', () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer): Buffer => {
    const typeBuffer = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Number(zlib.crc32(Buffer.concat([typeBuffer, data]))) >>> 0, 0);
    return Buffer.concat([
      length,
      typeBuffer,
      data,
      crc,
    ]);
  };
  const ihdrPng = (bitDepth: number, colorType: number): Buffer => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
  };
  assert.throws(() => decodePng(ihdrPng(8, 0)), { code: 'UNSUPPORTED_COLOR_TYPE' });
  assert.throws(() => decodePng(ihdrPng(16, 6)), { code: 'UNSUPPORTED_BIT_DEPTH' });

  const base = encodeRgbaPng(makePng(1, 1));
  const actl = chunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]));
  const insertAt = base.indexOf(Buffer.from('IDAT', 'ascii')) - 4;
  assert.throws(() => decodePng(Buffer.concat([base.subarray(0, insertAt), actl, base.subarray(insertAt)])), { code: 'APNG_UNSUPPORTED' });
  assert.throws(() => decodePng(Buffer.from('not png')), { code: 'NOT_PNG' });
});
