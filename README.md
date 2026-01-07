<div align="center">

# RAI

### <img src="https://api.iconify.design/solar/planet-saturn-bold.svg?color=%23F59E0B&width=32&height=32" valign="middle" alt="RAI Logo" /> 智能 AI 聊天助手 | Intelligent AI Chat Assistant

[![Version](https://img.shields.io/badge/Version-0.85+-F59E0B?style=flat-square)]()
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![License](https://img.shields.io/badge/License-Personal_Free-F59E0B?style=flat-square)](#-授权与商用)

**RAI v0.85+** 全新 **Chat Flow 思维流** 功能，将对话与可视化画布结合，构建思维图谱！

## 官网：rai.rick.quest  

[English](#english) | [功能特性](#-功能特性) | [功能列表](#-功能列表) | [快速开始](#-快速开始) | [模型路由](#-智能模型路由) | [在线体验](#-在线体验)

</div>

---

# 最新更新内容

## 🎨 Chat Flow 思维流 (v0.85+ 重磅新增)

将 AI 对话与可视化画布完美结合，打造属于你的思维图谱：

- **无限画布**: 拖拽对话内容到画布，自由组织你的思维
- **智能连线**: 为节点创建语义化连接，添加标签说明关系  
- **AI 拆解**: 选中节点后，AI 自动分解为子话题
- **多种导出**: 支持 PNG、SVG、Mermaid、JSON 导出
- **自动布局**: 一键整理画布节点

<img width="2790" height="1716" alt="Chat Flow 界面" src="https://github.com/user-attachments/assets/96b0a2c4-b42a-4644-817f-b3d1c94a76ff" /> 
<img width="682" height="832" alt="Chat Flow 移动端" src="https://github.com/user-attachments/assets/7270482c-9b3d-4be4-84a9-d20b3726d411" />

---

## <img src="https://api.iconify.design/material-symbols/star-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 功能特性

### <img src="https://api.iconify.design/material-symbols/robot-2-outline.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 多模型支持
- **阿里云通义千问**: Qwen-Flash / Qwen-Plus / Qwen-Max / Qwen3 8B (免费) / Qwen3 Omni Flash
- **DeepSeek**: DeepSeek-V3.2
- **Moonshot**: Kimi K2
- **本地部署**: LMStudio 本地模型

### <img src="https://api.iconify.design/material-symbols/psychology.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 智能模型路由 (核心特色)
- **Auto 模式**: 根据问题复杂度自动选择最佳模型
- **五维度分析**: 输入长度、代码检测、数学公式、推理复杂度、语言混合度
- **关键词触发**: 情绪词、专业术语、复杂值词智能识别
- **预设答案**: 常见问候语极速响应，零成本零延迟

### <img src="https://api.iconify.design/material-symbols/language.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 联网搜索
- Tavily API 实时搜索集成
- 阿里云原生联网搜索支持
- AI 智能判断是否需要联网
- 搜索结果自动注入对话上下文

### <img src="https://api.iconify.design/material-symbols/thinking-problem-outline.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 思考模式 (Chain of Thought)
- DeepSeek Reasoner 深度推理
- 阿里云 Qwen 思考模式
- 思考过程可视化展示
- 思考预算可调控 (1-32768 tokens)

### <img src="https://api.iconify.design/material-symbols/devices.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 现代化 UI
- 响应式设计，完美适配 PC / 移动端
- 深色 / 浅色主题切换
- 流式输出，打字机效果
- Markdown + LaTeX 数学公式渲染
- Mermaid 图表渲染 (支持全屏、缩放、导出)
- 精美动画效果

### <img src="https://api.iconify.design/material-symbols/image.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 多模态能力
- 图片理解与描述 (Qwen VL Max / Qwen3 Omni Flash)
- 视频理解 (Qwen VL Max Latest)
- 文档上传与解析 (PDF, DOCX, TXT)
- AI 回复支持插入图片

### <img src="https://api.iconify.design/material-symbols/format-quote.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 引用回复
- 消息引用功能，回复特定内容
- 引用预览，快速定位上下文
- 支持删除和修改引用

### <img src="https://api.iconify.design/material-symbols/edit-note.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 编辑消息
- 已发送消息可编辑修改
- 编辑后重新生成 AI 回复
- 保留编辑历史记录

### <img src="https://api.iconify.design/material-symbols/card-membership.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 会员系统
- 每日签到领取 20 点数
- 点数消费透明记录
- VIP 会员等级与权益

### <img src="https://api.iconify.design/material-symbols/lock-outline.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 安全可靠
- JWT 令牌认证
- API 限流保护
- 密码加密存储

---

## <img src="https://api.iconify.design/material-symbols/list-alt-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 功能列表

| 类别 | 功能 | 描述 |
|:---|:---|:---|
| **核心对话** | 流式响应 | 打字机效果，实时输出 |
| | Markdown 渲染 | 支持表格、列表、引用等富文本格式 |
| | 数学公式 | 支持 LaTeX 语法，完美渲染复杂公式 |
| | 代码高亮 | 自动识别编程语言，提供语法高亮 |
| | Mermaid 图表 | 流程图、序列图、思维导图等，支持全屏交互 |
| | 消息复制 | 一键复制 AI 回复内容 |
| | 停止生成 | 随时中断 AI 的输出过程 |
| | **图文并茂** | AI 回复支持丰富图片内容 |
| | **引用回复** | 消息引用功能，精准回复 |
| | **编辑消息** | 已发送消息可编辑修改 |
| **Chat Flow** | 思维流画布 | 将对话拖拽到无限画布 |
| | 节点连接 | 创建语义化连线，添加标签 |
| | AI 拆解 | 智能分解话题为子节点 |
| | 多格式导出 | PNG / SVG / Mermaid / JSON |
| | 自动布局 | 一键整理画布节点 |
| **模型能力** | 多模型切换 | Qwen 系列 / DeepSeek / Kimi K2 / 本地模型 |
| | **智能路由** | 自动分析问题复杂度，选择最优模型 (Auto模式) |
| | 联网搜索 | AI 自主判断是否需要搜索，实时获取网络信息 |
| | 思考模式 | 展示 AI 推理过程，支持折叠/展开和逐句动画 |
| | 预设答案 | 常见问候语毫秒级响应，无需消耗 Token |
| | **多模态** | 图片/视频理解，文档解析 |
| **会话管理** | 会话列表 | 侧边栏管理所有历史对话 |
| | 自动标题 | 根据对话内容自动生成合适的标题 |
| | 新建/删除 | 随时开启新话题或清理旧记录 |
| | 会话搜索 | 快速查找历史对话内容 |
| **用户系统** | 注册/登录 | 邮箱+密码注册，JWT 安全认证 |
| | 头像管理 | 支持上传自定义头像 |
| | 个性化配置 | 自定义温度、Top-P、最大长度等参数 |
| | 系统提示词 | 设置全局 System Prompt，定制 AI 人设 |
| | **每日签到** | 签到领取 20 点数 |
| **界面交互** | 响应式设计 | 完美适配桌面、平板和手机屏幕 |
| | 主题切换 | 支持深色模式和浅色模式 |
| | 多语言 | 中文 / English |
| | 动画效果 | 欢迎页土星浮动、标题金属光泽、消息滑入等 |
| | 快捷操作 | 欢迎页提供常用功能快捷入口 |

---

## <img src="https://api.iconify.design/material-symbols/rocket-launch-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 快速开始

### 环境要求

- Node.js 18+
- npm 或 yarn

### 安装步骤

```bash
# 克隆项目
git clone https://github.com/yourusername/RAI.git
cd RAI/rai

# 安装依赖
npm install

# 启动服务
npm start
# 或开发模式
npm run dev
```

### 访问应用

打开浏览器访问: `http://localhost:3009`

---

## <img src="https://api.iconify.design/material-symbols/hub.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 智能模型路由

RAI 的核心特色是**智能模型路由系统**，能够自动分析用户输入并选择最合适的 AI 模型。

<div align="center">
<img width="800" alt="RAI模型路由" src="https://github.com/user-attachments/assets/b4726c1b-cba3-4ade-b6d9-68225ab29082" />
</div>

### 路由策略

| 复杂度评分 | 选择模型 | 适用场景 |
|:---:|:---:|:---|
| < 0.40 | Qwen-Flash | 简单问答、日常聊天 |
| 0.40 - 0.80 | Qwen-Plus | 中等复杂度问题 |
| ≥ 0.80 | Qwen-Max | 专业问题、深度分析 |

### 五维度评估

```
📏 输入长度     ████████░░  权重: 15%
💻 代码检测     ████████░░  权重: 30%
📐 数学公式     ████████░░  权重: 25%
🧠 推理复杂度   ████████░░  权重: 25%
🌍 语言混合     ██░░░░░░░░  权重: 5%
```

### 特殊触发词

- **强制 Max**: 情绪词、强调词、重要标点
- **专业升级**: 技术术语、编程概念、数学词汇

---

## <img src="https://api.iconify.design/material-symbols/play-circle-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 在线体验

- **在线试用**: 访问 [rick.quest](https://rick.quest) 并选择 **RAI** 即可在线体验。
- **功能演示**: 观看详细介绍 [RAI 介绍页](https://rick.rth2.xyz/ai/main.html#how-it-works)

---

## <img src="https://api.iconify.design/material-symbols/menu-book-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> API 文档

### 认证相关

| 端点 | 方法 | 描述 |
|:---|:---:|:---|
| `/api/auth/register` | POST | 用户注册 |
| `/api/auth/login` | POST | 用户登录 |
| `/api/auth/verify` | GET | 验证令牌 |

### 用户相关

| 端点 | 方法 | 描述 |
|:---|:---:|:---|
| `/api/user/profile` | GET | 获取用户信息 |
| `/api/user/config` | PUT | 更新用户配置 |
| `/api/user/avatar` | POST | 上传头像 |
| `/api/user/membership` | GET | 获取会员状态 |
| `/api/user/checkin` | POST | 每日签到 |

### 会话相关

| 端点 | 方法 | 描述 |
|:---|:---:|:---|
| `/api/sessions` | GET | 获取会话列表 |
| `/api/sessions` | POST | 创建新会话 |
| `/api/sessions/:id` | PUT | 更新会话 |
| `/api/sessions/:id` | DELETE | 删除会话 |

### 聊天相关

| 端点 | 方法 | 描述 |
|:---|:---:|:---|
| `/api/chat/stream` | POST | 流式聊天 (SSE) |
| `/api/chat/stop` | POST | 停止生成 |
| `/api/upload` | POST | 上传文件 |

---

## <img src="https://api.iconify.design/material-symbols/build-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 技术栈

<div align="center">

| 前端 | 后端 | 数据库 | AI 服务 |
|:---:|:---:|:---:|:---:|
| HTML5 | Node.js | SQLite | 阿里云百炼 |
| CSS3 | Express | - | DeepSeek |
| JavaScript | JWT | - | Moonshot (Kimi) |
| KaTeX | bcrypt | - | Tavily |
| Mermaid | multer | - | SiliconFlow |
| Highlight.js | - | - | - |

</div>

---

## <img src="https://api.iconify.design/material-symbols/folder-open-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 项目结构

```
rai/
├── public/
│   ├── index.html          # 前端 HTML 结构
│   ├── app.js              # 前端核心逻辑
│   ├── styles.css          # 样式文件
│   └── lib/                # 第三方库
├── server.js               # 后端服务 (Express + 智能路由引擎)
├── textExtractor.js        # 文档文本提取工具
├── ai_data.db              # SQLite 数据库
├── uploads/                # 上传文件
├── avatars/                # 用户头像
├── package.json            # 依赖配置
└── README.md               # 项目文档
```

---

## <img src="https://api.iconify.design/material-symbols/license.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 授权与商用

**个人用户免费支持分支**。

如需**商业用途**，请联系：[rick080402@gmail.com](mailto:rick080402@gmail.com)

---

<div align="center">

# English

## RAI - Intelligent AI Chat Assistant

A smart AI chat assistant with **Intelligent Model Routing** that automatically selects the best model based on query complexity.

**RAI v0.85+** introduces the brand new **Chat Flow** feature, combining conversations with visual canvas to build your mind maps!

</div>

---

## 🎨 Chat Flow (v0.85+ Major Update)

Seamlessly combine AI conversations with visual canvas to create your own mind maps:

- **Infinite Canvas**: Drag conversation content to canvas, freely organize your thoughts
- **Smart Connections**: Create semantic connections between nodes with labels
- **AI Decompose**: Select a node and let AI automatically break it into sub-topics
- **Multiple Exports**: Support PNG, SVG, Mermaid, JSON export
- **Auto Layout**: One-click to organize canvas nodes

<img width="2790" height="1716" alt="Chat Flow Interface" src="https://github.com/user-attachments/assets/96b0a2c4-b42a-4644-817f-b3d1c94a76ff" /> 
<img width="682" height="832" alt="Chat Flow Mobile" src="https://github.com/user-attachments/assets/7270482c-9b3d-4be4-84a9-d20b3726d411" />

---

### <img src="https://api.iconify.design/material-symbols/star-outline.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> Key Features

#### <img src="https://api.iconify.design/material-symbols/robot-2-outline.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Multi-Model Support
- **Alibaba Cloud Qwen**: Qwen-Flash / Qwen-Plus / Qwen-Max / Qwen3 8B (Free) / Qwen3 Omni Flash
- **DeepSeek**: DeepSeek-V3.2
- **Moonshot**: Kimi K2
- **Local Deployment**: LMStudio local models

#### <img src="https://api.iconify.design/material-symbols/psychology.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Intelligent Model Routing (Core Feature)
- **Auto Mode**: Automatically select the best model based on query complexity
- **5-Dimension Analysis**: Input length, code detection, math formulas, reasoning complexity, language mix
- **Keyword Triggers**: Emotion words, professional terms, complexity indicators
- **Preset Answers**: Instant responses for common greetings, zero cost & latency

#### <img src="https://api.iconify.design/material-symbols/language.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Web Search
- Tavily API real-time search integration
- Alibaba Cloud native search support
- AI intelligently decides when to search
- Search results auto-injected into conversation context

#### <img src="https://api.iconify.design/material-symbols/thinking-problem-outline.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Thinking Mode (Chain of Thought)
- DeepSeek Reasoner deep reasoning
- Alibaba Cloud Qwen thinking mode
- Visualized thinking process
- Adjustable thinking budget (1-32768 tokens)

#### <img src="https://api.iconify.design/material-symbols/devices.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Modern UI
- Responsive design, perfect for PC / Mobile
- Dark / Light theme switching
- Streaming output with typewriter effect
- Markdown + LaTeX math rendering
- Mermaid charts (fullscreen, zoom, export)
- Beautiful animations

#### <img src="https://api.iconify.design/material-symbols/image.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Multimodal Capabilities
- Image understanding (Qwen VL Max / Qwen3 Omni Flash)
- Video understanding (Qwen VL Max Latest)
- Document upload & parsing (PDF, DOCX, TXT)
- AI responses with embedded images

#### <img src="https://api.iconify.design/material-symbols/format-quote.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Quote Reply
- Reply to specific messages
- Quick preview of quoted context
- Edit or delete quotes

#### <img src="https://api.iconify.design/material-symbols/edit-note.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Edit Messages
- Modify sent messages
- Regenerate AI response after edit
- Preserve edit history

#### <img src="https://api.iconify.design/material-symbols/card-membership.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Membership System
- Daily check-in for 20 points
- Transparent point consumption records
- VIP membership levels & benefits

#### <img src="https://api.iconify.design/material-symbols/lock-outline.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Security
- JWT token authentication
- API rate limiting
- Encrypted password storage

---

### <img src="https://api.iconify.design/material-symbols/list-alt-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> Feature List

| Category | Feature | Description |
|:---|:---|:---|
| **Core Chat** | Streaming Response | Typewriter effect, real-time output |
| | Markdown Rendering | Tables, lists, blockquotes, rich text |
| | Math Formulas | LaTeX syntax, complex formula rendering |
| | Code Highlighting | Auto language detection, syntax highlighting |
| | Mermaid Charts | Flowcharts, sequence diagrams, mind maps with fullscreen |
| | Copy Message | One-click copy AI response |
| | Stop Generation | Interrupt AI output anytime |
| | **Rich Media** | AI responses with images |
| | **Quote Reply** | Precise replies with context |
| | **Edit Messages** | Modify sent messages |
| **Chat Flow** | Mind Map Canvas | Drag conversations to infinite canvas |
| | Node Connections | Create semantic edges with labels |
| | AI Decompose | Smart decomposition into sub-nodes |
| | Multi-format Export | PNG / SVG / Mermaid / JSON |
| | Auto Layout | One-click node arrangement |
| **Model Capabilities** | Multi-model Switch | Qwen / DeepSeek / Kimi K2 / Local |
| | **Smart Routing** | Auto-select optimal model (Auto mode) |
| | Web Search | AI decides when to search, real-time results |
| | Thinking Mode | Visualized reasoning, collapsible animation |
| | Preset Answers | Instant response for greetings, zero tokens |
| | **Multimodal** | Image/video understanding, document parsing |
| **Session Management** | Session List | Manage all conversations in sidebar |
| | Auto Title | Generate suitable titles from content |
| | Create/Delete | Start new topics or clear old records |
| | Session Search | Quick search conversation history |
| **User System** | Register/Login | Email + password, JWT authentication |
| | Avatar Management | Upload custom avatars |
| | Personalization | Temperature, Top-P, max length settings |
| | System Prompt | Global AI persona customization |
| | **Daily Check-in** | Earn 20 points daily |
| **Interface** | Responsive Design | Desktop, tablet, mobile |
| | Theme Switch | Dark and light modes |
| | Multi-language | Chinese / English |
| | Animations | Saturn floating, metallic title, slide-in |
| | Quick Actions | Welcome page shortcuts |

---

### <img src="https://api.iconify.design/material-symbols/hub.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> Intelligent Model Routing System

<div align="center">
<img width="800" alt="RAI Intelligent Model Routing System" src="https://github.com/user-attachments/assets/944d7b69-8838-4a94-bd18-7a682d44070a" />
</div>

#### Routing Strategy

| Complexity Score | Selected Model | Use Case |
|:---:|:---:|:---|
| < 0.40 | Qwen-Flash | Simple Q&A, daily chat |
| 0.40 - 0.80 | Qwen-Plus | Medium complexity |
| ≥ 0.80 | Qwen-Max | Professional, deep analysis |

#### 5-Dimension Evaluation

```
📏 Input Length     ████████░░  Weight: 15%
💻 Code Detection   ████████░░  Weight: 30%
📐 Math Formula     ████████░░  Weight: 25%
🧠 Reasoning        ████████░░  Weight: 25%
🌍 Language Mix     ██░░░░░░░░  Weight: 5%
```

#### Special Trigger Words

- **Force Max**: Emotion words, emphasis words, important punctuation
- **Professional Upgrade**: Technical terms, programming concepts, math vocabulary

---

### <img src="https://api.iconify.design/material-symbols/rocket-launch-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> Quick Start

#### Requirements

- Node.js 18+
- npm or yarn

#### Installation

```bash
git clone https://github.com/yourusername/RAI.git
cd RAI/rai
npm install
npm start
# or development mode
npm run dev
```

Visit `http://localhost:3009` in your browser.

---

### <img src="https://api.iconify.design/material-symbols/menu-book-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> API Documentation

#### Authentication

| Endpoint | Method | Description |
|:---|:---:|:---|
| `/api/auth/register` | POST | User registration |
| `/api/auth/login` | POST | User login |
| `/api/auth/verify` | GET | Verify token |

#### User

| Endpoint | Method | Description |
|:---|:---:|:---|
| `/api/user/profile` | GET | Get user info |
| `/api/user/config` | PUT | Update user config |
| `/api/user/avatar` | POST | Upload avatar |
| `/api/user/membership` | GET | Get membership status |
| `/api/user/checkin` | POST | Daily check-in |

#### Sessions

| Endpoint | Method | Description |
|:---|:---:|:---|
| `/api/sessions` | GET | Get session list |
| `/api/sessions` | POST | Create new session |
| `/api/sessions/:id` | PUT | Update session |
| `/api/sessions/:id` | DELETE | Delete session |

#### Chat

| Endpoint | Method | Description |
|:---|:---:|:---|
| `/api/chat/stream` | POST | Streaming chat (SSE) |
| `/api/chat/stop` | POST | Stop generation |
| `/api/upload` | POST | Upload file |

---

### <img src="https://api.iconify.design/material-symbols/build-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> Tech Stack

<div align="center">

| Frontend | Backend | Database | AI Services |
|:---:|:---:|:---:|:---:|
| HTML5 | Node.js | SQLite | Alibaba Cloud |
| CSS3 | Express | - | DeepSeek |
| JavaScript | JWT | - | Moonshot (Kimi) |
| KaTeX | bcrypt | - | Tavily |
| Mermaid | multer | - | SiliconFlow |
| Highlight.js | - | - | - |

</div>

---

### <img src="https://api.iconify.design/material-symbols/folder-open-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> Project Structure

```
rai/
├── public/
│   ├── index.html          # Frontend HTML structure
│   ├── app.js              # Frontend core logic
│   ├── styles.css          # Stylesheet
│   └── lib/                # Third-party libraries
├── server.js               # Backend (Express + Smart Routing Engine)
├── textExtractor.js        # Document text extraction tool
├── ai_data.db              # SQLite database
├── uploads/                # Uploaded files
├── avatars/                # User avatars
├── package.json            # Dependencies
└── README.md               # Documentation
```

---

### <img src="https://api.iconify.design/material-symbols/play-circle-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> Online Demo

- **Try it out**: Visit [rick.quest](https://rick.quest) and select **RAI**.
- **Introduction**: Watch how it works at [Introduction Page](https://rick.rth2.xyz/ai/main.html#how-it-works)

### <img src="https://api.iconify.design/material-symbols/license.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> License & Commercial Use

**Free for personal use and supporting branches.**

For **commercial use**, please contact: [rick080402@gmail.com](mailto:rick080402@gmail.com)

---

<div align="center">

Made with <img src="https://api.iconify.design/material-symbols/favorite.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> by RAI Team

</div>
