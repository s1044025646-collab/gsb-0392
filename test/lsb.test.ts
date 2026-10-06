import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  embed,
  extract,
  buildHeader,
  payloadCapacity,
  HEADER_LEN,
  type RgbaImage,
} from "../src/core/lsb.js";
import { decodeCarrier, encodePng } from "../src/core/png.js";
import { makeFixture } from "../src/fixtures.js";
import { ApiError } from "../src/core/errors.js";

function roundTrip(w: number, h: number, payload: Buffer) {
  const img = decodeCarrier(makeFixture(w, h));
  const before = Buffer.from(img.data);
  embed(img, payload);
  const reopened = decodeCarrier(encodePng(img));
  return { before, after: img, reopened, result: extract(reopened) };
}

test("往返：中文、零字节、空载荷", () => {
  const cases = [Buffer.from("你好，LSB1！", "utf8"), Buffer.from("00ff00610000", "hex"), Buffer.alloc(0)];
  for (const p of cases) {
    const { result } = roundTrip(32, 32, p);
    assert.ok(result.ok);
    assert.deepEqual(result.payload, p);
  }
});

test("恰好容量可嵌入，超一字节拒绝", () => {
  const cap = payloadCapacity(16, 16);
  assert.equal(cap, 56);
  embed(decodeCarrier(makeFixture(16, 16)), Buffer.alloc(cap, 0xab));
  assert.throws(() => embed(decodeCarrier(makeFixture(16, 16)), Buffer.alloc(cap + 1)), ApiError);
});

test("损坏魔数与损坏载荷区分", () => {
  const payload = Buffer.from("hello");
  const img = decodeCarrier(makeFixture(32, 32));
  embed(img, payload);
  const bad1 = { ...img, data: Buffer.from(img.data) };
  bad1.data[0] ^= 1;
  const r1 = extract(bad1);
  assert.ok(!r1.ok && r1.code === "MAGIC_NOT_FOUND");
  const bad2 = { ...img, data: Buffer.from(img.data) };
  const off = Math.floor((HEADER_LEN * 8) / 3) * 4 + ((HEADER_LEN * 8) % 3);
  bad2.data[off] ^= 1;
  const r2 = extract(bad2);
  assert.ok(!r2.ok && r2.code === "PAYLOAD_CORRUPT");
});

test("伪造巨大长度", () => {
  const img = decodeCarrier(makeFixture(16, 16));
  embed(img, Buffer.from("x"));
  const bad = { ...img, data: Buffer.from(img.data) };
  bad.data[Math.floor(32 / 3) * 4 + (32 % 3)] |= 1;
  const r = extract(bad);
  assert.ok(!r.ok && r.code === "LENGTH_INVALID");
});

test("含透明像素载体：Alpha 不变、RGB 差值不超过一、未用区域一致", () => {
  const payload = Buffer.from("短载荷");
  const { before, after } = roundTrip(32, 32, payload);
  const usedBits = (HEADER_LEN + payload.length) * 8;
  const usedPixels = Math.ceil(usedBits / 3);
  for (let p = 0; p < 32 * 32; p++) {
    assert.equal(after.data[p * 4 + 3], before[p * 4 + 3], `alpha@${p}`);
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(after.data[p * 4 + c] - before[p * 4 + c]);
      assert.ok(d <= 1, `delta@${p},${c}=${d}`);
      if (p >= usedPixels) assert.equal(after.data[p * 4 + c], before[p * 4 + c]);
    }
  }
});

test("手算像素向量：位序与大端长度", () => {
  const img: RgbaImage = { width: 16, height: 16, data: Buffer.alloc(16 * 16 * 4, 0xfe) };
  for (let p = 0; p < 256; p++) img.data[p * 4 + 3] = 0xff;
  embed(img, Buffer.from([0x80]));
  const header = buildHeader(Buffer.from([0x80]));
  const blob = Buffer.concat([header, Buffer.from([0x80])]);
  for (let i = 0; i < blob.length * 8; i++) {
    const byte = blob[Math.floor(i / 8)];
    const bit = (byte >> (7 - (i % 8))) & 1;
    const pixel = Math.floor(i / 3);
    const ch = i % 3;
    assert.equal(img.data[pixel * 4 + ch] & 1, bit, `bit ${i}`);
  }
  assert.equal(img.data[Math.floor(63 / 3) * 4 + (63 % 3)] & 1, 1);
  for (let i = 32; i < 63; i++) {
    assert.equal(img.data[Math.floor(i / 3) * 4 + (i % 3)] & 1, 0, `len bit ${i}`);
  }
  assert.equal(img.data[Math.floor(320 / 3) * 4 + (320 % 3)] & 1, 1);
  for (let i = 321; i < 328; i++) {
    assert.equal(img.data[Math.floor(i / 3) * 4 + (i % 3)] & 1, 0);
  }
  const digest = createHash("sha256").update(Buffer.from([0x80])).digest();
  for (let i = 0; i < 256; i++) {
    const bit = (digest[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
    const gi = 64 + i;
    assert.equal(img.data[Math.floor(gi / 3) * 4 + (gi % 3)] & 1, bit);
  }
});

test("拒绝 APNG", () => {
  const rgb = Buffer.from(makeFixture(8, 8));
  const actl = Buffer.alloc(20);
  actl.writeUInt32BE(8, 0);
  actl.write("acTL", 4, "ascii");
  const apng = Buffer.concat([rgb.subarray(0, 33), actl, rgb.subarray(33)]);
  assert.throws(() => decodeCarrier(apng), /APNG/);
});
