const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');  // 用于网页搜索

const app = express();
const PORT = process.env.PORT || 3009;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ==================== 智能路由引擎核心 v4 ====================

// 默认词库 (大幅扩充)
const defaultKeywords = {
    forceMax: [
        // 中文情绪词
        '不满意', '很生气', '生气', '愤怒', '错误', '有问题', '我生气了', '你们真烦', '别烦我',
        '糟糕', '太烂', '好烂', '太垃圾', '好垃圾', '好差劲', '太差劲', '好废物', '太废物',
        '坑爹', '气死', '郁闷', '烦死', '吐槽', '无语', '崩溃', '爆炸', '瞎说', '胡说', '乱说',
        '不对', '不是这样', '智障', '弱智', '傻逼', '滚', '闭嘴', '垃圾', '废物',
        // 标点符号
        '!', '!!', '!!!', '！！！！', '!!!!!', '!!!!!!', '……', '。。。', '…………', '！', '！！', '！！！',
        // 中文态度词
        '仔细', '认真', '详细', '一定要', '必须', '立即', '马上', '紧急', '重要', '关键', '严肃',
        '认真对待', '不能马虎', '务必', '千万', '绝对', '一定', '不许', '不能',
        // 英文情绪词
        'angry', 'furious', 'upset', 'disappointed', 'unsatisfied', 'awful', 'terrible', 'horrible',
        'wrong', 'error', 'problem', 'issue', 'urgent', 'critical', 'important', 'immediate',
        'cannot', 'must not', 'absolutely', 'definitely', 'certainly', 'seriously', 'carefully',
        'bad', 'stop', 'lie', 'lying', 'incorrect', 'false', 'stupid', 'idiot', 'shut up'
    ],
    complexity: [
        // 中文复杂值词
        '详细设计', '完整方案', '深层分析', '系统性', '多角度', '综合分析', '全面讨论', '深入探讨',
        '架构设计', '方案设计', '性能优化', '功能扩展', '集成方案', '解决方案', '最佳实践',
        '技术评估', '效果评测', '对比分析', '趋势预测', '风险评估', '成本分析',
        // 英文复杂值词
        'comprehensive', 'detailed', 'complete', 'thorough', 'systematic', 'analysis', 'design',
        'architecture', 'optimization', 'performance', 'integration', 'solution', 'strategy',
        'evaluation', 'assessment', 'comparison', 'prediction', 'forecast', 'complex'
    ],
    professional: [
        // 编程相关
        '算法', '数据结构', '微服务', '分布式', '并发', '异步', '线程', '进程', '进程间通信',
        '设计模式', '架构', '系统架构', '数据库', '缓存', '优化', '性能优化',
        '编程语言', '开发框架', '库', 'SDK', '依赖', '包管理', '版本控制',

        // 容器和云
        'Docker', 'Kubernetes', 'K8s', '容器化', '容器编排', 'AWS', 'Azure', 'GCP', '云计算',
        'Redis', 'MongoDB', 'MySQL', '消息队列', 'MQ', 'RabbitMQ', 'Kafka', 'ElasticSearch',

        // 测试和质量
        '单元测试', '集成测试', '测试覆盖率', 'Mock', '测试驱动', 'TDD', 'BDD',

        // 监控和运维
        '日志', '监控', '告警', '追踪', 'APM', '健康检查', '熔断', '限流', '隔离',

        // API和通信
        'API', 'REST', 'GraphQL', 'gRPC', 'HTTP', 'TCP', 'UDP', 'WebSocket', 'DNS',

        // 安全相关
        '加密', '密码学', 'SSL', 'TLS', '认证', '授权', '权限', '安全', '漏洞',

        // 数据相关
        '数据分析', '机器学习', '深度学习', '神经网络', '模型', 'NLP', 'CV',
        '爬虫', '大数据', 'Hadoop', 'Spark', 'Flink', 'ETL', '数据仓库',

        // 其他技术
        '物联网', 'IoT', '区块链', '智能合约', '虚拟机', '编译器', '解释器',
        '词法分析', '语法分析', '代码生成', '类型系统', '类型推断',

        // 工程化
        'CI/CD', 'DevOps', 'Git', 'GitLab', 'GitHub', '版本管理', '代码审查',
        'RESTful', '接口设计', '微前端', '前端工程', '后端工程',

        // 英文专业词
        'algorithm', 'datastructure', 'microservice', 'distributed', 'concurrent',
        'architecture', 'optimization', 'framework', 'pattern', 'container',
        'orchestration', 'scalability', 'availability', 'reliability', 'consistency',
        'deployment', 'integration', 'regression', 'refactoring', 'caching'
    ],
    math: [
        // 中文数学词
        '微分', '积分', '求导', '矩阵', '向量', '特征值', '特征向量', '行列式', '秩',
        '线性代数', '群论', '拓扑', '几何', '解析几何', '射影几何', '微分几何',
        '概率', '统计', '分布', '期望', '方差', '协方差', '相关系数', '回归',
        '傅里叶', '拉普拉斯', '卷积', '变换', '滤波', '频域', '时域',
        '微分方程', '偏微分方程', '常微分方程', '积分方程', '泛函分析',
        '数论', '组合', '排列', '阶乘', '二项式', '生成函数', '递推关系',
        '极限', '连续', '可导', '收敛', '发散', '级数', '泰勒级数', '傅里叶级数',
        '复数', '虚数', '实部', '虚部', '模', '辐角', '欧拉公式',
        '图论', '树', '图', '最短路径', '最大流', 'NP完全', '计算复杂度',

        // 英文数学词
        'derivative', 'integral', 'matrix', 'vector', 'eigenvalue', 'eigenvector',
        'linear algebra', 'probability', 'statistics', 'distribution', 'variance',
        'fourier', 'laplace', 'convolution', 'transform', 'differential',
        'equation', 'partial', 'limit', 'convergence', 'divergence', 'series',
        'complex', 'imaginary', 'eigenspace', 'determinant', 'rank'
    ]
};

// ==================== Mermaid 图表生成指南 ====================
// 这个指南会自动附加到 system prompt，教导 AI 如何生成图表
const MERMAID_CHART_GUIDE = `

## 图表生成能力

你可以使用 Mermaid 语法生成各类图表，用户界面会自动渲染。使用 \`\`\`mermaid 代码块。

### 支持的图表类型:

1. **流程图**: \`flowchart TD/LR\` - 用于流程、逻辑、决策
2. **时序图**: \`sequenceDiagram\` - 用于交互、API调用流程
3. **类图**: \`classDiagram\` - 用于面向对象设计
4. **状态图**: \`stateDiagram-v2\` - 用于状态转换
5. **ER图**: \`erDiagram\` - 用于数据库设计
6. **甘特图**: \`gantt\` - 用于项目计划
7. **饼图**: \`pie\` - 用于占比展示
8. **思维导图**: \`mindmap\` - 用于知识梳理
9. **用户旅程图**: \`journey\` - 用于用户体验分析
10. **象限图**: \`quadrantChart\` - 用于四象限分析

### 使用原则:
- 当用户询问流程、逻辑、结构、关系时，**主动使用图表**
- 请求规划或分析时，用甘特图或象限图
- 数据占比用饼图
- 系统交互用时序图
- 数据库设计用ER图
- **图表应简洁清晰，配合文字说明**
`;

// 路由配置
const config = {
    thresholds: { t1: 0.40, t2: 0.80 },
    weights: {
        inputLength: 0.15,
        codeDetection: 0.30,
        mathFormula: 0.25,
        reasoning: 0.25,
        languageMix: 0.05
    },
    professional: {
        threshold: 1,      // 触发Plus的阈值
        maxThreshold: 2    // 触发Max的阈值
    }
};

// 代码检测模式 (自动识别编程语言和代码特征)
const codePatterns = {
    languages: /\b(c|cpp|c\+\+|java|javascript|js|python|py|go|golang|rust|ruby|php|c#|csharp|typescript|ts|kotlin|swift|scala|r|matlab|perl|lua|groovy|clojure|haskell|elixir|erlang|julia|racket|scheme)\b/gi,
    codeMarkers: /```|function|def\s|class\s|async\s|await\s|import\s|require\(|from\s|module\.exports|export\s|=>|::|->|#include|\.filter|\.map|\.reduce/gi,
    comments: /\/\/|\/\*|\*\/|#\s|--|`/gi,
    htmlTags: /<(!DOCTYPE|html|head|body|div|span|class|style|script|meta|link|title|form|input|button|p|h[1-6]|ul|li|table|tr|td)\b/gi,
    brackets: /[\{\}\[\]\(\)<>]/g,
    sqlKeywords: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|LIMIT|ON|AS|UNION|VALUES)\b/gi
};

// ========== 关键词检测引擎 ==========
function detectKeywords(message) {
    const result = {
        forceMax: [],
        complexity: { count: 0, keywords: [] },
        professional: { count: 0, keywords: [] },
        math: { count: 0, keywords: [] },
        code: { detected: false, types: [] }
    };

    // 检测强制Max词
    defaultKeywords.forceMax.forEach(keyword => {
        if (message.toLowerCase().includes(keyword.toLowerCase())) {
            result.forceMax.push(keyword);
        }
    });

    // 检测复杂值词 (每个+0.12分)
    defaultKeywords.complexity.forEach(keyword => {
        if (message.toLowerCase().includes(keyword.toLowerCase())) {
            result.complexity.keywords.push(keyword);
            result.complexity.count++;
        }
    });

    // 检测专业词汇
    defaultKeywords.professional.forEach(keyword => {
        if (message.toLowerCase().includes(keyword.toLowerCase())) {
            result.professional.keywords.push(keyword);
            result.professional.count++;
        }
    });

    // 检测数学词汇
    defaultKeywords.math.forEach(keyword => {
        if (message.toLowerCase().includes(keyword.toLowerCase())) {
            result.math.keywords.push(keyword);
            result.math.count++;
        }
    });

    // 自动识别代码特征
    if (codePatterns.languages.test(message)) result.code.types.push('编程语言');
    if (codePatterns.codeMarkers.test(message)) result.code.types.push('代码标记');
    if (codePatterns.comments.test(message)) result.code.types.push('注释');
    if (codePatterns.htmlTags.test(message)) result.code.types.push('HTML');
    if ((message.match(codePatterns.brackets) || []).length > 3) result.code.types.push('括号结构');
    if (codePatterns.sqlKeywords.test(message)) result.code.types.push('SQL');

    result.code.detected = result.code.types.length > 0;
    return result;
}

// ========== 五维度复杂度评估 ==========
function evaluateComplexity(message) {
    const dimensions = {};
    const keywords = detectKeywords(message);

    // 维度1: 输入长度 (0.05-1.0)
    const len = message.length;
    dimensions.inputLength = len <= 15 ? 0.05 :
        len <= 30 ? 0.10 :
            len <= 60 ? 0.20 :
                len <= 150 ? 0.35 :
                    len <= 300 ? 0.50 :
                        Math.min(0.70 + (len - 300) / 1000, 0.9);

    // 维度2: 代码检测 (0-1.0)
    let codeScore = keywords.code.detected ? 0.3 + (keywords.code.types.length * 0.15) : 0;
    dimensions.codeDetection = Math.min(codeScore, 1);

    // 维度3: 数学词汇 (0-1.0)
    dimensions.mathFormula = Math.min(keywords.math.count * 0.15, 1);

    // 维度4: 推理复杂度 (0-1.0)
    const reasoningKeywords = ['为什么', '如何', '解释', '分析', '推理', '证明', 'why', 'how', 'explain'];
    let reasoningScore = reasoningKeywords.reduce((sum, word) =>
        sum + (message.toLowerCase().includes(word) ? 0.20 : 0), 0);
    reasoningScore += Math.min((message.match(/[。，！？,]/g) || []).length * 0.08, 0.15);
    dimensions.reasoning = Math.min(reasoningScore, 1);

    // 维度5: 语言混合度 (0-0.5)
    const mixCount = [/[\u4e00-\u9fa5]/.test(message), /[a-zA-Z]/.test(message),
    /[0-9]/.test(message), /[!@#$%^&*()_+={}\[\]:;"'<>,.?/\\|`~]/.test(message)]
        .filter(Boolean).length;
    dimensions.languageMix = Math.min((mixCount - 1) * 0.15, 0.5);

    // 计算加权基础分数
    let totalScore = Object.entries(config.weights).reduce((sum, [key, weight]) =>
        sum + (dimensions[key] * weight), 0);

    // 特殊加分项
    totalScore += keywords.complexity.count * 0.12; // 复杂值词
    totalScore += keywords.professional.count * 0.15; // 专业词汇

    return {
        score: Math.min(totalScore, 1),
        dimensions,
        keywords
    };
}

// ========== 路由决策引擎 ==========
function routeModel(evaluation) {
    const score = evaluation.score;
    const keywords = evaluation.keywords;
    let model, cost, reason, isForceMax = false;

    // 强制Max判断 (最高优先级)
    if (keywords.forceMax.length > 0) {
        model = 'qwen-max';
        cost = 0.01;
        reason = `强制Max: "${keywords.forceMax[0]}"等关键词`;
        isForceMax = true;
    }
    // 专业词汇阈值判断
    else if (keywords.professional.count >= config.professional.maxThreshold) {
        model = 'qwen-max';
        cost = 0.01;
        reason = `专业词汇(${keywords.professional.count}个) → Max`;
    }
    else if (keywords.professional.count >= config.professional.threshold) {
        model = 'qwen-plus';
        cost = 0.001;
        reason = `专业词汇(${keywords.professional.count}个) → Plus`;
    }
    // 分数阈值判断
    else if (score < config.thresholds.t1) {
        model = 'qwen-flash';
        cost = 0.0001;
        reason = `分数${score.toFixed(2)} < ${config.thresholds.t1} → Flash`;
    }
    else if (score < config.thresholds.t2) {
        model = 'qwen-plus';
        cost = 0.001;
        reason = `分数${score.toFixed(2)}在中等范围 → Plus`;
    }
    else {
        model = 'qwen-max';
        cost = 0.01;
        reason = `分数${score.toFixed(2)} ≥ ${config.thresholds.t2} → Max`;
    }

    return { model, cost, reason, isForceMax };
}

// ========== 核心API接口 ==========
function analyzeMessage(message) {
    // 预设答案快速通道
    const presetAnswers = {
        '你好': '你好！很高兴见到你',
        '谢谢': '不客气！',
        '再见': '再见！'
    };

    if (presetAnswers[message.trim()]) {
        // ✅ 修复：返回完整的分析对象，包含所有必需字段
        return {
            model: 'qwen-flash',
            cost: 0,
            reason: '预设答案(极速响应)',
            isForceMax: false,
            score: 0.05,  // ✅ 添加 score 字段
            dimensions: {  // ✅ 添加完整的维度对象
                inputLength: 0.05,
                codeDetection: 0,
                mathFormula: 0,
                reasoning: 0,
                languageMix: 0
            },
            keywords: {  // ✅ 添加完整的关键词对象
                forceMax: [],
                complexity: { count: 0, keywords: [] },
                professional: { count: 0, keywords: [] },
                math: { count: 0, keywords: [] },
                code: { detected: false, types: [] }
            }
        };
    }

    // 完整路由流程
    const evaluation = evaluateComplexity(message);
    const route = routeModel(evaluation);

    return {
        model: route.model,
        cost: route.cost,
        reason: route.reason,
        isForceMax: route.isForceMax,
        score: evaluation.score,
        dimensions: evaluation.dimensions,
        keywords: evaluation.keywords
    };
}

// ==================== 网页搜索功能 (Tavily API) ====================

// Tavily API 配置
const TAVILY_API_KEY = 'tvly';
const TAVILY_API_URL = 'https://api.tavily.com/search';

/**
 * AI智能判断是否需要联网搜索，并生成搜索查询
 * 这是核心的"工具调用"决策函数 - AI自主决定是否使用搜索工具
 * @param {string} userMessage - 用户的原始问题
 * @param {Array} conversationHistory - 对话历史（可选）
 * @returns {Promise<{needsSearch: boolean, query: string, reason: string}>}
 */
async function aiDecideWebSearch(userMessage, conversationHistory = []) {
    return new Promise((resolve) => {
        try {
            console.log(`🤖 AI正在判断是否需要搜索: "${userMessage.substring(0, 50)}..."`);

            const systemPrompt = `You are a smart assistant that decides whether a web search is needed to answer the user's question.

Your task:
1. Analyze if the question requires REAL-TIME, CURRENT, or FACTUAL information that you might not have
2. If search is needed, generate a concise search query (max 10 words)
3. If search is NOT needed (general knowledge, creative tasks, coding, etc.), skip the search

Respond in JSON format ONLY:
{"needs_search": true/false, "query": "search query if needed", "reason": "brief reason"}

Search IS NEEDED for:
- Current events, news, weather, stock prices, sports scores
- Recent updates (last 1-2 years)
- Facts you're unsure about
- "What's the latest...", "Current status of...", "Today's..."
- Specific real-time data (prices, schedules, availability)

Search is NOT NEEDED for:
- General knowledge ("What is photosynthesis?", "Explain Python decorators")
- Creative writing, brainstorming, stories
- Code generation, debugging help
- Math calculations, logic puzzles
- Definitions of common concepts
- Personal advice, opinions
- Translations, formatting

IMPORTANT: Be conservative - only search when truly necessary. Most questions don't need search.`;

            // 构建请求体 - 使用qwen-flash快速判断
            const requestBody = JSON.stringify({
                model: 'qwen-flash',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ],
                temperature: 0.1,  // 低温度以获得更一致的判断
                max_tokens: 150,
                stream: false
            });

            const urlParts = new URL(API_PROVIDERS.aliyun.baseURL);
            const options = {
                hostname: urlParts.hostname,
                port: 443,
                path: urlParts.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_PROVIDERS.aliyun.apiKey}`,
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.choices && result.choices[0] && result.choices[0].message) {
                            const aiResponse = result.choices[0].message.content.trim();

                            // 尝试解析JSON响应
                            try {
                                // 移除可能的markdown代码块标记
                                const cleanJson = aiResponse.replace(/```json\n?|\n?```/g, '').trim();
                                const decision = JSON.parse(cleanJson);

                                console.log(`✅ AI搜索决策: ${decision.needs_search ? '需要搜索' : '不需要搜索'}`);
                                if (decision.needs_search) {
                                    console.log(`   查询: "${decision.query}"`);
                                }
                                console.log(`   原因: ${decision.reason}`);

                                resolve({
                                    needsSearch: decision.needs_search === true,
                                    query: decision.query || userMessage,
                                    reason: decision.reason || ''
                                });
                            } catch (parseError) {
                                // 如果JSON解析失败，检查是否包含关键词来推断
                                console.warn('⚠️ AI响应JSON解析失败，进行回退判断');
                                const needsSearch = aiResponse.toLowerCase().includes('"needs_search": true') ||
                                    aiResponse.toLowerCase().includes('"needs_search":true');
                                resolve({
                                    needsSearch: needsSearch,
                                    query: userMessage,
                                    reason: 'JSON parse fallback'
                                });
                            }
                        } else {
                            console.warn('⚠️ AI响应格式异常，默认不搜索');
                            resolve({ needsSearch: false, query: userMessage, reason: 'Response format error' });
                        }
                    } catch (e) {
                        console.error('❌ 解析AI响应失败:', e);
                        resolve({ needsSearch: false, query: userMessage, reason: 'Parse error' });
                    }
                });
            });

            req.on('error', (err) => {
                console.error('❌ AI搜索决策失败:', err);
                resolve({ needsSearch: false, query: userMessage, reason: 'Request error' });
            });

            req.setTimeout(5000, () => {
                console.warn('⚠️ AI决策超时，默认不搜索');
                req.destroy();
                resolve({ needsSearch: false, query: userMessage, reason: 'Timeout' });
            });

            req.write(requestBody);
            req.end();
        } catch (error) {
            console.error('❌ AI搜索决策异常:', error);
            resolve({ needsSearch: false, query: userMessage, reason: 'Exception' });
        }
    });
}

/**
 * 使用AI生成智能搜索查询 (保留向后兼容)
 * AI根据用户问题自主决定应该搜索什么内容
 * @deprecated 推荐使用 aiDecideWebSearch 代替
 * @param {string} userMessage - 用户的原始问题
 * @param {Array} conversationHistory - 对话历史（可选）
 * @returns {Promise<string>} 优化后的搜索查询
 */
async function generateAISearchQuery(userMessage, conversationHistory = []) {
    // 直接使用新的决策函数
    const decision = await aiDecideWebSearch(userMessage, conversationHistory);
    return decision.query;
}


/**
 * 执行网页搜索 (使用Tavily API)
 * Tavily是专为AI代理设计的搜索API，提供高质量、实时的搜索结果
 * @param {string} query - 搜索查询
 * @param {number} maxResults - 最大结果数量 (默认5，最大20)
 * @returns {Promise<Array>} 搜索结果数组
 */
async function performWebSearch(query, maxResults = 5) {
    return new Promise((resolve) => {
        try {
            console.log(`🔍 执行Tavily网页搜索: "${query}"`);

            // 构建请求体
            const requestBody = JSON.stringify({
                api_key: TAVILY_API_KEY,
                query: query,
                search_depth: 'basic',        // 'basic' 或 'advanced' (advanced更深入但更慢)
                include_answer: true,          // 包含AI生成的摘要答案
                include_raw_content: false,    // 不需要原始HTML内容
                max_results: Math.min(maxResults, 20),  // 限制最大20条
                include_images: true,          // 开启图片搜索
                include_favicon: true,         // 包含网站图标
                topic: 'general'               // 通用搜索
            });

            // 解析URL
            const urlParts = new URL(TAVILY_API_URL);

            const options = {
                hostname: urlParts.hostname,
                port: 443,
                path: urlParts.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        const searchResults = [];

                        // 检查API错误
                        if (result.error) {
                            console.error('❌ Tavily API错误:', result.error);
                            resolve([]);
                            return;
                        }

                        // 如果有AI生成的答案摘要，添加到结果中
                        if (result.answer) {
                            searchResults.push({
                                title: 'AI 搜索摘要',
                                snippet: result.answer,
                                url: '',
                                source: 'Tavily AI'
                            });
                        }

                        // 提取搜索结果
                        if (result.results && Array.isArray(result.results)) {
                            result.results.forEach(item => {
                                searchResults.push({
                                    title: item.title || '未知标题',
                                    snippet: item.content || '',
                                    url: item.url || '',
                                    favicon: item.favicon || '',  // 包含favicon
                                    source: 'Tavily',
                                    score: item.score  // 相关性评分
                                });
                            });
                        }

                        // 提取搜索图片
                        const images = result.images || [];

                        console.log(`✅ Tavily搜索完成，获得 ${searchResults.length} 条结果, ${images.length} 张图片 (响应时间: ${result.responseTime || 'N/A'}s)`);
                        resolve({ results: searchResults, images: images });
                    } catch (parseError) {
                        console.error('❌ 解析Tavily搜索结果失败:', parseError);
                        console.error('原始响应:', data);
                        resolve([]);
                    }
                });
            });

            req.on('error', (err) => {
                console.error('❌ Tavily网页搜索请求失败:', err);
                resolve({ results: [], images: [] });
            });

            // 设置超时
            req.setTimeout(15000, () => {
                console.error('❌ Tavily搜索请求超时');
                req.destroy();
                resolve({ results: [], images: [] });
            });

            // 发送请求
            req.write(requestBody);
            req.end();
        } catch (error) {
            console.error('❌ Tavily网页搜索异常:', error);
            resolve({ results: [], images: [] });
        }
    });
}

/**
 * 验证单个图片URL是否可访问
 * @param {string} imageUrl - 图片URL
 * @param {number} timeout - 超时时间(ms)
 * @returns {Promise<boolean>} 是否可访问
 */
function validateImageUrl(imageUrl, timeout = 2000) {
    return new Promise((resolve) => {
        if (!imageUrl || typeof imageUrl !== 'string') {
            resolve(false);
            return;
        }

        try {
            const urlObj = new URL(imageUrl);
            const protocol = urlObj.protocol === 'https:' ? https : require('http');

            const req = protocol.request({
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'HEAD',  // 只获取头部，不下载整个图片
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }, (res) => {
                // 2xx 或 3xx 状态码认为有效
                const isValid = res.statusCode >= 200 && res.statusCode < 400;
                resolve(isValid);
            });

            req.on('error', () => {
                resolve(false);  // 请求失败，URL无效
            });

            req.setTimeout(timeout, () => {
                req.destroy();
                resolve(false);  // 超时，认为无效
            });

            req.end();
        } catch (e) {
            resolve(false);  // URL解析失败
        }
    });
}

/**
 * 并行验证多个图片URL，过滤出有效的
 * @param {Array<string>} imageUrls - 图片URL数组
 * @param {number} maxConcurrent - 最大并发数
 * @param {number} totalTimeout - 总超时时间(ms)
 * @returns {Promise<Array<string>>} 有效的图片URL数组
 */
async function filterValidImages(imageUrls, maxConcurrent = 5, totalTimeout = 3000) {
    if (!imageUrls || imageUrls.length === 0) return [];

    console.log(`🖼️ 验证 ${imageUrls.length} 张图片URL...`);

    // 只验证前N张，避免太慢
    const urlsToCheck = imageUrls.slice(0, maxConcurrent);

    // 使用Promise.allSettled并行验证，带总超时
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve([]), totalTimeout);
    });

    const validationPromise = Promise.all(
        urlsToCheck.map(async (url) => {
            const isValid = await validateImageUrl(url);
            return { url, isValid };
        })
    );

    const results = await Promise.race([validationPromise, timeoutPromise]);

    // 如果超时返回空数组
    if (!Array.isArray(results) || results.length === 0) {
        console.log(`⚠️ 图片验证超时，跳过图片`);
        return [];
    }

    const validUrls = results.filter(r => r.isValid).map(r => r.url);
    console.log(`✅ 图片验证完成: ${validUrls.length}/${urlsToCheck.length} 有效`);

    return validUrls;
}

/**
 * 格式化搜索结果为提示词（带角标引用指引）
 * @param {Array} results - 搜索结果
 * @param {string} query - 原始查询
 * @returns {string} 格式化的搜索结果文本
 */
function formatSearchResults(searchData, query) {
    // 兼容旧格式和新格式
    const results = searchData.results || searchData;
    const images = searchData.images || [];

    if (!results || results.length === 0) {
        return '';
    }

    let formatted = `\n\n[网页搜索结果] 关于"${query}"：\n\n`;

    // 跳过AI摘要，只使用实际网页来源
    const webResults = results.filter(r => r.url && r.url.trim() !== '');

    webResults.forEach((result, index) => {
        const citationNum = index + 1;
        formatted += `[${citationNum}] ${result.title}\n`;
        formatted += `   ${result.snippet}\n`;
        formatted += `   来源: ${result.url}\n\n`;
    });

    // 如果有图片，添加图片信息
    if (images.length > 0) {
        formatted += `\n[搜索相关图片] 以下是与查询相关的图片URL，可在回复中使用 ![描述](url) 格式引用：\n`;
        images.slice(0, 5).forEach((imgUrl, index) => {
            formatted += `图片${index + 1}: ${imgUrl}\n`;
        });
        formatted += `\n`;
    }

    // 指示模型使用角标引用
    formatted += `\n重要指示：
1. 请基于以上搜索结果回答用户问题
2. 在回答中使用角标标记信息来源，格式为 [1]、[2] 等
3. 例如："根据最新数据，该产品售价为999元[1]。"
4. 每个角标对应上方的搜索结果编号
5. 如果有相关图片且对回答有帮助，可以使用 ![描述](图片URL) 格式插入图片\n`;

    return formatted;
}

/**
 * 新增：提取用于SSE传输的来源信息
 * @param {Array} results - 搜索结果
 * @returns {Array} 简化的来源数组
 */
function extractSourcesForSSE(results) {
    if (!results || results.length === 0) return [];

    // 跳过AI摘要，只返回实际网页来源
    return results
        .filter(r => r.url && r.url.trim() !== '')
        .map((r, index) => ({
            index: index + 1,
            title: r.title || '未知标题',
            url: r.url,
            favicon: r.favicon || '',
            site_name: r.url ? new URL(r.url).hostname.replace('www.', '') : ''
        }));
}

// ==================== 多模态内容处理 (Qwen3-Omni-Flash) ====================

/**
 * 检测消息中是否包含多模态内容
 * @param {object} message - 消息对象
 * @returns {object} { hasMultimodal: boolean, types: string[] }
 */
function detectMultimodalContent(message) {
    const result = {
        hasMultimodal: false,
        types: [],  // 'image', 'audio', 'video'
        count: 0
    };

    if (!message || !message.content) return result;

    // 🔍 调试：打印消息结构
    console.log(`🔍 检测消息多模态内容:`, {
        role: message.role,
        contentType: typeof message.content,
        hasAttachments: !!message.attachments,
        attachmentsCount: message.attachments?.length || 0
    });

    // 如果content是数组，检查是否包含多模态内容
    if (Array.isArray(message.content)) {
        message.content.forEach(item => {
            if (item.type === 'image_url' || item.type === 'image') {
                result.hasMultimodal = true;
                result.types.push('image');
                result.count++;
            }
            if (item.type === 'input_audio' || item.type === 'audio') {
                result.hasMultimodal = true;
                result.types.push('audio');
                result.count++;
            }
            if (item.type === 'video') {
                result.hasMultimodal = true;
                result.types.push('video');
                result.count++;
            }
        });
    }

    // 🔧 增强防御性检查：处理 attachments 可能是字符串的情况
    let attachments = message.attachments;
    // 如果是字符串（从数据库加载的JSON），尝试解析
    if (typeof attachments === 'string') {
        try {
            attachments = JSON.parse(attachments);
        } catch (e) {
            attachments = [];
        }
    }

    // 检查message对象是否有attachments字段（增强防御性检查）
    if (Array.isArray(attachments) && attachments.length > 0) {
        console.log(`📎 发现附件:`, attachments.map(a => ({ type: a.type, fileName: a.fileName })));
        attachments.forEach(att => {
            if (att.type === 'image') {
                result.hasMultimodal = true;
                result.types.push('image');
                result.count++;
            }
            if (att.type === 'audio') {
                result.hasMultimodal = true;
                result.types.push('audio');
                result.count++;
            }
            if (att.type === 'video') {
                result.hasMultimodal = true;
                result.types.push('video');
                result.count++;
            }
        });
    }

    console.log(`🔍 检测结果:`, result);
    return result;
}

/**
 * 检测消息数组中是否有多模态内容
 * @param {Array} messages - 消息数组
 * @returns {object} 多模态检测结果
 */
function detectMultimodalInMessages(messages) {
    const result = {
        hasMultimodal: false,
        types: [],
        totalCount: 0
    };

    if (!messages || !Array.isArray(messages)) return result;

    for (const msg of messages) {
        const detection = detectMultimodalContent(msg);
        if (detection.hasMultimodal) {
            result.hasMultimodal = true;
            result.types.push(...detection.types);
            result.totalCount += detection.count;
        }
    }

    // 去重
    result.types = [...new Set(result.types)];
    return result;
}

/**
 * 将带附件的消息转换为Qwen3-Omni-Flash格式
 * @param {object} message - 原始消息
 * @returns {object} 转换后的消息
 */
function convertToOmniFormat(message) {
    if (!message || !message.content) return message;

    // 🔧 增强防御性检查：确保 attachments 是数组
    let attachments = message.attachments;
    // 如果是字符串（从数据库加载的JSON），尝试解析
    if (typeof attachments === 'string') {
        try {
            attachments = JSON.parse(attachments);
        } catch (e) {
            attachments = [];
        }
    }
    // 确保是数组
    if (!Array.isArray(attachments)) {
        attachments = [];
    }

    // 如果没有附件，检查content是否已经是数组格式
    if (attachments.length === 0) {
        // 如果content已经是数组格式（包含多模态内容），直接返回
        if (Array.isArray(message.content)) {
            return message;
        }
        // 纯文本消息
        return message;
    }

    // 将消息转换为多模态格式
    const contentArray = [];

    // 处理附件
    attachments.forEach(attachment => {
        if (attachment.type === 'image') {
            // 图片使用image_url格式
            contentArray.push({
                type: 'image_url',
                image_url: {
                    url: attachment.data  // Base64 data URL
                }
            });
        } else if (attachment.type === 'audio') {
            // 音频使用input_audio格式
            contentArray.push({
                type: 'input_audio',
                input_audio: {
                    data: attachment.data  // Base64 data URL
                }
            });
        } else if (attachment.type === 'video') {
            // 视频使用video格式
            contentArray.push({
                type: 'video',
                video: [attachment.data]  // 视频需要数组格式
            });
        }
    });

    // 添加文本内容
    if (typeof message.content === 'string' && message.content.trim()) {
        contentArray.push({
            type: 'text',
            text: message.content
        });
    }

    return {
        role: message.role,
        content: contentArray
    };
}

/**
 * 转换消息数组为多模态格式
 * @param {Array} messages - 原始消息数组
 * @returns {Array} 转换后的消息数组
 */
function convertMessagesToOmniFormat(messages) {
    if (!messages || !Array.isArray(messages)) return messages;

    return messages.map(msg => {
        // 只转换可能包含附件的用户消息
        if (msg.role === 'user') {
            return convertToOmniFormat(msg);
        }
        return msg;
    });
}

/**
 * 获取多模态消息的类型描述
 * @param {Array} types - 多模态类型数组
 * @returns {string} 类型描述
 */
function getMultimodalTypeDescription(types) {
    const map = {
        'image': '图片',
        'audio': '音频',
        'video': '视频'
    };
    return types.map(t => map[t] || t).join('、');
}

// ==================== API配置系统 ====================
const API_PROVIDERS = {
    aliyun: {
        apiKey: 's',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        models: ['qwen-flash', 'qwen-plus', 'qwen-max']
    },
    // Qwen3-Omni-Flash 多模态模型 (支持图片、音频、视频输入和语音输出)
    aliyun_omni: {
        apiKey: 'sk-',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        models: ['qwen3-omni-flash'],
        multimodal: true,  // 标记支持多模态
        audioOutput: true  // 支持语音输出
    },
    deepseek: {
        apiKey: 'sk-',
        baseURL: 'https://api.deepseek.com/v1/chat/completions',
        models: ['deepseek-chat', 'deepseek-reasoner']
    },
    deepseek_v3_2_speciale: {
        apiKey: 'sk-',
        baseURL: 'https://api.deepseek.com/v3.2_speciale_expires_on_20251215/chat/completions',
        models: ['deepseek-reasoner'],  // 特殊端点使用标准模型名
        // 此模型只支持思考模式，支持时间截止至北京时间 2025-12-15 23:59
        expiresAt: '2025-12-15T23:59:00+08:00',
        thinkingOnly: true  // 标记只支持思考模式
    },
    // 硅基流动 SiliconFlow - Kimi K2 模型
    siliconflow: {
        apiKey: 'sk-',
        baseURL: 'https://api.siliconflow.cn/v1/chat/completions',
        models: ['moonshotai/Kimi-K2-Thinking', 'moonshotai/Kimi-K2-Instruct-0905']
    },
    // 硅基流动 SiliconFlow - Qwen3 VL 视觉模型 (图像理解)
    siliconflow_vl: {
        apiKey: 'sk-',
        baseURL: 'https://api.siliconflow.cn/v1/chat/completions',
        models: ['Qwen/Qwen3-VL-235B-A22B-Instruct'],
        multimodal: true,  // 标记支持多模态
        visionModel: true  // 标记这是视觉模型
    },
    // Google Gemini API - Gemini 3 Flash Preview
    google_gemini: {
        apiKey: 'AIzaSyC_',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/models',  // 基础URL，实际使用时会拼接模型名
        models: ['gemini-3-flash-preview'],
        isGemini: true  // 标记这是Gemini API，需要特殊处理
    }
};

// 模型路由映射 (支持auto模式)
const MODEL_ROUTING = {
    // 具体模型配置
    'qwen-flash': { provider: 'aliyun', model: 'qwen-flash' },
    'qwen-plus': { provider: 'aliyun', model: 'qwen-plus' },
    'qwen-max': { provider: 'aliyun', model: 'qwen-max' },
    // Qwen3-Omni-Flash 多模态模型 (图片/音频/视频输入 + 语音输出)
    'qwen3-omni-flash': {
        provider: 'aliyun_omni',
        model: 'qwen3-omni-flash',
        multimodal: true,   // 标记支持多模态
        audioOutput: true,  // 支持语音输出
        streamRequired: true // 必须开启流式
    },
    // Qwen3-VL 视觉语言模型 (硅基流动 - 图像理解)
    'qwen3-vl': {
        provider: 'siliconflow_vl',
        model: 'Qwen/Qwen3-VL-235B-A22B-Instruct',
        multimodal: true,      // 支持多模态
        visionModel: true      // 这是视觉模型
    },
    'deepseek-v3': {
        provider: 'deepseek',
        model: 'deepseek-chat',
        thinkingModel: 'deepseek-reasoner'
    },
    // DeepSeek-V3.2-Speciale (只支持思考模式, 支持至 2025-12-15)
    'deepseek-v3.2-speciale': {
        provider: 'deepseek_v3_2_speciale',
        model: 'deepseek-reasoner',  // 特殊端点使用标准的 reasoner 模型名
        thinkingOnly: true,  // 强制开启思考模式
        maxTokens: 128000,   // 默认和最大上下文长度都是 128K
        expiresAt: '2025-12-15T23:59:00+08:00'
    },
    // Kimi K2 - 月之暗面高性能模型
    'kimi-k2': {
        provider: 'siliconflow',
        model: 'moonshotai/Kimi-K2-Instruct-0905',  // 默认使用 Instruct 模型
        thinkingModel: 'moonshotai/Kimi-K2-Thinking',  // 思考模式使用 Thinking 模型
        supportsWebSearch: true  // 支持Tavily联网搜索
    },
    // Google Gemini 3 Flash - 最智能的速度优化模型
    'gemini-3-flash': {
        provider: 'google_gemini',
        model: 'gemini-3-flash-preview',
        isGemini: true,  // 标记需要特殊处理
        supportsWebSearch: true  // 支持Tavily联网搜索
    },
    // 关键修复：将 'auto' 标记为特殊的虚拟路由，表示需要动态选择
    'auto': {
        provider: 'auto',  // 虚拟提供商，表示需要动态决策
        model: 'auto',     // 虚拟模型，表示需要通过智能路由选择
        isAutoMode: true   // 标记这是auto模式
    }
};


// 创建目录
const dirs = ['uploads', 'avatars', 'database'];
dirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`✅ 已创建目录: ${dir}`);
    }
});

// 数据库初始化
const dbPath = path.join(__dirname, 'ai_data.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('❌ 数据库连接失败:', err);
        process.exit(1);
    } else {
        console.log('✅ 数据库已连接:', dbPath);

        // ==================== SQLite 性能优化 ====================
        db.run("PRAGMA journal_mode=WAL;", (err) => {
            if (err) console.warn('⚠️ WAL模式设置失败:', err.message);
            else console.log('✅ SQLite WAL模式已启用');
        });
        db.run("PRAGMA cache_size=10000;");  // 约40MB缓存
        db.run("PRAGMA busy_timeout=5000;"); // 5秒锁等待超时
        db.run("PRAGMA synchronous=NORMAL;"); // 平衡性能与安全
        db.run("PRAGMA temp_store=MEMORY;");  // 临时表存内存
    }
});

// 创建所有表
db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    username TEXT,
    avatar_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  )`);

    // 会话表
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新对话',
    model TEXT DEFAULT 'deepseek-v3',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_archived INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    // 消息表
    db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    attachments TEXT,
    reasoning_content TEXT,
    model TEXT,
    enable_search INTEGER DEFAULT 0,
    thinking_mode INTEGER DEFAULT 0,
    internet_mode INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`);

    // 用户配置表
    db.run(`CREATE TABLE IF NOT EXISTS user_configs (
    user_id INTEGER PRIMARY KEY,
    theme TEXT DEFAULT 'light',
    default_model TEXT DEFAULT 'deepseek-v3',
    temperature REAL DEFAULT 0.7,
    top_p REAL DEFAULT 0.9,
    max_tokens INTEGER DEFAULT 2000,
    frequency_penalty REAL DEFAULT 0,
    presence_penalty REAL DEFAULT 0,
    system_prompt TEXT,
    thinking_mode INTEGER DEFAULT 0,
    internet_mode INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    // 活跃请求表
    db.run(`CREATE TABLE IF NOT EXISTS active_requests (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_cancelled INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    // 设备指纹表
    db.run(`CREATE TABLE IF NOT EXISTS device_fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    device_name TEXT,
    last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    console.log('✅ 所有数据表就绪');

    // ✅ 数据库迁移：添加缺失的列（如果表已存在且列不存在）
    db.serialize(() => {
        // 添加thinking_mode列（如果不存在）
        db.run(`ALTER TABLE user_configs ADD COLUMN thinking_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加thinking_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log('✅ 已添加thinking_mode列到user_configs表');
            }
        });

        // 添加internet_mode列（如果不存在）
        db.run(`ALTER TABLE user_configs ADD COLUMN internet_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加internet_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log('✅ 已添加internet_mode列到user_configs表');
            }
        });

        // 添加model列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN model TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加model列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log('✅ 已添加model列到messages表');
            }
        });

        // 添加enable_search列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN enable_search INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加enable_search列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log('✅ 已添加enable_search列到messages表');
            }
        });

        // 添加thinking_mode列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN thinking_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加thinking_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log('✅ 已添加thinking_mode列到messages表');
            }
        });

        // 添加internet_mode列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN internet_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加internet_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log('✅ 已添加internet_mode列到messages表');
            }
        });

        // 添加sources列到messages表（如果不存在）- 存储联网搜索来源信息（JSON格式）
        db.run(`ALTER TABLE messages ADD COLUMN sources TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加sources列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log('✅ 已添加sources列到messages表');
            }
        });

        // 创建索引以加速查询
        // 注意：索引方向要与查询一致（ASC）
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at ASC, id ASC)`, (err) => {
            if (err) {
                console.warn(`⚠️ 创建messages索引失败:`, err.message);
            } else {
                console.log('✅ messages表索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, is_archived, updated_at DESC)`, (err) => {
            if (err) {
                console.warn(`⚠️ 创建sessions索引失败:`, err.message);
            } else {
                console.log('✅ sessions表索引就绪');
            }
        });
    });
});

// 中间件配置
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// 静态资源缓存配置（1天 = 86400秒）
const staticCacheOptions = {
    maxAge: '1d',
    etag: true,
    lastModified: true
};

app.use('/uploads', express.static(path.join(__dirname, 'uploads'), staticCacheOptions));
app.use('/avatars', express.static(path.join(__dirname, 'avatars'), staticCacheOptions));
app.use(express.static(path.join(__dirname, 'public'), staticCacheOptions));

// 限流配置
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: '登录尝试过多,请15分钟后再试' }
});

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 100,
    message: { error: '请求过于频繁,请稍后再试' }
});

// JWT验证中间件
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: '未提供认证令牌' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: '令牌无效或已过期' });
        }
        req.user = user;
        next();
    });
};

// 文件上传配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = file.fieldname === 'avatar' ? 'avatars' : 'uploads';
        cb(null, path.join(__dirname, uploadPath));
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|mp4|avi|mov/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype && extname) return cb(null, true);
        cb(new Error('不支持的文件类型'));
    }
});

// ==================== 测试路由 ====================
app.get('/api/test', (req, res) => {
    res.json({
        success: true,
        message: 'RAI API v3.2 正常运行',
        timestamp: new Date().toISOString(),
        providers: Object.keys(API_PROVIDERS)
    });
});

// ==================== 认证路由 ====================
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { email, password, username } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: '邮箱和密码不能为空' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        if (password.length < 6) {
            return res.status(400).json({ success: false, error: '密码至少需要6位' });
        }

        db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
            if (err) {
                return res.status(500).json({ success: false, error: '数据库错误' });
            }

            if (row) {
                return res.status(400).json({ success: false, error: '该邮箱已被注册' });
            }

            try {
                const passwordHash = await bcrypt.hash(password, 10);
                const finalUsername = username || email.split('@')[0];

                db.run(
                    'INSERT INTO users (email, password_hash, username) VALUES (?, ?, ?)',
                    [email, passwordHash, finalUsername],
                    function (err) {
                        if (err) {
                            return res.status(500).json({ success: false, error: '注册失败,请重试' });
                        }

                        const userId = this.lastID;
                        console.log('✅ 用户注册成功, ID:', userId);

                        db.run('INSERT INTO user_configs (user_id) VALUES (?)', [userId]);

                        const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });

                        res.json({
                            success: true,
                            token,
                            user: { id: userId, email, username: finalUsername }
                        });
                    }
                );
            } catch (hashError) {
                return res.status(500).json({ success: false, error: '服务器错误' });
            }
        });
    } catch (error) {
        console.error('❌ 注册错误:', error);
        res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password, fingerprint } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: '邮箱和密码不能为空' });
        }

        db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
            if (err) {
                return res.status(500).json({ success: false, error: '数据库错误' });
            }

            if (!user) {
                return res.status(401).json({ success: false, error: '邮箱或密码错误' });
            }

            try {
                const validPassword = await bcrypt.compare(password, user.password_hash);
                if (!validPassword) {
                    return res.status(401).json({ success: false, error: '邮箱或密码错误' });
                }

                db.run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

                if (fingerprint) {
                    db.run(
                        'INSERT OR REPLACE INTO device_fingerprints (user_id, fingerprint, device_name, last_used) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
                        [user.id, fingerprint, req.headers['user-agent'] || 'Unknown']
                    );
                }

                const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });

                console.log('✅ 登录成功, 用户ID:', user.id);
                res.json({
                    success: true,
                    token,
                    user: {
                        id: user.id,
                        email: user.email,
                        username: user.username,
                        avatar_url: user.avatar_url
                    }
                });
            } catch (compareError) {
                return res.status(500).json({ success: false, error: '服务器错误' });
            }
        });
    } catch (error) {
        console.error('❌ 登录错误:', error);
        res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.get('/api/auth/verify', authenticateToken, (req, res) => {
    db.get(
        'SELECT id, email, username, avatar_url FROM users WHERE id = ?',
        [req.user.userId],
        (err, user) => {
            if (err || !user) {
                return res.status(404).json({ success: false, error: '用户不存在' });
            }
            res.json({ success: true, user });
        }
    );
});

// ==================== 用户管理路由 ====================
app.get('/api/user/profile', authenticateToken, (req, res) => {
    db.get(
        `SELECT u.id, u.email, u.username, u.avatar_url, u.created_at, u.last_login,
      COALESCE(c.theme, 'dark') as theme,
      COALESCE(c.default_model, 'deepseek-v3') as default_model,
      COALESCE(c.temperature, 0.7) as temperature,
      COALESCE(c.top_p, 0.9) as top_p,
      COALESCE(c.max_tokens, 2000) as max_tokens,
      COALESCE(c.frequency_penalty, 0) as frequency_penalty,
      COALESCE(c.presence_penalty, 0) as presence_penalty,
      COALESCE(c.system_prompt, '') as system_prompt,
      COALESCE(c.thinking_mode, 0) as thinking_mode,
      COALESCE(c.internet_mode, 0) as internet_mode
    FROM users u
    LEFT JOIN user_configs c ON u.id = c.user_id
    WHERE u.id = ?`,
        [req.user.userId],
        (err, user) => {
            if (err) {
                console.error('❌ 获取用户信息失败:', err);
                // 返回默认配置,而不是抛出500错误
                return res.json({
                    id: req.user.userId,
                    email: 'user@example.com',
                    username: 'User',
                    avatar_url: null,
                    created_at: new Date().toISOString(),
                    last_login: new Date().toISOString(),
                    theme: 'dark',
                    default_model: 'deepseek-v3',
                    temperature: 0.7,
                    top_p: 0.9,
                    max_tokens: 2000,
                    frequency_penalty: 0,
                    presence_penalty: 0,
                    system_prompt: '',
                    thinking_mode: 0,
                    internet_mode: 0
                });
            }

            if (!user) {
                console.error('❌ 用户不存在, ID:', req.user.userId);
                // 同样返回默认配置
                return res.json({
                    id: req.user.userId,
                    email: 'user@example.com',
                    username: 'User',
                    avatar_url: null,
                    created_at: new Date().toISOString(),
                    last_login: new Date().toISOString(),
                    theme: 'dark',
                    default_model: 'deepseek-v3',
                    temperature: 0.7,
                    top_p: 0.9,
                    max_tokens: 2000,
                    frequency_penalty: 0,
                    presence_penalty: 0,
                    system_prompt: '',
                    thinking_mode: 0,
                    internet_mode: 0
                });
            }

            // ✅ 修复：确保所有字段都有值，特别是system_prompt
            const profile = {
                id: user.id,
                email: user.email || '',
                username: user.username || user.email.split('@')[0],
                avatar_url: user.avatar_url || null,
                created_at: user.created_at,
                last_login: user.last_login,
                theme: user.theme || 'dark',
                default_model: user.default_model || 'deepseek-v3',
                temperature: parseFloat(user.temperature) || 0.7,
                top_p: parseFloat(user.top_p) || 0.9,
                max_tokens: parseInt(user.max_tokens, 10) || 2000,
                frequency_penalty: parseFloat(user.frequency_penalty) || 0,
                presence_penalty: parseFloat(user.presence_penalty) || 0,
                system_prompt: user.system_prompt || '',  // ✅ 关键修复：确保始终返回字符串
                thinking_mode: user.thinking_mode || 0,
                internet_mode: user.internet_mode || 0
            };

            console.log('✅ 返回用户信息, ID:', user.id, 'Username:', profile.username, 'SystemPromptLen:', profile.system_prompt.length);
            res.json(profile);
        }
    );
});

app.put('/api/user/config', authenticateToken, (req, res) => {
    const {
        theme, default_model, temperature, top_p, max_tokens,
        frequency_penalty, presence_penalty, system_prompt,
        thinking_mode, internet_mode
    } = req.body;

    // ✅ 防御性检查：确保system_prompt被正确处理
    const finalSystemPrompt = system_prompt === null ? '' : (system_prompt || '');

    db.run(
        `INSERT INTO user_configs (
      user_id, theme, default_model, temperature, top_p, max_tokens, 
      frequency_penalty, presence_penalty, system_prompt, thinking_mode, internet_mode
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      theme = excluded.theme,
      default_model = excluded.default_model,
      temperature = excluded.temperature,
      top_p = excluded.top_p,
      max_tokens = excluded.max_tokens,
      frequency_penalty = excluded.frequency_penalty,
      presence_penalty = excluded.presence_penalty,
      system_prompt = excluded.system_prompt,
      thinking_mode = excluded.thinking_mode,
      internet_mode = excluded.internet_mode`,
        [
            req.user.userId, theme || 'dark', default_model || 'deepseek-v3',
            temperature || 0.7, top_p || 0.9, max_tokens || 2000,
            frequency_penalty || 0, presence_penalty || 0, finalSystemPrompt,
            thinking_mode ? 1 : 0, internet_mode ? 1 : 0
        ],
        (err) => {
            if (err) {
                console.error('❌ 保存配置失败:', err);
                return res.status(500).json({ error: '保存失败', details: err.message });
            }
            console.log(`✅ 用户配置已保存: userId=${req.user.userId}, systemPromptLength=${finalSystemPrompt.length}`);
            res.json({ success: true });
        }
    );
});

app.post('/api/user/avatar', authenticateToken, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件上传' });

    const avatarUrl = `/avatars/${req.file.filename}`;
    db.run('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.user.userId], (err) => {
        if (err) {
            console.error('❌ 更新头像失败:', err);
            return res.status(500).json({ error: '更新失败' });
        }
        res.json({ success: true, avatar_url: avatarUrl });
    });
});

// ==================== 会话管理路由 ====================
app.get('/api/sessions', authenticateToken, (req, res) => {
    // 分页参数：offset（偏移量）和 limit（每页数量）
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 20;

    // 优化：简化查询，移除慢速子查询（message_count, recent_attachments）
    // 只保留 last_message 用于侧边栏预览
    db.all(
        `SELECT s.id, s.title, s.model, s.updated_at, s.created_at,
      (SELECT content FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message
    FROM sessions s
    WHERE s.user_id = ? AND s.is_archived = 0
    ORDER BY s.updated_at DESC
    LIMIT ? OFFSET ?`,
        [req.user.userId, limit, offset],
        (err, sessions) => {
            if (err) {
                console.error('❌ 获取会话列表失败:', err);
                return res.status(500).json({ error: '数据库错误' });
            }
            // 返回带有分页信息的响应
            res.json({
                sessions: sessions,
                hasMore: sessions.length === limit,
                offset: offset,
                limit: limit
            });
        }
    );
});

app.post('/api/sessions', authenticateToken, (req, res) => {
    const sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const { title, model } = req.body;

    db.run(
        'INSERT INTO sessions (id, user_id, title, model) VALUES (?, ?, ?, ?)',
        [sessionId, req.user.userId, title || '新对话', model || 'deepseek-v3'],
        (err) => {
            if (err) {
                console.error('❌ 创建会话失败:', err);
                return res.status(500).json({ error: '创建失败' });
            }
            console.log('✅ 创建会话成功:', sessionId);
            res.json({ success: true, sessionId });
        }
    );
});

app.put('/api/sessions/:id', authenticateToken, (req, res) => {
    const { title, model, is_archived } = req.body;

    db.run(
        'UPDATE sessions SET title = COALESCE(?, title), model = COALESCE(?, model), is_archived = COALESCE(?, is_archived), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [title, model, is_archived, req.params.id, req.user.userId],
        (err) => {
            if (err) {
                console.error('❌ 更新会话失败:', err);
                return res.status(500).json({ error: '更新失败' });
            }
            res.json({ success: true });
        }
    );
});

app.delete('/api/sessions/:id', authenticateToken, (req, res) => {
    db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId], (err) => {
        if (err) {
            console.error('❌ 删除会话失败:', err);
            return res.status(500).json({ error: '删除失败' });
        }
        console.log('✅ 删除会话成功:', req.params.id);
        res.json({ success: true });
    });
});

app.get('/api/sessions/:id/messages', authenticateToken, (req, res) => {
    db.get('SELECT user_id FROM sessions WHERE id = ?', [req.params.id], (err, session) => {
        if (err) {
            console.error('❌ 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 优化：只查询必要字段，避免加载大的attachments Base64数据
        // 附件数据可以按需加载（懒加载）
        db.all(
            `SELECT id, session_id, role, content, reasoning_content, model, 
                    enable_search, thinking_mode, internet_mode, sources, created_at,
                    CASE WHEN attachments IS NOT NULL AND attachments != '' AND attachments != '[]' 
                         THEN 1 ELSE 0 END as has_attachments
             FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
            [req.params.id],
            (err, messages) => {
                if (err) {
                    console.error('❌ 获取消息失败:', err);
                    return res.status(500).json({ error: '数据库错误' });
                }
                res.json(messages);
            }
        );
    });
});

// ==================== 消息管理API ====================

// 懒加载消息附件（避免初始加载时传输大量Base64数据）
app.get('/api/messages/:messageId/attachments', authenticateToken, (req, res) => {
    const { messageId } = req.params;

    db.get(
        `SELECT m.attachments, s.user_id 
         FROM messages m 
         JOIN sessions s ON m.session_id = s.id 
         WHERE m.id = ?`,
        [messageId],
        (err, row) => {
            if (err) {
                console.error('❌ 获取附件失败:', err);
                return res.status(500).json({ error: '数据库错误' });
            }

            if (!row) {
                return res.status(404).json({ error: '消息不存在' });
            }

            if (row.user_id !== req.user.userId) {
                return res.status(403).json({ error: '无权访问' });
            }

            // 解析并返回附件
            let attachments = [];
            if (row.attachments) {
                try {
                    attachments = JSON.parse(row.attachments);
                } catch (e) {
                    attachments = [];
                }
            }

            res.json({ attachments });
        }
    );
});

// 删除单条消息
app.delete('/api/sessions/:sessionId/messages/:messageId', authenticateToken, (req, res) => {
    const { sessionId, messageId } = req.params;

    // 验证会话归属
    db.get('SELECT user_id FROM sessions WHERE id = ?', [sessionId], (err, session) => {
        if (err) {
            console.error('❌ 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 删除指定消息
        db.run('DELETE FROM messages WHERE id = ? AND session_id = ?', [messageId, sessionId], function (err) {
            if (err) {
                console.error('❌ 删除消息失败:', err);
                return res.status(500).json({ error: '删除失败' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: '消息不存在' });
            }

            console.log(`✅ 已删除消息 ID: ${messageId}`);
            res.json({ success: true, deletedId: messageId });
        });
    });
});

// 编辑消息内容
app.put('/api/sessions/:sessionId/messages/:messageId', authenticateToken, (req, res) => {
    const { sessionId, messageId } = req.params;
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: '内容不能为空' });
    }

    // 验证会话归属
    db.get('SELECT user_id FROM sessions WHERE id = ?', [sessionId], (err, session) => {
        if (err) {
            console.error('❌ 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 更新消息内容
        db.run('UPDATE messages SET content = ? WHERE id = ? AND session_id = ?',
            [content, messageId, sessionId],
            function (err) {
                if (err) {
                    console.error('❌ 更新消息失败:', err);
                    return res.status(500).json({ error: '更新失败' });
                }

                if (this.changes === 0) {
                    return res.status(404).json({ error: '消息不存在' });
                }

                console.log(`✅ 已更新消息 ID: ${messageId}`);
                res.json({ success: true, updatedId: messageId, content });
            }
        );
    });
});

// 获取指定消息之前的所有消息（用于重新生成）
app.get('/api/sessions/:sessionId/messages-before/:messageId', authenticateToken, (req, res) => {
    const { sessionId, messageId } = req.params;

    // 验证会话归属
    db.get('SELECT user_id FROM sessions WHERE id = ?', [sessionId], (err, session) => {
        if (err) {
            console.error('❌ 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 获取目标消息的创建时间
        db.get('SELECT created_at FROM messages WHERE id = ? AND session_id = ?',
            [messageId, sessionId],
            (err, targetMsg) => {
                if (err || !targetMsg) {
                    return res.status(404).json({ error: '消息不存在' });
                }

                // 获取该消息之前的所有消息
                db.all(
                    'SELECT * FROM messages WHERE session_id = ? AND created_at < ? ORDER BY created_at ASC, id ASC',
                    [sessionId, targetMsg.created_at],
                    (err, messages) => {
                        if (err) {
                            console.error('❌ 获取消息失败:', err);
                            return res.status(500).json({ error: '数据库错误' });
                        }
                        res.json(messages);
                    }
                );
            }
        );
    });
});

// ==================== AI聊天路由 ====================

app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件上传' });

    console.log('✅ 文件上传成功:', req.file.filename);
    res.json({
        success: true,
        file: {
            filename: req.file.filename,
            originalName: req.file.originalname,
            filePath: `/uploads/${req.file.filename}`,
            fileType: req.file.mimetype,
            size: req.file.size
        }
    });
});

// ✅ 修复：流式聊天路由
app.post('/api/chat/stream', authenticateToken, apiLimiter, async (req, res) => {
    console.log('💬 收到聊天请求');

    let requestId = null;  // ✅ 关键修复：在函数开始声明requestId

    try {
        const {
            sessionId,
            messages,
            model = 'auto',  // 默认为auto模式
            thinkingMode = false,
            thinkingBudget = 1024,
            internetMode = false,
            temperature = 0.7,
            top_p = 0.9,
            max_tokens = 2000,
            frequency_penalty = 0,
            presence_penalty = 0,
            systemPrompt
        } = req.body;

        console.log(`🔍 接收参数: model=${model}, thinking=${thinkingMode}, internet=${internetMode}`);

        // 🔍 调试：打印收到的消息结构
        console.log(`📨 收到 ${messages.length} 条消息:`);
        messages.forEach((m, i) => {
            const hasValidAttachments = m.attachments && Array.isArray(m.attachments);
            console.log(`   [${i}] role=${m.role}, hasAttachments=${hasValidAttachments}, attachmentsCount=${hasValidAttachments ? m.attachments.length : 0}`);
            if (hasValidAttachments && m.attachments.length > 0) {
                console.log(`       附件详情:`, m.attachments.map(a => ({ type: a.type, fileName: a.fileName, hasData: !!a.data })));
            }
        });

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: '消息不能为空' });
        }

        // 验证会话所有权
        if (sessionId) {
            const session = await new Promise((resolve, reject) => {
                db.get('SELECT user_id FROM sessions WHERE id = ?', [sessionId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            if (!session || session.user_id !== req.user.userId) {
                return res.status(403).json({ error: '无权访问此会话' });
            }
        }

        // 生成请求ID
        requestId = `req_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

        // ✅ 添加活跃请求记录（用于取消机制）
        db.run('INSERT INTO active_requests (id, user_id, session_id) VALUES (?, ?, ?)',
            [requestId, req.user.userId, sessionId || 'anonymous']);

        // ✅ 防御性检查：验证 messages 存在且非空
        if (!Array.isArray(messages) || messages.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '消息不能为空' }));
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        // ✅✅ 关键修复：在所有 res.write() 调用之前，先设置 SSE 响应头
        // 这确保后续所有的 res.write() 都能正常工作
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Request-ID', requestId);
        // 注意：X-Model-Used 在后面确定最终模型后再设置
        res.flushHeaders();  // 立即发送头部，开始SSE流

        // 🚀 预设答案快速通道：在所有路由逻辑之前检查，确保所有模式都能生效
        const lastUserMsg = messages[messages.length - 1];
        const userContent = typeof lastUserMsg.content === 'string'
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg.content);

        console.log(`📝 分析消息: "${userContent.substring(0, 100)}${userContent.length > 100 ? '...' : ''}"`);

        const presetAnswers = {
            '你好': '你好！很高兴见到你 😊',
            '谢谢': '不客气！很高兴能帮到你 👍',
            '再见': '再见！期待下次与你交谈 👋',
            'hello': 'Hello! Nice to meet you!',
            'hi': 'Hi there! How can I help you?',
            'thank you': 'You\'re welcome!',
            'thanks': 'You\'re welcome!',
            'bye': 'Goodbye! See you next time!'
        };

        const trimmedContent = userContent.trim().toLowerCase();
        const presetAnswer = presetAnswers[trimmedContent] || presetAnswers[userContent.trim()]; // 兼容原始大小写

        if (presetAnswer) {
            console.log(`\n⚡ 命中预设答案: "${userContent.trim()}" -> 直接返回，无需调用AI`);

            // SSE头已在前面设置，直接发送预设答案
            res.write(`data: ${JSON.stringify({ type: 'content', content: presetAnswer })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);

            // 保存到数据库
            if (sessionId) {
                console.log('\n💾 保存预设答案到数据库');

                // 保存用户消息
                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
                        [sessionId, 'user', userContent],
                        (err) => {
                            if (err) console.error('❌ 保存用户消息失败:', err);
                            else console.log(`✅ 用户消息已保存 (${userContent.length}字符)`);
                            resolve();
                        }
                    );
                });

                // 保存预设答案
                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content, model, enable_search, thinking_mode, internet_mode) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [sessionId, 'assistant', presetAnswer, 'preset', 0, 0, 0],
                        (err) => {
                            if (err) console.error('❌ 保存预设答案失败:', err);
                            else console.log(`✅ 预设答案已保存 (${presetAnswer.length}字符)`);
                            resolve();
                        }
                    );
                });

                // 更新会话时间戳
                await new Promise((resolve) => {
                    db.run(
                        'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [sessionId],
                        (err) => {
                            if (err) console.error('❌ 更新会话时间戳失败:', err);
                            else console.log('✅ 会话时间戳已更新');
                            resolve();
                        }
                    );
                });
            }

            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            console.log('\n✅ 预设答案处理完成（0成本）\n');
            return;
        }

        // 智能路由：根据最后一条用户消息自动选择模型
        let finalModel = model;  // 最终选中的模型类型（qwen-flash/plus/max或deepseek-v3）
        let routing = null;      // 对应的路由配置
        let autoRoutingReason = '';

        console.log(`\n🎯 模型选择开始: 用户指定 = ${model}`);

        // 关键修复：只检测【当前用户消息】的多模态内容，而不是整个对话历史！
        // 这样只有当前消息带图片才会用 VL 模型，之前对话中的图片不会影响后续消息
        const lastUserMessage = messages.filter(m => m.role === 'user').pop();
        const currentMessageMultimodal = lastUserMessage ? detectMultimodalContent(lastUserMessage) : { hasMultimodal: false, types: [], count: 0 };
        let isMultimodalRequest = currentMessageMultimodal.hasMultimodal;

        if (isMultimodalRequest) {
            console.log(`\n🎨 🎨 🎨 当前消息检测到多模态内容!!!`);
            console.log(`   类型: ${getMultimodalTypeDescription(currentMessageMultimodal.types)}`);
            console.log(`   数量: ${currentMessageMultimodal.count}`);

            // 强制切换到视觉语言模型（使用硅基流动 Qwen3-VL-235B-A22B-Thinking）
            finalModel = 'qwen3-vl';
            autoRoutingReason = `当前消息包含${getMultimodalTypeDescription(currentMessageMultimodal.types)}，自动切换到Qwen3-VL视觉语言模型`;
            console.log(`   🔄 强制使用模型: qwen3-vl (Qwen/Qwen3-VL-235B-A22B-Thinking)`);
        } else if (model === 'auto') {
            // 只有在没有多模态内容时才使用auto路由
            // 调用智能路由引擎
            const analysis = analyzeMessage(userContent);

            // ✅ 防御性检查：确保 analysis 和 score 有效
            if (!analysis || typeof analysis.score !== 'number') {
                console.error('⚠️ 分析结果异常:', analysis);
                finalModel = 'qwen-flash';
                autoRoutingReason = 'Analysis failed, fallback to Flash';
            } else {
                finalModel = analysis.model;
                autoRoutingReason = analysis.reason;

                console.log(`\n🤖 Auto路由分析结果:`);
                console.log(`   ✅ 分数: ${analysis.score.toFixed(3)}`);
                console.log(`   ✅ 选择模型: ${finalModel}`);
                console.log(`   ✅ 选择原因: ${autoRoutingReason}`);
                console.log(`   ✅ 维度详情:`, JSON.stringify(analysis.dimensions, null, 2));
            }
        }


        // ✅ 修复：Auto模式下联网不强制使用max，而是根据智能路由结果选择合适的阿里云模型
        // 所有阿里云模型（flash/plus/max）都支持联网功能
        if (model === 'auto' && internetMode) {
            // 如果智能路由选择了DeepSeek，需要切换到阿里云模型（DeepSeek不支持联网）
            if (finalModel === 'deepseek-v3') {
                // 根据分析分数选择合适的阿里云模型，而不是一律使用max
                const analysis = analyzeMessage(messages[messages.length - 1].content);
                if (analysis.score < config.thresholds.t1) {
                    finalModel = 'qwen-flash';
                    autoRoutingReason = '联网模式，切换到Qwen-Flash（仍保持智能路由）';
                } else if (analysis.score < config.thresholds.t2) {
                    finalModel = 'qwen-plus';
                    autoRoutingReason = '联网模式，切换到Qwen-Plus（仍保持智能路由）';
                } else {
                    finalModel = 'qwen-max';
                    autoRoutingReason = '联网模式，切换到Qwen-Max（复杂查询）';
                }
                console.log(`🌐 Auto+联网模式: DeepSeek不支持联网，智能切换到${finalModel}`);
            } else {
                // 如果已经是阿里云模型，保持智能路由的选择
                console.log(`🌐 Auto+联网模式: 使用智能路由选择的${finalModel}（支持联网）`);
            }
        }

        // ✅ 关键修复：添加白名单验证（防御性编程）
        const VALID_MODELS = ['qwen-flash', 'qwen-plus', 'qwen-max', 'deepseek-v3', 'deepseek-v3.2-speciale', 'qwen3-omni-flash', 'qwen3-vl', 'kimi-k2', 'gemini-3-flash'];

        // 注意：多模态检测已在上面执行，这里不再重复

        if (!VALID_MODELS.includes(finalModel)) {
            console.warn(`⚠️ 无效模型 ${finalModel},回退到 qwen-flash`);
            finalModel = 'qwen-flash';
            autoRoutingReason = '无效模型,自动回退到Flash';
        }

        // 关键修复：现在finalModel已经是具体的模型名，再获取routing
        routing = MODEL_ROUTING[finalModel];
        if (!routing) {
            console.error(`❌ 模型路由配置未找到: ${finalModel}`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: `配置错误: ${finalModel}` })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        console.log(`\n🔌 路由配置: provider=${routing.provider}, model=${routing.model}`);

        let actualModel = routing.model;
        // DeepSeek思考模式自动切换
        if (finalModel === 'deepseek-v3' && thinkingMode) {
            actualModel = routing.thinkingModel || 'deepseek-reasoner';
            console.log(`🧠 DeepSeek思考模式: 切换到 ${actualModel}`);
        }

        // DeepSeek-V3.2-Speciale 强制使用思考模式
        if (finalModel === 'deepseek-v3.2-speciale') {
            actualModel = 'deepseek-reasoner';  // 特殊端点使用 reasoner
            console.log(`🧠 DeepSeek-V3.2-Speciale: 强制使用思考模式 (${actualModel})`);
        }

        // Kimi K2 思考模式自动切换
        if (finalModel === 'kimi-k2' && thinkingMode && routing.thinkingModel) {
            actualModel = routing.thinkingModel;
            console.log(`🧠 Kimi K2 思考模式: 切换到 ${actualModel}`);
        }

        // ✅ 关键修复：验证提供商配置存在（防止404错误）
        const providerConfig = API_PROVIDERS[routing.provider];
        if (!providerConfig) {
            console.error(`❌ API提供商配置未找到: ${routing.provider}`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: `不支持的提供商: ${routing.provider}` })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        console.log(`✅ API端点: ${providerConfig.baseURL}`);

        // 关键修复：通过SSE发送实际使用的模型信息（因为响应头已经发送，无法再设置X-Model-Used）
        res.write(`data: ${JSON.stringify({
            type: 'model_info',
            model: finalModel,
            actualModel: actualModel,
            reason: autoRoutingReason,
            provider: routing.provider
        })}\n\n`);
        console.log(`📤 已发送模型信息: finalModel=${finalModel}, actualModel=${actualModel}`);

        // 🔍 网页搜索功能（针对非阿里云模型）
        // ✨ 改进：AI智能判断是否需要搜索，而不是无条件搜索
        let searchContext = '';
        let searchSources = [];  // 存储搜索来源用于SSE传输

        if (internetMode && routing.provider !== 'aliyun' && finalModel !== 'deepseek-v3.2-speciale') {
            console.log(`🌐 联网模式已开启，AI正在判断是否需要搜索...`);

            // 提取用户最后一条消息
            const lastMessage = messages[messages.length - 1];
            const userMessage = typeof lastMessage.content === 'string'
                ? lastMessage.content
                : JSON.stringify(lastMessage.content);

            // 📡 发送搜索状态：正在分析问题
            res.write(`data: ${JSON.stringify({
                type: 'search_status',
                status: 'analyzing',
                message: 'AI正在分析是否需要搜索...'
            })}\n\n`);

            // 🤖 使用AI智能判断是否需要搜索
            const searchDecision = await aiDecideWebSearch(userMessage, messages);

            if (searchDecision.needsSearch) {
                console.log(`🔍 AI决定执行搜索: "${searchDecision.query}"`);

                // 📡 发送搜索状态：显示AI生成的搜索关键词
                res.write(`data: ${JSON.stringify({
                    type: 'search_status',
                    status: 'searching',
                    query: searchDecision.query,
                    message: `正在搜索: "${searchDecision.query}"`
                })}\n\n`);

                // 执行搜索
                const searchData = await performWebSearch(searchDecision.query, 5);
                const searchResults = searchData.results || searchData;  // 兼容新旧格式
                let searchImages = searchData.images || [];

                // 验证图片URL，过滤掉无效的
                if (searchImages.length > 0) {
                    searchImages = await filterValidImages(searchImages, 5, 3000);
                }

                if (searchResults && searchResults.length > 0) {
                    // 使用验证后的图片
                    searchContext = formatSearchResults({ results: searchResults, images: searchImages }, searchDecision.query);
                    searchSources = extractSourcesForSSE(searchResults);  // 提取来源信息
                    console.log(`✅ 搜索结果已添加到上下文 (${searchResults.length} 条结果, ${searchSources.length} 个来源, ${searchImages.length} 张有效图片)`);

                    // 📡 发送搜索状态：搜索完成
                    res.write(`data: ${JSON.stringify({
                        type: 'search_status',
                        status: 'complete',
                        query: searchDecision.query,
                        resultCount: searchResults.length,
                        message: `找到 ${searchResults.length} 条结果`
                    })}\n\n`);
                } else {
                    console.log(`⚠️ 未获取到搜索结果`);
                    // 📡 发送搜索状态：未找到结果
                    res.write(`data: ${JSON.stringify({
                        type: 'search_status',
                        status: 'no_results',
                        query: searchDecision.query,
                        message: '未找到相关结果'
                    })}\n\n`);
                }
            } else {
                // AI判断不需要搜索
                console.log(`ℹ️ AI判断不需要搜索: ${searchDecision.reason}`);
                // 📡 发送搜索状态：跳过搜索
                res.write(`data: ${JSON.stringify({
                    type: 'search_status',
                    status: 'skipped',
                    reason: searchDecision.reason,
                    message: 'AI判断此问题不需要搜索'
                })}\n\n`);
            }

        } else if (internetMode && finalModel === 'deepseek-v3.2-speciale') {
            console.log(`ℹ️ DeepSeek-V3.2-Speciale 是高级思考模型，无需额外联网搜索`);
        }

        // 构建消息数组
        let finalMessages = [...messages];

        // 如果是多模态请求，转换消息格式为Omni格式
        if (isMultimodalRequest) {
            finalMessages = convertMessagesToOmniFormat(finalMessages);
            console.log(`🎨 消息已转换为多模态格式`);
        }

        // 添加系统提示词（包含搜索结果 + 图表生成指南）
        let systemContent = searchContext
            ? `${systemPrompt || ''}\n${searchContext}`.trim()
            : systemPrompt || '';

        // 🎨 附加 Mermaid 图表生成指南
        if (systemContent) {
            systemContent = `${systemContent}\n${MERMAID_CHART_GUIDE}`;
        } else {
            systemContent = MERMAID_CHART_GUIDE.trim();
        }

        if (systemContent) {
            finalMessages.unshift({
                role: 'system',
                content: systemContent
            });
        }

        // 构建API请求体
        const requestBody = {
            model: actualModel,
            messages: finalMessages,
            temperature: parseFloat(temperature) || 0.7,
            top_p: parseFloat(top_p) || 0.9,
            max_tokens: parseInt(max_tokens, 10) || 2000,
            stream: true  // Qwen3-Omni-Flash要求必须开启流式
        };

        // Qwen3-Omni-Flash 多模态特殊配置
        if (finalModel === 'qwen3-omni-flash') {
            // 设置输出模态：文本+音频 或 仅文本
            // 目前仅输出文本，后续可根据需求添加音频输出
            requestBody.modalities = ["text"];

            // 如果需要音频输出，启用以下配置：
            // requestBody.modalities = ["text", "audio"];
            // requestBody.audio = { voice: "Cherry", format: "wav" };

            console.log(`🎨 Qwen3-Omni-Flash 多模态配置已应用`);
        }

        // Qwen3-VL 视觉语言模型配置 (SiliconFlow)
        if (finalModel === 'qwen3-vl') {
            // Qwen3-VL-235B-A22B-Thinking 内置思考能力，需要更大的token限制
            requestBody.max_tokens = Math.max(parseInt(max_tokens, 10) || 4096, 4096);
            console.log(`🔍 Qwen3-VL 视觉语言模型配置已应用 (max_tokens: ${requestBody.max_tokens})`);
        }

        // ✅ 防御性检查：确保数值解析成功
        if (isNaN(requestBody.temperature) || requestBody.temperature < 0 || requestBody.temperature > 2) {
            console.warn(`⚠️ 无效的temperature值: ${temperature}，使用默认值0.7`);
            requestBody.temperature = 0.7;
        }
        if (isNaN(requestBody.top_p) || requestBody.top_p < 0 || requestBody.top_p > 1) {
            console.warn(`⚠️ 无效的top_p值: ${top_p}，使用默认值0.9`);
            requestBody.top_p = 0.9;
        }
        if (isNaN(requestBody.max_tokens) || requestBody.max_tokens < 100 || requestBody.max_tokens > 8000) {
            console.warn(`⚠️ 无效的max_tokens值: ${max_tokens}，使用默认值2000`);
            requestBody.max_tokens = 2000;
        }

        // 阿里云思考模式（仅Qwen）
        if (thinkingMode && routing.provider === 'aliyun') {
            requestBody.enable_thinking = true;

            // ✅ 思考预算直接放顶层，不用extra_body
            const budget = parseInt(thinkingBudget);
            const validBudget = Math.max(256, Math.min(isNaN(budget) ? 1024 : budget, 32768));

            requestBody.thinking_budget = validBudget;  // ✅ 改为直接放顶层

            console.log(`🧠 Qwen思考模式已开启, 预算: ${validBudget} tokens`);
        }

        // 阿里云互联网模式
        if (internetMode && routing.provider === 'aliyun') {
            // ✅ 修复：确保enable_search是布尔值，不能是其他类型
            requestBody.enable_search = true;
            // 新增：启用搜索来源和角标功能
            requestBody.search_options = {
                enable_source: true,        // 返回搜索来源列表
                enable_citation: true,      // 在回答中插入角标
                citation_format: "[<number>]"  // 角标格式: [1], [2]
            };
            console.log(`🌐 阿里云互联网搜索已开启（启Enable角标引用）`);
        }

        // DeepSeek参数
        if (routing.provider === 'deepseek') {
            // ✅ 确保frequency_penalty和presence_penalty是有效的数值
            const freqPenalty = parseFloat(frequency_penalty);
            const presPenalty = parseFloat(presence_penalty);

            requestBody.frequency_penalty = (isNaN(freqPenalty) ? 0 : Math.max(0, Math.min(freqPenalty, 2)));
            requestBody.presence_penalty = (isNaN(presPenalty) ? 0 : Math.max(0, Math.min(presPenalty, 2)));

            console.log(`📊 DeepSeek参数: frequency_penalty=${requestBody.frequency_penalty}, presence_penalty=${requestBody.presence_penalty}`);
        }

        console.log(`\n📤 最终请求体 (前1000字符):`);
        console.log(JSON.stringify(requestBody, null, 2).substring(0, 1000));

        // ✅ 加强过滤：将autoRoutingReason转换为可以放入HTTP头的格式（移除所有中文和特殊字符）
        const reasonForHeader = (autoRoutingReason || '')
            .replace(/[\u4e00-\u9fa5\u3000-\u303F\uFF00-\uFFEF]/g, '')  // 移除所有中日韩字符
            .replace(/[^\x20-\x7E]/g, '')      // 只保留可打印ASCII字符
            .replace(/[\r\n\t]/g, ' ')         // 替换换行符为空格
            .trim()
            .substring(0, 100);

        // ✅ 验证请求体的关键字段
        if (!requestBody.model) {
            console.error('❌ 请求体缺少model字段');
            res.write(`data: ${JSON.stringify({ type: 'error', error: '模型配置错误' })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
            console.error('❌ 请求体消息为空');
            res.write(`data: ${JSON.stringify({ type: 'error', error: '消息不能为空' })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        // 注意：SSE头已在搜索前提前设置（约第1770行）
        // 新增：如果有搜索来源，立即发送给前端
        if (searchSources && searchSources.length > 0) {
            res.write(`data: ${JSON.stringify({ type: 'sources', sources: searchSources })}\n\n`);
            console.log(`📤 已发送 ${searchSources.length} 个搜索来源到前端`);
        }

        console.log(`\n📤 发送请求到 ${routing.provider} - ${actualModel}\n`);

        // ✅ 关键修复：调用API
        console.log(`🌐 正在调用: ${providerConfig.baseURL}`);
        console.log(`   API密钥: ${providerConfig.apiKey.substring(0, 10)}...`);

        // ✅ 修复：添加超时控制 (120秒) - 增加超时时间以应对网络不稳定
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);

        // ✅ 关键修复：将变量声明移到try块外部，避免作用域问题
        let fullContent = '';
        let reasoningContent = '';

        // 🔥 Gemini API 特殊处理
        const isGeminiAPI = providerConfig.isGemini || routing.isGemini;

        try {
            let apiUrl, fetchHeaders, fetchBody;

            if (isGeminiAPI) {
                // ============ Gemini API 格式 ============
                // Gemini endpoint: {baseURL}/{modelName}:streamGenerateContent?alt=sse
                apiUrl = `${providerConfig.baseURL}/${actualModel}:streamGenerateContent?alt=sse`;

                // Gemini 使用 x-goog-api-key 头
                fetchHeaders = {
                    'x-goog-api-key': providerConfig.apiKey,
                    'Content-Type': 'application/json'
                };

                // 将 OpenAI 格式的 messages 转换为 Gemini 格式的 contents
                const geminiContents = [];
                for (const msg of finalMessages) {
                    if (msg.role === 'system') {
                        // Gemini 将 system 作为 systemInstruction 处理
                        continue; // 我们在下面单独处理
                    }
                    const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
                    geminiContents.push({
                        role: geminiRole,
                        parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
                    });
                }

                // 提取 system prompt
                const systemMsg = finalMessages.find(m => m.role === 'system');

                fetchBody = {
                    contents: geminiContents,
                    generationConfig: {
                        temperature: parseFloat(temperature) || 0.7,
                        topP: parseFloat(top_p) || 0.9,
                        maxOutputTokens: parseInt(max_tokens, 10) || 2000
                    }
                };

                // 如果有 system prompt，添加为 systemInstruction
                if (systemMsg) {
                    fetchBody.systemInstruction = {
                        parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content) }]
                    };
                }

                console.log(`🔷 Gemini API 请求: ${apiUrl}`);
                console.log(`   模型: ${actualModel}`);
                console.log(`   消息数: ${geminiContents.length}`);
            } else {
                // ============ OpenAI 兼容 API 格式 ============
                apiUrl = providerConfig.baseURL;
                fetchHeaders = {
                    'Authorization': `Bearer ${providerConfig.apiKey}`,
                    'Content-Type': 'application/json'
                };
                fetchBody = requestBody;
            }

            console.log(`🌐 正在调用: ${apiUrl}`);
            console.log(`   API密钥: ${providerConfig.apiKey.substring(0, 10)}...`);

            const apiResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: fetchHeaders,
                body: JSON.stringify(fetchBody),
                signal: controller.signal
            });

            clearTimeout(timeoutId); // 清除超时定时器

            console.log(`📥 API响应状态: ${apiResponse.status} ${apiResponse.statusText}`);

            // ✅ 修复错误处理
            if (!apiResponse.ok) {
                const errorText = await apiResponse.text();
                console.error(`❌ API返回错误:`);
                console.error(`   状态码: ${apiResponse.status}`);
                console.error(`   响应体: ${errorText.substring(0, 500)}`);

                const errorMsg = `AI服务调用失败: ${apiResponse.status} ${errorText.substring(0, 100)}`;
                res.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`);
                res.end();

                db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                return;
            }

            console.log('✅ API连接成功，开始接收流式响应\n');

            const reader = apiResponse.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            // 轮询检查取消状态
            const checkCancellation = async () => {
                return new Promise((resolve) => {
                    db.get('SELECT is_cancelled FROM active_requests WHERE id = ?', [requestId], (err, row) => {
                        resolve(row?.is_cancelled === 1);
                    });
                });
            };

            while (true) {
                const isCancelled = await checkCancellation();
                if (isCancelled) {
                    console.log(`🛑 请求被用户取消: ${requestId}`);
                    res.write(`data: ${JSON.stringify({ type: 'cancelled' })}\n\n`);
                    res.end();
                    reader.cancel();
                    break;
                }

                const { done, value } = await reader.read();
                if (done) {
                    console.log('✅ 流式响应结束');
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;

                    if (trimmed.startsWith('data: ')) {
                        const data = trimmed.slice(6);
                        try {
                            const parsed = JSON.parse(data);

                            if (isGeminiAPI) {
                                // ============ Gemini 响应格式解析 ============
                                // Gemini 响应结构: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
                                const candidate = parsed.candidates?.[0];
                                if (candidate) {
                                    const parts = candidate.content?.parts || [];
                                    for (const part of parts) {
                                        if (part.text) {
                                            fullContent += part.text;
                                            res.write(`data: ${JSON.stringify({ type: 'content', content: part.text })}\n\n`);
                                        }
                                    }
                                }
                            } else {
                                // ============ OpenAI 兼容格式解析 ============
                                const choice = parsed.choices?.[0];

                                // ✅ 修复：处理推理内容（支持 DeepSeek 和 Qwen）
                                const delta = choice?.delta || {};
                                const reasoning = delta.reasoning_content || delta.reasoning;
                                const content = delta.content;

                                if (reasoning) {
                                    reasoningContent += reasoning;
                                    res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoning })}\n\n`);
                                }

                                if (content) {
                                    fullContent += content;
                                    res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
                                }

                                // 处理阿里云原生联网的 search_info
                                const searchInfo = parsed.search_info || parsed.output?.search_info;
                                if (searchInfo && searchInfo.search_results && searchInfo.search_results.length > 0) {
                                    const qwenSources = searchInfo.search_results.map(r => ({
                                        index: r.index || 0,
                                        title: r.title || '未知来源',
                                        url: r.url || '',
                                        favicon: r.icon || '',
                                        site_name: r.site_name || ''
                                    }));
                                    // 更新 searchSources 变量，确保保存消息时包含来源信息
                                    if (!searchSources || searchSources.length === 0) {
                                        searchSources = qwenSources;
                                    }
                                    res.write(`data: ${JSON.stringify({ type: 'sources', sources: qwenSources })}\n\n`);
                                    console.log(`📤 阿里云search_info: 已发送 ${qwenSources.length} 个来源`);
                                }
                            }
                        } catch (e) {
                            console.error('⚠️ 解析响应行错误:', e.message);
                        }
                    }
                }
            }
        } catch (fetchError) {

            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                console.error('❌ API请求超时 (120s)');
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI服务请求超时(120秒)，请检查网络连接或稍后重试' })}\n\n`);
            } else if (fetchError.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
                console.error('❌ 连接超时:', fetchError.message);
                console.error('   可能原因: 1) 网络不稳定 2) API服务响应慢 3) 防火墙阻止');
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI服务连接超时，请检查：1) 网络连接是否正常 2) 服务器防火墙设置 3) API服务状态，然后重试' })}\n\n`);
            } else {
                console.error('❌ Fetch错误:', fetchError);
                res.write(`data: ${JSON.stringify({ type: 'error', error: `网络请求失败: ${fetchError.message}` })}\n\n`);
            }
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        // ✅ 完整的消息保存逻辑
        if (sessionId) {
            console.log('\n💾 开始保存消息到数据库');

            // 1. 保存用户消息（包含附件信息）
            const lastUserMsg = messages[messages.length - 1];
            if (lastUserMsg && lastUserMsg.role === 'user') {
                const userContent = typeof lastUserMsg.content === 'string'
                    ? lastUserMsg.content
                    : JSON.stringify(lastUserMsg.content);

                // 提取附件信息用于保存（仅保存预览所需的精简数据）
                let attachmentsJson = null;
                // 防御性检查：确保 attachments 是数组
                if (lastUserMsg.attachments && Array.isArray(lastUserMsg.attachments) && lastUserMsg.attachments.length > 0) {
                    const previewAttachments = lastUserMsg.attachments.map(att => {
                        // 对于图片，保存缩小的预览版本（减少数据库存储）
                        // 对于视频/音频，只保存类型和文件名
                        if (att.type === 'image' && att.data) {
                            return {
                                type: 'image',
                                fileName: att.fileName,
                                // 保存原始data用于预览（Base64）
                                data: att.data
                            };
                        } else {
                            return {
                                type: att.type,
                                fileName: att.fileName
                            };
                        }
                    });
                    attachmentsJson = JSON.stringify(previewAttachments);
                    console.log(`📎 保存 ${previewAttachments.length} 个附件信息`);
                }

                // 使用毫秒级时间戳确保用户消息严格早于AI消息
                const userMsgTimestamp = new Date().toISOString();
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)',
                        [sessionId, 'user', userContent, attachmentsJson, userMsgTimestamp],
                        (err) => {
                            if (err) {
                                console.error('❌ 保存用户消息失败:', err);
                                reject(err);
                            } else {
                                console.log(`✅ 用户消息已保存 (${userContent.length}字符${attachmentsJson ? ', 含附件' : ''})`);
                                resolve();
                            }
                        }
                    );
                });
            }

            // 2. 提取并处理标题 (如果存在)
            let contentToSave = fullContent || (reasoningContent ? '(纯思考内容)' : '(生成中断)');
            let extractedTitle = null;

            const titleMatch = contentToSave.match(/\[TITLE\](.*?)\[\/TITLE\]/);
            if (titleMatch && titleMatch[1]) {
                extractedTitle = titleMatch[1].trim();
                // 从内容中移除标题标记
                contentToSave = contentToSave.replace(/\[TITLE\].*?\[\/TITLE\]/g, '').trim();
                console.log(`📋 提取到标题: "${extractedTitle}"`);
            }

            // 3. 保存AI回复 (已移除标题标记, 包含联网来源信息)
            // 序列化 sources 为 JSON 字符串
            const sourcesJson = (searchSources && searchSources.length > 0) ? JSON.stringify(searchSources) : null;

            // 使用毫秒级时间戳，确保AI消息严格晚于用户消息
            const aiMsgTimestamp = new Date().toISOString();
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO messages (session_id, role, content, reasoning_content, model, enable_search, thinking_mode, internet_mode, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [sessionId, 'assistant', contentToSave, reasoningContent || null, finalModel, internetMode ? 1 : 0, thinkingMode ? 1 : 0, internetMode ? 1 : 0, sourcesJson, aiMsgTimestamp],
                    (err) => {
                        if (err) {
                            console.error('❌ 保存AI消息失败:', err);
                            reject(err);
                        } else {
                            console.log(`✅ AI回复已保存:`);
                            console.log(`   - 内容: ${contentToSave.length}字符`);
                            console.log(`   - 思考: ${reasoningContent.length}字符`);
                            console.log(`   - 模型: ${finalModel}`);
                            console.log(`   - 联网: ${internetMode ? '是' : '否'}`);
                            console.log(`   - 思考模式: ${thinkingMode ? '是' : '否'}`);
                            console.log(`   - 来源数: ${searchSources?.length || 0}`);
                            resolve();
                        }
                    }
                );
            });


            // 4. 如果提取到标题,更新会话标题（每次对话都更新）
            if (extractedTitle) {
                // 每次对话都更新标题，不再限制只在新对话时更新
                db.run(
                    'UPDATE sessions SET title = ? WHERE id = ?',
                    [extractedTitle, sessionId],
                    (updateErr) => {
                        if (!updateErr) {
                            console.log(`✅ 会话标题已更新: "${extractedTitle}"`);
                            // 通知前端标题更新
                            res.write(`data: ${JSON.stringify({
                                type: 'title',
                                title: extractedTitle
                            })}\n\n`);
                        } else {
                            console.error('❌ 更新会话标题失败:', updateErr);
                        }
                    }
                );
            }

            // 5. 更新会话时间戳
            await new Promise((resolve) => {
                db.run(
                    'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [sessionId],
                    (err) => {
                        if (err) console.error('❌ 更新会话时间戳失败:', err);
                        else console.log('✅ 会话时间戳已更新');
                        resolve();
                    }
                );
            });
        }

        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

        console.log('\n✅ 聊天处理完成\n');

    } catch (error) {
        console.error('❌ 聊天错误:', error);
        try {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        } catch (writeError) {
            console.error('❌ 写入响应错误:', writeError);
        }
    } finally {
        // ✅ 关键修复：添加null检查
        if (requestId) {
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
        }
    }
});

app.post('/api/chat/stop', authenticateToken, (req, res) => {
    const { requestId } = req.body;

    if (!requestId) {
        return res.status(400).json({ error: '缺少requestId' });
    }

    db.get(
        'SELECT user_id FROM active_requests WHERE id = ?',
        [requestId],
        (err, row) => {
            if (err || !row) {
                return res.status(404).json({ error: '请求不存在' });
            }

            if (row.user_id !== req.user.userId) {
                return res.status(403).json({ error: '无权停止此请求' });
            }

            db.run(
                'UPDATE active_requests SET is_cancelled = 1 WHERE id = ?',
                [requestId],
                (err) => {
                    if (err) {
                        return res.status(500).json({ error: '停止失败' });
                    }
                    console.log('🛑 停止请求:', requestId);
                    res.json({ success: true, message: '已发送停止信号' });
                }
            );
        }
    );
});

// ==================== 404处理 ====================
app.use((req, res) => {
    res.status(404).json({
        error: '路由未找到',
        path: req.path,
        method: req.method
    });
});

// ==================== 错误处理 ====================
app.use((err, req, res, next) => {
    console.error('❌ 服务器错误:', err);
    res.status(500).json({
        error: '服务器内部错误',
        message: err.message
    });
});

// ==================== 启动服务器 ====================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║            🚀 RAI v0.8 已启动                            ║
║                                                          ║
║  📡 服务地址: http://0.0.0.0:${PORT}                     ║
║  📊 数据库: ${dbPath}                                    ║
║  🔐 JWT认证: ✅                                         ║
║  🤖 AI提供商: 阿里云百炼 + DeepSeek                       ║
║  🧠 思考模式: ✅ (DeepSeek-Reasoner)                     ║
║  🛑 停止输出: ✅                                         ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);

    db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (!err) {
            console.log(`✅ 数据库正常, 当前用户数: ${row.count}`);
        }
    });
});

// 优雅退出
process.on('SIGTERM', () => {
    console.log('⚠️ 收到SIGTERM信号,准备关闭服务器');
    db.close((err) => {
        if (err) console.error('❌ 关闭数据库失败:', err);
        else console.log('✅ 数据库已关闭');
        process.exit(0);
    });
});
