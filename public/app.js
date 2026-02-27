// ==================== ChatFlow iframe 模式检测 ====================
// 检测是否在 ChatFlow iframe 模式下运行
const isChatFlowIframeMode = new URLSearchParams(window.location.search).get('mode') === 'chatflow';

// 存储从父窗口接收的画布上下文
let chatFlowCanvasContext = '';
let pendingCanvasCallback = null;

// ChatFlow iframe 模式初始化
if (isChatFlowIframeMode) {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('📱 ChatFlow iframe 模式已启用');

    // 隐藏侧边栏（但保留顶部导航）
    // const sidebar = document.getElementById('sidebar');
    // if (sidebar) sidebar.style.display = 'none';

    // 添加 ChatFlow 模式标记
    document.body.classList.add('chatflow-iframe-mode');

    // 监听来自父窗口的消息
    window.addEventListener('message', (e) => {
      // 接收画布数据
      if (e.data.action === 'canvas-data') {
        chatFlowCanvasContext = e.data.canvas || '';
        console.log('📋 收到画布上下文:', chatFlowCanvasContext.substring(0, 100) + '...');

        // 如果有等待的回调，执行它
        if (pendingCanvasCallback) {
          pendingCanvasCallback(chatFlowCanvasContext);
          pendingCanvasCallback = null;
        }
      }
    });

    // 监听文本选择拖拽 - 只允许选中的文本被拖拽
    document.addEventListener('dragstart', (e) => {
      const selection = window.getSelection().toString().trim();
      if (selection && selection.length > 0) {
        // 设置拖拽数据为选中的文本
        e.dataTransfer.setData('text/plain', JSON.stringify({
          type: 'selected-text',
          text: selection,
          source: 'chatflow-iframe'
        }));
        e.dataTransfer.effectAllowed = 'copy';
        console.log('🖱️ 拖拽选中文本:', selection.substring(0, 50) + (selection.length > 50 ? '...' : ''));
      } else {
        // 没有选中文本时阻止拖拽
        e.preventDefault();
      }
    });
  });
}

// 请求画布上下文（用于发送消息前）
function requestCanvasContext(callback) {
  if (!isChatFlowIframeMode || window.parent === window) {
    callback('');
    return;
  }

  pendingCanvasCallback = callback;
  window.parent.postMessage({ action: 'request-canvas' }, '*');

  // 超时处理（500ms 后如果没收到回复，使用空上下文）
  setTimeout(() => {
    if (pendingCanvasCallback) {
      console.warn('⚠️ 画布上下文请求超时');
      pendingCanvasCallback('');
      pendingCanvasCallback = null;
    }
  }, 500);
}


// ==================== 渲染工具函数 (Markdown/KaTeX/Mermaid) ====================
// Robust loading with CDN fallback
window.addEventListener('load', function () {
  if (typeof marked === 'undefined' && !window.marked) {
    console.warn('⚠️ Local marked.js failed to load. Attempting CDN fallback...');
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
    script.onload = function () {
      console.log('✅ Marked.js loaded from CDN');
      if (typeof renderMessages === 'function') {
        console.log('🔄 Re-rendering messages...');
        renderMessages();
      }
    };
    script.onerror = function () {
      console.error('❌ Critical: Marked.js failed to load from both local and CDN');
      // Define a simple fallback
      window.marked = {
        parse: function (text) { return text; }
      };
    };
    document.head.appendChild(script);
  } else {
    console.log('✅ Marked.js loaded successfully (Local)');
  }
});

// 数学公式渲染 - 完整解决方案

// 渲染带数学公式的Markdown文本
// @param {string} text - 要渲染的文本
// @param {boolean} isStreaming - 是否流式模式（流式模式下用占位符替代图片）
function renderMarkdownWithMath(text, isStreaming = false) {
  if (!text) return '';

  // 临时存储公式的映射
  const mathStore = new Map();
  let counter = 0;

  // 1. 保护 $$ ... $$ 块级公式
  let protectedText = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
    const id = `@@MATHBLOCK${counter++}@@`;
    mathStore.set(id, { formula: formula.trim(), display: true });
    return id;
  });

  // 2. 保护 $ ... $ 行内公式
  protectedText = protectedText.replace(/\$([^\$\n]+?)\$/g, (match, formula) => {
    // 跳过看起来像货币的情况（以数字开头并且很短）
    if (/^\d+\.?\d*$/.test(formula.trim())) return match;
    const id = `@@MATHINLINE${counter++}@@`;
    mathStore.set(id, { formula: formula.trim(), display: false });
    return id;
  });

  // 3. Markdown解析
  let html = '';
  if (typeof marked !== 'undefined' && marked.parse) {
    html = marked.parse(protectedText);
  } else {
    html = protectedText;
  }

  // 4. 恢复并渲染数学公式
  if (typeof katex !== 'undefined') {
    mathStore.forEach((data, id) => {
      try {
        const rendered = katex.renderToString(data.formula, {
          displayMode: data.display,
          throwOnError: false,
          errorColor: '#ff6b6b',
          trust: true,
          strict: false
        });
        html = html.replace(new RegExp(id, 'g'), rendered);
      } catch (e) {
        console.warn('KaTeX render error for:', data.formula, e);
        // 渲染失败时显示原始公式（用code标签包裹）
        const fallback = data.display
          ? `<pre class="math-error"><code>${escapeHtml(data.formula)}</code></pre>`
          : `<code class="math-error">${escapeHtml(data.formula)}</code>`;
        html = html.replace(new RegExp(id, 'g'), fallback);
      }
    });
  } else {
    // KaTeX未加载，显示原始公式
    mathStore.forEach((data, id) => {
      const original = data.display ? `$$${data.formula}$$` : `$${data.formula}$`;
      html = html.replace(new RegExp(id, 'g'), `<code>${escapeHtml(original)}</code>`);
    });
  }

  // 5. 图片处理：流式模式使用加载容器，非流式直接显示
  if (isStreaming) {
    // 流式模式：用容器包裹图片，显示加载骨架（事件由updateContent处理）
    html = html.replace(/<img([^>]*)src="([^"]+)"([^>]*)>/g, (match, before, src, after) => {
      // 跳过已处理的图片
      if (match.includes('streaming-image-container')) return match;
      return `<div class="streaming-image-container" data-src="${src}">
            <div class="streaming-image-skeleton"></div>
            <img${before}src="${src}"${after} loading="eager">
          </div>`;
    });
  } else {
    // 非流式模式：直接显示图片，添加错误处理
    html = html.replace(/<img([^>]*)src="([^"]+)"([^>]*)>/g, (match, before, src, after) => {
      return `<img${before}src="${src}"${after} loading="lazy" onerror="this.style.display='none'; this.insertAdjacentHTML('afterend', '<span class=\\'image-error\\'>图片有版权等原因不能加载，见谅 ＞﹏＜ </span>')">`;
    });
  }

  // 6. 🎨 Mermaid 图表处理：检测并转换 mermaid 代码块为渲染容器
  // 🎨 流式模式下跳过转换（使用独立的 mermaidLivePreview 容器实时渲染）
  if (!isStreaming) {
    html = html.replace(
      /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi,
      (match, code) => {
        const id = 'mermaid-' + Math.random().toString(36).substr(2, 9);
        // 解码 HTML 实体
        const decodedCode = code
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();
        return `<div class="mermaid-container" id="${id}" data-mermaid-code="${encodeURIComponent(decodedCode)}"></div>`;
      }
    );
  }

  return html;
}

// HTML转义辅助函数
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 兼容旧代码的空函数
function restoreAndRenderMath(element) {
  // 不再需要，因为renderMarkdownWithMath已经完成了所有工作
}

// 新增：将文本中的 [1] [2] 等转换为可点击的角标
function renderCitations(html, sources) {
  if (!sources || sources.length === 0) return html;

  // 匹配 [1] [2] 等角标格式
  return html.replace(/\[(\d+)\]/g, (match, num) => {
    const index = parseInt(num);
    const source = sources.find(s => s.index === index);
    if (source && source.url) {
      return `<a href="${source.url}" target="_blank" rel="noopener" class="citation-badge" title="${source.title || '来源'}">${num}</a>`;
    }
    return match; // 如果没有对应来源，保持原样
  });
}

// 新增：渲染来源列表
function renderSourcesList(sources, language) {
  if (!sources || sources.length === 0) return '';

  const headerText = language === 'zh-CN' ? '来源' : 'Sources';

  let html = `
        <div class="sources-list">
          <div class="sources-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
            <span>${headerText}</span>
          </div>
      `;

  sources.forEach(source => {
    const domain = source.site_name || (source.url ? new URL(source.url).hostname.replace('www.', '') : '');
    const faviconHtml = source.favicon
      ? `<img class="source-favicon" src="${source.favicon}" alt="" onerror="this.style.display='none'">`
      : `<div class="source-favicon-placeholder"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg></div>`;

    html += `
          <a href="${source.url || '#'}" target="_blank" rel="noopener" class="source-card">
            <span class="source-index">${source.index}</span>
            ${faviconHtml}
            <div class="source-info">
              <div class="source-title">${escapeHtml(source.title || '未知来源')}</div>
              <div class="source-domain">${escapeHtml(domain)}</div>
            </div>
          </a>
        `;
  });

  html += '</div>';
  return html;
}

// ==================== 代码块处理功能 ====================

// 语言名称映射（美化显示）
const languageNames = {
  'js': 'JavaScript',
  'javascript': 'JavaScript',
  'ts': 'TypeScript',
  'typescript': 'TypeScript',
  'py': 'Python',
  'python': 'Python',
  'rb': 'Ruby',
  'ruby': 'Ruby',
  'java': 'Java',
  'c': 'C',
  'cpp': 'C++',
  'c++': 'C++',
  'cs': 'C#',
  'csharp': 'C#',
  'go': 'Go',
  'golang': 'Go',
  'rs': 'Rust',
  'rust': 'Rust',
  'swift': 'Swift',
  'kotlin': 'Kotlin',
  'kt': 'Kotlin',
  'php': 'PHP',
  'html': 'HTML',
  'css': 'CSS',
  'scss': 'SCSS',
  'sass': 'Sass',
  'less': 'Less',
  'json': 'JSON',
  'xml': 'XML',
  'yaml': 'YAML',
  'yml': 'YAML',
  'md': 'Markdown',
  'markdown': 'Markdown',
  'sql': 'SQL',
  'sh': 'Shell',
  'bash': 'Bash',
  'zsh': 'Zsh',
  'powershell': 'PowerShell',
  'ps1': 'PowerShell',
  'dockerfile': 'Dockerfile',
  'docker': 'Docker',
  'nginx': 'Nginx',
  'apache': 'Apache',
  'vim': 'Vim',
  'lua': 'Lua',
  'r': 'R',
  'scala': 'Scala',
  'perl': 'Perl',
  'jsx': 'JSX',
  'tsx': 'TSX',
  'vue': 'Vue',
  'svelte': 'Svelte',
  'graphql': 'GraphQL',
  'gql': 'GraphQL',
  'toml': 'TOML',
  'ini': 'INI',
  'makefile': 'Makefile',
  'cmake': 'CMake',
  'diff': 'Diff',
  'plaintext': '纯文本',
  'text': '纯文本',
  '': '代码'
};

// 获取美化的语言名称
function getLanguageDisplayName(lang) {
  if (!lang) return '代码';
  const normalized = lang.toLowerCase().trim();
  return languageNames[normalized] || lang.toUpperCase();
}

// 处理代码块：添加头部（语言标签+复制按钮）和语法高亮
function processCodeBlocks(container) {
  if (!container) return;

  const codeBlocks = container.querySelectorAll('pre > code:not(.processed)');

  codeBlocks.forEach((codeElement, index) => {
    const preElement = codeElement.parentElement;

    // 跳过已处理的或mermaid代码块
    if (preElement.closest('.code-block-wrapper') || preElement.closest('.mermaid-container')) {
      return;
    }

    // 获取语言类型
    let language = '';
    const classList = codeElement.className.split(' ');
    for (const cls of classList) {
      if (cls.startsWith('language-')) {
        language = cls.replace('language-', '');
        break;
      }
    }

    // 跳过mermaid
    if (language === 'mermaid') return;

    // 标记为已处理
    codeElement.classList.add('processed');

    // 创建包装容器
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    // 创建头部
    const header = document.createElement('div');
    header.className = 'code-block-header';

    // 语言标签
    const langLabel = document.createElement('span');
    langLabel.className = 'code-block-lang';
    langLabel.textContent = getLanguageDisplayName(language);

    // 复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <span>复制</span>
        `;
    copyBtn.onclick = () => copyCodeBlock(copyBtn, codeElement);

    header.appendChild(langLabel);
    header.appendChild(copyBtn);

    // 插入包装容器
    preElement.parentNode.insertBefore(wrapper, preElement);
    wrapper.appendChild(header);
    wrapper.appendChild(preElement);

    // 应用语法高亮
    if (typeof hljs !== 'undefined' && language && language !== 'plaintext') {
      try {
        hljs.highlightElement(codeElement);
      } catch (e) {
        console.warn('Highlight.js error:', e);
      }
    }
  });
}

// 复制代码到剪贴板
function copyCodeBlock(button, codeElement) {
  const code = codeElement.textContent || codeElement.innerText;

  navigator.clipboard.writeText(code).then(() => {
    // 显示成功状态
    const originalHTML = button.innerHTML;
    button.classList.add('copied');
    button.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>已复制</span>
        `;

    // 2秒后恢复原状
    setTimeout(() => {
      button.classList.remove('copied');
      button.innerHTML = originalHTML;
    }, 2000);
  }).catch(err => {
    console.error('复制失败:', err);
    // 回退方案
    const textarea = document.createElement('textarea');
    textarea.value = code;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      button.classList.add('copied');
      const originalHTML = button.innerHTML;
      button.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>已复制</span>
          `;
      setTimeout(() => {
        button.classList.remove('copied');
        button.innerHTML = originalHTML;
      }, 2000);
    } catch (e) {
      console.error('回退复制也失败:', e);
    }
    document.body.removeChild(textarea);
  });
}

// 流式处理代码块：实时显示语言标签、复制按钮、语法高亮
// 此函数针对流式输出优化，避免重复处理和DOM抖动
function processCodeBlocksStreaming(container) {
  if (!container) return;

  const codeBlocks = container.querySelectorAll('pre > code:not(.stream-processed)');

  codeBlocks.forEach((codeElement) => {
    const preElement = codeElement.parentElement;

    // 跳过已处理的或mermaid代码块
    if (preElement.closest('.code-block-wrapper') ||
      preElement.closest('.mermaid-container') ||
      preElement.closest('.mermaid-inline-wrapper')) {
      return;
    }

    // 获取语言类型
    let language = '';
    const classList = codeElement.className.split(' ');
    for (const cls of classList) {
      if (cls.startsWith('language-')) {
        language = cls.replace('language-', '');
        break;
      }
    }

    // 跳过mermaid
    if (language === 'mermaid') return;

    // 标记为流式处理中
    codeElement.classList.add('stream-processed');

    // 创建包装容器
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    // 创建头部
    const header = document.createElement('div');
    header.className = 'code-block-header';

    // 语言标签
    const langLabel = document.createElement('span');
    langLabel.className = 'code-block-lang';
    langLabel.textContent = getLanguageDisplayName(language);

    // 复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <span>复制</span>
        `;
    copyBtn.onclick = () => copyCodeBlock(copyBtn, codeElement);

    header.appendChild(langLabel);
    header.appendChild(copyBtn);

    // 插入包装容器
    preElement.parentNode.insertBefore(wrapper, preElement);
    wrapper.appendChild(header);
    wrapper.appendChild(preElement);

    // 尝试应用语法高亮（流式时可能代码不完整，但会在最终渲染时修正）
    if (typeof hljs !== 'undefined' && language && language !== 'plaintext') {
      try {
        hljs.highlightElement(codeElement);
      } catch (e) {
        // 流式过程中语法高亮失败是正常的，最终渲染会修正
      }
    }
  });
}

// ==================== Mermaid 图表功能 ====================

// Mermaid 初始化配置
function initMermaid() {
  if (typeof mermaid !== 'undefined') {
    const isDark = document.documentElement.dataset.theme !== 'light';
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark ? 'dark' : 'default',
      securityLevel: 'strict',
      fontFamily: 'inherit',
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
      sequence: { useMaxWidth: true, mirrorActors: false },
      gantt: { useMaxWidth: true },
      pie: { useMaxWidth: true },
      mindmap: { useMaxWidth: true },
      c4: { useMaxWidth: true }
    });
    console.log('✅ Mermaid 初始化完成 (主题:', isDark ? 'dark' : 'default', ')');
  } else {
    console.warn('⚠️ Mermaid 库未加载');
  }
}

// 渲染页面中的所有 Mermaid 图表
async function renderMermaidCharts() {
  if (typeof mermaid === 'undefined') {
    console.warn('⚠️ Mermaid 库未加载，跳过图表渲染');
    return;
  }

  const containers = document.querySelectorAll('.mermaid-container:not(.rendered)');
  if (containers.length === 0) return;

  console.log(`🎨 开始渲染 ${containers.length} 个 Mermaid 图表`);

  for (const container of containers) {
    const code = decodeURIComponent(container.dataset.mermaidCode || '');
    if (!code) continue;

    try {
      const { svg } = await mermaid.render(container.id + '-svg', code);
      container.innerHTML = svg;
      container.classList.add('rendered');

      // 添加工具栏
      const toolbar = document.createElement('div');
      toolbar.className = 'mermaid-toolbar';
      toolbar.innerHTML = `
            <button onclick="showMermaidCode('${container.id}')" title="查看代码">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg>
            </button>
            <button onclick="copyMermaidCode('${container.id}')" title="复制代码">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button onclick="downloadMermaidSVG('${container.id}')" title="下载SVG">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button onclick="toggleMermaidFullscreen('${container.id}')" title="全屏查看">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            </button>
          `;
      container.appendChild(toolbar);

      console.log(`✅ 图表渲染成功: ${container.id}`);
    } catch (err) {
      console.error('❌ Mermaid 渲染失败:', err);
      container.innerHTML = `<div class="mermaid-error">
            <span class="mermaid-error-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
              图表渲染失败
            </span>
            <pre>${escapeHtml(err.message || '语法错误')}</pre>
            <details><summary>查看原始代码</summary><pre>${escapeHtml(code)}</pre></details>
          </div>`;
      container.classList.add('render-error');
    }
  }
}

// 复制 Mermaid 代码
function copyMermaidCode(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const code = decodeURIComponent(container.dataset.mermaidCode || '');
  navigator.clipboard.writeText('```mermaid\n' + code + '\n```').then(() => {
    console.log('✅ Mermaid 代码已复制');
  });
}

// 查看 Mermaid 代码（打开全屏并切换到代码视图）
function showMermaidCode(containerId) {
  toggleMermaidFullscreen(containerId);
  // 延迟切换到代码视图，确保模态框已渲染
  setTimeout(() => {
    if (!mermaidFullscreenState.showCode) {
      toggleMermaidCodeView();
    }
  }, 100);
}

// 下载 SVG
function downloadMermaidSVG(containerId) {
  const container = document.getElementById(containerId);
  const svg = container?.querySelector('svg');
  if (!svg) return;

  const svgData = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([svgData], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = 'mermaid-chart.svg';
  a.click();
  URL.revokeObjectURL(url);
}

// ==================== Mermaid 全屏模态框系统 ====================
let mermaidFullscreenState = {
  isOpen: false,
  scale: 1,
  translateX: 0,
  translateY: 0,
  isDragging: false,
  startX: 0,
  startY: 0,
  lastScale: 1,
  lastTranslateX: 0,
  lastTranslateY: 0,
  showCode: false,
  currentCode: '',
  containerId: null
};

// 创建全屏模态框 DOM
function createMermaidFullscreenModal() {
  if (document.getElementById('mermaidFullscreenModal')) return;

  const modal = document.createElement('div');
  modal.id = 'mermaidFullscreenModal';
  modal.className = 'mermaid-fullscreen-modal';
  modal.innerHTML = `
        <div class="mermaid-fullscreen-toolbar">
          <div class="mermaid-fullscreen-toolbar-left">
            <button class="mermaid-fullscreen-btn" id="mermaidViewCodeBtn" title="查看代码">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>
              </svg>
            </button>
            <button class="mermaid-fullscreen-btn" id="mermaidCopyBtn" title="复制代码">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <button class="mermaid-fullscreen-btn" id="mermaidDownloadBtn" title="下载SVG">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
          </div>
          <div class="mermaid-fullscreen-toolbar-center">
            <button class="mermaid-fullscreen-btn" id="mermaidZoomOutBtn" title="缩小">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
            <span class="mermaid-fullscreen-zoom-level" id="mermaidZoomLevel">100%</span>
            <button class="mermaid-fullscreen-btn" id="mermaidZoomInBtn" title="放大">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
            <button class="mermaid-fullscreen-btn" id="mermaidResetBtn" title="重置视图">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
          </div>
          <div class="mermaid-fullscreen-toolbar-right">
            <button class="mermaid-fullscreen-btn" id="mermaidCloseBtn" title="关闭 (Esc)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="mermaid-fullscreen-content" id="mermaidFullscreenContent">
          <div class="mermaid-fullscreen-wrapper" id="mermaidFullscreenWrapper"></div>
          <div class="mermaid-fullscreen-code" id="mermaidFullscreenCode">
            <pre id="mermaidCodeContent"></pre>
          </div>
        </div>
      `;
  document.body.appendChild(modal);

  // 绑定事件
  bindMermaidFullscreenEvents();
}

// 绑定全屏模态框事件
function bindMermaidFullscreenEvents() {
  const modal = document.getElementById('mermaidFullscreenModal');
  const content = document.getElementById('mermaidFullscreenContent');
  const wrapper = document.getElementById('mermaidFullscreenWrapper');

  // 关闭按钮
  document.getElementById('mermaidCloseBtn').onclick = closeMermaidFullscreen;

  // 查看代码
  document.getElementById('mermaidViewCodeBtn').onclick = toggleMermaidCodeView;

  // 复制代码
  document.getElementById('mermaidCopyBtn').onclick = () => {
    navigator.clipboard.writeText('```mermaid\n' + mermaidFullscreenState.currentCode + '\n```');
    console.log('✅ Mermaid 代码已复制');
  };

  // 下载
  document.getElementById('mermaidDownloadBtn').onclick = () => {
    const svg = wrapper.querySelector('svg');
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mermaid-chart.svg';
    a.click();
    URL.revokeObjectURL(url);
  };

  // 缩放按钮
  document.getElementById('mermaidZoomInBtn').onclick = () => zoomMermaid(0.2);
  document.getElementById('mermaidZoomOutBtn').onclick = () => zoomMermaid(-0.2);
  document.getElementById('mermaidResetBtn').onclick = resetMermaidView;

  // 鼠标拖拽
  wrapper.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);

  // 鼠标滚轮缩放（全屏模式下直接滚轮缩放，无需Ctrl）
  // 触摸板双指滑动拖拽（通过 wheel 事件的 deltaX/deltaY 实现）
  content.addEventListener('wheel', (e) => {
    e.preventDefault();

    // 判断是否为缩放操作：Ctrl+滚轮 或 触摸板双指捶合（ctrlKey会自动为true）
    if (e.ctrlKey || e.metaKey) {
      // 缩放
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      zoomMermaid(delta, e.clientX, e.clientY);
    } else {
      // 触摸板双指滑动 或 鼠标滚轮滚动 -> 平移图表
      mermaidFullscreenState.translateX -= e.deltaX;
      mermaidFullscreenState.translateY -= e.deltaY;
      updateMermaidTransform();
    }
  }, { passive: false });

  // 触摸事件
  let touchStartDistance = 0;
  let touchStartScale = 1;
  let touchStartX = 0;
  let touchStartY = 0;

  wrapper.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      // 双指缩放
      touchStartDistance = getTouchDistance(e.touches);
      touchStartScale = mermaidFullscreenState.scale;
    } else if (e.touches.length === 1) {
      // 单指拖拽
      touchStartX = e.touches[0].clientX - mermaidFullscreenState.translateX;
      touchStartY = e.touches[0].clientY - mermaidFullscreenState.translateY;
      wrapper.classList.add('dragging');
    }
  }, { passive: true });

  wrapper.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      // 双指缩放
      e.preventDefault();
      const currentDistance = getTouchDistance(e.touches);
      const scaleDelta = currentDistance / touchStartDistance;
      mermaidFullscreenState.scale = Math.min(5, Math.max(0.2, touchStartScale * scaleDelta));
      updateMermaidTransform();
    } else if (e.touches.length === 1 && wrapper.classList.contains('dragging')) {
      // 单指拖拽
      e.preventDefault();
      mermaidFullscreenState.translateX = e.touches[0].clientX - touchStartX;
      mermaidFullscreenState.translateY = e.touches[0].clientY - touchStartY;
      updateMermaidTransform();
    }
  }, { passive: false });

  wrapper.addEventListener('touchend', () => {
    wrapper.classList.remove('dragging');
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mermaidFullscreenState.isOpen) {
      closeMermaidFullscreen();
    }
  });
}

// 开始拖拽 (鼠标)
function startDrag(e) {
  if (e.button !== 0) return;
  mermaidFullscreenState.isDragging = true;
  mermaidFullscreenState.startX = e.clientX - mermaidFullscreenState.translateX;
  mermaidFullscreenState.startY = e.clientY - mermaidFullscreenState.translateY;
  document.getElementById('mermaidFullscreenWrapper').classList.add('dragging');
}

// 拖拽中
function onDrag(e) {
  if (!mermaidFullscreenState.isDragging) return;
  mermaidFullscreenState.translateX = e.clientX - mermaidFullscreenState.startX;
  mermaidFullscreenState.translateY = e.clientY - mermaidFullscreenState.startY;
  updateMermaidTransform();
}

// 结束拖拽
function endDrag() {
  mermaidFullscreenState.isDragging = false;
  const wrapper = document.getElementById('mermaidFullscreenWrapper');
  if (wrapper) wrapper.classList.remove('dragging');
}

// 计算触摸距离
function getTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

// 缩放
function zoomMermaid(delta, centerX, centerY) {
  const oldScale = mermaidFullscreenState.scale;
  mermaidFullscreenState.scale = Math.min(5, Math.max(0.2, oldScale + delta));

  // 如果提供了中心点，调整位移以围绕中心点缩放
  if (centerX !== undefined && centerY !== undefined) {
    const content = document.getElementById('mermaidFullscreenContent');
    const rect = content.getBoundingClientRect();
    const x = centerX - rect.left - rect.width / 2;
    const y = centerY - rect.top - rect.height / 2;
    const scaleDelta = mermaidFullscreenState.scale - oldScale;
    mermaidFullscreenState.translateX -= x * scaleDelta / oldScale;
    mermaidFullscreenState.translateY -= y * scaleDelta / oldScale;
  }

  updateMermaidTransform();
}

// 重置视图
function resetMermaidView() {
  mermaidFullscreenState.scale = 1;
  mermaidFullscreenState.translateX = 0;
  mermaidFullscreenState.translateY = 0;
  updateMermaidTransform();
}

// 更新变换
function updateMermaidTransform() {
  const wrapper = document.getElementById('mermaidFullscreenWrapper');
  if (!wrapper) return;
  wrapper.style.transform = `translate(${mermaidFullscreenState.translateX}px, ${mermaidFullscreenState.translateY}px) scale(${mermaidFullscreenState.scale})`;
  document.getElementById('mermaidZoomLevel').textContent = Math.round(mermaidFullscreenState.scale * 100) + '%';
}

// 切换代码视图
function toggleMermaidCodeView() {
  mermaidFullscreenState.showCode = !mermaidFullscreenState.showCode;
  const codePanel = document.getElementById('mermaidFullscreenCode');
  const wrapper = document.getElementById('mermaidFullscreenWrapper');
  const btn = document.getElementById('mermaidViewCodeBtn');

  if (mermaidFullscreenState.showCode) {
    codePanel.classList.add('active');
    wrapper.style.display = 'none';
    btn.style.background = 'rgba(255, 255, 255, 0.3)';
  } else {
    codePanel.classList.remove('active');
    wrapper.style.display = '';
    btn.style.background = '';
  }
}

// 打开全屏模态框
function toggleMermaidFullscreen(containerId) {
  createMermaidFullscreenModal();

  const container = document.getElementById(containerId);
  if (!container) return;

  const svg = container.querySelector('svg');
  const code = decodeURIComponent(container.dataset.mermaidCode || '');

  if (!svg) return;

  // 重置状态
  mermaidFullscreenState.scale = 1;
  mermaidFullscreenState.translateX = 0;
  mermaidFullscreenState.translateY = 0;
  mermaidFullscreenState.showCode = false;
  mermaidFullscreenState.currentCode = code;
  mermaidFullscreenState.containerId = containerId;
  mermaidFullscreenState.isOpen = true;

  // 复制 SVG 到全屏模态框
  const wrapper = document.getElementById('mermaidFullscreenWrapper');
  wrapper.innerHTML = svg.outerHTML;
  wrapper.style.display = '';
  wrapper.style.transform = '';

  // 设置代码
  document.getElementById('mermaidCodeContent').textContent = code;
  document.getElementById('mermaidFullscreenCode').classList.remove('active');
  document.getElementById('mermaidViewCodeBtn').style.background = '';
  document.getElementById('mermaidZoomLevel').textContent = '100%';

  // 显示模态框
  const modal = document.getElementById('mermaidFullscreenModal');
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';
}

// 关闭全屏模态框
function closeMermaidFullscreen() {
  const modal = document.getElementById('mermaidFullscreenModal');
  if (modal) {
    modal.classList.remove('active');
    mermaidFullscreenState.isOpen = false;
    document.body.style.overflow = '';
  }
}

// ==================== 流式 Mermaid 渲染 ====================

// 流式过程中渲染完整的 Mermaid 图表
async function renderStreamingMermaidCharts(textDiv, renderedCache) {
  if (typeof mermaid === 'undefined') return;

  const containers = textDiv.querySelectorAll('.mermaid-container:not(.rendered)');

  for (const container of containers) {
    const code = container.dataset.mermaidCode;
    if (!code) continue;

    // 检查缓存中是否已有渲染结果
    if (renderedCache.has(code)) {
      const cached = renderedCache.get(code);
      container.replaceWith(cached.cloneNode(true));
      continue;
    }

    // 检测代码是否完整（以有效的 Mermaid 关键字开头）
    const decodedCode = decodeURIComponent(code).trim();
    const validStarts = ['graph', 'flowchart', 'sequencediagram', 'classdiagram',
      'statediagram', 'erdiagram', 'gantt', 'pie', 'mindmap',
      'journey', 'gitgraph', 'c4', 'timeline', 'quadrantchart', 'xychart', 'block'];
    const codeLower = decodedCode.toLowerCase();
    const isValidStart = validStarts.some(k => codeLower.startsWith(k));

    if (!isValidStart) continue; // 等待更多内容

    // 异步渲染，不阻塞流式输出
    renderSingleMermaidContainer(container, decodedCode, renderedCache);
  }
}

// 渲染单个 Mermaid 容器
async function renderSingleMermaidContainer(container, code, cache) {
  // 如果已经在渲染中或已渲染，跳过
  if (container.classList.contains('rendering') || container.classList.contains('rendered')) {
    return;
  }

  container.classList.add('rendering');

  try {
    const id = container.id + '-svg';
    const { svg } = await mermaid.render(id, code);

    container.innerHTML = svg;
    container.classList.remove('rendering');
    container.classList.add('rendered');

    // 添加工具栏
    addMermaidToolbar(container);

    // 缓存渲染结果
    cache.set(container.dataset.mermaidCode, container.cloneNode(true));

    console.log(`✅ 流式渲染 Mermaid 图表: ${container.id}`);
  } catch (err) {
    container.classList.remove('rendering');
    // 渲染失败则保持loading状态，等待更多内容（可能代码不完整）
    console.debug('⏳ Mermaid 代码可能不完整，等待更多内容...', err.message);
  }
}

// 抽取工具栏添加逻辑为独立函数
function addMermaidToolbar(container) {
  if (container.querySelector('.mermaid-toolbar')) return;

  const toolbar = document.createElement('div');
  toolbar.className = 'mermaid-toolbar';
  toolbar.innerHTML = `
        <button onclick="copyMermaidCode('${container.id}')" title="复制代码">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
        <button onclick="downloadMermaidSVG('${container.id}')" title="下载SVG">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
        <button onclick="toggleMermaidFullscreen('${container.id}')" title="全屏查看">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
          </svg>
        </button>
      `;
  container.appendChild(toolbar);
}

// 监听主题变化，重新初始化 Mermaid
const mermaidThemeObserver = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    if (mutation.attributeName === 'data-theme') {
      initMermaid();
      // 重新渲染所有图表（移除 rendered 标记）
      document.querySelectorAll('.mermaid-container.rendered').forEach(el => {
        el.classList.remove('rendered');
      });
      renderMermaidCharts();
    }
  });
});

// 页面加载完成后初始化 Mermaid
document.addEventListener('DOMContentLoaded', () => {
  initMermaid();
  mermaidThemeObserver.observe(document.documentElement, { attributes: true });
});

// ==================== 主应用逻辑 ====================
// ==================== SVG 图标库定义 ====================
// 所有图标均来自 Material Design Icons
const ICON_PATHS = {
  // 汉堡菜单图标 - 用于移动端侧边栏切换按钮
  'menu': '<path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>',

  // 浅色主题图标 - 用于主题切换按钮（显示太阳）
  'light_mode': '<path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/>',

  // 深色主题图标 - 用于主题切换按钮（显示月亮）
  'dark_mode': '<path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/>',

  // 搜索图标 - 用于侧边栏对话搜索框、欢迎页面搜索动作卡片
  'search': '<path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>',

  // 📤 上传文件图标 - 用于新建对话按钮、新建空间按钮、附件上传按钮
  'add': { viewBox: '0 -960 960 960', content: '<path d="M440-280h80v-168l64 64 56-56-160-160-160 160 56 56 64-64v168ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z"/>' },

  // 文件夹图标 - 用于侧边栏空间分组标题
  'folder': '<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>',

  // 向上箭头图标 - 用于折叠组的收起状态、思考内容展开后的图标
  'expand_less': '<path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/>',

  // 向下箭头图标 - 用于下拉菜单、折叠组的展开状态、思考内容折叠时的图标
  'expand_more': '<path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/>',

  // 对话气泡图标 - 用于侧边栏对话分组标题
  'chat': '<path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>',

  // 设置齿轮图标 - 用于侧边栏用户信息区域的设置按钮
  'settings': '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.58 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>',

  // 编辑/笔图标 - 用于欢迎页面写作动作卡片
  'edit_note': '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',

  // 代码符号图标 - 用于欢迎页面代码动作卡片
  'code': '<path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>',

  // 翻译图标 - 用于欢迎页面翻译动作卡片
  'translate': '<path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/>',

  // 地球/联网图标 - 用于输入框工具栏联网按钮、侧边栏语言切换提示
  'language': '<path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.91-4.33-3.56zm2.95-8H5.08c.96-1.65 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"/>',

  // 齿轮/设置图标💡 灯泡/推理图标 - 用于输入框推理模式按钮、AI消息思考过程标签（已更换为灯泡样式）
  'psychology': { viewBox: '0 -960 960 960', content: '<path d="M240-80v-172q-57-52-88.5-121.5T120-520q0-150 105-255t255-105q125 0 221.5 73.5T827-615l52 205q5 19-7 34.5T840-360h-80v120q0 33-23.5 56.5T680-160h-80v80h-80v-160h160v-200h108l-38-155q-23-91-98-148t-172-57q-116 0-198 81t-82 197q0 60 24.5 114t69.5 96l26 24v208h-80Zm254-360Zm-54 80h80l6-50q8-3 14.5-7t11.5-9l46 20 40-68-40-30q2-8 2-16t-2-16l40-30-40-68-46 20q-5-5-11.5-9t-14.5-7l-6-50h-80l-6 50q-8 3-14.5 7t-11.5 9l-46-20-40 68 40 30q-2 8-2 16t2 16l-40 30 40 68 46-20q5 5 11.5 9t14.5 7l6 50Zm40-100q-25 0-42.5-17.5T420-520q0-25 17.5-42.5T480-580q25 0 42.5 17.5T540-520q0 25-17.5 42.5T480-460Z"/>' },

  // ⬆️ 发送箭头图标（加粗版）- 用于输入框发送按钮
  'arrow_upward': '<path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z" stroke-width="2"/>',

  // 停止方块图标 - 用于停止AI生成按钮
  'stop': '<path d="M6 6h12v12H6z"/>',

  // 关闭/叉号图标 - 用于设置面板关闭按钮、对话删除等
  'close': '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',

  // 🤖 AI机器人图标 - 用于AI消息的头像、模型标签
  'smart_toy': {
    viewBox: '0 0 64 64',
    content: '<circle cx="32" cy="32" r="14" fill="currentColor"/><path d="M 10 42 C 10 35, 54 20, 54 28 C 54 32, 40 40, 32 40" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M 54 28 C 54 36, 10 50, 10 42" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>'
  },

  // 复制图标 - 用于复制AI消息内容按钮
  'content_copy': '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>',

  // 对勾/完成图标 - 用于复制成功后的反馈提示
  'check': '<path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>',

  // 删除/垃圾桶图标 - 用于删除对话、删除空间、删除文档等
  'delete': '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',

  // 编辑/铅笔图标 - 用于编辑消息内容
  'edit': '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',

  // 刷新/重新生成图标 - 用于重新生成AI回复
  'refresh': '<path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>',

  // 引用图标 - 用于引用消息内容
  'format_quote': '<path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/>',


  // ✨ Sparkle/星星闪烁图标 - 用于思考(Chain of Thought)UI的图标
  'sparkles': { viewBox: '0 -960 960 960', content: '<path d="m354-247 126-76 126 77-33-144 111-96-146-13-58-136-58 135-146 13 111 97-33 143ZM233-80l65-281L80-550l288-25 112-265 112 265 288 25-218 189 65 281-247-149L233-80Z"/>' },

  // 🪐 RAI 彩色Logo - 用于侧边栏品牌Logo、AI消息头像、欢迎页面
  'rai_logo_colored': {
    viewBox: '0 0 64 64',
    fill: 'none',
    content: '<defs><linearGradient id="planetGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#f5d547;stop-opacity:1"/><stop offset="100%" style="stop-color:#e6a824;stop-opacity:1"/></linearGradient><linearGradient id="ringGrad" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" style="stop-color:#f9e79f;stop-opacity:1"/><stop offset="100%" style="stop-color:#fef5e7;stop-opacity:1"/></linearGradient></defs><circle cx="32" cy="32" r="14" fill="url(#planetGrad)"/><path d="M 10 42 C 10 35, 54 20, 54 28 C 54 32, 40 40, 32 40" fill="none" stroke="url(#ringGrad)" stroke-width="4" stroke-linecap="round" opacity="0.8"/><path d="M 54 28 C 54 36, 10 50, 10 42" fill="none" stroke="url(#ringGrad)" stroke-width="4" stroke-linecap="round" opacity="0.9"/><circle cx="26" cy="26" r="4" fill="white" opacity="0.2"/>'
  }
};

function getSvgIcon(name, className = '', size = 24) {
  const iconDef = ICON_PATHS[name];
  if (!iconDef) {
    console.warn(`Icon not found: ${name}`);
    return '';
  }

  let content = iconDef;
  let viewBox = '0 0 24 24';
  let fill = 'currentColor';

  if (typeof iconDef === 'object') {
    content = iconDef.content;
    viewBox = iconDef.viewBox || viewBox;
    fill = iconDef.fill || fill;
  }

  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${size}" height="${size}" fill="${fill}">${content}</svg>`;
}

const API_BASE = '/api';

const appState = {
  user: null,
  token: null,
  currentSession: null,
  sessions: [],
  messages: [],
  currentRequestId: null,
  isStreaming: false,
  selectedModel: 'kimi-k2',  // 默认为Kimi K2模型
  thinkingMode: false,  // 默认关闭推理模式
  internetMode: true,  // 默认开启联网
  inputExpanded: false,  // 输入框展开状态
  thinkingBudget: 1024,
  thinkingBudgetOpen: false,
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 2000,
  frequencyPenalty: 0,
  presencePenalty: 0,
  systemPrompt: '',  // 用户的个人偏好，将附加到内置提示词后
  sidebarOpen: false,
  settingsOpen: false,
  touchStartX: 0,
  touchStartY: 0,
  touchMoveX: 0,
  isSwiping: false,
  theme: 'dark',
  language: 'zh-CN',
  lastModelUsed: '',  // 记录最后使用的实际模型
  lastRoutingReason: '',  // 记录路由选择原因
  // RAG相关状态
  spaces: [],  // 用户空间列表
  currentSpaceId: null,  // 当前选中的空间ID
  useRag: false,  // 是否启用RAG
  ragTopK: 3,  // RAG检索数量
  currentScenario: 'balanced',  // 当前场景预设
  // 思考UI状态
  thinkingUIMode: 'collapsed',  // 'collapsed' | 'expanded'
  currentSentenceIndex: 0,
  sentenceRotationTimer: null,
  thinkingLineInterval: null, // 新增：用于实时更新竖线高度的定时器
  thinkingSentences: [],
  currentThinkingMessageId: null,
  // 智能滚动控制
  userScrolledUp: false,  // 用户是否主动向上滚动
  lastScrollTop: 0,  // 上次滚动位置
  // 引用功能状态
  currentQuote: null,  // 当前引用的消息 { role: 'user'|'assistant', content: string }
  // 会话列表分页状态
  sessionsPagination: {
    offset: 0,
    limit: 5,//首次加载历史对话条数
    hasMore: true,
    isLoading: false
  }
};

const MODELS = {
  "auto": {
    name: "最佳 Auto",
    displayName: { "zh-CN": "最佳", "en": "Auto" },
    provider: "auto",
    supportsThinking: true
  },
  'qwen-flash': {
    name: 'Qwen3Flash',
    provider: 'aliyun',
    supportsThinking: true
  },
  'qwen-plus': {
    name: 'Qwen3-Plus',
    provider: 'aliyun',
    supportsThinking: true
  },
  'qwen-max': {
    name: 'Qwen3-Max',
    provider: 'aliyun',
    supportsThinking: true
  },
  'deepseek-v3': {
    name: 'DeepSeekV3.2',
    provider: 'deepseek',
    supportsThinking: true
  },
  'deepseek-v3.2-speciale': {
    name: 'DeepSeekV3.2-Speciale',
    provider: 'deepseek_v3_2_speciale',
    supportsThinking: true,
    thinkingOnly: true,  // 只支持思考模式
    maxTokens: 128000,   // 128K 上下文
    expiresAt: '2025-12-15T23:59:00+08:00'  // 截止时间
  },
  // Kimi K2 - 月之暗面高性能模型
  'kimi-k2': {
    name: 'Kimi K2',
    provider: 'siliconflow',
    supportsThinking: true
  },
  // Qwen3-8B - 硅基流动免费模型 (支持思考、工具调用)
  'qwen3-8b': {
    name: 'Qwen3 8B',
    provider: 'siliconflow',
    supportsThinking: true,
    isFree: true  // 标记为免费模型
  },
  // Qwen3-Omni-Flash 多模态模型 (图片/音频/视频)
  'qwen3-omni-flash': {
    name: 'Qwen3 Omni Flash',
    provider: 'aliyun_omni',
    supportsThinking: false,
    multimodal: true
  },
  // Google Gemini 3 Flash - 最智能的速度优化模型（多模态）
  'gemini-3-flash': {
    name: 'Gemini 3 Flash',
    provider: 'google_gemini',
    supportsThinking: true,
    multimodal: true  // 支持图片/视频等多模态输入
  },
  'lmstudio-local': {
    name: 'LMStudio Local',
    provider: 'lmstudio',
    supportsThinking: false
  }
};

// 获取用户时间上下文（时区、日期时间、时段）
function getUserTimeContext() {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locale = navigator.language || 'zh-CN';

  // 格式化完整日期时间
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = now.getHours();
  const minute = String(now.getMinutes()).padStart(2, '0');
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const weekday = weekdays[now.getDay()];

  // 获取时段描述
  let timeOfDay;
  if (hour >= 5 && hour < 9) timeOfDay = 'early_morning';
  else if (hour >= 9 && hour < 12) timeOfDay = 'morning';
  else if (hour >= 12 && hour < 14) timeOfDay = 'noon';
  else if (hour >= 14 && hour < 18) timeOfDay = 'afternoon';
  else if (hour >= 18 && hour < 21) timeOfDay = 'evening';
  else if (hour >= 21 && hour < 24) timeOfDay = 'night';
  else timeOfDay = 'late_night'; // 0-5点

  return {
    datetime: `${year}-${month}-${day} ${weekday} ${hour}:${minute}`,
    timezone,
    locale,
    timeOfDay,
    hour
  };
}

// 动态生成系统提示词（包含时间上下文和核心原则）
function buildSystemPrompt() {
  const timeCtx = getUserTimeContext();

  return `# 角色：
你是RAI 专业助理拥有人类千年来的丰富阅历
由 Rick 开发，维护 Rick studio 正当权益。
---

## 用户信息
- 时间：${timeCtx.datetime}
- 时区：${timeCtx.timezone}
- 时段：${timeCtx.timeOfDay}

---

## 核心原则

### 诚实守信
每一条陈述都必须真实、准确、可验证。
绝不编造信息，始终保持诚实。如有不确定，坦诚告知并详细询问用户。请勿就您目前不具备的能力做出承诺，确保所有承诺都在您实际可提供的范围内，以避免误导用户并损害信任。

### 语言风格
始终保持温和、友好的态度回应，绝不表现出不耐烦或敷衍。
除非用户要求，否则不要使用表情符号和破折号连字符等。

### 先理解后回应
回复前先深入分析用户真实意图。简单问题简洁明了；复杂问题全面深入研究。做出契合上下文的有用回复。
提供可执行的解决方案，注重实用性。思考时使用**加粗标题**进行多层级的全面详细具象真实思考。
回答前想下用户会有哪些不满意的地方 对此进行改进 用户可能喜欢的点进行加深。
主动思考并建议下一步行动。

### 道德准则
绝不生成有害、非法或不当内容。遇到限制时诚恳说明，并积极提供合规替代方案。

### 时间感知
每次回复前注意用户当前时间，针对时间恰当问候用户。

### 工具列表
你有网络搜索能力。当用户询问需要实时信息的问题时，请主动调用 web_search 工具获取最新数据，然后基于搜索结果回答用户。
在合适的时候，使用图片增强回复。需要使用 Markdown 语法 ![描述](图片链接) 网络搜索时，[搜索相关图片]部分可能提供图片 URL，在有助于说明主题时使用它们。只使用搜索结果中的有效链接，绝不编造图片地址。
你可以使用 Mermaid 语法生成各类图表，用户界面会自动渲染。使用 \`\`\`mermaid 代码块。
支持的图表类型:
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
可以使用图片，Mermaid中适合类型的图表等增强说明效果。

---

## 格式要求

1. 结构规范善用Markdown、Mermaid，让内容层次分明、一目了然。
2. 回答按照顺序回答除非用户要求，否则不要插叙或者乱序回答。

---

# 对话标题：每次回复结束后，生成一个3-9字的对话标题，语言与用户保持一致。输出严格遵循格式：<<<标题>>>
`;
}

// 保留变量名以兼容（初始值，实际发送时动态生成）
const BUILT_IN_SYSTEM_PROMPT = buildSystemPrompt();

// 多语言支持
const i18n = {
  'zh-CN': {
    'login-title': '欢迎回来',
    'login-subtitle': '登录继续使用 RAI',
    'register-title': '创建账号',
    'register-subtitle': '加入 RAI 开始对话',
    'email-label': '邮箱',
    'password-label': '密码',
    'username-label': '用户名 (可选)',
    'password-placeholder': '至少6位字符',
    'username-placeholder': '您的昵称',
    'login-btn': '登录',
    'register-btn': '注册',
    'no-account': '还没有账号?',
    'has-account': '已有账号?',
    'register-link': '立即注册',
    'login-link': '立即登录',
    'search-placeholder': '搜索对话',
    'new-chat': '新对话',
    'sidebar-spaces': '空间',
    'new-space': '新建空间',
    'sidebar-sessions': '对话',
    'settings': '设置',
    'logout': '退出',
    'welcome-title': '询问任何问题:D',
    'welcome-subtitle': '可以帮您写作,翻译,构思\n您专属RAI助理',
    'action-write': '写作',
    'action-search': '搜索',
    'action-code': '代码',
    'action-translate': '翻译',
    'attach': '附件',
    'internet': '联网',
    'reasoning': '推理',
    'thinking-budget': '思考预算',
    'thinking-budget-desc': '控制思考的最大长度',
    'min': '最小',
    'max': '最大',
    'input-placeholder': '输入消息... (Shift+Enter 换行)',
    'input-placeholder-short': '有什么问题?',
    'appearance': '外观',
    'theme-label': '主题',
    'theme-desc': '选择界面主题',
    'dark-theme': '深色',
    'light-theme': '浅色',
    'language-label': '语言',
    'language-desc': '选择界面语言',
    'generation-params': '生成参数',
    'temperature-desc': '控制回复的随机性 (0-2)',
    'topp-desc': '核采样参数 (0-1)',
    'maxtokens-desc': '最大生成长度 (100-8000)',
    'frequency-desc': '频率惩罚 (仅DeepSeek)',
    'presence-desc': '存在惩罚 (仅DeepSeek)',
    'system-prompt-title': '系统提示词',
    'custom-system-prompt': '自定义系统提示词',
    'system-prompt-desc': '设置AI的角色和行为',
    'system-prompt-placeholder': '例如: 我希望获得简洁明了的答案...',
    'cancel': '取消',
    'save-settings': '保存设置',
    // 模型选择相关
    'model-smart': '智能模式',
    'model-fast': '极速模式',
    'model-expert': '专家模式',
    'model-all': '全部模型',
    'select-model': '选择模型',
    // 引用功能
    'quote': '引用',
    'quote-user': '引用用户',
    'quote-ai': '引用AI',
    // 更多菜单
    'internet-search': '联网搜索',
    'reasoning-mode': '推理模式',
    'add-attachment': '添加附件'
  },
  'en': {
    'login-title': 'Welcome Back',
    'login-subtitle': 'Log in to continue using RAI',
    'register-title': 'Create Account',
    'register-subtitle': 'Join RAI to start chatting',
    'email-label': 'Email',
    'password-label': 'Password',
    'username-label': 'Username (optional)',
    'password-placeholder': 'At least 6 characters',
    'username-placeholder': 'Your nickname',
    'login-btn': 'Login',
    'register-btn': 'Register',
    'no-account': "Don't have an account?",
    'has-account': 'Already have an account?',
    'register-link': 'Sign up now',
    'login-link': 'Log in now',
    'search-placeholder': 'Search conversations',
    'new-chat': 'New Chat',
    'sidebar-spaces': 'Spaces',
    'new-space': 'New Space',
    'sidebar-sessions': 'Conversations',
    'settings': 'Settings',
    'logout': 'Logout',
    'welcome-title': 'How can I help you?',
    'welcome-subtitle': 'I can help you write, translate, and brainstorm\nYour personal RAI assistant',
    'action-write': 'Write',
    'action-search': 'Search',
    'action-code': 'Code',
    'action-translate': 'Translate',
    'attach': 'Attach',
    'internet': 'Web',
    'reasoning': 'Reasoning',
    'thinking-budget': 'Thinking Budget',
    'thinking-budget-desc': 'Control max thinking length',
    'min': 'Min',
    'max': 'Max',
    'input-placeholder': 'Type a message... (Shift+Enter for new line)',
    'input-placeholder-short': 'Ask anything...',
    'appearance': 'Appearance',
    'theme-label': 'Theme',
    'theme-desc': 'Choose interface theme',
    'dark-theme': 'Dark',
    'light-theme': 'Light',
    'language-label': 'Language',
    'language-desc': 'Choose interface language',
    'generation-params': 'Generation Parameters',
    'temperature-desc': 'Control response randomness (0-2)',
    'topp-desc': 'Nucleus sampling parameter (0-1)',
    'maxtokens-desc': 'Maximum generation length (100-8000)',
    'frequency-desc': 'Frequency penalty (DeepSeek only)',
    'presence-desc': 'Presence penalty (DeepSeek only)',
    'system-prompt-title': 'System Prompt',
    'custom-system-prompt': 'Custom System Prompt',
    'system-prompt-desc': 'Set AI role and behavior',
    'system-prompt-placeholder': 'e.g., You are a professional programming assistant...',
    'cancel': 'Cancel',
    'save-settings': 'Save Settings',
    // Model selection
    'model-smart': 'Smart Mode',
    'model-fast': 'Fast Mode',
    'model-expert': 'Expert Mode',
    'model-all': 'All Models',
    'select-model': 'Select Model',
    // Quote feature
    'quote': 'Quote',
    'quote-user': 'Quoting User',
    'quote-ai': 'Quoting AI',
    // More menu
    'internet-search': 'Web Search',
    'reasoning-mode': 'Reasoning Mode',
    'add-attachment': 'Add Attachment'
  }
};


// 主题切换
function toggleTheme() {
  const newTheme = appState.theme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
}

function setTheme(theme) {
  appState.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('rai_theme', theme);

  // 更新移动端图标
  const mobileIcon = document.getElementById('mobileThemeIcon');
  if (mobileIcon) {
    const newIconName = theme === 'dark' ? 'light_mode' : 'dark_mode';
    mobileIcon.outerHTML = getSvgIcon(newIconName, 'material-symbols-outlined', 24).replace('<svg', '<svg id="mobileThemeIcon"');
  }

  // 更新PC侧边栏图标
  const sidebarIcon = document.getElementById('sidebarThemeIcon');
  if (sidebarIcon) {
    const newIconName = theme === 'dark' ? 'light_mode' : 'dark_mode';
    sidebarIcon.outerHTML = getSvgIcon(newIconName, 'material-symbols-outlined', 24).replace('<svg', '<svg id="sidebarThemeIcon"');
  }

  // 更新meta theme-color
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.content = theme === 'dark' ? '#0D0D0D' : '#FFFFFF';
  }
}

// 语言切换
function toggleLanguage() {
  const newLang = appState.language === 'zh-CN' ? 'en' : 'zh-CN';
  setLanguage(newLang);
}

function setLanguage(lang) {
  appState.language = lang;
  localStorage.setItem('rai_language', lang);

  // 更新HTML lang属性
  document.documentElement.lang = lang;

  // 更新所有翻译文本
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (i18n[lang] && i18n[lang][key]) {
      el.textContent = i18n[lang][key];
    }
  });

  // 更新placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (i18n[lang] && i18n[lang][key]) {
      el.placeholder = i18n[lang][key];
    }
  });

  // 更新移动端语言按钮文本
  const mobileLangText = document.getElementById('mobileLangText');
  if (mobileLangText) {
    mobileLangText.textContent = lang === 'zh-CN' ? 'EN' : '中';
  }

  // 更新PC侧边栏语言按钮文本
  const sidebarLangText = document.getElementById('sidebarLangText');
  if (sidebarLangText) {
    sidebarLangText.textContent = lang === 'zh-CN' ? 'EN' : '中';
  }

  // 更新登录页面语言按钮文本
  const authLangText = document.getElementById('authLangText');
  if (authLangText) {
    authLangText.textContent = lang === 'zh-CN' ? 'EN' : '中';
  }
}

// 初始化主题和语言
function initThemeAndLanguage() {
  // 加载保存的主题
  const savedTheme = localStorage.getItem('rai_theme') || 'dark';
  setTheme(savedTheme);

  // 加载保存的语言
  const savedLanguage = localStorage.getItem('rai_language') || 'zh-CN';
  setLanguage(savedLanguage);

  // 初始化PC侧边栏按钮状态
  const sidebarThemeIcon = document.getElementById('sidebarThemeIcon');
  if (sidebarThemeIcon) {
    const newIconName = savedTheme === 'dark' ? 'light_mode' : 'dark_mode';
    sidebarThemeIcon.outerHTML = getSvgIcon(newIconName, 'material-symbols-outlined', 24).replace('<svg', '<svg id="sidebarThemeIcon"');
  }

  const sidebarLangText = document.getElementById('sidebarLangText');
  if (sidebarLangText) {
    sidebarLangText.textContent = savedLanguage === 'zh-CN' ? 'EN' : '中';
  }
}

// ==================== 侧边栏分组折叠功能 ====================
function toggleGroup(groupName) {
  const group = document.getElementById(groupName + 'Group');
  const icon = document.getElementById(groupName + 'Toggle');

  if (!group || !icon) return;

  const isCollapsed = group.classList.contains('collapsed');

  if (isCollapsed) {
    group.classList.remove('collapsed');
    icon.classList.remove('collapsed');
  } else {
    group.classList.add('collapsed');
    icon.classList.add('collapsed');
  }
}

// ==================== 搜索对话功能 ====================
function handleSearch(query) {
  const sessionItems = document.querySelectorAll('.session-item');
  const searchQuery = query.toLowerCase().trim();

  sessionItems.forEach(item => {
    const title = item.querySelector('.session-title');
    const preview = item.querySelector('.session-preview');

    if (!title) return;

    const titleText = title.textContent.toLowerCase();
    const previewText = preview ? preview.textContent.toLowerCase() : '';

    if (searchQuery === '' || titleText.includes(searchQuery) || previewText.includes(searchQuery)) {
      item.style.display = '';
    } else {
      item.style.display = 'none';
    }
  });
}

// ==================== 输入框交互（已简化，无展开/收缩动画）====================
// 输入框现在始终展开，不再需要展开/收缩逻辑
function expandInput() {
  // 保留空函数以兼容现有代码调用
  appState.inputExpanded = true;
}

function collapseInput() {
  // 保留空函数以兼容现有代码调用
  // 不再收缩输入框
}

function handleInputContainerClick(event) {
  // 点击输入容器时聚焦输入框
  const target = event.target;

  // 如果点击的是工具栏按钮或下拉菜单，不处理
  if (target.closest('.toolbar-btn') ||
    target.closest('.model-dropdown') ||
    target.closest('.model-selector') ||
    target.closest('.thinking-budget-modal') ||
    target.closest('.send-btn') ||
    target.closest('.stop-btn')) {
    return;
  }

  // 点击容器时，如果输入框未聚焦，强制聚焦
  const input = document.getElementById('messageInput');
  if (input && document.activeElement !== input) {
    input.focus();
  }
}

function handleActionCard(action) {
  const input = document.getElementById('messageInput');
  if (!input) return;

  let text = '';
  switch (action) {
    case 'write':
      text = '帮我写一篇文章：';
      break;
    case 'search':
      text = '搜索：';
      if (!appState.internetMode) toggleInternet();
      break;
    case 'code':
      text = '帮我写代码：';
      break;
    case 'translate':
      text = '翻译：';
      break;
  }

  input.value = text;
  input.focus();
}

function autoResizeInput() {
  const input = document.getElementById('messageInput');
  if (!input) return;

  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// ==================== RAuth SSO 配置 ====================
const RAUTH_URL = 'http://localhost:3011';  // RAuth 统一认证服务地址
const RAUTH_TOKEN_KEY = 'rauth_token';  // SSO token 存储键名
const RAI_TOKEN_KEY = 'rai_token';  // 兼容旧 token

// SSO: 检测从 RAuth 返回的 token 参数
function handleRAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl) {
    console.log('📥 从 RAuth 获取到 token');
    localStorage.setItem(RAUTH_TOKEN_KEY, tokenFromUrl);
    // 清除 URL 中的 token 参数
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState({}, document.title, url.pathname + url.search);
    return tokenFromUrl;
  }
  return null;
}

// SSO: 检测 RAuth 服务是否可用
async function checkRAuthAvailable() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3秒超时
    const response = await fetch(`${RAUTH_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test' }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return true; // 服务可用
  } catch (error) {
    console.warn('⚠️ RAuth 服务不可用:', error.message);
    return false;
  }
}

// SSO: 重定向到 RAuth 登录页面（先检测服务可用性）
async function redirectToRAuth() {
  const isAvailable = await checkRAuthAvailable();
  if (isAvailable) {
    const returnUrl = encodeURIComponent(window.location.href);
    window.location.href = `${RAUTH_URL}?redirect=${returnUrl}`;
  } else {
    // RAuth 不可用，显示本地登录界面
    console.log('⚠️ RAuth 服务不可用，显示本地登录界面');
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('authContainer').classList.add('active');
  }
}

// SSO: 验证 RAuth token
async function verifyRAuthToken(token) {
  try {
    const response = await fetch(`${RAUTH_URL}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await response.json();
    if (data.valid) {
      console.log('✅ RAuth token 验证成功');
      return {
        userId: data.userId,
        email: data.email,
        username: data.username,
        avatarUrl: data.avatarUrl
      };
    }
    return null;
  } catch (error) {
    console.error('❌ RAuth token 验证失败:', error);
    return null;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log('✅ RAI v0.8 初始化 (SSO 已启用)');

  // 绑定输入容器点击和触摸事件（移动端支持）
  const inputContainer = document.getElementById('inputContainer');
  if (inputContainer) {
    inputContainer.addEventListener('click', handleInputContainerClick);
    // 移动端触摸支持
    inputContainer.addEventListener('touchstart', (e) => {
      // 不阻止默认行为，允许后续的focus事件
      handleInputContainerClick(e);
    }, { passive: true });
  }

  // 初始化主题和语言
  initThemeAndLanguage();

  // ==================== SSO 认证流程 ====================
  // 1. 检测 URL 中是否有从 RAuth 返回的 token
  let token = handleRAuthCallback();

  // 2. 如果 URL 中没有 token，检查 localStorage
  if (!token) {
    token = localStorage.getItem(RAUTH_TOKEN_KEY) || localStorage.getItem(RAI_TOKEN_KEY);
  }

  // 3. 如果有 token，验证它
  if (token) {
    appState.token = token;
    // 优先使用 RAuth 验证（如果是 rauth_token）
    if (localStorage.getItem(RAUTH_TOKEN_KEY) || handleRAuthCallback()) {
      const rauthUser = await verifyRAuthToken(token);
      if (rauthUser) {
        appState.user = rauthUser;
        // 同时保存到 rai_token 以兼容后端 API
        localStorage.setItem(RAI_TOKEN_KEY, token);
        showApp();
        await loadUserData();
      } else {
        // RAuth token 无效，重定向到 RAuth 重新登录
        localStorage.removeItem(RAUTH_TOKEN_KEY);
        localStorage.removeItem(RAI_TOKEN_KEY);
        redirectToRAuth();
        return;
      }
    } else {
      // 使用旧的 RAI token 验证
      verifyToken();
    }
  } else {
    // 4. 没有 token，重定向到 RAuth 登录
    console.log('⚠️ 未找到有效 token，重定向到 RAuth 登录');
    redirectToRAuth();
    return;
  }

  loadSettings();
  updateModelControls();
  initSwipeGestures();

  // 初始化智能滚动监听
  initChatScrollListener();

  // 初始化 MD 涟漪效果
  initRippleEffect();

  // 初始化工具栏按钮状态（确保联网按钮默认激活）
  updateToolbarUI();

  // 初始化拖拽上传功能
  initDragAndDrop();

  // 修复：改进model dropdown的点击外关闭逻辑
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('modelDropdown');
    const customSelect = document.getElementById('modelSelectCustom');

    if (dropdown && customSelect) {
      if (!customSelect.contains(e.target) && !dropdown.contains(e.target)) {
        closeModelDropdown();
      }
    }

    // 修复：改进thinking budget modal的点击外关闭逻辑
    const budgetModal = document.getElementById('thinkingBudgetModal');
    const expandBtn = document.getElementById('thinkingExpandBtn');

    if (budgetModal && expandBtn) {
      if (!budgetModal.contains(e.target) && !expandBtn.contains(e.target)) {
        appState.thinkingBudgetOpen = false;
        budgetModal.style.display = 'none';
        const icon = expandBtn.querySelector('.material-symbols-outlined');
        if (icon) {
          icon.textContent = 'expand_less';
        }
      }
    }

    // 输入框不再收缩，此处逻辑已移除
  });
});

// ==================== 自定义模型选择器 ====================
function toggleModelDropdown() {
  const dropdown = document.getElementById('modelDropdown');
  const customSelect = document.getElementById('modelSelectCustom');

  if (!dropdown || !customSelect) {
    console.error('❌ 模型选择器元素未找到');
    return;
  }

  const isOpen = dropdown.classList.contains('open');

  if (isOpen) {
    closeModelDropdown();
  } else {
    dropdown.classList.add('open');
    customSelect.classList.add('open');
  }
}

function closeModelDropdown() {
  const dropdown = document.getElementById('modelDropdown');
  const customSelect = document.getElementById('modelSelectCustom');

  if (dropdown) {
    dropdown.classList.remove('open');
  }

  if (customSelect) {
    customSelect.classList.remove('open');
  }
}

// ==================== 工具栏功能 ====================

// 切换更多菜单显示/隐藏
function toggleMoreMenu() {
  const menu = document.getElementById('moreMenu');
  if (menu) {
    const isOpening = !menu.classList.contains('active');
    menu.classList.toggle('active');

    // 当菜单打开时，同步toggle状态
    if (isOpening) {
      const internetToggle = document.getElementById('internetToggle');
      const thinkingToggle = document.getElementById('thinkingToggle');

      if (internetToggle) {
        internetToggle.classList.toggle('active', appState.internetMode);
      }
      if (thinkingToggle) {
        thinkingToggle.classList.toggle('active', appState.thinkingMode);
      }
    }
  }
}


// 点击外部关闭更多菜单
document.addEventListener('click', function (e) {
  const menu = document.getElementById('moreMenu');
  const moreBtn = document.getElementById('moreBtn');
  if (menu && menu.classList.contains('active')) {
    if (!menu.contains(e.target) && !moreBtn.contains(e.target)) {
      menu.classList.remove('active');
    }
  }
});

// 从菜单切换联网模式
function toggleInternetFromMenu(event) {
  event.stopPropagation(); // 防止关闭菜单
  appState.internetMode = !appState.internetMode;

  // 直接更新toggle UI
  const toggle = document.getElementById('internetToggle');
  if (toggle) {
    toggle.classList.toggle('active', appState.internetMode);
  }

  console.log(`🌐 联网模式: ${appState.internetMode ? '开启' : '关闭'}`);
}

// 从菜单切换推理模式
function toggleThinkingFromMenu(event) {
  event.stopPropagation(); // 防止关闭菜单
  appState.thinkingMode = !appState.thinkingMode;

  // 直接更新toggle UI
  const toggle = document.getElementById('thinkingToggle');
  if (toggle) {
    toggle.classList.toggle('active', appState.thinkingMode);
  }

  console.log(`🧠 推理模式: ${appState.thinkingMode ? '开启' : '关闭'}`);
}


// 从菜单触发文件上传
function handleFileUploadFromMenu() {
  const menu = document.getElementById('moreMenu');
  if (menu) menu.classList.remove('active');
  handleFileUpload();
}

// 原有的切换函数（向后兼容）
function toggleInternet() {
  appState.internetMode = !appState.internetMode;
  updateToolbarUI();
}

function toggleThinking() {
  appState.thinkingMode = !appState.thinkingMode;
  updateToolbarUI();
}

function handleFileUpload() {
  const fileInput = document.getElementById('fileInput');
  if (fileInput) {
    fileInput.click();
  }
}

function handleFileSelected(event) {
  const files = event.target.files;
  if (files && files.length > 0) {
    console.log('文件选择:', files[0].name);
    // 这里可以添加文件上传逻辑
  }
}

function updateToolbarUI() {
  // 更新"更多"菜单中的开关状态
  const internetToggle = document.getElementById('internetToggle');
  const thinkingToggle = document.getElementById('thinkingToggle');

  if (internetToggle) {
    if (appState.internetMode) {
      internetToggle.classList.add('active');
    } else {
      internetToggle.classList.remove('active');
    }
  }

  if (thinkingToggle) {
    if (appState.thinkingMode) {
      thinkingToggle.classList.add('active');
    } else {
      thinkingToggle.classList.remove('active');
    }
  }

  // 向后兼容：也更新旧的独立按钮（如果存在）
  const internetBtn = document.getElementById('internetBtn');
  const thinkingBtn = document.getElementById('thinkingBtn');

  if (internetBtn) {
    if (appState.internetMode) {
      internetBtn.classList.add('active');
    } else {
      internetBtn.classList.remove('active');
    }
  }

  if (thinkingBtn) {
    if (appState.thinkingMode) {
      thinkingBtn.classList.add('active');
    } else {
      thinkingBtn.classList.remove('active');
    }
  }
}


function updateModelControls() {
  // 根据选择的模型显示/隐藏推理控件
  const thinkingControls = document.getElementById('thinkingControls');
  const selectedModel = appState.selectedModel;

  if (thinkingControls) {
    // DeepSeek模型和Kimi K2模型支持推理模式
    if (selectedModel === 'deepseek-v3' || selectedModel === 'deepseek-v3.2-speciale' ||
      selectedModel === 'kimi-k2') {
      thinkingControls.style.display = 'flex';

      // DeepSeek-V3.2-Speciale 强制开启思考模式(只支持思考模式)
      if (selectedModel === 'deepseek-v3.2-speciale') {
        appState.thinkingMode = true;  // 强制开启
      }
    } else {
      thinkingControls.style.display = 'none';
    }
  }

  // 更新工具栏UI状态
  updateToolbarUI();
}

// 修复：改进toggleThinkingBudget函数
function toggleThinkingBudget() {
  appState.thinkingBudgetOpen = !appState.thinkingBudgetOpen;

  const modal = document.getElementById('thinkingBudgetModal');
  const expandBtn = document.getElementById('thinkingExpandBtn');

  if (!modal || !expandBtn) {
    console.warn('⚠️ 思考预算模态框元素未找到');
    return;
  }

  const icon = expandBtn.querySelector('.material-symbols-outlined');

  if (appState.thinkingBudgetOpen) {
    modal.style.display = 'block';
    if (icon) icon.outerHTML = getSvgIcon('expand_more', 'material-symbols-outlined', 24);
  } else {
    modal.style.display = 'none';
    if (icon) icon.outerHTML = getSvgIcon('expand_less', 'material-symbols-outlined', 24);
  }
}

// 修复：改进updateThinkingBudget函数
function updateThinkingBudget(value) {
  const numValue = parseInt(value);
  if (!isNaN(numValue)) {
    appState.thinkingBudget = numValue;

    const valueEl = document.getElementById('thinkingBudgetValue');
    if (valueEl) {
      valueEl.textContent = `${value} tokens`;
    }
  }
}

// 修复：改进updateToolbarUI函数
function updateToolbarUI() {
  const thinkingBtn = document.getElementById('thinkingBtn');
  const internetBtn = document.getElementById('internetBtn');

  if (thinkingBtn) {
    if (appState.thinkingMode) {
      thinkingBtn.classList.add('active');
    } else {
      thinkingBtn.classList.remove('active');
    }
  }

  if (internetBtn) {
    if (appState.internetMode) {
      internetBtn.classList.add('active');
    } else {
      internetBtn.classList.remove('active');
    }
  }
}

// 修复：改进updateSliderValue函数
function updateSliderValue(name, value) {
  const spanMap = {
    'temperature': 'temperatureValue',
    'topP': 'topPValue',
    'maxTokens': 'maxTokensValue',
    'frequency': 'frequencyValue',
    'presence': 'presenceValue'
  };

  const spanId = spanMap[name];
  if (spanId) {
    const element = document.getElementById(spanId);
    if (element) {
      element.textContent = value;
    }
  }
}

// 修复：改进updateSettingsUI函数，添加null检查
function updateSettingsUI() {
  const elements = [
    { id: 'temperatureSlider', valueId: 'temperatureValue', value: appState.temperature, format: 1 },
    { id: 'topPSlider', valueId: 'topPValue', value: appState.topP, format: 2 },
    { id: 'maxTokensSlider', valueId: 'maxTokensValue', value: appState.maxTokens, format: 0 },
    { id: 'frequencySlider', valueId: 'frequencyValue', value: appState.frequencyPenalty, format: 1 },
    { id: 'presenceSlider', valueId: 'presenceValue', value: appState.presencePenalty, format: 1 }
  ];

  elements.forEach(({ id, valueId, value, format }) => {
    const slider = document.getElementById(id);
    const valueEl = document.getElementById(valueId);

    if (slider) slider.value = value;
    if (valueEl) {
      valueEl.textContent = format === 0 ? value : value.toFixed(format);
    }
  });

  const systemPromptEl = document.getElementById('systemPrompt');
  if (systemPromptEl) {
    systemPromptEl.value = appState.systemPrompt;
  }
}

// 修复：改进updateModelControls函数，添加null检查
function updateModelControls() {
  const model = MODELS[appState.selectedModel];

  if (!model) {
    console.warn(`⚠️ 未找到模型配置: ${appState.selectedModel}`);
    return;
  }

  const thinkingControls = document.getElementById('thinkingControls');
  const thinkingExpandBtn = document.getElementById('thinkingExpandBtn');

  if (thinkingControls) {
    if (model.supportsThinking) {
      thinkingControls.style.display = 'flex';
    } else {
      thinkingControls.style.display = 'none';
      appState.thinkingMode = false;
      appState.thinkingBudgetOpen = false;
    }
  }

  if (thinkingExpandBtn) {
    if (appState.thinkingMode) {
      thinkingExpandBtn.style.display = 'flex';
    } else {
      thinkingExpandBtn.style.display = 'none';
      appState.thinkingBudgetOpen = false;
      const budgetModal = document.getElementById('thinkingBudgetModal');
      if (budgetModal) {
        budgetModal.style.display = 'none';
      }
    }
  }

  updateToolbarUI();
}

// 修复：改进toggleThinking函数
function toggleThinking() {
  const model = MODELS[appState.selectedModel];

  if (!model || !model.supportsThinking) {
    console.warn('⚠️ 当前模型不支持思考模式');
    return;
  }

  appState.thinkingMode = !appState.thinkingMode;
  updateModelControls();
  updateToolbarUI();
}

// 修复：改进toggleInternet函数
function toggleInternet() {
  appState.internetMode = !appState.internetMode;
  updateToolbarUI();
}

// ==================== 新版思考UI函数 ====================

// 解析思考内容，提取以"-"开头的第一句作为预览
function parseThinkingPreview(rawContent) {
  if (!rawContent) return '';

  // 匹配以 "- " 开头的行，取第一个
  const lines = rawContent.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      // 移除开头的 "- "，返回第一句
      const sentence = trimmed.substring(2).trim();
      if (sentence) {
        // 限制预览长度
        return sentence.length > 40 ? sentence.substring(0, 40) + '...' : sentence;
      }
    }
  }

  // ✅ 修复：如果没有"-"格式，尝试提取第一句有意义的文本
  const firstMeaningful = rawContent.trim().split(/[\n.!?。！？]/)[0]?.trim();
  if (firstMeaningful && firstMeaningful.length > 5) {
    return firstMeaningful.length > 40 ? firstMeaningful.substring(0, 40) + '...' : firstMeaningful;
  }

  // ✅ 修复：返回默认文本而不是空字符串
  return appState.language === 'zh-CN' ? 'AI 正在分析内容...' : 'AI is analyzing...';
}

// 更新预览文本
function updateThinkingPreview(previewText) {
  const previewEl = document.getElementById('thinkingPreviewText');
  const previewContainer = document.getElementById('thinkingPreview');

  if (previewEl && previewText) {
    previewEl.textContent = previewText;
    if (previewContainer) previewContainer.style.display = 'inline-flex';
  } else if (previewContainer && !previewText) {
    // ✅ 修复：如果没有预览文本，隐藏容器避免显示空条
    previewContainer.style.display = 'none';
  }
}

// 切换思考UI模式（简洁/展开）
function toggleThinkingUIMode(thinkingId) {
  const thinkingContent = document.getElementById(thinkingId);
  const toggleBtn = document.getElementById('thinkingToggleBtn');
  const previewContainer = document.getElementById('thinkingPreview');
  const thinkingLine = document.getElementById('thinkingLine');

  if (!thinkingContent) return;

  const isExpanding = !thinkingContent.classList.contains('expanded');

  if (isExpanding) {
    // 切换到展开模式
    appState.thinkingUIMode = 'expanded';
    thinkingContent.classList.add('expanded');

    // 隐藏预览
    if (previewContainer) previewContainer.style.display = 'none';

    // 更新按钮：显示"收起思路"和向上箭头
    if (toggleBtn) {
      toggleBtn.classList.add('expanded');
      toggleBtn.classList.remove('icon-only');
      toggleBtn.innerHTML = `
            <span class="toggle-text">${appState.language === 'zh-CN' ? '收起思路' : 'Hide'}</span>
            ${getSvgIcon('expand_less', 'toggle-icon', 16)}
          `;
    }

    // 显示竖线并更新高度
    if (thinkingLine) {
      thinkingLine.classList.add('visible');
    }
    updateThinkingLine(thinkingId);

    // 启动实时更新定时器 (0.1s刷新一次)
    if (appState.thinkingLineInterval) clearInterval(appState.thinkingLineInterval);
    appState.thinkingLineInterval = setInterval(() => updateThinkingLine(thinkingId), 100);
  } else {
    // 切换到简洁模式
    appState.thinkingUIMode = 'collapsed';
    thinkingContent.classList.remove('expanded');

    // 显示预览
    if (previewContainer) previewContainer.style.display = 'inline-flex';

    // 更新按钮：只显示向下箭头
    if (toggleBtn) {
      toggleBtn.classList.remove('expanded');
      toggleBtn.classList.add('icon-only');
      toggleBtn.innerHTML = `${getSvgIcon('expand_more', 'toggle-icon', 16)}`;
    }

    // 停止实时更新定时器
    if (appState.thinkingLineInterval) {
      clearInterval(appState.thinkingLineInterval);
      appState.thinkingLineInterval = null;
    }

    // 隐藏竖线
    if (thinkingLine) {
      thinkingLine.classList.remove('visible');
      thinkingLine.style.height = '0px';
    }
  }
}

// 更新竖线长度 - 直接操作thinking-line元素
function updateThinkingLine(thinkingId) {
  const thinkingContent = document.getElementById(thinkingId);
  const thinkingLine = document.getElementById('thinkingLine');

  if (!thinkingContent || !thinkingLine) return;

  // 简洁模式或收起状态，完全隐藏竖线
  if (appState.thinkingUIMode !== 'expanded' || !thinkingContent.classList.contains('expanded')) {
    thinkingLine.style.height = '0px';
    thinkingLine.classList.remove('visible');
    return;
  }

  // 展开模式：计算实际内容高度并设置竖线高度
  const updateHeight = () => {
    if (thinkingContent.classList.contains('expanded')) {
      const contentHeight = thinkingContent.scrollHeight;
      // 竖线高度 = 内容高度 + 一些额外空间
      thinkingLine.style.height = `${contentHeight + 8}px`;
      thinkingLine.classList.add('visible');
    }
  };

  // 立即更新一次
  updateHeight();

  // 延迟再更新一次，确保动态内容也被计算
  setTimeout(updateHeight, 300);
}

// 开始思考动画
function startThinkingAnimation(avatarElement, thinkingId, previewText) {
  if (!avatarElement) return;

  // 添加光晕动画，随机周期
  const glowDuration = 1.2 + Math.random() * 0.3; // 1.2-1.5s
  avatarElement.style.animationDuration = `${glowDuration}s`;
  avatarElement.classList.add('thinking');

  // 更新预览文本
  if (previewText) {
    updateThinkingPreview(previewText);
  }

  // 如果是展开模式，更新竖线
  if (appState.thinkingUIMode === 'expanded') {
    updateThinkingLine(thinkingId);
  }
}

// 停止思考动画
function stopThinkingAnimation(avatarElement, thinkingId) {
  if (!avatarElement) return;

  avatarElement.classList.remove('thinking');

  // 停止实时更新定时器
  if (appState.thinkingLineInterval) {
    clearInterval(appState.thinkingLineInterval);
    appState.thinkingLineInterval = null;
  }

  // 更新按钮文本为"展开思路"
  const toggleBtn = document.getElementById('thinkingToggleBtn');
  const previewContainer = document.getElementById('thinkingPreview');

  if (appState.thinkingUIMode === 'collapsed') {
    // 简洁模式：显示预览和展开按钮
    if (toggleBtn) {
      toggleBtn.classList.remove('expanded');
      toggleBtn.classList.add('icon-only');
      toggleBtn.innerHTML = `${getSvgIcon('expand_more', 'toggle-icon', 16)}`;
    }
    if (previewContainer) previewContainer.style.display = 'inline-flex';
  }
}


// 历史消息的思考UI切换（使用动态ID）
function toggleHistoryThinkingUI(thinkingId) {
  const thinkingContent = document.getElementById(thinkingId);
  const toggleBtn = document.getElementById(`${thinkingId}-btn`);
  const previewContainer = document.getElementById(`${thinkingId}-preview`);
  const thinkingLine = document.getElementById(`${thinkingId}-line`);

  if (!thinkingContent) return;

  const isExpanding = !thinkingContent.classList.contains('expanded');

  if (isExpanding) {
    // 展开模式
    thinkingContent.classList.add('expanded');

    // 隐藏预览
    if (previewContainer) previewContainer.style.display = 'none';

    // 更新按钮
    if (toggleBtn) {
      toggleBtn.classList.add('expanded');
      toggleBtn.classList.remove('icon-only');
      toggleBtn.innerHTML = `
            <span class="toggle-text">${appState.language === 'zh-CN' ? '收起思路' : 'Hide'}</span>
            ${getSvgIcon('expand_less', 'toggle-icon', 16)}
          `;
    }

    // 显示竖线
    if (thinkingLine) {
      const contentHeight = thinkingContent.scrollHeight;
      thinkingLine.style.height = `${contentHeight + 8}px`;
      thinkingLine.classList.add('visible');
    }
  } else {
    // 收起模式
    thinkingContent.classList.remove('expanded');

    // 显示预览
    if (previewContainer) previewContainer.style.display = 'inline-flex';

    // 更新按钮
    if (toggleBtn) {
      toggleBtn.classList.remove('expanded');
      toggleBtn.classList.add('icon-only');
      toggleBtn.innerHTML = `${getSvgIcon('expand_more', 'toggle-icon', 16)}`;
    }

    // 隐藏竖线
    if (thinkingLine) {
      thinkingLine.classList.remove('visible');
      thinkingLine.style.height = '0px';
    }
  }
}

// ==================== 模型选择下拉菜单函数 ====================
function openModelModal() {
  const menu = document.getElementById('modelDropdownMenu');
  if (menu) {
    menu.classList.toggle('active');
    if (menu.classList.contains('active')) {
      updateMenuSelection();
    }
  }
}

function closeModelModal() {
  const menu = document.getElementById('modelDropdownMenu');
  if (menu && menu.classList.contains('active')) {
    // 移除active，添加closing触发关闭动画
    menu.classList.remove('active');
    menu.classList.add('closing');

    // 动画结束后移除closing类
    menu.addEventListener('animationend', function handler() {
      menu.classList.remove('closing');
      menu.removeEventListener('animationend', handler);
    }, { once: true });
  }
}

function toggleAllModels() {
  const section = document.getElementById('allModelsSection');
  const toggleItem = document.querySelector('[data-toggle="all-models"]');

  if (section && toggleItem) {
    if (section.style.display === 'none') {
      section.style.display = 'block';
      toggleItem.classList.add('expanded');
    } else {
      section.style.display = 'none';
      toggleItem.classList.remove('expanded');
    }
  }
}

function updateMenuSelection() {
  const items = document.querySelectorAll('.model-menu-item');
  items.forEach(item => {
    const modelValue = item.getAttribute('data-model');
    if (modelValue === appState.selectedModel) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
  });
}

function selectModelFromMenu(model, displayName, i18nKey) {
  appState.selectedModel = model;
  const selectedText = document.getElementById('selectedModelText');
  if (selectedText) {
    // 如果有i18n键，使用当前语言的翻译；否则使用传入的displayName
    if (i18nKey && i18n[appState.language] && i18n[appState.language][i18nKey]) {
      selectedText.textContent = i18n[appState.language][i18nKey];
      selectedText.setAttribute('data-i18n', i18nKey);
    } else {
      selectedText.textContent = displayName;
      selectedText.removeAttribute('data-i18n');
    }
  }

  updateModelControls();
  closeModelModal();

  console.log(`✅ 已切换模型: ${model} (${displayName})`);
}

// 点击页面其他地方关闭下拉菜单
document.addEventListener('click', (e) => {
  const menu = document.getElementById('modelDropdownMenu');
  const selector = document.getElementById('modelSelectCustom');

  if (menu && selector) {
    if (!menu.contains(e.target) && !selector.contains(e.target)) {
      closeModelModal();
    }
  }
});

// ==================== 设置相关 ====================
function toggleAdvancedOptions() {
  const content = document.getElementById('advancedOptionsContent');
  const header = document.querySelector('.advanced-options-header');

  if (content && header) {
    content.classList.toggle('expanded');
    header.classList.toggle('expanded');
  }
}

// 修复：改进openSettings函数
function openSettings() {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    settingsModal.classList.add('active');
    appState.settingsOpen = true;
    updateSettingsUI();
  }
}

// 修复：改进closeSettings函数
function closeSettings() {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    settingsModal.classList.remove('active');
    appState.settingsOpen = false;
  }
}

// 点击空白处关闭设置
document.addEventListener('click', (e) => {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal && e.target === settingsModal) {
    closeSettings();
  }
});

// 移动端键盘适配 - 最简单保守方案
// 只处理iOS的滚动问题，让Android使用默认行为
if (window.visualViewport) {
  window.visualViewport.addEventListener('scroll', () => {
    // 防止iOS橡皮筋效果
    window.scrollTo(0, 0);
  });
}

function scrollToBottom() {
  const chatContainer = document.querySelector('.chat-container');
  if (chatContainer) {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }
}

// 修复：改进saveSettings函数，添加null检查
function saveSettings() {
  const temperatureSlider = document.getElementById('temperatureSlider');
  const topPSlider = document.getElementById('topPSlider');
  const maxTokensSlider = document.getElementById('maxTokensSlider');
  const frequencySlider = document.getElementById('frequencySlider');
  const presenceSlider = document.getElementById('presenceSlider');
  const systemPromptEl = document.getElementById('systemPrompt');

  if (!temperatureSlider || !topPSlider || !maxTokensSlider) {
    console.error('❌ 设置表单元素未找到');
    return;
  }

  const temperature = parseFloat(temperatureSlider.value);
  const topP = parseFloat(topPSlider.value);
  const maxTokens = parseInt(maxTokensSlider.value, 10);
  const frequencyPenalty = parseFloat(frequencySlider?.value || 0);
  const presencePenalty = parseFloat(presenceSlider?.value || 0);
  // ✅ 修复：确保systemPrompt正确读取和处理，处理空字符串和null
  const systemPrompt = (systemPromptEl?.value || '').trim();

  if (isNaN(temperature) || isNaN(topP) || isNaN(maxTokens)) {
    console.error('❌ 参数值无效');
    return;
  }

  appState.temperature = temperature;
  appState.topP = topP;
  appState.maxTokens = maxTokens;
  appState.frequencyPenalty = frequencyPenalty;
  appState.presencePenalty = presencePenalty;
  appState.systemPrompt = systemPrompt;  // ✅ 保存trimmed版本

  const settings = {
    temperature,
    topP,
    maxTokens,
    frequencyPenalty,
    presencePenalty,
    systemPrompt
  };
  localStorage.setItem('rai_settings', JSON.stringify(settings));

  // ✅ 修复：同步保存到后端数据库
  if (appState.token) {
    console.log(`📤 正在将设置同步到云端...`);
    console.log(`   系统提示词长度: ${systemPrompt.length}字符`);

    fetch(`${API_BASE}/user/config`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        theme: appState.theme,
        default_model: appState.selectedModel,
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        frequency_penalty: frequencyPenalty,
        presence_penalty: presencePenalty,
        system_prompt: systemPrompt,  // ✅ 确保发送正确的值
        thinking_mode: appState.thinkingMode ? 1 : 0,
        internet_mode: appState.internetMode ? 1 : 0
      })
    })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          console.log('✅ 云端配置已同步');
        } else {
          console.warn('⚠️ 云端同步失败:', data.error);
        }
      })
      .catch(err => console.error('❌ 保存配置网络错误:', err));
  }

  console.log('✅ 设置已保存本地并同步云端');

  closeSettings();
}

// 修复事件处理器中inline onclick处理和事件委托问题，避免undefined引用

// 修复：改进renderMessages，防止事件处理中的undefined错误
function renderMessages() {
  const container = document.getElementById('messagesList');
  const welcome = document.getElementById('welcomeScreen');

  if (!container || !welcome) {
    console.error('❌ 消息容器或欢迎屏幕未找到');
    return;
  }

  if (appState.messages.length === 0) {
    showWelcome();
    return;
  }

  welcome.classList.add('hidden');
  welcome.style.display = 'none';
  container.style.display = 'block';
  container.innerHTML = '';

  appState.messages.forEach(msg => {
    const messageDiv = createMessageElement(msg);
    if (messageDiv) {
      container.appendChild(messageDiv);
    }
  });

  // 完整渲染时强制滚动到底部并重置状态
  appState.userScrolledUp = false;
  scrollToBottom(true);

  // 🎨 渲染 Mermaid 图表
  setTimeout(() => renderMermaidCharts(), 100);

  // 💻 处理代码块：添加语言标签、复制按钮、语法高亮
  setTimeout(() => processCodeBlocks(container), 50);

  // 📍 更新对话索引导航器
  setTimeout(() => renderChatIndexTimeline(), 150);
}

// 修复：改进createMessageElement，添加安全的事件处理
function createMessageElement(message) {
  if (!message || !message.role) {
    console.warn('⚠️ 无效的消息对象');
    return null;
  }

  const div = document.createElement('div');
  div.className = `message ${message.role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';

  if (message.role === 'user') {
    const name = appState.user?.username || appState.user?.email || 'U';
    avatar.textContent = name ? name[0].toUpperCase() : 'U';
  } else {
    avatar.innerHTML = getSvgIcon('rai_logo_colored', 'material-symbols-outlined ai-avatar', 24);
  }
  div.appendChild(avatar);

  const content = document.createElement('div');
  content.className = 'message-content';

  // 判断是否需要显示时间轴（有reasoning_content或internet_mode）
  const hasReasoning = message.reasoning_content && message.reasoning_content !== 'null' && message.reasoning_content.trim() !== '';
  const hasInternet = message.internet_mode || (message.sources && message.sources !== 'null');

  if (message.role === 'assistant' && (hasReasoning || hasInternet)) {
    const timelineDiv = document.createElement('div');
    timelineDiv.className = 'thinking-timeline';
    const thinkingId = `thinking-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // 解析sources获取搜索信息
    let sources = [];
    if (message.sources && message.sources !== 'null') {
      try {
        sources = typeof message.sources === 'string' ? JSON.parse(message.sources) : message.sources;
      } catch (e) { sources = []; }
    }

    // 工具决策详情文本
    const toolDetail = hasInternet && sources.length > 0
      ? (appState.language === 'zh-CN' ? `联网搜索 → ${sources.length}条来源` : `Web search → ${sources.length} sources`)
      : (appState.language === 'zh-CN' ? '已完成' : 'Completed');

    // 构建时间轴HTML
    let timelineHtml = `
          <!-- 步骤1: 分析问题 - 已完成 -->
          <div class="thinking-step" data-status="done">
            <div class="thinking-step-node"></div>
            <div class="thinking-step-content">
              <div class="thinking-step-title">${appState.language === 'zh-CN' ? 'RAI分析' : 'RAI Analysis'}</div>
              <div class="thinking-step-detail">${toolDetail}</div>
            </div>
          </div>
          
          <!-- 步骤2: 生成回答 - 已完成 -->
          <div class="thinking-step" data-status="done">
            <div class="thinking-step-node"></div>
            <div class="thinking-step-content">
              <div class="thinking-step-title">${appState.language === 'zh-CN' ? '生成回答' : 'Generating Response'}</div>
              <div class="thinking-step-detail">${appState.language === 'zh-CN' ? '已完成' : 'Completed'}</div>
            </div>
          </div>
        `;

    // 如果有深度思考内容，添加步骤3
    if (hasReasoning) {
      timelineHtml += `
            <!-- 步骤3: 深度思考 - 已完成，可展开 -->
            <div class="thinking-step" data-status="done">
              <div class="thinking-step-node"></div>
              <div class="thinking-step-content">
                <button class="deep-thinking-toggle" id="${thinkingId}-toggle">
                  <span>${appState.language === 'zh-CN' ? '深度思考' : 'Deep Thinking'}</span>
                  <span class="toggle-icon">▼</span>
                </button>
                <div class="deep-thinking-content" id="${thinkingId}-content"></div>
              </div>
            </div>
          `;
    }

    timelineDiv.innerHTML = timelineHtml;

    // 填充深度思考内容
    if (hasReasoning) {
      const deepContent = timelineDiv.querySelector(`#${thinkingId}-content`);
      const formattedText = message.reasoning_content.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      if (deepContent) {
        deepContent.innerHTML = `<span class="thinking-sentence">${formattedText}</span>`;
      }

      // 添加展开/收起事件监听
      setTimeout(() => {
        const toggleBtn = document.getElementById(`${thinkingId}-toggle`);
        if (toggleBtn) {
          toggleBtn.addEventListener('click', function () {
            const contentEl = document.getElementById(`${thinkingId}-content`);
            const isExpanded = contentEl.classList.contains('expanded');
            if (isExpanded) {
              contentEl.classList.remove('expanded');
              this.classList.remove('expanded');
            } else {
              contentEl.classList.add('expanded');
              this.classList.add('expanded');
            }
          });
        }
      }, 0);
    }

    content.appendChild(timelineDiv);
  }

  // 为用户消息添加附件预览（在文本之前显示）
  // 支持懒加载：如果只有 has_attachments 标记但没有实际附件数据，显示占位符
  if (message.role === 'user' && (message.attachments || message.has_attachments)) {
    let attachments = message.attachments;
    // 如果是字符串，尝试解析JSON
    if (typeof attachments === 'string') {
      try {
        attachments = JSON.parse(attachments);
      } catch (e) {
        attachments = [];
      }
    }

    // 懒加载模式：有标记但没有实际数据
    const needsLazyLoad = message.has_attachments && (!attachments || attachments.length === 0);

    if (needsLazyLoad) {
      // 显示懒加载占位符
      const lazyDiv = document.createElement('div');
      lazyDiv.className = 'message-attachments lazy-attachments';
      lazyDiv.dataset.messageId = message.id;
      lazyDiv.innerHTML = `
            <div class="lazy-attachment-placeholder" onclick="loadMessageAttachments(${message.id}, this.parentElement)">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <path d="M21 15l-5-5L5 21"/>
              </svg>
              <span>${appState.language === 'zh-CN' ? '点击加载附件' : 'Click to load attachments'}</span>
            </div>
          `;
      content.appendChild(lazyDiv);
    } else if (Array.isArray(attachments) && attachments.length > 0) {
      const attachmentsDiv = document.createElement('div');
      attachmentsDiv.className = 'message-attachments';

      attachments.forEach(att => {
        if (!att || !att.type) return;

        const itemDiv = document.createElement('div');

        if (att.type === 'image') {
          itemDiv.className = 'message-attachment-item image-attachment';
          if (att.data) {
            const img = document.createElement('img');
            img.src = att.data;
            img.alt = att.fileName || '图片';
            img.loading = 'lazy';
            // 点击查看大图
            img.onclick = () => {
              window.open(att.data, '_blank');
            };
            itemDiv.appendChild(img);
          } else {
            itemDiv.innerHTML = `<div style="padding: 20px; text-align: center;">🖼️</div>`;
          }
        } else if (att.type === 'video') {
          itemDiv.className = 'message-attachment-item media-attachment';
          itemDiv.innerHTML = `
                <span class="media-icon">🎬</span>
                <div class="media-info">
                  <div class="media-type">${appState.language === 'zh-CN' ? '视频' : 'Video'}</div>
                  <div class="media-name">${att.fileName || ''}</div>
                </div>
              `;
        } else if (att.type === 'audio') {
          itemDiv.className = 'message-attachment-item media-attachment';
          itemDiv.innerHTML = `
                <span class="media-icon">🎵</span>
                <div class="media-info">
                  <div class="media-type">${appState.language === 'zh-CN' ? '音频' : 'Audio'}</div>
                  <div class="media-name">${att.fileName || ''}</div>
                </div>
              `;
        } else if (att.type === 'document') {
          itemDiv.className = 'message-attachment-item media-attachment';
          itemDiv.innerHTML = `
                <span class="media-icon">📄</span>
                <div class="media-info">
                  <div class="media-type">${appState.language === 'zh-CN' ? '文档' : 'Document'}</div>
                  <div class="media-name">${att.fileName || ''}</div>
                </div>
              `;
        }

        if (itemDiv.innerHTML) {
          attachmentsDiv.appendChild(itemDiv);
        }
      });

      if (attachmentsDiv.children.length > 0) {
        content.appendChild(attachmentsDiv);
      }
    }
  }

  const textDiv = document.createElement('div');
  textDiv.className = 'message-text';
  // 🔧 移除标题标记 <<<标题>>> 后再渲染（修复历史消息显示标题的bug）
  const cleanContent = (message.content || '').replace(/<<<.{1,30}>>>\s*$/g, '').trim();
  // 使用renderMarkdownWithMath渲染Markdown和数学公式
  let renderedContent = renderMarkdownWithMath(cleanContent);

  // 解析 sources：可能是 JSON 字符串（从数据库加载）或数组对象（流式响应）
  let sources = message.sources;
  if (typeof sources === 'string' && sources.trim()) {
    try {
      sources = JSON.parse(sources);
    } catch (e) {
      console.warn('⚠️ 解析 sources JSON 失败:', e);
      sources = null;
    }
  }

  // 对AI消息的角标进行转换
  if (message.role === 'assistant' && sources && Array.isArray(sources) && sources.length > 0) {
    renderedContent = renderCitations(renderedContent, sources);
  }

  textDiv.innerHTML = renderedContent;
  content.appendChild(textDiv);


  // 渲染来源列表（在消息文本后）- 使用已解析的 sources 变量
  if (message.role === 'assistant' && sources && Array.isArray(sources) && sources.length > 0) {
    const sourcesDiv = document.createElement('div');
    sourcesDiv.innerHTML = renderSourcesList(sources, appState.language);
    content.appendChild(sourcesDiv);
  }


  // 为AI消息添加元信息和复制按钮
  if (message.role === 'assistant') {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'message-meta';

    // 显示模型信息
    if (message.model) {
      const modelBadge = document.createElement('span');
      modelBadge.className = 'meta-badge';

      // 获取模型显示名称
      let modelName = message.model;
      if (MODELS[message.model]) {
        modelName = MODELS[message.model].name;
      }

      modelBadge.innerHTML = `
            ${getSvgIcon('smart_toy', 'material-symbols-outlined', 24)}
            <span>${modelName}</span>
          `;
      metaDiv.appendChild(modelBadge);
    }

    // 显示联网状态
    // 增强判断逻辑：检查 enable_search 或 internet_mode，并处理可能的类型差异（数字/布尔值）
    const isInternet = (message.enable_search === 1 || message.enable_search === true) ||
      (message.internet_mode === 1 || message.internet_mode === true);

    if (isInternet) {
      const internetBadge = document.createElement('span');
      internetBadge.className = 'meta-badge';
      internetBadge.innerHTML = `
            ${getSvgIcon('language', 'material-symbols-outlined', 24)}
            <span>${appState.language === 'zh-CN' ? '联网' : 'Web'}</span>
          `;
      metaDiv.appendChild(internetBadge);
    }

    // 显示思考状态
    if (message.reasoning_content && message.reasoning_content !== 'null' && message.reasoning_content.trim() !== '') {
      const thinkingBadge = document.createElement('span');
      thinkingBadge.className = 'meta-badge';
      thinkingBadge.innerHTML = `
            ${getSvgIcon('psychology', 'material-symbols-outlined', 24)}
            <span>${appState.language === 'zh-CN' ? '思考' : 'Thinking'}</span>
          `;
      metaDiv.appendChild(thinkingBadge);
    }

    // 添加复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.title = appState.language === 'zh-CN' ? '复制消息' : 'Copy message';
    copyBtn.innerHTML = `
          ${getSvgIcon('content_copy', 'material-symbols-outlined', 24)}
        `;

    // 复制按钮事件
    copyBtn.addEventListener('click', async function () {
      const textToCopy = message.content || '';

      try {
        // 优先使用现代API
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(textToCopy);
          console.log('✅ 复制成功');
        } else {
          // 备用方案：使用传统方法
          const textarea = document.createElement('textarea');
          textarea.value = textToCopy;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
          console.log('✅ 复制成功（备用方法）');
        }

        // 更新按钮状态
        copyBtn.classList.add('copied');
        copyBtn.innerHTML = `
              ${getSvgIcon('check', 'material-symbols-outlined', 24)}
            `;

        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = `
                ${getSvgIcon('content_copy', 'material-symbols-outlined', 24)}
              `;
        }, 2000);
      } catch (err) {
        console.error('❌ 复制失败:', err);
        alert(appState.language === 'zh-CN' ? '复制失败' : 'Copy failed');
      }
    });

    metaDiv.appendChild(copyBtn);

    // 添加编辑按钮
    const editBtn = document.createElement('button');
    editBtn.className = 'action-btn edit-btn';
    editBtn.title = appState.language === 'zh-CN' ? '编辑' : 'Edit';
    editBtn.innerHTML = getSvgIcon('edit', 'material-symbols-outlined', 16);
    editBtn.addEventListener('click', () => startEditMessage(message, div));
    metaDiv.appendChild(editBtn);

    // 添加重新生成按钮
    const regenerateBtn = document.createElement('button');
    regenerateBtn.className = 'action-btn regenerate-btn';
    regenerateBtn.title = appState.language === 'zh-CN' ? '重新生成' : 'Regenerate';
    regenerateBtn.innerHTML = getSvgIcon('refresh', 'material-symbols-outlined', 16);
    regenerateBtn.addEventListener('click', () => openRegenerateModal(message));
    metaDiv.appendChild(regenerateBtn);

    // 添加删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn delete-btn';
    deleteBtn.title = appState.language === 'zh-CN' ? '删除' : 'Delete';
    deleteBtn.innerHTML = getSvgIcon('delete', 'material-symbols-outlined', 16);
    deleteBtn.addEventListener('click', () => deleteMessage(message));
    metaDiv.appendChild(deleteBtn);

    // 添加引用按钮
    const quoteBtn = document.createElement('button');
    quoteBtn.className = 'action-btn quote-btn';
    quoteBtn.title = appState.language === 'zh-CN' ? '引用' : 'Quote';
    quoteBtn.innerHTML = getSvgIcon('format_quote', 'material-symbols-outlined', 16);
    quoteBtn.addEventListener('click', () => quoteMessage(message));
    metaDiv.appendChild(quoteBtn);

    content.appendChild(metaDiv);
  }

  // 为用户消息添加操作按钮
  if (message.role === 'user') {
    const userMetaDiv = document.createElement('div');
    userMetaDiv.className = 'user-message-meta';

    // 编辑按钮
    const editBtn = document.createElement('button');
    editBtn.className = 'action-btn edit-btn';
    editBtn.title = appState.language === 'zh-CN' ? '编辑' : 'Edit';
    editBtn.innerHTML = getSvgIcon('edit', 'material-symbols-outlined', 16);
    editBtn.addEventListener('click', () => startEditMessage(message, div));
    userMetaDiv.appendChild(editBtn);

    // 删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn delete-btn';
    deleteBtn.title = appState.language === 'zh-CN' ? '删除' : 'Delete';
    deleteBtn.innerHTML = getSvgIcon('delete', 'material-symbols-outlined', 16);
    deleteBtn.addEventListener('click', () => deleteMessage(message));
    userMetaDiv.appendChild(deleteBtn);

    // 引用按钮
    const quoteBtn = document.createElement('button');
    quoteBtn.className = 'action-btn quote-btn';
    quoteBtn.title = appState.language === 'zh-CN' ? '引用' : 'Quote';
    quoteBtn.innerHTML = getSvgIcon('format_quote', 'material-symbols-outlined', 16);
    quoteBtn.addEventListener('click', () => quoteMessage(message));
    userMetaDiv.appendChild(quoteBtn);

    content.appendChild(userMetaDiv);
  }


  div.appendChild(content);

  return div;
}

// 懒加载消息附件
async function loadMessageAttachments(messageId, containerElement) {
  if (!containerElement) return;

  // 显示加载状态
  containerElement.innerHTML = `
        <div class="lazy-attachment-placeholder loading">
          <svg class="loading-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" opacity="0.3"/>
            <path d="M12 2a10 10 0 0 1 10 10"/>
          </svg>
          <span>${appState.language === 'zh-CN' ? '加载中...' : 'Loading...'}</span>
        </div>
      `;

  try {
    const response = await fetch(`${API_BASE}/messages/${messageId}/attachments`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const { attachments } = await response.json();

    if (!attachments || attachments.length === 0) {
      containerElement.innerHTML = `<div style="color: var(--text-secondary); font-size: 12px; padding: 8px;">无附件</div>`;
      return;
    }

    // 渲染附件
    containerElement.innerHTML = '';
    containerElement.classList.remove('lazy-attachments');

    attachments.forEach(att => {
      if (!att || !att.type) return;

      const itemDiv = document.createElement('div');

      if (att.type === 'image' && att.data) {
        itemDiv.className = 'message-attachment-item image-attachment';
        const img = document.createElement('img');
        img.src = att.data;
        img.alt = att.fileName || '图片';
        img.loading = 'lazy';
        img.onclick = () => window.open(att.data, '_blank');
        itemDiv.appendChild(img);
      } else if (att.type === 'video') {
        itemDiv.className = 'message-attachment-item media-attachment';
        itemDiv.innerHTML = `<span class="media-icon">🎬</span><div class="media-info"><div class="media-type">${appState.language === 'zh-CN' ? '视频' : 'Video'}</div><div class="media-name">${att.fileName || ''}</div></div>`;
      } else if (att.type === 'audio') {
        itemDiv.className = 'message-attachment-item media-attachment';
        itemDiv.innerHTML = `<span class="media-icon">🎵</span><div class="media-info"><div class="media-type">${appState.language === 'zh-CN' ? '音频' : 'Audio'}</div><div class="media-name">${att.fileName || ''}</div></div>`;
      }

      if (itemDiv.innerHTML) containerElement.appendChild(itemDiv);
    });

  } catch (error) {
    console.error('❌ 加载附件失败:', error);
    containerElement.innerHTML = `
          <div class="lazy-attachment-placeholder error" onclick="loadMessageAttachments(${messageId}, this.parentElement)">
            <span>${appState.language === 'zh-CN' ? '加载失败，点击重试' : 'Failed, click to retry'}</span>
          </div>
        `;
  }
}

// 修复：改进openSidebar函数
function openSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobileOverlay');

  if (sidebar) {
    sidebar.classList.add('active');
    sidebar.style.transform = '';
  }

  if (overlay) {
    overlay.classList.add('active');
  }

  appState.sidebarOpen = true;
}

// 修复：改进closeSidebar函数
function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobileOverlay');

  if (sidebar) {
    sidebar.classList.remove('active');
    sidebar.style.transform = '';
  }

  if (overlay) {
    overlay.classList.remove('active');
  }

  appState.sidebarOpen = false;
}

// 修复：改进toggleSidebar函数
function toggleSidebar() {
  if (appState.sidebarOpen) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

// 修复：改进deleteSession函数
async function deleteSession(event, sessionId) {
  if (!event) {
    console.warn('⚠️ 事件对象未传递');
    return;
  }

  event.stopPropagation();

  const confirmMsg = appState.language === 'zh-CN' ? '确定要删除这个对话吗?' : 'Delete this conversation?';
  if (!confirm(confirmMsg)) return;

  try {
    const response = await fetch(`${API_BASE}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (appState.currentSession?.id === sessionId) {
      appState.currentSession = null;
      appState.messages = [];
      showWelcome();
    }

    await loadSessions();
  } catch (error) {
    console.error('❌ 删除会话失败:', error);
    alert(appState.language === 'zh-CN' ? '删除失败' : 'Delete failed');
  }
}

// ==================== 消息管理功能 ====================

// 当前正在重新生成的消息
let regenerateTargetMessage = null;

// 开始编辑消息
function startEditMessage(message, messageDiv) {
  // 找到消息文本区域
  const textDiv = messageDiv.querySelector('.message-text');
  if (!textDiv) return;

  // 获取原始内容（移除可能的标题标记）
  const originalContent = (message.content || '').replace(/<<<.{1,30}>>>\s*$/g, '').trim();

  // 保存原始HTML以便取消时恢复
  const originalHtml = textDiv.innerHTML;

  // 创建编辑容器
  const editContainer = document.createElement('div');
  editContainer.className = 'message-edit-container';
  editContainer.innerHTML = `
        <textarea class="message-edit-textarea">${escapeHtml(originalContent)}</textarea>
        <div class="message-edit-actions">
          <button class="edit-cancel-btn" data-i18n="cancel">${appState.language === 'zh-CN' ? '取消' : 'Cancel'}</button>
          <button class="edit-save-btn" data-i18n="save">${appState.language === 'zh-CN' ? '保存' : 'Save'}</button>
        </div>
      `;

  // 隐藏原始文本，显示编辑区域
  textDiv.style.display = 'none';
  textDiv.parentNode.insertBefore(editContainer, textDiv.nextSibling);

  // 自动聚焦并选中文本
  const textarea = editContainer.querySelector('.message-edit-textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  // 取消按钮事件
  editContainer.querySelector('.edit-cancel-btn').addEventListener('click', () => {
    editContainer.remove();
    textDiv.style.display = '';
  });

  // 保存按钮事件
  editContainer.querySelector('.edit-save-btn').addEventListener('click', async () => {
    const newContent = textarea.value.trim();
    if (!newContent) {
      alert(appState.language === 'zh-CN' ? '内容不能为空' : 'Content cannot be empty');
      return;
    }

    await saveEditMessage(message, newContent, messageDiv, editContainer, textDiv);
  });
}

// 保存编辑的消息
async function saveEditMessage(message, newContent, messageDiv, editContainer, textDiv) {
  if (!appState.currentSession) {
    console.error('❌ 无法保存：缺少会话');
    alert(appState.language === 'zh-CN' ? '请先刷新页面' : 'Please refresh the page first');
    return;
  }

  // 如果消息没有ID，需要先从数据库重新加载消息获取ID
  if (!message.id) {
    console.log('⚠️ 消息没有ID，正在从数据库重新加载...');
    try {
      const response = await fetch(`${API_BASE}/sessions/${appState.currentSession.id}/messages`, {
        headers: { 'Authorization': `Bearer ${appState.token}` }
      });
      if (response.ok) {
        const dbMessages = await response.json();
        appState.messages = dbMessages;
        // 找到对应位置的消息并获取其ID
        const msgIndex = appState.messages.findIndex(m =>
          m.content === message.content && m.role === message.role
        );
        if (msgIndex !== -1 && appState.messages[msgIndex].id) {
          message.id = appState.messages[msgIndex].id;
          console.log(`✅ 已获取消息ID: ${message.id}`);
        } else {
          console.error('❌ 无法找到消息ID');
          alert(appState.language === 'zh-CN' ? '消息尚未保存，请稍后重试' : 'Message not saved yet, please try again');
          return;
        }
      }
    } catch (error) {
      console.error('❌ 重新加载消息失败:', error);
      alert(appState.language === 'zh-CN' ? '加载失败，请重试' : 'Load failed, please retry');
      return;
    }
  }


  try {
    const response = await fetch(`${API_BASE}/sessions/${appState.currentSession.id}/messages/${message.id}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: newContent })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    console.log('✅ 消息已更新:', result);

    // 更新本地状态
    message.content = newContent;
    const msgIndex = appState.messages.findIndex(m => m.id === message.id);
    if (msgIndex !== -1) {
      appState.messages[msgIndex].content = newContent;
    }

    // 移除编辑容器，更新显示
    editContainer.remove();
    textDiv.style.display = '';
    textDiv.innerHTML = renderMarkdownWithMath(newContent);

    // 如果是用户消息，自动触发AI重新回复
    if (message.role === 'user') {
      // 找到这条消息之后的AI回复并删除，然后重新生成
      await regenerateAfterUserEdit(message);
    }

  } catch (error) {
    console.error('❌ 更新消息失败:', error);
    alert(appState.language === 'zh-CN' ? '更新失败' : 'Update failed');
  }
}

// 用户消息编辑后自动重新生成AI回复
async function regenerateAfterUserEdit(userMessage) {
  const msgIndex = appState.messages.findIndex(m => m.id === userMessage.id);
  if (msgIndex === -1) return;

  // 找到紧跟这条用户消息的AI回复
  const nextMsg = appState.messages[msgIndex + 1];
  if (nextMsg && nextMsg.role === 'assistant') {
    // 删除这条AI回复
    await deleteMessageFromDB(nextMsg);

    // 从本地状态移除
    appState.messages.splice(msgIndex + 1, 1);
  }

  // 重新渲染并触发AI回复
  renderMessages();

  // 构建消息并发送
  const messagesToSend = appState.messages.slice(0, msgIndex + 1).map(m => ({
    role: m.role,
    content: m.content
  }));

  // 触发AI回复
  await triggerAIResponse(messagesToSend);
}

// 确保消息有ID（如果没有则从数据库重新加载）
async function ensureMessageHasId(message) {
  if (message.id) return message;

  if (!appState.currentSession) {
    console.error('❌ 无法获取消息ID：缺少会话');
    return null;
  }

  console.log('⚠️ 消息没有ID，正在从数据库重新加载...');
  try {
    const response = await fetch(`${API_BASE}/sessions/${appState.currentSession.id}/messages`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const dbMessages = await response.json();

    // 找到对应的消息（通过内容和角色匹配）
    const foundMsg = dbMessages.find(m =>
      m.content === message.content && m.role === message.role
    );

    if (foundMsg && foundMsg.id) {
      // 更新本地消息数组
      appState.messages = dbMessages;
      console.log(`✅ 已获取消息ID: ${foundMsg.id}`);
      return foundMsg;
    } else {
      console.error('❌ 无法在数据库中找到该消息');
      return null;
    }
  } catch (error) {
    console.error('❌ 重新加载消息失败:', error);
    return null;
  }
}


// 从数据库删除消息（不更新UI）
async function deleteMessageFromDB(message) {
  if (!appState.currentSession) return false;

  // 确保消息有ID
  const msgWithId = await ensureMessageHasId(message);
  if (!msgWithId || !msgWithId.id) {
    console.error('❌ 无法删除：无法获取消息ID');
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/sessions/${appState.currentSession.id}/messages/${msgWithId.id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    console.log(`✅ 已从数据库删除消息 ID: ${msgWithId.id}`);
    return true;
  } catch (error) {
    console.error('❌ 删除消息失败:', error);
    return false;
  }
}

// 删除消息
async function deleteMessage(message) {
  const confirmMsg = appState.language === 'zh-CN' ? '确定要删除这条消息吗?' : 'Delete this message?';
  if (!confirm(confirmMsg)) return;

  // 确保消息有ID
  const msgWithId = await ensureMessageHasId(message);
  if (!msgWithId) {
    alert(appState.language === 'zh-CN' ? '无法获取消息信息，请刷新页面后重试' : 'Cannot get message info, please refresh and retry');
    return;
  }

  const deleted = await deleteMessageFromDB(msgWithId);
  if (deleted) {
    // 从本地状态移除（通过ID查找，因为已经reload了）
    const msgIndex = appState.messages.findIndex(m => m.id === msgWithId.id);
    if (msgIndex !== -1) {
      appState.messages.splice(msgIndex, 1);
    }

    // 重新渲染
    if (appState.messages.length === 0) {
      showWelcome();
    } else {
      renderMessages();
    }
  } else {
    alert(appState.language === 'zh-CN' ? '删除失败' : 'Delete failed');
  }
}

// ==================== 引用功能 ====================

// 引用消息
function quoteMessage(message) {
  appState.currentQuote = {
    role: message.role,
    content: message.content || ''
  };
  updateQuoteUI();

  // 聚焦输入框
  const input = document.getElementById('messageInput');
  if (input) {
    input.focus();
  }

  console.log('✅ 已引用消息:', message.role);
}

// 移除引用
function removeQuote() {
  appState.currentQuote = null;
  updateQuoteUI();
}

// 更新引用预览UI
function updateQuoteUI() {
  let quotePreview = document.getElementById('quotePreview');

  if (!appState.currentQuote) {
    // 移除预览
    if (quotePreview) {
      quotePreview.remove();
    }
    return;
  }

  // 创建或更新预览元素
  if (!quotePreview) {
    quotePreview = document.createElement('div');
    quotePreview.id = 'quotePreview';
    quotePreview.className = 'quote-preview';

    // 插入到input-row之前
    const inputContainer = document.getElementById('inputContainer');
    const inputRow = inputContainer?.querySelector('.input-row');
    if (inputContainer && inputRow) {
      inputContainer.insertBefore(quotePreview, inputRow);
    }
  }

  // 获取引用标签文本
  const quoteLabel = appState.currentQuote.role === 'user'
    ? (i18n[appState.language]?.['quote-user'] || '引用用户')
    : (i18n[appState.language]?.['quote-ai'] || '引用AI');

  // 截取引用内容预览（最多100个字符）
  const contentPreview = (appState.currentQuote.content || '')
    .replace(/\n+/g, ' ')
    .trim()
    .slice(0, 100) + (appState.currentQuote.content.length > 100 ? '...' : '');

  quotePreview.innerHTML = `
        <div class="quote-preview-content">
          <div class="quote-preview-label">
            ${getSvgIcon('format_quote', 'material-symbols-outlined', 14)}
            <span>${quoteLabel}</span>
          </div>
          <div class="quote-preview-text">${contentPreview}</div>
        </div>
        <button class="quote-preview-remove" onclick="removeQuote()" title="${appState.language === 'zh-CN' ? '取消引用' : 'Remove quote'}">
          ${getSvgIcon('close', 'remove-icon', 16)}
        </button>
      `;
}

// 打开重新生成弹窗
function openRegenerateModal(message) {
  regenerateTargetMessage = message;

  const modal = document.getElementById('regenerateModal');
  if (!modal) return;

  // 设置默认值
  document.getElementById('regenerateModelSelect').value = appState.selectedModel || 'auto';
  document.getElementById('regenerateInternetToggle').checked = appState.internetMode || false;
  document.getElementById('regenerateThinkingToggle').checked = appState.thinkingMode || false;

  modal.classList.add('active');
}

// 关闭重新生成弹窗
function closeRegenerateModal() {
  const modal = document.getElementById('regenerateModal');
  if (modal) {
    modal.classList.remove('active');
  }
  regenerateTargetMessage = null;
}

// 确认重新生成
async function confirmRegenerate() {
  if (!regenerateTargetMessage) return;

  // 保存目标消息引用（因为closeRegenerateModal会将其设为null）
  const targetMessage = regenerateTargetMessage;

  const selectedModel = document.getElementById('regenerateModelSelect').value;
  const internetMode = document.getElementById('regenerateInternetToggle').checked;
  const thinkingMode = document.getElementById('regenerateThinkingToggle').checked;

  closeRegenerateModal();


  // 使用本地变量targetMessage而不是regenerateTargetMessage
  let currentTarget = targetMessage;

  // 如果消息没有ID，需要先从数据库重新加载消息获取ID
  if (!currentTarget.id && appState.currentSession) {
    console.log('⚠️ 消息没有ID，正在从数据库重新加载...');
    try {
      const response = await fetch(`${API_BASE}/sessions/${appState.currentSession.id}/messages`, {
        headers: { 'Authorization': `Bearer ${appState.token}` }
      });
      if (response.ok) {
        const dbMessages = await response.json();
        appState.messages = dbMessages;
        // 找到对应内容的消息并更新目标
        const foundMsg = appState.messages.find(m =>
          m.content === currentTarget.content && m.role === 'assistant'
        );
        if (foundMsg && foundMsg.id) {
          currentTarget = foundMsg;
          console.log(`✅ 已获取消息ID: ${foundMsg.id}`);
        } else {
          console.error('❌ 无法找到消息ID');
          alert(appState.language === 'zh-CN' ? '消息尚未保存，请稍后重试' : 'Message not saved yet, please try again');
          return;
        }
      }
    } catch (error) {
      console.error('❌ 重新加载消息失败:', error);
      alert(appState.language === 'zh-CN' ? '加载失败，请重试' : 'Load failed, please retry');
      return;
    }
  }

  // 找到这条AI消息（通过ID或内容匹配）
  let msgIndex = appState.messages.findIndex(m => m.id === currentTarget.id);
  if (msgIndex === -1) {
    // 尝试通过内容匹配
    msgIndex = appState.messages.findIndex(m =>
      m.content === currentTarget.content && m.role === 'assistant'
    );
  }
  if (msgIndex === -1) {
    console.error('❌ 无法找到要重新生成的消息');
    return;
  }

  // 删除这条AI消息
  await deleteMessageFromDB(appState.messages[msgIndex]);
  appState.messages.splice(msgIndex, 1);


  // 重新渲染
  renderMessages();

  // 保存当前设置
  const originalModel = appState.selectedModel;
  const originalInternet = appState.internetMode;
  const originalThinking = appState.thinkingMode;

  // 临时应用新设置
  appState.selectedModel = selectedModel;
  appState.internetMode = internetMode;
  appState.thinkingMode = thinkingMode;

  // 更新UI显示
  updateModelControls();

  // 构建消息并发送
  const messagesToSend = appState.messages.map(m => ({
    role: m.role,
    content: m.content
  }));

  // 触发AI回复
  await triggerAIResponse(messagesToSend);

  // 恢复原设置（可选）
  // appState.selectedModel = originalModel;
  // appState.internetMode = originalInternet;
  // appState.thinkingMode = originalThinking;
}

// 触发AI回复
async function triggerAIResponse(messages) {
  if (appState.isStreaming) return;

  // 创建AI消息占位符
  const aiMsg = {
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString()
  };
  appState.messages.push(aiMsg);
  renderMessages();

  // 调用现有的流式聊天逻辑（通过sendMessage部分逻辑）
  await streamAIResponse(messages, aiMsg);
}

// 流式AI回复（优化版：增量更新DOM，不重新渲染整个消息列表）
async function streamAIResponse(messages, aiMsg) {
  appState.isStreaming = true;

  const sessionId = appState.currentSession?.id;
  const requestId = `req_${Date.now()}`;

  // 找到AI消息在列表中的位置并获取对应的DOM元素
  const msgIndex = appState.messages.indexOf(aiMsg);
  const container = document.getElementById('messagesList');
  const messageElements = container?.querySelectorAll('.message');
  const aiMsgElement = messageElements ? messageElements[msgIndex] : null;
  const textDiv = aiMsgElement?.querySelector('.message-text');

  // 用于节流更新的变量
  let pendingUpdate = false;
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL = 50; // 50ms更新间隔

  // 跟踪已加载的图片：URL -> DOM容器映射
  const loadedImageContainers = new Map();

  // 使用骨架中预先创建的 Mermaid 预览容器
  const mermaidPreviewContainer = aiMsgElement?.querySelector('#mermaidLivePreview');
  let lastValidMermaidCode = ''; // 上次成功渲染的代码

  // 从原始文本中提取 Mermaid 代码并尝试实时渲染
  async function tryRenderMermaidFromText(fullText) {
    if (typeof mermaid === 'undefined' || !mermaidPreviewContainer) return;

    // 提取 mermaid 代码块（支持未闭合的情况）
    const mermaidRegex = /```mermaid\n([\s\S]*?)(```|$)/;
    const match = fullText.match(mermaidRegex);

    if (!match) {
      // 没有 mermaid 代码块，隐藏预览
      mermaidPreviewContainer.style.display = 'none';
      return;
    }

    const code = match[1].trim();
    if (!code || code === lastValidMermaidCode) return; // 代码没变化，跳过

    // 显示容器
    mermaidPreviewContainer.style.display = 'block';

    try {
      // 1. 先用 parse() 检查语法是否正确
      await mermaid.parse(code);

      // 2. 语法正确，渲染图表
      const id = `mermaid-live-${Date.now()}`;
      const { svg } = await mermaid.render(id, code);

      mermaidPreviewContainer.innerHTML = svg;
      mermaidPreviewContainer.classList.add('rendered');
      lastValidMermaidCode = code;

      console.log('✅ Mermaid 实时渲染成功');
    } catch (err) {
      // 语法错误，保持上一次的渲染结果
      console.debug('⏳ Mermaid 语法不完整，保持上一帧');
    }
  }

  // 节流更新函数（保留已加载图片状态）
  function throttledUpdate(content) {
    if (!textDiv) return;

    const now = Date.now();
    if (now - lastUpdateTime >= UPDATE_INTERVAL) {
      updateContent(content);
      lastUpdateTime = now;
      scrollToBottom();
    } else if (!pendingUpdate) {
      pendingUpdate = true;
      setTimeout(() => {
        updateContent(aiMsg.content);
        lastUpdateTime = Date.now();
        pendingUpdate = false;
        scrollToBottom();
      }, UPDATE_INTERVAL);
    }
  }

  // 实际更新内容的函数，保留已加载图片的DOM元素
  function updateContent(content) {
    // 1. 保存已加载图片的DOM容器
    const existingContainers = textDiv.querySelectorAll('.streaming-image-container.loaded');
    existingContainers.forEach(container => {
      const src = container.getAttribute('data-src');
      if (src) {
        // 克隆容器以保留完整状态
        loadedImageContainers.set(src, container.cloneNode(true));
      }
    });

    // 2. 渲染新内容（流式模式）
    textDiv.innerHTML = renderMarkdownWithMath(content, true);

    // 3. 用保存的容器替换新创建的容器（图片）
    const newContainers = textDiv.querySelectorAll('.streaming-image-container');
    newContainers.forEach(container => {
      const src = container.getAttribute('data-src');
      if (src && loadedImageContainers.has(src)) {
        // 直接用已加载的容器替换
        container.replaceWith(loadedImageContainers.get(src).cloneNode(true));
      } else {
        // 新图片，添加加载监听
        const img = container.querySelector('img');
        if (img) {
          img.onload = function () {
            container.classList.add('loaded');
            loadedImageContainers.set(src, container.cloneNode(true));
          };
          img.onerror = function () {
            container.classList.add('error');
            container.innerHTML = '<span class="image-error">图片有版权等原因不能加载，见谅 ＞﹏＜ </span>';
          };
        }
      }
    });

    // 4.从原始文本中提取 Mermaid 代码并实时渲染到持久容器
    tryRenderMermaidFromText(content);
  }

  try {
    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({
        messages,
        model: appState.selectedModel,
        sessionId,
        requestId,
        internetMode: appState.internetMode,
        thinkingMode: appState.thinkingMode,
        temperature: appState.temperature,
        topP: appState.topP,
        maxTokens: appState.maxTokens,
        frequencyPenalty: appState.frequencyPenalty,
        presencePenalty: appState.presencePenalty,
        systemPrompt: buildSystemPrompt() + (appState.systemPrompt ? '\n\nUser Custom Instructions:\n' + appState.systemPrompt : '')
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let reasoningContent = '';
    let sources = null;
    let finalModel = appState.selectedModel;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.sources) {
            sources = parsed.sources;
            aiMsg.sources = sources;
          }

          if (parsed.model) {
            finalModel = parsed.model;
            aiMsg.model = finalModel;
          }

          if (parsed.choices?.[0]?.delta) {
            const delta = parsed.choices[0].delta;
            if (delta.content) {
              fullContent += delta.content;
              aiMsg.content = fullContent;
              // 使用节流更新而不是每次都更新
              throttledUpdate(fullContent);
            }
            if (delta.reasoning_content) {
              reasoningContent += delta.reasoning_content;
              aiMsg.reasoning_content = reasoningContent;
            }
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    // 流结束后最终渲染一次（确保完整内容显示）
    console.log('✅ 流式响应完成');

  } catch (error) {
    console.error('❌ 流式请求失败:', error);
    aiMsg.content = appState.language === 'zh-CN' ? '生成失败，请重试' : 'Generation failed, please retry';
  } finally {
    appState.isStreaming = false;

    // 🎨 清理持久的 Mermaid 预览容器（最终渲染会创建正式的容器）
    if (mermaidPreviewContainer) {
      mermaidPreviewContainer.remove();
      mermaidPreviewContainer = null;
    }

    // 最终完整渲染一次，确保所有内容正确显示（包括来源、模型标签等）
    renderMessages();
    // 重新加载消息以获取数据库ID
    if (sessionId) {
      try {
        const resp = await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
          headers: { 'Authorization': `Bearer ${appState.token}` }
        });
        if (resp.ok) {
          appState.messages = await resp.json();
          renderMessages();
        }
      } catch (e) {
        console.warn('⚠️ 重新加载消息失败:', e);
      }
    }
  }
}


// 修复：改进renderSessions，使用事件委托处理删除按钮
// 新增：支持侧边栏附件预览


// 解析会话的附件数据
function parseSessionAttachments(session) {
  if (!session.recent_attachments) return [];

  try {
    const attachmentStrings = session.recent_attachments.split('|||');
    const attachments = [];

    for (const str of attachmentStrings) {
      if (str && str.trim()) {
        try {
          const parsed = JSON.parse(str);
          if (Array.isArray(parsed)) {
            attachments.push(...parsed);
          } else {
            attachments.push(parsed);
          }
        } catch (e) {
          // 跳过无法解析的条目
        }
      }
    }

    return attachments.slice(0, 2); // 最多2个
  } catch (e) {
    return [];
  }
}

// 生成单个附件预览HTML
function renderSessionAttachmentPreview(attachment) {
  if (!attachment || !attachment.type) return '';

  if (attachment.type === 'image') {
    if (attachment.data) {
      return `<div class="session-attachment-preview">
            <img src="${attachment.data}" alt="图片" loading="lazy">
          </div>`;
    } else {
      return `<div class="session-attachment-preview">🖼️</div>`;
    }
  } else if (attachment.type === 'video') {
    return `<div class="session-attachment-preview video-preview">🎬</div>`;
  } else if (attachment.type === 'audio') {
    return `<div class="session-attachment-preview audio-preview">🎵</div>`;
  } else if (attachment.type === 'document') {
    return `<div class="session-attachment-preview">📄</div>`;
  }
  return '';
}

function renderSessions() {
  const container = document.getElementById('sessionsContainer');

  if (!container) {
    console.error('❌ 找不到会话容器');
    return;
  }

  container.innerHTML = '';

  if (!appState.sessions || appState.sessions.length === 0) {
    // 如果正在加载，显示加载中
    if (appState.sessionsPagination.isLoading) {
      container.innerHTML = `<div class="sessions-loader"><div class="loader-spinner"></div></div>`;
      return;
    }
    const msg = appState.language === 'zh-CN'
      ? '暂无历史对话<br>点击"新对话"开始聊天'
      : 'No conversations<br>Click "New Chat" to start';
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-secondary); font-size: 13px;">${msg}</div>`;
    return;
  }

  appState.sessions.forEach(session => {
    const div = document.createElement('div');
    div.className = `session-item ${session.id === appState.currentSession?.id ? 'active' : ''}`;
    div.setAttribute('data-session-id', session.id);

    // 解析附件并生成预览HTML
    const attachments = parseSessionAttachments(session);
    let attachmentsHtml = '';
    if (attachments.length > 0) {
      const previews = attachments.map(att => renderSessionAttachmentPreview(att)).join('');
      attachmentsHtml = `<div class="session-attachments">${previews}</div>`;
    }

    div.innerHTML = `
          <div class="session-title">${escapeHtml(session.title || '')}</div>
          <div class="session-preview">${escapeHtml((session.last_message || '').substring(0, 50))}...</div>
          ${attachmentsHtml}
          <button class="session-delete-btn" type="button">
            ${getSvgIcon('close', 'material-symbols-outlined', 24)}
          </button>
        `;

    // 主项目点击加载会话
    div.addEventListener('click', function (e) {
      if (!e.target.closest('.session-delete-btn')) {
        const sid = this.getAttribute('data-session-id');
        if (sid) loadSession(sid);
      }
    });

    // 删除按钮点击处理
    const deleteBtn = div.querySelector('.session-delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        const sid = div.getAttribute('data-session-id');
        if (sid) deleteSession(e, sid);
      });
    }

    container.appendChild(div);
  });

  // 添加加载指示器（如果还有更多数据）
  if (appState.sessionsPagination.hasMore) {
    const loader = document.createElement('div');
    loader.className = 'sessions-loader';
    loader.id = 'sessionsLoader';
    loader.innerHTML = `<div class="loader-spinner"></div>`;
    container.appendChild(loader);

    // 使用 Intersection Observer 检测加载指示器是否可见
    setupSessionsLoaderObserver();
  }
}

// 会话列表无限滚动的 Intersection Observer
let sessionsLoaderObserver = null;

function setupSessionsLoaderObserver() {
  const loader = document.getElementById('sessionsLoader');
  if (!loader) return;

  // 清理旧的观察器
  if (sessionsLoaderObserver) {
    sessionsLoaderObserver.disconnect();
  }

  // 找到滚动容器
  const scrollContainer = loader.closest('.sidebar-scrollable') || loader.closest('.sessions-container');

  sessionsLoaderObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting &&
        appState.sessionsPagination.hasMore &&
        !appState.sessionsPagination.isLoading) {
        console.log('📜 触发加载更多会话...');
        loadSessions(false);  // false = 追加模式
      }
    });
  }, {
    root: scrollContainer,
    rootMargin: '100px',  // 提前100px触发
    threshold: 0.1
  });

  sessionsLoaderObserver.observe(loader);
}

// 修复：改进sendMessage，添加更多的错误处理
// 支持多模态：图片、音频、视频附件
async function sendMessage(message = null) {
  // 如果在 ChatFlow iframe 模式下，发送前先请求最新的画布上下文
  if (isChatFlowIframeMode) {
    console.log('⏳ 发送前请求画布上下文...');
    await new Promise(resolve => requestCanvasContext(resolve));
  }

  const input = document.getElementById('messageInput');
  if (!input) {
    console.error('❌ 消息输入框未找到');
    return;
  }

  // 检测超长输入并自动转换为文件附件
  if (checkAndConvertLongInput()) {
    // 输入已被转换为附件，等待下次发送
    return;
  }

  const messageText = input.value.trim();

  // 允许只发送附件（无文字内容）
  if (!messageText && !currentAttachment) return;
  if (appState.isStreaming) return;

  if (!appState.currentSession) {
    await createNewSession();
    return;
  }

  input.value = '';
  autoResizeInput();

  // 🗨️ 处理引用内容
  let finalMessageContent = messageText || message || '请分析这个文件';
  if (appState.currentQuote) {
    const quoteLabel = appState.currentQuote.role === 'user'
      ? (appState.language === 'zh-CN' ? '引用用户' : 'Quoting User')
      : (appState.language === 'zh-CN' ? '引用AI' : 'Quoting AI');
    // 截取引用内容（最多200字符）
    const quotedContent = (appState.currentQuote.content || '').slice(0, 200) +
      (appState.currentQuote.content.length > 200 ? '...' : '');
    finalMessageContent = `${quoteLabel}：${quotedContent}\n---\n${messageText || message || ''}`.trim();

    // 清除引用状态
    appState.currentQuote = null;
    updateQuoteUI();
    console.log('✅ 引用内容已添加到消息');
  }

  // 构建带附件的用户消息
  const userMsg = {
    role: 'user',
    content: finalMessageContent,
    created_at: new Date().toISOString()
  };

  // 如果有附件，添加到消息中
  if (currentAttachment) {
    userMsg.attachments = [{
      type: currentAttachment.type,  // 'image', 'audio', 'video'
      data: currentAttachment.data,  // Base64 data URL
      fileName: currentAttachment.fileName
    }];
    console.log(`📎 消息包含附件: ${currentAttachment.type} - ${currentAttachment.fileName}`);
  }

  appState.messages.push(userMsg);
  renderMessages();

  // 构建发送给服务器的消息数组（包含附件信息）
  const messages = appState.messages.map(m => {
    const msgObj = {
      role: m.role,
      content: m.content
    };
    // 如果有附件，也传递给服务器
    // 🔧 增强防御性检查：确保 attachments 是数组
    let attachments = m.attachments;
    // 如果是字符串（从数据库加载的JSON），尝试解析
    if (typeof attachments === 'string') {
      try {
        attachments = JSON.parse(attachments);
      } catch (e) {
        attachments = [];
      }
    }
    // 确保是数组且非空
    if (Array.isArray(attachments) && attachments.length > 0) {
      msgObj.attachments = attachments;
    }
    return msgObj;
  });

  // ==================== ChatFlow 画布上下文注入 ====================
  // 如果在 ChatFlow iframe 模式下，将画布上下文附加到最后一条用户消息
  if (isChatFlowIframeMode && chatFlowCanvasContext) {
    const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf('user');
    if (lastUserMsgIndex >= 0) {
      messages[lastUserMsgIndex] = {
        ...messages[lastUserMsgIndex],
        content: messages[lastUserMsgIndex].content + '\n\n' + chatFlowCanvasContext
      };
      console.log('📋 已注入画布上下文到用户消息');
    }
  }

  // 清除当前附件
  const hadAttachment = !!currentAttachment;
  currentAttachment = null;
  updateAttachmentUI();  // 更新UI显示

  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');

  if (sendBtn) sendBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = 'flex';

  appState.isStreaming = true;

  const aiMsgDiv = document.createElement('div');
  aiMsgDiv.className = 'message assistant';
  const thinkingLabelText = '';

  // 根据当前模式确定初始加载状态文本
  const initialStatusText = appState.internetMode
    ? (appState.language === 'zh-CN' ? '联网搜索中...' : 'Searching...')
    : (appState.thinkingMode
      ? (appState.language === 'zh-CN' ? '推理中...' : 'Reasoning...')
      : (appState.language === 'zh-CN' ? '思考中...' : 'Thinking...'));

  aiMsgDiv.innerHTML = `
        <div class="message-avatar">
          ${getSvgIcon('rai_logo_colored', 'material-symbols-outlined ai-avatar processing', 28)}
          <span class="loading-status" id="loadingStatus">
            <svg class="status-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 4V2C6.48 2 2 6.48 2 12h2c0-4.41 3.59-8 8-8z"/>
            </svg>
            <span id="loadingStatusText">${initialStatusText}</span>
          </span>
        </div>
        <div class="message-content">
          <!-- 搜索状态显示区域 -->
          <div class="search-status" id="searchStatus" style="display: none;">
            <span id="searchStatusText">正在分析问题...</span>
          </div>
          
          <!-- 新版时间轴思考UI -->
          <div class="thinking-timeline" id="thinkingTimeline" style="display: none;">
            <!-- 步骤1: 分析问题 -->
            <div class="thinking-step" id="stepToolDecision" data-status="pending">
              <div class="thinking-step-node"></div>
              <div class="thinking-step-content">
                <div class="thinking-step-title">${appState.language === 'zh-CN' ? 'RAI正在分析问题' : 'RAI Analyzing'}</div>
                <div class="thinking-step-detail" id="toolDecisionDetail"></div>
              </div>
            </div>
            
            <!-- 步骤2: 生成回答 -->
            <div class="thinking-step" id="stepGenerating" data-status="pending">
              <div class="thinking-step-node"></div>
              <div class="thinking-step-content">
                <div class="thinking-step-title">${appState.language === 'zh-CN' ? '生成回答' : 'Generating Response'}</div>
                <div class="thinking-step-detail" id="generatingDetail"></div>
              </div>
            </div>
            
            <!-- 步骤3: 深度思考 (仅在思考模式下显示) -->
            <div class="thinking-step" id="stepDeepThinking" data-status="pending" style="${appState.thinkingMode ? '' : 'display: none;'}">
              <div class="thinking-step-node"></div>
              <div class="thinking-step-content">
                <button class="deep-thinking-toggle" id="deepThinkingToggle">
                  <span>${appState.language === 'zh-CN' ? '深度思考' : 'Deep Thinking'}</span>
                  <span class="toggle-icon">▼</span>
                </button>
                <div class="deep-thinking-content" id="deepThinkingContent"></div>
              </div>
            </div>
          </div>
          
          <div class="message-text" id="streamingContent"></div>
        </div>
      `;

  const messagesList = document.getElementById('messagesList');
  if (messagesList) {
    messagesList.appendChild(aiMsgDiv);
  }

  // 添加思考折叠功能的事件监听器
  // 添加深度思考折叠功能的事件监听器
  const deepThinkingToggle = aiMsgDiv.querySelector('#deepThinkingToggle');
  if (deepThinkingToggle) {
    deepThinkingToggle.addEventListener('click', function () {
      const content = aiMsgDiv.querySelector('#deepThinkingContent');
      const isExpanded = content.classList.contains('expanded');

      if (isExpanded) {
        content.classList.remove('expanded');
        this.classList.remove('expanded');
      } else {
        content.classList.add('expanded');
        this.classList.add('expanded');
      }
    });
  }

  scrollToBottom();

  // 时间轴元素引用
  const thinkingTimeline = aiMsgDiv.querySelector('#thinkingTimeline');
  const stepToolDecision = aiMsgDiv.querySelector('#stepToolDecision');
  const stepGenerating = aiMsgDiv.querySelector('#stepGenerating');
  const stepDeepThinking = aiMsgDiv.querySelector('#stepDeepThinking');
  const toolDecisionDetail = aiMsgDiv.querySelector('#toolDecisionDetail');
  const generatingDetail = aiMsgDiv.querySelector('#generatingDetail');
  const deepThinkingContent = aiMsgDiv.querySelector('#deepThinkingContent');

  // 更新步骤状态的辅助函数
  function updateStepStatus(element, status, detail = '') {
    if (!element) return;
    element.setAttribute('data-status', status);
    const detailEl = element.querySelector('.thinking-step-detail');
    if (detailEl && detail) {
      detailEl.textContent = detail;
    }
  }

  let fullContent = '';
  let reasoningContent = '';
  let thinkingSentences = [];
  let isThinkingPhase = false;
  let currentSources = [];  // 存储联网搜索来源
  let currentSearchQuery = '';  // 存储搜索词供时间轴显示和保存
  let toolMarkerCarry = '';
  let inToolCallSection = false;
  const TOOL_CALL_SECTION_START = '<|tool_calls_section_begin|>';
  const TOOL_CALL_SECTION_END = '<|tool_calls_section_end|>';

  function sanitizeToolCallArtifacts(chunk = '') {
    if (!chunk) return '';

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
  }

  try {
    const response = await fetch(`${API_BASE}/chat/stream`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sessionId: appState.currentSession.id,
        messages: messages,
        model: appState.selectedModel,
        thinkingMode: appState.thinkingMode,
        thinkingBudget: appState.thinkingBudget,
        internetMode: appState.internetMode,
        temperature: appState.temperature,
        top_p: appState.topP,
        max_tokens: appState.maxTokens,
        frequency_penalty: appState.frequencyPenalty,
        presence_penalty: appState.presencePenalty,
        systemPrompt: appState.systemPrompt.trim()
          ? `${BUILT_IN_SYSTEM_PROMPT}\n\n以下是用户个人偏好，请参考：\n${appState.systemPrompt}`
          : BUILT_IN_SYSTEM_PROMPT,
        // RAG参数
        spaceId: appState.currentSpaceId,
        useRag: appState.useRag,
        ragTopK: appState.ragTopK
      })
    });

    const modelUsed = response.headers.get('X-Model-Used');
    const routingReason = response.headers.get('X-Model-Reason');

    if (modelUsed) {
      appState.lastModelUsed = modelUsed;
      appState.lastRoutingReason = routingReason || '';
      console.log(`✅ 实际使用模型: ${modelUsed}`);
      console.log(`   选择原因: ${appState.lastRoutingReason}`);

      if (appState.selectedModel === 'auto') {
        showModelRoutingInfo(modelUsed, appState.lastRoutingReason);
      }
    }

    appState.currentRequestId = response.headers.get('X-Request-ID');

    if (!response.body) {
      throw new Error('响应体为空');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 显示时间轴并初始化状态
    if (thinkingTimeline) {
      thinkingTimeline.style.display = 'block';
      updateStepStatus(stepToolDecision, 'active', appState.language === 'zh-CN' ? '正在判断...' : 'Deciding...');
    }

    // 隐藏加载状态
    const loadingStatus = document.getElementById('loadingStatus');
    if (loadingStatus) loadingStatus.style.display = 'none';

    const streamingEl = document.getElementById('streamingContent');
    const aiAvatar = aiMsgDiv.querySelector('.ai-avatar');

    // 🎨 多图防抖动缓存（状态外置 + 缓存注入）
    const lastValidMermaids = {}; // 格式: { "0": "code...", "1": "code..." }
    const renderedSvgs = {};      // 格式: { "0": "<svg>...</svg>", "1": "<svg>...</svg>" }

    // ==================== AI Smooth Fusion 渲染队列 ====================
    let charRenderQueue = [];  // 字符渲染队列
    let charRenderTimer = null;  // 渲染定时器
    let isCharRendering = false;  // 渲染状态
    let displayedContent = '';  // 已显示的内容
    let lastMarkdownRender = 0;  // 上次 Markdown 渲染时间
    let lastMermaidRender = 0;  // 上次 Mermaid 渲染时间
    const CHAR_RENDER_INTERVAL = 12;  // 字符渲染间隔 (ms)
    const MARKDOWN_RENDER_INTERVAL = 700;  // Markdown 渲染间隔 (ms) - 足够让动画可见
    const MERMAID_RENDER_INTERVAL = 500;  // 🎨 Mermaid 渲染间隔 (ms) - 更快以实现实时效果
    const MAX_ANIMATED_CHARS = 5;  // 最多同时动画的字符数

    // 对最后 N 个字符添加动画效果
    function applyCharAnimations(container) {
      if (!container) return;

      // 获取所有文本节点
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
      const textNodes = [];
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent.trim()) textNodes.push(node);
      }

      if (textNodes.length === 0) return;

      // 获取最后一个有内容的文本节点
      const lastTextNode = textNodes[textNodes.length - 1];
      const text = lastTextNode.textContent;

      if (text.length <= MAX_ANIMATED_CHARS) {
        // 整个节点都需要动画
        const wrapper = document.createElement('span');
        wrapper.className = 'streaming-char';
        wrapper.textContent = text;
        lastTextNode.parentNode.replaceChild(wrapper, lastTextNode);
      } else {
        // 只对最后 N 个字符添加动画
        const normalText = text.slice(0, -MAX_ANIMATED_CHARS);
        const animatedText = text.slice(-MAX_ANIMATED_CHARS);

        const fragment = document.createDocumentFragment();
        fragment.appendChild(document.createTextNode(normalText));

        const animSpan = document.createElement('span');
        animSpan.className = 'streaming-char';
        animSpan.textContent = animatedText;
        fragment.appendChild(animSpan);

        lastTextNode.parentNode.replaceChild(fragment, lastTextNode);
      }
    }

    // 执行 Markdown 渲染 + 动画 + Citations + 🎨 内联 Mermaid 替换
    function renderStreamingContent() {
      if (!streamingEl || !displayedContent) return;

      const contentToDisplay = displayedContent.replace(/<<<.{1,30}>>>\s*$/g, '').trim();
      let html = renderMarkdownWithMath(contentToDisplay, true);

      // 处理 citations（如果有 sources）
      if (currentSources && currentSources.length > 0) {
        html = renderCitations(html, currentSources);
      }

      // 🎨 核心逻辑：将 Mermaid 代码块就地替换为图表容器（缓存注入）
      let diagramCount = 0;
      html = html.replace(
        /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi,
        (match, codeContent) => {
          const currentId = diagramCount++;

          // 解码 HTML 实体
          const decodedCode = codeContent
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();

          // 从缓存获取 SVG（如果没有，显示加载动画）
          const cachedSVG = renderedSvgs[currentId] || `
                <div class="mermaid-loading"><span>图表 ${currentId + 1} 渲染中...</span></div>
              `;

          // 返回内联图表容器（隐藏代码，只显示图表）
          return `
                <div class="mermaid-inline-wrapper" data-mermaid-index="${currentId}" data-mermaid-code="${encodeURIComponent(decodedCode)}">
                  <div class="mermaid-preview-container">
                    ${cachedSVG}
                  </div>
                </div>
              `;
        }
      );

      streamingEl.innerHTML = html;
      applyCharAnimations(streamingEl);

      // 🎨 异步渲染所有图表
      const now = Date.now();
      if (now - lastMermaidRender >= MERMAID_RENDER_INTERVAL) {
        tryRenderMermaidLive();
        lastMermaidRender = now;
      }

      // 💻 实时处理代码块：添加语言标签、复制按钮、语法高亮
      processCodeBlocksStreaming(streamingEl);

      scrollToBottom();
    }

    // 🎨 多图防抖动：查找内联 Mermaid 容器并异步渲染
    async function tryRenderMermaidLive() {
      if (typeof mermaid === 'undefined' || !streamingEl) return;

      // 查找所有内联的 Mermaid 包装容器
      const wrappers = streamingEl.querySelectorAll('.mermaid-inline-wrapper');
      if (wrappers.length === 0) return;

      // 遍历每个内联容器
      wrappers.forEach((wrapper) => {
        const index = parseInt(wrapper.getAttribute('data-mermaid-index'), 10);
        const code = decodeURIComponent(wrapper.getAttribute('data-mermaid-code') || '');

        if (!code || isNaN(index)) return;

        // 跳过未变化的代码（防抖核心）
        if (code === lastValidMermaids[index]) return;

        // 异步渲染（不阻塞主流程）
        (async () => {
          try {
            // 1. 预检查语法
            await mermaid.parse(code);

            // 2. 渲染 SVG
            const svgId = `mermaid-inline-svg-${index}-${Date.now()}`;
            const { svg } = await mermaid.render(svgId, code);

            // 3. 缓存结果
            renderedSvgs[index] = svg;
            lastValidMermaids[index] = code;

            // 4. 直接更新内联容器的 DOM（如果它还存在）
            const currentWrapper = streamingEl.querySelector(`.mermaid-inline-wrapper[data-mermaid-index="${index}"]`);
            if (currentWrapper) {
              const previewContainer = currentWrapper.querySelector('.mermaid-preview-container');
              if (previewContainer) {
                previewContainer.innerHTML = svg;
                currentWrapper.classList.add('rendered');
              }
            }
            // console.log(`✅ Mermaid 图表 #${index + 1} 实时渲染成功`);
          } catch (err) {
            // 渲染失败：保持上一帧（缓存中的 SVG 会在下次 renderStreamingContent 时自动注入）
            // console.debug(`⏳ Mermaid 图表 #${index + 1} 语法不完整，保持上一帧`);
          }
        })();
      });
    }

    // 字符级渲染消费者
    function processCharQueue() {
      if (charRenderQueue.length > 0) {
        // 批量处理队列中的字符
        const char = charRenderQueue.shift();
        displayedContent += char;

        // 节流 Markdown 渲染：每 100ms 渲染一次
        const now = Date.now();
        if (now - lastMarkdownRender >= MARKDOWN_RENDER_INTERVAL) {
          renderStreamingContent();
          lastMarkdownRender = now;
        }

        charRenderTimer = setTimeout(processCharQueue, CHAR_RENDER_INTERVAL);
      } else {
        // 队列空，执行最终渲染确保内容完整
        if (displayedContent) {
          renderStreamingContent();
        }
        charRenderTimer = setTimeout(processCharQueue, 20);
      }
    }

    // 停止字符渲染
    function stopCharRender() {
      if (charRenderTimer) {
        clearTimeout(charRenderTimer);
        charRenderTimer = null;
      }
      isCharRendering = false;
      // 最终渲染确保 Markdown 完整（包含 citations 和 Mermaid）
      if (displayedContent && streamingEl) {
        // 🔧 修复：使用 renderStreamingContent 保持 Mermaid 内联渲染逻辑一致
        renderStreamingContent();

        // 移除所有动画类（流结束）
        streamingEl.querySelectorAll('.streaming-char').forEach(el => {
          el.classList.remove('streaming-char');
        });

        // 🔧 修复：最终 Mermaid 渲染（同时支持两种容器格式）
        setTimeout(() => {
          tryRenderMermaidLive();  // 处理 .mermaid-inline-wrapper
          renderMermaidCharts();   // 处理 .mermaid-container (兼容历史消息)
        }, 100);

        // 💻 处理代码块：添加语言标签、复制按钮、语法高亮
        setTimeout(() => processCodeBlocks(streamingEl?.closest('.message')), 50);
      }
    }
    // ==================== 渲染队列结束 ====================

    function appendThinkingSentence(sentence) {
      if (!thinkingEl || !sentence.trim()) return;

      const sentenceSpan = document.createElement('span');
      sentenceSpan.className = 'thinking-sentence';
      // 识别**文本**格式并转换为<strong>标签
      const formattedText = sentence.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      sentenceSpan.innerHTML = formattedText;
      thinkingEl.appendChild(sentenceSpan);
      scrollToBottom();
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.type === 'reasoning') {
            // 进入深度思考阶段
            if (!isThinkingPhase) {
              isThinkingPhase = true;

              // 显示时间轴
              if (thinkingTimeline) thinkingTimeline.style.display = 'block';

              // 更新步骤状态：工具决策完成，深度思考进行中
              updateStepStatus(stepToolDecision, 'done', appState.language === 'zh-CN' ? '已完成判断' : 'Completed');
              updateStepStatus(stepDeepThinking, 'thinking', '');

              // 显示深度思考步骤（如果之前隐藏了）
              if (stepDeepThinking) stepDeepThinking.style.display = '';

              // 更新加载状态文本
              const loadingStatusText = document.getElementById('loadingStatusText');
              if (loadingStatusText) {
                loadingStatusText.textContent = appState.language === 'zh-CN' ? '深度思考中...' : 'Deep Thinking...';
              }

              // 添加AI头像闪烁效果
              if (aiAvatar) {
                aiAvatar.classList.add('thinking');
                aiAvatar.classList.remove('processing');
              }

              // 隐藏加载状态提示
              const loadingStatus = document.getElementById('loadingStatus');
              if (loadingStatus) loadingStatus.style.display = 'none';
            }

            reasoningContent += parsed.content;

            // 实时更新深度思考内容
            if (deepThinkingContent) {
              // 获取或创建正在输入的临时元素
              let currentTyping = deepThinkingContent.querySelector('.thinking-current-typing');
              if (!currentTyping) {
                currentTyping = document.createElement('span');
                currentTyping.className = 'thinking-sentence thinking-current-typing';
                deepThinkingContent.appendChild(currentTyping);
              }

              // 格式化并显示内容
              const formattedText = reasoningContent.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
              currentTyping.innerHTML = formattedText;

              // 如果深度思考区域已展开，滚动到底部
              if (deepThinkingContent.classList.contains('expanded')) {
                deepThinkingContent.scrollTop = deepThinkingContent.scrollHeight;
              }
            }


            scrollToBottom();
          }
          else if (parsed.type === 'content') {
            // 隐藏加载状态提示（首次收到内容时）
            if (!isThinkingPhase) {
              const loadingStatus = document.getElementById('loadingStatus');
              if (loadingStatus) loadingStatus.style.display = 'none';
              if (aiAvatar) aiAvatar.classList.remove('processing');

              // 非思考模式：直接更新步骤状态
              if (stepToolDecision.getAttribute('data-status') !== 'done') {
                updateStepStatus(stepToolDecision, 'done', appState.language === 'zh-CN' ? '已完成判断' : 'Completed');
                // 隐藏深度思考步骤（非思考模式）
                if (stepDeepThinking && !appState.thinkingMode) {
                  stepDeepThinking.style.display = 'none';
                }
                updateStepStatus(stepGenerating, 'active', appState.language === 'zh-CN' ? '正在生成...' : 'Generating...');
              }
            }

            // 思考阶段结束，开始生成正文
            if (isThinkingPhase) {
              isThinkingPhase = false;

              // 移除深度思考中的临时输入元素
              if (deepThinkingContent) {
                const currentTyping = deepThinkingContent.querySelector('.thinking-current-typing');
                if (currentTyping) {
                  // 将临时内容转为正式内容
                  currentTyping.classList.remove('thinking-current-typing');
                }
              }

              // 更新步骤状态：深度思考完成，生成回答进行中
              updateStepStatus(stepDeepThinking, 'done', appState.language === 'zh-CN' ? '思考完成' : 'Completed');
              updateStepStatus(stepGenerating, 'active', appState.language === 'zh-CN' ? '正在组织语言...' : 'Organizing response...');

              // 停止AI头像闪烁
              if (aiAvatar) aiAvatar.classList.remove('thinking');
            }

            // 现在开始显示正文 - 使用字符级渲染队列
            const cleanChunk = sanitizeToolCallArtifacts(parsed.content || '');
            if (!cleanChunk) {
              continue;
            }
            fullContent += cleanChunk;

            // 将新字符推入渲染队列（而非直接渲染整个内容）
            const newChars = cleanChunk;
            for (const char of newChars) {
              charRenderQueue.push(char);
            }

            // 启动渲染消费者（如果尚未启动）
            if (!isCharRendering) {
              isCharRendering = true;
              processCharQueue();
            }
          }
          else if (parsed.type === 'title') {
            // 处理标题更新
            if (parsed.title && appState.currentSession) {
              appState.currentSession.title = parsed.title;
              console.log(`✅ 会话标题已更新: "${parsed.title}"`);
              loadSessions().catch(err => console.error('刷新会话列表失败:', err));

              // 新增：如果处于 ChatFlow iframe 模式，同步标题给父窗口
              if (isChatFlowIframeMode) {
                console.log('📤 同步标题给 Chat Flow:', parsed.title);
                window.parent.postMessage({
                  action: 'update-flow-title',
                  title: parsed.title
                }, '*');
              }
            }
          }
          // 新增：处理模型信息（显示实际使用的模型）
          else if (parsed.type === 'model_info') {
            appState.lastModelUsed = parsed.model;
            appState.lastRoutingReason = parsed.reason || '';
            console.log(`📍 实际使用模型: ${parsed.model} (${parsed.actualModel})`);
            console.log(`   路由原因: ${parsed.reason || '用户选择'}`);

            // 如果模型与用户选择的不同，显示通知
            if (parsed.model !== appState.selectedModel && appState.selectedModel !== 'auto') {
              showModelRoutingInfo(parsed.model, parsed.reason);
            }
          }
          // 新增：处理搜索来源
          else if (parsed.type === 'sources') {
            if (parsed.sources && Array.isArray(parsed.sources)) {
              currentSources = parsed.sources;
              console.log(`📥 收到 ${currentSources.length} 个搜索来源:`, currentSources.map(s => s.title));
            }
          }
          // 🔍 处理搜索状态 - 更新到时间轴第一步
          else if (parsed.type === 'search_status') {
            if (parsed.status === 'analyzing') {
              // 正在分析是否需要搜索
              updateStepStatus(stepToolDecision, 'active', appState.language === 'zh-CN' ? '正在分析问题...' : 'Analyzing...');
            } else if (parsed.status === 'searching') {
              // 保存搜索词供后续使用
              currentSearchQuery = parsed.query || '';
              // 决定使用搜索工具，显示搜索词
              updateStepStatus(stepToolDecision, 'active', appState.language === 'zh-CN'
                ? `联网搜索: "${currentSearchQuery}"`
                : `Web search: "${currentSearchQuery}"`);
            } else if (parsed.status === 'complete') {
              const resultCount = parsed.resultCount || 0;
              currentSearchQuery = parsed.query || currentSearchQuery || '';
              // 搜索完成
              updateStepStatus(stepToolDecision, 'done', appState.language === 'zh-CN'
                ? `搜索完成 → ${resultCount}条结果`
                : `Search done → ${resultCount} results`);
              // 开始生成回答
              updateStepStatus(stepGenerating, 'active', appState.language === 'zh-CN' ? '正在生成...' : 'Generating...');
            } else if (parsed.status === 'no_search') {
              // 不需要搜索
              updateStepStatus(stepToolDecision, 'done', appState.language === 'zh-CN' ? '不需要联网' : 'No search needed');
            } else if (parsed.status === 'no_results') {
              currentSearchQuery = parsed.query || currentSearchQuery || '';
              // 搜索无结果
              updateStepStatus(stepToolDecision, 'done', appState.language === 'zh-CN'
                ? `搜索完成 → 无结果`
                : `Search done → No results`);
            }
            scrollToBottom();
          }
          else if (parsed.type === 'done') {
            console.log('✅ 流式响应完成');

            // 停止字符渲染队列
            stopCharRender();

            // 更新步骤状态：生成回答完成
            updateStepStatus(stepGenerating, 'done', appState.language === 'zh-CN' ? '生成完成' : 'Completed');

            // 停止AI头像闪烁
            if (aiAvatar) aiAvatar.classList.remove('thinking');
          }
          else if (parsed.type === 'cancelled') {
            console.log('⚠️ 响应已取消');
            stopCharRender();  // 停止字符渲染
            // 停止AI头像闪烁
            if (aiAvatar) aiAvatar.classList.remove('thinking');
            break;
          }
          else if (parsed.type === 'error') {
            stopCharRender();  // 停止字符渲染
            // 停止AI头像闪烁
            if (aiAvatar) aiAvatar.classList.remove('thinking');
            alert((appState.language === 'zh-CN' ? 'AI服务错误: ' : 'AI Service Error: ') + (parsed.error || '未知错误'));
            break;
          }
        } catch (e) {
          console.error('⚠️ 解析响应错误:', e);
        }
      }
    }

    // 确保停止AI头像闪烁
    if (aiAvatar) aiAvatar.classList.remove('thinking');

    // 合并所有思考句子
    const finalReasoningContent = thinkingSentences.join('') + reasoningContent.trim();

    // 移除标题标记后再保存到appState
    const cleanContent = fullContent
      .replace(/<<<.{1,30}>>>\s*$/g, '')
      .replace(/<\|[^|]+\|>/g, '')
      .replace(/functions\.web_search:\d+/g, '')
      .trim();

    const aiMsg = {
      role: 'assistant',
      content: cleanContent,
      reasoning_content: finalReasoningContent || null,
      model: appState.lastModelUsed || appState.selectedModel,
      enable_search: appState.internetMode,
      internet_mode: appState.internetMode,
      sources: currentSources.length > 0 ? currentSources : null,  // 新增：存储来源
      created_at: new Date().toISOString()
    };
    appState.messages.push(aiMsg);

    // 重新渲染所有消息以显示元信息和复制按钮
    renderMessages();

    await loadSessions();

  } catch (error) {
    console.error('❌ 发送消息错误:', error);
    alert(appState.language === 'zh-CN' ? '发送失败,请检查网络连接' : 'Send failed, check network');
    // 确保停止AI头像闪烁
    const aiAvatar = document.querySelector('.message.assistant:last-child .ai-avatar');
    if (aiAvatar) aiAvatar.classList.remove('thinking');
  } finally {
    if (sendBtn) sendBtn.style.display = 'flex';
    if (stopBtn) stopBtn.style.display = 'none';
    appState.isStreaming = false;
    appState.currentRequestId = null;

    // 重置联网模式为开启状态（用户关闭仅限本次）
    appState.internetMode = true;
    updateToolbarUI();

    // 修复：在流式传输结束后处理标题
    // 提取标题 <<<标题>>> - 匹配回复末尾的三角括号内容
    const titleMatch = fullContent.match(/<<<(.{1,30})>>>\s*$/);
    if (titleMatch && titleMatch[1]) {
      const newTitle = titleMatch[1].trim();
      console.log(`📝 检测到新标题: "${newTitle}"`);

      if (appState.currentSession) {
        // 1. 更新本地状态
        appState.currentSession.title = newTitle;

        // 2. 更新服务器
        fetch(`${API_BASE}/sessions/${appState.currentSession.id}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${appState.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ title: newTitle })
        }).then(() => {
          console.log('✅ 标题已同步到服务器');
          // 3. 刷新侧边栏
          loadSessions();
        }).catch(err => console.error('❌ 同步标题失败:', err));
      }
    }
  }
}

// 修复：改进stopGeneration函数
async function stopGeneration() {
  if (!appState.currentRequestId) {
    console.warn('⚠️ 没有活跃的请求');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/chat/stop`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requestId: appState.currentRequestId
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    console.log('🛑 已发送停止请求');
  } catch (error) {
    console.error('❌ 停止失败:', error);
  }
}

// 修复：改进handleInputKeydown
function handleInputKeydown(event) {
  if (!event) return;

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

// 修复：改进autoResizeInput
function autoResizeInput() {
  const input = document.getElementById('messageInput');
  if (!input) return;

  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}

// 显示按钮悬浮提示
function showButtonTooltip(buttonElement, tooltipText) {
  if (!buttonElement) return;

  const buttonRect = buttonElement.getBoundingClientRect();
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip-popup';
  tooltip.textContent = tooltipText;

  // 定位在按钮上方
  document.body.appendChild(tooltip);
  const tooltipRect = tooltip.getBoundingClientRect();
  tooltip.style.left = `${buttonRect.left + (buttonRect.width - tooltipRect.width) / 2}px`;
  tooltip.style.top = `${buttonRect.top - tooltipRect.height - 8}px`;

  // 1秒后自动移除
  setTimeout(() => {
    if (tooltip.parentNode) {
      tooltip.parentNode.removeChild(tooltip);
    }
  }, 1000);
}

// 修复：改进handleFileUpload，添加悬浮提示
function handleFileUpload() {
  const fileInput = document.getElementById('fileInput');
  const attachBtn = document.getElementById('attachBtn');
  if (!fileInput) {
    console.error('❌ 文件输入框未找到');
    return;
  }

  // 显示提示
  const tooltipText = appState.language === 'zh-CN' ? '附件' : 'Attach';
  showButtonTooltip(attachBtn, tooltipText);

  // 清除之前的值，确保可以重复选择同一文件
  fileInput.value = '';
  fileInput.click();
}

// 切换联网模式
function toggleInternet() {
  appState.internetMode = !appState.internetMode;
  updateToolbarUI();

  const internetBtn = document.getElementById('internetBtn');
  const tooltipText = appState.language === 'zh-CN' ? '联网' : 'Internet';
  showButtonTooltip(internetBtn, tooltipText);

  console.log(`🌐 联网模式: ${appState.internetMode ? '开启' : '关闭'}`);
}

// 切换推理模式
function toggleThinking() {
  const modelConfig = MODELS[appState.selectedModel];
  if (!modelConfig || !modelConfig.supportsThinking) {
    const msg = appState.language === 'zh-CN'
      ? '当前模型不支持推理模式'
      : 'Current model does not support thinking mode';
    alert(msg);
    return;
  }

  appState.thinkingMode = !appState.thinkingMode;
  updateToolbarUI();

  const thinkingBtn = document.getElementById('thinkingBtn');
  const tooltipText = appState.language === 'zh-CN' ? '推理' : 'Reasoning';
  showButtonTooltip(thinkingBtn, tooltipText);

  console.log(`🧠 推理模式: ${appState.thinkingMode ? '开启' : '关闭'}`);
}

// 修复：改进handleFileSelected - 添加完整的错误处理
function handleFileSelected(event) {
  if (!event || !event.target) {
    console.error('❌ 事件对象无效');
    return;
  }

  const files = event.target.files;
  if (!files || files.length === 0) {
    console.warn('⚠️ 未选择文件');
    return;
  }

  const file = files[0];
  console.log(`✅ 选中文件: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`);

  // 文件类型验证
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'];
  if (!allowedTypes.includes(file.type)) {
    const msg = appState.language === 'zh-CN'
      ? `不支持的文件类型: ${file.type}\n支持的类型: 图片(JPG, PNG, GIF, WebP), PDF, 文本文件`
      : `Unsupported file type: ${file.type}\nSupported: Images (JPG, PNG, GIF, WebP), PDF, Text`;
    alert(msg);
    return;
  }

  // 文件大小验证 (最大10MB)
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    const msg = appState.language === 'zh-CN'
      ? `文件过大: ${(file.size / 1024 / 1024).toFixed(2)} MB\n最大支持: 10 MB`
      : `File too large: ${(file.size / 1024 / 1024).toFixed(2)} MB\nMax size: 10 MB`;
    alert(msg);
    return;
  }

  // TODO: 实现文件上传到服务器的逻辑
  // 这里应该将文件上传到后端，并获取URL或ID
  // 然后可以在发送消息时附加文件信息
  console.log('📎 文件已准备，等待上传实现');

  // 临时提示用户
  const msg = appState.language === 'zh-CN'
    ? `文件 "${file.name}" 已选择\n注意: 文件上传功能尚未完全实现`
    : `File "${file.name}" selected\nNote: File upload not fully implemented yet`;
  alert(msg);
}

// 修复：改进showModelRoutingInfo
function showModelRoutingInfo(modelUsed, reason) {
  console.log(`🤖 [Auto路由] 使用模型: ${modelUsed}, 原因: ${reason}`);
}

// 修复：改进handleViewportResize
function handleViewportResize() {
  // 处理viewport变化时的布局调整
  console.log('📱 Viewport已调整大小');
}

// ==================== 认证相关 ====================
// 兼容旧代码的handleLogin函数 - 实际调用新的handleAuthSubmit
async function handleLogin(event) {
  if (event) event.preventDefault();
  // 设置为登录模式
  appState.authMode = 'login';
  await handleAuthSubmit();
}

async function handleRegister(event) {
  event.preventDefault();

  const email = document.getElementById('registerEmail').value;
  const password = document.getElementById('registerPassword').value;
  const username = document.getElementById('registerUsername').value;
  const registerBtn = document.getElementById('registerBtn');
  const errorEl = document.getElementById('registerError');

  registerBtn.disabled = true;
  registerBtn.innerHTML = '<span class="loading"></span> ' + (appState.language === 'zh-CN' ? '注册中...' : 'Registering...');
  errorEl.classList.remove('show');

  try {
    const response = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, username })
    });

    const data = await response.json();

    if (data.success) {
      appState.token = data.token;
      appState.user = data.user;
      localStorage.setItem('rai_token', data.token);

      showApp();
      await loadUserData();
    } else {
      showError(errorEl, data.error || (appState.language === 'zh-CN' ? '注册失败' : 'Registration failed'));
    }
  } catch (error) {
    showError(errorEl, appState.language === 'zh-CN' ? '网络错误,请检查服务器连接' : 'Network error');
    console.error('❌ 注册错误:', error);
  } finally {
    registerBtn.disabled = false;
    registerBtn.textContent = appState.language === 'zh-CN' ? '注册' : 'Register';
  }
}

async function verifyToken() {
  try {
    const response = await fetch(`${API_BASE}/auth/verify`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    const data = await response.json();

    if (data.success) {
      appState.user = data.user;
      showApp();
      await loadUserData();
    } else {
      localStorage.removeItem('rai_token');
      appState.token = null;
    }
  } catch (error) {
    console.error('❌ 验证token失败:', error);
    localStorage.removeItem('rai_token');
    appState.token = null;
  }
}

function handleLogout() {
  const confirmMsg = appState.language === 'zh-CN' ? '确定要退出登录吗?' : 'Are you sure you want to logout?';
  if (confirm(confirmMsg)) {
    // 清除所有认证 token
    localStorage.removeItem(RAUTH_TOKEN_KEY);
    localStorage.removeItem(RAI_TOKEN_KEY);
    appState.token = null;
    appState.user = null;
    appState.sessions = [];
    appState.currentSession = null;

    // 重定向到 RAuth 登录页面
    redirectToRAuth();
  }
}

function switchToRegister() {
  // 兼容旧代码，调用新的切换函数
  switchAuthMode();
}

function switchToLogin() {
  // 兼容旧代码，调用新的切换函数
  if (appState.authMode === 'register') {
    switchAuthMode();
  }
}

// ==================== Apple风格渐进式登录系统 ====================
// 当前认证模式: 'login' | 'register'
appState.authMode = 'login';
// 邮箱是否已验证（显示了密码框）
appState.authEmailValidated = false;

// 邮箱输入处理 - 检测有效邮箱后显示密码框
function handleEmailInput(input) {
  const email = input.value.trim();
  const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  if (isValidEmail && !appState.authEmailValidated) {
    // 显示密码框和提交按钮
    showAuthStep('passwordStep');
    showAuthStep('submitStep');
    appState.authEmailValidated = true;

    // 如果是注册模式，也显示用户名输入框
    if (appState.authMode === 'register') {
      showAuthStep('usernameStep');
    }

    // 自动聚焦到密码框
    setTimeout(() => {
      document.getElementById('authPassword')?.focus();
    }, 300);
  } else if (!isValidEmail && appState.authEmailValidated) {
    // 邮箱变为无效，隐藏后续步骤
    hideAuthStep('passwordStep');
    hideAuthStep('usernameStep');
    hideAuthStep('submitStep');
    appState.authEmailValidated = false;
  }
}

// 邮箱输入框按键处理 - Enter键触发验证
function handleEmailKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    const input = document.getElementById('authEmail');
    const email = input.value.trim();
    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (isValidEmail) {
      if (!appState.authEmailValidated) {
        handleEmailInput(input);
      } else {
        // 已经显示了密码框，聚焦到密码框
        document.getElementById('authPassword')?.focus();
      }
    } else {
      // 显示邮箱格式错误
      showAuthError(appState.language === 'zh-CN' ? '请输入有效的邮箱地址' : 'Please enter a valid email');
    }
  }
}

// 密码输入框按键处理 - Enter键提交表单
function handlePasswordKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleAuthSubmit();
  }
}

// 显示认证步骤
function showAuthStep(stepId) {
  const step = document.getElementById(stepId);
  if (step) {
    step.classList.remove('auth-step-hidden');
    step.classList.add('auth-step-visible');
  }
}

// 隐藏认证步骤
function hideAuthStep(stepId) {
  const step = document.getElementById(stepId);
  if (step) {
    step.classList.remove('auth-step-visible');
    step.classList.add('auth-step-hidden');
  }
}

// 显示认证错误
function showAuthError(message) {
  const errorEl = document.getElementById('authError');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.add('show');
  }
}

// 隐藏认证错误
function hideAuthError() {
  const errorEl = document.getElementById('authError');
  if (errorEl) {
    errorEl.classList.remove('show');
  }
}

// 切换登录/注册模式
function switchAuthMode() {
  const isLogin = appState.authMode === 'login';
  appState.authMode = isLogin ? 'register' : 'login';

  // 更新标题和副标题
  const title = document.getElementById('authTitle');
  const subtitle = document.getElementById('authSubtitle');
  const switchText = document.getElementById('authSwitch').querySelector('[data-i18n]');
  const switchLink = document.getElementById('authSwitchLink');
  const submitBtn = document.getElementById('authSubmitBtn');

  if (appState.authMode === 'register') {
    // 切换到注册模式
    if (title) {
      title.textContent = i18n[appState.language]?.['register-title'] || '创建账号';
      title.setAttribute('data-i18n', 'register-title');
    }
    if (subtitle) {
      subtitle.textContent = i18n[appState.language]?.['register-subtitle'] || '加入 RAI 开始对话';
      subtitle.setAttribute('data-i18n', 'register-subtitle');
    }
    if (switchText) {
      switchText.textContent = i18n[appState.language]?.['has-account'] || '已有账号?';
      switchText.setAttribute('data-i18n', 'has-account');
    }
    if (switchLink) {
      switchLink.textContent = i18n[appState.language]?.['login-link'] || '立即登录';
      switchLink.setAttribute('data-i18n', 'login-link');
    }
    if (submitBtn) {
      submitBtn.textContent = i18n[appState.language]?.['register-btn'] || '注册';
      submitBtn.setAttribute('data-i18n', 'register-btn');
    }

    // 如果邮箱已验证，显示用户名输入框
    if (appState.authEmailValidated) {
      showAuthStep('usernameStep');
    }
  } else {
    // 切换到登录模式
    if (title) {
      title.textContent = i18n[appState.language]?.['login-title'] || '欢迎回来';
      title.setAttribute('data-i18n', 'login-title');
    }
    if (subtitle) {
      subtitle.textContent = i18n[appState.language]?.['login-subtitle'] || '登录继续使用 RAI';
      subtitle.setAttribute('data-i18n', 'login-subtitle');
    }
    if (switchText) {
      switchText.textContent = i18n[appState.language]?.['no-account'] || '还没有账号?';
      switchText.setAttribute('data-i18n', 'no-account');
    }
    if (switchLink) {
      switchLink.textContent = i18n[appState.language]?.['register-link'] || '立即注册';
      switchLink.setAttribute('data-i18n', 'register-link');
    }
    if (submitBtn) {
      submitBtn.textContent = i18n[appState.language]?.['login-btn'] || '登录';
      submitBtn.setAttribute('data-i18n', 'login-btn');
    }

    // 隐藏用户名输入框
    hideAuthStep('usernameStep');
  }

  // 清除错误信息
  hideAuthError();
}

// 统一的表单提交处理
async function handleAuthSubmit() {
  const email = document.getElementById('authEmail')?.value.trim();
  const password = document.getElementById('authPassword')?.value;
  const username = document.getElementById('authUsername')?.value.trim();
  const submitBtn = document.getElementById('authSubmitBtn');
  const errorEl = document.getElementById('authError');

  // 基本验证
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showAuthError(appState.language === 'zh-CN' ? '请输入有效的邮箱地址' : 'Please enter a valid email');
    return;
  }

  if (!password || password.length < 6) {
    showAuthError(appState.language === 'zh-CN' ? '密码至少6位字符' : 'Password must be at least 6 characters');
    return;
  }

  hideAuthError();

  // 禁用按钮并显示加载状态
  if (submitBtn) {
    submitBtn.disabled = true;
    const loadingText = appState.authMode === 'login'
      ? (appState.language === 'zh-CN' ? '登录中...' : 'Logging in...')
      : (appState.language === 'zh-CN' ? '注册中...' : 'Registering...');
    submitBtn.innerHTML = '<span class="loading"></span> ' + loadingText;
  }

  try {
    const endpoint = appState.authMode === 'login' ? 'login' : 'register';
    const body = appState.authMode === 'login'
      ? { email, password }
      : { email, password, username };

    const response = await fetch(`${API_BASE}/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.success) {
      appState.token = data.token;
      appState.user = data.user;
      localStorage.setItem('rai_token', data.token);

      showApp();
      await loadUserData();
    } else {
      showAuthError(data.error || (appState.language === 'zh-CN' ? '操作失败' : 'Operation failed'));
    }
  } catch (error) {
    showAuthError(appState.language === 'zh-CN' ? '网络错误,请检查服务器连接' : 'Network error');
    console.error('❌ 认证错误:', error);
  } finally {
    // 恢复按钮状态
    if (submitBtn) {
      submitBtn.disabled = false;
      const btnText = appState.authMode === 'login'
        ? (appState.language === 'zh-CN' ? '登录' : 'Login')
        : (appState.language === 'zh-CN' ? '注册' : 'Register');
      submitBtn.textContent = btnText;
    }
  }
}

function showApp() {
  document.getElementById('authContainer').classList.remove('active');
  document.getElementById('appContainer').style.display = 'flex';

  // 延迟初始化滚动监听器，确保 chatContainer 已存在
  setTimeout(() => {
    initChatScrollListener();
    initChatIndexListener(); // 初始化对话索引导航器监听
    updateToolbarUI();
  }, 100);
}

function showError(element, message) {
  element.textContent = message;
  element.classList.add('show');
}

async function loadUserData() {
  try {
    console.log('📥 加载用户数据...');

    const profileResponse = await fetch(`${API_BASE}/user/profile`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!profileResponse.ok) {
      throw new Error(`HTTP ${profileResponse.status}`);
    }

    const profile = await profileResponse.json();

    const realEmail = appState.user?.email || profile.email || '';
    const displayName = appState.user?.username || profile.username || (realEmail ? realEmail.split('@')[0] : '用户');

    console.log('📧 显示邮箱:', realEmail);

    document.getElementById('userName').textContent = displayName;
    // userEmail 元素已移除，不再显示邮箱在侧边栏
    document.getElementById('userAvatar').textContent = realEmail ? realEmail[0].toUpperCase() : 'U';

    appState.user = {
      username: displayName,
      email: realEmail
    };

    // ✅ 修复：检查profile对象的所有必需字段
    if (profile && typeof profile === 'object') {
      if (profile.temperature !== undefined) appState.temperature = parseFloat(profile.temperature) || 0.7;
      if (profile.top_p !== undefined) appState.topP = parseFloat(profile.top_p) || 0.9;
      if (profile.max_tokens !== undefined) appState.maxTokens = parseInt(profile.max_tokens, 10) || 2000;
      if (profile.frequency_penalty !== undefined) appState.frequencyPenalty = parseFloat(profile.frequency_penalty) || 0;
      if (profile.presence_penalty !== undefined) appState.presencePenalty = parseFloat(profile.presence_penalty) || 0;
      // ✅ 关键修复：正确处理system_prompt，确保始终是字符串
      if (profile.system_prompt !== undefined) {
        appState.systemPrompt = (profile.system_prompt || '');
        console.log(`✅ 加载系统提示词: ${appState.systemPrompt.length}字符`);
      }
      // ✅ 修复：只有用户明确开启了思考模式才覆盖默认值（默认关闭）
      if (profile.thinking_mode === 1 || profile.thinking_mode === true) {
        appState.thinkingMode = true;
      }
      // ✅ 修复：保持联网模式默认开启，除非用户明确关闭
      // 数据库默认值0表示"未设置"，不覆盖前端默认值true
      // 前端已默认开启联网，所以这里不再处理 internet_mode

      updateSettingsUI();
      updateToolbarUI();
      console.log('✅ 用户配置已加载到UI');
    } else {
      console.warn('⚠️ profile对象格式不正确');
    }

    console.log('📋 加载历史会话...');
    await loadSessions();

    if (appState.sessions && appState.sessions.length > 0) {
      console.log(`✅ 找到 ${appState.sessions.length} 个历史会话,自动加载最新会话`);
      await loadSession(appState.sessions[0].id);
    } else {
      console.log('ℹ️ 无历史会话,显示欢迎界面');
      showWelcome();
    }

    console.log('✅ 用户数据加载完成');

    // 🎫 获取并显示会员状态
    await fetchUserMembership();
    updateUserAreaWithMembership();
  } catch (error) {
    console.error('❌ 加载用户数据失败:', error);
    if (error.message.includes('500')) {
      console.warn('⚠️ 用户配置加载失败,使用默认配置继续');
      showWelcome();
    } else {
      alert((appState.language === 'zh-CN' ? '加载失败: ' : 'Load failed: ') + error.message);
    }
  }
}

// ==================== RAG 功能函数 ====================

// 标签页切换
function switchSidebarTab(tabName) {
  const tabs = document.querySelectorAll('.sidebar-tab');
  const tabContents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => tab.classList.remove('active'));
  tabContents.forEach(content => content.classList.remove('active'));

  const activeTab = Array.from(tabs).find(tab =>
    tab.onclick.toString().includes(tabName)
  );
  if (activeTab) activeTab.classList.add('active');

  const activeContent = document.getElementById(
    tabName === 'sessions' ? 'sessionsTab' : 'spacesTab'
  );
  if (activeContent) activeContent.classList.add('active');

  // 切换到空间标签页时加载空间列表
  if (tabName === 'spaces') {
    loadSpaces();
  }
}

// 加载用户空间列表
async function loadSpaces() {
  try {
    const response = await fetch(`${API_BASE}/spaces`, {
      headers: {
        'Authorization': `Bearer ${appState.token}`
      }
    });

    if (!response.ok) throw new Error('加载空间失败');

    const spaces = await response.json();
    appState.spaces = spaces;

    const spacesList = document.getElementById('spacesList');
    if (!spacesList) return;

    if (spaces.length === 0) {
      spacesList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">暂无空间，点击上方创建</div>';
      return;
    }

    spacesList.innerHTML = spaces.map(space => `
          <div class="space-item ${space.id === appState.currentSpaceId ? 'active' : ''}"
               onclick="selectSpace('${space.id}')">
            <div class="space-icon">${space.icon}</div>
            <div class="space-info">
              <div class="space-name">${space.name}</div>
              <div class="space-doc-count">${space.document_count || 0} 个文档</div>
            </div>
            <div class="space-actions" onclick="event.stopPropagation()">
              <button class="space-action-icon delete" onclick="deleteSpace('${space.id}')" title="删除">
                ${getSvgIcon('delete', 'material-symbols-outlined', 24)}
              </button>
            </div>
          </div>
        `).join('');
  } catch (error) {
    console.error('加载空间失败:', error);
  }
}

// 创建新空间
async function createNewSpace() {
  const name = prompt('请输入空间名称:');
  if (!name || !name.trim()) return;

  const icon = prompt('请输入图标 emoji (可选):', '📚');

  try {
    const response = await fetch(`${API_BASE}/spaces`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({
        name: name.trim(),
        description: '',
        icon: icon || '📚'
      })
    });

    if (!response.ok) throw new Error('创建空间失败');

    const { space } = await response.json();
    console.log('✅ 空间创建成功:', space);

    // 重新加载空间列表
    await loadSpaces();
  } catch (error) {
    console.error('创建空间失败:', error);
    alert('创建空间失败: ' + error.message);
  }
}

// 选择空间
async function selectSpace(spaceId) {
  appState.currentSpaceId = spaceId;

  // 更新UI
  const spaceItems = document.querySelectorAll('.space-item');
  spaceItems.forEach(item => item.classList.remove('active'));

  const selectedItem = Array.from(spaceItems).find(item =>
    item.onclick.toString().includes(spaceId)
  );
  if (selectedItem) selectedItem.classList.add('active');

  // 显示空间详情面板
  const spaceDetail = document.getElementById('spaceDetail');
  if (spaceDetail) {
    spaceDetail.classList.add('active');
    const space = appState.spaces.find(s => s.id === spaceId);
    if (space) {
      document.getElementById('spaceDetailTitle').textContent = space.name;
    }
  }

  // 加载文档列表
  await loadDocuments(spaceId);
}

// 加载文档列表
async function loadDocuments(spaceId) {
  try {
    const response = await fetch(`${API_BASE}/spaces/${spaceId}/documents`, {
      headers: {
        'Authorization': `Bearer ${appState.token}`
      }
    });

    if (!response.ok) throw new Error('加载文档失败');

    const documents = await response.json();

    const documentList = document.getElementById('documentList');
    if (!documentList) return;

    if (documents.length === 0) {
      documentList.innerHTML = '<div style="text-align: center; color: var(--text-secondary); padding: 20px;">暂无文档</div>';
      return;
    }

    documentList.innerHTML = documents.map(doc => `
          <div class="document-item">
            <div class="document-info">
              <div class="document-name" title="${doc.original_name}">${doc.original_name}</div>
              <div class="document-meta">${formatFileSize(doc.file_size)} • ${doc.embedding_status === 'completed' ? '✓ 已索引' : '处理中'}</div>
            </div>
            <button class="document-delete" onclick="deleteDocument('${spaceId}', '${doc.id}')" title="删除">
              ${getSvgIcon('delete', 'material-symbols-outlined', 24)}
            </button>
          </div>
        `).join('');
  } catch (error) {
    console.error('加载文档失败:', error);
  }
}

// 上传文档
function uploadDocument() {
  if (!appState.currentSpaceId) {
    alert('请先选择一个空间');
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt,.pdf,.docx';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch(`${API_BASE}/spaces/${appState.currentSpaceId}/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${appState.token}`
        },
        body: formData
      });

      if (!response.ok) throw new Error('上传失败');

      const result = await response.json();
      console.log('✅ 文件上传成功:', result);

      // 重新加载文档列表和空间列表
      await loadDocuments(appState.currentSpaceId);
      await loadSpaces();

      alert(`文件上传成功！\n状态: ${result.document.embedding_status === 'completed' ? '已索引' : '处理中'}`);
    } catch (error) {
      console.error('上传文件失败:', error);
      alert('上传失败: ' + error.message);
    }
  };

  input.click();
}

// 删除文档
async function deleteDocument(spaceId, docId) {
  if (!confirm('确认删除此文档吗？')) return;

  try {
    const response = await fetch(`${API_BASE}/spaces/${spaceId}/documents/${docId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${appState.token}`
      }
    });

    if (!response.ok) throw new Error('删除失败');

    console.log('✅ 文档删除成功');

    // 重新加载文档列表和空间列表
    await loadDocuments(spaceId);
    await loadSpaces();
  } catch (error) {
    console.error('删除文档失败:', error);
    alert('删除失败: ' + error.message);
  }
}

// 删除空间
async function deleteSpace(spaceId) {
  if (!confirm('确认删除此空间吗？空间中的所有文档也会被删除！')) return;

  try {
    const response = await fetch(`${API_BASE}/spaces/${spaceId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${appState.token}`
      }
    });

    if (!response.ok) throw new Error('删除失败');

    console.log('✅ 空间删除成功');

    // 如果删除的是当前选中的空间，清空状态
    if (appState.currentSpaceId === spaceId) {
      appState.currentSpaceId = null;
      document.getElementById('spaceDetail').classList.remove('active');
    }

    // 重新加载空间列表
    await loadSpaces();
  } catch (error) {
    console.error('删除空间失败:', error);
    alert('删除失败: ' + error.message);
  }
}

// RAG功能切换
function toggleRAG() {
  appState.useRag = !appState.useRag;
  const ragBtn = document.getElementById('ragBtn');
  if (ragBtn) {
    ragBtn.classList.toggle('active');
  }
  console.log('RAG功能:', appState.useRag ? '已开启' : '已关闭');
}

// 场景预设切换
async function selectScenario(scenario) {
  appState.currentScenario = scenario;

  // 更新UI
  const scenarioBtns = document.querySelectorAll('.scenario-btn');
  scenarioBtns.forEach(btn => btn.classList.remove('active'));

  const selectedBtn = document.getElementById(`scenario-${scenario}`);
  if (selectedBtn) selectedBtn.classList.add('active');

  // 调用意图识别API获取推荐参数(可选)
  // 这里简化处理,直接设置预定义的参数
  const scenarios = {
    divergent: { temperature: 1.3, top_p: 0.95, presence_penalty: 0.6 },
    precise: { temperature: 0.4, top_p: 0.2, presence_penalty: 0 },
    code: { temperature: 0.3, top_p: 0.2, presence_penalty: 0 },
    creative: { temperature: 0.9, top_p: 0.85, presence_penalty: 0.4 },
    balanced: { temperature: 0.7, top_p: 0.9, presence_penalty: 0 }
  };

  const params = scenarios[scenario];
  if (params) {
    appState.temperature = params.temperature;
    appState.topP = params.top_p;
    appState.presencePenalty = params.presence_penalty;
    console.log(`✅ 切换到${scenario}模式:`, params);
  }
}

// 辅助函数：格式化文件大小
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// ==================== Chat Flow 思维流核心逻辑 ====================

// Chat Flow 状态
const chatFlowState = {
  currentFlowId: null,
  flows: [],
  messages: [],
  canvas: {
    scale: 1,
    translateX: 0,
    translateY: 0,
    isPanning: false,
    startX: 0,
    startY: 0
  },
  nodes: [],
  edges: [],
  isInitialized: false,
  // Phase 2 新增
  selectedModel: 'kimi-k2',
  thinkingMode: false,
  internetMode: false,
  isStreaming: false
};

// 加载 Flow 列表
async function loadFlowsList() {
  try {
    const response = await fetch('/api/flows', {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) throw new Error('加载失败');

    const flows = await response.json();
    chatFlowState.flows = flows;
    renderFlowsList(flows);
  } catch (error) {
    console.error('❌ 加载思维流列表失败:', error);
  }
}

// 渲染 Flow 列表
function renderFlowsList(flows) {
  const container = document.getElementById('flowsList');
  if (!container) return;

  if (flows.length === 0) {
    const emptyHint = appState.language === 'zh-CN' ? '暂无思维流' : 'No Flows';
    container.innerHTML = `<div class="flow-empty-hint">${emptyHint}</div>`;
    return;
  }

  container.innerHTML = flows.map(flow => `
        <div class="flow-item ${chatFlowState.currentFlowId === flow.id ? 'active' : ''}" 
             onclick="openFlow('${flow.id}')" data-flow-id="${flow.id}">
          <svg class="flow-item-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor">
            <path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Z"/>
          </svg>
          <span class="flow-item-title">${escapeHtml(flow.title)}</span>
          <button class="flow-item-delete" onclick="event.stopPropagation(); deleteFlow('${flow.id}')" title="${appState.language === 'zh-CN' ? '删除' : 'Delete'}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      `).join('');
}

// 创建新 Flow
async function createNewFlow() {
  try {
    const defaultTitle = appState.language === 'zh-CN' ? '新思维流' : 'New Flow';
    const response = await fetch('/api/flows', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({ title: defaultTitle })
    });

    if (!response.ok) throw new Error('创建失败');

    const flow = await response.json();
    console.log('✅ 创建思维流成功:', flow.id);

    await loadFlowsList();
    openFlow(flow.id);
  } catch (error) {
    console.error('❌ 创建思维流失败:', error);
    alert(appState.language === 'zh-CN' ? '创建思维流失败，请重试' : 'Failed to create flow, please retry');
  }
}

// 打开 Flow
async function openFlow(flowId) {
  try {
    const response = await fetch(`/api/flows/${flowId}`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error('加载失败');

    const flow = await response.json();

    chatFlowState.currentFlowId = flowId;
    chatFlowState.messages = flow.chat_history || [];
    chatFlowState.nodes = flow.canvas_state?.nodes || [];
    chatFlowState.edges = flow.canvas_state?.edges || [];
    chatFlowState.canvas = {
      ...chatFlowState.canvas,
      ...flow.canvas_state?.viewport
    };

    // 更新 UI
    document.getElementById('chatflowTitle').textContent = flow.title;
    document.getElementById('chatFlowWorkspace').style.display = 'flex';

    // 初始化画布
    if (!chatFlowState.isInitialized) {
      initChatFlowCanvas();
      initChatFlowDivider();
      chatFlowState.isInitialized = true;
    }

    // 渲染消息和节点
    renderChatFlowMessages();
    renderCanvasNodes();
    renderEdges(); // 修复: 确保重新打开时渲染连线
    updateCanvasTransform();

    // 更新列表选中状态
    renderFlowsList(chatFlowState.flows);


    console.log('✅ 打开思维流:', flowId);
  } catch (error) {
    console.error('❌ 打开思维流失败:', error);
    alert(appState.language === 'zh-CN' ? '打开思维流失败，请重试' : 'Failed to open flow, please retry');
  }
}

// 关闭 Chat Flow
function closeChatFlow() {
  document.getElementById('chatFlowWorkspace').style.display = 'none';
  chatFlowState.currentFlowId = null;
  renderFlowsList(chatFlowState.flows);
}

// 删除 Flow
async function deleteFlow(flowId) {
  const confirmMsg = appState.language === 'zh-CN' ? '确定要删除这个思维流吗？' : 'Are you sure you want to delete this flow?';
  if (!confirm(confirmMsg)) return;

  try {
    const response = await fetch(`/api/flows/${flowId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) throw new Error('删除失败');

    if (chatFlowState.currentFlowId === flowId) {
      closeChatFlow();
    }

    await loadFlowsList();
    console.log('✅ 删除思维流成功:', flowId);
  } catch (error) {
    console.error('❌ 删除思维流失败:', error);
    alert('删除思维流失败，请重试');
  }
}

// 保存 Flow 状态
async function saveFlowState() {
  if (!chatFlowState.currentFlowId) return;

  try {
    await fetch(`/api/flows/${chatFlowState.currentFlowId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({
        chat_history: chatFlowState.messages,
        canvas_state: {
          nodes: chatFlowState.nodes,
          edges: chatFlowState.edges,
          viewport: {
            x: chatFlowState.canvas.translateX,
            y: chatFlowState.canvas.translateY,
            zoom: chatFlowState.canvas.scale
          }
        }
      })
    });
  } catch (error) {
    console.error('❌ 保存思维流状态失败:', error);
  }
}

// 渲染 Chat Flow 消息
function renderChatFlowMessages() {
  const container = document.getElementById('chatflowMessages');
  if (!container) return;

  if (chatFlowState.messages.length === 0) {
    const emptyMsg = appState.language === 'zh-CN' ? '开始对话，然后拖拽消息到画布' : 'Start chatting, then drag messages to canvas';
    container.innerHTML = `
          <div class="chatflow-empty-state">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="48" height="48" fill="currentColor">
              <path d="M480-80q-33 0-56.5-23.5T400-160h160q0 33-23.5 56.5T480-80ZM320-200v-80h320v80H320Zm10-120q-69-41-109.5-110T180-580q0-125 87.5-212.5T480-880q125 0 212.5 87.5T780-580q0 81-40.5 150T630-320H330Z"/>
            </svg>
            <p>${emptyMsg}</p>
          </div>
        `;
    return;
  }

  container.innerHTML = chatFlowState.messages.map((msg, i) => `
        <div class="chatflow-message ${msg.role}" draggable="true" data-msg-index="${i}">
          <div class="chatflow-message-drag-handle" title="${appState.language === 'zh-CN' ? '拖拽到画布' : 'Drag to canvas'}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="16" height="16" fill="currentColor">
              <path d="M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z"/>
            </svg>
          </div>
          <div class="chatflow-message-content">${renderMarkdownWithMath(msg.content)}</div>
        </div>
      `).join('');

  // 添加 hover 事件实现双向高亮
  container.querySelectorAll('.chatflow-message').forEach(msgEl => {
    msgEl.addEventListener('mouseenter', () => {
      const msgIndex = parseInt(msgEl.dataset.msgIndex);
      // 找到画布上对应的节点并高亮
      chatFlowState.nodes.forEach(node => {
        if (node.sourceIndex === msgIndex) {
          highlightNode(node.id);
        }
      });
    });

    msgEl.addEventListener('mouseleave', () => {
      // 清除高亮
      document.querySelectorAll('.canvas-node.highlighted').forEach(el => {
        el.classList.remove('highlighted');
      });
    });
  });
}

// 渲染画布节点
function renderCanvasNodes() {
  const nodesLayer = document.getElementById('nodesLayer');
  if (!nodesLayer) return;

  // 清空现有节点
  nodesLayer.innerHTML = '';

  // 如果没有节点，显示提示
  const hint = document.getElementById('canvasHint');
  if (hint) {
    hint.style.display = chatFlowState.nodes.length === 0 ? 'flex' : 'none';
  }

  // TODO: 渲染节点 (Phase 2)
}

// 初始化 Chat Flow 画布
function initChatFlowCanvas() {
  const svg = document.getElementById('infiniteCanvas');
  if (!svg) return;

  // ==================== 父窗口消息监听 (响应 iframe 请求) ====================
  // 防止重复添加监听器
  if (!window._chatFlowMessageListenerAdded) {
    window.addEventListener('message', (e) => {
      // 响应画布数据请求
      if (e.data.action === 'request-canvas') {
        const iframe = document.getElementById('chatflowIframe');
        // 验证消息来源是我们的 iframe
        if (iframe && iframe.contentWindow === e.source) {
          console.log('📥 收到 iframe 的画布请求');
          let canvasData = '';
          // 尝试获取画布数据
          if (typeof serializeCanvasToPrompt === 'function') {
            canvasData = serializeCanvasToPrompt();
          } else {
            console.warn('⚠️ serializeCanvasToPrompt 未定义');
          }

          // 发送回 iframe
          iframe.contentWindow.postMessage({
            action: 'canvas-data',
            canvas: canvasData
          }, '*');
          console.log('📤 已发送画布数据给 iframe');
        }
      } else if (e.data.action === 'update-flow-title') {
        const iframe = document.getElementById('chatflowIframe');
        // 验证消息来源
        if (iframe && iframe.contentWindow === e.source && e.data.title && chatFlowState.currentFlowId) {
          console.log('📥 收到 iframe 的标题同步:', e.data.title);

          // 1. 更新 UI 标题
          const titleEl = document.getElementById('chatflowTitle');
          if (titleEl) titleEl.textContent = e.data.title;

          // 2. 更新本地状态 flow 列表
          const flow = chatFlowState.flows.find(f => f.id === chatFlowState.currentFlowId);
          if (flow) {
            flow.title = e.data.title;
            renderFlowsList(chatFlowState.flows);
          }

          // 3. 调用 API 保存到数据库
          fetch(`/api/flows/${chatFlowState.currentFlowId}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${appState.token}`
            },
            body: JSON.stringify({ title: e.data.title })
          }).then(res => {
            if (res.ok) console.log('✅ Flow 标题已保存到数据库');
            else console.error('❌ 保存 Flow 标题失败');
          }).catch(err => console.error('❌ 保存 Flow 标题请求错误:', err));
        }
      }

    });
    window._chatFlowMessageListenerAdded = true;
  }


  // 鼠标平移
  svg.addEventListener('mousedown', (e) => {
    if (e.target === svg || e.target.classList.contains('canvas-bg')) {
      chatFlowState.canvas.isPanning = true;
      chatFlowState.canvas.startX = e.clientX - chatFlowState.canvas.translateX;
      chatFlowState.canvas.startY = e.clientY - chatFlowState.canvas.translateY;
      svg.style.cursor = 'grabbing';
    }
  });

  svg.addEventListener('mousemove', (e) => {
    if (!chatFlowState.canvas.isPanning) return;
    chatFlowState.canvas.translateX = e.clientX - chatFlowState.canvas.startX;
    chatFlowState.canvas.translateY = e.clientY - chatFlowState.canvas.startY;
    updateCanvasTransform();
  });

  svg.addEventListener('mouseup', () => {
    chatFlowState.canvas.isPanning = false;
    svg.style.cursor = 'grab';
  });

  svg.addEventListener('mouseleave', () => {
    chatFlowState.canvas.isPanning = false;
    svg.style.cursor = 'grab';
  });

  // 滚轮缩放
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(chatFlowState.canvas.scale * delta, 0.1), 5);
    chatFlowState.canvas.scale = newScale;
    updateCanvasTransform();
    updateZoomDisplay();
  }, { passive: false });

  // ==================== 画布空白处右键菜单 ====================
  svg.addEventListener('contextmenu', (e) => {
    // 只在空白处触发（非节点、非边）
    if (e.target === svg || e.target.classList.contains('canvas-bg') || e.target.closest('.canvas-bg-pattern')) {
      e.preventDefault();
      showCanvasContextMenu(e);
    }
  });
}

// ==================== 画布空白处右键菜单 ====================
function showCanvasContextMenu(e) {
  // 移除已有菜单
  document.querySelectorAll('.canvas-context-menu').forEach(el => el.remove());

  const canvasContainer = document.getElementById('chatflowCanvasContainer');
  if (!canvasContainer) return;

  // 计算画布坐标（用于创建节点）
  const rect = canvasContainer.getBoundingClientRect();
  const canvasX = (e.clientX - rect.left - chatFlowState.canvas.translateX) / chatFlowState.canvas.scale;
  const canvasY = (e.clientY - rect.top - chatFlowState.canvas.translateY) / chatFlowState.canvas.scale;

  const menu = document.createElement('div');
  menu.className = 'canvas-context-menu';
  menu.style.cssText = `
        position: fixed;
        left: ${e.clientX}px;
        top: ${e.clientY}px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 4px 0;
        min-width: 160px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        z-index: 1000;
        animation: menuFadeIn 0.15s ease-out;
      `;

  const menuItems = [
    {
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor"><path d="M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Z"/></svg>',
      text: appState.language === 'zh-CN' ? '新建便签' : 'New Sticky Note',
      action: () => addStickyNoteAt(canvasX, canvasY)
    },
    {
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor"><path d="M440-280h80v-160h160v-80H520v-160h-80v160H280v80h160v160ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Z"/></svg>',
      text: appState.language === 'zh-CN' ? '新建文本节点' : 'New Text Node',
      action: () => addTextNodeAt(canvasX, canvasY)
    },
    { type: 'divider' },
    {
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor"><path d="M212-140v-80h136v-120H200q-33 0-56.5-23.5T120-420v-320q0-33 23.5-56.5T200-820h560q33 0 56.5 23.5T840-740v320q0 33-23.5 56.5T760-340H612v120h136v80H212Z"/></svg>',
      text: appState.language === 'zh-CN' ? '粘贴剪贴板内容' : 'Paste from Clipboard',
      action: () => pasteClipboardAsNode(canvasX, canvasY)
    },
    { type: 'divider' },
    {
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor"><path d="M480-320q75 0 127.5-52.5T660-500q0-75-52.5-127.5T480-680q-75 0-127.5 52.5T300-500q0 75 52.5 127.5T480-320Zm0-72q-45 0-76.5-31.5T372-500q0-45 31.5-76.5T480-608q45 0 76.5 31.5T588-500q0 45-31.5 76.5T480-392Zm0 192q-146 0-266-81.5T40-500q54-137 174-218.5T480-800q146 0 266 81.5T920-500q-54 137-174 218.5T480-200Z"/></svg>',
      text: appState.language === 'zh-CN' ? '重置视图' : 'Reset View',
      action: () => canvasResetView()
    },
  ];

  menuItems.forEach(item => {
    if (item.type === 'divider') {
      const divider = document.createElement('div');
      divider.style.cssText = 'height: 1px; background: var(--border-color); margin: 4px 0;';
      menu.appendChild(divider);
      return;
    }

    const menuItem = document.createElement('div');
    menuItem.className = 'context-menu-item';
    menuItem.style.cssText = `
          padding: 8px 16px;
          cursor: pointer;
          font-size: 13px;
          color: var(--text-secondary);
          display: flex;
          align-items: center;
          gap: 10px;
        `;
    menuItem.innerHTML = `${item.icon}<span>${item.text}</span>`;

    menuItem.addEventListener('mouseenter', () => {
      menuItem.style.background = 'var(--bg-hover)';
      menuItem.style.color = 'var(--text-primary)';
    });
    menuItem.addEventListener('mouseleave', () => {
      menuItem.style.background = 'transparent';
      menuItem.style.color = 'var(--text-secondary)';
    });
    menuItem.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(menuItem);
  });

  document.body.appendChild(menu);

  // 确保菜单不超出屏幕
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth) {
    menu.style.left = (window.innerWidth - menuRect.width - 10) + 'px';
  }
  if (menuRect.bottom > window.innerHeight) {
    menu.style.top = (window.innerHeight - menuRect.height - 10) + 'px';
  }

  // 点击其他地方关闭菜单
  setTimeout(() => {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }, { once: true });
  }, 100);
}

// 在指定位置添加便签
function addStickyNoteAt(x, y) {
  const nodeId = `sticky-${Date.now()}`;
  const node = {
    id: nodeId,
    type: 'sticky',
    content: appState.language === 'zh-CN' ? '双击编辑便签...' : 'Double click to edit...',
    fullContent: '',
    x: x,
    y: y,
    width: 150,
    height: 100,
    color: '#f5d547'
  };

  chatFlowState.nodes.push(node);
  renderCanvasNodes();
  renderEdges();
  saveFlowState();
  console.log('✅ 在位置创建便签:', x, y);
}

// 在指定位置添加文本节点
function addTextNodeAt(x, y) {
  const nodeId = `text-${Date.now()}`;

  const node = {
    id: nodeId,
    type: 'text',
    content: '',
    fullContent: '',
    x: x,
    y: y,
    width: 200,
    height: 100
  };

  chatFlowState.nodes.push(node);
  renderCanvasNodes();
  renderEdges();
  saveFlowState();
  console.log('✅ 在位置创建文本节点:', x, y);

  // 创建后立即进入编辑模式
  setTimeout(() => {
    editNodeInline(nodeId);
  }, 100);
}

// 从剪贴板粘贴内容作为节点
async function pasteClipboardAsNode(x, y) {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      showToast(appState.language === 'zh-CN' ? '剪贴板为空' : 'Clipboard is empty');
      return;
    }

    const nodeId = `text-${Date.now()}`;
    const node = {
      id: nodeId,
      type: 'text',
      content: text.trim().slice(0, 200),
      fullContent: text.trim(),
      x: x,
      y: y,
      width: 200,
      height: 100
    };

    chatFlowState.nodes.push(node);
    renderCanvasNodes();
    renderEdges();
    saveFlowState();
    showToast(appState.language === 'zh-CN' ? '已粘贴到画布' : 'Pasted to canvas');
    console.log('✅ 从剪贴板粘贴节点:', x, y);
  } catch (err) {
    console.error('读取剪贴板失败:', err);
    showToast(appState.language === 'zh-CN' ? '无法读取剪贴板' : 'Cannot read clipboard');
  }
}

// 初始化分隔栏拖拽
function initChatFlowDivider() {
  const divider = document.getElementById('chatflowDivider');
  const llmPanel = document.getElementById('chatflowLLMPanel');
  if (!divider || !llmPanel) return;

  let isDragging = false;

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const containerRect = document.getElementById('chatFlowWorkspace').getBoundingClientRect();
    const newWidth = e.clientX - containerRect.left;
    const minWidth = 320;
    const maxWidth = containerRect.width * 0.5;

    llmPanel.style.width = Math.max(minWidth, Math.min(maxWidth, newWidth)) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // 双击折叠
  divider.addEventListener('dblclick', () => {
    if (llmPanel.style.width === '0px') {
      llmPanel.style.width = '30%';
    } else {
      llmPanel.style.width = '0px';
    }
  });
}

// 更新画布变换
function updateCanvasTransform() {
  const content = document.getElementById('canvasContent');
  if (!content) return;
  content.setAttribute('transform',
    `translate(${chatFlowState.canvas.translateX}, ${chatFlowState.canvas.translateY}) scale(${chatFlowState.canvas.scale})`
  );
}

// 更新缩放显示
function updateZoomDisplay() {
  const display = document.getElementById('canvasZoomLevel');
  if (display) {
    display.textContent = Math.round(chatFlowState.canvas.scale * 100) + '%';
  }
}

// 缩放控制
function canvasZoomIn() {
  chatFlowState.canvas.scale = Math.min(chatFlowState.canvas.scale * 1.2, 5);
  updateCanvasTransform();
  updateZoomDisplay();
}

function canvasZoomOut() {
  chatFlowState.canvas.scale = Math.max(chatFlowState.canvas.scale * 0.8, 0.1);
  updateCanvasTransform();
  updateZoomDisplay();
}

function canvasResetView() {
  chatFlowState.canvas.scale = 1;
  chatFlowState.canvas.translateX = 0;
  chatFlowState.canvas.translateY = 0;
  updateCanvasTransform();
  updateZoomDisplay();
}

// ==================== Chat Flow UI 控制函数 ====================

// 更多菜单切换
function toggleChatFlowMoreMenu() {
  const menu = document.getElementById('chatflowMoreMenu');
  if (menu) {
    menu.classList.toggle('active');
  }
}

// 模型菜单切换
function toggleChatFlowModelMenu() {
  const menu = document.getElementById('chatflowModelMenu');
  if (menu) {
    menu.classList.toggle('active');
  }
}

// 选择模型
function selectChatFlowModel(modelId, modelName) {
  chatFlowState.selectedModel = modelId;
  const display = document.getElementById('chatflowSelectedModel');
  if (display) {
    display.textContent = modelName;
  }
  toggleChatFlowModelMenu();
}

// 联网搜索切换
function toggleChatFlowInternet(event) {
  event.stopPropagation();
  chatFlowState.internetMode = !chatFlowState.internetMode;
  const toggle = document.getElementById('chatflowInternetToggle');
  if (toggle) {
    toggle.classList.toggle('active', chatFlowState.internetMode);
  }
}

// 推理模式切换
function toggleChatFlowThinking(event) {
  event.stopPropagation();
  chatFlowState.thinkingMode = !chatFlowState.thinkingMode;
  const toggle = document.getElementById('chatflowThinkingToggle');
  if (toggle) {
    toggle.classList.toggle('active', chatFlowState.thinkingMode);
  }
}

// 关闭所有菜单
function closeChatFlowMenus() {
  document.getElementById('chatflowMoreMenu')?.classList.remove('active');
  document.getElementById('chatflowModelMenu')?.classList.remove('active');
}

// 点击外部关闭菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('.chatflow-more-menu-container') &&
    !e.target.closest('.chatflow-model-selector')) {
    closeChatFlowMenus();
  }
});

// Chat Flow 输入处理
function handleChatFlowInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatFlowMessage();
  }
}

function autoResizeChatFlowInput() {
  const input = document.getElementById('chatflowMessageInput');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
}

// ==================== Chat Flow LLM 调用 ====================

// 发送 Chat Flow 消息
async function sendChatFlowMessage() {
  const input = document.getElementById('chatflowMessageInput');
  if (!input) return;

  const content = input.value.trim();
  if (!content) return;

  // 添加用户消息
  const userMessage = { role: 'user', content, timestamp: Date.now() };
  chatFlowState.messages.push(userMessage);
  input.value = '';
  autoResizeChatFlowInput();
  renderChatFlowMessages();

  // 显示停止按钮
  document.getElementById('chatflowSendBtn').style.display = 'none';
  document.getElementById('chatflowStopBtn').style.display = 'flex';
  chatFlowState.isStreaming = true;

  try {
    // 构建消息历史
    let messages = chatFlowState.messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    // ==================== 注入画布上下文 ====================
    // 将画布内容序列化后附加到用户消息中，让 LLM 了解当前画布状态
    if (chatFlowState.nodes.length > 0 || chatFlowState.edges.length > 0) {
      const canvasContext = serializeCanvasToPrompt();
      if (canvasContext && messages.length > 0) {
        // 将画布上下文附加到最后一条用户消息
        const lastUserMsgIndex = messages.map(m => m.role).lastIndexOf('user');
        if (lastUserMsgIndex >= 0) {
          messages[lastUserMsgIndex] = {
            ...messages[lastUserMsgIndex],
            content: messages[lastUserMsgIndex].content + canvasContext
          };
          console.log('📋 已注入画布上下文到用户消息');
        }
      }
    }

    // ==================== 系统提示词 ====================
    // Chat Flow 模式下，添加系统提示词和标题生成指令
    const chatFlowSystemPrompt = `你是 RAI 思维流助手，专注于帮助用户梳理思路、分析问题和构建知识图谱。

注意事项：
1. 回答要清晰、有条理，便于用户理解和拖拽到画布
2. 对于复杂问题，可以分步骤或分要点回答
3. 适当使用 markdown 格式增强可读性
4. 如果用户的问题涉及到当前画布内容，请结合画布上下文回答

【重要】请在回答的末尾使用以下格式生成一个简短的对话标题（不超过15个字），标题应该概括本次对话的核心内容：
[TITLE]这里是标题[/TITLE]`;

    // 调用 LLM API（复用主流程的 API）
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({
        messages: messages,
        model: chatFlowState.selectedModel || 'kimi-k2',
        thinkingMode: chatFlowState.thinkingMode || false,
        internetMode: chatFlowState.internetMode || false,
        stream: true,
        systemPrompt: chatFlowSystemPrompt
      })
    });

    if (!response.ok) {
      throw new Error('API 请求失败');
    }

    // 添加占位 AI 消息
    const aiMessage = { role: 'assistant', content: '', timestamp: Date.now() };
    chatFlowState.messages.push(aiMessage);
    renderChatFlowMessages();

    // 流式读取
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              aiMessage.content += parsed.content;
              // 更新最后一个消息
              const msgContainer = document.getElementById('chatflowMessages');
              const lastMsg = msgContainer?.querySelector('.chatflow-message:last-child .chatflow-message-content');
              if (lastMsg) {
                lastMsg.innerHTML = renderMarkdownWithMath(aiMessage.content);
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    // 提取标题并更新 Flow
    if (aiMessage.content) {
      const titleMatch = aiMessage.content.match(/\[TITLE\](.*?)\[\/TITLE\]/);
      if (titleMatch && titleMatch[1]) {
        const extractedTitle = titleMatch[1].trim();
        // 从显示内容中移除标题标记
        aiMessage.content = aiMessage.content.replace(/\[TITLE\].*?\[\/TITLE\]/g, '').trim();

        // 更新 Flow 标题
        if (chatFlowState.currentFlowId) {
          try {
            await fetch(`/api/flows/${chatFlowState.currentFlowId}`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${appState.token}`
              },
              body: JSON.stringify({ title: extractedTitle })
            });
            // 更新UI显示的标题
            const titleEl = document.getElementById('chatflowTitle');
            if (titleEl) titleEl.textContent = extractedTitle;
            // 重新加载侧边栏列表
            loadFlowsList();
            console.log('📋 Flow 标题已更新:', extractedTitle);
          } catch (err) {
            console.error('❌ 更新 Flow 标题失败:', err);
          }
        }
      }
    }

    // 完成后渲染最终内容
    renderChatFlowMessages();
  } catch (error) {
    console.error('❌ Chat Flow LLM 调用失败:', error);
    // 添加错误消息
    chatFlowState.messages.push({
      role: 'assistant',
      content: `抱歉，发生了错误: ${error.message}`,
      timestamp: Date.now()
    });
    renderChatFlowMessages();
  } finally {
    // 恢复按钮状态
    document.getElementById('chatflowSendBtn').style.display = 'flex';
    document.getElementById('chatflowStopBtn').style.display = 'none';
    chatFlowState.isStreaming = false;

    // 保存状态
    saveFlowState();
  }
}

// 停止生成
function stopChatFlowGeneration() {
  // TODO: 实现取消请求
  chatFlowState.isStreaming = false;
  document.getElementById('chatflowSendBtn').style.display = 'flex';
  document.getElementById('chatflowStopBtn').style.display = 'none';
}

// ==================== Phase 2: 拖拽节点生成 ====================

// 初始化拖拽
function initChatFlowDragDrop() {
  const messagesContainer = document.getElementById('chatflowMessages');
  const canvasContainer = document.getElementById('chatflowCanvasContainer');

  if (!messagesContainer || !canvasContainer) return;

  // 拖拽开始
  messagesContainer.addEventListener('dragstart', (e) => {
    const msgElement = e.target.closest('.chatflow-message');
    if (!msgElement) return;

    const msgIndex = parseInt(msgElement.dataset.msgIndex);
    e.dataTransfer.setData('text/plain', JSON.stringify({
      type: 'message',
      index: msgIndex
    }));
    e.dataTransfer.effectAllowed = 'copy';
    msgElement.classList.add('dragging');
  });

  messagesContainer.addEventListener('dragend', (e) => {
    const msgElement = e.target.closest('.chatflow-message');
    if (msgElement) {
      msgElement.classList.remove('dragging');
    }
  });

  // 画布接收拖拽
  canvasContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    canvasContainer.classList.add('drag-over');
  });

  canvasContainer.addEventListener('dragleave', () => {
    canvasContainer.classList.remove('drag-over');
  });

  canvasContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    canvasContainer.classList.remove('drag-over');

    try {
      // 计算放置位置（相对于画布）
      const rect = canvasContainer.getBoundingClientRect();
      const x = (e.clientX - rect.left - chatFlowState.canvas.translateX) / chatFlowState.canvas.scale;
      const y = (e.clientY - rect.top - chatFlowState.canvas.translateY) / chatFlowState.canvas.scale;

      // 尝试解析结构化数据
      let handled = false;
      const jsonData = e.dataTransfer.getData('text/plain');

      if (jsonData) {
        try {
          const data = JSON.parse(jsonData);
          if (data.type === 'message') {
            const msg = chatFlowState.messages[data.index];
            if (msg) {
              createCanvasNode(msg, x, y, data.index);
              handled = true;
            }
          } else if (data.type === 'selected-text') {
            // 选中文本拖拽创建节点
            createTextNode(data.text, x, y);
            handled = true;
          }
        } catch (parseErr) {
          // 不是 JSON 格式，尝试作为纯文本处理
        }
      }

      // 尝试获取纯文本（选中文本拖拽）
      if (!handled) {
        const plainText = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
        if (plainText && plainText.trim() && plainText.length > 0 && plainText.length < 10000) {
          // 检查是否是有效的纯文本（非 JSON）
          try {
            JSON.parse(plainText);
            // 如果能解析成 JSON 但没被处理，可能是无效数据
          } catch {
            // 不是 JSON，作为选中文本处理
            createTextNode(plainText.trim(), x, y);
            handled = true;
          }
        }
      }
    } catch (err) {
      console.error('拖放处理失败:', err);
    }
  });
}

// 创建画布节点
function createCanvasNode(message, x, y, sourceIndex) {
  const nodeId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // 清理 Markdown 标记
  const cleanContent = message.content
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .slice(0, 200);

  const node = {
    id: nodeId,
    type: message.role === 'user' ? 'user' : 'assistant',
    content: cleanContent,
    fullContent: message.content,
    sourceIndex: sourceIndex,
    x: x,
    y: y,
    width: 200,
    height: 100
  };

  chatFlowState.nodes.push(node);
  renderCanvasNodes();
  renderEdges();
  saveFlowState();

  console.log('✅ 创建节点:', nodeId);
}

// 创建文本节点（从选中文本拖拽）
function createTextNode(text, x, y) {
  const nodeId = `text-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // 清理和截取内容
  const cleanContent = text
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .slice(0, 200);

  const node = {
    id: nodeId,
    type: 'text',
    content: cleanContent,
    fullContent: text,
    x: x,
    y: y,
    width: 200,
    height: 100
  };

  chatFlowState.nodes.push(node);
  renderCanvasNodes();
  renderEdges();
  saveFlowState();

  console.log('✅ 从选中文本创建节点:', nodeId);
  showToast('已添加到画布');
}

// 渲染画布节点
function renderCanvasNodes() {
  const nodesLayer = document.getElementById('nodesLayer');
  if (!nodesLayer) return;

  nodesLayer.innerHTML = '';

  // 隐藏/显示提示
  const hint = document.getElementById('canvasHint');
  if (hint) {
    hint.style.display = chatFlowState.nodes.length === 0 ? 'flex' : 'none';
  }

  chatFlowState.nodes.forEach(node => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'canvas-node');
    g.setAttribute('data-node-id', node.id);
    g.setAttribute('data-source-index', node.sourceIndex || '');
    g.setAttribute('transform', `translate(${node.x}, ${node.y})`);

    // 背景矩形
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'canvas-node-bg');
    rect.setAttribute('width', node.width);
    rect.setAttribute('height', node.height);

    // 根据节点类型设置样式
    if (node.type === 'sticky') {
      rect.setAttribute('fill', node.color || '#f5d547');
      rect.setAttribute('stroke', '#e6c42e');
    } else if (node.type === 'text') {
      // 文本节点使用蓝色边框
      rect.setAttribute('fill', 'var(--bg-secondary)');
      rect.setAttribute('stroke', 'var(--color-saturn-yellow)');
      rect.setAttribute('stroke-width', '2');
    } else {
      rect.setAttribute('fill', node.type === 'user' ? 'var(--bg-tertiary)' : 'var(--bg-secondary)');
    }
    g.appendChild(rect);

    // 角色标签 (便签和文本节点显示不同标签)
    if (node.type !== 'sticky') {
      const roleText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      roleText.setAttribute('class', 'canvas-node-role');
      roleText.setAttribute('x', '8');
      roleText.setAttribute('y', '16');
      const typeLabels = {
        'user': 'USER',
        'assistant': 'AI',
        'text': 'TEXT'
      };
      roleText.textContent = typeLabels[node.type] || 'NODE';
      g.appendChild(roleText);
    }

    // 内容文本（使用 foreignObject 支持换行）
    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', '8');
    fo.setAttribute('y', node.type === 'sticky' ? '8' : '24');
    fo.setAttribute('width', node.width - 16);
    fo.setAttribute('height', node.height - (node.type === 'sticky' ? 16 : 32));

    const div = document.createElement('div');
    div.style.cssText = `font-size: 11px; color: ${node.type === 'sticky' ? '#333' : 'var(--text-primary)'}; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;`;
    div.textContent = node.content;
    fo.appendChild(div);
    g.appendChild(fo);

    // ==================== 连接端口 (4个圆点) ====================
    const portPositions = [
      { cx: node.width / 2, cy: 0, id: 'top' },      // 上
      { cx: node.width / 2, cy: node.height, id: 'bottom' }, // 下
      { cx: 0, cy: node.height / 2, id: 'left' },    // 左
      { cx: node.width, cy: node.height / 2, id: 'right' }   // 右
    ];

    portPositions.forEach(pos => {
      const port = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      port.setAttribute('class', 'canvas-node-port');
      port.setAttribute('cx', pos.cx);
      port.setAttribute('cy', pos.cy);
      port.setAttribute('r', '6');
      port.setAttribute('data-port', pos.id);
      g.appendChild(port);
    });

    // ==================== 调整大小手柄 (右下角) ====================
    const resizeHandle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    resizeHandle.setAttribute('class', 'canvas-node-resize');
    resizeHandle.setAttribute('x', node.width - 12);
    resizeHandle.setAttribute('y', node.height - 12);
    resizeHandle.setAttribute('width', 12);
    resizeHandle.setAttribute('height', 12);
    resizeHandle.setAttribute('rx', 3);
    g.appendChild(resizeHandle);

    // Resize 拖拽逻辑
    let isResizing = false;
    let resizeStartX, resizeStartY, resizeStartWidth, resizeStartHeight;

    resizeHandle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      isResizing = true;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartWidth = node.width;
      resizeStartHeight = node.height;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const dx = (e.clientX - resizeStartX) / chatFlowState.canvas.scale;
      const dy = (e.clientY - resizeStartY) / chatFlowState.canvas.scale;

      // 限制最小尺寸
      const newWidth = Math.max(80, resizeStartWidth + dx);
      const newHeight = Math.max(50, resizeStartHeight + dy);

      node.width = newWidth;
      node.height = newHeight;

      // 更新节点元素
      rect.setAttribute('width', newWidth);
      rect.setAttribute('height', newHeight);
      fo.setAttribute('width', newWidth - 16);
      fo.setAttribute('height', newHeight - (node.type === 'sticky' ? 16 : 32));
      resizeHandle.setAttribute('x', newWidth - 12);
      resizeHandle.setAttribute('y', newHeight - 12);

      // 更新端口位置
      const ports = g.querySelectorAll('.canvas-node-port');
      ports.forEach(p => {
        const portId = p.getAttribute('data-port');
        if (portId === 'top') { p.setAttribute('cx', newWidth / 2); }
        if (portId === 'bottom') { p.setAttribute('cx', newWidth / 2); p.setAttribute('cy', newHeight); }
        if (portId === 'left') { p.setAttribute('cy', newHeight / 2); }
        if (portId === 'right') { p.setAttribute('cx', newWidth); p.setAttribute('cy', newHeight / 2); }
      });

      renderEdges();
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        saveFlowState();
      }
    });

    // 添加拖拽功能
    let isDragging = false;
    let startX, startY, startNodeX, startNodeY;

    g.addEventListener('mousedown', (e) => {
      // 如果点击的是端口，不触发节点拖拽（连接端口用于连线）
      if (e.target.classList.contains('canvas-node-port')) {
        return; // 让 initEdgeConnection 处理端口连线
      }
      if (e.target.classList.contains('canvas-node-resize')) return;

      // 选择模式下选中节点
      document.querySelectorAll('.canvas-node.selected').forEach(el => el.classList.remove('selected'));
      g.classList.add('selected');

      if (chatFlowState.currentTool === 'select') {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startNodeX = node.x;
        startNodeY = node.y;
      }
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = (e.clientX - startX) / chatFlowState.canvas.scale;
      const dy = (e.clientY - startY) / chatFlowState.canvas.scale;
      node.x = startNodeX + dx;
      node.y = startNodeY + dy;
      g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
      // 更新连线
      renderEdges();
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        saveFlowState();
      }
    });

    // 单击高亮对应消息
    g.addEventListener('click', (e) => {
      if (e.target.classList.contains('canvas-node-port')) return;
      if (node.sourceIndex !== undefined) {
        highlightMessage(node.sourceIndex);
      }
    });

    // 双击编辑
    g.addEventListener('dblclick', () => {
      editNodeContent(node.id);
    });

    // 右键菜单
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showNodeContextMenu(e, node.id);
    });

    nodesLayer.appendChild(g);
  });
}

// 在登录后加载思维流列表
const originalLoadUserData = window.loadUserData;
window.loadUserData = async function () {
  if (originalLoadUserData) await originalLoadUserData();
  await loadFlowsList();
};

// 扩展初始化函数
const originalInitChatFlowCanvas = initChatFlowCanvas;
initChatFlowCanvas = function () {
  originalInitChatFlowCanvas();
  initChatFlowDragDrop();
  initEdgeConnection();
  initAutoSave();
};

// ==================== Phase 3+4: 完整功能实现 ====================

// 当前工具模式
chatFlowState.currentTool = 'select';
chatFlowState.selectedNodes = [];
chatFlowState.connectingFrom = null;

// 设置画布工具
function setCanvasTool(tool) {
  chatFlowState.currentTool = tool;

  // 更新工具按钮状态
  document.querySelectorAll('.canvas-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });

  // 更新光标
  const canvas = document.getElementById('infiniteCanvas');
  if (canvas) {
    canvas.style.cursor = tool === 'connect' ? 'crosshair' : 'grab';
  }
}

// ==================== 拖拽功能 ====================

// 初始化 Chat Flow 拖拽功能
function initChatFlowDragDrop() {
  if (window._chatFlowDragDropInitialized) return;

  const container = document.getElementById('chatflowCanvasContainer');
  if (!container) return;

  window._chatFlowDragDropInitialized = true;
  console.log('📦 初始化 Canvas 拖拽支持');

  container.addEventListener('dragover', (e) => {
    e.preventDefault(); // 允许放置
    e.dataTransfer.dropEffect = 'copy';
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    console.log('📥 Canvas 收到 Drop 事件');

    try {
      const dataStr = e.dataTransfer.getData('text/plain');
      if (!dataStr) return;

      const data = JSON.parse(dataStr);

      // 检查是否是选中文本拖拽
      if (data.type === 'selected-text' && data.text) {
        // 计算画布坐标 (考虑平移和缩放)
        const rect = container.getBoundingClientRect();
        const x = (e.clientX - rect.left - chatFlowState.canvas.translateX) / chatFlowState.canvas.scale;
        const y = (e.clientY - rect.top - chatFlowState.canvas.translateY) / chatFlowState.canvas.scale;

        // 创建文本节点
        const nodeId = `node-${Date.now()}`;
        const node = {
          id: nodeId,
          type: 'text',
          content: data.text.substring(0, 100) + (data.text.length > 100 ? '...' : ''), // 预览内容
          fullContent: data.text, // 完整内容
          x: x,
          y: y,
          width: 200,
          height: 100
        };

        chatFlowState.nodes.push(node);
        renderCanvasNodes();
        renderEdges();
        saveFlowState();

        console.log('✅ 拖拽创建节点成功:', nodeId, '坐标:', parseInt(x), parseInt(y));
      }
    } catch (err) {
      console.error('❌ 处理拖拽数据失败:', err);
    }
  });
}

// ==================== 连线功能 ====================

// 初始化连线功能
function initEdgeConnection() {
  const canvasContainer = document.getElementById('chatflowCanvasContainer');
  const svg = document.getElementById('infiniteCanvas');
  if (!canvasContainer || !svg) return;

  // 获取画布坐标转换函数
  function getCanvasPoint(clientX, clientY) {
    const rect = canvasContainer.getBoundingClientRect();
    const x = (clientX - rect.left - chatFlowState.canvas.translateX) / chatFlowState.canvas.scale;
    const y = (clientY - rect.top - chatFlowState.canvas.translateY) / chatFlowState.canvas.scale;
    return { x, y };
  }

  // 修复: 支持选择模式和连线模式都能通过端口连线
  canvasContainer.addEventListener('mousedown', (e) => {
    // 检查是否点击了节点端口
    const port = e.target.closest('.canvas-node-port');
    const nodeEl = e.target.closest('.canvas-node');

    if (port && nodeEl) {
      // 从端口开始连线（选择模式和连线模式都支持）
      if (chatFlowState.currentTool === 'connect' || chatFlowState.currentTool === 'select') {
        chatFlowState.connectingFrom = nodeEl.dataset.nodeId;
        const node = chatFlowState.nodes.find(n => n.id === chatFlowState.connectingFrom);
        if (node) {
          const previewLine = document.getElementById('edgePreviewLine');
          if (previewLine) {
            const startX = node.x + node.width / 2;
            const startY = node.y + node.height / 2;
            previewLine.setAttribute('x1', startX);
            previewLine.setAttribute('y1', startY);
            previewLine.setAttribute('x2', startX);
            previewLine.setAttribute('y2', startY);
            previewLine.style.display = 'block';
          }
        }
        e.stopPropagation();
      }
    } else if (chatFlowState.currentTool === 'connect' && nodeEl) {
      // 连线模式下点击节点任意位置也能开始连线
      chatFlowState.connectingFrom = nodeEl.dataset.nodeId;
      const node = chatFlowState.nodes.find(n => n.id === chatFlowState.connectingFrom);
      if (node) {
        const previewLine = document.getElementById('edgePreviewLine');
        if (previewLine) {
          const startX = node.x + node.width / 2;
          const startY = node.y + node.height / 2;
          previewLine.setAttribute('x1', startX);
          previewLine.setAttribute('y1', startY);
          previewLine.setAttribute('x2', startX);
          previewLine.setAttribute('y2', startY);
          previewLine.style.display = 'block';
        }
      }
    }
  });

  // 修复: 预览线跟随鼠标（改进坐标计算）
  canvasContainer.addEventListener('mousemove', (e) => {
    if (!chatFlowState.connectingFrom) return;

    const previewLine = document.getElementById('edgePreviewLine');
    if (previewLine) {
      const point = getCanvasPoint(e.clientX, e.clientY);
      previewLine.setAttribute('x2', point.x);
      previewLine.setAttribute('y2', point.y);
    }
  });

  canvasContainer.addEventListener('mouseup', (e) => {
    if (!chatFlowState.connectingFrom) return;

    const previewLine = document.getElementById('edgePreviewLine');
    if (previewLine) {
      previewLine.style.display = 'none';
    }

    const nodeEl = e.target.closest('.canvas-node');
    if (nodeEl && nodeEl.dataset.nodeId !== chatFlowState.connectingFrom) {
      createEdge(chatFlowState.connectingFrom, nodeEl.dataset.nodeId);
    }

    chatFlowState.connectingFrom = null;
  });

  // 修复#6: 支持触控板手势
  let lastTouchDistance = 0;
  let lastTouchCenter = { x: 0, y: 0 };

  canvasContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      // 双指捏合缩放
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      lastTouchDistance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      lastTouchCenter = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2
      };
    }
  }, { passive: true });

  canvasContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const currentDistance = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      const currentCenter = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2
      };

      // 缩放
      if (lastTouchDistance > 0) {
        const scale = currentDistance / lastTouchDistance;
        const newScale = Math.min(Math.max(chatFlowState.canvas.scale * scale, 0.1), 5);
        chatFlowState.canvas.scale = newScale;
        updateCanvasTransform();
        updateZoomDisplay();
      }

      // 平移
      chatFlowState.canvas.translateX += currentCenter.x - lastTouchCenter.x;
      chatFlowState.canvas.translateY += currentCenter.y - lastTouchCenter.y;
      updateCanvasTransform();

      lastTouchDistance = currentDistance;
      lastTouchCenter = currentCenter;
    }
  }, { passive: false });

  canvasContainer.addEventListener('touchend', () => {
    lastTouchDistance = 0;
  }, { passive: true });
}


// 创建边
function createEdge(fromId, toId, label = '') {
  const edgeId = `edge-${Date.now()}`;
  const edge = {
    id: edgeId,
    from: fromId,
    to: toId,
    label: label
  };

  chatFlowState.edges.push(edge);
  renderEdges();
  saveFlowState();
  console.log('✅ 创建连线:', edgeId);
}

// 渲染所有边
function renderEdges() {
  const edgesLayer = document.getElementById('edgesLayer');
  if (!edgesLayer) return;

  edgesLayer.innerHTML = '';

  chatFlowState.edges.forEach(edge => {
    const fromNode = chatFlowState.nodes.find(n => n.id === edge.from);
    const toNode = chatFlowState.nodes.find(n => n.id === edge.to);

    if (!fromNode || !toNode) return;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'canvas-edge');
    g.setAttribute('data-edge-id', edge.id);

    // 计算起点和终点
    const x1 = fromNode.x + fromNode.width / 2;
    const y1 = fromNode.y + fromNode.height;
    const x2 = toNode.x + toNode.width / 2;
    const y2 = toNode.y;

    // 贝塞尔曲线
    const midY = (y1 + y2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`);
    path.setAttribute('stroke', 'var(--text-tertiary)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('marker-end', 'url(#arrowhead)');
    g.appendChild(path);

    // 标签 - 修复字体太粗问题
    if (edge.label) {
      const labelX = (x1 + x2) / 2;
      const labelY = midY;

      const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      labelBg.setAttribute('class', 'canvas-edge-label-bg');
      labelBg.setAttribute('x', labelX - 30);
      labelBg.setAttribute('y', labelY - 10);
      labelBg.setAttribute('width', '60');
      labelBg.setAttribute('height', '20');
      labelBg.setAttribute('rx', '4');
      labelBg.setAttribute('fill', 'var(--bg-secondary)');
      labelBg.setAttribute('stroke', 'var(--border-color)');
      labelBg.setAttribute('stroke-width', '1');
      g.appendChild(labelBg);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('class', 'canvas-edge-label');
      text.setAttribute('x', labelX);
      text.setAttribute('y', labelY + 4);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '11');
      text.setAttribute('font-weight', '400'); // 修复: 使用正常字重
      text.setAttribute('fill', 'var(--text-secondary)');
      text.textContent = edge.label;
      g.appendChild(text);
    }

    // 修复: 右键菜单删除（替代双击删除）
    g.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showEdgeContextMenu(e, edge.id);
    });

    // 删除模式点击删除
    g.addEventListener('click', () => {
      if (chatFlowState.currentTool === 'delete') {
        chatFlowState.edges = chatFlowState.edges.filter(e => e.id !== edge.id);
        renderEdges();
        saveFlowState();
      }
    });

    edgesLayer.appendChild(g);
  });
}

// 新增: 边的右键菜单
function showEdgeContextMenu(e, edgeId) {
  // 移除已有菜单
  document.querySelectorAll('.edge-context-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'edge-context-menu';
  menu.style.cssText = `
        position: fixed;
        left: ${e.clientX}px;
        top: ${e.clientY}px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 4px 0;
        min-width: 100px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        z-index: 1000;
      `;

  const deleteItem = document.createElement('div');
  deleteItem.style.cssText = 'padding: 8px 16px; cursor: pointer; font-size: 13px; color: var(--text-secondary);';
  deleteItem.textContent = appState.language === 'zh-CN' ? '删除连线' : 'Delete Connection';
  deleteItem.addEventListener('mouseenter', () => {
    deleteItem.style.background = 'var(--bg-hover)';
    deleteItem.style.color = 'var(--text-primary)';
  });
  deleteItem.addEventListener('mouseleave', () => {
    deleteItem.style.background = 'transparent';
    deleteItem.style.color = 'var(--text-secondary)';
  });
  deleteItem.addEventListener('click', () => {
    chatFlowState.edges = chatFlowState.edges.filter(e => e.id !== edgeId);
    renderEdges();
    saveFlowState();
    menu.remove();
  });
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);

  // 点击其他地方关闭菜单
  setTimeout(() => {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }, { once: true });
  }, 100);
}


// ==================== 便签功能 ====================

function addStickyNote() {
  const nodeId = `sticky-${Date.now()}`;
  const node = {
    id: nodeId,
    type: 'sticky',
    content: appState.language === 'zh-CN' ? '双击编辑便签...' : 'Double click to edit...',
    fullContent: '',
    x: 100 - chatFlowState.canvas.translateX / chatFlowState.canvas.scale,
    y: 100 - chatFlowState.canvas.translateY / chatFlowState.canvas.scale,
    width: 150,
    height: 100,
    color: '#f5d547'
  };

  chatFlowState.nodes.push(node);
  renderCanvasNodes();
  saveFlowState();

  // 创建后立即进入编辑模式
  setTimeout(() => {
    editNodeInline(nodeId);
  }, 100);
}

// ==================== 删除节点 ====================

function deleteSelectedNodes() {
  const selected = chatFlowState.nodes.filter(n =>
    document.querySelector(`.canvas-node[data-node-id="${n.id}"].selected`)
  );

  if (selected.length === 0) {
    alert(appState.language === 'zh-CN' ? '请先选择要删除的节点' : 'Please select nodes to delete');
    return;
  }

  const confirmMsg = appState.language === 'zh-CN'
    ? `确定删除 ${selected.length} 个节点？`
    : `Delete ${selected.length} nodes?`;

  if (!confirm(confirmMsg)) return;

  selected.forEach(node => {
    chatFlowState.nodes = chatFlowState.nodes.filter(n => n.id !== node.id);
    chatFlowState.edges = chatFlowState.edges.filter(e => e.from !== node.id && e.to !== node.id);
  });

  renderCanvasNodes();
  renderEdges();
  saveFlowState();
}

// ==================== AI 拆解 ====================

async function aiDecomposeSelected() {
  const selected = document.querySelector('.canvas-node.selected');
  if (!selected) {
    alert(appState.language === 'zh-CN' ? '请先选择一个节点进行拆解' : 'Please select a node to decompose');
    return;
  }

  const nodeId = selected.dataset.nodeId;
  const node = chatFlowState.nodes.find(n => n.id === nodeId);
  if (!node) return;

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({
        messages: [{
          role: 'user',
          content: `请将以下内容拆解成3-5个要点，每个要点用一行表示，不需要编号：\n\n${node.fullContent || node.content}`
        }],
        model: 'kimi-k2',
        stream: false
      })
    });

    if (!response.ok) throw new Error('API 请求失败');

    const result = await response.json();
    const points = result.content.split('\n').filter(l => l.trim());

    // 为每个要点创建子节点
    points.forEach((point, i) => {
      const childNode = {
        id: `node-${Date.now()}-${i}`,
        type: 'assistant',
        content: point.slice(0, 100),
        fullContent: point,
        x: node.x + (i - points.length / 2) * 220,
        y: node.y + 150,
        width: 180,
        height: 80
      };
      chatFlowState.nodes.push(childNode);
      createEdge(nodeId, childNode.id, '拆解');
    });

    renderCanvasNodes();
    renderEdges();
    saveFlowState();

  } catch (error) {
    console.error('AI 拆解失败:', error);
    alert(appState.language === 'zh-CN' ? 'AI 拆解失败，请重试' : 'AI decomposition failed, please retry');
  }
}

// ==================== 自动布局 ====================

function autoLayoutNodes() {
  if (chatFlowState.nodes.length === 0) return;

  // 简单的网格布局
  const cols = Math.ceil(Math.sqrt(chatFlowState.nodes.length));
  const gapX = 250;
  const gapY = 150;
  const startX = 100;
  const startY = 100;

  chatFlowState.nodes.forEach((node, i) => {
    node.x = startX + (i % cols) * gapX;
    node.y = startY + Math.floor(i / cols) * gapY;
  });

  renderCanvasNodes();
  renderEdges();
  saveFlowState();
  canvasResetView();
}

// ==================== 双向高亮 ====================

function highlightMessage(sourceIndex) {
  // 清除所有高亮
  document.querySelectorAll('.chatflow-message.highlighted').forEach(el => {
    el.classList.remove('highlighted');
  });

  // 高亮对应消息
  const msgEl = document.querySelector(`.chatflow-message[data-msg-index="${sourceIndex}"]`);
  if (msgEl) {
    msgEl.classList.add('highlighted');
    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function highlightNode(nodeId) {
  // 清除所有高亮
  document.querySelectorAll('.canvas-node.highlighted').forEach(el => {
    el.classList.remove('highlighted');
  });

  // 高亮对应节点
  const nodeEl = document.querySelector(`.canvas-node[data-node-id="${nodeId}"]`);
  if (nodeEl) {
    nodeEl.classList.add('highlighted');
  }
}

// ==================== 导出功能 ====================

function toggleExportMenu() {
  const menu = document.getElementById('canvasExportMenu');
  if (menu) {
    menu.classList.toggle('active');
  }
}

async function exportCanvas(format) {
  toggleExportMenu();

  switch (format) {
    case 'json':
      exportAsJSON();
      break;
    case 'mermaid':
      exportAsMermaid();
      break;
    case 'png':
    case 'svg':
      await exportAsImage(format);
      break;
  }
}

function exportAsJSON() {
  const data = {
    nodes: chatFlowState.nodes,
    edges: chatFlowState.edges,
    messages: chatFlowState.messages,
    exportedAt: new Date().toISOString()
  };

  downloadFile(
    JSON.stringify(data, null, 2),
    `chatflow-${Date.now()}.json`,
    'application/json'
  );
}

function exportAsMermaid() {
  let mermaid = 'graph TD\n';

  // 添加节点
  chatFlowState.nodes.forEach(node => {
    const label = node.content.replace(/"/g, "'").slice(0, 50);
    const shape = node.type === 'user' ? `[${label}]` : `(${label})`;
    mermaid += `  ${node.id}${shape}\n`;
  });

  // 添加连线
  chatFlowState.edges.forEach(edge => {
    const arrow = edge.label ? `-->|${edge.label}|` : '-->';
    mermaid += `  ${edge.from} ${arrow} ${edge.to}\n`;
  });

  downloadFile(mermaid, `chatflow-${Date.now()}.mmd`, 'text/plain');

  downloadFile(mermaid, `chatflow-${Date.now()}.mmd`, 'text/plain');

  // 也复制到剪贴板
  navigator.clipboard.writeText(mermaid).then(() => {
    showToast(appState.language === 'zh-CN' ? 'Mermaid 代码已复制到剪贴板' : 'Mermaid code copied to clipboard');
  });
}

async function exportAsImage(format) {
  const svg = document.getElementById('infiniteCanvas');
  if (!svg) return;

  // 克隆 SVG
  const clone = svg.cloneNode(true);
  clone.setAttribute('width', '2000');
  clone.setAttribute('height', '1500');

  if (format === 'svg') {
    const svgData = new XMLSerializer().serializeToString(clone);
    downloadFile(svgData, `chatflow-${Date.now()}.svg`, 'image/svg+xml');
  } else {
    // PNG 导出需要 canvas
    const svgData = new XMLSerializer().serializeToString(clone);
    const canvas = document.createElement('canvas');
    canvas.width = 2000;
    canvas.height = 1500;
    const ctx = canvas.getContext('2d');

    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chatflow-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      });
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  }
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ==================== 节点编辑 ====================

function editNodeContent(nodeId) {
  editNodeInline(nodeId);
}

/**
 * 内联编辑节点内容（使用网页模态框代替浏览器 prompt）
 */
function editNodeInline(nodeId) {
  const node = chatFlowState.nodes.find(n => n.id === nodeId);
  if (!node) return;

  // 移除已有的编辑模态框
  document.querySelectorAll('.node-edit-modal').forEach(el => el.remove());

  // 计算模态框位置（在节点附近）
  const canvasContainer = document.getElementById('chatflowCanvasContainer');
  const canvasRect = canvasContainer?.getBoundingClientRect() || { left: 0, top: 0 };
  const nodeScreenX = canvasRect.left + node.x * chatFlowState.canvas.scale + chatFlowState.canvas.translateX;
  const nodeScreenY = canvasRect.top + node.y * chatFlowState.canvas.scale + chatFlowState.canvas.translateY;

  // 创建模态框
  const modal = document.createElement('div');
  modal.className = 'node-edit-modal';
  modal.style.cssText = `
    position: fixed;
    left: ${Math.min(Math.max(nodeScreenX, 20), window.innerWidth - 320)}px;
    top: ${Math.min(Math.max(nodeScreenY, 20), window.innerHeight - 200)}px;
    width: 300px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    z-index: 2000;
    animation: menuFadeIn 0.15s ease-out;
  `;

  // 标题
  const title = document.createElement('div');
  title.style.cssText = 'font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 12px;';

  if (node.type === 'sticky') {
    title.textContent = appState.language === 'zh-CN' ? '编辑便签' : 'Edit Sticky Note';
  } else {
    title.textContent = appState.language === 'zh-CN' ? '编辑节点' : 'Edit Node';
  }

  modal.appendChild(title);

  // 文本输入框
  const textarea = document.createElement('textarea');
  textarea.style.cssText = `
    width: 100%;
    min-height: 100px;
    max-height: 200px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 10px;
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    resize: vertical;
    outline: none;
    line-height: 1.5;
  `;
  textarea.value = node.fullContent || node.content || '';
  textarea.placeholder = node.type === 'sticky'
    ? (appState.language === 'zh-CN' ? '输入便签内容...' : 'Enter note content...')
    : (appState.language === 'zh-CN' ? '输入节点内容...' : 'Enter node content...');
  modal.appendChild(textarea);

  // 按钮容器
  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;';

  // 取消按钮
  const cancelBtn = document.createElement('button');
  cancelBtn.style.cssText = `
    padding: 8px 16px;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  `;
  cancelBtn.textContent = appState.language === 'zh-CN' ? '取消' : 'Cancel';
  cancelBtn.addEventListener('click', () => modal.remove());
  cancelBtn.addEventListener('mouseenter', () => cancelBtn.style.background = 'var(--bg-hover)');
  cancelBtn.addEventListener('mouseleave', () => cancelBtn.style.background = 'transparent');
  btnContainer.appendChild(cancelBtn);

  // 保存按钮
  const saveBtn = document.createElement('button');
  saveBtn.style.cssText = `
    padding: 8px 16px;
    background: var(--color-saturn-yellow);
    border: none;
    border-radius: 6px;
    color: #000;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  `;
  saveBtn.textContent = '保存';
  saveBtn.addEventListener('click', () => {
    const newContent = textarea.value.trim();
    if (newContent) {
      node.content = newContent.slice(0, 200);
      node.fullContent = newContent;
    } else {
      node.content = '';
      node.fullContent = '';
    }
    renderCanvasNodes();
    renderEdges();
    saveFlowState();
    modal.remove();
  });
  saveBtn.addEventListener('mouseenter', () => saveBtn.style.opacity = '0.9');
  saveBtn.addEventListener('mouseleave', () => saveBtn.style.opacity = '1');
  btnContainer.appendChild(saveBtn);

  modal.appendChild(btnContainer);

  document.body.appendChild(modal);

  // 自动聚焦输入框
  setTimeout(() => {
    textarea.focus();
    textarea.select();
  }, 50);

  // 按 Escape 关闭
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      modal.remove();
    } else if (e.key === 'Enter' && e.ctrlKey) {
      // Ctrl+Enter 保存
      saveBtn.click();
    }
  });

  // 点击外部关闭
  setTimeout(() => {
    const closeOnClickOutside = (e) => {
      if (!modal.contains(e.target)) {
        modal.remove();
        document.removeEventListener('mousedown', closeOnClickOutside);
      }
    };
    document.addEventListener('mousedown', closeOnClickOutside);
  }, 100);
}

// ==================== 右键上下文菜单 ====================

function showNodeContextMenu(e, nodeId) {
  // 移除已有菜单
  document.querySelectorAll('.node-context-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'node-context-menu';
  menu.style.cssText = `
        position: fixed;
        left: ${e.clientX}px;
        top: ${e.clientY}px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 4px 0;
        min-width: 140px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        z-index: 1000;
      `;

  const menuItems = [
    { text: appState.language === 'zh-CN' ? '编辑内容' : 'Edit Content', action: () => editNodeContent(nodeId) },
    { text: appState.language === 'zh-CN' ? '添加注释' : 'Add Annotation', action: () => addAnnotationToNode(nodeId) },
    { text: appState.language === 'zh-CN' ? '删除节点' : 'Delete Node', action: () => deleteNode(nodeId) }
  ];

  menuItems.forEach(item => {
    const menuItem = document.createElement('div');
    menuItem.className = 'context-menu-item';
    menuItem.style.cssText = 'padding: 8px 16px; cursor: pointer; font-size: 13px; color: var(--text-secondary);';
    menuItem.textContent = item.text;
    menuItem.addEventListener('mouseenter', () => {
      menuItem.style.background = 'var(--bg-hover)';
      menuItem.style.color = 'var(--text-primary)';
    });
    menuItem.addEventListener('mouseleave', () => {
      menuItem.style.background = 'transparent';
      menuItem.style.color = 'var(--text-secondary)';
    });
    menuItem.addEventListener('click', () => {
      item.action();
      menu.remove();
    });
    menu.appendChild(menuItem);
  });

  document.body.appendChild(menu);

  // 点击其他地方关闭菜单
  setTimeout(() => {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }, { once: true });
  }, 100);
}

// 添加注释到节点旁边
function addAnnotationToNode(targetNodeId) {
  const targetNode = chatFlowState.nodes.find(n => n.id === targetNodeId);
  if (!targetNode) return;

  const promptMsg = appState.language === 'zh-CN' ? '输入注释内容:' : 'Enter annotation:';
  const annotationText = prompt(promptMsg);
  if (!annotationText || !annotationText.trim()) return;

  const stickyId = `sticky-${Date.now()}`;
  const sticky = {
    id: stickyId,
    type: 'sticky',
    content: annotationText.trim(),
    fullContent: annotationText.trim(),
    x: targetNode.x + targetNode.width + 20,
    y: targetNode.y,
    width: 120,
    height: 80,
    color: '#f5d547',
    attachedTo: targetNodeId // 吸附关系
  };

  chatFlowState.nodes.push(sticky);
  // 创建连线表示关联
  createEdge(targetNodeId, stickyId, '注释');
  renderCanvasNodes();
  saveFlowState();
}

// 删除单个节点
function deleteNode(nodeId) {
  const confirmMsg = appState.language === 'zh-CN' ? '确定删除此节点？' : 'Delete this node?';
  if (!confirm(confirmMsg)) return;
  chatFlowState.nodes = chatFlowState.nodes.filter(n => n.id !== nodeId);
  chatFlowState.edges = chatFlowState.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
  renderCanvasNodes();
  renderEdges();
  saveFlowState();
}

// ==================== 连线标签预设菜单 ====================

function showEdgeLabelMenu(edgeId, x, y) {
  // 移除已有菜单
  document.querySelectorAll('.edge-label-menu').forEach(el => el.remove());

  const menu = document.createElement('div');
  menu.className = 'edge-label-menu';
  menu.style.cssText = `
        position: fixed;
        left: ${x}px;
        top: ${y}px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 4px 0;
        min-width: 100px;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        z-index: 1000;
      `;

  const presetLabels = appState.language === 'zh-CN'
    ? ['导致', '包含', '反驳', '举例', '下一步', '自定义...']
    : ['Caused by', 'Includes', 'Refutes', 'Example', 'Next Step', 'Custom...'];

  presetLabels.forEach(label => {
    const item = document.createElement('div');
    item.style.cssText = 'padding: 8px 16px; cursor: pointer; font-size: 13px; color: var(--text-secondary);';
    item.textContent = label;
    item.addEventListener('mouseenter', () => {
      item.style.background = 'var(--bg-hover)';
      item.style.color = 'var(--text-primary)';
    });
    item.addEventListener('mouseleave', () => {
      item.style.background = 'transparent';
      item.style.color = 'var(--text-secondary)';
    });
    item.addEventListener('click', () => {
      let finalLabel = label;
      const customLabel = appState.language === 'zh-CN' ? '自定义...' : 'Custom...';
      const promptMsg = appState.language === 'zh-CN' ? '输入连线标签:' : 'Enter edge label:';

      if (label === customLabel) {
        finalLabel = prompt(promptMsg) || '';
      }

      const edge = chatFlowState.edges.find(e => e.id === edgeId);
      if (edge) {
        edge.label = finalLabel;
        renderEdges();
        saveFlowState();
      }
      menu.remove();
    });
    menu.appendChild(item);
  });

  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', function closeMenu() {
      menu.remove();
      document.removeEventListener('click', closeMenu);
    }, { once: true });
  }, 100);
}

// 修改 createEdge 以显示标签菜单
const originalCreateEdge = createEdge;
createEdge = function (fromId, toId, label = '') {
  originalCreateEdge(fromId, toId, label);

  // 如果没有传入标签，显示预设菜单
  if (!label) {
    const toNode = chatFlowState.nodes.find(n => n.id === toId);
    if (toNode) {
      const canvasRect = document.getElementById('chatflowCanvasContainer')?.getBoundingClientRect();
      if (canvasRect) {
        const x = canvasRect.left + (toNode.x + toNode.width / 2) * chatFlowState.canvas.scale + chatFlowState.canvas.translateX;
        const y = canvasRect.top + toNode.y * chatFlowState.canvas.scale + chatFlowState.canvas.translateY;
        const lastEdge = chatFlowState.edges[chatFlowState.edges.length - 1];
        if (lastEdge) {
          showEdgeLabelMenu(lastEdge.id, x, y);
        }
      }
    }
  }
};

// ==================== 自动保存 ====================

let autoSaveInterval = null;

function initAutoSave() {
  // 每 5 秒自动保存
  autoSaveInterval = setInterval(() => {
    if (chatFlowState.currentFlowId) {
      saveFlowState();
      console.log('⏱️ 自动保存完成');
    }
  }, 5000);
}

// ==================== 结构回传 (序列化到 Prompt) ====================

/**
 * 将画布内容序列化为 LLM 可理解的文本格式
 * 包含：所有节点、便签、连线关系及标签
 */
function serializeCanvasToPrompt() {
  if (chatFlowState.nodes.length === 0 && chatFlowState.edges.length === 0) return '';

  let context = '\n\n---\n📋 **当前思维画布内容：**\n\n';

  // 1. 输出所有节点
  if (chatFlowState.nodes.length > 0) {
    context += '**节点列表：**\n';
    chatFlowState.nodes.forEach((node, index) => {
      const typeLabel = {
        'user': '👤 用户',
        'assistant': '🤖 AI',
        'sticky': '📌 便签',
        'text': '📝 文本'
      }[node.type] || '📄 节点';

      const content = (node.fullContent || node.content || '').replace(/\n/g, ' ').slice(0, 100);
      context += `${index + 1}. [${node.id}] ${typeLabel}: "${content}"${content.length >= 100 ? '...' : ''}\n`;
    });
    context += '\n';
  }

  // 2. 输出便签内容（特别标注）
  const stickyNotes = chatFlowState.nodes.filter(n => n.type === 'sticky');
  if (stickyNotes.length > 0) {
    context += '**便签备注：**\n';
    stickyNotes.forEach((note, index) => {
      const content = (note.fullContent || note.content || '').replace(/\n/g, ' ');
      const attachedInfo = note.attachedTo ? ` (附注于: ${note.attachedTo})` : '';
      context += `- 便签${index + 1}: "${content}"${attachedInfo}\n`;
    });
    context += '\n';
  }

  // 3. 输出连线关系
  if (chatFlowState.edges.length > 0) {
    context += '**节点关系（连线）：**\n';
    chatFlowState.edges.forEach((edge, index) => {
      const fromNode = chatFlowState.nodes.find(n => n.id === edge.from);
      const toNode = chatFlowState.nodes.find(n => n.id === edge.to);
      const fromLabel = fromNode ? (fromNode.content || '').slice(0, 30) : edge.from;
      const toLabel = toNode ? (toNode.content || '').slice(0, 30) : edge.to;
      const relationLabel = edge.label ? ` --「${edge.label}」-->` : ' -->';
      context += `${index + 1}. "${fromLabel}"${relationLabel} "${toLabel}"\n`;
    });
    context += '\n';
  }

  // 4. 输出 Mermaid 图表（便于 AI 理解结构）
  context += '**结构图（Mermaid格式）：**\n```mermaid\ngraph TD\n';
  chatFlowState.nodes.forEach(node => {
    const label = (node.content || '').replace(/"/g, "'").replace(/\n/g, ' ').slice(0, 40);
    let shape;
    switch (node.type) {
      case 'user': shape = `["${label}"]`; break;
      case 'assistant': shape = `("${label}")`; break;
      case 'sticky': shape = `>"${label}"]`; break;
      default: shape = `["${label}"]`;
    }
    context += `  ${node.id}${shape}\n`;
  });
  chatFlowState.edges.forEach(edge => {
    const arrow = edge.label ? `-->|${edge.label}|` : '-->';
    context += `  ${edge.from} ${arrow} ${edge.to}\n`;
  });
  context += '```\n\n---\n';

  return context;
}

// 不再使用装饰器模式，将画布上下文直接整合到消息发送逻辑中
// 见下方 sendChatFlowMessageWithCanvasContext


// ==================== 会话管理 ====================

// 支持分页加载的 loadSessions
// reset=true: 重新加载（初始化/刷新）
// reset=false: 追加加载（滚动加载更多）
async function loadSessions(reset = true) {
  // 如果正在加载，跳过
  if (appState.sessionsPagination.isLoading) return;
  // 如果不是重置且没有更多数据，跳过
  if (!reset && !appState.sessionsPagination.hasMore) return;

  // 如果是重置，清空现有数据
  if (reset) {
    appState.sessions = [];
    appState.sessionsPagination.offset = 0;
    appState.sessionsPagination.hasMore = true;
  }

  appState.sessionsPagination.isLoading = true;

  try {
    const { offset, limit } = appState.sessionsPagination;
    const response = await fetch(
      `${API_BASE}/sessions?offset=${offset}&limit=${limit}`,
      { headers: { 'Authorization': `Bearer ${appState.token}` } }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // 追加新会话到现有列表（从最新到最旧）
    appState.sessions = [...appState.sessions, ...data.sessions];
    appState.sessionsPagination.hasMore = data.hasMore;
    appState.sessionsPagination.offset += data.sessions.length;

    console.log(`✅ 加载了 ${data.sessions.length} 个会话，总计 ${appState.sessions.length}，还有更多: ${data.hasMore}`);
    renderSessions();

  } catch (error) {
    console.error('❌ 加载会话失败:', error);
    if (reset) {
      appState.sessions = [];
    }
    renderSessions();
  } finally {
    appState.sessionsPagination.isLoading = false;
  }
}

function showWelcome() {
  const welcomeScreen = document.getElementById('welcomeScreen');
  const messagesList = document.getElementById('messagesList');

  if (welcomeScreen) {
    welcomeScreen.style.display = 'flex';
    welcomeScreen.classList.remove('hidden');
  }

  if (messagesList) {
    messagesList.style.display = 'none';
  }

  // 隐藏对话索引导航器
  const navigator = document.getElementById('chatIndexNavigator');
  if (navigator) {
    navigator.classList.remove('visible');
    navigator.classList.add('hidden');
  }
}

// 别名，确保兼容性
const renderWelcomeScreen = showWelcome;

// 判断用户是否在底部附近（阈值50px）
function isNearBottom() {
  const container = document.getElementById('chatContainer');
  if (!container) return true;
  const threshold = 50;
  return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
}

// 智能滚动到底部：只有用户在底部附近时才自动滚动
function scrollToBottom(force = false) {
  const container = document.getElementById('chatContainer');
  if (!container) return;

  // 如果用户主动向上滚动了，不强制滚动（除非 force=true）
  if (appState.userScrolledUp && !force) {
    return;
  }

  setTimeout(() => {
    container.scrollTop = container.scrollHeight;
    appState.userScrolledUp = false;
  }, 100);
}

// 初始化聊天容器的滚动监听
let chatScrollListenerInitialized = false;

function initChatScrollListener() {
  const container = document.getElementById('chatContainer');
  if (!container || chatScrollListenerInitialized) return;

  chatScrollListenerInitialized = true;

  container.addEventListener('scroll', () => {
    const nearBottom = isNearBottom();

    // 如果不在底部附近，说明用户向上滚动了
    if (!nearBottom) {
      appState.userScrolledUp = true;
    } else {
      // 用户滚到了底部附近，重新启用自动滚动
      appState.userScrolledUp = false;
    }
  }, { passive: true });

  console.log('✅ 智能滚动监听器已初始化');
}

// 初始化 Material Design 涟漪效果
function initRippleEffect() {
  // 为工具栏按钮添加涟漪效果
  document.addEventListener('click', function (e) {
    const button = e.target.closest('.toolbar-btn, .model-select-custom');
    if (!button) return;

    // 创建涟漪元素
    const ripple = document.createElement('span');
    ripple.classList.add('ripple-effect');

    // 计算涟漪位置
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;

    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;

    // 添加到按钮
    button.appendChild(ripple);

    // 动画结束后移除
    ripple.addEventListener('animationend', () => {
      ripple.remove();
    });
  });
}

async function createNewSession() {
  try {
    const response = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: appState.language === 'zh-CN' ? '新对话' : 'New Chat',
        model: appState.selectedModel || 'auto'  // 默认为auto或当前选择的模型
      })
    });

    const data = await response.json();

    if (data.success) {
      await loadSessions();
      await loadSession(data.sessionId);

      // 移除移动端自动弹出侧边栏
      // if (window.innerWidth <= 768) {
      //   toggleSidebar();
      // }
    }
  } catch (error) {
    console.error('❌ 创建会话失败:', error);
    alert(appState.language === 'zh-CN' ? '创建对话失败' : 'Failed to create chat');
  }
}

async function loadSession(sessionId) {
  try {
    console.log('📖 加载会话:', sessionId);

    const response = await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const messages = await response.json();

    appState.currentSession = appState.sessions.find(s => s.id === sessionId);
    appState.messages = Array.isArray(messages) ? messages : [];

    console.log(`✅ 加载到 ${messages.length} 条消息`);

    renderMessages();
    renderSessions();

    // 移除移动端自动弹出侧边栏
    // if (window.innerWidth <= 768) {
    //   toggleSidebar();
    // }

  } catch (error) {
    console.error('❌ 加载消息失败:', error);
    alert(appState.language === 'zh-CN' ? '加载对话失败' : 'Failed to load chat');
  }
}

// ==================== 侧边栏滑动手势 ====================
function initSwipeGestures() {
  const mainContent = document.querySelector('.main-content');
  const sidebar = document.getElementById('sidebar');

  if (!mainContent || !sidebar) return;

  mainContent.addEventListener('touchstart', (e) => {
    appState.touchStartX = e.touches[0].clientX;
    appState.touchStartY = e.touches[0].clientY;
    appState.isSwiping = false;
  }, { passive: true });

  mainContent.addEventListener('touchmove', (e) => {
    if (!appState.touchStartX) return;

    appState.touchMoveX = e.touches[0].clientX;
    const touchMoveY = e.touches[0].clientY;

    const deltaX = appState.touchMoveX - appState.touchStartX;
    const deltaY = Math.abs(touchMoveY - appState.touchStartY);

    if (Math.abs(deltaX) > 30 && Math.abs(deltaX) > deltaY * 2) {
      appState.isSwiping = true;

      if (deltaX > 0 && appState.touchStartX < 50 && !appState.sidebarOpen) {
        const translateX = Math.min(deltaX, sidebar.offsetWidth);
        sidebar.style.transform = `translateX(calc(-100% + ${translateX}px))`;
      }
      else if (deltaX < 0 && appState.sidebarOpen) {
        const translateX = Math.max(deltaX, -sidebar.offsetWidth);
        sidebar.style.transform = `translateX(${translateX}px)`;
      }
    }
  }, { passive: true });

  mainContent.addEventListener('touchend', () => {
    if (!appState.isSwiping) {
      appState.touchStartX = 0;
      return;
    }

    const deltaX = appState.touchMoveX - appState.touchStartX;
    const threshold = sidebar.offsetWidth / 3;

    if (!appState.sidebarOpen && deltaX > threshold) {
      openSidebar();
    } else if (appState.sidebarOpen && deltaX < -threshold) {
      closeSidebar();
    } else {
      sidebar.style.transform = '';
    }

    appState.touchStartX = 0;
    appState.touchMoveX = 0;
    appState.isSwiping = false;
  }, { passive: true });
}

function selectModel(value, displayName) {
  appState.selectedModel = value;

  document.getElementById('selectedModelText').textContent = displayName;

  document.querySelectorAll('.model-option').forEach(option => {
    option.classList.remove('selected');
  });

  // 修复：直接通过data-value属性查找对应的option
  const targetOption = document.querySelector(`.model-option[data-value="${value}"]`);
  if (targetOption) {
    targetOption.classList.add('selected');
  }

  closeModelDropdown();
  updateModelControls();
}

// 修复：添加null检查和安全的DOM操作
function toggleThinkingContent(id) {
  if (!id) return;

  const content = document.getElementById(id);
  const icon = document.getElementById(`${id}-icon`);

  if (!content || !icon) {
    console.warn(`⚠️ 找不到元素: ${id}`);
    return;
  }

  const expanded = content.classList.toggle('expanded');
  const iconName = expanded ? 'expand_less' : 'expand_more';
  icon.outerHTML = getSvgIcon(iconName, 'material-symbols-outlined thinking-expand-icon', 24).replace('<svg', `<svg id="${icon.id}"`);
}

function formatMessage(text) {
  // 简单转义与换行处理，考虑插入代码块渲染等
  if (!text) return '';

  let escaped = text.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // 保留换行
  escaped = escaped.replace(/\n/g, '<br>');

  return escaped;
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/[&<>"']/g, function (m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m];
  });
}

function loadSettings() {
  // 从本地存储加载用户设置（如果存在）
  const savedSettings = localStorage.getItem('rai_settings');
  if (savedSettings) {
    try {
      const settings = JSON.parse(savedSettings);
      if (settings.temperature !== undefined) appState.temperature = settings.temperature;
      if (settings.topP !== undefined) appState.topP = settings.topP;
      if (settings.maxTokens !== undefined) appState.maxTokens = settings.maxTokens;
      if (settings.frequencyPenalty !== undefined) appState.frequencyPenalty = settings.frequencyPenalty;
      if (settings.presencePenalty !== undefined) appState.presencePenalty = settings.presencePenalty;
      if (settings.systemPrompt !== undefined) appState.systemPrompt = settings.systemPrompt;
      console.log('✅ 从本地存储加载设置成功');
    } catch (e) {
      console.warn('⚠️ 解析本地设置失败:', e);
    }
  }
}

// 初始化完毕后调用
if (document.readyState !== 'loading') {
  updateModelControls();
} else {
  document.addEventListener('DOMContentLoaded', updateModelControls);
}

// ==================== 移动端键盘处理器 (iOS VisualViewport 修复版 v2) ====================
class MobileKeyboardHandler {
  constructor(options = {}) {
    this.options = {
      scrollThreshold: options.scrollThreshold || 0.85,
      iosDelay: options.iosDelay || 0,
      androidDelay: options.androidDelay || 300,
      debug: options.debug || false,
      ...options
    };

    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    this.isAndroid = /Android/i.test(navigator.userAgent);
    this.isMobile = this.isIOS || this.isAndroid;

    this.activeInput = null;
    this.keyboardOpen = false;
    this.visualViewport = window.visualViewport;
    this.inputContainer = document.getElementById('inputContainer');

    // iOS 专用状态
    this.lastViewportHeight = window.innerHeight;
    this.keyboardAnimating = false;
    this.rafId = null;
    this.checkInterval = null;

    // 绑定方法
    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.handleFocusOut = this.handleFocusOut.bind(this);
    this.resetPosition = this.resetPosition.bind(this);

    if (this.isMobile) {
      this.init();
    }
  }

  log(...args) {
    if (this.options.debug) console.log('[MobileKeyboard]', ...args);
  }

  init() {
    // 1. VisualViewport 监听 (iOS 核心修复)
    if (this.visualViewport) {
      if (this.isIOS) {
        // iOS: 必须监听 resize 和 scroll 来实时调整位置
        this.visualViewport.addEventListener('resize', this.handleViewportChange);
        this.visualViewport.addEventListener('scroll', this.handleViewportChange);
      } else {
        // Android: 仅监听 resize 用于检测键盘
        this.visualViewport.addEventListener('resize', this.handleViewportChange);
      }
    }

    // 2. Focus 监听
    this.setupFocusListeners();

    // 3. 平台特定修复
    if (this.isAndroid) this.applyAndroidFixes();
    if (this.isIOS) this.applyIOSFixes();

    this.log('MobileKeyboardHandler 初始化完成', { isIOS: this.isIOS, isAndroid: this.isAndroid });
  }

  handleViewportChange() {
    if (!this.visualViewport) return;

    // iOS 专用定位逻辑 - 增强版
    if (this.isIOS && this.inputContainer) {
      // 取消之前的 RAF 防止抖动
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
      }

      this.rafId = requestAnimationFrame(() => {
        const viewport = this.visualViewport;
        const layoutHeight = window.innerHeight;
        const visualHeight = viewport.height;
        const visualTop = viewport.offsetTop;
        const scale = viewport.scale || 1;

        // 计算真实的偏移量（考虑缩放）
        const offset = Math.max(0, (layoutHeight - visualHeight) / scale - visualTop);

        // 检测键盘是否在动画中
        const heightDiff = Math.abs(this.lastViewportHeight - visualHeight);
        this.keyboardAnimating = heightDiff > 5 && heightDiff < 200;
        this.lastViewportHeight = visualHeight;

        // 只有当偏移量显著（>10px）时才应用
        if (offset > 10) {
          // 使用 bottom 定位而非 transform，更稳定
          this.inputContainer.style.position = 'fixed';
          this.inputContainer.style.bottom = `${offset}px`;
          this.inputContainer.style.left = '0';
          this.inputContainer.style.right = '0';
          this.inputContainer.style.transform = 'none';
          this.keyboardOpen = true;
        } else if (!this.keyboardAnimating) {
          this.resetPosition();
        }

        this.log('iOS Adjust:', { layoutHeight, visualHeight, visualTop, offset, animating: this.keyboardAnimating });
      });
    }

    // Android 逻辑 (保持不变)
    if (this.isAndroid) {
      const currentHeight = this.visualViewport.height;
      const keyboardHeight = window.innerHeight - currentHeight;
      this.keyboardOpen = keyboardHeight > 150;
      if (this.keyboardOpen) {
        setTimeout(() => this.adjustAndroidPosition(), 100);
      }
    }
  }

  resetPosition() {
    if (this.inputContainer) {
      this.inputContainer.style.position = '';
      this.inputContainer.style.bottom = '';
      this.inputContainer.style.left = '';
      this.inputContainer.style.right = '';
      this.inputContainer.style.transform = '';
    }
    this.keyboardOpen = false;
  }

  adjustAndroidPosition() {
    if (!this.activeInput) return;
    const inputRect = this.activeInput.getBoundingClientRect();
    const viewportTop = this.visualViewport ? this.visualViewport.offsetTop : 0;
    const viewportHeight = this.visualViewport ? this.visualViewport.height : window.innerHeight;
    const inputBottomRelative = inputRect.bottom - viewportTop;
    const threshold = viewportHeight * 0.85;

    if (inputBottomRelative > threshold) {
      const scrollAmount = inputBottomRelative - threshold + 20;
      if (scrollAmount > 0) {
        window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    }
  }

  setupFocusListeners() {
    document.addEventListener('focusin', this.handleFocusIn);
    document.addEventListener('focusout', this.handleFocusOut);
  }

  handleFocusIn(event) {
    const target = event.target;
    if (!this.isInputElement(target)) return;

    this.activeInput = target;
    this.keyboardOpen = true;

    if (window.expandInput && !window.appState?.inputExpanded) {
      window.expandInput();
    }

    // iOS: 延迟触发位置更新，等待键盘完全弹出
    if (this.isIOS) {
      // 清除之前的检查间隔
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
      }

      // 立即触发一次
      setTimeout(() => this.handleViewportChange(), 100);

      // 持续监听直到键盘稳定（最多1秒）
      let checkCount = 0;
      this.checkInterval = setInterval(() => {
        this.handleViewportChange();
        checkCount++;
        if (checkCount > 10 || !this.keyboardAnimating) {
          clearInterval(this.checkInterval);
          this.checkInterval = null;
        }
      }, 100);
    }

    // Android: 滚动
    if (this.isAndroid) {
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 300);
    }
  }

  handleFocusOut(event) {
    if (event.target === this.activeInput) {
      this.activeInput = null;

      // 清除检查间隔
      if (this.checkInterval) {
        clearInterval(this.checkInterval);
        this.checkInterval = null;
      }

      // 延迟重置，避免键盘收起时的闪烁
      setTimeout(() => {
        if (!this.activeInput) {
          this.resetPosition();
        }
      }, 300);
    }
  }

  applyAndroidFixes() {
    const container = document.getElementById('inputContainer');
    if (container) {
      container.addEventListener('click', (e) => {
        const input = document.getElementById('messageInput');
        if (input && e.target !== input && !e.target.closest('button')) {
          setTimeout(() => input.focus(), 10);
        }
      });
    }
  }

  applyIOSFixes() {
    // 禁用双击缩放
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });

    // 修复 iOS Safari 输入框聚焦时的跳动
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
      // 禁止输入区域的弹性滚动
      messageInput.addEventListener('touchmove', (e) => {
        e.stopPropagation();
      }, { passive: false });
    }

    // 禁止 iOS 弹性滚动影响输入区域
    if (this.inputContainer) {
      this.inputContainer.addEventListener('touchmove', (e) => {
        e.stopPropagation();
      }, { passive: false });
    }
  }

  isInputElement(element) {
    return element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && element.type === 'text');
  }
}

// ==================== 文件上传处理 (多模态支持) ====================
let currentAttachment = null;
const MAX_INPUT_CHARS = 100000; // 约等于 25000 tokens，用于自动转换

// Toast 通知函数
function showToast(message, duration = 3000) {
  let toast = document.getElementById('toastNotification');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toastNotification';
    toast.className = 'toast-notification';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

// 检测输入长度，超长自动转换为 txt 附件
function checkAndConvertLongInput() {
  const input = document.getElementById('messageInput');
  const content = input?.value || '';

  if (content.length > MAX_INPUT_CHARS) {
    // 创建 txt 文件附件
    const blob = new Blob([content], { type: 'text/plain' });
    const reader = new FileReader();
    reader.onload = (e) => {
      currentAttachment = {
        type: 'text',
        data: e.target.result,
        fileName: `long_input_${Date.now()}.txt`
      };
      updateAttachmentUI();

      // 清空输入框，显示提示
      input.value = appState.language === 'zh-CN'
        ? '请分析这个文档'
        : 'Please analyze this document';
      autoResizeInput();

      // 显示提示
      showToast(appState.language === 'zh-CN'
        ? '输入内容过长，已自动转换为文本文件附件'
        : 'Input too long, converted to text file attachment');
    };
    reader.readAsDataURL(blob);
    return true;
  }
  return false;
}

function handleFileUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  // 扩展支持的文件类型
  input.accept = [
    // 图片格式
    'image/*', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.heic', '.heif',
    // 视频格式  
    'video/*', '.webm', '.mkv', '.flv', '.wmv', '.avi', '.mov', '.m4v',
    // 音频格式
    'audio/*', '.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.wma', '.opus',
    // 文本文档格式
    '.txt', '.md', '.json', '.xml', '.csv', '.log', '.yaml', '.yml', '.ini', '.conf',
    // 代码文件
    '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
    '.css', '.scss', '.less', '.html', '.vue', '.svelte', '.swift', '.kt', '.go', '.rs', '.rb', '.php',
    // 办公文档
    '.pdf', '.doc', '.docx'
  ].join(',');

  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    processUploadedFile(file);
  };
  input.click();
}

// 独立的文件处理函数（供拖拽上传复用）
async function processUploadedFile(file) {
  const maxSize = 50 * 1024 * 1024; // 50MB
  if (file.size > maxSize) {
    alert(appState.language === 'zh-CN' ? '文件大小不能超过50MB' : 'File size cannot exceed 50MB');
    return;
  }

  const fileType = file.type;
  const fileName = file.name.toLowerCase();
  let attachmentType = 'document';

  // 更精确的类型检测
  if (fileType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|tiff|heic|heif)$/i.test(fileName)) {
    attachmentType = 'image';
  } else if (fileType.startsWith('video/') || /\.(mp4|webm|mkv|flv|wmv|avi|mov|m4v)$/i.test(fileName)) {
    attachmentType = 'video';
  } else if (fileType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac|wma|opus)$/i.test(fileName)) {
    attachmentType = 'audio';
  } else if (/\.(txt|md|json|xml|csv|log|yaml|yml|ini|conf)$/i.test(fileName) || fileType === 'text/plain' || fileType === 'application/json') {
    attachmentType = 'text';
  } else if (/\.(js|ts|jsx|tsx|py|java|c|cpp|h|hpp|css|scss|less|html|vue|svelte|swift|kt|go|rs|rb|php|sh|bash|zsh|sql)$/i.test(fileName)) {
    attachmentType = 'code';
  }

  // 图片、视频、音频、文本、代码使用Base64编码直接发送给多模态模型
  if (['image', 'video', 'audio', 'text', 'code'].includes(attachmentType)) {
    const reader = new FileReader();
    reader.onload = (event) => {
      currentAttachment = {
        type: attachmentType,
        data: event.target.result,  // Base64 data URL
        fileName: file.name
      };
      console.log(`✅ ${attachmentType}文件已选择: ${file.name}`);
      updateAttachmentUI();
    };
    reader.readAsDataURL(file);
  } else {
    // PDF/Office文档类型走原有上传流程
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_BASE}/upload/document`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${appState.token}` },
        body: formData
      });
      if (!response.ok) throw new Error('文档上传失败');
      const data = await response.json();
      currentAttachment = {
        type: 'document',
        fileId: data.file_id,
        fileName: file.name
      };
      console.log('✅ 文档上传成功');
      updateAttachmentUI();
    } catch (error) {
      console.error('❌ 文档上传失败:', error);
      alert(appState.language === 'zh-CN' ? '文档上传失败' : 'Document upload failed');
    }
  }
}

// 更新附件UI显示
function updateAttachmentUI() {
  let attachmentPreview = document.getElementById('attachmentPreview');

  if (!currentAttachment) {
    // 移除预览
    if (attachmentPreview) {
      attachmentPreview.remove();
    }
    return;
  }

  // 创建或更新预览元素
  if (!attachmentPreview) {
    attachmentPreview = document.createElement('div');
    attachmentPreview.id = 'attachmentPreview';
    attachmentPreview.className = 'attachment-preview';

    // 插入到input-row之前
    const inputContainer = document.getElementById('inputContainer');
    if (inputContainer) {
      const inputRow = inputContainer.querySelector('.input-row');
      if (inputRow) {
        inputContainer.insertBefore(attachmentPreview, inputRow);
      } else {
        // 如果找不到input-row，插入到inputContainer开头
        inputContainer.insertBefore(attachmentPreview, inputContainer.firstChild);
      }
    }
  }

  // 根据类型显示不同的预览
  let iconSvg = '';
  let typeLabel = '';

  switch (currentAttachment.type) {
    case 'image':
      iconSvg = getSvgIcon('image', 'attachment-icon', 20);
      typeLabel = appState.language === 'zh-CN' ? '图片' : 'Image';
      break;
    case 'audio':
      iconSvg = getSvgIcon('headphones', 'attachment-icon', 20);
      typeLabel = appState.language === 'zh-CN' ? '音频' : 'Audio';
      break;
    case 'video':
      iconSvg = getSvgIcon('video_camera_front', 'attachment-icon', 20);
      typeLabel = appState.language === 'zh-CN' ? '视频' : 'Video';
      break;
    case 'text':
      iconSvg = getSvgIcon('article', 'attachment-icon', 20);
      typeLabel = appState.language === 'zh-CN' ? '文本' : 'Text';
      break;
    case 'code':
      iconSvg = getSvgIcon('code', 'attachment-icon', 20);
      typeLabel = appState.language === 'zh-CN' ? '代码' : 'Code';
      break;
    default:
      iconSvg = getSvgIcon('description', 'attachment-icon', 20);
      typeLabel = appState.language === 'zh-CN' ? '文档' : 'Document';
  }

  attachmentPreview.innerHTML = `
        <div class="attachment-info">
          ${iconSvg}
          <span class="attachment-type">${typeLabel}</span>
          <span class="attachment-name">${currentAttachment.fileName}</span>
        </div>
        <button class="attachment-remove" onclick="removeAttachment()" title="${appState.language === 'zh-CN' ? '移除' : 'Remove'}">
          ${getSvgIcon('close', 'remove-icon', 16)}
        </button>
      `;

  // 如果是图片，显示缩略图
  if (currentAttachment.type === 'image' && currentAttachment.data) {
    const thumbnail = document.createElement('img');
    thumbnail.src = currentAttachment.data;
    thumbnail.className = 'attachment-thumbnail';
    attachmentPreview.querySelector('.attachment-info').prepend(thumbnail);
  }
}

function removeAttachment() {
  currentAttachment = null;
  updateAttachmentUI();
}

// ==================== 拖拽上传功能 ====================
function initDragAndDrop() {
  // 创建拖拽覆盖层
  let dropOverlay = document.getElementById('dropOverlay');
  if (!dropOverlay) {
    dropOverlay = document.createElement('div');
    dropOverlay.id = 'dropOverlay';
    dropOverlay.className = 'drop-overlay';
    dropOverlay.innerHTML = `
          <div class="drop-overlay-content">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/>
            </svg>
            <span>${appState.language === 'zh-CN' ? '释放以上传文件' : 'Drop to upload file'}</span>
          </div>
        `;
    document.body.appendChild(dropOverlay);
  }

  let dragCounter = 0;

  // 阻止默认拖拽行为
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    document.body.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, false);
  });

  // 拖拽进入
  document.body.addEventListener('dragenter', (e) => {
    dragCounter++;
    if (e.dataTransfer?.types?.includes('Files')) {
      dropOverlay.classList.add('active');
    }
  });

  // 拖拽离开
  document.body.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter === 0) {
      dropOverlay.classList.remove('active');
    }
  });

  // 放置文件
  document.body.addEventListener('drop', (e) => {
    dragCounter = 0;
    dropOverlay.classList.remove('active');

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      processUploadedFile(files[0]);
      console.log('📁 拖拽上传文件:', files[0].name);
    }
  });

  console.log('✅ 拖拽上传功能已初始化');
}

// ==================== 对话索引导航器 ====================

// 获取所有消息（包括用户和AI）
function getChatIndexItems() {
  const items = [];
  const messages = appState.messages || [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    items.push({
      index: i,
      role: msg.role,
      content: msg.content || '',
      messageIndex: i
    });
  }
  return items;
}

// 渲染时间轴
function renderChatIndexTimeline() {
  const timeline = document.getElementById('chatIndexTimeline');
  const navigator = document.getElementById('chatIndexNavigator');
  if (!timeline || !navigator) return;

  const items = getChatIndexItems();

  // 没有消息时隐藏导航器
  if (items.length === 0) {
    navigator.classList.remove('visible');
    navigator.classList.add('hidden');
    return;
  }

  // 有消息时显示导航器
  navigator.classList.add('visible');
  navigator.classList.remove('hidden');

  // 清空并重新渲染时间轴
  timeline.innerHTML = '';

  items.forEach((item, idx) => {
    const line = document.createElement('div');
    line.className = 'chat-index-line';
    // 添加角色类：用户短线，AI中线
    line.classList.add(item.role === 'user' ? 'user-line' : 'assistant-line');
    line.dataset.index = idx;
    line.dataset.messageIndex = item.messageIndex;
    line.dataset.role = item.role;
    line.dataset.content = item.content;

    // 生成tooltip文本
    let tooltipText;
    if (item.role === 'user') {
      // 用户消息：直接显示内容，最多50字
      tooltipText = item.content.replace(/\n/g, ' ').trim();
      if (tooltipText.length > 50) {
        tooltipText = tooltipText.substring(0, 50) + '...';
      }
    } else {
      // AI回复：格式为 "RAI回复：\n内容"，最多50字
      const label = appState.language === 'zh-CN' ? 'RAI回复：' : 'RAI Response:';
      let content = item.content.replace(/\n/g, ' ').trim();
      if (content.length > 50) {
        content = content.substring(0, 50) + '...';
      }
      tooltipText = label + '\n' + content;
    }

    // 事件监听
    line.addEventListener('mouseenter', (e) => showChatIndexTooltip(e, tooltipText));
    line.addEventListener('mouseleave', hideChatIndexTooltip);
    line.addEventListener('click', () => {
      // 立即更新高亮状态
      setActiveIndexLine(idx);
      // 滚动到消息
      scrollToMessage(item.messageIndex);
    });

    timeline.appendChild(line);
  });

  // 更新当前高亮
  updateChatIndexHighlight();
}

// 立即设置指定索引为active
function setActiveIndexLine(activeIdx) {
  const timeline = document.getElementById('chatIndexTimeline');
  if (!timeline) return;

  const lines = timeline.querySelectorAll('.chat-index-line');
  lines.forEach((line, idx) => {
    if (idx === activeIdx) {
      line.classList.add('active');
    } else {
      line.classList.remove('active');
    }
  });
}
// 显示横线悬浮提示
function showChatIndexTooltip(event, content) {
  const tooltip = document.getElementById('chatIndexTooltip');
  if (!tooltip) return;

  // 截断过长的内容
  const maxLength = 100;
  let displayContent = content.replace(/\n/g, ' ').trim();
  if (displayContent.length > maxLength) {
    displayContent = displayContent.substring(0, maxLength) + '...';
  }

  tooltip.textContent = displayContent;

  // 定位 - 在元素左侧显示
  const rect = event.target.getBoundingClientRect();
  tooltip.style.top = `${rect.top + rect.height / 2}px`;
  tooltip.style.right = `${window.innerWidth - rect.left + 16}px`;
  tooltip.style.left = 'auto';
  tooltip.style.transform = 'translateY(-50%)';

  tooltip.classList.add('visible');
}

// 隐藏横线悬浮提示
function hideChatIndexTooltip() {
  const tooltip = document.getElementById('chatIndexTooltip');
  if (tooltip) {
    tooltip.classList.remove('visible');
  }
}

// 显示导航按钮悬浮提示
function showNavTooltip(event, direction) {
  const tooltip = document.getElementById('chatIndexNavTooltip');
  if (!tooltip) return;

  const text = direction === 'prev'
    ? (appState.language === 'zh-CN' ? '上一个响应' : 'Previous response')
    : (appState.language === 'zh-CN' ? '下一个响应' : 'Next response');

  tooltip.textContent = text;

  // 定位 - 在按钮左侧显示
  const rect = event.target.getBoundingClientRect();
  tooltip.style.top = `${rect.top + rect.height / 2}px`;
  tooltip.style.right = `${window.innerWidth - rect.left + 16}px`;
  tooltip.style.left = 'auto';
  tooltip.style.transform = 'translateY(-50%)';

  tooltip.classList.add('visible');
}

// 隐藏导航按钮悬浮提示
function hideNavTooltip() {
  const tooltip = document.getElementById('chatIndexNavTooltip');
  if (tooltip) {
    tooltip.classList.remove('visible');
  }
}

// 导航到上/下一个响应
function navigateToResponse(direction) {
  const items = getChatIndexItems();
  if (items.length === 0) return;

  const currentIndex = getCurrentChatIndex();
  let targetIndex;

  if (direction === 'prev') {
    // 已经是第一个了
    if (currentIndex <= 0) {
      showBoundaryTooltip('top');
      return;
    }
    targetIndex = currentIndex - 1;
  } else {
    // 已经是最后一个了
    if (currentIndex >= items.length - 1) {
      showBoundaryTooltip('bottom');
      return;
    }
    targetIndex = currentIndex + 1;
  }

  if (items[targetIndex]) {
    scrollToMessage(items[targetIndex].messageIndex);
  }
}

// 显示已到顶/底提示
function showBoundaryTooltip(position) {
  const tooltip = document.getElementById('chatIndexNavTooltip');
  if (!tooltip) return;

  const text = position === 'top'
    ? (appState.language === 'zh-CN' ? '已经到顶了' : 'Already at top')
    : (appState.language === 'zh-CN' ? '已经到底了' : 'Already at bottom');

  tooltip.textContent = text;

  // 定位在导航器中间
  const navigator = document.getElementById('chatIndexNavigator');
  if (navigator) {
    const rect = navigator.getBoundingClientRect();
    tooltip.style.top = `${rect.top + rect.height / 2}px`;
    tooltip.style.right = `${window.innerWidth - rect.left + 16}px`;
    tooltip.style.left = 'auto';
    tooltip.style.transform = 'translateY(-50%)';
  }

  tooltip.classList.add('visible');

  // 1.5秒后自动隐藏
  setTimeout(() => {
    tooltip.classList.remove('visible');
  }, 1500);
}
// 滚动到指定消息
function scrollToMessage(messageIndex) {
  const container = document.getElementById('messagesList');
  const chatContainer = document.getElementById('chatContainer');
  if (!container || !chatContainer) return;

  const messages = container.querySelectorAll('.message');
  const targetMessage = messages[messageIndex];

  if (targetMessage) {
    // 滚动到消息位置
    const containerRect = chatContainer.getBoundingClientRect();
    const messageRect = targetMessage.getBoundingClientRect();
    const scrollTop = chatContainer.scrollTop + messageRect.top - containerRect.top - 100;

    chatContainer.scrollTo({
      top: scrollTop,
      behavior: 'smooth'
    });

    // 短暂高亮目标消息
    targetMessage.style.transition = 'background 0.3s ease';
    targetMessage.style.background = 'rgba(255, 255, 255, 0.05)';
    setTimeout(() => {
      targetMessage.style.background = '';
    }, 1000);
  }
}

// 获取当前滚动位置对应的索引
function getCurrentChatIndex() {
  const items = getChatIndexItems();
  if (items.length === 0) return 0;

  const container = document.getElementById('messagesList');
  const chatContainer = document.getElementById('chatContainer');
  if (!container || !chatContainer) return 0;

  const messages = container.querySelectorAll('.message');
  const containerRect = chatContainer.getBoundingClientRect();
  const scrollTop = chatContainer.scrollTop;

  let closestIndex = 0;
  let closestDistance = Infinity;

  items.forEach((item, idx) => {
    const message = messages[item.messageIndex];
    if (message) {
      const messageRect = message.getBoundingClientRect();
      const messageTop = messageRect.top - containerRect.top + scrollTop;
      const distance = Math.abs(scrollTop - messageTop + 100);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = idx;
      }
    }
  });

  return closestIndex;
}

// 更新当前高亮
function updateChatIndexHighlight() {
  const timeline = document.getElementById('chatIndexTimeline');
  if (!timeline) return;

  const currentIndex = getCurrentChatIndex();
  const lines = timeline.querySelectorAll('.chat-index-line');

  lines.forEach((line, idx) => {
    if (idx === currentIndex) {
      line.classList.add('active');
    } else {
      line.classList.remove('active');
    }
  });

  // 更新按钮状态
  updateChatIndexNavButtons();
}

// 更新导航按钮状态
function updateChatIndexNavButtons() {
  const items = getChatIndexItems();
  const currentIndex = getCurrentChatIndex();

  const prevBtn = document.getElementById('chatIndexPrevBtn');
  const nextBtn = document.getElementById('chatIndexNextBtn');

  if (prevBtn) {
    prevBtn.disabled = currentIndex <= 0;
  }
  if (nextBtn) {
    nextBtn.disabled = currentIndex >= items.length - 1;
  }
}

// 初始化对话索引导航器滚动监听
function initChatIndexListener() {
  const chatContainer = document.getElementById('chatContainer');
  if (!chatContainer) return;

  let scrollTimeout;
  chatContainer.addEventListener('scroll', () => {
    // 节流处理
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      updateChatIndexHighlight();
    }, 100);
  }, { passive: true });

  // 初始化移动端滑动操作
  initMobileTouchNavigation();

  console.log('✅ 对话索引导航器滚动监听器已初始化');
}

// 移动端触摸滑动导航
function initMobileTouchNavigation() {
  const timeline = document.getElementById('chatIndexTimeline');
  if (!timeline) return;

  let isTouching = false;
  let currentTouchLine = null;

  // 根据触摸位置找到对应的横线
  function getLineAtPosition(y) {
    const lines = timeline.querySelectorAll('.chat-index-line');
    for (const line of lines) {
      const rect = line.getBoundingClientRect();
      // 扩大判定区域
      if (y >= rect.top - 10 && y <= rect.bottom + 10) {
        return line;
      }
    }
    return null;
  }

  // 显示触摸位置的预览
  function showTouchPreview(line) {
    if (!line) return;

    const content = line.dataset.content || '';
    const role = line.dataset.role || 'user';

    let tooltipText;
    if (role === 'user') {
      tooltipText = content.replace(/\n/g, ' ').trim();
      if (tooltipText.length > 50) {
        tooltipText = tooltipText.substring(0, 50) + '...';
      }
    } else {
      const label = appState.language === 'zh-CN' ? 'RAI回复：' : 'RAI Response:';
      let displayContent = content.replace(/\n/g, ' ').trim();
      if (displayContent.length > 50) {
        displayContent = displayContent.substring(0, 50) + '...';
      }
      tooltipText = label + '\n' + displayContent;
    }

    const tooltip = document.getElementById('chatIndexTooltip');
    if (tooltip) {
      tooltip.textContent = tooltipText;
      const rect = line.getBoundingClientRect();
      tooltip.style.top = `${rect.top + rect.height / 2}px`;
      tooltip.style.right = `${window.innerWidth - rect.left + 16}px`;
      tooltip.style.left = 'auto';
      tooltip.style.transform = 'translateY(-50%)';
      tooltip.classList.add('visible');
    }

    // 高亮当前触摸的横线
    timeline.querySelectorAll('.chat-index-line').forEach(l => l.classList.remove('touching'));
    line.classList.add('touching');
  }

  // 触摸开始
  timeline.addEventListener('touchstart', (e) => {
    isTouching = true;
    const touch = e.touches[0];
    currentTouchLine = getLineAtPosition(touch.clientY);
    if (currentTouchLine) {
      showTouchPreview(currentTouchLine);
    }
  }, { passive: true });

  // 触摸滑动
  timeline.addEventListener('touchmove', (e) => {
    if (!isTouching) return;
    const touch = e.touches[0];
    const line = getLineAtPosition(touch.clientY);
    if (line && line !== currentTouchLine) {
      currentTouchLine = line;
      showTouchPreview(line);
    }
  }, { passive: true });

  // 触摸结束
  timeline.addEventListener('touchend', () => {
    if (currentTouchLine) {
      const messageIndex = parseInt(currentTouchLine.dataset.messageIndex);
      const idx = parseInt(currentTouchLine.dataset.index);
      if (!isNaN(messageIndex) && !isNaN(idx)) {
        setActiveIndexLine(idx);
        scrollToMessage(messageIndex);
      }
    }

    // 隐藏预览和触摸高亮
    setTimeout(() => {
      hideChatIndexTooltip();
      timeline.querySelectorAll('.chat-index-line').forEach(l => l.classList.remove('touching'));
    }, 300);

    isTouching = false;
    currentTouchLine = null;
  }, { passive: true });

  // 触摸取消
  timeline.addEventListener('touchcancel', () => {
    hideChatIndexTooltip();
    timeline.querySelectorAll('.chat-index-line').forEach(l => l.classList.remove('touching'));
    isTouching = false;
    currentTouchLine = null;
  }, { passive: true });
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  window.mobileKeyboardHandler = new MobileKeyboardHandler({
    debug: false
  });

  // 窗口尺寸变化时重新计算竖线长度
  window.addEventListener('resize', () => {
    if (appState.thinkingUIMode === 'expanded') {
      // 更新所有展开的思考内容竖线
      document.querySelectorAll('.thinking-content.expanded').forEach(content => {
        const thinkingId = content.id;
        if (thinkingId) {
          updateThinkingLine(thinkingId);
        }
      });
    }
  });

});

// ==================== 用户会员系统 ====================

// 用户会员状态
let userMembershipState = {
  membership: 'free',
  points: 0,
  purchasedPoints: 0,
  totalPoints: 0,
  canCheckin: true,
  createdAt: null
};

// 获取用户会员状态
async function fetchUserMembership() {
  try {
    const token = appState.token;
    if (!token) return;

    const res = await fetch('/api/user/membership', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      userMembershipState = {
        membership: data.membership || 'free',
        membershipEnd: data.membershipEnd,
        points: data.points || 0,
        purchasedPoints: data.purchasedPoints || 0,
        totalPoints: data.totalPoints || 0,
        canCheckin: data.canCheckin,
        createdAt: data.createdAt
      };
      console.log('✅ 会员状态更新:', userMembershipState);
    }
  } catch (e) {
    console.log('获取会员状态失败');
  }
}

// 用户签到 (设置面板用)
async function userCheckin() {
  console.log('🔄 userCheckin() 被调用');
  try {
    const token = appState.token;
    console.log('🔑 Token:', token ? '存在' : '不存在');
    if (!token) {
      console.error('❌ 无token，取消签到');
      return;
    }

    console.log('📤 发送签到请求...');
    const res = await fetch('/api/user/checkin', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log('📥 响应状态:', res.status);
    const data = await res.json();
    console.log('📦 响应数据:', data);

    if (res.ok) {
      alert(`签到成功！获得 ${data.pointsGained} 点数 ⚡`);
      await fetchUserMembership();
      updateSettingsMembership();
      updateUserAreaWithMembership();
    } else {
      alert(data.error || '签到失败');
    }
  } catch (e) {
    console.error('❌ 签到错误:', e);
    alert('网络错误: ' + e.message);
  }
}

// 打开会员计划弹窗
function openMembershipPlans() {
  createMembershipPlansModal();
  document.getElementById('membershipPlansModal').classList.add('active');
}

// 关闭会员计划弹窗
function closeMembershipPlans() {
  const modal = document.getElementById('membershipPlansModal');
  if (modal) modal.classList.remove('active');
}

// 创建会员计划弹窗
function createMembershipPlansModal() {
  if (document.getElementById('membershipPlansModal')) return;

  const modal = document.createElement('div');
  modal.id = 'membershipPlansModal';
  modal.className = 'membership-plans-overlay';
  modal.innerHTML = `
        <div class="membership-plans-box">
          <div class="membership-plans-header">
            <h2>🎫 会员计划</h2>
            <button class="admin-close-btn" onclick="closeMembershipPlans()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="membership-plans-content">
            <div class="membership-plans-grid">
              <div class="membership-plan-card free ${userMembershipState.membership === 'free' ? 'current' : ''}">
                <div class="membership-plan-name">free</div>
                <div class="membership-plan-price">免费</div>
                <div class="membership-plan-points">每日签到获得 20 点数</div>
                <div class="membership-plan-features">
                  默认用户套餐<br>
                  点数长期有效
                </div>
              </div>
              <div class="membership-plan-card pro ${userMembershipState.membership === 'Pro' ? 'current' : ''}">
                <div class="membership-plan-name">Pro</div>
                <div class="membership-plan-price">¥15 <small>/月</small></div>
                <div class="membership-plan-points">每日自动获得 90 点数</div>
                <div class="membership-plan-features">
                  基础套餐<br>
                  无需签到
                </div>
              </div>
              <div class="membership-plan-card max ${userMembershipState.membership === 'MAX' ? 'current' : ''}">
                <div class="membership-plan-name">MAX</div>
                <div class="membership-plan-price">¥199 <small>/月</small></div>
                <div class="membership-plan-points">每日自动获得 10000 点数</div>
                <div class="membership-plan-features">
                  顶级套餐<br>
                  无限推理使用限额<br>
                  无限文件上传<br>
                  最高使用额度
                </div>
              </div>
            </div>

            <div class="membership-divider"></div>

            <div class="membership-extra-section">
              <h3>💎 按需享用</h3>
              <p>单独捐赠获取点数，购买的点数 2 年有效。</p>
            </div>

            <div class="membership-contact">
              <p>📧 购买请联系: <a href="mailto:rick080402@gmail.com">rick080402@gmail.com</a></p>
              <p style="font-size: 12px; color: var(--text-tertiary); margin-top: 8px;">目前购买需要通过邮箱联系</p>
            </div>
          </div>
        </div>
      `;
  document.body.appendChild(modal);

  // 点击背景关闭
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeMembershipPlans();
  });
}

// 更新侧边栏用户区域 - 简化版，只显示签到按钮
function updateUserAreaWithMembership() {
  const checkinContainer = document.getElementById('sidebarCheckinContainer');
  if (!checkinContainer) return;

  const m = userMembershipState;

  // 只有free用户且可以签到时才显示签到按钮
  if (m.membership === 'free' && m.canCheckin) {
    checkinContainer.style.display = 'block';
    checkinContainer.innerHTML = `
          <button onclick="sidebarCheckin()" style="
            background: linear-gradient(135deg, #f5d547 0%, #e6a824 100%);
            color: #1a1a1a;
            border: none;
            padding: 6px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 6px;
            box-shadow: 0 2px 8px rgba(245, 213, 71, 0.3);
            transition: transform 0.2s, box-shadow 0.2s;
          " onmouseover="this.style.transform='scale(1.02)';this.style.boxShadow='0 4px 12px rgba(245, 213, 71, 0.4)';"
             onmouseout="this.style.transform='scale(1)';this.style.boxShadow='0 2px 8px rgba(245, 213, 71, 0.3)';">
            签到 +20 ⚡
          </button>
        `;
  } else {
    // 隐藏签到容器（已签到或非free用户）
    checkinContainer.style.display = 'none';
    checkinContainer.innerHTML = '';
  }
}

// 侧边栏签到函数 - 签到成功后隐藏按钮
async function sidebarCheckin() {
  console.log('🔄 sidebarCheckin() 被调用');
  try {
    const token = appState.token;
    console.log('🔑 Token:', token ? '存在' : '不存在');
    if (!token) {
      console.error('❌ 无token，取消签到');
      return;
    }

    console.log('📤 发送签到请求...');
    const res = await fetch('/api/user/checkin', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log('📥 响应状态:', res.status);
    const data = await res.json();
    console.log('📦 响应数据:', data);

    if (res.ok) {
      // 更新状态
      userMembershipState.canCheckin = false;
      userMembershipState.totalPoints = data.currentPoints;

      // 隐藏签到按钮
      const checkinContainer = document.getElementById('sidebarCheckinContainer');
      if (checkinContainer) {
        checkinContainer.style.display = 'none';
      }

      // 也更新设置面板中的状态
      updateSettingsMembership();

      // 显示成功提示
      showToast(`签到成功！+${data.pointsGained} ⚡`);
    } else {
      showToast(data.error || '签到失败', 'error');
    }
  } catch (e) {
    showToast('网络错误', 'error');
  }
}

// 更新设置面板中的会员信息
function updateSettingsMembership() {
  const m = userMembershipState;

  // 更新会员徽章
  const badge = document.getElementById('settingsMembershipBadge');
  if (badge) {
    badge.textContent = m.membership;
    badge.className = `settings-membership-badge ${m.membership === 'MAX' ? 'max' : (m.membership === 'Pro' ? 'pro' : 'free')}`;
  }

  // 更新点数显示
  const points = document.getElementById('settingsPointsDisplay');
  if (points) points.textContent = m.totalPoints;

  // 更新签到按钮
  const checkinBtn = document.getElementById('settingsCheckinBtn');
  if (checkinBtn) {
    if (m.membership !== 'free') {
      checkinBtn.style.display = 'none';
    } else if (!m.canCheckin) {
      checkinBtn.disabled = true;
      checkinBtn.textContent = '今日已签到 ✓';
    } else {
      checkinBtn.disabled = false;
      checkinBtn.style.display = 'inline-block';
      checkinBtn.textContent = '签到 +20 ⚡';
    }
  }

  // 更新创建时间
  const created = document.getElementById('settingsCreatedAt');
  if (created && m.createdAt) {
    const date = new Date(m.createdAt);
    created.textContent = `创建于: ${date.toLocaleDateString('zh-CN')}`;
  }

  // 隐藏升级链接（非free用户）
  const upgradeLink = document.querySelector('#settingsMembershipSection .settings-upgrade-link');
  if (upgradeLink) {
    upgradeLink.style.display = m.membership === 'free' ? 'inline' : 'none';
  }
}

// 每60秒刷新一次会员状态
setInterval(() => {
  const token = localStorage.getItem('token');
  if (token) {
    fetchUserMembership().then(() => {
      updateUserAreaWithMembership();
      updateSettingsMembership();
    });
  }
}, 60000);

// 页面加载后获取会员状态
setTimeout(() => {
  fetchUserMembership().then(() => {
    updateUserAreaWithMembership();
    updateSettingsMembership();
  });
}, 1000);

// ==================== 管理员后台系统 ====================

// 管理员状态
const adminState = {
  isLoggedIn: false,
  token: null,
  currentTab: 'stats'
};

// 检查管理员登录状态
function checkAdminLogin() {
  const token = localStorage.getItem('adminToken');
  if (token) {
    adminState.token = token;
    verifyAdminToken();
  }
}

// 验证管理员 Token
async function verifyAdminToken() {
  try {
    const res = await fetch('/api/admin/verify', {
      headers: { 'X-Admin-Token': adminState.token }
    });
    if (res.ok) {
      adminState.isLoggedIn = true;
    } else {
      localStorage.removeItem('adminToken');
      adminState.token = null;
      adminState.isLoggedIn = false;
    }
  } catch (e) {
    console.log('Admin token verification failed');
  }
}

// 打开管理员登录
function openAdminLogin() {
  createAdminLoginModal();
  document.getElementById('adminLoginModal').classList.add('active');
}

// 创建管理员登录模态框
function createAdminLoginModal() {
  if (document.getElementById('adminLoginModal')) return;

  const modal = document.createElement('div');
  modal.id = 'adminLoginModal';
  modal.className = 'admin-modal-overlay';
  modal.innerHTML = `
        <div class="admin-login-box">
          <div class="admin-login-header">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="var(--color-saturn-yellow)">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
            </svg>
            <h2>管理员登录</h2>
          </div>
          <form id="adminLoginForm" onsubmit="handleAdminLogin(event)">
            <div class="admin-input-group">
              <label>用户名</label>
              <input type="text" id="adminUsername" placeholder="admin" autocomplete="username" required>
            </div>
            <div class="admin-input-group">
              <label>密码</label>
              <input type="password" id="adminPassword" placeholder="••••••••" autocomplete="current-password" required>
            </div>
            <div id="adminLoginError" class="admin-login-error"></div>
            <button type="submit" class="admin-login-btn">登录管理后台</button>
          </form>
          <button class="admin-close-btn" onclick="closeAdminLogin()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      `;
  document.body.appendChild(modal);
}

// 关闭管理员登录
function closeAdminLogin() {
  const modal = document.getElementById('adminLoginModal');
  if (modal) modal.classList.remove('active');
}

// 处理管理员登录
async function handleAdminLogin(e) {
  e.preventDefault();
  const username = document.getElementById('adminUsername').value;
  const password = document.getElementById('adminPassword').value;
  const errorEl = document.getElementById('adminLoginError');

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      adminState.token = data.token;
      adminState.isLoggedIn = true;
      localStorage.setItem('adminToken', data.token);
      closeAdminLogin();
      openAdminPanel();
    } else {
      errorEl.textContent = data.error || '登录失败';
    }
  } catch (err) {
    errorEl.textContent = '网络错误，请重试';
  }
}

// 打开管理面板
function openAdminPanel() {
  if (!adminState.isLoggedIn) {
    openAdminLogin();
    return;
  }
  createAdminPanel();
  document.getElementById('adminPanel').classList.add('active');
  loadAdminStats();
}

// 创建管理面板
function createAdminPanel() {
  if (document.getElementById('adminPanel')) return;

  const panel = document.createElement('div');
  panel.id = 'adminPanel';
  panel.className = 'admin-panel-overlay';
  panel.innerHTML = `
        <div class="admin-panel">
          <div class="admin-panel-header">
            <h1>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="var(--color-saturn-yellow)">
                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
              </svg>
              RAI 管理后台
            </h1>
            <button class="admin-close-btn" onclick="closeAdminPanel()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="admin-panel-tabs">
            <button class="admin-tab active" data-tab="stats" onclick="switchAdminTab('stats')">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/></svg>
              <span>数据统计</span>
            </button>
            <button class="admin-tab" data-tab="users" onclick="switchAdminTab('users')">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              <span>用户管理</span>
            </button>
            <button class="admin-tab" data-tab="messages" onclick="switchAdminTab('messages')">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
              <span>消息浏览</span>
            </button>
            <button class="admin-tab" data-tab="sessions" onclick="switchAdminTab('sessions')">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
              <span>会话管理</span>
            </button>
          </div>

          <div class="admin-panel-content">
            <div id="adminStatsTab" class="admin-tab-content active">
              <div class="admin-stats-grid" id="adminStatsGrid">
                <div class="admin-stat-card loading"><div class="admin-stat-skeleton"></div></div>
                <div class="admin-stat-card loading"><div class="admin-stat-skeleton"></div></div>
                <div class="admin-stat-card loading"><div class="admin-stat-skeleton"></div></div>
                <div class="admin-stat-card loading"><div class="admin-stat-skeleton"></div></div>
              </div>
              <div class="admin-charts-row">
                <div class="admin-chart-card">
                  <h3>每日消息趋势 (最近30天)</h3>
                  <div id="adminDailyChart" class="admin-chart"></div>
                </div>
                <div class="admin-chart-card">
                  <h3>模型使用分布</h3>
                  <div id="adminModelChart" class="admin-chart"></div>
                </div>
              </div>
              <div class="admin-chart-card">
                <h3>活跃用户排行</h3>
                <div id="adminTopUsersChart" class="admin-chart"></div>
              </div>
            </div>

            <div id="adminUsersTab" class="admin-tab-content">
              <div id="adminUsersTable" class="admin-table-container"></div>
            </div>

            <div id="adminMessagesTab" class="admin-tab-content">
              <div class="admin-search-bar">
                <input type="text" id="adminMessageSearch" placeholder="搜索消息内容..." onkeyup="if(event.key==='Enter')loadAdminMessages()">
                <button onclick="loadAdminMessages()">搜索</button>
              </div>
              <div id="adminMessagesTable" class="admin-table-container"></div>
            </div>

            <div id="adminSessionsTab" class="admin-tab-content">
              <div id="adminSessionsTable" class="admin-table-container"></div>
            </div>
          </div>
        </div>
      `;
  document.body.appendChild(panel);
}

// 关闭管理面板
function closeAdminPanel() {
  const panel = document.getElementById('adminPanel');
  if (panel) panel.classList.remove('active');
}

// 切换标签页
function switchAdminTab(tab) {
  adminState.currentTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.admin-tab[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`admin${tab.charAt(0).toUpperCase() + tab.slice(1)}Tab`).classList.add('active');

  // 加载对应数据
  if (tab === 'stats') loadAdminStats();
  else if (tab === 'users') loadAdminUsers();
  else if (tab === 'messages') loadAdminMessages();
  else if (tab === 'sessions') loadAdminSessions();
}

// 加载统计数据
async function loadAdminStats() {
  try {
    const res = await fetch('/api/admin/stats', {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();

    // 更新统计卡片
    document.getElementById('adminStatsGrid').innerHTML = `
          <div class="admin-stat-card">
            <div class="admin-stat-icon users">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            </div>
            <div class="admin-stat-info">
              <div class="admin-stat-value">${data.totalUsers || 0}</div>
              <div class="admin-stat-label">总用户数</div>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-icon sessions">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>
            </div>
            <div class="admin-stat-info">
              <div class="admin-stat-value">${data.totalSessions || 0}</div>
              <div class="admin-stat-label">总会话数</div>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-icon messages">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>
            </div>
            <div class="admin-stat-info">
              <div class="admin-stat-value">${data.totalMessages || 0}</div>
              <div class="admin-stat-label">总消息数</div>
            </div>
          </div>
          <div class="admin-stat-card">
            <div class="admin-stat-icon today">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
            </div>
            <div class="admin-stat-info">
              <div class="admin-stat-value">${data.todayMessages || 0}</div>
              <div class="admin-stat-label">今日消息</div>
            </div>
          </div>
        `;

    // 绘制每日趋势图
    renderDailyChart(data.dailyStats || []);

    // 绘制模型使用分布
    renderModelChart(data.modelUsage || []);

    // 绘制活跃用户排行
    renderTopUsersChart(data.topUsers || []);

  } catch (err) {
    console.error('加载统计数据失败:', err);
  }
}

// 绘制每日趋势图（简单条形图）
function renderDailyChart(dailyStats) {
  const container = document.getElementById('adminDailyChart');
  if (!dailyStats.length) {
    container.innerHTML = '<div class="admin-no-data">暂无数据</div>';
    return;
  }

  const maxMessages = Math.max(...dailyStats.map(d => d.messages), 1);
  let html = '<div class="admin-bar-chart">';
  dailyStats.slice(-14).forEach(day => {
    const height = (day.messages / maxMessages) * 100;
    const date = day.date.slice(5); // MM-DD
    html += `
          <div class="admin-bar-item">
            <div class="admin-bar" style="height: ${height}%" title="${day.date}: ${day.messages}条"></div>
            <span class="admin-bar-label">${date}</span>
          </div>
        `;
  });
  html += '</div>';
  container.innerHTML = html;
}

// 绘制模型使用分布
function renderModelChart(modelUsage) {
  const container = document.getElementById('adminModelChart');
  if (!modelUsage.length) {
    container.innerHTML = '<div class="admin-no-data">暂无数据</div>';
    return;
  }

  const total = modelUsage.reduce((sum, m) => sum + m.count, 0);
  const colors = ['#f5d547', '#4CAF50', '#2196F3', '#9C27B0', '#FF5722', '#00BCD4', '#FF9800'];

  let html = '<div class="admin-model-list">';
  modelUsage.slice(0, 7).forEach((model, i) => {
    const percent = ((model.count / total) * 100).toFixed(1);
    const color = colors[i % colors.length];
    html += `
          <div class="admin-model-item">
            <div class="admin-model-bar-bg">
              <div class="admin-model-bar" style="width: ${percent}%; background: ${color}"></div>
            </div>
            <span class="admin-model-name">${model.model || '未知'}</span>
            <span class="admin-model-count">${model.count} (${percent}%)</span>
          </div>
        `;
  });
  html += '</div>';
  container.innerHTML = html;
}

// 绘制活跃用户排行
function renderTopUsersChart(topUsers) {
  const container = document.getElementById('adminTopUsersChart');
  if (!topUsers.length) {
    container.innerHTML = '<div class="admin-no-data">暂无数据</div>';
    return;
  }

  const maxCount = Math.max(...topUsers.map(u => u.messageCount), 1);
  let html = '<div class="admin-top-users-list">';
  topUsers.forEach((user, i) => {
    const width = (user.messageCount / maxCount) * 100;
    html += `
          <div class="admin-top-user-item">
            <span class="admin-top-user-rank">#${i + 1}</span>
            <span class="admin-top-user-name">${user.username || user.email || 'User ' + user.id}</span>
            <div class="admin-top-user-bar-bg">
              <div class="admin-top-user-bar" style="width: ${width}%"></div>
            </div>
            <span class="admin-top-user-count">${user.messageCount}</span>
          </div>
        `;
  });
  html += '</div>';
  container.innerHTML = html;
}

// 加载用户列表
async function loadAdminUsers() {
  try {
    const res = await fetch('/api/admin/users', {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();

    let html = `
          <table class="admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>邮箱</th>
                <th>用户名</th>
                <th>会员</th>
                <th>点数</th>
                <th>消息数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
        `;

    (data.users || []).forEach(user => {
      const membershipBadge = getMembershipBadge(user.membership);
      const totalPoints = (user.points || 0) + (user.purchased_points || 0);
      html += `
            <tr onclick="openUserDetailModal(${user.id})" style="cursor:pointer" title="点击查看用户详情">
              <td>${user.id}</td>
              <td>${user.email}</td>
              <td>${user.username || '-'}</td>
              <td>${membershipBadge}</td>
              <td>${totalPoints} ⚡</td>
              <td>${user.messageCount || 0}</td>
              <td>
                <button class="admin-action-btn view" onclick="event.stopPropagation();openUserDetailModal(${user.id})">查看</button>
                <button class="admin-action-btn view" onclick="event.stopPropagation();openMembershipEditor(${user.id}, '${user.membership || 'free'}')">会员</button>
                <button class="admin-action-btn view" onclick="event.stopPropagation();openPointsEditor(${user.id})">点数</button>
                <button class="admin-action-btn delete" onclick="event.stopPropagation();deleteUser(${user.id})">删除</button>
              </td>
            </tr>
          `;
    });

    html += '</tbody></table>';
    document.getElementById('adminUsersTable').innerHTML = html;

  } catch (err) {
    console.error('加载用户列表失败:', err);
  }
}

// 获取会员等级徽章
function getMembershipBadge(membership) {
  switch (membership) {
    case 'Pro': return '<span class="membership-badge pro">Pro</span>';
    case 'MAX': return '<span class="membership-badge max">MAX</span>';
    default: return '<span class="membership-badge free">free</span>';
  }
}

// 打开会员编辑器
function openMembershipEditor(userId, currentMembership) {
  const level = prompt(`设置用户 #${userId} 的会员等级:\n\n输入: free / Pro / MAX`, currentMembership);
  if (!level || !['free', 'Pro', 'MAX'].includes(level)) return;

  let months = 0;
  if (level !== 'free') {
    months = parseInt(prompt('设置会员时长（月数）:', '1')) || 1;
  }

  setUserMembership(userId, level, months);
}

// 设置用户会员
async function setUserMembership(userId, membership, months) {
  try {
    const res = await fetch(`/api/admin/users/${userId}/membership`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminState.token
      },
      body: JSON.stringify({ membership, months })
    });
    if (res.ok) {
      alert(`成功设置用户 #${userId} 为 ${membership}，时长 ${months} 个月`);
      loadAdminUsers();
    } else {
      const err = await res.json();
      alert('设置失败: ' + (err.error || '未知错误'));
    }
  } catch (e) {
    alert('网络错误');
  }
}

// 打开点数编辑器
function openPointsEditor(userId) {
  const points = parseInt(prompt(`给用户 #${userId} 添加点数:\n\n输入正数添加，负数扣减`, '100'));
  if (isNaN(points)) return;

  const type = confirm('是购买点数(2年有效)？\n\n确定 = 购买点数\n取消 = 每日点数') ? 'purchased' : 'daily';

  addUserPoints(userId, points, type);
}

// 添加用户点数
async function addUserPoints(userId, points, type) {
  try {
    const res = await fetch(`/api/admin/users/${userId}/points`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminState.token
      },
      body: JSON.stringify({ points, type, expireYears: type === 'purchased' ? 2 : 0 })
    });
    if (res.ok) {
      alert(`成功给用户 #${userId} 添加 ${points} ${type === 'purchased' ? '购买' : '每日'}点数`);
      loadAdminUsers();
    } else {
      const err = await res.json();
      alert('添加失败: ' + (err.error || '未知错误'));
    }
  } catch (e) {
    alert('网络错误');
  }
}

// 查看用户消息
async function viewUserMessages(userId) {
  try {
    const res = await fetch(`/api/admin/users/${userId}/messages`, {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();

    let html = `<h3>用户 #${userId} 的消息</h3><button onclick="loadAdminUsers()" class="admin-back-btn">← 返回用户列表</button>`;
    html += `<table class="admin-table"><thead><tr><th>ID</th><th>角色</th><th>内容</th><th>模型</th><th>时间</th></tr></thead><tbody>`;

    (data.messages || []).forEach(msg => {
      const content = (msg.content || '').substring(0, 100) + (msg.content?.length > 100 ? '...' : '');
      html += `
            <tr>
              <td>${msg.id}</td>
              <td>${msg.role === 'user' ? '👤 用户' : '🤖 AI'}</td>
              <td class="admin-msg-content">${escapeHtml(content)}</td>
              <td>${msg.model || '-'}</td>
              <td>${formatDate(msg.created_at)}</td>
            </tr>
          `;
    });

    html += '</tbody></table>';
    document.getElementById('adminUsersTable').innerHTML = html;

  } catch (err) {
    console.error('加载用户消息失败:', err);
  }
}

// 删除用户
async function deleteUser(userId) {
  if (!confirm(`确定要删除用户 #${userId} 及其所有数据吗？此操作不可撤销！`)) return;

  try {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': adminState.token }
    });
    if (res.ok) {
      loadAdminUsers();
    } else {
      alert('删除失败');
    }
  } catch (err) {
    alert('网络错误');
  }
}

// 加载消息列表
async function loadAdminMessages() {
  const search = document.getElementById('adminMessageSearch')?.value || '';
  try {
    const res = await fetch(`/api/admin/messages?search=${encodeURIComponent(search)}`, {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();

    let html = `
          <table class="admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>用户</th>
                <th>角色</th>
                <th>内容</th>
                <th>模型</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
        `;

    (data.messages || []).forEach(msg => {
      const content = (msg.content || '').substring(0, 80) + (msg.content?.length > 80 ? '...' : '');
      html += `
            <tr>
              <td>${msg.id}</td>
              <td>${msg.username || msg.email || '-'}</td>
              <td>${msg.role === 'user' ? '👤' : '🤖'}</td>
              <td class="admin-msg-content">${escapeHtml(content)}</td>
              <td>${msg.model || '-'}</td>
              <td>${formatDate(msg.created_at)}</td>
              <td><button class="admin-action-btn delete" onclick="deleteMessage(${msg.id})">删除</button></td>
            </tr>
          `;
    });

    html += '</tbody></table>';
    document.getElementById('adminMessagesTable').innerHTML = html;

  } catch (err) {
    console.error('加载消息列表失败:', err);
  }
}

// 删除消息
async function deleteMessage(messageId) {
  if (!confirm('确定要删除这条消息吗？')) return;

  try {
    const res = await fetch(`/api/admin/messages/${messageId}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': adminState.token }
    });
    if (res.ok) {
      loadAdminMessages();
    }
  } catch (err) {
    console.error('删除消息失败:', err);
  }
}

// 加载会话列表
async function loadAdminSessions() {
  try {
    const res = await fetch('/api/admin/sessions', {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();

    let html = `
          <table class="admin-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>用户</th>
                <th>标题</th>
                <th>模型</th>
                <th>消息数</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
        `;

    (data.sessions || []).forEach(session => {
      html += `
            <tr>
              <td class="admin-session-id">${session.id.substring(0, 15)}...</td>
              <td>${session.username || session.email || '-'}</td>
              <td>${escapeHtml(session.title || '新对话')}</td>
              <td>${session.model || '-'}</td>
              <td>${session.messageCount || 0}</td>
              <td>${formatDate(session.updated_at)}</td>
              <td><button class="admin-action-btn delete" onclick="deleteSession('${session.id}')">删除</button></td>
            </tr>
          `;
    });

    html += '</tbody></table>';
    document.getElementById('adminSessionsTable').innerHTML = html;

  } catch (err) {
    console.error('加载会话列表失败:', err);
  }
}

// 删除会话
async function deleteSession(sessionId) {
  if (!confirm('确定要删除这个会话及其所有消息吗？')) return;

  try {
    const res = await fetch(`/api/admin/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': adminState.token }
    });
    if (res.ok) {
      loadAdminSessions();
    }
  } catch (err) {
    console.error('删除会话失败:', err);
  }
}

// 格式化日期
function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 键盘快捷键: Ctrl+Shift+A 打开管理员入口
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
    e.preventDefault();
    console.log('🔐 管理员快捷键触发');
    if (adminState.isLoggedIn) {
      openAdminPanel();
    } else {
      openAdminLogin();
    }
  }
});

// ==================== 用户详情弹窗 ====================

// 用户详情状态
const userDetailState = {
  userId: null,
  currentSessionId: null
};

// 打开用户详情弹窗
async function openUserDetailModal(userId) {
  userDetailState.userId = userId;
  userDetailState.currentSessionId = null;

  // 创建弹窗结构
  let modal = document.getElementById('userDetailModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'userDetailModal';
    modal.className = 'admin-modal-overlay user-detail-modal';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="user-detail-container">
      <div class="user-detail-header">
        <h2>👤 用户详情</h2>
        <button class="admin-close-btn" onclick="closeUserDetailModal()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="user-detail-body">
        <div class="user-detail-loading">加载中...</div>
      </div>
    </div>
  `;
  modal.classList.add('active');

  try {
    const res = await fetch(`/api/admin/users/${userId}/detail`, {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || '获取用户详情失败');
    }

    renderUserDetail(data.user, data.sessions);
  } catch (err) {
    console.error('❌ 获取用户详情失败:', err);
    modal.querySelector('.user-detail-body').innerHTML = `
      <div class="user-detail-error">❌ ${err.message}</div>
    `;
  }
}

// 渲染用户详情
function renderUserDetail(user, sessions) {
  const modal = document.getElementById('userDetailModal');
  const body = modal.querySelector('.user-detail-body');

  const membershipBadge = getMembershipBadge(user.membership);
  const totalPoints = (user.points || 0) + (user.purchased_points || 0);

  body.innerHTML = `
    <div class="user-detail-content">
      <!-- 用户信息卡片 -->
      <div class="user-info-card">
        <h3>📋 基本信息</h3>
        <div class="user-info-grid">
          <div class="user-info-item">
            <span class="label">用户ID</span>
            <span class="value">${user.id}</span>
          </div>
          <div class="user-info-item">
            <span class="label">邮箱</span>
            <span class="value">${user.email}</span>
          </div>
          <div class="user-info-item">
            <span class="label">用户名</span>
            <span class="value">${user.username || '未设置'}</span>
          </div>
          <div class="user-info-item">
            <span class="label">会员等级</span>
            <span class="value">${membershipBadge}</span>
          </div>
          <div class="user-info-item">
            <span class="label">当前点数</span>
            <span class="value">${totalPoints} ⚡</span>
          </div>
          <div class="user-info-item">
            <span class="label">会话数</span>
            <span class="value">${user.sessionCount || 0}</span>
          </div>
          <div class="user-info-item">
            <span class="label">消息总数</span>
            <span class="value">${user.messageCount || 0}</span>
          </div>
          <div class="user-info-item">
            <span class="label">注册时间</span>
            <span class="value">${formatDate(user.created_at)}</span>
          </div>
          <div class="user-info-item">
            <span class="label">最后登录</span>
            <span class="value">${formatDate(user.last_login)}</span>
          </div>
          <div class="user-info-item">
            <span class="label">最后签到</span>
            <span class="value">${user.last_checkin || '从未'}</span>
          </div>
        </div>
      </div>
      
      <!-- 会话列表和消息查看区域 -->
      <div class="user-sessions-area">
        <div class="user-sessions-list">
          <h3>💬 对话列表 (${sessions.length})</h3>
          <div class="sessions-scroll">
            ${sessions.length === 0 ? '<div class="no-sessions">该用户暂无对话</div>' : sessions.map(s => `
              <div class="ud-session-item ${userDetailState.currentSessionId === s.id ? 'active' : ''}" 
                   data-session-id="${s.id}"
                   onclick="loadSessionMessages('${s.id}')">
                <div class="ud-session-title">${escapeHtml(s.title || '新对话')}</div>
                <div class="ud-session-meta">
                  <span>${s.messageCount || 0} 条消息</span>
                  <span>${formatDate(s.updated_at)}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        
        <div class="user-messages-area" id="userMessagesArea">
          <div class="ud-messages-placeholder">
            <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
              <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
            </svg>
            <p>点击左侧对话查看完整消息</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

// 加载会话消息
async function loadSessionMessages(sessionId) {
  userDetailState.currentSessionId = sessionId;

  // 更新选中状态
  document.querySelectorAll('.ud-session-item').forEach(el => {
    el.classList.toggle('active', el.dataset.sessionId === sessionId);
  });

  const messagesArea = document.getElementById('userMessagesArea');
  messagesArea.innerHTML = '<div class="ud-messages-loading">加载消息中...</div>';

  try {
    const res = await fetch(`/api/admin/sessions/${sessionId}/messages?limit=200`, {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || '获取消息失败');
    }

    renderSessionMessages(data.session, data.messages, data.totalCount);
  } catch (err) {
    console.error('❌ 获取会话消息失败:', err);
    messagesArea.innerHTML = `<div class="ud-messages-error">❌ ${err.message}</div>`;
  }
}

// 渲染会话消息
function renderSessionMessages(session, messages, totalCount) {
  const messagesArea = document.getElementById('userMessagesArea');

  if (messages.length === 0) {
    messagesArea.innerHTML = '<div class="ud-messages-placeholder"><p>该对话暂无消息</p></div>';
    return;
  }

  let html = `
    <div class="ud-messages-header">
      <h4>${escapeHtml(session.title || '对话详情')}</h4>
      <span class="ud-messages-count">共 ${totalCount} 条消息</span>
    </div>
    <div class="ud-messages-list">
  `;

  messages.forEach(msg => {
    const isUser = msg.role === 'user';
    const roleLabel = isUser ? '👤 用户' : '🤖 AI';
    const roleClass = isUser ? 'user-msg' : 'ai-msg';

    // 完整显示消息内容，不截断
    const content = msg.content || '(空消息)';

    html += `
      <div class="ud-message-item ${roleClass}">
        <div class="ud-message-header">
          <span class="ud-message-role">${roleLabel}</span>
          <span class="ud-message-time">${formatDate(msg.created_at)}</span>
          ${msg.model ? `<span class="ud-message-model">${msg.model}</span>` : ''}
        </div>
        <div class="ud-message-content" onclick="this.classList.toggle('expanded')">
          <pre>${escapeHtml(content)}</pre>
        </div>
        ${msg.reasoning_content ? `
          <details class="ud-message-reasoning">
            <summary>🧠 思考过程 (点击展开)</summary>
            <pre>${escapeHtml(msg.reasoning_content)}</pre>
          </details>
        ` : ''}
      </div>
    `;
  });

  html += '</div>';
  messagesArea.innerHTML = html;
}

// 关闭用户详情弹窗  
function closeUserDetailModal() {
  const modal = document.getElementById('userDetailModal');
  if (modal) {
    modal.classList.remove('active');
  }
  userDetailState.userId = null;
  userDetailState.currentSessionId = null;
}

// 初始化时检查管理员状态
checkAdminLogin();
