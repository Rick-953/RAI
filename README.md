<div align="center">

# RAI

### <img src="https://api.iconify.design/solar/planet-saturn-bold.svg?color=%23F59E0B&width=32&height=32" valign="middle" alt="RAI Logo" /> 智能 AI 聊天助手 | Intelligent AI Chat Assistant

[![Version](https://img.shields.io/badge/Version-0.8-F59E0B?style=flat-square)]()
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![License](https://img.shields.io/badge/License-Personal_Free-F59E0B?style=flat-square)](#-授权与商用)

**RAI v0.8** 版本开始内置模型路由，能够根据问题复杂度自动选择最佳模型，0成本，低延时的极致体验:D

## 官网：rai.rick.quest  

[English](#english) | [功能特性](#-功能特性) | [功能列表](#-功能列表) | [快速开始](#-快速开始) | [模型路由](#-智能模型路由) | [在线体验](#-在线体验)

</div>

---

# 最新更新内容  
支持Chat Flow  β 超多bug警告！这是Chat Flow专属界面，正经界面接着往下翻。   <img width="2790" height="1716" alt="2a34d7f57edae57ed934c61c386aed49" src="https://github.com/user-attachments/assets/96b0a2c4-b42a-4644-817f-b3d1c94a76ff" /> <img width="682" height="832" alt="2e5cb220ac1be47b1d25dbb55e4d2f29" src="https://github.com/user-attachments/assets/7270482c-9b3d-4be4-84a9-d20b3726d411" />


## <img src="https://api.iconify.design/material-symbols/star-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 功能特性

### <img src="https://api.iconify.design/material-symbols/robot-2-outline.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 多模型支持
- **阿里云通义千问**: Qwen-Flash / Qwen-Plus / Qwen-Max
- **DeepSeek**: DeepSeek-V3 / DeepSeek-Reasoner / DeepSeek-V3.2-Speciale

### <img src="https://api.iconify.design/material-symbols/psychology.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 智能模型路由 (核心特色)
- **Auto 模式**: 根据问题复杂度自动选择最佳模型
- **五维度分析**: 输入长度、代码检测、数学公式、推理复杂度、语言混合度
- **关键词触发**: 情绪词、专业术语、复杂值词智能识别
- **预设答案**: 常见问候语极速响应，零成本零延迟

### <img src="https://api.iconify.design/material-symbols/language.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 联网搜索
- Tavily API 实时搜索集成
- 阿里云原生联网搜索支持
- 搜索结果自动注入对话上下文

### <img src="https://api.iconify.design/material-symbols/thinking-problem-outline.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 思考模式 (Chain of Thought)
- DeepSeek Reasoner 深度推理
- 阿里云 Qwen 思考模式
- 思考过程可视化展示
- 思考预算可调控

### <img src="https://api.iconify.design/material-symbols/devices.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 现代化 UI
- 响应式设计，完美适配 PC / 移动端
- 深色 / 浅色主题切换
- 流式输出，打字机效果
- Markdown + LaTeX 数学公式渲染
- 精美动画效果

### <img src="https://api.iconify.design/material-symbols/image.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 图文并茂 (v0.8 新增)
- 支持ai回复过程中插入多张图片到回答里。  
- <img width="1108" height="1703" alt="屏幕截图 2025-12-13 143709" src="https://github.com/user-attachments/assets/f8b414a7-2316-47fa-a5cb-72184beff4b1" />
- 支持画流程图，统计图，思维导图等各种类型的图表！  
- <img width="2744" height="1684" alt="image" src="https://github.com/user-attachments/assets/9a0d3c91-c4c1-4261-ac67-64d90f90c85b" />
- 一次回答图文表并茂！  

### <img src="https://api.iconify.design/material-symbols/format-quote.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 引用回复 (v0.8 新增)
- 消息引用功能，回复特定内容
- 引用预览，快速定位上下文
- 支持删除和修改引用

### <img src="https://api.iconify.design/material-symbols/edit-note.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> 编辑消息 (v0.8 新增)
- 已发送消息可编辑修改
- 编辑后重新生成 AI 回复
- 保留编辑历史记录

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
| | 消息复制 | 一键复制 AI 回复内容 |
| | 停止生成 | 随时中断 AI 的输出过程 |
| | **图文并茂** | AI 回复支持丰富图片内容 (v0.8) |
| | **引用回复** | 消息引用功能，精准回复 (v0.8) |
| | **编辑消息** | 已发送消息可编辑修改 (v0.8) |
| **模型能力** | 多模型切换 | 支持 Qwen (Flash/Plus/Max) 和 DeepSeek 系列 |
| | **智能路由** | 自动分析问题复杂度，选择最优模型 (Auto模式) |
| | 联网搜索 | 实时获取网络信息，支持 Tavily 和原生联网 |
| | 思考模式 | 展示 AI 推理过程，支持折叠/展开和逐句动画 |
| | 预设答案 | 常见问候语毫秒级响应，无需消耗 Token |
| **会话管理** | 会话列表 | 侧边栏管理所有历史对话 |
| | 自动标题 | 根据对话内容自动生成合适的标题 |
| | 新建/删除 | 随时开启新话题或清理旧记录 |
| | 会话搜索 | 快速查找历史对话内容 |
| **用户系统** | 注册/登录 | 邮箱+密码注册，JWT 安全认证 |
| | 头像管理 | 支持上传自定义头像 |
| | 个性化配置 | 自定义温度、Top-P、最大长度等参数 |
| | 系统提示词 | 设置全局 System Prompt，定制 AI 人设 |
| **界面交互** | 响应式设计 | 完美适配桌面、平板和手机屏幕 |
| | 主题切换 | 支持深色模式和浅色模式 |
| | 动画效果 | 欢迎页土星浮动、标题金属光泽、消息滑入等 |
| | 快捷操作 | 欢迎页提供常用功能快捷入口 |
| **空间管理** | 知识库空间 | 创建独立空间管理文档 (RAG基础) |
| | 文档上传 | 支持上传文件用于辅助对话 |

---

## <img src="https://api.iconify.design/material-symbols/rocket-launch-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 快速开始

### 环境要求

- Node.js 18+
- npm 或 yarn

### 安装步骤

```bash
# 克隆项目
git clone https://github.com/yourusername/RAI.git
cd RAI/ai

# 安装依赖
npm install

# 启动服务
node server.js
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

---

## <img src="https://api.iconify.design/material-symbols/build-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 技术栈

<div align="center">

| 前端 | 后端 | 数据库 | AI 服务 |
|:---:|:---:|:---:|:---:|
| HTML5 | Node.js | SQLite | 阿里云百炼 |
| CSS3 | Express | - | DeepSeek |
| JavaScript | JWT | - | Tavily |
| KaTeX | bcrypt | - | - |

</div>

---

## <img src="https://api.iconify.design/material-symbols/folder-open-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> 项目结构

```
RAI/
├── ai/
│   ├── public/
│   │   ├── index.html      # 前端主文件
│   │   └── lib/            # 第三方库
│   ├── server.js           # 后端服务
│   ├── ai_data.db          # SQLite 数据库
│   ├── uploads/            # 上传文件
│   ├── avatars/            # 用户头像
│   └── package.json        # 依赖配置
└── README.md
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

</div>

### <img src="https://api.iconify.design/material-symbols/star-outline.svg?color=%23F59E0B&width=20&height=20" valign="middle" /> Key Features

- **<img src="https://api.iconify.design/material-symbols/robot-2-outline.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Multi-Model Support**: Qwen (Flash/Plus/Max) + DeepSeek (V3/Reasoner)
- **<img src="https://api.iconify.design/material-symbols/psychology.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Smart Routing**: Auto-select optimal model based on 5-dimension analysis
- **<img src="https://api.iconify.design/material-symbols/language.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Web Search**: Real-time internet search via Tavily API
- **<img src="https://api.iconify.design/material-symbols/thinking-problem-outline.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Thinking Mode**: Chain-of-thought reasoning with visualization
- **<img src="https://api.iconify.design/material-symbols/devices.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Modern UI**: Responsive design, dark/light themes, streaming output
- **<img src="https://api.iconify.design/material-symbols/lock-outline.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Secure**: JWT auth, rate limiting, encrypted passwords
- **<img src="https://api.iconify.design/material-symbols/image.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Rich Media**: Image-rich AI responses with smooth loading (v0.8)
- **<img src="https://api.iconify.design/material-symbols/format-quote.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Quote Reply**: Reply to specific messages with context (v0.8)
- **<img src="https://api.iconify.design/material-symbols/edit-note.svg?color=%23F59E0B&width=16&height=16" valign="middle" /> Edit Messages**: Modify sent messages and regenerate (v0.8)

### <img src="https://api.iconify.design/material-symbols/hub.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> Intelligent Model Routing System

<div align="center">
<img width="800" alt="RAI Intelligent Model Routing System" src="https://github.com/user-attachments/assets/944d7b69-8838-4a94-bd18-7a682d44070a" />
</div>

The routing engine evaluates queries across **5 dimensions**:

| Dimension | Weight | Description |
|:---|:---:|:---|
| Input Length | 15% | Message character count |
| Code Detection | 30% | Programming language & syntax |
| Math Formula | 25% | Mathematical expressions |
| Reasoning | 25% | Logic complexity indicators |
| Language Mix | 5% | Multi-language presence |

### <img src="https://api.iconify.design/material-symbols/rocket-launch-outline.svg?color=%23F59E0B&width=24&height=24" valign="middle" /> Quick Start

```bash
git clone https://github.com/yourusername/RAI.git
cd RAI/ai
npm install
node server.js
```

Visit `http://localhost:3009` in your browser.

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
