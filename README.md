# PNG RGB 最低位载荷实验后端

这是一个只包含 API 与 CLI 的本地 TypeScript / Node.js 实验项目。它把二进制载荷写入静态 8 位 RGBA PNG 的 R、G、B 通道最低位，再从重新打开的派生 PNG 像素中提取并用 SHA-256 核对完整性。

> 安全边界：本项目仅演示可逆的低位读取与完整性校验，不提供加密、隐私承诺、鲁棒水印、来源认证、抗篡改承诺、JPEG 兼容或图像生成。缩放、旋转、调色板转换、滤镜、截图、有损转码或重新采样都可能清除低位。

## 环境

- Windows 本地可直接运行，不需要 Docker、WSL、付费服务或外部在线 API。
- 已使用 Node.js 25.5.0、npm 11.8.0 验证。
- SQLite 使用 Node.js 内置 `node:sqlite`。
- PNG 容器读写使用成熟库 `pngjs`；容量、包头、位序、嵌入和提取规则由本项目自行实现。

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
npm start
```

默认不固定端口：服务会让操作系统选择空闲端口，并在启动 JSON 中输出 `url`。如需固定端口：

```powershell
$env:PORT="8080"
npm start
```

可选数据目录：

```powershell
$env:PNG_LSB_DATA_DIR="E:\lsb-data"
npm start
```

## 位写入规则

- 像素遍历：从上到下，从左到右。
- 通道遍历：每个像素严格按 R、G、B。
- Alpha 完全不参与，也不会被修改；透明像素仍正常参与。
- 载荷字节按最高位（MSB）先写。
- 对每个颜色字节执行：先清掉最低位，再填入目标比特。
  - 新值与原值差值只能是 `-1`、`0` 或 `1`。
  - 已需要的低位之外，所有 RGB 字节和全部 Alpha 保持不变。

第 `b` 个颜色位对应：

```text
pixelIndex = floor(b / 3)
channel    = b mod 3        # 0=R, 1=G, 2=B
x          = pixelIndex mod width
y          = floor(pixelIndex / width)
```

## 包头与容量

固定包头共 40 字节：

| 偏移 | 长度 | 内容 |
| --- | ---: | --- |
| 0 | 4 | ASCII 魔数 `LSB1` |
| 4 | 4 | 载荷字节长度，32 位无符号大端整数 |
| 8 | 32 | 原始载荷的 SHA-256 摘要 |
| 40 | N | 原始载荷 |

容量只按解码像素计算，不看 PNG 压缩文件大小：

```text
总可用字节 = floor(width × height × 3 / 8)
载荷容量   = 总可用字节 - 40
```

空载荷合法，但仍写入完整 40 字节包头。若包头或载荷放不下，服务在输出文件前拒绝，不会产生半张成功图片。

提取时：

1. 读取重新打开的输出 PNG 的像素，不使用数据库中保存的原载荷。
2. 校验魔数；没有魔数返回 `magic_not_found`。
3. 读取大端长度，并确认未超过像素容量；伪造超长返回 `length_exceeds_capacity`。
4. 读取声明长度的载荷并计算 SHA-256；摘要不一致返回 `digest_mismatch`。
5. 仅魔数、长度和摘要都通过才返回 `valid`。

## 输入限制

- 最大输入 PNG：20 MB。
- 最大派生 PNG：20 MB。
- 最大声明载荷：20 MB，同时仍受像素容量限制。
- 图片宽高：单边不超过 4096 像素。
- 仅接受静态 PNG、8 位位深、RGBA 颜色类型 6、非隔行扫描。
- 明确拒绝 APNG 区块 `acTL`、`fcTL`、`fdAT`。
- 明确拒绝非 PNG、16 位、非 RGBA 颜色类型、零尺寸和截断区块。

## 数据目录

默认目录为项目内 `data/`：

```text
data/
  lsb.sqlite          # 元数据、操作版本与检查报告
  originals/          # 按输入 SHA-256 保存的原始载体
  outputs/            # 派生 PNG，失败不覆盖已有成功文件
  tmp/                # 原子写入临时文件
  demo-fixtures/      # 一键演示生成的夹具
```

原始载体不被修改。派生文件使用源图片 ID 与输出内容 SHA-256 命名，通过临时文件原子重命名。SQLite 记录输入摘要、尺寸、操作版本 `LSB1-v1`、派生文件路径和检查报告。服务重启后仍可检查已有输出。

## CLI

### 导入载体并查看容量

```powershell
npm run cli -- import-carrier --input data\demo-fixtures\rgba-carrier.png
```

### 嵌入 UTF-8 文本

```powershell
npm run cli -- embed --image-id 1 --encoding utf8 --payload "你好，LSB"
```

### 嵌入十六进制

```powershell
npm run cli -- embed --image-id 1 --encoding hex --payload "00ff0080"
```

### 从任意文件导入二进制载荷

```powershell
npm run cli -- embed --image-id 1 --payload-file payload.bin
```

### 重新打开输出 PNG 并提取、核验

```powershell
npm run cli -- extract --input data\outputs\embed_1_xxxxxxxxxxxxxxxx.png
npm run cli -- check   --input data\outputs\embed_1_xxxxxxxxxxxxxxxx.png
```

`extract` 与 `check` 输出 `payloadBase64`、`payloadUtf8`、`payloadHex`、声明长度和摘要。核验失败时进程退出码为 2。

### 导出操作产物

```powershell
npm run cli -- export --operation-id 1 --output result.png
```

可给所有命令指定数据目录：

```powershell
npm run cli -- import-carrier --input carrier.png --data-dir E:\lsb-data
```

## HTTP API

以下示例中 `$base` 为启动时输出的地址，例如 `http://127.0.0.1:57909`。

### 健康检查

```powershell
Invoke-RestMethod "$base/health"
```

### 导入载体

`contentBase64` 是静态 8 位 RGBA PNG 的 Base64。

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("carrier.png"))
$body = @{ contentBase64 = $b64; fileName = "carrier.png" } | ConvertTo-Json
Invoke-RestMethod -Method Post "$base/api/carriers" -ContentType "application/json" -Body $body
```

### 查询容量

```powershell
Invoke-RestMethod "$base/api/images/1/capacity"
```

### 嵌入

```powershell
$body = @{
  imageId = 1
  encoding = "utf8"      # 或 hex
  payload = "你好，LSB"
} | ConvertTo-Json
Invoke-RestMethod -Method Post "$base/api/embed" -ContentType "application/json; charset=utf-8" -Body $body
```

### 从输出图片提取并核验

```powershell
Invoke-RestMethod -Method Post "$base/api/images/5/extract"
```

### 对已有嵌入操作再次核验

```powershell
Invoke-RestMethod "$base/api/operations/1/check"
```

### 查询操作元数据与下载 PNG

```powershell
Invoke-RestMethod "$base/api/operations/1"
Invoke-WebRequest "$base/api/operations/1/download" -OutFile result.png
```

### 查看载荷字节对应的像素通道

`payloadBitInByte=0` 表示该字节最高位。

```powershell
Invoke-RestMethod "$base/api/images/1/locate-bit?payloadByteIndex=0&payloadBitInByte=0"
```

### 审计某个载荷位嵌入前后的低位变化

该接口只返回对应坐标、通道和数值，不展示整张图片：

```powershell
Invoke-RestMethod "$base/api/operations/1/bit-audit?payloadByteIndex=0&payloadBitInByte=0"
```

## 主要错误码

| 错误码 | 含义 |
| --- | --- |
| `NOT_PNG` | PNG 签名不匹配 |
| `PNG_TRUNCATED` | PNG 区块超出文件范围 |
| `APNG_UNSUPPORTED` | 检测到动画 PNG 区块 |
| `UNSUPPORTED_BIT_DEPTH` | 位深不是 8 |
| `UNSUPPORTED_COLOR_TYPE` | 颜色类型不是 RGBA 6 |
| `INTERLACED_PNG_UNSUPPORTED` | 隔行扫描 PNG |
| `IMAGE_TOO_LARGE` | 宽高超过限制 |
| `CAPACITY_TOO_SMALL` | 容量不足以容纳包头 |
| `PAYLOAD_TOO_LARGE` | 载荷超过像素容量或大小限制 |
| `MAGIC_NOT_FOUND` / `magic_not_found` | 未找到 `LSB1` 包头 |
| `LENGTH_EXCEEDS_CAPACITY` / `length_exceeds_capacity` | 声明长度超过像素容量 |
| `DIGEST_MISMATCH` / `digest_mismatch` | 魔数存在但载荷摘要不一致 |
| `POST_EMBED_VERIFY_FAILED` | 输出 PNG 重读或逐像素约束失败 |

## 测试与演示

```powershell
npm test
npm run demo
```

测试使用代码生成的 RGBA PNG，覆盖：

- 中文 UTF-8、含零字节数据和空载荷。
- 导出 PNG 后重新解码，提取字节与输入完全一致。
- 恰好容量和超一字节。
- 损坏魔数、修改一个载荷位、伪造巨大长度。
- 含透明 Alpha 的载体，逐像素验证 Alpha 不变。
- 每个 RGB 通道差值不超过 1。
- 未使用区域保持一致。
- 不依赖往返测试的手算位序：`L = 01001100`。
- 大端长度 `1` 的最低位位于第 63 个颜色位。
- 非 RGBA、16 位、APNG 和非 PNG 容器拒绝。

## 开发命令

```powershell
npm run build   # TypeScript 编译到 dist/
npm test        # Node 内置测试运行器
npm start       # tsx 直接启动 API
npm run demo    # 生成夹具并演示三种载荷
npm run cli     # 运行 CLI
```

## 重要限制

- 低位不是秘密保护机制；查看图片低位即可读取载荷。
- SHA-256 只判断提取内容是否与包头摘要一致，不证明来源可信，也不能阻止攻击者重写包头和载荷。
- 普通 PNG 重新编码即使像素不变，也可能改变压缩文件字节；比较必须基于解码后的像素，而不是文件哈希。
- 任何改变像素值的处理都可能破坏载荷，尤其是缩放、调色板、颜色空间转换和 JPEG 转码。
