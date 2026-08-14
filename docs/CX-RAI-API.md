# CX RAI API 接入合同

版本：`v0.11.68`  
客户端：`CX RAI`  
描述：`WP / Windows 10 / Windows 11 端 RAI`

本文档是 Windows 原生客户端接入 RAI Web 的接口合同。接口根地址二选一：

```text
https://rai.rick.sarl/api
https://rai.000339.xyz/api
```

所有请求必须使用 HTTPS。除 SSE 外，响应均为 UTF-8 JSON。

## 1. 凭据模型

### 1.1 软件客户端 key

演示 key（仅用于文档和 UI 占位，已经明确不可登录生产）：

```text
sk-CXRaiDemoA7B9C2D4E6F8H1J3K5
```

正式 key 由 RAI 管理员为每个客户端单独生成。当前正式格式是：

```text
rai_app_v1_<16字符keyId>_<43字符secret>
```

创建命令（在正式 Web 服务器项目目录执行；完整 key 只显示一次）：

```bash
node scripts/software-client-key-cli.js create \
  --name "CX RAI" \
  --platform windows \
  --package-name cx.rai.windows \
  --output /绝对路径/cx-rai-client-key.txt
```

后续平台使用不同的 `--platform`、`--package-name` 创建不同 key。列出和吊销：

```bash
node scripts/software-client-key-cli.js list
node scripts/software-client-key-cli.js revoke <keyId>
```

数据库只保存 key 的 SHA-256 哈希；丢失后不能恢复，只能吊销旧 key 并重新创建。key 是“可撤销软件身份”，不是用户密码、JWT 或管理员凭据。

请求头：

```http
X-RAI-Client-Key: rai_app_v1_...
```

服务端允许 key 出现在所有 `/api` 请求中，但只有 `/api/client/capabilities` 强制要求它。Windows 客户端应始终发送该头；它不能替代用户 JWT，也不能绕过用户归属、会员、点数、配额或速率限制检查。

### 1.2 用户 access token 与 refresh cookie

登录成功后使用短期 access token：

```http
Authorization: Bearer <access-token>
X-RAI-Client-Key: rai_app_v1_...
```

登录/注册/兑换 ZTX6D 后服务端会设置 HttpOnly refresh cookie。Windows 客户端必须使用支持 cookie 的 `CookieContainer`，并在刷新时发送：

```http
X-RAI-Refresh: 1
Origin: https://rai.rick.sarl
```

刷新调用 `POST /api/auth/refresh`，不要把 refresh token 放入 JSON、日志、设置文件或 URL。

### 1.3 启动握手

客户端启动后先调用：

```http
GET /api/client/capabilities
X-RAI-Client-Key: rai_app_v1_...
```

成功响应：

```json
{
  "success": true,
  "packageVersion": "0.11.53",
  "client": {
    "keyId": "RA1xxxxxxxxxxxxxx",
    "name": "CX RAI",
    "platform": "windows",
    "scopes": ["user_api"],
    "packageName": "com.cx.rai.windows",
    "createdAt": 0,
    "lastUsedAt": 0
  },
  "userSessionRequired": true,
  "adminAllowed": false,
  "credentialPurpose": "revocable_software_identity",
  "embeddedKeyExtractable": true
}
```

`embeddedKeyExtractable=true` 是安全事实：桌面程序无法把静态 key 当作秘密保存。发现泄露时立即按 `keyId` 吊销并发新 key。

### 1.4 CX RAI Windows 实际 key（已创建）

本次已为截图中的 `CX RAI` Windows 客户端创建真实生产 key：

```text
keyId:       vdh8RZxKo0P8G2L0
platform:    windows
packageName: cx.rai.windows
scope:       user_api
status:      active
```

原始 key 不写入本文档、不进入 Git、不在聊天中回显，已保存为：

```text
服务器（root-only）：/root/.rai-secrets/cx-rai-windows-key-v1.txt
本机（0600）：       /Users/rick/.config/rai/cx-rai-windows-key-v1.txt
```

把本机文件内容复制到 Windows 客户端的本地安全存储。不要把真实值提交到 GitHub、`Package.appxmanifest`、截图、日志或公开配置。需要再次取用时，在本机终端执行 `pbcopy < /Users/rick/.config/rai/cx-rai-windows-key-v1.txt`，再粘贴到 Windows 项目的安全设置入口；不要把命令输出发到聊天。

### 1.5 Windows/WinUI 请求头配置

所有 API 请求使用同一个 `HttpClient`，同时加上软件 key；登录后再加用户 access token：

```csharp
using System.Net.Http.Headers;

var client = new HttpClient {
    BaseAddress = new Uri("https://rai.rick.sarl/api/")
};

// 从 PasswordVault / ApplicationData.LocalFolder 读取，不要硬编码到源码。
var softwareKey = await LoadCxRaiKeyAsync();
client.DefaultRequestHeaders.TryAddWithoutValidation("X-RAI-Client-Key", softwareKey);
client.DefaultRequestHeaders.TryAddWithoutValidation("X-RAI-Device-Name", windowsComputerName);
client.DefaultRequestHeaders.TryAddWithoutValidation("X-RAI-Device-Fingerprint", stableDeviceFingerprint);
client.DefaultRequestHeaders.UserAgent.ParseAdd(edgeLegacyUserAgent);

// 登录成功后，每次用户 API 请求都设置短期 access token。
client.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", accessToken);
```

启动先调用 `GET client/capabilities` 验证 key；收到 `software_client_key_invalid` 时停止请求并联系发布方，收到 `401 未提供认证令牌` 时走登录/refresh。软件 key 不能代替 `Authorization: Bearer`。

`stableDeviceFingerprint` 必须在同一台电脑的登录、2FA、refresh、邮箱验证码和 Passkey 流程中保持不变；它是随机生成的安装级 ID，不是用户名、MAC 地址或硬件序列号。`windowsComputerName` 使用 Windows 实际电脑名称。服务端优先读取 JSON body 的 `fingerprint` / `deviceName`，body 缺失或为空时回退到统一 header：`X-RAI-Device-Fingerprint` / `X-RAI-Device-Name`。

这两个设备字段适用于所有会创建或更新用户会话的认证请求：密码登录、邮箱验证码登录、2FA 验证、Passkey 验证、ZTX6D 兑换以及 `POST /auth/refresh`。新客户端应同时在 body 和 header 上报；旧客户端只送其中一种也兼容。若两者冲突，非空 body 值绝对优先，以便在请求级别完成可预期的调试与迁移。

## 2. 认证流程

### 密码登录

```http
POST /api/auth/login
Content-Type: application/json
X-RAI-Client-Key: rai_app_v1_...
```

```json
{
  "email": "user@example.com",
  "password": "Strong-password-here",
  "fingerprint": "cx-rai-device-id",
  "deviceName": "Ricks-Windows-PC",
  "twoFactorCode": "123456"
}
```

成功返回 `token`、`tokenExpiresAt` 和 `user`；若启用二步验证且未提交验证码，返回 `requiresTwoFactor=true` 与一次性 `twoFactorToken`，随后调用 `POST /api/auth/login/2fa`。

CX RAI 登录、邮箱验证码登录、2FA、Passkey、ZTX6D 兑换和 refresh 都应携带同一个稳定 `fingerprint`；`deviceName` 使用 Windows 电脑名称。refresh 请求体可为：`{"fingerprint":"cx-rai-device-id","deviceName":"Ricks-Windows-PC"}`。若认证请求不能放 JSON body，发送同名语义的 `X-RAI-Device-Fingerprint` 与 `X-RAI-Device-Name` 即可。body 非空时优先；同一账号和 fingerprint 会复用原会话并轮换 refresh token，不会产生另一条活动设备记录。

CX RAI 的 User-Agent 应包含完整 Windows build 和 Edge Legacy 标识，例如：

```text
Mozilla/5.0 (Windows NT 10.0; Win64; x64; WindowsBuild/10.0.19045.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/18.19045
```

设备接口会显示 `osName=Windows`、`osVersion=10.0.19045.0`、`browserName=Edge HTML`、`browserVersion=18.19045`；请求体的 `deviceName` 优先于 UA 推断名称。

### 邮箱验证码登录

1. `POST /api/auth/login/email-code/request`：`{"email":"user@example.com"}`
2. `POST /api/auth/login/email-code/verify`：`{"email":"user@example.com","code":"123456","fingerprint":"cx-rai-device-id","deviceName":"Ricks-Windows-PC"}`
3. 若响应要求二步验证，调用 `POST /api/auth/login/2fa`。

兼容旧客户端的登录前探测：

```http
POST /api/auth/login/precheck
{}
```

该接口不会泄露账号是否启用 2FA；正式客户端直接按登录响应决定是否进入二步验证页面。

### 注册与密码重置

- `POST /api/auth/register`：`email`、`password`、可选 `username`、`referrerId`。
- `POST /api/auth/register/resend`：`email`、`password`。
- `POST /api/auth/register/verify`：`email`、`code`、可选 `fingerprint`。
- `POST /api/auth/password/reset/request`：`email`。
- `POST /api/auth/password/reset/confirm`：`email`、`code`、`newPassword`、可选 `fingerprint`。

所有邮箱验证码均为 6 位纯数字，发送后 5 分钟过期。新请求会使同一邮箱、同一用途的旧验证码失效。

邮箱不存在时，登录验证码和重置验证码接口保持统一响应，客户端不要据此枚举账号。

### Token 生命周期

```http
GET /api/auth/verify
Authorization: Bearer <access-token>
```

```http
POST /api/auth/refresh
X-RAI-Refresh: 1
Origin: https://rai.rick.sarl
Cookie: <HttpOnly refresh cookie>
```

退出当前设备：`POST /api/auth/logout`。退出全部设备：`POST /api/auth/logout-all`。后者会立即撤销该账号全部 refresh 会话（包括当前设备），并与 Web 设置页“退出全部设备”使用同一撤销边界。

认证路由索引（均为 `/api` 下的接口）：

```text
GET  /auth/ztx6d/status
GET  /auth/ztx6d/start
GET  /auth/ztx6d/callback
POST /auth/ztx6d/bind/start
POST /auth/ztx6d/exchange
POST /auth/refresh
POST /auth/logout
POST /auth/logout-all
POST /auth/register
POST /auth/register/resend
POST /auth/register/verify
POST /auth/login/precheck
POST /auth/login
POST /auth/login/email-code/request
POST /auth/login/email-code/verify
POST /auth/login/2fa
POST /auth/password/reset/request
POST /auth/password/reset/confirm
GET  /auth/verify
POST /auth/passkeys/authentication/options
POST /auth/passkeys/authentication/verify
```

## 3. 设备信息（与 RAI Web 安全页同一合同）

```http
GET /api/user/devices
Authorization: Bearer <access-token>
X-RAI-Client-Key: rai_app_v1_...
```

响应固定为 `active` 与 `history` 两组：

```json
{
  "success": true,
  "active": [
    {
      "id": "auth-session-id",
      "deviceName": "Windows PC",
      "location": "Singapore",
      "browserName": "Edge",
      "browserVersion": "128.0.0",
      "osName": "Windows",
      "osVersion": "10.0",
      "authMethod": "password",
      "createdAt": 1720000000000,
      "lastUsedAt": 1720000000000,
      "expiresAt": 1720003600000,
      "revokedAt": null,
      "revokeReason": null,
      "isCurrent": true,
      "isActive": true
    }
  ],
  "history": []
}
```

字段合同：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 会话 ID，仅用于展示/审计，不是 token |
| `deviceName` | string | 由 User-Agent 推断，如 `Windows PC`、`Mac`、`Android phone` |
| `location` | string | 反代提供的粗略城市/地区/国家标签；可能为 `Unknown location` |
| `browserName` / `browserVersion` | string | User-Agent 推断结果；原生客户端可显示 `Unknown browser` |
| `osName` / `osVersion` | string | User-Agent 推断的系统名称和版本 |
| `authMethod` | string | `password`、`email_code`、`passkey`、`ztx6d` 等 |
| `createdAt` / `lastUsedAt` / `expiresAt` | number | Unix 毫秒时间戳 |
| `revokedAt` | number/null | 撤销时间；活动会话为 `null` |
| `revokeReason` | string/null | 撤销原因 |
| `isCurrent` | boolean | 是否当前 access token 对应的会话 |
| `isActive` | boolean | 当前是否仍可使用 |

隐私边界：服务端不保存、不返回原始 IP，不返回 refresh token；`location` 只使用 Cloudflare/Vercel 粗略头。CX RAI 的设备设置页直接渲染 `active/history`，不要另造字段或把 `id` 当作凭据。

## 4. 核心聊天接口

### 会话

```http
GET /api/sessions?offset=0&limit=20
POST /api/sessions
GET /api/sessions/{sessionId}/messages
GET /api/sessions/{sessionId}/messages-before/{messageId}
PUT /api/sessions/{sessionId}
DELETE /api/sessions/{sessionId}
```

创建：`{"title":"新对话","model":"auto","session_kind":"chat"}`。列表响应包含 `pinned`、`sessions`、`hasMore`、`offset`、`limit`。所有会话和消息均按 JWT 用户归属检查，跨用户 ID 返回 403/404。

会话组织：

```http
POST   /api/sessions/{sessionId}/pin       {"pinned":true}
PUT    /api/sessions/pins/order            {"sessionIds":["session_..."]}
POST   /api/sessions/{sessionId}/prompt-identity
GET    /api/conversation-folders
POST   /api/conversation-folders
PATCH  /api/conversation-folders/{folderId}
DELETE /api/conversation-folders/{folderId}
GET    /api/conversation-folders/{folderId}/sessions
PUT    /api/conversation-folders/{folderId}/sessions
```

`prompt-identity` 请求体：`{"prompt_model_identity":"smart","prompt_language":"zh-CN"}`。模型身份可为 `smart`、`fast`、`think`、`research` 或 `model:<合法模型ID>`；只在会话尚未锁定时写入。

消息维护：

```http
DELETE /api/sessions/{sessionId}/messages/{messageId}
PUT    /api/sessions/{sessionId}/messages/{messageId}       {"content":"..."}
PATCH  /api/sessions/{sessionId}/messages/{messageId}/regeneration
POST   /api/messages/{messageId}/feedback                   {"rating":"up|down","comment":"..."}
GET    /api/messages/{messageId}/attachments
```

### SSE 流式聊天

```http
POST /api/chat/stream
Authorization: Bearer <access-token>
X-RAI-Client-Key: rai_app_v1_...
Content-Type: application/json
Accept: text/event-stream
```

最小请求：

```json
{
  "sessionId": "session_...",
  "messages": [{"role":"user","content":"你好"}],
  "model": "auto",
  "thinkingMode": false,
  "internetMode": true,
  "temperature": 0.7,
  "top_p": 0.9,
  "max_tokens": 2000,
  "uiLanguage": "zh-CN",
  "memoryMode": "normal"
}
```

服务端权威提示词：原生客户端无需发送 `systemPrompt`。字段缺失时，服务端会根据会话首次锁定的模型身份和语言生成与 Web 相同的 RAI 主提示词，并自动追加该账号在 Web 设置中保存的自定义提示词。Web 设置保存后，Windows Phone、Windows 和 Android 的下一次普通聊天请求会直接使用新值，无需更新客户端内置文案。

新会话创建时建议继续传 `prompt_model_identity`；即使旧客户端没有调用 `prompt-identity`，聊天接口也会根据 `model`、`thinkingMode`、`researchMode` 和 `uiLanguage` 原子补齐会话锁。提示词身份和语言一旦写入便不随客户端后续切换而改变。`memoryMode:"off"`、临时对话或显式 `systemPrompt:""` 继续保持无提示词隔离。为兼容旧 Web/高级客户端，非空 `systemPrompt` 仍可作为本次请求的显式覆盖，但原生客户端不应复制或硬编码 RAI 主提示词。

其他可选字段还包括 `thinkingBudget`、`agentMode`、`agentPolicy`、`qualityProfile`、`agentTraceLevel`、`reasoningProfile`、`researchMode`、`researchAgentModels`、`researchMasterModel`、`researchMaxRounds`、`frequency_penalty`、`presence_penalty`、`systemPrompt`、`promptTimeContext`、`domainMode`、`canvasContext`、`canvasApplyMode`、`uiSurface`、`flowId`、`skipUserSave`。服务端会重新校验模型、数值范围和附件归属。

旧 UWP 的本地文件执行仍使用 `client_file_execution:true` 与 `/api/agent/tool-result`，但必须同时携带有效的 `X-RAI-Client-Key`。新跨平台 Agent 使用 `local_agent` 签名会话，不得通过旧结果接口完成签名任务。

SSE 每行格式为 `data: {JSON}\n\n`。客户端至少处理：

```text
content          增量正文
reasoning        增量思考内容
title            会话标题
status           请求状态
agent_status     Agent 状态
tool_status      工具状态
search_status    搜索状态
routing_notice   路由提示
error            错误（结束前可能出现）
cancelled        已取消
done             正常结束
```

停止和插话：

```http
POST /api/chat/stop
{"requestId":"request-id-from-stream"}

POST /api/chat/interject
{"requestId":"request-id-from-stream","message":"请改用中文总结"}
```

会话实时恢复：

```http
GET /api/sessions/{sessionId}/stream-events
Authorization: Bearer <access-token>
Accept: text/event-stream
```

### 文件和图片

上传使用 `multipart/form-data`，字段名必须是 `file`：

```http
POST /api/upload
Authorization: Bearer <access-token>
X-RAI-Client-Key: rai_app_v1_...
Content-Type: multipart/form-data
```

成功返回 `file.filename`、`originalName`、`filePath`、`fileType`、`size`。随后把 `filePath` 作为消息附件引用；下载时必须带 JWT：

```http
GET /api/uploads/{filename}
GET /generated-images/{filename}
Authorization: Bearer <access-token>
```

服务端检查文件类型、大小、用户归属和路径穿越；不要把上传地址改成公开 URL，也不要在日志写入文件内容。

## 5. Flow 与选词解释

```http
GET    /api/flows
POST   /api/flows                         {"title":"研究 Flow"}
GET    /api/flows/{flowId}
PUT    /api/flows/{flowId}                {"title":"...","canvas_state":{}}
DELETE /api/flows/{flowId}
```

选词解释使用 SSE：

```http
POST   /api/selection-explanations/stream
POST   /api/selection-explanations/{requestId}/stop
GET    /api/selection-explanations/threads
GET    /api/selection-explanations/threads/{threadId}
GET    /api/selection-explanations/threads/{threadId}/nodes
GET    /api/selection-explanations/cards/{cardId}/path
DELETE /api/selection-explanations/cards/{cardId}
DELETE /api/selection-explanations/threads/{threadId}
DELETE /api/selection-explanations
```

## 6. 用户、设置与会员

```http
GET    /api/user/profile
PUT    /api/user/profile
POST   /api/user/profile/email/verify
POST   /api/user/profile/email/verify-current
PUT    /api/user/config
POST   /api/user/avatar                 multipart 字段 avatar
GET    /api/user/membership
POST   /api/user/membership/redeem      {"tier":"Pro|MAX"}
POST   /api/user/checkin
POST   /api/user/tasks/pwa-install/complete
POST   /api/user/tasks/bookmark-domain/complete
GET    /api/user/memories
POST   /api/user/memories
PATCH  /api/user/memories/{id}
DELETE /api/user/memories/{id}
POST   /api/user/memories/clear
```

会员兑换会消耗点数并由服务端校验档位；客户端不要自行计算余额。签到和任务接口具有幂等/防重复领取逻辑，收到 400/409 时刷新 `/api/user/membership`。

## 7. Passkey、2FA 与账号安全

```http
POST   /api/auth/passkeys/authentication/options
POST   /api/auth/passkeys/authentication/verify
GET    /api/user/passkeys
POST   /api/user/passkeys/reauth
POST   /api/user/passkeys/registration/options
POST   /api/user/passkeys/registration/verify
POST   /api/user/passkeys/{id}/activation/options
POST   /api/user/passkeys/{id}/activation/verify
PATCH  /api/user/passkeys/{id}
DELETE /api/user/passkeys/{id}
POST   /api/user/2fa/setup
POST   /api/user/2fa/enable
POST   /api/user/2fa/disable
PUT    /api/user/password
DELETE /api/user/account
```

Passkey 请求/响应遵循 WebAuthn JSON 编码（ArrayBuffer 使用 base64url 字符串），客户端应复用系统 WebAuthn API，不要自行实现密码学。

## 8. 公共信息与兼容认证

```http
GET /api/test
GET /api/version
GET /api/model-availability
GET /api/announcements?lang=zh-CN
GET /api/quote/{symbol}
GET /api/auth/ztx6d/status
GET /api/auth/ztx6d/start?return=/
GET /api/auth/ztx6d/callback?rt=<一次性rt>
POST /api/auth/ztx6d/bind/start        （需要 JWT）
POST /api/auth/ztx6d/exchange           {"auth_code":"一次性code"}
```

ZTX6D 登录是浏览器重定向流程；Windows 客户端优先使用密码/邮箱验证码，只有需要 ZTX6D 时才打开系统浏览器并回收一次性 `auth_code`。

## 9. HTTP 状态与错误处理

| 状态 | 含义 | 客户端动作 |
|---|---|---|
| 400 | 参数、验证码、文件或业务状态无效 | 展示服务端 `error`，不要盲目重试 |
| 401 | JWT 缺失/过期，或软件 key 无效 | JWT 先调用 refresh；key 错误联系发布方 |
| 403 | 用户归属、刷新来源或管理员边界不允许 | 不重试，不泄露对象是否存在 |
| 404 | 资源不存在或无权访问 | 刷新列表；删除接口视为已不存在 |
| 409 | 并发冲突（如置顶顺序） | 重新 GET 后重放 |
| 413 | 上传过大 | 在客户端预检并提示 |
| 429 | 限流、配额或并发上限 | 遵守 `Retry-After`（如有），指数退避 |
| 500/502/503 | 服务或上游暂时失败 | 有界重试；SSE 断线按会话状态恢复 |

统一读取 JSON 中的 `error` 和可选 `code`。不要把服务端中文错误文本当作稳定枚举；需要程序分支时优先使用 `code`。

## 10. 管理员边界与安全要求

- `/api/admin/*` 是后台专用接口，CX RAI 永远不得调用。普通软件 key 访问会收到 `403 software_client_admin_forbidden`。
- 软件 key 不授予用户身份；所有用户数据接口仍需要 `Authorization: Bearer`。
- 每个客户端、每个平台、每个发布批次使用独立 key；泄露只吊销对应 `keyId`。
- 不记录 key、JWT、refresh cookie、密码、验证码、原始 IP 或上传文件内容；Windows 日志只记录请求路径、状态码和本地关联 ID。
- TLS 证书必须校验；不要关闭证书验证，不要把 token 放 query string。
- 客户端卸载、账号退出或“退出全部设备”后清除本地 access token、cookie 和会话缓存；重新启动先调用 `/api/client/capabilities`，再尝试 refresh。
