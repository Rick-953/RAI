# RAI v0.5
轻量化AI界面，包含前后端，支持联网和思考功能，支持多个api。内置路由模型功能，已经有基础功能。
个人可以使用，修改，商用需要联系rick080402@gmail.com  
访问rick.quest然后选择RAI即可在线体验！  

新增功能：ai总结对话标题，修了一堆bug。改了改提示词。

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


