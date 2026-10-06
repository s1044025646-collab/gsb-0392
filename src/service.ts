import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Store } from "./db.js";
import { decodeCarrier, encodePng, MAX_PAYLOAD_BYTES } from "./core/png.js";
import {
  embed,
  extract,
  mapPayloadBytes,
  payloadCapacity,
  OPERATION_VERSION,
  type RgbaImage,
} from "./core/lsb.js";
import { ApiError } from "./core/errors.js";

export function parsePayload(opts: { text?: string; hex?: string }): Buffer {
  if (opts.text !== undefined && opts.hex !== undefined) {
    throw new ApiError("BAD_REQUEST", "text 与 hex 只能二选一");
  }
  let payload: Buffer;
  if (opts.hex !== undefined) {
    const h = opts.hex.replace(/\s+/g, "");
    if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) {
      throw new ApiError("INVALID_PAYLOAD", "hex 载荷格式非法");
    }
    payload = Buffer.from(h, "hex");
  } else if (opts.text !== undefined) {
    payload = Buffer.from(opts.text, "utf8");
  } else {
    payload = Buffer.alloc(0);
  }
  if (payload.length > MAX_PAYLOAD_BYTES) {
    throw new ApiError("LIMIT_EXCEEDED", `声明载荷超过上限 ${MAX_PAYLOAD_BYTES} 字节`, 413);
  }
  return payload;
}

export class Service {
  constructor(
    public store: Store,
    public dataDir: string,
  ) {}

  importCarrier(buf: Buffer) {
    const img = decodeCarrier(buf);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const id = this.store.addCarrier(sha256, img.width, img.height, "");
    const rel = path.join("carriers", `carrier-${id}.png`);
    fs.writeFileSync(path.join(this.dataDir, rel), buf);
    this.store.db.prepare("UPDATE carriers SET path=? WHERE id=?").run(rel, id);
    return { id, sha256, width: img.width, height: img.height, capacity: payloadCapacity(img.width, img.height) };
  }

  private loadCarrierImage(id: number) {
    const row = this.store.getCarrier(id);
    if (!row) throw new ApiError("NOT_FOUND", `载体 ${id} 不存在`, 404);
    const img = decodeCarrier(fs.readFileSync(path.join(this.dataDir, row.path)));
    return { row, img };
  }

  capacity(carrierId: number) {
    const { row } = this.loadCarrierImage(carrierId);
    return {
      carrierId,
      width: row.width,
      height: row.height,
      capacityBytes: payloadCapacity(row.width, row.height),
      headerBytes: 40,
    };
  }

  embed(carrierId: number, payload: Buffer) {
    const { img } = this.loadCarrierImage(carrierId);
    const capacity = payloadCapacity(img.width, img.height);
    if (payload.length > capacity) {
      throw new ApiError("PAYLOAD_TOO_LARGE", `载荷 ${payload.length} 字节超出容量 ${capacity} 字节`, 413);
    }
    const bitsUsed = embed(img, payload);
    const outBuf = encodePng(img);
    const payloadSha = createHash("sha256").update(payload).digest("hex");
    const id = this.store.addOutput({
      carrier_id: carrierId,
      payload_sha256: payloadSha,
      payload_len: payload.length,
      path: "",
      status: "embedded",
      report: null,
      version: OPERATION_VERSION,
    });
    const rel = path.join("derived", `output-${id}.png`);
    fs.writeFileSync(path.join(this.dataDir, rel), outBuf);
    this.store.db.prepare("UPDATE outputs SET path=? WHERE id=?").run(rel, id);
    return { outputId: id, payloadBytes: payload.length, bitsUsed, sha256: payloadSha, path: rel };
  }

  private loadOutputImage(outputId: number) {
    const row = this.store.getOutput(outputId);
    if (!row) throw new ApiError("NOT_FOUND", `输出 ${outputId} 不存在`, 404);
    const img = decodeCarrier(fs.readFileSync(path.join(this.dataDir, row.path)));
    return { row, img };
  }

  /** 重新打开输出 PNG 像素进行提取与核验，结果写回数据库 */
  extract(outputId: number) {
    const { row, img } = this.loadOutputImage(outputId);
    const result = extract(img);
    const report = {
      outputId,
      version: row.version,
      checkedAt: new Date().toISOString(),
      ok: result.ok,
      code: result.ok ? "OK" : result.code,
      message: result.ok ? "校验通过" : result.message,
    };
    if (result.ok) {
      this.store.updateOutputReport(outputId, "verified", JSON.stringify(report));
      const text = Buffer.from(result.payload.toString("utf8"), "utf8").equals(result.payload)
        ? result.payload.toString("utf8")
        : null;
      return {
        ok: true as const,
        length: result.declaredLength,
        sha256: result.digest,
        hex: result.payload.toString("hex"),
        text,
      };
    }
    this.store.updateOutputReport(outputId, result.code, JSON.stringify(report));
    return { ok: false as const, code: result.code, message: result.message };
  }

  map(outputId: number, byteOffset: number, count: number) {
    const { row, img: after } = this.loadOutputImage(outputId);
    const carrier = this.store.getCarrier(row.carrier_id);
    if (!carrier) throw new ApiError("NOT_FOUND", "原载体记录缺失", 404);
    const before = decodeCarrier(fs.readFileSync(path.join(this.dataDir, carrier.path)));
    if (byteOffset < -40 || byteOffset + count > row.payload_len) {
      throw new ApiError("BAD_REQUEST", `字节范围越界（载荷长度 ${row.payload_len}）`);
    }
    return mapPayloadBytes(before, after, byteOffset, count);
  }

  /** 嵌入前后低位变化统计（不输出整张图片） */
  diff(outputId: number) {
    const { row, img: after } = this.loadOutputImage(outputId);
    const carrier = this.store.getCarrier(row.carrier_id);
    if (!carrier) throw new ApiError("NOT_FOUND", "原载体记录缺失", 404);
    const before = decodeCarrier(fs.readFileSync(path.join(this.dataDir, carrier.path)));
    let changed = 0;
    let maxDelta = 0;
    let alphaChanged = 0;
    const pixels = before.width * before.height;
    for (let p = 0; p < pixels; p++) {
      for (let c = 0; c < 4; c++) {
        const d = Math.abs(before.data[p * 4 + c] - after.data[p * 4 + c]);
        if (c === 3 && d !== 0) alphaChanged++;
        if (c < 3) {
          if (d !== 0) changed++;
          if (d > maxDelta) maxDelta = d;
        }
      }
    }
    return { outputId, changedChannels: changed, maxDelta, alphaChanged };
  }
}
