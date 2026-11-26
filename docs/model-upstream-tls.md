# Web 模型上游的 TLS

RAI 发布版使用 Node.js `24.16.0`。它内置 OpenSSL `3.5.6`，默认在 TLS 1.3 ClientHello 中先提供 `X25519MLKEM768` 密钥份额，同时提供 `X25519`。对端可选用传统密钥交换组，原有 TLS 1.2 兼容性与证书验证由 Node 保持。Node 20 等内置 OpenSSL 3.0 的版本继续使用其原生 TLS。要启用混合组，升级实际启动服务的 Node 二进制。

聊天、Agent 与研究经 `fetchModelProvider` 及相应的网关回退进入 Node 原生 `fetch`。Gemini 专用请求、Luna 官方 Responses 和 token 计数、指令审查与图像网关最终也调用同一运行时的 `fetch`。OpenAI、DeepSeek 官方端点以及其余服务端配置的 HTTPS 模型端点各自协商。流式 SSE、取消、超时与模型回退沿用各调用路径的处理。

## 启动与验证

默认的发布版启动参数即可使用混合协商。若自定义 OpenSSL 配置覆盖了默认组，`scripts/model-upstream-tls.cnf` 提供显式配置。它保留 OpenSSL 3.5 的 `DEFAULT` 组列表，让混合组与 X25519 的份额依次发送。配置由 Node 在启动时加载，对该进程的 TLS 上下文生效。已有自定义 OpenSSL 配置时，将 `Groups` 设置合入其 `nodejs_conf` 的 `system_default`，以保留现有策略。使用 `--openssl-shared-config` 时，对应的入口为 `openssl_conf`。

使用与服务相同的 Node 二进制，在仓库根目录验证。测试需要本机 `openssl` 命令生成一次性环回证书。Windows 可用 `OPENSSL_BIN` 指向该命令。

```bash
node scripts/model-transport-regression.js --require-hybrid
node --openssl-config=scripts/model-upstream-tls.cnf scripts/model-transport-regression.js --require-hybrid
```

显式启用时，在服务的 Node 启动命令中使用上述同一配置。例如从仓库根目录启动 `node --openssl-config=scripts/model-upstream-tls.cnf --env-file=.env server.js`。systemd 可将配置路径写为绝对路径。兼容性测试可以省略 `--require-hybrid`，在缺少混合组的旧运行时检验普通 TLS 和 HTTP。

## 代理与验证范围

出站代理沿用运行时设置。Node `24.16.0` 通过 `NODE_USE_ENV_PROXY=1` 或 `--use-env-proxy` 启用 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`，具体地址仍由部署环境提供。Express 的 `TRUST_PROXY` 用于处理入站请求。纯 CONNECT 内的 TLS 由 Node 和上游协商。若代理解密流量，需分别验证 Node 到代理和代理到上游的 TLS。平台网关向后转发的链路由网关运行时协商。

环回测试检查首次 ClientHello 的密钥份额，并让 TLS 1.3 服务端只接受混合组来确认实际握手。另覆盖 TLS 1.3/X25519、TLS 1.2/P-256、HTTP、证书拒绝、SSE 读出和取消、带认证的 HTTP 与 HTTPS CONNECT，以及 `NO_PROXY`。真实部署上的协商取决于目标 TLS 端点。可以在有授权的环境中抓取对应链路的 ClientHello 和 ServerHello，仅观察选组而无需发送模型请求。
