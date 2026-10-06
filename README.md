# PNG LSB1 载荷嵌入与提取核验服务

在 Windows 本地运行的 PNG 最低有效位（LSB）载荷实验后端，仅提供 HTTP API 与 CLI，无前端。
技术栈：TypeScript + Node.js（≥ 22，使用内置 `node:sqlite`）+ pngjs。不依赖 Docker、WSL 或任何在线服务。

**仅演示可逆载荷读取**：不做加密、不做隐私承诺、不是鲁棒水印、不兼容 JPEG、不生成图像。
SHA-256 在此只用于完整性检查，**不是来源认证，也不构成抗篡改承诺**。
图片经缩放、调色板化或有损转码后，低位信息可能丢失，提取会失败。

## 嵌入规则

- 仅接受 **8 位 RGBA（颜色类型 6）静态 PNG**；明确拒绝 APNG、16 位位深及其他颜色类型。
- 遍历顺序：从上到下、从左到右，每个像素依次取 R、G、B 通道各 1 个最低位；**Alpha 完全不参与**，不跳过透明像素。
- 载荷字节按**最高位先写**；通道新值 = 清掉最低位再填入目标比特，因此每个修改通道与原值最多相差 1。
- 用完所需位置后其余像素字节保持不变。
- 提取时**重新打开导出的 PNG 解码像素**进行读取，不从数据库返回原始消息。
- 普通 PNG 重新编码可能改变文件字节，所有比较均基于解码后的像素。

## 包头格式（40 字节，大端）

| 偏移 | 长度 | 内容 |
| ---- | ---- | ---- |
| 0 | 4 | ASCII 魔数 `LSB1` |
| 4 | 4 | 大端无符号 32 位载荷长度（字节） |
| 8 | 32 | 载荷的 SHA-256 摘要 |
| 40 | N | 原始载荷 |

## 容量公式

```
可用载荷字节数 = floor(宽 × 高 × 3 / 8) - 40
```

容量只由像素数决定，与 PNG 压缩文件大小无关。容不下包头或载荷时直接拒绝，不输出半成品图片；空载荷合法（仍写完整包头）。

## 限制

- 单边尺寸 ≤ 4096，总像素 ≤ 16,777,216，输入文件 ≤ 64 MB，声明载荷 ≤ 8 MB。

## 错误码

`INVALID_PNG` / `UNSUPPORTED_PNG` / `APNG_NOT_SUPPORTED` / `LIMIT_EXCEEDED` / `PAYLOAD_TOO_LARGE` / `INVALID_PAYLOAD` / `NOT_FOUND` / `MAGIC_NOT_FOUND`（无嵌入数据）/ `LENGTH_INVALID`（声明长度超容量）/ `PAYLOAD_CORRUPT`（摘要不匹配）/ `BAD_REQUEST`

## 构建、测试、启动

```powershell
npm install
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认端口 0 = 自动选择空闲端口）
$env:PORT=8080; npm start   # 指定端口
```

数据目录默认为项目内 `data/`（可用 `DATA_DIR` 环境变量修改），包含 `carriers/`（原图，保持原样）、`derived/`（派生输出）与 `lsb1.db`（SQLite：输入摘要、尺寸、操作版本、派生文件路径、检查报告）。嵌入失败不会写入产物，核验失败不会覆盖先前成功产物，重启后可继续对已有输出执行 `extract`。

## CLI

```powershell
npm run cli -- fixtures                 # 生成 RGBA 测试夹具（含透明像素）
npm run cli -- demo                     # 中文文本 / 含零字节 / 空载荷 往返演示
npm run cli -- import <png>             # 导入载体，返回载体 id 与容量
npm run cli -- capacity <carrierId>     # 计算容量
npm run cli -- embed <carrierId> --text "你好"
npm run cli -- embed <carrierId> --hex 00ff0061
npm run cli -- embed <carrierId> --file payload.bin
npm run cli -- extract <outputId>       # 提取并核验摘要
npm run cli -- map <outputId> 0 4       # 查看载荷字节 0..3 对应的像素通道与前后值
npm run cli -- diff <outputId>          # 嵌入前后低位变化统计（变化通道数/最大差值/Alpha 变化）
npm run cli -- list                     # 列出全部输出及状态
```

## HTTP API

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/carriers` | 导入载体（请求体为 PNG 原始字节） |
| GET | `/api/carriers/:id/capacity` | 计算容量 |
| POST | `/api/carriers/:id/embed` | 嵌入，JSON：`{"text":"..."}` 或 `{"hex":"..."}` |
| POST | `/api/outputs/:id/extract` | 重开输出 PNG 提取并核验，失败返回 422 与错误码 |
| GET | `/api/outputs/:id/map?offset=0&count=4` | 指定载荷字节对应的像素坐标、通道及嵌入前后值 |
| GET | `/api/outputs/:id/diff` | 低位变化统计 |
| GET | `/api/outputs` | 列出全部输出 |

## 测试覆盖

恰好容量、超一字节拒绝、损坏魔数（`MAGIC_NOT_FOUND`）、修改一个载荷位（`PAYLOAD_CORRUPT`）、伪造巨大长度（`LENGTH_INVALID`）、含透明像素载体（Alpha 逐像素不变、RGB 差值 ≤ 1、未用区域一致），以及不依赖往返的手算像素向量测试（逐位核对位序、大端长度字段与摘要字段）。
