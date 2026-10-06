import fs from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIMITS } from './config.js';
import { AppError } from './errors.js';
import { capacity, locatePayloadBit } from './lsb.js';
import { initStore, type DataStore } from './store.js';
import { readPngFile } from './png.js';
import { checkImageFile, checkOperation, decodePayloadInput, embedFromCarrier, getOperation, humanStatus, importCarrier } from './service.js';

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMITS.maxJsonBytes) throw new AppError('REQUEST_TOO_LARGE', `请求体不能超过 ${LIMITS.maxJsonBytes} 字节。`, 413);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', '请求体必须是合法 JSON。', 400);
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof AppError) {
    sendJson(res, error.statusCode, { ok: false, code: error.code, error: error.message });
  } else {
    sendJson(res, 500, { ok: false, code: 'INTERNAL_ERROR', error: error instanceof Error ? error.message : String(error) });
  }
}

function requireId(value: string | undefined, name = 'id'): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('INVALID_ID', `${name} 必须是正整数。`, 400);
  return id;
}

function requireNonNegativeInt(value: string | null, name: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    throw new AppError('INVALID_NON_NEGATIVE_INT', `${name} 必须是非负整数。`, 400);
  }
  return numberValue;
}

async function getImagePath(store: DataStore, id: number): Promise<string> {
  const row = store.db.prepare('SELECT file_path FROM images WHERE id = ?').get(id) as { file_path: string } | undefined;
  if (!row) throw new AppError('IMAGE_NOT_FOUND', `找不到图片 ID ${id}。`, 404);
  return row.file_path;
}

export function createServer(store: DataStore): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathParts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, service: 'png-lsb-lab', dataDir: store.root });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/carriers') {
        const body = await readJson(req);
        if (typeof body?.contentBase64 !== 'string') throw new AppError('MISSING_CARRIER', '需要 contentBase64 字段。', 400);
        let file: Buffer;
        try { file = Buffer.from(body.contentBase64, 'base64'); } catch { throw new AppError('INVALID_BASE64', 'contentBase64 不是合法 Base64。', 400); }
        sendJson(res, 201, await importCarrier(store, file, typeof body.fileName === 'string' ? body.fileName : 'upload.png'));
        return;
      }

      if (method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'images' && pathParts[3] === 'capacity') {
        const id = requireId(pathParts[2], 'imageId');
        const row = store.db.prepare('SELECT width,height FROM images WHERE id=?').get(id) as { width: number; height: number } | undefined;
        if (!row) throw new AppError('IMAGE_NOT_FOUND', `找不到图片 ID ${id}。`, 404);
        sendJson(res, 200, capacity(row.width, row.height));
        return;
      }

      if (method === 'POST' && url.pathname === '/api/embed') {
        const body = await readJson(req);
        const imageId = requireId(String(body?.imageId), 'imageId');
        const encoding = body?.encoding === 'hex' ? 'hex' : 'utf8';
        if (typeof body?.payload !== 'string') throw new AppError('MISSING_PAYLOAD', '需要字符串 payload。', 400);
        const result = await embedFromCarrier(store, imageId, decodePayloadInput(body.payload, encoding), encoding);
        sendJson(res, 201, { ok: true, ...result });
        return;
      }

      if (method === 'POST' && pathParts[0] === 'api' && pathParts[1] === 'images' && pathParts[3] === 'extract') {
        const id = requireId(pathParts[2], 'imageId');
        const check = await checkImageFile(store, await getImagePath(store, id), id);
        const r = check.result;
        sendJson(res, r.valid ? 200 : 422, {
          ok: r.valid,
          operationId: check.operationId,
          status: r.status,
          message: humanStatus(r.status),
          declaredLength: r.declaredLength,
          payloadLength: r.payload.length,
          payloadBase64: r.payload.toString('base64'),
          payloadUtf8: r.payload.toString('utf8'),
          payloadHex: r.payload.toString('hex'),
          expectedDigest: r.expectedDigest,
          actualDigest: r.actualDigest,
          capacity: r.capacity,
        });
        return;
      }

      if (method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'operations' && pathParts[3] === 'check') {
        const id = requireId(pathParts[2], 'operationId');
        const check = await checkOperation(store, id);
        const r = check.result;
        sendJson(res, r.valid ? 200 : 422, {
          ok: r.valid,
          operationId: check.operationId,
          status: r.status,
          message: humanStatus(r.status),
          payloadLength: r.payload.length,
          payloadBase64: r.payload.toString('base64'),
          payloadUtf8: r.payload.toString('utf8'),
          payloadHex: r.payload.toString('hex'),
          expectedDigest: r.expectedDigest,
          actualDigest: r.actualDigest,
        });
        return;
      }

      if (method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'operations' && pathParts.length === 3) {
        sendJson(res, 200, getOperation(store, requireId(pathParts[2], 'operationId')));
        return;
      }

      if (method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'operations' && pathParts[3] === 'bit-audit') {
        const id = requireId(pathParts[2], 'operationId');
        const operation = getOperation(store, id) as {
          source_image_id: number | null;
          output_path: string | null;
          payload_length: number | null;
        };
        if (!operation.source_image_id || !operation.output_path) {
          throw new AppError('SUCCESSFUL_EMBED_REQUIRED', '只能审计成功嵌入操作。', 404);
        }
        const byteIndex = requireNonNegativeInt(url.searchParams.get('payloadByteIndex'), 'payloadByteIndex');
        const bitIndex = requireNonNegativeInt(url.searchParams.get('payloadBitInByte'), 'payloadBitInByte');
        if (bitIndex > 7) throw new AppError('INVALID_BIT_INDEX', 'payloadBitInByte 必须为 0 到 7，其中 0 是最高位。', 400);
        if (operation.payload_length !== null && byteIndex >= operation.payload_length) {
          throw new AppError('INVALID_PAYLOAD_OFFSET', '载荷字节下标超出该操作实际载荷长度。', 400);
        }

        const sourcePath = await getImagePath(store, operation.source_image_id);
        const [source, output] = await Promise.all([readPngFile(sourcePath), readPngFile(operation.output_path)]);
        const location = locatePayloadBit(output.image, byteIndex, bitIndex);
        const channelOffset = location.pixelIndex * 4 + location.channel;
        const alphaOffset = location.pixelIndex * 4 + 3;
        sendJson(res, 200, {
          ...location,
          beforeColorValue: source.image.data[channelOffset],
          afterColorValue: output.image.data[channelOffset],
          beforeLsb: source.image.data[channelOffset] & 1,
          afterLsb: output.image.data[channelOffset] & 1,
          delta: output.image.data[channelOffset] - source.image.data[channelOffset],
          alphaBefore: source.image.data[alphaOffset],
          alphaAfter: output.image.data[alphaOffset],
        });
        return;
      }

      if (method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'operations' && pathParts[3] === 'download') {
        const id = requireId(pathParts[2], 'operationId');
        const row = getOperation(store, id) as { output_path?: string | null };
        if (!row.output_path) throw new AppError('OUTPUT_NOT_FOUND', '该操作没有可导出的输出文件。', 404);
        const content = await fs.readFile(row.output_path);
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': content.length });
        res.end(content);
        return;
      }

      if (method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'images' && pathParts[3] === 'locate-bit') {
        const id = requireId(pathParts[2], 'imageId');
        const row = store.db.prepare('SELECT width,height FROM images WHERE id=?').get(id) as { width: number; height: number } | undefined;
        if (!row) throw new AppError('IMAGE_NOT_FOUND', `找不到图片 ID ${id}。`, 404);
        const byteIndex = requireNonNegativeInt(url.searchParams.get('payloadByteIndex'), 'payloadByteIndex');
        const bitIndex = requireNonNegativeInt(url.searchParams.get('payloadBitInByte'), 'payloadBitInByte');
        if (bitIndex > 7) throw new AppError('INVALID_BIT_INDEX', 'payloadBitInByte 必须为 0 到 7，其中 0 是最高位。', 400);
        sendJson(res, 200, locatePayloadBit({ width: row.width, height: row.height, data: new Uint8Array() }, byteIndex, bitIndex));
        return;
      }

      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '接口不存在。' });
    } catch (error) {
      sendError(res, error);
    }
  });
}

export async function findFreePort(preferred?: number): Promise<number> {
  if (preferred && preferred > 0) return preferred;
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

async function main(): Promise<void> {
  const store = await initStore();
  const port = await findFreePort(Number(process.env.PORT ?? 0));
  const server = createServer(store);
  server.listen(port, '127.0.0.1', () => {
    console.log(JSON.stringify({ ok: true, url: `http://127.0.0.1:${port}`, health: `http://127.0.0.1:${port}/health`, dataDir: store.root }, null, 2));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof AppError ? JSON.stringify({ ok: false, code: error.code, error: error.message }) : error);
    process.exit(1);
  });
}
