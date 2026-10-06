#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { initStore } from '../store.js';
import { checkImageFile, decodePayloadInput, embedFromCarrier, importCarrier } from '../service.js';

function argsToMap(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (!item.startsWith('--')) throw new Error(`无法识别参数：${item}`);
    const key = item.slice(2);
    const value = args[i + 1]?.startsWith('--') ? '' : args[++i] ?? '';
    map.set(key, value);
  }
  return map;
}

function required(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (value === undefined) throw new Error(`缺少必需参数 --${key}`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = argsToMap(rawArgs);
  const store = await initStore(args.get('data-dir'));

  if (command === 'import-carrier') {
    const filePath = path.resolve(required(args, 'input'));
    console.log(JSON.stringify(await importCarrier(store, await fs.readFile(filePath), path.basename(filePath)), null, 2));
  } else if (command === 'embed') {
    const imageId = Number(required(args, 'image-id'));
    const encoding = args.get('encoding') === 'hex' ? 'hex' : 'utf8';
    let payload: Buffer;
    if (args.has('payload-file')) {
      payload = await fs.readFile(path.resolve(required(args, 'payload-file')));
    } else {
      payload = decodePayloadInput(args.get('payload') ?? '', encoding);
    }
    console.log(JSON.stringify(await embedFromCarrier(store, imageId, payload, encoding), null, 2));
  } else if (command === 'extract' || command === 'check') {
    const input = path.resolve(required(args, 'input'));
    const result = await checkImageFile(store, input);
    console.log(JSON.stringify({
      ...result.result,
      payloadBase64: result.result.payload.toString('base64'),
      payloadUtf8: result.result.payload.toString('utf8'),
      payloadHex: result.result.payload.toString('hex'),
    }, null, 2));
    if (!result.result.valid) process.exitCode = 2;
  } else if (command === 'export') {
    const operationId = Number(required(args, 'operation-id'));
    const row = store.db.prepare('SELECT output_path FROM operations WHERE id=?').get(operationId) as { output_path?: string } | undefined;
    if (!row?.output_path) throw new Error('找不到该操作的输出文件');
    await fs.copyFile(row.output_path, path.resolve(required(args, 'output')));
  } else {
    console.log('用法: png-lsb <import-carrier|embed|extract|check|export> [参数]');
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'CLI_ERROR', error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
