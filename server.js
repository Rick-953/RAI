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

const app = express();
const PORT = process.env.PORT || 3009;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ==================== 🚀 智能路由引擎核心 v4 ====================

// 默认词库 (大幅扩充)
const defaultKeywords = {
    forceMax: [
        // 中文情绪词
        '不满意', '很生气', '生气', '愤怒', '错误', '有问题', '我生气了', '你们真烦', '别烦我',
        '糟糕', '太烂', '好烂', '太垃圾', '好垃圾', '好差劲', '太差劲', '好废物', '太废物',
        '坑爹', '气死', '郁闷', '烦死', '吐槽', '无语', '崩溃', '爆炸',
        // 标点符号
        '!', '!!', '!!!', '！！！！', '!!!!!', '!!!!!!', '……', '。。。', '…………', '！', '！！', '！！！',
        // 中文态度词
        '仔细', '认真', '详细', '一定要', '必须', '立即', '马上', '紧急', '重要', '关键', '严肃',
        '认真对待', '不能马虎', '务必', '千万', '绝对', '一定', '不许', '不能',
        // 英文情绪词
        'angry', 'furious', 'upset', 'disappointed', 'unsatisfied', 'awful', 'terrible', 'horrible',
        'wrong', 'error', 'problem', 'issue', 'urgent', 'critical', 'important', 'immediate',
        'cannot', 'must not', 'absolutely', 'definitely', 'certainly', 'seriously', 'carefully'
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
    thresholds: { t1: 0.35, t2: 0.70 },
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
        len <= 30 ? 0.12 :
            len <= 60 ? 0.25 :
                len <= 150 ? 0.45 :
                    len <= 300 ? 0.65 :
                        Math.min(0.85 + (len - 300) / 1000, 1);

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

// ==================== API配置系统 ====================
const API_PROVIDERS = {
    aliyun: {
        apiKey: '***REMOVED***',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        models: ['qwen-flash', 'qwen-plus', 'qwen-max']
    },
    deepseek: {
        apiKey: '***REMOVED***',
        baseURL: 'https://api.deepseek.com/v1/chat/completions',
        models: ['deepseek-chat', 'deepseek-reasoner']
    }
};

// 模型路由映射 (支持auto模式)
const MODEL_ROUTING = {
    // 具体模型配置
    'qwen-flash': { provider: 'aliyun', model: 'qwen-flash' },
    'qwen-plus': { provider: 'aliyun', model: 'qwen-plus' },
    'qwen-max': { provider: 'aliyun', model: 'qwen-max' },
    'deepseek-v3': {
        provider: 'deepseek',
        model: 'deepseek-chat',
        thinkingModel: 'deepseek-reasoner'
    },
    // ✅ 关键修复：将 'auto' 标记为特殊的虚拟路由，表示需要动态选择
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
    });
});

// 中间件配置
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/avatars', express.static(path.join(__dirname, 'avatars')));
app.use(express.static(path.join(__dirname, 'public')));

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
    db.all(
        `SELECT s.*,
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count,
      (SELECT content FROM messages WHERE session_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message
    FROM sessions s
    WHERE s.user_id = ? AND s.is_archived = 0
    ORDER BY s.updated_at DESC`,
        [req.user.userId],
        (err, sessions) => {
            if (err) {
                console.error('❌ 获取会话列表失败:', err);
                return res.status(500).json({ error: '数据库错误' });
            }
            res.json(sessions);
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

        db.all(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC',
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
            model = 'auto',  // 🔥 默认为auto模式
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

        // 记录活跃请求
        db.run(
            'INSERT INTO active_requests (id, user_id, session_id, is_cancelled) VALUES (?, ?, ?, 0)',
            [requestId, req.user.userId, sessionId || 'temp']
        );

        // 🔥 智能路由：根据最后一条用户消息自动选择模型
        let finalModel = model;  // 最终选中的模型类型（qwen-flash/plus/max或deepseek-v3）
        let routing = null;      // 对应的路由配置
        let autoRoutingReason = '';

        console.log(`\n📊 模型选择开始: 用户指定 = ${model}`);

        if (model === 'auto') {
            // 分析最后一条用户消息
            const lastUserMsg = messages[messages.length - 1];
            const userContent = typeof lastUserMsg.content === 'string'
                ? lastUserMsg.content
                : JSON.stringify(lastUserMsg.content);

            console.log(`📝 分析消息: "${userContent.substring(0, 100)}${userContent.length > 100 ? '...' : ''}"`);

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

        // ✅ 修复：Auto模式下如果开启联网，强制使用支持联网的模型 (Aliyun)
        if (model === 'auto' && internetMode) {
            console.log('🌐 Auto模式检测到联网需求，强制切换到 阿里云(qwen-max)');
            finalModel = 'qwen-max';
            autoRoutingReason = '联网模式强制使用Qwen-Max';
        }

        // ✅ 关键修复：添加白名单验证（防御性编程）
        const VALID_MODELS = ['qwen-flash', 'qwen-plus', 'qwen-max', 'deepseek-v3'];
        if (!VALID_MODELS.includes(finalModel)) {
            console.warn(`⚠️ 无效模型 ${finalModel},回退到 qwen-flash`);
            finalModel = 'qwen-flash';
            autoRoutingReason = '无效模型,自动回退到Flash';
        }

        // 🔥 关键修复：现在finalModel已经是具体的模型名，再获取routing
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

        // 构建消息数组
        const finalMessages = [...messages];
        if (systemPrompt) {
            finalMessages.unshift({
                role: 'system',
                content: systemPrompt
            });
        }

        // 🔥 构建API请求体
        const requestBody = {
            model: actualModel,
            messages: finalMessages,
            temperature: parseFloat(temperature) || 0.7,
            top_p: parseFloat(top_p) || 0.9,
            max_tokens: parseInt(max_tokens, 10) || 2000,
            stream: true
        };

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

        // 🔥 阿里云思考模式（仅Qwen）
        if (thinkingMode && routing.provider === 'aliyun') {
            requestBody.enable_thinking = true;

            // ✅ 思考预算直接放顶层，不用extra_body
            const budget = parseInt(thinkingBudget);
            const validBudget = Math.max(256, Math.min(isNaN(budget) ? 1024 : budget, 32768));

            requestBody.thinking_budget = validBudget;  // ✅ 改为直接放顶层

            console.log(`🧠 Qwen思考模式已开启, 预算: ${validBudget} tokens`);
        }

        // 🔥 阿里云互联网模式
        if (internetMode && routing.provider === 'aliyun') {
            // ✅ 修复：确保enable_search是布尔值，不能是其他类型
            requestBody.enable_search = true;
            console.log(`🌐 阿里云互联网搜索已开启`);
        }

        // 🔥 DeepSeek参数
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

        // 设置SSE响应头
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('X-Request-ID', requestId);
        res.setHeader('X-Model-Used', finalModel);  // 🔥 返回实际使用的模型

        // ✅ 只在有效内容时才设置响应头，且避免纯空格
        if (reasonForHeader && reasonForHeader.trim().length > 0) {
            res.setHeader('X-Model-Reason', reasonForHeader);  // 🔥 返回选择原因
        }

        res.flushHeaders();

        console.log(`\n📤 发送请求到 ${routing.provider} - ${actualModel}\n`);

        // ✅ 关键修复：调用API
        console.log(`🌐 正在调用: ${providerConfig.baseURL}`);
        console.log(`   API密钥: ${providerConfig.apiKey.substring(0, 10)}...`);

        const apiResponse = await fetch(providerConfig.baseURL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${providerConfig.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

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

        let fullContent = '';
        let reasoningContent = '';
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
                    } catch (e) {
                        console.error('⚠️ 解析响应行错误:', e.message);
                    }
                }
            }
        }

        // ✅ 完整的消息保存逻辑
        if (sessionId) {
            console.log('\n💾 开始保存消息到数据库');

            // 1. 保存用户消息
            const lastUserMsg = messages[messages.length - 1];
            if (lastUserMsg && lastUserMsg.role === 'user') {
                const userContent = typeof lastUserMsg.content === 'string'
                    ? lastUserMsg.content
                    : JSON.stringify(lastUserMsg.content);

                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
                        [sessionId, 'user', userContent],
                        (err) => {
                            if (err) {
                                console.error('❌ 保存用户消息失败:', err);
                                reject(err);
                            } else {
                                console.log(`✅ 用户消息已保存 (${userContent.length}字符)`);
                                resolve();
                            }
                        }
                    );
                });
            }

            // 2. 保存AI回复
            const finalContent = fullContent || (reasoningContent ? '(纯思考内容)' : '(生成中断)');
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO messages (session_id, role, content, reasoning_content) VALUES (?, ?, ?, ?)',
                    [sessionId, 'assistant', finalContent, reasoningContent || null],
                    (err) => {
                        if (err) {
                            console.error('❌ 保存AI消息失败:', err);
                            reject(err);
                        } else {
                            console.log(`✅ AI回复已保存:`);
                            console.log(`   - 内容: ${fullContent.length}字符`);
                            console.log(`   - 思考: ${reasoningContent.length}字符`);
                            resolve();
                        }
                    }
                );
            });

            // 3. 更新会话时间戳
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
║            🚀 RAI v3.2 已启动                            ║
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
