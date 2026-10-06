import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, OPERATION_SCHEMA_VERSION } from './config.js';
import { AppError, fail } from './errors.js';
import { capacity, diffRgb, embedPayload, extractPayload, unusedBytesEqual } from './lsb.js';
import { decodePng, encodeRgbaPng, readPngFile } from './png.js';
import type { DataStore } from './store.js';

export type PayloadEncoding = 'utf8' | 'hex' | 'binary';

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function recordImage(store: DataStore, values: {
  sha: string; name: string; filePath: string; size: number; width: number; height: number; role: 'original' | 'output';
}): number {
  const existing = store.db.prepare('SELECT id FROM images WHERE sha256 = ?').get(values.sha) as { id: number } | undefined;
  if (existing) return existing.id;
  const result = store.db.prepare(`
    INSERT INTO images (sha256, file_name, file_path, file_size, width, height, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(values.sha, values.name, values.filePath, values.size, values.width, values.height, values.role);
  return Number(result.lastInsertRowid);
}

function recordOperation(store: DataStore, values: {
  kind: 'embed' | 'check'; status: 'success' | 'failed'; sourceImageId?: number; outputImageId?: number;
  payloadSha?: string; payloadLength?: number; outputPath?: string; errorCode?: string;
  errorMessage?: string; report?: unknown;
}): number {
  const result = store.db.prepare(`
    INSERT INTO operations (
      schema_version, kind, status, source_image_id, output_image_id, payload_sha256,
      payload_length, output_path, error_code, error_message, report_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    OPERATION_SCHEMA_VERSION,
    values.kind,
    values.status,
    values.sourceImageId ?? null,
    values.outputImageId ?? null,
    values.payloadSha ?? null,
    values.payloadLength ?? null,
    values.outputPath ?? null,
    values.errorCode ?? null,
    values.errorMessage ?? null,
    values.report === undefined ? null : JSON.stringify(values.report),
  );
  return Number(result.lastInsertRowid);
}

async function writeFileAtomic(targetDir: string, finalPath: string, tmpDir: string, contents: Buffer): Promise<void> {
  const tempPath = path.join(tmpDir, `${path.basename(finalPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tempPath, contents);
  try {
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export function decodePayloadInput(input: string | undefined, encoding: 'utf8' | 'hex'): Buffer {
  const value = input ?? '';
  if (encoding === 'utf8') return Buffer.from(value, 'utf8');
  if (value.length % 2 !== 0) throw new AppError('INVALID_HEX', '十六进制长度必须为偶数。', 400);
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new AppError('INVALID_HEX', '十六进制只能包含字节对。', 400);
  return Buffer.from(value, 'hex');
}

export async function importCarrier(store: DataStore, file: Buffer, originalName = 'upload.png'): Promise<{
  id: number; sha256: string; width: number; height: number; path: string; capacity: ReturnType<typeof capacity>;
}> {
  if (file.length > LIMITS.maxInputBytes) throw new AppError('INPUT_TOO_LARGE', `输入不能超过 ${LIMITS.maxInputBytes} 字节。`, 413);
  const image = decodePng(file);
  const hash = sha256(file);
  const finalName = `${hash}.png`;
  const finalPath = path.join(store.originalsDir, finalName);
  await writeFileAtomic(store.originalsDir, finalPath, store.tmpDir, file);
  const id = recordImage(store, { sha: hash, name: originalName, filePath: finalPath, size: file.length, width: image.width, height: image.height, role: 'original' });
  return { id, sha256: hash, width: image.width, height: image.height, path: finalPath, capacity: capacity(image.width, image.height) };
}

function getImage(store: DataStore, imageId: number) {
  const row = store.db.prepare('SELECT * FROM images WHERE id = ?').get(imageId) as
    | { id: number; sha256: string; file_path: string; width: number; height: number; role: string }
    | undefined;
  if (!row) throw new AppError('IMAGE_NOT_FOUND', `找不到图片 ID ${imageId}。`, 404);
  return row;
}

export async function embedFromCarrier(store: DataStore, imageId: number, payload: Buffer, encoding: PayloadEncoding = 'binary'): Promise<{
  operationId: number; outputImageId: number; outputPath: string; payloadSha256: string; verification: unknown;
}> {
  if (payload.length > LIMITS.maxPayloadBytes) throw new AppError('PAYLOAD_TOO_LARGE', `声明载荷不能超过 ${LIMITS.maxPayloadBytes} 字节。`, 413);
  const imageRow = getImage(store, imageId);
  try {
    const { image: sourceImage } = await readPngFile(imageRow.file_path);
    const stegoImage = embedPayload(sourceImage, payload);
    const encoded = encodeRgbaPng(stegoImage);
    if (encoded.length > LIMITS.maxEncodedPngBytes) throw new AppError('OUTPUT_TOO_LARGE', '派生 PNG 编码后超过大小限制。', 413);

    const payloadHash = sha256(payload);
    store.db.prepare('INSERT OR IGNORE INTO payloads (sha256, byte_length, input_encoding) VALUES (?, ?, ?)')
      .run(payloadHash, payload.length, encoding);

    const outputHash = sha256(encoded);
    const outputName = `embed_${imageId}_${outputHash.slice(0, 16)}.png`;
    const outputPath = path.join(store.outputsDir, outputName);
    if (!await exists(outputPath)) await writeFileAtomic(store.outputsDir, outputPath, store.tmpDir, encoded);

    const reopened = await readPngFile(outputPath);
    const verification = extractPayload(reopened.image);
    if (!verification.valid || !verification.payload.equals(payload)) {
      throw new AppError('POST_EMBED_VERIFY_FAILED', '输出 PNG 重读后未能提取出完整一致载荷。', 500);
    }
    const comparison = diffRgb(sourceImage, reopened.image);
    const report = {
      schemaVersion: OPERATION_SCHEMA_VERSION,
      sourceSha256: imageRow.sha256,
      payloadSha256: payloadHash,
      payloadLength: payload.length,
      outputSha256: outputHash,
      capacity: verification.capacity,
      extractionStatus: verification.status,
      changedChannels: comparison.changes.length,
      alphaChanged: comparison.alphaChanged,
      maxRgbDelta: comparison.maxDelta,
      unusedRegionUnchanged: unusedBytesEqual(sourceImage, reopened.image, (40 + payload.length) * 8),
    };
    if (report.alphaChanged || report.maxRgbDelta > 1 || !report.unusedRegionUnchanged) {
      throw new AppError('POST_EMBED_VERIFY_FAILED', '嵌入后的像素约束验证失败。', 500);
    }

    const outputImageId = recordImage(store, { sha: outputHash, name: outputName, filePath: outputPath, size: encoded.length, width: sourceImage.width, height: sourceImage.height, role: 'output' });
    const operationId = recordOperation(store, { kind: 'embed', status: 'success', sourceImageId: imageId, outputImageId, payloadSha: payloadHash, payloadLength: payload.length, outputPath, report });
    return { operationId, outputImageId, outputPath, payloadSha256: payloadHash, verification: report };
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError('EMBED_FAILED', String(error), 500);
    recordOperation(store, { kind: 'embed', status: 'failed', sourceImageId: imageId, payloadLength: payload.length, errorCode: appError.code, errorMessage: appError.message });
    throw appError;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function checkImageFile(store: DataStore, filePath: string, sourceImageId?: number): Promise<{ operationId?: number; result: ReturnType<typeof extractPayload> }> {
  const { image } = await readPngFile(filePath);
  const result = extractPayload(image);
  const report = {
    status: result.status,
    valid: result.valid,
    declaredLength: result.declaredLength,
    expectedDigest: result.expectedDigest,
    actualDigest: result.actualDigest,
    payloadLength: result.payload.length,
    capacity: result.capacity,
  };
  let operationId: number | undefined;
  if (sourceImageId !== undefined) {
    operationId = recordOperation(store, {
      kind: 'check',
      status: result.valid ? 'success' : 'failed',
      sourceImageId,
      payloadLength: result.payload.length,
      outputPath: filePath,
      errorCode: result.valid ? undefined : result.status.toUpperCase(),
      errorMessage: result.valid ? undefined : humanStatus(result.status),
      report,
    });
  }
  return { operationId, result };
}

export async function checkOperation(store: DataStore, operationId: number) {
  const row = store.db.prepare('SELECT output_path, output_image_id FROM operations WHERE id = ? AND kind = ?').get(operationId, 'embed') as
    | { output_path: string | null; output_image_id: number | null } | undefined;
  if (!row?.output_path) throw new AppError('OPERATION_NOT_FOUND', `找不到嵌入操作 ${operationId} 或其输出。`, 404);
  return checkImageFile(store, row.output_path, row.output_image_id ?? undefined);
}

export function humanStatus(status: string): string {
  if (status === 'magic_not_found') return '魔数不存在：该图片不是本格式的 LSB1 载体，或低位已被重写。';
  if (status === 'length_exceeds_capacity') return '声明长度超过像素可容纳容量，按伪造/损坏包头拒绝。';
  if (status === 'digest_mismatch') return '找到 LSB1 包头，但载荷 SHA-256 摘要不匹配，载荷已损坏。';
  return '摘要和长度校验通过。';
}

export function getOperation(store: DataStore, id: number) {
  const row = store.db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
  if (!row) throw new AppError('OPERATION_NOT_FOUND', `找不到操作 ID ${id}。`, 404);
  return row;
}
