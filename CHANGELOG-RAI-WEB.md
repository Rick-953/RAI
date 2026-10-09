## 0.13.22 — 2026-10-09

- 输入框空白区域统一即时聚焦，包括工具栏间隙与模型控件外层留白；仅排除实际按钮、菜单、滑条和内容预览。
- pointerdown 用户手势内直接聚焦，保留 click 兼容兜底；删除 Android 重复延迟聚焦，不改发送位置、智能模型、路由或额度。
- 开启思考默认自适应；上游请求不指定 reasoning_effort，由模型决定思考强度，不再用本地问题长度打分替代自适应。手动低/中/高/最大仍传对应档位。
- 修复 max 被 normalizeReasoningProfile 重置为 low；兼容旧 mixed 迁移，中文最大 / English Max。
- 普通与研究模型列表只显示模型名称，不把视觉、256k、档位和压缩提示当作选项文案。
- 附件入口改为整行原生按钮；选择、拖放、粘贴支持多文件/多图片与追加批次，排队上传全部完成后发送，独立移除并隔离账号/新对话。
- 移动端正文纵向触摸优先暂停自动跟随，取消待处理到底部任务；保留代码/表格滑动与左右侧栏手势。上传数量与服务器配置同步（默认每条 8 个），超限明确提示而非静默丢文件。
- 新增 Chromium/WebKit 桌面、移动和 PWA 点击/轻触、文字选择、控件隔离与禁用输入回归。
- 更新 0.13.22、时间轴与服务工作线程资源标记，避免旧缓存保留错误点击行为。实机输入法弹出仍需设备验收。
- Fast 网关短请求实测：不传固定 reasoning_effort 的 GPT 6.1 Sol 正常返回（HTTP 200）；auto 字符串不在供应商支持枚举中，因此自适应使用省略固定强度而非发送非法枚举。未对 Astra 进行真实长上下文测试。

## 0.13.20 — 2026-10-09

- 将当前 Web 本地 Agent 入口替换为同账号在线 CX RAI 连接；手机无需扩展，电脑需 1.8.7+ 主动启用。
- 随机设备身份、软件客户端校验、账号/对话隔离、安全码、本机连接授权和每次工具确认。一次性任务启动，忙碌不丢任务，退出/离线/到期撤销，结果不保存在中继内存。
- 服务端等待本机确认时暂停模型总时限并发 SSE 心跳；回传工具结果续答，取消不重放。远程为文件/PowerShell 工具联动，不是无人值守桌面视频流。
- 更新 PWA 缓存和时间轴，清理重新生成的遗留模型选项；协议 HTTP、真实认证/SQLite/聊天续答和 Chromium/WebKit 手机/电脑 UI 回归纳入门禁。

## 0.13.19 — 2026-10-08

- 公开对话及研究模型统一为 DeepSeek V4.1 Flash、GPT 6.1 Sol、GPT 6 Luna、GPT 6 Astra；标准 ID 两端一致，旧 ID 仅兼容迁移。
- 四模型原生视觉，图片不触发旧 Qwen/Gemini/Kimi 视觉备用路由；管理员公开模型与默认路由仅接受四模型。
- DeepSeek Fast 优先、现有官方备用，独立私密密钥文件；GPT 三模型使用 Fast 独立密钥文件，不将任何密钥下发客户端。
- 服务端按账号、模型、滚动 24h 原子预占，成功答完后计 1 次；Free Astra/Sol/Luna 为 3/50/100，Pro 为 50/100/200，MAX 为 80/200/500。失败/取消释放，内部工具与供应商重试不重复扣次，达到上限返回明确错误而非偷偷扣积分或换 GPT。
- 四模型统一 256000 上下文预算，包含保守输入估算、视觉预留、输出和安全余量。每次工具续传也检查；超限自动摘要旧完整轮次，保留系统指令、近期完整工具链及附件引用，原始历史不修改。压缩失败明确报错。
- 低/中/高/max 思考两端对齐；Fast GPT 实测拒绝 none，关闭思考采用 low 并隐藏思考；DeepSeek 关闭使用 thinking.disabled，官方备用转换其支持的档位。
- 模型路由规则：默认关闭思考的 GPT 6.1 Sol；快速 Fast DeepSeek V4.1 Flash；思考 GPT 6.1 Sol 根据问题自适应低/中/高/max。Fast 在 10 秒内无有效响应或服务失败时直接切官方 DeepSeek，不扣未完成的 GPT 额度。
- 电脑端暂不启用适人握持，但不修改账号同步偏好；侧边栏默认支持双向滑动。Windows 下载程序标推荐，Mac/手机推荐网页应用。
- 修复右侧问答索引横条及上下导航的悬浮预览越界：按实际锚点选择展开方向并限制在可视窗口内，不受账号移动端握持偏好影响。
- 新增 SQLite 并发、滚动边界、会员到期、取消/崩溃租约、幂等扣次、思考、上下文与备用线路回归；发布前运行隔离 API、正式审计与客户端编译签名验证。
- 真机 WP/桌面安装及 iPhone 实机验收需与源码/CI/安装包验证区分。

# RAI Web 更新记录

## 2026-09-29 - Installed iOS viewport and password-manager preference (feature/pwa-viewport-remember-20260929; not deployed)
- The installed iOS app now paints its full layout viewport instead of fixing the root to WebKit's transient short visual viewport. The composer and settings surfaces extend to the physical bottom while controls retain home-indicator padding. Only a focused input uses the keyboard-sized visual viewport; blur, pageshow, and foreground transitions reconcile stale values without toggling the shell display. Ordinary Safari/Android/desktop sizing remains separate.
- Sign-in and registration remember-password checkbox defaults on if no preference exists; explicit opt-out persists as a boolean shared with /UWP-SignUP. Browser/OS password managers handle credentials through autocomplete and, where supported, a guarded post-authentication PasswordCredential offer; never plaintext Web storage.
- Bumped app, diagnostics, index resources and service-worker cache to `20260929-pwa-r8`; UWP signup CSS/JS cache URLs are `20260929-remember-r1`. Added real Chromium fixture coverage for standalone/Safari geometry, keyboard-close/background stale viewport, safe controls, and unset/false/true preference across Web and UWP registration. Physical iPhone Safari/PWA validation remains required.


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

## 2026-09-29 — 文件入口与扫码会话边界（开发中，未部署）
- 文件入口移入侧栏可滚动容器；统一文件页按钮、间距、移动安全区和 reduced-motion。
- QR 授权在真实会话存储事务内复查有效期、撤销状态和账号会话版本，继承原始 auth_time，不提升敏感操作认证新鲜度。
- 修复二维码关闭/创建竞态及 beta 子路径；更新缓存资源版本。
- 新增扫码 HTTP 集成、QR 状态机、提示词缓存和 iOS 布局测试到 formal-audit 门禁。
- 本机文件库回归通过；Windows 缺少 sqlite3 native binding，HTTP 集成测试必须在 Linux 测试副本执行。
- 全量审计上次停于 fetch-url 的 LF 文本断言（测试副本 CRLF），将使用 Git 导出源码重跑；未降低断言。

本批验证补充（2026-09-29）：
- 修复 app.js / index / Service Worker 的构建标识不一致，统一为 20260928-secure-chat-r2。
- 安全冒烟测试按固定技能注册表复制技能，修复拆分 Office 后启动时缺少 documents/SKILL.md。
- 将旧版长持机手提示测试迁移到短 ctx；保留移动端开关、最后用户轮、旧格式持久化清理测试，并增加实际系统前缀不变性检查。
- 新增 smart-model-routing 行为测试，直接执行真实路由函数，覆盖 Flash 首选/思考、旧 Pro 管理设置、不可用回退、去重和多模态限制。
- Linux Node 24.16.0：check、formal-user-bugs 20/20、全部排在 desktop:check 之前的 formal-audit 回归和隔离安全冒烟通过；命令停在测试主机缺少 cargo，未删除此门禁，等待 GitHub CI 完整验证。
- QR 状态机、真实会话 SQLite HTTP 集成、提示词缓存、iOS 布局契约及模型路由专项均单独通过。布局契约不是 iPhone 真机验收；路由测试不是供应商在线可用性或真实缓存命中率证明。
- 浏览器实测文件入口 position:static，所属容器 overflow-y:auto；短窗口滚动 175px，按钮 y 从 214 变为 39，确认不固定在新建对话区。
- 测试运行时代码树：3f13e31c4294ee0968bb7adc4afe10dbc9908898（后续仅补充日志）。正式服务仍为 c043345，未部署本功能分支。

## 2026-09-29 — 发布门禁依赖修补（未部署）
- GitHub 新运行发现 undici 6.28.0 命中 GHSA-3wwx-pv8p-q78v；依维护方公告升级最小补丁 6.28.1，未跨主版本。
- 使用项目固定 Node 24.16.0 / npm 11.13.0 生成锁文件；只有 undici 的版本、来源和完整性哈希变化。
- npm audit --audit-level=moderate 返回 0 漏洞；dependency-security 回归通过，新增 undici 锁定防回退断言。
- 提交 111fd0e 的 GitHub Formal regression suite 与 Isolated runtime security smoke 均通过，证明包含 Cargo 的完整 formal-audit 已通过；该运行的依赖/OSV 门禁失败由此补丁修复，需新运行再次确认。

## 2026-09-29 — 按需 UI 技能同步
- Web/CX 界面技能同步文件入口的滚动位置、搜索/上传/文件操作路径，防止 RAI 指引用户寻找旧的固定入口。
- 产品技能明确 CX RAI 才是 UWP 客户端，RAI Web 是浏览器/PWA，消除英文指代歧义；作者关系保持不变。
- 技能保持 LF，更新固定 SHA-256；技能加载静态/运行时回归通过。主提示词字符数仍 1119，测试 ctx 仍 47 字符，不把详细界面指南塞回每轮 system。

## 2026-09-29 — 分享链接事务隔离
- 分享快照读取/轮换/撤销使用现有独立主数据库事务连接；并发创建只保留最后提交的链接，插入失败回滚后旧链接仍可用。
- 新增 6 次并发创建、失败注入回滚和全部撤销的真实 SQLite HTTP 回归；已通过，check/系统提示词/技能加载运行时/formal-user-bugs/隔离安全冒烟均通过。
- 恢复作者归属测试所约束的原英文句式，保留 CX UWP 与 Web/PWA 的明确区分，不放宽作者归属断言。

## 2026-09-29 — 扫码/分享独立限流门禁（未上线）
- PR工作流通过后独立CodeQL聚合检查仍报告6条新增高危限流告警；不以工作流success替代完整PR门禁，也不抑制规则。
- 路由模块自身定义二维码创建、二维码刷新、授权/分享变更、匿名分享读取的独立IP限流，保留宿主既有限流；换宿主装载时也不会变成无限流接口。
- 创建码12次/分钟，刷新120次/分钟，授权与分享变更60次/分钟，匿名分享读取120次/分钟。正常3秒轮换不使用密码登录的尝试预算。
- 分享会话路由在限流前设置no-store/no-referrer，429也不缓存。
- 真实HTTP+SQLite回归新增实际429、创建预算耗尽后已有二维码仍可刷新测试；连同并发分享原子轮换、失败回滚测试通过。待GitHub再次完整扫描后决定是否合并。

- 跟进聚合扫描剩余的consume告警：领取凭据与cancel同样显式绑定本模块授权预算，HTTP回归验证429不签发新凭据。上一轮Formal回归仅在cargo拉取itoa时遇到HTTP/2网络错误，不修改/移除Cargo门禁。
- 真实供应商小样本（2026-09-29，服务器现有DeepSeek配置，非生产用户会话）：Flash两次非流请求200，输入465token；第二次cache hit=256/miss=209（约55%，非长期指标）。Flash思考流200、正文22字符、思考229字符、finish=stop、[DONE]齐全。这证明该配置可用，不替代完整浏览器端到端验收。

## 2026-09-29 — 正式部署与原生dialog实测修正
- PR #72 已通过全部门禁，合并为e9939bf并用标准脚本部署正式版；服务active、工作树干净，三域名资源SHA256与服务器文件一致。线上已验证二维码生成/3.3秒换码/未登录确认401/未知分享404/取消后领取410。
- 独立Chromium真实点击扫码入口正常，7秒70次采样中63次显示有效图片、3张不同二维码；未触发真实账号授权。Codex内置浏览器该次点击无响应，未将其等同于后端不可用。
- 浏览器截图暴露全局margin:0使原生dialog靠左上角，修正为margin:auto；添加小视口滚动/安全区限制。二维码隐藏时保留方形位置，不因轮换反复改变弹窗高度。
- 弹窗增加可访问标题关联；更新静态资源/Service Worker版本并纳入扫码脚本与样式预缓存。
- 新增布局契约回归；真实浏览器居中、换码稳定性和移动尺寸另行验收，不拿正则检查代替渲染证据。


## 2026-09-29 — 登录按钮排布与扫码Cookie隔离（待发布验证）
- 按用户截图重排登录选择：桌面扫码/通行密钥并列、API Key独立一行；420px及以下纵向排列。三项共享无描边10px圆角按钮、10px间距，悬浮仅轻微变色、按下scale(0.97)、抬起恢复；无渐变/发光/装饰图案，保留仅键盘显示的焦点提示与减少动态效果偏好。
- 扫码请求绑定原始API地址、账号epoch/token和持久化token；取消立即停止接收，迟到授权只撤销新签发会话，撤销绕过全局自动重试且credentials=omit，防止误撤销当前账号。
- 浏览器扫码使用按会话命名的HttpOnly刷新Cookie，只有客户端接纳并保存的访问令牌才能选择对应Cookie进行刷新。迟到Cookie不覆盖普通登录Cookie、不被自动选中；缺失或错误作用域不回退到其他账号。CX继续原有rai_refresh契约。
- 新增浏览器生命周期、Cookie选择及实际服务端签发/刷新/退出HTTP处理器+临时SQLite回归；最初回归复现了切换token后旧扫码覆盖新账号的错误。缓存版本更新为20260929-secure-chat-r4。
- 当前尚未合并/部署；完整双设备、物理iOS和CX原生UI验收仍未完成。

本批验证：
- Linux暂存树c095e26599aaebc5d9b914e93b5e09449da8b61a：npm run check、qr-browser-lifecycle（含真实HTTP处理器+SQLite）、secure-sharing、auth-sessions、qr-login、secure-dialog-layout、formal-user-bugs全部通过。
- Chromium本地隔离页面布局：桌面按钮44px高、10px间距、0px边框；390/320px纵向三项均无文本溢出。悬浮仅背景变化，按下matrix(0.97)，松开matrix(1)。本地刷新接口模拟401，仅作为UI证据，不冒充正式账号业务验收。

## 2026-09-29 — 紧凑登录页、已登录设备扫码入口与待登录设备位置（验证中）
- 语言切换缩为 简体 / 繁體 / EN，与注册/登录提示共用一横排；保持完整的无障碍名称与选中状态。三种语言 320 / 390 / 1280 px 实测均单行、垂直中心差 0、无水平溢出。
- 已登录侧栏的 临时对话 旁加入 扫码授权登录，支持后置相机和本地图片解码。jsQR 1.4.0 精确固定、完整 Apache-2.0 许可、上游字节来源及 SHA-256 纳入供应链门禁；不依赖 iOS 尚不普遍支持的 BarcodeDetector。
- 只接受当前服务器 origin 和正式/beta 对应路径的 RAI 登录二维码；不导航扫描出的任意网址、不上传相机画面或图片。
- 每次识别仍需用户明确确认。确认页显示待登录设备、IP、大致位置；点击 确认登录 后原设备直接登录。核对码是两台设备间的辅助核对，无需输入，不代替明确确认。
- IP 取创建二维码请求的 Express 已验证代理链地址，拒用客户端提交 IP/城市与未验证的 CDN 地理请求头；服务端固定版本 ip2region 2.3.0 离线解析，不外传 IP。数据库可能滞后、VPN/代理会影响位置；未知和局域网有明确回退。位置不是认证因素。
- IP/位置只在短期内存授权记录中保存，仅返回给已登录扫码人；不写日志、不放入二维码、owner 轮询、分享或提示词。
- 相机只在用户点击扫码入口后请求；页面隐藏、退出、关闭、身份变化、识别完成均停止。延迟授予的媒体流立即释放；确认请求绑定原账号，不经全局 401 重试改用别的账号。
- Permissions-Policy 仅为同源相机开放，麦克风/定位仍禁止。补齐同版本离线资源；缓存构建号 20260929-auth-scanner-r5。
- 更新按需 rai-web-ui 技能与哈希，不改主提示词前缀。
- 本地验证：真实二维码编码→实际 jsQR 解码；扫码/授权竞态、来源限制、IP可信来源、离线数据库、相机权限拒绝、真实图片选择→显示设备/IP/位置→明确确认。浏览器在无真实账号/无真实授权的本地 mock 环境验证；iPhone 真机相机/PWA 仍需单独验收，不能用模拟宽度替代。
- 完整 Linux 回归、GitHub 安全门禁、正式部署结果在后续记录补齐；本节不宣称已上线。

本批发布前验证补充：
- Linux Node 24.16.0：check、qr-scanner、qr-login、secure-sharing（真实 SQLite/HTTP）、qr-browser-lifecycle、secure-dialog-layout、vendor-integrity、vendor-provenance、skill-loader、csp-static、privacy-logging、dependency-security 全通过。
- 真实 Chromium 本地隔离浏览器：拒绝相机权限、二维码图片、本地 canvas MediaStream 实际相机解码管线、识别后先停止流且不自动授权、点击确认/拒绝、关闭后延迟相机授权释放全通过，无页面异常。测试发现并修正了浏览器定时器未绑定导致的 Illegal invocation；纯 Node mock 无法代替此项。
- 可复跑 `npm run test:qr-scanner-browser`（测试环境提供 Playwright；可用 NODE_PATH 指定测试工具，RAI_QR_BROWSER_EXECUTABLE 指定已安装浏览器，RAI_QR_BROWSER_ARTIFACTS 可选输出截图）。脚本自行启停回环地址测试站、仅使用假账号与测试二维码，不触碰正式登录或相机。
- 相机 Permissions-Policy 进一步只对应用主页 / 与 /index.html 开放，其他文档仍禁用。

## 2026-09-29 — 跨端脱敏诊断（feature 分支，未合并/上线）
- 请求审计加入客户端/服务端/聊天关联 ID、固定端点及实际路由模型，客户端不发送日志到其他服务；保留已有扫码与分享安全边界。
- 设置 > 关于新增本标签页最多500条白名单 JSON 导出。统一读取器仅旁观实际已读 SSE，记录完成/中断/取消、首字延迟、正文与思考字符数、工具事件和供应商真实 usage；不复制响应体或工具参数，不改变原重试/授权/流传输。
- 恢复诊断 WIP stash 时对 index/app/sw 冲突逐项手工合并：以已上线 PR75 的语言栏、侧栏扫描器与本地扫码解码为基础，仅加入诊断脚本与导出；缓存整体升为 20260929-diagnostics-r6。原 stash 暂保留供审计。
- 已通过本地诊断与扫码浏览器/布局回归；服务器/CI 全门禁、合并、标准正式部署与生产导出仍需另行验证。不得将 PR75 已上线或本段源码视作诊断已部署。

### 脱敏诊断正式部署补记（2026-09-29）
- PR #76 中本地 storage 槽名触发 Gitleaks 误报；未添加扫描例外、未强推，改由干净单提交 PR #77 取代。#77 全门禁含 Formal、Gitleaks、CodeQL、RustSec、独立 CodeQL 聚合和安全总结均通过。
- PR #77 合并 commit c87dc45626f350f066b663c44a6aae615bede541；13:59（Asia/Singapore）经 `/opt/rai/deploy.sh formal` 正式部署。部署前已在线备份 SQLite、`quick_check=ok`、私密备份 .env；服务 active、部署树 clean。
- 公网 index/app/sw/diagnostics/selection-explainer 的 SHA256 均与对应 Git blob 和服务器文件相同。新隔离 Chromium 正式站 HTTP 200、加载 rai.diagnostics.v1 / r6，无页面异常；本地实际“关于→导出”下载及隐私、流式关联测试通过。
- 尚未在正式站真实登录账号中导出并核验生产会话、双设备扫码、物理 iOS PWA 或实际模型供应商 usage；不拿离线/模拟验证替代这些剩余验收。

## 2026-09-29 — 临时对话思考中断兜底（待 PR/部署）
- 修复临时对话没有数据库 sessionId 时，上游仅输出半段思考就中断、客户端收到 done 却没有正文的路径；现在与持久对话共用终止兜底，在 done 前显示明确的未完成提示，不自动重放可能有副作用的工具调用。
- done 事件标明 degraded；Web 的生成时间线将这种终止标为未完成，而不是“生成完成”。有正文的正常回复不重复插入兜底文本。
- 新增可执行 helper 回归，同时断言兜底位置位于有会话专属存储逻辑之外。Windows 本地 `npm run check`、stream-completion-recovery、tool-trace-ui、diagnostics 已通过；Linux 全部门禁、真实临时对话供应商流与线上验收仍待 PR/部署。
- 前端 app/index 与 Service Worker 缓存标识统一升至 20260929-stream-r7；版本契约同步，确保已安装 PWA 更新流式脚本。

### 临时对话兜底正式上线补记（2026-09-29）
- PR #79 全部 Formal、独立 CodeQL、依赖、RustSec、Gitleaks、OSV 与安全汇总门禁通过，合并提交 d70e89201c0456ceadcc7f7435e259ed83013c88。
- 16:50（Asia/Singapore）在私密在线 SQLite 备份 `quick_check=ok` 后，使用 `/opt/rai/deploy.sh formal` 部署；服务与 Nginx active，工作树 clean，公网健康检查 200。
- 公网 index.html、app.js、sw.js 内容与 origin/main Git blob 哈希逐个一致，浏览器确实载入 20260929-stream-r7。隔离浏览器的未登录扫码弹窗正常；尚未用真实账号重演供应商断流、物理 iOS PWA 或 CX 原生双设备授权。

### 2026-09-29 — PWA 修复集成验证
- 复查补充：输入框保留焦点或连接硬件键盘时，不能只凭 focus 认定键盘打开；同宽视口保留聚焦前高度，必须同时检测实际收缩。
- 新增锁定 Playwright 1.62.1 的 Chromium/WebKit CI 回归；不再仅依赖本机安装的测试工具。
- 两种引擎本机模拟 393×852 屏幕实测：shell/composer/settings/content 的 bottom 均为 852，输入控件 bottom=808（含 34px 主屏幕指示条保护和 10px 间隔），不存在额外 59px 浏览器栏占位。覆盖残留短视口、键盘、保留焦点、前后台切换、Safari 分支及登录偏好 unset/false/true。
- 物理 iPhone PWA 仍须用户复验；以上浏览器模拟不等于真机验证。Windows 的 sqlite3 原生绑定缺失限制仍保留，完整正式回归由 Linux PR 门禁验证。
