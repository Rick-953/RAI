# RAI Web 更新记录

## 2026-09-28 — 开发中，未部署
基线：正式服务器与 GitHub main 均为 c0433456e6675a62617d3e9db1047f66eeb1a8b3。
- 扫码登录：3 秒旧码失效、独立领取凭据、设备/安全码确认、撤销与单次消费；新增轻量手机确认页。
- 分享：7 天只读文本快照、撤销/轮换链接、网页回退、CX RAI 协议唤起。
- 智能/思考默认采用 DeepSeek Flash，禁止自动备用链静默切到 Pro。
- 思考请求预算与截断处理改进；不再把仅思考的断流当成功正文。
- 思考和工具卡视觉更新；iOS 安全区背景延伸，保留按钮安全距离。
- 元数据请求日志；不记录原始 URL、查询参数、请求正文或凭据。
- Office 拆分 documents/spreadsheets/presentations；新增 rai-web-ui/cx-rai-ui。技能按需读取，重新校验哈希并固定 LF。
- 常用主提示词保留简短作者说明和技能索引，详细指引不随每轮发送；用户时间/设备/持机手缩成 [ctx]。
- 搜索结果放入当轮用户上下文，不改写系统前缀。

已验证：npm run check；skill-loader、system-prompt-contract、prompt-cache、qr-login、stream-completion-recovery、ios-standalone-layout、tool-trace-ui 回归通过。
提示词测量：测试配置主提示词 1119 字符，当轮 ctx 47 字符；这是字符数，不是实测 token 数或服务商缓存命中率。
未完成：Linux 权限日志测试、接口端到端/真实模型缓存测试、设备渲染验收、完整功能差异补齐、正式部署。Windows 上 privacy-logging 的 0600 权限断言未通过，必须在 Linux 验证，不能删除断言掩盖问题。

作者：RAI Web 由 Rick 全权构建。
