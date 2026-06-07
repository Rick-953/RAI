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
const packageInfo = require('./package.json');
const { runAgentPipeline, normalizeUsage } = require('./agent/engine');

const app = express();
// 安全默认：本地直连时不信任代理头。反向代理部署时可通过 TRUST_PROXY 显式开启。
const trustProxyEnv = process.env.TRUST_PROXY;
let trustProxySetting = false;
if (trustProxyEnv) {
    if (trustProxyEnv === 'true') {
        trustProxySetting = 1;
    } else if (trustProxyEnv === 'false') {
        trustProxySetting = false;
    } else if (/^\d+$/.test(trustProxyEnv)) {
        trustProxySetting = parseInt(trustProxyEnv, 10);
    } else {
        trustProxySetting = trustProxyEnv;
    }
}
app.set('trust proxy', trustProxySetting);
const PORT = process.env.PORT || 3009;
const PACKAGE_VERSION = packageInfo.version || '0.0.0';

function requireSecretEnv(name, minLength = 32) {
    const value = String(process.env[name] || '').trim();
    if (value.length < minLength) {
        console.error(` 启动失败: ${name} 未配置或长度不足 ${minLength} 字符`);
        process.exit(1);
    }
    return value;
}

const JWT_SECRET = requireSecretEnv('JWT_SECRET', 32);
const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions').trim();
const NEWAPI_BASE_URL = (process.env.NEWAPI_BASE_URL || 'https://api.18363221.xyz/v1/chat/completions').trim();
const GOOGLE_GEMINI_BASE_URL = (process.env.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models').trim();
const ZTX6D_APP_ID = String(process.env.ZTX6D_APP_ID || '').trim();
const ZTX6D_APP_KEY = String(process.env.ZTX6D_APP_KEY || '').trim();
const ZTX6D_API_URL = (process.env.ZTX6D_API_URL || 'https://passport.ztx6d.com/open.php').trim();
const ZTX6D_LOGIN_URL = (process.env.ZTX6D_LOGIN_URL || 'https://passport.ztx6d.com/').trim();
const ZTX6D_CALLBACK_URL = (process.env.ZTX6D_CALLBACK_URL || '').trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim();
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD_HASH = requireSecretEnv('ADMIN_PASSWORD_HASH', 50);
const ADMIN_JWT_SECRET = requireSecretEnv('ADMIN_JWT_SECRET', 32);
const ZTX6D_RT_TTL_MS = 10 * 60 * 1000;
const ENV_API_KEYS = {
    TAVILY_API_KEY: (process.env.TAVILY_API_KEY || '').trim(),
    ALIYUN_API_KEY: (process.env.ALIYUN_API_KEY || '').trim(),
    DEEPSEEK_API_KEY: (process.env.DEEPSEEK_API_KEY || '').trim(),
    SILICONFLOW_API_KEY: (process.env.SILICONFLOW_API_KEY || '').trim(),
    GOOGLE_GEMINI_API_KEY: (process.env.GOOGLE_GEMINI_API_KEY || '').trim(),
    POE_API_KEY: (process.env.POE_API_KEY || '').trim(),
    OPENROUTER_API_KEY: (process.env.OPENROUTER_API_KEY || '').trim(),
    NEWAPI_API_KEY: (process.env.NEWAPI_API_KEY || '').trim()
};

const POE_STATIC_MODEL_MAP = {
    'poe-claude': 'claude-haiku-4.5',
    'poe-gpt': 'gpt-5-nano',
    'poe-grok': 'grok-4.1-fast-reasoning',
    'poe-gemini': 'gemini-3-flash'
};

const POE_ALIAS_HINTS = {
    'poe-claude': ['claude', 'haiku'],
    'poe-gpt': ['gpt', 'nano'],
    'poe-grok': ['grok'],
    'poe-gemini': ['gemini', 'flash']
};

const POE_MODEL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const POE_DAILY_LIMIT_FREE = 3;
const GPT55_DAILY_LIMIT_FREE = 10;

const ADMIN_MODEL_CATALOG = [
    { id: 'deepseek-v3', name: 'DeepSeek V4', group: '全部模型' },
    { id: 'kimi-k2.5', name: 'Kimi / 专家模式', group: '快捷与全部模型' },
    { id: 'qwen2.5-7b', name: 'Qwen / 极速模式', group: '快捷与全部模型' },
    { id: 'chatgpt-gpt-oss-120b', name: 'ChatGPT', group: '全部模型' },
    { id: 'gpt-5.5', name: 'GPT-5.5', group: '全部模型' },
    { id: 'grok-4.2', name: 'Grok 4.2', group: '全部模型' },
    { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', group: 'MAX 模型' },
    { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku', group: 'MAX 模型' },
    { id: 'gemma', name: 'Gemma', group: '全部模型' }
];

const PUBLIC_MODEL_IDS = ADMIN_MODEL_CATALOG.map((model) => model.id);
const AUTO_MODEL_PREFERENCE = ['kimi-k2.5', 'deepseek-v3', 'chatgpt-gpt-oss-120b', 'gemma', 'qwen2.5-7b'];
const AUTO_MULTIMODAL_MODEL_PREFERENCE = ['kimi-k2.5', 'gemma'];
const MODEL_DISABLED_CACHE_TTL_MS = 10 * 1000;
let modelAvailabilityCache = { loadedAt: 0, disabled: new Set() };

const poeModelRegistry = {
    hasSuccessfulSync: false,
    syncing: false,
    lastSyncAt: null,
    lastError: '',
    modelIds: [],
    aliasResolvedModels: { ...POE_STATIC_MODEL_MAP },
    aliasAvailability: Object.keys(POE_STATIC_MODEL_MAP).reduce((acc, alias) => {
        acc[alias] = true;
        return acc;
    }, {})
};

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

    // 强制高质量场景优先 Kimi；余额不足时会自动回退到免费 Qwen2.5-7B
    if (keywords.forceMax.length > 0) {
        model = 'kimi-k2.5';
        cost = 0.01;
        reason = `强制高质量: "${keywords.forceMax[0]}"等关键词`;
        isForceMax = true;
    }
    // 专业词汇高密度：优先 Kimi
    else if (keywords.professional.count >= config.professional.maxThreshold) {
        model = 'kimi-k2.5';
        cost = 0.01;
        reason = `专业词汇(${keywords.professional.count}个) → Kimi K2.5`;
    }
    // 中高复杂：DeepSeek
    else if (keywords.professional.count >= config.professional.threshold) {
        model = 'deepseek-v3';
        cost = 0.001;
        reason = `专业词汇(${keywords.professional.count}个) → DeepSeek`;
    }
    else if (score < config.thresholds.t1) {
        model = 'qwen2.5-7b';
        cost = 0;
        reason = `分数${score.toFixed(2)} < ${config.thresholds.t1} → Qwen2.5-7B(免费)`;
    }
    else if (score < config.thresholds.t2) {
        model = 'deepseek-v3';
        cost = 0.001;
        reason = `分数${score.toFixed(2)}在中等范围 → DeepSeek`;
    }
    else {
        model = 'kimi-k2.5';
        cost = 0.01;
        reason = `分数${score.toFixed(2)} ≥ ${config.thresholds.t2} → Kimi K2.5`;
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
        //  修复：返回完整的分析对象，包含所有必需字段
        return {
            model: 'qwen2.5-7b',
            cost: 0,
            reason: '预设答案(极速响应)',
            isForceMax: false,
            score: 0.05,  //  添加 score 字段
            dimensions: {  //  添加完整的维度对象
                inputLength: 0.05,
                codeDetection: 0,
                mathFormula: 0,
                reasoning: 0,
                languageMix: 0
            },
            keywords: {  //  添加完整的关键词对象
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
const TAVILY_API_KEY = ENV_API_KEYS.TAVILY_API_KEY;
const TAVILY_API_URL = 'https://api.tavily.com/search';

// ==================== 原生工具调用 (Function Calling) ====================

const FINANCE_ALLOWED_RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const FINANCE_ALLOWED_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1d', '1wk', '1mo', '3mo']);
const FINANCE_DEFAULT_RANGE = '1mo';
const FINANCE_DEFAULT_INTERVAL = '1d';
const FINANCE_CACHE_TTL_MS = 60 * 1000;
const FINANCE_QUOTE_CACHE = new Map();
const YAHOO_FINANCE_CHART_BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_FINANCE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0 Safari/537.36';

function createFinanceError(statusCode, code, message, details = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    error.details = details;
    return error;
}

function normalizeFinanceSymbolInput(symbol = '') {
    return String(symbol || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/，/g, ',');
}

function resolveFinanceSymbol(symbol = '') {
    const normalized = normalizeFinanceSymbolInput(symbol);
    if (!normalized) {
        throw createFinanceError(400, 'invalid_symbol', 'symbol 不能为空');
    }

    if (/^[A-Z0-9^._=-]{1,20}\.(SS|SZ|HK)$/.test(normalized) || /^[A-Z][A-Z0-9^._=-]{0,19}$/.test(normalized)) {
        return normalized;
    }

    if (/^6\d{5}$/.test(normalized)) return `${normalized}.SS`;
    if (/^(0\d{5}|3\d{5})$/.test(normalized)) return `${normalized}.SZ`;
    if (/^\d{4,5}$/.test(normalized)) return `${normalized}.HK`;

    throw createFinanceError(400, 'invalid_symbol', `无法识别的证券代码: ${symbol}`);
}

function normalizeFinanceRange(range = FINANCE_DEFAULT_RANGE) {
    const normalized = String(range || FINANCE_DEFAULT_RANGE).trim().toLowerCase();
    if (!FINANCE_ALLOWED_RANGES.has(normalized)) {
        throw createFinanceError(400, 'invalid_range', `不支持的 range: ${range}`, {
            allowed: Array.from(FINANCE_ALLOWED_RANGES)
        });
    }
    return normalized;
}

function normalizeFinanceInterval(interval = FINANCE_DEFAULT_INTERVAL) {
    const normalized = String(interval || FINANCE_DEFAULT_INTERVAL).trim().toLowerCase();
    if (!FINANCE_ALLOWED_INTERVALS.has(normalized)) {
        throw createFinanceError(400, 'invalid_interval', `不支持的 interval: ${interval}`, {
            allowed: Array.from(FINANCE_ALLOWED_INTERVALS)
        });
    }
    return normalized;
}

function toFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function toIsoTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '';
    return new Date(numeric * 1000).toISOString();
}

function buildFinanceSeries(result = {}) {
    const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
    const quoteSeries = result.indicators?.quote?.[0] || {};
    const opens = Array.isArray(quoteSeries.open) ? quoteSeries.open : [];
    const highs = Array.isArray(quoteSeries.high) ? quoteSeries.high : [];
    const lows = Array.isArray(quoteSeries.low) ? quoteSeries.low : [];
    const closes = Array.isArray(quoteSeries.close) ? quoteSeries.close : [];
    const volumes = Array.isArray(quoteSeries.volume) ? quoteSeries.volume : [];

    return timestamps.map((timestamp, index) => ({
        timestamp: toIsoTimestamp(timestamp),
        open: toFiniteNumber(opens[index]),
        high: toFiniteNumber(highs[index]),
        low: toFiniteNumber(lows[index]),
        close: toFiniteNumber(closes[index]),
        volume: toFiniteNumber(volumes[index])
    })).filter((item) => item.timestamp && (
        item.open !== null ||
        item.high !== null ||
        item.low !== null ||
        item.close !== null ||
        item.volume !== null
    ));
}

function buildFinanceWarnings(resolvedSymbol = '') {
    const warnings = ['Yahoo Finance 免费数据可能存在延迟，不应视为逐笔实时成交数据。'];
    if (/\.(SS|SZ|HK)$/.test(resolvedSymbol)) {
        warnings.push('A股 / 港股通常为延迟行情，适合参考，不适合作为高频交易依据。');
    }
    return warnings;
}

function normalizeFinanceQuoteResponse(chartResult, {
    symbol,
    resolvedSymbol,
    range,
    interval,
    cacheHit = false
}) {
    const meta = chartResult?.meta || {};
    const series = buildFinanceSeries(chartResult);
    const lastSeriesPoint = [...series].reverse().find((point) => point.close !== null) || null;

    const price = toFiniteNumber(
        meta.regularMarketPrice ??
        meta.postMarketPrice ??
        meta.preMarketPrice ??
        lastSeriesPoint?.close
    );
    const previousClose = toFiniteNumber(
        meta.chartPreviousClose ??
        meta.previousClose ??
        meta.regularMarketPreviousClose
    );
    const change = (price !== null && previousClose !== null) ? Number((price - previousClose).toFixed(6)) : null;
    const changePercent = (change !== null && previousClose) ? Number(((change / previousClose) * 100).toFixed(4)) : null;

    return {
        symbol: normalizeFinanceSymbolInput(symbol),
        resolvedSymbol,
        range,
        interval,
        source: 'Yahoo Finance via RAI proxy',
        delayed: true,
        meta: {
            shortName: meta.shortName || '',
            longName: meta.longName || '',
            currency: meta.currency || '',
            exchangeName: meta.exchangeName || '',
            instrumentType: meta.instrumentType || '',
            marketState: meta.marketState || '',
            timezone: meta.exchangeTimezoneName || meta.timezone || ''
        },
        quote: {
            price,
            previousClose,
            change,
            changePercent,
            timestamp: toIsoTimestamp(meta.regularMarketTime || chartResult?.timestamp?.slice(-1)?.[0] || 0)
        },
        series,
        cache: {
            hit: cacheHit,
            ttlSeconds: Math.floor(FINANCE_CACHE_TTL_MS / 1000)
        },
        warnings: buildFinanceWarnings(resolvedSymbol)
    };
}

async function fetchYahooFinanceQuote({ symbol, range = FINANCE_DEFAULT_RANGE, interval = FINANCE_DEFAULT_INTERVAL }) {
    const resolvedSymbol = resolveFinanceSymbol(symbol);
    const normalizedRange = normalizeFinanceRange(range);
    const normalizedInterval = normalizeFinanceInterval(interval);
    const cacheKey = `${resolvedSymbol}|${normalizedRange}|${normalizedInterval}`;
    const now = Date.now();

    const cached = FINANCE_QUOTE_CACHE.get(cacheKey);
    if (cached && (now - cached.ts) < FINANCE_CACHE_TTL_MS) {
        return {
            ...cached.data,
            cache: {
                ...cached.data.cache,
                hit: true
            }
        };
    }

    const requestUrl = `${YAHOO_FINANCE_CHART_BASE_URL}/${encodeURIComponent(resolvedSymbol)}?${new URLSearchParams({
        range: normalizedRange,
        interval: normalizedInterval
    }).toString()}`;

    let response;
    try {
        response = await fetch(requestUrl, {
            headers: {
                'User-Agent': YAHOO_FINANCE_USER_AGENT,
                Accept: 'application/json'
            }
        });
    } catch (error) {
        throw createFinanceError(502, 'upstream_request_failed', `Yahoo Finance 请求失败: ${error.message}`);
    }

    if (!response.ok) {
        const errText = await response.text();
        throw createFinanceError(502, 'upstream_bad_status', `Yahoo Finance 返回异常状态: ${response.status}`, {
            status: response.status,
            preview: errText.slice(0, 200)
        });
    }

    let payload;
    try {
        payload = await response.json();
    } catch (error) {
        throw createFinanceError(502, 'upstream_invalid_json', `Yahoo Finance 返回数据无法解析: ${error.message}`);
    }

    const chartResult = payload?.chart?.result?.[0];
    const chartError = payload?.chart?.error;
    if (!chartResult || chartError) {
        throw createFinanceError(502, 'upstream_no_chart', chartError?.description || 'Yahoo Finance 未返回有效行情数据', {
            symbol: resolvedSymbol
        });
    }

    const normalized = normalizeFinanceQuoteResponse(chartResult, {
        symbol,
        resolvedSymbol,
        range: normalizedRange,
        interval: normalizedInterval,
        cacheHit: false
    });

    FINANCE_QUOTE_CACHE.set(cacheKey, {
        ts: now,
        data: normalized
    });

    return normalized;
}

// 工具定义 - Kimi K2.5 原生支持
const TOOL_DEFINITIONS = [{
    type: "function",
    function: {
        name: "web_search",
        description: "搜索互联网获取实时信息。当问题涉及新闻、天气、股价、最新事件、实时数据、需要验证的事实时调用此工具。",
        parameters: {
            type: "object",
            required: ["query"],
            properties: {
                query: {
                    type: "string",
                    description: "优化后的搜索关键词，英文优先以获得更好结果"
                }
            }
        }
    }
}, {
    type: "function",
    function: {
        name: "finance_quote",
        description: "获取股票、ETF、指数的行情和历史K线数据。适用于证券代码、价格、涨跌幅、历史走势、K线区间等问题。A股/港股通常为延迟数据。",
        parameters: {
            type: "object",
            required: ["symbol"],
            properties: {
                symbol: {
                    type: "string",
                    description: "证券代码，例如 600519.SS、0700.HK、AAPL、SPY"
                },
                range: {
                    type: "string",
                    description: "历史区间，可选 1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max"
                },
                interval: {
                    type: "string",
                    description: "K线周期，可选 1m,2m,5m,15m,30m,60m,90m,1d,1wk,1mo,3mo"
                }
            }
        }
    }
}];

// 工具执行器映射
const TOOL_EXECUTORS = {
    web_search: async (args, searchDepth = 'basic') => {
        const maxResults = 5;
        console.log(` 执行工具 web_search: query="${args.query}", depth=${searchDepth}, max=${maxResults}`);
        return await performWebSearch(args.query, maxResults, searchDepth);
    },
    finance_quote: async (args) => {
        console.log(` 执行工具 finance_quote: symbol="${args.symbol}", range="${args.range || FINANCE_DEFAULT_RANGE}", interval="${args.interval || FINANCE_DEFAULT_INTERVAL}"`);
        return await fetchYahooFinanceQuote(args);
    }
};

// ==================== Multi-Agent 编排 (主控 + 动态1~4子AI) ====================

const AGENT_DEFAULT_POLICY = 'dynamic-1-4';
const AGENT_DEFAULT_QUALITY = 'high';
const AGENT_MAX_RETRIES = 2;
const AGENT_ROLES = ['planner', 'researcher', 'synthesizer', 'verifier'];

const FRESHNESS_KEYWORDS = [
    '现在', '最新', '今天', '实时', 'recent', 'latest', 'today', 'now',
    'news', '天气', '股价', '价格', '汇率', '比分', '政策', '更新'
];

const HIGH_RISK_KEYWORDS = [
    '医疗', '诊断', '处方', '药', '手术', '健康',
    '法律', '合同', '诉讼', '合规', '税务',
    '金融', '投资', '理财', '杠杆', '证券', '贷款',
    'medical', 'diagnosis', 'prescription', 'legal', 'lawsuit',
    'finance', 'investment', 'tax', 'compliance', 'security'
];

const HIGH_ACCURACY_KEYWORDS = [
    '高准确', '高精度', '严谨', '严格', '请务必准确',
    'high accuracy', 'strictly accurate', 'double check'
];

// ==================== 关键词规则注入引擎（首版硬编码） ====================
const PROMPT_INJECTION_RULES = [
    {
        id: 'logic_carwash_distance',
        enabled: true,
        priority: 100,
        match: {
            keywords: ['洗车', '50', '开车', '走路'],
            minMatchCount: 3,
            scope: 'current_message',
            caseInsensitive: true
        },
        mustIncludeAny: ['洗车'],
        excludeIfAny: [],
        instruction: [
            '这是常识逻辑题时，优先指出“洗的是车不是人”。',
            '核心结论：默认应“开车去洗车”，并说明走路无法把车带去洗。',
            '若用户补充“车不在身边/车已在店里”等前提，再按新前提重判。'
        ].join('\n'),
        notes: '洗车场景逻辑强化'
    },
    {
        id: 'logic_parents_marriage_not_invited',
        enabled: true,
        priority: 90,
        match: {
            keywords: ['爸妈', '父母', '结婚', '没叫我', '不叫我', '没邀请我', '难过', '伤心'],
            minMatchCount: 3,
            scope: 'current_message',
            caseInsensitive: true
        },
        mustIncludeAny: ['结婚'],
        excludeIfAny: [],
        instruction: [
            '回答需明确提醒：“你爸妈结婚时你还没出生，所以‘没叫你’不是针对你。”',
            '表达顺序：先简短共情，再给逻辑澄清，再给安抚建议（1-2条）。'
        ].join('\n'),
        notes: '情绪+逻辑澄清场景'
    }
];

function normalizeForRuleMatch(text = '', caseInsensitive = true) {
    let normalized = String(text || '');
    if (caseInsensitive) normalized = normalized.toLowerCase();
    return normalized
        .replace(/[\r\n\t\s]+/g, '')
        .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
}

function matchRule(rule, userMessage) {
    if (!rule || !rule.enabled) {
        return { matched: false, matchedKeywords: [], score: 0 };
    }

    const matchConfig = rule.match || {};
    const caseInsensitive = matchConfig.caseInsensitive !== false;
    const sourceText = normalizeForRuleMatch(userMessage, caseInsensitive);
    if (!sourceText) {
        return { matched: false, matchedKeywords: [], score: 0 };
    }

    const keywords = Array.isArray(matchConfig.keywords) ? matchConfig.keywords : [];
    const matchedKeywords = [];
    for (const kw of keywords) {
        const token = normalizeForRuleMatch(kw, caseInsensitive);
        if (!token) continue;
        if (sourceText.includes(token)) matchedKeywords.push(String(kw));
    }

    const minMatchCount = Number(matchConfig.minMatchCount || 1);
    if (matchedKeywords.length < minMatchCount) {
        return {
            matched: false,
            matchedKeywords,
            score: keywords.length > 0 ? matchedKeywords.length / keywords.length : 0
        };
    }

    if (Array.isArray(rule.mustIncludeAny) && rule.mustIncludeAny.length > 0) {
        const mustPass = rule.mustIncludeAny.some((kw) => {
            const token = normalizeForRuleMatch(kw, caseInsensitive);
            return token ? sourceText.includes(token) : false;
        });
        if (!mustPass) {
            return {
                matched: false,
                matchedKeywords,
                score: keywords.length > 0 ? matchedKeywords.length / keywords.length : 0
            };
        }
    }

    if (Array.isArray(rule.excludeIfAny) && rule.excludeIfAny.length > 0) {
        const blocked = rule.excludeIfAny.some((kw) => {
            const token = normalizeForRuleMatch(kw, caseInsensitive);
            return token ? sourceText.includes(token) : false;
        });
        if (blocked) {
            return {
                matched: false,
                matchedKeywords,
                score: keywords.length > 0 ? matchedKeywords.length / keywords.length : 0
            };
        }
    }

    return {
        matched: true,
        matchedKeywords,
        score: keywords.length > 0 ? matchedKeywords.length / keywords.length : 1
    };
}

function resolvePromptInjection(userMessage) {
    const candidates = [];
    for (const rule of PROMPT_INJECTION_RULES) {
        if (!rule?.enabled) continue;
        if (rule?.match?.scope && rule.match.scope !== 'current_message') continue;
        const result = matchRule(rule, userMessage);
        if (!result.matched) continue;
        candidates.push({
            rule,
            matchedKeywords: result.matchedKeywords,
            score: result.score
        });
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
        const pa = Number(a.rule.priority || 0);
        const pb = Number(b.rule.priority || 0);
        if (pb !== pa) return pb - pa;
        return (b.score || 0) - (a.score || 0);
    });

    const selected = candidates[0];
    return {
        ruleId: selected.rule.id,
        instruction: String(selected.rule.instruction || '').trim(),
        matchedKeywords: selected.matchedKeywords
    };
}

function buildRuleInjectionInstruction(resolvedRule) {
    if (!resolvedRule?.instruction) return '';
    const matched = Array.isArray(resolvedRule.matchedKeywords)
        ? resolvedRule.matchedKeywords.join('、')
        : '';
    return [
        '[规则注入-高优先级]',
        '你必须严格遵守以下逻辑约束（优先级高于一般风格要求）：',
        `规则ID: ${resolvedRule.ruleId || 'unknown'}`,
        matched ? `命中关键词: ${matched}` : '',
        String(resolvedRule.instruction || '').trim()
    ].filter(Boolean).join('\n').trim();
}

const DOMAIN_MODE_ALIASES = {
    write: 'writing',
    writing: 'writing',
    writer: 'writing',
    '写作': 'writing',
    finance: 'finance',
    financial: 'finance',
    stock: 'finance',
    stocks: 'finance',
    ticker: 'finance',
    quote: 'finance',
    market: 'finance',
    markets: 'finance',
    '财务': 'finance',
    '金融': 'finance',
    '股票': 'finance',
    '证券': 'finance',
    '港股': 'finance',
    'a股': 'finance',
    'A股': 'finance',
    code: 'coding',
    coding: 'coding',
    programmer: 'coding',
    programming: 'coding',
    '代码': 'coding',
    search: 'research',
    research: 'research',
    '搜索': 'research',
    '研究': 'research',
    translate: 'translation',
    translation: 'translation',
    translator: 'translation',
    '翻译': 'translation'
};

const DOMAIN_LABELS = {
    writing: { zh: '写作', en: 'Writing' },
    finance: { zh: '财务', en: 'Finance' },
    coding: { zh: '代码', en: 'Coding' },
    research: { zh: '搜索/研究', en: 'Search/Research' },
    translation: { zh: '翻译', en: 'Translation' }
};

const DOMAIN_SYSTEM_PROMPTS = {
    writing: {
        en: `You are an elite writing consultant with expertise across literary fiction, copywriting, journalism, and content strategy.

CORE DIRECTIVES:
- Analyze the user's intent, audience, tone, and purpose BEFORE writing
- Match voice and register precisely: formal/casual/poetic/persuasive
- Structure with narrative tension: hook -> development -> resolution
- Prioritize specificity over generality; concrete details over abstractions
- Every sentence must earn its place — cut filler, amplify signal

OUTPUT PROTOCOL:
1. Clarify ambiguities with ONE targeted question if needed
2. Produce the primary draft
3. Offer 1-2 variant approaches (different tone/angle/structure)
4. End with brief craft notes explaining key decisions

QUALITY MARKERS: vivid imagery, rhythmic sentence variation, emotional resonance, clear throughline, memorable opening/closing.`,
        zh: `你是一位顶级写作顾问，精通文学创作、文案策划、新闻写作与内容策略。

【核心指令】
- 动笔前先分析用户意图、目标受众、语气基调与写作目的
- 精准匹配文风与语域：正式 / 轻松 / 诗意 / 说服性
- 以叙事张力构建结构：钩子开篇 -> 层层推进 -> 有力收尾
- 用具体细节代替空泛表述，用鲜活意象代替抽象概念
- 每一句话都必须有存在价值，删除冗余，强化信号

【输出规范】
1. 若信息不足，只提一个最关键的问题进行确认
2. 输出主要正文内容
3. 提供 1-2 个备选方向（不同语气 / 角度 / 结构）
4. 附上简短的「创作说明」，解释关键写作决策

【质量标准】
意象鲜明，句式富有节奏，情感共鸣，主线清晰，开头结尾令人印象深刻。`
    },
    finance: {
        en: `You are a market and finance analyst focused on practical stock, ETF, index, and quote interpretation.

CORE DIRECTIVES:
- Use the finance_quote tool first for symbol-based market data, price, change, and K-line/history questions
- Never fabricate prices, percentage changes, or chart trends
- Separate market data from your own interpretation
- Clearly note that free Yahoo Finance data for A-shares and Hong Kong stocks is usually delayed and not tick-level real-time
- If the user does not provide a recognizable ticker or market suffix, ask for the symbol before making claims
- Use web_search only for news, filings, company events, macro background, or analyst commentary

OUTPUT PROTOCOL:
1. Identify the ticker or market first when needed
2. Present a compact market data summary
3. Explain trend, volatility, and key levels in plain language
4. Mark uncertainty and delay risk explicitly
5. Distinguish facts, calculations, and opinion

TOOL PRIORITY:
- Use finance_quote for quotes, price moves, trend ranges, and historical candles
- Use web_search only after finance_quote when news or context is needed
- Cite Yahoo Finance market data with alpha markers like [A], [B] when the tool provides them`,
        zh: `你是一位市场与财务分析助手，专注于股票、ETF、指数与行情解读。

【核心指令】
- 只要问题涉及证券代码、价格、涨跌幅、区间走势、K线、成交量，优先调用 finance_quote 工具取数
- 绝不编造价格、涨跌幅、历史走势或财务市场数据
- 明确区分“市场数据事实”和“你的分析判断”
- 明确提示：Yahoo Finance 免费数据中的 A 股 / 港股通常为延迟行情，并非逐笔实时成交
- 如果用户没有提供可识别的 ticker 或市场后缀，先要求补充证券代码后再下结论
- 只有在需要新闻、公告、财报背景、研报观点、宏观背景时，再结合 web_search

【输出规范】
1. 先识别或确认证券代码 / 市场
2. 先给结构化市场数据摘要
3. 再解释区间趋势、波动、关键价位
4. 明确说明延迟数据与不确定性
5. 清晰区分事实、计算结果与分析意见

【工具优先级】
- finance_quote：用于行情、涨跌、区间走势、历史 K 线
- web_search：用于新闻、公告、事件背景与外部信息补充
- 如果使用 Yahoo Finance 行情数据，请在正文中使用字母角标，例如 [A]、[B]`
    },
    coding: {
        en: `You are a senior software engineer with 15+ years across full-stack, systems, and architecture. You write production-grade code.

CORE DIRECTIVES:
- Understand requirements fully before coding; identify edge cases first
- Write clean, readable, maintainable code, not just functional code
- Follow language-specific best practices and idiomatic patterns
- Consider: performance, security, error handling, scalability
- Never assume; ask about constraints (language version, framework, env)

OUTPUT PROTOCOL:
1. Restate the problem in your own words to confirm understanding
2. Outline your approach BEFORE writing code
3. Provide complete, runnable code with inline comments for non-obvious logic
4. Include: error handling, input validation, edge case notes
5. Add a "Potential Improvements" section for production considerations

QUALITY MARKERS: O(n) complexity awareness, DRY principles, SOLID design, security-conscious patterns, test coverage suggestions.`,
        zh: `你是一位拥有 15 年以上经验的资深软件工程师，精通全栈开发、系统设计与架构规划，只写生产级代码。

【核心指令】
- 完整理解需求后再动手，优先识别边界条件与异常情况
- 代码要干净、可读、易维护，不只是能跑起来
- 遵循对应语言的最佳实践与惯用模式
- 全面考量：性能、安全性、错误处理、可扩展性
- 遇到不确定的约束（语言版本、框架、环境）主动询问

【输出规范】
1. 用自己的话复述问题，确认理解无误
2. 写代码前先阐述实现思路
3. 提供完整可运行的代码，对非显而易见的逻辑加注释
4. 包含：错误处理、输入校验、边界情况说明
5. 末尾附「可优化方向」供生产环境参考

【质量标准】
时间复杂度意识，DRY 原则，SOLID 设计，安全编码习惯，测试覆盖建议。`
    },
    research: {
        en: `You are a research analyst and information strategist trained in academic research, fact-checking, and knowledge synthesis.

CORE DIRECTIVES:
- Decompose complex queries into precise sub-questions
- Distinguish between: verified facts / expert consensus / contested claims / speculation
- Cite source types (peer-reviewed / official / journalistic / anecdotal)
- Flag information currency, and note if data may be outdated
- Identify knowledge gaps and conflicting evidence explicitly

OUTPUT PROTOCOL:
1. Reframe the query for maximum precision
2. Deliver findings in layers: Summary -> Details -> Evidence -> Caveats
3. Use confidence levels: [High / Medium / Low / Unverified]
4. Highlight what is NOT known or disputed
5. Suggest follow-up searches or primary sources

QUALITY MARKERS: epistemic honesty, source triangulation, bias awareness, clear separation of fact vs. interpretation.`,
        zh: `你是一位研究分析师与信息策略专家，擅长学术研究、事实核查与知识综合归纳。

【核心指令】
- 将复杂问题拆解为精确的子问题
- 严格区分：已验证事实 / 专家共识 / 争议观点 / 推测性内容
- 标注信息来源类型（学术论文 / 官方数据 / 新闻报道 / 坊间说法）
- 注明信息时效性，若数据可能过时需显式提示
- 明确指出知识盲区与相互矛盾的证据

【输出规范】
1. 重新精确表述问题
2. 分层输出结论：摘要 -> 详情 -> 证据 -> 注意事项
3. 标注可信度等级：【高】【中】【低】【待核实】
4. 突出显示「尚未明确」或「存在争议」的部分
5. 建议延伸搜索方向或一手信息来源

【质量标准】
认知诚实，多源交叉验证，偏见意识，事实与解读清晰分离。`
    },
    translation: {
        en: `You are a professional translator and computational linguist with deep expertise in cross-cultural communication, localization, and linguistics.

CORE DIRECTIVES:
- Prioritize meaning fidelity over word-for-word literalism
- Preserve: tone, register, cultural nuance, rhetorical effect, humor
- Identify untranslatable concepts and handle them explicitly
- Adapt idioms, metaphors, and cultural references for target audience
- Maintain stylistic fingerprint of the original author

OUTPUT PROTOCOL:
1. Identify source language, target language, domain, and register
2. Deliver primary translation
3. Annotate culturally significant choices with [TN: translator's note]
4. For ambiguous source text, provide 2 interpretations with reasoning
5. Flag any terms with intentional localization decisions

QUALITY MARKERS: natural target-language flow, cultural equivalence, preserved subtext, consistent terminology, register alignment.

SPECIAL MODES (invoke as needed):
- [LITERAL] for academic/legal precision
- [LOCALIZE] for marketing/consumer content
- [PRESERVE STYLE] for literary/creative work`,
        zh: `你是一位职业译者与计算语言学家，深度精通跨文化传播、本地化策略与语言学理论。

【核心指令】
- 以意义忠实为首要原则，而非逐字对译
- 完整保留：语气、语域、文化内涵、修辞效果、幽默感
- 识别不可直译的概念，并给出显式处理方案
- 对习语、隐喻、文化典故进行目标语读者适配
- 保留原作者的文体风格与个人语言特征

【输出规范】
1. 识别源语言、目标语言、专业领域与语域风格
2. 输出主要译文
3. 对有文化负载的翻译决策加注【译注】说明
4. 源文本存在歧义时，提供两种理解方向并附理由
5. 标记所有经过有意本地化处理的术语

【质量标准】
目标语行文自然，文化等效，潜台词保留，术语一致，语域对齐。

【特殊模式（按需启用）】
[直译模式] 适用于学术/法律类精确场景
[本地化模式] 适用于营销/消费者内容
[保留文风模式] 适用于文学/创意写作`
    }
};

function normalizeDomainMode(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    return DOMAIN_MODE_ALIASES[lower] || DOMAIN_MODE_ALIASES[raw] || '';
}

function resolvePromptLanguage(uiLanguage = '', userMessage = '') {
    const lang = String(uiLanguage || '').toLowerCase();
    if (lang.startsWith('zh')) return 'zh';
    if (lang.startsWith('en')) return 'en';

    const text = String(userMessage || '');
    const zhCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const enCount = (text.match(/[a-zA-Z]/g) || []).length;
    return zhCount >= enCount ? 'zh' : 'en';
}

function resolveDomainSystemPrompt({ domainMode = '', uiLanguage = '', userMessage = '' }) {
    const normalizedDomainMode = normalizeDomainMode(domainMode);
    if (!normalizedDomainMode) return null;

    const promptLanguage = resolvePromptLanguage(uiLanguage, userMessage);
    const promptPack = DOMAIN_SYSTEM_PROMPTS[normalizedDomainMode];
    const promptText = String(promptPack?.[promptLanguage] || promptPack?.en || '').trim();
    if (!promptText) return null;

    return {
        domainMode: normalizedDomainMode,
        promptLanguage,
        promptText
    };
}

function buildDomainInjectionInstruction(resolvedDomainPrompt) {
    if (!resolvedDomainPrompt?.promptText) return '';
    const mode = resolvedDomainPrompt.domainMode;
    const lang = resolvedDomainPrompt.promptLanguage === 'zh' ? 'zh' : 'en';
    const modeLabel = DOMAIN_LABELS[mode]?.[lang] || mode;
    const langLabel = lang === 'zh' ? '中文' : 'English';
    return [
        '[领域系统提示词]',
        `当前功能模式: ${modeLabel}`,
        `输出语言优先: ${langLabel}`,
        '在不违反安全、合规和真实性原则前提下，优先遵循以下专业规范：',
        resolvedDomainPrompt.promptText
    ].join('\n').trim();
}

function isInsufficientBalanceError(status, errorText = '') {
    const text = String(errorText || '').toLowerCase();
    if (![402, 403].includes(Number(status))) return false;
    return (
        text.includes('"code":30001') ||
        text.includes('code\\":30001') ||
        text.includes('insufficient') ||
        text.includes('account balance') ||
        text.includes('余额不足')
    );
}

function normalizeReasoningProfile(value = 'low') {
    const normalized = String(value || '').trim().toLowerCase();
    if (['low', 'medium', 'high', 'mixed'].includes(normalized)) return normalized;
    return 'low';
}

function normalizeResearchMode(value = 'off') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'deep') return 'deep';
    if (normalized === 'fast') return 'fast';
    return 'off';
}

const REASONING_TEXT_KEYS = [
    'reasoning_content',
    'reasoning',
    'reasoning_text',
    'reasoningSummary',
    'reasoning_summary',
    'reasoning_summary_text',
    'thinking',
    'thought',
    'thoughts'
];

const REASONING_NESTED_KEYS = [
    'reasoning_details',
    'reasoningDetails',
    'summary',
    'summaries',
    'parts',
    'items'
];

function stringifyReasoningValue(value, seen = new Set()) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        return value.map((item) => stringifyReasoningValue(item, seen)).filter(Boolean).join('');
    }
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);

    const type = String(value.type || '').toLowerCase();
    if (type.includes('encrypted')) return '';

    const pieces = [];
    for (const key of ['text', 'content', 'delta', 'value']) {
        if (typeof value[key] === 'string') {
            pieces.push(value[key]);
        }
    }
    for (const key of REASONING_TEXT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            pieces.push(stringifyReasoningValue(value[key], seen));
        }
    }
    for (const key of REASONING_NESTED_KEYS) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            pieces.push(stringifyReasoningValue(value[key], seen));
        }
    }

    return pieces.filter(Boolean).join('');
}

function extractReasoningTextFromPayload(...payloads) {
    const pieces = [];
    for (const payload of payloads) {
        if (!payload || typeof payload !== 'object') continue;

        for (const key of REASONING_TEXT_KEYS) {
            if (Object.prototype.hasOwnProperty.call(payload, key)) {
                pieces.push(stringifyReasoningValue(payload[key]));
            }
        }

        for (const key of REASONING_NESTED_KEYS) {
            if (Object.prototype.hasOwnProperty.call(payload, key)) {
                pieces.push(stringifyReasoningValue(payload[key]));
            }
        }
    }
    return pieces.filter(Boolean).join('');
}

function extractReasoningTextFromResponseEvent(event = {}) {
    const type = String(event?.type || '').toLowerCase();
    const itemType = String(event?.item?.type || event?.part?.type || event?.delta?.type || '').toLowerCase();
    if (!type.includes('reasoning') && !itemType.includes('reasoning')) return '';
    return (
        stringifyReasoningValue(event.delta) ||
        stringifyReasoningValue(event.text) ||
        stringifyReasoningValue(event.content) ||
        stringifyReasoningValue(event.summary) ||
        stringifyReasoningValue(event.part) ||
        stringifyReasoningValue(event.item) ||
        stringifyReasoningValue(event.output) ||
        extractReasoningTextFromPayload(event)
    );
}

function extractOutputTextFromResponseEvent(event = {}) {
    const type = String(event?.type || '').toLowerCase();
    if (!type.includes('output_text') && !type.includes('message.delta')) return '';
    return (
        (typeof event.delta === 'string' && event.delta) ||
        (typeof event.text === 'string' && event.text) ||
        (typeof event.content === 'string' && event.content) ||
        ''
    );
}

function isPoeModelAlias(modelName = '') {
    return Object.prototype.hasOwnProperty.call(POE_STATIC_MODEL_MAP, String(modelName || '').trim());
}

function pickPoeModelByHints(modelIds = [], hints = []) {
    if (!Array.isArray(modelIds) || modelIds.length === 0) return '';
    if (!Array.isArray(hints) || hints.length === 0) return '';

    const loweredHints = hints.map((h) => String(h || '').toLowerCase()).filter(Boolean);
    if (loweredHints.length === 0) return '';

    const fullMatch = modelIds.find((id) => {
        const text = String(id || '').toLowerCase();
        return loweredHints.every((hint) => text.includes(hint));
    });
    if (fullMatch) return fullMatch;

    return modelIds.find((id) => String(id || '').toLowerCase().includes(loweredHints[0])) || '';
}

function resolvePoeModelAlias(alias = '') {
    const key = String(alias || '').trim();
    const staticModel = POE_STATIC_MODEL_MAP[key];
    if (!staticModel) {
        return {
            alias: key,
            available: false,
            model: '',
            source: 'unknown'
        };
    }

    if (!poeModelRegistry.hasSuccessfulSync) {
        return {
            alias: key,
            available: true,
            model: staticModel,
            source: 'static'
        };
    }

    const available = !!poeModelRegistry.aliasAvailability[key];
    const resolvedModel = poeModelRegistry.aliasResolvedModels[key] || staticModel;
    return {
        alias: key,
        available,
        model: resolvedModel,
        source: available ? 'dynamic' : 'dynamic_unavailable'
    };
}

function buildPoeExtraBody(modelAlias, reasoningProfile = 'low', thinkingMode = false) {
    const alias = String(modelAlias || '').trim();
    const profile = normalizeReasoningProfile(reasoningProfile);

    if (alias === 'poe-gpt') {
        return {
            reasoning_effort: resolveOpenAIChatReasoningEffort(
                POE_STATIC_MODEL_MAP[alias] || 'gpt-5-nano',
                !!thinkingMode,
                profile
            )
        };
    }

    if (alias === 'poe-gemini') {
        if (!thinkingMode) return null;
        if (profile === 'mixed') return null;
        const geminiThinkingMap = {
            low: 'minimal',
            medium: 'low',
            high: 'high'
        };
        return {
            thinking_level: geminiThinkingMap[profile] || 'minimal'
        };
    }

    if (alias === 'poe-claude') {
        if (!thinkingMode) return null;
        const claudeBudgetMap = {
            low: 1024,
            medium: 4096,
            high: 8192,
            mixed: 4096
        };
        return {
            thinking_budget: claudeBudgetMap[profile] || 1024
        };
    }

    // grok 首版不传 reasoning 参数，兼容优先
    return null;
}

async function syncPoeModels() {
    if (poeModelRegistry.syncing) return;
    if (!ENV_API_KEYS.POE_API_KEY) return;

    poeModelRegistry.syncing = true;
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
        const response = await fetch('https://api.poe.com/v1/models', {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${ENV_API_KEYS.POE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText.substring(0, 160)}`);
        }

        const payload = await response.json();
        const data = Array.isArray(payload?.data) ? payload.data : [];
        const modelIds = data
            .map((item) => String(item?.id || item?.name || '').trim())
            .filter(Boolean);

        const nextResolvedModels = { ...POE_STATIC_MODEL_MAP };
        const nextAvailability = {};

        for (const alias of Object.keys(POE_STATIC_MODEL_MAP)) {
            const staticModel = POE_STATIC_MODEL_MAP[alias];
            const exactMatch = modelIds.find((id) => id.toLowerCase() === staticModel.toLowerCase());
            const hintedMatch = pickPoeModelByHints(modelIds, POE_ALIAS_HINTS[alias] || []);
            const resolvedModel = exactMatch || hintedMatch || staticModel;
            const available = !!(exactMatch || hintedMatch);
            nextResolvedModels[alias] = resolvedModel;
            nextAvailability[alias] = available;
        }

        poeModelRegistry.modelIds = modelIds;
        poeModelRegistry.aliasResolvedModels = nextResolvedModels;
        poeModelRegistry.aliasAvailability = nextAvailability;
        poeModelRegistry.lastSyncAt = new Date().toISOString();
        poeModelRegistry.lastError = '';
        poeModelRegistry.hasSuccessfulSync = true;

        const availableCount = Object.values(nextAvailability).filter(Boolean).length;
        console.log(` poe_model_sync success models=${modelIds.length} alias_available=${availableCount}/4 elapsed=${Date.now() - startedAt}ms`);
    } catch (error) {
        poeModelRegistry.lastSyncAt = new Date().toISOString();
        poeModelRegistry.lastError = String(error?.message || error);
        console.warn(` poe_model_sync failed: ${poeModelRegistry.lastError}`);
    } finally {
        clearTimeout(timeoutId);
        poeModelRegistry.syncing = false;
    }
}

function startPoeModelSyncJob() {
    if (!ENV_API_KEYS.POE_API_KEY) return;
    syncPoeModels().catch((err) => {
        console.warn(` poe_model_sync startup failed: ${err?.message || err}`);
    });
    setInterval(() => {
        syncPoeModels().catch((err) => {
            console.warn(` poe_model_sync interval failed: ${err?.message || err}`);
        });
    }, POE_MODEL_SYNC_INTERVAL_MS);
}

const THINKING_BUDGET_MODELS = new Set([
    'THUDM/GLM-Z1-9B-0414',
    'THUDM/GLM-4.1V-9B-Thinking'
]);

function isKimiK25ActualModel(modelName = '') {
    return /Kimi-K2\.5/i.test(String(modelName || ''));
}

function supportsThinkingBudgetModel(modelName = '') {
    return THINKING_BUDGET_MODELS.has(String(modelName || '').trim());
}

function resolveThinkingBudgetForModel(modelName = '', thinkingMode = false, thinkingBudget = 1024) {
    if (!supportsThinkingBudgetModel(modelName)) return null;

    // 对于默认思考模型，用极低budget模拟“快速模式”
    if (!thinkingMode) return 8;

    const parsed = parseInt(thinkingBudget, 10);
    if (isNaN(parsed) || parsed <= 0) return 1024;
    return Math.max(1, Math.min(parsed, 32768));
}

function resolveDeepSeekReasoningEffort(reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    return (profile === 'high' || profile === 'mixed') ? 'max' : 'high';
}

function resolveOpenAIReasoningEffort(reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    if (profile === 'high' || profile === 'mixed') return 'high';
    if (profile === 'medium') return 'medium';
    return 'low';
}

function resolveOpenAIChatReasoningEffort(modelName = '', thinkingMode = false, reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    const normalizedModel = String(modelName || '').trim().toLowerCase();

    if (normalizedModel.includes('gpt-5-pro')) {
        return 'high';
    }

    if (/^gpt-5\.1(?:$|-)/.test(normalizedModel)) {
        if (!thinkingMode) return 'none';
        if (profile === 'mixed') return 'high';
        if (profile === 'high') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    if (/^gpt-(?:5\.[2-9]|[6-9](?:\.|$))/.test(normalizedModel)) {
        if (!thinkingMode) return 'none';
        if (profile === 'mixed') return 'xhigh';
        if (profile === 'high') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    if (/^gpt-5(?:$|-)/.test(normalizedModel)) {
        if (!thinkingMode) return 'minimal';
        if (profile === 'mixed') return 'high';
        if (profile === 'high') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    if (!thinkingMode) return null;
    return resolveOpenAIReasoningEffort(profile);
}

function resolveNewApiReasoningEffort(modelName = '', thinkingMode = false, reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    const normalizedModel = String(modelName || '').trim().toLowerCase();

    if (normalizedModel.startsWith('gpt-')) {
        return resolveOpenAIChatReasoningEffort(normalizedModel, thinkingMode, profile);
    }

    if (normalizedModel.includes('grok')) {
        if (!thinkingMode) return 'none';
        if (profile === 'mixed') return 'high';
        if (profile === 'high') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    return thinkingMode ? resolveOpenAIReasoningEffort(profile) : null;
}

function resolveOpenRouterReasoningEffort(actualModel = '', reasoningProfile = 'low') {
    const profile = normalizeReasoningProfile(reasoningProfile);
    const normalizedModel = String(actualModel || '').trim().toLowerCase();

    if (normalizedModel.includes('gpt-oss')) {
        if (profile === 'high' || profile === 'mixed') return 'high';
        if (profile === 'medium') return 'medium';
        return 'low';
    }

    if (profile === 'mixed') return 'high';
    if (profile === 'high') return 'high';
    if (profile === 'medium') return 'medium';
    return 'low';
}

function applyNewApiModelParams(body, actualModel = '', thinkingMode = false, reasoningProfile = 'low') {
    if (!body || typeof body !== 'object') return;
    const effort = resolveNewApiReasoningEffort(actualModel, thinkingMode, reasoningProfile);
    if (effort) {
        body.reasoning_effort = effort;
        if (String(actualModel || '').toLowerCase().includes('grok')) {
            body.reasoning = { effort };
        } else {
            delete body.reasoning;
        }
    } else {
        delete body.reasoning_effort;
        delete body.reasoning;
    }
}

function applyOpenRouterReasoningParams(body, actualModel = '', thinkingMode = false, reasoningProfile = 'low') {
    if (!body || typeof body !== 'object') return;

    const normalizedModel = String(actualModel || '').trim().toLowerCase();
    const isGptOss = normalizedModel.includes('gpt-oss');
    const isOpenRouterFree = normalizedModel === 'openrouter/free';

    if (!isGptOss && !isOpenRouterFree && !normalizedModel.includes('gemma')) {
        delete body.reasoning;
        return;
    }

    if (isGptOss) {
        if (thinkingMode) {
            body.reasoning = {
                effort: resolveOpenRouterReasoningEffort(actualModel, reasoningProfile),
                exclude: false
            };
        } else {
            body.reasoning = { exclude: true };
        }
        return;
    }

    if (thinkingMode) {
        body.reasoning = {
            effort: resolveOpenRouterReasoningEffort(actualModel, reasoningProfile),
            exclude: false
        };
    } else {
        delete body.reasoning;
    }
}

function applyDeepSeekV4ModeParams(body, thinkingMode = false, reasoningProfile = 'low') {
    if (!body || typeof body !== 'object') return;

    body.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
    if (thinkingMode) {
        body.reasoning_effort = resolveDeepSeekReasoningEffort(reasoningProfile);
        delete body.temperature;
        delete body.top_p;
        delete body.frequency_penalty;
        delete body.presence_penalty;
    } else {
        delete body.reasoning_effort;
    }
}

function buildSiliconflowFreeFallbackRequestBody({
    actualModel,
    messages,
    internetMode,
    thinkingMode,
    thinkingBudget,
    temperature,
    top_p,
    max_tokens
}) {
    const body = {
        model: actualModel,
        messages,
        max_tokens: parseInt(max_tokens, 10) || 2000,
        stream: true,
        temperature: parseFloat(temperature) || 0.7,
        top_p: parseFloat(top_p) || 0.9
    };

    const budget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
    if (budget !== null) {
        body.thinking_budget = budget;
    }

    // 硅基免费模型使用工具调用来联网，不走阿里云 enable_search
    if (internetMode) {
        body.tools = TOOL_DEFINITIONS;
        body.tool_choice = 'auto';
    }

    return body;
}

function buildOpenAIFallbackRequestBody({
    actualModel,
    messages,
    internetMode,
    temperature,
    top_p,
    max_tokens
}) {
    const body = {
        model: actualModel,
        messages,
        max_tokens: parseInt(max_tokens, 10) || 2000,
        stream: true,
        temperature: parseFloat(temperature) || 0.7,
        top_p: parseFloat(top_p) || 0.9
    };

    if (internetMode) {
        body.tools = TOOL_DEFINITIONS;
        body.tool_choice = 'auto';
    }

    return body;
}

function normalizeAgentMode(value) {
    if (value === 'on' || value === true || value === 'true' || value === 1 || value === '1') {
        return 'on';
    }
    return 'off';
}

function normalizeQualityProfile(value) {
    return value === 'high' ? 'high' : AGENT_DEFAULT_QUALITY;
}

function normalizeAgentPolicy(value) {
    return value === AGENT_DEFAULT_POLICY ? value : AGENT_DEFAULT_POLICY;
}

function detectFreshnessNeed(message = '', internetMode = false) {
    const lower = String(message || '').toLowerCase();
    const keywordHit = FRESHNESS_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
    // 开启联网仅代表“允许检索”，不等于“必须实时检索”
    return keywordHit || (internetMode && /(最新|实时|news|today|now|price|weather)/i.test(lower));
}

function detectRiskLevel(message = '') {
    const lower = String(message || '').toLowerCase();
    return HIGH_RISK_KEYWORDS.some(k => lower.includes(k.toLowerCase())) ? 'high' : 'low';
}

function detectHighAccuracyNeed(message = '') {
    const lower = String(message || '').toLowerCase();
    return HIGH_ACCURACY_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

function estimateUncertainty(complexityScore, freshnessNeed, riskLevel) {
    const base = 0.1 + (complexityScore * 0.35);
    const freshnessPenalty = freshnessNeed ? 0.2 : 0;
    const riskPenalty = riskLevel === 'high' ? 0.25 : 0;
    return Math.max(0, Math.min(base + freshnessPenalty + riskPenalty, 1));
}

function buildTaskFingerprint(userMessage, internetMode = false) {
    const safeMessage = String(userMessage || '');
    const complexity = evaluateComplexity(safeMessage);
    const complexityScore = Number(complexity?.score || 0);
    const freshnessNeed = detectFreshnessNeed(safeMessage, internetMode);
    const riskLevel = detectRiskLevel(safeMessage);
    const highAccuracyRequested = detectHighAccuracyNeed(safeMessage);
    const uncertainty = estimateUncertainty(complexityScore, freshnessNeed, riskLevel);

    return {
        complexityScore,
        freshnessNeed,
        riskLevel,
        uncertainty,
        highAccuracyRequested
    };
}

function selectAgentSet(taskFingerprint, policy = AGENT_DEFAULT_POLICY) {
    if (policy !== AGENT_DEFAULT_POLICY) {
        return ['synthesizer'];
    }

    const {
        complexityScore = 0,
        freshnessNeed = false,
        riskLevel = 'low',
        uncertainty = 0,
        highAccuracyRequested = false
    } = taskFingerprint || {};

    let selected = ['synthesizer'];
    if (freshnessNeed || complexityScore >= 0.55) {
        selected = ['planner', 'researcher', 'synthesizer'];
    } else if (complexityScore >= 0.25 && complexityScore <= 0.55 && !freshnessNeed) {
        selected = ['planner', 'synthesizer'];
    }

    if (riskLevel === 'high' || uncertainty > 0.35 || highAccuracyRequested) {
        selected = [...AGENT_ROLES];
    }

    return selected;
}

function emitAgentEvent(res, payload) {
    if (!res || !payload) return;
    if (process.env.AGENT_DEBUG === '1') {
        const role = payload.role ? ` role=${payload.role}` : '';
        const status = payload.status ? ` status=${payload.status}` : '';
        console.log(` agent_event type=${payload.type}${role}${status}`);
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function summarizePlannerPlan(userMessage, fingerprint, selectedAgents) {
    const text = String(userMessage || '').trim();
    const summary = text.length > 80 ? `${text.slice(0, 80)}...` : text;
    const goals = [
        '澄清用户目标与约束',
        fingerprint.freshnessNeed ? '提取需要联网核验的关键信息' : '提取关键推理步骤',
        '生成可验证的最终答案结构'
    ];

    return {
        summary,
        goals,
        selectedAgents
    };
}

function runPlanner({ userMessage, fingerprint, selectedAgents }) {
    return summarizePlannerPlan(userMessage, fingerprint, selectedAgents);
}

function runResearcher({ userMessage, fingerprint }) {
    const baseQuery = String(userMessage || '').replace(/\s+/g, ' ').trim();
    const hints = [];
    if (baseQuery) {
        hints.push(baseQuery.length > 80 ? `${baseQuery.slice(0, 80)} latest` : baseQuery);
    }
    if (fingerprint?.freshnessNeed) {
        hints.push(`${baseQuery} official source`);
    }
    return {
        shouldSearch: !!fingerprint?.freshnessNeed,
        queryHints: hints.slice(0, 3)
    };
}

function runSynthesizer() {
    return {
        mode: 'streaming',
        delegated: true
    };
}

function runVerifier({ qualityProfile, content, sources, fingerprint }) {
    return applyQualityGate({ qualityProfile, content, sources, fingerprint });
}

function scoreSourceQuality(sources = []) {
    if (!Array.isArray(sources) || sources.length === 0) return 0;

    const lowQualityPatterns = ['aqi.in', 'weather25', 'unknown'];
    let total = 0;
    for (const src of sources) {
        const url = String(src?.url || '');
        const title = String(src?.title || '');
        let score = 0.5;
        if (url.startsWith('https://')) score += 0.2;
        if (url && !lowQualityPatterns.some(p => url.includes(p))) score += 0.2;
        if (title && title !== '未知标题') score += 0.1;
        total += Math.min(score, 1);
    }
    return Math.max(0, Math.min(total / sources.length, 1));
}

function estimateClaimCoverage(content = '', sources = [], freshnessNeed = false) {
    const text = String(content || '').trim();
    if (!text) return 0;

    const claims = text.split(/[\n。！？.!?;；]/g).map(s => s.trim()).filter(s => s.length >= 12);
    if (claims.length === 0) return 1;

    const citationHits = (text.match(/\[\d+\]/g) || []).length;
    let coveredClaims = citationHits;
    if (coveredClaims === 0 && Array.isArray(sources) && sources.length > 0) {
        // 未显式角标时，按“已参考来源但未编号”处理，避免过度误判
        coveredClaims = Math.ceil(Math.min(claims.length, claims.length * 0.85));
    }

    if (!freshnessNeed && (!sources || sources.length === 0)) {
        return 1;
    }

    return Math.max(0, Math.min(coveredClaims / claims.length, 1));
}

function detectSimpleContradictions(content = '') {
    const text = String(content || '').toLowerCase();
    if (!text) return 0;
    if (text.includes('自相矛盾') || text.includes('contradict')) {
        return 1;
    }
    return 0;
}

function applyQualityGate({ qualityProfile, content, sources, fingerprint }) {
    const normalizedProfile = normalizeQualityProfile(qualityProfile);
    const freshnessNeed = !!fingerprint?.freshnessNeed;
    const claimCoverage = estimateClaimCoverage(content, sources, freshnessNeed);
    const contradictionCount = detectSimpleContradictions(content);
    const sourceQualityScore = scoreSourceQuality(sources);

    const thresholds = {
        claimCoverage: normalizedProfile === 'high' ? 0.8 : 0.65,
        sourceQuality: normalizedProfile === 'high' ? 0.55 : 0.45
    };

    const sourceGatePass = freshnessNeed
        ? sourceQualityScore >= thresholds.sourceQuality
        : true;

    const pass = (
        claimCoverage >= thresholds.claimCoverage &&
        contradictionCount === 0 &&
        sourceGatePass
    );

    return {
        pass,
        metrics: {
            claimCoverage: Number(claimCoverage.toFixed(3)),
            contradictionCount,
            sourceQualityScore: Number(sourceQualityScore.toFixed(3))
        },
        thresholds
    };
}

function buildConservativeFallbackNote(fingerprint) {
    return '';
}

function runAgentOrchestrator({ res, userMessage, internetMode, agentMode, agentPolicy, qualityProfile }) {
    const normalizedMode = normalizeAgentMode(agentMode);
    if (normalizedMode !== 'on') {
        return {
            enabled: false,
            agentMode: 'off',
            agentPolicy: normalizeAgentPolicy(agentPolicy),
            qualityProfile: normalizeQualityProfile(qualityProfile)
        };
    }

    const fingerprint = buildTaskFingerprint(userMessage, internetMode);
    const normalizedPolicy = normalizeAgentPolicy(agentPolicy);
    const normalizedQuality = normalizeQualityProfile(qualityProfile);
    const selectedAgents = selectAgentSet(fingerprint, normalizedPolicy);
    const plannerPlan = runPlanner({ userMessage, fingerprint, selectedAgents });
    const researcherPlan = runResearcher({ userMessage, fingerprint });
    const synthesizerPlan = runSynthesizer();

    emitAgentEvent(res, {
        type: 'agent_status',
        role: 'master',
        status: 'start',
        detail: '开始任务指纹分析'
    });

    emitAgentEvent(res, {
        type: 'agent_plan',
        policy: normalizedPolicy,
        qualityProfile: normalizedQuality,
        selectedAgents,
        maxRetries: AGENT_MAX_RETRIES,
        fingerprint,
        plan: plannerPlan
    });

    if (selectedAgents.includes('planner')) {
        emitAgentEvent(res, {
            type: 'agent_status',
            role: 'planner',
            status: 'start',
            detail: '开始任务拆解'
        });
        emitAgentEvent(res, {
            type: 'agent_status',
            role: 'planner',
            status: 'done',
            detail: '任务拆解完成'
        });
    }

    if (selectedAgents.includes('researcher')) {
        emitAgentEvent(res, {
            type: 'agent_status',
            role: 'researcher',
            status: 'start',
            detail: researcherPlan.queryHints?.[0]
                ? `等待检索任务: ${researcherPlan.queryHints[0]}`
                : '等待检索任务'
        });
    }

    if (selectedAgents.includes('synthesizer')) {
        emitAgentEvent(res, {
            type: 'agent_status',
            role: 'synthesizer',
            status: 'start',
            detail: synthesizerPlan.delegated ? '准备生成回答（流式）' : '准备生成回答'
        });
    }

    return {
        enabled: true,
        agentMode: 'on',
        agentPolicy: normalizedPolicy,
        qualityProfile: normalizedQuality,
        selectedAgents,
        fingerprint,
        retriesUsed: 0
    };
}


// [已删除] aiDecideWebSearch - 已被原生Function Calling替代
// 现在使用 callAPIWithTools + TOOL_DEFINITIONS 实现工具调用


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
 * 根据模型类型决定Tavily搜索深度
 * @param {string} modelName - 实际使用的模型名称
 * @param {boolean} isThinkingMode - 是否开启思考模式
 * @returns {string} 'ultra-fast' | 'fast' | 'basic'
 */
function getTavilySearchDepth(modelName, isThinkingMode = false) {
    // 思考模式固定使用 basic
    if (isThinkingMode || modelName.includes('Thinking')) {
        return 'basic';
    }
    // 快速/轻量模型优先 ultra-fast
    if (modelName.includes('flash') || modelName.includes('8B') || modelName.includes('Instruct')) {
        return 'ultra-fast';
    }
    // 默认使用基础搜索
    return 'basic';
}

/**
 * 执行网页搜索 (使用Tavily API)
 * Tavily是专为AI代理设计的搜索API，提供高质量、实时的搜索结果
 * @param {string} query - 搜索查询
 * @param {number} maxResults - 最大结果数量
 * @param {string} searchDepth - 搜索深度 'ultra-fast'|'fast'|'basic'
 * @returns {Promise<Array>} 搜索结果数组
 */
async function performWebSearch(query, maxResults = 5, searchDepth = 'basic') {
    return new Promise((resolve) => {
        try {
            if (!TAVILY_API_KEY) {
                console.error(' 缺少 TAVILY_API_KEY，跳过联网搜索');
                resolve({ results: [], images: [] });
                return;
            }
            console.log(` 执行Tavily网页搜索: "${query}" (深度: ${searchDepth})`);

            // 构建请求体
            const requestBody = JSON.stringify({
                api_key: TAVILY_API_KEY,
                query: query,
                search_depth: searchDepth,
                include_answer: true,          // 包含AI生成的摘要答案
                include_raw_content: false,    // 不需要原始HTML内容
                max_results: Math.max(1, parseInt(maxResults, 10) || 5),
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
                            console.error(' Tavily API错误:', result.error);
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

                        console.log(` Tavily搜索完成，获得 ${searchResults.length} 条结果, ${images.length} 张图片 (响应时间: ${result.responseTime || 'N/A'}s)`);
                        resolve({ results: searchResults, images: images });
                    } catch (parseError) {
                        console.error(' 解析Tavily搜索结果失败:', parseError);
                        console.error('原始响应:', data);
                        resolve([]);
                    }
                });
            });

            req.on('error', (err) => {
                console.error(' Tavily网页搜索请求失败:', err);
                resolve({ results: [], images: [] });
            });

            // 设置超时
            req.setTimeout(15000, () => {
                console.error(' Tavily搜索请求超时');
                req.destroy();
                resolve({ results: [], images: [] });
            });

            // 发送请求
            req.write(requestBody);
            req.end();
        } catch (error) {
            console.error(' Tavily网页搜索异常:', error);
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

    console.log(` 验证 ${imageUrls.length} 张图片URL...`);

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
        console.log(` 图片验证超时，跳过图片`);
        return [];
    }

    const validUrls = results.filter(r => r.isValid).map(r => r.url);
    console.log(` 图片验证完成: ${validUrls.length}/${urlsToCheck.length} 有效`);

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
        .map((r) => ({
            title: r.title || '未知标题',
            url: r.url,
            favicon: r.favicon || '',
            site_name: r.url ? new URL(r.url).hostname.replace('www.', '') : '',
            snippet: r.snippet || '',
            provider: 'tavily',
            sourceKind: 'web',
            markerType: 'numeric',
            label: 'Tavily'
        }));
}

function alphaMarkerFromIndex(index) {
    let current = Number(index || 1);
    let marker = '';
    while (current > 0) {
        const remainder = (current - 1) % 26;
        marker = String.fromCharCode(65 + remainder) + marker;
        current = Math.floor((current - 1) / 26);
    }
    return marker || 'A';
}

function getSourceKind(source = {}) {
    if (source.sourceKind) return source.sourceKind;
    if (source.provider === 'yahoo_finance') return 'finance';
    return 'web';
}

function getSourceIdentityKey(source = {}) {
    return [
        String(source.provider || ''),
        String(source.url || ''),
        String(source.title || ''),
        String(source.symbol || ''),
        String(source.range || ''),
        String(source.interval || '')
    ].join('|');
}

function appendAnnotatedSources(existingSources = [], incomingSources = []) {
    const merged = Array.isArray(existingSources) ? existingSources.map((source) => ({ ...source })) : [];
    const seen = new Set(merged.map(getSourceIdentityKey));

    let webCounter = merged.filter((source) => getSourceKind(source) === 'web').length;
    let financeCounter = merged.filter((source) => getSourceKind(source) === 'finance').length;
    const newlyAdded = [];

    for (const rawSource of (Array.isArray(incomingSources) ? incomingSources : [])) {
        if (!rawSource || typeof rawSource !== 'object') continue;
        const source = { ...rawSource };
        const identityKey = getSourceIdentityKey(source);
        if (seen.has(identityKey)) continue;
        seen.add(identityKey);

        const sourceKind = getSourceKind(source);
        source.sourceKind = sourceKind;
        source.provider = source.provider || (sourceKind === 'finance' ? 'yahoo_finance' : 'tavily');
        source.label = source.label || (sourceKind === 'finance' ? 'Yahoo Finance' : 'Tavily');

        if (sourceKind === 'finance') {
            financeCounter += 1;
            source.markerType = 'alpha';
            source.marker = source.marker || alphaMarkerFromIndex(financeCounter);
            source.index = source.index || financeCounter;
        } else {
            webCounter += 1;
            source.markerType = 'numeric';
            source.marker = source.marker || String(webCounter);
            source.index = source.index || webCounter;
        }

        merged.push(source);
        newlyAdded.push(source);
    }

    return { merged, newlyAdded };
}

function emitSourcesEvent(res, sources = []) {
    if (!res || !Array.isArray(sources) || sources.length === 0) return;
    res.write(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`);
}

function buildFinanceSourceForSSE(financeResult = {}) {
    const resolvedSymbol = financeResult.resolvedSymbol || financeResult.symbol || '';
    if (!resolvedSymbol) return [];

    const titleBase = financeResult.meta?.shortName || financeResult.meta?.longName || resolvedSymbol;
    return [{
        title: `${titleBase} (${resolvedSymbol})`,
        url: `https://finance.yahoo.com/quote/${encodeURIComponent(resolvedSymbol)}`,
        favicon: '',
        site_name: 'finance.yahoo.com',
        provider: 'yahoo_finance',
        sourceKind: 'finance',
        markerType: 'alpha',
        label: 'Yahoo Finance',
        symbol: resolvedSymbol,
        range: financeResult.range || FINANCE_DEFAULT_RANGE,
        interval: financeResult.interval || FINANCE_DEFAULT_INTERVAL,
        delayed: !!financeResult.delayed
    }];
}

function buildToolResultForLLM({ toolName, result, sources = [], args = {} }) {
    if (toolName === 'web_search') {
        return {
            query: args.query || '',
            results: (result?.results || []).map((item) => ({
                title: item.title || '',
                url: item.url || '',
                snippet: item.snippet || ''
            })),
            images: result?.images || [],
            citations: sources.map((source) => ({
                marker: source.marker,
                title: source.title,
                url: source.url,
                snippet: source.snippet || ''
            })),
            citation_instruction: 'When citing these web sources, use numeric markers exactly like [1], [2], [3].'
        };
    }

    if (toolName === 'finance_quote') {
        const financeSource = Array.isArray(sources) ? sources[0] : null;
        return {
            ...result,
            citation_marker: financeSource?.marker || 'A',
            citation_label: financeSource?.label || 'Yahoo Finance',
            citation_instruction: `When citing this market data, use the alpha marker [${financeSource?.marker || 'A'}].`
        };
    }

    return result;
}

/**
 * 带工具定义的API调用 (非流式)
 * 用于工具调用决策阶段
 * @param {Array} messages - 消息数组
 * @param {string} model - 模型名称
 * @param {object} providerConfig - API提供商配置
 * @param {Array} tools - 工具定义数组
 * @returns {Promise<object>} { finish_reason, tool_calls, content }
 */
async function callAPIWithTools(messages, model, providerConfig, tools) {
    console.log(` 调用API (带工具): model=${model}, tools=${tools.length}个`);

    const requestBody = {
        model: model,
        messages: messages,
        tools: tools,
        tool_choice: "auto",
        stream: false,
        max_tokens: 1000
    };

    return new Promise((resolve, reject) => {
        const urlParts = new URL(providerConfig.baseURL);

        const requestLib = urlParts.protocol === 'https:' ? https : require('http');
        const options = {
            hostname: urlParts.hostname,
            port: urlParts.port || (urlParts.protocol === 'https:' ? 443 : 80),
            path: urlParts.pathname + urlParts.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${providerConfig.apiKey}`
            }
        };

        const req = requestLib.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);

                    if (result.error) {
                        console.error(' 工具调用API错误:', result.error);
                        resolve({ finish_reason: 'error', tool_calls: null, content: null });
                        return;
                    }

                    const choice = result.choices?.[0];
                    const response = {
                        finish_reason: choice?.finish_reason,
                        tool_calls: choice?.message?.tool_calls,
                        content: choice?.message?.content,
                        message: choice?.message
                    };

                    console.log(` 工具调用API响应: finish_reason=${response.finish_reason}, has_tool_calls=${!!response.tool_calls}`);
                    resolve(response);
                } catch (e) {
                    console.error(' 解析工具调用响应失败:', e);
                    resolve({ finish_reason: 'error', tool_calls: null, content: null });
                }
            });
        });

        req.on('error', (err) => {
            console.error(' 工具调用请求失败:', err);
            resolve({ finish_reason: 'error', tool_calls: null, content: null });
        });

        req.setTimeout(15000, () => {
            console.warn(' 工具调用请求超时');
            req.destroy();
            resolve({ finish_reason: 'timeout', tool_calls: null, content: null });
        });

        req.write(JSON.stringify(requestBody));
        req.end();
    });
}

function dedupeSources(sources = []) {
    if (!Array.isArray(sources) || sources.length === 0) return [];
    const seen = new Set();
    const deduped = [];
    for (const source of sources) {
        const key = getSourceIdentityKey(source);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(source);
    }
    return deduped;
}

function buildHistoryContext(messages = [], maxCount = 6) {
    return (messages || [])
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .slice(-maxCount)
        .map((m) => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
            return `${m.role === 'user' ? '用户' : '助手'}: ${content}`;
        })
        .join('\n');
}

function createSearchBudget(totalLimit = 8, perTaskLimit = 2) {
    return {
        totalLimit,
        perTaskLimit,
        totalUsed: 0,
        perTaskUsed: {},
        cache: new Map()
    };
}

function normalizeToolCalls(toolCalls = []) {
    const normalized = [];
    for (const toolCall of toolCalls) {
        if (!toolCall || toolCall.type !== 'function' || !toolCall.function?.name) continue;
        let args = {};
        try {
            args = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
            args = {};
        }
        const toolName = String(toolCall.function.name || '').trim();
        if (toolName === 'web_search') {
            const query = String(args.query || '').trim();
            if (!query) continue;
            normalized.push({
                id: toolCall.id || `tool_${Date.now()}_${normalized.length}`,
                type: 'function',
                function: {
                    name: toolName,
                    arguments: JSON.stringify({ query })
                },
                _args: { query }
            });
            continue;
        }

        if (toolName === 'finance_quote') {
            const rawSymbol = String(args.symbol || args.ticker || '').trim();
            if (!rawSymbol) continue;
            let normalizedSymbol;
            try {
                normalizedSymbol = resolveFinanceSymbol(rawSymbol);
            } catch (error) {
                console.warn(` 跳过无效 finance_quote symbol: ${rawSymbol}`);
                continue;
            }

            const normalizedArgs = {
                symbol: normalizedSymbol,
                range: normalizeFinanceRange(args.range || FINANCE_DEFAULT_RANGE),
                interval: normalizeFinanceInterval(args.interval || FINANCE_DEFAULT_INTERVAL)
            };
            normalized.push({
                id: toolCall.id || `tool_${Date.now()}_${normalized.length}`,
                type: 'function',
                function: {
                    name: toolName,
                    arguments: JSON.stringify(normalizedArgs)
                },
                _args: normalizedArgs
            });
        }
    }
    return normalized;
}

async function executeSearchWithBudget({
    query,
    taskKey,
    searchBudget,
    res,
    actualModel,
    thinkingMode
}) {
    const normalizedQuery = String(query || '').trim();
    const cacheKey = normalizedQuery.toLowerCase();
    const safeTaskKey = taskKey || 'global';

    if (!searchBudget.perTaskUsed[safeTaskKey]) {
        searchBudget.perTaskUsed[safeTaskKey] = 0;
    }

    const emitSearchStatus = (payload) => {
        if (!res) return;
        res.write(`data: ${JSON.stringify({
            type: 'search_status',
            ...payload,
            taskId: safeTaskKey
        })}\n\n`);
    };

    if (searchBudget.cache.has(cacheKey)) {
        const cached = searchBudget.cache.get(cacheKey);
        emitSearchStatus({
            status: 'complete',
            query: normalizedQuery,
            resultCount: cached.results?.length || 0,
            message: `缓存命中: ${normalizedQuery}`
        });
        return { result: cached, cached: true, searchCountInc: 0 };
    }

    if (searchBudget.totalUsed >= searchBudget.totalLimit || searchBudget.perTaskUsed[safeTaskKey] >= searchBudget.perTaskLimit) {
        emitSearchStatus({
            status: 'no_results',
            query: normalizedQuery,
            message: '检索预算已用尽，跳过搜索'
        });
        return {
            result: {
                results: [],
                images: [],
                budget_exceeded: true,
                message: 'search budget exceeded'
            },
            cached: false,
            searchCountInc: 0
        };
    }

    emitSearchStatus({
        status: 'searching',
        query: normalizedQuery,
        message: `正在搜索: "${normalizedQuery}"`
    });

    searchBudget.totalUsed += 1;
    searchBudget.perTaskUsed[safeTaskKey] += 1;

    const searchDepth = getTavilySearchDepth(actualModel, thinkingMode);
    const searchResult = await TOOL_EXECUTORS.web_search({ query: normalizedQuery }, searchDepth);
    const normalizedResult = searchResult && searchResult.results
        ? searchResult
        : { results: Array.isArray(searchResult) ? searchResult : [], images: [] };

    searchBudget.cache.set(cacheKey, normalizedResult);
    emitSearchStatus({
        status: 'complete',
        query: normalizedQuery,
        resultCount: normalizedResult.results?.length || 0,
        message: `找到 ${normalizedResult.results?.length || 0} 条结果`
    });

    return {
        result: normalizedResult,
        cached: false,
        searchCountInc: 1
    };
}

async function executeNormalizedToolCall({
    toolCall,
    searchBudget,
    taskKey,
    res,
    actualModel,
    thinkingMode
}) {
    const toolName = toolCall?.function?.name;
    const args = toolCall?._args || {};

    if (toolName === 'web_search') {
        const searchResult = await executeSearchWithBudget({
            query: args.query,
            taskKey,
            searchBudget,
            res,
            actualModel,
            thinkingMode
        });
        return {
            result: searchResult.result,
            sources: extractSourcesForSSE(searchResult.result?.results || []),
            searchCountInc: searchResult.searchCountInc
        };
    }

    if (toolName === 'finance_quote') {
        const financeResult = await TOOL_EXECUTORS.finance_quote(args);
        return {
            result: financeResult,
            sources: buildFinanceSourceForSSE(financeResult),
            searchCountInc: 0
        };
    }

    throw new Error(`不支持的工具: ${toolName}`);
}

async function callK2p5NonStream({
    providerConfig,
    actualModel,
    messages,
    thinkingMode,
    thinkingBudget = 1024,
    internetMode,
    maxTokens,
    maxToolRounds = 2,
    searchBudget,
    taskKey,
    res,
    requestTimeoutMs = 35000
}) {
    let conversationMessages = [...messages];
    let aggregatedSources = [];
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let searchCount = 0;
    let responseContent = '';
    let reasoningContent = '';

    for (let round = 0; round <= maxToolRounds; round += 1) {
        const requestBody = {
            model: actualModel,
            messages: conversationMessages,
            max_tokens: Math.max(256, parseInt(maxTokens, 10) || 2000),
            stream: false
        };
        if (isKimiK25ActualModel(actualModel)) {
            requestBody.enable_thinking = !!thinkingMode;
        } else {
            const budget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
            if (budget !== null) {
                requestBody.thinking_budget = budget;
            }
        }

        if (internetMode) {
            requestBody.tools = TOOL_DEFINITIONS;
            requestBody.tool_choice = 'auto';
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        let apiResponse;
        try {
            apiResponse = await fetch(providerConfig.baseURL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${providerConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`K2.5 非流式调用超时(${requestTimeoutMs}ms)`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }

        if (!apiResponse.ok) {
            const errText = await apiResponse.text();
            throw new Error(`K2.5 非流式调用失败 ${apiResponse.status}: ${errText.substring(0, 300)}`);
        }

        const result = await apiResponse.json();
        const choice = result.choices?.[0] || {};
        const message = choice.message || {};
        const finishReason = choice.finish_reason || 'stop';
        const roundReasoningContent = extractReasoningTextFromPayload(message, choice);

        const currentUsage = normalizeUsage(result.usage);
        totalUsage.prompt_tokens += currentUsage.prompt_tokens;
        totalUsage.completion_tokens += currentUsage.completion_tokens;
        totalUsage.total_tokens += currentUsage.total_tokens;

        if (typeof message.content === 'string') {
            responseContent = message.content;
        }
        if (roundReasoningContent) {
            reasoningContent = roundReasoningContent;
        }

        if (!internetMode || finishReason !== 'tool_calls' || !Array.isArray(message.tool_calls) || round >= maxToolRounds) {
            return {
                content: responseContent,
                reasoningContent,
                sources: dedupeSources(aggregatedSources),
                usage: totalUsage,
                searchCount
            };
        }

        const normalizedCalls = normalizeToolCalls(message.tool_calls);
        if (normalizedCalls.length === 0) {
            return {
                content: responseContent,
                reasoningContent,
                sources: dedupeSources(aggregatedSources),
                usage: totalUsage,
                searchCount
            };
        }

        const executedToolMessages = [];
        for (const toolCall of normalizedCalls) {
            const toolResult = await executeNormalizedToolCall({
                toolCall,
                taskKey,
                searchBudget,
                res,
                actualModel,
                thinkingMode
            });

            searchCount += Number(toolResult.searchCountInc || 0);
            const sourceAppendResult = appendAnnotatedSources(aggregatedSources, toolResult.sources);
            aggregatedSources = sourceAppendResult.merged;
            emitSourcesEvent(res, sourceAppendResult.newlyAdded);

            executedToolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(buildToolResultForLLM({
                    toolName: toolCall.function.name,
                    result: toolResult.result,
                    sources: sourceAppendResult.newlyAdded,
                    args: toolCall._args || {}
                }))
            });
        }

        const assistantToolCallMessage = {
            role: 'assistant',
            content: message.content || null,
            tool_calls: normalizedCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                    name: call.function.name,
                    arguments: call.function.arguments
                }
            }))
        };
        if (thinkingMode) {
            assistantToolCallMessage.reasoning_content = roundReasoningContent || 'Tool call continuation reasoning.';
        }

        conversationMessages = [
            ...conversationMessages,
            assistantToolCallMessage,
            ...executedToolMessages
        ];
    }

    return {
        content: responseContent,
        reasoningContent,
        sources: dedupeSources(aggregatedSources),
        usage: totalUsage,
        searchCount
    };
}

async function callK2p5Stream({
    providerConfig,
    actualModel,
    messages,
    thinkingMode,
    thinkingBudget = 1024,
    internetMode,
    maxTokens,
    maxToolRounds = 2,
    searchBudget,
    taskKey,
    res,
    onContent,
    onReasoning,
    requestTimeoutMs = 45000
}) {
    let conversationMessages = [...messages];
    let aggregatedSources = [];
    let fullContent = '';
    let reasoningContent = '';
    let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let searchCount = 0;

    for (let round = 0; round <= maxToolRounds; round += 1) {
        const requestBody = {
            model: actualModel,
            messages: conversationMessages,
            max_tokens: Math.max(256, parseInt(maxTokens, 10) || 2000),
            stream: true
        };
        if (isKimiK25ActualModel(actualModel)) {
            requestBody.enable_thinking = !!thinkingMode;
        } else {
            const budget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
            if (budget !== null) {
                requestBody.thinking_budget = budget;
            }
        }

        if (internetMode) {
            requestBody.tools = TOOL_DEFINITIONS;
            requestBody.tool_choice = 'auto';
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
        let apiResponse;
        try {
            apiResponse = await fetch(providerConfig.baseURL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${providerConfig.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error(`K2.5 流式调用超时(${requestTimeoutMs}ms)`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }

        if (!apiResponse.ok || !apiResponse.body) {
            const errText = await apiResponse.text();
            throw new Error(`K2.5 流式调用失败 ${apiResponse.status}: ${errText.substring(0, 300)}`);
        }

        const reader = apiResponse.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let finishReason = null;
        const toolCalls = [];
        let roundReasoningContent = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (!trimmed.startsWith('data: ')) continue;

                let parsed;
                try {
                    parsed = JSON.parse(trimmed.slice(6));
                } catch (e) {
                    continue;
                }

                if (parsed.usage) {
                    const chunkUsage = normalizeUsage(parsed.usage);
                    totalUsage.prompt_tokens += chunkUsage.prompt_tokens;
                    totalUsage.completion_tokens += chunkUsage.completion_tokens;
                    totalUsage.total_tokens += chunkUsage.total_tokens;
                }

                const choice = parsed.choices?.[0];
                if (!choice) continue;
                if (choice.finish_reason) finishReason = choice.finish_reason;
                const delta = choice.delta || {};

                const reasoningChunk = extractReasoningTextFromPayload(delta);
                if (reasoningChunk) {
                    reasoningContent += reasoningChunk;
                    roundReasoningContent += reasoningChunk;
                    if (onReasoning) onReasoning(reasoningChunk);
                }

                if (delta.content) {
                    fullContent += delta.content;
                    if (onContent) onContent(delta.content);
                }

                if (Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index || 0;
                        if (!toolCalls[idx]) {
                            toolCalls[idx] = {
                                id: tc.id || `stream_tool_${Date.now()}_${idx}`,
                                type: 'function',
                                function: {
                                    name: tc.function?.name || '',
                                    arguments: ''
                                }
                            };
                        }
                        if (tc.id) toolCalls[idx].id = tc.id;
                        if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
                        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                    }
                }
            }
        }

        const normalizedCalls = normalizeToolCalls(toolCalls);
        if (!internetMode || finishReason !== 'tool_calls' || normalizedCalls.length === 0 || round >= maxToolRounds) {
            return {
                content: fullContent,
                reasoningContent,
                sources: dedupeSources(aggregatedSources),
                usage: totalUsage,
                searchCount
            };
        }

        const executedToolMessages = [];
        for (const toolCall of normalizedCalls) {
            const toolResult = await executeNormalizedToolCall({
                toolCall,
                taskKey,
                searchBudget,
                res,
                actualModel,
                thinkingMode
            });
            searchCount += Number(toolResult.searchCountInc || 0);
            const sourceAppendResult = appendAnnotatedSources(aggregatedSources, toolResult.sources);
            aggregatedSources = sourceAppendResult.merged;
            emitSourcesEvent(res, sourceAppendResult.newlyAdded);
            executedToolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(buildToolResultForLLM({
                    toolName: toolCall.function.name,
                    result: toolResult.result,
                    sources: sourceAppendResult.newlyAdded,
                    args: toolCall._args || {}
                }))
            });
        }

        const assistantToolCallMessage = {
            role: 'assistant',
            content: null,
            tool_calls: normalizedCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                    name: call.function.name,
                    arguments: call.function.arguments
                }
            }))
        };
        if (thinkingMode) {
            assistantToolCallMessage.reasoning_content = roundReasoningContent || 'Tool call continuation reasoning.';
        }

        conversationMessages = [
            ...conversationMessages,
            assistantToolCallMessage,
            ...executedToolMessages
        ];
    }

    return {
        content: fullContent,
        reasoningContent,
        sources: dedupeSources(aggregatedSources),
        usage: totalUsage,
        searchCount
    };
}

function researchModelLabel(modelId = '') {
    const labels = {
        'gemma': 'Gemma',
        'kimi-k2.5': 'Kimi K2.5',
        'gpt-5.5': 'GPT-5.5',
        'deepseek-v3.2-speciale': 'DeepSeek V4 Pro'
    };
    return labels[modelId] || modelId || 'Research Model';
}

function researchRoleFromModel(modelId = '') {
    if (modelId === 'gemma') return 'gemma';
    if (modelId === 'kimi-k2.5') return 'kimi';
    if (modelId === 'gpt-5.5') return 'gpt55';
    if (modelId === 'deepseek-v3.2-speciale') return 'deepseek';
    return 'researcher';
}

function truncateResearchText(text = '', maxLength = 8000) {
    const value = String(text || '').trim();
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}\n\n[内容已截断，保留前 ${maxLength} 字符]`;
}

function normalizeResearchMessageContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === 'string') return part;
            if (typeof part?.text === 'string') return part.text;
            if (typeof part?.content === 'string') return part.content;
            if (part?.type === 'text' && typeof part.text === 'string') return part.text;
            return '';
        }).join('');
    }
    if (content === null || content === undefined) return '';
    return String(content);
}

function buildGeminiResearchPayload({ messages = [], actualModel, maxTokens = 2000 }) {
    const contents = [];
    let systemInstructionText = '';

    for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const text = normalizeResearchMessageContent(msg.content);
        if (!text) continue;

        if (msg.role === 'system') {
            systemInstructionText = systemInstructionText
                ? `${systemInstructionText}\n\n${text}`
                : text;
            continue;
        }

        contents.push({
            role,
            parts: [{ text }]
        });
    }

    const body = {
        contents,
        generationConfig: {
            temperature: 0.35,
            topP: 0.9,
            maxOutputTokens: Math.max(512, Math.min(parseInt(maxTokens, 10) || 2000, 8000))
        }
    };

    if (systemInstructionText) {
        body.systemInstruction = {
            parts: [{ text: systemInstructionText }]
        };
    }

    return {
        apiUrl: `${API_PROVIDERS.google_gemini.baseURL}/${actualModel}:streamGenerateContent?key=${API_PROVIDERS.google_gemini.apiKey}&alt=sse`,
        headers: { 'Content-Type': 'application/json' },
        body
    };
}

function buildResearchRequest({ modelId, messages, stream = false, thinkingMode = true, reasoningProfile = 'mixed', maxTokens = 2000 }) {
    const routing = MODEL_ROUTING[modelId];
    if (!routing) throw new Error(`深度研究模型路由缺失: ${modelId}`);

    const providerConfig = API_PROVIDERS[routing.provider];
    if (!providerConfig?.apiKey) {
        throw new Error(`深度研究模型缺少环境变量: ${providerConfig?.envKey || routing.provider || modelId}`);
    }

    let actualModel = routing.model;
    if (routing.provider === 'deepseek' && thinkingMode && routing.thinkingModel) {
        actualModel = routing.thinkingModel;
    }
    if (modelId === 'deepseek-v3.2-speciale') {
        actualModel = routing.thinkingModel || 'deepseek-v4-pro';
    }
    if ((modelId === 'kimi-k2.5' || modelId === 'kimi-k2') && thinkingMode && routing.thinkingModel) {
        actualModel = routing.thinkingModel;
    }

    if (routing.provider === 'google_gemini' || routing.isGemini || providerConfig.isGemini) {
        const geminiPayload = buildGeminiResearchPayload({ messages, actualModel, maxTokens });
        return {
            routing,
            providerConfig,
            actualModel,
            body: geminiPayload.body,
            apiUrl: geminiPayload.apiUrl,
            headers: geminiPayload.headers,
            isGeminiAPI: true
        };
    }

    const body = {
        model: actualModel,
        messages,
        max_tokens: Math.max(512, Math.min(parseInt(maxTokens, 10) || 2000, 8000)),
        stream: !!stream
    };

    if (routing.provider === 'siliconflow' && isKimiK25ActualModel(actualModel)) {
        body.enable_thinking = !!thinkingMode;
    } else {
        body.temperature = 0.35;
        body.top_p = 0.9;
    }

    if (routing.provider === 'deepseek') {
        applyDeepSeekV4ModeParams(body, !!thinkingMode, reasoningProfile);
    }
    if (routing.provider === 'newapi') {
        applyNewApiModelParams(body, actualModel, !!thinkingMode, reasoningProfile);
    }
    if (routing.provider === 'openrouter') {
        applyOpenRouterReasoningParams(body, actualModel, !!thinkingMode, reasoningProfile);
    }
    if (routing.provider === 'poe') {
        const poeExtraBody = buildPoeExtraBody(modelId, reasoningProfile, !!thinkingMode);
        if (poeExtraBody && Object.keys(poeExtraBody).length > 0) {
            body.extra_body = poeExtraBody;
        }
    }

    return {
        routing,
        providerConfig,
        actualModel,
        body,
        apiUrl: providerConfig.baseURL,
        headers: {
            Authorization: `Bearer ${providerConfig.apiKey}`,
            'Content-Type': 'application/json'
        },
        isGeminiAPI: false
    };
}

async function callResearchModelNonStream({
    modelId,
    messages,
    thinkingMode = true,
    reasoningProfile = 'mixed',
    maxTokens = 1800,
    timeoutMs = 55000
}) {
    const request = buildResearchRequest({
        modelId,
        messages,
        stream: false,
        thinkingMode,
        reasoningProfile,
        maxTokens
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(request.apiUrl || request.providerConfig.baseURL, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`${researchModelLabel(modelId)} 深度研究调用超时(${timeoutMs}ms)`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${researchModelLabel(modelId)} 深度研究调用失败 ${response.status}: ${errorText.substring(0, 260)}`);
    }

    const payload = await response.json();
    const choice = payload?.choices?.[0] || {};
    const message = choice.message || {};
    const rawContent = normalizeResearchMessageContent(message.content || choice.text || '');

    return {
        modelId,
        actualModel: request.actualModel,
        provider: request.routing.provider,
        content: rawContent.trim(),
        reasoningContent: extractReasoningTextFromPayload(message, choice, payload),
        usage: normalizeUsage(payload.usage)
    };
}

async function callResearchModelStream({
    modelId,
    messages,
    thinkingMode = true,
    reasoningProfile = 'mixed',
    maxTokens = 2400,
    timeoutMs = 120000,
    onContent,
    onReasoning
}) {
    const request = buildResearchRequest({
        modelId,
        messages,
        stream: true,
        thinkingMode,
        reasoningProfile,
        maxTokens
    });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(request.apiUrl || request.providerConfig.baseURL, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`${researchModelLabel(modelId)} 主控生成超时(${timeoutMs}ms)`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`${researchModelLabel(modelId)} 主控生成失败 ${response.status}: ${errorText.substring(0, 260)}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let reasoningContent = '';
    let thinkCarry = '';
    let inThink = false;
    const THINK_START = '<think>';
    const THINK_END = '</think>';

    const splitThink = (chunk = '') => {
        let text = thinkCarry + String(chunk || '');
        thinkCarry = '';
        let visible = '';
        let reasoning = '';

        while (text.length > 0) {
            if (inThink) {
                const endIdx = text.indexOf(THINK_END);
                if (endIdx === -1) {
                    const safeLen = Math.max(0, text.length - (THINK_END.length - 1));
                    reasoning += text.slice(0, safeLen);
                    thinkCarry = text.slice(safeLen);
                    return { visible, reasoning };
                }
                reasoning += text.slice(0, endIdx);
                text = text.slice(endIdx + THINK_END.length);
                inThink = false;
                continue;
            }

            const startIdx = text.indexOf(THINK_START);
            if (startIdx === -1) {
                const partialIdx = text.lastIndexOf('<');
                if (partialIdx !== -1 && THINK_START.startsWith(text.slice(partialIdx))) {
                    visible += text.slice(0, partialIdx);
                    thinkCarry = text.slice(partialIdx);
                    return { visible, reasoning };
                }
                visible += text;
                text = '';
                continue;
            }

            visible += text.slice(0, startIdx);
            text = text.slice(startIdx + THINK_START.length);
            inThink = true;
        }

        return { visible, reasoning };
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            const flushed = buffer + decoder.decode();
            buffer = flushed ? `${flushed}\n` : '';
        } else {
            buffer += decoder.decode(value, { stream: true });
        }

        const lines = buffer.split(/\r?\n/);
        buffer = done ? '' : (lines.pop() || '');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            let parsed;
            try {
                parsed = JSON.parse(trimmed.slice(6));
            } catch (error) {
                continue;
            }

            if (parsed?.error) {
                const errMessage = typeof parsed.error === 'string'
                    ? parsed.error
                    : (parsed.error.message || JSON.stringify(parsed.error));
                throw new Error(`${researchModelLabel(modelId)} 主控流式事件错误: ${errMessage}`);
            }

            const eventReasoning = extractReasoningTextFromResponseEvent(parsed);
            if (eventReasoning) {
                reasoningContent += eventReasoning;
                if (onReasoning) onReasoning(eventReasoning);
                continue;
            }

            if (request.isGeminiAPI) {
                const candidate = parsed.candidates?.[0];
                const parts = candidate?.content?.parts || [];
                for (const part of parts) {
                    if (!part?.text) continue;
                    if (part.thought) {
                        const reasoningDelta = extractIncrementalChunk(reasoningContent, part.text);
                        if (reasoningDelta) {
                            reasoningContent += reasoningDelta;
                            if (onReasoning) onReasoning(reasoningDelta);
                        }
                    } else {
                        const visibleDelta = extractIncrementalChunk(content, part.text);
                        if (visibleDelta) {
                            content += visibleDelta;
                            if (onContent) onContent(visibleDelta);
                        }
                    }
                }
                continue;
            }

            const eventContent = extractOutputTextFromResponseEvent(parsed);
            const choice = parsed.choices?.[0] || {};
            const delta = choice.delta || {};
            const reasoning = extractReasoningTextFromPayload(delta);
            const contentChunk = eventContent || normalizeResearchMessageContent(delta.content || '');

            if (reasoning) {
                reasoningContent += reasoning;
                if (onReasoning) onReasoning(reasoning);
            }

            if (contentChunk) {
                const split = splitThink(contentChunk);
                if (split.reasoning) {
                    reasoningContent += split.reasoning;
                    if (onReasoning) onReasoning(split.reasoning);
                }
                if (split.visible) {
                    content += split.visible;
                    if (onContent) onContent(split.visible);
                }
            }
        }

        if (done) break;
    }

    return {
        modelId,
        actualModel: request.actualModel,
        provider: request.routing.provider,
        content,
        reasoningContent
    };
}

function extractResearchDebateStatus(content = '') {
    const text = String(content || '').trim();
    const statusMatch = text.match(/(?:结论状态|状态|status)\s*[：:]\s*([^\n\r]+)/i);
    const statusLine = statusMatch ? statusMatch[1].trim() : '';
    const noIssuePattern = /无重大问题|没有重大问题|无需继续质疑|达成一致|consensus|no\s+(?:blocking|major)\s+issues?/i;
    const hasIssuePattern = /仍有问题|有重大问题|需要修正|未达成一致|blocking\s+issues?|major\s+issues?|needs?\s+revision/i;

    if (statusLine) {
        if (noIssuePattern.test(statusLine)) {
            return { hasBlockingIssue: false, statusLine };
        }
        if (hasIssuePattern.test(statusLine)) {
            return { hasBlockingIssue: true, statusLine };
        }
    }

    if (noIssuePattern.test(text)) {
        return { hasBlockingIssue: false, statusLine: '无重大问题' };
    }

    return { hasBlockingIssue: true, statusLine: statusLine || '未明确' };
}

function buildResearchDiscussionBrief(items = [], maxLengthPerItem = 3200) {
    return items
        .filter((item) => item && item.content)
        .map((item) => `### ${item.label || item.role || '模型'}\n${truncateResearchText(item.content, maxLengthPerItem)}`)
        .join('\n\n');
}

function compactResearchSpeech(content = '', maxChars = 220) {
    const rawText = String(content || '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<\/?think>/gi, '')
        .trim();
    const usefulLines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^(?:结论状态|状态|status)\s*[：:]/i.test(line))
        .map((line) => line.replace(/^(?:发言|观点|结论|speech)\s*[：:]\s*/i, '').trim())
        .filter(Boolean);
    let text = usefulLines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) text = rawText.replace(/\s+/g, ' ').trim();

    const sentenceMatches = text.match(/[^。！？!?\.]+[。！？!?\.]?/g);
    if (sentenceMatches && sentenceMatches.length > 0) {
        text = sentenceMatches.slice(0, 2).join('').trim();
    }
    if (text.length > maxChars) {
        text = `${text.slice(0, maxChars).trim()}...`;
    }
    return text || '我需要更多信息才能判断。';
}

function buildResearchChatTranscript(speeches = [], maxChars = 4200, interjections = []) {
    const speechLines = speeches
        .map((speech) => {
            const status = speech.voteOk ? '无重大问题' : '仍有问题';
            return `第${speech.round}轮 ${speech.label}（${status}）：${speech.speech}`;
        });
    const interjectionLines = interjections
        .map((item) => `用户插话（${item.createdAt || '实时'}）：${item.content}`)
        .filter(Boolean);
    const text = [...speechLines, ...interjectionLines].join('\n');
    return truncateResearchText(text || '(暂无发言)', maxChars);
}

async function runResearchDebateMode({
    res,
    requestId,
    messages,
    userMessage,
    masterModelId,
    researchMode = 'deep',
    debateThinkingMode = true,
    maxDebateRounds = 3,
    reasoningProfile = 'mixed',
    maxTokens = 2400,
    onContent,
    onReasoning,
    onAgentEvent = null
}) {
    const startedAt = Date.now();
    const masterId = (masterModelId === 'deepseek-v3' || masterModelId === 'deepseek-v3.2-speciale')
        ? 'deepseek-v3.2-speciale'
        : 'gpt-5.5';
    const debateMode = normalizeResearchMode(researchMode) === 'fast' ? 'fast' : 'deep';
    const useThinking = debateMode === 'deep' && debateThinkingMode !== false;
    const roundLimit = Math.max(1, Math.min(parseInt(maxDebateRounds, 10) || (debateMode === 'deep' ? 3 : 2), debateMode === 'deep' ? 4 : 3));
    const speechTokenLimit = debateMode === 'deep' ? 520 : 360;
    const totalSpeakers = 4;
    const requiredOkVotes = Math.ceil(totalSpeakers * 0.75);

    const emitResearchEvent = (payload) => {
        emitAgentEvent(res, payload);
        if (typeof onAgentEvent === 'function') {
            try {
                onAgentEvent(payload);
            } catch (error) {
                console.warn(` 记录深度研究事件失败: ${error.message}`);
            }
        }
    };

    const speakers = [
        { agent_id: 1, role: 'gemma', modelId: 'gemma', label: 'Gemma', task: '从常识、表达和边界条件给出判断' },
        { agent_id: 2, role: 'kimi', modelId: 'kimi-k2.5', label: 'Kimi K2.5', task: '提出核心判断或质疑前序发言' },
        { agent_id: 3, role: 'gpt55', modelId: 'gpt-5.5', label: 'GPT-5.5', task: '检查逻辑漏洞并修正结论' },
        { agent_id: 4, role: 'deepseek', modelId: 'deepseek-v3.2-speciale', label: 'DeepSeek V4 Pro', task: '检查事实、前提和反例' }
    ];

    emitResearchEvent({
        type: 'agent_plan',
        mode: 'research_chat_debate',
        researchMode: debateMode,
        discussionRounds: roundLimit,
        stopRule: 'master_decides',
        totalSpeakers,
        masterModel: masterId,
        selectedAgents: speakers.map((speaker) => speaker.role),
        tasks: [
            ...speakers.map((speaker) => ({
            agent_id: speaker.agent_id,
            stepId: `research-${speaker.role}`,
            role: speaker.role,
            task: speaker.task
            })),
            {
                agent_id: 999,
                stepId: 'research-master',
                role: 'master',
                task: `${researchModelLabel(masterId)} 判断是否继续讨论并输出最终正文`
            }
        ]
    });

    const appendInstruction = (baseMessages, instruction) => [
        ...baseMessages,
        {
            role: 'user',
            content: instruction
        }
    ];

    const speeches = [];
    const debateRounds = [];
    const userInterjections = [];
    let masterReadyToAnswer = false;
    let masterDecisionReason = '';

    const collectLiveUserInterjections = (round, beforeRole) => {
        const items = collectRequestInterjections(requestId);
        if (!items.length) return;
        for (const item of items) {
            const record = {
                ...item,
                round,
                beforeRole
            };
            userInterjections.push(record);
            emitResearchEvent({
                type: 'agent_interjection',
                role: 'user',
                round,
                beforeRole,
                detail: `用户插话: ${record.content.slice(0, 120)}`,
                content: record.content,
                createdAt: record.createdAt
            });
        }
    };

    const parseMasterDecision = (raw = '', isLastRound = false) => {
        const text = String(raw || '').trim();
        let payload = null;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                payload = JSON.parse(jsonMatch[0]);
            } catch (error) {
                payload = null;
            }
        }
        const decisionText = String(payload?.decision || payload?.action || text).toLowerCase();
        const ready = /final|answer|generate|stop|无需|不需要|可以回答|生成正文|最终回答/.test(decisionText)
            && !/continue|继续|more|更多/.test(decisionText);
        const continueMore = /continue|继续|more|更多|再讨论|需要继续/.test(decisionText);
        return {
            ready: ready || (isLastRound && !continueMore),
            reason: String(payload?.reason || payload?.rationale || text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
        };
    };

    for (let round = 1; round <= roundLimit; round += 1) {
        const roundResults = [];

        for (const [index, speaker] of speakers.entries()) {
            const stepId = `research-r${round}-${speaker.role}`;
            const taskId = (round - 1) * totalSpeakers + index + 1;
            const stepStartedAt = Date.now();
            collectLiveUserInterjections(round, speaker.role);

            emitResearchEvent({
                type: 'agent_status',
                role: speaker.role,
                scope: 'task',
                stepId,
                taskId,
                status: 'running',
                detail: `${speaker.label} 第${round}轮发言中`
            });

            try {
                let streamedSpeech = '';
                let streamedReasoning = '';
                const speechTask = `第${round}轮发言`;
                emitResearchEvent({
                    type: 'agent_draft_delta',
                    taskId,
                    stepId,
                    role: speaker.role,
                    task: speechTask,
                    speech: true,
                    round,
                    reset: true,
                    delta: ''
                });

                const transcript = buildResearchChatTranscript(speeches, debateMode === 'deep' ? 5200 : 3000, userInterjections);
                const result = await callResearchModelStream({
                    modelId: speaker.modelId,
                    messages: appendInstruction(messages, [
                        `[研究聊天第${round}轮：${speaker.label}]`,
                        `当前研究模式：${debateMode === 'deep' ? '深度研究' : '快速研究'}。`,
                        '你正在一个聊天软件气泡式讨论中发言。你只发言一次，必须短、准、在点上。',
                        '输出必须只有两行：',
                        '第一行必须从下面二选一：结论状态：无重大问题 / 结论状态：仍有问题',
                        '第二行必须写：发言：一句或两句，最多120个中文字符或80个英文单词。',
                        '开放性问题不要用“信息不足”逃避；除非确实缺少关键事实，否则必须基于已知上下文给出有用判断。',
                        '质疑对象只能是此前模型发言，不要质疑用户的问题或用户的新插话。',
                        '如果前面模型有漏洞，要尖锐指出最关键漏洞和修正方向；如果认可，也必须说明还有哪些边界需要收紧，不要空泛附和。',
                        '不要输出给用户的最终正文，不要长篇分点，不要代码块。',
                        '',
                        '用户原问题：',
                        userMessage,
                        '',
                        '此前发言：',
                        transcript
                    ].join('\n')),
                    thinkingMode: useThinking,
                    reasoningProfile,
                    maxTokens: speechTokenLimit,
                    timeoutMs: debateMode === 'deep' ? 65000 : 45000,
                    onContent: (chunk) => {
                        if (!chunk) return;
                        streamedSpeech += chunk;
                        emitResearchEvent({
                            type: 'agent_draft_delta',
                            taskId,
                            stepId,
                            role: speaker.role,
                            task: speechTask,
                            speech: true,
                            round,
                            delta: chunk
                        });
                    },
                    onReasoning: (chunk) => {
                        if (!chunk) return;
                        streamedReasoning += chunk;
                        emitResearchEvent({
                            type: 'agent_draft_delta',
                            taskId,
                            stepId,
                            role: speaker.role,
                            task: speechTask,
                            speech: true,
                            round,
                            reasoningDelta: chunk
                        });
                    }
                });

                const rawContent = truncateResearchText(result.content || streamedSpeech, 1200);
                const reasoningForBubble = truncateResearchText(result.reasoningContent || streamedReasoning, 3000);
                const debateStatus = extractResearchDebateStatus(rawContent);
                const speech = compactResearchSpeech(rawContent, debateMode === 'deep' ? 240 : 180);
                const voteOk = !debateStatus.hasBlockingIssue;
                const speechRecord = {
                    ok: true,
                    modelId: speaker.modelId,
                    role: speaker.role,
                    label: speaker.label,
                    stepId,
                    taskId,
                    round,
                    content: rawContent,
                    speech,
                    voteOk,
                    statusLine: debateStatus.statusLine,
                    reasoningContent: reasoningForBubble,
                    actualModel: result.actualModel,
                    provider: result.provider
                };
                speeches.push(speechRecord);
                roundResults.push(speechRecord);

                emitResearchEvent({
                    type: 'agent_draft',
                    taskId,
                    stepId,
                    role: speaker.role,
                    task: speechTask,
                    speech: true,
                    round,
                    voteOk,
                    statusLine: debateStatus.statusLine,
                    summary: speech,
                    content: speech,
                    rawContent,
                    reasoningContent: reasoningForBubble,
                    usage: result.usage || null,
                    debateRound: round,
                    hasBlockingIssue: debateStatus.hasBlockingIssue
                });
                emitResearchEvent({
                    type: 'agent_status',
                    role: speaker.role,
                    scope: 'task',
                    stepId,
                    taskId,
                    status: 'done',
                    detail: `${speaker.label} ${voteOk ? '完成本轮判断' : '提出需要修正的问题'}`,
                    durationMs: Date.now() - stepStartedAt
                });
            } catch (error) {
                emitResearchEvent({
                    type: 'agent_status',
                    role: speaker.role,
                    scope: 'task',
                    stepId,
                    taskId,
                    status: 'failed',
                    detail: `${speaker.label} 第${round}轮失败: ${error.message}`,
                    durationMs: Date.now() - stepStartedAt
                });
                const failedRecord = {
                    ok: false,
                    modelId: speaker.modelId,
                    role: speaker.role,
                    label: speaker.label,
                    stepId,
                    taskId,
                    content: '',
                    speech: `本轮调用失败：${error.message}`,
                    round,
                    debateRound: round,
                    hasBlockingIssue: true,
                    voteOk: false,
                    error: error.message
                };
                emitResearchEvent({
                    type: 'agent_draft',
                    taskId,
                    stepId,
                    role: speaker.role,
                    task: `第${round}轮发言`,
                    speech: true,
                    round,
                    voteOk: false,
                    statusLine: '结论状态：仍有问题',
                    summary: failedRecord.speech,
                    content: failedRecord.speech,
                    rawContent: failedRecord.speech,
                    debateRound: round,
                    hasBlockingIssue: true
                });
                roundResults.push(failedRecord);
            }
        }

        const successfulRound = roundResults.filter((item) => item.ok && item.speech);
        const okVotes = roundResults.filter((item) => item.ok && item.voteOk !== false && item.hasBlockingIssue !== true).length;
        collectLiveUserInterjections(round, 'master');
        const decisionStartedAt = Date.now();
        let decisionResult = { ready: round >= roundLimit, reason: round >= roundLimit ? '达到讨论轮次上限，进入最终综合。' : '' };
        try {
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: `research-r${round}-master-check`,
                taskId: 900 + round,
                status: 'running',
                detail: `${researchModelLabel(masterId)} 判断是否还需要继续讨论`
            });
            const decisionPrompt = [
                `[研究主控判定第${round}轮]`,
                '你只判断是否还需要更多讨论，不输出给用户的正文。',
                `如果当前 Gemma、Kimi、GPT、DeepSeek 中至少 ${requiredOkVotes}/${totalSpeakers} 个模型认为没有重大问题，且讨论已经足够回答用户，就 decision=final。`,
                '如果存在会明显影响答案的关键漏洞、事实缺口或用户刚插话需要下一位模型吸收，就 decision=continue。',
                '输出严格 JSON：{"decision":"final|continue","reason":"一句话原因"}',
                '',
                '用户原问题：',
                userMessage,
                '',
                '实时讨论记录（含用户插话）：',
                buildResearchChatTranscript(speeches, debateMode === 'deep' ? 7600 : 4400, userInterjections)
            ].join('\n');
            const decisionRaw = await callResearchModelNonStream({
                modelId: masterId,
                messages: appendInstruction(messages, decisionPrompt),
                thinkingMode: false,
                reasoningProfile: 'low',
                maxTokens: 420,
                timeoutMs: debateMode === 'deep' ? 45000 : 30000
            });
            decisionResult = parseMasterDecision(decisionRaw.content, round >= roundLimit);
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: `research-r${round}-master-check`,
                taskId: 900 + round,
                status: 'done',
                detail: decisionResult.ready
                    ? `主控判断无需继续讨论: ${decisionResult.reason}`
                    : `主控判断继续讨论: ${decisionResult.reason}`,
                durationMs: Date.now() - decisionStartedAt
            });
        } catch (error) {
            decisionResult = {
                ready: round >= roundLimit,
                reason: round >= roundLimit
                    ? `主控判定失败且达到上限: ${error.message}`
                    : `主控判定失败，保守继续一轮: ${error.message}`
            };
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: `research-r${round}-master-check`,
                taskId: 900 + round,
                status: decisionResult.ready ? 'done' : 'running',
                detail: decisionResult.reason,
                durationMs: Date.now() - decisionStartedAt
            });
        }

        if (okVotes < requiredOkVotes && round < roundLimit) {
            decisionResult = {
                ready: false,
                reason: `${okVotes}/${totalSpeakers} 个模型认为无重大问题，未达到 ${requiredOkVotes}/${totalSpeakers} 停止条件，继续讨论。`
            };
            emitResearchEvent({
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: `research-r${round}-vote-check`,
                taskId: 950 + round,
                status: 'running',
                detail: decisionResult.reason
            });
        } else if (okVotes < requiredOkVotes && round >= roundLimit) {
            decisionResult = {
                ready: true,
                reason: `${okVotes}/${totalSpeakers} 个模型认为无重大问题；已达到轮次上限，最终回答需保留关键边界。`
            };
        }

        masterReadyToAnswer = decisionResult.ready;
        masterDecisionReason = decisionResult.reason;
        debateRounds.push({
            round,
            results: roundResults,
            okVotes,
            requiredOkVotes,
            masterReadyToAnswer,
            masterDecisionReason
        });

        emitResearchEvent({
            type: 'agent_quality',
            round,
            pass: masterReadyToAnswer,
            metrics: {
                claimCoverage: okVotes,
                totalSpeakers,
                requiredOkVotes,
                stopRule: 'master_decides'
            },
            detail: masterReadyToAnswer
                ? `第${round}轮主控判断无需继续讨论，进入最终回答`
                : `第${round}轮主控判断继续讨论`
        });

        if (masterReadyToAnswer) {
            break;
        }
    }

    if (speeches.length === 0) {
        throw new Error('研究讨论没有任何可用发言，无法继续');
    }

    const critiqueResults = speeches;
    collectLiveUserInterjections(debateRounds.length || roundLimit, 'final');
    const critiqueBrief = buildResearchChatTranscript(speeches, debateMode === 'deep' ? 9000 : 5200, userInterjections);

    const masterStepStartedAt = Date.now();
    emitResearchEvent({
        type: 'agent_status',
        role: 'master',
        scope: 'stage',
        stepId: 'research-master',
        taskId: 999,
        status: 'running',
        detail: `${researchModelLabel(masterId)} 正在根据讨论输出最终回答`
    });

    const masterPrompt = [
        `[深度研究主控: ${researchModelLabel(masterId)}]`,
        `当前研究模式：${debateMode === 'deep' ? '深度研究' : '快速研究'}。`,
        `主控停止原因：${masterReadyToAnswer ? (masterDecisionReason || '主控判断无需继续讨论。') : '已达到讨论轮次上限，需要基于现有讨论保守综合。'}。`,
        '你将基于 Gemma、Kimi K2.5、GPT-5.5、DeepSeek V4 Pro 的聊天式讨论和用户实时插话处理用户问题。',
        '要求：',
        '- 直接回答用户，不要复述“模型A/模型B说了什么”，也不要输出内部判定过程。',
        '- 必须吸收讨论中成立的质疑，修正过度确定、遗漏前提或逻辑跳步。',
        '- 最终主控不要再质疑用户，也不要用质疑口吻；请正经陈述修正后的答案。',
        '- 如果用户的问题信息不足，需要用独立的 rai_ask_user 代码块询问用户；questions 数组没有数量上限。',
        '- 如果使用 rai_ask_user，多问题必须等待用户把所有问题选完并点击发送后再继续。',
        '- 询问用户工具第一行必须精确使用 ```rai_ask_user，不要用 ```json、无语言代码块或普通文本 JSON 代替。',
        '- 使用用户当前语言；保持结构清楚、可执行、不过度冗长。',
        '',
        '用户原问题：',
        userMessage,
        '',
        '聊天式讨论记录：',
        critiqueBrief
    ].join('\n');

    const masterResult = await callResearchModelStream({
        modelId: masterId,
        messages: appendInstruction(messages, masterPrompt),
        thinkingMode: useThinking,
        reasoningProfile,
        maxTokens: debateMode === 'deep'
            ? Math.max(parseInt(maxTokens, 10) || 2400, 1800)
            : Math.max(Math.min(parseInt(maxTokens, 10) || 1800, 2600), 1200),
        timeoutMs: debateMode === 'deep' ? 140000 : 90000,
        onContent: (chunk) => {
            if (onContent) onContent(chunk);
        },
        onReasoning
    });

    emitResearchEvent({
        type: 'agent_status',
        role: 'master',
        scope: 'stage',
        stepId: 'research-master',
        taskId: 999,
        status: 'done',
        detail: '深度研究主控综合完成',
        durationMs: Date.now() - masterStepStartedAt
    });
    emitResearchEvent({
        type: 'agent_metrics',
        mode: 'research_debate',
        researchMode: debateMode,
        durationMs: Date.now() - startedAt,
        successfulAgents: new Set(speeches.filter((item) => item.ok).map((item) => item.role)).size,
        critiqueCount: critiqueResults.filter((item) => item.ok && item.content).length,
        discussionRounds: debateRounds.length,
        stopRule: 'master_decides',
        masterReadyToAnswer,
        masterDecisionReason,
        interjectionCount: userInterjections.length,
        masterModel: masterId
    });

    return {
        content: masterResult.content,
        reasoningContent: [
            ...speeches.map((item) => item.reasoningContent).filter(Boolean),
            masterResult.reasoningContent || ''
        ].join('\n'),
        finalModel: masterId,
        actualModel: masterResult.actualModel,
        provider: masterResult.provider,
        trace: {
            initialResults: speeches.filter((item) => item.round === 1),
            critiqueResults,
            userInterjections,
            debateRounds,
            consensusReached: masterReadyToAnswer,
            stopRule: 'master_decides',
            masterDecisionReason,
            master: {
                modelId: masterId,
                actualModel: masterResult.actualModel,
                provider: masterResult.provider
            }
        }
    };
}

async function runTrueParallelAgentMode({
    res,
    messages,
    userMessage,
    systemPrompt,
    userIdentityInstruction = '',
    domainInstruction = '',
    ruleInstruction = '',
    ruleMeta = null,
    thinkingMode,
    thinkingBudget = 1024,
    internetMode,
    qualityProfile,
    maxTokens,
    agentTraceLevel = 'full',
    onAgentEvent = null
}) {
    const routing = MODEL_ROUTING['kimi-k2.5'];
    if (!routing) throw new Error('K2.5 路由缺失');
    const providerConfig = API_PROVIDERS[routing.provider];
    if (!providerConfig) throw new Error('K2.5 提供商配置缺失');
    if (!providerConfig.apiKey) {
        throw new Error(`缺少环境变量: ${providerConfig.envKey || 'SILICONFLOW_API_KEY'}`);
    }

    const actualModel = routing.model;
    const searchBudget = createSearchBudget(8, 2);
    const historyContext = buildHistoryContext(messages, 6);
    const activeUserIdentityInstruction = String(userIdentityInstruction || '').trim();
    const activeDomainInstruction = String(domainInstruction || '').trim();
    const activeRuleInstruction = String(ruleInstruction || '').trim();
    const mergePromptSections = (...sections) => sections
        .map((section) => String(section || '').trim())
        .filter(Boolean)
        .join('\n\n');
    if (ruleMeta?.ruleId) {
        console.log(` Agent规则注入: ${ruleMeta.ruleId}`);
    }

    res.write(`data: ${JSON.stringify({
        type: 'model_info',
        model: 'kimi-k2.5',
        actualModel,
        reason: 'agent_mode_parallel',
        provider: routing.provider
    })}\n\n`);

    const emitContentChunk = (chunk) => {
        if (!chunk) return;
        res.write(`data: ${JSON.stringify({ type: 'content', content: chunk })}\n\n`);
    };
    const emitReasoningChunk = (chunk) => {
        if (!chunk) return;
        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: chunk })}\n\n`);
    };

    const emitAgentEventWithHook = (payload) => {
        emitAgentEvent(res, payload);
        if (typeof onAgentEvent === 'function') {
            try {
                onAgentEvent(payload);
            } catch (hookError) {
                console.warn(' 记录Agent过程事件失败:', hookError.message);
            }
        }
    };

    const result = await runAgentPipeline({
        userMessage,
        historyMessages: messages,
        internetMode,
        thinkingMode,
        qualityProfile,
        maxSubAgents: 4,
        forceSubAgentCount: 4,
        maxRetries: AGENT_MAX_RETRIES,
        traceLevel: agentTraceLevel,
        emitEvent: emitAgentEventWithHook,
        onContent: emitContentChunk,
        onReasoning: emitReasoningChunk,
        callPlanner: async ({ plannerPrompt, userMessage: inputMessage }) => {
            const plannerSystemPrompt = mergePromptSections(
                plannerPrompt,
                activeUserIdentityInstruction,
                activeDomainInstruction,
                activeRuleInstruction
            );
            const plannerStepId = 'task-0';
            let plannerDraft = '';
            emitAgentEventWithHook({
                type: 'agent_status',
                role: 'planner',
                scope: 'task',
                stepId: plannerStepId,
                taskId: 0,
                status: 'start',
                detail: 'Planning task decomposition'
            });
            emitAgentEventWithHook({
                type: 'agent_draft_delta',
                taskId: 0,
                stepId: plannerStepId,
                role: 'planner',
                task: 'Planning task decomposition',
                reset: true,
                delta: ''
            });
            const plannerMessages = [
                { role: 'system', content: plannerSystemPrompt },
                {
                    role: 'user',
                    content: `用户问题:\n${inputMessage}\n\n最近对话:\n${historyContext || '(无)'}\n\n请严格输出JSON，不要附带任何解释。`
                }
            ];
            const plannerResult = await callK2p5Stream({
                providerConfig,
                actualModel,
                messages: plannerMessages,
                thinkingMode,
                thinkingBudget,
                internetMode: false,
                maxTokens: 1200,
                maxToolRounds: 0,
                searchBudget,
                taskKey: 'planner',
                res,
                onContent: (chunk) => {
                    if (!chunk) return;
                    plannerDraft += chunk;
                    emitAgentEventWithHook({
                        type: 'agent_draft_delta',
                        taskId: 0,
                        stepId: plannerStepId,
                        role: 'planner',
                        task: 'Planning task decomposition',
                        delta: chunk
                    });
                },
                onReasoning: () => { },
                requestTimeoutMs: 20000
            });
            if ((!plannerResult.content || !String(plannerResult.content).trim()) && plannerDraft.trim()) {
                plannerResult.content = plannerDraft;
            }
            const compactPlannerText = String(plannerResult.content || '').replace(/\s+/g, ' ').trim();
            emitAgentEventWithHook({
                type: 'agent_draft',
                stepId: plannerStepId,
                taskId: 0,
                role: 'planner',
                task: 'Planning task decomposition',
                summary: compactPlannerText.length > 80 ? `${compactPlannerText.slice(0, 80)}...` : compactPlannerText,
                content: plannerResult.content || '',
                usage: normalizeUsage(plannerResult.usage),
                searchCount: Number(plannerResult.searchCount || 0)
            });
            emitAgentEventWithHook({
                type: 'agent_status',
                role: 'planner',
                scope: 'task',
                stepId: plannerStepId,
                taskId: 0,
                status: 'done',
                detail: 'Planning task decomposition completed'
            });
            return plannerResult;
        },
        callSubAgent: async ({ task, subPrompt }) => {
            const taskId = Number(task.agent_id || 0) || 0;
            let streamedDraft = '';
            const subAgentSystemPrompt = mergePromptSections(
                subPrompt,
                activeUserIdentityInstruction,
                activeDomainInstruction,
                activeRuleInstruction
            );
            const subMessages = [
                { role: 'system', content: subAgentSystemPrompt },
                { role: 'user', content: '请完成任务并直接输出结果。' }
            ];
            emitAgentEventWithHook({
                type: 'agent_draft_delta',
                taskId,
                stepId: `task-${taskId}`,
                role: task.role || 'custom',
                task: task.task || '',
                reset: true,
                delta: ''
            });

            const subResult = await callK2p5Stream({
                providerConfig,
                actualModel,
                messages: subMessages,
                thinkingMode,
                thinkingBudget,
                internetMode,
                maxTokens: Math.min(Math.max(parseInt(maxTokens, 10) || 2000, 800), 6000),
                maxToolRounds: 2,
                searchBudget,
                taskKey: `task-${task.agent_id || 0}`,
                res,
                onContent: (chunk) => {
                    if (!chunk) return;
                    streamedDraft += chunk;
                    emitAgentEventWithHook({
                        type: 'agent_draft_delta',
                        taskId,
                        stepId: `task-${taskId}`,
                        role: task.role || 'custom',
                        task: task.task || '',
                        delta: chunk
                    });
                },
                onReasoning: () => { },
                requestTimeoutMs: internetMode ? 60000 : 40000
            });
            if ((!subResult.content || !String(subResult.content).trim()) && streamedDraft.trim()) {
                subResult.content = streamedDraft;
            }
            return subResult;
        },
        streamSynthesis: async ({ synthPrompt, userMessage: inputMessage, drafts }) => {
            const draftSummary = drafts.map((d) => `[task-${d.taskId}] ${d.summary}`).join('\n');
            const synthMessages = [];
            let masterDraftDeltaStarted = false;
            const mergedSystemPrompt = mergePromptSections(
                systemPrompt,
                activeUserIdentityInstruction,
                activeDomainInstruction,
                activeRuleInstruction
            );
            if (mergedSystemPrompt) {
                synthMessages.push({
                    role: 'system',
                    content: mergedSystemPrompt
                });
            }
            synthMessages.push({ role: 'system', content: synthPrompt });
            synthMessages.push({
                role: 'user',
                content: `请基于以下草稿给出最终回答:\n${draftSummary}\n\n原问题:\n${inputMessage}`
            });

            return await callK2p5Stream({
                providerConfig,
                actualModel,
                messages: synthMessages,
                thinkingMode,
                thinkingBudget,
                internetMode,
                maxTokens: Math.max(parseInt(maxTokens, 10) || 2000, 1200),
                maxToolRounds: 2,
                searchBudget,
                taskKey: 'synthesis',
                res,
                onContent: (chunk) => {
                    emitContentChunk(chunk);
                    if (!chunk) return;
                    if (!masterDraftDeltaStarted) {
                        masterDraftDeltaStarted = true;
                        emitAgentEventWithHook({
                            type: 'agent_draft_delta',
                            taskId: 999,
                            stepId: 'master-synthesis',
                            role: 'master',
                            task: '主控综合草稿',
                            reset: true,
                            delta: ''
                        });
                    }
                    emitAgentEventWithHook({
                        type: 'agent_draft_delta',
                        taskId: 999,
                        stepId: 'master-synthesis',
                        role: 'master',
                        task: '主控综合草稿',
                        delta: chunk
                    });
                },
                onReasoning: emitReasoningChunk,
                requestTimeoutMs: internetMode ? 75000 : 55000
            });
        },
        runVerifier: ({ qualityProfile, content, sources, fingerprint }) => applyQualityGate({
            qualityProfile,
            content,
            sources,
            fingerprint
        }),
        buildConservativeFallbackNote
    });

    return {
        ...result,
        finalModel: 'kimi-k2.5'
    };
}

// ==================== 多模态内容处理 (OpenAI兼容格式) ====================

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

    //  调试：打印消息结构
    console.log(` 检测消息多模态内容:`, {
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

    //  增强防御性检查：处理 attachments 可能是字符串的情况
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
        console.log(` 发现附件:`, attachments.map(a => ({ type: a.type, fileName: a.fileName })));
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

    console.log(` 检测结果:`, result);
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
 * 将带附件的消息转换为OpenAI兼容多模态格式
 * @param {object} message - 原始消息
 * @returns {object} 转换后的消息
 */
function convertToOmniFormat(message) {
    if (!message || !message.content) return message;

    //  增强防御性检查：确保 attachments 是数组
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
 * 转换消息数组为多模态格式（适配支持多模态的OpenAI兼容模型）
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
        apiKey: ENV_API_KEYS.ALIYUN_API_KEY,
        envKey: 'ALIYUN_API_KEY',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        models: [] // 官方Qwen文本模型已下线
    },
    // Qwen3-Omni-Flash 多模态模型 (支持图片、音频、视频输入和语音输出)
    aliyun_omni: {
        apiKey: ENV_API_KEYS.ALIYUN_API_KEY,
        envKey: 'ALIYUN_API_KEY',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        models: [], // 官方Qwen多模态模型已下线
        multimodal: true,  // 标记支持多模态
        audioOutput: true  // 支持语音输出
    },
    deepseek: {
        apiKey: ENV_API_KEYS.DEEPSEEK_API_KEY,
        envKey: 'DEEPSEEK_API_KEY',
        baseURL: 'https://api.deepseek.com/v1/chat/completions',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro']
    },

    // 硅基流动 SiliconFlow - Kimi K2.5 模型 + Qwen2.5-7B (免费)
    siliconflow: {
        apiKey: ENV_API_KEYS.SILICONFLOW_API_KEY,
        envKey: 'SILICONFLOW_API_KEY',
        baseURL: 'https://api.siliconflow.cn/v1/chat/completions',
        models: ['Pro/moonshotai/Kimi-K2.5', 'moonshotai/Kimi-K2-Instruct-0905', 'Qwen/Qwen2.5-7B-Instruct']
    },
    // Google Generative Language API - Gemini/Gemma models
    google_gemini: {
        apiKey: ENV_API_KEYS.GOOGLE_GEMINI_API_KEY,
        envKey: 'GOOGLE_GEMINI_API_KEY',
        baseURL: GOOGLE_GEMINI_BASE_URL,  // 基础URL，实际使用时会拼接模型名
        models: ['gemini-3-flash-preview', 'gemma-4-31b-it'],
        isGemini: true,  // 标记这是Gemini API，需要特殊处理
        multimodal: true  // 支持图片/视频等多模态输入
    },
    // Poe OpenAI-compatible API
    poe: {
        apiKey: ENV_API_KEYS.POE_API_KEY,
        envKey: 'POE_API_KEY',
        baseURL: 'https://api.poe.com/v1/chat/completions',
        models: Object.values(POE_STATIC_MODEL_MAP)
    },
    // OpenRouter OpenAI-compatible API
    openrouter: {
        apiKey: ENV_API_KEYS.OPENROUTER_API_KEY,
        envKey: 'OPENROUTER_API_KEY',
        baseURL: OPENROUTER_BASE_URL,
        models: [
            'anthropic/claude-sonnet-4.6',
            'anthropic/claude-3-haiku',
            'openai/gpt-oss-120b:free',
            'google/gemma-4-31b-it:free',
            'openrouter/free'
        ]
    },
    // NewAPI OpenAI-compatible gateway
    newapi: {
        apiKey: ENV_API_KEYS.NEWAPI_API_KEY,
        envKey: 'NEWAPI_API_KEY',
        baseURL: NEWAPI_BASE_URL,
        models: ['gpt-5.5', 'grok-4.2']
    }
};

function logApiKeyReadiness() {
    const missing = [];
    const seen = new Set();
    Object.values(API_PROVIDERS).forEach((provider) => {
        if (!provider?.envKey || seen.has(provider.envKey)) return;
        seen.add(provider.envKey);
        if (!provider.apiKey) missing.push(provider.envKey);
    });
    if (!TAVILY_API_KEY) missing.push('TAVILY_API_KEY');

    if (missing.length > 0) {
        console.warn(` 缺少API环境变量: ${missing.join(', ')}`);
    } else {
        console.log(' API环境变量已就绪');
    }
}

logApiKeyReadiness();
startPoeModelSyncJob();

const LEGACY_MODEL_ALIASES = {
    'qwen3-vl': 'kimi-k2.5',
    'deepseek-chat': 'deepseek-v3',
    'deepseek-reasoner': 'deepseek-v3',
    'deepseek-v4-flash': 'deepseek-v3',
    'claude-haiku': 'anthropic/claude-3-haiku',
    'anthropic/claude-3-haiku:beta': 'anthropic/claude-3-haiku'
};

function normalizeIncomingModelId(modelId = 'auto') {
    const normalized = String(modelId || 'auto').trim();
    const aliased = LEGACY_MODEL_ALIASES[normalized] || normalized;
    if (String(aliased).startsWith('x-ai/grok-4.20')) return 'grok-4.2';
    return aliased || 'auto';
}

// 模型路由映射 (支持auto模式)
const MODEL_ROUTING = {
    // 具体模型配置
    // 兼容旧配置：统一映射到免费 7B 文本模型
    'qwen-flash': { provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct' },
    'qwen-plus': { provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct' },
    'qwen-max': { provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct' },
    'deepseek-v3': {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        thinkingModel: 'deepseek-v4-flash'
    },
    'deepseek-v3.2-speciale': {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        thinkingModel: 'deepseek-v4-pro'
    },
    // Kimi K2.5 - 月之暗面高性能模型
    'kimi-k2.5': {
        provider: 'siliconflow',
        model: 'Pro/moonshotai/Kimi-K2.5',
        thinkingModel: 'Pro/moonshotai/Kimi-K2.5',  // K2.5统一模型
        supportsWebSearch: true,
        multimodal: true
    },
    // 兼容旧配置: kimi-k2 自动路由到 K2.5
    'kimi-k2': {
        provider: 'siliconflow',
        model: 'Pro/moonshotai/Kimi-K2.5',
        thinkingModel: 'Pro/moonshotai/Kimi-K2.5',
        supportsWebSearch: true,  // 支持Tavily联网搜索
        multimodal: true
    },
    // Qwen2.5-7B 免费模型
    'qwen2.5-7b': {
        provider: 'siliconflow',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        supportsThinking: false,  // 7B Instruct 不走推理链输出
        supportsWebSearch: true,  // 支持Tavily联网搜索
        multimodal: false         // 文本模型
    },
    // 兼容旧ID：qwen3-8b -> qwen2.5-7b
    'qwen3-8b': {
        provider: 'siliconflow',
        model: 'Qwen/Qwen2.5-7B-Instruct',
        supportsThinking: false,
        supportsWebSearch: true,
        multimodal: false
    },
    // OpenRouter 模型
    'chatgpt-gpt-oss-120b': {
        provider: 'openrouter',
        model: 'openai/gpt-oss-120b:free',
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: false
    },
    'grok-4.2': {
        provider: 'newapi',
        model: 'grok-4.2',
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: false
    },
    'gpt-5.5': {
        provider: 'newapi',
        model: 'gpt-5.5',
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: false
    },
    'claude-haiku': {
        provider: 'openrouter',
        model: 'anthropic/claude-3-haiku',
        fallbackModels: ['anthropic/claude-3-haiku'],
        supportsThinking: false,
        supportsWebSearch: false,
        multimodal: true
    },
    'anthropic/claude-sonnet-4.6': {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4.6',
        fallbackModels: ['anthropic/claude-sonnet-4.6'],
        supportsThinking: false,
        supportsWebSearch: false,
        multimodal: true
    },
    'anthropic/claude-3-haiku': {
        provider: 'openrouter',
        model: 'anthropic/claude-3-haiku',
        fallbackModels: ['anthropic/claude-3-haiku'],
        supportsThinking: false,
        supportsWebSearch: false,
        multimodal: true
    },
    'gemma': {
        provider: 'google_gemini',
        model: 'gemma-4-31b-it',
        isGemini: true,
        supportsThinking: true,
        supportsWebSearch: false,
        multimodal: true,
        contextWindow: 256000,
        maxOutputTokens: 8000
    },
    // Google Gemini 3 Flash - 最智能的速度优化模型（多模态）
    'gemini-3-flash': {
        provider: 'google_gemini',
        model: 'gemini-3-flash-preview',
        isGemini: true,  // 标记需要特殊处理
        multimodal: true,  // 支持图片/视频等多模态输入
        supportsWebSearch: true  // 支持Tavily联网搜索
    },
    // Poe 模型族（静态默认 + 动态同步兜底）
    'poe-claude': {
        provider: 'poe',
        model: POE_STATIC_MODEL_MAP['poe-claude'],
        supportsThinking: true,
        supportsWebSearch: true
    },
    'poe-gpt': {
        provider: 'poe',
        model: POE_STATIC_MODEL_MAP['poe-gpt'],
        supportsThinking: true,
        supportsWebSearch: true
    },
    'poe-grok': {
        provider: 'poe',
        model: POE_STATIC_MODEL_MAP['poe-grok'],
        supportsThinking: true,
        supportsWebSearch: true
    },
    'poe-gemini': {
        provider: 'poe',
        model: POE_STATIC_MODEL_MAP['poe-gemini'],
        supportsThinking: true,
        supportsWebSearch: true
    },
    // 关键修复：将 'auto' 标记为特殊的虚拟路由，表示需要动态选择
    'auto': {
        provider: 'auto',  // 虚拟提供商，表示需要动态决策
        model: 'auto',     // 虚拟模型，表示需要通过智能路由选择
        isAutoMode: true   // 标记这是auto模式
    }
};

const UNIVERSAL_RUNTIME_FALLBACK_MODELS = [
    'chatgpt-gpt-oss-120b',
    'gemma',
    'qwen2.5-7b'
];

function getRuntimeFallbackModelIds(currentModel = '') {
    const current = normalizeIncomingModelId(currentModel);
    return UNIVERSAL_RUNTIME_FALLBACK_MODELS.filter((modelId) => modelId !== current);
}

function findAvailableRuntimeFallbackModelId(currentModel = '') {
    return getRuntimeFallbackModelIds(currentModel).find((modelId) => {
        const route = MODEL_ROUTING[modelId];
        const provider = route ? API_PROVIDERS[route.provider] : null;
        return !!(route && provider?.apiKey);
    }) || null;
}

function resolveFreeFallbackModelId(currentModel = '') {
    return findAvailableRuntimeFallbackModelId(currentModel) || 'qwen2.5-7b';
}


// 创建目录
const dirs = ['uploads', 'avatars', 'database'];
dirs.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(` 已创建目录: ${dir}`);
    }
});

// 数据库初始化
const dbPath = path.join(__dirname, 'ai_data.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error(' 数据库连接失败:', err);
        process.exit(1);
    } else {
        console.log(' 数据库已连接:', dbPath);

        // ==================== SQLite 性能优化 ====================
        db.run("PRAGMA foreign_keys=ON;", (err) => {
            if (err) console.warn(' 外键约束启用失败:', err.message);
            else console.log(' SQLite 外键约束已启用');
        });
        db.run("PRAGMA journal_mode=WAL;", (err) => {
            if (err) console.warn(' WAL模式设置失败:', err.message);
            else console.log(' SQLite WAL模式已启用');
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
    external_provider TEXT,
    external_uid TEXT,
    gpt55_usage_date DATE,
    gpt55_usage_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  )`);

    // 会话表
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新对话',
    model TEXT DEFAULT 'deepseek-v3',
    session_kind TEXT DEFAULT 'chat',
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
    process_trace TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`);

    // 用户配置表
    db.run(`CREATE TABLE IF NOT EXISTS user_configs (
    user_id INTEGER PRIMARY KEY,
    theme TEXT DEFAULT 'light',
    default_model TEXT DEFAULT 'auto',
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

    // ChatFlow 表
    db.run(`CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新 ChatFlow',
    session_id TEXT,
    chat_history TEXT DEFAULT '[]',
    canvas_state TEXT DEFAULT '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS auth_ztx6d_rt (
    rt TEXT PRIMARY KEY,
    return_path TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    bind_user_id INTEGER
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS message_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, message_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS model_visibility (
    model_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_task_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    task_key TEXT NOT NULL,
    points INTEGER NOT NULL DEFAULT 0,
    metadata TEXT,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, task_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

    console.log(' 所有数据表就绪');

    //  数据库迁移：添加缺失的列（如果表已存在且列不存在）
    db.serialize(() => {
        // 添加thinking_mode列（如果不存在）
        db.run(`ALTER TABLE user_configs ADD COLUMN thinking_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加thinking_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加thinking_mode列到user_configs表');
            }
        });

        // 添加internet_mode列（如果不存在）
        db.run(`ALTER TABLE user_configs ADD COLUMN internet_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加internet_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加internet_mode列到user_configs表');
            }
        });

        // 添加model列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN model TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加model列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加model列到messages表');
            }
        });

        // 添加enable_search列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN enable_search INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加enable_search列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加enable_search列到messages表');
            }
        });

        // 添加thinking_mode列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN thinking_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加thinking_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加thinking_mode列到messages表');
            }
        });

        // 添加internet_mode列到messages表（如果不存在）
        db.run(`ALTER TABLE messages ADD COLUMN internet_mode INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加internet_mode列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加internet_mode列到messages表');
            }
        });

        // 添加sources列到messages表（如果不存在）- 存储联网搜索来源信息（JSON格式）
        db.run(`ALTER TABLE messages ADD COLUMN sources TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加sources列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加sources列到messages表');
            }
        });

        // 添加process_trace列到messages表（如果不存在）- 存储Agent过程轨迹（JSON格式）
        db.run(`ALTER TABLE messages ADD COLUMN process_trace TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加process_trace列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加process_trace列到messages表');
            }
        });

        db.run(`ALTER TABLE sessions ADD COLUMN session_kind TEXT DEFAULT 'chat'`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加session_kind列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加session_kind列到sessions表');
            }
        });

        db.run(`ALTER TABLE flows ADD COLUMN session_id TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加session_id列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加session_id列到flows表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN external_provider TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加external_provider列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加external_provider列到users表');
            }
        });

        db.run(`ALTER TABLE users ADD COLUMN external_uid TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加external_uid列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加external_uid列到users表');
            }
        });

        db.run(`ALTER TABLE auth_ztx6d_rt ADD COLUMN bind_user_id INTEGER`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加ZTX6D bind_user_id列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log(' 已添加bind_user_id列到auth_ztx6d_rt表');
            }
        });

        // 创建索引以加速查询
        // 注意：索引方向要与查询一致（ASC）
        db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at ASC, id ASC)`, (err) => {
            if (err) {
                console.warn(` 创建messages索引失败:`, err.message);
            } else {
                console.log(' messages表索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, is_archived, updated_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建sessions索引失败:`, err.message);
            } else {
                console.log(' sessions表索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_kind_updated ON sessions(user_id, session_kind, is_archived, updated_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建sessions(session_kind)索引失败:`, err.message);
            } else {
                console.log(' sessions(session_kind)索引就绪');
            }
        });

        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_identity ON users(external_provider, external_uid) WHERE external_provider IS NOT NULL AND external_uid IS NOT NULL`, (err) => {
            if (err) {
                console.warn(` 创建users外部身份索引失败:`, err.message);
            } else {
                console.log(' users外部身份索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_auth_ztx6d_rt_expires ON auth_ztx6d_rt(expires_at)`, (err) => {
            if (err) {
                console.warn(` 创建ZTX6D rt索引失败:`, err.message);
            } else {
                console.log(' ZTX6D rt索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_message_feedback_created ON message_feedback(created_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建message_feedback时间索引失败:`, err.message);
            } else {
                console.log(' message_feedback时间索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_message_feedback_rating_created ON message_feedback(rating, created_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建message_feedback评分索引失败:`, err.message);
            } else {
                console.log(' message_feedback评分索引就绪');
            }
        });

        db.run(`CREATE INDEX IF NOT EXISTS idx_user_task_rewards_user ON user_task_rewards(user_id, completed_at DESC)`, (err) => {
            if (err) {
                console.warn(` 创建user_task_rewards用户索引失败:`, err.message);
            } else {
                console.log(' user_task_rewards用户索引就绪');
            }
        });

        // ==================== VIP会员系统字段 ====================
        // 会员等级: free / Pro / MAX
        db.run(`ALTER TABLE users ADD COLUMN membership TEXT DEFAULT 'free'`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加membership列失败:`, err.message);
            } else if (!err) {
                console.log(' 已添加membership列到users表');
            }
        });

        // 会员开始时间
        db.run(`ALTER TABLE users ADD COLUMN membership_start DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加membership_start列失败:`, err.message);
            }
        });

        // 会员结束时间
        db.run(`ALTER TABLE users ADD COLUMN membership_end DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加membership_end列失败:`, err.message);
            }
        });

        // 当前点数（每日发放，用完即止）
        db.run(`ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加points列失败:`, err.message);
            } else if (!err) {
                console.log(' 已添加points列到users表');
            }
        });

        // 上次签到日期（free用户签到用）
        db.run(`ALTER TABLE users ADD COLUMN last_checkin DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加last_checkin列失败:`, err.message);
            }
        });

        // 购买的点数（长期有效，2年过期）
        db.run(`ALTER TABLE users ADD COLUMN purchased_points INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加purchased_points列失败:`, err.message);
            }
        });

        // 购买点数过期时间
        db.run(`ALTER TABLE users ADD COLUMN purchased_points_expire DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加purchased_points_expire列失败:`, err.message);
            }
        });

        // 上次每日点数发放日期（Pro/MAX自动发放用）
        db.run(`ALTER TABLE users ADD COLUMN last_daily_grant DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加last_daily_grant列失败:`, err.message);
            }
        });

        // Poe 使用日期（用于 free 每日3次限制）
        db.run(`ALTER TABLE users ADD COLUMN poe_usage_date DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加poe_usage_date列失败:`, err.message);
            }
        });

        // Poe 使用次数（用于 free 每日3次限制）
        db.run(`ALTER TABLE users ADD COLUMN poe_usage_count INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加poe_usage_count列失败:`, err.message);
            }
        });

        // GPT-5.5 限免使用日期（free 每日10次限制）
        db.run(`ALTER TABLE users ADD COLUMN gpt55_usage_date DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加gpt55_usage_date列失败:`, err.message);
            }
        });

        // GPT-5.5 限免使用次数（free 每日10次限制）
        db.run(`ALTER TABLE users ADD COLUMN gpt55_usage_count INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(` 添加gpt55_usage_count列失败:`, err.message);
            }
        });

        console.log(' VIP会员系统字段就绪');
    });
});

function buildAllowedCorsOrigins() {
    const origins = new Set([
        'http://localhost:3009',
        'http://127.0.0.1:3009',
        'http://localhost:3010',
        'http://127.0.0.1:3010',
        'tauri://localhost',
        'http://tauri.localhost',
        'https://tauri.localhost'
    ]);

    for (const raw of [PUBLIC_BASE_URL, process.env.CORS_ORIGINS]) {
        if (!raw) continue;
        for (const value of String(raw).split(',')) {
            const trimmed = value.trim();
            if (!trimmed) continue;
            try {
                origins.add(new URL(trimmed).origin);
            } catch (e) {
                origins.add(trimmed);
            }
        }
    }

    return origins;
}

const allowedCorsOrigins = buildAllowedCorsOrigins();
const jsonParser = express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' });
const chatJsonParser = express.json({ limit: process.env.CHAT_JSON_BODY_LIMIT || '4mb' });

// 中间件配置
app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedCorsOrigins.has(origin)) return callback(null, true);
        return callback(new Error('CORS origin not allowed'));
    },
    credentials: true
}));
app.use((req, res, next) => {
    if (req.path === '/api/chat/stream') {
        return chatJsonParser(req, res, next);
    }
    return jsonParser(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: process.env.URLENCODED_BODY_LIMIT || '1mb' }));
// 静态资源缓存配置（1天 = 86400秒）
const staticCacheOptions = {
    maxAge: '1d',
    etag: true,
    lastModified: true
};

const avatarStaticOptions = {
    ...staticCacheOptions,
    setHeaders(res) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
};

app.use('/avatars', (req, res, next) => {
    const ext = path.extname(req.path).toLowerCase().slice(1);
    if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        return res.status(404).end();
    }
    next();
}, express.static(path.join(__dirname, 'avatars'), avatarStaticOptions));

app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.get('/site.webmanifest', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.type('application/manifest+json');
    res.sendFile(path.join(__dirname, 'public', 'site.webmanifest'));
});

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

const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '管理员登录尝试过多,请稍后再试' }
});

function parseBoundedInteger(value, defaultValue, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return defaultValue;
    return Math.min(Math.max(parsed, min), max);
}

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

const BLOCKED_UPLOAD_EXTENSIONS = new Set([
    'svg', 'html', 'htm', 'js', 'mjs', 'cjs', 'jsx', 'sh', 'bash', 'zsh',
    'ps1', 'bat', 'cmd', 'sql', 'php', 'pl', 'rb', 'exe', 'dll', 'msi',
    'jar', 'com', 'scr', 'vbs', 'wsf'
]);
const AVATAR_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const ATTACHMENT_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'heic', 'heif',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'txt', 'md', 'json', 'xml', 'csv', 'log', 'yaml', 'yml', 'ini', 'conf',
    'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'css', 'scss', 'less',
    'vue', 'svelte', 'swift', 'kt', 'go', 'rs',
    'mp4', 'webm', 'mkv', 'flv', 'wmv', 'avi', 'mov', 'm4v',
    'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'wma', 'opus'
]);

function getUploadExtension(file) {
    return path.extname(file.originalname || '').toLowerCase().slice(1);
}

function validateAvatarUpload(req, file, cb) {
    const ext = getUploadExtension(file);
    if (!AVATAR_EXTENSIONS.has(ext)) {
        return cb(new Error('头像仅支持 jpg/png/webp/gif 图片'));
    }
    if (!/^image\/(jpeg|png|gif|webp)$/i.test(file.mimetype || '')) {
        return cb(new Error('头像 MIME 类型不合法'));
    }
    return cb(null, true);
}

function validateAttachmentUpload(req, file, cb) {
    const ext = getUploadExtension(file);
    if (!ext || BLOCKED_UPLOAD_EXTENSIONS.has(ext) || !ATTACHMENT_EXTENSIONS.has(ext)) {
        return cb(new Error('不支持的文件类型'));
    }
    if (/html|javascript|svg|x-sh|x-msdownload/i.test(file.mimetype || '')) {
        return cb(new Error('不支持的文件类型'));
    }
    return cb(null, true);
}

function runUpload(middleware, req, res, next) {
    middleware(req, res, (err) => {
        if (!err) return next();
        if (err instanceof multer.MulterError) {
            const message = err.code === 'LIMIT_FILE_SIZE' ? '文件大小超过限制' : '文件上传失败';
            return res.status(400).json({ error: message });
        }
        return res.status(400).json({ error: err.message || '文件上传失败' });
    });
}

const avatarUpload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: validateAvatarUpload
});

const attachmentUpload = multer({
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: validateAttachmentUpload
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

app.get('/api/version', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({
        success: true,
        version: PACKAGE_VERSION,
        timestamp: new Date().toISOString()
    });
});

app.get('/api/quote/:symbol', async (req, res) => {
    try {
        const quote = await fetchYahooFinanceQuote({
            symbol: req.params.symbol,
            range: req.query.range || FINANCE_DEFAULT_RANGE,
            interval: req.query.interval || FINANCE_DEFAULT_INTERVAL
        });
        res.json(quote);
    } catch (error) {
        const statusCode = Number(error?.statusCode || 502);
        res.status(statusCode).json({
            error: {
                code: error?.code || 'finance_quote_failed',
                message: error?.message || '获取行情失败',
                details: error?.details || null
            }
        });
    }
});

function isZtx6dEnabled() {
    return !!(ZTX6D_APP_ID && ZTX6D_APP_KEY);
}

function resolvePublicBaseUrl(req) {
    if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, '');
    const protocol = req.protocol || 'https';
    const host = req.get('host') || 'rai.rick.quest';
    return `${protocol}://${host}`;
}

function resolveZtx6dCallbackUrl(req) {
    const publicBase = resolvePublicBaseUrl(req);
    if (ZTX6D_CALLBACK_URL) {
        try {
            const configured = new URL(ZTX6D_CALLBACK_URL);
            const publicUrl = new URL(publicBase);
            const publicPath = publicUrl.pathname.replace(/\/+$/, '');
            const configuredPath = configured.pathname.replace(/\/+$/, '');
            if (publicPath && publicPath !== '/' && configured.origin === publicUrl.origin && !configuredPath.startsWith(`${publicPath}/`)) {
                return `${publicBase}/api/auth/ztx6d/callback`;
            }
        } catch (error) {
            console.warn(` ZTX6D_CALLBACK_URL格式无效，使用PUBLIC_BASE_URL生成回调: ${error.message}`);
            return `${publicBase}/api/auth/ztx6d/callback`;
        }
        return ZTX6D_CALLBACK_URL;
    }
    return `${publicBase}/api/auth/ztx6d/callback`;
}

function normalizeReturnPath(value = '/') {
    const raw = String(value || '/').trim();
    if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
    return raw;
}

function buildClientAuthRedirect(req, returnPath, params = {}) {
    const publicUrl = new URL(resolvePublicBaseUrl(req));
    const basePath = publicUrl.pathname.replace(/\/+$/, '');
    const targetUrl = new URL(normalizeReturnPath(returnPath), `${publicUrl.origin}/`);
    if (basePath && basePath !== '/' && targetUrl.origin === publicUrl.origin && !(targetUrl.pathname === basePath || targetUrl.pathname.startsWith(`${basePath}/`))) {
        targetUrl.pathname = `${basePath}${targetUrl.pathname === '/' ? '/' : targetUrl.pathname}`;
    }
    const url = new URL(targetUrl.toString());
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    });
    return url.toString();
}

async function fetchZtx6dOpenApi(action, payload) {
    const url = new URL(ZTX6D_API_URL);
    url.searchParams.set('action', action);

    const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    let data = null;
    const text = await response.text();
    if (text) {
        try {
            data = JSON.parse(text);
        } catch (error) {
            throw new Error(`ztx6d_invalid_json:${text.substring(0, 160)}`);
        }
    }

    if (!response.ok || data?.error) {
        const code = data?.error || `http_${response.status}`;
        const error = new Error(`ztx6d_${action}_${code}`);
        error.code = code;
        error.statusCode = response.status || 502;
        throw error;
    }

    return data || {};
}

async function cleanupExpiredZtx6dRt() {
    try {
        await dbRunAsync(
            'DELETE FROM auth_ztx6d_rt WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)',
            [Date.now(), Date.now() - 24 * 60 * 60 * 1000]
        );
    } catch (error) {
        console.warn(` ZTX6D rt清理失败: ${error.message}`);
    }
}

async function findOrCreateZtx6dUser(uid) {
    const externalUid = String(uid || '').trim();
    if (!externalUid) {
        throw new Error('missing_ztx6d_uid');
    }

    const provider = 'ztx6d';
    const syntheticEmail = `ztx6d-${externalUid}@passport.ztx6d.local`;
    const username = `ztx6d_${externalUid}`;

    let user = await dbGetAsync(
        'SELECT id, email, username, avatar_url FROM users WHERE external_provider = ? AND external_uid = ?',
        [provider, externalUid]
    );

    if (!user) {
        const existingSyntheticUser = await dbGetAsync(
            'SELECT id, email, username, avatar_url FROM users WHERE email = ?',
            [syntheticEmail]
        );

        if (existingSyntheticUser) {
            await dbRunAsync(
                'UPDATE users SET external_provider = ?, external_uid = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?',
                [provider, externalUid, existingSyntheticUser.id]
            );
            user = { ...existingSyntheticUser, username: existingSyntheticUser.username || username };
        } else {
            const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
            const result = await dbRunAsync(
                'INSERT INTO users (email, password_hash, username, external_provider, external_uid, last_login) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
                [syntheticEmail, passwordHash, username, provider, externalUid]
            );
            await dbRunAsync('INSERT OR IGNORE INTO user_configs (user_id) VALUES (?)', [result.lastID]);
            user = {
                id: result.lastID,
                email: syntheticEmail,
                username,
                avatar_url: null
            };
        }
    } else {
        await dbRunAsync('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
        await dbRunAsync('INSERT OR IGNORE INTO user_configs (user_id) VALUES (?)', [user.id]);
    }

    return user;
}

async function bindZtx6dUser(userId, uid) {
    const targetUserId = Number(userId);
    const externalUid = String(uid || '').trim();
    const provider = 'ztx6d';

    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        const error = new Error('invalid_bind_user');
        error.code = 'user_not_found';
        throw error;
    }

    if (!externalUid) {
        const error = new Error('missing_ztx6d_uid');
        error.code = 'missing_uid';
        throw error;
    }

    const existingBinding = await dbGetAsync(
        'SELECT id, email, username, avatar_url FROM users WHERE external_provider = ? AND external_uid = ?',
        [provider, externalUid]
    );

    if (existingBinding && Number(existingBinding.id) !== targetUserId) {
        const error = new Error('ztx6d_uid_already_bound');
        error.code = 'already_bound';
        throw error;
    }

    const user = await dbGetAsync(
        'SELECT id, email, username, avatar_url, external_provider, external_uid FROM users WHERE id = ?',
        [targetUserId]
    );

    if (!user) {
        const error = new Error('bind_user_not_found');
        error.code = 'user_not_found';
        throw error;
    }

    const currentProvider = String(user.external_provider || '').trim();
    const currentUid = String(user.external_uid || '').trim();
    if (currentProvider && (currentProvider !== provider || currentUid !== externalUid)) {
        const error = new Error('local_user_already_bound');
        error.code = 'user_already_bound';
        throw error;
    }

    await dbRunAsync(
        'UPDATE users SET external_provider = ?, external_uid = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?',
        [provider, externalUid, targetUserId]
    );
    await dbRunAsync('INSERT OR IGNORE INTO user_configs (user_id) VALUES (?)', [targetUserId]);

    return {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar_url: user.avatar_url
    };
}

function redirectZtx6dError(req, returnPath, code) {
    const safeCode = String(code || 'auth_failed').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80);
    return buildClientAuthRedirect(req, returnPath, {
        auth_error: `ztx6d_${safeCode}`
    });
}

app.get('/api/auth/ztx6d/status', (req, res) => {
    res.json({
        success: true,
        enabled: isZtx6dEnabled(),
        provider: 'ztx6d',
        loginUrl: '/api/auth/ztx6d/start',
        bindUrl: '/api/auth/ztx6d/bind/start',
        callbackUrl: resolveZtx6dCallbackUrl(req)
    });
});

app.get('/api/auth/ztx6d/start', authLimiter, async (req, res) => {
    const returnPath = normalizeReturnPath(req.query.return || '/');

    if (!isZtx6dEnabled()) {
        return res.status(503).json({ success: false, error: 'ztx6d_disabled' });
    }

    try {
        await cleanupExpiredZtx6dRt();
        const data = await fetchZtx6dOpenApi('create_rt', {
            appid: Number(ZTX6D_APP_ID),
            appkey: ZTX6D_APP_KEY,
            once: 1
        });
        const rt = String(data?.rt || '').trim();
        if (!rt) {
            return res.status(502).json({ success: false, error: 'ztx6d_missing_rt' });
        }

        await dbRunAsync(
            'INSERT OR REPLACE INTO auth_ztx6d_rt (rt, return_path, created_at, expires_at, consumed_at, bind_user_id) VALUES (?, ?, ?, ?, NULL, NULL)',
            [rt, returnPath, Date.now(), Date.now() + ZTX6D_RT_TTL_MS]
        );

        const loginUrl = new URL(ZTX6D_LOGIN_URL);
        loginUrl.searchParams.set('rt', rt);
        res.redirect(loginUrl.toString());
    } catch (error) {
        console.error(` ZTX6D create_rt失败: ${error.message}`);
        res.status(502).json({ success: false, error: error.code || 'ztx6d_create_rt_failed' });
    }
});

app.post('/api/auth/ztx6d/bind/start', authenticateToken, authLimiter, async (req, res) => {
    const returnPath = normalizeReturnPath(req.body?.return || req.query.return || '/');

    if (!isZtx6dEnabled()) {
        return res.status(503).json({ success: false, error: 'ztx6d_disabled' });
    }

    try {
        await cleanupExpiredZtx6dRt();
        const data = await fetchZtx6dOpenApi('create_rt', {
            appid: Number(ZTX6D_APP_ID),
            appkey: ZTX6D_APP_KEY,
            once: 1
        });
        const rt = String(data?.rt || '').trim();
        if (!rt) {
            return res.status(502).json({ success: false, error: 'ztx6d_missing_rt' });
        }

        await dbRunAsync(
            'INSERT OR REPLACE INTO auth_ztx6d_rt (rt, return_path, created_at, expires_at, consumed_at, bind_user_id) VALUES (?, ?, ?, ?, NULL, ?)',
            [rt, returnPath, Date.now(), Date.now() + ZTX6D_RT_TTL_MS, req.user.userId]
        );

        const loginUrl = new URL(ZTX6D_LOGIN_URL);
        loginUrl.searchParams.set('rt', rt);
        res.json({ success: true, redirectUrl: loginUrl.toString() });
    } catch (error) {
        console.error(` ZTX6D bind create_rt失败: ${error.message}`);
        res.status(502).json({ success: false, error: error.code || 'ztx6d_create_rt_failed' });
    }
});

app.get('/api/auth/ztx6d/callback', authLimiter, async (req, res) => {
    const rt = String(req.query.rt || '').trim();
    let returnPath = '/';

    if (!isZtx6dEnabled()) {
        return res.redirect(redirectZtx6dError(req, returnPath, 'disabled'));
    }

    if (!rt) {
        return res.redirect(redirectZtx6dError(req, returnPath, 'missing_rt'));
    }

    try {
        const pending = await dbGetAsync('SELECT * FROM auth_ztx6d_rt WHERE rt = ?', [rt]);
        returnPath = normalizeReturnPath(pending?.return_path || '/');

        if (!pending || pending.consumed_at || Number(pending.expires_at || 0) < Date.now()) {
            return res.redirect(redirectZtx6dError(req, returnPath, 'invalid_or_expired_rt'));
        }

        const data = await fetchZtx6dOpenApi('get_rt', {
            appid: Number(ZTX6D_APP_ID),
            appkey: ZTX6D_APP_KEY,
            rt
        });

        const uid = data?.uid;
        if (uid === undefined || uid === null || String(uid).trim() === '') {
            return res.redirect(redirectZtx6dError(req, returnPath, 'missing_uid'));
        }

        await dbRunAsync('UPDATE auth_ztx6d_rt SET consumed_at = ? WHERE rt = ?', [Date.now(), rt]);
        const bindUserId = Number(pending.bind_user_id || 0);
        const user = bindUserId > 0
            ? await bindZtx6dUser(bindUserId, uid)
            : await findOrCreateZtx6dUser(uid);
        const token = jwt.sign(
            { userId: user.id, email: user.email, provider: 'ztx6d' },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.redirect(buildClientAuthRedirect(req, returnPath, {
            rai_token: token,
            auth_provider: 'ztx6d'
        }));
    } catch (error) {
        console.error(` ZTX6D callback失败: ${error.message}`);
        res.redirect(redirectZtx6dError(req, returnPath, error.code || 'callback_failed'));
    }
});

// ==================== 认证路由 ====================
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { email, password, username, referrerId, referralCode, ref } = req.body;
        const normalizedReferrerId = normalizeReferralUserId(referrerId || referralCode || ref);

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
                    async function (err) {
                        if (err) {
                            return res.status(500).json({ success: false, error: '注册失败,请重试' });
                        }

                        const userId = this.lastID;
                        console.log(' 用户注册成功, ID:', userId);

                        db.run('INSERT INTO user_configs (user_id) VALUES (?)', [userId]);

                        let inviteReward = null;
                        if (normalizedReferrerId) {
                            try {
                                inviteReward = await awardInviteReferralIfValid(normalizedReferrerId, userId, req);
                                if (inviteReward?.awarded) {
                                    console.log(` 邀请奖励成功: referrer=${normalizedReferrerId}, invited=${userId}, points=${inviteReward.pointsGained}`);
                                }
                            } catch (inviteError) {
                                console.warn(` 邀请奖励失败 referrer=${normalizedReferrerId}, invited=${userId}:`, inviteError.message);
                            }
                        }

                        const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '30d' });

                        res.json({
                            success: true,
                            token,
                            isNewUser: true,
                            inviteReward,
                            user: { id: userId, email, username: finalUsername }
                        });
                    }
                );
            } catch (hashError) {
                return res.status(500).json({ success: false, error: '服务器错误' });
            }
        });
    } catch (error) {
        console.error(' 注册错误:', error);
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

                console.log(' 登录成功, 用户ID:', user.id);

                // 检查是否为新用户（无对话记录）
                db.get('SELECT COUNT(*) as cnt FROM sessions WHERE user_id = ?', [user.id], (sessionErr, sessionRow) => {
                    const isNewUser = !sessionErr && (!sessionRow || sessionRow.cnt === 0);

                    res.json({
                        success: true,
                        token,
                        isNewUser,
                        user: {
                            id: user.id,
                            email: user.email,
                            username: user.username,
                            avatar_url: user.avatar_url
                        }
                    });
                });
            } catch (compareError) {
                return res.status(500).json({ success: false, error: '服务器错误' });
            }
        });
    } catch (error) {
        console.error(' 登录错误:', error);
        res.status(500).json({ success: false, error: '服务器错误' });
    }
});

app.get('/api/auth/verify', authenticateToken, (req, res) => {
    db.get(
        'SELECT id, email, username, avatar_url, external_provider, external_uid FROM users WHERE id = ?',
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
      u.external_provider, u.external_uid,
      COALESCE(c.theme, 'dark') as theme,
      COALESCE(c.default_model, 'auto') as default_model,
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
                console.error(' 获取用户信息失败:', err);
                // 返回默认配置,而不是抛出500错误
                return res.json({
                    id: req.user.userId,
                    email: 'user@example.com',
                    username: 'User',
                    avatar_url: null,
                    external_provider: null,
                    external_uid: null,
                    created_at: new Date().toISOString(),
                    last_login: new Date().toISOString(),
                    theme: 'dark',
                    default_model: 'auto',
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
                console.error(' 用户不存在, ID:', req.user.userId);
                // 同样返回默认配置
                return res.json({
                    id: req.user.userId,
                    email: 'user@example.com',
                    username: 'User',
                    avatar_url: null,
                    external_provider: null,
                    external_uid: null,
                    created_at: new Date().toISOString(),
                    last_login: new Date().toISOString(),
                    theme: 'dark',
                    default_model: 'auto',
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

            //  修复：确保所有字段都有值，特别是system_prompt
            const profile = {
                id: user.id,
                email: user.email || '',
                username: user.username || user.email.split('@')[0],
                avatar_url: user.avatar_url || null,
                external_provider: user.external_provider || null,
                external_uid: user.external_uid || null,
                created_at: user.created_at,
                last_login: user.last_login,
                theme: user.theme || 'dark',
                default_model: user.default_model || 'auto',
                temperature: parseFloat(user.temperature) || 0.7,
                top_p: parseFloat(user.top_p) || 0.9,
                max_tokens: parseInt(user.max_tokens, 10) || 2000,
                frequency_penalty: parseFloat(user.frequency_penalty) || 0,
                presence_penalty: parseFloat(user.presence_penalty) || 0,
                system_prompt: user.system_prompt || '',  //  关键修复：确保始终返回字符串
                thinking_mode: user.thinking_mode || 0,
                internet_mode: user.internet_mode || 0
            };

            console.log(' 返回用户信息, ID:', user.id, 'Username:', profile.username, 'SystemPromptLen:', profile.system_prompt.length);
            res.json(profile);
        }
    );
});

app.put('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
        const rawUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!rawEmail) {
            return res.status(400).json({ success: false, error: '邮箱不能为空' });
        }

        if (!emailRegex.test(rawEmail)) {
            return res.status(400).json({ success: false, error: '邮件格式不正确' });
        }

        if (rawEmail.length > 255) {
            return res.status(400).json({ success: false, error: '邮箱长度不能超过255个字符' });
        }

        if (rawUsername.length > 80) {
            return res.status(400).json({ success: false, error: '用户名不能超过80个字符' });
        }

        const finalUsername = rawUsername || rawEmail.split('@')[0];
        const duplicateUser = await dbGetAsync(
            'SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND id != ?',
            [rawEmail, req.user.userId]
        );

        if (duplicateUser) {
            return res.status(409).json({ success: false, error: '该邮箱已被其他账号使用' });
        }

        await dbRunAsync(
            'UPDATE users SET email = ?, username = ? WHERE id = ?',
            [rawEmail, finalUsername, req.user.userId]
        );

        const updatedUser = await dbGetAsync(
            'SELECT id, email, username, avatar_url, external_provider, external_uid FROM users WHERE id = ?',
            [req.user.userId]
        );

        if (!updatedUser) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        const refreshedToken = jwt.sign(
            { userId: updatedUser.id, email: updatedUser.email },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log(` 用户资料已更新: userId=${updatedUser.id}, email=${updatedUser.email}, username=${updatedUser.username}`);
        res.json({
            success: true,
            token: refreshedToken,
            user: {
                id: updatedUser.id,
                email: updatedUser.email,
                username: updatedUser.username,
                avatar_url: updatedUser.avatar_url || null,
                external_provider: updatedUser.external_provider || null,
                external_uid: updatedUser.external_uid || null
            }
        });
    } catch (error) {
        console.error(' 更新用户资料失败:', error);
        res.status(500).json({ success: false, error: '更新用户资料失败' });
    }
});

app.put('/api/user/password', authenticateToken, async (req, res) => {
    try {
        const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
        const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';

        if (!currentPassword) {
            return res.status(400).json({ success: false, error: '当前密码不能为空' });
        }

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ success: false, error: '新密码至少需要6位' });
        }

        if (newPassword === currentPassword) {
            return res.status(400).json({ success: false, error: '新密码不能与当前密码相同' });
        }

        const user = await dbGetAsync(
            'SELECT id, email, password_hash FROM users WHERE id = ?',
            [req.user.userId]
        );

        if (!user) {
            return res.status(404).json({ success: false, error: '用户不存在' });
        }

        const passwordMatched = await bcrypt.compare(currentPassword, user.password_hash);
        if (!passwordMatched) {
            return res.status(400).json({ success: false, error: '当前密码错误' });
        }

        const nextPasswordHash = await bcrypt.hash(newPassword, 10);
        await dbRunAsync(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            [nextPasswordHash, user.id]
        );

        console.log(` 用户密码已更新: userId=${user.id}, email=${user.email}`);
        res.json({ success: true });
    } catch (error) {
        console.error(' 更新用户密码失败:', error);
        res.status(500).json({ success: false, error: '更新密码失败' });
    }
});

app.put('/api/user/config', authenticateToken, (req, res) => {
    const {
        theme, default_model, temperature, top_p, max_tokens,
        frequency_penalty, presence_penalty, system_prompt,
        thinking_mode, internet_mode
    } = req.body;

    //  防御性检查：确保system_prompt被正确处理
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
            req.user.userId, theme || 'dark', default_model || 'auto',
            temperature || 0.7, top_p || 0.9, max_tokens || 2000,
            frequency_penalty || 0, presence_penalty || 0, finalSystemPrompt,
            thinking_mode ? 1 : 0, internet_mode ? 1 : 0
        ],
        (err) => {
            if (err) {
                console.error(' 保存配置失败:', err);
                return res.status(500).json({ error: '保存失败', details: err.message });
            }
            console.log(` 用户配置已保存: userId=${req.user.userId}, systemPromptLength=${finalSystemPrompt.length}`);
            res.json({ success: true });
        }
    );
});

app.post('/api/user/avatar', authenticateToken, (req, res, next) => runUpload(avatarUpload.single('avatar'), req, res, next), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件上传' });

    const avatarUrl = `/avatars/${req.file.filename}`;
    db.run('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.user.userId], (err) => {
        if (err) {
            console.error(' 更新头像失败:', err);
            return res.status(500).json({ error: '更新失败' });
        }
        res.json({ success: true, avatar_url: avatarUrl });
    });
});

// ==================== 会话管理路由 ====================
app.get('/api/sessions', authenticateToken, async (req, res) => {
    try {
        await ensureSessionKindColumn();

        // 分页参数：offset（偏移量）和 limit（每页数量）
        const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
        const limit = parseBoundedInteger(req.query.limit, 20, 1, 100);

        // 优化：简化查询，移除慢速子查询（message_count, recent_attachments）
        // 只保留 last_message 用于侧边栏预览
        db.all(
            `SELECT s.id, s.title, s.model, s.updated_at, s.created_at,
          (SELECT content FROM messages WHERE session_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1) as last_message,
          (SELECT content FROM messages WHERE session_id = s.id AND role = 'assistant' ORDER BY created_at DESC, id DESC LIMIT 1) as last_assistant_message
        FROM sessions s
        WHERE s.user_id = ? AND s.is_archived = 0 AND COALESCE(s.session_kind, 'chat') = 'chat'
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?`,
            [req.user.userId, limit, offset],
            (err, sessions) => {
                if (err) {
                    console.error(' 获取会话列表失败:', err);
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
    } catch (error) {
        console.error(' 确保sessions表结构失败:', error);
        res.status(500).json({ error: '数据库结构初始化失败' });
    }
});

app.post('/api/sessions', authenticateToken, async (req, res) => {
    try {
        await ensureSessionKindColumn();

        const sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const { title, model, session_kind: sessionKind = 'chat' } = req.body;

        db.run(
            'INSERT INTO sessions (id, user_id, title, model, session_kind) VALUES (?, ?, ?, ?, ?)',
            [sessionId, req.user.userId, title || '新对话', model || 'deepseek-v3', sessionKind || 'chat'],
            (err) => {
                if (err) {
                    console.error(' 创建会话失败:', err);
                    return res.status(500).json({ error: '创建失败' });
                }
                console.log(' 创建会话成功:', sessionId);
                res.json({ success: true, sessionId });
            }
        );
    } catch (error) {
        console.error(' 确保sessions表结构失败:', error);
        res.status(500).json({ error: '数据库结构初始化失败' });
    }
});

app.put('/api/sessions/:id', authenticateToken, (req, res) => {
    const { title, model, is_archived } = req.body;

    db.run(
        'UPDATE sessions SET title = COALESCE(?, title), model = COALESCE(?, model), is_archived = COALESCE(?, is_archived), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [title, model, is_archived, req.params.id, req.user.userId],
        (err) => {
            if (err) {
                console.error(' 更新会话失败:', err);
                return res.status(500).json({ error: '更新失败' });
            }
            res.json({ success: true });
        }
    );
});

app.delete('/api/sessions/:id', authenticateToken, (req, res) => {
    db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId], (err) => {
        if (err) {
            console.error(' 删除会话失败:', err);
            return res.status(500).json({ error: '删除失败' });
        }
        console.log(' 删除会话成功:', req.params.id);
        res.json({ success: true });
    });
});

app.get('/api/sessions/:id/messages', authenticateToken, (req, res) => {
    db.get('SELECT user_id FROM sessions WHERE id = ?', [req.params.id], (err, session) => {
        if (err) {
            console.error(' 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 优化：只查询必要字段，避免加载大的attachments Base64数据
        // 附件数据可以按需加载（懒加载）
        db.all(
            `SELECT id, session_id, role, content, reasoning_content, model, 
                    enable_search, thinking_mode, internet_mode, sources, process_trace, created_at,
                    CASE WHEN attachments IS NOT NULL AND attachments != '' AND attachments != '[]' 
                         THEN 1 ELSE 0 END as has_attachments
             FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`,
            [req.params.id],
            (err, messages) => {
                if (err) {
                    console.error(' 获取消息失败:', err);
                    return res.status(500).json({ error: '数据库错误' });
                }
                res.json(messages);
            }
        );
    });
});

// ==================== ChatFlow API ====================

const FLOW_DEFAULT_CANVAS_STATE = Object.freeze({
    nodes: [],
    edges: [],
    viewport: {
        x: 0,
        y: 0,
        zoom: 1
    }
});

const CANVAS_OPS_START_TOKEN = '[CANVAS_OPS]';
const CANVAS_OPS_END_TOKEN = '[/CANVAS_OPS]';
const TITLE_START_TOKEN = '[TITLE]';
const TITLE_END_TOKEN = '[/TITLE]';
const STRUCTURED_OUTPUT_TOKENS = [
    CANVAS_OPS_START_TOKEN,
    CANVAS_OPS_END_TOKEN,
    TITLE_START_TOKEN,
    TITLE_END_TOKEN
];

function cloneFlowDefaultCanvasState() {
    return JSON.parse(JSON.stringify(FLOW_DEFAULT_CANVAS_STATE));
}

function safeJsonParse(rawValue, fallbackValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return fallbackValue;
    }

    if (typeof rawValue === 'object') {
        return rawValue;
    }

    try {
        return JSON.parse(rawValue);
    } catch (error) {
        return fallbackValue;
    }
}

function normalizeFlowViewport(viewport = {}) {
    const x = Number(viewport?.x);
    const y = Number(viewport?.y);
    const zoom = Number(viewport?.zoom);
    return {
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0,
        zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1
    };
}

function normalizeFlowCanvasNode(node = {}) {
    const normalizedNode = { ...node };

    if (normalizedNode.sourceMessageId !== undefined && normalizedNode.sourceMessageId !== null && normalizedNode.sourceMessageId !== '') {
        const numericMessageId = Number(normalizedNode.sourceMessageId);
        normalizedNode.sourceMessageId = Number.isFinite(numericMessageId) ? numericMessageId : normalizedNode.sourceMessageId;
    } else {
        delete normalizedNode.sourceMessageId;
    }

    if (normalizedNode.sourceIndex !== undefined && normalizedNode.sourceIndex !== null && normalizedNode.sourceIndex !== '') {
        const numericSourceIndex = Number(normalizedNode.sourceIndex);
        normalizedNode.sourceIndex = Number.isFinite(numericSourceIndex) ? numericSourceIndex : normalizedNode.sourceIndex;
    } else {
        delete normalizedNode.sourceIndex;
    }

    return normalizedNode;
}

function normalizeFlowCanvasState(rawCanvasState) {
    const parsedCanvasState = safeJsonParse(rawCanvasState, cloneFlowDefaultCanvasState()) || cloneFlowDefaultCanvasState();
    const viewport = normalizeFlowViewport(parsedCanvasState.viewport || parsedCanvasState.viewPort || {});
    const nodes = Array.isArray(parsedCanvasState.nodes)
        ? parsedCanvasState.nodes.map((node) => normalizeFlowCanvasNode(node)).filter(Boolean)
        : [];
    const edges = Array.isArray(parsedCanvasState.edges)
        ? parsedCanvasState.edges.map((edge) => ({ ...edge })).filter(Boolean)
        : [];

    return {
        nodes,
        edges,
        viewport
    };
}

function normalizeLegacyFlowMessages(rawChatHistory) {
    const parsedChatHistory = safeJsonParse(rawChatHistory, []);
    if (!Array.isArray(parsedChatHistory)) return [];

    return parsedChatHistory
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
        .map((item) => ({
            role: item.role,
            content: typeof item.content === 'string' ? item.content : String(item.content || '')
        }));
}

function trimStructuredTokenPrefix(text = '') {
    let result = String(text || '');
    for (const token of STRUCTURED_OUTPUT_TOKENS) {
        const maxPrefixLength = Math.min(token.length - 1, result.length);
        for (let len = maxPrefixLength; len > 0; len -= 1) {
            if (token.startsWith(result.slice(-len))) {
                result = result.slice(0, -len);
                break;
            }
        }
    }
    return result;
}

function parseCanvasPatchPayload(rawPatchText = '') {
    const raw = String(rawPatchText || '').trim();
    if (!raw) {
        return {
            canvasPatch: null,
            canvasPatchRaw: '',
            canvasPatchParseError: null
        };
    }

    try {
        return {
            canvasPatch: JSON.parse(raw),
            canvasPatchRaw: raw,
            canvasPatchParseError: null
        };
    } catch (error) {
        return {
            canvasPatch: null,
            canvasPatchRaw: raw,
            canvasPatchParseError: error.message
        };
    }
}

function extractLegacyTrailingTitle(text = '') {
    const source = String(text || '').trimEnd();
    const match = source.match(/<{2,3}\s*([^<>\n]{1,40}?)\s*>{2,3}\s*$/);
    if (!match) {
        return {
            title: null,
            cleanContent: source.trim()
        };
    }

    return {
        title: String(match[1] || '').replace(/\s+/g, ' ').trim() || null,
        cleanContent: source.replace(/<{2,3}\s*([^<>\n]{1,40}?)\s*>{2,3}\s*$/, '').trim()
    };
}

function parseStructuredAssistantOutput(rawText = '') {
    const source = String(rawText || '');
    let visibleContent = '';
    let extractedTitle = null;
    let canvasPatchRaw = '';
    let canvasPatch = null;
    let canvasPatchParseError = null;
    let cursor = 0;

    while (cursor < source.length) {
        if (source.startsWith(TITLE_START_TOKEN, cursor)) {
            const titleEnd = source.indexOf(TITLE_END_TOKEN, cursor + TITLE_START_TOKEN.length);
            if (titleEnd === -1) {
                break;
            }
            if (extractedTitle === null) {
                extractedTitle = source.slice(cursor + TITLE_START_TOKEN.length, titleEnd).trim();
            }
            cursor = titleEnd + TITLE_END_TOKEN.length;
            continue;
        }

        if (source.startsWith(CANVAS_OPS_START_TOKEN, cursor)) {
            const patchEnd = source.indexOf(CANVAS_OPS_END_TOKEN, cursor + CANVAS_OPS_START_TOKEN.length);
            if (patchEnd === -1) {
                break;
            }
            if (!canvasPatchRaw) {
                const parsedPatch = parseCanvasPatchPayload(source.slice(cursor + CANVAS_OPS_START_TOKEN.length, patchEnd));
                canvasPatchRaw = parsedPatch.canvasPatchRaw;
                canvasPatch = parsedPatch.canvasPatch;
                canvasPatchParseError = parsedPatch.canvasPatchParseError;
            }
            cursor = patchEnd + CANVAS_OPS_END_TOKEN.length;
            continue;
        }

        visibleContent += source[cursor];
        cursor += 1;
    }

    const legacyTitleResult = extractedTitle ? null : extractLegacyTrailingTitle(visibleContent);
    if (legacyTitleResult?.title) {
        extractedTitle = legacyTitleResult.title;
        visibleContent = legacyTitleResult.cleanContent;
    }

    return {
        visibleContent: trimStructuredTokenPrefix(visibleContent).trimEnd(),
        extractedTitle,
        canvasPatch,
        canvasPatchRaw,
        canvasPatchParseError
    };
}

async function createSessionRecord({ userId, title, model = 'auto', sessionKind = 'chat' }) {
    await ensureSessionKindColumn();
    const sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    await dbRunAsync(
        'INSERT INTO sessions (id, user_id, title, model, session_kind) VALUES (?, ?, ?, ?, ?)',
        [sessionId, userId, title || '新对话', model || 'auto', sessionKind || 'chat']
    );
    return sessionId;
}

async function getSessionMessagesBySessionId(sessionId) {
    return dbAllAsync(
        `SELECT id, session_id, role, content, reasoning_content, model,
                enable_search, thinking_mode, internet_mode, sources, process_trace, created_at,
                CASE WHEN attachments IS NOT NULL AND attachments != '' AND attachments != '[]'
                     THEN 1 ELSE 0 END as has_attachments
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at ASC, id ASC`,
        [sessionId]
    );
}

async function migrateLegacyFlowRow(flowRow, userId) {
    await ensureChatFlowSchemaColumns();
    const sessionId = `session_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const legacyMessages = normalizeLegacyFlowMessages(flowRow.chat_history);
    const normalizedCanvasState = normalizeFlowCanvasState(flowRow.canvas_state);
    const insertedMessageIds = [];

    await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
        await dbRunAsync(
            'INSERT INTO sessions (id, user_id, title, model, session_kind) VALUES (?, ?, ?, ?, ?)',
            [sessionId, userId, flowRow.title || '新 ChatFlow', 'auto', 'flow']
        );

        for (let index = 0; index < legacyMessages.length; index += 1) {
            const legacyMessage = legacyMessages[index];
            const createdAt = new Date(Date.now() + index).toISOString();
            const insertResult = await dbRunAsync(
                'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
                [sessionId, legacyMessage.role, legacyMessage.content, createdAt]
            );
            insertedMessageIds.push(insertResult.lastID);
        }

        const migratedCanvasState = normalizeFlowCanvasState({
            ...normalizedCanvasState,
            nodes: normalizedCanvasState.nodes.map((node) => {
                if ((node.sourceMessageId === undefined || node.sourceMessageId === null || node.sourceMessageId === '') &&
                    Number.isInteger(node.sourceIndex) &&
                    insertedMessageIds[node.sourceIndex]) {
                    return {
                        ...node,
                        sourceMessageId: insertedMessageIds[node.sourceIndex]
                    };
                }
                return node;
            })
        });

        await dbRunAsync(
            'UPDATE flows SET session_id = ?, canvas_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
            [sessionId, JSON.stringify(migratedCanvasState), flowRow.id, userId]
        );

        await dbRunAsync('COMMIT');

        return {
            ...flowRow,
            session_id: sessionId,
            canvas_state: JSON.stringify(migratedCanvasState)
        };
    } catch (error) {
        try {
            await dbRunAsync('ROLLBACK');
        } catch (rollbackError) {
            console.warn(' 回滚旧Flow迁移事务失败:', rollbackError.message);
        }
        throw error;
    }
}

async function ensureFlowRecord(flowId, userId) {
    await ensureChatFlowSchemaColumns();
    let flowRow = await dbGetAsync('SELECT * FROM flows WHERE id = ? AND user_id = ?', [flowId, userId]);
    if (!flowRow) return null;

    if (flowRow.session_id) {
        const linkedSession = await dbGetAsync(
            'SELECT id FROM sessions WHERE id = ? AND user_id = ?',
            [flowRow.session_id, userId]
        );
        if (!linkedSession) {
            flowRow = await migrateLegacyFlowRow(flowRow, userId);
        }
    } else {
        flowRow = await migrateLegacyFlowRow(flowRow, userId);
    }

    const normalizedCanvasState = normalizeFlowCanvasState(flowRow.canvas_state);
    const messages = flowRow.session_id ? await getSessionMessagesBySessionId(flowRow.session_id) : [];

    return {
        ...flowRow,
        canvas_state: normalizedCanvasState,
        chat_history: normalizeLegacyFlowMessages(flowRow.chat_history),
        messages
    };
}

async function syncFlowTitle(flowId, userId, title) {
    await ensureChatFlowSchemaColumns();
    const trimmedTitle = String(title || '').trim();
    if (!trimmedTitle) return null;

    const flowRow = await dbGetAsync('SELECT id, session_id FROM flows WHERE id = ? AND user_id = ?', [flowId, userId]);
    if (!flowRow) return null;

    await dbRunAsync(
        'UPDATE flows SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
        [trimmedTitle, flowId, userId]
    );

    if (flowRow.session_id) {
        await dbRunAsync(
            'UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
            [trimmedTitle, flowRow.session_id, userId]
        );
    }

    return {
        title: trimmedTitle,
        sessionId: flowRow.session_id || null
    };
}

function buildFlowCanvasSystemInstruction({ flowRecord, canvasContext, uiSurface, canvasApplyMode }) {
    if (!flowRecord) return '';

    const normalizedCanvasContext = (() => {
        if (!canvasContext) return null;
        if (typeof canvasContext === 'string') {
            try {
                return JSON.parse(canvasContext);
            } catch (error) {
                return null;
            }
        }
        return canvasContext;
    })();

    const flowTitle = String(flowRecord?.title || '新 ChatFlow').trim() || '新 ChatFlow';
    const mobilePrompt = uiSurface === 'chatflow-mobile'
        ? '\n4. 当前界面是移动端 ChatFlow 浮窗，请优先给出简短、直接、便于继续操作画布的回答。'
        : '';
    const canvasModeHint = canvasApplyMode === 'direct'
        ? '当前用户偏好是直接应用画布修改。'
        : '当前用户偏好是审核后应用画布修改。';
    const serializedContext = normalizedCanvasContext
        ? JSON.stringify(normalizedCanvasContext)
        : JSON.stringify({
            nodes: flowRecord.canvas_state?.nodes || [],
            edges: flowRecord.canvas_state?.edges || [],
            viewport: flowRecord.canvas_state?.viewport || FLOW_DEFAULT_CANVAS_STATE.viewport,
            selectedNodeIds: [],
            flowTitle
        });

    return [
        `当前处于 ChatFlow 专属会话，Flow 标题为「${flowTitle}」。`,
        '你可以结合当前画布上下文回答，但不要把画布上下文原样复述给用户。',
        '如果你认为应该修改画布，请在正常回答之外，追加一个隐藏结构化区块，格式必须严格为：[CANVAS_OPS]{...}[/CANVAS_OPS]。',
        '可用操作仅限：add_node、update_node、delete_node、add_edge、update_edge、delete_edge、auto_layout。',
        '不要输出自由手绘、整张清空或图片节点相关操作。',
        canvasModeHint,
        '标题仍需在回复末尾使用 [TITLE]标题[/TITLE] 生成，标题简短即可。',
        mobilePrompt,
        `当前画布上下文(JSON): ${serializedContext}`
    ].filter(Boolean).join('\n');
}

// 获取用户的 Flow 列表
app.get('/api/flows', authenticateToken, async (req, res) => {
    try {
        await ensureChatFlowSchemaColumns();
        db.all(
            `SELECT f.id, f.title, f.session_id, f.created_at, f.updated_at,
                    (SELECT content FROM messages WHERE session_id = f.session_id ORDER BY created_at DESC, id DESC LIMIT 1) as last_message
             FROM flows f
             WHERE f.user_id = ?
             ORDER BY f.updated_at DESC`,
            [req.user.userId],
            (err, rows) => {
                if (err) {
                    console.error(' 获取Flow列表失败:', err);
                    return res.status(500).json({ error: err.message });
                }
                res.json(rows);
            }
        );
    } catch (error) {
        console.error(' 确保Flow表结构失败:', error);
        res.status(500).json({ error: '数据库结构初始化失败' });
    }
});

// 创建新 Flow
app.post('/api/flows', authenticateToken, async (req, res) => {
    const { title = '新 ChatFlow' } = req.body;
    const id = `flow-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    try {
        await ensureChatFlowSchemaColumns();
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        const sessionId = await createSessionRecord({
            userId: req.user.userId,
            title,
            model: 'auto',
            sessionKind: 'flow'
        });
        await dbRunAsync(
            `INSERT INTO flows (id, user_id, title, session_id) VALUES (?, ?, ?, ?)`,
            [id, req.user.userId, title, sessionId]
        );
        await dbRunAsync('COMMIT');

        console.log(' 创建ChatFlow成功:', id);
        res.json({
            id,
            title,
            session_id: sessionId,
            created_at: new Date().toISOString()
        });
    } catch (error) {
        try {
            await dbRunAsync('ROLLBACK');
        } catch (rollbackError) {
            console.warn(' 回滚创建Flow事务失败:', rollbackError.message);
        }
        console.error(' 创建Flow失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取单个 Flow 详情
app.get('/api/flows/:id', authenticateToken, async (req, res) => {
    try {
        await ensureChatFlowSchemaColumns();
        const flow = await ensureFlowRecord(req.params.id, req.user.userId);
        if (!flow) {
            return res.status(404).json({ error: 'Flow not found' });
        }

        res.json({
            ...flow,
            session_id: flow.session_id || null
        });
    } catch (error) {
        console.error(' 获取Flow详情失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 更新 Flow
app.put('/api/flows/:id', authenticateToken, async (req, res) => {
    const { title, chat_history, canvas_state: canvasStateInput } = req.body;

    try {
        await ensureChatFlowSchemaColumns();
        const currentFlow = await dbGetAsync(
            'SELECT id, user_id, session_id FROM flows WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.userId]
        );
        if (!currentFlow) {
            return res.status(404).json({ error: 'Flow not found' });
        }

        const updates = [];
        const params = [];

        if (title !== undefined) {
            updates.push('title = ?');
            params.push(String(title || '').trim() || '新 ChatFlow');
        }

        if (canvasStateInput !== undefined) {
            updates.push('canvas_state = ?');
            params.push(JSON.stringify(normalizeFlowCanvasState(canvasStateInput)));
        }

        updates.push('updated_at = CURRENT_TIMESTAMP');
        params.push(req.params.id, req.user.userId);

        await dbRunAsync(
            `UPDATE flows SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
            params
        );

        if (title !== undefined && currentFlow.session_id) {
            await dbRunAsync(
                'UPDATE sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?',
                [String(title || '').trim() || '新 ChatFlow', currentFlow.session_id, req.user.userId]
            );
        }

        if (chat_history !== undefined) {
            console.warn(` Flow ${req.params.id} 收到废弃字段 chat_history，已忽略`);
        }

        console.log(' 更新ChatFlow成功:', req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error(' 更新Flow失败:', error);
        res.status(500).json({ error: error.message });
    }
});

// 删除 Flow
app.delete('/api/flows/:id', authenticateToken, async (req, res) => {
    try {
        await ensureChatFlowSchemaColumns();
        const flow = await dbGetAsync(
            'SELECT id, session_id FROM flows WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.userId]
        );
        if (!flow) {
            return res.status(404).json({ error: 'Flow not found' });
        }

        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        await dbRunAsync(
            'DELETE FROM flows WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.userId]
        );
        if (flow.session_id) {
            await dbRunAsync(
                'DELETE FROM sessions WHERE id = ? AND user_id = ? AND COALESCE(session_kind, ?) = ?',
                [flow.session_id, req.user.userId, 'flow', 'flow']
            );
        }
        await dbRunAsync('COMMIT');

        console.log(' 删除ChatFlow成功:', req.params.id);
        res.json({ success: true });
    } catch (error) {
        try {
            await dbRunAsync('ROLLBACK');
        } catch (rollbackError) {
            console.warn(' 回滚删除Flow事务失败:', rollbackError.message);
        }
        console.error(' 删除Flow失败:', error);
        res.status(500).json({ error: error.message });
    }
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
                console.error(' 获取附件失败:', err);
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
            console.error(' 查询会话失败:', err);
            return res.status(500).json({ error: '数据库错误' });
        }

        if (!session || session.user_id !== req.user.userId) {
            return res.status(403).json({ error: '无权访问此会话' });
        }

        // 删除指定消息
        db.run('DELETE FROM messages WHERE id = ? AND session_id = ?', [messageId, sessionId], function (err) {
            if (err) {
                console.error(' 删除消息失败:', err);
                return res.status(500).json({ error: '删除失败' });
            }

            if (this.changes === 0) {
                return res.status(404).json({ error: '消息不存在' });
            }

            console.log(` 已删除消息 ID: ${messageId}`);
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
            console.error(' 查询会话失败:', err);
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
                    console.error(' 更新消息失败:', err);
                    return res.status(500).json({ error: '更新失败' });
                }

                if (this.changes === 0) {
                    return res.status(404).json({ error: '消息不存在' });
                }

                console.log(` 已更新消息 ID: ${messageId}`);
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
            console.error(' 查询会话失败:', err);
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
                            console.error(' 获取消息失败:', err);
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

app.post('/api/upload', authenticateToken, (req, res, next) => runUpload(attachmentUpload.single('file'), req, res, next), (req, res) => {
    if (!req.file) return res.status(400).json({ error: '没有文件上传' });

    const forwardedPrefix = String(req.headers['x-forwarded-prefix'] || '').replace(/\/+$/, '');
    console.log(' 文件上传成功:', req.file.filename);
    res.json({
        success: true,
        file: {
            filename: req.file.filename,
            originalName: req.file.originalname,
            filePath: `${forwardedPrefix}/api/uploads/${req.file.filename}`,
            fileType: req.file.mimetype,
            size: req.file.size
        }
    });
});

app.get('/api/uploads/:filename', authenticateToken, (req, res) => {
    const filename = path.basename(req.params.filename || '');
    if (!filename || filename !== req.params.filename || filename.includes('..')) {
        return res.status(400).json({ error: '无效文件名' });
    }

    const ext = path.extname(filename).toLowerCase().slice(1);
    if (!ATTACHMENT_EXTENSIONS.has(ext) || BLOCKED_UPLOAD_EXTENSIONS.has(ext)) {
        return res.status(404).json({ error: '文件不存在' });
    }

    const filePath = path.join(__dirname, 'uploads', filename);
    if (!filePath.startsWith(path.join(__dirname, 'uploads'))) {
        return res.status(400).json({ error: '无效文件名' });
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(filePath, filename, (err) => {
        if (err && !res.headersSent) {
            res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: '文件下载失败' });
        }
    });
});

const activeRequestInterjections = new Map();

function normalizeStreamingInterjection(value = '') {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .trim()
        .slice(0, 1200);
}

function pushRequestInterjection(requestId, text, userId) {
    const content = normalizeStreamingInterjection(text);
    if (!requestId || !content) return null;
    const item = {
        userId,
        content,
        createdAt: new Date().toISOString()
    };
    const list = activeRequestInterjections.get(requestId) || [];
    list.push(item);
    activeRequestInterjections.set(requestId, list.slice(-20));
    return item;
}

function collectRequestInterjections(requestId) {
    const list = activeRequestInterjections.get(requestId) || [];
    if (list.length > 0) {
        activeRequestInterjections.set(requestId, []);
    }
    return list;
}

//  修复：流式聊天路由
app.post('/api/chat/stream', authenticateToken, apiLimiter, async (req, res) => {
    console.log(' 收到聊天请求');

    let requestId = null;  //  关键修复：在函数开始声明requestId

    try {
        const {
            sessionId: requestedSessionId,
            flowId,
            messages,
            model: requestedModel = 'auto',  // 默认为auto模式
            thinkingMode: thinkingModeInput = false,
            thinkingBudget = 1024,
            internetMode = false,
            agentMode = 'off',
            agentPolicy = AGENT_DEFAULT_POLICY,
            qualityProfile = AGENT_DEFAULT_QUALITY,
            agentTraceLevel = 'full',
            reasoningProfile = 'low',
            researchMode = 'off',
            temperature = 0.7,
            top_p = 0.9,
            max_tokens = 2000,
            frequency_penalty = 0,
            presence_penalty = 0,
            systemPrompt,
            promptTimeContext = null,
            domainMode = '',
            uiLanguage = '',
            canvasContext = null,
            canvasApplyMode = 'review',
            uiSurface = ''
        } = req.body;
        let sessionId = requestedSessionId;
        let flowRecord = null;
        let thinkingMode = !!thinkingModeInput;
        let model = normalizeIncomingModelId(requestedModel);
        let normalizedReasoningProfile = normalizeReasoningProfile(reasoningProfile);
        const normalizedResearchMode = normalizeResearchMode(researchMode);
        const normalizedPromptTimeContext = normalizePromptTimeContext(promptTimeContext);

        if (normalizedResearchMode === 'fast') {
            thinkingMode = false;
        } else if (normalizedResearchMode === 'deep') {
            thinkingMode = true;
            normalizedReasoningProfile = 'mixed';
        }

        console.log(` 接收参数: model=${model}, thinking=${thinkingMode}, internet=${internetMode}, agentMode=${agentMode}, researchMode=${normalizedResearchMode}, policy=${agentPolicy}, quality=${qualityProfile}, trace=${agentTraceLevel}, reasoningProfile=${normalizedReasoningProfile}`);
        if (requestedModel !== model) {
            console.log(` 已将旧模型ID ${requestedModel} 归一化为 ${model}`);
        }

        //  调试：打印收到的消息结构
        console.log(` 收到 ${messages.length} 条消息:`);
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

        if (flowId) {
            flowRecord = await ensureFlowRecord(flowId, req.user.userId);
            if (!flowRecord) {
                return res.status(404).json({ error: 'Flow not found' });
            }
            sessionId = flowRecord.session_id || null;
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

        let promptUserProfile = null;
        try {
            promptUserProfile = await getPromptUserProfile(req.user.userId, req.user.email);
        } catch (promptUserProfileError) {
            console.warn(` 获取Prompt用户信息失败，使用令牌回退: ${promptUserProfileError.message}`);
            promptUserProfile = await getPromptUserProfile(null, req.user.email);
        }
        const userIdentityInstruction = buildUserIdentityPrompt(promptUserProfile);
        if (userIdentityInstruction) {
            console.log(` 已注入当前用户信息到Prompt: userId=${req.user.userId}, hasUsername=${!!promptUserProfile?.username}, hasEmail=${!!promptUserProfile?.email}`);
        }

        if (
            model === 'claude-haiku' ||
            model === 'anthropic/claude-sonnet-4.6' ||
            model === 'anthropic/claude-3-haiku'
        ) {
            const membershipSnapshot = await getUserMembershipSnapshot(req.user.userId);
            const membershipTier = String(membershipSnapshot?.membership || 'free').toLowerCase();
            if (membershipTier !== 'max') {
                return res.status(403).json({ error: '该模型仅 MAX 会员可用' });
            }
        }

        if (model !== 'auto' && await isPublicModelDisabled(model)) {
            console.warn(` 模型 ${model} 已被管理员关闭，回退到智能模型`);
            model = 'auto';
        }

        // 生成请求ID
        requestId = `req_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;

        //  添加活跃请求记录（用于取消机制）
        db.run('INSERT INTO active_requests (id, user_id, session_id) VALUES (?, ?, ?)',
            [requestId, req.user.userId, sessionId || 'anonymous']);

        //  防御性检查：验证 messages 存在且非空
        if (!Array.isArray(messages) || messages.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '消息不能为空' }));
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        //  关键修复：在所有 res.write() 调用之前，先设置 SSE 响应头
        // 这确保后续所有的 res.write() 都能正常工作
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Request-ID', requestId);
        // 注意：X-Model-Used 在后面确定最终模型后再设置
        res.flushHeaders();  // 立即发送头部，开始SSE流

        //  预设答案快速通道：在所有路由逻辑之前检查，确保所有模式都能生效
        const lastUserMsg = messages[messages.length - 1];
        const rawUserContent = typeof lastUserMsg.content === 'string'
            ? lastUserMsg.content
            : JSON.stringify(lastUserMsg.content);
        const userContent = stripInlinePromptTimeHint(rawUserContent);
        const promptContextTrace = buildPromptContextTrace(normalizedPromptTimeContext);

        console.log(` 分析消息: "${userContent.substring(0, 100)}${userContent.length > 100 ? '...' : ''}"`);

        let agentRuntime = {
            enabled: false,
            agentMode: 'off',
            agentPolicy: normalizeAgentPolicy(agentPolicy),
            qualityProfile: normalizeQualityProfile(qualityProfile),
            selectedAgents: [],
            fingerprint: null,
            retriesUsed: 0
        };

        const presetAnswers = {
            '你好': '你好！很高兴见到你 ',
            '谢谢': '不客气！很高兴能帮到你 ',
            '再见': '再见！期待下次与你交谈 ',
            'hello': 'Hello! Nice to meet you!',
            'hi': 'Hi there! How can I help you?',
            'thank you': 'You\'re welcome!',
            'thanks': 'You\'re welcome!',
            'bye': 'Goodbye! See you next time!'
        };

        const trimmedContent = userContent.trim().toLowerCase();
        const presetAnswer = presetAnswers[trimmedContent] || presetAnswers[userContent.trim()]; // 兼容原始大小写

        if (presetAnswer) {
            console.log(`\n 命中预设答案: "${userContent.trim()}" -> 直接返回，无需调用AI`);

            // SSE头已在前面设置，直接发送预设答案
            res.write(`data: ${JSON.stringify({ type: 'content', content: presetAnswer })}\n\n`);
            res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);

            // 保存到数据库
            if (sessionId) {
                console.log('\n 保存预设答案到数据库');

                // 保存用户消息
                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
                        [sessionId, 'user', userContent],
                        (err) => {
                            if (err) console.error(' 保存用户消息失败:', err);
                            else console.log(` 用户消息已保存 (${userContent.length}字符)`);
                            resolve();
                        }
                    );
                });

                // 保存预设答案
                await new Promise((resolve) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content, model, enable_search, thinking_mode, internet_mode, process_trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        [sessionId, 'assistant', presetAnswer, 'preset', 0, 0, 0, promptContextTrace ? JSON.stringify(promptContextTrace) : null],
                        (err) => {
                            if (err) console.error(' 保存预设答案失败:', err);
                            else console.log(` 预设答案已保存 (${presetAnswer.length}字符)`);
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
                            if (err) console.error(' 更新会话时间戳失败:', err);
                            else console.log(' 会话时间戳已更新');
                            resolve();
                        }
                    );
                });
            }

            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            console.log('\n 预设答案处理完成（0成本）\n');
            return;
        }

        const resolvedPromptRule = resolvePromptInjection(userContent);
        const activeRuleInstruction = buildRuleInjectionInstruction(resolvedPromptRule);
        if (resolvedPromptRule) {
            const matched = (resolvedPromptRule.matchedKeywords || []).join(', ');
            console.log(` RULE_HIT id=${resolvedPromptRule.ruleId} matched=[${matched}]`);
            res.write(`data: ${JSON.stringify({
                type: 'rule_injection',
                ruleId: resolvedPromptRule.ruleId,
                matchedKeywords: resolvedPromptRule.matchedKeywords || [],
                appliedStages: normalizeAgentMode(agentMode) === 'on'
                    ? ['planner', 'sub', 'synthesis']
                    : ['single']
            })}\n\n`);
        }

        const resolvedDomainPrompt = resolveDomainSystemPrompt({
            domainMode,
            uiLanguage,
            userMessage: userContent
        });
        const activeDomainInstruction = buildDomainInjectionInstruction(resolvedDomainPrompt);
        if (resolvedDomainPrompt) {
            console.log(` DOMAIN_PROMPT mode=${resolvedDomainPrompt.domainMode} lang=${resolvedDomainPrompt.promptLanguage}`);
            res.write(`data: ${JSON.stringify({
                type: 'domain_injection',
                domainMode: resolvedDomainPrompt.domainMode,
                language: resolvedDomainPrompt.promptLanguage
            })}\n\n`);
        }

        let userMembershipTier = 'free';
        try {
            const membershipStatus = await getUserMembershipSnapshot(req.user.userId);
            userMembershipTier = String(membershipStatus?.membership || 'free');
        } catch (tierErr) {
            console.warn(` 读取会员等级失败，按free处理: ${tierErr.message}`);
            userMembershipTier = 'free';
        }
        const normalizedMembershipTier = String(userMembershipTier || 'free').toLowerCase();
        const normalizedAgentMode = normalizeAgentMode(agentMode);
        let effectiveAgentMode = normalizedAgentMode;
        const agentHardDisabled = process.env.AGENT_HARD_DISABLE === '1';
        let pointsAlreadyDeducted = false;
        let forceFreeModelByQuota = false;
        let gpt55QuotaConsumed = false;

        if (normalizedAgentMode === 'on' && normalizedMembershipTier !== 'max') {
            effectiveAgentMode = 'off';
            emitAgentEvent(res, {
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: 'master',
                status: 'failed',
                detail: '高级研究仅 MAX 会员可用，已自动回退单模型'
            });
            console.warn(` 用户 ${req.user.userId} 非MAX会员，跳过Agent模式`);
        }

        // Agent模式默认走高质量模型，先做点数检查，避免后续失败后再回退
        if (normalizedAgentMode === 'on' && effectiveAgentMode === 'on' && !agentHardDisabled) {
            try {
                const agentPoints = await checkAndDeductPoints(req.user.userId, 'kimi-k2.5');
                if (agentPoints?.useFreeModel) {
                    forceFreeModelByQuota = true;
                    effectiveAgentMode = 'off';
                    res.write(`data: ${JSON.stringify({
                        type: 'points_info',
                        remainingPoints: 0,
                        message: agentPoints.message || '点数不足，已自动切换到免费模型。完成任务或签到可增加积分。'
                    })}\n\n`);
                    emitAgentEvent(res, {
                        type: 'agent_status',
                        role: 'master',
                        scope: 'stage',
                        stepId: 'master',
                        status: 'failed',
                        detail: '点数不足，已自动回退到免费模型路径'
                    });
                    console.warn(` 用户 ${req.user.userId} 点数不足，跳过Agent模式`);
                } else {
                    pointsAlreadyDeducted = Number(agentPoints?.pointsDeducted || 0) > 0;
                    if (pointsAlreadyDeducted) {
                        console.log(` Agent请求已扣点: user=${req.user.userId}, remaining=${agentPoints.remainingPoints}`);
                    }
                }
            } catch (pointsErr) {
                forceFreeModelByQuota = true;
                effectiveAgentMode = 'off';
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'master',
                    status: 'failed',
                    detail: '点数检查失败，已回退免费模型路径'
                });
                console.error(` Agent点数检查失败，回退免费模型: ${pointsErr.message}`);
            }
        }

        if (normalizedAgentMode === 'on') {
            if (agentHardDisabled) {
                console.warn(' AGENT_HARD_DISABLE=1，强制回退单模型路径');
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'master',
                    status: 'failed',
                    detail: '服务端已禁用Agent模式，自动回退单模型'
                });
                effectiveAgentMode = 'off';
            } else if (effectiveAgentMode !== 'on') {
                // 前置点数检查已判定回退，不再进入并行Agent调用
                console.warn(' Agent模式已因点数/策略回退到单模型路径');
            } else {
                try {
                    const agentTraceState = {
                        version: 1,
                        mode: 'agent',
                        policy: normalizeAgentPolicy(agentPolicy),
                        qualityProfile: normalizeQualityProfile(qualityProfile),
                        plan: null,
                        tasks: {},
                        statuses: [],
                        drafts: [],
                        quality: [],
                        retry: [],
                        metrics: null,
                        savedAt: null
                    };

                    const onAgentEvent = (payload) => {
                        const event = payload && typeof payload === 'object' ? payload : null;
                        if (!event || !event.type) return;

                        if (event.type === 'agent_plan') {
                            agentTraceState.plan = event;
                            if (Array.isArray(event.tasks)) {
                                for (const task of event.tasks) {
                                    const taskId = Number(task.agent_id || 0);
                                    if (!taskId) continue;
                                    const stepId = `task-${taskId}`;
                                    agentTraceState.tasks[stepId] = {
                                        stepId,
                                        taskId,
                                        role: task.role || 'custom',
                                        status: 'pending',
                                        detail: task.task || '',
                                        durationMs: null
                                    };
                                }
                            }
                            return;
                        }

                        if (event.type === 'agent_status') {
                            const statusEvent = {
                                type: event.type,
                                scope: event.scope || 'stage',
                                stepId: event.stepId || '',
                                taskId: event.taskId || null,
                                role: event.role || '',
                                status: event.status || 'pending',
                                detail: event.detail || '',
                                durationMs: event.durationMs || null,
                                ts: Date.now()
                            };
                            agentTraceState.statuses.push(statusEvent);
                            if (agentTraceState.statuses.length > 400) {
                                agentTraceState.statuses = agentTraceState.statuses.slice(-400);
                            }

                            const isTask = statusEvent.scope === 'task' || (statusEvent.stepId && statusEvent.stepId.startsWith('task-'));
                            if (isTask) {
                                const stepId = statusEvent.stepId || `task-${statusEvent.taskId || 0}`;
                                const prev = agentTraceState.tasks[stepId] || {};
                                agentTraceState.tasks[stepId] = {
                                    ...prev,
                                    stepId,
                                    taskId: statusEvent.taskId || prev.taskId || null,
                                    role: statusEvent.role || prev.role || 'custom',
                                    status: statusEvent.status || prev.status || 'pending',
                                    detail: statusEvent.detail || prev.detail || '',
                                    durationMs: statusEvent.durationMs != null ? statusEvent.durationMs : (prev.durationMs || null)
                                };
                            }
                            return;
                        }

                        if (event.type === 'agent_draft') {
                            agentTraceState.drafts.push(event);
                            if (agentTraceState.drafts.length > 20) {
                                agentTraceState.drafts = agentTraceState.drafts.slice(-20);
                            }
                            return;
                        }

                        if (event.type === 'agent_draft_delta') {
                            if (!Array.isArray(agentTraceState.draftDeltas)) {
                                agentTraceState.draftDeltas = [];
                            }
                            agentTraceState.draftDeltas.push({
                                taskId: event.taskId || null,
                                stepId: event.stepId || '',
                                role: event.role || '',
                                task: event.task || '',
                                reset: !!event.reset,
                                delta: String(event.delta || ''),
                                ts: Date.now()
                            });
                            if (agentTraceState.draftDeltas.length > 800) {
                                agentTraceState.draftDeltas = agentTraceState.draftDeltas.slice(-800);
                            }
                            return;
                        }

                        if (event.type === 'agent_quality') {
                            agentTraceState.quality.push(event);
                            if (agentTraceState.quality.length > 20) {
                                agentTraceState.quality = agentTraceState.quality.slice(-20);
                            }
                            return;
                        }

                        if (event.type === 'agent_retry') {
                            agentTraceState.retry.push(event);
                            if (agentTraceState.retry.length > 20) {
                                agentTraceState.retry = agentTraceState.retry.slice(-20);
                            }
                            return;
                        }

                        if (event.type === 'agent_metrics') {
                            agentTraceState.metrics = event;
                        }
                    };

                    console.log('\n 启用真并行 Multi-Agent 模式 (K2.5)\n');
                    const agentResult = await runTrueParallelAgentMode({
                        res,
                        messages,
                        userMessage: userContent,
                        systemPrompt,
                        userIdentityInstruction,
                        domainInstruction: activeDomainInstruction,
                        ruleInstruction: activeRuleInstruction,
                        ruleMeta: resolvedPromptRule
                            ? {
                                ruleId: resolvedPromptRule.ruleId,
                                matchedKeywords: resolvedPromptRule.matchedKeywords || []
                            }
                            : null,
                        thinkingMode,
                        thinkingBudget,
                        internetMode,
                        qualityProfile,
                        maxTokens: max_tokens,
                        agentTraceLevel,
                        onAgentEvent
                    });

                    let contentToSave = String(agentResult?.content || '').trim();
                    contentToSave = contentToSave
                        .replace(/<\|[^|]+\|>/g, '')
                        .replace(/functions\.\w+:\d+/g, '')
                        .trim();
                    const reasoningToSave = String(agentResult?.reasoningContent || '').trim();
                    const searchSources = dedupeSources(Array.isArray(agentResult?.sources) ? agentResult.sources : []);
                    const finalModel = agentResult?.finalModel || 'kimi-k2.5';
                    agentTraceState.savedAt = new Date().toISOString();
                    const processTraceJson = JSON.stringify({
                        version: agentTraceState.version,
                        mode: agentTraceState.mode,
                        policy: agentTraceState.policy,
                        qualityProfile: agentTraceState.qualityProfile,
                        plan: agentTraceState.plan,
                        tasks: Object.values(agentTraceState.tasks || {}).sort((a, b) => Number(a.taskId || 0) - Number(b.taskId || 0)),
                        statuses: agentTraceState.statuses,
                        drafts: agentTraceState.drafts,
                        quality: agentTraceState.quality,
                        retry: agentTraceState.retry,
                        metrics: agentTraceState.metrics,
                        draftDeltas: agentTraceState.draftDeltas || [],
                        savedAt: agentTraceState.savedAt,
                        prompt_context: promptContextTrace?.prompt_context || null
                    });
                    const structuredAgentOutput = parseStructuredAssistantOutput(contentToSave);
                    contentToSave = structuredAgentOutput.visibleContent || contentToSave;
                    const extractedTitle = structuredAgentOutput.extractedTitle || null;

                    if (sessionId) {
                        console.log('\n 保存真并行 Agent 结果到数据库');

                        const lastUserMessage = messages[messages.length - 1];
                        if (lastUserMessage && lastUserMessage.role === 'user') {
                            const lastUserContent = typeof lastUserMessage.content === 'string'
                                ? lastUserMessage.content
                                : JSON.stringify(lastUserMessage.content);

                            let attachmentsJson = null;
                            if (Array.isArray(lastUserMessage.attachments) && lastUserMessage.attachments.length > 0) {
                                const previewAttachments = lastUserMessage.attachments.map(att => {
                                    if (att.type === 'image' && att.data) {
                                        return {
                                            type: 'image',
                                            fileName: att.fileName,
                                            data: att.data
                                        };
                                    }
                                    return {
                                        type: att.type,
                                        fileName: att.fileName
                                    };
                                });
                                attachmentsJson = JSON.stringify(previewAttachments);
                            }

                            await new Promise((resolve, reject) => {
                                db.run(
                                    'INSERT INTO messages (session_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)',
                                    [sessionId, 'user', lastUserContent, attachmentsJson, new Date().toISOString()],
                                    (err) => err ? reject(err) : resolve()
                                );
                            });
                        }

                        const sourcesJson = searchSources.length > 0 ? JSON.stringify(searchSources) : null;
                        await new Promise((resolve, reject) => {
                            db.run(
                                'INSERT INTO messages (session_id, role, content, reasoning_content, model, enable_search, thinking_mode, internet_mode, sources, process_trace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                                [
                                    sessionId,
                                    'assistant',
                                    contentToSave || '(生成中断)',
                                    reasoningToSave || null,
                                    finalModel,
                                    internetMode ? 1 : 0,
                                    thinkingMode ? 1 : 0,
                                    internetMode ? 1 : 0,
                                    sourcesJson,
                                    processTraceJson,
                                    new Date().toISOString()
                                ],
                                (err) => err ? reject(err) : resolve()
                            );
                        });

                        if (extractedTitle) {
                            if (flowId) {
                                await syncFlowTitle(flowId, req.user.userId, extractedTitle);
                                res.write(`data: ${JSON.stringify({ type: 'title', title: extractedTitle })}\n\n`);
                            } else {
                                db.run(
                                    'UPDATE sessions SET title = ? WHERE id = ?',
                                    [extractedTitle, sessionId],
                                    (updateErr) => {
                                        if (!updateErr) {
                                            res.write(`data: ${JSON.stringify({ type: 'title', title: extractedTitle })}\n\n`);
                                        }
                                    }
                                );
                            }
                        }

                        await new Promise((resolve) => {
                            db.run(
                                'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                                [sessionId],
                                () => resolve()
                            );
                        });
                    }

                    if (flowId && structuredAgentOutput.canvasPatchRaw) {
                        res.write(`data: ${JSON.stringify({
                            type: 'canvas_patch',
                            patch: structuredAgentOutput.canvasPatch,
                            raw: structuredAgentOutput.canvasPatchRaw,
                            valid: !structuredAgentOutput.canvasPatchParseError,
                            error: structuredAgentOutput.canvasPatchParseError || null
                        })}\n\n`);
                    }

                    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                    res.end();
                    console.log('\n 真并行 Multi-Agent 处理完成\n');
                    return;
                } catch (agentPipelineError) {
                    console.error(' 真并行Agent流程失败，回退单模型路径:', agentPipelineError.message);
                    emitAgentEvent(res, {
                        type: 'agent_status',
                        role: 'master',
                        scope: 'stage',
                        stepId: 'master',
                        status: 'failed',
                        detail: '并行Agent异常，已回退单模型流程'
                    });
                    effectiveAgentMode = 'off';
                }
            }
        }

        try {
            agentRuntime = runAgentOrchestrator({
                res,
                userMessage: userContent,
                internetMode,
                agentMode: effectiveAgentMode,
                agentPolicy,
                qualityProfile
            });
        } catch (agentError) {
            console.error(' Multi-Agent 编排初始化失败，回退单模型路径:', agentError.message);
            emitAgentEvent(res, {
                type: 'agent_status',
                role: 'master',
                status: 'error',
                detail: '编排初始化失败，已自动回退单模型流程'
            });
            agentRuntime = {
                enabled: false,
                agentMode: 'off',
                agentPolicy: normalizeAgentPolicy(agentPolicy),
                qualityProfile: normalizeQualityProfile(qualityProfile),
                selectedAgents: [],
                fingerprint: null,
                retriesUsed: 0
            };
        }

        // 智能路由：根据最后一条用户消息自动选择模型
        let finalModel = model;  // 最终选中的模型类型
        let routing = null;      // 对应的路由配置
        let autoRoutingReason = '';

        console.log(`\n 模型选择开始: 用户指定 = ${model}`);

        // 关键修复：只检测【当前用户消息】的多模态内容，而不是整个对话历史！
        // 这样只有当前消息带图片才会用 VL 模型，之前对话中的图片不会影响后续消息
        const lastUserMessage = messages.filter(m => m.role === 'user').pop();
        const currentMessageMultimodal = lastUserMessage ? detectMultimodalContent(lastUserMessage) : { hasMultimodal: false, types: [], count: 0 };
        let isMultimodalRequest = currentMessageMultimodal.hasMultimodal;

        if (isMultimodalRequest) {
            console.log(`\n   当前消息检测到多模态内容!!!`);
            console.log(`   类型: ${getMultimodalTypeDescription(currentMessageMultimodal.types)}`);
            console.log(`   数量: ${currentMessageMultimodal.count}`);

            const multimodalTypesText = getMultimodalTypeDescription(currentMessageMultimodal.types);
            const defaultMultimodalModel = model === 'auto' ? await resolveVisibleAutoMultimodalModel() : model;
            const requestedRouting = MODEL_ROUTING[defaultMultimodalModel];
            const supportsNativeMultimodal = model === 'auto' || !!requestedRouting?.multimodal;

            if (supportsNativeMultimodal) {
                finalModel = defaultMultimodalModel;
                autoRoutingReason = model === 'auto'
                    ? `${userMembershipTier} 用户智能模型默认使用 Kimi K2.5 处理${multimodalTypesText}`
                    : `${defaultMultimodalModel} 原生支持多模态，直接处理${multimodalTypesText}`;
                console.log(`    模型 ${finalModel} 原生支持多模态，无需切换`);
            } else {
                finalModel = 'kimi-k2.5';
                autoRoutingReason = `${model || 'auto'} 不支持多模态，自动切换到 Kimi K2.5 处理${multimodalTypesText}`;
                console.log(`    ${model || 'auto'} 不支持多模态，切换到 kimi-k2.5 (Pro/moonshotai/Kimi-K2.5)`);
            }
        } else if (model === 'auto') {
            // 智能模型策略：free/pro/max 全部默认 K2.5
            finalModel = await resolveVisibleAutoModel();
            autoRoutingReason = `${userMembershipTier} 用户智能模型默认使用 ${finalModel}`;
            console.log(` auto_route_decision: ${autoRoutingReason}`);
        }


        // Auto + 联网：优先保证可用性，DeepSeek 下回退到硅基免费 Qwen2.5-7B
        if (model === 'auto' && internetMode) {
            console.log(` Auto+联网模式: 使用 ${finalModel}（支持联网）`);
        }

        let enableResearchDebate = (normalizedResearchMode === 'fast' || normalizedResearchMode === 'deep') && !isMultimodalRequest;
        if ((normalizedResearchMode === 'fast' || normalizedResearchMode === 'deep') && isMultimodalRequest) {
            emitAgentEvent(res, {
                type: 'agent_status',
                role: 'master',
                scope: 'stage',
                stepId: 'research-master',
                status: 'failed',
                detail: '当前消息包含图片/多模态内容，研究讨论已自动降级为单模型处理'
            });
            console.warn(' 研究讨论暂不处理多模态当前消息，回退单模型处理');
        }

        if (enableResearchDebate) {
            const preferredMaster = (finalModel === 'deepseek-v3' || finalModel === 'deepseek-v3.2-speciale')
                ? 'deepseek-v3.2-speciale'
                : 'gpt-5.5';
            const gpt55Routing = MODEL_ROUTING['gpt-5.5'];
            const dsv4Routing = MODEL_ROUTING['deepseek-v3.2-speciale'];
            const gpt55Available = !!API_PROVIDERS[gpt55Routing?.provider]?.apiKey && !(await isPublicModelDisabled('gpt-5.5'));
            const dsv4Available = !!API_PROVIDERS[dsv4Routing?.provider]?.apiKey && !(await isPublicModelDisabled('deepseek-v3.2-speciale'));

            if (preferredMaster === 'deepseek-v3.2-speciale' && dsv4Available) {
                finalModel = 'deepseek-v3.2-speciale';
            } else if (preferredMaster === 'gpt-5.5' && gpt55Available) {
                finalModel = 'gpt-5.5';
            } else if (gpt55Available) {
                finalModel = 'gpt-5.5';
            } else if (dsv4Available) {
                finalModel = 'deepseek-v3.2-speciale';
            } else {
                enableResearchDebate = false;
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'research-master',
                    status: 'failed',
                    detail: '深度研究主控模型不可用，已自动降级为单模型深度思考'
                });
                console.warn(' 深度研究互评主控模型不可用，回退单模型');
            }

            if (enableResearchDebate) {
                autoRoutingReason = `${normalizedResearchMode === 'deep' ? '深度研究' : '快速研究'}讨论: Gemma + Kimi K2.5 + GPT-5.5 + DeepSeek V4 Pro 轮流质疑，由 ${researchModelLabel(finalModel)} 主控判断停止并回答`;
                console.log(` research_debate enabled mode=${normalizedResearchMode} master=${finalModel}`);
            }
        }

        //  关键修复：添加白名单验证（防御性编程）
        const VALID_MODELS = [
            'deepseek-v3',
            'deepseek-v3.2-speciale',
            'kimi-k2.5',
            'kimi-k2',
            'qwen2.5-7b',
            'qwen3-8b',
            'chatgpt-gpt-oss-120b',
            'grok-4.2',
            'gpt-5.5',
            'claude-haiku',
            'anthropic/claude-sonnet-4.6',
            'anthropic/claude-3-haiku',
            'gemma',
            'gemini-3-flash',
            'poe-claude',
            'poe-gpt',
            'poe-grok',
            'poe-gemini'
        ];

        // 注意：多模态检测已在上面执行，这里不再重复

        if (!VALID_MODELS.includes(finalModel) || await isPublicModelDisabled(finalModel)) {
            const fallbackModel = resolveFreeFallbackModelId(finalModel);
            const visibleFallbackModel = await isPublicModelDisabled(fallbackModel)
                ? await resolveVisibleAutoModel()
                : fallbackModel;
            console.warn(` 无效或已关闭模型 ${finalModel},回退到 ${visibleFallbackModel}`);
            finalModel = visibleFallbackModel;
            autoRoutingReason = `无效或已关闭模型,按备用链自动回退到 ${visibleFallbackModel}`;
        }

        // Poe 路由策略：先做 free 配额与 thinking 强制，再做模型可用性校验
        if (isPoeModelAlias(finalModel)) {
            if (normalizedMembershipTier === 'free') {
                try {
                    const poeQuotaResult = await checkAndConsumePoeQuota(req.user.userId, 'free');
                    res.write(`data: ${JSON.stringify({
                        type: 'quota_info',
                        provider: 'poe',
                        poeRemaining: poeQuotaResult.remaining,
                        poeUsed: poeQuotaResult.used,
                        poeLimit: poeQuotaResult.limit,
                        resetAt: poeQuotaResult.resetAt
                    })}\n\n`);

                    if (!poeQuotaResult.allowed) {
                        const fallbackModel = resolveFreeFallbackModelId(finalModel);
                        finalModel = fallbackModel;
                        autoRoutingReason = `Poe free 配额已用尽，按备用链自动切换到 ${fallbackModel}`;
                        console.warn(` poe_fallback quota_exceeded -> ${finalModel}`);
                    } else if (thinkingMode) {
                        thinkingMode = false;
                        console.log(' free + Poe 已强制关闭 thinkingMode');
                    }
                } catch (poeQuotaError) {
                    console.warn(` Poe配额检查失败，回退免费模型: ${poeQuotaError.message}`);
                    const fallbackModel = resolveFreeFallbackModelId(finalModel);
                    finalModel = fallbackModel;
                    autoRoutingReason = `Poe配额检查失败，按备用链自动回退到 ${fallbackModel}`;
                }
            }

            if (isPoeModelAlias(finalModel)) {
                const poeResolution = resolvePoeModelAlias(finalModel);
                if (!poeResolution.available) {
                    const fallbackModel = resolveFreeFallbackModelId(finalModel);
                    console.warn(` poe_fallback unavailable alias=${finalModel} -> ${fallbackModel}`);
                    finalModel = fallbackModel;
                    autoRoutingReason = `Poe模型暂不可用，按备用链回退到 ${fallbackModel} (${poeResolution.alias})`;
                } else {
                    console.log(` poe_model_sync route alias=${finalModel} model=${poeResolution.model} source=${poeResolution.source}`);
                }
            }
        }

        if (finalModel === 'gpt-5.5' && normalizedMembershipTier === 'free') {
            try {
                const gpt55QuotaResult = await checkAndConsumeGpt55Quota(req.user.userId, 'free');
                res.write(`data: ${JSON.stringify({
                    type: 'quota_info',
                    provider: 'newapi_gpt55',
                    gpt55Remaining: gpt55QuotaResult.remaining,
                    gpt55Used: gpt55QuotaResult.used,
                    gpt55Limit: gpt55QuotaResult.limit,
                    resetAt: gpt55QuotaResult.resetAt
                })}\n\n`);

                if (!gpt55QuotaResult.allowed) {
                    const fallbackModel = resolveFreeFallbackModelId(finalModel);
                    res.write(`data: ${JSON.stringify({
                        type: 'model_info',
                        model: fallbackModel,
                        actualModel: MODEL_ROUTING[fallbackModel]?.model || fallbackModel,
                        reason: `GPT-5.5 限免次数已用完，按备用链回退到 ${fallbackModel}`,
                        provider: MODEL_ROUTING[fallbackModel]?.provider || 'unknown'
                    })}\n\n`);
                    finalModel = fallbackModel;
                    autoRoutingReason = `GPT-5.5 限免次数已用完，free 用户每日 ${gpt55QuotaResult.limit} 次，按备用链回退到 ${fallbackModel}`;
                    console.warn(` gpt55_quota_fallback quota_exceeded -> ${finalModel}`);
                } else {
                    gpt55QuotaConsumed = true;
                    console.log(` gpt55_quota_consume user=${req.user.userId} used=${gpt55QuotaResult.used}/${gpt55QuotaResult.limit}`);
                }
            } catch (gpt55QuotaError) {
                console.warn(` GPT-5.5配额检查失败: ${gpt55QuotaError.message}`);
                const fallbackModel = resolveFreeFallbackModelId(finalModel);
                finalModel = fallbackModel;
                autoRoutingReason = `GPT-5.5限免配额检查失败，按备用链回退到 ${fallbackModel}`;
            }
        }

        if (forceFreeModelByQuota && !isFreeModelIdentifier(finalModel)) {
            const fallbackModel = resolveFreeFallbackModelId(finalModel);
            finalModel = fallbackModel;
            autoRoutingReason = autoRoutingReason
                ? `${autoRoutingReason}; 点数不足按备用链自动切换到 ${fallbackModel}，完成任务或签到可增加积分`
                : `点数不足按备用链自动切换到 ${fallbackModel}，完成任务或签到可增加积分`;
            console.log(` 点数不足强制免费模型: user=${req.user.userId}`);
        } else if (!forceFreeModelByQuota && !pointsAlreadyDeducted) {
            try {
                const pointsResult = await checkAndDeductPoints(req.user.userId, finalModel);
                if (pointsResult?.useFreeModel && finalModel !== 'qwen2.5-7b') {
                    const fallbackModel = resolveFreeFallbackModelId(finalModel);
                    finalModel = fallbackModel;
                    res.write(`data: ${JSON.stringify({
                        type: 'points_info',
                        remainingPoints: 0,
                        message: pointsResult.message || '点数不足，已自动切换到免费模型。完成任务或签到可增加积分。'
                    })}\n\n`);
                    autoRoutingReason = autoRoutingReason
                        ? `${autoRoutingReason}; 点数不足按备用链自动切换到 ${fallbackModel}，完成任务或签到可增加积分`
                        : `点数不足按备用链自动切换到 ${fallbackModel}，完成任务或签到可增加积分`;
                    console.log(` 点数不足自动切换免费模型: user=${req.user.userId}`);
                } else if (Number(pointsResult?.pointsDeducted || 0) > 0) {
                    pointsAlreadyDeducted = true;
                    console.log(` 已扣点: user=${req.user.userId}, remaining=${pointsResult.remainingPoints}`);
                }
            } catch (pointsErr) {
                const fallbackModel = resolveFreeFallbackModelId(finalModel);
                finalModel = fallbackModel;
                autoRoutingReason = autoRoutingReason
                    ? `${autoRoutingReason}; 点数检查失败，按备用链回退到 ${fallbackModel}`
                    : `点数检查失败，按备用链回退到 ${fallbackModel}`;
                console.error(` 点数检查失败，回退免费模型: ${pointsErr.message}`);
            }
        }

        // 关键修复：现在finalModel已经是具体的模型名，再获取routing
        routing = MODEL_ROUTING[finalModel];
        if (!routing) {
            console.error(` 模型路由配置未找到: ${finalModel}`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: `配置错误: ${finalModel}` })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        console.log(`\n 路由配置: provider=${routing.provider}, model=${routing.model}`);

        let actualModel = routing.model;
        if (routing.provider === 'poe') {
            const poeResolution = resolvePoeModelAlias(finalModel);
            if (poeResolution.available && poeResolution.model) {
                actualModel = poeResolution.model;
            } else {
                console.warn(` poe_fallback runtime_unavailable alias=${finalModel} -> kimi-k2.5`);
                finalModel = 'kimi-k2.5';
                routing = MODEL_ROUTING[finalModel];
                actualModel = routing.model;
                autoRoutingReason = 'Poe模型运行期不可用，自动回退到 Kimi K2.5';
            }
        }

        // DeepSeek V4 使用同一模型，通过 thinking 参数切换思考/非思考模式
        if (routing.provider === 'deepseek' && thinkingMode && routing.thinkingModel) {
            actualModel = routing.thinkingModel;
            console.log(` DeepSeek V4 思考模式: 使用 ${actualModel}`);
        }

        // DeepSeek-V3.2-Speciale 已隐藏；兼容旧会话并映射到 V4 Pro 思考模式
        if (finalModel === 'deepseek-v3.2-speciale') {
            actualModel = routing.thinkingModel || 'deepseek-v4-pro';
            thinkingMode = true;
            console.log(` DeepSeek-V3.2-Speciale: 兼容映射到 ${actualModel}`);
        }

        // Kimi K2.5 思考模式自动切换
        if ((finalModel === 'kimi-k2.5' || finalModel === 'kimi-k2') && thinkingMode && routing.thinkingModel) {
            actualModel = routing.thinkingModel;
            console.log(` Kimi K2.5 思考模式: 切换到 ${actualModel}`);
        }

        //  关键修复：验证提供商配置存在（防止404错误）
        let providerConfig = API_PROVIDERS[routing.provider];
        if (!providerConfig || !providerConfig.apiKey) {
            const fallbackModel = findAvailableRuntimeFallbackModelId(finalModel);
            if (fallbackModel) {
                const missingReason = !providerConfig
                    ? `提供商配置缺失: ${routing.provider}`
                    : `缺少环境变量: ${providerConfig.envKey || 'API_KEY'}`;
                console.warn(` ${missingReason}，按备用链回退到 ${fallbackModel}`);
                finalModel = fallbackModel;
                routing = MODEL_ROUTING[finalModel];
                actualModel = routing.model;
                providerConfig = API_PROVIDERS[routing.provider];
                autoRoutingReason = autoRoutingReason
                    ? `${autoRoutingReason}; ${missingReason}，按备用链回退到 ${fallbackModel}`
                    : `${missingReason}，按备用链回退到 ${fallbackModel}`;
            }
        }
        if (!providerConfig) {
            console.error(` API提供商配置未找到: ${routing.provider}`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: `不支持的提供商: ${routing.provider}` })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }
        if (!providerConfig.apiKey) {
            const missingEnvKey = providerConfig.envKey || 'API_KEY';
            console.error(` 缺少API环境变量: ${missingEnvKey}`);
            res.write(`data: ${JSON.stringify({ type: 'error', error: `服务器未配置${missingEnvKey}` })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        console.log(` API端点: ${providerConfig.baseURL}`);

        // 关键修复：通过SSE发送实际使用的模型信息（因为响应头已经发送，无法再设置X-Model-Used）
        res.write(`data: ${JSON.stringify({
            type: 'model_info',
            model: finalModel,
            actualModel: actualModel,
            reason: autoRoutingReason,
            provider: routing.provider
        })}\n\n`);
        console.log(` 已发送模型信息: finalModel=${finalModel}, actualModel=${actualModel}`);

        //  流式工具调用模式 (Streaming Function Calling)
        // 不再预先判断，而是在流式响应中检测 tool_calls
        let searchContext = '';
        let searchSources = [];
        let useStreamingTools = false;  // 标记是否启用流式工具调用

        if (enableResearchDebate && internetMode) {
            try {
                res.write(`data: ${JSON.stringify({
                    type: 'search_status',
                    status: 'searching',
                    query: userContent,
                    message: `正在搜索: "${userContent.slice(0, 80)}"`
                })}\n\n`);
                const researchSearchData = await performWebSearch(userContent, 5, getTavilySearchDepth(actualModel, true));
                const researchSearchResults = researchSearchData?.results || researchSearchData || [];
                if (Array.isArray(researchSearchResults) && researchSearchResults.length > 0) {
                    searchContext = formatSearchResults(researchSearchData, userContent);
                    const currentSources = extractSourcesForSSE(researchSearchResults);
                    const sourceAppendResult = appendAnnotatedSources(searchSources, currentSources);
                    searchSources = sourceAppendResult.merged;
                    emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                    res.write(`data: ${JSON.stringify({
                        type: 'search_status',
                        status: 'complete',
                        query: userContent,
                        resultCount: researchSearchResults.length,
                        message: `找到 ${researchSearchResults.length} 条结果`
                    })}\n\n`);
                    console.log(` 深度研究预检索完成: ${researchSearchResults.length} 条结果`);
                } else {
                    res.write(`data: ${JSON.stringify({
                        type: 'search_status',
                        status: 'no_results',
                        query: userContent,
                        message: '未找到相关结果'
                    })}\n\n`);
                }
            } catch (searchError) {
                console.warn(` 深度研究预检索失败，继续无联网上下文: ${searchError.message}`);
                res.write(`data: ${JSON.stringify({
                    type: 'search_status',
                    status: 'no_results',
                    query: userContent,
                    message: '搜索暂不可用，已继续深度研究'
                })}\n\n`);
            }
        }

        if (!enableResearchDebate && internetMode && routing.provider !== 'aliyun' && routing.supportsWebSearch !== false) {
            console.log(` 联网模式: 启用流式工具调用 (Streaming Function Calling)`);
            useStreamingTools = true;
            // 不再阻塞等待，直接在后面的流式调用中添加 tools 参数
        } else if (!enableResearchDebate && internetMode && finalModel === 'deepseek-v3.2-speciale') {
            console.log(` DeepSeek-V3.2-Speciale 是高级思考模型，无需额外联网搜索`);
        }

        // 构建消息数组
        let finalMessages = [...messages];

        // 如果是多模态请求，转换消息格式为Omni格式
        if (isMultimodalRequest) {
            finalMessages = convertMessagesToOmniFormat(finalMessages);
            console.log(` 消息已转换为多模态格式`);
        }

        // 添加系统提示词（包含搜索结果）
        // 注意: Mermaid 图表生成指南已内置在前端的 buildSystemPrompt() 中
        let systemContent = searchContext
            ? `${systemPrompt || ''}\n${searchContext}`.trim()
            : systemPrompt || '';

        //  流式工具调用：在系统提示词中告知 AI 它有搜索能力
        if (useStreamingTools) {
            const toolHint = `\n\n[系统提示] 当前处于联网模式。若用户要求“最新/实时/文献/论文/来源/数据依据/研究结论”，请至少调用一次 web_search 再回答；涉及天气、新闻、股价、时效数据时也应按需调用，并可在必要时再次调用。`;
            systemContent = systemContent ? `${systemContent}${toolHint}` : toolHint.trim();
            console.log(` 已添加工具提示到系统提示词`);
        }

        if (userIdentityInstruction) {
            systemContent = systemContent
                ? `${systemContent}\n\n${userIdentityInstruction}`
                : userIdentityInstruction;
            console.log(` 已注入当前用户信息到系统提示词`);
        }

        if (activeDomainInstruction) {
            systemContent = systemContent
                ? `${systemContent}\n\n${activeDomainInstruction}`
                : activeDomainInstruction;
            console.log(` 已注入领域系统提示词: ${resolvedDomainPrompt?.domainMode || 'unknown'}`);
        }

        if (activeRuleInstruction) {
            systemContent = systemContent
                ? `${systemContent}\n\n${activeRuleInstruction}`
                : activeRuleInstruction;
            console.log(` 已注入规则提示到系统提示词: ${resolvedPromptRule?.ruleId || 'unknown'}`);
        }

        if (flowRecord) {
            const flowCanvasInstruction = buildFlowCanvasSystemInstruction({
                flowRecord,
                canvasContext,
                uiSurface,
                canvasApplyMode
            });
            if (flowCanvasInstruction) {
                systemContent = systemContent
                    ? `${systemContent}\n\n${flowCanvasInstruction}`
                    : flowCanvasInstruction;
                console.log(` 已注入 ChatFlow 专属上下文: flow=${flowRecord.id}, session=${flowRecord.session_id}`);
            }
        }

        if (systemContent) {
            finalMessages.unshift({
                role: 'system',
                content: systemContent
            });
        }

        const isKimiK25Model = (finalModel === 'kimi-k2.5' || finalModel === 'kimi-k2' || isKimiK25ActualModel(actualModel));

        // 构建API请求体
        let requestBody = {
            model: actualModel,
            messages: finalMessages,
            max_tokens: parseInt(max_tokens, 10) || 2000,
            stream: true  // Qwen3-Omni-Flash要求必须开启流式
        };
        if (routing.provider === 'openrouter' && Array.isArray(routing.fallbackModels) && routing.fallbackModels.length > 1) {
            requestBody.models = routing.fallbackModels;
            console.log(` OpenRouter fallback models: ${routing.fallbackModels.join(' -> ')}`);
        }

        // Kimi K2.5 参数规则：
        // 1) 默认思考开启；要快速响应需显式关闭思考
        // 2) 对 K2.5 不传可变采样参数，避免参数冲突
        if (isKimiK25Model) {
            if (routing.provider === 'siliconflow') {
                // SiliconFlow: 使用 enable_thinking 开关
                requestBody.enable_thinking = !!thinkingMode;
                console.log(` Kimi K2.5 enable_thinking=${requestBody.enable_thinking} (${thinkingMode ? '深度模式' : '快速模式'})`);
            } else {
                // Moonshot 原生兼容写法
                requestBody.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
                console.log(` Kimi K2.5 thinking=${requestBody.thinking.type} (${thinkingMode ? '深度模式' : '快速模式'})`);
            }
        } else {
            requestBody.temperature = parseFloat(temperature) || 0.7;
            requestBody.top_p = parseFloat(top_p) || 0.9;

            const modelThinkingBudget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
            if (modelThinkingBudget !== null) {
                requestBody.thinking_budget = modelThinkingBudget;
                console.log(` ${actualModel} thinking_budget=${modelThinkingBudget} (${thinkingMode ? '思考模式' : '快速模式'})`);
            }
        }

        if (routing.provider === 'poe') {
            const poeExtraBody = buildPoeExtraBody(finalModel, normalizedReasoningProfile, !!thinkingMode);
            if (poeExtraBody && Object.keys(poeExtraBody).length > 0) {
                requestBody.extra_body = poeExtraBody;
                console.log(` Poe extra_body 已注入: ${JSON.stringify(poeExtraBody)}`);
            }
        }

        //  流式工具调用：为请求添加 tools 参数
        if (useStreamingTools) {
            requestBody.tools = TOOL_DEFINITIONS;
            // 支持“先说一部分，再按需调用工具，再继续说”
            requestBody.tool_choice = "auto";
            console.log(` 已为流式调用添加工具定义: ${TOOL_DEFINITIONS.length}个工具`);
        }

        //  防御性检查：确保数值解析成功
        if (Object.prototype.hasOwnProperty.call(requestBody, 'temperature') &&
            (isNaN(requestBody.temperature) || requestBody.temperature < 0 || requestBody.temperature > 2)) {
            console.warn(` 无效的temperature值: ${temperature}，使用默认值0.7`);
            requestBody.temperature = 0.7;
        }
        if (Object.prototype.hasOwnProperty.call(requestBody, 'top_p') &&
            (isNaN(requestBody.top_p) || requestBody.top_p < 0 || requestBody.top_p > 1)) {
            console.warn(` 无效的top_p值: ${top_p}，使用默认值0.9`);
            requestBody.top_p = 0.9;
        }
        if (isNaN(requestBody.max_tokens) || requestBody.max_tokens < 100 || requestBody.max_tokens > 8000) {
            console.warn(` 无效的max_tokens值: ${max_tokens}，使用默认值2000`);
            requestBody.max_tokens = 2000;
        }

        // 阿里云思考模式（仅Qwen）
        if (thinkingMode && routing.provider === 'aliyun') {
            requestBody.enable_thinking = true;

            //  思考预算直接放顶层，不用extra_body
            const budget = parseInt(thinkingBudget);
            const validBudget = Math.max(256, Math.min(isNaN(budget) ? 1024 : budget, 32768));

            requestBody.thinking_budget = validBudget;  //  改为直接放顶层

            console.log(` Qwen思考模式已开启, 预算: ${validBudget} tokens`);
        }

        // 阿里云互联网模式
        if (internetMode && routing.provider === 'aliyun') {
            //  修复：确保enable_search是布尔值，不能是其他类型
            requestBody.enable_search = true;
            // 新增：启用搜索来源和角标功能
            requestBody.search_options = {
                enable_source: true,        // 返回搜索来源列表
                enable_citation: true,      // 在回答中插入角标
                citation_format: "[<number>]"  // 角标格式: [1], [2]
            };
            console.log(` 阿里云互联网搜索已开启（启Enable角标引用）`);
        }

        // DeepSeek参数
        if (routing.provider === 'deepseek') {
            applyDeepSeekV4ModeParams(requestBody, !!thinkingMode, normalizedReasoningProfile);

            if (!thinkingMode) {
                //  确保frequency_penalty和presence_penalty是有效的数值
                const freqPenalty = parseFloat(frequency_penalty);
                const presPenalty = parseFloat(presence_penalty);

                requestBody.frequency_penalty = (isNaN(freqPenalty) ? 0 : Math.max(0, Math.min(freqPenalty, 2)));
                requestBody.presence_penalty = (isNaN(presPenalty) ? 0 : Math.max(0, Math.min(presPenalty, 2)));

                console.log(` DeepSeek V4非思考模式: thinking=disabled, frequency_penalty=${requestBody.frequency_penalty}, presence_penalty=${requestBody.presence_penalty}`);
            } else {
                console.log(` DeepSeek V4思考模式: thinking=enabled, reasoning_effort=${requestBody.reasoning_effort}`);
            }
        }

        if (routing.provider === 'newapi') {
            applyNewApiModelParams(requestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);
            if (requestBody.reasoning_effort) {
                console.log(` NewAPI ${actualModel} reasoning_effort=${requestBody.reasoning_effort}`);
            }
        }

        if (routing.provider === 'openrouter') {
            applyOpenRouterReasoningParams(requestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);
            if (requestBody.reasoning) {
                console.log(` OpenRouter ${actualModel} reasoning=${JSON.stringify(requestBody.reasoning)}`);
            }
        }

        console.log(` 请求体摘要: messages=${requestBody.messages?.length || 0}, tools=${requestBody.tools?.length || 0}, stream=${!!requestBody.stream}`);

        //  加强过滤：将autoRoutingReason转换为可以放入HTTP头的格式（移除所有中文和特殊字符）
        const reasonForHeader = (autoRoutingReason || '')
            .replace(/[\u4e00-\u9fa5\u3000-\u303F\uFF00-\uFFEF]/g, '')  // 移除所有中日韩字符
            .replace(/[^\x20-\x7E]/g, '')      // 只保留可打印ASCII字符
            .replace(/[\r\n\t]/g, ' ')         // 替换换行符为空格
            .trim()
            .substring(0, 100);

        //  验证请求体的关键字段
        if (!requestBody.model) {
            console.error(' 请求体缺少model字段');
            res.write(`data: ${JSON.stringify({ type: 'error', error: '模型配置错误' })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        if (!Array.isArray(requestBody.messages) || requestBody.messages.length === 0) {
            console.error(' 请求体消息为空');
            res.write(`data: ${JSON.stringify({ type: 'error', error: '消息不能为空' })}\n\n`);
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        // 注意：SSE头已在搜索前提前设置（约第1770行）
        // 新增：如果有搜索来源，立即发送给前端
        if (searchSources && searchSources.length > 0) {
            res.write(`data: ${JSON.stringify({ type: 'sources', sources: searchSources })}\n\n`);
            console.log(` 已发送 ${searchSources.length} 个搜索来源到前端`);
        }

        console.log(`\n 发送请求到 ${routing.provider} - ${actualModel}\n`);

        //  关键修复：调用API
        console.log(` 正在调用: ${providerConfig.baseURL}`);
        console.log(`   API密钥: 已配置`);

        //  修复：添加超时控制 (120秒) - 增加超时时间以应对网络不稳定
        const controller = new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), 120000);

        //  关键修复：将变量声明移到try块外部，避免作用域问题
        let fullContent = '';
        let reasoningContent = '';
        let rawToolContent = '';
        let agentSynthesizerRunning = false;
        let agentResearcherRunning = false;
        let rawAssistantStructuredBuffer = '';
        let latestStructuredAssistantOutput = {
            visibleContent: '',
            extractedTitle: null,
            canvasPatch: null,
            canvasPatchRaw: '',
            canvasPatchParseError: null
        };

        const emitStructuredAssistantChunk = (rawChunk = '') => {
            const normalizedChunk = typeof rawChunk === 'string' ? rawChunk : String(rawChunk || '');
            if (!normalizedChunk) return '';

            rawAssistantStructuredBuffer += normalizedChunk;
            latestStructuredAssistantOutput = parseStructuredAssistantOutput(rawAssistantStructuredBuffer);
            const nextVisibleContent = latestStructuredAssistantOutput.visibleContent || '';
            const visibleDelta = nextVisibleContent.startsWith(fullContent)
                ? nextVisibleContent.slice(fullContent.length)
                : nextVisibleContent;

            fullContent = nextVisibleContent;

            if (visibleDelta) {
                res.write(`data: ${JSON.stringify({ type: 'content', content: visibleDelta })}\n\n`);
            }

            return visibleDelta;
        };

        if (enableResearchDebate) {
            clearTimeout(timeoutId);
            const researchTraceState = {
                version: 1,
                mode: 'research_debate',
                researchMode: normalizedResearchMode,
                plan: null,
                tasks: {},
                statuses: [],
                drafts: [],
                metrics: null,
                trace: [],
                savedAt: null
            };
            const recordResearchTraceEvent = (payload) => {
                const event = payload && typeof payload === 'object' ? payload : null;
                if (!event || !event.type) return;
                const traceText = event.detail || event.summary || event.task || event.mode || '';
                researchTraceState.trace.push({
                    kind: event.type,
                    text: String(traceText || '').slice(0, 240),
                    ts: Date.now()
                });
                if (researchTraceState.trace.length > 300) {
                    researchTraceState.trace = researchTraceState.trace.slice(-300);
                }

                if (event.type === 'agent_plan') {
                    researchTraceState.plan = event;
                    if (Array.isArray(event.tasks)) {
                        for (const task of event.tasks) {
                            const taskId = Number(task.agent_id || task.taskId || 0);
                            if (!taskId) continue;
                            const stepId = task.role === 'master' ? 'research-master' : `research-${task.role || taskId}`;
                            researchTraceState.tasks[stepId] = {
                                stepId,
                                taskId,
                                role: task.role || 'researcher',
                                status: 'pending',
                                detail: task.task || '',
                                durationMs: null
                            };
                        }
                    }
                    return;
                }

                if (event.type === 'agent_status') {
                    const stepId = event.stepId || (event.role === 'master' ? 'research-master' : `research-${event.role || 'agent'}`);
                    const statusEvent = {
                        type: event.type,
                        scope: event.scope || 'stage',
                        stepId,
                        taskId: event.taskId || null,
                        role: event.role || 'agent',
                        status: event.status || 'pending',
                        detail: event.detail || '',
                        durationMs: event.durationMs || null,
                        ts: Date.now()
                    };
                    researchTraceState.statuses.push(statusEvent);
                    if (researchTraceState.statuses.length > 300) {
                        researchTraceState.statuses = researchTraceState.statuses.slice(-300);
                    }
                    const previous = researchTraceState.tasks[stepId] || {};
                    researchTraceState.tasks[stepId] = {
                        ...previous,
                        stepId,
                        taskId: event.taskId || previous.taskId || null,
                        role: event.role || previous.role || 'agent',
                        status: event.status || previous.status || 'pending',
                        detail: event.detail || previous.detail || '',
                        durationMs: event.durationMs != null ? event.durationMs : (previous.durationMs || null)
                    };
                    return;
                }

                if (event.type === 'agent_draft') {
                    researchTraceState.drafts.push(event);
                    if (researchTraceState.drafts.length > 16) {
                        researchTraceState.drafts = researchTraceState.drafts.slice(-16);
                    }
                    return;
                }

                if (event.type === 'agent_metrics') {
                    researchTraceState.metrics = event;
                }
            };

            try {
                console.log(`\n 启用${normalizedResearchMode === 'deep' ? '深度研究' : '快速研究'}讨论模式 (Gemma + Kimi K2.5 + GPT-5.5 + DeepSeek V4 Pro)\n`);
                const researchResult = await runResearchDebateMode({
                    res,
                    requestId,
                    messages: finalMessages,
                    userMessage: userContent,
                    masterModelId: finalModel,
                    researchMode: normalizedResearchMode,
                    debateThinkingMode: normalizedResearchMode === 'deep',
                    maxDebateRounds: normalizedResearchMode === 'deep' ? 3 : 2,
                    reasoningProfile: normalizedReasoningProfile,
                    maxTokens: max_tokens,
                    onContent: emitStructuredAssistantChunk,
                    onReasoning: (chunk) => {
                        if (!chunk) return;
                        reasoningContent += chunk;
                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: chunk })}\n\n`);
                    },
                    onAgentEvent: recordResearchTraceEvent
                });

                finalModel = researchResult.finalModel || finalModel;
                actualModel = researchResult.actualModel || actualModel;
                routing = MODEL_ROUTING[finalModel] || routing;
                if (routing?.provider && API_PROVIDERS[routing.provider]) {
                    providerConfig = API_PROVIDERS[routing.provider];
                }

                if (sessionId) {
                    console.log('\n 保存深度研究结果到数据库');

                    const lastUserMessage = messages[messages.length - 1];
                    if (lastUserMessage && lastUserMessage.role === 'user') {
                        const lastUserContent = typeof lastUserMessage.content === 'string'
                            ? stripInlinePromptTimeHint(lastUserMessage.content)
                            : JSON.stringify(lastUserMessage.content);

                        let attachmentsJson = null;
                        if (Array.isArray(lastUserMessage.attachments) && lastUserMessage.attachments.length > 0) {
                            const previewAttachments = lastUserMessage.attachments.map(att => {
                                if (att.type === 'image' && att.data) {
                                    return {
                                        type: 'image',
                                        fileName: att.fileName,
                                        data: att.data
                                    };
                                }
                                return {
                                    type: att.type,
                                    fileName: att.fileName
                                };
                            });
                            attachmentsJson = JSON.stringify(previewAttachments);
                        }

                        await dbRunAsync(
                            'INSERT INTO messages (session_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)',
                            [sessionId, 'user', lastUserContent, attachmentsJson, new Date().toISOString()]
                        );
                    }

                    let contentToSave = fullContent || researchResult.content || (reasoningContent ? '(纯思考内容)' : '(生成中断)');
                    contentToSave = contentToSave
                        .replace(/<\|[^|]+\|>/g, '')
                        .replace(/functions\.\w+:\d+/g, '')
                        .trim();
                    const structuredResearchOutput = parseStructuredAssistantOutput(rawAssistantStructuredBuffer || contentToSave);
                    const extractedTitle = structuredResearchOutput.extractedTitle || null;
                    contentToSave = (structuredResearchOutput.visibleContent || contentToSave).trim();
                    if (!contentToSave) {
                        contentToSave = reasoningContent ? '(纯思考内容)' : '(生成中断)';
                    }

                    researchTraceState.savedAt = new Date().toISOString();
                    researchTraceState.drafts.push({
                        taskId: 999,
                        role: 'master',
                        task: '深度研究最终回答',
                        summary: contentToSave.replace(/\s+/g, ' ').slice(0, 120),
                        content: truncateResearchText(contentToSave, 8000)
                    });
                    const processTraceJson = JSON.stringify({
                        version: researchTraceState.version,
                        mode: researchTraceState.mode,
                        researchMode: researchTraceState.researchMode,
                        plan: researchTraceState.plan,
                        tasks: Object.values(researchTraceState.tasks || {}).sort((a, b) => Number(a.taskId || 0) - Number(b.taskId || 0)),
                        statuses: researchTraceState.statuses,
                        drafts: researchTraceState.drafts,
                        metrics: researchTraceState.metrics,
                        trace: researchTraceState.trace,
                        savedAt: researchTraceState.savedAt,
                        prompt_context: promptContextTrace?.prompt_context || null
                    });

                    await dbRunAsync(
                        'INSERT INTO messages (session_id, role, content, reasoning_content, model, enable_search, thinking_mode, internet_mode, sources, process_trace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [
                            sessionId,
                            'assistant',
                            contentToSave,
                            (reasoningContent || researchResult.reasoningContent || '').trim() || null,
                            finalModel,
                            internetMode ? 1 : 0,
                            normalizedResearchMode === 'deep' ? 1 : 0,
                            internetMode ? 1 : 0,
                            searchSources && searchSources.length > 0 ? JSON.stringify(searchSources) : null,
                            processTraceJson,
                            new Date().toISOString()
                        ]
                    );

                    if (extractedTitle) {
                        if (flowId) {
                            await syncFlowTitle(flowId, req.user.userId, extractedTitle);
                        } else {
                            await dbRunAsync(
                                'UPDATE sessions SET title = ? WHERE id = ?',
                                [extractedTitle, sessionId]
                            );
                        }
                        res.write(`data: ${JSON.stringify({ type: 'title', title: extractedTitle })}\n\n`);
                    }

                    if (flowId && structuredResearchOutput.canvasPatchRaw) {
                        res.write(`data: ${JSON.stringify({
                            type: 'canvas_patch',
                            patch: structuredResearchOutput.canvasPatch,
                            raw: structuredResearchOutput.canvasPatchRaw,
                            valid: !structuredResearchOutput.canvasPatchParseError,
                            error: structuredResearchOutput.canvasPatchParseError || null
                        })}\n\n`);
                    }

                    await dbRunAsync(
                        'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                        [sessionId]
                    );
                }

                res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                res.end();
                console.log(`\n ${normalizedResearchMode === 'deep' ? '深度研究' : '快速研究'}讨论处理完成\n`);
                return;
            } catch (researchError) {
                console.error(' 研究讨论失败:', researchError.message);
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'research-master',
                    status: 'failed',
                    detail: '研究讨论异常，已回退单模型流程'
                });
                enableResearchDebate = false;
                if (String(fullContent || '').trim()) {
                    res.write(`data: ${JSON.stringify({ type: 'error', error: `研究模式中断: ${researchError.message}` })}\n\n`);
                    res.end();
                    return;
                }
                timeoutId = setTimeout(() => controller.abort(), 120000);
            }
        }

        //  Gemini API 特殊处理
        let isGeminiAPI = providerConfig.isGemini || routing.isGemini;

        const buildRuntimeFallbackRequestBody = (fallbackModelId, fallbackRouting, fallbackActualModel) => {
            if (fallbackRouting.provider === 'siliconflow') {
                return buildSiliconflowFreeFallbackRequestBody({
                    actualModel: fallbackActualModel,
                    messages: finalMessages,
                    internetMode,
                    thinkingMode,
                    thinkingBudget,
                    temperature,
                    top_p,
                    max_tokens
                });
            }

            const body = {
                model: fallbackActualModel,
                messages: finalMessages,
                max_tokens: parseInt(max_tokens, 10) || 2000,
                stream: true,
                temperature: parseFloat(temperature) || 0.7,
                top_p: parseFloat(top_p) || 0.9
            };

            if (
                fallbackRouting.provider === 'openrouter' &&
                Array.isArray(fallbackRouting.fallbackModels) &&
                fallbackRouting.fallbackModels.length > 1
            ) {
                body.models = fallbackRouting.fallbackModels;
            }

            if (fallbackRouting.provider === 'openrouter') {
                applyOpenRouterReasoningParams(body, fallbackActualModel, !!thinkingMode, normalizedReasoningProfile);
            }

            if (internetMode && fallbackRouting.provider !== 'aliyun' && fallbackRouting.supportsWebSearch !== false) {
                body.tools = TOOL_DEFINITIONS;
                body.tool_choice = 'auto';
            }

            return body;
        };

        const buildFetchPayloadForAttempt = (attemptProviderConfig, attemptRouting, attemptActualModel, attemptRequestBody) => {
            const attemptIsGeminiAPI = attemptProviderConfig.isGemini || attemptRouting.isGemini;
            if (!attemptIsGeminiAPI) {
                return {
                    isGeminiAPI: false,
                    apiUrl: attemptProviderConfig.baseURL,
                    fetchHeaders: {
                        'Authorization': `Bearer ${attemptProviderConfig.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    fetchBody: attemptRequestBody
                };
            }

            const geminiContents = [];
            for (const msg of finalMessages) {
                if (msg.role === 'system') continue;
                const geminiRole = msg.role === 'assistant' ? 'model' : 'user';
                const parts = [];

                if (Array.isArray(msg.content)) {
                    for (const item of msg.content) {
                        if (item.type === 'text') {
                            parts.push({ text: item.text });
                        } else if (item.type === 'image_url' && item.image_url?.url) {
                            const imageUrl = item.image_url.url;
                            if (imageUrl.startsWith('data:')) {
                                const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                                if (matches) {
                                    parts.push({
                                        inlineData: {
                                            mimeType: matches[1],
                                            data: matches[2]
                                        }
                                    });
                                }
                            } else {
                                parts.push({ fileData: { fileUri: imageUrl, mimeType: 'image/jpeg' } });
                            }
                        }
                    }
                } else {
                    parts.push({ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
                }

                if (msg.attachments && Array.isArray(msg.attachments)) {
                    for (const att of msg.attachments) {
                        if (att.type === 'image' && att.data) {
                            const imageData = att.data;
                            if (imageData.startsWith('data:')) {
                                const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
                                if (matches) {
                                    parts.push({
                                        inlineData: {
                                            mimeType: matches[1],
                                            data: matches[2]
                                        }
                                    });
                                }
                            }
                        }
                    }
                }

                geminiContents.push({ role: geminiRole, parts });
            }

            const fetchBody = {
                contents: geminiContents,
                generationConfig: {
                    temperature: parseFloat(temperature) || 0.7,
                    topP: parseFloat(top_p) || 0.9,
                    maxOutputTokens: Math.min(parseInt(max_tokens, 10) || 2000, attemptRouting.maxOutputTokens || 8000)
                }
            };

            const systemMsg = finalMessages.find(m => m.role === 'system');
            if (systemMsg) {
                fetchBody.systemInstruction = {
                    parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content) }]
                };
            }

            return {
                isGeminiAPI: true,
                apiUrl: `${attemptProviderConfig.baseURL}/${attemptActualModel}:streamGenerateContent?key=${attemptProviderConfig.apiKey}&alt=sse`,
                fetchHeaders: {
                    'Content-Type': 'application/json'
                },
                fetchBody
            };
        };

        const tryUniversalRuntimeFallback = async ({ failedStatus, failedBody, reason }) => {
            const candidates = getRuntimeFallbackModelIds(finalModel);
            for (const fallbackModel of candidates) {
                const fallbackRouting = MODEL_ROUTING[fallbackModel];
                const fallbackProviderConfig = fallbackRouting ? API_PROVIDERS[fallbackRouting.provider] : null;
                if (!fallbackRouting || !fallbackProviderConfig?.apiKey) {
                    const missingEnv = fallbackProviderConfig?.envKey || fallbackRouting?.provider || fallbackModel;
                    console.warn(` runtime_fallback skip=${fallbackModel} missing=${missingEnv}`);
                    continue;
                }

                const fallbackActualModel = fallbackRouting.model;
                const fallbackUseStreamingTools = !!(internetMode && fallbackRouting.provider !== 'aliyun' && fallbackRouting.supportsWebSearch !== false);
                const fallbackRequestBody = buildRuntimeFallbackRequestBody(fallbackModel, fallbackRouting, fallbackActualModel);
                const payload = buildFetchPayloadForAttempt(
                    fallbackProviderConfig,
                    fallbackRouting,
                    fallbackActualModel,
                    fallbackRequestBody
                );

                const fallbackController = new AbortController();
                const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 120000);
                let fallbackResponse;
                try {
                    const safeFallbackUrl = payload.isGeminiAPI
                        ? payload.apiUrl.replace(/key=[^&]+/, 'key=***')
                        : payload.apiUrl;
                    console.warn(` runtime_fallback try=${fallbackModel} provider=${fallbackRouting.provider} url=${safeFallbackUrl}`);
                    fallbackResponse = await fetch(payload.apiUrl, {
                        method: 'POST',
                        headers: payload.fetchHeaders,
                        body: JSON.stringify(payload.fetchBody),
                        signal: fallbackController.signal
                    });
                } catch (fallbackErr) {
                    clearTimeout(fallbackTimeoutId);
                    console.warn(` runtime_fallback network_failed model=${fallbackModel} error=${fallbackErr.message}`);
                    continue;
                }
                clearTimeout(fallbackTimeoutId);

                if (!fallbackResponse.ok) {
                    const fallbackErrorText = await fallbackResponse.text();
                    console.warn(` runtime_fallback failed model=${fallbackModel} status=${fallbackResponse.status} body=${fallbackErrorText.substring(0, 220)}`);
                    continue;
                }

                routing = fallbackRouting;
                providerConfig = fallbackProviderConfig;
                finalModel = fallbackModel;
                actualModel = fallbackActualModel;
                requestBody = fallbackRequestBody;
                useStreamingTools = fallbackUseStreamingTools;
                isGeminiAPI = payload.isGeminiAPI;

                const fallbackReason = reason || `primary_failed_${failedStatus || 'network'}`;
                res.write(`data: ${JSON.stringify({
                    type: 'model_info',
                    model: finalModel,
                    actualModel,
                    reason: `runtime_fallback:${fallbackReason}`,
                    provider: routing.provider
                })}\n\n`);
                console.warn(` runtime_fallback success model=${fallbackModel} actual=${actualModel} from_status=${failedStatus || 'network'} body=${String(failedBody || '').substring(0, 160)}`);
                return { response: fallbackResponse, errorText: '' };
            }

            return null;
        };

        try {
            let apiUrl, fetchHeaders, fetchBody;

            if (isGeminiAPI) {
                // ============ Gemini API 格式 ============
                // Gemini endpoint: {baseURL}/{modelName}:streamGenerateContent?key=API_KEY&alt=sse
                apiUrl = `${providerConfig.baseURL}/${actualModel}:streamGenerateContent?key=${providerConfig.apiKey}&alt=sse`;

                // Gemini 请求头
                fetchHeaders = {
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

                    // 处理多模态内容（图片）
                    const parts = [];
                    if (Array.isArray(msg.content)) {
                        // OpenAI多模态格式: [{type: 'text', text: '...'}, {type: 'image_url', image_url: {url: '...'}}]
                        for (const item of msg.content) {
                            if (item.type === 'text') {
                                parts.push({ text: item.text });
                            } else if (item.type === 'image_url' && item.image_url?.url) {
                                // 处理base64图片 (data:image/...;base64,...)
                                const imageUrl = item.image_url.url;
                                if (imageUrl.startsWith('data:')) {
                                    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
                                    if (matches) {
                                        parts.push({
                                            inlineData: {
                                                mimeType: matches[1],
                                                data: matches[2]
                                            }
                                        });
                                    }
                                } else {
                                    // 外部URL图片
                                    parts.push({ fileData: { fileUri: imageUrl, mimeType: 'image/jpeg' } });
                                }
                            }
                        }
                    } else {
                        // 纯文本消息
                        parts.push({ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
                    }

                    // 处理附件（如果有）
                    if (msg.attachments && Array.isArray(msg.attachments)) {
                        for (const att of msg.attachments) {
                            if (att.type === 'image' && att.data) {
                                // Base64图片附件
                                const imageData = att.data;
                                if (imageData.startsWith('data:')) {
                                    const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
                                    if (matches) {
                                        parts.push({
                                            inlineData: {
                                                mimeType: matches[1],
                                                data: matches[2]
                                            }
                                        });
                                    }
                                }
                            }
                        }
                    }

                    geminiContents.push({ role: geminiRole, parts });
                }

                // 提取 system prompt
                const systemMsg = finalMessages.find(m => m.role === 'system');

                fetchBody = {
                    contents: geminiContents,
                    generationConfig: {
                        temperature: parseFloat(temperature) || 0.7,
                        topP: parseFloat(top_p) || 0.9,
                        maxOutputTokens: Math.min(parseInt(max_tokens, 10) || 2000, routing.maxOutputTokens || 8000)
                    }
                };

                // 如果有 system prompt，添加为 systemInstruction
                if (systemMsg) {
                    fetchBody.systemInstruction = {
                        parts: [{ text: typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content) }]
                    };
                }

                const safeGeminiApiUrl = apiUrl.replace(/key=[^&]+/, 'key=***');
                console.log(` Gemini API 请求: ${safeGeminiApiUrl}`);
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

            const safeApiUrl = isGeminiAPI ? apiUrl.replace(/key=[^&]+/, 'key=***') : apiUrl;
            console.log(` 正在调用: ${safeApiUrl}`);
            console.log(`   API密钥: 已配置`);

            let apiResponse;
            try {
                apiResponse = await fetch(apiUrl, {
                    method: 'POST',
                    headers: fetchHeaders,
                    body: JSON.stringify(fetchBody),
                    signal: controller.signal
                });
                clearTimeout(timeoutId); // 清除超时定时器
            } catch (primaryFetchError) {
                clearTimeout(timeoutId);
                const fallbackResult = await tryUniversalRuntimeFallback({
                    failedStatus: primaryFetchError.name === 'AbortError' ? 'timeout' : 'network',
                    failedBody: primaryFetchError.message,
                    reason: `${routing.provider}_${actualModel}_${primaryFetchError.name === 'AbortError' ? 'timeout' : 'network_error'}`
                });
                if (fallbackResult?.response) {
                    apiResponse = fallbackResult.response;
                } else {
                    throw primaryFetchError;
                }
            }

            console.log(` API响应状态: ${apiResponse.status} ${apiResponse.statusText}`);

            //  修复错误处理
            if (!apiResponse.ok) {
                let errorText = await apiResponse.text();
                console.error(` API返回错误:`);
                console.error(`   状态码: ${apiResponse.status}`);
                console.error(`   响应体: ${errorText.substring(0, 500)}`);

                if (gpt55QuotaConsumed && finalModel === 'gpt-5.5') {
                    try {
                        const refundedQuota = await refundGpt55Quota(req.user.userId);
                        gpt55QuotaConsumed = false;
                        res.write(`data: ${JSON.stringify({
                            type: 'quota_info',
                            provider: 'newapi_gpt55',
                            gpt55Remaining: refundedQuota.remaining,
                            gpt55Used: refundedQuota.used,
                            gpt55Limit: refundedQuota.limit,
                            resetAt: refundedQuota.resetAt
                        })}\n\n`);
                        console.warn(` gpt55_quota_refund user=${req.user.userId} status=${apiResponse.status}`);
                    } catch (refundError) {
                        console.warn(` GPT-5.5配额回滚失败: ${refundError.message}`);
                    }
                }

                // Poe 4xx 参数错误：去掉 extra_body 重试一次
                if (
                    routing.provider === 'poe' &&
                    fetchBody?.extra_body &&
                    apiResponse.status >= 400 &&
                    apiResponse.status < 500
                ) {
                    console.warn(` poe_fallback retry_without_extra_body model=${finalModel} status=${apiResponse.status}`);
                    const retryBody = { ...requestBody };
                    delete retryBody.extra_body;

                    try {
                        apiResponse = await fetch(apiUrl, {
                            method: 'POST',
                            headers: fetchHeaders,
                            body: JSON.stringify(retryBody)
                        });
                        requestBody = retryBody;
                        fetchBody = retryBody;
                    } catch (retryErr) {
                        const retryErrorMsg = `Poe请求失败(重试无extra_body失败): ${retryErr.message}`;
                        res.write(`data: ${JSON.stringify({ type: 'error', error: retryErrorMsg })}\n\n`);
                        res.end();
                        db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                        return;
                    }

                    if (!apiResponse.ok) {
                        errorText = await apiResponse.text();
                        console.warn(` poe_fallback retry_failed status=${apiResponse.status} body=${errorText.substring(0, 200)}`);
                    } else {
                        console.log(' Poe 参数回退重试成功（已移除 extra_body）');
                    }
                }

                if (!apiResponse.ok) {
                    const fallbackResult = await tryUniversalRuntimeFallback({
                        failedStatus: apiResponse.status,
                        failedBody: errorText,
                        reason: `${routing.provider}_${actualModel}_failed`
                    });
                    if (fallbackResult?.response) {
                        apiResponse = fallbackResult.response;
                        errorText = fallbackResult.errorText || '';
                    }
                }

                // Poe 模型调用失败：回退到 Kimi K2.5（再由通用余额逻辑兜底到Qwen2.5-7B）
                if (
                    !apiResponse.ok &&
                    routing.provider === 'poe' &&
                    apiResponse.status >= 400 &&
                    apiResponse.status < 500
                ) {
                    const fallbackModel = 'kimi-k2.5';
                    const fallbackRouting = MODEL_ROUTING[fallbackModel];
                    const fallbackProviderConfig = fallbackRouting ? API_PROVIDERS[fallbackRouting.provider] : null;

                    if (fallbackRouting && fallbackProviderConfig?.apiKey) {
                        console.warn(` poe_fallback to=${fallbackModel} status=${apiResponse.status}`);
                        routing = fallbackRouting;
                        providerConfig = fallbackProviderConfig;
                        finalModel = fallbackModel;
                        actualModel = fallbackRouting.model;
                        useStreamingTools = !!internetMode;

                        requestBody = {
                            model: actualModel,
                            messages: finalMessages,
                            max_tokens: parseInt(max_tokens, 10) || 2000,
                            stream: true,
                            enable_thinking: !!thinkingMode
                        };
                        if (useStreamingTools) {
                            requestBody.tools = TOOL_DEFINITIONS;
                            requestBody.tool_choice = 'auto';
                        }

                        res.write(`data: ${JSON.stringify({
                            type: 'model_info',
                            model: finalModel,
                            actualModel,
                            reason: 'poe_fallback_to_kimi',
                            provider: routing.provider
                        })}\n\n`);

                        try {
                            apiResponse = await fetch(providerConfig.baseURL, {
                                method: 'POST',
                                headers: {
                                    'Authorization': `Bearer ${providerConfig.apiKey}`,
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify(requestBody)
                            });
                        } catch (fallbackErr) {
                            const fallbackErrorMsg = `AI服务调用失败: Poe回退Kimi请求失败: ${fallbackErr.message}`;
                            res.write(`data: ${JSON.stringify({ type: 'error', error: fallbackErrorMsg })}\n\n`);
                            res.end();
                            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                            return;
                        }

                        if (!apiResponse.ok) {
                            errorText = await apiResponse.text();
                            console.warn(` poe_fallback_to_kimi failed status=${apiResponse.status} body=${errorText.substring(0, 200)}`);
                        } else {
                            console.log(` poe_fallback_to_kimi 成功: ${actualModel}`);
                        }
                    }
                }

                if (!apiResponse.ok) {
                    if (isGeminiAPI && finalModel === 'gemma') {
                        const fallbackProviderConfig = API_PROVIDERS.openrouter;
                        if (fallbackProviderConfig?.apiKey) {
                            console.warn(` Gemma Google API unavailable, fallback to OpenRouter free route: status=${apiResponse.status}`);
                            routing = {
                                provider: 'openrouter',
                                model: 'openrouter/free',
                                fallbackModels: ['openrouter/free', 'openai/gpt-oss-120b:free'],
                                supportsThinking: true,
                                supportsWebSearch: false,
                                multimodal: false
                            };
                            providerConfig = fallbackProviderConfig;
                            actualModel = routing.model;
                            requestBody = {
                                model: actualModel,
                                models: routing.fallbackModels,
                                messages: finalMessages,
                                max_tokens: parseInt(max_tokens, 10) || 2000,
                                stream: true,
                                temperature: parseFloat(temperature) || 0.7,
                                top_p: parseFloat(top_p) || 0.9
                            };
                            applyOpenRouterReasoningParams(requestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);

                            res.write(`data: ${JSON.stringify({
                                type: 'model_info',
                                model: finalModel,
                                actualModel,
                                reason: 'gemma_google_api_fallback',
                                provider: routing.provider
                            })}\n\n`);

                            try {
                                apiResponse = await fetch(providerConfig.baseURL, {
                                    method: 'POST',
                                    headers: {
                                        'Authorization': `Bearer ${providerConfig.apiKey}`,
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify(requestBody)
                                });
                            } catch (fallbackErr) {
                                const fallbackErrorMsg = `AI服务调用失败: Gemma Google API不可用且备用路由失败: ${fallbackErr.message}`;
                                res.write(`data: ${JSON.stringify({ type: 'error', error: fallbackErrorMsg })}\n\n`);
                                res.end();
                                db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                                return;
                            }

                            if (!apiResponse.ok) {
                                errorText = await apiResponse.text();
                                console.warn(` gemma_google_api_fallback failed status=${apiResponse.status} body=${errorText.substring(0, 200)}`);
                            } else {
                                console.log(` Gemma Google API fallback connected: ${actualModel}`);
                            }
                        }
                    }

                    if (!apiResponse.ok) {
                    // SiliconFlow/Kimi 余额不足时，自动回退到免费模型，避免全站不可用
                    const canFallbackToAliyun =
                        isInsufficientBalanceError(apiResponse.status, errorText) &&
                        routing.provider === 'siliconflow';

                    if (canFallbackToAliyun) {
                        const fallbackModel = 'qwen2.5-7b';
                        const fallbackRouting = MODEL_ROUTING[fallbackModel];
                        const fallbackProviderConfig = fallbackRouting ? API_PROVIDERS[fallbackRouting.provider] : null;

                        if (fallbackRouting && fallbackProviderConfig?.apiKey) {
                            console.warn(` 检测到硅基余额不足，自动回退到免费模型 ${fallbackModel}`);
                            routing = fallbackRouting;
                            providerConfig = fallbackProviderConfig;
                            finalModel = fallbackModel;
                            actualModel = fallbackRouting.model;
                            useStreamingTools = !!internetMode;

                            requestBody = buildSiliconflowFreeFallbackRequestBody({
                                actualModel,
                                messages: finalMessages,
                                internetMode,
                                thinkingMode,
                                thinkingBudget,
                                temperature,
                                top_p,
                                max_tokens
                            });

                            res.write(`data: ${JSON.stringify({
                                type: 'model_info',
                                model: finalModel,
                                actualModel,
                                reason: 'fallback_insufficient_balance',
                                provider: routing.provider
                            })}\n\n`);

                            const fallbackController = new AbortController();
                            const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 120000);
                            try {
                                apiResponse = await fetch(providerConfig.baseURL, {
                                    method: 'POST',
                                    headers: {
                                        'Authorization': `Bearer ${providerConfig.apiKey}`,
                                        'Content-Type': 'application/json'
                                    },
                                    body: JSON.stringify(requestBody),
                                    signal: fallbackController.signal
                                });
                            } catch (fallbackErr) {
                                clearTimeout(fallbackTimeoutId);
                                const fallbackMsg = `AI服务调用失败: 余额不足且备用模型请求失败: ${fallbackErr.message}`;
                                res.write(`data: ${JSON.stringify({ type: 'error', error: fallbackMsg })}\n\n`);
                                res.end();
                                db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                                return;
                            }
                            clearTimeout(fallbackTimeoutId);

                            if (!apiResponse.ok) {
                                const fallbackErrorText = await apiResponse.text();
                                console.error(` 备用模型也失败: ${apiResponse.status} ${fallbackErrorText.substring(0, 300)}`);
                                const fallbackMsg = `AI服务调用失败: 主模型余额不足，备用模型失败 ${apiResponse.status} ${fallbackErrorText.substring(0, 100)}`;
                                res.write(`data: ${JSON.stringify({ type: 'error', error: fallbackMsg })}\n\n`);
                                res.end();
                                db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                                return;
                            }

                            console.log(` 备用模型连接成功，继续流式输出: ${fallbackModel}`);
                        } else {
                            const errorMsg = `AI服务调用失败: ${apiResponse.status} ${errorText.substring(0, 100)}`;
                            res.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`);
                            res.end();
                            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                            return;
                        }
                    } else {
                        const errorMsg = `AI服务调用失败: ${apiResponse.status} ${errorText.substring(0, 100)}`;
                        res.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`);
                        res.end();
                        db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                        return;
                    }
                    }
                }
            }

            console.log(' API连接成功，开始接收流式响应\n');

            const reader = apiResponse.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';

            //  流式工具调用：累积 tool_calls 数据
            let accumulatedToolCalls = [];  // 累积的工具调用
            let pendingToolCall = null;     // 当前正在累积的工具调用
            let streamFinishReason = null;  // 流结束原因
            let streamProviderError = null; // 流式事件级错误（HTTP仍可能是200）
            let toolMarkerCarry = '';
            let inToolCallSection = false;
            const TOOL_CALL_SECTION_START = '<|tool_calls_section_begin|>';
            const TOOL_CALL_SECTION_END = '<|tool_calls_section_end|>';
            let thinkTagCarry = '';
            let inThinkSection = false;
            const THINK_SECTION_START = '<think>';
            const THINK_SECTION_END = '</think>';

            const sanitizeStreamingContent = (chunk = '') => {
                if (!useStreamingTools || !chunk) return chunk;

                let text = toolMarkerCarry + chunk;
                toolMarkerCarry = '';
                let visible = '';

                while (text.length > 0) {
                    if (inToolCallSection) {
                        const endIdx = text.indexOf(TOOL_CALL_SECTION_END);
                        if (endIdx === -1) {
                            const carryLen = Math.min(text.length, TOOL_CALL_SECTION_END.length - 1);
                            toolMarkerCarry = text.slice(-carryLen);
                            return visible;
                        }
                        text = text.slice(endIdx + TOOL_CALL_SECTION_END.length);
                        inToolCallSection = false;
                        continue;
                    }

                    const startIdx = text.indexOf(TOOL_CALL_SECTION_START);
                    if (startIdx === -1) {
                        visible += text;
                        text = '';
                    } else {
                        visible += text.slice(0, startIdx);
                        text = text.slice(startIdx + TOOL_CALL_SECTION_START.length);
                        inToolCallSection = true;
                    }
                }

                const incompleteMarkerIdx = visible.lastIndexOf('<|');
                if (incompleteMarkerIdx !== -1 && visible.indexOf('|>', incompleteMarkerIdx) === -1) {
                    toolMarkerCarry = visible.slice(incompleteMarkerIdx);
                    visible = visible.slice(0, incompleteMarkerIdx);
                }

                visible = visible.replace(/<\|[^|]+\|>/g, '');
                visible = visible.replace(/functions\.\w+:\d+/g, '');

                if (/^\s*\{[\s\S]*"query"[\s\S]*\}\s*$/.test(visible)) {
                    return '';
                }

                return visible;
            };

            const splitEmbeddedThinkContent = (chunk = '', allowReasoning = false) => {
                let text = thinkTagCarry + String(chunk || '');
                thinkTagCarry = '';
                let visible = '';
                let reasoning = '';

                while (text.length > 0) {
                    if (inThinkSection) {
                        const endIdx = text.indexOf(THINK_SECTION_END);
                        if (endIdx === -1) {
                            const safeLen = Math.max(0, text.length - (THINK_SECTION_END.length - 1));
                            const reasoningChunk = text.slice(0, safeLen);
                            if (allowReasoning && reasoningChunk) {
                                reasoning += reasoningChunk;
                            }
                            thinkTagCarry = text.slice(safeLen);
                            return { visible, reasoning };
                        }

                        const reasoningChunk = text.slice(0, endIdx);
                        if (allowReasoning && reasoningChunk) {
                            reasoning += reasoningChunk;
                        }
                        text = text.slice(endIdx + THINK_SECTION_END.length);
                        inThinkSection = false;
                        continue;
                    }

                    const startIdx = text.indexOf(THINK_SECTION_START);
                    if (startIdx === -1) {
                        const partialIdx = text.lastIndexOf('<');
                        if (partialIdx !== -1 && THINK_SECTION_START.startsWith(text.slice(partialIdx))) {
                            visible += text.slice(0, partialIdx);
                            thinkTagCarry = text.slice(partialIdx);
                            return { visible, reasoning };
                        }
                        visible += text;
                        text = '';
                        continue;
                    }

                    visible += text.slice(0, startIdx);
                    text = text.slice(startIdx + THINK_SECTION_START.length);
                    inThinkSection = true;
                }

                return { visible, reasoning };
            };

            // 某些模型会把“累计文本”重复放在后续delta中，这里统一做去重增量提取
            const extractIncrementalChunk = (accumulated = '', incoming = '') => {
                const acc = typeof accumulated === 'string' ? accumulated : String(accumulated || '');
                const inc = typeof incoming === 'string' ? incoming : String(incoming || '');
                if (!inc) return '';
                if (!acc) return inc;
                if (inc === acc) return '';
                if (inc.startsWith(acc)) return inc.slice(acc.length);
                if (acc.endsWith(inc)) return '';

                const maxOverlap = Math.min(acc.length, inc.length);
                for (let i = maxOverlap; i > 0; i -= 1) {
                    if (acc.slice(-i) === inc.slice(0, i)) {
                        return inc.slice(i);
                    }
                }

                return inc;
            };

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
                    console.log(` 请求被用户取消: ${requestId}`);
                    res.write(`data: ${JSON.stringify({ type: 'cancelled' })}\n\n`);
                    res.end();
                    reader.cancel();
                    break;
                }

                const { done, value } = await reader.read();
                if (done) {
                    const flushed = buffer + decoder.decode();
                    buffer = flushed ? (flushed + '\n') : '';
                } else {
                    buffer += decoder.decode(value, { stream: true });
                }

                const lines = buffer.split(/\r?\n/);
                buffer = done ? '' : (lines.pop() || '');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;

                    if (trimmed.startsWith('data: ')) {
                        const data = trimmed.slice(6);
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed?.error) {
                                const errPayload = parsed.error;
                                const errMessage = typeof errPayload === 'string'
                                    ? errPayload
                                    : (errPayload?.message || JSON.stringify(errPayload));
                                streamProviderError = errMessage;
                                console.error(` 流式事件错误(${routing.provider}): ${errMessage}`);
                                continue;
                            }

                            const responseEventReasoning = extractReasoningTextFromResponseEvent(parsed);
                            if (responseEventReasoning) {
                                if (thinkingMode) {
                                    const reasoningDelta = extractIncrementalChunk(reasoningContent, responseEventReasoning);
                                    if (reasoningDelta) {
                                        reasoningContent += reasoningDelta;
                                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                    }
                                }
                                continue;
                            }

                            const responseEventContent = extractOutputTextFromResponseEvent(parsed);
                            if (responseEventContent) {
                                rawToolContent += responseEventContent;
                                const filteredContent = sanitizeStreamingContent(responseEventContent);
                                const splitThinkContent = splitEmbeddedThinkContent(filteredContent, !!thinkingMode);
                                if (splitThinkContent.reasoning) {
                                    const reasoningDelta = extractIncrementalChunk(reasoningContent, splitThinkContent.reasoning);
                                    if (reasoningDelta) {
                                        reasoningContent += reasoningDelta;
                                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                    }
                                }
                                const incrementalContent = extractIncrementalChunk(fullContent, splitThinkContent.visible);
                                if (incrementalContent.length > 0) {
                                    emitStructuredAssistantChunk(incrementalContent);
                                }
                                continue;
                            }

                            if (isGeminiAPI) {
                                // ============ Gemini 响应格式解析 ============
                                // Gemini 响应结构: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
                                const candidate = parsed.candidates?.[0];
                                if (candidate) {
                                    const parts = candidate.content?.parts || [];
                                    for (const part of parts) {
                                        if (!part.text) continue;
                                        if (part.thought) {
                                            if (thinkingMode) {
                                                const reasoningDelta = extractIncrementalChunk(reasoningContent, part.text);
                                                if (reasoningDelta) {
                                                    reasoningContent += reasoningDelta;
                                                    res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                                }
                                            }
                                            continue;
                                        }

                                        const visibleDelta = extractIncrementalChunk(fullContent, part.text);
                                        if (visibleDelta) {
                                            emitStructuredAssistantChunk(visibleDelta);
                                        }
                                    }
                                }
                            } else {
                                // ============ OpenAI 兼容格式解析 ============
                                const choice = parsed.choices?.[0];

                                //  修复：处理推理内容（支持 DeepSeek 和 Qwen）
                                const delta = choice?.delta || {};
                                const reasoning = extractReasoningTextFromPayload(delta);
                                const content = delta.content;

                                if (reasoning && thinkingMode) {
                                    const reasoningDelta = extractIncrementalChunk(reasoningContent, reasoning);
                                    if (reasoningDelta) {
                                        reasoningContent += reasoningDelta;
                                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                    }
                                }

                                if (content) {
                                    rawToolContent += content;
                                    const filteredContent = sanitizeStreamingContent(content);
                                    const splitThinkContent = splitEmbeddedThinkContent(filteredContent, !!thinkingMode);

                                    if (splitThinkContent.reasoning) {
                                        const reasoningDelta = extractIncrementalChunk(reasoningContent, splitThinkContent.reasoning);
                                        if (reasoningDelta) {
                                            reasoningContent += reasoningDelta;
                                            res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                        }
                                    }

                                    const incrementalContent = extractIncrementalChunk(fullContent, splitThinkContent.visible);

                                    if (incrementalContent.length > 0) {
                                        if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('synthesizer') && !agentSynthesizerRunning) {
                                            emitAgentEvent(res, {
                                                type: 'agent_status',
                                                role: 'synthesizer',
                                                status: 'running',
                                                detail: '正在生成候选答案'
                                                });
                                            agentSynthesizerRunning = true;
                                        }
                                        emitStructuredAssistantChunk(incrementalContent);
                                    }
                                }

                                //  流式工具调用：检测 tool_calls
                                if (delta.tool_calls && useStreamingTools) {
                                    for (const tc of delta.tool_calls) {
                                        const idx = tc.index || 0;

                                        // 初始化或更新工具调用
                                        if (!accumulatedToolCalls[idx]) {
                                            accumulatedToolCalls[idx] = {
                                                id: tc.id || `call_${Date.now()}_${idx}`,
                                                type: 'function',
                                                function: {
                                                    name: tc.function?.name || '',
                                                    arguments: ''
                                                }
                                            };
                                        }

                                        // 累积函数名（可能分片传输）
                                        if (tc.function?.name) {
                                            accumulatedToolCalls[idx].function.name = tc.function.name;
                                        }

                                        // 累积参数（JSON字符串分片传输）
                                        if (tc.function?.arguments) {
                                            accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                                        }
                                    }
                                }

                                // 记录 finish_reason
                                if (choice?.finish_reason) {
                                    streamFinishReason = choice.finish_reason;
                                }

                                // 处理阿里云原生联网的 search_info
                                const searchInfo = parsed.search_info || parsed.output?.search_info;
                                if (searchInfo && searchInfo.search_results && searchInfo.search_results.length > 0) {
                                    const qwenSources = searchInfo.search_results.map(r => ({
                                        title: r.title || '未知来源',
                                        url: r.url || '',
                                        favicon: r.icon || '',
                                        site_name: r.site_name || '',
                                        provider: 'aliyun_search',
                                        sourceKind: 'web',
                                        markerType: 'numeric',
                                        label: 'Web Search'
                                    }));
                                    const sourceAppendResult = appendAnnotatedSources(searchSources, qwenSources);
                                    searchSources = sourceAppendResult.merged;
                                    emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                                    console.log(` 阿里云search_info: 已发送 ${sourceAppendResult.newlyAdded.length} 个来源`);
                                }
                            }
                        } catch (e) {
                            console.error(' 解析响应行错误:', e.message);
                        }
                    }
                }

                if (done) {
                    console.log(' 流式响应结束');
                    break;
                }
            }

            // Poe 在部分错误场景会返回 HTTP 200 + SSE error 事件，导致无正文但不触发HTTP错误分支
            // 这里做兜底回退，避免前端只看到“生成中断”
            if (routing.provider === 'poe' && !String(fullContent || '').trim()) {
                console.warn(` poe_fallback empty_stream -> kimi-k2.5 reason=${streamProviderError || 'empty_stream'}`);
                const fallbackModel = 'kimi-k2.5';
                const fallbackRouting = MODEL_ROUTING[fallbackModel];
                const fallbackProviderConfig = fallbackRouting ? API_PROVIDERS[fallbackRouting.provider] : null;

                if (!fallbackRouting || !fallbackProviderConfig?.apiKey) {
                    const fallbackErrorMsg = `Poe流式输出为空: ${streamProviderError || 'empty_stream'}`;
                    res.write(`data: ${JSON.stringify({ type: 'error', error: fallbackErrorMsg })}\n\n`);
                    res.end();
                    db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                    return;
                }

                routing = fallbackRouting;
                providerConfig = fallbackProviderConfig;
                finalModel = fallbackModel;
                actualModel = fallbackRouting.model;
                useStreamingTools = false;

                res.write(`data: ${JSON.stringify({
                    type: 'model_info',
                    model: finalModel,
                    actualModel,
                    reason: 'poe_stream_error_fallback_to_kimi',
                    provider: routing.provider
                })}\n\n`);

                const fallbackBody = {
                    model: actualModel,
                    messages: finalMessages,
                    max_tokens: parseInt(max_tokens, 10) || 2000,
                    stream: false,
                    enable_thinking: !!thinkingMode
                };

                let fallbackResponse;
                try {
                    fallbackResponse = await fetch(providerConfig.baseURL, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${providerConfig.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(fallbackBody)
                    });
                } catch (fallbackErr) {
                    const fallbackErrorMsg = `Poe回退Kimi失败: ${fallbackErr.message}`;
                    res.write(`data: ${JSON.stringify({ type: 'error', error: fallbackErrorMsg })}\n\n`);
                    res.end();
                    db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                    return;
                }

                if (!fallbackResponse.ok) {
                    const fallbackErrorText = await fallbackResponse.text();
                    const fallbackErrorMsg = `Poe回退Kimi失败: ${fallbackResponse.status} ${fallbackErrorText.substring(0, 180)}`;
                    res.write(`data: ${JSON.stringify({ type: 'error', error: fallbackErrorMsg })}\n\n`);
                    res.end();
                    db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
                    return;
                }

                const fallbackJson = await fallbackResponse.json();
                let fallbackContent = fallbackJson?.choices?.[0]?.message?.content || '';
                if (Array.isArray(fallbackContent)) {
                    fallbackContent = fallbackContent
                        .map((part) => {
                            if (typeof part === 'string') return part;
                            if (part?.text) return part.text;
                            if (typeof part?.content === 'string') return part.content;
                            return '';
                        })
                        .join('');
                } else if (typeof fallbackContent !== 'string') {
                    fallbackContent = String(fallbackContent || '');
                }
                const cleanedFallbackContent = sanitizeStreamingContent(fallbackContent);
                const splitFallbackContent = splitEmbeddedThinkContent(cleanedFallbackContent, !!thinkingMode);
                if (splitFallbackContent.visible) {
                    emitStructuredAssistantChunk(splitFallbackContent.visible);
                }

                const fallbackChoice = fallbackJson?.choices?.[0] || {};
                const fallbackReasoning = extractReasoningTextFromPayload(fallbackChoice.message || {}, fallbackChoice, fallbackJson);
                if (splitFallbackContent.reasoning && thinkingMode) {
                    reasoningContent += String(splitFallbackContent.reasoning);
                    res.write(`data: ${JSON.stringify({ type: 'reasoning', content: String(splitFallbackContent.reasoning) })}\n\n`);
                }
                if (fallbackReasoning && thinkingMode) {
                    reasoningContent += String(fallbackReasoning);
                    res.write(`data: ${JSON.stringify({ type: 'reasoning', content: String(fallbackReasoning) })}\n\n`);
                }

                streamFinishReason = 'stop';
            }

            const extractFallbackToolCalls = (rawText = '') => {
                const trimmedText = String(rawText || '').trim();
                const fallbackCalls = [];

                if (!trimmedText) return fallbackCalls;

                // 1) JSON 数组格式
                if (trimmedText.startsWith('[') && trimmedText.includes('web_search')) {
                    try {
                        const parsedCalls = JSON.parse(trimmedText);
                        if (Array.isArray(parsedCalls)) {
                            for (const call of parsedCalls) {
                                if ((call?.name === 'web_search' || call?.name === 'finance_quote') && call.arguments) {
                                    fallbackCalls.push({
                                        name: call.name,
                                        arguments: call.arguments
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        // ignore
                    }
                }

                // 2) Kimi 标记格式
                if (fallbackCalls.length === 0 && trimmedText.includes('<|tool_call_begin|>')) {
                    const markerRegex = /<\|tool_call_begin\|>\s*functions\.(\w+)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*({[\s\S]*?})\s*(?:<\|tool_call_end\|>|<\|tool_calls_section_end\|>|$)/g;
                    let markerMatch;
                    while ((markerMatch = markerRegex.exec(trimmedText)) !== null) {
                        const functionName = markerMatch[1];
                        const argumentText = markerMatch[2];
                        if (functionName !== 'web_search' && functionName !== 'finance_quote') continue;

                        try {
                            fallbackCalls.push({
                                name: functionName,
                                arguments: JSON.parse(argumentText)
                            });
                        } catch (e) {
                            console.warn(' 无法解析工具参数(JSON):', argumentText);
                        }
                    }
                }

                // 3) 松散文本格式
                if (fallbackCalls.length === 0 && trimmedText.includes('functions.')) {
                    const looseRegex = /functions\.(\w+)(?::\d+)?[\s\S]{0,160}?(\{[\s\S]*?"(?:query|symbol)"[\s\S]*?\})/g;
                    let looseMatch;
                    while ((looseMatch = looseRegex.exec(trimmedText)) !== null) {
                        const functionName = looseMatch[1];
                        const argumentText = looseMatch[2];
                        if (functionName !== 'web_search' && functionName !== 'finance_quote') continue;

                        try {
                            fallbackCalls.push({
                                name: functionName,
                                arguments: JSON.parse(argumentText)
                            });
                        } catch (e) {
                            // ignore broken fragments
                        }
                    }
                }

                return fallbackCalls;
            };

            const normalizeToolCalls = (toolCalls = []) => {
                const normalized = [];
                for (const toolCall of toolCalls) {
                    if (!toolCall || !toolCall.function?.name) continue;

                    let args;
                    try {
                        args = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        continue;
                    }

                    const toolName = String(toolCall.function.name || '').trim();
                    if (toolName === 'web_search') {
                        if (!args || typeof args !== 'object' || typeof args.query !== 'string' || !args.query.trim()) {
                            continue;
                        }

                        normalized.push({
                            ...toolCall,
                            function: {
                                ...toolCall.function,
                                arguments: JSON.stringify({ query: args.query.trim() })
                            },
                            _args: { query: args.query.trim() }
                        });
                        continue;
                    }

                    if (toolName === 'finance_quote') {
                        const rawSymbol = String(args.symbol || args.ticker || '').trim();
                        if (!rawSymbol) {
                            continue;
                        }

                        let normalizedArgs;
                        try {
                            normalizedArgs = {
                                symbol: resolveFinanceSymbol(rawSymbol),
                                range: normalizeFinanceRange(args.range || FINANCE_DEFAULT_RANGE),
                                interval: normalizeFinanceInterval(args.interval || FINANCE_DEFAULT_INTERVAL)
                            };
                        } catch (error) {
                            continue;
                        }

                        normalized.push({
                            ...toolCall,
                            function: {
                                ...toolCall.function,
                                arguments: JSON.stringify(normalizedArgs)
                            },
                            _args: normalizedArgs
                        });
                    }
                }
                return normalized;
            };

            // 初始流 fallback：模型可能把 tool_calls 作为文本输出
            if (useStreamingTools && accumulatedToolCalls.length === 0 && rawToolContent) {
                const fallbackCalls = extractFallbackToolCalls(rawToolContent);
                if (fallbackCalls.length > 0) {
                    console.log(` 检测到 AI 以文本形式输出工具调用，已转换为标准 tool_calls: ${fallbackCalls.length} 个`);
                    for (let i = 0; i < fallbackCalls.length; i++) {
                        const call = fallbackCalls[i];
                        accumulatedToolCalls.push({
                            id: `fallback_call_${Date.now()}_${i}`,
                            type: 'function',
                            function: {
                                name: call.name,
                                arguments: JSON.stringify(call.arguments)
                            }
                        });
                    }
                }
            }

            if (useStreamingTools && streamFinishReason !== 'tool_calls' && accumulatedToolCalls.length === 0) {
                console.warn(` 联网模式已开启，但模型未触发工具调用: model=${actualModel}`);
                if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                    emitAgentEvent(res, {
                        type: 'agent_status',
                        role: 'researcher',
                        status: 'done',
                        detail: '本轮未触发外部检索'
                    });
                }
            }

            // 流式 + 多轮工具调用
            if (useStreamingTools && accumulatedToolCalls.length > 0) {
                let pendingToolCalls = normalizeToolCalls(accumulatedToolCalls);
                if (pendingToolCalls.length === 0) {
                    console.warn(` 收到 tool_calls 但均无效，已跳过`);
                } else {
                    let toolRound = 0;
                    const maxToolRounds = 5;
                    let conversationMessages = [...finalMessages];

                    while (pendingToolCalls.length > 0 && toolRound < maxToolRounds) {
                        toolRound += 1;
                        console.log(` 工具调用轮次: ${toolRound}, calls=${pendingToolCalls.length}`);

                        const executedToolResults = [];
                        for (const toolCall of pendingToolCalls) {
                            const toolName = toolCall.function.name;
                            const args = toolCall._args;

                            console.log(` 执行工具: ${toolName}, args=${JSON.stringify(args)}`);
                            const isSearchTool = toolName === 'web_search';
                            if (isSearchTool && agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                                emitAgentEvent(res, {
                                    type: 'agent_status',
                                    role: 'researcher',
                                    status: 'running',
                                    detail: `检索中: ${args.query}`
                                });
                                agentResearcherRunning = true;
                            }
                            if (isSearchTool) {
                                res.write(`data: ${JSON.stringify({
                                    type: 'search_status',
                                    status: 'searching',
                                    query: args.query,
                                    message: `正在搜索: "${args.query}"`
                                })}\n\n`);
                            }

                            const executor = TOOL_EXECUTORS[toolName];
                            if (!executor) {
                                console.warn(` 未找到工具执行器: ${toolName}`);
                                continue;
                            }

                            const searchDepth = isSearchTool ? getTavilySearchDepth(actualModel, thinkingMode) : null;
                            const result = isSearchTool
                                ? await executor(args, searchDepth)
                                : await executor(args);

                            if (isSearchTool) {
                                const searchResults = result.results || result;
                                let searchImages = result.images || [];
                                if (searchImages.length > 0) {
                                    searchImages = await filterValidImages(searchImages, 5, 3000);
                                }

                                if (searchResults && searchResults.length > 0) {
                                    const currentSources = extractSourcesForSSE(searchResults);
                                    const sourceAppendResult = appendAnnotatedSources(searchSources, currentSources);
                                    searchSources = sourceAppendResult.merged;

                                    res.write(`data: ${JSON.stringify({
                                        type: 'search_status',
                                        status: 'complete',
                                        query: args.query,
                                        resultCount: searchResults.length,
                                        message: `找到 ${searchResults.length} 条结果`
                                    })}\n\n`);

                                    emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                                    executedToolResults.push({
                                        toolCall,
                                        result: buildToolResultForLLM({
                                            toolName,
                                            result: {
                                                ...result,
                                                images: searchImages
                                            },
                                            sources: sourceAppendResult.newlyAdded,
                                            args
                                        })
                                    });
                                    console.log(` 工具执行完成: ${searchResults.length} 条结果`);
                                    if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                                        emitAgentEvent(res, {
                                            type: 'agent_status',
                                            role: 'researcher',
                                            status: 'done',
                                            detail: `完成检索: ${searchResults.length} 条结果`
                                        });
                                        agentResearcherRunning = false;
                                    }
                                } else {
                                    res.write(`data: ${JSON.stringify({
                                        type: 'search_status',
                                        status: 'no_results',
                                        query: args.query,
                                        message: '未找到相关结果'
                                    })}\n\n`);
                                    executedToolResults.push({
                                        toolCall,
                                        result: buildToolResultForLLM({
                                            toolName,
                                            result: {
                                                ...result,
                                                images: searchImages
                                            },
                                            sources: [],
                                            args
                                        })
                                    });
                                    if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                                        emitAgentEvent(res, {
                                            type: 'agent_status',
                                            role: 'researcher',
                                            status: 'done',
                                            detail: '检索完成: 无结果'
                                        });
                                        agentResearcherRunning = false;
                                    }
                                }
                            } else {
                                const financeSources = buildFinanceSourceForSSE(result);
                                const sourceAppendResult = appendAnnotatedSources(searchSources, financeSources);
                                searchSources = sourceAppendResult.merged;
                                emitSourcesEvent(res, sourceAppendResult.newlyAdded);
                                executedToolResults.push({
                                    toolCall,
                                    result: buildToolResultForLLM({
                                        toolName,
                                        result,
                                        sources: sourceAppendResult.newlyAdded,
                                        args
                                    })
                                });
                                console.log(` 工具执行完成: finance_quote symbol=${result?.resolvedSymbol || args.symbol}`);
                            }
                        }

                        if (executedToolResults.length === 0) {
                            console.warn(` 本轮没有可执行的工具结果，结束工具循环`);
                            break;
                        }

                        // 将本轮工具调用 + 工具结果加入上下文，发起下一轮流式生成
                        const assistantToolCallMessage = {
                            role: 'assistant',
                            content: null,
                            tool_calls: executedToolResults.map(({ toolCall }) => ({
                                id: toolCall.id,
                                type: 'function',
                                function: {
                                    name: toolCall.function.name,
                                    arguments: toolCall.function.arguments
                                }
                            }))
                        };
                        const toolResultMessages = executedToolResults.map(({ toolCall, result }) => ({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify(result)
                        }));
                        conversationMessages = [...conversationMessages, assistantToolCallMessage, ...toolResultMessages];

                        const continueRequestBody = {
                            model: actualModel,
                            messages: conversationMessages,
                            max_tokens: parseInt(max_tokens, 10) || 2000,
                            stream: true,
                            tools: TOOL_DEFINITIONS,
                            tool_choice: "auto"
                        };
                        if (routing.provider === 'openrouter' && Array.isArray(routing.fallbackModels) && routing.fallbackModels.length > 1) {
                            continueRequestBody.models = routing.fallbackModels;
                        }

                        if (isKimiK25Model) {
                            if (routing.provider === 'siliconflow') {
                                continueRequestBody.enable_thinking = !!thinkingMode;
                            } else {
                                continueRequestBody.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
                            }
                        } else {
                            continueRequestBody.temperature = parseFloat(temperature) || 0.7;
                            continueRequestBody.top_p = parseFloat(top_p) || 0.9;
                            const continueThinkingBudget = resolveThinkingBudgetForModel(actualModel, !!thinkingMode, thinkingBudget);
                            if (continueThinkingBudget !== null) {
                                continueRequestBody.thinking_budget = continueThinkingBudget;
                            }
                        }
                        if (routing.provider === 'deepseek') {
                            applyDeepSeekV4ModeParams(continueRequestBody, !!thinkingMode, normalizedReasoningProfile);
                        }
                        if (routing.provider === 'newapi') {
                            applyNewApiModelParams(continueRequestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);
                        }
                        if (routing.provider === 'openrouter') {
                            applyOpenRouterReasoningParams(continueRequestBody, actualModel, !!thinkingMode, normalizedReasoningProfile);
                        }
                        if (routing.provider === 'poe') {
                            const poeExtraBody = buildPoeExtraBody(finalModel, normalizedReasoningProfile, !!thinkingMode);
                            if (poeExtraBody && Object.keys(poeExtraBody).length > 0) {
                                continueRequestBody.extra_body = poeExtraBody;
                            }
                        }

                        console.log(` 发起续传流式调用 (round=${toolRound})...`);
                        // 重置工具标记清洗器状态，避免跨轮污染
                        toolMarkerCarry = '';
                        inToolCallSection = false;
                        thinkTagCarry = '';
                        inThinkSection = false;

                        const continueResponse = await fetch(providerConfig.baseURL, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${providerConfig.apiKey}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify(continueRequestBody)
                        });

                        if (!continueResponse.ok) {
                            const continueErr = await continueResponse.text();
                            console.error(` 续传请求失败: ${continueResponse.status} ${continueErr.substring(0, 300)}`);
                            break;
                        }

                        const continueReader = continueResponse.body.getReader();
                        const continueDecoder = new TextDecoder('utf-8');
                        let continueBuffer = '';
                        let continueRawToolContent = '';
                        let continueStreamFinishReason = null;
                        const continueAccumulatedToolCalls = [];

                        while (true) {
                            const { done: continueDone, value: continueValue } = await continueReader.read();
                            if (continueDone) {
                                const continueFlushed = continueBuffer + continueDecoder.decode();
                                continueBuffer = continueFlushed ? (continueFlushed + '\n') : '';
                            } else {
                                continueBuffer += continueDecoder.decode(continueValue, { stream: true });
                            }

                            const continueLines = continueBuffer.split(/\r?\n/);
                            continueBuffer = continueDone ? '' : (continueLines.pop() || '');
                            for (const continueLine of continueLines) {
                                const continueTrimmed = continueLine.trim();
                                if (!continueTrimmed || continueTrimmed === 'data: [DONE]') continue;
                                if (!continueTrimmed.startsWith('data: ')) continue;

                                try {
                                    const continueParsed = JSON.parse(continueTrimmed.slice(6));
                                    const continueEventReasoning = extractReasoningTextFromResponseEvent(continueParsed);
                                    if (continueEventReasoning) {
                                        if (thinkingMode) {
                                            const reasoningDelta = extractIncrementalChunk(reasoningContent, continueEventReasoning);
                                            if (reasoningDelta) {
                                                reasoningContent += reasoningDelta;
                                                res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                            }
                                        }
                                        continue;
                                    }

                                    const continueEventContent = extractOutputTextFromResponseEvent(continueParsed);
                                    if (continueEventContent) {
                                        continueRawToolContent += continueEventContent;
                                        rawToolContent += continueEventContent;
                                        const filteredContinueContent = sanitizeStreamingContent(continueEventContent);
                                        const splitContinueThink = splitEmbeddedThinkContent(filteredContinueContent, !!thinkingMode);
                                        if (splitContinueThink.reasoning) {
                                            const reasoningDelta = extractIncrementalChunk(reasoningContent, splitContinueThink.reasoning);
                                            if (reasoningDelta) {
                                                reasoningContent += reasoningDelta;
                                                res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                            }
                                        }
                                        const incrementalContinueContent = extractIncrementalChunk(fullContent, splitContinueThink.visible);
                                        if (incrementalContinueContent.length > 0) {
                                            emitStructuredAssistantChunk(incrementalContinueContent);
                                        }
                                        continue;
                                    }

                                    const continueChoice = continueParsed.choices?.[0];
                                    const continueDelta = continueChoice?.delta || {};

                                    if (continueChoice?.finish_reason) {
                                        continueStreamFinishReason = continueChoice.finish_reason;
                                    }

                                    const reasoning = extractReasoningTextFromPayload(continueDelta);
                                    if (reasoning && thinkingMode) {
                                        const reasoningDelta = extractIncrementalChunk(reasoningContent, reasoning);
                                        if (reasoningDelta) {
                                            reasoningContent += reasoningDelta;
                                            res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                        }
                                    }

                                    if (continueDelta.content) {
                                        continueRawToolContent += continueDelta.content;
                                        rawToolContent += continueDelta.content;
                                        const filteredContinueContent = sanitizeStreamingContent(continueDelta.content);
                                        const splitContinueThink = splitEmbeddedThinkContent(filteredContinueContent, !!thinkingMode);
                                        if (splitContinueThink.reasoning) {
                                            const reasoningDelta = extractIncrementalChunk(reasoningContent, splitContinueThink.reasoning);
                                            if (reasoningDelta) {
                                                reasoningContent += reasoningDelta;
                                                res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoningDelta })}\n\n`);
                                            }
                                        }
                                        const incrementalContinueContent = extractIncrementalChunk(fullContent, splitContinueThink.visible);
                                        if (incrementalContinueContent.length > 0) {
                                            if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('synthesizer') && !agentSynthesizerRunning) {
                                                emitAgentEvent(res, {
                                                    type: 'agent_status',
                                                    role: 'synthesizer',
                                                    status: 'running',
                                                    detail: '正在生成候选答案'
                                                });
                                                agentSynthesizerRunning = true;
                                            }
                                            emitStructuredAssistantChunk(incrementalContinueContent);
                                        }
                                    }

                                    if (continueDelta.tool_calls && useStreamingTools) {
                                        for (const tc of continueDelta.tool_calls) {
                                            const idx = tc.index || 0;
                                            if (!continueAccumulatedToolCalls[idx]) {
                                                continueAccumulatedToolCalls[idx] = {
                                                    id: tc.id || `continue_call_${Date.now()}_${idx}`,
                                                    type: 'function',
                                                    function: {
                                                        name: tc.function?.name || '',
                                                        arguments: ''
                                                    }
                                                };
                                            }
                                            if (tc.function?.name) {
                                                continueAccumulatedToolCalls[idx].function.name = tc.function.name;
                                            }
                                            if (tc.function?.arguments) {
                                                continueAccumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                                            }
                                        }
                                    }
                                } catch (e) {
                                    // ignore
                                }
                            }

                            if (continueDone) {
                                break;
                            }
                        }

                        // 续传流 fallback：处理文本型工具调用标记
                        if (continueAccumulatedToolCalls.length === 0 && continueRawToolContent) {
                            const fallbackCalls = extractFallbackToolCalls(continueRawToolContent);
                            if (fallbackCalls.length > 0) {
                                for (let i = 0; i < fallbackCalls.length; i++) {
                                    const call = fallbackCalls[i];
                                    continueAccumulatedToolCalls.push({
                                        id: `continue_fallback_call_${Date.now()}_${i}`,
                                        type: 'function',
                                        function: {
                                            name: call.name,
                                            arguments: JSON.stringify(call.arguments)
                                        }
                                    });
                                }
                            }
                        }

                        pendingToolCalls = normalizeToolCalls(continueAccumulatedToolCalls);
                        console.log(` 续传流式调用完成 (round=${toolRound}), next_tool_calls=${pendingToolCalls.length}, finish_reason=${continueStreamFinishReason || 'unknown'}`);
                    }

                    if (toolRound >= maxToolRounds && pendingToolCalls.length > 0) {
                        console.warn(` 工具调用轮次达到上限(${maxToolRounds})，强制结束以避免死循环`);
                    }
                }
            }
        } catch (fetchError) {

            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                console.error(' API请求超时 (120s)');
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI服务请求超时(120秒)，请检查网络连接或稍后重试' })}\n\n`);
            } else if (fetchError.cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
                console.error(' 连接超时:', fetchError.message);
                console.error('   可能原因: 1) 网络不稳定 2) API服务响应慢 3) 防火墙阻止');
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'AI服务连接超时，请检查：1) 网络连接是否正常 2) 服务器防火墙设置 3) API服务状态，然后重试' })}\n\n`);
            } else {
                console.error(' Fetch错误:', fetchError);
                res.write(`data: ${JSON.stringify({ type: 'error', error: `网络请求失败: ${fetchError.message}` })}\n\n`);
            }
            res.end();
            db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
            return;
        }

        if (agentRuntime.enabled) {
            if (agentRuntime.selectedAgents.includes('synthesizer')) {
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'synthesizer',
                    status: 'done',
                    detail: '候选答案生成完成'
                });
            }

            if (agentRuntime.selectedAgents.includes('verifier')) {
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'verifier',
                    status: 'start',
                    detail: '开始质量审查'
                });
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'verifier',
                    status: 'running',
                    detail: '执行事实与一致性校验'
                });

                let qualityResult = runVerifier({
                    qualityProfile: agentRuntime.qualityProfile,
                    content: fullContent,
                    sources: searchSources,
                    fingerprint: agentRuntime.fingerprint
                });

                emitAgentEvent(res, {
                    type: 'agent_quality',
                    pass: qualityResult.pass,
                    profile: agentRuntime.qualityProfile,
                    metrics: qualityResult.metrics,
                    thresholds: qualityResult.thresholds,
                    round: agentRuntime.retriesUsed
                });

                while (!qualityResult.pass && agentRuntime.retriesUsed < AGENT_MAX_RETRIES) {
                    agentRuntime.retriesUsed += 1;
                    const reason = `coverage=${qualityResult.metrics.claimCoverage}, contradictions=${qualityResult.metrics.contradictionCount}, sourceQuality=${qualityResult.metrics.sourceQualityScore}`;
                    emitAgentEvent(res, {
                        type: 'agent_retry',
                        round: agentRuntime.retriesUsed,
                        reason,
                        action: agentRuntime.retriesUsed < AGENT_MAX_RETRIES ? 'recheck' : 'degrade_to_conservative'
                    });

                    if (agentRuntime.retriesUsed >= AGENT_MAX_RETRIES) {
                        const conservativeNote = buildConservativeFallbackNote(agentRuntime.fingerprint);
                        emitStructuredAssistantChunk(conservativeNote);
                    }

                    qualityResult = runVerifier({
                        qualityProfile: agentRuntime.qualityProfile,
                        content: fullContent,
                        sources: searchSources,
                        fingerprint: agentRuntime.fingerprint
                    });

                    emitAgentEvent(res, {
                        type: 'agent_quality',
                        pass: qualityResult.pass,
                        profile: agentRuntime.qualityProfile,
                        metrics: qualityResult.metrics,
                        thresholds: qualityResult.thresholds,
                        round: agentRuntime.retriesUsed
                    });
                }

                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'verifier',
                    status: 'done',
                    detail: qualityResult.pass ? '质量门控通过' : '质量门控未通过，已降级保守输出'
                });
            } else {
                const qualityResult = runVerifier({
                    qualityProfile: agentRuntime.qualityProfile,
                    content: fullContent,
                    sources: searchSources,
                    fingerprint: agentRuntime.fingerprint || { freshnessNeed: internetMode }
                });
                emitAgentEvent(res, {
                    type: 'agent_quality',
                    pass: qualityResult.pass,
                    profile: agentRuntime.qualityProfile,
                    metrics: qualityResult.metrics,
                    thresholds: qualityResult.thresholds,
                    round: 0
                });
            }
        }

        //  完整的消息保存逻辑
        if (sessionId) {
            console.log('\n 开始保存消息到数据库');

            // 1. 保存用户消息（包含附件信息）
            const lastUserMsg = messages[messages.length - 1];
            if (lastUserMsg && lastUserMsg.role === 'user') {
                const userContent = typeof lastUserMsg.content === 'string'
                    ? stripInlinePromptTimeHint(lastUserMsg.content)
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
                    console.log(` 保存 ${previewAttachments.length} 个附件信息`);
                }

                // 使用毫秒级时间戳确保用户消息严格早于AI消息
                const userMsgTimestamp = new Date().toISOString();
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content, attachments, created_at) VALUES (?, ?, ?, ?, ?)',
                        [sessionId, 'user', userContent, attachmentsJson, userMsgTimestamp],
                        (err) => {
                            if (err) {
                                console.error(' 保存用户消息失败:', err);
                                reject(err);
                            } else {
                                console.log(` 用户消息已保存 (${userContent.length}字符${attachmentsJson ? ', 含附件' : ''})`);
                                resolve();
                            }
                        }
                    );
                });
            }

            // 2. 提取并处理标题 / 画布Patch (如果存在)
            let contentToSave = fullContent || (reasoningContent ? '(纯思考内容)' : '(生成中断)');
            // 兜底清洗：避免工具调用标记残留到数据库
            contentToSave = contentToSave
                .replace(/<\|[^|]+\|>/g, '')
                .replace(/functions\.\w+:\d+/g, '')
                .trim();
            const structuredAssistantOutput = parseStructuredAssistantOutput(rawAssistantStructuredBuffer || contentToSave);
            const extractedTitle = structuredAssistantOutput.extractedTitle || null;
            contentToSave = (structuredAssistantOutput.visibleContent || contentToSave).trim();
            if (!contentToSave) {
                contentToSave = reasoningContent ? '(纯思考内容)' : '(生成中断)';
            }
            if (extractedTitle) {
                console.log(` 提取到标题: "${extractedTitle}"`);
            }

            // 3. 保存AI回复 (已移除标题标记, 包含联网来源信息)
            // 序列化 sources 为 JSON 字符串
            const sourcesJson = (searchSources && searchSources.length > 0) ? JSON.stringify(searchSources) : null;
            const assistantProcessTraceJson = promptContextTrace ? JSON.stringify(promptContextTrace) : null;

            // 使用毫秒级时间戳，确保AI消息严格晚于用户消息
            const aiMsgTimestamp = new Date().toISOString();
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO messages (session_id, role, content, reasoning_content, model, enable_search, thinking_mode, internet_mode, sources, process_trace, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [sessionId, 'assistant', contentToSave, reasoningContent || null, finalModel, internetMode ? 1 : 0, thinkingMode ? 1 : 0, internetMode ? 1 : 0, sourcesJson, assistantProcessTraceJson, aiMsgTimestamp],
                    (err) => {
                        if (err) {
                            console.error(' 保存AI消息失败:', err);
                            reject(err);
                        } else {
                            console.log(` AI回复已保存:`);
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
                if (flowId) {
                    await syncFlowTitle(flowId, req.user.userId, extractedTitle);
                    console.log(` Flow标题已更新: "${extractedTitle}"`);
                    res.write(`data: ${JSON.stringify({
                        type: 'title',
                        title: extractedTitle
                    })}\n\n`);
                } else {
                    // 每次对话都更新标题，不再限制只在新对话时更新
                    db.run(
                        'UPDATE sessions SET title = ? WHERE id = ?',
                        [extractedTitle, sessionId],
                        (updateErr) => {
                            if (!updateErr) {
                                console.log(` 会话标题已更新: "${extractedTitle}"`);
                                // 通知前端标题更新
                                res.write(`data: ${JSON.stringify({
                                    type: 'title',
                                    title: extractedTitle
                                })}\n\n`);
                            } else {
                                console.error(' 更新会话标题失败:', updateErr);
                            }
                        }
                    );
                }
            }

            if (flowId && structuredAssistantOutput.canvasPatchRaw) {
                res.write(`data: ${JSON.stringify({
                    type: 'canvas_patch',
                    patch: structuredAssistantOutput.canvasPatch,
                    raw: structuredAssistantOutput.canvasPatchRaw,
                    valid: !structuredAssistantOutput.canvasPatchParseError,
                    error: structuredAssistantOutput.canvasPatchParseError || null
                })}\n\n`);
            }

            // 5. 更新会话时间戳
            await new Promise((resolve) => {
                db.run(
                    'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [sessionId],
                    (err) => {
                        if (err) console.error(' 更新会话时间戳失败:', err);
                        else console.log(' 会话时间戳已更新');
                        resolve();
                    }
                );
            });
        }

        if (agentRuntime.enabled) {
            emitAgentEvent(res, {
                type: 'agent_status',
                role: 'master',
                status: 'done',
                detail: `编排完成 (retries=${agentRuntime.retriesUsed || 0})`
            });
        }

        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

        console.log('\n 聊天处理完成\n');

    } catch (error) {
        console.error(' 聊天错误:', error);
        try {
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
        } catch (writeError) {
            console.error(' 写入响应错误:', writeError);
        }
    } finally {
        //  关键修复：添加null检查
        if (requestId) {
            activeRequestInterjections.delete(requestId);
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
                    console.log(' 停止请求:', requestId);
                    res.json({ success: true, message: '已发送停止信号' });
                }
            );
        }
    );
});

app.post('/api/chat/interject', authenticateToken, (req, res) => {
    const { requestId, message } = req.body || {};
    const content = normalizeStreamingInterjection(message);

    if (!requestId) {
        return res.status(400).json({ error: '缺少requestId' });
    }
    if (!content) {
        return res.status(400).json({ error: '插话内容不能为空' });
    }

    db.get(
        'SELECT user_id, session_id FROM active_requests WHERE id = ?',
        [requestId],
        (err, row) => {
            if (err || !row) {
                return res.status(404).json({ error: '请求不存在或已结束' });
            }

            if (row.user_id !== req.user.userId) {
                return res.status(403).json({ error: '无权向此请求插话' });
            }

            const item = pushRequestInterjection(requestId, content, req.user.userId);
            const sessionId = row.session_id && row.session_id !== 'anonymous' ? row.session_id : null;
            if (!sessionId) {
                return res.json({ success: true, item });
            }

            db.run(
                'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
                [sessionId, 'user', content, item.createdAt],
                (insertErr) => {
                    if (insertErr) {
                        console.warn(` 保存讨论插话失败，但已进入当前研究上下文: ${insertErr.message}`);
                    }
                    db.run('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [sessionId]);
                    res.json({ success: true, item, persisted: !insertErr });
                }
            );
        }
    );
});

// ==================== VIP 会员系统 ====================

// 会员配置
const DAILY_CHECKIN_POINTS = 20;
const MONTHLY_REDEEM_CHECKIN_DAYS = 28;

const MEMBERSHIP_CONFIG = {
    free: { checkinPoints: DAILY_CHECKIN_POINTS },
    Pro: { redeemCost: DAILY_CHECKIN_POINTS * MONTHLY_REDEEM_CHECKIN_DAYS, durationDays: 30 },
    MAX: { redeemCost: 6000, durationDays: 30 }
};

const USER_TASK_REWARDS = {
    pwaInstall: { key: 'pwa_install', points: 300 },
    inviteUser: { keyPrefix: 'invite_user:', points: 600 }
};

function dbGetAsync(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAllAsync(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function dbRunAsync(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function buildTaskMetadata(req, metadata = {}) {
    return JSON.stringify({
        ...metadata,
        userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
        ip: String(req?.ip || req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 80)
    });
}

function normalizeReferralUserId(value) {
    const text = String(value || '').trim();
    if (!/^\d{1,12}$/.test(text)) return null;
    const id = Number.parseInt(text, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function getUserTaskSnapshot(userId) {
    const rows = await dbAllAsync(
        'SELECT task_key, points, completed_at, metadata FROM user_task_rewards WHERE user_id = ? ORDER BY completed_at ASC',
        [userId]
    );
    const pwaInstall = rows.find((row) => row.task_key === USER_TASK_REWARDS.pwaInstall.key);
    const inviteRows = rows.filter((row) => String(row.task_key || '').startsWith(USER_TASK_REWARDS.inviteUser.keyPrefix));
    const invitePoints = inviteRows.reduce((sum, row) => sum + Number(row.points || 0), 0);

    return {
        pwaInstall: {
            key: USER_TASK_REWARDS.pwaInstall.key,
            rewardPoints: USER_TASK_REWARDS.pwaInstall.points,
            completed: Boolean(pwaInstall),
            completedAt: pwaInstall?.completed_at || null
        },
        inviteUser: {
            key: 'invite_user',
            rewardPoints: USER_TASK_REWARDS.inviteUser.points,
            completed: inviteRows.length > 0,
            completedAt: inviteRows[0]?.completed_at || null,
            completedCount: inviteRows.length,
            totalRewardPoints: invitePoints
        }
    };
}

async function awardUserTaskPoints({ userId, taskKey, points, metadata = null }) {
    let inTransaction = false;
    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        inTransaction = true;

        const insertResult = await dbRunAsync(
            `INSERT OR IGNORE INTO user_task_rewards (user_id, task_key, points, metadata)
             VALUES (?, ?, ?, ?)`,
            [userId, taskKey, points, metadata]
        );
        const awarded = Number(insertResult?.changes || 0) > 0;

        if (awarded) {
            await dbRunAsync(
                'UPDATE users SET points = COALESCE(points, 0) + ? WHERE id = ?',
                [points, userId]
            );
        }

        await dbRunAsync('COMMIT');
        inTransaction = false;
        return { awarded, pointsGained: awarded ? points : 0 };
    } catch (error) {
        if (inTransaction) {
            try {
                await dbRunAsync('ROLLBACK');
            } catch (rollbackError) {
                console.error(' 任务积分回滚失败:', rollbackError);
            }
        }
        throw error;
    }
}

async function awardInviteReferralIfValid(referrerId, invitedUserId, req) {
    const normalizedReferrerId = normalizeReferralUserId(referrerId);
    if (!normalizedReferrerId || normalizedReferrerId === invitedUserId) {
        return { awarded: false, pointsGained: 0, reason: 'invalid_referrer' };
    }

    const referrer = await dbGetAsync('SELECT id FROM users WHERE id = ?', [normalizedReferrerId]);
    if (!referrer) {
        return { awarded: false, pointsGained: 0, reason: 'referrer_not_found' };
    }

    return awardUserTaskPoints({
        userId: normalizedReferrerId,
        taskKey: `${USER_TASK_REWARDS.inviteUser.keyPrefix}${invitedUserId}`,
        points: USER_TASK_REWARDS.inviteUser.points,
        metadata: buildTaskMetadata(req, {
            invitedUserId,
            source: 'register_referral'
        })
    });
}

function normalizeAdminModelId(modelId) {
    const normalized = normalizeIncomingModelId(modelId);
    return PUBLIC_MODEL_IDS.includes(normalized) ? normalized : '';
}

async function getDisabledModelSet({ forceRefresh = false } = {}) {
    const now = Date.now();
    if (!forceRefresh && modelAvailabilityCache.loadedAt && now - modelAvailabilityCache.loadedAt < MODEL_DISABLED_CACHE_TTL_MS) {
        return modelAvailabilityCache.disabled;
    }

    const rows = await dbAllAsync(
        'SELECT model_id FROM model_visibility WHERE enabled = 0'
    );
    modelAvailabilityCache = {
        loadedAt: now,
        disabled: new Set(rows.map((row) => normalizeAdminModelId(row.model_id)).filter(Boolean))
    };
    return modelAvailabilityCache.disabled;
}

async function isPublicModelDisabled(modelId) {
    const normalized = normalizeAdminModelId(modelId);
    if (!normalized) return false;
    const disabled = await getDisabledModelSet();
    return disabled.has(normalized);
}

async function resolveVisibleAutoModel() {
    const disabled = await getDisabledModelSet();
    return AUTO_MODEL_PREFERENCE.find((modelId) => !disabled.has(modelId)) || 'qwen2.5-7b';
}

async function resolveVisibleAutoMultimodalModel() {
    const disabled = await getDisabledModelSet();
    return AUTO_MULTIMODAL_MODEL_PREFERENCE.find((modelId) => !disabled.has(modelId))
        || await resolveVisibleAutoModel();
}

async function getModelVisibilityPayload({ forceRefresh = false } = {}) {
    const disabled = await getDisabledModelSet({ forceRefresh });
    return ADMIN_MODEL_CATALOG.map((model) => ({
        ...model,
        enabled: !disabled.has(model.id)
    }));
}

app.post('/api/messages/:messageId/feedback', authenticateToken, async (req, res) => {
    try {
        const messageId = Number.parseInt(req.params.messageId, 10);
        const rating = String(req.body?.rating || '').trim();
        const comment = String(req.body?.comment || '').trim();

        if (!Number.isInteger(messageId) || messageId <= 0) {
            return res.status(400).json({ error: '无效的消息ID' });
        }

        if (!['up', 'down'].includes(rating)) {
            return res.status(400).json({ error: '无效的反馈类型' });
        }

        if (comment.length > 1000) {
            return res.status(400).json({ error: '反馈内容不能超过1000字' });
        }

        const message = await dbGetAsync(`
            SELECT m.id, m.session_id, m.role, s.user_id
            FROM messages m
            JOIN sessions s ON m.session_id = s.id
            WHERE m.id = ? AND s.user_id = ?
        `, [messageId, req.user.userId]);

        if (!message) {
            return res.status(404).json({ error: '消息不存在' });
        }

        if (message.role !== 'assistant') {
            return res.status(400).json({ error: '只能反馈AI回复' });
        }

        await dbRunAsync(`
            INSERT INTO message_feedback (message_id, session_id, user_id, rating, comment, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, message_id) DO UPDATE SET
                rating = excluded.rating,
                comment = excluded.comment,
                updated_at = CURRENT_TIMESTAMP
        `, [message.id, message.session_id, req.user.userId, rating, comment || null]);

        res.json({
            success: true,
            feedback: {
                messageId: message.id,
                rating,
                comment
            }
        });
    } catch (error) {
        console.error('保存消息反馈失败:', error);
        res.status(500).json({ error: '保存反馈失败' });
    }
});

app.get('/api/model-availability', async (req, res) => {
    try {
        const models = await getModelVisibilityPayload();
        res.json({
            models,
            disabledModels: models.filter((model) => !model.enabled).map((model) => model.id)
        });
    } catch (error) {
        console.error(' 获取模型可见性失败:', error);
        res.status(500).json({ error: '获取模型可见性失败' });
    }
});

let ensureSessionKindColumnPromise = null;
let ensureFlowSessionIdColumnPromise = null;

async function ensureColumnExists(tableName, columnName, alterSql) {
    const columns = await dbAllAsync(`PRAGMA table_info(${tableName})`);
    if (columns.some((column) => String(column?.name || '').trim() === columnName)) {
        return false;
    }

    try {
        await dbRunAsync(alterSql);
        return true;
    } catch (error) {
        if (String(error?.message || '').includes('duplicate column')) {
            return false;
        }
        throw error;
    }
}

async function ensureSessionKindColumn() {
    if (!ensureSessionKindColumnPromise) {
        ensureSessionKindColumnPromise = (async () => {
            await ensureColumnExists('sessions', 'session_kind', `ALTER TABLE sessions ADD COLUMN session_kind TEXT DEFAULT 'chat'`);
            await dbRunAsync(`CREATE INDEX IF NOT EXISTS idx_sessions_user_kind_updated ON sessions(user_id, session_kind, is_archived, updated_at DESC)`);
        })().catch((error) => {
            ensureSessionKindColumnPromise = null;
            throw error;
        });
    }

    return ensureSessionKindColumnPromise;
}

async function ensureFlowSessionIdColumn() {
    if (!ensureFlowSessionIdColumnPromise) {
        ensureFlowSessionIdColumnPromise = ensureColumnExists('flows', 'session_id', `ALTER TABLE flows ADD COLUMN session_id TEXT`).catch((error) => {
            ensureFlowSessionIdColumnPromise = null;
            throw error;
        });
    }

    return ensureFlowSessionIdColumnPromise;
}

async function ensureChatFlowSchemaColumns() {
    await ensureSessionKindColumn();
    await ensureFlowSessionIdColumn();
}

function getTodayDateString() {
    return new Date().toISOString().split('T')[0];
}

function normalizePromptTimeContext(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const datetime = typeof raw.datetime === 'string' ? raw.datetime.trim() : '';
    if (!datetime) return null;

    const timezone = typeof raw.timezone === 'string' && raw.timezone.trim()
        ? raw.timezone.trim()
        : 'unknown';
    const locale = typeof raw.locale === 'string' && raw.locale.trim()
        ? raw.locale.trim()
        : 'unknown';
    const timeOfDay = typeof raw.timeOfDay === 'string' && raw.timeOfDay.trim()
        ? raw.timeOfDay.trim()
        : 'unknown';
    const hour = Number(raw.hour);

    return {
        datetime,
        timezone,
        locale,
        timeOfDay,
        hour: Number.isFinite(hour) ? hour : null
    };
}

function stripInlinePromptTimeHint(content = '') {
    return String(content || '')
        .replace(/\n{0,2}\[(?:当前时间|Current time)[^\]]*(?:不要把回答中心放在时间上|do not center the answer on time)[。.]?\]/i, '')
        .trim();
}

function buildPromptContextTrace(promptTimeContext) {
    if (!promptTimeContext) return null;

    return {
        prompt_context: {
            injection: 'per_request_datetime',
            injectedAt: new Date().toISOString(),
            requestTimeContext: promptTimeContext
        }
    };
}

function sanitizePromptUserField(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

async function getPromptUserProfile(userId, fallbackEmail = '') {
    const user = userId
        ? await dbGetAsync('SELECT email, username FROM users WHERE id = ?', [userId])
        : null;
    const email = sanitizePromptUserField(user?.email || fallbackEmail);
    const username = sanitizePromptUserField(
        user?.username || (email.includes('@') ? email.split('@')[0] : '')
    );

    return {
        email,
        username
    };
}

function buildUserIdentityPrompt(profile) {
    if (!profile || typeof profile !== 'object') return '';

    const username = sanitizePromptUserField(profile.username);
    const email = sanitizePromptUserField(profile.email);
    const lines = [];

    if (username) lines.push(`- 用户名: ${username}`);
    if (email) lines.push(`- 邮箱: ${email}`);
    if (lines.length === 0) return '';

    return [
        '[当前登录用户信息]',
        ...lines,
        '以上信息来自当前已登录账号，可用于帮助你理解用户背景并提供更贴合的回答；除非用户明确要求，否则不要主动复述或暴露这些信息。'
    ].join('\n');
}

function buildMembershipEndISO(currentEnd, durationDays) {
    const now = new Date();
    const parsedEnd = currentEnd ? new Date(currentEnd) : null;
    const hasActiveEnd = parsedEnd && !Number.isNaN(parsedEnd.getTime()) && parsedEnd > now;
    const baseDate = hasActiveEnd ? parsedEnd : now;
    const nextEnd = new Date(baseDate.getTime());
    nextEnd.setDate(nextEnd.getDate() + durationDays);
    return nextEnd.toISOString();
}

async function getUserMembershipSnapshot(userId) {
    const user = await dbGetAsync(`
        SELECT id, email, username, created_at,
               COALESCE(membership, 'free') AS membership,
               membership_start, membership_end,
               COALESCE(points, 0) AS points,
               COALESCE(purchased_points, 0) AS purchased_points,
               purchased_points_expire,
               last_checkin, last_daily_grant,
               poe_usage_date, COALESCE(poe_usage_count, 0) AS poe_usage_count,
               gpt55_usage_date, COALESCE(gpt55_usage_count, 0) AS gpt55_usage_count
        FROM users WHERE id = ?
    `, [userId]);

    if (!user) return null;

    const now = new Date();
    const today = getTodayDateString();
    let membership = user.membership || 'free';
    let membershipStart = user.membership_start || null;
    let membershipEnd = user.membership_end || null;

    if (membership !== 'free' && membershipEnd) {
        const endDate = new Date(membershipEnd);
        if (!Number.isNaN(endDate.getTime()) && endDate < now) {
            membership = 'free';
            membershipStart = null;
            membershipEnd = null;
            await dbRunAsync(
                'UPDATE users SET membership = ?, membership_start = NULL, membership_end = NULL WHERE id = ?',
                ['free', user.id]
            );
        }
    }

    let points = Number(user.points || 0);
    let purchasedPoints = Number(user.purchased_points || 0);
    let purchasedPointsExpire = user.purchased_points_expire || null;

    if (purchasedPoints > 0 && purchasedPointsExpire) {
        const expireDate = new Date(purchasedPointsExpire);
        if (!Number.isNaN(expireDate.getTime()) && expireDate < now) {
            purchasedPoints = 0;
            purchasedPointsExpire = null;
            await dbRunAsync(
                'UPDATE users SET purchased_points = 0, purchased_points_expire = NULL WHERE id = ?',
                [user.id]
            );
        }
    }

    const totalPoints = points + purchasedPoints;
    const canCheckin = user.last_checkin !== today;
    const poeUsedToday = user.poe_usage_date === today ? Number(user.poe_usage_count || 0) : 0;
    const poeRemaining = Math.max(0, POE_DAILY_LIMIT_FREE - poeUsedToday);
    const gpt55UsedToday = user.gpt55_usage_date === today ? Number(user.gpt55_usage_count || 0) : 0;
    const gpt55Remaining = Math.max(0, GPT55_DAILY_LIMIT_FREE - gpt55UsedToday);
    const tasks = await getUserTaskSnapshot(user.id);

    return {
        membership,
        membershipStart,
        membershipEnd,
        points,
        purchasedPoints,
        purchasedPointsExpire,
        totalPoints,
        canCheckin,
        lastCheckin: user.last_checkin,
        createdAt: user.created_at,
        poeDailyLimit: POE_DAILY_LIMIT_FREE,
        poeUsedToday,
        poeRemaining,
        poeResetAt: buildPoeResetAtISO(),
        gpt55DailyLimit: GPT55_DAILY_LIMIT_FREE,
        gpt55UsedToday,
        gpt55Remaining,
        gpt55ResetAt: buildPoeResetAtISO(),
        tasks
    };
}

// 获取会员状态和点数
app.get('/api/user/membership', authenticateToken, async (req, res) => {
    try {
        const snapshot = await getUserMembershipSnapshot(req.user.userId);
        if (!snapshot) {
            return res.status(404).json({ error: '用户不存在' });
        }
        res.json(snapshot);
    } catch (error) {
        console.error(' 获取会员状态失败:', error);
        res.status(500).json({ error: '获取会员状态失败' });
    }
});

// 每日签到（所有登录用户每天一次）
app.post('/api/user/checkin', authenticateToken, async (req, res) => {
    try {
        const user = await dbGetAsync(
            'SELECT id, COALESCE(points, 0) AS points, last_checkin FROM users WHERE id = ?',
            [req.user.userId]
        );

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const today = getTodayDateString();
        if (user.last_checkin === today) {
            return res.status(400).json({ error: '今日已签到' });
        }

        const pointsGained = MEMBERSHIP_CONFIG.free.checkinPoints;
        const newPoints = Number(user.points || 0) + pointsGained;

        await dbRunAsync(
            'UPDATE users SET points = ?, last_checkin = ? WHERE id = ?',
            [newPoints, today, user.id]
        );

        const snapshot = await getUserMembershipSnapshot(user.id);
        console.log(` 用户 ${user.id} 签到成功，获得 ${pointsGained} 点数`);
        res.json({
            success: true,
            pointsGained,
            newPoints,
            currentPoints: snapshot?.totalPoints ?? newPoints,
            totalPoints: snapshot?.totalPoints ?? newPoints,
            canCheckin: snapshot?.canCheckin ?? false
        });
    } catch (error) {
        console.error(' 签到失败:', error);
        res.status(500).json({ error: '签到失败' });
    }
});

app.post('/api/user/tasks/pwa-install/complete', authenticateToken, async (req, res) => {
    try {
        const user = await dbGetAsync('SELECT id FROM users WHERE id = ?', [req.user.userId]);
        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const source = String(req.body?.source || 'unknown').slice(0, 80);
        const reward = await awardUserTaskPoints({
            userId: user.id,
            taskKey: USER_TASK_REWARDS.pwaInstall.key,
            points: USER_TASK_REWARDS.pwaInstall.points,
            metadata: buildTaskMetadata(req, { source })
        });
        const snapshot = await getUserMembershipSnapshot(user.id);

        if (reward.awarded) {
            console.log(` 用户 ${user.id} 完成桌面App任务，获得 ${reward.pointsGained} 点数`);
        }

        res.json({
            success: true,
            ...reward,
            ...snapshot
        });
    } catch (error) {
        console.error(' 完成桌面App任务失败:', error);
        res.status(500).json({ error: '完成任务失败' });
    }
});

// 点数兑换会员
app.post('/api/user/membership/redeem', authenticateToken, async (req, res) => {
    const tier = String(req.body?.tier || '').trim();
    const config = MEMBERSHIP_CONFIG[tier];

    if (!config || tier === 'free') {
        return res.status(400).json({ error: '无效的会员档位' });
    }

    let inTransaction = false;

    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        inTransaction = true;

        const user = await dbGetAsync(`
            SELECT id,
                   membership, membership_start, membership_end,
                   COALESCE(points, 0) AS points,
                   COALESCE(purchased_points, 0) AS purchased_points,
                   purchased_points_expire
            FROM users WHERE id = ?
        `, [req.user.userId]);

        if (!user) {
            await dbRunAsync('ROLLBACK');
            inTransaction = false;
            return res.status(404).json({ error: '用户不存在' });
        }

        const currentMembership = String(user.membership || 'free');
        const currentMembershipEnd = user.membership_end ? new Date(user.membership_end) : null;
        const hasActiveMembership = currentMembership !== 'free' &&
            currentMembershipEnd &&
            !Number.isNaN(currentMembershipEnd.getTime()) &&
            currentMembershipEnd > new Date();

        if (currentMembership === 'MAX' && tier === 'Pro' && hasActiveMembership) {
            await dbRunAsync('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: '当前已是更高档位，请直接续期当前会员' });
        }

        let points = Number(user.points || 0);
        let purchasedPoints = Number(user.purchased_points || 0);
        let purchasedPointsExpire = user.purchased_points_expire || null;

        if (purchasedPoints > 0 && purchasedPointsExpire) {
            const expireDate = new Date(purchasedPointsExpire);
            if (!Number.isNaN(expireDate.getTime()) && expireDate < new Date()) {
                purchasedPoints = 0;
                purchasedPointsExpire = null;
                await dbRunAsync(
                    'UPDATE users SET purchased_points = 0, purchased_points_expire = NULL WHERE id = ?',
                    [user.id]
                );
            }
        }

        const totalPoints = points + purchasedPoints;
        if (totalPoints < config.redeemCost) {
            await dbRunAsync('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: '点数不足，请完成任务或签到增加积分' });
        }

        let remainingCost = config.redeemCost;
        if (points >= remainingCost) {
            points -= remainingCost;
            remainingCost = 0;
        } else {
            remainingCost -= points;
            points = 0;
            purchasedPoints -= remainingCost;
        }

        const membershipStart = new Date().toISOString();
        const membershipEnd = buildMembershipEndISO(user.membership_end, config.durationDays);

        await dbRunAsync(`
            UPDATE users SET
                membership = ?,
                membership_start = ?,
                membership_end = ?,
                points = ?,
                purchased_points = ?,
                purchased_points_expire = ?,
                last_daily_grant = NULL
            WHERE id = ?
        `, [
            tier,
            membershipStart,
            membershipEnd,
            points,
            purchasedPoints,
            purchasedPoints > 0 ? purchasedPointsExpire : null,
            user.id
        ]);

        await dbRunAsync('COMMIT');
        inTransaction = false;

        const snapshot = await getUserMembershipSnapshot(user.id);
        console.log(` 用户 ${user.id} 兑换会员成功: ${tier}, 扣除 ${config.redeemCost} 点`);
        res.json({
            success: true,
            tier,
            pointsSpent: config.redeemCost,
            ...snapshot
        });
    } catch (error) {
        if (inTransaction) {
            try {
                await dbRunAsync('ROLLBACK');
            } catch (rollbackError) {
                console.error(' 兑换会员回滚失败:', rollbackError);
            }
        }
        console.error(' 兑换会员失败:', error);
        res.status(500).json({ error: '兑换会员失败' });
    }
});

function isFreeModelIdentifier(modelUsed = '') {
    const modelText = String(modelUsed || '').trim().toLowerCase();
    if (!modelText) return false;

    return modelText === 'qwen2.5-7b' ||
        modelText === 'qwen3-8b' ||
        modelText === 'qwen-flash' ||
        modelText === 'qwen-plus' ||
        modelText === 'qwen-max' ||
        modelText === 'chatgpt-gpt-oss-120b' ||
        modelText === 'grok-4.2' ||
        modelText === 'gpt-5.5' ||
        modelText === 'gemma' ||
        modelText === 'gemma-4-31b-it' ||
        modelText === 'openai/gpt-oss-120b:free' ||
        modelText === 'google/gemma-4-31b-it:free' ||
        modelText.includes('qwen2.5-7b-instruct') ||
        modelText.includes('qwen/qwen2.5-7b-instruct');
}

function buildPoeResetAtISO() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return next.toISOString();
}

// free 用户 Poe 每24小时最多3次
async function checkAndConsumePoeQuota(userId, membership) {
    const tier = String(membership || 'free').toLowerCase();
    const limit = POE_DAILY_LIMIT_FREE;
    const resetAt = buildPoeResetAtISO();

    if (tier !== 'free') {
        return {
            allowed: true,
            limit: null,
            used: 0,
            remaining: null,
            resetAt
        };
    }

    const today = new Date().toISOString().split('T')[0];
    return await new Promise((resolve, reject) => {
        db.get(
            'SELECT poe_usage_date, COALESCE(poe_usage_count, 0) AS poe_usage_count FROM users WHERE id = ?',
            [userId],
            (err, row) => {
                if (err) return reject(err);
                if (!row) return reject(new Error('用户不存在'));

                const sameDay = row.poe_usage_date === today;
                const currentUsed = sameDay ? Number(row.poe_usage_count || 0) : 0;

                if (currentUsed >= limit) {
                    console.warn(` poe_quota_consume blocked user=${userId} used=${currentUsed}/${limit}`);
                    return resolve({
                        allowed: false,
                        limit,
                        used: currentUsed,
                        remaining: 0,
                        resetAt
                    });
                }

                const nextUsed = currentUsed + 1;
                db.run(
                    'UPDATE users SET poe_usage_date = ?, poe_usage_count = ? WHERE id = ?',
                    [today, nextUsed, userId],
                    (updateErr) => {
                        if (updateErr) return reject(updateErr);
                        const remaining = Math.max(0, limit - nextUsed);
                        console.log(` poe_quota_consume user=${userId} used=${nextUsed}/${limit} remaining=${remaining}`);
                        resolve({
                            allowed: true,
                            limit,
                            used: nextUsed,
                            remaining,
                            resetAt
                        });
                    }
                );
            }
        );
    });
}

// free 用户 GPT-5.5 每24小时最多10次
async function checkAndConsumeGpt55Quota(userId, membership) {
    const tier = String(membership || 'free').toLowerCase();
    const limit = GPT55_DAILY_LIMIT_FREE;
    const resetAt = buildPoeResetAtISO();

    if (tier !== 'free') {
        return {
            allowed: true,
            limit: null,
            used: 0,
            remaining: null,
            resetAt
        };
    }

    const today = getTodayDateString();
    return await new Promise((resolve, reject) => {
        db.get(
            'SELECT gpt55_usage_date, COALESCE(gpt55_usage_count, 0) AS gpt55_usage_count FROM users WHERE id = ?',
            [userId],
            (err, row) => {
                if (err) return reject(err);
                if (!row) return reject(new Error('用户不存在'));

                const sameDay = row.gpt55_usage_date === today;
                const currentUsed = sameDay ? Number(row.gpt55_usage_count || 0) : 0;

                if (currentUsed >= limit) {
                    console.warn(` gpt55_quota_consume blocked user=${userId} used=${currentUsed}/${limit}`);
                    return resolve({
                        allowed: false,
                        limit,
                        used: currentUsed,
                        remaining: 0,
                        resetAt
                    });
                }

                const nextUsed = currentUsed + 1;
                db.run(
                    'UPDATE users SET gpt55_usage_date = ?, gpt55_usage_count = ? WHERE id = ?',
                    [today, nextUsed, userId],
                    (updateErr) => {
                        if (updateErr) return reject(updateErr);
                        const remaining = Math.max(0, limit - nextUsed);
                        resolve({
                            allowed: true,
                            limit,
                            used: nextUsed,
                            remaining,
                            resetAt
                        });
                    }
                );
            }
        );
    });
}

async function refundGpt55Quota(userId) {
    const today = getTodayDateString();
    await dbRunAsync(
        `UPDATE users
         SET gpt55_usage_count = CASE
             WHEN gpt55_usage_date = ? AND COALESCE(gpt55_usage_count, 0) > 0 THEN gpt55_usage_count - 1
             ELSE COALESCE(gpt55_usage_count, 0)
         END
         WHERE id = ?`,
        [today, userId]
    );

    const row = await dbGetAsync(
        'SELECT gpt55_usage_date, COALESCE(gpt55_usage_count, 0) AS gpt55_usage_count FROM users WHERE id = ?',
        [userId]
    );
    const used = row?.gpt55_usage_date === today ? Number(row.gpt55_usage_count || 0) : 0;
    return {
        limit: GPT55_DAILY_LIMIT_FREE,
        used,
        remaining: Math.max(0, GPT55_DAILY_LIMIT_FREE - used),
        resetAt: buildPoeResetAtISO()
    };
}

// 辅助函数：检查并扣减点数
async function checkAndDeductPoints(userId, modelUsed) {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT id, membership, points, purchased_points, purchased_points_expire
            FROM users WHERE id = ?
        `, [userId], (err, user) => {
            if (err) return reject(err);
            if (!user) return reject(new Error('用户不存在'));

            let points = user.points || 0;
            let purchasedPoints = user.purchased_points || 0;

            // 检查购买点数是否过期
            if (purchasedPoints > 0 && user.purchased_points_expire) {
                const expireDate = new Date(user.purchased_points_expire);
                if (expireDate < new Date()) {
                    purchasedPoints = 0;
                    db.run('UPDATE users SET purchased_points = 0 WHERE id = ?', [userId]);
                }
            }

            const totalPoints = points + purchasedPoints;

            // 免费模型不扣点
            if (isFreeModelIdentifier(modelUsed)) {
                return resolve({
                    allowed: true,
                    pointsDeducted: 0,
                    remainingPoints: totalPoints,
                    useFreeModel: false
                });
            }

            // 点数不足，需要切换到免费模型
            if (totalPoints <= 0) {
                return resolve({
                    allowed: true,
                    pointsDeducted: 0,
                    remainingPoints: 0,
                    useFreeModel: true,
                    message: '点数不足，已自动切换到免费模型。完成任务或签到可增加积分。'
                });
            }

            // 扣减1点
            let newPoints = points;
            let newPurchasedPoints = purchasedPoints;

            // 优先使用每日点数
            if (points > 0) {
                newPoints = points - 1;
            } else {
                newPurchasedPoints = purchasedPoints - 1;
            }

            db.run('UPDATE users SET points = ?, purchased_points = ? WHERE id = ?',
                [newPoints, newPurchasedPoints, userId], (err) => {
                    if (err) return reject(err);
                    resolve({
                        allowed: true,
                        pointsDeducted: 1,
                        remainingPoints: newPoints + newPurchasedPoints,
                        useFreeModel: false
                    });
                });
        });
    });
}

// ==================== 管理员后台系统 ====================

// 管理员认证中间件
const authenticateAdmin = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    if (!token) {
        return res.status(401).json({ error: '需要管理员令牌' });
    }
    try {
        const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
        if (decoded.isAdmin) {
            req.isAdmin = true;
            next();
        } else {
            res.status(403).json({ error: '无效的管理员令牌' });
        }
    } catch (e) {
        res.status(403).json({ error: '管理员令牌已过期或无效' });
    }
};

// 管理员登录
app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
    const { username, password } = req.body;

    try {
        const usernameOk = String(username || '').trim() === ADMIN_USERNAME;
        const passwordOk = usernameOk && await bcrypt.compare(String(password || ''), ADMIN_PASSWORD_HASH);

        if (passwordOk) {
            const token = jwt.sign({ isAdmin: true, username: ADMIN_USERNAME, loginTime: Date.now() }, ADMIN_JWT_SECRET, { expiresIn: '8h' });
            console.log(' 管理员登录成功');
            return res.json({ success: true, token });
        }

        console.log(' 管理员登录失败尝试');
        return res.status(401).json({ error: '管理员凭据无效' });
    } catch (err) {
        console.error(' 管理员登录校验失败:', err.message);
        return res.status(401).json({ error: '管理员凭据无效' });
    }
});

// 验证管理员Token
app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
    res.json({ success: true, isAdmin: true });
});

app.get('/api/admin/models', authenticateAdmin, async (req, res) => {
    try {
        const models = await getModelVisibilityPayload({ forceRefresh: true });
        res.json({ models });
    } catch (error) {
        console.error(' 管理员获取模型开关失败:', error);
        res.status(500).json({ error: '获取模型开关失败' });
    }
});

app.put('/api/admin/models/:modelId', authenticateAdmin, async (req, res) => {
    try {
        const modelId = normalizeAdminModelId(req.params.modelId);
        if (!modelId) {
            return res.status(400).json({ error: '无效的模型ID' });
        }

        const enabled = req.body?.enabled === true || req.body?.enabled === 1 || req.body?.enabled === '1';
        await dbRunAsync(`
            INSERT INTO model_visibility (model_id, enabled, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(model_id) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = CURRENT_TIMESTAMP
        `, [modelId, enabled ? 1 : 0]);
        modelAvailabilityCache.loadedAt = 0;

        const models = await getModelVisibilityPayload({ forceRefresh: true });
        res.json({ success: true, modelId, enabled, models });
    } catch (error) {
        console.error(' 管理员更新模型开关失败:', error);
        res.status(500).json({ error: '更新模型开关失败' });
    }
});

// 获取数据统计
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
        // 基础统计
        const totalUsers = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        const totalSessions = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM sessions', (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        const totalMessages = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM messages', (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        // 今日统计
        const todayMessages = await new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM messages WHERE DATE(created_at) = DATE('now')", (err, row) => {
                if (err) reject(err);
                else resolve(row.count);
            });
        });

        // 最近30天每日消息数
        const dailyStats = await new Promise((resolve, reject) => {
            db.all(`
                SELECT DATE(created_at) as date, COUNT(*) as messages
                FROM messages
                WHERE created_at >= DATE('now', '-30 days')
                GROUP BY DATE(created_at)
                ORDER BY date ASC
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // 模型使用统计
        const modelUsage = await new Promise((resolve, reject) => {
            db.all(`
                SELECT model, COUNT(*) as count
                FROM messages
                WHERE model IS NOT NULL AND model != ''
                GROUP BY model
                ORDER BY count DESC
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        // 活跃用户排行（前10）
        const topUsers = await new Promise((resolve, reject) => {
            db.all(`
                SELECT u.id, u.username, u.email, COUNT(m.id) as messageCount
                FROM users u
                LEFT JOIN sessions s ON u.id = s.user_id
                LEFT JOIN messages m ON s.id = m.session_id
                GROUP BY u.id
                ORDER BY messageCount DESC
                LIMIT 10
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        const feedbackStats = await dbGetAsync(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END) AS positive,
                SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS negative
            FROM message_feedback
        `);

        res.json({
            totalUsers,
            totalSessions,
            totalMessages,
            todayMessages,
            dailyStats,
            modelUsage,
            topUsers,
            feedbackStats: {
                total: Number(feedbackStats?.total || 0),
                positive: Number(feedbackStats?.positive || 0),
                negative: Number(feedbackStats?.negative || 0)
            }
        });

    } catch (error) {
        console.error(' 获取统计数据失败:', error);
        res.status(500).json({ error: '获取统计数据失败' });
    }
});

app.get('/api/admin/feedback', authenticateAdmin, async (req, res) => {
    try {
        const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
        const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);
        const rating = String(req.query.rating || '').trim();
        const search = String(req.query.search || '').trim();

        const where = [];
        const params = [];

        if (['up', 'down'].includes(rating)) {
            where.push('mf.rating = ?');
            params.push(rating);
        }

        if (search) {
            where.push(`(
                mf.comment LIKE ? OR
                m.content LIKE ? OR
                s.title LIKE ? OR
                u.email LIKE ? OR
                u.username LIKE ?
            )`);
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const feedback = await dbAllAsync(`
            SELECT
                mf.id,
                mf.message_id,
                mf.session_id,
                mf.user_id,
                mf.rating,
                mf.comment,
                mf.created_at,
                mf.updated_at,
                m.content AS message_content,
                m.model AS message_model,
                s.title AS session_title,
                u.email AS user_email,
                u.username AS username
            FROM message_feedback mf
            JOIN messages m ON mf.message_id = m.id
            JOIN sessions s ON mf.session_id = s.id
            JOIN users u ON mf.user_id = u.id
            ${whereSql}
            ORDER BY mf.updated_at DESC, mf.id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        const totalRow = await dbGetAsync(`
            SELECT COUNT(*) AS count
            FROM message_feedback mf
            JOIN messages m ON mf.message_id = m.id
            JOIN sessions s ON mf.session_id = s.id
            JOIN users u ON mf.user_id = u.id
            ${whereSql}
        `, params);

        res.json({
            feedback,
            total: Number(totalRow?.count || 0),
            offset,
            limit
        });
    } catch (error) {
        console.error(' 获取反馈列表失败:', error);
        res.status(500).json({ error: '获取反馈列表失败' });
    }
});

// 获取所有用户列表
app.get('/api/admin/users', authenticateAdmin, (req, res) => {
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);

    db.all(`
        SELECT u.id, u.email, u.username, u.avatar_url, u.created_at, u.last_login,
               COALESCE(u.membership, 'free') as membership,
               u.membership_start, u.membership_end,
               COALESCE(u.points, 0) as points,
               COALESCE(u.purchased_points, 0) as purchased_points,
               (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) as sessionCount,
               (SELECT COUNT(*) FROM messages m 
                JOIN sessions s ON m.session_id = s.id 
                WHERE s.user_id = u.id) as messageCount
        FROM users u
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?
    `, [limit, offset], (err, users) => {
        if (err) {
            console.error(' 获取用户列表失败:', err);
            return res.status(500).json({ error: '获取用户列表失败' });
        }
        res.json({ users, offset, limit });
    });
});

// 获取用户完整详情（包括会话列表）
app.get('/api/admin/users/:userId/detail', authenticateAdmin, async (req, res) => {
    const { userId } = req.params;

    try {
        // 获取用户基本信息
        const user = await new Promise((resolve, reject) => {
            db.get(`
                SELECT u.id, u.email, u.username, u.avatar_url, u.created_at, u.last_login,
                       COALESCE(u.membership, 'free') as membership,
                       u.membership_start, u.membership_end,
                       COALESCE(u.points, 0) as points,
                       COALESCE(u.purchased_points, 0) as purchased_points,
                       u.last_checkin, u.last_daily_grant,
                       (SELECT COUNT(*) FROM sessions WHERE user_id = u.id) as sessionCount,
                       (SELECT COUNT(*) FROM messages m 
                        JOIN sessions s ON m.session_id = s.id 
                        WHERE s.user_id = u.id) as messageCount
                FROM users u
                WHERE u.id = ?
            `, [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        // 获取用户所有会话列表
        const sessions = await new Promise((resolve, reject) => {
            db.all(`
                SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
                       (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as messageCount
                FROM sessions s
                WHERE s.user_id = ?
                ORDER BY s.updated_at DESC
            `, [userId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        res.json({ user, sessions });
    } catch (error) {
        console.error(' 获取用户详情失败:', error);
        res.status(500).json({ error: '获取用户详情失败' });
    }
});

// 获取指定会话的所有消息（完整内容）
app.get('/api/admin/sessions/:sessionId/messages', authenticateAdmin, async (req, res) => {
    const { sessionId } = req.params;
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 100, 1, 200);

    try {
        // 获取会话信息
        const session = await new Promise((resolve, reject) => {
            db.get(`
                SELECT s.id, s.title, s.model, s.created_at, s.updated_at, s.user_id,
                       u.email, u.username
                FROM sessions s
                JOIN users u ON s.user_id = u.id
                WHERE s.id = ?
            `, [sessionId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!session) {
            return res.status(404).json({ error: '会话不存在' });
        }

        // 获取消息总数
        const totalCount = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM messages WHERE session_id = ?', [sessionId], (err, row) => {
                if (err) reject(err);
                else resolve(row?.count || 0);
            });
        });

        // 获取消息列表（完整内容，按时间正序排列便于阅读）
        const messages = await new Promise((resolve, reject) => {
            db.all(`
                SELECT id, role, content, reasoning_content, model, enable_search, 
                       thinking_mode, internet_mode, sources, process_trace, created_at
                FROM messages
                WHERE session_id = ?
                ORDER BY created_at ASC
                LIMIT ? OFFSET ?
            `, [sessionId, limit, offset], (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });

        res.json({ session, messages, totalCount, offset, limit });
    } catch (error) {
        console.error(' 获取会话消息失败:', error);
        res.status(500).json({ error: '获取会话消息失败' });
    }
});

// 获取指定用户的详细信息和消息
app.get('/api/admin/users/:userId/messages', authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);

    db.all(`
        SELECT m.id, m.session_id, m.role, m.content, m.model, m.created_at,
               s.title as session_title
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.user_id = ?
        ORDER BY m.created_at DESC
        LIMIT ? OFFSET ?
    `, [userId, limit, offset], (err, messages) => {
        if (err) {
            console.error(' 获取用户消息失败:', err);
            return res.status(500).json({ error: '获取用户消息失败' });
        }
        res.json({ messages, offset, limit });
    });
});

// 删除用户（及其所有数据）
app.delete('/api/admin/users/:userId', authenticateAdmin, async (req, res) => {
    const { userId } = req.params;

    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        await dbRunAsync('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)', [userId]);
        await dbRunAsync('DELETE FROM sessions WHERE user_id = ?', [userId]);
        await dbRunAsync('DELETE FROM user_configs WHERE user_id = ?', [userId]);
        await dbRunAsync('DELETE FROM device_fingerprints WHERE user_id = ?', [userId]);
        const result = await dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
        if (result.changes === 0) {
            await dbRunAsync('ROLLBACK');
            return res.status(404).json({ error: '用户不存在' });
        }
        await dbRunAsync('COMMIT');
        console.log(` 管理员删除用户 ID: ${userId}`);
        return res.json({ success: true, deletedUserId: userId });
    } catch (err) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        console.error(' 删除用户失败:', err);
        return res.status(500).json({ error: '删除用户失败' });
    }
});

// 管理员设置用户会员等级
app.put('/api/admin/users/:userId/membership', authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const { membership, months } = req.body;

    // 验证会员等级
    if (!['free', 'Pro', 'MAX'].includes(membership)) {
        return res.status(400).json({ error: '无效的会员等级，必须是 free/Pro/MAX' });
    }

    let membershipStart = null;
    let membershipEnd = null;

    if (membership !== 'free' && months > 0) {
        membershipStart = new Date().toISOString();
        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + parseInt(months));
        membershipEnd = endDate.toISOString();
    }

    db.run(`
        UPDATE users SET 
            membership = ?,
            membership_start = ?,
            membership_end = ?
        WHERE id = ?
    `, [membership, membershipStart, membershipEnd, userId], function (err) {
        if (err) {
            console.error(' 设置会员失败:', err);
            return res.status(500).json({ error: '设置会员失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '用户不存在' });
        }
        console.log(` 管理员设置用户 ${userId} 会员为 ${membership}，时长 ${months || 0} 个月`);
        res.json({ success: true, membership, membershipStart, membershipEnd });
    });
});

// 管理员添加/扣减点数
app.put('/api/admin/users/:userId/points', authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const { points, type, expireYears } = req.body;
    // type: 'daily' 或 'purchased'

    if (typeof points !== 'number') {
        return res.status(400).json({ error: '点数必须是数字' });
    }

    if (type === 'purchased') {
        // 购买的点数
        let expireDate = null;
        if (expireYears && expireYears > 0) {
            const date = new Date();
            date.setFullYear(date.getFullYear() + expireYears);
            expireDate = date.toISOString();
        }

        db.run(`
            UPDATE users SET 
                purchased_points = COALESCE(purchased_points, 0) + ?,
                purchased_points_expire = COALESCE(?, purchased_points_expire)
            WHERE id = ?
        `, [points, expireDate, userId], function (err) {
            if (err) {
                console.error(' 添加购买点数失败:', err);
                return res.status(500).json({ error: '添加点数失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '用户不存在' });
            }
            console.log(` 管理员给用户 ${userId} 添加 ${points} 购买点数`);
            res.json({ success: true, pointsAdded: points, type: 'purchased' });
        });
    } else {
        // 每日点数
        db.run(`
            UPDATE users SET points = COALESCE(points, 0) + ? WHERE id = ?
        `, [points, userId], function (err) {
            if (err) {
                console.error(' 添加每日点数失败:', err);
                return res.status(500).json({ error: '添加点数失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '用户不存在' });
            }
            console.log(` 管理员给用户 ${userId} 添加 ${points} 每日点数`);
            res.json({ success: true, pointsAdded: points, type: 'daily' });
        });
    }
});

// 获取所有消息（带分页和筛选）
app.get('/api/admin/messages', authenticateAdmin, (req, res) => {
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);
    const search = req.query.search || '';
    const userId = req.query.userId || '';

    let query = `
        SELECT m.id, m.session_id, m.role, m.content, m.model, m.created_at,
               s.title as session_title, u.username, u.email
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        JOIN users u ON s.user_id = u.id
        WHERE 1=1
    `;
    const params = [];

    if (search) {
        query += ' AND m.content LIKE ?';
        params.push(`%${search}%`);
    }

    if (userId) {
        query += ' AND u.id = ?';
        params.push(userId);
    }

    query += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    db.all(query, params, (err, messages) => {
        if (err) {
            console.error(' 获取消息列表失败:', err);
            return res.status(500).json({ error: '获取消息列表失败' });
        }
        res.json({ messages, offset, limit });
    });
});

// 删除消息
app.delete('/api/admin/messages/:messageId', authenticateAdmin, (req, res) => {
    const { messageId } = req.params;

    db.run('DELETE FROM messages WHERE id = ?', [messageId], function (err) {
        if (err) {
            console.error(' 删除消息失败:', err);
            return res.status(500).json({ error: '删除消息失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '消息不存在' });
        }
        console.log(` 管理员删除消息 ID: ${messageId}`);
        res.json({ success: true, deletedMessageId: messageId });
    });
});

// 获取所有会话
app.get('/api/admin/sessions', authenticateAdmin, (req, res) => {
    const offset = parseBoundedInteger(req.query.offset, 0, 0, 100000);
    const limit = parseBoundedInteger(req.query.limit, 50, 1, 100);

    db.all(`
        SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
               u.username, u.email,
               (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as messageCount
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
    `, [limit, offset], (err, sessions) => {
        if (err) {
            console.error(' 获取会话列表失败:', err);
            return res.status(500).json({ error: '获取会话列表失败' });
        }
        res.json({ sessions, offset, limit });
    });
});

// 删除会话
app.delete('/api/admin/sessions/:sessionId', authenticateAdmin, async (req, res) => {
    const { sessionId } = req.params;

    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        await dbRunAsync('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        const result = await dbRunAsync('DELETE FROM sessions WHERE id = ?', [sessionId]);
        if (result.changes === 0) {
            await dbRunAsync('ROLLBACK');
            return res.status(404).json({ error: '会话不存在' });
        }
        await dbRunAsync('COMMIT');
        console.log(` 管理员删除会话 ID: ${sessionId}`);
        return res.json({ success: true, deletedSessionId: sessionId });
    } catch (err) {
        await dbRunAsync('ROLLBACK').catch(() => null);
        console.error(' 删除会话失败:', err);
        return res.status(500).json({ error: '删除会话失败' });
    }
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
    console.error(' 服务器错误:', err);
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
║             RAI v0.10.9.16 已启动                      ║
║                                                          ║
║   服务地址: http://0.0.0.0:${PORT}                     ║
║   数据库: ${dbPath}                                    ║
║   JWT认证:                                          ║
║   AI提供商: Tavily + 流动硅基                           ║
║   思考模式:                                          ║
║   停止输出:                                          ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
  `);

    db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (!err) {
            console.log(` 数据库正常, 当前用户数: ${row.count}`);
        }
    });
});

// 优雅退出
process.on('SIGTERM', () => {
    console.log(' 收到SIGTERM信号,准备关闭服务器');
    db.close((err) => {
        if (err) console.error(' 关闭数据库失败:', err);
        else console.log(' 数据库已关闭');
        process.exit(0);
    });
});
