import fs from "node:fs";
import path from "node:path";
import { Store } from "./db.js";
import { Service, parsePayload } from "./service.js";
import { makeFixture } from "./fixtures.js";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const store = new Store(DATA_DIR);
const svc = new Service(store, DATA_DIR);

function out(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}

function payloadFromArgs(args: string[]): Buffer {
  const ti = args.indexOf("--text");
  const hi = args.indexOf("--hex");
  const fi = args.indexOf("--file");
  if (fi >= 0) return fs.readFileSync(args[fi + 1]);
  return parsePayload({
    text: ti >= 0 ? args[ti + 1] : undefined,
    hex: hi >= 0 ? args[hi + 1] : undefined,
  });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "import":
      out(svc.importCarrier(fs.readFileSync(args[0])));
      break;
    case "capacity":
      out(svc.capacity(Number(args[0])));
      break;
    case "embed":
      out(svc.embed(Number(args[0]), payloadFromArgs(args.slice(1))));
      break;
    case "extract":
      out(svc.extract(Number(args[0])));
      break;
    case "map":
      out(svc.map(Number(args[0]), Number(args[1] ?? "0"), Number(args[2] ?? "4")));
      break;
    case "diff":
      out(svc.diff(Number(args[0])));
      break;
    case "list":
      out(store.listOutputs());
      break;
    case "fixtures": {
      const dir = path.join(DATA_DIR, "fixtures");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "gradient-64x64.png"), makeFixture(64, 64));
      fs.writeFileSync(path.join(dir, "gradient-32x32.png"), makeFixture(32, 32));
      fs.writeFileSync(path.join(dir, "opaque-64x64.png"), makeFixture(64, 64, false));
      console.log(`夹具已生成于 ${dir}`);
      break;
    }
    case "demo": {
      const buf = makeFixture(64, 64);
      const c = svc.importCarrier(buf);
      console.log(`载体 #${c.id} 容量 ${c.capacity} 字节`);
      for (const [name, payload] of [
        ["中文文本", Buffer.from("你好，LSB1 世界！", "utf8")],
        ["含零字节", Buffer.from("00ff00610000", "hex")],
        ["空载荷", Buffer.alloc(0)],
      ] as const) {
        const e = svc.embed(c.id, payload);
        const x = svc.extract(e.outputId);
        const roundTrip = x.ok && Buffer.from(x.hex, "hex").equals(payload);
        console.log(`${name}: 输出 #${e.outputId} 往返一致=${roundTrip}`);
      }
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  import <png>                导入载体
  capacity <carrierId>        计算容量
  embed <carrierId> [--text 文本 | --hex 十六进制 | --file 文件]
  extract <outputId>          提取并核验
  map <outputId> [offset] [count]   查看载荷字节对应的像素通道
  diff <outputId>             嵌入前后低位变化统计
  list                        列出全部输出
  fixtures                    生成 RGBA 测试夹具
  demo                        中文/零字节/空载荷往返演示`);
  }
}

main().catch((e) => {
  console.error(e.code ? `[${e.code}] ${e.message}` : e);
  process.exit(1);
});
