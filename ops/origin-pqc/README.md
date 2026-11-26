# RAI 直连 HTTPS 与后量子握手

客户端直接连接源站的 443，使用站点域名作为 TLS SNI 并验证服务器证书。面向用户的 DNS 记录应指向已经验证的公网入口。支持混合密钥交换的客户端可以协商 X25519 + ML-KEM-768，旧客户端仍可通过原有 TLS 1.2 路径连接。

## 验证直连

使用 RAI 发布版 Node 运行下面的探针，替换地址和域名。可以在同一次调用中检查共享监听的多个站点。

```sh
node ops/origin-pqc/verify-direct.js 192.0.2.1 443 rai.example.com api.example.com
```

探针向每个站点发送两次不含凭据的 `HEAD /`。一次只提供 TLS 1.3 混合组，一次只提供 TLS 1.2 和 P-256，并核对主机名、证书指纹和 HTTP 状态。与变更前基线比较时，应保留各站点原有的重定向、认证或 404 状态。验证默认选组时，在客户端用 OpenSSL 3.5 运行 `openssl s_client -brief -connect IP:443 -servername HOST -verify_hostname HOST -verify_return_error`，观察实际协商的组。还应单独验证应用健康和公网 DNS。

## 共享 Nginx 的部署与回退

正式机沿用发行版 Nginx。为该服务单独加载经校验的 OpenSSL 3.5 LTS 共享库，系统的其他服务继续使用发行版库。版本和目录都应明确指定。例如 3.5.9 的目录为 `/opt/rai/runtime/openssl-3.5.9/lib`。此目录和上级目录须由 root 管理。采用独立运行库后，维护者也需跟踪 OpenSSL LTS 的安全更新。

1. 校验上游发布归档的 SHA-256，在与主机 ABI 兼容的环境中构建。在私有库路径下运行 `nginx -t`。用完整虚拟主机配置启动仅绑定环回测试端口的候选实例，逐站比较证书、HTTP 状态和应用健康。检查候选实例的传统与混合握手。
2. 将同一 `LD_LIBRARY_PATH` 配置在 nginx.service 的 systemd drop-in 和 Nginx 主配置顶层的 `env LD_LIBRARY_PATH=...;`。前者用于冷启动，后者让热升级时的新进程继承该环境。在相同 systemd 配置下先预演主进程交接。
3. 通过 `nginx -t` 后平滑 reload，在旧 master 上执行 Nginx 的 USR2 热升级。确认新 master 加载了预期库，再用 WINCH 让旧 worker 完成已有连接。核对所有虚拟主机后，让旧 master 正常退出，确认 systemd 跟踪新 master。随后从另一台机器通过公网 IP 和原 SNI 复验。
4. 如候选实例或新 master 不符合基线，保留旧 master，恢复原环境配置并重新启用旧 worker，再退出新 master。已完成交接后需要回退时，按相同流程反向预演和交接。只有在原 master 已退出、进程映射已核对后，才能回收不再使用的运行库。

[Nginx 热升级与回退](https://nginx.org/en/docs/control.html#upgrade) · [OpenSSL LTS 发布页](https://openssl-library.org/source/)
