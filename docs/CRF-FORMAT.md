# CRF 文件格式与签名规范（CX RAI CRF v1.1）

> 本文档是 UWP 客户端、网页版、服务端、公开验证页的唯一契约。任何端实现 CRF 读写都必须严格遵循。

## 1. 文件结构

```
<!-- CX RAI CRF v1 -->
<!-- title: <对话标题> -->
<!-- model: <模型名> -->
<!-- source: official | thirdparty:<apiName> -->
<!-- crf-signature: v1.<keyId>.<base64url签名>.<unixTs> -->
<!-- crf-verify: https://rai.rick.sarl/verify -->

<!-- message: user -->
## 用户
<内容>
<!-- end message -->

<!-- message: assistant -->
## AI 回复
<内容>
<!-- end message -->
```

- `source` 参与签名。`official` = 官方模型对话；`thirdparty:<apiName>` = 用户配置的第三方 API 对话
- `crf-signature` / `crf-verify` 两行由导出流程插入，位置紧跟 `source` 行之后

## 2. 签名算法（定稿，勿改）

- 曲线：ECDSA P-256（prime256v1），哈希 SHA-256
- 签名载荷（ASCII）：`"<sha256hex>.<unixTs>"`，其中 `sha256hex` 是规范化后内容的小写十六进制
- 签名输出：**64 字节 raw（r||s，各 32 字节大端）**，base64url 编码（`-_` 字符集，无 padding）
  - Windows `Ecdsa256.VerifyHash` 与浏览器 WebCrypto 均用 raw 格式；Node `crypto.sign` 输出 DER，需 derToRaw 转换
- 头部元数据（title/model/source）参与签名，防止篡改 model/source 嫁祸

### 规范化规则（两端必须完全一致）

1. 按 UTF-8 读取全文
2. 统一换行符为 `\n`（兼容 CRLF / LF / CR）
3. 剔除所有以 `<!-- crf-signature:` 和 `<!-- crf-verify:` 开头的行
4. 剩余行按 `\n` 重新连接
5. 对结果计算 SHA-256（小写 hex）

## 3. 服务端接口（正式环境）

- `POST /api/crf/sign`（Bearer JWT）
  - body：`{"contentHash": "<64位小写hex>"}`（只传哈希，内容绝不上传）
  - 成功：`{"success":true,"signature":"<base64url>","ts":<unix秒>,"keyId":"<string>"}`
  - 失败：400 `invalid_content_hash` / 401 / 429 / 500 `sign_failed`
- `GET /api/crf/public-key`（公开）
  - 返回：`{"success":true,"keys":[{"keyId":"dev1","pem":"<公钥PEM>"}]}`（支持轮换，可含多把）
- `GET /api/sessions/:id/export-crf`（Bearer JWT）网页版导出
  - 返回：`{"success":true,"filename":"...crf","content":"<完整带签名 CRF 文本>"}`
- `POST /api/crf/import`（Bearer JWT）网页版导入
  - body：`{"content":"<CRF 文本>"}`
  - 成功：`{"success":true,"sessionId":"...","verification":{"status":"valid|unsigned","source":"..."}}`
  - 403 `crf_tampered`（有签名但验签失败）/ 403 `crf_unsigned_official`（官方对话无签名）

## 4. 导入/导出策略（老茶拍板定稿）

| 文件状态 | UWP 端 | 网页版 |
|---|---|---|
| 有签名 + 验签通过 | 导入，标「✓ 官方认证 · 导出于 X」；thirdparty 文案「✓ 官方导出 · 内容未被篡改」 | 导入 |
| 有签名 + 验签失败（篡改） | 弹窗两选「导入至第三方 AI / 取消」，绝不写库（预留三选扩展点） | 拒绝（403 crf_tampered） |
| 无签名 + `source: official` | 弹窗「该文件无官方签名，可能已被篡改」→「导入至第三方对话 / 取消」；选导入则作为第三方对话导入（标记未认证），**不写入官方对话库** | 拒绝（403 crf_unsigned_official） |
| 无签名 + `source: thirdparty` | 标记「未认证」，正常导入（转移场景不阻塞） | 允许（标记未认证） |

**导出联动**：
- `official` 拿不到签名 → 允许无签名导出 + 提示「导入时只能进入第三方对话」（保留离线兼容）
- `thirdparty` 断网 → 照常无签名导出

**核心原则**：无签名的官方内容只能进第三方对话，绝不进官方对话库——离线兼容与声誉防线两全。

## 5. 语义边界

- 签名证明：**文件未被篡改 + 由官方服务端签发**
- 签名不证明：内容由官方模型生成（`source: thirdparty` 时内容来自用户配置的第三方 API）

## 6. 安全要点（实测确认）

- **删签名行绕过**：官方文件删除 `crf-signature` 行 + 篡改内容 → 文件变「无签名」。字节层面无法区分「本来无签名」与「删了签名」，只能靠 source 分级堵（official 无签名拒绝/降级）——这是无签名放行策略存在的必要原因
- **「改回来又能导入」不是漏洞**：内容复原 = 与导出时一致 = 无危害；签名只验证「当前内容 = 导出时内容」
- 篡改后**不导入**直接发社交平台的文件，导入侧防不住，靠公开验证页（/verify）让公众验伪
- 验证页对无签名文件显示「⚠️ 无官方签名，无法确认完整性」，不显示官方认证

## 7. 密钥与轮换

- 正式密钥：`/opt/rai/crf-tools/keys/crf-sign-key.pem`（ECDSA P-256，keyId=`dev1`，rai-runner 可读 600）
- 公钥：`crf-sign-pub.pem`；UWP 内置公钥已匹配
- 轮换：public-key 接口返回多把公钥（当前 + 历史），验签按签名行 keyId 选择；私钥丢失=无法再签新文件（老文件仍可验），泄露=体系失效需立即轮换

---

## 8. JSON 通用格式（v1.1 新增，双格式导出）

CRF 是 RAI 自有格式；另支持 **JSON 通用格式**（贴近 OpenAI Chat Completions 结构，方便其他 AI 工具使用）。两种格式使用**同一套签名机制**（内容哈希签名，格式无关）。

### 8.1 JSON 文件结构

```json
{
  "title": "<对话标题>",
  "model": "<模型名>",
  "source": "official | thirdparty:<apiName>",
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "crf_signature": "v1.<keyId>.<base64url签名>.<unixTs>",
  "crf_verify": "https://rai.rick.sarl/verify"
}
```

- `crf_signature` / `crf_verify` 是 RAI 签名元数据字段，其他工具可忽略；仅 RAI 验证页/导入流程使用
- `messages` 数组：`role` 取 `user` / `assistant`，`content` 为字符串

### 8.2 JSON 规范化与签名

- 规范化：UTF-8 → 统一 `\n` → 剔除**含 `"crf_signature"` / `"crf_verify"` 的行** → 剩余文本 SHA-256
- 签名载荷/算法与 CRF 完全一致：`"<sha256hex>.<unixTs>"`，ECDSA P-256，raw 64 字节 base64url
- 检测：文本以 `{` 开头（去 BOM/空白后）判定为 JSON

### 8.3 接口

- 导出：`GET /api/sessions/:id/export-crf?format=json`（默认 crf）→ `{"success":true,"filename":"对话_xxx.json","content":"<JSON 文本>","format":"json"}`
- 导入：`POST /api/crf/import` 自动检测格式（CRF / JSON），验签与安全策略一致（篡改 403 / 官方无签名 403）
- 验证页 `/verify` 支持拖入 .json 文件验签

### 8.4 UWP 导出入口

- 官方对话（云同步）：调 export-crf 接口，用户可选 **CRF**（RAI 生态）或 **JSON**（通用）格式
- 第三方对话（本地）：本地组装后调 `POST /api/crf/sign`，两种格式都适用（组装 JSON 时按 8.2 嵌签名字段）
