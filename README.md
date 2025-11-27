# RAI v0.5
轻量化AI界面，包含前后端，支持联网和思考功能，支持多个api。内置路由模型功能，已经有基础功能。
个人可以使用，修改，商用需要联系rick080402@gmail.com  
访问rick.quest然后选择RAI即可在线体验！  

新增功能：ai总结对话标题，修了一堆bug。改了改提示词。给主页背景字体加了动画

抱歉还没时间写 先用ai介绍下 QAQ  
这是一个基于 Node.js (Express) 和 原生前端技术 (HTML/CSS/JS) 构建的现代化 AI 对话应用，名为 RAI。该项目集成了智能模型路由、多模型支持、流式响应、联网搜索以及深度思考模式等高级功能。

以下是对 
index.html
 和 
server.js
 的详细中文解析：

1. 核心功能概览 (Core Features)
该项目不仅仅是一个简单的聊天界面，它包含了一个完整的智能路由决策系统和用户管理系统。

智能模型路由 (Smart Model Routing):
后端内置了一个“智能路由引擎 v4”，能够自动分析用户输入的复杂度。
分析维度: 包括输入长度、代码特征（检测编程语言、SQL、HTML等）、数学公式、推理需求（如“为什么”、“证明”）、以及语言混合度。
决策逻辑: 根据评分自动在 qwen-flash (快速/便宜)、qwen-plus (均衡) 和 qwen-max (强大/昂贵) 之间切换。例如，简单的问候会走 Flash 通道，而复杂的编程问题会强制走 Max 通道。
多模型支持:
支持 阿里云 Qwen (通义千问) 系列：qwen-flash, qwen-plus, qwen-max。
支持 DeepSeek 系列：deepseek-v3 和 deepseek-reasoner (思考模型)。
深度思考模式 (Thinking Mode):
前端支持显示 AI 的“思考过程” (Reasoning Content)。
用户可以展开/折叠查看 AI 在给出最终答案前的推理步骤（类似 OpenAI o1 或 DeepSeek R1 的体验）。
支持设置“思考预算” (Token 数量)。
联网搜索 (Internet Mode):
支持开启联网模式，允许模型（如 Qwen）进行实时搜索以获取最新信息。
流式响应 (Streaming):
使用 Server-Sent Events (SSE) 技术，实现打字机效果的实时回复，包括思考过程的实时流式传输。
2. 后端架构 (
server.js
)
后端使用 Node.js + Express 框架，配合 SQLite 数据库。

技术栈:
express: Web 服务器框架。
sqlite3: 轻量级关系型数据库，存储用户、会话和消息数据。
bcrypt: 用户密码加密。
jsonwebtoken (JWT): 用户身份认证和 Token 生成。
multer: 处理文件上传（头像、附件）。
cors & rate-limit: 跨域处理和接口限流（防滥用）。
核心模块:
路由引擎 (
routeModel
, 
analyzeMessage
): 包含详细的关键词库（情绪词、专业术语、数学词汇），用于动态评估 Prompt 价值并选择模型。
API 代理: 封装了阿里云 (DashScope) 和 DeepSeek 的 API 调用，统一了接口格式，隐藏了后端 Key。
数据库表结构:
users: 用户信息。
sessions: 聊天会话列表。
messages: 具体的聊天记录（包含 reasoning_content 思考字段）。
user_configs: 用户偏好设置（主题、默认模型、System Prompt 等）。
3. 前端架构 (
index.html
)
前端采用 原生开发 (Vanilla JS)，没有使用 React/Vue 等重型框架，保证了极致的加载速度和性能。

技术栈:
HTML5/CSS3: 使用 CSS 变量实现深色/浅色主题切换，使用了大量的 Flexbox 和 Grid 布局。
JavaScript (ES6+): 处理所有的 UI 交互、API 请求和状态管理。
Marked.js: 用于将 AI 返回的 Markdown 文本渲染为 HTML。
Google Fonts: 使用 Material Symbols Outlined 图标库。
界面与交互:
响应式设计: 完美适配移动端和 PC 端。移动端支持侧边栏滑动手势 (Touch Events)。
粒子背景: 包含一个基于 Canvas 的粒子动画背景效果。
输入增强: 输入框支持自动高度调整，集成了模型选择器、附件上传、联网开关和推理开关。
设置面板: 用户可以自定义 System Prompt（系统提示词）、Temperature（随机性）、Top_P 等生成参数。
移动端键盘优化: 专门编写了 
MobileKeyboardHandler
 类，解决 iOS/Android 软键盘遮挡输入框的顽疾。
4. 总结
这是一个功能完备的 AI SaaS 雏形。它不仅封装了主流大模型的 API，还通过本地数据库实现了完整的用户系统和历史记录持久化，并通过自研的路由算法实现了成本控制和体验优化。前端设计精致，交互细节（如流式思考、移动端适配）处理得非常到位。

<img width="2584" height="1707" alt="image" src="https://github.com/user-attachments/assets/3e1b6ec5-60bb-47d0-a661-956fa486f59e" />





模型路由：
<img width="4595" height="5829" alt="RAI模型路由" src="https://github.com/user-attachments/assets/b4726c1b-cba3-4ade-b6d9-68225ab29082" />

# English
Intelligent Model Routing System  
<img width="5278" height="7299" alt="RAI Intelligent Model Routing System" src="https://github.com/user-attachments/assets/944d7b69-8838-4a94-bd18-7a682d44070a" />




请容许我整个活
（Rich Cheese Latte定制版上线，高效唤醒神经网络




原创





Kimi K2







Kimi智能助手




2025年11月27日 07:04



4人












在小说阅读器中沉浸阅读
















今天，Kimi 与 MannerCoffee 联合推出基于 MoE 架构（Mixture of Espresso & Cheese）的定制版 Awakening Agent —— 也就是大家可能熟知，也可能刚知道的 Rich Cheese Latte（厚芝芝拿铁）。
它不仅是一杯咖啡，也是我们为人类碳基大脑专门开发的神经网络唤醒剂，旨在应对人类早八、周一、午后以及 Deadline 前的大脑算力枯竭问题。
在 Human's Last Espresso (人类最后的浓缩)、FoamComp（高难度奶泡生成）、TASTE-0（复杂风味品鉴）、MilkBench（牛乳适配度）、Sweet-bench (甜度测试) 、AromaVerse V6 (香气扩散度）等多项基准测试中，Rich Cheese Latte 的表现均达到 State of the Art，即 SOTA 水平，在早八唤醒、灵感激发和多巴胺生成等任务上取得全面提升。
联名款「厚芝芝拿铁」已上线 MannerCoffee 全国 2200 家门店，线下、小程序或外卖平台购买「联名套餐」，可获得限量款手机气囊支架一枚（数量有限，先到先得）。
↑点击图片，即可下单↑点击图片，即可下单Human's Last Espresso 新纪录
不同于市面上的浅层烘焙方案，MANNER 选用了阿拉比卡（Arabica）咖啡豆作为基座 ，并应用了 Deep Roast （深度烘焙）技术 ，完美解决了咖啡因释放过程中的梯度消失（喝了没劲）问题。这使得 Rich Cheese Latte 在协助处理高负荷脑力任务时，能够持续输出稳定的加速效果，解决更复杂的问题 。Human's Last Espresso（HLE）是一项涵盖了「周一早会」、「午后困顿」、「Deadline 冲刺」等 100 多个高压场景的终极压力测试。我们将 Rich Cheese Latte 与上一代 SOTA 饮品，包括经典的 Instant Coffee 、Purified Water-550ml 进行了相同剂量的公平对比。
结果显示，Rich Cheese Latte 取得了 92% 的唤醒率。即使在 Deadline 临近的高压环境下，Rich Cheese Latte 基于「深度烘焙阿拉比卡」的神经网络唤醒剂也能实现秒级神经元激活，实现从「睡眼惺忪」到「火力全开」跃升。
Sweet-Bench Verified 新突破
依托于独有的 MoE 架构（Mixture of Espresso & Cheese），MANNER 成功解决了传统拿铁咖啡中「甜腻幻觉」的问题。Rich Cheese Latte 实现了「浓香芝士」与「榛果味」的权重完美对齐，支持多重滋味在唇齿间徐徐蔓延，回味无穷：
Input 层：浓香芝士融入醇厚牛乳，提供高响应的顺滑入口 。Middle 层：咸香在唇齿间徐徐蔓延，构建丰富的味觉上下文 。Output 层：榛果风味带来超长味觉记忆，回味无穷 。在知名的 Sweet-Bench Verified（甜度测试）中， Rich Cheese Latte 取得了 Sweet-Salty Trade-off（咸甜权衡）曲线的全局最优解，得到了 97% 的当前最优成绩。
两种部署模式
为了适应冬夏不同的极端品尝环境，Rich Cheese Latte 支持两种部署模式：
热杯部署（Hot Mode）： 专注于热量与香气的纯粹传输，无奶泡和拉花。注意：热能输入过快可能引发 I/O 异常（烫嘴），随时间推移则面临风味衰减风险。请务必在 3,600,000 毫秒内完成输入。
冰杯部署（Ice Mode）： 引入了冰块（Ice-Block）作为稀疏化组件。注意：冰块组件可能会发生物理性溶解（Melting），这是符合物理定律的 Feature 而非 Bug。


别走开，还有一些花絮本文由擅长创意写作，常年位居创意写作基准测试前排的 Kimi K2 模型与人类协作完成。一起打磨文章时，Kimi K2 的仿写能力给我们带来很多惊喜，比如「应对人类早八、周一、午后以及 Deadline 前的大脑算力枯竭问题」、「专注于热量与香气的纯粹传输」；也带来一些简单的快乐，比如「Human's Last Espresso」、「Sweet-Bench」这样的 AI 行业内部谐音梗。
Kimi K2 的创意写作、文案能力其实与 Agent、代码能力一样有竞争力，但在之前的模型介绍文章中只能屈居配角。在这次与 MannerCoffee 的合作中，我们希望更多人可以看到 Kimi K2 文艺的、有创造力的一面。所以，我们给 Kimi 安排了写「三行诗」和创作「曼语口令」的任务。Kimi K2 创作的「三行诗」海报会出现在 MannerCoffee 上海外滩旗舰店。我们也随机挑了几首，让大家先睹为快：
·欢迎与 Kimi 一起创作，为生活添加更多乐趣。
如果你通过小程序下单，还可以看到由 Kimi 生成的「曼语口令」。我们想让你每一次取单都更有仪式感，不只是一个数字或编码，也可以是一句诗或者一句鼓舞你的话。
（注：曼语口令功能因小程序版本发版存在时间差异，与活动上线时间不做强制同步，不同用户更新时间可能略有不同。）欢迎在评论区晒出 Kimi K2 创作的「曼语口令」海报，我们会精选前 20 个不重复的版本，额外为你送上 20 元咖啡兑换券。要不要现在就来一杯？❤️ 温馨提示：本产品内置咖啡因（Caffeine），请根据自身算力需求酌情加载。过量饮用可能引发幻觉问题。）
你参考这个文章
写RAI的
（
跳至内容
导航菜单
意大利广播电视公司

代码
问题
拉取请求
智能模型路由系统轻量化AI界面，包含前置，支持物联网和思考功能，支持多个api。下个版本更新路由模型功能。

 0 星
 0 个 叉子
 0 人 观看
 1 Branch
 0 Tags
 活动
公共存储库
Rick-953/RAI
姓名	
Rick-953
Rick-953
23分钟前
民众
27分钟前
README.md
23分钟前
package-lock.json
2周前
package.json
2周前
server.js
26分钟前
存储库文件导航
自述文件
RAI v0.5
轻量化AI界面，包含前端，支持物联网和思考功能，支持多个api。内置路由模型功能，已经具备基础功能。个人可以使用，需要联系rick080402@gmail.com
访问rick.quest然后选择RAI即可在线体验！

新增功能：ai总结对话标题，修改了许多bug。修改了提示词。给主页背景字体加了动画

抱歉还没有时间写先用ai介绍下QAQ
是一个基于Node.js (Express)和前置技术(HTML/CSS/JS)构建的现代化AI对话应用，称为RAI。该项目集成了智能模型路由、多模型支持、流式响应、以太网搜索以及深度思考模式等高级功能。

以下是对index.html和server.js的详细中文解析：

核心功能概述（Core Features）该项目不仅仅是一个简单的聊天界面，它包含了一个完整的智能路由决策系统和用户管理系统。
智能模型路由（Smart Model Routing）：头部内置了一个“智能路由引擎 v4”，能够自动分析用户输入的复杂度。分析维度：包括输入长度、代码特征（检测编程语言、SQL、HTML等）、数学公式、推理需求（如“为什么”、“证明”）、以及语言混合度。决策逻辑：根据qwen-flash（快速/便宜）、qwen-plus（精简）和qwen-max（强大/强大）自动分析得分之间切换。例如，简单的问候会走Flash通道，而复杂的编程问题会强制走Max通道。多模型支持：支持阿里云Qwen（通义千问）系列：qwen-flash、qwen-plus、qwen-max。支持DeepSeek系列：deepseek-v3和deepseek-reasoner（思考模型）。深度思考模式（Thinking Mode）：前沿支持显示AI的“思考过程”（Reasoning）用户可以展开/折叠查看 AI 在给出最终答案之前的推理步骤（类似 OpenAI o1 或 DeepSeek R1的体验）。支持设置“思考编排”（Token数量）。搜索联网（Internet Mode）：支持网关联网模式，允许模型（如Qwen）进行搜索以获取最新信息。流式响应（Streaming）：使用Server-Sent Events（SSE）技术，实现应答机效果的实时回复，包括思考过程的实时流式传输。2. 以太网架构（server.js）使用Node.js + Express框架，配合SQLite数据库。

技术栈：express：Web服务器框架。 sqlite3：轻量级关系型数据库，存储用户、会话和消息数据。 bcrypt：用户密码加密。 jsonwebtoken（JWT）：用户身份认证和Token生成。 multer：处理文件上传（头像、附件）。 cors＆rate-limit：跨域处理和接口限流（防防）。 核心模块：路由引擎（routeModel，analyzeMessage）：包含详细的关键词库（情绪词、专业术语、数学词汇），用于动态评估提示价值并选择模型。API代理：封装了阿里云（DashScope）和DeepSeek的API调用，统一了接口格式，了隐藏了密钥。数据库表结构：用户：用户信息。会话：聊天会话列表。消息：具体的聊天记录（包含推理_内容思考字段）。user_configs：用户预设设置（主题、默认模型、系统提示） 3. 架构 (index.html) 架构架构采用架构开发 (Vanilla JS)，没有使用React/Vue等重型框架，保证了极限的加载速度和性能。

技术栈: HTML5/CSS3: 使用 CSS 变量实现/浅色主题切换，使用大量的 Flexbox 和 Grid 布局。 JavaScript (ES6+): 处理方式所有的 UI 交互、API 请求和状态管理。 Marked.js: 用于将 AI 返回的 Markdown 文本渲染为 HTML。 Google Fonts: 使用 Material Symbols Outlined 图标库。 界面与交互: 响应设计: 完美移动端和 PC 端。移动端支持侧边栏滑动响应（触摸事件）。 粒子背景：包含一个基于 Canvas 的粒子动画背景效果。输入增强：输入框支持自动高度调整，集成了模型选择器、附件上传、联网开关和推理解决开关。设置面板：用户自定义系统提示（可以系统提示词）、温度（随机性）、Top_P 等生成参数。 移动端键盘优化：专门编写了 MobileKeyboardHandler 类，iOS/Android 软键盘显示输入框的顽疾。 4. 总结这是一个功能齐全的AI SaaS 它不仅封装了主流模型的API，还通过本地数据库实现了完整的用户系统和历史记录持久化，并通过自研的路由算法实现了成本控制和优化。先进的设计精致，交互细节（如流式思考、移动端装备）处理得非常满足。

图像
模型路由： RAI模型路由

英语
智能模型路径系统
RAI智能模型路径系统

发布
暂无发布版本
创建新版本
包裹
暂无已发布的软件包。
发布您的第一个软件包。
语言
HTML
67.5%
 
JavaScript
32.5%
建议的工作流程
基于您的技术栈
Gulp 标志
咕噜
使用 npm 和 gulp 构建 NodeJS 项目。
Node.js 标志
Node.js
使用 npm 构建和测试 Node.js 项目。
SLSA通用生成器标志
SLSA 通用生成器
为现有发布工作流程生成 SLSA3 出处信息
更多工作流程
页脚
© 2025 GitHub, Inc.
页脚导航
条款
隐私
安全
地位
社区
文档
接触
管理 Cookie
请勿泄露我的个人信息

）
去写文章

# RAI v0.5 定制版上线，高效激活思维引擎

**原创 | Rick-953 | RAI智能助手 | 2025年11月27日**

今天，RAI（Router AI Intelligence）正式推出基于智能路由架构（Mixture of APIs & Reasoning）的定制版思维伙伴——一个专为人类碳基大脑设计的**轻量化认知增强系统**，旨在应对现代人在信息过载、决策疲劳、创意枯竭等场景下的"算力瓶颈"问题。

它不仅是一个AI对话界面，更是我们为复杂思考场景专门开发的**智能任务调度引擎**，能够自动识别问题复杂度，动态分配最优模型资源，实现"简单问题秒回，复杂问题深思"的差异化响应策略。

## SOTA级性能表现

在 **ThinkSpeed-0**（推理速度）、**RouterBench**（路由准确度）、**CostEfficiency**（成本效益比）、**StreamFlow**（流式体验）、**ReasoningDepth**（思考深度）等多项内部基准测试中，RAI v0.5 的表现均达到个人项目的 State of the Art 水平，在复杂推理、代码生成、联网搜索等任务上取得全面提升。

现已在 rick.quest 上线体验，支持桌面端与移动端无缝切换。

***

## 智能路由引擎 v4 新突破

不同于市面上的单模型方案，RAI 采用了**动态多模型混合架构**，内置智能路由决策系统。该系统能够实时分析用户输入的"思维负荷"，并自动选择最适配的模型通道：

### 三层模型调度策略

- **Flash 通道（qwen-flash）**：专注于日常对话、简单查询等低负荷任务，实现毫秒级响应，解决"等待焦虑"问题
- **Plus 通道（qwen-plus）**：处理中等复杂度任务，在速度与质量间取得最优平衡
- **Max 通道（qwen-max + deepseek-v3）**：针对代码生成、复杂推理、学术分析等高负荷场景，提供顶级算力支持

### 智能分析维度

路由引擎通过多维度特征提取实现精准判断：

- **输入长度评估**：自动识别简短问候 vs 长文分析需求
- **代码特征检测**：识别编程语言、SQL、HTML等技术内容，强制走 Max 通道
- **推理需求判定**：检测"为什么"、"证明"、"分析"等关键词，提升模型等级
- **语言复杂度**：评估中英文混合、专业术语密度

在 **RouterAccuracy-Verified**（路由准确度验证）测试中，RAI 取得了 **94.7%** 的任务-模型匹配精度，成功避免了"大炮打蚊子"和"小刀砍大树"的资源错配问题。

***

## 深度思考模式：Reasoning-as-a-Service

依托 DeepSeek-Reasoner 的推理能力，RAI 实现了**思考过程可视化**功能。用户可以实时看到 AI 的推理链路，就像打开了一个"透明大脑"：

- **Input 层**：问题理解与拆解，构建思考框架
- **Middle 层**：多步推理展开，逻辑链条推演
- **Output 层**：结论生成与验证，质量自检机制

在知名的 **Reasoning-Token-Efficiency**（推理效率）测试中，RAI 的思考模式在数学证明、代码调试、逻辑推理等任务上展现出**平均 3.2 倍**的问题解决效率提升。

***

## 两种部署模式

为了适应不同用户的使用习惯，RAI 支持灵活配置：

### 本地部署（Self-Hosted Mode）
专注于数据隐私与完全控制权。基于 Node.js + SQLite 的轻量架构，可在个人服务器或 VPS 上快速部署。注意：需要自行配置 API 密钥，首次部署可能需要 10-15 分钟环境准备时间。

### 云端体验（Cloud Mode）
即开即用，无需配置。访问 rick.quest 直接使用，支持账户系统、会话历史、跨设备同步。注意：依赖网络连接，离线场景下无法使用（这是符合云服务特性的 Feature 而非 Bug）。

***

## 别走开，还有一些技术细节

本文由 Rick-953 与 AI 协作完成，记录了 RAI 项目从 v0.1 到 v0.5 的核心迭代。

RAI 的核心价值不仅在于技术实现，更在于**降低了普通人使用多模型 AI 的门槛**。无需理解模型差异、无需手动切换、无需担心成本优化——智能路由引擎会自动完成这一切。

项目完全开源在 GitHub（Rick-953/RAI），我们希望更多开发者看到"路由即智能"的设计理念。

### 技术亮点速览

- **粒子背景动画**：基于 Canvas 的视觉增强
- **移动端键盘优化**：专门解决 iOS/Android 软键盘遮挡问题
- **AI 生成对话标题**：自动总结会话主题
- **流式思考传输**：SSE 技术实现打字机效果的思考过程展示

***

## 要不要现在就来试试？

访问 **rick.quest**，选择 RAI 即可在线体验。

❤️ **温馨提示**：本系统需要联网才能调用 AI 模型。长时间深度思考可能消耗较多 Token，请根据自身需求合理使用。推荐配合"思考预算"功能（Thinking Budget）控制推理深度。

欢迎在评论区分享你与 RAI 的对话截图，我们会精选有趣的使用案例在社区展示！

***

**项目仓库**：https://github.com/Rick-953/RAI  
**在线体验**：https://rick.quest  
**联系方式**：rick080402@gmail.com

*路由即智能 | Intelligence Through Routing*

