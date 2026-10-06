import { PNG } from "pngjs";

/** 生成简单 RGBA 夹具：确定性渐变 + 部分透明像素 */
export function makeFixture(width: number, height: number, withAlpha = true): Buffer {
  const png = new PNG({ width, height, bitDepth: 8, colorType: 6 });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = (x * 7 + y * 3) & 0xff;
      png.data[i + 1] = (x * 5 + y * 11) & 0xff;
      png.data[i + 2] = (x * 13 + y * 17) & 0xff;
      png.data[i + 3] = withAlpha && (x + y) % 5 === 0 ? 0 : 255;
    }
  }
  return PNG.sync.write(png);
}
