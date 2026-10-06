import fs from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { initStore } from '../src/store.js';
import { checkImageFile, embedFromCarrier, importCarrier } from '../src/service.js';

function createRgbaPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height, bitDepth: 8, colorType: 6 });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = (i * 37) & 255;
    png.data[i * 4 + 1] = (i * 73 + 41) & 255;
    png.data[i * 4 + 2] = (i * 109 + 83) & 255;
    png.data[i * 4 + 3] = i % 7 === 0 ? 0 : 255;
  }
  return PNG.sync.write(png, { colorType: 6, bitDepth: 8 });
}

async function main(): Promise<void> {
  const store = await initStore();
  const fixtureDir = path.join(store.root, 'demo-fixtures');
  await fs.mkdir(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, 'rgba-carrier.png');
  await fs.writeFile(fixturePath, createRgbaPng(96, 24));
  const carrier = await importCarrier(store, await fs.readFile(fixturePath), 'rgba-carrier.png');

  const payloads: Array<[string, Buffer, 'utf8' | 'binary']> = [
    ['中文演示：PNG RGB 最低位可逆载荷', Buffer.from('中文演示：PNG RGB 最低位可逆载荷', 'utf8'), 'utf8'],
    ['含零字节 00 ff 00 80', Buffer.from([0x00, 0x01, 0x7f, 0x00, 0xff, 0x80]), 'binary'],
    ['空载荷', Buffer.alloc(0), 'binary'],
  ];

  for (const [name, payload, encoding] of payloads) {
    const embedded = await embedFromCarrier(store, carrier.id, payload, encoding);
    const checked = await checkImageFile(store, embedded.outputPath, embedded.outputImageId);
    if (!checked.result.valid || !checked.result.payload.equals(payload)) throw new Error(`演示失败：${name}`);
    console.log(JSON.stringify({
      name,
      operationId: embedded.operationId,
      output: embedded.outputPath,
      inputBytes: payload.length,
      extractedBytes: checked.result.payload.length,
      sha256Match: checked.result.valid,
    }, null, 2));
  }
  console.log(`演示完成，数据目录：${store.root}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
