# RAI 上传进度 API

上传接口使用 Bearer 用户令牌认证。客户端先创建短时上传会话，再用返回的 `uploadId` 上传文件；同一用户的其他客户端可轮询状态接口。上传会话在最后一次状态更新 30 分钟后过期。

## 1. 创建上传会话

`POST /api/uploads/sessions`

```http
Authorization: Bearer <user-token>
Content-Type: application/json
```

```json
{
  "fileName": "report.png",
  "size": 245760,
  "mimeType": "image/png"
}
```

成功时返回 `201`：

```json
{
  "success": true,
  "uploadId": "upl_0123456789abcdef0123456789abcdef",
  "status": "pending",
  "uploadedBytes": 0,
  "totalBytes": 245760,
  "progressPercent": 0,
  "uploadUrl": "/api/upload",
  "statusUrl": "/api/uploads/upl_0123456789abcdef0123456789abcdef/status",
  "expiresAt": "2026-08-11T10:30:00.000Z"
}
```

## 2. 上传文件

将文件作为名为 `file` 的 multipart 字段发送到 `POST /api/upload`，并绑定上传会话：

```http
Authorization: Bearer <user-token>
X-RAI-Upload-ID: upl_0123456789abcdef0123456789abcdef
Content-Type: multipart/form-data; boundary=...
```

服务端完成内容校验和配额写入后才返回 `completed`：

```json
{
  "success": true,
  "uploadId": "upl_0123456789abcdef0123456789abcdef",
  "status": "completed",
  "file": {
    "filename": "stored-name.png",
    "originalName": "report.png",
    "filePath": "/api/uploads/stored-name.png",
    "fileType": "image/png",
    "size": 245760
  }
}
```

未提供 `X-RAI-Upload-ID` 的旧客户端仍可直接上传。服务端会自动创建会话，并在响应正文和 `X-RAI-Upload-ID` 响应头中返回 ID。

## 3. 查询进度和完成状态

`GET /api/uploads/:uploadId/status`

```http
Authorization: Bearer <user-token>
```

```json
{
  "success": true,
  "uploadId": "upl_0123456789abcdef0123456789abcdef",
  "status": "uploading",
  "uploadedBytes": 122880,
  "totalBytes": 245760,
  "progressPercent": 50,
  "file": null,
  "errorCode": null,
  "updatedAt": "2026-08-11T10:00:03.000Z",
  "expiresAt": "2026-08-11T10:30:03.000Z"
}
```

状态依次为 `pending`、`uploading`、`processing`，终态为 `completed` 或 `failed`。只有创建会话的用户可以查询；不存在、已过期或属于其他用户的 ID 均返回 `404`。客户端必须以 `completed` 作为上传真正完成的判断条件。

## 客户端流程

```text
创建会话 -> 上传 multipart + X-RAI-Upload-ID
          -> 同账号客户端轮询 statusUrl
          -> completed: 使用 file 元数据
          -> failed: 根据 errorCode 提示或重试新会话
```
