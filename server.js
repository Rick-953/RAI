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
const TAVILY_API_KEY = 'tvly-';
const TAVILY_API_URL = 'https://api.tavily.com/search';

// ==================== 原生工具调用 (Function Calling) ====================

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
}];

// 工具执行器映射
const TOOL_EXECUTORS = {
    web_search: async (args, searchDepth = 'basic') => {
        const maxResults = searchDepth === 'advanced' ? 20 : 5;
        console.log(`🔧 执行工具 web_search: query="${args.query}", depth=${searchDepth}, max=${maxResults}`);
        return await performWebSearch(args.query, maxResults, searchDepth);
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
        console.log(`🤖 agent_event type=${payload.type}${role}${status}`);
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
    if (fingerprint?.freshnessNeed) {
        return '\n\n[校验提示] 当前结果已尽力核验，但部分实时信息来源覆盖不足，请以官方最新发布为准。';
    }
    return '\n\n[校验提示] 当前回答存在不确定点，已采用保守表述；如需更高精度，请提供更多上下文。';
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
 * @returns {string} 'fast' | 'basic' | 'advanced'
 */
function getTavilySearchDepth(modelName, isThinkingMode = false) {
    // 思考模型使用高级搜索 (2 credits)
    if (isThinkingMode || modelName.includes('Thinking')) {
        return 'advanced';
    }
    // 快速/轻量模型使用快速搜索 (1 credit)
    if (modelName.includes('flash') || modelName.includes('8B') || modelName.includes('Instruct')) {
        return 'fast';
    }
    // 默认使用基础搜索 (1 credit)
    return 'basic';
}

/**
 * 执行网页搜索 (使用Tavily API)
 * Tavily是专为AI代理设计的搜索API，提供高质量、实时的搜索结果
 * @param {string} query - 搜索查询
 * @param {number} maxResults - 最大结果数量 (默认5，最大20)
 * @param {string} searchDepth - 搜索深度 'fast'|'basic'|'advanced'
 * @returns {Promise<Array>} 搜索结果数组
 */
async function performWebSearch(query, maxResults = 5, searchDepth = 'basic') {
    return new Promise((resolve) => {
        try {
            console.log(`🔍 执行Tavily网页搜索: "${query}" (深度: ${searchDepth})`);

            // 构建请求体
            const requestBody = JSON.stringify({
                api_key: TAVILY_API_KEY,
                query: query,
                search_depth: searchDepth,
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
    console.log(`🔧 调用API (带工具): model=${model}, tools=${tools.length}个`);

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

        const options = {
            hostname: urlParts.hostname,
            port: 443,
            path: urlParts.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${providerConfig.apiKey}`
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);

                    if (result.error) {
                        console.error('❌ 工具调用API错误:', result.error);
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

                    console.log(`✅ 工具调用API响应: finish_reason=${response.finish_reason}, has_tool_calls=${!!response.tool_calls}`);
                    resolve(response);
                } catch (e) {
                    console.error('❌ 解析工具调用响应失败:', e);
                    resolve({ finish_reason: 'error', tool_calls: null, content: null });
                }
            });
        });

        req.on('error', (err) => {
            console.error('❌ 工具调用请求失败:', err);
            resolve({ finish_reason: 'error', tool_calls: null, content: null });
        });

        req.setTimeout(15000, () => {
            console.warn('⚠️ 工具调用请求超时');
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
        const key = `${source?.url || ''}|${source?.title || ''}`;
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
        if (toolCall.function.name !== 'web_search') continue;
        const query = String(args.query || '').trim();
        if (!query) continue;
        normalized.push({
            id: toolCall.id || `tool_${Date.now()}_${normalized.length}`,
            type: 'function',
            function: {
                name: toolCall.function.name,
                arguments: JSON.stringify({ query })
            },
            _args: { query }
        });
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

    const currentSources = extractSourcesForSSE(normalizedResult.results || []);
    if (currentSources.length > 0 && res) {
        res.write(`data: ${JSON.stringify({ type: 'sources', sources: currentSources })}\n\n`);
    }

    return {
        result: normalizedResult,
        cached: false,
        searchCountInc: 1
    };
}

async function callK2p5NonStream({
    providerConfig,
    actualModel,
    messages,
    thinkingMode,
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
            stream: false,
            enable_thinking: !!thinkingMode
        };

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

        const currentUsage = normalizeUsage(result.usage);
        totalUsage.prompt_tokens += currentUsage.prompt_tokens;
        totalUsage.completion_tokens += currentUsage.completion_tokens;
        totalUsage.total_tokens += currentUsage.total_tokens;

        if (typeof message.content === 'string') {
            responseContent = message.content;
        }
        if (typeof message.reasoning_content === 'string') {
            reasoningContent = message.reasoning_content;
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
            const query = toolCall._args.query;
            const searchResult = await executeSearchWithBudget({
                query,
                taskKey,
                searchBudget,
                res,
                actualModel,
                thinkingMode
            });

            const modelPayload = searchResult.result;
            searchCount += searchResult.searchCountInc;
            const currentSources = extractSourcesForSSE(modelPayload.results || []);
            if (currentSources.length > 0) {
                aggregatedSources = dedupeSources([...aggregatedSources, ...currentSources]);
            }

            executedToolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(modelPayload)
            });
        }

        conversationMessages = [
            ...conversationMessages,
            {
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
            },
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
            stream: true,
            enable_thinking: !!thinkingMode
        };

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

                if (delta.reasoning_content || delta.reasoning) {
                    const reasoningChunk = delta.reasoning_content || delta.reasoning;
                    reasoningContent += reasoningChunk;
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
            const query = toolCall._args.query;
            const searchResult = await executeSearchWithBudget({
                query,
                taskKey,
                searchBudget,
                res,
                actualModel,
                thinkingMode
            });
            const modelPayload = searchResult.result;
            searchCount += searchResult.searchCountInc;
            const currentSources = extractSourcesForSSE(modelPayload.results || []);
            if (currentSources.length > 0) {
                aggregatedSources = dedupeSources([...aggregatedSources, ...currentSources]);
            }
            executedToolMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(modelPayload)
            });
        }

        conversationMessages = [
            ...conversationMessages,
            {
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
            },
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

async function runTrueParallelAgentMode({
    res,
    messages,
    userMessage,
    systemPrompt,
    thinkingMode,
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

    const actualModel = routing.model;
    const searchBudget = createSearchBudget(8, 2);
    const historyContext = buildHistoryContext(messages, 6);

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
                console.warn('⚠️ 记录Agent过程事件失败:', hookError.message);
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
        maxRetries: AGENT_MAX_RETRIES,
        traceLevel: agentTraceLevel,
        emitEvent: emitAgentEventWithHook,
        onContent: emitContentChunk,
        onReasoning: emitReasoningChunk,
        callPlanner: async ({ plannerPrompt, userMessage: inputMessage }) => {
            const plannerMessages = [
                { role: 'system', content: plannerPrompt },
                {
                    role: 'user',
                    content: `用户问题:\n${inputMessage}\n\n最近对话:\n${historyContext || '(无)'}\n\n请严格输出JSON，不要附带任何解释。`
                }
            ];
            return await callK2p5NonStream({
                providerConfig,
                actualModel,
                messages: plannerMessages,
                thinkingMode,
                internetMode: false,
                maxTokens: 1200,
                maxToolRounds: 0,
                searchBudget,
                taskKey: 'planner',
                res,
                requestTimeoutMs: 15000
            });
        },
        callSubAgent: async ({ task, subPrompt }) => {
            const subMessages = [
                { role: 'system', content: subPrompt },
                { role: 'user', content: '请完成任务并直接输出结果。' }
            ];
            return await callK2p5NonStream({
                providerConfig,
                actualModel,
                messages: subMessages,
                thinkingMode,
                internetMode,
                maxTokens: Math.min(Math.max(parseInt(maxTokens, 10) || 2000, 800), 6000),
                maxToolRounds: 2,
                searchBudget,
                taskKey: `task-${task.agent_id || 0}`,
                res,
                requestTimeoutMs: 35000
            });
        },
        streamSynthesis: async ({ synthPrompt, userMessage: inputMessage, drafts }) => {
            const draftSummary = drafts.map((d) => `[task-${d.taskId}] ${d.summary}`).join('\n');
            const synthMessages = [];
            if (systemPrompt && String(systemPrompt).trim()) {
                synthMessages.push({
                    role: 'system',
                    content: String(systemPrompt).trim()
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
                internetMode,
                maxTokens: Math.max(parseInt(maxTokens, 10) || 2000, 1200),
                maxToolRounds: 2,
                searchBudget,
                taskKey: 'synthesis',
                res,
                onContent: emitContentChunk,
                onReasoning: emitReasoningChunk,
                requestTimeoutMs: 45000
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
 * 将带附件的消息转换为OpenAI兼容多模态格式
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
        apiKey: 'sk-',
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

    // 硅基流动 SiliconFlow - Kimi K2.5 模型 + Qwen3-8B (免费)
    siliconflow: {
        apiKey: 'sk',
        baseURL: 'https://api.siliconflow.cn/v1/chat/completions',
        models: ['Pro/moonshotai/Kimi-K2.5', 'moonshotai/Kimi-K2-Instruct-0905', 'Qwen/Qwen3-8B']
    },
    // 硅基流动 SiliconFlow - Qwen3 VL 视觉模型 (图像理解)
    siliconflow_vl: {
        apiKey: 'sk-',
        baseURL: 'https://api.siliconflow.cn/v1/chat/completions',
        models: ['Qwen/Qwen3-Omni-30B-A3B-Instruct'],
        multimodal: true,  // 标记支持多模态
        visionModel: true  // 标记这是视觉模型
    },
    // Google Gemini API - Gemini 3 Flash Preview (多模态)
    google_gemini: {
        apiKey: 'AI',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/models',  // 基础URL，实际使用时会拼接模型名
        models: ['Gemini 3 Flash Preview'],
        isGemini: true,  // 标记这是Gemini API，需要特殊处理
        multimodal: true  // 支持图片/视频等多模态输入
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
        model: 'Qwen/Qwen3-Omni-30B-A3B-Instruct',
        multimodal: true,      // 支持多模态
        visionModel: true      // 这是视觉模型
    },
    'deepseek-v3': {
        provider: 'deepseek',
        model: 'deepseek-chat',
        thinkingModel: 'deepseek-reasoner'
    },
    // Kimi K2.5 - 月之暗面高性能模型
    'kimi-k2.5': {
        provider: 'siliconflow',
        model: 'Pro/moonshotai/Kimi-K2.5',
        thinkingModel: 'Pro/moonshotai/Kimi-K2.5',  // K2.5统一模型
        supportsWebSearch: true
    },
    // 兼容旧配置: kimi-k2 自动路由到 K2.5
    'kimi-k2': {
        provider: 'siliconflow',
        model: 'Pro/moonshotai/Kimi-K2.5',
        thinkingModel: 'Pro/moonshotai/Kimi-K2.5',
        supportsWebSearch: true  // 支持Tavily联网搜索
    },
    // Qwen3-8B - 硅基流动免费模型 (支持思考、工具调用、多模态)
    'qwen3-8b': {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-8B',
        supportsThinking: true,   // 支持思考模式
        supportsWebSearch: true,  // 支持Tavily联网搜索
        multimodal: false          // 支持图片输入
    },
    // Google Gemini 3 Flash - 最智能的速度优化模型（多模态）
    'gemini-3-flash': {
        provider: 'google_gemini',
        model: 'gemini-3-flash-preview',
        isGemini: true,  // 标记需要特殊处理
        multimodal: true,  // 支持图片/视频等多模态输入
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
    process_trace TEXT,
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

    // Chat Flow 思维流表
    db.run(`CREATE TABLE IF NOT EXISTS flows (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT '新思维流',
    chat_history TEXT DEFAULT '[]',
    canvas_state TEXT DEFAULT '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

        // 添加process_trace列到messages表（如果不存在）- 存储Agent过程轨迹（JSON格式）
        db.run(`ALTER TABLE messages ADD COLUMN process_trace TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加process_trace列失败(可能已存在):`, err.message);
            } else if (!err) {
                console.log('✅ 已添加process_trace列到messages表');
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

        // ==================== VIP会员系统字段 ====================
        // 会员等级: free / Pro / MAX
        db.run(`ALTER TABLE users ADD COLUMN membership TEXT DEFAULT 'free'`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加membership列失败:`, err.message);
            } else if (!err) {
                console.log('✅ 已添加membership列到users表');
            }
        });

        // 会员开始时间
        db.run(`ALTER TABLE users ADD COLUMN membership_start DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加membership_start列失败:`, err.message);
            }
        });

        // 会员结束时间
        db.run(`ALTER TABLE users ADD COLUMN membership_end DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加membership_end列失败:`, err.message);
            }
        });

        // 当前点数（每日发放，用完即止）
        db.run(`ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加points列失败:`, err.message);
            } else if (!err) {
                console.log('✅ 已添加points列到users表');
            }
        });

        // 上次签到日期（free用户签到用）
        db.run(`ALTER TABLE users ADD COLUMN last_checkin DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加last_checkin列失败:`, err.message);
            }
        });

        // 购买的点数（长期有效，2年过期）
        db.run(`ALTER TABLE users ADD COLUMN purchased_points INTEGER DEFAULT 0`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加purchased_points列失败:`, err.message);
            }
        });

        // 购买点数过期时间
        db.run(`ALTER TABLE users ADD COLUMN purchased_points_expire DATETIME`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加purchased_points_expire列失败:`, err.message);
            }
        });

        // 上次每日点数发放日期（Pro/MAX自动发放用）
        db.run(`ALTER TABLE users ADD COLUMN last_daily_grant DATE`, (err) => {
            if (err && !err.message.includes('duplicate column')) {
                console.warn(`⚠️ 添加last_daily_grant列失败:`, err.message);
            }
        });

        console.log('✅ VIP会员系统字段就绪');
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
    limits: { fileSize: 50 * 1024 * 1024 }, // 增加到 50MB
    fileFilter: (req, file, cb) => {
        // 扩展支持的文件类型
        const allowedExtensions = /jpeg|jpg|png|gif|webp|svg|bmp|ico|tiff|heic|heif|pdf|doc|docx|txt|md|json|xml|csv|log|yaml|yml|ini|conf|js|ts|jsx|tsx|py|java|c|cpp|h|hpp|css|scss|less|html|vue|svelte|swift|kt|go|rs|rb|php|sh|sql|mp4|webm|mkv|flv|wmv|avi|mov|m4v|mp3|wav|m4a|ogg|flac|aac|wma|opus/i;
        const allowedMimeTypes = /image|video|audio|text|application\/(json|pdf|msword|vnd\.openxmlformats)/i;

        const ext = path.extname(file.originalname).toLowerCase().slice(1);
        const extValid = allowedExtensions.test(ext);
        const mimeValid = allowedMimeTypes.test(file.mimetype);

        if (extValid || mimeValid) return cb(null, true);
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

// ==================== VIP会员系统路由 ====================
// 获取用户会员状态
app.get('/api/user/membership', authenticateToken, (req, res) => {
    db.get(
        `SELECT id, email, username, created_at, membership, membership_start, membership_end, 
         points, last_checkin, purchased_points, purchased_points_expire, last_daily_grant
         FROM users WHERE id = ?`,
        [req.user.userId],
        (err, user) => {
            if (err) {
                console.error('❌ 获取会员状态失败:', err);
                return res.status(500).json({ error: '数据库错误' });
            }
            if (!user) {
                return res.status(404).json({ error: '用户不存在' });
            }

            const today = new Date().toISOString().split('T')[0];
            const canCheckin = user.membership === 'free' && user.last_checkin !== today;

            // 计算总点数：当前点数 + 购买的点数（如果未过期）
            let totalPoints = user.points || 0;
            if (user.purchased_points && user.purchased_points_expire) {
                const expireDate = new Date(user.purchased_points_expire);
                if (expireDate > new Date()) {
                    totalPoints += user.purchased_points;
                }
            }

            res.json({
                membership: user.membership || 'free',
                membershipStart: user.membership_start,
                membershipEnd: user.membership_end,
                points: user.points || 0,
                purchasedPoints: user.purchased_points || 0,
                totalPoints: totalPoints,
                canCheckin: canCheckin,
                lastCheckin: user.last_checkin,
                createdAt: user.created_at
            });
        }
    );
});

// 用户签到（每日+20点数）
app.post('/api/user/checkin', authenticateToken, (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    db.get('SELECT id, membership, last_checkin, points FROM users WHERE id = ?',
        [req.user.userId],
        (err, user) => {
            if (err) {
                console.error('❌ 签到查询失败:', err);
                return res.status(500).json({ error: '数据库错误' });
            }
            if (!user) {
                return res.status(404).json({ error: '用户不存在' });
            }

            // 只有free用户需要签到
            if (user.membership !== 'free') {
                return res.status(400).json({ error: '会员用户无需签到，每日自动获得点数' });
            }

            // 检查今天是否已签到
            if (user.last_checkin === today) {
                return res.status(400).json({ error: '今日已签到' });
            }

            const pointsGained = 20;
            const newPoints = (user.points || 0) + pointsGained;

            db.run(
                'UPDATE users SET points = ?, last_checkin = ? WHERE id = ?',
                [newPoints, today, req.user.userId],
                function (err) {
                    if (err) {
                        console.error('❌ 签到更新失败:', err);
                        return res.status(500).json({ error: '签到失败' });
                    }

                    console.log(`✅ 用户 ${req.user.userId} 签到成功，获得 ${pointsGained} 点数，当前点数: ${newPoints}`);
                    res.json({
                        success: true,
                        pointsGained: pointsGained,
                        currentPoints: newPoints,
                        message: `签到成功！获得 ${pointsGained} 点数`
                    });
                }
            );
        }
    );
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
                    enable_search, thinking_mode, internet_mode, sources, process_trace, created_at,
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

// ==================== Chat Flow 思维流 API ====================

// 获取用户的 Flow 列表
app.get('/api/flows', authenticateToken, (req, res) => {
    db.all(
        `SELECT id, title, created_at, updated_at FROM flows WHERE user_id = ? ORDER BY updated_at DESC`,
        [req.user.userId],
        (err, rows) => {
            if (err) {
                console.error('❌ 获取Flow列表失败:', err);
                return res.status(500).json({ error: err.message });
            }
            res.json(rows);
        }
    );
});

// 创建新 Flow
app.post('/api/flows', authenticateToken, (req, res) => {
    const { title = '新思维流' } = req.body;
    const id = `flow-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    db.run(
        `INSERT INTO flows (id, user_id, title) VALUES (?, ?, ?)`,
        [id, req.user.userId, title],
        function (err) {
            if (err) {
                console.error('❌ 创建Flow失败:', err);
                return res.status(500).json({ error: err.message });
            }
            console.log('✅ 创建思维流成功:', id);
            res.json({ id, title, created_at: new Date().toISOString() });
        }
    );
});

// 获取单个 Flow 详情
app.get('/api/flows/:id', authenticateToken, (req, res) => {
    db.get(
        `SELECT * FROM flows WHERE id = ? AND user_id = ?`,
        [req.params.id, req.user.userId],
        (err, row) => {
            if (err) {
                console.error('❌ 获取Flow详情失败:', err);
                return res.status(500).json({ error: err.message });
            }
            if (!row) {
                return res.status(404).json({ error: 'Flow not found' });
            }
            // 解析JSON字段
            res.json({
                ...row,
                chat_history: JSON.parse(row.chat_history || '[]'),
                canvas_state: JSON.parse(row.canvas_state || '{"nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}')
            });
        }
    );
});

// 更新 Flow
app.put('/api/flows/:id', authenticateToken, (req, res) => {
    const { title, chat_history, canvas_state } = req.body;
    const updates = [];
    const params = [];

    if (title !== undefined) {
        updates.push('title = ?');
        params.push(title);
    }
    if (chat_history !== undefined) {
        updates.push('chat_history = ?');
        params.push(JSON.stringify(chat_history));
    }
    if (canvas_state !== undefined) {
        updates.push('canvas_state = ?');
        params.push(JSON.stringify(canvas_state));
    }
    updates.push('updated_at = CURRENT_TIMESTAMP');

    params.push(req.params.id, req.user.userId);

    db.run(
        `UPDATE flows SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
        params,
        function (err) {
            if (err) {
                console.error('❌ 更新Flow失败:', err);
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Flow not found' });
            }
            console.log('✅ 更新思维流成功:', req.params.id);
            res.json({ success: true });
        }
    );
});

// 删除 Flow
app.delete('/api/flows/:id', authenticateToken, (req, res) => {
    db.run(
        `DELETE FROM flows WHERE id = ? AND user_id = ?`,
        [req.params.id, req.user.userId],
        function (err) {
            if (err) {
                console.error('❌ 删除Flow失败:', err);
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Flow not found' });
            }
            console.log('✅ 删除思维流成功:', req.params.id);
            res.json({ success: true });
        }
    );
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
            agentMode = 'off',
            agentPolicy = AGENT_DEFAULT_POLICY,
            qualityProfile = AGENT_DEFAULT_QUALITY,
            agentTraceLevel = 'full',
            temperature = 0.7,
            top_p = 0.9,
            max_tokens = 2000,
            frequency_penalty = 0,
            presence_penalty = 0,
            systemPrompt
        } = req.body;

        console.log(`🔍 接收参数: model=${model}, thinking=${thinkingMode}, internet=${internetMode}, agentMode=${agentMode}, policy=${agentPolicy}, quality=${qualityProfile}, trace=${agentTraceLevel}`);

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

        const normalizedAgentMode = normalizeAgentMode(agentMode);
        let effectiveAgentMode = normalizedAgentMode;
        const agentHardDisabled = process.env.AGENT_HARD_DISABLE === '1';

        if (normalizedAgentMode === 'on') {
            if (agentHardDisabled) {
                console.warn('⚠️ AGENT_HARD_DISABLE=1，强制回退单模型路径');
                emitAgentEvent(res, {
                    type: 'agent_status',
                    role: 'master',
                    scope: 'stage',
                    stepId: 'master',
                    status: 'failed',
                    detail: '服务端已禁用Agent模式，自动回退单模型'
                });
                effectiveAgentMode = 'off';
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

                    console.log('\n🤖 启用真并行 Multi-Agent 模式 (K2.5)\n');
                    const agentResult = await runTrueParallelAgentMode({
                        res,
                        messages,
                        userMessage: userContent,
                        systemPrompt,
                        thinkingMode,
                        internetMode,
                        qualityProfile,
                        maxTokens: max_tokens,
                        agentTraceLevel,
                        onAgentEvent
                    });

                    let contentToSave = String(agentResult?.content || '').trim();
                    contentToSave = contentToSave
                        .replace(/<\|[^|]+\|>/g, '')
                        .replace(/functions\.web_search:\d+/g, '')
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
                        savedAt: agentTraceState.savedAt
                    });

                    let extractedTitle = null;
                    const titleMatch = contentToSave.match(/\[TITLE\](.*?)\[\/TITLE\]/);
                    if (titleMatch && titleMatch[1]) {
                        extractedTitle = titleMatch[1].trim();
                        contentToSave = contentToSave.replace(/\[TITLE\].*?\[\/TITLE\]/g, '').trim();
                    }

                    if (sessionId) {
                        console.log('\n💾 保存真并行 Agent 结果到数据库');

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

                        await new Promise((resolve) => {
                            db.run(
                                'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                                [sessionId],
                                () => resolve()
                            );
                        });
                    }

                    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
                    res.end();
                    console.log('\n✅ 真并行 Multi-Agent 处理完成\n');
                    return;
                } catch (agentPipelineError) {
                    console.error('⚠️ 真并行Agent流程失败，回退单模型路径:', agentPipelineError.message);
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
            console.error('⚠️ Multi-Agent 编排初始化失败，回退单模型路径:', agentError.message);
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

            // 定义原生支持多模态的模型列表（Gemini / Qwen / Kimi K2.5）
            const NATIVE_MULTIMODAL_MODELS = ['gemini-3-flash', 'qwen3-omni-flash', 'qwen3-vl', 'kimi-k2.5', 'kimi-k2'];

            // 检查用户选择的模型是否原生支持多模态
            if (NATIVE_MULTIMODAL_MODELS.includes(model)) {
                // Gemini 3 Flash / Qwen3-Omni 等原生支持多模态，直接使用
                finalModel = model;
                autoRoutingReason = `${model} 原生支持多模态，直接处理${getMultimodalTypeDescription(currentMessageMultimodal.types)}`;
                console.log(`   ✅ 模型 ${model} 原生支持多模态，无需切换`);
            } else {
                // 非多模态模型自动切换到视觉模型
                finalModel = 'qwen3-vl';
                autoRoutingReason = `${model || 'auto'} 不支持多模态，自动切换到Qwen3-Omni视觉语言模型处理${getMultimodalTypeDescription(currentMessageMultimodal.types)}`;
                console.log(`   🔄 ${model || 'auto'} 不支持多模态，切换到 qwen3-vl (Qwen/Qwen3-Omni-30B-A3B-Instruct)`);
            }
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
        const VALID_MODELS = ['qwen-flash', 'qwen-plus', 'qwen-max', 'deepseek-v3', 'deepseek-v3.2-speciale', 'qwen3-omni-flash', 'qwen3-vl', 'kimi-k2.5', 'kimi-k2', 'qwen3-8b', 'gemini-3-flash'];

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

        // Kimi K2.5 思考模式自动切换
        if ((finalModel === 'kimi-k2.5' || finalModel === 'kimi-k2') && thinkingMode && routing.thinkingModel) {
            actualModel = routing.thinkingModel;
            console.log(`🧠 Kimi K2.5 思考模式: 切换到 ${actualModel}`);
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

        // 🔍 流式工具调用模式 (Streaming Function Calling)
        // 不再预先判断，而是在流式响应中检测 tool_calls
        let searchContext = '';
        let searchSources = [];
        let useStreamingTools = false;  // 标记是否启用流式工具调用

        if (internetMode && routing.provider !== 'aliyun') {
            console.log(`🌐 联网模式: 启用流式工具调用 (Streaming Function Calling)`);
            useStreamingTools = true;
            // 不再阻塞等待，直接在后面的流式调用中添加 tools 参数
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

        // 添加系统提示词（包含搜索结果）
        // 注意: Mermaid 图表生成指南已内置在前端的 buildSystemPrompt() 中
        let systemContent = searchContext
            ? `${systemPrompt || ''}\n${searchContext}`.trim()
            : systemPrompt || '';

        // 🔧 流式工具调用：在系统提示词中告知 AI 它有搜索能力
        if (useStreamingTools) {
            const toolHint = `\n\n[系统提示] 当前处于联网模式。若用户要求“最新/实时/文献/论文/来源/数据依据/研究结论”，请至少调用一次 web_search 再回答；涉及天气、新闻、股价、时效数据时也应按需调用，并可在必要时再次调用。`;
            systemContent = systemContent ? `${systemContent}${toolHint}` : toolHint.trim();
            console.log(`🔧 已添加工具提示到系统提示词`);
        }

        if (systemContent) {
            finalMessages.unshift({
                role: 'system',
                content: systemContent
            });
        }

        const isKimiK25Model = (finalModel === 'kimi-k2.5' || finalModel === 'kimi-k2' || /Kimi-K2\.5/i.test(actualModel));

        // 构建API请求体
        const requestBody = {
            model: actualModel,
            messages: finalMessages,
            max_tokens: parseInt(max_tokens, 10) || 2000,
            stream: true  // Qwen3-Omni-Flash要求必须开启流式
        };

        // Kimi K2.5 参数规则：
        // 1) 默认思考开启；要快速响应需显式关闭思考
        // 2) 对 K2.5 不传可变采样参数，避免参数冲突
        if (isKimiK25Model) {
            if (routing.provider === 'siliconflow') {
                // SiliconFlow: 使用 enable_thinking 开关
                requestBody.enable_thinking = !!thinkingMode;
                console.log(`🧠 Kimi K2.5 enable_thinking=${requestBody.enable_thinking} (${thinkingMode ? '深度模式' : '快速模式'})`);
            } else {
                // Moonshot 原生兼容写法
                requestBody.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
                console.log(`🧠 Kimi K2.5 thinking=${requestBody.thinking.type} (${thinkingMode ? '深度模式' : '快速模式'})`);
            }
        } else {
            requestBody.temperature = parseFloat(temperature) || 0.7;
            requestBody.top_p = parseFloat(top_p) || 0.9;
        }

        // 🔧 流式工具调用：为请求添加 tools 参数
        if (useStreamingTools) {
            requestBody.tools = TOOL_DEFINITIONS;
            // 支持“先说一部分，再按需调用工具，再继续说”
            requestBody.tool_choice = "auto";
            console.log(`🔧 已为流式调用添加工具定义: ${TOOL_DEFINITIONS.length}个工具`);
        }

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
        if (Object.prototype.hasOwnProperty.call(requestBody, 'temperature') &&
            (isNaN(requestBody.temperature) || requestBody.temperature < 0 || requestBody.temperature > 2)) {
            console.warn(`⚠️ 无效的temperature值: ${temperature}，使用默认值0.7`);
            requestBody.temperature = 0.7;
        }
        if (Object.prototype.hasOwnProperty.call(requestBody, 'top_p') &&
            (isNaN(requestBody.top_p) || requestBody.top_p < 0 || requestBody.top_p > 1)) {
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
        let rawToolContent = '';
        let agentSynthesizerRunning = false;
        let agentResearcherRunning = false;

        // 🔥 Gemini API 特殊处理
        const isGeminiAPI = providerConfig.isGemini || routing.isGemini;

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

            // 🔧 流式工具调用：累积 tool_calls 数据
            let accumulatedToolCalls = [];  // 累积的工具调用
            let pendingToolCall = null;     // 当前正在累积的工具调用
            let streamFinishReason = null;  // 流结束原因
            let toolMarkerCarry = '';
            let inToolCallSection = false;
            const TOOL_CALL_SECTION_START = '<|tool_calls_section_begin|>';
            const TOOL_CALL_SECTION_END = '<|tool_calls_section_end|>';

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
                visible = visible.replace(/functions\.web_search:\d+/g, '');

                if (/^\s*\{[\s\S]*"query"[\s\S]*\}\s*$/.test(visible)) {
                    return '';
                }

                return visible;
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
                    console.log(`🛑 请求被用户取消: ${requestId}`);
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
                                    rawToolContent += content;
                                    const filteredContent = sanitizeStreamingContent(content);

                                    if (filteredContent.length > 0) {
                                        if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('synthesizer') && !agentSynthesizerRunning) {
                                            emitAgentEvent(res, {
                                                type: 'agent_status',
                                                role: 'synthesizer',
                                                status: 'running',
                                                detail: '正在生成候选答案'
                                            });
                                            agentSynthesizerRunning = true;
                                        }
                                        fullContent += filteredContent;
                                        res.write(`data: ${JSON.stringify({ type: 'content', content: filteredContent })}\n\n`);
                                    }
                                }

                                // 🔧 流式工具调用：检测 tool_calls
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

                if (done) {
                    console.log('✅ 流式响应结束');
                    break;
                }
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
                                if (call?.name === 'web_search' && call.arguments) {
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
                        if (functionName !== 'web_search') continue;

                        try {
                            fallbackCalls.push({
                                name: functionName,
                                arguments: JSON.parse(argumentText)
                            });
                        } catch (e) {
                            console.warn('⚠️ 无法解析工具参数(JSON):', argumentText);
                        }
                    }
                }

                // 3) 松散文本格式
                if (fallbackCalls.length === 0 && trimmedText.includes('functions.web_search')) {
                    const looseRegex = /functions\.(\w+)(?::\d+)?[\s\S]{0,120}?(\{[\s\S]*?"query"[\s\S]*?\})/g;
                    let looseMatch;
                    while ((looseMatch = looseRegex.exec(trimmedText)) !== null) {
                        const functionName = looseMatch[1];
                        const argumentText = looseMatch[2];
                        if (functionName !== 'web_search') continue;

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

                    if (!args || typeof args !== 'object' || typeof args.query !== 'string' || !args.query.trim()) {
                        continue;
                    }

                    normalized.push({
                        ...toolCall,
                        function: {
                            ...toolCall.function,
                            arguments: JSON.stringify(args)
                        },
                        _args: args
                    });
                }
                return normalized;
            };

            // 初始流 fallback：模型可能把 tool_calls 作为文本输出
            if (useStreamingTools && accumulatedToolCalls.length === 0 && rawToolContent) {
                const fallbackCalls = extractFallbackToolCalls(rawToolContent);
                if (fallbackCalls.length > 0) {
                    console.log(`⚠️ 检测到 AI 以文本形式输出工具调用，已转换为标准 tool_calls: ${fallbackCalls.length} 个`);
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
                console.warn(`⚠️ 联网模式已开启，但模型未触发工具调用: model=${actualModel}`);
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
                    console.warn(`⚠️ 收到 tool_calls 但均无效，已跳过`);
                } else {
                    let toolRound = 0;
                    const maxToolRounds = 5;
                    let conversationMessages = [...finalMessages];

                    while (pendingToolCalls.length > 0 && toolRound < maxToolRounds) {
                        toolRound += 1;
                        console.log(`🔁 工具调用轮次: ${toolRound}, calls=${pendingToolCalls.length}`);

                        const executedToolResults = [];
                        for (const toolCall of pendingToolCalls) {
                            const toolName = toolCall.function.name;
                            const args = toolCall._args;

                            console.log(`🔧 执行工具: ${toolName}, args=${JSON.stringify(args)}`);
                            if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('researcher')) {
                                emitAgentEvent(res, {
                                    type: 'agent_status',
                                    role: 'researcher',
                                    status: 'running',
                                    detail: `检索中: ${args.query}`
                                });
                                agentResearcherRunning = true;
                            }
                            res.write(`data: ${JSON.stringify({
                                type: 'search_status',
                                status: 'searching',
                                query: args.query,
                                message: `正在搜索: "${args.query}"`
                            })}\n\n`);

                            const executor = TOOL_EXECUTORS[toolName];
                            if (!executor) {
                                console.warn(`⚠️ 未找到工具执行器: ${toolName}`);
                                continue;
                            }

                            const searchDepth = getTavilySearchDepth(actualModel, thinkingMode);
                            const result = await executor(args, searchDepth);
                            executedToolResults.push({ toolCall, result });

                            const searchResults = result.results || result;
                            let searchImages = result.images || [];
                            if (searchImages.length > 0) {
                                searchImages = await filterValidImages(searchImages, 5, 3000);
                            }

                            if (searchResults && searchResults.length > 0) {
                                const currentSources = extractSourcesForSSE(searchResults);
                                if (currentSources.length > 0) {
                                    const sourceMap = new Map((searchSources || []).map(s => [`${s.url}|${s.title}`, s]));
                                    for (const s of currentSources) {
                                        sourceMap.set(`${s.url}|${s.title}`, s);
                                    }
                                    searchSources = Array.from(sourceMap.values());
                                }

                                res.write(`data: ${JSON.stringify({
                                    type: 'search_status',
                                    status: 'complete',
                                    query: args.query,
                                    resultCount: searchResults.length,
                                    message: `找到 ${searchResults.length} 条结果`
                                })}\n\n`);

                                if (currentSources.length > 0) {
                                    res.write(`data: ${JSON.stringify({ type: 'sources', sources: currentSources })}\n\n`);
                                }
                                console.log(`✅ 工具执行完成: ${searchResults.length} 条结果`);
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
                        }

                        if (executedToolResults.length === 0) {
                            console.warn(`⚠️ 本轮没有可执行的工具结果，结束工具循环`);
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

                        if (isKimiK25Model) {
                            if (routing.provider === 'siliconflow') {
                                continueRequestBody.enable_thinking = !!thinkingMode;
                            } else {
                                continueRequestBody.thinking = { type: thinkingMode ? 'enabled' : 'disabled' };
                            }
                        } else {
                            continueRequestBody.temperature = parseFloat(temperature) || 0.7;
                            continueRequestBody.top_p = parseFloat(top_p) || 0.9;
                        }

                        console.log(`🔄 发起续传流式调用 (round=${toolRound})...`);
                        // 重置工具标记清洗器状态，避免跨轮污染
                        toolMarkerCarry = '';
                        inToolCallSection = false;

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
                            console.error(`❌ 续传请求失败: ${continueResponse.status} ${continueErr.substring(0, 300)}`);
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
                                    const continueChoice = continueParsed.choices?.[0];
                                    const continueDelta = continueChoice?.delta || {};

                                    if (continueChoice?.finish_reason) {
                                        continueStreamFinishReason = continueChoice.finish_reason;
                                    }

                                    if (continueDelta.reasoning_content || continueDelta.reasoning) {
                                        const reasoning = continueDelta.reasoning_content || continueDelta.reasoning;
                                        reasoningContent += reasoning;
                                        res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoning })}\n\n`);
                                    }

                                    if (continueDelta.content) {
                                        continueRawToolContent += continueDelta.content;
                                        rawToolContent += continueDelta.content;
                                        const filteredContinueContent = sanitizeStreamingContent(continueDelta.content);
                                        if (filteredContinueContent.length > 0) {
                                            if (agentRuntime.enabled && agentRuntime.selectedAgents.includes('synthesizer') && !agentSynthesizerRunning) {
                                                emitAgentEvent(res, {
                                                    type: 'agent_status',
                                                    role: 'synthesizer',
                                                    status: 'running',
                                                    detail: '正在生成候选答案'
                                                });
                                                agentSynthesizerRunning = true;
                                            }
                                            fullContent += filteredContinueContent;
                                            res.write(`data: ${JSON.stringify({ type: 'content', content: filteredContinueContent })}\n\n`);
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
                        console.log(`✅ 续传流式调用完成 (round=${toolRound}), next_tool_calls=${pendingToolCalls.length}, finish_reason=${continueStreamFinishReason || 'unknown'}`);
                    }

                    if (toolRound >= maxToolRounds && pendingToolCalls.length > 0) {
                        console.warn(`⚠️ 工具调用轮次达到上限(${maxToolRounds})，强制结束以避免死循环`);
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
                        fullContent += conservativeNote;
                        res.write(`data: ${JSON.stringify({ type: 'content', content: conservativeNote })}\n\n`);
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
            // 兜底清洗：避免工具调用标记残留到数据库
            contentToSave = contentToSave
                .replace(/<\|[^|]+\|>/g, '')
                .replace(/functions\.web_search:\d+/g, '')
                .trim();
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

// ==================== VIP 会员系统 ====================

// 会员配置
const MEMBERSHIP_CONFIG = {
    free: { dailyPoints: 20, needsCheckin: true },
    Pro: { dailyPoints: 90, needsCheckin: false },
    MAX: { dailyPoints: 10000, needsCheckin: false }
};

// 获取会员状态和点数
app.get('/api/user/membership', authenticateToken, async (req, res) => {
    try {
        const user = await new Promise((resolve, reject) => {
            db.get(`
                SELECT id, email, username, created_at,
                       COALESCE(membership, 'free') as membership,
                       membership_start, membership_end,
                       COALESCE(points, 0) as points,
                       COALESCE(purchased_points, 0) as purchased_points,
                       purchased_points_expire,
                       last_checkin, last_daily_grant
                FROM users WHERE id = ?
            `, [req.user.userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        // 检查会员是否过期
        let membership = user.membership || 'free';
        if (membership !== 'free' && user.membership_end) {
            const endDate = new Date(user.membership_end);
            if (endDate < new Date()) {
                // 会员已过期，降级为 free
                membership = 'free';
                db.run('UPDATE users SET membership = ? WHERE id = ?', ['free', user.id]);
            }
        }

        // 检查购买点数是否过期
        let purchasedPoints = user.purchased_points || 0;
        if (purchasedPoints > 0 && user.purchased_points_expire) {
            const expireDate = new Date(user.purchased_points_expire);
            if (expireDate < new Date()) {
                purchasedPoints = 0;
                db.run('UPDATE users SET purchased_points = 0 WHERE id = ?', [user.id]);
            }
        }

        // 检查今日是否需要自动发放点数（Pro/MAX）
        const today = new Date().toISOString().split('T')[0];
        let points = user.points || 0;

        if (membership !== 'free' && user.last_daily_grant !== today) {
            // 自动发放每日点数
            const config = MEMBERSHIP_CONFIG[membership];
            if (config) {
                points = config.dailyPoints;
                db.run('UPDATE users SET points = ?, last_daily_grant = ? WHERE id = ?',
                    [points, today, user.id]);
                console.log(`✨ 用户 ${user.id} (${membership}) 自动发放 ${points} 点数`);
            }
        }

        // 检查今日是否可以签到（free用户）
        const canCheckin = membership === 'free' && user.last_checkin !== today;

        res.json({
            membership,
            membershipStart: user.membership_start,
            membershipEnd: user.membership_end,
            points,
            purchasedPoints,
            purchasedPointsExpire: user.purchased_points_expire,
            totalPoints: points + purchasedPoints,
            canCheckin,
            lastCheckin: user.last_checkin,
            createdAt: user.created_at
        });

    } catch (error) {
        console.error('❌ 获取会员状态失败:', error);
        res.status(500).json({ error: '获取会员状态失败' });
    }
});

// 每日签到（free用户）
app.post('/api/user/checkin', authenticateToken, async (req, res) => {
    try {
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT id, membership, points, last_checkin FROM users WHERE id = ?',
                [req.user.userId], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
        });

        if (!user) {
            return res.status(404).json({ error: '用户不存在' });
        }

        const membership = user.membership || 'free';
        if (membership !== 'free') {
            return res.status(400).json({ error: 'Pro/MAX 用户无需签到，每日自动发放点数' });
        }

        const today = new Date().toISOString().split('T')[0];
        if (user.last_checkin === today) {
            return res.status(400).json({ error: '今日已签到' });
        }

        // 签到获得20点
        const newPoints = (user.points || 0) + MEMBERSHIP_CONFIG.free.dailyPoints;

        await new Promise((resolve, reject) => {
            db.run('UPDATE users SET points = ?, last_checkin = ? WHERE id = ?',
                [newPoints, today, user.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
        });

        console.log(`✅ 用户 ${user.id} 签到成功，获得 ${MEMBERSHIP_CONFIG.free.dailyPoints} 点数`);
        res.json({
            success: true,
            pointsGained: MEMBERSHIP_CONFIG.free.dailyPoints,
            newPoints
        });

    } catch (error) {
        console.error('❌ 签到失败:', error);
        res.status(500).json({ error: '签到失败' });
    }
});

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

            // 如果使用的是 qwen3-8b（免费模型），不扣点
            if (modelUsed && modelUsed.includes('qwen3') && modelUsed.includes('8b')) {
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
                    message: '点数不足，自动切换到免费模型'
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

// 管理员配置（独立于用户系统）
const ADMIN_CONFIG = {
    username: 'admin',
    password: 'RAI@Admin2025',
    secret: 'admin-jwt-secret-rai-2025'
};

// 管理员认证中间件
const authenticateAdmin = (req, res, next) => {
    const token = req.headers['x-admin-token'];
    if (!token) {
        return res.status(401).json({ error: '需要管理员令牌' });
    }
    try {
        const decoded = jwt.verify(token, ADMIN_CONFIG.secret);
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
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;

    if (username === ADMIN_CONFIG.username && password === ADMIN_CONFIG.password) {
        const token = jwt.sign({ isAdmin: true, loginTime: Date.now() }, ADMIN_CONFIG.secret, { expiresIn: '8h' });
        console.log('🔐 管理员登录成功');
        res.json({ success: true, token });
    } else {
        console.log('⚠️ 管理员登录失败尝试');
        res.status(401).json({ error: '管理员凭据无效' });
    }
});

// 验证管理员Token
app.get('/api/admin/verify', authenticateAdmin, (req, res) => {
    res.json({ success: true, isAdmin: true });
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

        res.json({
            totalUsers,
            totalSessions,
            totalMessages,
            todayMessages,
            dailyStats,
            modelUsage,
            topUsers
        });

    } catch (error) {
        console.error('❌ 获取统计数据失败:', error);
        res.status(500).json({ error: '获取统计数据失败' });
    }
});

// 获取所有用户列表
app.get('/api/admin/users', authenticateAdmin, (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 50;

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
            console.error('❌ 获取用户列表失败:', err);
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
        console.error('❌ 获取用户详情失败:', error);
        res.status(500).json({ error: '获取用户详情失败' });
    }
});

// 获取指定会话的所有消息（完整内容）
app.get('/api/admin/sessions/:sessionId/messages', authenticateAdmin, async (req, res) => {
    const { sessionId } = req.params;
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 100;

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
        console.error('❌ 获取会话消息失败:', error);
        res.status(500).json({ error: '获取会话消息失败' });
    }
});

// 获取指定用户的详细信息和消息
app.get('/api/admin/users/:userId/messages', authenticateAdmin, (req, res) => {
    const { userId } = req.params;
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 50;

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
            console.error('❌ 获取用户消息失败:', err);
            return res.status(500).json({ error: '获取用户消息失败' });
        }
        res.json({ messages, offset, limit });
    });
});

// 删除用户（及其所有数据）
app.delete('/api/admin/users/:userId', authenticateAdmin, (req, res) => {
    const { userId } = req.params;

    // 先删除用户的所有消息和会话，再删除用户
    db.serialize(() => {
        db.run('DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ?)', [userId]);
        db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
        db.run('DELETE FROM user_configs WHERE user_id = ?', [userId]);
        db.run('DELETE FROM device_fingerprints WHERE user_id = ?', [userId]);
        db.run('DELETE FROM users WHERE id = ?', [userId], function (err) {
            if (err) {
                console.error('❌ 删除用户失败:', err);
                return res.status(500).json({ error: '删除用户失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '用户不存在' });
            }
            console.log(`🗑️ 管理员删除用户 ID: ${userId}`);
            res.json({ success: true, deletedUserId: userId });
        });
    });
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
            console.error('❌ 设置会员失败:', err);
            return res.status(500).json({ error: '设置会员失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '用户不存在' });
        }
        console.log(`👑 管理员设置用户 ${userId} 会员为 ${membership}，时长 ${months || 0} 个月`);
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
                console.error('❌ 添加购买点数失败:', err);
                return res.status(500).json({ error: '添加点数失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '用户不存在' });
            }
            console.log(`💰 管理员给用户 ${userId} 添加 ${points} 购买点数`);
            res.json({ success: true, pointsAdded: points, type: 'purchased' });
        });
    } else {
        // 每日点数
        db.run(`
            UPDATE users SET points = COALESCE(points, 0) + ? WHERE id = ?
        `, [points, userId], function (err) {
            if (err) {
                console.error('❌ 添加每日点数失败:', err);
                return res.status(500).json({ error: '添加点数失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '用户不存在' });
            }
            console.log(`⚡ 管理员给用户 ${userId} 添加 ${points} 每日点数`);
            res.json({ success: true, pointsAdded: points, type: 'daily' });
        });
    }
});

// 获取所有消息（带分页和筛选）
app.get('/api/admin/messages', authenticateAdmin, (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 50;
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
            console.error('❌ 获取消息列表失败:', err);
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
            console.error('❌ 删除消息失败:', err);
            return res.status(500).json({ error: '删除消息失败' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: '消息不存在' });
        }
        console.log(`🗑️ 管理员删除消息 ID: ${messageId}`);
        res.json({ success: true, deletedMessageId: messageId });
    });
});

// 获取所有会话
app.get('/api/admin/sessions', authenticateAdmin, (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit = parseInt(req.query.limit) || 50;

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
            console.error('❌ 获取会话列表失败:', err);
            return res.status(500).json({ error: '获取会话列表失败' });
        }
        res.json({ sessions, offset, limit });
    });
});

// 删除会话
app.delete('/api/admin/sessions/:sessionId', authenticateAdmin, (req, res) => {
    const { sessionId } = req.params;

    db.serialize(() => {
        db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        db.run('DELETE FROM sessions WHERE id = ?', [sessionId], function (err) {
            if (err) {
                console.error('❌ 删除会话失败:', err);
                return res.status(500).json({ error: '删除会话失败' });
            }
            if (this.changes === 0) {
                return res.status(404).json({ error: '会话不存在' });
            }
            console.log(`🗑️ 管理员删除会话 ID: ${sessionId}`);
            res.json({ success: true, deletedSessionId: sessionId });
        });
    });
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
║            🚀 RAI v0.9 已启动                            ║
║                                                          ║
║  📡 服务地址: http://0.0.0.0:${PORT}                     ║
║  📊 数据库: ${dbPath}                                    ║
║  🔐 JWT认证: ✅                                         ║
║  🤖 AI提供商: Tavily + 流动硅基                           ║
║  🧠 思考模式: ✅                                         ║
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
