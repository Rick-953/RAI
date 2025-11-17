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

// 模型路由映射
const MODEL_ROUTING = {
  'qwen-flash': { provider: 'aliyun', model: 'qwen-flash' },
  'qwen-plus': { provider: 'aliyun', model: 'qwen-plus' },
  'qwen-max': { provider: 'aliyun', model: 'qwen-max' },
  'deepseek-v3': { 
    provider: 'deepseek', 
    model: 'deepseek-chat',
    thinkingModel: 'deepseek-reasoner'
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
      return res.status(400).json({ success: false, error: '邮箱格式不正确' });
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
          function(err) {
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

      
      // 确保所有字段都有值
      const profile = {
        id: user.id,
        email: user.email || '',
        username: user.username || user.email.split('@')[0],
        avatar_url: user.avatar_url || null,
        created_at: user.created_at,
        last_login: user.last_login,
        theme: user.theme,
        default_model: user.default_model,
        temperature: parseFloat(user.temperature),
        top_p: parseFloat(user.top_p),
        max_tokens: parseInt(user.max_tokens),
        frequency_penalty: parseFloat(user.frequency_penalty),
        presence_penalty: parseFloat(user.presence_penalty),
        system_prompt: user.system_prompt,
        thinking_mode: user.thinking_mode,
        internet_mode: user.internet_mode
      };
      
      console.log('✅ 返回用户信息, ID:', user.id, 'Username:', profile.username);
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
      req.user.userId, theme, default_model, temperature, top_p, max_tokens,
      frequency_penalty, presence_penalty, system_prompt, 
      thinking_mode ? 1 : 0, internet_mode ? 1 : 0
    ],
    (err) => {
      if (err) {
        console.error('❌ 保存配置失败:', err);
        return res.status(500).json({ error: '保存失败' });
      }
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
  
  try {
    const {
      sessionId,
      messages,
      model = 'deepseek-v3',
      thinkingMode = false,
      thinkingBudget = 1024,  // 🔥 添加这一行
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
    const requestId = `req_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
    
    // 记录活跃请求
    db.run(
      'INSERT INTO active_requests (id, user_id, session_id, is_cancelled) VALUES (?, ?, ?, 0)',
      [requestId, req.user.userId, sessionId || 'temp']
    );
    
    // 路由到正确的API
    const routing = MODEL_ROUTING[model];
    let actualModel = routing.model;
    
    // DeepSeek思考模式自动切换
    if (model === 'deepseek-v3' && thinkingMode) {
      actualModel = routing.thinkingModel;
    }
    
    const providerConfig = API_PROVIDERS[routing.provider];
    
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
  model: actualModel,  // 使用 actualModel 而不是 modelInfo.model
  messages: finalMessages,  // 使用 finalMessages 而不是 processedMessages
  temperature: parseFloat(temperature),
  top_p: parseFloat(top_p),
  max_tokens: parseInt(max_tokens),
  stream: true
};

// 🔥 Qwen3 思考模式（使用 enable_thinking 参数）
if (thinkingMode && routing.provider === 'aliyun') {
  requestBody.enable_thinking = true;
  
  // ✅ thinking_budget必须放在extra_body中
  const budget = parseInt(thinkingBudget);
  
  // 确保预算在有效范围内（256-32768）
  const validBudget = Math.max(256, Math.min(budget, 32768));
  
  requestBody.extra_body = {
    thinking_budget: validBudget
  };
  
  console.log(`🧠 Qwen思考模式已开启, 预算: ${validBudget} tokens`);
}



// 🔥 DeepSeek 已在 actualModel 中处理，无需额外操作

// 阿里云特有参数
if (routing.provider === 'aliyun' && internetMode) {
  requestBody.enable_search = true;
}

// DeepSeek特有参数
if (routing.provider === 'deepseek') {
  requestBody.frequency_penalty = parseFloat(frequency_penalty);
  requestBody.presence_penalty = parseFloat(presence_penalty);
}

console.log('📤 请求参数:', JSON.stringify(requestBody, null, 2));

    
    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Request-ID', requestId);
    res.flushHeaders();
    
    console.log(`📤 发送请求到 ${routing.provider} - ${actualModel}`);
    
    // 调用API
    const apiResponse = await fetch(providerConfig.baseURL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${providerConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    
    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error('❌ API错误:', apiResponse.status, errorText);
      res.write(`data: ${JSON.stringify({ type: 'error', error: `AI服务调用失败: ${apiResponse.status}` })}\n\n`);
      res.end();
      db.run('DELETE FROM active_requests WHERE id = ?', [requestId]);
      return;
    }
    
    console.log('✅ 开始接收流式响应');
    
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
            // 🔥 添加调试日志
            if (parsed.choices?.[0]?.delta) {
            console.log('📦 Delta内容:', JSON.stringify(parsed.choices[0].delta, null, 2));
            }
            const choice = parsed.choices?.[0];
            
            // 推理模式处理（支持 DeepSeek 和 Qwen）
            const reasoning = choice?.delta?.reasoning_content;
            const content = choice?.delta?.content;

            // 处理思考内容（DeepSeek reasoner 和 Qwen 思考模式）
            if (reasoning) {
              reasoningContent += reasoning;
              res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoning })}\n\n`);
            }

            // 处理正常内容
            if (content) {
              fullContent += content;
              res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
            }
          } catch (e) {
            console.error('⚠️ 解析错误:', e.message);
          }
        }
      }
    }
    
    // ✅ 修复后的代码
// 完整的消息保存逻辑(即使只有思考内容也保存)
if (sessionId) {  // 🔥 关键修复:去掉 fullContent 判断
  console.log('💾 保存消息, Session:', sessionId);
  
  // 1. 保存用户消息
  const lastUserMsg = messages[messages.length - 1];
  if (lastUserMsg && lastUserMsg.role === 'user') {
    const userContent = typeof lastUserMsg.content === 'string' 
      ? lastUserMsg.content 
      : JSON.stringify(lastUserMsg.content);
    
    await new Promise((resolve, reject) => {  // 🔥 改为 await 确保执行完成
      db.run(
        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
        [sessionId, 'user', userContent],
        (err) => {
          if (err) {
            console.error('❌ 保存用户消息失败:', err);
            reject(err);
          } else {
            console.log('✅ 用户消息已保存');
            resolve();
          }
        }
      );
    });
  }
  
  // 2. 保存AI回复(即使content为空也保存,因为可能有reasoning_content)
  const finalContent = fullContent || (reasoningContent ? '(纯思考内容)' : '(生成中断)');  // 🔥 更明确的默认值
  await new Promise((resolve, reject) => {  // 🔥 改为 await
    db.run(
      'INSERT INTO messages (session_id, role, content, reasoning_content) VALUES (?, ?, ?, ?)',
      [sessionId, 'assistant', finalContent, reasoningContent || null],
      (err) => {
        if (err) {
          console.error('❌ 保存AI消息失败:', err);
          reject(err);
        } else {
          console.log('✅ AI回复已保存, Content:', fullContent?.length || 0, 'Reasoning:', reasoningContent?.length || 0);
          resolve();
        }
      }
    );
  });
  
  // 3. 更新会话时间戳
  await new Promise((resolve) => {  // 🔥 改为 await
    db.run(
      'UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', 
      [sessionId],
      (err) => {
        if (err) console.error('❌ 更新会话时间戳失败:', err);
        resolve();
      }
    );
  });
}


    
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
    
  } catch (error) {
    console.error('❌ 聊天错误:', error);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } catch (writeError) {
      console.error('❌ 写入响应错误:', writeError);
    }
  } finally {
    // 清理活跃请求记录
    const requestId = req.headers['x-request-id'];
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
