import http from "node:http";
import path from "node:path";
import { Store } from "./db.js";
import { Service, parsePayload } from "./service.js";
import { ApiError } from "./core/errors.js";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const store = new Store(DATA_DIR);
const svc = new Service(store, DATA_DIR);

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new ApiError("LIMIT_EXCEEDED", "请求体过大", 413));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = url.pathname.match(/^\/api\/(carriers|outputs)(?:\/(\d+))?(?:\/(capacity|embed|extract|map|diff))?$/);
    if (!m) throw new ApiError("NOT_FOUND", "路由不存在", 404);
    const [, resource, idStr, action] = m;
    const id = idStr ? Number(idStr) : null;

    if (resource === "carriers" && req.method === "POST" && id === null) {
      const body = await readBody(req, 64 * 1024 * 1024);
      return send(res, 201, svc.importCarrier(body));
    }
    if (resource === "carriers" && id !== null && action === "capacity" && req.method === "GET") {
      return send(res, 200, svc.capacity(id));
    }
    if (resource === "carriers" && id !== null && action === "embed" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 16 * 1024 * 1024)).toString("utf8") || "{}");
      return send(res, 201, svc.embed(id, parsePayload(body)));
    }
    if (resource === "outputs" && id !== null && action === "extract" && req.method === "POST") {
      const r = svc.extract(id);
      return send(res, r.ok ? 200 : 422, r);
    }
    if (resource === "outputs" && id !== null && action === "map" && req.method === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const count = Math.min(Number(url.searchParams.get("count") ?? "4"), 256);
      return send(res, 200, svc.map(id, offset, count));
    }
    if (resource === "outputs" && id !== null && action === "diff" && req.method === "GET") {
      return send(res, 200, svc.diff(id));
    }
    if (resource === "outputs" && req.method === "GET" && id === null) {
      return send(res, 200, store.listOutputs());
    }
    throw new ApiError("NOT_FOUND", "路由不存在", 404);
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message });
    send(res, 500, { error: "INTERNAL", message: String((e as Error).message) });
  }
});

const port = Number(process.env.PORT ?? "0"); // 默认选择空闲端口
server.listen(port, () => {
  const addr = server.address();
  console.log(`LSB1 服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
});
