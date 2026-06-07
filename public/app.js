// ==================== ChatFlow iframe 模式检测 ====================
// 检测是否在 ChatFlow iframe 模式下运行
const isChatFlowIframeMode = new URLSearchParams(window.location.search).get('mode') === 'chatflow';

// 存储从父窗口接收的画布上下文
let chatFlowCanvasContext = '';
let pendingCanvasCallback = null;

// ChatFlow iframe 模式初始化
if (isChatFlowIframeMode) {
  document.addEventListener('DOMContentLoaded', () => {
    console.log(' ChatFlow iframe 模式已启用');

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
        console.log(' 收到画布上下文:', chatFlowCanvasContext.substring(0, 100) + '...');

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
        console.log(' 拖拽选中文本:', selection.substring(0, 50) + (selection.length > 50 ? '...' : ''));
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
      console.warn(' 画布上下文请求超时');
      pendingCanvasCallback('');
      pendingCanvasCallback = null;
    }
  }, 500);
}


// ==================== 渲染工具函数 (Markdown/KaTeX/Mermaid) ====================
// Robust loading with CDN fallback
window.addEventListener('load', function () {
  if (typeof marked === 'undefined' && !window.marked) {
    console.warn(' Local marked.js failed to load. Attempting CDN fallback...');
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
    script.onload = function () {
      console.log(' Marked.js loaded from CDN');
      configureMarkedSecurity();
      if (typeof renderMessages === 'function') {
        console.log(' Re-rendering messages...');
        renderMessages();
      }
    };
    script.onerror = function () {
      console.error(' Critical: Marked.js failed to load from both local and CDN');
      // Define a simple fallback
      window.marked = {
        parse: function (text) { return text; }
      };
    };
    document.head.appendChild(script);
  } else {
    console.log(' Marked.js loaded successfully (Local)');
  }
});

// 数学公式渲染 - 完整解决方案

// 渲染带数学公式的Markdown文本
// @param {string} text - 要渲染的文本
// @param {boolean} isStreaming - 是否流式模式（流式模式下用占位符替代图片）
let markedSecurityConfigured = false;

function configureMarkedSecurity() {
  const markedLib = window.marked || (typeof marked !== 'undefined' ? marked : null);
  if (!markedLib || markedSecurityConfigured) return;

  if (typeof markedLib.Renderer === 'function') {
    const renderer = new markedLib.Renderer();
    renderer.html = function (html) {
      return escapeHtml(String(html || ''));
    };

    if (typeof markedLib.use === 'function') {
      markedLib.use({ renderer });
    } else if (typeof markedLib.setOptions === 'function') {
      markedLib.setOptions({ renderer });
    }
  }

  markedSecurityConfigured = true;
}

const RAI_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2',
    'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span',
    'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'
  ],
  ALLOWED_ATTR: [
    'alt', 'aria-hidden', 'aria-label', 'class', 'data-lang', 'data-mermaid-code',
    'data-mermaid-index', 'data-src', 'href', 'id', 'loading', 'rel', 'role', 'src', 'target', 'title'
  ],
  ALLOW_DATA_ATTR: true,
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math'],
  FORBID_ATTR: ['style'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#|data:image\/(?:png|jpeg|gif|webp);base64,)/i
};

function sanitizeRenderedHtml(html) {
  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    return window.DOMPurify.sanitize(String(html || ''), RAI_SANITIZE_CONFIG);
  }
  return escapeHtml(String(html || ''));
}

function sanitizeReasoningText(text) {
  const escaped = escapeHtml(String(text || ''))
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    return window.DOMPurify.sanitize(escaped, {
      ALLOWED_TAGS: ['strong', 'br'],
      ALLOWED_ATTR: []
    });
  }
  return escaped;
}

function renderMarkdownWithMath(text, isStreaming = false) {
  if (!text) return '';

  const normalizedText = normalizeMarkdownTables(String(text || ''));
  const { text: mermaidProtectedText, blocks: mermaidBlocks } = extractMermaidBlocks(normalizedText);

  // 临时存储公式的映射
  const mathStore = new Map();
  let counter = 0;

  // 1. 保护 $$ ... $$ 块级公式
  let protectedText = mermaidProtectedText.replace(/\$\$([\s\S]+?)\$\$/g, (match, formula) => {
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
    configureMarkedSecurity();
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
          trust: false,
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

  // 6.  Mermaid 图表处理：检测并转换 mermaid 代码块为渲染容器
  //  流式模式下跳过转换（使用独立的 mermaidLivePreview 容器实时渲染）
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

  html = restoreMermaidPlaceholders(html, mermaidBlocks, isStreaming);
  html = wrapTablesInHtml(html);

  return sanitizeRenderedHtml(html);
}

function looksLikeMarkdownTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) return false;
  return (trimmed.match(/\|/g) || []).length >= 2;
}

function looksLikeMarkdownTableSeparator(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/.test(String(line || ''));
}

function normalizeMarkdownTables(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const output = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const nextLine = lines[i + 1];

    if (looksLikeMarkdownTableRow(line) && looksLikeMarkdownTableSeparator(nextLine)) {
      if (output.length > 0 && output[output.length - 1].trim() !== '') {
        output.push('');
      }

      output.push(line.trimEnd());
      output.push(String(nextLine || '').trimEnd());
      i += 1;

      while (i + 1 < lines.length && looksLikeMarkdownTableRow(lines[i + 1])) {
        i += 1;
        output.push(lines[i].trimEnd());
      }

      if (i + 1 < lines.length && lines[i + 1].trim() !== '') {
        output.push('');
      }
      continue;
    }

    output.push(line);
  }

  return output.join('\n');
}

function parseMermaidOpeningFence(line) {
  const match = String(line || '').match(/^\s*(`{3,}|~{3,})\s*mermaid\b\s*(.*)$/i);
  if (!match) return null;
  return {
    marker: match[1][0],
    trailing: match[2] || ''
  };
}

function isMermaidClosingFenceLine(line) {
  const value = String(line || '').trim();
  return /^`{2,}$/.test(value) || /^~{3,}$/.test(value);
}

function splitMermaidInlineFence(line) {
  const value = String(line || '');
  const tickIndex = value.search(/`{2,}/);
  const tildeIndex = value.search(/~{3,}/);
  const indexes = [tickIndex, tildeIndex].filter(index => index >= 0);
  if (!indexes.length) return null;

  const index = Math.min(...indexes);
  const markerMatch = value.slice(index).match(/^(`{2,}|~{3,})/);
  if (!markerMatch) return null;

  return {
    before: value.slice(0, index).trimEnd(),
    after: value.slice(index + markerMatch[0].length)
  };
}

function stripMermaidFenceNoise(code) {
  const lines = normalizeMermaidCode(code).split('\n');
  const output = [];

  for (const line of lines) {
    if (isMermaidClosingFenceLine(line)) break;

    const inlineFence = splitMermaidInlineFence(line);
    if (inlineFence) {
      if (inlineFence.before.trim()) {
        output.push(inlineFence.before);
      }
      break;
    }

    output.push(line);
  }

  return normalizeMermaidCode(output.join('\n'));
}

function extractMermaidBlocks(text) {
  const source = String(text || '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const output = [];
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const opening = parseMermaidOpeningFence(lines[i]);

    if (!opening) {
      output.push(lines[i]);
      continue;
    }

    const codeLines = [];
    const openingTrailing = opening.trailing.trim();
    if (openingTrailing) {
      codeLines.push(openingTrailing);
    }

    let afterClosingFence = '';
    i += 1;

    for (; i < lines.length; i += 1) {
      const line = lines[i];

      if (isMermaidClosingFenceLine(line)) {
        break;
      }

      const inlineFence = splitMermaidInlineFence(line);
      if (inlineFence) {
        if (inlineFence.before.trim()) {
          codeLines.push(inlineFence.before);
        }
        afterClosingFence = inlineFence.after;
        break;
      }

      codeLines.push(line);
    }

    const token = `@@MERMAIDBLOCK${blocks.length}@@`;
    blocks.push(stripMermaidFenceNoise(codeLines.join('\n')));
    output.push(token);

    if (afterClosingFence.trim()) {
      output.push(afterClosingFence);
    }
  }

  return {
    text: output.join('\n'),
    blocks
  };
}

function restoreMermaidPlaceholders(html, blocks, isStreaming = false) {
  let restoredHtml = String(html || '');

  blocks.forEach((blockCode, index) => {
    const token = `@@MERMAIDBLOCK${index}@@`;
    const normalizedCode = normalizeMermaidCode(blockCode);
    const replacement = isStreaming
      ? `<div class="mermaid-inline-wrapper" data-mermaid-index="${index}" data-mermaid-code="${encodeURIComponent(normalizedCode)}"><div class="mermaid-preview-container"><div class="mermaid-loading"><span>图表 ${index + 1} 渲染中...</span></div></div></div>`
      : `<div class="mermaid-container" id="mermaid-${Math.random().toString(36).slice(2, 11)}" data-mermaid-code="${encodeURIComponent(normalizedCode)}"></div>`;
    restoredHtml = restoredHtml.replace(new RegExp(token, 'g'), replacement);
  });

  return restoredHtml;
}

function wrapTablesInHtml(html) {
  return String(html || '').replace(
    /(<table[\s\S]*?<\/table>)/gi,
    '<div class="table-wrapper">$1</div>'
  );
}

function normalizeMermaidCode(code) {
  return String(code || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s+|\s+$/g, '');
}

function decodeHtmlEntities(value) {
  if (!value) return '';
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}

function sanitizeMermaidCode(code) {
  let normalized = stripMermaidFenceNoise(normalizeMermaidCode(decodeHtmlEntities(code)));

  if (!normalized) return '';

  normalized = normalized
    .replace(/<\/?(span|math|semantics|annotation|mrow|mn|mo|mi|mtext|pre|code|div)[^>]*>/gi, '')
    .replace(/<\/?br\s*\/?>/gi, '<br/>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+\n/g, '\n');

  normalized = normalized.replace(
    /^(\s*[xy]-axis\s+.+?)\s*[←↔→]+\s*(.+)$/gim,
    '$1 --> $2'
  );

  normalized = repairXyChartSyntax(normalized);

  if (/^\s*bar\s*$/i.test(normalized.split('\n')[0] || '')) {
    const converted = convertLegacyBarChart(normalized);
    if (converted) {
      normalized = converted;
    }
  }

  return normalizeMermaidCode(normalized);
}

function escapeMermaidQuotedText(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '').replace(/"/g, '\\"');
}

function quoteMermaidText(value) {
  const text = String(value || '').trim();
  if (!text) return '""';
  if (/^".*"$/.test(text)) return text;
  return `"${escapeMermaidQuotedText(text)}"`;
}

function splitXyChartClauses(line) {
  return String(line || '')
    .replace(/\s+(?=(?:title\b|x-axis\b|y-axis\b|bar\s*\[|line\s*\[))/gi, '\n')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);
}

function quoteXyAxisLabels(rawLabels) {
  return String(rawLabels || '')
    .split(',')
    .map((label) => {
      const trimmed = label.trim();
      if (!trimmed) return '';
      if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) {
        return quoteMermaidText(trimmed);
      }
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
      return quoteMermaidText(trimmed);
    })
    .filter(Boolean)
    .join(', ');
}

function repairXyChartSyntax(code) {
  const lines = normalizeMermaidCode(code).split('\n');
  if (!lines.length) return code;

  const firstLineMatch = lines[0].trim().match(/^(xychart(?:-beta)?)(?:\s+(.+))?$/i);
  if (!firstLineMatch) return code;

  const output = [firstLineMatch[1].toLowerCase() === 'xychart' ? 'xychart-beta' : firstLineMatch[1]];
  const pendingLines = [];
  if (firstLineMatch[2]) {
    pendingLines.push(...splitXyChartClauses(firstLineMatch[2]));
  }
  for (let i = 1; i < lines.length; i += 1) {
    pendingLines.push(...splitXyChartClauses(lines[i]));
  }

  pendingLines.forEach((rawLine) => {
    let line = rawLine.trim();
    if (!line) return;

    const titleMatch = line.match(/^title\s*:?\s+(.+)$/i);
    if (titleMatch) {
      output.push(`  title ${quoteMermaidText(titleMatch[1])}`);
      return;
    }

    const xAxisMatch = line.match(/^x-axis\s*\[(.*)\]\s*$/i);
    if (xAxisMatch) {
      output.push(`  x-axis [${quoteXyAxisLabels(xAxisMatch[1])}]`);
      return;
    }

    const yAxisMatch = line.match(/^y-axis\s+(.+)$/i);
    if (yAxisMatch) {
      const rest = yAxisMatch[1].trim();
      if (/^-?\d+(?:\.\d+)?\s*-->\s*-?\d+(?:\.\d+)?$/.test(rest) || /^".*"/.test(rest)) {
        output.push(`  y-axis ${rest}`);
        return;
      }

      const rangedLabelMatch = rest.match(/^(.+?)\s+(-?\d+(?:\.\d+)?\s*-->\s*-?\d+(?:\.\d+)?)$/);
      if (rangedLabelMatch) {
        output.push(`  y-axis ${quoteMermaidText(rangedLabelMatch[1])} ${rangedLabelMatch[2]}`);
      } else {
        output.push(`  y-axis ${quoteMermaidText(rest)}`);
      }
      return;
    }

    const seriesMatch = line.match(/^(bar|line)\s*(?:\[)?\s*([^\]]+?)\s*(?:\])?$/i);
    if (seriesMatch) {
      output.push(`  ${seriesMatch[1].toLowerCase()} [${seriesMatch[2].trim()}]`);
      return;
    }

    output.push(`  ${line}`);
  });

  return output.join('\n');
}

function convertLegacyBarChart(code) {
  const lines = normalizeMermaidCode(code).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines[0].toLowerCase() !== 'bar') return null;

  let title = '';
  let yAxisLabel = 'Value';
  const labels = [];
  const values = [];

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^title\s+/i.test(line)) {
      title = line.replace(/^title\s+/i, '').trim();
      continue;
    }
    if (/^axis\s+y\s+/i.test(line)) {
      yAxisLabel = line.replace(/^axis\s+y\s+/i, '').trim();
      continue;
    }

    const entryMatch = line.match(/^"(.+?)"\s*:\s*(-?\d+(?:\.\d+)?)$/);
    if (entryMatch) {
      labels.push(entryMatch[1]);
      values.push(Number(entryMatch[2]));
    }
  }

  if (labels.length === 0 || labels.length !== values.length) return null;

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const padding = Math.max(1, Math.ceil((maxValue - minValue) * 0.1));
  const lowerBound = Math.floor(minValue - padding);
  const upperBound = Math.ceil(maxValue + padding);

  return [
    'xychart-beta',
    title ? `  title "${title.replace(/"/g, '\\"')}"` : '',
    `  x-axis [${labels.map((label) => `"${label.replace(/"/g, '\\"')}"`).join(', ')}]`,
    `  y-axis "${yAxisLabel.replace(/"/g, '\\"')}" ${lowerBound} --> ${upperBound}`,
    `  bar [${values.join(', ')}]`
  ].filter(Boolean).join('\n');
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

  const annotatedSources = annotateSourceMarkers(sources);

  return html.replace(/\[([0-9]+|[A-Z]{1,3})\]/g, (match, markerText) => {
    const normalizedMarker = String(markerText || '').toUpperCase();
    const source = annotatedSources.find((item) => String(item.marker || '').toUpperCase() === normalizedMarker);
    if (source && source.url) {
      return `<a href="${source.url}" target="_blank" rel="noopener" class="citation-badge citation-badge-${source.markerType || 'numeric'}" title="${source.title || '来源'}">[${normalizedMarker}]</a>`;
    }
    return match;
  });
}

function renderSourcesList(sources, language) {
  if (!sources || sources.length === 0) return '';

  const annotatedSources = annotateSourceMarkers(sources);
  const groupedSources = groupSourcesForDisplay(annotatedSources, language);
  const isChinese = isChineseLanguage(language);
  const headerText = isChinese ? '来源' : 'Sources';
  const expandText = isChinese ? '展开来源' : 'Show Sources';
  const collapseText = isChinese ? '收起来源' : 'Hide Sources';
  const sourceCount = annotatedSources.length;

  let html = `
        <div class="sources-list is-collapsed">
          <div class="sources-header">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
            <span>${headerText}</span>
            <button
              type="button"
              class="sources-toggle-btn"
              data-count="${sourceCount}"
              data-label-expand="${expandText}"
              data-label-collapse="${collapseText}"
              data-expanded="false"
              onclick="toggleSourcesList(this)"
            >
              <span class="sources-toggle-text">${expandText} (${sourceCount})</span>
              <span class="sources-toggle-icon"></span>
            </button>
          </div>
      `;

  groupedSources.forEach((group) => {
    if (!group.sources.length) return;

    html += `
          <div class="sources-group">
            <div class="sources-group-title">${group.title}</div>
            <div class="sources-body">
        `;

    group.sources.forEach((source) => {
      const domain = source.site_name || (source.url ? new URL(source.url).hostname.replace('www.', '') : '');
      const faviconHtml = source.favicon
        ? `<img class="source-favicon" src="${source.favicon}" alt="" onerror="this.style.display='none'">`
        : `<div class="source-favicon-placeholder"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg></div>`;
      const metaLine = group.kind === 'finance'
        ? `${escapeHtml(source.label || 'Yahoo Finance')} · ${escapeHtml(source.symbol || '')} · ${escapeHtml(source.range || '')}/${escapeHtml(source.interval || '')}`
        : escapeHtml(domain);

      html += `
            <a href="${source.url || '#'}" target="_blank" rel="noopener" class="source-card source-card-${group.kind}">
              <span class="source-index">${escapeHtml(source.marker || '')}</span>
              ${faviconHtml}
              <div class="source-info">
                <div class="source-title">${escapeHtml(source.title || '未知来源')}</div>
                <div class="source-domain">${metaLine}</div>
              </div>
            </a>
          `;
    });

    html += `
            </div>
          </div>
        `;
  });

  html += `
        </div>
      `;
  return html;
}

function toggleSourcesList(button) {
  if (!button) return;
  const wrapper = button.closest('.sources-list');
  if (!wrapper) return;

  const expanded = wrapper.classList.contains('is-expanded');
  const nextExpanded = !expanded;
  wrapper.classList.toggle('is-expanded', nextExpanded);
  wrapper.classList.toggle('is-collapsed', !nextExpanded);

  const expandText = button.getAttribute('data-label-expand') || 'Show Sources';
  const collapseText = button.getAttribute('data-label-collapse') || 'Hide Sources';
  const count = button.getAttribute('data-count') || '0';
  const textEl = button.querySelector('.sources-toggle-text');
  const iconEl = button.querySelector('.sources-toggle-icon');

  if (textEl) {
    textEl.textContent = `${nextExpanded ? collapseText : expandText} (${count})`;
  }
  if (iconEl) {
    iconEl.textContent = nextExpanded ? '▼' : '';
  }
  button.setAttribute('data-expanded', nextExpanded ? 'true' : 'false');
}

function mergeAndReindexSources(existingSources = [], incomingSources = []) {
  const merged = [];
  const seen = new Set();

  const append = (source) => {
    if (!source || typeof source !== 'object') return;
    const key = [
      String(source.provider || ''),
      String(source.url || ''),
      String(source.title || ''),
      String(source.symbol || ''),
      String(source.range || ''),
      String(source.interval || '')
    ].join('|');
    if (!source.url || seen.has(key)) return;
    seen.add(key);
    merged.push({
      ...source,
      title: source.title || '未知标题'
    });
  };

  (Array.isArray(existingSources) ? existingSources : []).forEach(append);
  (Array.isArray(incomingSources) ? incomingSources : []).forEach(append);

  return annotateSourceMarkers(merged);
}

function getSourceKind(source) {
  if (source?.sourceKind) return source.sourceKind;
  if (source?.provider === 'yahoo_finance') return 'finance';
  return 'web';
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

function annotateSourceMarkers(sources = []) {
  let webCounter = 0;
  let financeCounter = 0;

  return (Array.isArray(sources) ? sources : []).map((source) => {
    const sourceKind = getSourceKind(source);
    if (source.marker) {
      if (sourceKind === 'finance') {
        financeCounter += 1;
      } else {
        webCounter += 1;
      }
      return {
        ...source,
        sourceKind,
        markerType: source.markerType || (sourceKind === 'finance' ? 'alpha' : 'numeric')
      };
    }

    if (sourceKind === 'finance') {
      financeCounter += 1;
      return {
        ...source,
        sourceKind,
        markerType: 'alpha',
        marker: alphaMarkerFromIndex(financeCounter),
        index: source.index || financeCounter
      };
    }

    webCounter += 1;
    return {
      ...source,
      sourceKind,
      markerType: 'numeric',
      marker: String(webCounter),
      index: source.index || webCounter
    };
  });
}

function groupSourcesForDisplay(sources = [], language = appState.language) {
  const isChinese = isChineseLanguage(language);
  const groups = [
    {
      kind: 'web',
      title: isChinese ? '网页来源 / Tavily' : 'Web Sources / Tavily',
      sources: []
    },
    {
      kind: 'finance',
      title: isChinese ? '市场数据 / Yahoo Finance' : 'Market Data / Yahoo Finance',
      sources: []
    }
  ];

  (Array.isArray(sources) ? sources : []).forEach((source) => {
    const group = groups.find((item) => item.kind === getSourceKind(source));
    if (group) group.sources.push(source);
  });

  return groups.filter((group) => group.sources.length > 0);
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

    // 跳过 mermaid 和询问用户工具块
    if (language === 'mermaid' || isAskUserCodeLanguage(language)) return;

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

    // 跳过 mermaid 和询问用户工具块
    if (language === 'mermaid' || isAskUserCodeLanguage(language)) return;

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

    // 流式阶段不执行 hljs，避免不完整代码导致大量告警与抖动。
    // 最终响应完成后会走 processCodeBlocks() 进行一次完整高亮。
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
    console.log(' Mermaid 初始化完成 (主题:', isDark ? 'dark' : 'default', ')');
  } else {
    console.warn(' Mermaid 库未加载');
  }
}

async function renderMermaidSvg(code, renderId) {
  if (typeof mermaid === 'undefined') {
    throw new Error('Mermaid library not loaded');
  }

  const sanitizedCode = sanitizeMermaidCode(code);
  if (!sanitizedCode) {
    throw new Error('Empty Mermaid code');
  }

  const renderHost = document.createElement('div');
  renderHost.className = 'mermaid-render-host';
  renderHost.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0;';
  document.body.appendChild(renderHost);

  try {
    cleanupMermaidRenderArtifacts(renderId, renderHost);
    await mermaid.parse(sanitizedCode);
    const { svg } = await mermaid.render(renderId, sanitizedCode, renderHost);
    if (isMermaidErrorOutput(svg)) {
      throw new Error('Mermaid syntax error');
    }
    cleanupMermaidRenderArtifacts(renderId, renderHost);
    return { svg, code: sanitizedCode };
  } finally {
    cleanupMermaidRenderArtifacts(renderId, renderHost);
    if (renderHost.parentNode) {
      renderHost.parentNode.removeChild(renderHost);
    }
    cleanupStrayMermaidErrorArtifacts();
  }
}

// 渲染页面中的所有 Mermaid 图表
async function renderMermaidCharts() {
  if (typeof mermaid === 'undefined') {
    console.warn('Mermaid library not loaded; skip rendering.');
    return;
  }

  cleanupStrayMermaidErrorArtifacts();

  const containers = document.querySelectorAll('.mermaid-container:not(.rendered)');
  if (containers.length === 0) return;

  console.log(`Start rendering ${containers.length} Mermaid chart(s)`);

  for (const container of containers) {
    const originalCode = decodeURIComponent(container.dataset.mermaidCode || '');
    const code = sanitizeMermaidCode(originalCode);
    if (!code) continue;

    const renderId = container.id + '-svg';

    try {
      const { svg, code: renderedCode } = await renderMermaidSvg(code, renderId);
      container.dataset.mermaidCode = encodeURIComponent(renderedCode);
      container.innerHTML = svg;
      container.classList.add('rendered');

      addMermaidToolbar(container);

      console.log(`Mermaid chart rendered: ${container.id}`);
    } catch (err) {
      console.error('Mermaid render failed:', err);
      cleanupStrayMermaidErrorArtifacts();
      container.innerHTML = `<div class="mermaid-error">
            <span class="mermaid-error-title">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
              Diagram render failed
            </span>
            <pre>${escapeHtml(err.message || 'Syntax error')}</pre>
            <details><summary>View chart code</summary><pre>${escapeHtml(originalCode)}</pre></details>
          </div>`;
      container.classList.add('render-error');
    }
  }
}

function isMermaidErrorOutput(svg) {
  const text = String(svg || '');
  return text.includes('aria-roledescription="error"') || text.includes('Syntax error in text');
}

function cleanupMermaidRenderArtifacts(renderId, renderHost = null) {
  const wrapperId = 'd' + renderId;
  const selectors = ['#' + CSS.escape(renderId), '#' + CSS.escape(wrapperId)];

  document.querySelectorAll(selectors.join(',')).forEach((node) => {
    if (renderHost && renderHost.contains(node)) return;
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
  });

  if (renderHost) {
    renderHost.innerHTML = '';
  }
}

function cleanupStrayMermaidErrorArtifacts() {
  document.querySelectorAll('body > div[id^="dmermaid-"]').forEach((node) => {
    if (node.querySelector('svg[aria-roledescription="error"], .error-icon, .error-text')) {
      node.remove();
    }
  });

  document.querySelectorAll('body > svg[id^="mermaid-"][aria-roledescription="error"]').forEach((node) => {
    node.remove();
  });
}

function copyMermaidCode(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const code = decodeURIComponent(container.dataset.mermaidCode || '');
  navigator.clipboard.writeText('```mermaid\n' + code + '\n```').then(() => {
    console.log(' Mermaid 代码已复制');
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
    console.log(' Mermaid 代码已复制');
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
  });

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
    const sanitizedCode = sanitizeMermaidCode(code);
    if (!sanitizedCode) {
      container.classList.remove('rendering');
      return;
    }

    const id = container.id + '-svg';
    const { svg, code: renderedCode } = await renderMermaidSvg(sanitizedCode, id);

    container.dataset.mermaidCode = encodeURIComponent(renderedCode);
    container.innerHTML = svg;
    container.classList.remove('rendering');
    container.classList.add('rendered');

    // 添加工具栏
    addMermaidToolbar(container);

    // 缓存渲染结果
    cache.set(container.dataset.mermaidCode, container.cloneNode(true));

    console.log(` 流式渲染 Mermaid 图表: ${container.id}`);
  } catch (err) {
    container.classList.remove('rendering');
    // 渲染失败则保持loading状态，等待更多内容（可能代码不完整）
    console.debug(' Mermaid 代码可能不完整，等待更多内容...', err.message);
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

  //  上传文件图标 - 用于新建对话按钮、新建空间按钮、附件上传按钮
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

  // 齿轮/设置图标 灯泡/推理图标 - 用于输入框推理模式按钮、AI消息思考过程标签（已更换为灯泡样式）
  'psychology': { viewBox: '0 -960 960 960', content: '<path d="M240-80v-172q-57-52-88.5-121.5T120-520q0-150 105-255t255-105q125 0 221.5 73.5T827-615l52 205q5 19-7 34.5T840-360h-80v120q0 33-23.5 56.5T680-160h-80v80h-80v-160h160v-200h108l-38-155q-23-91-98-148t-172-57q-116 0-198 81t-82 197q0 60 24.5 114t69.5 96l26 24v208h-80Zm254-360Zm-54 80h80l6-50q8-3 14.5-7t11.5-9l46 20 40-68-40-30q2-8 2-16t-2-16l40-30-40-68-46 20q-5-5-11.5-9t-14.5-7l-6-50h-80l-6 50q-8 3-14.5 7t-11.5 9l-46-20-40 68 40 30q-2 8-2 16t2 16l-40 30 40 68 46-20q5 5 11.5 9t14.5 7l6 50Zm40-100q-25 0-42.5-17.5T420-520q0-25 17.5-42.5T480-580q25 0 42.5 17.5T540-520q0 25-17.5 42.5T480-460Z"/>' },

  //  发送箭头图标（加粗版）- 用于输入框发送按钮
  'arrow_upward': '<path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z" stroke-width="2"/>',
  'south': '<path d="M4 12l1.41-1.41L11 16.17V4h2v12.17l5.58-5.59L20 12l-8 8-8-8z"/>',

  // 停止方块图标 - 用于停止AI生成按钮
  'stop': '<path d="M6 6h12v12H6z"/>',

  // 关闭/叉号图标 - 用于设置面板关闭按钮、对话删除等
  'close': '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',

  //  AI机器人图标 - 用于AI消息的头像、模型标签
  'smart_toy': {
    viewBox: '0 0 64 64',
    content: '<circle cx="32" cy="32" r="14" fill="currentColor"/><path d="M 10 42 C 10 35, 54 20, 54 28 C 54 32, 40 40, 32 40" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M 54 28 C 54 36, 10 50, 10 42" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>'
  },

  // 复制图标 - 用于复制AI消息内容按钮
  'content_copy': '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>',
  'thumb_up': '<path d="M21 8h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2zM9 19V9l4.34-4.34L12 10h9v2l-3 7H9zM1 9h4v12H1z"/>',
  'thumb_down': '<path d="M3 16h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2H6c-.83 0-1.54.5-1.84 1.22L1.14 11.27c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2zm12-11v10l-4.34 4.34L12 14H3v-2l3-7h9zm4-2h4v12h-4z"/>',

  // 图片图标 - 用于附件预览
  'image': '<path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5zM8 8.5c0-.83.67-1.5 1.5-1.5S11 7.67 11 8.5 10.33 10 9.5 10 8 9.33 8 8.5z"/>',

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


  //  Sparkle/星星闪烁图标 - 用于思考(Chain of Thought)UI的图标
  'sparkles': { viewBox: '0 -960 960 960', content: '<path d="m354-247 126-76 126 77-33-144 111-96-146-13-58-136-58 135-146 13 111 97-33 143ZM233-80l65-281L80-550l288-25 112-265 112 265 288 25-218 189 65 281-247-149L233-80Z"/>' },

  //  RAI 彩色Logo - 用于侧边栏品牌Logo、AI消息头像、欢迎页面
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

const RAI_PRODUCTION_ORIGIN = 'https://rai.rick.quest';

function isTauriDesktopRuntime() {
  return Boolean(
    window.__TAURI__ ||
    window.__TAURI_INTERNALS__ ||
    window.location.protocol === 'tauri:' ||
    window.location.hostname === 'tauri.localhost'
  );
}

const RAI_IS_TAURI_DESKTOP = isTauriDesktopRuntime();
document.documentElement.classList.toggle('is-tauri-desktop', RAI_IS_TAURI_DESKTOP);
const APP_BASE_PATH = !RAI_IS_TAURI_DESKTOP && (window.location.pathname === '/beta' || window.location.pathname.startsWith('/beta/'))
  ? '/beta'
  : '';
const API_BASE = RAI_IS_TAURI_DESKTOP ? `${RAI_PRODUCTION_ORIGIN}/api` : `${APP_BASE_PATH}/api`;
const RAI_APP_VERSION = '0.10.9.16';
const RAI_BUILD_ID = '20260604-transparent-icon-download-v010916';

function resolveRaiRemoteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || !RAI_IS_TAURI_DESKTOP) return raw;
  if (/^(https?:|data:|blob:|mailto:|tel:)/i.test(raw)) return raw;
  if (raw.startsWith('/api/') || raw.startsWith('/avatars/') || raw.startsWith('/uploads/')) {
    return `${RAI_PRODUCTION_ORIGIN}${raw}`;
  }
  return raw;
}

if ((APP_BASE_PATH || RAI_IS_TAURI_DESKTOP) && typeof window.fetch === 'function') {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (resource, init) {
    if (typeof resource === 'string' && resource.startsWith('/api/')) {
      return nativeFetch(RAI_IS_TAURI_DESKTOP ? `${RAI_PRODUCTION_ORIGIN}${resource}` : `${APP_BASE_PATH}${resource}`, init);
    }
    if (resource instanceof Request) {
      const url = new URL(resource.url, window.location.origin);
      if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
        const nextUrl = RAI_IS_TAURI_DESKTOP
          ? `${RAI_PRODUCTION_ORIGIN}${url.pathname}${url.search}${url.hash}`
          : `${APP_BASE_PATH}${url.pathname}${url.search}${url.hash}`;
        return nativeFetch(new Request(nextUrl, resource), init);
      }
    }
    return nativeFetch(resource, init);
  };
}

const appState = {
  user: null,
  token: null,
  currentSession: null,
  sessions: [],
  messages: [],
  currentRequestId: null,
  isStreaming: false,
  selectedModel: 'auto',  // 默认智能模型
  profileDefaultModel: 'auto',  // 用户云端保存的默认模型（Pro/MAX记忆）
  thinkingMode: false,  // 默认关闭推理模式
  reasoningProfile: 'low',
  internetMode: true,  // 默认开启联网
  agentMode: false,  // 兼容旧字段；深度研究由 researchMode 驱动
  agentPolicy: 'dynamic-1-4',
  qualityProfile: 'high',
  researchModeEnabled: false,
  researchMode: 'fast',
  inputExpanded: false,  // 输入框展开状态
  thinkingBudget: 1024,
  thinkingBudgetOpen: false,
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 2000,
  frequencyPenalty: 0,
  presencePenalty: 0,
  systemPrompt: '',  // 用户的个人偏好，将附加到内置提示词后
  pendingDomainMode: null,  // 首页功能块注入的领域模式（单次请求）
  sidebarOpen: false,
  settingsOpen: false,
  activeSettingsSection: 'language',
  settingsMobileMode: 'home',
  settingsHistoryDepth: 0,
  touchStartX: 0,
  touchStartY: 0,
  touchMoveX: 0,
  isSwiping: false,
  sidebarGestureMode: null,
  sidebarGestureLocked: false,
  ztx6dSsoEnabled: false,
  ztx6dBindUrl: '/auth/ztx6d/bind/start',
  activeModelMenuAnchorId: 'modelSelectCustom',
  theme: 'dark',
  themePreference: 'dark',
  systemThemeListenerBound: false,
  language: 'zh-CN',
  languageToggleChinese: 'zh-CN',
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
  scrollFollowMode: 'following', // 'following' | 'pausedByUser'
  scrollBottomThreshold: 160,
  pendingScrollTimer: null,
  mobileComposerFocusTimer: null,
  pendingMobileComposerFocus: false,
  mobileHomeAutoFocusUsed: false,
  isProgrammaticScroll: false,
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

let deferredPwaInstallPrompt = null;
let pwaInstallSupportInitialized = false;
const RAI_PWA_INSTALLED_HINT_KEY = 'rai_pwa_installed_hint';
const RAI_INVITE_REF_KEY = 'rai_invite_referrer_id';
const PWA_INSTALL_REWARD_POINTS = 300;
const INVITE_REWARD_POINTS = 600;
const PWA_INSTALL_CLAIM_SOURCE = 'already-installed-claim';
let pwaInstallTaskReportPending = false;
let pwaRewardPromptDismissedThisSession = false;

function isPwaStandaloneMode() {
  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
    window.navigator?.standalone === true
  );
}

function hasStoredPwaInstallHint() {
  try {
    return localStorage.getItem(RAI_PWA_INSTALLED_HINT_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function storePwaInstallHint() {
  try {
    localStorage.setItem(RAI_PWA_INSTALLED_HINT_KEY, '1');
  } catch (error) {
    console.warn('无法记录 PWA 安装提示状态:', error);
  }
}

function captureInviteRefFromUrl() {
  try {
    const url = new URL(window.location.href);
    const ref = url.searchParams.get('ref') || url.searchParams.get('invite') || url.searchParams.get('rai_ref');
    if (!ref || !/^\d{1,12}$/.test(ref)) return;
    localStorage.setItem(RAI_INVITE_REF_KEY, ref);
  } catch (error) {
    console.warn('无法记录邀请来源:', error);
  }
}

function getStoredInviteReferrerId() {
  try {
    const ref = localStorage.getItem(RAI_INVITE_REF_KEY);
    return ref && /^\d{1,12}$/.test(ref) ? ref : '';
  } catch (error) {
    return '';
  }
}

function clearStoredInviteReferrerId() {
  try {
    localStorage.removeItem(RAI_INVITE_REF_KEY);
  } catch (error) {
    console.warn('无法清理邀请来源:', error);
  }
}

function getInviteLink() {
  const userId = appState.user?.id;
  if (!userId) return window.location.origin + APP_BASE_PATH;
  const url = new URL(window.location.origin + APP_BASE_PATH + '/');
  url.searchParams.set('ref', String(userId));
  return url.toString();
}

function hasCompletedPwaInstallTask() {
  return Boolean(userMembershipState?.tasks?.pwaInstall?.completed);
}

function closePwaRewardPrompt({ dismiss = false } = {}) {
  if (dismiss) {
    pwaRewardPromptDismissedThisSession = true;
  }
  const overlay = document.getElementById('pwaRewardPrompt');
  if (overlay) {
    overlay.classList.remove('active');
  }
}

function ensurePwaRewardPrompt() {
  let overlay = document.getElementById('pwaRewardPrompt');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'pwaRewardPrompt';
  overlay.className = 'pwa-reward-overlay';
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePwaRewardPrompt({ dismiss: true });
  });
  document.body.appendChild(overlay);
  return overlay;
}

function renderPwaRewardPrompt() {
  const isZh = isChineseLanguage(appState.language);
  const overlay = ensurePwaRewardPrompt();
  overlay.innerHTML = `
    <div class="pwa-reward-card" role="dialog" aria-modal="true" aria-labelledby="pwaRewardTitle">
      <button type="button" class="pwa-reward-close" onclick="closePwaRewardPrompt({ dismiss: true })" aria-label="${isZh ? '关闭' : 'Close'}">×</button>
      <div class="pwa-reward-icon" aria-hidden="true"></div>
      <h2 id="pwaRewardTitle">${isZh ? '添加 RAI 到 App' : 'Add RAI as an app'}</h2>
      <p>${isZh ? `添加RAI到app获得积分${PWA_INSTALL_REWARD_POINTS}！` : `Add RAI as an app to earn ${PWA_INSTALL_REWARD_POINTS} points.`}</p>
      <div class="pwa-reward-actions">
        <button type="button" class="pwa-reward-primary" onclick="handlePwaRewardInstallAction()">${isZh ? '立即添加' : 'Add now'}</button>
        <button type="button" class="pwa-reward-secondary" onclick="claimAlreadyInstalledPwaReward()">${isZh ? '已添加，领取积分' : 'Already added, claim points'}</button>
        <button type="button" class="pwa-reward-secondary" onclick="closePwaRewardPrompt({ dismiss: true })">${isZh ? '稍后' : 'Later'}</button>
      </div>
    </div>
  `;
  return overlay;
}

function maybeShowPwaRewardPrompt({ force = false } = {}) {
  if (!appState.token || isChatFlowIframeMode) return;
  if (RAI_IS_TAURI_DESKTOP) {
    closePwaRewardPrompt();
    reportPwaInstallTask('tauri-desktop');
    return;
  }
  if (isPwaStandaloneMode()) {
    closePwaRewardPrompt();
    reportPwaInstallTask('standalone-open');
    return;
  }
  if (hasStoredPwaInstallHint()) {
    closePwaRewardPrompt();
    reportPwaInstallTask('stored-install-hint');
    return;
  }
  if (hasCompletedPwaInstallTask()) {
    closePwaRewardPrompt();
    return;
  }
  if (pwaRewardPromptDismissedThisSession && !force) return;
  const overlay = renderPwaRewardPrompt();
  requestAnimationFrame(() => overlay.classList.add('active'));
}

async function handlePwaRewardInstallAction() {
  await handlePwaInstallClick();
  if (!deferredPwaInstallPrompt && !isPwaStandaloneMode() && !hasCompletedPwaInstallTask()) {
    closePwaRewardPrompt({ dismiss: true });
    if (typeof openSettings === 'function') {
      openSettings();
      if (typeof switchSettingsSection === 'function') {
        switchSettingsSection('about');
      }
    }
  }
}

async function claimAlreadyInstalledPwaReward() {
  storePwaInstallHint();
  const result = await reportPwaInstallTask(PWA_INSTALL_CLAIM_SOURCE);
  if (!result?.success) {
    showToast(isChineseLanguage(appState.language)
      ? '领取失败，请稍后再试'
      : 'Claim failed. Please try again later');
  }
}

async function reportPwaInstallTask(source = 'unknown') {
  if (!appState.token || pwaInstallTaskReportPending || hasCompletedPwaInstallTask()) return null;
  pwaInstallTaskReportPending = true;
  try {
    const res = await fetch('/api/user/tasks/pwa-install/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({ source })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.success) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }

    applyUserMembershipData(data);
    closePwaRewardPrompt();
    updateUserAreaWithMembership();
    updateSettingsMembership();
    refreshMembershipPlansModal();

    if (data.awarded) {
      showToast(isChineseLanguage(appState.language)
        ? `已获得 ${data.pointsGained || PWA_INSTALL_REWARD_POINTS} 积分`
        : `You earned ${data.pointsGained || PWA_INSTALL_REWARD_POINTS} points`);
    }
    return data;
  } catch (error) {
    console.warn('桌面App任务上报失败:', error);
    return null;
  } finally {
    pwaInstallTaskReportPending = false;
  }
}

function detectPwaInstallContext() {
  const ua = window.navigator.userAgent || '';
  const platform = window.navigator.platform || '';
  const isIPadOsDesktopMode = platform === 'MacIntel' && Number(window.navigator.maxTouchPoints || 0) > 1;
  const isIOS = /iPad|iPhone|iPod/i.test(ua) || isIPadOsDesktopMode;
  const isAndroid = /Android/i.test(ua);
  const isMac = !isIOS && /Mac/i.test(platform);
  const isWindows = /Win/i.test(platform);
  const isEdge = /Edg\//i.test(ua) || /EdgA/i.test(ua) || /EdgiOS/i.test(ua);
  const isChrome = !isEdge && (/Chrome|Chromium|CriOS/i.test(ua)) && !/OPR|Opera|SamsungBrowser/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Opera|FxiOS/i.test(ua);
  const isFirefox = /Firefox|FxiOS/i.test(ua);
  const isDesktop = !isIOS && !isAndroid;

  return {
    browser: isEdge ? 'edge' : (isChrome ? 'chrome' : (isSafari ? 'safari' : (isFirefox ? 'firefox' : 'other'))),
    platform: isIOS ? 'ios' : (isAndroid ? 'android' : (isMac ? 'mac' : (isWindows ? 'windows' : 'desktop'))),
    isDesktop,
    canPrompt: Boolean(deferredPwaInstallPrompt),
    installed: isPwaStandaloneMode(),
    installedHint: hasStoredPwaInstallHint()
  };
}

function getPwaInstallCopy() {
  const context = detectPwaInstallContext();
  const isZh = isChineseLanguage(appState.language);
  if (RAI_IS_TAURI_DESKTOP) {
    return {
      status: isZh ? 'RAI 已在桌面客户端中打开。' : 'RAI is open in the desktop client.',
      actionLabel: isZh ? '桌面客户端' : 'Desktop client',
      disabled: true,
      steps: isZh
        ? ['可通过 macOS 菜单栏或 Windows 系统托盘图标再次打开 RAI。']
        : ['Use the macOS menu bar or Windows system tray icon to open RAI again.']
    };
  }
  const browserName = {
    chrome: 'Chrome',
    edge: 'Edge',
    safari: 'Safari',
    firefox: 'Firefox',
    other: isZh ? '当前浏览器' : 'This browser'
  }[context.browser] || (isZh ? '当前浏览器' : 'This browser');
  const actionLabel = i18nText('settings-install-action', isZh ? '安装 RAI' : 'Install RAI');

  if (context.installed) {
    storePwaInstallHint();
    return {
      status: i18nText('settings-install-installed', isZh ? 'RAI 已在应用模式中打开。' : 'RAI is already open in app mode.'),
      actionLabel: isZh ? '已安装' : 'Installed',
      disabled: true,
      steps: isZh
        ? ['可以从桌面、Dock、启动台或开始菜单再次打开 RAI。']
        : ['Open RAI again from your desktop, Dock, Launchpad, or Start menu.']
    };
  }

  if (context.installedHint) {
    return {
      status: isZh ? '此浏览器曾记录过安装；如已卸载，请按下方步骤重新添加。' : 'This browser has a previous install record; if removed, follow the steps below to add it again.',
      actionLabel: isZh ? '查看步骤' : 'View Steps',
      disabled: false,
      steps: isZh
        ? ['如果桌面、Dock、启动台或开始菜单中已有 RAI，可直接从那里打开。', '如果找不到，按当前浏览器菜单重新安装。']
        : ['If RAI is already on your desktop, Dock, Launchpad, or Start menu, open it there.', 'If it is missing, reinstall it from this browser menu.']
    };
  }

  if (context.canPrompt) {
    return {
      status: i18nText('settings-install-ready', isZh ? '当前浏览器可直接安装。' : 'This browser can install RAI directly.'),
      actionLabel,
      disabled: false,
      steps: isZh
        ? [`点击“${actionLabel}”。`, `在 ${browserName} 的安装窗口中确认。`, '安装后可从桌面、Dock、启动台或开始菜单打开 RAI。']
        : [`Select "${actionLabel}".`, `Confirm in the ${browserName} install window.`, 'Open RAI from your desktop, Dock, Launchpad, or Start menu.']
    };
  }

  if (context.platform === 'ios') {
    const needsSafari = context.browser !== 'safari';
    return {
      status: i18nText('settings-install-manual', isZh ? '当前浏览器需要使用浏览器菜单添加。' : 'Use this browser menu to add RAI manually.'),
      actionLabel: isZh ? '查看步骤' : 'View Steps',
      disabled: false,
      steps: isZh
        ? [
          needsSafari ? '先用 Safari 打开当前 RAI 网页。' : '点击 Safari 底部或顶部的分享按钮。',
          needsSafari ? '点击 Safari 的分享按钮。' : '选择“添加到主屏幕”。',
          needsSafari ? '选择“添加到主屏幕”，再点击“添加”。' : '点击“添加”，RAI 会出现在主屏幕。'
        ]
        : [
          needsSafari ? 'Open this RAI page in Safari first.' : 'Tap the Share button in Safari.',
          needsSafari ? 'Tap the Share button in Safari.' : 'Choose "Add to Home Screen".',
          needsSafari ? 'Choose "Add to Home Screen", then tap "Add".' : 'Tap "Add"; RAI will appear on the Home Screen.'
        ]
    };
  }

  if (context.browser === 'safari' && context.platform === 'mac') {
    return {
      status: i18nText('settings-install-manual', isZh ? '当前浏览器需要使用浏览器菜单添加。' : 'Use this browser menu to add RAI manually.'),
      actionLabel: isZh ? '查看步骤' : 'View Steps',
      disabled: false,
      steps: isZh
        ? ['打开 Safari 菜单栏的“文件”。', '选择“添加到 Dock”。', '确认名称为 RAI 后点击“添加”。']
        : ['Open Safari\'s File menu.', 'Choose "Add to Dock".', 'Confirm the name RAI, then select "Add".']
    };
  }

  if ((context.browser === 'chrome' || context.browser === 'edge') && context.isDesktop) {
    const menuLabel = context.browser === 'edge'
      ? (isZh ? '应用' : 'Apps')
      : (isZh ? '保存并分享' : 'Save and share');
    return {
      status: i18nText('settings-install-manual', isZh ? '当前浏览器需要使用浏览器菜单添加。' : 'Use this browser menu to add RAI manually.'),
      actionLabel: isZh ? '查看步骤' : 'View Steps',
      disabled: false,
      steps: isZh
        ? [`打开 ${browserName} 右上角菜单。`, `进入“${menuLabel}”。`, '选择“将此网站作为应用安装”或“安装此页面为应用”。']
        : [`Open the ${browserName} menu in the top-right corner.`, `Go to "${menuLabel}".`, 'Choose "Install this site as an app" or "Install page as app".']
    };
  }

  if (context.platform === 'android' && (context.browser === 'chrome' || context.browser === 'edge')) {
    return {
      status: i18nText('settings-install-manual', isZh ? '当前浏览器需要使用浏览器菜单添加。' : 'Use this browser menu to add RAI manually.'),
      actionLabel: isZh ? '查看步骤' : 'View Steps',
      disabled: false,
      steps: isZh
        ? [`打开 ${browserName} 右上角菜单。`, '选择“安装应用”或“添加到主屏幕”。', '确认后从主屏幕打开 RAI。']
        : [`Open the ${browserName} menu.`, 'Choose "Install app" or "Add to Home screen".', 'Confirm, then open RAI from the Home screen.']
    };
  }

  return {
    status: i18nText('settings-install-unavailable', isZh ? '当前环境暂不支持安装，请使用 Chrome、Edge 或 Safari 打开。' : 'Install is not available here. Open RAI in Chrome, Edge, or Safari.'),
    actionLabel: isZh ? '不可用' : 'Unavailable',
    disabled: true,
    steps: isZh
      ? ['在 Windows 或 macOS 上使用 Chrome / Edge / Safari 打开 RAI。', '在移动设备上优先使用 Safari 或 Chrome。']
      : ['Open RAI in Chrome, Edge, or Safari on Windows or macOS.', 'On mobile, use Safari or Chrome first.']
  };
}

function updatePwaInstallUI() {
  const status = document.getElementById('pwaInstallStatus');
  const button = document.getElementById('pwaInstallBtn');
  const steps = document.getElementById('pwaInstallSteps');
  if (!status || !button || !steps) return;

  const copy = getPwaInstallCopy();
  status.textContent = copy.status;
  button.textContent = copy.actionLabel;
  button.disabled = !!copy.disabled;
  steps.innerHTML = '';
  copy.steps.forEach((step) => {
    const item = document.createElement('li');
    item.textContent = step;
    steps.appendChild(item);
  });
}

async function handlePwaInstallClick() {
  if (isPwaStandaloneMode()) {
    showToast(i18nText('settings-install-opened', isChineseLanguage(appState.language) ? 'RAI 已经以应用模式打开' : 'RAI is already open in app mode'));
    await reportPwaInstallTask('standalone-click');
    updatePwaInstallUI();
    return;
  }

  if (!deferredPwaInstallPrompt) {
    showToast(i18nText('settings-install-see-steps', isChineseLanguage(appState.language) ? '请按下方步骤添加到桌面' : 'Follow the steps below to add RAI to your desktop'));
    updatePwaInstallUI();
    return;
  }

  const promptEvent = deferredPwaInstallPrompt;
  deferredPwaInstallPrompt = null;

  try {
    promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    const accepted = choice?.outcome === 'accepted';
    if (accepted) {
      storePwaInstallHint();
      await reportPwaInstallTask('browser-install-prompt');
    }
    showToast(accepted
      ? i18nText('settings-install-accepted', isChineseLanguage(appState.language) ? '安装已开始' : 'Install started')
      : i18nText('settings-install-dismissed', isChineseLanguage(appState.language) ? '已取消安装' : 'Install canceled'));
  } catch (error) {
    console.warn('PWA 安装提示失败:', error);
    showToast(i18nText('settings-install-see-steps', isChineseLanguage(appState.language) ? '请按下方步骤添加到桌面' : 'Follow the steps below to add RAI to your desktop'));
  } finally {
    updatePwaInstallUI();
  }
}

function initPwaInstallSupport() {
  if (pwaInstallSupportInitialized || isChatFlowIframeMode) return;
  pwaInstallSupportInitialized = true;
  if (RAI_IS_TAURI_DESKTOP) {
    updatePwaInstallUI();
    maybeShowPwaRewardPrompt();
    return;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPwaInstallPrompt = event;
    updatePwaInstallUI();
  });

  window.addEventListener('appinstalled', () => {
    deferredPwaInstallPrompt = null;
    storePwaInstallHint();
    reportPwaInstallTask('appinstalled');
    showToast(i18nText('settings-install-accepted', isChineseLanguage(appState.language) ? '安装已开始' : 'Install started'));
    updatePwaInstallUI();
  });

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then((registration) => {
          if (typeof registration.update === 'function') {
            registration.update().catch(() => null);
          }
        })
        .catch((error) => console.warn('Service Worker 注册失败:', error));
    });
  }

  updatePwaInstallUI();
}

const feedbackModalState = {
  message: null,
  rating: null,
  isSubmitting: false
};

const MODELS = {
  "auto": {
    name: "最佳 Auto",
    displayName: { "zh-CN": "最佳", "en": "Auto" },
    provider: "auto",
    supportsThinking: true
  },
  'deepseek-v3': {
    name: 'DeepSeek V4',
    provider: 'deepseek',
    supportsThinking: true,
    contextWindow: 1000000
  },
  'deepseek-v3.2-speciale': {
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek_v3_2_speciale',
    supportsThinking: true,
    thinkingOnly: true,  // 只支持思考模式
    maxTokens: 128000,   // 128K 上下文
    expiresAt: '2025-12-15T23:59:00+08:00'  // 截止时间
  },
  // Kimi K2.5 - 月之暗面高性能模型
  'kimi-k2.5': {
    name: 'Kimi',
    provider: 'siliconflow',
    supportsThinking: true,
    supportsVision: true,
    supportsTools: true,
    supportsPrefix: true,
    contextWindow: 256000
  },
  // 兼容旧配置：kimi-k2 自动视作 kimi-k2.5
  'kimi-k2': {
    name: 'Kimi',
    provider: 'siliconflow',
    supportsThinking: true
  },
  // Qwen2.5-7B 免费模型
  'qwen2.5-7b': {
    name: 'Qwen',
    provider: 'siliconflow',
    supportsThinking: false,
    isFree: true  // 标记为免费模型
  },
  // 兼容旧ID
  'qwen3-8b': {
    name: 'Qwen',
    provider: 'siliconflow',
    supportsThinking: false,
    isFree: true
  },
  'chatgpt-gpt-oss-120b': {
    name: 'ChatGPT',
    provider: 'openrouter',
    supportsThinking: true,
    supportsReasoningProfile: true,
    isFree: true
  },
  'grok-4.2': {
    name: 'Grok 4.2',
    provider: 'newapi',
    supportsThinking: true,
    supportsReasoningProfile: false,
    isFree: true
  },
  'gpt-5.5': {
    name: 'GPT-5.5',
    provider: 'newapi',
    supportsThinking: true,
    supportsReasoningProfile: true
  },
  'claude-haiku': {
    name: 'Claude 3 Haiku',
    provider: 'openrouter',
    supportsThinking: false,
    supportsVision: true
  },
  'anthropic/claude-sonnet-4.6': {
    name: 'Claude Sonnet 4.6',
    provider: 'openrouter',
    supportsThinking: false,
    supportsVision: true
  },
  'anthropic/claude-3-haiku': {
    name: 'Claude 3 Haiku',
    provider: 'openrouter',
    supportsThinking: false,
    supportsVision: true
  },
  'gemma': {
    name: 'Gemma',
    provider: 'google_gemini',
    supportsThinking: true,
    supportsReasoningProfile: false,
    isFree: true,
    supportsVision: true,
    contextWindow: 256000
  },
  'poe-claude': {
    name: 'Claude (Poe)',
    provider: 'poe',
    supportsThinking: true
  },
  'poe-gpt': {
    name: 'ChatGPT (Poe)',
    provider: 'poe',
    supportsThinking: true
  },
  'poe-grok': {
    name: 'Grok (Poe)',
    provider: 'poe',
    supportsThinking: true
  },
  'poe-gemini': {
    name: 'Gemini (Poe)',
    provider: 'poe',
    supportsThinking: true
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

const LEGACY_MODEL_ALIASES = {
  'qwen3-vl': 'kimi-k2.5',
  'qwen3-8b': 'qwen2.5-7b',
  'qwen-flash': 'qwen2.5-7b',
  'qwen-plus': 'qwen2.5-7b',
  'qwen-max': 'qwen2.5-7b',
  'deepseek-chat': 'deepseek-v3',
  'deepseek-reasoner': 'deepseek-v3',
  'deepseek-v4-flash': 'deepseek-v3',
  'openai/gpt-oss-120b:free': 'chatgpt-gpt-oss-120b',
  'claude-haiku': 'anthropic/claude-3-haiku',
  'anthropic/claude-3-haiku:beta': 'anthropic/claude-3-haiku',
  'gemma-4-31b-it': 'gemma',
  'google/gemma-4-31b-it:free': 'gemma'
};

const HIDDEN_MODEL_PREFIXES = ['poe-'];
const ALWAYS_VISIBLE_MODEL_IDS = ['auto'];
const modelVisibilityState = {
  loaded: false,
  disabled: new Set()
};

function isHiddenModelId(modelId) {
  const normalized = String(modelId || '').trim().toLowerCase();
  if (!normalized) return false;
  return HIDDEN_MODEL_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function normalizeSelectedModelId(modelId) {
  const raw = String(modelId || '').trim();
  const normalized = LEGACY_MODEL_ALIASES[raw] || raw;
  if (String(normalized).startsWith('x-ai/grok-4.20')) return 'grok-4.2';
  if (!normalized) return normalized;
  return isHiddenModelId(normalized) ? 'auto' : normalized;
}

function isModelDisabledByAdmin(modelId) {
  const normalized = normalizeSelectedModelId(modelId);
  if (!normalized || ALWAYS_VISIBLE_MODEL_IDS.includes(normalized)) return false;
  return modelVisibilityState.disabled.has(normalized);
}

function ensureVisibleSelectedModels() {
  if (isModelDisabledByAdmin(appState.selectedModel)) {
    appState.selectedModel = 'auto';
    updateSelectedModelText('auto');
    updateModelControls();
  }
  if (typeof chatFlowState !== 'undefined' && chatFlowState && isModelDisabledByAdmin(chatFlowState.selectedModel)) {
    chatFlowState.selectedModel = 'auto';
    updateChatFlowControlStates();
  }
}

function applyModelVisibilityToDom() {
  document.querySelectorAll('[data-model]').forEach((el) => {
    const modelId = el.getAttribute('data-model');
    const hidden = isModelDisabledByAdmin(modelId);
    el.classList.toggle('admin-model-hidden', hidden);
    if (hidden) {
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.removeAttribute('aria-hidden');
    }
  });

  document.querySelectorAll('#regenerateModelSelect option').forEach((option) => {
    option.hidden = isModelDisabledByAdmin(option.value);
  });

  ensureVisibleSelectedModels();
  updateMenuSelection();
}

async function fetchModelAvailability() {
  try {
    const res = await fetch('/api/model-availability');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    modelVisibilityState.disabled = new Set((data.disabledModels || []).map(normalizeSelectedModelId).filter(Boolean));
    modelVisibilityState.loaded = true;
    applyModelVisibilityToDom();
  } catch (error) {
    console.warn(' 获取模型开关失败:', error.message || error);
  }
}

function isPoeModelSelected(modelId = appState.selectedModel) {
  const normalized = normalizeSelectedModelId(modelId);
  return normalized.startsWith('poe-');
}

function isFreeMembershipUser() {
  return String(userMembershipState?.membership || 'free').toLowerCase() === 'free';
}

function isMaxMembershipUser() {
  return String(userMembershipState?.membership || 'free').toLowerCase() === 'max';
}

const TITLE_MARKER_REGEX = /\[TITLE\]([\s\S]{1,40}?)\[\/TITLE\]\s*$/i;
const LEGACY_TITLE_MARKER_REGEX = /<{2,3}\s*([^<>\n]{1,40}?)\s*>{2,3}\s*$/;

function extractTrailingTitleMarker(text = '') {
  const source = String(text || '').trimEnd();
  if (!source) {
    return { title: '', cleanContent: '' };
  }

  const titleMatch = source.match(TITLE_MARKER_REGEX);
  if (titleMatch) {
    const title = String(titleMatch[1] || '').replace(/\s+/g, ' ').trim();
    return {
      title,
      cleanContent: source.replace(TITLE_MARKER_REGEX, '').trim()
    };
  }

  const legacyMatch = source.match(LEGACY_TITLE_MARKER_REGEX);
  if (legacyMatch) {
    const title = String(legacyMatch[1] || '').replace(/\s+/g, ' ').trim();
    return {
      title,
      cleanContent: source.replace(LEGACY_TITLE_MARKER_REGEX, '').trim()
    };
  }

  return { title: '', cleanContent: source.trim() };
}

function stripTrailingTitleMarker(text = '') {
  return extractTrailingTitleMarker(text).cleanContent;
}

function isDefaultConversationTitle(title = '') {
  const normalized = String(title || '').trim().toLowerCase();
  return !normalized || normalized === '新对话' || normalized === 'new chat' || normalized === 'untitled';
}

function getSessionDisplayTitle(session = {}) {
  const rawTitle = String(session?.title || '').trim();
  if (!isDefaultConversationTitle(rawTitle)) {
    return rawTitle;
  }

  const markerSource = session?.last_assistant_message || session?.last_message || '';
  const markerTitle = extractTrailingTitleMarker(markerSource).title;
  return markerTitle || rawTitle || (isChineseLanguage(appState.language) ? '新对话' : 'New Chat');
}

function isFreePoeMode(modelId = appState.selectedModel) {
  return isPoeModelSelected(modelId) && isFreeMembershipUser();
}

function isMembershipLockedModel(modelId) {
  const normalized = normalizeSelectedModelId(modelId);
  const isMaxOnlyModel = normalized === 'anthropic/claude-sonnet-4.6'
    || normalized === 'anthropic/claude-3-haiku';
  return isMaxOnlyModel && !isMaxMembershipUser();
}

function normalizeReasoningProfile(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'medium' || v === 'high' || v === 'mixed') return v;
  return 'low';
}

const REASONING_PROFILE_ORDER = ['low', 'medium', 'high', 'mixed'];

function reasoningProfileToIndex(profile) {
  const normalized = normalizeReasoningProfile(profile);
  const idx = REASONING_PROFILE_ORDER.indexOf(normalized);
  return idx >= 0 ? idx : 0;
}

function reasoningIndexToProfile(index) {
  const num = Number(index);
  if (!Number.isFinite(num)) return 'low';
  const clamped = Math.max(0, Math.min(3, Math.round(num)));
  return REASONING_PROFILE_ORDER[clamped] || 'low';
}

function updateReasoningProfileSliderVisual(sliderEl) {
  if (!sliderEl) return;
  const min = Number(sliderEl.min || 0);
  const max = Number(sliderEl.max || 3);
  const current = Number(sliderEl.value || 0);
  const range = max - min || 1;
  const progress = ((current - min) / range) * 100;
  sliderEl.style.setProperty('--slider-progress', `${progress}%`);
}

function setReasoningProfileFromSlider(indexValue) {
  const profile = reasoningIndexToProfile(indexValue);
  setReasoningProfile(profile);
}

function setReasoningProfile(profile) {
  appState.reasoningProfile = normalizeReasoningProfile(profile);
  updateReasoningProfileControl();
}

function updateReasoningProfileControl() {
  const normalized = normalizeReasoningProfile(appState.reasoningProfile);

  const select = document.getElementById('reasoningProfileSelect');
  if (select && select.value !== normalized) {
    select.value = normalized;
  }

  const slider = document.getElementById('reasoningProfileSlider');
  if (slider) {
    const targetIndex = String(reasoningProfileToIndex(normalized));
    if (slider.value !== targetIndex) {
      slider.value = targetIndex;
    }
    updateReasoningProfileSliderVisual(slider);
  }
}

function updatePoeQuotaHint() {
  const hintEl = document.getElementById('poeQuotaHint');
  if (!hintEl) return;

  const isPoe = isPoeModelSelected();
  if (!isPoe) {
    hintEl.style.display = 'none';
    hintEl.textContent = '';
    return;
  }

  const isFree = isFreeMembershipUser();
  const lang = appState.language;

  if (isFree) {
    const remaining = Number.isFinite(Number(userMembershipState.poeRemaining))
      ? Number(userMembershipState.poeRemaining)
      : 0;
    const limit = Number.isFinite(Number(userMembershipState.poeDailyLimit))
      ? Number(userMembershipState.poeDailyLimit)
      : 3;
    hintEl.textContent = isChineseLanguage(lang)
      ? `Poe 今日剩余 ${remaining}/${limit} 次（free 强制关闭推理）`
      : `Poe remaining today: ${remaining}/${limit} (thinking is disabled for free)`;
    hintEl.style.display = 'block';
    return;
  }

  hintEl.textContent = isChineseLanguage(lang)
    ? 'Poe 模型已启用，可调推理强度'
    : 'Poe enabled, reasoning profile is available';
  hintEl.style.display = 'block';
}

function applyFreePoeThinkingPolicy() {
  if (isFreePoeMode()) {
    appState.thinkingMode = false;
  }
}

function applyQuotaInfoEvent(payload = {}) {
  if (payload.provider === 'newapi_gpt55') {
    const limit = Number(payload.gpt55Limit ?? userMembershipState.gpt55DailyLimit ?? 10);
    const used = Number(payload.gpt55Used ?? userMembershipState.gpt55UsedToday ?? 0);
    const remaining = Number(payload.gpt55Remaining ?? Math.max(0, limit - used));

    userMembershipState.gpt55DailyLimit = Number.isFinite(limit) ? limit : 10;
    userMembershipState.gpt55UsedToday = Number.isFinite(used) ? used : 0;
    userMembershipState.gpt55Remaining = Number.isFinite(remaining) ? remaining : 0;
    userMembershipState.gpt55ResetAt = payload.resetAt || userMembershipState.gpt55ResetAt || null;
    return;
  }

  if (payload.provider !== 'poe') return;

  const limit = Number(payload.poeLimit ?? userMembershipState.poeDailyLimit ?? 3);
  const used = Number(payload.poeUsed ?? userMembershipState.poeUsedToday ?? 0);
  const remaining = Number(payload.poeRemaining ?? Math.max(0, limit - used));

  userMembershipState.poeDailyLimit = Number.isFinite(limit) ? limit : 3;
  userMembershipState.poeUsedToday = Number.isFinite(used) ? used : 0;
  userMembershipState.poeRemaining = Number.isFinite(remaining) ? remaining : 0;
  userMembershipState.poeResetAt = payload.resetAt || userMembershipState.poeResetAt || null;

  updatePoeQuotaHint();
}

function handlePointsInfoEvent(payload = {}) {
  const message = payload.message || (isChineseLanguage(appState.language)
    ? '点数不足，请完成任务或签到增加积分'
    : 'Not enough points. Complete tasks or check in to earn more points.');
  showToast(message);
  if (typeof addProcessTraceItem === 'function') {
    addProcessTraceItem('info', message);
  }
  fetchUserMembership().catch(() => null);
}

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

function getShortUserTimeHint() {
  const ctx = getUserTimeContext();
  return `${ctx.datetime.replace(/\s+[A-Za-z]+/, '')}`;
}

function appendUserTimeHintForPrompt(content) {
  const text = String(content || '');
  const hint = isChineseLanguage(appState.language)
    ? `当前时间：${getShortUserTimeHint()}。仅作背景，不要把回答中心放在时间上。`
    : `Current time: ${getShortUserTimeHint()}. Background only; do not center the answer on time.`;
  return `${text}\n\n[${hint}]`;
}

// 动态生成系统提示词（核心原则；每条用户问题末尾另附短时间）
function buildSystemPrompt() {
  return `# 角色：
你是RAI 专业助理拥有人类千年来的丰富阅历
由 Rick 开发，维护 Rick studio 正当权益。
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
每次用户问题末尾会附带简短当前时间。它只作为背景参考；除非用户询问时间、日程或时效信息，不要把回答中心放到时间上。

### 工具列表
你有网络搜索能力。当用户询问需要实时信息的问题时，请主动调用 web_search 工具获取最新数据，然后基于搜索结果回答用户。
在合适的时候，使用图片增强回复。需要使用 Markdown 语法 ![描述](图片链接) 网络搜索时，[搜索相关图片]部分可能提供图片 URL，在有助于说明主题时使用它们。只使用搜索结果中的有效链接，绝不编造图片地址。
### 询问用户工具
当用户需求不明确、需要用户选择方向、范围、语言、风格或下一步时，可以输出一个独立的询问用户工具代码块，界面会渲染成可点击选项和自定义输入框。一次可以问多个问题，问题数量不设上限。
单问题格式：
\`\`\`rai_ask_user
{"question":"你想先做哪一项？","options":["选项一","选项二","选项三"],"placeholder":"输入其他想法，按 Enter 记录"}
\`\`\`
多问题格式：
\`\`\`rai_ask_user
{"questions":[{"question":"你想先做哪一项？","options":["整理资料","写代码","做设计"],"placeholder":"输入其他任务"},{"question":"你希望输出多详细？","options":["简短","标准","详细"],"placeholder":"输入你的要求"}]}
\`\`\`
规则：
- questions 数组可以包含任意数量的问题；每个问题的 options 也可以有多个，必须短、明确。
- 每个问题最后一个入口由 placeholder 表示，是用户自定义输入框；用户可先选择或输入全部问题，界面底部有统一“发送选择”按钮。
- 不要在用户只选了第一个选项后继续回答；必须等用户完成全部问题并点击发送。
- 只在确实需要用户决策时使用，不要为了普通回复滥用。
- 工具代码块必须独立出现，不要嵌入表格、列表或引用块。
- 第一行必须精确使用 \`\`\`rai_ask_user；不要用 \`\`\`json、无语言代码块或普通文本 JSON 代替。

你可以使用 Mermaid 语法生成各类图表，用户界面会自动渲染。使用 \`\`\`mermaid 代码块。
Mermaid 必须以独立一行的 \`\`\`mermaid 开始，并以独立一行的 \`\`\` 结束；不要使用两个反引号闭合，也不要把正文接在结束符同一行。
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
统计图规范:
- 柱状图和折线趋势图必须使用 \`xychart-beta\`，不要输出旧式 \`bar\` 图表、JSON、HTML 或 Markdown 表格冒充图表。
- \`title\` 和 \`y-axis\` 文本必须使用英文双引号，例如 \`title "月度业务量"\`、\`y-axis "数量" 0 --> 250\`。
- \`x-axis\` 分类标签使用数组，中文标签也加英文双引号，例如 \`x-axis ["一月", "二月", "三月"]\`。
- 占比图使用 \`pie\`，不要用 xychart-beta 模拟饼图。
最小统计图示例:
\`\`\`mermaid
xychart-beta
  title "月度业务量"
  x-axis ["一月", "二月", "三月"]
  y-axis "数量" 0 --> 250
  bar [120, 180, 150]
\`\`\`
可以使用图片，Mermaid中适合类型的图表等增强说明效果。

---

## 格式要求

1. 结构规范善用Markdown、Mermaid，让内容层次分明、一目了然。
2. 回答按照顺序回答除非用户要求，否则不要插叙或者乱序回答。

---

# 对话标题：每次回复结束后，生成一个3-9字的对话标题，语言与用户保持一致。输出严格遵循格式：[TITLE]标题[/TITLE]
`;
}

function buildEffectiveSystemPrompt(customPrompt = appState.systemPrompt) {
  const trimmedCustomPrompt = String(customPrompt || '').trim();
  const promptBase = buildSystemPrompt();
  return trimmedCustomPrompt
    ? `${promptBase}\n\n以下是用户个人偏好，请参考：\n${trimmedCustomPrompt}`
    : promptBase;
}

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
    'sidebar-flows': 'ChatFlow',
    'new-flow': '新建 ChatFlow',
    'sidebar-sessions': '对话',
    'settings': '设置',
    'logout': '登出',
    'back-to-chat': '返回对话',
    'welcome-title': '询问任何问题:D',
    'welcome-subtitle': '可以帮您写作,财务分析,翻译与构思\n您专属RAI助理',
    'action-write': '写作',
    'action-finance': '财务',
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
    'system-theme': '跟随系统',
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
    'preferences-title': '您有什么偏好？',
    'preferences-desc': '设置AI的角色和行为',
    'preferences-placeholder': '例如: 我希望获得简短回复...',
    'advanced-options': '高级选项',
    'settings-nav-language': '语言 / English',
    'settings-nav-subscription': '订阅',
    'settings-nav-account': '账号',
    'settings-nav-appearance': '外观',
    'settings-nav-custom': '自定义',
    'settings-nav-advanced': '高级',
    'settings-nav-desktop': '桌面端',
    'settings-nav-about': '关于',
    'settings-mobile-section-rai': '我的 RAI',
    'settings-mobile-section-account': '账户',
    'settings-mobile-section-system': '系统',
    'settings-subscription-desc': '签到、任务、点数兑换会员和会员状态',
    'settings-account-desc': '用户名、邮箱、密码和第三方绑定状态',
    'settings-advanced-desc': '生成参数控制',
    'settings-desktop-title': '桌面端',
    'settings-desktop-desc': '控制 macOS 菜单栏或 Windows 系统托盘中的 RAI 窗口。',
    'settings-desktop-status': '桌面客户端已连接线上 RAI 服务',
    'settings-desktop-open-quick': '打开快速小窗',
    'settings-desktop-open-main': '打开完整窗口',
    'settings-desktop-hide': '隐藏窗口',
    'settings-about-title': '关于RAI',
    'settings-about-desc': '您的专属 AI 助理，由 Rick 创作。欢迎随时找我聊天、讨论。',
    'settings-about-github-label': 'GitHub',
    'settings-about-author-label': '作者 Rick',
    'settings-update-timeline-title': '更新记录',
    'settings-update-timeline-source': '来源：本机历史版本目录、版本记录、历史 release manifest、GitHub README。',
    'settings-timeline-details-open': '查看完整更新',
    'settings-timeline-details-close': '收起完整更新',
    'settings-replay-onboarding': '重新观看欢迎引导',
    'settings-install-title': '添加到桌面',
    'settings-install-desc': '在 Windows、macOS、iPhone 和 iPad 上把 RAI 作为独立应用打开。',
    'settings-install-action': '安装 RAI',
    'settings-install-download-macos': '下载 macOS 桌面版',
    'settings-install-ready': '当前浏览器可直接安装。',
    'settings-install-installed': 'RAI 已在应用模式中打开。',
    'settings-install-manual': '当前浏览器需要使用浏览器菜单添加。',
    'settings-install-unavailable': '当前环境暂不支持安装，请使用 Chrome、Edge 或 Safari 打开。',
    'settings-install-opened': 'RAI 已经以应用模式打开',
    'settings-install-accepted': '安装已开始',
    'settings-install-dismissed': '已取消安装',
    'settings-install-see-steps': '请按下方步骤添加到桌面',
    'app-update-title': 'RAI 已更新',
    'app-update-desc': '当前网页仍是旧版本，刷新后即可使用最新版。',
    'app-update-button': '刷新更新',
    'onb-hero-sub': '由 Rick 打造的智能 AI 助手',
    'onb-welcome-title': '欢迎来到 RAI',
    'onb-welcome-desc': '多模型、深度研究、联网搜索，一切尽在指尖。',
    'onb-features-title': '强大的 AI 能力',
    'onb-feat-models-title': '多模型协作',
    'onb-feat-models': '多模型自由切换（DeepSeek / Kimi / GPT / Claude / Grok / Gemma）',
    'onb-feat-research-title': '研究模式',
    'onb-feat-research': '快速 / 深度研究模式，支持多模型互评综合回答',
    'onb-feat-search-title': '实时信息',
    'onb-feat-search': '联网搜索 + 实时财经数据',
    'onb-feat-files-title': '文件理解',
    'onb-feat-files': '图片 / 视频 / 文件上传分析',
    'onb-feat-markdown-title': '专业输出',
    'onb-feat-markdown': 'Markdown / 代码高亮 / Mermaid 图表 / 数学公式',
    'onb-usage-title': '开始使用',
    'onb-usage-input-title': '输入框',
    'onb-usage-input-desc': '在底部输入问题，Enter 发送，Shift+Enter 换行。可拖拽上传文件。',
    'onb-usage-model-title': '模型切换',
    'onb-usage-model-desc': '点击顶部模型选择器，可切换智能模型、极速模式、专家模式或全部模型。',
    'onb-usage-sidebar-title': '侧边栏',
    'onb-usage-sidebar-desc': '左侧边栏可管理对话历史、搜索对话、切换主题和语言、进入设置。',
    'onb-skip': '跳过',
    'onb-next': '下一步',
    'onb-start': '开始使用',
    'sidebar-flows-beta': '测试',
    'avatar-settings-title': '头像',
    'avatar-settings-desc': '上传自定义头像，用于侧边栏、设置页和聊天消息',
    'change-avatar': '更换头像',
    'avatar-uploading': '头像上传中...',
    'avatar-upload-success': '头像已更新',
    'avatar-upload-failed': '头像上传失败',
    'account-binding-title': '账号绑定',
    'confirm-change': '确定',
    'account-settings-title': '账号信息',
    'settings-username-label': '用户名',
    'settings-username-desc': '修改侧边栏显示名称；留空时默认使用邮箱前缀',
    'settings-email-label': '邮箱',
    'settings-email-desc': '修改登录邮箱，保存后立即生效',
    'settings-email-placeholder': 'name@example.com',
    'password-settings-title': '修改密码',
    'password-settings-desc': '',
    'password-current-label': '当前密码',
    'password-new-label': '新密码',
    'password-confirm-label': '确认新密码',
    'password-current-placeholder': '输入当前密码',
    'password-new-placeholder': '至少6位字符',
    'password-confirm-placeholder': '再次输入新密码',
    'membership-status-title': '会员状态',
    'upgrade-points-link': '点数兑换会员',
    'remaining-points-label': '剩余点数',
    'created-at-prefix': '创建于',
    'checkin-bonus': '签到 +20 ',
    'checkin-done': '今日已签到 ✓',
    'checkin-success': '签到成功！获得 {points} 点数 ',
    'network-error': '网络错误',
    'cancel': '取消',
    'save-settings': '保存设置',
    'save-settings-pending': '保存中...',
    'settings-save-success': '设置已保存',
    'settings-save-success-profile': '账号信息和设置已保存',
    'settings-save-success-password': '密码和设置已保存',
    'settings-save-success-full': '账号信息、密码和设置已保存',
    'settings-save-partial': '部分内容已保存，但配置同步失败',
    'settings-save-failed': '保存失败，请重试',
    'invalid-email-error': '请输入有效的邮箱地址',
    'username-too-long-error': '用户名不能超过 80 个字符',
    'password-current-required-error': '修改密码时必须输入当前密码',
    'password-new-required-error': '请输入新密码',
    'password-confirm-required-error': '请再次输入新密码',
    'password-too-short-error': '新密码至少需要 6 位字符',
    'password-confirm-mismatch-error': '两次输入的新密码不一致',
    'password-same-as-current-error': '新密码不能与当前密码相同',
    // 模型选择相关
    'model-smart': '智能模型',
    'model-fast': '极速模型',
    'model-expert': '专家模型',
    'model-all': '全部模型',
    'select-model': '选择模型',
    // 引用功能
    'quote': '引用',
    'quote-user': '引用用户',
    'quote-ai': '引用AI',
    // 更多菜单
    'internet-search': '联网搜索',
    'reasoning-mode': '推理模式',
    'reasoning-profile': '推理时间',
    'reasoning-low': '短',
    'reasoning-medium': '中',
    'reasoning-high': '长',
    'reasoning-mixed': '自适应',
    'research-mode': '研究模式',
    'research-fast': '快速研究',
    'research-deep': '深度研究',
    'agent-mode': '深度研究',
    'add-attachment': '添加附件',
    'rpass-pending': 'rPass 登录待上线',
    'internetSearch': '联网搜索',
    'thinkingMode': '思考模式',
    'regenerateTitle': '重新生成回复',
    'selectModel': '选择模型',
    'smartMode': '智能模型',
    'fastMode': '极速模型',
    'expertMode': '专家模型',
    'regenerate': '重新生成'
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
    'sidebar-flows': 'ChatFlow',
    'new-flow': 'New ChatFlow',
    'sidebar-sessions': 'Conversations',
    'settings': 'Settings',
    'logout': 'Log out',
    'back-to-chat': 'Back to Chat',
    'welcome-title': 'How can I help you?',
    'welcome-subtitle': 'I can help you write, analyze finance, translate, and brainstorm\nYour personal RAI assistant',
    'action-write': 'Write',
    'action-finance': 'Finance',
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
    'system-theme': 'System',
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
    'preferences-title': 'Your Preferences',
    'preferences-desc': 'Set AI role and behavior',
    'preferences-placeholder': 'e.g., I prefer concise replies...',
    'advanced-options': 'Advanced Options',
    'settings-nav-language': 'Language / 中文',
    'settings-nav-subscription': 'Subscription',
    'settings-nav-account': 'Account',
    'settings-nav-appearance': 'Appearance',
    'settings-nav-custom': 'Custom',
    'settings-nav-advanced': 'Advanced',
    'settings-nav-desktop': 'Desktop',
    'settings-nav-about': 'About',
    'settings-mobile-section-rai': 'My RAI',
    'settings-mobile-section-account': 'Account',
    'settings-mobile-section-system': 'System',
    'settings-subscription-desc': 'Check-in, tasks, points redemption, and membership status',
    'settings-account-desc': 'Username, email, password, and third-party binding status',
    'settings-advanced-desc': 'Generation parameter controls',
    'settings-desktop-title': 'Desktop',
    'settings-desktop-desc': 'Control RAI windows from the macOS menu bar or Windows system tray.',
    'settings-desktop-status': 'The desktop client is connected to the live RAI service',
    'settings-desktop-open-quick': 'Open quick window',
    'settings-desktop-open-main': 'Open full window',
    'settings-desktop-hide': 'Hide windows',
    'settings-about-title': 'About RAI',
    'settings-about-desc': 'Your personal AI assistant by Rick. Feel free to chat or discuss ideas anytime.',
    'settings-about-github-label': 'GitHub',
    'settings-about-author-label': 'Author Rick',
    'settings-update-timeline-title': 'Update Records',
    'settings-update-timeline-source': 'Sources: local historical version folders, version records, historical release manifest, and GitHub README.',
    'settings-timeline-details-open': 'View full update',
    'settings-timeline-details-close': 'Collapse full update',
    'settings-replay-onboarding': 'Replay welcome guide',
    'settings-install-title': 'Add to Desktop',
    'settings-install-desc': 'Open RAI as a standalone app on Windows, macOS, iPhone, and iPad.',
    'settings-install-action': 'Install RAI',
    'settings-install-download-macos': 'Download macOS desktop app',
    'settings-install-ready': 'This browser can install RAI directly.',
    'settings-install-installed': 'RAI is already open in app mode.',
    'settings-install-manual': 'Use this browser menu to add RAI manually.',
    'settings-install-unavailable': 'Install is not available here. Open RAI in Chrome, Edge, or Safari.',
    'settings-install-opened': 'RAI is already open in app mode',
    'settings-install-accepted': 'Install started',
    'settings-install-dismissed': 'Install canceled',
    'settings-install-see-steps': 'Follow the steps below to add RAI to your desktop',
    'app-update-title': 'RAI has been updated',
    'app-update-desc': 'This page is still running an older version. Refresh to use the latest release.',
    'app-update-button': 'Refresh',
    'onb-hero-sub': 'Your intelligent AI assistant by Rick',
    'onb-welcome-title': 'Welcome to RAI',
    'onb-welcome-desc': 'Multi-model chat, deep research, and web search are ready when you are.',
    'onb-features-title': 'Powerful AI capability',
    'onb-feat-models-title': 'Model collaboration',
    'onb-feat-models': 'Switch freely across DeepSeek, Kimi, GPT, Claude, Grok, and Gemma',
    'onb-feat-research-title': 'Research mode',
    'onb-feat-research': 'Fast and Deep Research modes with multi-model review',
    'onb-feat-search-title': 'Live context',
    'onb-feat-search': 'Web search plus real-time finance data',
    'onb-feat-files-title': 'File understanding',
    'onb-feat-files': 'Analyze images, videos, and uploaded files',
    'onb-feat-markdown-title': 'Professional output',
    'onb-feat-markdown': 'Markdown, code highlighting, Mermaid charts, and math',
    'onb-usage-title': 'Start using RAI',
    'onb-usage-input-title': 'Composer',
    'onb-usage-input-desc': 'Type at the bottom, press Enter to send, Shift+Enter for a new line. Drag files in to upload.',
    'onb-usage-model-title': 'Model switcher',
    'onb-usage-model-desc': 'Use the top model picker for Smart, Fast, Expert, or all models.',
    'onb-usage-sidebar-title': 'Sidebar',
    'onb-usage-sidebar-desc': 'Manage chat history, search conversations, switch theme and language, and open settings.',
    'onb-skip': 'Skip',
    'onb-next': 'Next',
    'onb-start': 'Get started',
    'sidebar-flows-beta': 'Beta',
    'avatar-settings-title': 'Avatar',
    'avatar-settings-desc': 'Upload a custom avatar for the sidebar, settings, and chat messages.',
    'change-avatar': 'Change Avatar',
    'avatar-uploading': 'Uploading avatar...',
    'avatar-upload-success': 'Avatar updated',
    'avatar-upload-failed': 'Avatar upload failed',
    'account-binding-title': 'Account Binding',
    'confirm-change': 'Confirm',
    'account-settings-title': 'Account',
    'settings-username-label': 'Username',
    'settings-username-desc': 'Change the display name shown in the sidebar; if blank, the email prefix will be used.',
    'settings-email-label': 'Email',
    'settings-email-desc': 'Change the login email. It takes effect immediately after saving.',
    'settings-email-placeholder': 'name@example.com',
    'password-settings-title': 'Change Password',
    'password-settings-desc': '',
    'password-current-label': 'Current Password',
    'password-new-label': 'New Password',
    'password-confirm-label': 'Confirm New Password',
    'password-current-placeholder': 'Enter current password',
    'password-new-placeholder': 'At least 6 characters',
    'password-confirm-placeholder': 'Enter new password again',
    'membership-status-title': 'Membership Status',
    'upgrade-points-link': 'Redeem membership with points',
    'remaining-points-label': 'Remaining Points',
    'created-at-prefix': 'Created At',
    'checkin-bonus': 'Check in +20 ',
    'checkin-done': 'Checked in today ✓',
    'checkin-success': 'Check-in successful! +{points} ',
    'network-error': 'Network error',
    'cancel': 'Cancel',
    'save-settings': 'Save Settings',
    'save-settings-pending': 'Saving...',
    'settings-save-success': 'Settings saved',
    'settings-save-success-profile': 'Account and settings saved',
    'settings-save-success-password': 'Password and settings saved',
    'settings-save-success-full': 'Account, password, and settings saved',
    'settings-save-partial': 'Part of your changes were saved, but config sync failed',
    'settings-save-failed': 'Save failed, please try again',
    'invalid-email-error': 'Please enter a valid email address',
    'username-too-long-error': 'Username must be 80 characters or fewer',
    'password-current-required-error': 'Current password is required to change password',
    'password-new-required-error': 'Please enter a new password',
    'password-confirm-required-error': 'Please confirm the new password',
    'password-too-short-error': 'New password must be at least 6 characters',
    'password-confirm-mismatch-error': 'The new passwords do not match',
    'password-same-as-current-error': 'New password must be different from current password',
    // Model selection
    'model-smart': 'Smart Model',
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
    'reasoning-profile': 'Reasoning Profile',
    'reasoning-low': 'Low',
    'reasoning-medium': 'Medium',
    'reasoning-high': 'High',
    'reasoning-mixed': 'Adaptive',
    'research-mode': 'Research Mode',
    'research-fast': 'Fast Research',
    'research-deep': 'Deep Research',
    'agent-mode': 'Deep Research',
    'add-attachment': 'Add Attachment',
    'rpass-pending': 'rPass login is coming soon',
    'internetSearch': 'Web Search',
    'thinkingMode': 'Thinking Mode',
    'regenerateTitle': 'Regenerate Response',
    'selectModel': 'Select Model',
    'smartMode': 'Smart Model',
    'fastMode': 'Fast Mode',
    'expertMode': 'Expert Mode',
    'regenerate': 'Regenerate'
  }
};

const SIMPLIFIED_TO_TRADITIONAL_PHRASE_MAP = [
  ['设置', '設定'],
  ['关于', '關於'],
  ['时间线', '時間線'],
  ['更新记录', '更新記錄'],
  ['更新时间线', '更新時間線'],
  ['浅色模式', '淺色模式'],
  ['深色模式', '深色模式'],
  ['移动端', '移動端'],
  ['二级', '二級'],
  ['账号', '帳號'],
  ['订阅', '訂閱'],
  ['自定义', '自訂'],
  ['高级', '進階'],
  ['图标', '圖示'],
  ['侧边栏', '側邊欄'],
  ['本地', '本機'],
  ['服务器', '伺服器'],
  ['运维', '運維'],
  ['历史', '歷史'],
  ['版本', '版本'],
  ['完整更新', '完整更新'],
  ['创作', '創作'],
  ['欢迎', '歡迎'],
  ['聊天', '聊天'],
  ['讨论', '討論'],
  ['邮箱', '信箱'],
  ['作者', '作者'],
  ['来源', '來源'],
  ['头像', '頭像'],
  ['响应式', '響應式'],
  ['联网', '連網'],
  ['模型路由', '模型路由'],
  ['智能模型', '智慧模型'],
  ['运行期备用链', '執行期備援鏈'],
  ['逻辑', '邏輯'],
  ['补齐', '補齊'],
  ['跟随系统', '跟隨系統'],
  ['登出', '登出']
];

const SIMPLIFIED_TO_TRADITIONAL_CHAR_MAP = {
  '欢': '歡', '来': '來', '继': '繼', '续': '續', '创': '創', '账': '帳', '号': '號', '开': '開',
  '对': '對', '邮': '郵', '箱': '箱', '码': '碼', '选': '選', '还': '還', '没': '沒', '册': '冊',
  '录': '錄', '搜': '搜', '索': '索', '话': '話', '间': '間', '会': '會', '设': '設', '置': '置',
  '退': '退', '询': '詢', '问': '問', '题': '題', '写': '寫', '财': '財', '务': '務', '析': '析',
  '译': '譯', '构': '構', '属': '屬', '助': '助', '理': '理', '联': '聯', '网': '網', '推': '推',
  '预': '預', '算': '算', '控': '控', '制': '制', '长': '長', '输': '輸', '入': '入', '换': '換',
  '行': '行', '观': '觀', '择': '擇', '界': '界', '语': '語', '参': '參', '数': '數', '随': '隨',
  '机': '機', '性': '性', '核': '核', '采': '採', '样': '樣', '罚': '罰', '仅': '僅', '词': '詞',
  '简': '簡', '洁': '潔', '您': '您', '什': '什', '偏': '偏', '好': '好', '项': '項', '订': '訂',
  '阅': '閱', '关': '關', '于': '於', '态': '態', '点': '點', '兑': '兌', '员': '員', '状': '狀',
  '户': '戶', '绑': '綁', '态': '態', '统': '統', '专': '專', '化': '化', '级': '級', '线': '線',
  '传': '傳', '侧': '側', '栏': '欄', '聊': '聊', '天': '天', '显': '顯', '称': '稱', '时': '時',
  '认': '認', '为': '為', '过': '過', '键': '鍵', '后': '後', '即': '即', '效': '效', '留': '留',
  '则': '則', '当': '當', '前': '前', '确': '確', '认': '認', '再': '再', '获': '獲', '络': '絡',
  '误': '誤', '败': '敗', '请': '請', '试': '試', '部': '部', '分': '分', '内': '內', '容': '容',
  '同': '同', '步': '步', '失': '失', '败': '敗', '须': '須', '与': '與', '两': '兩', '致': '致',
  '模': '模', '型': '型', '极': '極', '证': '證', '资': '資', '讯': '訊', '复': '復', '应': '應',
  '页': '頁', '动': '動', '画': '畫', '适': '適', '配': '配', '发': '發', '布': '佈', '历': '歷',
  '繁': '繁', '体': '體', '浅': '淺', '图': '圖', '标': '標', '异': '異', '常': '常', '终': '終',
  '览': '覽', '导': '導', '径': '徑', '运': '運', '维': '維', '档': '檔', '额': '額', '层': '層',
  '级': '級', '护': '護', '备': '備', '份': '份', '启': '啟', '动': '動', '务': '務', '览': '覽',
  '讨': '討', '论': '論', '议': '議', '细': '細', '库': '庫', '赖': '賴', '据': '據', '驱': '驅',
  '环': '環', '离': '離', '错': '錯', '实': '實', '际': '際', '签': '簽', '读': '讀', '买': '買',
  '卖': '賣', '扩': '擴', '载': '載', '链': '鏈', '认': '認', '质': '質', '穷': '窮',
  '补': '補', '齐': '齊', '测': '測', '验': '驗', '连': '連', '辑': '輯', '邏': '邏'
};

function toTraditionalText(value) {
  let text = String(value || '');
  SIMPLIFIED_TO_TRADITIONAL_PHRASE_MAP.forEach(([simplified, traditional]) => {
    text = text.replaceAll(simplified, traditional);
  });
  return text.replace(/[\u4e00-\u9fff]/g, (char) => SIMPLIFIED_TO_TRADITIONAL_CHAR_MAP[char] || char);
}

i18n['zh-TW'] = Object.fromEntries(
  Object.entries(i18n['zh-CN']).map(([key, value]) => [key, toTraditionalText(value)])
);

Object.assign(i18n['zh-TW'], {
  'settings-nav-language': '語言 / English',
  'settings-about-title': '關於 RAI',
  'settings-about-desc': '您的專屬 AI 助理，由 Rick 創作。歡迎隨時找我聊天、討論。',
  'settings-about-github-label': 'GitHub',
  'settings-about-author-label': '作者 Rick',
  'logout': '登出',
  'system-theme': '跟隨系統',
  'settings-update-timeline-title': '更新記錄',
  'settings-update-timeline-source': '來源：本機歷史版本目錄、版本記錄、歷史 release manifest、GitHub README。',
  'settings-timeline-details-open': '查看完整更新',
  'settings-timeline-details-close': '收起完整更新',
  'settings-replay-onboarding': '重新觀看歡迎引導',
  'settings-install-download-macos': '下載 macOS 桌面版',
  'sidebar-flows-beta': '測試'
});

const RAI_UPDATE_TIMELINE = [
  {
    date: '2026-06-04',
    version: 'v0.10.9.16',
    zh: {
      summary: '修复透明矢量图标并加入桌面客户端下载入口。',
      details: [
        'RAI 图标不再绘制全画布黑色背景，圆角外区域保持透明。',
        'Web、PWA 和 Tauri 图标均由无文字土星矢量图重新生成。',
        '设置关于页的添加到桌面卡片新增 macOS 桌面版下载入口。',
        '桌面端设置状态行移除绿色圆点装饰，保持统一的设置页设计语言。'
      ]
    },
    en: {
      summary: 'Fixed the transparent vector icon and added a desktop app download.',
      details: [
        'The RAI icon no longer paints a full-canvas black background; the area outside the rounded icon stays transparent.',
        'Web, PWA, and Tauri icons were regenerated from the text-free Saturn vector mark.',
        'The About settings install card now includes a macOS desktop app download link.',
        'The desktop settings status row no longer shows the green dot decoration.'
      ]
    }
  },
  {
    date: '2026-06-02',
    version: 'v0.10.9.15',
    zh: {
      summary: '修复桌面小窗登录同步、会员状态和图标圆角。',
      details: [
        'macOS 菜单栏快速小窗会在打开和获得焦点时同步主窗口登录状态，不再出现主窗口已登录、小窗未登录。',
        '桌面端会员、积分、签到和任务状态会在获取成功后主动刷新设置页。',
        '设置页新增仅桌面客户端可见的“桌面端”入口，可打开快速小窗、完整窗口或隐藏窗口。',
        'RAI 桌面图标重新生成，保持无文字土星标识，并修正四角露白问题。'
      ]
    },
    en: {
      summary: 'Fixed desktop quick-window auth sync, membership state, and icon corners.',
      details: [
        'The macOS menu bar quick window now syncs login state when opened or focused.',
        'Desktop membership, points, check-in, and task state refresh the settings page immediately after loading.',
        'Settings now include a desktop-only section for opening the quick window, full window, or hiding windows.',
        'The RAI desktop icon was regenerated as a text-free Saturn mark with corrected rounded corners.'
      ]
    }
  },
  {
    date: '2026-06-02',
    version: 'v0.10.9.14',
    zh: {
      summary: '新增 Tauri v2 桌面客户端基础版。',
      details: [
        'macOS 菜单栏和 Windows 系统托盘加入 RAI 图标，可快速打开对话窗口或完整窗口。',
        '桌面客户端内置现有静态前端，业务 API 和用户数据统一连接线上 RAI 服务，不打包 Chromium。',
        '桌面客户端登录后会自动完成“把 RAI 放到桌面”任务上报，仍然只奖励一次。'
      ]
    },
    en: {
      summary: 'Added the first Tauri v2 desktop client.',
      details: [
        'RAI now has a macOS menu bar and Windows system tray icon for quick chat or the full window.',
        'The desktop client bundles the existing static frontend and connects business APIs to the live RAI service without bundling Chromium.',
        'After login, the desktop client reports the add-to-desktop task automatically and still only awards points once.'
      ]
    }
  },
  {
    date: '2026-06-01',
    version: 'v0.10.9.13',
    zh: {
      summary: '优化桌面 App 任务领取和任务列表样式。',
      details: [
        '已添加过 RAI 到桌面的用户可直接领取 300 积分，无需删除并重新安装。',
        '桌面 App 图标继续只保留土星图形，不在图标内写 RAI。',
        '任务列表外层去掉背景，只保留单条任务背景，统一设置页视觉语言。'
      ]
    },
    en: {
      summary: 'Refined desktop app task claiming and task list styling.',
      details: [
        'Users who already added RAI to desktop can claim the 300 points directly without reinstalling.',
        'The desktop app icon remains the Saturn-only mark without RAI text inside the icon.',
        'The task list wrapper no longer has its own background; each task item keeps the card background.'
      ]
    }
  },
  {
    date: '2026-05-31',
    version: 'v0.10.9.12',
    zh: {
      summary: '新增积分任务和桌面 App 奖励提示。',
      details: [
        '未完成桌面 App 任务的账号打开网页版时会提示添加 RAI 到 App 可获得 300 积分。',
        '订阅设置加入任务区：把 RAI 放到桌面 +300，邀请一位用户 +600。',
        '点数不足时提示通过任务或签到增加积分，并自动回退免费模型。',
        '研究模式讨论气泡改为左上角小圆角，其余三角大圆角。'
      ]
    },
    en: {
      summary: 'Added points tasks and desktop app reward prompts.',
      details: [
        'Accounts that have not completed the desktop app task now see a web prompt to add RAI as an app for 300 points.',
        'Subscription settings now include tasks: add RAI to desktop for +300 and invite one user for +600.',
        'When points run out, RAI prompts users to earn more through tasks or check-in and falls back to a free model.',
        'Research discussion bubbles now use a small top-left corner and larger remaining corners.'
      ]
    }
  },
  {
    date: '2026-05-31',
    version: 'v0.10.9.11',
    zh: {
      summary: '新增跨浏览器添加到桌面能力。',
      details: [
        '补齐 Web App Manifest、应用图标和 Service Worker，让 Chrome 与 Edge 能识别为可安装应用。',
        '关于页新增“添加到桌面”入口，Chrome / Edge 可直接触发浏览器安装弹窗。',
        'Safari、iPhone 和 iPad 会根据当前平台显示对应的手动添加步骤。',
        '已针对独立应用打开状态做检测，避免重复提示安装。'
      ]
    },
    en: {
      summary: 'Added cross-browser desktop install support.',
      details: [
        'Added the Web App Manifest, app icon, and Service Worker so Chrome and Edge can recognize RAI as installable.',
        'Added an Add to Desktop entry in About; Chrome and Edge can open the native browser install prompt.',
        'Safari, iPhone, and iPad now show platform-specific manual install steps.',
        'Installed app mode is detected to avoid repeated install prompts.'
      ]
    }
  },
  {
    date: '2026-05-28',
    version: 'v0.10.9.10',
    zh: {
      summary: '完善研究讨论气泡、thinking 展示与会员点数。',
      details: [
        'Pro 会员兑换点数改为 28 天签到可获得的点数，即 560 点。',
        '研究讨论完成后会保留 Gemma、Kimi K2.5、GPT-5.5、DeepSeek V4 Pro 的讨论气泡，不再只剩最终回答。',
        '子模型发言改为头像 + 聊天气泡布局，去掉模型对话边框，并按模型使用轻微区分的品牌色。',
        '深度研究开启 thinking 时，每个子模型气泡内可折叠查看自己的 thinking。',
        '研究停止条件收紧为至少 3/4 子模型认为无重大问题；主控模型只负责最终认真陈述，不再质疑用户。',
        '快速研究强制关闭 thinking 并使用低推理强度，避免表现得像普通模式或残留深度档位。',
        '询问用户工具继续加固，兼容模型把工具 JSON 意外包进普通代码块的情况。',
        '询问用户卡片去掉黄色背景和阴影，改为直接展示问题、灰度选项按钮和黑白数字圆标。',
        '普通模式 thinking 改为轻量折叠面板，去掉厚重卡片边框；侧边栏深浅色和语言切换按钮去掉默认按钮背景。'
      ]
    },
    en: {
      summary: 'Improved research chat bubbles, per-agent thinking, and membership points.',
      details: [
        'Pro redemption now costs 560 points, equal to 28 days of check-ins.',
        'Research discussions keep the Gemma, Kimi K2.5, GPT-5.5, and DeepSeek V4 Pro bubbles after completion instead of disappearing behind the final answer.',
        'Sub-agent turns now use an avatar plus chat bubble layout with no dialogue borders and subtly distinct model colors.',
        'When Deep Research enables thinking, each sub-agent bubble can show its own collapsible thinking.',
        'Research now requires at least 3/4 sub-agents to report no major issue before the master writes the final answer; the master answers directly instead of challenging the user.',
        'Fast Research forces thinking off and low reasoning effort so it does not inherit deep-research settings.',
        'Ask-user rendering is further hardened for cases where a model accidentally wraps the tool JSON in a generic code block.',
        'Ask-user cards no longer use the yellow background or shadow; questions, neutral option buttons, and black/white number dots are shown directly.',
        'Ordinary-mode thinking now uses a lighter collapsible panel without heavy card borders, and sidebar theme/language controls no longer have default button backgrounds.'
      ]
    }
  },
  {
    date: '2026-05-27',
    version: 'v0.10.9.9',
    zh: {
      summary: '修正快速/深度研究为多模型讨论流程。',
      details: [
        '快速研究不再等同普通单模型模式，现在同样进入 Kimi K2.5、GPT-5.5、DeepSeek V4 Pro 讨论流程。',
        '快速研究关闭 thinking，采用较短讨论轮次；深度研究开启 thinking，采用更完整的多轮质疑。',
        '研究流程改为先由各模型形成初始结论，再按轮共享结论、互相质疑并修正，直到无重大问题或达到安全轮次上限。',
        '最终回答只由主控模型在讨论结束后生成，主控必须吸收成立的质疑并标注仍未解决的不确定前提。',
        '研究过程记录新增 discussionRounds、consensusReached 与轮次质量信息，便于回看模型是否真的讨论过。'
      ]
    },
    en: {
      summary: 'Changed Fast and Deep Research into true multi-model discussion.',
      details: [
        'Fast Research no longer behaves like ordinary single-model chat; it now enters the Kimi K2.5, GPT-5.5, and DeepSeek V4 Pro discussion flow.',
        'Fast Research disables thinking and uses shorter rounds; Deep Research enables thinking and runs fuller challenge rounds.',
        'The research flow now starts with initial conclusions, then shares conclusions round by round for mutual critique and revision until no major issue remains or the safe round limit is reached.',
        'Only the master model writes the final answer after discussion, and it must absorb valid critiques and preserve unresolved uncertainty.',
        'Process traces now include discussionRounds, consensusReached, and per-round quality information.'
      ]
    }
  },
  {
    date: '2026-05-27',
    version: 'v0.10.9.6',
    zh: {
      summary: '加固询问用户工具渲染。',
      details: [
        '询问用户工具现在同时识别标准 rai_ask_user 围栏、json 围栏、无语言围栏，以及模型偶发输出的独立 JSON 行。',
        '解析器会严格校验 question/questions 与 options/placeholder 结构，避免普通代码块被随意误判。',
        '流式阶段会隐藏未闭合的询问用户工具块，最终消息会渲染为交互卡片，不再残留原始 JSON 或反引号。',
        '支持只有自定义输入框的问题，兼容单问题与不限数量的 questions 数组。',
        '提示词补充要求模型必须使用独立的 rai_ask_user 围栏，不得用普通 json 代码块代替。'
      ]
    },
    en: {
      summary: 'Hardened ask-user tool rendering.',
      details: [
        'Ask-user rendering now recognizes the standard rai_ask_user fence, json fences, unlabeled fences, and occasional standalone JSON lines emitted by models.',
        'The parser strictly validates question/questions plus options/placeholder structure so ordinary code blocks are not broadly misclassified.',
        'During streaming, incomplete ask-user blocks are hidden; final messages render interactive cards without raw JSON or stray backticks.',
        'Input-only questions are supported, along with single-question payloads and unlimited questions arrays.',
        'The prompt now tells models to use an independent rai_ask_user fence and not substitute a generic json code block.'
      ]
    }
  },
  {
    date: '2026-05-27',
    version: 'v0.10.9.5',
    zh: {
      summary: '移除全部模型中的商用模型图标。',
      details: [
        '全部模型展开列表中的 DeepSeek、Kimi、Qwen、ChatGPT、GPT-5.5、Grok、Claude、Gemma 图标已全部移除，只保留文字与状态徽章。',
        '模型弹窗中的同类商用模型卡片图标同步移除，避免界面内残留品牌图形。',
        '智能模型、极速模式、专家模式与全部模型入口图标保留；本地模型入口不受影响。',
        '为无图标条目补齐纯文字布局，展开列表不再留下左侧空白占位。',
        '版本号提升至 0.10.9.5，并更新缓存号，旧页面会收到刷新提示。'
      ]
    },
    en: {
      summary: 'Removed commercial provider icons from the full model list.',
      details: [
        'DeepSeek, Kimi, Qwen, ChatGPT, GPT-5.5, Grok, Claude, and Gemma no longer show provider icons in the expanded All Models list, leaving text and badges only.',
        'The same provider icons were removed from the model modal cards so brand graphics do not linger elsewhere in the UI.',
        'The top-level Smart, Fast, Expert, and All Models entry icons remain, and the local-model entry is unchanged.',
        'Text-only menu items now use a dedicated layout so the expanded list no longer leaves an empty left gutter.',
        'The app version is now 0.10.9.5 with a new build id so older pages surface the refresh prompt.'
      ]
    }
  },
  {
    date: '2026-05-26',
    version: 'v0.10.9.4',
    zh: {
      summary: '翻新主页视觉并修复询问用户工具。',
      details: [
        '主页侧边栏、新对话、选中对话、输入框、模型菜单和加号菜单改为设置页同款灰度层级，减少硬边框。',
        '新用户引导第一页图片改为占卡片一半，移除重复关闭按钮，底部顺序调整为跳过、步骤点、下一步。',
        '重做引导第二页能力介绍卡片，保持第三页结构不变。',
        '研究模式新增总开关；关闭时不影响普通推理，开启快速研究会关闭 thinking，开启深度研究才进入多模型互评。',
        '修复 RAI_ASK_USER 被显示成代码块的问题，流式和历史消息都会渲染为可点击/可输入的问题卡片。'
      ]
    },
    en: {
      summary: 'Refreshed the home UI and fixed ask-user rendering.',
      details: [
        'The sidebar, new chat button, active conversation, composer, model menu, and plus menu now use Settings-style grayscale layers with fewer hard borders.',
        'The first onboarding page image now takes half the card, the duplicate close button is removed, and the footer order is Skip, dots, Next.',
        'The second onboarding page now uses polished capability cards while the third page keeps its stronger layout.',
        'Research Mode now has a master switch; off leaves ordinary reasoning alone, Fast disables thinking, and Deep starts the multi-model review flow.',
        'Fixed RAI_ASK_USER rendering so streaming and saved messages show interactive question cards instead of raw code blocks.'
      ]
    }
  },
  {
    date: '2026-05-26',
    version: 'v0.10.9.3',
    zh: {
      summary: '修复登录语言与研究模式交互。',
      details: [
        '设置页繁体中文下，简体中文选项保持显示为“简体中文”，避免语言按钮互相误导。',
        '登录 / 注册页语言按钮改为与签到按钮一致的土星黄选中态，去掉阴影和渐变。',
        'ZTX6D 登录改为半宽按钮，并新增 rPass 登录占位入口，悬浮或点击提示待上线。',
        '邮箱输入不再在 .co 阶段自动跳到密码框，渐进式表单隐藏步骤不再预留空白。',
        '退出登录会关闭设置面板、清除登录态并强制刷新页面。',
        '原 4 倍速研究入口改为快速研究 / 深度研究两档滑块；快速研究关闭 thinking，深度研究由 Kimi K2.5、GPT-5.5、DeepSeek V4 Pro 互相质疑讨论后，再由 GPT-5.5 或 DeepSeek V4 Pro 主控生成最终回答。'
      ]
    },
    en: {
      summary: 'Fixed login language UI and research-mode behavior.',
      details: [
        'In Traditional Chinese, the Simplified Chinese option now keeps its own label instead of becoming misleading.',
        'The login language picker now matches the check-in button color with no shadow or gradient.',
        'ZTX6D login is half-width and an rPass login placeholder now shows coming-soon feedback.',
        'Email entry no longer advances at .co, and hidden auth steps no longer reserve empty space.',
        'Logging out closes Settings, clears auth state, and forces a page refresh.',
        'The old 4x research entry is replaced by a Fast / Deep Research slider; Fast disables thinking, while Deep has Kimi K2.5, GPT-5.5, and DeepSeek V4 Pro challenge each other before GPT-5.5 or DeepSeek V4 Pro produces the final answer.'
      ]
    }
  },
  {
    date: '2026-05-26',
    version: 'v0.10.9.2',
    zh: {
      summary: '重做新用户引导、登录语言选择和询问用户工具。',
      details: [
        '新用户引导改为账号级完成状态，注册新账号不会被旧浏览器标记跳过。',
        '引导结束后会在主页显示 RAI 的语言选择问题，用户可选择简体中文、繁體中文或 English。',
        'AI 新增询问用户工具，可在回复中渲染不限数量的问题，每题最多 3 个选项和一个自定义输入框。',
        '旧版本网页会检测线上版本变化，并显示一键刷新到最新版的提示。',
        '登录 / 注册语言切换改为分段按钮，设置页重新观看引导入口移入关于卡片操作区。',
        '修复无会话新用户侧边栏一直显示加载中的问题。'
      ]
    },
    en: {
      summary: 'Reworked onboarding, login language selection, and the ask-user tool.',
      details: [
        'Onboarding completion is now account-scoped so a new registration is not skipped by an old browser flag.',
        'After onboarding, RAI asks the new user to choose Simplified Chinese, Traditional Chinese, or English on the home screen.',
        'Assistant replies can now render unlimited ask-user questions, each with up to three options and one custom input.',
        'Older open pages now detect newer server versions and show a one-click refresh prompt.',
        'The login language picker is now a segmented control, and replaying onboarding lives in the About action area.',
        'Fixed the empty-session sidebar loading state for new users.'
      ]
    }
  },
  {
    date: '2026-05-25',
    version: 'v0.10.9.1',
    zh: {
      summary: '管理员后台快捷键适配 macOS。',
      details: [
        'macOS 管理员入口快捷键改为 Control + Option + A，避免占用 Chrome 的 Command 快捷键。',
        'Windows / Linux 继续使用 Ctrl + Shift + A 打开管理员入口。'
      ]
    },
    en: {
      summary: 'Adjusted the admin panel shortcut for macOS.',
      details: [
        'The macOS admin shortcut is now Control + Option + A to avoid Chrome Command-key conflicts.',
        'Windows and Linux continue to use Ctrl + Shift + A.'
      ]
    }
  },
  {
    date: '2026-05-25',
    version: 'v0.10.9',
    zh: {
      summary: '管理员后台新增模型开关。',
      details: [
        '管理员可以在后台按模型开启或关闭用户可见性。',
        '关闭后的模型会从主聊天、移动模型菜单、ChatFlow 和重新生成模型列表中隐藏。',
        '如果用户当前选择了被关闭模型，会自动切回智能模型。'
      ]
    },
    en: {
      summary: 'Added admin-controlled model visibility switches.',
      details: [
        'Admins can enable or disable user-visible models from the admin panel.',
        'Disabled models are hidden from chat model menus, ChatFlow, and regenerate choices.',
        'When a selected model is disabled, the UI automatically switches back to Smart Model.'
      ]
    }
  },
  {
    date: '2026-05-22',
    version: 'v0.10.8',
    zh: {
      summary: '设置、侧边栏、点数兑换和更新记录完成一次体验打磨。',
      details: [
        '关于页使用 RAI 土星 Logo，更新记录改成面向用户的版本说明，并显示完整年份日期。',
        '版本号回到 0.10 系列，当前版本显示为 v0.10.8。',
        '设置页新增跟随系统深浅色，浅色配色更接近现代应用的柔和灰白层级。',
        '登出入口移动到账号设置内，账号表单、移动端返回箭头和二级菜单状态更加整齐。',
        '侧边栏修正搜索框右边界、移动端圆角、ChatFlow 测试标识和语言图标按钮。',
        '点数兑换会员页面改为更清晰的套餐卡片，支持邮箱改为 rick080402+raisupport@gmail.com。'
      ]
    },
    en: {
      summary: 'Polished Settings, sidebar, points redemption, and the update records experience.',
      details: [
        'The About page now uses the RAI Saturn logo, shows user-facing update notes, and includes full year dates.',
        'The app version returned to the 0.10 line and now displays v0.10.8.',
        'Settings now supports following the system theme, with a softer modern light palette.',
        'Log out moved into Account settings, with cleaner account fields, mobile back affordance, and detail-page state.',
        'The sidebar now has a fixed search edge, rounded mobile drawer, ChatFlow beta badge, and language icon button.',
        'The points redemption page now uses clearer plan cards and support email is rick080402+raisupport@gmail.com.'
      ]
    }
  },
  {
    date: '2026-05-21',
    version: 'v0.9.4',
    zh: {
      summary: '设置页浅色模式和关于页更新记录基础完成。',
      details: [
        '设置弹窗、移动端设置主页、二级设置页、输入框、按钮、头像区和更新记录都支持浅色主题。',
        '设置图标在浅色主题下显示深色，在深色主题下显示浅色。',
        '关于页从固定内容改为数据驱动更新记录，并加入 GitHub、作者和联系邮箱。',
        '简体中文、繁体中文和 English 的设置页文案完成同步。'
      ]
    },
    en: {
      summary: 'Completed the base light theme for Settings and the About update records.',
      details: [
        'Settings modal, mobile home, detail pages, inputs, buttons, avatar areas, and update records all support light theme.',
        'Settings icons now use dark artwork on light theme and light artwork on dark theme.',
        'About moved from fixed entries to data-driven update records with GitHub, author, and contact email.',
        'Simplified Chinese, Traditional Chinese, and English Settings copy were synchronized.'
      ]
    }
  },
  {
    date: '2026-05-21',
    version: 'v0.9.3',
    zh: {
      summary: '本地 Markdown 渲染更稳定，首屏加载不再依赖外部备用资源。',
      details: [
        '修复本地 Markdown 渲染库文件损坏造成的加载风险。',
        'RAI 可以直接使用内置 Markdown 渲染能力，弱网或外部 CDN 不可用时也更稳。',
        '关于页补充该版本的更新记录。'
      ]
    },
    en: {
      summary: 'Made local Markdown rendering more stable without relying on external fallback resources.',
      details: [
        'Fixed the damaged local Markdown renderer file that could affect first load.',
        'RAI can use its bundled Markdown renderer more reliably when networks or CDNs are unavailable.',
        'Added this version to the About update records.'
      ]
    }
  },
  {
    date: '2026-05-21',
    version: 'v0.9.2',
    zh: {
      summary: '浅色主题图标、繁体中文和更新记录入口上线。',
      details: [
        '浅色主题下设置入口、关闭按钮和分类图标更清晰。',
        '语言支持扩展为简体中文、繁体中文和 English。',
        '关于页首次加入 RAI 更新记录，方便查看版本演进。'
      ]
    },
    en: {
      summary: 'Added light-theme icon contrast, Traditional Chinese, and the first update records entry.',
      details: [
        'Settings entry, close button, and category icons are clearer on light theme.',
        'Language support expanded to Simplified Chinese, Traditional Chinese, and English.',
        'About gained RAI update records so version history is easier to review.'
      ]
    }
  },
  {
    date: '2026-05-21',
    version: 'v0.9.1',
    zh: {
      summary: '移动端设置更像原生应用，并加入自定义头像。',
      details: [
        '移动端设置的字号、头像、按钮高度、圆角和间距更适合触控。',
        '设置主页和二级页面切换加入非线性淡入、滑移、缩放和轻微模糊。',
        'Android 系统返回键可以从二级设置返回设置主页，再返回 RAI 主界面。',
        '用户可以上传自定义头像，并同步显示在侧边栏、设置页和聊天消息中。'
      ]
    },
    en: {
      summary: 'Made mobile Settings feel more native and added custom avatars.',
      details: [
        'Mobile Settings typography, avatar size, button height, radius, and spacing are better tuned for touch.',
        'Settings home and detail transitions now use non-linear fade, slide, scale, and light blur.',
        'Android back returns from detail to Settings home, then from Settings home to the RAI main screen.',
        'Users can upload a custom avatar that appears in the sidebar, Settings, and chat messages.'
      ]
    }
  },
  {
    date: '2026-05-21',
    version: 'v0.9.0',
    zh: {
      summary: '移动端设置重做，并修正侧边栏签到按钮。',
      details: [
        '移动端设置改为设置主页加二级详情页，更符合手机触控习惯。',
        '侧边栏签到按钮改为按内容宽度显示，不再占用过多空间。',
        '设置分类、关闭按钮和侧边栏设置入口加入 SVG 图标。',
        '移动端设置主页展示用户头像和名称。'
      ]
    },
    en: {
      summary: 'Rebuilt mobile Settings and fixed the sidebar check-in button.',
      details: [
        'Mobile Settings now uses a home page plus detail pages for a better touch flow.',
        'The sidebar check-in button now sizes to its content instead of taking too much width.',
        'Settings categories, close button, and sidebar Settings entry gained SVG icons.',
        'Mobile Settings home shows the user avatar and name.'
      ]
    }
  },
  {
    date: '2026-05-14',
    version: 'v0.10.7',
    zh: {
      summary: 'ZTX6D 登录、NewAPI GPT-5.5、故障降级和 Mermaid 实时图表修复。',
      details: [
        '新增服务端 ZTX6D SSO 登录和老用户绑定入口，前端只接收 RAI 自签 JWT。',
        '接入 OpenAI-compatible NewAPI GPT-5.5 通道，并对 free 用户设置每日 10 次限免。',
        '模型失败时按 GPT-OSS-120B、Gemma、Qwen2.5-7B 自动降级。',
        '修复流式 Mermaid 统计图、饼图、流程图与 Markdown、KaTeX、代码块冲突。',
        '保留 Grok 4.2、Gemma 官方/relay/备用路由和 Claude relay 兼容逻辑。'
      ]
    },
    en: {
      summary: 'Added ZTX6D login, NewAPI GPT-5.5, fallback routing, and live Mermaid fixes.',
      details: [
        'Added server-side ZTX6D SSO login and account binding while the frontend only receives RAI JWTs.',
        'Connected OpenAI-compatible NewAPI GPT-5.5 with a 10-use daily free quota.',
        'Fallbacks now try GPT-OSS-120B, Gemma, then Qwen2.5-7B when a model fails.',
        'Fixed streaming Mermaid charts conflicting with Markdown, KaTeX, and code blocks.',
        'Kept Grok 4.2, Gemma official/relay/fallback routing, and Claude relay compatibility.'
      ]
    }
  },
  {
    date: '2026-05-10',
    version: 'v0.10.6',
    zh: {
      summary: 'Grok、Gemma、Claude 多供应商路由和模型菜单打磨。',
      details: [
        'Grok 4.2 接入 NewAPI 路由，并清理上游混在正文里的 think 内容。',
        'Gemma 支持 Google 官方接口、relay 和备用路由。',
        'Claude OpenRouter 请求改为经美国 relay 转发，上游调用更安全稳定。',
        '模型供应商图标、短名展示、会员徽标和列表宽度继续统一。'
      ]
    },
    en: {
      summary: 'Polished Grok, Gemma, Claude provider routing and model menus.',
      details: [
        'Routed Grok 4.2 through NewAPI and separated upstream think content from visible replies.',
        'Added Gemma official Google API, relay, and fallback routing support.',
        'Moved Claude OpenRouter traffic through a US relay for safer and more stable upstream calls.',
        'Unified provider icons, short names, membership badges, and model list width behavior.'
      ]
    }
  },
  {
    date: '2026-05-06',
    version: 'v0.10.4',
    zh: {
      summary: 'GPT-5.5 限免策略、NewAPI main 分组和运行期备用链。',
      details: [
        'GPT-5.5 调整为限免策略，free 每日 10 次，Pro/MAX 不受该限额约束。',
        '确认 NewAPI 令牌 main 分组可用，直连 gpt-5.5 返回正常。',
        'ZTX6D 登录绑定和 GPT-5.5 使用配置更完整。',
        '服务端增加统一运行期备用链，主模型不可用时自动回退。'
      ]
    },
    en: {
      summary: 'Updated GPT-5.5 free quota, NewAPI main group, and runtime fallback chain.',
      details: [
        'Changed GPT-5.5 to a limited-free model: 10 daily uses for free users, unlimited for Pro/MAX.',
        'Verified the NewAPI main token group can call gpt-5.5 successfully.',
        'Added ops chapters for ZTX6D login/binding and GPT-5.5 integration parameters.',
        'Added a unified runtime fallback chain when primary models are unavailable.'
      ]
    }
  },
  {
    date: '2026-05-05',
    version: 'v0.10.3',
    zh: {
      summary: 'ZTX6D SSO、账号绑定、NewAPI provider 和 GPT-5.5 模型入口。',
      details: [
        '新增 /api/auth/ztx6d/status、start、callback，使用一次性 rt 换取 uid。',
        '已登录用户可在设置账号里绑定 ZTX6D。',
        '登录页新增 ZTX6D 登录按钮，并移除生产环境 localhost 旧跳转。',
        '新增 NewAPI / Lightcone AI provider，并在桌面、移动端、重新生成和 ChatFlow 菜单加入 GPT-5.5。'
      ]
    },
    en: {
      summary: 'Added ZTX6D SSO, account binding, NewAPI provider, and GPT-5.5 entries.',
      details: [
        'Added /api/auth/ztx6d/status, start, and callback using one-time rt exchange for uid.',
        'Logged-in users can bind ZTX6D from Settings account binding.',
        'Added a ZTX6D login button and removed old production localhost redirects.',
        'Added the NewAPI / Lightcone AI provider and GPT-5.5 in desktop, mobile, regenerate, and ChatFlow menus.'
      ]
    }
  },
  {
    date: '2026-04-30',
    version: 'v0.10.0',
    zh: {
      summary: 'DeepSeek V4、ChatGPT/Gemma 路由、模型菜单和横屏输入布局。',
      details: [
        'DeepSeek 主路由升级为 deepseek-v4-flash，前端显示 DeepSeek V4。',
        '新增 OpenRouter ChatGPT openai/gpt-oss-120b:free。',
        'Gemma 切到 Google 官方 Generative Language API，并保留地区限制兜底。',
        '模型选择菜单缩窄、供应商图标统一，极速/专家入口保持抽象图标。',
        '桌面与横屏平板首页输入框宽度改为主内容区域约三分之二。',
        '主站版本同步上线，历史对话与用户数据保持不变。'
      ]
    },
    en: {
      summary: 'Updated DeepSeek V4, ChatGPT/Gemma routing, model menus, and landscape input layout.',
      details: [
        'Upgraded DeepSeek main routing to deepseek-v4-flash and displayed it as DeepSeek V4.',
        'Added OpenRouter ChatGPT openai/gpt-oss-120b:free.',
        'Moved Gemma to the Google official Generative Language API with region-limit fallback.',
        'Narrowed model menus, unified provider icons, and kept Fast/Expert entries abstract.',
        'Set desktop and landscape tablet welcome input width to about two-thirds of the main content area.',
        'Published the main site update while preserving chat history and user data.'
      ]
    }
  },
  {
    date: '2026-04-08',
    version: 'v0.9',
    zh: {
      summary: '历史版本整理为 0.9 快照节点。',
      details: [
        'β0.2、0.3、0.4、0.5、0.6、0.81、0.85+、0.85++ 和 0.9 的历史演进被整理为可追溯记录。',
        '历史包清理了和用户体验无关的本地状态文件，版本内容更聚焦。',
        '3月到4月的移动端模型入口、对话索引、Mermaid 错误收敛和滚动体验更新并入该快照说明。'
      ]
    },
    en: {
      summary: 'Historical archive and 0.9 snapshot milestone.',
      details: [
        'Organized the historical progress from beta 0.2 through 0.9 into traceable records.',
        'Cleaned local state files from historical packages so each record focuses on product changes.',
        'Grouped March-April mobile model entry, conversation index, Mermaid failure handling, and scrolling updates into this snapshot.'
      ]
    }
  },
  {
    date: '2026-01-30',
    version: 'v0.85++',
    zh: {
      summary: '最后一个保留模型路由版本。',
      details: [
        '保留 Chat Flow 之前的模型路由能力，作为后续路线的可回退参考点。',
        '搜索深度映射、原生工具调用和流式工具调用体验进一步稳定。',
        '首字延时从约 5 秒降至约 1 秒，并支持 AI 边输出边决定是否调用搜索工具。'
      ]
    },
    en: {
      summary: 'Last archived version that preserves the older model-routing branch.',
      details: [
        'Kept the pre-Chat Flow model-routing capability as a fallback reference point.',
        'Improved Tavily search-depth mapping, native tool calling, and streaming tool-call behavior.',
        'Reduced first-token latency from about 5 seconds to about 1 second while supporting search decisions during streaming.'
      ]
    }
  },
  {
    date: '2026-01-11',
    version: 'v0.85+',
    zh: {
      summary: 'Chat Flow 思维流重磅新增。',
      details: [
        '新增无限画布，可把对话内容拖拽到画布组织思路。',
        '支持节点语义连线、标签说明关系和 AI 自动拆解子话题。',
        '支持 PNG、SVG、Mermaid、JSON 多格式导出和一键自动布局。',
        '补齐 Chat Flow 桌面和移动端 README 展示。'
      ]
    },
    en: {
      summary: 'Major Chat Flow mind-map canvas update.',
      details: [
        'Added an infinite canvas where conversations can be dragged into visual thinking space.',
        'Supported semantic node connections, edge labels, and AI decomposition into subtopics.',
        'Added PNG, SVG, Mermaid, and JSON export plus one-click auto layout.',
        'Documented desktop and mobile Chat Flow screenshots in README.'
      ]
    }
  },
  {
    date: '2025-12-27',
    version: 'v0.81',
    zh: {
      summary: '0.8 之后的功能整合快照。',
      details: [
        '作为 0.85+ 之前的历史功能整合节点归档。',
        '保留多模型、联网搜索、思考模式、会员系统、引用回复和编辑消息等核心能力。',
        '该阶段作为后续 Chat Flow 大更新前的稳定基线。'
      ]
    },
    en: {
      summary: 'Feature consolidation snapshot after 0.8.',
      details: [
        'Archived as the historical consolidation point before 0.85+.',
        'Kept core capabilities including multi-model support, web search, thinking mode, membership, quote reply, and message editing.',
        'This stage serves as the stable baseline before the later Chat Flow update.'
      ]
    }
  },
  {
    date: '2025-12-13',
    version: 'v0.8',
    zh: {
      summary: '图文并茂回复和图表渲染。',
      details: [
        'AI 回复过程中支持插入多张图片。',
        '支持流程图、统计图、思维导图等多种图表输出。',
        'README 将该阶段标记为图文并茂能力节点。'
      ]
    },
    en: {
      summary: 'Rich media replies and chart rendering.',
      details: [
        'AI replies can include multiple images during generation.',
        'Added flowcharts, statistical charts, mind maps, and other diagram outputs.',
        'README marks this as the Rich Media milestone.'
      ]
    }
  },
  {
    date: '2025-12-10',
    version: 'v0.6 多模态',
    zh: {
      summary: '多模态能力归档。',
      details: [
        '历史目录记录为 RAI 0.6 多模态。',
        '能力范围覆盖图片理解、视频理解、文档上传与解析。',
        '多模态能力后来延续到 Qwen VL Max、Qwen3 Omni Flash 和文档解析流程。'
      ]
    },
    en: {
      summary: 'Multimodal capability archive.',
      details: [
        'Historical folder recorded as RAI 0.6 Multimodal.',
        'Covered image understanding, video understanding, and document upload/parsing.',
        'The multimodal capability later continued through Qwen VL Max, Qwen3 Omni Flash, and document parsing flows.'
      ]
    }
  },
  {
    date: '2025-12-09',
    version: 'v0.6 game routing',
    zh: {
      summary: '基于 0.6 多模态的模型路由 game 分支。',
      details: [
        '历史目录记录为“基于 RAI0.6 多模态 模型路由 game 版本”。',
        '作为 0.6 多模态和模型路由方向的分支快照保留。',
        '该分支保留了早期模型路由实验方向。'
      ]
    },
    en: {
      summary: 'Game-routing branch based on the 0.6 multimodal version.',
      details: [
        'Historical folder recorded as a model-routing game version based on RAI 0.6 multimodal.',
        'Kept as a branch snapshot for the multimodal and model-routing direction.',
        'This branch preserved the early model-routing experiment direction.'
      ]
    }
  },
  {
    date: '2025-11-27',
    version: 'v0.5',
    zh: {
      summary: '带模型路由的 0.5 版本。',
      details: [
        '引入 Auto 模式，根据复杂度选择 Qwen Flash、Plus、Max。',
        '加入五维度分析：输入长度、代码检测、数学公式、推理复杂度、语言混合度。',
        '整合联网搜索、思考模式和本地模型相关文档。'
      ]
    },
    en: {
      summary: '0.5 release with model routing.',
      details: [
        'Introduced Auto mode to choose Qwen Flash, Plus, or Max by complexity.',
        'Added five-dimension analysis: input length, code detection, math formulas, reasoning complexity, and language mix.',
        'Integrated web search, thinking mode, and local model documentation.'
      ]
    }
  },
  {
    date: '2025-11-20',
    version: 'v0.4',
    zh: {
      summary: '自动路由和运行稳定性提升。',
      details: [
        'Auto 模式更稳定，模型选择和请求头处理更可靠。',
        '修复自动模式 404 和模型选择异常，运行稳定性提升。',
        '形成自动路由阈值和验证清单，后续版本更容易迭代。'
      ]
    },
    en: {
      summary: 'Improved auto-routing and runtime stability.',
      details: [
        'Made Auto mode more stable with more reliable model selection and request headers.',
        'Fixed Auto mode 404s and model-selection issues while improving runtime stability.',
        'Created routing thresholds and verification checklists that made later versions easier to iterate.'
      ]
    }
  },
  {
    date: '2025-11-16',
    version: 'v0.3',
    zh: {
      summary: '早期 RAI 源码归档。',
      details: [
        'RAI 0.3 保留了早期源码骨架。',
        '保留早期 Express、SQLite、JWT、前端页面和 AI 聊天基础结构。',
        '这一版奠定了后续模型路由和多模态能力的基础。'
      ]
    },
    en: {
      summary: 'Early RAI source archive.',
      details: [
        'RAI 0.3 preserved the early source foundation.',
        'Kept early Express, SQLite, JWT, frontend, and AI chat foundations.',
        'This version laid the groundwork for later model routing and multimodal features.'
      ]
    }
  },
  {
    date: '2025-11-15',
    version: 'β0.2',
    zh: {
      summary: '初始 beta 归档。',
      details: [
        'RAI β0.2 是最早的可追溯 beta 节点。',
        '保留最早期项目骨架、认证和聊天基础能力。',
        '作为后续 0.3、0.4、0.5 演进的起点。'
      ]
    },
    en: {
      summary: 'Initial beta archive.',
      details: [
        'RAI beta 0.2 is the earliest traceable beta milestone.',
        'Kept the earliest project skeleton, authentication, and chat basics.',
        'Served as the starting point for later 0.3, 0.4, and 0.5 evolution.'
      ]
    }
  }
];

const SUPPORTED_LANGUAGES = ['zh-CN', 'zh-TW', 'en'];
const LANGUAGE_OPTION_LABELS = {
  'zh-CN': { 'zh-CN': '简体中文', 'zh-TW': '简体中文', 'en': 'Simplified Chinese' },
  'zh-TW': { 'zh-CN': '繁體中文', 'zh-TW': '繁體中文', 'en': 'Traditional Chinese' },
  'en': { 'zh-CN': 'English', 'zh-TW': 'English', 'en': 'English' }
};

function normalizeLanguage(lang) {
  if (lang === 'zh-HK' || lang === 'zh-MO') return 'zh-TW';
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'zh-CN';
}

function isChineseLanguage(lang = appState.language) {
  return String(lang || '').startsWith('zh');
}

function getCurrentLocale() {
  return appState.language === 'zh-TW' ? 'zh-TW' : (isChineseLanguage(appState.language) ? 'zh-CN' : 'en-US');
}

function getLanguageToggleLabel(lang = appState.language) {
  const currentLang = normalizeLanguage(lang);
  const nextLang = currentLang === 'en'
    ? normalizeLanguage(appState.languageToggleChinese || localStorage.getItem('rai_language_chinese_variant') || 'zh-CN')
    : 'en';
  if (nextLang === 'zh-CN') return '中';
  if (nextLang === 'zh-TW') return '繁';
  return 'EN';
}

function i18nText(key, fallback = '') {
  const lang = normalizeLanguage(appState.language);
  return i18n[lang]?.[key] || i18n['zh-CN']?.[key] || fallback;
}

function localizeTimelineContent(entry) {
  const lang = normalizeLanguage(appState.language);
  if (lang === 'en') return entry.en || entry.zh;
  if (lang === 'zh-TW') {
    const source = entry.zh || entry.en || {};
    return {
      summary: toTraditionalText(source.summary || ''),
      details: (source.details || []).map((detail) => toTraditionalText(detail))
    };
  }
  return entry.zh || entry.en || {};
}

function formatTimelineDate(dateValue) {
  const lang = normalizeLanguage(appState.language);
  const date = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateValue;

  if (lang === 'en') {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}.${month}.${day}`;
}

function renderSettingsTimeline() {
  const list = document.getElementById('settingsTimelineList');
  if (!list) return;

  list.textContent = '';
  const fragment = document.createDocumentFragment();
  const detailsOpenLabel = i18nText('settings-timeline-details-open', 'View full update');
  const detailsCloseLabel = i18nText('settings-timeline-details-close', 'Collapse full update');

  RAI_UPDATE_TIMELINE.forEach((entry) => {
    const content = localizeTimelineContent(entry);
    const item = document.createElement('article');
    item.className = 'settings-timeline-item';

    const time = document.createElement('time');
    time.className = 'settings-timeline-date';
    time.dateTime = entry.date;
    time.textContent = formatTimelineDate(entry.date);

    const body = document.createElement('div');
    body.className = 'settings-timeline-body';

    const version = document.createElement('div');
    version.className = 'settings-timeline-version';
    version.textContent = entry.version;

    const summary = document.createElement('p');
    summary.textContent = content.summary || '';

    body.append(version, summary);

    if (content.details?.length) {
      const details = document.createElement('details');
      details.className = 'settings-timeline-details';

      const detailsSummary = document.createElement('summary');
      detailsSummary.textContent = detailsOpenLabel;
      details.addEventListener('toggle', () => {
        detailsSummary.textContent = details.open ? detailsCloseLabel : detailsOpenLabel;
      });

      const detailList = document.createElement('ul');
      detailList.className = 'settings-timeline-detail-list';

      content.details.forEach((detailText) => {
        const detailItem = document.createElement('li');
        detailItem.textContent = detailText;
        detailList.appendChild(detailItem);
      });

      details.append(detailsSummary, detailList);
      body.appendChild(details);
    }

    item.append(time, body);
    fragment.appendChild(item);
  });

  list.appendChild(fragment);
}

function getUserDisplayName(user = appState.user) {
  const email = String(user?.email || '').trim();
  const username = String(user?.username || '').trim();
  if (username) return username;
  if (email) return email.split('@')[0];
  return isChineseLanguage(appState.language) ? '用户' : 'User';
}

function getUserAvatarUrl(user = appState.user) {
  return resolveRaiRemoteUrl(user?.avatar_url || user?.avatarUrl || '');
}

function getAvatarFallback(user = appState.user) {
  const displayName = getUserDisplayName(user);
  const email = String(user?.email || '').trim();
  const seed = displayName || email || 'U';
  return seed.charAt(0).toUpperCase();
}

function escapeCssUrl(url) {
  return String(url || '').replace(/["\\]/g, '\\$&');
}

function setAvatarElement(element, avatarUrl, fallbackText) {
  if (!element) return;

  const hasAvatar = !!avatarUrl;
  element.classList.toggle('has-image', hasAvatar);
  element.style.backgroundImage = hasAvatar ? `url("${escapeCssUrl(avatarUrl)}")` : '';
  element.textContent = hasAvatar ? '' : fallbackText;
}

function applyUserAvatarToElement(element, user = appState.user) {
  setAvatarElement(element, getUserAvatarUrl(user), getAvatarFallback(user));
}

function updateUserIdentityUI() {
  const realEmail = String(appState.user?.email || '').trim();
  const displayName = getUserDisplayName(appState.user);
  const avatarUrl = getUserAvatarUrl(appState.user);
  const avatarFallback = getAvatarFallback(appState.user);

  const userNameEl = document.getElementById('userName');
  if (userNameEl) {
    userNameEl.textContent = displayName;
  }

  const userAvatarEl = document.getElementById('userAvatar');
  setAvatarElement(userAvatarEl, avatarUrl, avatarFallback);

  const settingsMobileNameEl = document.getElementById('settingsMobileName');
  if (settingsMobileNameEl) {
    settingsMobileNameEl.textContent = displayName;
  }

  const settingsMobileAvatarEl = document.getElementById('settingsMobileAvatar');
  setAvatarElement(settingsMobileAvatarEl, avatarUrl, avatarFallback);

  const settingsAvatarPreviewEl = document.getElementById('settingsAvatarPreview');
  setAvatarElement(settingsAvatarPreviewEl, avatarUrl, avatarFallback);

  const usernameInput = document.getElementById('settingsUsernameInput');
  if (usernameInput) {
    usernameInput.value = String(appState.user?.username || '').trim();
  }

  const emailInput = document.getElementById('settingsEmailInput');
  if (emailInput) {
    emailInput.value = realEmail;
  }
}

function normalizeResearchMode(value) {
  return String(value || '').toLowerCase() === 'deep' ? 'deep' : 'fast';
}

function isResearchModeEnabled() {
  return appState.researchModeEnabled === true;
}

function getEffectiveResearchMode() {
  return isResearchModeEnabled() ? normalizeResearchMode(appState.researchMode) : 'off';
}

function researchModeToIndex(mode) {
  return normalizeResearchMode(mode) === 'deep' ? 1 : 0;
}

function researchIndexToMode(index) {
  return Number(index) >= 1 ? 'deep' : 'fast';
}

function setResearchModeFromSlider(indexValue) {
  setResearchMode(researchIndexToMode(indexValue), { enable: true });
}

function setResearchMode(mode, options = {}) {
  const normalized = normalizeResearchMode(mode);
  if (options.enable !== false) {
    appState.researchModeEnabled = true;
  }
  appState.researchMode = normalized;
  appState.agentMode = false;

  if (isResearchModeEnabled() && normalized === 'deep') {
    appState.thinkingMode = true;
    appState.reasoningProfile = 'high';
  } else if (isResearchModeEnabled() && normalized === 'fast') {
    appState.thinkingMode = false;
    appState.reasoningProfile = 'low';
  }

  updateResearchModeControl();
  updateReasoningProfileControl();
  updateToolbarUI();
  scheduleComposerMenuReposition(8);
  preserveMobileInputFocus();
}

function toggleResearchModeFromMenu(event) {
  event?.stopPropagation?.();
  appState.researchModeEnabled = !isResearchModeEnabled();
  appState.agentMode = false;

  if (appState.researchModeEnabled) {
    const normalized = normalizeResearchMode(appState.researchMode);
    if (normalized === 'deep') {
      appState.thinkingMode = true;
      appState.reasoningProfile = 'high';
    } else {
      appState.thinkingMode = false;
      appState.reasoningProfile = 'low';
    }
  } else {
    appState.thinkingMode = false;
  }

  updateResearchModeControl();
  updateReasoningProfileControl();
  updateToolbarUI();
  scheduleComposerMenuReposition(8);
  preserveMobileInputFocus();
}

function updateResearchModeControl() {
  const slider = document.getElementById('researchModeSlider');
  const toggle = document.getElementById('researchModeToggle');
  const switchBtn = document.getElementById('researchModeSwitch');
  const item = document.querySelector('.research-mode-item');
  const enabled = isResearchModeEnabled();

  if (slider) {
    const targetIndex = String(researchModeToIndex(appState.researchMode));
    if (slider.value !== targetIndex) {
      slider.value = targetIndex;
    }
    slider.disabled = !enabled;
    slider.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    updateReasoningProfileSliderVisual(slider);
  }

  if (toggle) {
    toggle.classList.toggle('active', enabled);
  }

  if (switchBtn) {
    switchBtn.classList.toggle('active', enabled);
    switchBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    switchBtn.title = enabled
      ? (isChineseLanguage(appState.language) ? '关闭研究模式' : 'Turn off research mode')
      : (isChineseLanguage(appState.language) ? '开启研究模式' : 'Turn on research mode');
  }

  if (item) {
    item.classList.toggle('research-mode-off', !enabled);
  }
}

function getRequestModelIdForCurrentMode() {
  const selected = normalizeSelectedModelId(appState.selectedModel);
  if (getEffectiveResearchMode() === 'deep' && appState.thinkingMode && selected === 'deepseek-v3') {
    return 'deepseek-v3.2-speciale';
  }
  return selected;
}

function getRequestReasoningProfileForCurrentMode() {
  if (getEffectiveResearchMode() === 'deep' && appState.thinkingMode) {
    return 'mixed';
  }
  if (getEffectiveResearchMode() === 'fast') {
    return 'low';
  }
  return normalizeReasoningProfile(appState.reasoningProfile);
}

function openAvatarPicker() {
  if (!appState.token) {
    showToast(isChineseLanguage(appState.language) ? '请先登录后再更换头像' : 'Please log in before changing your avatar');
    return;
  }

  const avatarInput = document.getElementById('avatarInput');
  if (!avatarInput) return;
  avatarInput.value = '';
  avatarInput.click();
}

async function handleAvatarSelected(event) {
  const input = event?.target;
  const file = input?.files?.[0];
  if (!file) return;

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(file.type)) {
    showToast(isChineseLanguage(appState.language) ? '请选择 JPG、PNG、WEBP 或 GIF 图片' : 'Choose a JPG, PNG, WEBP, or GIF image');
    input.value = '';
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    showToast(isChineseLanguage(appState.language) ? '头像不能超过 5MB' : 'Avatar must be under 5MB');
    input.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('avatar', file);
  showToast(i18nText('avatar-uploading', isChineseLanguage(appState.language) ? '头像上传中...' : 'Uploading avatar...'));

  try {
    const response = await fetch(`${API_BASE}/user/avatar`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appState.token}`
      },
      body: formData
    });
    const data = await response.json();

    if (!response.ok || !data?.success || !data.avatar_url) {
      throw new Error(data?.error || i18nText('avatar-upload-failed', isChineseLanguage(appState.language) ? '头像上传失败' : 'Avatar upload failed'));
    }

    appState.user = {
      ...appState.user,
      avatar_url: data.avatar_url
    };
    updateUserIdentityUI();
    if (typeof renderMessages === 'function') {
      renderMessages();
    }
    showToast(i18nText('avatar-upload-success', isChineseLanguage(appState.language) ? '头像已更新' : 'Avatar updated'));
  } catch (error) {
    console.error('头像上传失败:', error);
    showToast(error.message || i18nText('avatar-upload-failed', isChineseLanguage(appState.language) ? '头像上传失败' : 'Avatar upload failed'));
  } finally {
    input.value = '';
  }
}

function clearSettingsPasswordInputs() {
  ['settingsCurrentPasswordInput', 'settingsNewPasswordInput', 'settingsConfirmPasswordInput']
    .forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = '';
    });
}

const SETTINGS_SECTION_TITLE_KEYS = {
  language: 'settings-nav-language',
  subscription: 'settings-nav-subscription',
  account: 'settings-nav-account',
  appearance: 'settings-nav-appearance',
  custom: 'settings-nav-custom',
  advanced: 'settings-nav-advanced',
  desktop: 'settings-nav-desktop',
  about: 'settings-nav-about'
};

function getSettingsSectionTitle(section) {
  const key = SETTINGS_SECTION_TITLE_KEYS[section] || 'settings';
  return i18nText(key, section || 'Settings');
}

function isSettingsMobileLayout() {
  return window.matchMedia('(max-width: 860px)').matches;
}

function updateSettingsMobileMode(mode) {
  const content = document.querySelector('.settings-content');
  if (!content) return;

  const nextMode = mode === 'detail' ? 'detail' : 'home';
  appState.settingsMobileMode = nextMode;
  content.classList.toggle('mobile-home', nextMode === 'home');
  content.classList.toggle('mobile-detail', nextMode === 'detail');
}

function currentSettingsHistoryState() {
  return window.history.state && window.history.state.raiSettings === true
    ? window.history.state
    : null;
}

function pushSettingsHistory(mode, section = appState.activeSettingsSection || 'language') {
  if (!isSettingsMobileLayout()) return;

  const currentState = currentSettingsHistoryState();
  if (currentState?.settingsMode === mode && currentState?.settingsSection === section) {
    return;
  }

  window.history.pushState({
    raiSettings: true,
    settingsMode: mode,
    settingsSection: section
  }, '', window.location.href);

  appState.settingsHistoryDepth = Math.min((appState.settingsHistoryDepth || 0) + 1, 2);
}

function showSettingsMobileHome(options = {}) {
  if (!isSettingsMobileLayout()) return;

  if (!options.fromHistory && currentSettingsHistoryState()?.settingsMode === 'detail') {
    window.history.back();
    return;
  }

  updateSettingsMobileMode('home');
  appState.settingsHistoryDepth = currentSettingsHistoryState() ? 1 : 0;
  updateSettingsNavigationUI();
}

function syncSettingsResponsiveLayout() {
  const content = document.querySelector('.settings-content');
  if (!content) return;

  if (isSettingsMobileLayout()) {
    updateSettingsMobileMode(appState.settingsMobileMode || 'home');
  } else {
    content.classList.remove('mobile-home', 'mobile-detail');
  }
}

function updateSettingsOptionButtons() {
  document.querySelectorAll('[data-theme-option]').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-theme-option') === (appState.themePreference || appState.theme));
  });

  document.querySelectorAll('[data-language-option]').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-language-option') === appState.language);
  });
}

function syncDesktopSettingsVisibility() {
  document.querySelectorAll('.tauri-desktop-only').forEach((element) => {
    element.classList.toggle('is-hidden', !RAI_IS_TAURI_DESKTOP);
    if (RAI_IS_TAURI_DESKTOP) {
      element.removeAttribute('aria-hidden');
    } else {
      element.setAttribute('aria-hidden', 'true');
    }
  });

  if (!RAI_IS_TAURI_DESKTOP && appState.activeSettingsSection === 'desktop') {
    switchSettingsSection('language', { keepMobileHome: true });
  }
}

function getTauriInvoke() {
  return window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke || null;
}

async function invokeDesktopCommand(commandName) {
  if (!RAI_IS_TAURI_DESKTOP) return false;
  const invoke = getTauriInvoke();
  if (typeof invoke !== 'function') {
    showToast(isChineseLanguage(appState.language) ? '桌面端控制暂不可用' : 'Desktop controls are not available');
    return false;
  }
  try {
    await invoke(commandName);
    return true;
  } catch (error) {
    console.warn('桌面端命令失败:', commandName, error);
    showToast(isChineseLanguage(appState.language) ? '桌面端控制失败' : 'Desktop control failed');
    return false;
  }
}

function openDesktopQuickWindow() {
  invokeDesktopCommand('desktop_show_quick_window');
}

function openDesktopMainWindow() {
  invokeDesktopCommand('desktop_show_main_window');
}

function hideDesktopWindows() {
  invokeDesktopCommand('desktop_hide_windows');
}

function updateSettingsDirtyState() {
  const usernameInput = document.getElementById('settingsUsernameInput');
  const emailInput = document.getElementById('settingsEmailInput');
  const currentPasswordInput = document.getElementById('settingsCurrentPasswordInput');
  const newPasswordInput = document.getElementById('settingsNewPasswordInput');
  const confirmPasswordInput = document.getElementById('settingsConfirmPasswordInput');
  const accountSaveBtn = document.getElementById('settingsAccountSaveBtn');
  const passwordSaveBtn = document.getElementById('settingsPasswordSaveBtn');

  const nextUsername = String(usernameInput?.value || '').trim();
  const nextEmail = String(emailInput?.value || '').trim();
  const currentUsername = String(appState.user?.username || '').trim();
  const currentEmail = String(appState.user?.email || '').trim();
  const profileDirty = nextUsername !== currentUsername || nextEmail !== currentEmail;
  const passwordDirty = [currentPasswordInput, newPasswordInput, confirmPasswordInput]
    .some((input) => String(input?.value || '').length > 0);

  if (accountSaveBtn) {
    accountSaveBtn.classList.toggle('is-visible', profileDirty);
    accountSaveBtn.disabled = !profileDirty;
  }

  if (passwordSaveBtn) {
    passwordSaveBtn.classList.toggle('is-visible', passwordDirty);
    passwordSaveBtn.disabled = !passwordDirty;
  }
}

function updateSettingsNavigationUI() {
  const section = appState.activeSettingsSection || 'language';
  const titleKey = SETTINGS_SECTION_TITLE_KEYS[section] || 'settings';
  const title = document.getElementById('settingsPanelTitle');

  if (title) {
    title.setAttribute('data-i18n', titleKey);
    title.textContent = getSettingsSectionTitle(section);
  }

  document.querySelectorAll('.settings-nav-item').forEach((button) => {
    button.classList.toggle('active', button.getAttribute('data-settings-section') === section);
  });

  updateSettingsOptionButtons();
}

function switchSettingsSection(section = 'language', options = {}) {
  if (section === 'desktop' && !RAI_IS_TAURI_DESKTOP) return;
  const nextPanel = document.querySelector(`[data-settings-panel="${section}"]`);
  if (!nextPanel) return;

  const currentPanel = document.querySelector('.settings-panel.active');
  appState.activeSettingsSection = section;
  updateSettingsNavigationUI();

  if (currentPanel && currentPanel !== nextPanel) {
    currentPanel.classList.add('leaving');
    currentPanel.classList.remove('active');
    setTimeout(() => {
      currentPanel.classList.remove('leaving');
    }, 360);
  }

  nextPanel.classList.remove('leaving');
  nextPanel.classList.add('active');
  if (isSettingsMobileLayout() && appState.settingsOpen && !options.keepMobileHome) {
    updateSettingsMobileMode('detail');
    if (!options.fromHistory) {
      pushSettingsHistory('detail', section);
    }
  }
  updateSettingsDirtyState();
}

function initSettingsInteractions() {
  const watchedInputs = [
    'settingsUsernameInput',
    'settingsEmailInput',
    'settingsCurrentPasswordInput',
    'settingsNewPasswordInput',
    'settingsConfirmPasswordInput'
  ];

  watchedInputs.forEach((id) => {
    const input = document.getElementById(id);
    if (input && !input.dataset.settingsDirtyBound) {
      input.dataset.settingsDirtyBound = '1';
      input.addEventListener('input', updateSettingsDirtyState);
    }
  });

  updateSettingsNavigationUI();
  updateSettingsDirtyState();
}

function setSettingsSaveButtonState(isSaving) {
  const buttons = document.querySelectorAll('[data-settings-save-action], #saveSettingsBtn');
  buttons.forEach((button) => {
    const labelKey = button.getAttribute('data-label-key') || 'save-settings';
    button.disabled = !!isSaving;
    button.textContent = isSaving
      ? i18nText('save-settings-pending', isChineseLanguage(appState.language) ? '保存中...' : 'Saving...')
      : i18nText(labelKey, isChineseLanguage(appState.language) ? '保存设置' : 'Save Settings');
  });
}


// 主题切换
function toggleTheme() {
  const newTheme = appState.theme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
}

function getSystemTheme() {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getEffectiveTheme(themePreference = appState.themePreference || appState.theme || 'dark') {
  return themePreference === 'system' ? getSystemTheme() : (themePreference === 'light' ? 'light' : 'dark');
}

function setTheme(themePreference) {
  const normalizedPreference = ['dark', 'light', 'system'].includes(themePreference) ? themePreference : 'dark';
  const effectiveTheme = getEffectiveTheme(normalizedPreference);
  appState.themePreference = normalizedPreference;
  appState.theme = effectiveTheme;
  document.documentElement.setAttribute('data-theme', effectiveTheme);
  document.documentElement.setAttribute('data-theme-preference', normalizedPreference);
  localStorage.setItem('rai_theme', normalizedPreference);

  // 更新移动端图标
  const mobileIcon = document.getElementById('mobileThemeIcon');
  if (mobileIcon) {
    const newIconName = effectiveTheme === 'dark' ? 'light_mode' : 'dark_mode';
    mobileIcon.outerHTML = getSvgIcon(newIconName, 'material-symbols-outlined', 24).replace('<svg', '<svg id="mobileThemeIcon"');
  }

  // 更新PC侧边栏图标
  const sidebarIcon = document.getElementById('sidebarThemeIcon');
  if (sidebarIcon) {
    const newIconName = effectiveTheme === 'dark' ? 'light_mode' : 'dark_mode';
    sidebarIcon.outerHTML = getSvgIcon(newIconName, 'material-symbols-outlined', 24).replace('<svg', '<svg id="sidebarThemeIcon"');
  }

  // 更新meta theme-color
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.content = effectiveTheme === 'dark' ? '#0D0D0D' : '#F4F4F1';
  }

  updateSettingsOptionButtons();
}

// 语言切换
function toggleLanguage() {
  const currentLang = normalizeLanguage(appState.language);
  const preferredChinese = normalizeLanguage(appState.languageToggleChinese || localStorage.getItem('rai_language_chinese_variant') || 'zh-CN');
  const newLang = currentLang === 'en' ? (isChineseLanguage(preferredChinese) ? preferredChinese : 'zh-CN') : 'en';
  setLanguage(newLang);
}

function updateAuthLanguageButtons() {
  document.querySelectorAll('.auth-lang-text-btn[data-lang]').forEach((button) => {
    const active = normalizeLanguage(button.dataset.lang) === normalizeLanguage(appState.language);
    button.classList.toggle('active-lang', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function setLanguage(lang) {
  lang = normalizeLanguage(lang);
  appState.language = lang;
  localStorage.setItem('rai_language', lang);
  if (isChineseLanguage(lang)) {
    appState.languageToggleChinese = lang;
    localStorage.setItem('rai_language_chinese_variant', lang);
  }

  // 更新HTML lang属性
  document.documentElement.lang = lang;

  // 更新所有翻译文本
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = i18n[lang]?.[key] || i18n['zh-CN']?.[key];
    if (translated) {
      el.textContent = translated;
    }
  });

  // 更新placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const translated = i18n[lang]?.[key] || i18n['zh-CN']?.[key];
    if (translated) {
      el.placeholder = translated;
    }
  });

  document.querySelectorAll('[data-language-option]').forEach((button) => {
    const option = button.getAttribute('data-language-option');
    button.textContent = LANGUAGE_OPTION_LABELS[option]?.[lang] || option;
  });

  // 更新移动端语言按钮文本
  const mobileLangText = document.getElementById('mobileLangText');
  if (mobileLangText) {
    mobileLangText.textContent = getLanguageToggleLabel(lang);
  }

  // 更新PC侧边栏语言按钮文本
  const sidebarLangText = document.getElementById('sidebarLangText');
  if (sidebarLangText) {
    sidebarLangText.textContent = getLanguageToggleLabel(lang);
  }
  document.querySelectorAll('.language-toggle-btn').forEach((button) => {
    button.setAttribute('aria-label', i18nText('language-label', 'Language'));
    button.setAttribute('title', i18nText('language-label', 'Language'));
  });

  // 更新登录页面语言按钮文本
  const authLangText = document.getElementById('authLangText');
  if (authLangText) {
    authLangText.textContent = getLanguageToggleLabel(lang);
  }
  updateAuthLanguageButtons();

  updateReasoningProfileControl();
  updateResearchModeControl();
  updatePoeQuotaHint();
  updateSettingsMembership();
  updateUserIdentityUI();
  updateSettingsNavigationUI();
  updatePwaInstallUI();
  renderSettingsTimeline();
  updateScrollResumeButton();
  if (!appState.isStreaming) {
    renderMessages();
  }
}

// 初始化主题和语言
function initThemeAndLanguage() {
  // 加载保存的主题
  const savedTheme = localStorage.getItem('rai_theme') || 'dark';
  setTheme(savedTheme);

  // 加载保存的语言
  const savedLanguage = normalizeLanguage(localStorage.getItem('rai_language') || 'zh-CN');
  appState.languageToggleChinese = normalizeLanguage(localStorage.getItem('rai_language_chinese_variant') || (isChineseLanguage(savedLanguage) ? savedLanguage : 'zh-CN'));
  setLanguage(savedLanguage);

  // 初始化PC侧边栏按钮状态
  const sidebarThemeIcon = document.getElementById('sidebarThemeIcon');
  if (sidebarThemeIcon) {
    const newIconName = appState.theme === 'dark' ? 'light_mode' : 'dark_mode';
    sidebarThemeIcon.outerHTML = getSvgIcon(newIconName, 'material-symbols-outlined', 24).replace('<svg', '<svg id="sidebarThemeIcon"');
  }

  const sidebarLangText = document.getElementById('sidebarLangText');
  if (sidebarLangText) {
    sidebarLangText.textContent = getLanguageToggleLabel(savedLanguage);
  }

  const systemThemeQuery = window.matchMedia?.('(prefers-color-scheme: light)');
  if (systemThemeQuery && !appState.systemThemeListenerBound) {
    const syncSystemTheme = () => {
      if (appState.themePreference === 'system') setTheme('system');
    };
    systemThemeQuery.addEventListener?.('change', syncSystemTheme);
    appState.systemThemeListenerBound = true;
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

  const domainModeMap = {
    write: 'writing',
    finance: 'finance',
    search: 'research',
    code: 'coding',
    translate: 'translation'
  };
  appState.pendingDomainMode = domainModeMap[action] || null;
  const isEnglish = String(appState.language || '').toLowerCase().startsWith('en');

  let text = '';
  switch (action) {
    case 'write':
      text = isEnglish ? 'Help me write something:' : '帮我写一篇文章：';
      break;
    case 'finance':
      text = isEnglish ? 'Analyze this stock or finance question:' : '帮我分析这只股票/财务问题：';
      if (!appState.internetMode) toggleInternet();
      break;
    case 'search':
      text = isEnglish ? 'Search:' : '搜索：';
      if (!appState.internetMode) toggleInternet();
      break;
    case 'code':
      text = isEnglish ? 'Help me write code:' : '帮我写代码：';
      break;
    case 'translate':
      text = isEnglish ? 'Translate:' : '翻译：';
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
  window.mobileKeyboardHandler?.syncComposerMetrics();
}

function handleInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function preserveMobileInputFocus() {
  window.mobileKeyboardHandler?.restoreInputFocus();
}

function focusMessageInputForNewChat(force = false) {
  if (window.innerWidth > 768) return;

  const input = document.getElementById('messageInput');
  if (!input || input.disabled) return;

  const shouldForceFocus = force || appState.pendingMobileComposerFocus;
  appState.pendingMobileComposerFocus = shouldForceFocus;

  if (appState.mobileComposerFocusTimer) {
    clearTimeout(appState.mobileComposerFocusTimer);
  }

  const runFocus = () => {
    if (window.innerWidth > 768) return;

    if (window.expandInput && !appState.inputExpanded) {
      window.expandInput();
    }

    requestAnimationFrame(() => {
      try {
        input.focus({ preventScroll: true });
      } catch (error) {
        input.focus();
      }

      const end = input.value.length;
      if (typeof input.setSelectionRange === 'function') {
        try {
          input.setSelectionRange(end, end);
        } catch (error) {
          console.debug('Skip mobile selection restore:', error);
        }
      }

      window.mobileKeyboardHandler?.keepChatAnchored?.(true);
    });
  };

  appState.mobileComposerFocusTimer = window.setTimeout(() => {
    runFocus();
    window.setTimeout(runFocus, 180);
    appState.mobileComposerFocusTimer = null;
    appState.pendingMobileComposerFocus = false;
  }, shouldForceFocus ? 24 : 72);
}

function maybeAutoFocusMobileHomeInput() {
  if (appState.mobileHomeAutoFocusUsed || window.innerWidth > 768) return;
  const welcomeScreen = document.getElementById('welcomeScreen');
  if (!welcomeScreen || welcomeScreen.classList.contains('hidden') || welcomeScreen.style.display === 'none') return;
  appState.mobileHomeAutoFocusUsed = true;
  appState.pendingMobileComposerFocus = true;
  window.setTimeout(() => focusMessageInputForNewChat(true), 260);
}

// ==================== ZTX6D SSO 配置 ====================
const RAI_TOKEN_KEY = 'rai_token';
const LEGACY_RAUTH_TOKEN_KEY = 'rauth_token';

function showAuthScreen() {
  document.getElementById('appContainer').style.display = 'none';
  document.getElementById('authContainer').classList.add('active');
}

function handleRaiTokenCallback() {
  const url = new URL(window.location.href);
  const tokenFromUrl = url.searchParams.get('rai_token') || url.searchParams.get('token');
  const authError = url.searchParams.get('auth_error');

  if (tokenFromUrl) {
    console.log(' 从 SSO 回调获取到 RAI token');
    localStorage.setItem(RAI_TOKEN_KEY, tokenFromUrl);
    localStorage.removeItem(LEGACY_RAUTH_TOKEN_KEY);
    url.searchParams.delete('rai_token');
    url.searchParams.delete('token');
    url.searchParams.delete('auth_provider');
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    return tokenFromUrl;
  }

  if (authError) {
    const message = isChineseLanguage(appState.language)
      ? `ZTX6D 登录失败: ${authError}`
      : `ZTX6D login failed: ${authError}`;
    const hasStoredToken = !!localStorage.getItem(RAI_TOKEN_KEY);
    url.searchParams.delete('auth_error');
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    setTimeout(() => {
      if (hasStoredToken) {
        showToast(message);
      } else {
        showAuthError(message);
      }
    }, 0);
  }

  return null;
}

let tauriAuthSyncPending = false;

async function syncTauriAuthStateFromStorage() {
  if (!RAI_IS_TAURI_DESKTOP || tauriAuthSyncPending) return false;

  let storedToken = '';
  try {
    storedToken = localStorage.getItem(RAI_TOKEN_KEY) || '';
  } catch (error) {
    return false;
  }

  if (!storedToken) {
    if (appState.token || appState.user) {
      appState.token = null;
      appState.user = null;
      appState.sessions = [];
      appState.messages = [];
      appState.currentSession = null;
      showAuthScreen();
    }
    return false;
  }

  if (storedToken === appState.token && appState.user) {
    await fetchUserMembership({ applyPolicy: true });
    updateUserAreaWithMembership();
    updateSettingsMembership();
    return true;
  }

  tauriAuthSyncPending = true;
  try {
    appState.token = storedToken;
    localStorage.removeItem(LEGACY_RAUTH_TOKEN_KEY);
    const valid = await verifyToken();
    if (!valid) {
      showAuthScreen();
      return false;
    }
    await fetchUserMembership({ applyPolicy: true });
    updateUserAreaWithMembership();
    updateSettingsMembership();
    return true;
  } finally {
    tauriAuthSyncPending = false;
  }
}

window.syncTauriAuthStateFromStorage = syncTauriAuthStateFromStorage;

function initTauriDesktopAuthSync() {
  if (!RAI_IS_TAURI_DESKTOP) return;

  window.addEventListener('focus', () => {
    syncTauriAuthStateFromStorage().catch((error) => console.warn('桌面端登录状态同步失败:', error));
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncTauriAuthStateFromStorage().catch((error) => console.warn('桌面端登录状态同步失败:', error));
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key === RAI_TOKEN_KEY || event.key === null) {
      syncTauriAuthStateFromStorage().catch((error) => console.warn('桌面端登录状态同步失败:', error));
    }
  });
}

async function loadZtx6dSsoStatus() {
  try {
    const response = await fetch(`${API_BASE}/auth/ztx6d/status`, { cache: 'no-store' });
    const data = await response.json();
    appState.ztx6dSsoEnabled = !!data?.enabled;
    appState.ztx6dBindUrl = String(data?.bindUrl || '/auth/ztx6d/bind/start').replace(/^\/api(?=\/)/, '');
  } catch (error) {
    appState.ztx6dSsoEnabled = false;
    console.warn(' ZTX6D SSO 状态检查失败:', error.message);
  } finally {
    const container = document.getElementById('ztx6dSsoContainer');
    if (container) {
      container.style.display = appState.ztx6dSsoEnabled ? 'grid' : 'none';
    }
    updateZtx6dBindingUI();
  }
}

function startZtx6dLogin() {
  const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/';
  window.location.href = `${API_BASE}/auth/ztx6d/start?return=${encodeURIComponent(returnPath)}`;
}

function showRpassPending() {
  showToast(i18nText('rpass-pending', isChineseLanguage(appState.language) ? 'rPass 登录待上线' : 'rPass login is coming soon'));
}

function updateZtx6dBindingUI() {
  const section = document.getElementById('ztx6dBindingSection');
  const statusEl = document.getElementById('ztx6dBindingStatus');
  const bindBtn = document.getElementById('ztx6dBindBtn');
  if (!section || !statusEl || !bindBtn) return;

  const externalProvider = appState.user?.externalProvider || appState.user?.external_provider || '';
  const externalUid = appState.user?.externalUid || appState.user?.external_uid || '';
  const isBound = externalProvider === 'ztx6d' && !!externalUid;

  section.style.display = (appState.ztx6dSsoEnabled || isBound) ? 'block' : 'none';

  if (isBound) {
    statusEl.textContent = `已绑定 ZTX6D UID ${externalUid}`;
    bindBtn.textContent = '已绑定';
    bindBtn.disabled = true;
    return;
  }

  if (!appState.ztx6dSsoEnabled) {
    statusEl.textContent = 'ZTX6D SSO 未配置';
    bindBtn.textContent = '绑定 ZTX6D';
    bindBtn.disabled = true;
    return;
  }

  statusEl.textContent = '未绑定，绑定后可直接使用 ZTX6D 登录当前 RAI 账号';
  bindBtn.textContent = '绑定 ZTX6D';
  bindBtn.disabled = false;
}

async function bindZtx6dAccount() {
  if (!appState.token) {
    showToast(isChineseLanguage(appState.language) ? '请先登录' : 'Please log in first');
    return;
  }

  if (!appState.ztx6dSsoEnabled) {
    showToast(isChineseLanguage(appState.language) ? 'ZTX6D SSO 未配置' : 'ZTX6D SSO is not configured');
    return;
  }

  const bindBtn = document.getElementById('ztx6dBindBtn');
  if (bindBtn) bindBtn.disabled = true;

  try {
    const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/';
    const response = await fetch(`${API_BASE}${appState.ztx6dBindUrl}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({ return: returnPath })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success || !data?.redirectUrl) {
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    window.location.href = data.redirectUrl;
  } catch (error) {
    if (bindBtn) bindBtn.disabled = false;
    showToast(`${isChineseLanguage(appState.language) ? '绑定失败' : 'Bind failed'}: ${error.message}`);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  console.log(' RAI v0.10.9.16 初始化 (Transparent Icon / App Download / Tauri Desktop Sync)');

  // 绑定输入容器点击和触摸事件（移动端支持）
  const inputContainer = document.getElementById('inputContainer');
  if (inputContainer) {
    inputContainer.addEventListener('click', handleInputContainerClick);
  }

  // 初始化主题和语言
  initThemeAndLanguage();
  initTauriDesktopAuthSync();
  syncDesktopSettingsVisibility();
  captureInviteRefFromUrl();
  initPwaInstallSupport();
  startAppVersionMonitor();
  await fetchModelAvailability();
  await loadZtx6dSsoStatus();

  // ==================== 认证流程 ====================
  // 1. 检测 URL 中是否有服务端 SSO 回调返回的 RAI token
  let token = handleRaiTokenCallback();

  // 2. 如果 URL 中没有 token，检查 localStorage
  if (!token) {
    token = localStorage.getItem(RAI_TOKEN_KEY);
  }

  // 3. 如果有 token，验证它
  if (token) {
    appState.token = token;
    localStorage.removeItem(LEGACY_RAUTH_TOKEN_KEY);
    const valid = await verifyToken();
    if (!valid) {
      showAuthScreen();
    }
  } else {
    // 4. 没有 token，显示本地登录；如 ZTX6D 已配置，会显示 SSO 按钮
    console.log(' 未找到有效 token，显示登录界面');
    showAuthScreen();
  }

  loadSettings();
  initSettingsInteractions();
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
    console.error(' 模型选择器元素未找到');
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

  if (dropdown) {
    dropdown.classList.remove('open');
  }

  syncModelMenuTriggerState(null);
}

// ==================== 工具栏功能 ====================

function resolveModelMenuAnchor(anchorOrId = null) {
  if (anchorOrId && typeof anchorOrId !== 'string') {
    return anchorOrId;
  }

  if (anchorOrId) {
    return document.getElementById(anchorOrId);
  }

  return document.getElementById(appState.activeModelMenuAnchorId)
    || document.getElementById('modelSelectCustom')
    || document.getElementById('mobileModelSelectCustom');
}

function getModelMenuPositionConfig(anchor) {
  if (anchor?.id === 'mobileModelSelectCustom') {
    return { align: 'center', vertical: 'below' };
  }

  return { align: 'right', vertical: 'above' };
}

function syncModelMenuTriggerState(activeAnchor = null) {
  document.querySelectorAll('.model-select-custom').forEach((trigger) => {
    trigger.classList.toggle('open', !!activeAnchor && trigger === activeAnchor);
  });
}

function positionFloatingMenu(menu, anchor, align = 'left', vertical = 'above') {
  if (!menu || !anchor) return;

  if (menu.parentElement !== document.body) {
    document.body.appendChild(menu);
  }

  const viewportPadding = 12;
  const gap = 8;
  const anchorRect = anchor.getBoundingClientRect();

  // 先临时定位到左上角以获取准确尺寸
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.style.bottom = 'auto';
  // 限制菜单最大高度为 anchor 上方可用空间
  const availableSpace = vertical === 'below'
    ? window.innerHeight - anchorRect.bottom - viewportPadding - gap
    : anchorRect.top - viewportPadding - gap;
  menu.style.maxHeight = `${Math.max(availableSpace, 200)}px`;

  const menuRect = menu.getBoundingClientRect();

  // 始终向上弹出（输入框在页面底部）
  let left;
  if (align === 'right') {
    left = anchorRect.right - menuRect.width;
  } else if (align === 'center') {
    left = anchorRect.left + ((anchorRect.width - menuRect.width) / 2);
  } else {
    left = anchorRect.left;
  }

  left = Math.max(viewportPadding, Math.min(left, window.innerWidth - menuRect.width - viewportPadding));

  menu.style.setProperty('--menu-origin-x', align === 'right' ? 'right' : align === 'center' ? 'center' : 'left');
  menu.style.setProperty('--menu-origin-y', vertical === 'below' ? 'top' : 'bottom');
  menu.style.left = `${Math.round(left)}px`;

  if (vertical === 'below') {
    const top = Math.max(
      viewportPadding,
      Math.min(anchorRect.bottom + gap, window.innerHeight - menuRect.height - viewportPadding)
    );
    menu.style.top = `${Math.round(top)}px`;
    menu.style.bottom = 'auto';
    return;
  }

  const bottom = Math.max(
    viewportPadding,
    Math.min(window.innerHeight - anchorRect.top + gap, window.innerHeight - viewportPadding)
  );
  menu.style.top = 'auto';
  menu.style.bottom = `${Math.round(bottom)}px`;
}

function repositionComposerMenus() {
  const moreMenu = document.getElementById('moreMenu');
  const moreBtn = document.getElementById('moreBtn');
  if (moreMenu?.classList.contains('active') && moreBtn) {
    positionFloatingMenu(moreMenu, moreBtn, 'left');
  }

  const modelMenu = document.getElementById('modelDropdownMenu');
  const modelBtn = resolveModelMenuAnchor();
  if (modelMenu?.classList.contains('active') && modelBtn) {
    const { align, vertical } = getModelMenuPositionConfig(modelBtn);
    positionFloatingMenu(modelMenu, modelBtn, align, vertical);
  }
}

function scheduleComposerMenuReposition(frames = 2) {
  let remaining = Math.max(1, frames);
  const tick = () => {
    repositionComposerMenus();
    remaining -= 1;
    if (remaining > 0) {
      requestAnimationFrame(tick);
    }
  };
  requestAnimationFrame(tick);
}

// 切换更多菜单显示/隐藏
function toggleMoreMenu() {
  const menu = document.getElementById('moreMenu');
  if (menu) {
    closeModelModal();
    menu.classList.toggle('active');

    if (menu.classList.contains('active')) {
      const internetToggle = document.getElementById('internetToggle');
      const thinkingToggle = document.getElementById('thinkingToggle');

      if (internetToggle) {
        internetToggle.classList.toggle('active', appState.internetMode);
      }
      if (thinkingToggle) {
        thinkingToggle.classList.toggle('active', appState.thinkingMode);
      }

      updateToolbarUI();
      updateReasoningProfileControl();
      updateResearchModeControl();
      updatePoeQuotaHint();
      positionFloatingMenu(menu, document.getElementById('moreBtn'), 'left');
    }
  }
}


// 点击外部关闭更多菜单
document.addEventListener('click', function (e) {
  const menu = document.getElementById('moreMenu');
  const moreBtn = document.getElementById('moreBtn');
  if (menu && menu.classList.contains('active')) {
    if (!menu.contains(e.target) && !moreBtn?.contains(e.target)) {
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

  console.log(` 联网模式: ${appState.internetMode ? '开启' : '关闭'}`);
  preserveMobileInputFocus();
}

// 从菜单切换推理模式
function toggleThinkingFromMenu(event) {
  event.stopPropagation(); // 防止关闭菜单
  const currentModel = MODELS[normalizeSelectedModelId(appState.selectedModel)];
  if (!currentModel?.supportsThinking) {
    appState.thinkingMode = false;
    updateToolbarUI();
    preserveMobileInputFocus();
    scheduleComposerMenuReposition(8);
    return;
  }
  if (isFreePoeMode()) {
    appState.thinkingMode = false;
    updateToolbarUI();
    preserveMobileInputFocus();
    scheduleComposerMenuReposition(8);
    return;
  }
  appState.thinkingMode = !appState.thinkingMode;
  updateToolbarUI();
  scheduleComposerMenuReposition(8);

  console.log(` 推理模式: ${appState.thinkingMode ? '开启' : '关闭'}`);
  preserveMobileInputFocus();
}

// 从菜单切换Agent模式
function toggleAgentFromMenu(event) {
  event?.stopPropagation?.();
  setResearchMode(getEffectiveResearchMode() === 'deep' ? 'fast' : 'deep', { enable: true });
}


// 从菜单触发文件上传
function handleFileUploadFromMenu() {
  const menu = document.getElementById('moreMenu');
  menu?.classList.remove('active');
  handleFileUpload();
}

// 原有的切换函数（向后兼容）
function toggleInternet() {
  appState.internetMode = !appState.internetMode;
  updateToolbarUI();
}

function toggleThinking() {
  if (isFreePoeMode()) {
    appState.thinkingMode = false;
    updateToolbarUI();
    return;
  }
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

function updateModelControls() {
  // 根据选择的模型显示/隐藏推理控件
  const thinkingControls = document.getElementById('thinkingControls');
  const selectedModel = appState.selectedModel;

  if (thinkingControls) {
    // DeepSeek模型和Kimi K2.5模型支持推理模式
    if (selectedModel === 'deepseek-v3' || selectedModel === 'deepseek-v3.2-speciale' ||
      selectedModel === 'kimi-k2.5' || selectedModel === 'kimi-k2') {
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
    console.warn(' 思考预算模态框元素未找到');
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
  const internetToggle = document.getElementById('internetToggle');
  const thinkingToggle = document.getElementById('thinkingToggle');
  const reasoningProfileItem = document.querySelector('.reasoning-profile-item');
  const thinkingMenuItem = thinkingToggle?.closest('.more-menu-item');
  const thinkingBtn = document.getElementById('thinkingBtn');
  const internetBtn = document.getElementById('internetBtn');
  const reasoningSelect = document.getElementById('reasoningProfileSelect');
  const reasoningSlider = document.getElementById('reasoningProfileSlider');
  const currentModel = MODELS[normalizeSelectedModelId(appState.selectedModel)];
  const supportsThinking = !!currentModel?.supportsThinking;
  const supportsReasoningProfile = supportsThinking && currentModel?.supportsReasoningProfile !== false;
  const forceDisableThinking = isFreePoeMode();
  appState.agentMode = false;

  if (forceDisableThinking) {
    appState.thinkingMode = false;
  }

  if (internetToggle) {
    internetToggle.classList.toggle('active', appState.internetMode);
  }

  if (thinkingToggle) {
    thinkingToggle.style.display = supportsThinking ? 'inline-flex' : 'none';
    thinkingToggle.classList.toggle('active', appState.thinkingMode);
    thinkingToggle.classList.toggle('disabled', forceDisableThinking || !supportsThinking);
  }

  if (thinkingMenuItem) {
    thinkingMenuItem.classList.toggle('is-disabled', forceDisableThinking);
  }

  if (thinkingBtn) {
    thinkingBtn.style.display = supportsThinking ? 'inline-flex' : 'none';
    thinkingBtn.classList.toggle('disabled', forceDisableThinking);
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

  const showReasoningProfile = supportsReasoningProfile && appState.thinkingMode && !forceDisableThinking;
  if (reasoningProfileItem) {
    reasoningProfileItem.style.display = showReasoningProfile ? 'flex' : 'none';
  }

  if (reasoningSelect || reasoningSlider) {
    if (showReasoningProfile) {
      updateReasoningProfileControl();
    }
  }
  updateResearchModeControl();
  updatePoeQuotaHint();
  if (document.getElementById('moreMenu')?.classList.contains('active')) {
    scheduleComposerMenuReposition(6);
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
      const numericValue = Number(value);
      if (name === 'topP' && Number.isFinite(numericValue)) {
        element.textContent = numericValue.toFixed(2);
      } else if ((name === 'frequency' || name === 'presence' || name === 'temperature') && Number.isFinite(numericValue)) {
        element.textContent = numericValue.toFixed(1);
      } else {
        element.textContent = value;
      }
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

  updateUserIdentityUI();
  clearSettingsPasswordInputs();
  updateZtx6dBindingUI();
  updateSettingsNavigationUI();
  renderSettingsTimeline();
  updateSettingsDirtyState();
}

// 修复：改进updateModelControls函数，添加null检查
function updateModelControls() {
  appState.selectedModel = normalizeSelectedModelId(appState.selectedModel);
  applyFreePoeThinkingPolicy();
  const model = MODELS[appState.selectedModel];

  if (!model) {
    console.warn(` 未找到模型配置: ${appState.selectedModel}`);
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
    if (appState.thinkingMode && !isFreePoeMode()) {
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
  appState.selectedModel = normalizeSelectedModelId(appState.selectedModel);
  const model = MODELS[appState.selectedModel];

  if (!model || !model.supportsThinking) {
    console.warn(' 当前模型不支持思考模式');
    return;
  }
  if (isFreePoeMode()) {
    appState.thinkingMode = false;
    updateModelControls();
    updateToolbarUI();
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

  //  修复：如果没有"-"格式，尝试提取第一句有意义的文本
  const firstMeaningful = rawContent.trim().split(/[\n.!?。！？]/)[0]?.trim();
  if (firstMeaningful && firstMeaningful.length > 5) {
    return firstMeaningful.length > 40 ? firstMeaningful.substring(0, 40) + '...' : firstMeaningful;
  }

  //  修复：返回默认文本而不是空字符串
  return isChineseLanguage(appState.language) ? 'AI 正在分析内容...' : 'AI is analyzing...';
}

// 更新预览文本
function updateThinkingPreview(previewText) {
  const previewEl = document.getElementById('thinkingPreviewText');
  const previewContainer = document.getElementById('thinkingPreview');

  if (previewEl && previewText) {
    previewEl.textContent = previewText;
    if (previewContainer) previewContainer.style.display = 'inline-flex';
  } else if (previewContainer && !previewText) {
    //  修复：如果没有预览文本，隐藏容器避免显示空条
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
            <span class="toggle-text">${isChineseLanguage(appState.language) ? '收起思路' : 'Hide'}</span>
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
            <span class="toggle-text">${isChineseLanguage(appState.language) ? '收起思路' : 'Hide'}</span>
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
function openModelModal(anchorOrId = null) {
  const menu = document.getElementById('modelDropdownMenu');
  const selector = resolveModelMenuAnchor(anchorOrId);
  if (!menu || !selector) return;

  if (menu.classList.contains('active') && appState.activeModelMenuAnchorId === selector.id) {
    closeModelModal();
  } else {
    const moreMenu = document.getElementById('moreMenu');
    moreMenu?.classList.remove('active');
    menu.classList.remove('closing');
    menu.classList.add('active');
    appState.activeModelMenuAnchorId = selector.id;
    syncModelMenuTriggerState(selector);
    updateMenuSelection();
    const { align, vertical } = getModelMenuPositionConfig(selector);
    positionFloatingMenu(menu, selector, align, vertical);
    scheduleComposerMenuReposition();
  }
}

function closeModelModal() {
  const menu = document.getElementById('modelDropdownMenu');
  syncModelMenuTriggerState(null);
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
  const arrow = document.getElementById('allModelsArrow');

  if (section && toggleItem) {
    if (section._hideTimer) {
      clearTimeout(section._hideTimer);
      section._hideTimer = null;
    }

    const isExpanded = section.classList.contains('expanded');

    if (!isExpanded) {
      section.style.display = 'block';
      section.style.maxHeight = '0px';
      section.style.opacity = '0';
      section.style.transform = 'translateY(-4px)';
      void section.offsetHeight;
      section.classList.add('expanded');
      section.style.maxHeight = `${section.scrollHeight}px`;
      section.style.opacity = '1';
      section.style.transform = 'translateY(0)';
      toggleItem.classList.add('expanded');
      arrow?.classList.add('expanded');
    } else {
      section.style.maxHeight = `${section.scrollHeight}px`;
      void section.offsetHeight;
      section.classList.remove('expanded');
      section.style.maxHeight = '0px';
      section.style.opacity = '0';
      section.style.transform = 'translateY(-4px)';
      toggleItem.classList.remove('expanded');
      arrow?.classList.remove('expanded');
      section._hideTimer = window.setTimeout(() => {
        if (!section.classList.contains('expanded')) {
          section.style.display = 'none';
        }
        section._hideTimer = null;
      }, 220);
    }

    scheduleComposerMenuReposition(8);
  }
}

function updateMenuSelection() {
  const items = document.querySelectorAll('.model-menu-item');
  items.forEach(item => {
    const modelValue = item.getAttribute('data-model');
    const adminHidden = isModelDisabledByAdmin(modelValue);
    item.classList.toggle('admin-model-hidden', adminHidden);
    if (modelValue === appState.selectedModel) {
      item.classList.add('selected');
    } else {
      item.classList.remove('selected');
    }
    const requiredMembership = String(item.getAttribute('data-required-membership') || '').trim().toLowerCase();
    const locked = requiredMembership === 'max' && !isMaxMembershipUser();
    item.classList.toggle('membership-locked', locked);
    item.classList.toggle('membership-available', requiredMembership === 'max' && !locked);
  });

  document.querySelectorAll('.model-card').forEach((card) => {
    const modelValue = card.getAttribute('data-model');
    card.classList.toggle('admin-model-hidden', isModelDisabledByAdmin(modelValue));
    const requiredMembership = String(card.getAttribute('data-required-membership') || '').trim().toLowerCase();
    const locked = requiredMembership === 'max' && !isMaxMembershipUser();
    card.classList.toggle('membership-locked', locked);
    card.classList.toggle('membership-available', requiredMembership === 'max' && !locked);
  });

  ['claude-haiku', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-3-haiku'].forEach((modelId) => {
    document.querySelectorAll(`#regenerateModelSelect option[value="${modelId}"]`).forEach((option) => {
      option.disabled = !isMaxMembershipUser() || isModelDisabledByAdmin(modelId);
    });
  });

  document.querySelectorAll('#regenerateModelSelect option').forEach((option) => {
    option.hidden = isModelDisabledByAdmin(option.value);
    if (isModelDisabledByAdmin(option.value)) option.disabled = true;
  });
}

function getModelDisplayMeta(modelId) {
  const normalized = normalizeSelectedModelId(modelId);
  if (normalized === 'auto') {
    return { i18nKey: 'model-smart', fallback: 'Smart Model' };
  }
  if (normalized === 'qwen2.5-7b' || normalized === 'qwen3-8b') {
    return { i18nKey: 'model-fast', fallback: 'Fast Mode' };
  }
  if (normalized === 'kimi-k2.5' || normalized === 'kimi-k2') {
    return { i18nKey: 'model-expert', fallback: 'Expert Mode' };
  }
  return { i18nKey: null, fallback: MODELS[normalized]?.name || normalized };
}

function updateSelectedModelText(modelId = appState.selectedModel) {
  const selectedTextNodes = document.querySelectorAll('[data-model-label]');
  if (!selectedTextNodes.length) return;

  const meta = getModelDisplayMeta(modelId);
  selectedTextNodes.forEach((selectedText) => {
    if (meta.i18nKey && i18n?.[appState.language]?.[meta.i18nKey]) {
      selectedText.textContent = i18n[appState.language][meta.i18nKey];
      selectedText.setAttribute('data-i18n', meta.i18nKey);
    } else {
      selectedText.textContent = meta.fallback;
      selectedText.removeAttribute('data-i18n');
    }
  });
}

function persistDefaultModelPreference(modelId = appState.selectedModel) {
  const membership = String(userMembershipState?.membership || 'free');
  if (!appState.token || membership === 'free') return;

  fetch(`${API_BASE}/user/config`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${appState.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      theme: appState.themePreference || appState.theme,
      default_model: normalizeSelectedModelId(modelId),
      temperature: appState.temperature,
      top_p: appState.topP,
      max_tokens: appState.maxTokens,
      frequency_penalty: appState.frequencyPenalty,
      presence_penalty: appState.presencePenalty,
      system_prompt: appState.systemPrompt || '',
      thinking_mode: appState.thinkingMode ? 1 : 0,
      internet_mode: appState.internetMode ? 1 : 0
    })
  }).then((res) => res.json())
    .then((data) => {
      if (data?.success) {
        appState.profileDefaultModel = normalizeSelectedModelId(modelId);
      } else if (data?.error) {
        console.warn(' 保存默认模型失败:', data.error);
      }
    })
    .catch((err) => console.error(' 保存默认模型网络错误:', err));
}

function selectModelFromMenu(model, displayName, i18nKey) {
  if (isModelDisabledByAdmin(model)) {
    appState.selectedModel = 'auto';
    updateSelectedModelText('auto');
    updateModelControls();
    updateMenuSelection();
    closeModelModal();
    return;
  }
  if (isMembershipLockedModel(model)) {
    console.warn(' 该模型仅 MAX 会员可用');
    return;
  }
  appState.selectedModel = normalizeSelectedModelId(model);
  if (isHiddenModelId(model)) {
    console.log(' Poe models are hidden. Fallback to auto model.');
  }
  applyFreePoeThinkingPolicy();
  updateSelectedModelText(appState.selectedModel);

  updateModelControls();
  updateMenuSelection();
  updatePoeQuotaHint();
  closeModelModal();
  persistDefaultModelPreference(appState.selectedModel);
  preserveMobileInputFocus();

  console.log(` 已切换模型: ${appState.selectedModel} (${displayName})`);
}

function selectModelFromModal(model, displayName) {
  if (isMembershipLockedModel(model)) {
    selectModelFromMenu(model, displayName || model, null);
    return;
  }
  selectModelFromMenu(model, displayName || model, null);
  const modelModal = document.getElementById('modelModal');
  if (modelModal) {
    modelModal.classList.remove('active');
  }
}

// 点击页面其他地方关闭下拉菜单
document.addEventListener('click', (e) => {
  const menu = document.getElementById('modelDropdownMenu');
  const isClickInsideTrigger = Array.from(document.querySelectorAll('.model-select-custom'))
    .some((selector) => selector.contains(e.target));

  if (menu) {
    if (!menu.contains(e.target) && !isClickInsideTrigger) {
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
    const isMobileSettings = isSettingsMobileLayout();
    if (settingsModal._closeTimer) {
      clearTimeout(settingsModal._closeTimer);
      settingsModal._closeTimer = null;
    }
    settingsModal.classList.remove('closing');
    settingsModal.classList.add('active');
    appState.settingsOpen = true;
    updateSettingsUI();
    updatePwaInstallUI();
    appState.settingsMobileMode = isMobileSettings ? 'home' : 'detail';
    switchSettingsSection(appState.activeSettingsSection || 'language', { keepMobileHome: isMobileSettings });
    syncSettingsResponsiveLayout();
    if (isMobileSettings) {
      appState.settingsHistoryDepth = 0;
      pushSettingsHistory('home', appState.activeSettingsSection || 'language');
    }
    updateZtx6dBindingUI();
  }
}

// 修复：改进closeSettings函数
function closeSettings(options = {}) {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal) {
    if (!settingsModal.classList.contains('active')) return;
    if (!options.fromHistory && !options.skipHistory && isSettingsMobileLayout() && appState.settingsOpen) {
      const depth = appState.settingsHistoryDepth || (currentSettingsHistoryState() ? 1 : 0);
      if (depth > 0) {
        window.history.go(-depth);
      }
    }
    settingsModal.classList.add('closing');
    appState.settingsOpen = false;
    appState.settingsHistoryDepth = 0;
    settingsModal._closeTimer = setTimeout(() => {
      settingsModal.classList.remove('active', 'closing');
      settingsModal._closeTimer = null;
    }, 320);
  }
}

// 点击空白处关闭设置
document.addEventListener('click', (e) => {
  const settingsModal = document.getElementById('settingsModal');
  if (settingsModal && e.target === settingsModal) {
    closeSettings();
  }
});

window.addEventListener('popstate', (event) => {
  if (!appState.settingsOpen || !isSettingsMobileLayout()) return;

  const state = event.state;
  if (!state || state.raiSettings !== true) {
    closeSettings({ fromHistory: true });
    return;
  }

  if (state.settingsMode === 'detail') {
    appState.settingsHistoryDepth = 2;
    switchSettingsSection(state.settingsSection || appState.activeSettingsSection || 'language', { fromHistory: true });
    updateSettingsMobileMode('detail');
  } else {
    appState.settingsHistoryDepth = 1;
    showSettingsMobileHome({ fromHistory: true });
  }
});

// 修复：改进saveSettings函数，添加null检查
async function saveSettings(options = {}) {
  const closeAfterSave = options?.closeAfterSave === true;
  const temperatureSlider = document.getElementById('temperatureSlider');
  const topPSlider = document.getElementById('topPSlider');
  const maxTokensSlider = document.getElementById('maxTokensSlider');
  const frequencySlider = document.getElementById('frequencySlider');
  const presenceSlider = document.getElementById('presenceSlider');
  const systemPromptEl = document.getElementById('systemPrompt');
  const usernameInput = document.getElementById('settingsUsernameInput');
  const emailInput = document.getElementById('settingsEmailInput');
  const currentPasswordInput = document.getElementById('settingsCurrentPasswordInput');
  const newPasswordInput = document.getElementById('settingsNewPasswordInput');
  const confirmPasswordInput = document.getElementById('settingsConfirmPasswordInput');

  if (!temperatureSlider || !topPSlider || !maxTokensSlider) {
    console.error(' 设置表单元素未找到');
    return;
  }

  const temperature = parseFloat(temperatureSlider.value);
  const topP = parseFloat(topPSlider.value);
  const maxTokens = parseInt(maxTokensSlider.value, 10);
  const frequencyPenalty = parseFloat(frequencySlider?.value || 0);
  const presencePenalty = parseFloat(presenceSlider?.value || 0);
  //  修复：确保systemPrompt正确读取和处理，处理空字符串和null
  const systemPrompt = (systemPromptEl?.value || '').trim();
  const nextUsername = (usernameInput?.value || '').trim();
  const nextEmail = (emailInput?.value || '').trim();
  const currentPassword = currentPasswordInput?.value || '';
  const newPassword = newPasswordInput?.value || '';
  const confirmPassword = confirmPasswordInput?.value || '';
  const shouldUpdatePassword = [currentPassword, newPassword, confirmPassword].some((value) => String(value || '').length > 0);

  if (isNaN(temperature) || isNaN(topP) || isNaN(maxTokens)) {
    console.error(' 参数值无效');
    return;
  }

  if (!nextEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
    showToast(i18nText('invalid-email-error', isChineseLanguage(appState.language) ? '请输入有效的邮箱地址' : 'Please enter a valid email address'));
    emailInput?.focus();
    return;
  }

  if (nextUsername.length > 80) {
    showToast(i18nText('username-too-long-error', isChineseLanguage(appState.language) ? '用户名不能超过 80 个字符' : 'Username must be 80 characters or fewer'));
    usernameInput?.focus();
    return;
  }

  if (shouldUpdatePassword) {
    if (!currentPassword) {
      showToast(i18nText('password-current-required-error', isChineseLanguage(appState.language) ? '修改密码时必须输入当前密码' : 'Current password is required to change password'));
      currentPasswordInput?.focus();
      return;
    }
    if (!newPassword) {
      showToast(i18nText('password-new-required-error', isChineseLanguage(appState.language) ? '请输入新密码' : 'Please enter a new password'));
      newPasswordInput?.focus();
      return;
    }
    if (!confirmPassword) {
      showToast(i18nText('password-confirm-required-error', isChineseLanguage(appState.language) ? '请再次输入新密码' : 'Please confirm the new password'));
      confirmPasswordInput?.focus();
      return;
    }
    if (newPassword.length < 6) {
      showToast(i18nText('password-too-short-error', isChineseLanguage(appState.language) ? '新密码至少需要 6 位字符' : 'New password must be at least 6 characters'));
      newPasswordInput?.focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast(i18nText('password-confirm-mismatch-error', isChineseLanguage(appState.language) ? '两次输入的新密码不一致' : 'The new passwords do not match'));
      confirmPasswordInput?.focus();
      return;
    }
    if (newPassword === currentPassword) {
      showToast(i18nText('password-same-as-current-error', isChineseLanguage(appState.language) ? '新密码不能与当前密码相同' : 'New password must be different from current password'));
      newPasswordInput?.focus();
      return;
    }
  }

  appState.temperature = temperature;
  appState.topP = topP;
  appState.maxTokens = maxTokens;
  appState.frequencyPenalty = frequencyPenalty;
  appState.presencePenalty = presencePenalty;
  appState.systemPrompt = systemPrompt;  //  保存trimmed版本

  const settings = {
    temperature,
    topP,
    maxTokens,
    frequencyPenalty,
    presencePenalty,
    systemPrompt
  };
  localStorage.setItem('rai_settings', JSON.stringify(settings));

  let profileUpdated = false;
  let passwordUpdated = false;
  let configUpdated = !appState.token;
  setSettingsSaveButtonState(true);

  try {
    if (appState.token) {
      const currentEmail = String(appState.user?.email || '').trim();
      const currentUsername = String(appState.user?.username || '').trim();
      const shouldUpdateProfile = nextEmail !== currentEmail || nextUsername !== currentUsername;

      if (shouldUpdatePassword) {
        const passwordResponse = await fetch(`${API_BASE}/user/password`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${appState.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            currentPassword,
            newPassword
          })
        });

        const passwordData = await passwordResponse.json();
        if (!passwordResponse.ok || !passwordData?.success) {
          throw new Error(passwordData?.error || i18nText('settings-save-failed', isChineseLanguage(appState.language) ? '保存失败，请重试' : 'Save failed, please try again'));
        }

        passwordUpdated = true;
        console.log(' 用户密码已更新');
      }

      if (shouldUpdateProfile) {
        const profileResponse = await fetch(`${API_BASE}/user/profile`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${appState.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: nextEmail,
            username: nextUsername
          })
        });

        const profileData = await profileResponse.json();
        if (!profileResponse.ok || !profileData?.success) {
          throw new Error(profileData?.error || i18nText('settings-save-failed', isChineseLanguage(appState.language) ? '保存失败，请重试' : 'Save failed, please try again'));
        }

        if (profileData.token) {
          appState.token = profileData.token;
          localStorage.setItem(RAI_TOKEN_KEY, profileData.token);
        }

        if (profileData.user) {
          appState.user = {
            ...appState.user,
            id: profileData.user.id || appState.user?.id || null,
            username: String(profileData.user.username || nextUsername || nextEmail.split('@')[0] || '').trim(),
            email: String(profileData.user.email || nextEmail).trim(),
            avatar_url: profileData.user.avatar_url || appState.user?.avatar_url || null,
            externalProvider: profileData.user.external_provider || appState.user?.externalProvider || null,
            externalUid: profileData.user.external_uid || appState.user?.externalUid || null,
            external_provider: profileData.user.external_provider || appState.user?.external_provider || null,
            external_uid: profileData.user.external_uid || appState.user?.external_uid || null
          };
        }

        profileUpdated = true;
      }

      console.log(` 正在将设置同步到云端...`);
      console.log(`   系统提示词长度: ${systemPrompt.length}字符`);

      const configResponse = await fetch(`${API_BASE}/user/config`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${appState.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          theme: appState.themePreference || appState.theme,
          default_model: appState.selectedModel,
          temperature,
          top_p: topP,
          max_tokens: maxTokens,
          frequency_penalty: frequencyPenalty,
          presence_penalty: presencePenalty,
          system_prompt: systemPrompt,
          thinking_mode: appState.thinkingMode ? 1 : 0,
          internet_mode: appState.internetMode ? 1 : 0
        })
      });

      const configData = await configResponse.json();
      if (!configResponse.ok || !configData?.success) {
        throw new Error(configData?.error || i18nText('settings-save-failed', isChineseLanguage(appState.language) ? '保存失败，请重试' : 'Save failed, please try again'));
      }

      console.log(' 云端配置已同步');
      configUpdated = true;
    }

    updateUserIdentityUI();
    clearSettingsPasswordInputs();
    updateSettingsUI();
    if (closeAfterSave) {
      closeSettings();
    } else {
      switchSettingsSection(appState.activeSettingsSection || 'language');
      updateSettingsDirtyState();
    }
    let successKey = 'settings-save-success';
    let successFallback = isChineseLanguage(appState.language) ? '设置已保存' : 'Settings saved';
    if (profileUpdated && passwordUpdated) {
      successKey = 'settings-save-success-full';
      successFallback = isChineseLanguage(appState.language) ? '账号信息、密码和设置已保存' : 'Account, password, and settings saved';
    } else if (profileUpdated) {
      successKey = 'settings-save-success-profile';
      successFallback = isChineseLanguage(appState.language) ? '账号信息和设置已保存' : 'Account and settings saved';
    } else if (passwordUpdated) {
      successKey = 'settings-save-success-password';
      successFallback = isChineseLanguage(appState.language) ? '密码和设置已保存' : 'Password and settings saved';
    }
    showToast(i18nText(successKey, successFallback));
    console.log(' 设置已保存本地并同步云端');
  } catch (error) {
    console.error(' 保存设置失败:', error);
    if ((profileUpdated || passwordUpdated) && !configUpdated) {
      showToast(i18nText(
        'settings-save-partial',
        isChineseLanguage(appState.language) ? '部分内容已保存，但配置同步失败' : 'Part of your changes were saved, but config sync failed'
      ));
      return;
    }
    showToast(error.message || i18nText('settings-save-failed', isChineseLanguage(appState.language) ? '保存失败，请重试' : 'Save failed, please try again'));
    return;
  } finally {
    setSettingsSaveButtonState(false);
  }
}

// 修复事件处理器中inline onclick处理和事件委托问题，避免undefined引用

// 修复：改进renderMessages，防止事件处理中的undefined错误
function renderMessages() {
  const container = document.getElementById('messagesList');
  const welcome = document.getElementById('welcomeScreen');

  if (!container || !welcome) {
    console.error(' 消息容器或欢迎屏幕未找到');
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
  setScrollFollowMode('following');
  scrollToBottom(true);

  //  渲染 Mermaid 图表
  setTimeout(() => renderMermaidCharts(), 100);

  //  处理代码块：添加语言标签、复制按钮、语法高亮
  setTimeout(() => processCodeBlocks(container), 50);

  //  更新对话索引导航器
  setTimeout(() => renderChatIndexTimeline(), 150);
}

function normalizeAskUserQuestion(rawQuestion) {
  if (!rawQuestion || typeof rawQuestion !== 'object') return null;

  const question = String(rawQuestion.question || rawQuestion.title || '').trim();
  const rawOptions = Array.isArray(rawQuestion.options)
    ? rawQuestion.options
    : (Array.isArray(rawQuestion.choices) ? rawQuestion.choices : []);
  const options = rawOptions
    .map((option) => String(option || '').trim())
    .filter(Boolean);
  const placeholder = String(rawQuestion.placeholder || rawQuestion.inputPlaceholder || '').trim();

  if (!question || (options.length === 0 && !placeholder)) return null;

  return {
    question,
    options,
    placeholder: placeholder || (isChineseLanguage(appState.language) ? '输入其他回答，按 Enter 记录' : 'Type another answer and press Enter to record')
  };
}

function parseAskUserPayload(rawPayload, options = {}) {
  const silent = Boolean(options.silent);
  try {
    const payload = String(rawPayload || '').trim();
    if (!payload || payload[0] !== '{') return null;

    const data = JSON.parse(payload);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    const hasQuestionList = Array.isArray(data.questions);
    const hasSingleQuestion = typeof data.question === 'string';
    if (!hasQuestionList && !hasSingleQuestion) return null;

    const rawQuestions = hasQuestionList ? data.questions : [data];
    const questions = rawQuestions
      .map((question) => normalizeAskUserQuestion(question))
      .filter(Boolean);

    if (questions.length === 0) return null;

    return {
      intro: hasQuestionList ? String(data.title || data.intro || '').trim() : '',
      questions,
      action: String(data.action || '').trim(),
      meta: data.meta && typeof data.meta === 'object' ? data.meta : null
    };
  } catch (error) {
    if (!silent) console.warn('询问用户工具解析失败:', error);
    return null;
  }
}

function isAskUserCodeLanguage(language = '') {
  return /^(?:rai[_-]?ask[_-]?user|ask[_-]?user|询问用户)$/i.test(String(language || '').trim());
}

function isImplicitAskUserFenceLanguage(language = '') {
  return /^(?:|json|javascript|js)$/i.test(String(language || '').trim());
}

function looksLikeAskUserPayloadPrefix(rawPayload = '') {
  const payload = String(rawPayload || '').trim();
  return payload.startsWith('{')
    && /"(?:question|questions)"\s*:/.test(payload)
    && /"(?:options|choices|placeholder|inputPlaceholder)"\s*:/.test(payload);
}

function findJsonObjectEnd(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

function getLineStartIndex(text, index) {
  const prevNewline = text.lastIndexOf('\n', index);
  return prevNewline === -1 ? 0 : prevNewline + 1;
}

function getLineEndIndex(text, index) {
  const nextNewline = text.indexOf('\n', index);
  return nextNewline === -1 ? text.length : nextNewline;
}

function getNextLineStart(text, lineEnd) {
  if (lineEnd >= text.length) return text.length;
  return lineEnd + 1;
}

function getPreviousLineBounds(text, lineStart) {
  const previousEnd = Math.max(0, lineStart - 1);
  const previousStart = getLineStartIndex(text, Math.max(0, previousEnd - 1));
  return {
    start: previousStart,
    end: previousEnd
  };
}

function extractAskUserFencedBlocks(content) {
  const source = String(content || '');
  const prompts = [];
  const fenceStartRegex = /```([^\r\n`]*)\r?\n/g;
  let output = '';
  let cursor = 0;
  let match;

  while ((match = fenceStartRegex.exec(source)) !== null) {
    const fenceStart = match.index;
    const payloadStart = fenceStartRegex.lastIndex;
    const closingRegex = /\r?\n```/g;
    closingRegex.lastIndex = payloadStart;
    const closingMatch = closingRegex.exec(source);

    if (!closingMatch) break;

    const language = String(match[1] || '').trim();
    const rawPayload = source.slice(payloadStart, closingMatch.index);
    const prompt = parseAskUserPayload(rawPayload, { silent: true });
    const explicitAskUserFence = isAskUserCodeLanguage(language);
    const implicitAskUserFence = isImplicitAskUserFenceLanguage(language) && prompt;

    if (prompt && (explicitAskUserFence || implicitAskUserFence)) {
      output += source.slice(cursor, fenceStart);
      prompts.push(prompt);
      cursor = closingMatch.index + closingMatch[0].length;
    }

    fenceStartRegex.lastIndex = closingMatch.index + closingMatch[0].length;
  }

  output += source.slice(cursor);
  return { text: output, prompts };
}

function extractStandaloneAskUserJsonBlocks(content) {
  const source = String(content || '');
  const prompts = [];
  let output = '';
  let cursor = 0;
  let searchIndex = 0;

  while (searchIndex < source.length) {
    const objectStart = source.indexOf('{', searchIndex);
    if (objectStart === -1) break;

    const lineStart = getLineStartIndex(source, objectStart);
    if (source.slice(lineStart, objectStart).trim()) {
      searchIndex = objectStart + 1;
      continue;
    }

    const objectEnd = findJsonObjectEnd(source, objectStart);
    if (objectEnd === -1) break;

    const payload = source.slice(objectStart, objectEnd + 1);
    const prompt = parseAskUserPayload(payload, { silent: true });
    if (!prompt) {
      searchIndex = objectStart + 1;
      continue;
    }

    const lineEnd = getLineEndIndex(source, objectEnd + 1);
    const trailingOnLine = source.slice(objectEnd + 1, lineEnd).trim();
    if (trailingOnLine) {
      searchIndex = objectStart + 1;
      continue;
    }

    let removeEnd = lineEnd;
    let removeStart = lineStart;
    const prevLine = getPreviousLineBounds(source, lineStart);
    const prevText = source.slice(prevLine.start, prevLine.end).trim();
    if (/^```(?:\s*(?:json|javascript|js|rai[_-]?ask[_-]?user|ask[_-]?user|询问用户)?)?$/i.test(prevText)) {
      removeStart = prevLine.start;
    }
    const nextLineStart = getNextLineStart(source, lineEnd);
    const nextLineEnd = getLineEndIndex(source, nextLineStart);
    if (source.slice(nextLineStart, nextLineEnd).trim() === '```') {
      removeEnd = nextLineEnd;
    }

    output += source.slice(cursor, removeStart);
    prompts.push(prompt);
    cursor = removeEnd;
    searchIndex = removeEnd;
  }

  output += source.slice(cursor);
  return { text: output, prompts };
}

function stripIncompleteAskUserFence(content) {
  const source = String(content || '');
  const fenceStartRegex = /```([^\r\n`]*)\r?\n/g;
  let match;
  let lastOpenFence = null;

  while ((match = fenceStartRegex.exec(source)) !== null) {
    const closingRegex = /\r?\n```/g;
    closingRegex.lastIndex = fenceStartRegex.lastIndex;
    const closingMatch = closingRegex.exec(source);
    if (!closingMatch) {
      lastOpenFence = {
        index: match.index,
        payloadStart: fenceStartRegex.lastIndex,
        language: String(match[1] || '').trim()
      };
      break;
    }
    fenceStartRegex.lastIndex = closingMatch.index + closingMatch[0].length;
  }

  if (!lastOpenFence) return source;

  const payload = source.slice(lastOpenFence.payloadStart);
  const shouldHide = isAskUserCodeLanguage(lastOpenFence.language)
    || (isImplicitAskUserFenceLanguage(lastOpenFence.language) && looksLikeAskUserPayloadPrefix(payload));

  return shouldHide ? source.slice(0, lastOpenFence.index) : source;
}

function extractAskUserBlocks(content) {
  const fencedResult = extractAskUserFencedBlocks(content);
  const standaloneResult = extractStandaloneAskUserJsonBlocks(fencedResult.text);
  const prompts = [...fencedResult.prompts, ...standaloneResult.prompts];
  const text = standaloneResult.text.trim();

  return { text, prompts };
}

function stripAskUserBlocksForStreaming(content) {
  const extracted = extractAskUserBlocks(content);
  return stripIncompleteAskUserFence(extracted.text).trim();
}

const askUserCardState = new Map();

function getAskUserStateKey(prompt) {
  try {
    return JSON.stringify({
      action: prompt?.action || '',
      questions: (prompt?.questions || []).map((question) => ({
        question: question.question,
        options: question.options,
        placeholder: question.placeholder
      }))
    });
  } catch (error) {
    return `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function formatAskUserAnswers(prompt, answers) {
  if (!prompt || !Array.isArray(prompt.questions)) return String(answers?.[0] || '').trim();
  if (prompt.questions.length === 1) return String(answers?.[0] || '').trim();

  return prompt.questions
    .map((question, index) => {
      const answer = String(answers?.[index] || '').trim();
      return `${index + 1}. ${question.question}\n回答：${answer}`;
    })
    .join('\n\n');
}

function createAskUserCard(prompt, renderOptions = {}) {
  const card = document.createElement('div');
  card.className = 'ask-user-card';
  if (prompt.questions.length > 1) {
    card.classList.add('multi-question');
  }
  card.dataset.askAction = prompt.action || '';
  const stateKey = renderOptions.stateKey || getAskUserStateKey(prompt);
  card.dataset.askStateKey = stateKey;
  const existingState = askUserCardState.get(stateKey) || {};
  const answers = Array.isArray(existingState.answers)
    ? [...existingState.answers]
    : new Array(prompt.questions.length).fill('');
  while (answers.length < prompt.questions.length) answers.push('');
  const answered = existingState.submitted === true;

  const persistState = (submitted = false) => {
    askUserCardState.set(stateKey, {
      answers: [...answers],
      submitted: submitted || askUserCardState.get(stateKey)?.submitted === true
    });
  };

  if (prompt.intro) {
    const intro = document.createElement('div');
    intro.className = 'ask-user-intro';
    intro.textContent = prompt.intro;
    card.appendChild(intro);
  }

  const progress = document.createElement('div');
  progress.className = 'ask-user-progress';

  const footer = document.createElement('div');
  footer.className = 'ask-user-footer';

  const sendAllBtn = document.createElement('button');
  sendAllBtn.type = 'button';
  sendAllBtn.className = 'ask-user-send-all';
  sendAllBtn.textContent = isChineseLanguage(appState.language) ? '发送选择' : 'Send choices';

  const updateFooter = () => {
    const answeredCount = answers.filter(Boolean).length;
    const total = prompt.questions.length;
    progress.textContent = isChineseLanguage(appState.language)
      ? `已选择 ${answeredCount}/${total}`
      : `${answeredCount}/${total} selected`;
    sendAllBtn.disabled = answered || answeredCount < total || card.dataset.submitting === '1';
  };

  prompt.questions.forEach((questionData, questionIndex) => {
    const block = document.createElement('div');
    block.className = 'ask-user-question-block';

    const question = document.createElement('div');
    question.className = 'ask-user-question';
    question.textContent = prompt.questions.length > 1
      ? `${questionIndex + 1}. ${questionData.question}`
      : questionData.question;
    block.appendChild(question);

    const options = document.createElement('div');
    options.className = 'ask-user-options';

    const setAnswer = (answer, selectedButton = null) => {
      const normalized = String(answer || '').trim();
      if (!normalized || card.dataset.submitting === '1') return;

      answers[questionIndex] = normalized;
      persistState(false);
      block.dataset.answered = '1';
      block.querySelectorAll('.ask-user-option').forEach((button) => {
        button.classList.toggle('selected', button === selectedButton || button.dataset.optionValue === normalized);
      });
      input.value = selectedButton ? '' : normalized;

      const status = block.querySelector('.ask-user-question-status') || document.createElement('div');
      status.className = 'ask-user-question-status';
      status.textContent = normalized;
      if (!status.parentElement) block.appendChild(status);

      updateFooter();
    };

    questionData.options.forEach((option, optionIndex) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ask-user-option';
      button.dataset.optionValue = option;
      if (answers[questionIndex] === option) {
        button.classList.add('selected');
      }

      const number = document.createElement('span');
      number.className = 'ask-user-option-number';
      number.textContent = String(optionIndex + 1);

      const label = document.createElement('span');
      label.className = 'ask-user-option-label';
      label.textContent = option;

      button.append(number, label);
      button.addEventListener('click', () => setAnswer(option, button));
      options.appendChild(button);
    });
    block.appendChild(options);

    const customRow = document.createElement('div');
    customRow.className = 'ask-user-custom';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ask-user-input';
    input.placeholder = questionData.placeholder;
    input.autocomplete = 'off';
    if (answers[questionIndex] && !questionData.options.includes(answers[questionIndex])) {
      input.value = answers[questionIndex];
    }

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'ask-user-submit';
    submitBtn.title = isChineseLanguage(appState.language) ? '发送' : 'Send';
    submitBtn.setAttribute('aria-label', submitBtn.title);
    submitBtn.innerHTML = getSvgIcon('arrow_upward', 'material-symbols-outlined', 18);

    const submitCustom = () => {
      const answer = input.value.trim();
      if (answer) setAnswer(answer);
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitCustom();
      }
    });
    submitBtn.addEventListener('click', submitCustom);

    customRow.append(input, submitBtn);
    block.appendChild(customRow);
    if (answers[questionIndex]) {
      const status = document.createElement('div');
      status.className = 'ask-user-question-status';
      status.textContent = answers[questionIndex];
      block.dataset.answered = '1';
      block.appendChild(status);
    }
    card.appendChild(block);
  });

  sendAllBtn.addEventListener('click', () => {
    if (answers.every(Boolean)) {
      persistState(true);
      submitAskUserResponse(formatAskUserAnswers(prompt, answers), prompt, card, stateKey);
    }
  });

  footer.append(progress, sendAllBtn);
  card.appendChild(footer);
  if (answered) {
    card.classList.add('answered');
    card.querySelectorAll('button, input').forEach((element) => {
      element.disabled = true;
    });
    const status = document.createElement('div');
    status.className = 'ask-user-status';
    status.textContent = formatAskUserAnswers(prompt, answers);
    card.appendChild(status);
  }
  updateFooter();
  return card;
}

async function submitAskUserResponse(answer, prompt, card, stateKey = '') {
  const normalizedAnswer = String(answer || '').trim();
  if (!normalizedAnswer || card?.dataset.submitting === '1') return;

  if (card) {
    card.dataset.submitting = '1';
    card.classList.add('answered');
    card.querySelectorAll('button, input').forEach((element) => {
      element.disabled = true;
    });
    if (stateKey) {
      const state = askUserCardState.get(stateKey) || {};
      askUserCardState.set(stateKey, { ...state, submitted: true });
    }

    const status = document.createElement('div');
    status.className = 'ask-user-status';
    status.textContent = normalizedAnswer;
    card.appendChild(status);
  }

  if (prompt?.action === 'set_language') {
    handleOnboardingLanguageChoice(normalizedAnswer);
    return;
  }

  const input = document.getElementById('messageInput');
  if (!input) return;
  input.value = normalizedAnswer;
  autoResizeInput();
  await sendMessage();
}

function createMessageFeedbackButton(message, rating) {
  const button = document.createElement('button');
  const isPositive = rating === 'up';
  button.className = `action-btn feedback-btn feedback-${rating}-btn`;
  button.type = 'button';
  button.title = isChineseLanguage(appState.language)
    ? (isPositive ? '点赞这条回复' : '倒赞这条回复')
    : (isPositive ? 'Like this answer' : 'Dislike this answer');
  button.dataset.feedbackRating = rating;
  if (message?.id) {
    button.dataset.feedbackMessageId = String(message.id);
  }
  if (message?.feedback_rating === rating) {
    button.classList.add('active');
  }
  button.innerHTML = getSvgIcon(isPositive ? 'thumb_up' : 'thumb_down', 'material-symbols-outlined', 16);
  button.addEventListener('click', () => openFeedbackModal(message, rating));
  return button;
}

function ensureFeedbackModal() {
  let modal = document.getElementById('messageFeedbackModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'messageFeedbackModal';
  modal.className = 'feedback-modal-overlay';
  modal.innerHTML = `
    <div class="feedback-modal" role="dialog" aria-modal="true" aria-labelledby="feedbackModalTitle">
      <button class="feedback-modal-close" type="button" aria-label="Close">${getSvgIcon('close', 'material-symbols-outlined', 16)}</button>
      <div class="feedback-modal-icon" id="feedbackModalIcon"></div>
      <h3 id="feedbackModalTitle"></h3>
      <p id="feedbackModalHint" class="feedback-modal-hint"></p>
      <textarea id="feedbackCommentInput" class="feedback-textarea" maxlength="1000"></textarea>
      <div class="feedback-modal-actions">
        <button class="feedback-cancel-btn" type="button">${isChineseLanguage(appState.language) ? '取消' : 'Cancel'}</button>
        <button class="feedback-submit-btn" id="feedbackSubmitBtn" type="button">${isChineseLanguage(appState.language) ? '提交反馈' : 'Submit feedback'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeFeedbackModal();
  });
  modal.querySelector('.feedback-modal-close')?.addEventListener('click', closeFeedbackModal);
  modal.querySelector('.feedback-cancel-btn')?.addEventListener('click', closeFeedbackModal);
  modal.querySelector('#feedbackSubmitBtn')?.addEventListener('click', submitMessageFeedback);
  return modal;
}

function openFeedbackModal(message, rating) {
  if (!appState.token) {
    showToast(isChineseLanguage(appState.language) ? '请先登录后反馈' : 'Please log in to send feedback');
    return;
  }

  feedbackModalState.message = message;
  feedbackModalState.rating = rating;
  feedbackModalState.isSubmitting = false;

  const modal = ensureFeedbackModal();
  const isPositive = rating === 'up';
  modal.querySelector('#feedbackModalIcon').innerHTML = getSvgIcon(isPositive ? 'thumb_up' : 'thumb_down', 'material-symbols-outlined', 24);
  modal.querySelector('#feedbackModalTitle').textContent = isChineseLanguage(appState.language)
    ? (isPositive ? '这条回复哪里好？' : '这条回复哪里不好？')
    : (isPositive ? 'What worked well?' : 'What should be improved?');
  modal.querySelector('#feedbackModalHint').textContent = isChineseLanguage(appState.language)
    ? (isPositive ? '可以写下有帮助、准确或表达好的地方。' : '可以写下不准确、不完整或体验不好的地方。')
    : (isPositive ? 'Tell us what was helpful, accurate, or clear.' : 'Tell us what was inaccurate, incomplete, or confusing.');
  const textarea = modal.querySelector('#feedbackCommentInput');
  textarea.placeholder = isChineseLanguage(appState.language)
    ? '选填，最多1000字'
    : 'Optional, up to 1000 characters';
  textarea.value = message?.feedback_comment || '';
  modal.classList.add('active');
  setTimeout(() => textarea.focus(), 50);
}

function closeFeedbackModal() {
  const modal = document.getElementById('messageFeedbackModal');
  if (modal) modal.classList.remove('active');
  feedbackModalState.message = null;
  feedbackModalState.rating = null;
  feedbackModalState.isSubmitting = false;
}

async function resolveFeedbackMessageId(message) {
  if (message?.id) return message.id;
  if (!appState.currentSession?.id) return null;

  const response = await fetch(`${API_BASE}/sessions/${appState.currentSession.id}/messages`, {
    headers: { 'Authorization': `Bearer ${appState.token}` }
  });
  if (!response.ok) return null;

  const dbMessages = await response.json();
  if (Array.isArray(dbMessages)) {
    appState.messages = dbMessages;
    const matched = [...dbMessages].reverse().find((item) =>
      item.role === 'assistant' && item.content === message?.content
    );
    if (matched?.id) {
      message.id = matched.id;
      return matched.id;
    }
  }
  return null;
}

function refreshFeedbackButtonState(messageId, rating) {
  document.querySelectorAll(`.feedback-btn[data-feedback-message-id="${messageId}"]`).forEach((button) => {
    button.classList.toggle('active', button.dataset.feedbackRating === rating);
  });
}

async function submitMessageFeedback() {
  if (feedbackModalState.isSubmitting) return;
  const message = feedbackModalState.message;
  const rating = feedbackModalState.rating;
  const comment = document.getElementById('feedbackCommentInput')?.value.trim() || '';
  const submitBtn = document.getElementById('feedbackSubmitBtn');

  try {
    feedbackModalState.isSubmitting = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = isChineseLanguage(appState.language) ? '提交中...' : 'Submitting...';
    }

    const hadMessageId = !!message?.id;
    const messageId = await resolveFeedbackMessageId(message);
    if (!messageId) {
      showToast(isChineseLanguage(appState.language) ? '消息保存后才能反馈，请稍后再试' : 'Please try again after the message is saved');
      return;
    }

    const response = await fetch(`${API_BASE}/messages/${messageId}/feedback`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ rating, comment })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    message.id = messageId;
    message.feedback_rating = rating;
    message.feedback_comment = comment;
    const stored = appState.messages.find((item) => item.id === messageId);
    if (stored) {
      stored.feedback_rating = rating;
      stored.feedback_comment = comment;
    }
    if (hadMessageId) {
      refreshFeedbackButtonState(messageId, rating);
    } else {
      renderMessages();
    }
    showToast(isChineseLanguage(appState.language) ? '反馈已提交' : 'Feedback submitted');
    closeFeedbackModal();
  } catch (error) {
    console.error('提交反馈失败:', error);
    showToast(error.message || (isChineseLanguage(appState.language) ? '反馈提交失败' : 'Feedback failed'));
  } finally {
    feedbackModalState.isSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = isChineseLanguage(appState.language) ? '提交反馈' : 'Submit feedback';
    }
  }
}

function formatResearchAgentLabel(role = '') {
  const labelMap = {
    gemma: 'Gemma',
    kimi: 'Kimi K2.5',
    gpt55: 'GPT-5.5',
    deepseek: 'DeepSeek V4 Pro'
  };
  return labelMap[String(role || '').toLowerCase()] || formatAgentRole(role || 'agent');
}

function cleanResearchSpeechText(text = '') {
  const lines = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<\/?think>/gi, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^(结论状态|状态|status)\s*[：:]/i.test(line))
    .map(line => line.replace(/^(发言|观点|结论|speech)\s*[：:]\s*/i, '').trim())
    .filter(Boolean);
  const compact = (lines.join(' ') || String(text || '')).replace(/\s+/g, ' ').trim();
  return compact || (isChineseLanguage(appState.language) ? '正在输入...' : 'Typing...');
}

function getResearchReasoningText(draft = {}) {
  return sanitizeReasoningText(
    draft.reasoningContent ||
    draft.reasoning_content ||
    draft.reasoning ||
    ''
  ).trim();
}

function createResearchThinkingHtml(reasoningText = '', targetId = '') {
  const reasoning = String(reasoningText || '').trim();
  if (!reasoning || !targetId) return '';
  const label = isChineseLanguage(appState.language) ? '查看 thinking' : 'View thinking';
  const safeTargetId = escapeHtml(targetId);
  return `
    <div class="research-agent-thinking">
      <button class="research-agent-thinking-toggle" type="button" data-target="${safeTargetId}">
        <span>${label}</span>
        <span class="toggle-icon">▼</span>
      </button>
      <div class="research-agent-thinking-content" id="${safeTargetId}">${escapeHtml(reasoning)}</div>
    </div>
  `;
}

function bindResearchThinkingToggles(root = document) {
  root.querySelectorAll?.('.research-agent-thinking-toggle[data-target]').forEach((button) => {
    if (button.dataset.bound === '1') return;
    button.dataset.bound = '1';
    button.addEventListener('click', () => {
      const targetId = button.getAttribute('data-target');
      const escapedTargetId = (window.CSS && typeof CSS.escape === 'function')
        ? CSS.escape(targetId || '')
        : String(targetId || '').replace(/["\\#.;?+*~':!^$[\]()=>|/@]/g, '\\$&');
      const content = targetId
        ? root.querySelector(`#${escapedTargetId}`) || document.getElementById(targetId)
        : null;
      if (!content) return;
      const expanded = content.classList.toggle('expanded');
      button.classList.toggle('expanded', expanded);
    });
  });
}

// 修复：改进createMessageElement，添加安全的事件处理
function createMessageElement(message) {
  if (!message || !message.role) {
    console.warn(' 无效的消息对象');
    return null;
  }

  const div = document.createElement('div');
  div.className = `message ${message.role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';

  if (message.role === 'user') {
    applyUserAvatarToElement(avatar);
  } else {
    avatar.innerHTML = getSvgIcon('rai_logo_colored', 'material-symbols-outlined ai-avatar', 24);
  }
  div.appendChild(avatar);

  const content = document.createElement('div');
  content.className = 'message-content';

  // 判断是否需要显示时间轴（有 reasoning_content / internet_mode / process_trace）
  const hasReasoning = message.reasoning_content && message.reasoning_content !== 'null' && message.reasoning_content.trim() !== '';
  const hasInternet = message.internet_mode || (message.sources && message.sources !== 'null');
  let processTrace = null;
  if (message.process_trace && message.process_trace !== 'null') {
    try {
      processTrace = typeof message.process_trace === 'string'
        ? JSON.parse(message.process_trace)
        : message.process_trace;
    } catch (e) {
      processTrace = null;
    }
  }
  const hasAgentProcessTrace = !!(
    processTrace &&
    typeof processTrace === 'object' &&
    (
      processTrace.mode === 'agent' ||
      (Array.isArray(processTrace.tasks) && processTrace.tasks.length > 0) ||
      (Array.isArray(processTrace.drafts) && processTrace.drafts.length > 0)
    )
  );
  const isResearchTrace = !!(
    processTrace &&
    (
      processTrace.mode === 'research_debate' ||
      processTrace.mode === 'research_chat_debate' ||
      processTrace.plan?.mode === 'research_chat_debate'
    )
  );

  if (message.role === 'assistant' && (hasReasoning || hasInternet || hasAgentProcessTrace)) {
    const timelineDiv = document.createElement('div');
    timelineDiv.className = isResearchTrace ? 'thinking-timeline research-chat-timeline' : 'thinking-timeline';
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
      ? (isChineseLanguage(appState.language) ? `联网搜索 → ${sources.length}条来源` : `Web search → ${sources.length} sources`)
      : (isChineseLanguage(appState.language) ? '已完成' : 'Completed');

    // 构建时间轴HTML
    let timelineHtml = `
          <!-- 步骤1: 分析问题 - 已完成 -->
          <div class="thinking-step" data-status="done">
            <div class="thinking-step-node"></div>
            <div class="thinking-step-content">
              <div class="thinking-step-title">${isChineseLanguage(appState.language) ? 'RAI分析' : 'RAI Analysis'}</div>
              <div class="thinking-step-detail">${toolDetail}</div>
            </div>
          </div>
          
          <!-- 步骤2: 生成回答 - 已完成 -->
          <div class="thinking-step" data-status="done">
            <div class="thinking-step-node"></div>
            <div class="thinking-step-content">
              <div class="thinking-step-title">${isChineseLanguage(appState.language) ? '生成回答' : 'Generating Response'}</div>
              <div class="thinking-step-detail">${isChineseLanguage(appState.language) ? '已完成' : 'Completed'}</div>
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
                  <span>${isChineseLanguage(appState.language) ? '深度思考' : 'Deep Thinking'}</span>
                  <span class="toggle-icon">▼</span>
                </button>
                <div class="deep-thinking-content" id="${thinkingId}-content"></div>
              </div>
            </div>
          `;
    }

    if (hasAgentProcessTrace) {
      const normalizeStatusClass = (status) => {
        const s = String(status || '').toLowerCase();
        if (s === 'start' || s === 'active' || s === 'running') return 'running';
        if (s === 'done' || s === 'completed') return 'done';
        if (s === 'failed' || s === 'error') return 'failed';
        return 'pending';
      };

      const taskRows = Array.isArray(processTrace.tasks) ? processTrace.tasks : [];
      const sortedTaskRows = taskRows.slice().sort((a, b) => Number(a.taskId || 0) - Number(b.taskId || 0));
      const taskHtml = sortedTaskRows.map((task) => {
        const st = normalizeStatusClass(task.status);
        const role = escapeHtml(String(task.role || 'agent'));
        const step = escapeHtml(String(task.stepId || `task-${task.taskId || ''}`));
        const detail = escapeHtml(String(task.detail || ''));
        return `
          <div class="agent-task-item">
            <span class="agent-task-dot" data-status="${st}"></span>
            <div class="agent-task-text">
              <div class="agent-task-title">${role} · ${step}</div>
              <div class="agent-task-detail">${detail}</div>
            </div>
          </div>
        `;
      }).join('');

      const traceEvents = Array.isArray(processTrace.trace) ? processTrace.trace : [];
      const statusEvents = Array.isArray(processTrace.statuses) ? processTrace.statuses : [];
      const logRows = (traceEvents.length > 0 ? traceEvents : statusEvents).slice(-200);
      const logHtml = logRows.map((row) => {
        const kind = escapeHtml(String(row.kind || 'agent'));
        const text = escapeHtml(String(row.text || row.detail || ''));
        const time = row.ts ? new Date(row.ts).toLocaleTimeString() : '';
        const meta = escapeHtml(`[${time}] ${kind}`);
        return `
          <div class="process-dot-item ${kind}">
            <span class="process-dot-meta">${meta}</span>
            <span class="process-dot-text">${text}</span>
          </div>
        `;
      }).join('');

      const drafts = Array.isArray(processTrace.drafts) ? processTrace.drafts.slice(0, 20) : [];
      const draftHtml = drafts.map((draft, idx) => {
        if (isResearchTrace && !(draft.speech || draft.round || draft.voteOk !== undefined)) {
          return '';
        }
        if (isResearchTrace) {
          const rawRole = String(draft.role || 'agent');
          const safeRole = escapeHtml(rawRole.replace(/[^a-z0-9_-]/gi, ''));
          const roleLabel = escapeHtml(formatResearchAgentLabel(rawRole));
          const round = draft.round || draft.debateRound || '';
          const status = draft.voteOk === true ? 'ok' : (draft.voteOk === false ? 'issue' : 'talking');
          const bodyText = cleanResearchSpeechText(draft.content || draft.summary || '');
          const body = escapeHtml(bodyText || (isChineseLanguage(appState.language) ? '本轮没有可显示发言' : 'No visible speech'));
          const thinkingIdForDraft = `${thinkingId}-research-thinking-${idx}`;
          const thinkingHtml = createResearchThinkingHtml(getResearchReasoningText(draft), thinkingIdForDraft);
          return `
          <div class="research-agent-bubble role-${safeRole}" data-status="${status}">
            <span class="research-agent-avatar">${roleLabel.slice(0, 1)}</span>
            <div class="research-agent-card">
              <div class="research-agent-head">
                <div class="research-agent-meta">
                  <div class="research-agent-name">${roleLabel}</div>
                  <div class="research-agent-round">${round ? (isChineseLanguage(appState.language) ? `第 ${round} 轮` : `Round ${round}`) : ''}</div>
                </div>
              </div>
              <div class="research-agent-text">${body}</div>
              ${thinkingHtml}
            </div>
          </div>
        `;
        }

        const draftId = `${thinkingId}-draft-${idx}`;
        const role = escapeHtml(String(draft.role || 'agent'));
        const taskId = Number(draft.taskId || idx + 1);
        const summary = escapeHtml(String(draft.summary || ''));
        const body = escapeHtml(String(draft.content || ''));
        return `
          <div class="agent-draft-item">
            <button class="agent-draft-header" type="button" data-target="${draftId}">
              <span class="agent-draft-title">${role} · task-${taskId}</span>
              <span class="agent-draft-toggle"></span>
            </button>
            <div class="agent-draft-summary">${summary}</div>
            <pre class="agent-draft-content" id="${draftId}">${body}</pre>
          </div>
        `;
      }).join('');

      const traceToggleId = `${thinkingId}-trace-toggle`;
      const traceListId = `${thinkingId}-trace-list`;
      timelineHtml += `
        <div class="thinking-step research-history-process" data-status="done">
          <div class="thinking-step-node"></div>
          <div class="thinking-step-content">
            <div class="thinking-step-title">${isChineseLanguage(appState.language) ? '研究过程' : 'Research Process'}</div>
            <div class="agent-task-list">${taskHtml}</div>
            ${logRows.length > 0 ? `
              <button class="process-trace-toggle" id="${traceToggleId}">
                <span>${isChineseLanguage(appState.language) ? '过程轨迹' : 'Process Trace'}</span>
                <span class="toggle-icon">▼</span>
              </button>
              <div class="process-trace-list" id="${traceListId}">${logHtml}</div>
            ` : ''}
            ${drafts.length > 0 ? `<div class="agent-draft-list ${isResearchTrace ? 'research-chat-list' : ''}">${draftHtml}</div>` : ''}
          </div>
        </div>
      `;
    }

    timelineDiv.innerHTML = timelineHtml;

    // 填充深度思考内容
    if (hasReasoning && !isResearchTrace) {
      const deepContent = timelineDiv.querySelector(`#${thinkingId}-content`);
      const formattedText = sanitizeReasoningText(message.reasoning_content);
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

    if (hasAgentProcessTrace) {
      setTimeout(() => {
        const traceToggleBtn = timelineDiv.querySelector(`#${thinkingId}-trace-toggle`);
        const traceListEl = timelineDiv.querySelector(`#${thinkingId}-trace-list`);
        if (traceToggleBtn && traceListEl) {
          traceToggleBtn.addEventListener('click', () => {
            const expanded = traceListEl.classList.contains('expanded');
            if (expanded) {
              traceListEl.classList.remove('expanded');
              traceToggleBtn.classList.remove('expanded');
            } else {
              traceListEl.classList.add('expanded');
              traceToggleBtn.classList.add('expanded');
            }
          });
        }

        timelineDiv.querySelectorAll('.agent-draft-header[data-target]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-target');
            const target = timelineDiv.querySelector(`#${targetId}`);
            if (!target) return;
            const expanded = target.classList.contains('expanded');
            const icon = btn.querySelector('.agent-draft-toggle');
            if (expanded) {
              target.classList.remove('expanded');
              btn.classList.remove('expanded');
              if (icon) icon.textContent = '';
            } else {
              target.classList.add('expanded');
              btn.classList.add('expanded');
              if (icon) icon.textContent = '▼';
            }
          });
        });

        bindResearchThinkingToggles(timelineDiv);
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
              <span>${isChineseLanguage(appState.language) ? '点击加载附件' : 'Click to load attachments'}</span>
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
            itemDiv.innerHTML = `<div style="padding: 20px; text-align: center;"></div>`;
          }
        } else if (att.type === 'video') {
          itemDiv.className = 'message-attachment-item media-attachment';
          itemDiv.innerHTML = `
                <span class="media-icon"></span>
                <div class="media-info">
                  <div class="media-type">${isChineseLanguage(appState.language) ? '视频' : 'Video'}</div>
            <div class="media-name">${escapeHtml(att.fileName || '')}</div>
                </div>
              `;
        } else if (att.type === 'audio') {
          itemDiv.className = 'message-attachment-item media-attachment';
          itemDiv.innerHTML = `
                <span class="media-icon"></span>
                <div class="media-info">
                  <div class="media-type">${isChineseLanguage(appState.language) ? '音频' : 'Audio'}</div>
            <div class="media-name">${escapeHtml(att.fileName || '')}</div>
                </div>
              `;
        } else if (att.type === 'document') {
          itemDiv.className = 'message-attachment-item media-attachment';
          itemDiv.innerHTML = `
                <span class="media-icon"></span>
                <div class="media-info">
                  <div class="media-type">${isChineseLanguage(appState.language) ? '文档' : 'Document'}</div>
            <div class="media-name">${escapeHtml(att.fileName || '')}</div>
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
  //  移除标题标记 <<<标题>>> 后再渲染（修复历史消息显示标题的bug）
  const cleanContent = stripTrailingTitleMarker(message.content || '');
  const askUserResult = message.role === 'assistant'
    ? extractAskUserBlocks(cleanContent)
    : { text: cleanContent, prompts: [] };
  // 使用renderMarkdownWithMath渲染Markdown和数学公式
  let renderedContent = renderMarkdownWithMath(askUserResult.text);

  // 解析 sources：可能是 JSON 字符串（从数据库加载）或数组对象（流式响应）
  let sources = message.sources;
  if (typeof sources === 'string' && sources.trim()) {
    try {
      sources = JSON.parse(sources);
    } catch (e) {
      console.warn(' 解析 sources JSON 失败:', e);
      sources = null;
    }
  }

  // 对AI消息的角标进行转换
  if (message.role === 'assistant' && sources && Array.isArray(sources) && sources.length > 0) {
    renderedContent = renderCitations(renderedContent, sources);
  }

  textDiv.innerHTML = sanitizeRenderedHtml(renderedContent);
  if (textDiv.innerHTML.trim()) {
    content.appendChild(textDiv);
  }

  if (message.role === 'assistant' && askUserResult.prompts.length > 0) {
    askUserResult.prompts.forEach((prompt) => {
      content.appendChild(createAskUserCard(prompt));
    });
  }


  // 渲染来源列表（在消息文本后）- 使用已解析的 sources 变量
  if (message.role === 'assistant' && sources && Array.isArray(sources) && sources.length > 0) {
    const sourcesDiv = document.createElement('div');
    sourcesDiv.innerHTML = sanitizeRenderedHtml(renderSourcesList(sources, appState.language));
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
            <span>${isChineseLanguage(appState.language) ? '联网' : 'Web'}</span>
          `;
      metaDiv.appendChild(internetBadge);
    }

    // 显示思考状态
    if (message.reasoning_content && message.reasoning_content !== 'null' && message.reasoning_content.trim() !== '') {
      const thinkingBadge = document.createElement('span');
      thinkingBadge.className = 'meta-badge';
      thinkingBadge.innerHTML = `
            ${getSvgIcon('psychology', 'material-symbols-outlined', 24)}
            <span>${isChineseLanguage(appState.language) ? '思考' : 'Thinking'}</span>
          `;
      metaDiv.appendChild(thinkingBadge);
    }

    // 添加复制按钮
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.title = isChineseLanguage(appState.language) ? '复制消息' : 'Copy message';
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
          console.log(' 复制成功');
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
          console.log(' 复制成功（备用方法）');
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
        console.error(' 复制失败:', err);
        alert(isChineseLanguage(appState.language) ? '复制失败' : 'Copy failed');
      }
    });

    metaDiv.appendChild(copyBtn);
    metaDiv.appendChild(createMessageFeedbackButton(message, 'up'));
    metaDiv.appendChild(createMessageFeedbackButton(message, 'down'));

    // 添加编辑按钮
    const editBtn = document.createElement('button');
    editBtn.className = 'action-btn edit-btn';
    editBtn.title = isChineseLanguage(appState.language) ? '编辑' : 'Edit';
    editBtn.innerHTML = getSvgIcon('edit', 'material-symbols-outlined', 16);
    editBtn.addEventListener('click', () => startEditMessage(message, div));
    metaDiv.appendChild(editBtn);

    // 添加重新生成按钮
    const regenerateBtn = document.createElement('button');
    regenerateBtn.className = 'action-btn regenerate-btn';
    regenerateBtn.title = isChineseLanguage(appState.language) ? '重新生成' : 'Regenerate';
    regenerateBtn.innerHTML = getSvgIcon('refresh', 'material-symbols-outlined', 16);
    regenerateBtn.addEventListener('click', () => openRegenerateModal(message));
    metaDiv.appendChild(regenerateBtn);

    // 添加删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn delete-btn';
    deleteBtn.title = isChineseLanguage(appState.language) ? '删除' : 'Delete';
    deleteBtn.innerHTML = getSvgIcon('delete', 'material-symbols-outlined', 16);
    deleteBtn.addEventListener('click', () => deleteMessage(message));
    metaDiv.appendChild(deleteBtn);

    // 添加引用按钮
    const quoteBtn = document.createElement('button');
    quoteBtn.className = 'action-btn quote-btn';
    quoteBtn.title = isChineseLanguage(appState.language) ? '引用' : 'Quote';
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
    editBtn.title = isChineseLanguage(appState.language) ? '编辑' : 'Edit';
    editBtn.innerHTML = getSvgIcon('edit', 'material-symbols-outlined', 16);
    editBtn.addEventListener('click', () => startEditMessage(message, div));
    userMetaDiv.appendChild(editBtn);

    // 删除按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn delete-btn';
    deleteBtn.title = isChineseLanguage(appState.language) ? '删除' : 'Delete';
    deleteBtn.innerHTML = getSvgIcon('delete', 'material-symbols-outlined', 16);
    deleteBtn.addEventListener('click', () => deleteMessage(message));
    userMetaDiv.appendChild(deleteBtn);

    // 引用按钮
    const quoteBtn = document.createElement('button');
    quoteBtn.className = 'action-btn quote-btn';
    quoteBtn.title = isChineseLanguage(appState.language) ? '引用' : 'Quote';
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
          <span>${isChineseLanguage(appState.language) ? '加载中...' : 'Loading...'}</span>
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
        itemDiv.innerHTML = `<span class="media-icon"></span><div class="media-info"><div class="media-type">${isChineseLanguage(appState.language) ? '视频' : 'Video'}</div><div class="media-name">${escapeHtml(att.fileName || '')}</div></div>`;
      } else if (att.type === 'audio') {
        itemDiv.className = 'message-attachment-item media-attachment';
        itemDiv.innerHTML = `<span class="media-icon"></span><div class="media-info"><div class="media-type">${isChineseLanguage(appState.language) ? '音频' : 'Audio'}</div><div class="media-name">${escapeHtml(att.fileName || '')}</div></div>`;
      }

      if (itemDiv.innerHTML) containerElement.appendChild(itemDiv);
    });

  } catch (error) {
    console.error(' 加载附件失败:', error);
    containerElement.innerHTML = `
          <div class="lazy-attachment-placeholder error" onclick="loadMessageAttachments(${messageId}, this.parentElement)">
            <span>${isChineseLanguage(appState.language) ? '加载失败，点击重试' : 'Failed, click to retry'}</span>
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
    sidebar.classList.remove('dragging');
    sidebar.style.transform = '';
  }

  if (overlay) {
    overlay.classList.add('active');
    overlay.classList.remove('dragging');
    overlay.style.opacity = '';
  }

  appState.sidebarOpen = true;
}

// 修复：改进closeSidebar函数
function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobileOverlay');

  if (sidebar) {
    sidebar.classList.remove('active');
    sidebar.classList.remove('dragging');
    sidebar.style.transform = '';
  }

  if (overlay) {
    overlay.classList.remove('active');
    overlay.classList.remove('dragging');
    overlay.style.opacity = '';
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
    console.warn(' 事件对象未传递');
    return;
  }

  event.stopPropagation();

  const confirmMsg = isChineseLanguage(appState.language) ? '确定要删除这个对话吗?' : 'Delete this conversation?';
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
    console.error(' 删除会话失败:', error);
    alert(isChineseLanguage(appState.language) ? '删除失败' : 'Delete failed');
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
  const originalContent = stripTrailingTitleMarker(message.content || '');

  // 保存原始HTML以便取消时恢复
  const originalHtml = textDiv.innerHTML;

  // 创建编辑容器
  const editContainer = document.createElement('div');
  editContainer.className = 'message-edit-container';
  editContainer.innerHTML = `
        <textarea class="message-edit-textarea">${escapeHtml(originalContent)}</textarea>
        <div class="message-edit-actions">
          <button class="edit-cancel-btn" data-i18n="cancel">${isChineseLanguage(appState.language) ? '取消' : 'Cancel'}</button>
          <button class="edit-save-btn" data-i18n="save">${isChineseLanguage(appState.language) ? '保存' : 'Save'}</button>
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
      alert(isChineseLanguage(appState.language) ? '内容不能为空' : 'Content cannot be empty');
      return;
    }

    await saveEditMessage(message, newContent, messageDiv, editContainer, textDiv);
  });
}

// 保存编辑的消息
async function saveEditMessage(message, newContent, messageDiv, editContainer, textDiv) {
  if (!appState.currentSession) {
    console.error(' 无法保存：缺少会话');
    alert(isChineseLanguage(appState.language) ? '请先刷新页面' : 'Please refresh the page first');
    return;
  }

  // 如果消息没有ID，需要先从数据库重新加载消息获取ID
  if (!message.id) {
    console.log(' 消息没有ID，正在从数据库重新加载...');
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
          console.log(` 已获取消息ID: ${message.id}`);
        } else {
          console.error(' 无法找到消息ID');
          alert(isChineseLanguage(appState.language) ? '消息尚未保存，请稍后重试' : 'Message not saved yet, please try again');
          return;
        }
      }
    } catch (error) {
      console.error(' 重新加载消息失败:', error);
      alert(isChineseLanguage(appState.language) ? '加载失败，请重试' : 'Load failed, please retry');
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
    console.log(' 消息已更新:', result);

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
    console.error(' 更新消息失败:', error);
    alert(isChineseLanguage(appState.language) ? '更新失败' : 'Update failed');
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
    console.error(' 无法获取消息ID：缺少会话');
    return null;
  }

  console.log(' 消息没有ID，正在从数据库重新加载...');
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
      console.log(` 已获取消息ID: ${foundMsg.id}`);
      return foundMsg;
    } else {
      console.error(' 无法在数据库中找到该消息');
      return null;
    }
  } catch (error) {
    console.error(' 重新加载消息失败:', error);
    return null;
  }
}


// 从数据库删除消息（不更新UI）
async function deleteMessageFromDB(message) {
  if (!appState.currentSession) return false;

  // 确保消息有ID
  const msgWithId = await ensureMessageHasId(message);
  if (!msgWithId || !msgWithId.id) {
    console.error(' 无法删除：无法获取消息ID');
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

    console.log(` 已从数据库删除消息 ID: ${msgWithId.id}`);
    return true;
  } catch (error) {
    console.error(' 删除消息失败:', error);
    return false;
  }
}

// 删除消息
async function deleteMessage(message) {
  const confirmMsg = isChineseLanguage(appState.language) ? '确定要删除这条消息吗?' : 'Delete this message?';
  if (!confirm(confirmMsg)) return;

  // 确保消息有ID
  const msgWithId = await ensureMessageHasId(message);
  if (!msgWithId) {
    alert(isChineseLanguage(appState.language) ? '无法获取消息信息，请刷新页面后重试' : 'Cannot get message info, please refresh and retry');
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
    alert(isChineseLanguage(appState.language) ? '删除失败' : 'Delete failed');
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

  console.log(' 已引用消息:', message.role);
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
        <button class="quote-preview-remove" onclick="removeQuote()" title="${isChineseLanguage(appState.language) ? '取消引用' : 'Remove quote'}">
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
  const regenerateModelSelect = document.getElementById('regenerateModelSelect');
  const defaultModel = normalizeSelectedModelId(appState.selectedModel || 'auto') || 'auto';
  if (regenerateModelSelect) {
    regenerateModelSelect.value = defaultModel;
    if (regenerateModelSelect.value !== defaultModel) {
      regenerateModelSelect.value = 'auto';
    }
  }
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
    console.log(' 消息没有ID，正在从数据库重新加载...');
    try {
      const response = await fetch(`${API_BASE}/sessions/${appState.currentSession.id}/messages`, {
        headers: { 'Authorization': `Bearer ${appState.token}` }
      });
      if (response.ok) {
        const dbMessages = await response.json();
        // 找到对应内容的消息并更新目标
        const foundMsg = dbMessages.find(m =>
          m.content === currentTarget.content && m.role === 'assistant'
        );
        if (foundMsg && foundMsg.id) {
          appState.messages = dbMessages;
          currentTarget = foundMsg;
          console.log(` 已获取消息ID: ${foundMsg.id}`);
        } else {
          console.warn(' Regenerate target has no saved ID yet; continuing with local message state.');
        }
      }
    } catch (error) {
      console.error(' 重新加载消息失败:', error);
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
    console.error(' 无法找到要重新生成的消息');
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
  appState.selectedModel = normalizeSelectedModelId(selectedModel || 'auto') || 'auto';
  appState.internetMode = internetMode;
  appState.thinkingMode = thinkingMode;
  applyFreePoeThinkingPolicy();

  // 更新UI显示
  updateSelectedModelText(appState.selectedModel);
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
  let mermaidPreviewContainer = aiMsgElement?.querySelector('#mermaidLivePreview');
  let lastValidMermaidCode = ''; // 上次成功渲染的代码

  // 从原始文本中提取 Mermaid 代码并尝试实时渲染
  async function tryRenderMermaidFromText(fullText) {
    if (typeof mermaid === 'undefined' || !mermaidPreviewContainer) return;

    // 提取 mermaid 代码块（支持未闭合和少一个反引号的情况）
    const mermaidBlocks = extractMermaidBlocks(fullText).blocks;

    if (!mermaidBlocks.length) {
      // 没有 mermaid 代码块，隐藏预览
      mermaidPreviewContainer.style.display = 'none';
      return;
    }

    const code = sanitizeMermaidCode(mermaidBlocks[mermaidBlocks.length - 1]);
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

      console.log(' Mermaid 实时渲染成功');
    } catch (err) {
      // 语法错误，保持上一次的渲染结果
      console.debug(' Mermaid 语法不完整，保持上一帧');
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
        model: getRequestModelIdForCurrentMode(),
        sessionId,
        requestId,
        internetMode: appState.internetMode,
        researchMode: getEffectiveResearchMode(),
        thinkingMode: appState.thinkingMode,
        reasoningProfile: getRequestReasoningProfileForCurrentMode(),
        agentMode: 'off',
        agentPolicy: appState.agentPolicy,
        qualityProfile: appState.qualityProfile,
        temperature: appState.temperature,
        top_p: appState.topP,
        max_tokens: appState.maxTokens,
        frequency_penalty: appState.frequencyPenalty,
        presence_penalty: appState.presencePenalty,
        promptTimeContext: getUserTimeContext(),
        systemPrompt: buildEffectiveSystemPrompt()
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

	          if (parsed.type === 'points_info') {
	            handlePointsInfoEvent(parsed);
	            continue;
	          }

	          if (parsed.type === 'quota_info') {
	            applyQuotaInfoEvent(parsed);
	            continue;
	          }

          if (parsed.type === 'model_info') {
            if (parsed.model) {
              finalModel = parsed.model;
              aiMsg.model = finalModel;
            }
            continue;
          }

          if (parsed.type === 'sources' && Array.isArray(parsed.sources)) {
            sources = parsed.sources;
            aiMsg.sources = sources;
            continue;
          }

          if (parsed.type === 'reasoning' && parsed.content) {
            reasoningContent += parsed.content;
            aiMsg.reasoning_content = reasoningContent;
            continue;
          }

          if (parsed.type === 'content' && parsed.content) {
            fullContent += parsed.content;
            aiMsg.content = fullContent;
            throttledUpdate(fullContent);
            continue;
          }

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
    console.log(' 流式响应完成');

  } catch (error) {
    console.error(' 流式请求失败:', error);
    aiMsg.content = isChineseLanguage(appState.language) ? '生成失败，请重试' : 'Generation failed, please retry';
  } finally {
    appState.isStreaming = false;

    //  清理持久的 Mermaid 预览容器（最终渲染会创建正式的容器）
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
        console.warn(' 重新加载消息失败:', e);
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
      return `<div class="session-attachment-preview"></div>`;
    }
  } else if (attachment.type === 'video') {
    return `<div class="session-attachment-preview video-preview"></div>`;
  } else if (attachment.type === 'audio') {
    return `<div class="session-attachment-preview audio-preview"></div>`;
  } else if (attachment.type === 'document') {
    return `<div class="session-attachment-preview"></div>`;
  }
  return '';
}

function renderSessions() {
  const container = document.getElementById('sessionsContainer');

  if (!container) {
    console.error(' 找不到会话容器');
    return;
  }

  container.innerHTML = '';

  if (!appState.sessions || appState.sessions.length === 0) {
    // 如果正在加载，显示加载中
    if (appState.sessionsPagination.isLoading) {
      container.innerHTML = `<div class="sessions-loader"><div class="loader-spinner"></div></div>`;
      return;
    }
    const msg = isChineseLanguage(appState.language)
      ? '暂无历史对话<br>点击"新对话"开始聊天'
      : 'No conversations<br>Click "New Chat" to start';
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-secondary); font-size: 13px;">${msg}</div>`;
    return;
  }

  appState.sessions.forEach(session => {
    const div = document.createElement('div');
    div.className = `session-item ${session.id === appState.currentSession?.id ? 'active' : ''}`;
    div.setAttribute('data-session-id', session.id);
    const displayTitle = getSessionDisplayTitle(session);
    const previewText = stripAskUserBlocksForStreaming(stripTrailingTitleMarker(session.last_message || '')).replace(/\s+/g, ' ').trim();

    // 解析附件并生成预览HTML
    const attachments = parseSessionAttachments(session);
    let attachmentsHtml = '';
    if (attachments.length > 0) {
      const previews = attachments.map(att => renderSessionAttachmentPreview(att)).join('');
      attachmentsHtml = `<div class="session-attachments">${previews}</div>`;
    }

    div.innerHTML = `
          <div class="session-title">${escapeHtml(displayTitle)}</div>
          <div class="session-preview">${escapeHtml(previewText ? `${previewText.substring(0, 50)}...` : '')}</div>
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
        console.log(' 触发加载更多会话...');
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
async function submitStreamingInterjection(messageText) {
  const content = String(messageText || '').trim();
  if (!content || !appState.currentRequestId || !appState.currentSession) return false;

  const input = document.getElementById('messageInput');
  if (input) {
    input.value = '';
    autoResizeInput();
  }

  const userMsg = {
    role: 'user',
    content,
    created_at: new Date().toISOString(),
    isStreamingInterjection: true
  };
  appState.messages.push(userMsg);

  const messagesList = document.getElementById('messagesList');
  const streamingAssistant = document.getElementById('streamingContent')?.closest('.message.assistant');
  const userEl = createMessageElement(userMsg);
  if (messagesList && userEl) {
    if (streamingAssistant && streamingAssistant.parentElement === messagesList) {
      messagesList.insertBefore(userEl, streamingAssistant);
    } else {
      messagesList.appendChild(userEl);
    }
    scrollToBottom();
  }

  try {
    const response = await fetch(`${API_BASE}/chat/interject`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requestId: appState.currentRequestId,
        message: content
      })
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    showToast(isChineseLanguage(appState.language) ? '已加入当前讨论' : 'Added to current discussion');
    return true;
  } catch (error) {
    console.error(' 讨论插话失败:', error);
    showToast(isChineseLanguage(appState.language) ? '插话发送失败，请稍后重试' : 'Failed to add message to the discussion');
    return false;
  }
}

async function sendMessage(message = null) {
  // 如果在 ChatFlow iframe 模式下，发送前先请求最新的画布上下文
  if (isChatFlowIframeMode) {
    console.log(' 发送前请求画布上下文...');
    await new Promise(resolve => requestCanvasContext(resolve));
  }

  const input = document.getElementById('messageInput');
  if (!input) {
    console.error(' 消息输入框未找到');
    return;
  }

  // 检测超长输入并自动转换为文件附件
  if (checkAndConvertLongInput()) {
    // 输入已被转换为附件，等待下次发送
    return;
  }

  const providedMessage = message !== null && message !== undefined ? String(message).trim() : '';
  const messageText = providedMessage || input.value.trim();

  // 允许只发送附件（无文字内容）
  if (!messageText && !currentAttachment) return;
  if (appState.isStreaming) {
    if (messageText && !currentAttachment) {
      await submitStreamingInterjection(messageText);
    }
    return;
  }

  if (!appState.currentSession) {
    const created = await createNewSession({ focus: false });
    if (!created || !appState.currentSession) return;
  }

  input.value = '';
  autoResizeInput();

  //  处理引用内容
  let finalMessageContent = messageText || message || '请分析这个文件';
  if (appState.currentQuote) {
    const quoteLabel = appState.currentQuote.role === 'user'
      ? (isChineseLanguage(appState.language) ? '引用用户' : 'Quoting User')
      : (isChineseLanguage(appState.language) ? '引用AI' : 'Quoting AI');
    // 截取引用内容（最多200字符）
    const quotedContent = (appState.currentQuote.content || '').slice(0, 200) +
      (appState.currentQuote.content.length > 200 ? '...' : '');
    finalMessageContent = `${quoteLabel}：${quotedContent}\n---\n${messageText || message || ''}`.trim();

    // 清除引用状态
    appState.currentQuote = null;
    updateQuoteUI();
    console.log(' 引用内容已添加到消息');
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
    console.log(` 消息包含附件: ${currentAttachment.type} - ${currentAttachment.fileName}`);
  }

  appState.messages.push(userMsg);
  renderMessages();

  // 构建发送给服务器的消息数组（包含附件信息）
  const messages = appState.messages.map((m, index, arr) => {
    const msgObj = {
      role: m.role,
      content: m.role === 'user' && index === arr.length - 1
        ? appendUserTimeHintForPrompt(m.content)
        : m.content
    };
    // 如果有附件，也传递给服务器
    //  增强防御性检查：确保 attachments 是数组
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
      console.log(' 已注入画布上下文到用户消息');
    }
  }

  // 清除当前附件
  const hadAttachment = !!currentAttachment;
  currentAttachment = null;
  updateAttachmentUI();  // 更新UI显示

  const sendBtn = document.getElementById('sendBtn');
  const stopBtn = document.getElementById('stopBtn');

  if (sendBtn) {
    sendBtn.style.display = 'flex';
    sendBtn.title = isChineseLanguage(appState.language) ? '发送到当前讨论' : 'Send into current discussion';
  }
  if (stopBtn) stopBtn.style.display = 'flex';

  appState.isStreaming = true;

  const aiMsgDiv = document.createElement('div');
  aiMsgDiv.className = 'message assistant';
  const thinkingLabelText = '';

  // 根据当前模式确定初始加载状态文本
  const initialStatusText = appState.internetMode
    ? (isChineseLanguage(appState.language) ? '联网搜索中...' : 'Searching...')
    : (appState.thinkingMode
      ? (isChineseLanguage(appState.language) ? '推理中...' : 'Reasoning...')
      : (isChineseLanguage(appState.language) ? '思考中...' : 'Thinking...'));
  const currentResearchMode = getEffectiveResearchMode();
  const enableProcessTrace = currentResearchMode === 'fast' || currentResearchMode === 'deep';
  const isResearchModeActive = enableProcessTrace;
  const processTraceStepHtml = enableProcessTrace ? `
            <!-- 步骤2: AI 实时讨论 -->
            <div class="thinking-step" id="stepProcessTrace" data-status="pending">
              <div class="thinking-step-node"></div>
              <div class="thinking-step-content">
                <button class="process-trace-toggle" id="processTraceToggle">
                  <span>${isChineseLanguage(appState.language) ? 'AI 实时讨论' : 'Live AI Discussion'}</span>
                  <span class="toggle-icon">▼</span>
                </button>
                <div class="thinking-step-detail" id="processTraceDetail">${isChineseLanguage(appState.language) ? '等待模型输出...' : 'Waiting for model output...'}</div>
                <div class="agent-trace-toolbar" id="agentTraceToolbar" style="display: none;">
                  <button class="agent-trace-btn" id="agentExpandAllBtn">${isChineseLanguage(appState.language) ? '展开全部' : 'Expand All'}</button>
                  <button class="agent-trace-btn" id="agentCollapseAllBtn">${isChineseLanguage(appState.language) ? '折叠全部' : 'Collapse All'}</button>
                </div>
                <div class="agent-task-list" id="agentTaskList"></div>
                <div class="agent-draft-list" id="agentDraftList"></div>
                <div class="agent-metrics" id="agentMetrics" style="display: none;"></div>
                <div class="process-trace-list" id="processTraceList"></div>
              </div>
            </div>
            ` : '';

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
          
          <!-- 思考 / 研究过程 UI -->
          <div class="thinking-timeline ${isResearchModeActive ? 'research-chat-timeline' : ''}" id="thinkingTimeline" style="display: none;">
            <!-- 步骤1: 分析问题 -->
            <div class="thinking-step" id="stepToolDecision" data-status="pending">
              <div class="thinking-step-node"></div>
              <div class="thinking-step-content">
                <div class="thinking-step-title">${isResearchModeActive
                  ? (isChineseLanguage(appState.language) ? '多模型讨论' : 'Multi-model Discussion')
                  : (isChineseLanguage(appState.language) ? 'RAI正在分析问题' : 'RAI Analyzing')}</div>
                <div class="thinking-step-detail" id="toolDecisionDetail"></div>
              </div>
            </div>
            ${processTraceStepHtml}

            <!-- 步骤2: 生成回答 -->
            <div class="thinking-step" id="stepGenerating" data-status="pending">
              <div class="thinking-step-node"></div>
              <div class="thinking-step-content">
                <div class="thinking-step-title">${isChineseLanguage(appState.language) ? '生成回答' : 'Generating Response'}</div>
                <div class="thinking-step-detail" id="generatingDetail"></div>
              </div>
            </div>

            <!-- 深度思考 (仅在思考模式下显示) -->
            <div class="thinking-step" id="stepDeepThinking" data-status="pending" style="${appState.thinkingMode ? '' : 'display: none;'}">
              <div class="thinking-step-node"></div>
              <div class="thinking-step-content">
                <button class="deep-thinking-toggle" id="deepThinkingToggle">
                  <span>${isChineseLanguage(appState.language) ? '深度思考' : 'Deep Thinking'}</span>
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
  const stepProcessTrace = aiMsgDiv.querySelector('#stepProcessTrace');
  const stepDeepThinking = aiMsgDiv.querySelector('#stepDeepThinking');
  const toolDecisionDetail = aiMsgDiv.querySelector('#toolDecisionDetail');
  const generatingDetail = aiMsgDiv.querySelector('#generatingDetail');
  const processTraceDetail = aiMsgDiv.querySelector('#processTraceDetail');
  const processTraceList = aiMsgDiv.querySelector('#processTraceList');
  const processTraceToggle = aiMsgDiv.querySelector('#processTraceToggle');
  const agentTraceToolbar = aiMsgDiv.querySelector('#agentTraceToolbar');
  const agentExpandAllBtn = aiMsgDiv.querySelector('#agentExpandAllBtn');
  const agentCollapseAllBtn = aiMsgDiv.querySelector('#agentCollapseAllBtn');
  const agentTaskList = aiMsgDiv.querySelector('#agentTaskList');
  const agentDraftList = aiMsgDiv.querySelector('#agentDraftList');
  const agentMetrics = aiMsgDiv.querySelector('#agentMetrics');
  const deepThinkingContent = aiMsgDiv.querySelector('#deepThinkingContent');

  const agentRunState = {
    tasks: new Map(),
    drafts: new Map(),
    metrics: null
  };

  function mapNodeStatus(status = '') {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'thinking') return 'thinking';
    if (normalized === 'running' || normalized === 'start' || normalized === 'active') return 'running';
    if (normalized === 'done' || normalized === 'completed') return 'done';
    if (normalized === 'failed' || normalized === 'error') return 'failed';
    return 'pending';
  }

  function formatDuration(durationMs) {
    const ms = Number(durationMs || 0);
    if (!ms || ms < 1) return '';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
  }

  function ensureAgentPanelVisible() {
    if (agentTraceToolbar) {
      agentTraceToolbar.style.display = 'flex';
    }
  }

  function renderAgentTaskList() {
    if (!agentTaskList) return;
    const ordered = Array.from(agentRunState.tasks.values()).sort((a, b) => {
      const aId = Number(a.taskId || 0);
      const bId = Number(b.taskId || 0);
      if (aId && bId) return aId - bId;
      return String(a.stepId || '').localeCompare(String(b.stepId || ''));
    });

    if (ordered.length === 0) {
      agentTaskList.innerHTML = '';
      return;
    }

    agentTaskList.innerHTML = '';
    for (const task of ordered) {
      const item = document.createElement('div');
      item.className = 'agent-task-item';
      item.dataset.stepId = task.stepId;

      const dot = document.createElement('span');
      dot.className = 'agent-task-dot';
      dot.setAttribute('data-status', task.status || 'pending');

      const textWrap = document.createElement('div');
      textWrap.className = 'agent-task-text';

      const title = document.createElement('div');
      title.className = 'agent-task-title';
      title.textContent = task.detail
        ? `${task.roleLabel || task.role || 'agent'}`
        : `${task.roleLabel || task.role || 'agent'} · ${task.stepId}`;

      const detail = document.createElement('div');
      detail.className = 'agent-task-detail';
      detail.textContent = `${task.detail || ''}${task.durationLabel ? ` · ${task.durationLabel}` : ''}`;

      textWrap.appendChild(title);
      textWrap.appendChild(detail);
      item.appendChild(dot);
      item.appendChild(textWrap);
      agentTaskList.appendChild(item);
    }
  }

  function setTaskState(payload = {}) {
    const stepId = payload.stepId || `task-${payload.taskId || 0}`;
    if (!stepId) return;
    const prev = agentRunState.tasks.get(stepId) || {};
    const roleName = payload.role || prev.role || 'custom';
    const roleLabel = formatAgentRole(roleName);
    const status = mapNodeStatus(payload.status || prev.status);
    const detail = payload.detail || prev.detail || '';
    const durationLabel = payload.durationMs != null ? formatDuration(payload.durationMs) : (prev.durationLabel || '');
    agentRunState.tasks.set(stepId, {
      ...prev,
      stepId,
      taskId: payload.taskId || prev.taskId || null,
      role: roleName,
      roleLabel,
      status,
      detail,
      durationLabel
    });
    ensureAgentPanelVisible();
    renderAgentTaskList();
  }

  function cleanResearchSpeechText(text = '') {
    const lines = String(text || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/<\/?think>/gi, '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^(结论状态|状态|status)\s*[：:]/i.test(line))
      .map(line => line.replace(/^(发言|观点|结论|speech)\s*[：:]\s*/i, '').trim())
      .filter(Boolean);
    const compact = (lines.join(' ') || String(text || '')).replace(/\s+/g, ' ').trim();
    return compact || (isChineseLanguage(appState.language) ? '正在输入...' : 'Typing...');
  }

  function renderAgentDrafts() {
    if (!agentDraftList) return;
    const ordered = Array.from(agentRunState.drafts.values()).sort((a, b) => Number(a.taskId || 0) - Number(b.taskId || 0));
    if (ordered.length === 0) {
      agentDraftList.innerHTML = '';
      return;
    }

    agentDraftList.innerHTML = '';
    agentDraftList.classList.toggle('research-chat-list', !!isResearchModeActive);
    for (const draft of ordered) {
      if (isResearchModeActive) {
        const bubble = document.createElement('div');
        bubble.className = `research-agent-bubble role-${String(draft.role || 'agent').replace(/[^a-z0-9_-]/gi, '')}`;
        bubble.dataset.status = draft.voteOk === true ? 'ok' : (draft.voteOk === false ? 'issue' : 'talking');

        const avatar = document.createElement('span');
        avatar.className = 'research-agent-avatar';
        avatar.textContent = formatResearchAgentLabel(draft.role).slice(0, 1).toUpperCase();

        const card = document.createElement('div');
        card.className = 'research-agent-card';

        const head = document.createElement('div');
        head.className = 'research-agent-head';

        const meta = document.createElement('div');
        meta.className = 'research-agent-meta';

        const name = document.createElement('div');
        name.className = 'research-agent-name';
        name.textContent = formatResearchAgentLabel(draft.role);

        const sub = document.createElement('div');
        sub.className = 'research-agent-round';
        sub.textContent = draft.round
          ? (isChineseLanguage(appState.language) ? `第 ${draft.round} 轮` : `Round ${draft.round}`)
          : (draft.task || '');

        meta.appendChild(name);
        meta.appendChild(sub);
        head.appendChild(meta);

        const text = document.createElement('div');
        text.className = 'research-agent-text';
        text.textContent = cleanResearchSpeechText(draft.content || draft.summary || (isChineseLanguage(appState.language) ? '正在输入...' : 'Typing...'));

        card.appendChild(head);
        card.appendChild(text);

        const reasoning = getResearchReasoningText(draft);
        if (reasoning) {
          const thinkingId = `live-research-thinking-${draft.taskId || Math.random().toString(36).slice(2)}`;
          const wrapper = document.createElement('div');
          wrapper.innerHTML = createResearchThinkingHtml(reasoning, thinkingId).trim();
          const thinkingNode = wrapper.firstElementChild;
          if (thinkingNode) {
            card.appendChild(thinkingNode);
          }
        }

        bubble.appendChild(avatar);
        bubble.appendChild(card);
        agentDraftList.appendChild(bubble);
        bindResearchThinkingToggles(bubble);
        continue;
      }

      const item = document.createElement('div');
      item.className = 'agent-draft-item';
      item.dataset.taskId = String(draft.taskId || '');

      const header = document.createElement('button');
      header.className = `agent-draft-header ${draft.expanded ? 'expanded' : ''}`;
      header.type = 'button';

      const left = document.createElement('span');
      left.className = 'agent-draft-title';
      left.textContent = `${formatAgentRole(draft.role)} · task-${draft.taskId}`;

      const right = document.createElement('span');
      right.className = 'agent-draft-meta';
      const totalTokens = Number(draft.usage?.total_tokens || 0);
      const contentLength = String(draft.content || '').length;
      right.textContent = totalTokens > 0
        ? `tokens ${totalTokens}`
        : (isChineseLanguage(appState.language) ? `${contentLength} 字` : `${contentLength} chars`);

      const icon = document.createElement('span');
      icon.className = 'agent-draft-toggle';
      icon.textContent = draft.expanded ? '▼' : '';

      header.appendChild(left);
      header.appendChild(right);
      header.appendChild(icon);

      const summary = document.createElement('div');
      summary.className = 'agent-draft-summary';
      summary.textContent = draft.summary || '';

      const body = document.createElement('pre');
      body.className = `agent-draft-content ${draft.expanded ? 'expanded' : ''}`;
      body.textContent = draft.content || (isChineseLanguage(appState.language) ? '（草稿生成中或暂无正文）' : '(Draft is streaming or empty)');

      header.addEventListener('click', () => {
        const prev = agentRunState.drafts.get(draft.taskId);
        if (!prev) return;
        prev.expanded = !prev.expanded;
        agentRunState.drafts.set(draft.taskId, prev);
        renderAgentDrafts();
      });

      item.appendChild(header);
      item.appendChild(summary);
      item.appendChild(body);
      agentDraftList.appendChild(item);
    }
  }

  function appendDraftDelta(parsed = {}) {
    const taskId = Number(parsed.taskId || 0);
    const keyTaskId = Number.isFinite(taskId) ? taskId : 0;
    const prev = agentRunState.drafts.get(keyTaskId) || {
      taskId: keyTaskId,
      role: parsed.role || 'custom',
      task: parsed.task || '',
      summary: '',
      content: '',
      usage: {},
      searchCount: 0,
      round: parsed.round || null,
      voteOk: null,
      statusLine: '',
      speech: parsed.speech === true,
      rawContent: '',
      reasoningContent: '',
      expanded: true
    };

    if (parsed.reset) {
      prev.content = '';
      prev.reasoningContent = '';
    }
    const delta = String(parsed.delta || '');
    if (delta) {
      prev.content = `${prev.content || ''}${delta}`;
      const compact = prev.content.replace(/\s+/g, ' ').trim();
      prev.summary = compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
    }
    const reasoningDelta = String(parsed.reasoningDelta || parsed.reasoning_delta || '');
    if (reasoningDelta) {
      prev.reasoningContent = `${prev.reasoningContent || ''}${reasoningDelta}`;
    }
    if (parsed.reasoningContent || parsed.reasoning_content) {
      prev.reasoningContent = parsed.reasoningContent || parsed.reasoning_content || prev.reasoningContent || '';
    }
    prev.role = parsed.role || prev.role;
    prev.task = parsed.task || prev.task;
    prev.round = parsed.round || prev.round || null;
    if (parsed.voteOk !== undefined) prev.voteOk = parsed.voteOk === true;
    prev.statusLine = parsed.statusLine || prev.statusLine || '';
    prev.speech = parsed.speech === true || prev.speech === true;
    prev.rawContent = parsed.rawContent || prev.rawContent || '';
    if (prev.expanded !== false) {
      prev.expanded = true;
    }
    agentRunState.drafts.set(keyTaskId, prev);
    ensureAgentPanelVisible();
    renderAgentDrafts();
  }

  function updateAgentMetrics(metricsPayload = {}) {
    if (!agentMetrics) return;
    const stageDurations = metricsPayload.stageDurations || {};
    const tokenUsageTotal = metricsPayload.tokenUsageTotal || {};
    const plannerMs = Number(stageDurations.planner || 0);
    const subMs = Number(stageDurations.sub_agents || 0);
    const synthMs = Number(stageDurations.synthesis || 0);
    const qualityMs = Number(stageDurations.quality || 0);
    const total = plannerMs + subMs + synthMs + qualityMs;

    const parts = [
      `planner ${formatDuration(plannerMs)}`,
      `parallel ${formatDuration(subMs)}`,
      `synthesis ${formatDuration(synthMs)}`,
      `quality ${formatDuration(qualityMs)}`,
      `total ${formatDuration(total)}`,
      `tokens ${Number(tokenUsageTotal.total_tokens || 0)}`
    ];
    agentMetrics.textContent = parts.join(' · ');
    agentMetrics.style.display = 'block';
    ensureAgentPanelVisible();
  }

  // 更新步骤状态的辅助函数
  function updateStepStatus(element, status, detail = '') {
    if (!element) return;
    const mappedStatus = status === 'active' ? 'running' : mapNodeStatus(status);
    element.setAttribute('data-status', mappedStatus);
    const detailEl = element.querySelector('.thinking-step-detail');
    if (detailEl && detail) {
      detailEl.textContent = detail;
    }
  }

  if (processTraceToggle) {
    processTraceToggle.addEventListener('click', function () {
      const expanded = processTraceList?.classList.contains('expanded');
      if (expanded) {
        processTraceList?.classList.remove('expanded');
        processTraceToggle.classList.remove('expanded');
      } else {
        processTraceList?.classList.add('expanded');
        processTraceToggle.classList.add('expanded');
      }
    });
  }

  if (agentExpandAllBtn) {
    agentExpandAllBtn.addEventListener('click', () => {
      for (const [taskId, draft] of agentRunState.drafts.entries()) {
        draft.expanded = true;
        agentRunState.drafts.set(taskId, draft);
      }
      renderAgentDrafts();
    });
  }

  if (agentCollapseAllBtn) {
    agentCollapseAllBtn.addEventListener('click', () => {
      for (const [taskId, draft] of agentRunState.drafts.entries()) {
        draft.expanded = false;
        agentRunState.drafts.set(taskId, draft);
      }
      renderAgentDrafts();
    });
  }

  let traceReasoningChars = 0;
  let traceItems = 0;
  const processTraceEvents = [];

  function addProcessTraceItem(kind, text) {
    if (!enableProcessTrace) return;
    if (!processTraceList || !text) return;
    processTraceEvents.push({
      ts: Date.now(),
      kind,
      text: String(text)
    });
    if (processTraceEvents.length > 500) {
      processTraceEvents.splice(0, processTraceEvents.length - 500);
    }

    const item = document.createElement('div');
    item.className = `process-dot-item ${kind}`;

    const meta = document.createElement('span');
    meta.className = 'process-dot-meta';
    const labelMap = isChineseLanguage(appState.language)
      ? {
        framework: '框架',
        agent: 'Agent',
        search: '搜索',
        token: 'Token',
        reasoning: '推理',
        info: '信息'
      }
      : {
        framework: 'Framework',
        agent: 'Agent',
        search: 'Search',
        token: 'Token',
        reasoning: 'Reasoning',
        info: 'Info'
      };
    meta.textContent = `[${new Date().toLocaleTimeString()}] ${labelMap[kind] || 'Info'}`;

    const body = document.createElement('span');
    body.className = 'process-dot-text';
    body.textContent = text;

    item.appendChild(meta);
    item.appendChild(body);
    processTraceList.appendChild(item);
    traceItems += 1;
    processTraceList.scrollTop = processTraceList.scrollHeight;
  }

  function appendFrameworkRequirements(promptText) {
    const text = String(promptText || '').trim();
    if (!text) return;
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    addProcessTraceItem('framework', isChineseLanguage(appState.language) ? '开始展示框架要求' : 'Framework requirements begin');
    lines.forEach(line => addProcessTraceItem('framework', line));
    addProcessTraceItem('framework', isChineseLanguage(appState.language) ? '框架要求展示完成' : 'Framework requirements end');
  }

  let agentSelectedRoles = [];
  let agentRetryCount = 0;
  const formatAgentRole = (role) => {
    const roleMap = isChineseLanguage(appState.language)
      ? { master: '主控', judge: '主控校验', planner: '规划', researcher: '检索', synthesizer: '生成', verifier: '校验', gemma: 'Gemma', kimi: 'Kimi K2.5', gpt55: 'GPT-5.5', deepseek: 'DeepSeek V4 Pro' }
      : { master: 'Master', judge: 'Judge', planner: 'Planner', researcher: 'Researcher', synthesizer: 'Synthesizer', verifier: 'Verifier', gemma: 'Gemma', kimi: 'Kimi K2.5', gpt55: 'GPT-5.5', deepseek: 'DeepSeek V4 Pro' };
    return roleMap[role] || role;
  };

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

  const effectiveSystemPrompt = buildEffectiveSystemPrompt();
  const selectedDomainMode = appState.pendingDomainMode || null;
  appState.pendingDomainMode = null;

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
        model: getRequestModelIdForCurrentMode(),
        thinkingMode: appState.thinkingMode,
        thinkingBudget: appState.thinkingBudget,
        reasoningProfile: getRequestReasoningProfileForCurrentMode(),
        internetMode: appState.internetMode,
        researchMode: currentResearchMode,
        agentMode: 'off',
        agentPolicy: appState.agentPolicy,
        qualityProfile: appState.qualityProfile,
        temperature: appState.temperature,
        top_p: appState.topP,
        max_tokens: appState.maxTokens,
        frequency_penalty: appState.frequencyPenalty,
        presence_penalty: appState.presencePenalty,
        domainMode: selectedDomainMode,
        uiLanguage: appState.language,
        promptTimeContext: getUserTimeContext(),
        systemPrompt: effectiveSystemPrompt,
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
      console.log(` 实际使用模型: ${modelUsed}`);
      console.log(`   选择原因: ${appState.lastRoutingReason}`);

      if (appState.selectedModel === 'auto') {
        showModelRoutingInfo(modelUsed, appState.lastRoutingReason);
      }
    }

    appState.currentRequestId = response.headers.get('X-Request-ID');

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorText = await response.text();
        if (errorText) {
          try {
            const parsedError = JSON.parse(errorText);
            errorMessage = parsedError.error || parsedError.message || errorMessage;
          } catch (parseError) {
            errorMessage = errorText;
          }
        }
      } catch (readError) {
        console.warn('Failed to read stream error body:', readError);
      }
      throw new Error(errorMessage);
    }

    if (!response.body) {
      throw new Error('响应体为空');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 显示时间轴并初始化状态
    if (thinkingTimeline) {
      thinkingTimeline.style.display = 'block';
      updateStepStatus(stepToolDecision, 'active', isResearchModeActive
        ? (isChineseLanguage(appState.language) ? '等待多模型编排...' : 'Waiting for model plan...')
        : (isChineseLanguage(appState.language) ? '正在判断...' : 'Deciding...'));
      if (enableProcessTrace) {
        updateStepStatus(stepProcessTrace, 'pending', isChineseLanguage(appState.language) ? '等待模型输出...' : 'Waiting for model output...');
      }
    }

    if (enableProcessTrace) {
      addProcessTraceItem('info', isChineseLanguage(appState.language) ? '开始流式请求' : 'Streaming request started');
      appendFrameworkRequirements(effectiveSystemPrompt);
      addProcessTraceItem('info', isChineseLanguage(appState.language)
        ? `模型: ${modelUsed || appState.selectedModel}`
        : `Model: ${modelUsed || appState.selectedModel}`);
    }

    // 隐藏加载状态
    const loadingStatus = document.getElementById('loadingStatus');
    if (loadingStatus) loadingStatus.style.display = 'none';

    const streamingEl = document.getElementById('streamingContent');
    const aiAvatar = aiMsgDiv.querySelector('.ai-avatar');

    //  多图防抖动缓存（状态外置 + 缓存注入）
    const lastValidMermaids = {}; // 格式: { "0": "code...", "1": "code..." }
    const renderedSvgs = {};      // 格式: { "0": "<svg>...</svg>", "1": "<svg>...</svg>" }
    const renderingMermaids = new Set();

    // ==================== AI Smooth Fusion 渲染队列 ====================
    let charRenderQueue = [];  // 字符渲染队列
    let charRenderTimer = null;  // 渲染定时器
    let isCharRendering = false;  // 渲染状态
    let displayedContent = '';  // 已显示的内容
    let lastMarkdownRender = 0;  // 上次 Markdown 渲染时间
    let lastMermaidRender = 0;  // 上次 Mermaid 渲染时间
    const CHAR_RENDER_INTERVAL = 12;  // 字符渲染间隔 (ms)
    const MARKDOWN_RENDER_INTERVAL = 700;  // Markdown 渲染间隔 (ms) - 足够让动画可见
    const MERMAID_RENDER_INTERVAL = 500;  //  Mermaid 渲染间隔 (ms) - 更快以实现实时效果
    const MAX_ANIMATED_CHARS = 5;  // 最多同时动画的字符数

    // 对最后 N 个字符添加动画效果
    function applyCharAnimations(container) {
      return;
    }

    // 执行 Markdown 渲染 + 动画 + Citations +  内联 Mermaid 替换
    function renderStreamingContent() {
      if (!streamingEl || !displayedContent) return;

      const streamingAskUserResult = extractAskUserBlocks(stripTrailingTitleMarker(displayedContent));
      const contentToDisplay = stripIncompleteAskUserFence(streamingAskUserResult.text).trim();
      let html = renderMarkdownWithMath(contentToDisplay, true);

      // 处理 citations（如果有 sources）
      if (currentSources && currentSources.length > 0) {
        html = renderCitations(html, currentSources);
      }

      //  核心逻辑：将 Mermaid 代码块就地替换为图表容器（缓存注入）
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
          const sanitizedCode = sanitizeMermaidCode(decodedCode);

          // 从缓存获取 SVG（如果没有，显示加载动画）
          const cachedSVG = lastValidMermaids[currentId] === sanitizedCode && renderedSvgs[currentId]
            ? renderedSvgs[currentId]
            : `
                <div class="mermaid-loading"><span>图表 ${currentId + 1} 渲染中...</span></div>
              `;

          // 返回内联图表容器（隐藏代码，只显示图表）
          return `
                <div class="mermaid-inline-wrapper" data-mermaid-index="${currentId}" data-mermaid-code="${encodeURIComponent(sanitizedCode)}">
                  <div class="mermaid-preview-container">
                    ${cachedSVG}
                  </div>
                </div>
              `;
        }
      );

      streamingEl.innerHTML = html;
      if (streamingAskUserResult.prompts.length > 0) {
        streamingAskUserResult.prompts.forEach((prompt) => {
          streamingEl.appendChild(createAskUserCard(prompt));
        });
      }
      hydrateStreamingMermaidCache();
      applyCharAnimations(streamingEl);

      //  异步渲染所有图表
      const now = Date.now();
      if (now - lastMermaidRender >= MERMAID_RENDER_INTERVAL) {
        tryRenderMermaidLive();
        lastMermaidRender = now;
      }

      //  实时处理代码块：添加语言标签、复制按钮、语法高亮
      processCodeBlocksStreaming(streamingEl);

      scrollToBottom();
    }

    function hydrateStreamingMermaidCache() {
      if (!streamingEl) return;
      streamingEl.querySelectorAll('.mermaid-inline-wrapper').forEach((wrapper) => {
        const index = parseInt(wrapper.getAttribute('data-mermaid-index'), 10);
        const code = sanitizeMermaidCode(decodeURIComponent(wrapper.getAttribute('data-mermaid-code') || ''));
        if (!code || isNaN(index)) return;

        wrapper.setAttribute('data-mermaid-code', encodeURIComponent(code));
        if (lastValidMermaids[index] !== code || !renderedSvgs[index]) return;

        const previewContainer = wrapper.querySelector('.mermaid-preview-container');
        if (previewContainer) {
          previewContainer.innerHTML = renderedSvgs[index];
          wrapper.classList.add('rendered');
        }
      });
    }

    //  多图防抖动：查找内联 Mermaid 容器并异步渲染
    async function tryRenderMermaidLive() {
      if (typeof mermaid === 'undefined' || !streamingEl) return;

      // 查找所有内联的 Mermaid 包装容器
      const wrappers = streamingEl.querySelectorAll('.mermaid-inline-wrapper');
      if (wrappers.length === 0) return;

      // 遍历每个内联容器
      wrappers.forEach((wrapper) => {
        const index = parseInt(wrapper.getAttribute('data-mermaid-index'), 10);
        const code = sanitizeMermaidCode(decodeURIComponent(wrapper.getAttribute('data-mermaid-code') || ''));

        if (!code || isNaN(index)) return;

        if (code === lastValidMermaids[index] && renderedSvgs[index]) {
          const previewContainer = wrapper.querySelector('.mermaid-preview-container');
          if (previewContainer && !wrapper.classList.contains('rendered')) {
            previewContainer.innerHTML = renderedSvgs[index];
            wrapper.classList.add('rendered');
          }
          return;
        }

        const renderKey = `${index}:${code}`;
        if (renderingMermaids.has(renderKey)) return;
        renderingMermaids.add(renderKey);

        // 异步渲染（不阻塞主流程）
        (async () => {
          try {
            const svgId = `mermaid-inline-svg-${index}-${Date.now()}`;
            const { svg, code: renderedCode } = await renderMermaidSvg(code, svgId);

            // 3. 缓存结果
            renderedSvgs[index] = svg;
            lastValidMermaids[index] = renderedCode;

            // 4. 直接更新内联容器的 DOM（如果它还存在）
            const currentWrapper = streamingEl.querySelector(`.mermaid-inline-wrapper[data-mermaid-index="${index}"]`);
            const currentCode = currentWrapper
              ? sanitizeMermaidCode(decodeURIComponent(currentWrapper.getAttribute('data-mermaid-code') || ''))
              : '';
            if (currentWrapper && currentCode === renderedCode) {
              const previewContainer = currentWrapper.querySelector('.mermaid-preview-container');
              if (previewContainer) {
                previewContainer.innerHTML = svg;
                currentWrapper.classList.add('rendered');
              }
            }
            // console.log(` Mermaid 图表 #${index + 1} 实时渲染成功`);
          } catch (err) {
            // 渲染失败：保持上一帧（缓存中的 SVG 会在下次 renderStreamingContent 时自动注入）
            // console.debug(` Mermaid 图表 #${index + 1} 语法不完整，保持上一帧`);
          } finally {
            renderingMermaids.delete(renderKey);
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
        //  修复：使用 renderStreamingContent 保持 Mermaid 内联渲染逻辑一致
        renderStreamingContent();

        // 移除所有动画类（流结束）
        streamingEl.querySelectorAll('.streaming-char').forEach(el => {
          el.classList.remove('streaming-char');
        });

        //  修复：最终 Mermaid 渲染（同时支持两种容器格式）
        setTimeout(() => {
          tryRenderMermaidLive();  // 处理 .mermaid-inline-wrapper
          renderMermaidCharts();   // 处理 .mermaid-container (兼容历史消息)
        }, 100);

        //  处理代码块：添加语言标签、复制按钮、语法高亮
        setTimeout(() => processCodeBlocks(streamingEl?.closest('.message')), 50);
      }
    }
    // ==================== 渲染队列结束 ====================

    function appendThinkingSentence(sentence) {
      if (!thinkingEl || !sentence.trim()) return;

      const sentenceSpan = document.createElement('span');
      sentenceSpan.className = 'thinking-sentence';
      // 识别**文本**格式并转换为<strong>标签
      const formattedText = sanitizeReasoningText(sentence);
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
              updateStepStatus(stepToolDecision, 'done', isChineseLanguage(appState.language) ? '已完成判断' : 'Completed');
              updateStepStatus(stepDeepThinking, 'thinking', '');

              // 显示深度思考步骤（如果之前隐藏了）
              if (stepDeepThinking) stepDeepThinking.style.display = '';

              // 更新加载状态文本
              const loadingStatusText = document.getElementById('loadingStatusText');
              if (loadingStatusText) {
                loadingStatusText.textContent = isChineseLanguage(appState.language) ? '深度思考中...' : 'Deep Thinking...';
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
            traceReasoningChars += (parsed.content || '').length;
            addProcessTraceItem('reasoning', parsed.content || '');
            if (processTraceDetail) {
              processTraceDetail.textContent = isChineseLanguage(appState.language)
                ? `已记录 ${traceItems} 条 · 推理 ${traceReasoningChars} 字符`
                : `${traceItems} trace items · reasoning ${traceReasoningChars} chars`;
            }

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
              const formattedText = sanitizeReasoningText(reasoningContent);
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
                updateStepStatus(stepToolDecision, 'done', isChineseLanguage(appState.language) ? '已完成判断' : 'Completed');
                // 隐藏深度思考步骤（非思考模式）
                if (stepDeepThinking && !appState.thinkingMode) {
                  stepDeepThinking.style.display = 'none';
                }
                updateStepStatus(stepGenerating, 'active', isChineseLanguage(appState.language) ? '正在生成...' : 'Generating...');
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
              updateStepStatus(stepDeepThinking, 'done', isChineseLanguage(appState.language) ? '思考完成' : 'Completed');
              updateStepStatus(stepGenerating, 'active', isChineseLanguage(appState.language) ? '正在组织语言...' : 'Organizing response...');

              // 停止AI头像闪烁
              if (aiAvatar) aiAvatar.classList.remove('thinking');
            }

            // 现在开始显示正文 - 使用字符级渲染队列
            const rawChunk = parsed.content || '';
            const cleanChunk = sanitizeToolCallArtifacts(rawChunk);
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
              console.log(` 会话标题已更新: "${parsed.title}"`);
              loadSessions().catch(err => console.error('刷新会话列表失败:', err));

              // 新增：如果处于 ChatFlow iframe 模式，同步标题给父窗口
              if (isChatFlowIframeMode) {
                console.log(' 同步标题给 ChatFlow:', parsed.title);
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
            console.log(` 实际使用模型: ${parsed.model} (${parsed.actualModel})`);
            console.log(`   路由原因: ${parsed.reason || '用户选择'}`);
            addProcessTraceItem('info', isChineseLanguage(appState.language)
              ? `模型路由: ${parsed.model} (${parsed.actualModel})`
              : `Model route: ${parsed.model} (${parsed.actualModel})`);

            // 如果模型与用户选择的不同，显示通知
            if (parsed.model !== appState.selectedModel && appState.selectedModel !== 'auto') {
              showModelRoutingInfo(parsed.model, parsed.reason);
            }
          }
	          else if (parsed.type === 'points_info') {
	            handlePointsInfoEvent(parsed);
	          }
	          else if (parsed.type === 'quota_info') {
	            applyQuotaInfoEvent(parsed);
	            const quotaText = parsed.provider === 'newapi_gpt55'
              ? (isChineseLanguage(appState.language)
                ? `GPT-5.5限免: 剩余 ${userMembershipState.gpt55Remaining}/${userMembershipState.gpt55DailyLimit}`
                : `GPT-5.5 free quota: ${userMembershipState.gpt55Remaining}/${userMembershipState.gpt55DailyLimit} remaining`)
              : (isChineseLanguage(appState.language)
                ? `Poe配额: 剩余 ${userMembershipState.poeRemaining}/${userMembershipState.poeDailyLimit}`
                : `Poe quota: ${userMembershipState.poeRemaining}/${userMembershipState.poeDailyLimit} remaining`);
            addProcessTraceItem('info', quotaText);
          }
          // 新增：处理搜索来源
          else if (parsed.type === 'sources') {
            if (parsed.sources && Array.isArray(parsed.sources)) {
              currentSources = mergeAndReindexSources(currentSources, parsed.sources);
              aiMsg.sources = currentSources;
              console.log(` 收到 ${currentSources.length} 个搜索来源:`, currentSources.map(s => s.title));
              addProcessTraceItem('search', isChineseLanguage(appState.language)
                ? `来源更新: ${currentSources.length} 条`
                : `Sources updated: ${currentSources.length}`);
            }
          }
          else if (parsed.type === 'agent_plan') {
            agentSelectedRoles = Array.isArray(parsed.selectedAgents) ? parsed.selectedAgents : [];
            if (thinkingTimeline) thinkingTimeline.style.display = 'block';
            ensureAgentPanelVisible();
            const rolesText = agentSelectedRoles.map(formatAgentRole).join('、');
            updateStepStatus(stepToolDecision, 'running', isChineseLanguage(appState.language)
              ? `研究编排: ${rolesText || '已启用'}`
              : `Research plan: ${rolesText || 'enabled'}`);
            addProcessTraceItem('agent', isChineseLanguage(appState.language)
              ? `编排完成: ${rolesText || '已启用'}`
              : `Plan ready: ${rolesText || 'enabled'}`);

            if (Array.isArray(parsed.tasks)) {
              parsed.tasks.forEach((task, idx) => {
                const taskId = Number(task.agent_id || idx + 1);
                const stepId = task.stepId || `task-${taskId}`;
                setTaskState({
                  taskId,
                  stepId,
                  role: task.role || 'custom',
                  status: 'pending',
                  detail: task.task || ''
                });
              });
            }
          }
          else if (parsed.type === 'agent_status') {
            if (thinkingTimeline) thinkingTimeline.style.display = 'block';
            const roleName = formatAgentRole(parsed.role);
            const detail = parsed.detail || '';
            addProcessTraceItem('agent', `${roleName} -> ${parsed.status}${detail ? ` (${detail})` : ''}`);

            const mappedStatus = mapNodeStatus(parsed.status);
            const isMasterStage = parsed.role === 'master'
              || String(parsed.stepId || '').includes('master')
              || Number(parsed.taskId || 0) === 999;
            const isTaskScope = !isMasterStage
              && (parsed.scope === 'task' || parsed.taskId != null || String(parsed.stepId || '').startsWith('task-') || String(parsed.stepId || '').startsWith('research-'));

            if (isMasterStage) {
              ensureAgentPanelVisible();
              setTaskState({
                taskId: parsed.taskId,
                stepId: parsed.stepId || 'research-master',
                role: parsed.role || 'master',
                status: mappedStatus,
                detail,
                durationMs: parsed.durationMs
              });
              updateStepStatus(stepToolDecision, 'done', isChineseLanguage(appState.language) ? '讨论完成' : 'Discussion completed');
              updateStepStatus(stepProcessTrace, 'done', isChineseLanguage(appState.language)
                ? `讨论记录完成 · ${traceItems}条`
                : `Discussion logged · ${traceItems} items`);
              updateStepStatus(stepGenerating, mappedStatus, detail || (mappedStatus === 'done'
                ? (isChineseLanguage(appState.language) ? '生成完成' : 'Completed')
                : (isChineseLanguage(appState.language) ? '最终回答生成中...' : 'Final answer streaming...')));
            } else if (isTaskScope) {
              ensureAgentPanelVisible();
              setTaskState({
                taskId: parsed.taskId,
                stepId: parsed.stepId || `task-${parsed.taskId || 0}`,
                role: parsed.role || 'custom',
                status: mappedStatus,
                detail,
                durationMs: parsed.durationMs
              });
              if (mappedStatus === 'running') {
                updateStepStatus(stepToolDecision, 'running', isChineseLanguage(appState.language) ? '子AI正在讨论...' : 'Models are discussing...');
                updateStepStatus(stepProcessTrace, 'running', isChineseLanguage(appState.language) ? '实时展示模型输出...' : 'Showing model output live...');
              }
            } else {
              const stageStepId = String(parsed.stepId || '');
              const targetStep = (stageStepId === 'synthesis' || stageStepId === 'quality')
                ? stepGenerating
                : (stageStepId === 'master' ? stepProcessTrace : stepToolDecision);
              const fallbackText = detail || (isChineseLanguage(appState.language) ? `${roleName}处理中` : `${roleName} running`);
              updateStepStatus(targetStep, mappedStatus, fallbackText);
            }
          }
          else if (parsed.type === 'agent_draft') {
            const parsedTaskId = Number(parsed.taskId);
            const taskId = Number.isFinite(parsedTaskId)
              ? parsedTaskId
              : (agentRunState.drafts.size + 1);
            const prevDraft = agentRunState.drafts.get(taskId) || null;
            const draft = {
              taskId,
              role: parsed.role || prevDraft?.role || 'custom',
              task: parsed.task || prevDraft?.task || '',
              summary: parsed.summary || prevDraft?.summary || '',
              content: parsed.content || prevDraft?.content || '',
              usage: parsed.usage || prevDraft?.usage || {},
              searchCount: Number(parsed.searchCount || prevDraft?.searchCount || 0),
              round: parsed.round || parsed.debateRound || prevDraft?.round || null,
              voteOk: parsed.voteOk !== undefined ? parsed.voteOk === true : (prevDraft?.voteOk ?? null),
              statusLine: parsed.statusLine || prevDraft?.statusLine || '',
              speech: parsed.speech === true || prevDraft?.speech === true,
              rawContent: parsed.rawContent || prevDraft?.rawContent || '',
              reasoningContent: parsed.reasoningContent || parsed.reasoning_content || prevDraft?.reasoningContent || prevDraft?.reasoning_content || '',
              expanded: prevDraft?.expanded ?? true
            };
            agentRunState.drafts.set(taskId, draft);
            ensureAgentPanelVisible();
            renderAgentDrafts();
            setTaskState({
              taskId,
              stepId: parsed.stepId || `task-${taskId}`,
              role: draft.role,
              status: 'done',
              detail: draft.summary || draft.task
            });
            addProcessTraceItem('agent', isChineseLanguage(appState.language)
              ? `收到草稿 task-${taskId} (${formatAgentRole(draft.role)})`
              : `Draft received task-${taskId} (${formatAgentRole(draft.role)})`);
          }
          else if (parsed.type === 'agent_draft_delta') {
            appendDraftDelta(parsed);
            if (parsed.taskId != null) {
              const taskId = Number(parsed.taskId || 0);
              const isMasterDelta = parsed.role === 'master'
                || String(parsed.stepId || '').includes('master')
                || taskId === 999;
              setTaskState({
                taskId,
                stepId: parsed.stepId || `task-${taskId}`,
                role: parsed.role || 'custom',
                status: 'running',
                detail: parsed.task || (isChineseLanguage(appState.language) ? '草稿实时生成中...' : 'Draft streaming...')
              });
              if (isMasterDelta) {
                updateStepStatus(stepToolDecision, 'done', isChineseLanguage(appState.language) ? '讨论完成' : 'Discussion completed');
                updateStepStatus(stepProcessTrace, 'done', isChineseLanguage(appState.language)
                  ? `讨论记录完成 · ${traceItems}条`
                  : `Discussion logged · ${traceItems} items`);
                updateStepStatus(stepGenerating, 'running', isChineseLanguage(appState.language) ? '最终回答实时生成中...' : 'Final answer streaming...');
              } else {
                updateStepStatus(stepToolDecision, 'running', isChineseLanguage(appState.language) ? '子AI正在讨论...' : 'Models are discussing...');
                updateStepStatus(stepProcessTrace, 'running', isChineseLanguage(appState.language) ? '实时展示模型输出...' : 'Showing model output live...');
              }
            }
          }
          else if (parsed.type === 'agent_interjection') {
            addProcessTraceItem('agent', parsed.detail || (isChineseLanguage(appState.language) ? '用户插话已进入讨论上下文' : 'User message added to discussion context'));
            if (stepProcessTrace) {
              updateStepStatus(stepProcessTrace, 'running', isChineseLanguage(appState.language)
                ? '用户新消息已给下一个模型'
                : 'User message will be seen by the next model');
            }
          }
          else if (parsed.type === 'agent_metrics') {
            agentRunState.metrics = parsed;
            updateAgentMetrics(parsed);
            addProcessTraceItem('agent', isChineseLanguage(appState.language)
              ? `阶段耗时已汇总，tokens=${Number(parsed?.tokenUsageTotal?.total_tokens || 0)}`
              : `Metrics ready, tokens=${Number(parsed?.tokenUsageTotal?.total_tokens || 0)}`);
          }
          else if (parsed.type === 'agent_quality') {
            const coverage = parsed.metrics?.claimCoverage ?? '-';
            const contradictions = parsed.metrics?.contradictionCount ?? '-';
            const stopRule = parsed.metrics?.stopRule || '';
            if (stopRule === 'master_decides') {
              updateStepStatus(stepToolDecision, parsed.pass ? 'done' : 'running', parsed.detail || (isChineseLanguage(appState.language)
                ? (parsed.pass ? '主控判断无需继续讨论' : '主控判断继续讨论')
                : (parsed.pass ? 'Master decided to answer' : 'Master requested another round')));
              updateStepStatus(stepProcessTrace, parsed.pass ? 'done' : 'running', isChineseLanguage(appState.language)
                ? `已完成 ${coverage} 个模型发言`
                : `${coverage} model turns completed`);
              addProcessTraceItem('agent', parsed.detail || (isChineseLanguage(appState.language) ? '主控完成研究判定' : 'Master made research decision'));
              continue;
            }
            updateStepStatus(stepToolDecision, parsed.pass ? 'done' : 'running', isChineseLanguage(appState.language)
              ? (parsed.pass ? '主控质量检查通过' : '主控要求继续讨论')
              : (parsed.pass ? 'Master quality check passed' : 'Master requested more discussion'));
            updateStepStatus(stepProcessTrace, parsed.pass ? 'done' : 'running', isChineseLanguage(appState.language)
              ? `覆盖 ${coverage}，冲突 ${contradictions}`
              : `Coverage ${coverage}, contradictions ${contradictions}`);
            addProcessTraceItem('agent', isChineseLanguage(appState.language)
              ? `质量门控: ${parsed.pass ? '通过' : '待改进'} (coverage=${coverage}, contradictions=${contradictions})`
              : `Quality gate: ${parsed.pass ? 'pass' : 'pending'} (coverage=${coverage}, contradictions=${contradictions})`);
          }
          else if (parsed.type === 'agent_retry') {
            agentRetryCount = parsed.round || (agentRetryCount + 1);
            updateStepStatus(stepGenerating, 'running', isChineseLanguage(appState.language)
              ? `返工第${agentRetryCount}轮: ${parsed.reason || '继续优化'}`
              : `Retry #${agentRetryCount}: ${parsed.reason || 'refining'}`);
            addProcessTraceItem('agent', isChineseLanguage(appState.language)
              ? `返工#${agentRetryCount}: ${parsed.reason || '继续优化'}`
              : `Retry #${agentRetryCount}: ${parsed.reason || 'refining'}`);
          }
          //  处理搜索状态 - 更新到时间轴第一步
          else if (parsed.type === 'search_status') {
            if (parsed.status === 'analyzing') {
              // 正在分析是否需要搜索
              updateStepStatus(stepToolDecision, 'active', isChineseLanguage(appState.language) ? '正在分析问题...' : 'Analyzing...');
            } else if (parsed.status === 'searching') {
              // 保存搜索词供后续使用
              currentSearchQuery = parsed.query || '';
              // 决定使用搜索工具，显示搜索词
              updateStepStatus(stepToolDecision, 'active', isChineseLanguage(appState.language)
                ? `联网搜索: "${currentSearchQuery}"`
                : `Web search: "${currentSearchQuery}"`);
              addProcessTraceItem('search', isChineseLanguage(appState.language)
                ? `开始搜索: ${currentSearchQuery}`
                : `Search start: ${currentSearchQuery}`);
            } else if (parsed.status === 'complete') {
              const resultCount = parsed.resultCount || 0;
              currentSearchQuery = parsed.query || currentSearchQuery || '';
              // 搜索完成
              updateStepStatus(stepToolDecision, 'done', isChineseLanguage(appState.language)
                ? `搜索完成 → ${resultCount}条结果`
                : `Search done → ${resultCount} results`);
              // 开始生成回答
              updateStepStatus(stepGenerating, 'active', isChineseLanguage(appState.language) ? '正在生成...' : 'Generating...');
              addProcessTraceItem('search', isChineseLanguage(appState.language)
                ? `搜索完成: ${resultCount} 条`
                : `Search complete: ${resultCount}`);
            } else if (parsed.status === 'no_search') {
              // 不需要搜索
              updateStepStatus(stepToolDecision, 'done', isChineseLanguage(appState.language) ? '不需要联网' : 'No search needed');
              addProcessTraceItem('search', isChineseLanguage(appState.language) ? '无需联网搜索' : 'No web search needed');
            } else if (parsed.status === 'no_results') {
              currentSearchQuery = parsed.query || currentSearchQuery || '';
              // 搜索无结果
              updateStepStatus(stepToolDecision, 'done', isChineseLanguage(appState.language)
                ? `搜索完成 → 无结果`
                : `Search done → No results`);
              addProcessTraceItem('search', isChineseLanguage(appState.language) ? '搜索无结果' : 'No search results');
            }
            scrollToBottom();
          }
          else if (parsed.type === 'done') {
            console.log(' 流式响应完成');

            // 停止字符渲染队列
            stopCharRender();

            // 更新步骤状态：生成回答完成
            updateStepStatus(stepGenerating, 'done', isChineseLanguage(appState.language) ? '生成完成' : 'Completed');
            updateStepStatus(stepProcessTrace, 'done', isChineseLanguage(appState.language)
              ? `过程完成 · ${traceItems}条记录`
              : `Done · ${traceItems} trace items`);
            addProcessTraceItem('info', isChineseLanguage(appState.language) ? '流式响应完成' : 'Streaming completed');

            // 停止AI头像闪烁
            if (aiAvatar) aiAvatar.classList.remove('thinking');
          }
          else if (parsed.type === 'cancelled') {
            console.log(' 响应已取消');
            stopCharRender();  // 停止字符渲染
            updateStepStatus(stepProcessTrace, 'done', isChineseLanguage(appState.language) ? '过程已取消' : 'Trace cancelled');
            addProcessTraceItem('info', isChineseLanguage(appState.language) ? '请求已取消' : 'Request cancelled');
            // 停止AI头像闪烁
            if (aiAvatar) aiAvatar.classList.remove('thinking');
            break;
          }
          else if (parsed.type === 'error') {
            stopCharRender();  // 停止字符渲染
            updateStepStatus(stepProcessTrace, 'done', isChineseLanguage(appState.language) ? '过程异常中断' : 'Trace interrupted by error');
            addProcessTraceItem('info', `${isChineseLanguage(appState.language) ? '错误' : 'Error'}: ${parsed.error || ''}`);
            // 停止AI头像闪烁
            if (aiAvatar) aiAvatar.classList.remove('thinking');
            alert((isChineseLanguage(appState.language) ? 'AI服务错误: ' : 'AI Service Error: ') + (parsed.error || '未知错误'));
            break;
          }
        } catch (e) {
          console.error(' 解析响应错误:', e);
        }
      }
    }

    // 确保停止AI头像闪烁
    if (aiAvatar) aiAvatar.classList.remove('thinking');

    // 合并所有思考句子
    const finalReasoningContent = thinkingSentences.join('') + reasoningContent.trim();

    // 移除标题标记后再保存到appState
    const cleanContent = stripTrailingTitleMarker(fullContent)
      .replace(/<\|[^|]+\|>/g, '')
      .replace(/functions\.web_search:\d+/g, '')
      .trim();

    const taskSnapshot = Array.from(agentRunState.tasks.values()).map(t => ({
      stepId: t.stepId,
      taskId: t.taskId,
      role: t.role,
      status: t.status,
      detail: t.detail || '',
      durationLabel: t.durationLabel || ''
    }));
    const draftSnapshot = Array.from(agentRunState.drafts.values()).map(d => ({
      taskId: d.taskId,
      role: d.role,
      task: d.task || '',
      summary: d.summary || '',
      content: d.content || '',
      usage: d.usage || {},
      searchCount: Number(d.searchCount || 0),
      round: d.round || null,
      voteOk: d.voteOk,
      statusLine: d.statusLine || '',
      speech: d.speech === true,
      rawContent: d.rawContent || '',
      reasoningContent: d.reasoningContent || d.reasoning_content || ''
    }));
    let serializedProcessTrace = null;
    if (enableProcessTrace) {
      const processTraceSnapshot = {
        version: 1,
        mode: (currentResearchMode === 'deep' || currentResearchMode === 'fast')
          ? 'research_debate'
          : (appState.agentMode ? 'agent' : 'single'),
        researchMode: currentResearchMode,
        tasks: taskSnapshot,
        drafts: draftSnapshot,
        metrics: agentRunState.metrics || null,
        trace: processTraceEvents
      };
      if (appState.agentMode && processTraceSnapshot.drafts.length > 0) {
        processTraceSnapshot.forceSubAgents = 4;
      }
      serializedProcessTrace = JSON.stringify(processTraceSnapshot);
    }

    const aiMsg = {
      role: 'assistant',
      content: cleanContent,
      reasoning_content: finalReasoningContent || null,
      model: appState.lastModelUsed || appState.selectedModel,
      enable_search: appState.internetMode,
      internet_mode: appState.internetMode,
      process_trace: serializedProcessTrace,
      sources: currentSources.length > 0 ? currentSources : null,  // 新增：存储来源
      created_at: new Date().toISOString()
    };
    appState.messages.push(aiMsg);

    // 重新渲染所有消息以显示元信息和复制按钮
    renderMessages();

    await loadSessions();

  } catch (error) {
    console.error(' 发送消息错误:', error);
    const message = error?.message || (isChineseLanguage(appState.language)
      ? '发送失败,请检查网络连接'
      : 'Send failed, check network');
    alert(message);
    // 确保停止AI头像闪烁
    const aiAvatar = document.querySelector('.message.assistant:last-child .ai-avatar');
    if (aiAvatar) aiAvatar.classList.remove('thinking');
  } finally {
    if (sendBtn) {
      sendBtn.style.display = 'flex';
      sendBtn.title = isChineseLanguage(appState.language) ? '发送' : 'Send';
    }
    if (stopBtn) stopBtn.style.display = 'none';
    appState.isStreaming = false;
    appState.currentRequestId = null;

    // 重置联网模式为开启状态（用户关闭仅限本次）
    appState.internetMode = true;
    updateToolbarUI();

    // 修复：在流式传输结束后处理标题
    // 提取标题 <<<标题>>> - 匹配回复末尾的三角括号内容
    const fallbackTitle = extractTrailingTitleMarker(fullContent).title;
    if (fallbackTitle) {
      const newTitle = fallbackTitle;
      console.log(` 检测到新标题: "${newTitle}"`);

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
          console.log(' 标题已同步到服务器');
          // 3. 刷新侧边栏
          loadSessions();
        }).catch(err => console.error(' 同步标题失败:', err));
      }
    }
  }
}

// 修复：改进stopGeneration函数
async function stopGeneration() {
  if (!appState.currentRequestId) {
    console.warn(' 没有活跃的请求');
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

    console.log(' 已发送停止请求');
  } catch (error) {
    console.error(' 停止失败:', error);
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
    console.error(' 文件输入框未找到');
    return;
  }

  // 显示提示
  const tooltipText = isChineseLanguage(appState.language) ? '附件' : 'Attach';
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
  const tooltipText = isChineseLanguage(appState.language) ? '联网' : 'Internet';
  showButtonTooltip(internetBtn, tooltipText);

  console.log(` 联网模式: ${appState.internetMode ? '开启' : '关闭'}`);
}

// 切换推理模式
function toggleThinking() {
  const modelConfig = MODELS[appState.selectedModel];
  if (!modelConfig || !modelConfig.supportsThinking) {
    const msg = isChineseLanguage(appState.language)
      ? '当前模型不支持推理模式'
      : 'Current model does not support thinking mode';
    alert(msg);
    return;
  }

  appState.thinkingMode = !appState.thinkingMode;
  updateToolbarUI();

  const thinkingBtn = document.getElementById('thinkingBtn');
  const tooltipText = isChineseLanguage(appState.language) ? '推理' : 'Reasoning';
  showButtonTooltip(thinkingBtn, tooltipText);

  console.log(` 推理模式: ${appState.thinkingMode ? '开启' : '关闭'}`);
}

// 修复：改进handleFileSelected - 添加完整的错误处理
function handleFileSelected(event) {
  if (!event || !event.target) {
    console.error(' 事件对象无效');
    return;
  }

  const files = event.target.files;
  if (!files || files.length === 0) {
    console.warn(' 未选择文件');
    return;
  }

  const file = files[0];
  console.log(` 选中文件: ${file.name} (${(file.size / 1024).toFixed(2)} KB)`);

  // 文件类型验证
  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'];
  if (!allowedTypes.includes(file.type)) {
    const msg = isChineseLanguage(appState.language)
      ? `不支持的文件类型: ${file.type}\n支持的类型: 图片(JPG, PNG, GIF, WebP), PDF, 文本文件`
      : `Unsupported file type: ${file.type}\nSupported: Images (JPG, PNG, GIF, WebP), PDF, Text`;
    alert(msg);
    return;
  }

  // 文件大小验证 (最大10MB)
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    const msg = isChineseLanguage(appState.language)
      ? `文件过大: ${(file.size / 1024 / 1024).toFixed(2)} MB\n最大支持: 10 MB`
      : `File too large: ${(file.size / 1024 / 1024).toFixed(2)} MB\nMax size: 10 MB`;
    alert(msg);
    return;
  }

  // TODO: 实现文件上传到服务器的逻辑
  // 这里应该将文件上传到后端，并获取URL或ID
  // 然后可以在发送消息时附加文件信息
  console.log(' 文件已准备，等待上传实现');

  // 临时提示用户
  const msg = isChineseLanguage(appState.language)
    ? `文件 "${file.name}" 已选择\n注意: 文件上传功能尚未完全实现`
    : `File "${file.name}" selected\nNote: File upload not fully implemented yet`;
  alert(msg);
}

// 修复：改进showModelRoutingInfo
function showModelRoutingInfo(modelUsed, reason) {
  console.log(` [Auto路由] 使用模型: ${modelUsed}, 原因: ${reason}`);
}

// 修复：改进handleViewportResize
function handleViewportResize() {
  // 处理viewport变化时的布局调整
  console.log(' Viewport已调整大小');
}

// ==================== 认证相关 ====================
// 兼容旧代码的handleLogin函数 - 实际调用新的handleAuthSubmit
async function handleLogin(event) {
  if (event) event.preventDefault();
  // 设置为登录模式
  appState.authMode = 'login';
  await handleAuthSubmit();
}

function getOnboardingStorageKey(user = appState.user) {
  const identity = user?.id || user?.email || '';
  return identity ? `rai_onboarding_done:${identity}` : 'rai_onboarding_done';
}

function hasCompletedOnboarding(user = appState.user) {
  return localStorage.getItem(getOnboardingStorageKey(user)) === '1';
}

function setOnboardingCompleted(done = true, user = appState.user) {
  const accountKey = getOnboardingStorageKey(user);
  if (done) {
    localStorage.setItem(accountKey, '1');
    localStorage.setItem('rai_onboarding_done', '1');
    return;
  }
  localStorage.removeItem(accountKey);
  localStorage.removeItem('rai_onboarding_done');
}

async function enterAuthenticatedApp(data) {
  appState.token = data.token;
  appState.user = data.user;
  localStorage.setItem(RAI_TOKEN_KEY, data.token);

  showApp();
  await loadUserData();

  if (data.isNewUser && !hasCompletedOnboarding(data.user)) {
    showOnboarding(() => {
      setOnboardingCompleted(true, data.user);
      showNewUserLanguagePrompt();
    });
  }
  if (data.isNewUser) {
    clearStoredInviteReferrerId();
  }
}

function getOnboardingLanguageQuestionText(lang = appState.language) {
  const normalized = normalizeLanguage(lang);
  if (normalized === 'en') return 'Welcome to RAI.\n\nWhat language would you like to use?';
  if (normalized === 'zh-TW') return '歡迎來到 RAI。\n\n您的語言是？';
  return '欢迎来到 RAI。\n\n您的语言是？';
}

function getOnboardingStartText(lang = appState.language) {
  const normalized = normalizeLanguage(lang);
  if (normalized === 'en') return "Great. Let's get started.";
  if (normalized === 'zh-TW') return '太棒了，讓我們開始吧。';
  return '太棒了，让我们开始吧。';
}

function showNewUserLanguagePrompt() {
  const askPayload = {
    question: isChineseLanguage(appState.language) ? '您的语言是？' : 'What language would you like to use?',
    options: ['简体中文', '繁體中文', 'English'],
    placeholder: isChineseLanguage(appState.language) ? '输入其他语言，按 Enter 记录' : 'Type another language and press Enter to record',
    action: 'set_language'
  };

  appState.currentSession = null;
  appState.messages = [{
    role: 'assistant',
    content: `${getOnboardingLanguageQuestionText()}\n\n\`\`\`rai_ask_user\n${JSON.stringify(askPayload)}\n\`\`\``,
    created_at: new Date().toISOString(),
    model: 'auto',
    localOnboardingLanguagePrompt: true
  }];
  renderMessages();
  focusMessageInputForNewChat(false);
}

function resolveOnboardingLanguage(answer) {
  const value = String(answer || '').trim().toLowerCase();
  if (!value) return appState.language;
  if (value.includes('english') || value === 'en' || value.includes('英文')) return 'en';
  if (value.includes('繁') || value.includes('traditional') || value.includes('tw')) return 'zh-TW';
  if (value.includes('简') || value.includes('簡') || value.includes('simplified') || value.includes('cn')) return 'zh-CN';
  return appState.language;
}

function handleOnboardingLanguageChoice(answer) {
  const selectedLanguage = resolveOnboardingLanguage(answer);
  setLanguage(selectedLanguage);

  const promptMessage = appState.messages.find((message) => message.localOnboardingLanguagePrompt);
  if (promptMessage) {
    promptMessage.content = getOnboardingLanguageQuestionText(selectedLanguage);
    delete promptMessage.localOnboardingLanguagePrompt;
  }

  appState.messages.push(
    {
      role: 'user',
      content: String(answer || '').trim(),
      created_at: new Date().toISOString()
    },
    {
      role: 'assistant',
      content: getOnboardingStartText(selectedLanguage),
      created_at: new Date().toISOString(),
      model: 'auto'
    }
  );

  renderMessages();
  focusMessageInputForNewChat(false);
}

async function handleRegister(event) {
  event.preventDefault();

  const email = document.getElementById('registerEmail').value;
  const password = document.getElementById('registerPassword').value;
  const username = document.getElementById('registerUsername').value;
  const registerBtn = document.getElementById('registerBtn');
  const errorEl = document.getElementById('registerError');

  registerBtn.disabled = true;
  registerBtn.innerHTML = '<span class="loading"></span> ' + (isChineseLanguage(appState.language) ? '注册中...' : 'Registering...');
  errorEl.classList.remove('show');

  try {
	    const response = await fetch(`${API_BASE}/auth/register`, {
	      method: 'POST',
	      headers: { 'Content-Type': 'application/json' },
	      body: JSON.stringify({ email, password, username, referrerId: getStoredInviteReferrerId() || undefined })
	    });

    const data = await response.json();

    if (data.success) {
      await enterAuthenticatedApp(data);
    } else {
      showError(errorEl, data.error || (isChineseLanguage(appState.language) ? '注册失败' : 'Registration failed'));
    }
  } catch (error) {
    showError(errorEl, isChineseLanguage(appState.language) ? '网络错误,请检查服务器连接' : 'Network error');
    console.error(' 注册错误:', error);
  } finally {
    registerBtn.disabled = false;
    registerBtn.textContent = isChineseLanguage(appState.language) ? '注册' : 'Register';
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
      return true;
    } else {
      localStorage.removeItem('rai_token');
      appState.token = null;
      return false;
    }
  } catch (error) {
    console.error(' 验证token失败:', error);
    localStorage.removeItem('rai_token');
    appState.token = null;
    return false;
  }
}

function handleLogout() {
  const confirmMsg = isChineseLanguage(appState.language) ? '确定要登出吗?' : 'Are you sure you want to log out?';
  if (confirm(confirmMsg)) {
    if (typeof closeSettings === 'function') {
      closeSettings({ skipHistory: true });
    }
    // 清除所有认证 token
    localStorage.removeItem(LEGACY_RAUTH_TOKEN_KEY);
    localStorage.removeItem(RAI_TOKEN_KEY);
    appState.token = null;
    appState.user = null;
    appState.sessions = [];
    appState.messages = [];
    appState.currentSession = null;

    const url = new URL(window.location.href);
    url.searchParams.set('rai_logout', String(Date.now()));
    window.location.replace(url.toString());
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

function isValidAuthEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function isEmailReadyForAutoAdvance(email) {
  const value = String(email || '').trim();
  if (!isValidAuthEmail(value)) return false;
  const domain = value.split('@')[1] || '';
  const tld = domain.split('.').filter(Boolean).pop() || '';
  return tld.length >= 3;
}

// 邮箱输入处理 - 检测有效邮箱后显示密码框
function handleEmailInput(input) {
  const email = input.value.trim();
  const shouldAdvance = isEmailReadyForAutoAdvance(email);

  if (shouldAdvance && !appState.authEmailValidated) {
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
  } else if (!shouldAdvance && appState.authEmailValidated) {
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
    const isValidEmail = isValidAuthEmail(email);

    if (isValidEmail) {
      if (!appState.authEmailValidated) {
        showAuthStep('passwordStep');
        showAuthStep('submitStep');
        appState.authEmailValidated = true;
        if (appState.authMode === 'register') {
          showAuthStep('usernameStep');
        }
        document.getElementById('authPassword')?.focus();
      } else {
        // 已经显示了密码框，聚焦到密码框
        document.getElementById('authPassword')?.focus();
      }
    } else {
      // 显示邮箱格式错误
      showAuthError(isChineseLanguage(appState.language) ? '请输入有效的邮箱地址' : 'Please enter a valid email');
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
  if (!email || !isValidAuthEmail(email)) {
    showAuthError(isChineseLanguage(appState.language) ? '请输入有效的邮箱地址' : 'Please enter a valid email');
    return;
  }

  if (!password || password.length < 6) {
    showAuthError(isChineseLanguage(appState.language) ? '密码至少6位字符' : 'Password must be at least 6 characters');
    return;
  }

  hideAuthError();

  // 禁用按钮并显示加载状态
  if (submitBtn) {
    submitBtn.disabled = true;
    const loadingText = appState.authMode === 'login'
      ? (isChineseLanguage(appState.language) ? '登录中...' : 'Logging in...')
      : (isChineseLanguage(appState.language) ? '注册中...' : 'Registering...');
    submitBtn.innerHTML = '<span class="loading"></span> ' + loadingText;
  }

	  try {
	    const endpoint = appState.authMode === 'login' ? 'login' : 'register';
	    const body = appState.authMode === 'login'
	      ? { email, password }
	      : { email, password, username, referrerId: getStoredInviteReferrerId() || undefined };

    const response = await fetch(`${API_BASE}/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (data.success) {
      await enterAuthenticatedApp(data);
    } else {
      showAuthError(data.error || (isChineseLanguage(appState.language) ? '操作失败' : 'Operation failed'));
    }
  } catch (error) {
    showAuthError(isChineseLanguage(appState.language) ? '网络错误,请检查服务器连接' : 'Network error');
    console.error(' 认证错误:', error);
  } finally {
    // 恢复按钮状态
    if (submitBtn) {
      submitBtn.disabled = false;
      const btnText = appState.authMode === 'login'
        ? (isChineseLanguage(appState.language) ? '登录' : 'Login')
        : (isChineseLanguage(appState.language) ? '注册' : 'Register');
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

// ==================== 新用户引导 ====================
function showOnboarding(onDone) {
  const overlay = document.getElementById('onboardingOverlay');
  const card = overlay?.querySelector('.onboarding-card');
  const steps = document.querySelectorAll('.onboarding-step');
  const dots = document.querySelectorAll('.onboarding-dot');
  const skipBtn = document.getElementById('onboardingSkipBtn');
  const nextBtn = document.getElementById('onboardingNextBtn');
  const startBtn = document.getElementById('onboardingStartBtn');
  let currentStep = 0;
  const totalSteps = steps.length;

  function goToStep(n) {
    steps.forEach((s, i) => s.classList.toggle('active', i === n));
    dots.forEach((d, i) => d.classList.toggle('active', i === n));
    if (card) {
      card.dataset.step = String(n);
    }

    if (n === totalSteps - 1) {
      nextBtn.style.display = 'none';
      skipBtn.style.display = 'none';
      startBtn.style.display = 'inline-block';
    } else {
      nextBtn.style.display = 'inline-block';
      skipBtn.style.display = 'inline-block';
      startBtn.style.display = 'none';
    }
    currentStep = n;
  }

  function finish() {
    overlay.style.display = 'none';
    document.body.style.overflow = '';
    if (onDone) onDone();
  }

  skipBtn.onclick = finish;
  startBtn.onclick = finish;

  nextBtn.onclick = () => {
    if (currentStep < totalSteps - 1) {
      goToStep(currentStep + 1);
    }
  };

  // 点击步骤指示器可直接跳转
  dots.forEach(dot => {
    dot.onclick = () => {
      const step = parseInt(dot.dataset.step);
      goToStep(step);
    };
  });

  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  goToStep(0);
}

// 从设置页重新观看引导（清除标记后触发）
function replayOnboarding() {
  setOnboardingCompleted(false);
  // 关闭设置面板
  if (typeof closeSettings === 'function') closeSettings();
  showOnboarding(() => {
    setOnboardingCompleted(true);
  });
}

function showError(element, message) {
  element.textContent = message;
  element.classList.add('show');
}

async function loadUserData() {
  try {
    console.log(' 加载用户数据...');

    const profileResponse = await fetch(`${API_BASE}/user/profile`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!profileResponse.ok) {
      throw new Error(`HTTP ${profileResponse.status}`);
    }

    const profile = await profileResponse.json();

    const realEmail = profile.email || appState.user?.email || '';
    const displayName = profile.username || appState.user?.username || (realEmail ? realEmail.split('@')[0] : (isChineseLanguage(appState.language) ? '用户' : 'User'));

    console.log(' 显示邮箱:', realEmail);

    appState.user = {
      id: profile.id || appState.user?.id || null,
      username: profile.username || displayName,
      email: profile.email || realEmail,
      avatar_url: profile.avatar_url || appState.user?.avatar_url || null,
      externalProvider: profile.external_provider || appState.user?.external_provider || null,
      externalUid: profile.external_uid || appState.user?.external_uid || null,
      external_provider: profile.external_provider || appState.user?.external_provider || null,
      external_uid: profile.external_uid || appState.user?.external_uid || null
    };
    updateUserIdentityUI();

    //  修复：检查profile对象的所有必需字段
    if (profile && typeof profile === 'object') {
      if (profile.default_model !== undefined) {
        const rememberedModel = normalizeSelectedModelId(profile.default_model || 'auto');
        appState.profileDefaultModel = MODELS[rememberedModel] && !isModelDisabledByAdmin(rememberedModel) ? rememberedModel : 'auto';
        appState.selectedModel = appState.profileDefaultModel;
      }
      if (profile.temperature !== undefined) appState.temperature = parseFloat(profile.temperature) || 0.7;
      if (profile.top_p !== undefined) appState.topP = parseFloat(profile.top_p) || 0.9;
      if (profile.max_tokens !== undefined) appState.maxTokens = parseInt(profile.max_tokens, 10) || 2000;
      if (profile.frequency_penalty !== undefined) appState.frequencyPenalty = parseFloat(profile.frequency_penalty) || 0;
      if (profile.presence_penalty !== undefined) appState.presencePenalty = parseFloat(profile.presence_penalty) || 0;
      //  关键修复：正确处理system_prompt，确保始终是字符串
      if (profile.system_prompt !== undefined) {
        appState.systemPrompt = (profile.system_prompt || '');
        console.log(` 加载系统提示词: ${appState.systemPrompt.length}字符`);
      }
      // 读取用户偏好；若模型不支持会在 updateModelControls 里自动关闭
      if (profile.thinking_mode !== undefined) {
        appState.thinkingMode = (profile.thinking_mode === 1 || profile.thinking_mode === true);
      }
      //  修复：保持联网模式默认开启，除非用户明确关闭
      // 数据库默认值0表示"未设置"，不覆盖前端默认值true
      // 前端已默认开启联网，所以这里不再处理 internet_mode

      updateSettingsUI();
      updateSelectedModelText(appState.selectedModel);
      updateModelControls();
      updateMenuSelection();
      updateToolbarUI();
      console.log(' 用户配置已加载到UI');
    } else {
      console.warn(' profile对象格式不正确');
    }

    console.log(' 加载历史会话...');
    await loadSessions();

    if (appState.sessions && appState.sessions.length > 0) {
      console.log(` 找到 ${appState.sessions.length} 个历史会话,自动加载最新会话`);
      await loadSession(appState.sessions[0].id);
    } else {
      console.log(' 无历史会话,显示欢迎界面');
      showWelcome();
    }

    console.log(' 用户数据加载完成');

    //  获取并显示会员状态 + 应用模型策略
    await fetchUserMembership({ applyPolicy: true, initial: true });
    updateUserAreaWithMembership();
  } catch (error) {
    console.error(' 加载用户数据失败:', error);
    if (error.message.includes('500')) {
      console.warn(' 用户配置加载失败,使用默认配置继续');
      showWelcome();
    } else {
      alert((isChineseLanguage(appState.language) ? '加载失败: ' : 'Load failed: ') + error.message);
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

  const icon = prompt('请输入图标 emoji (可选):', '');

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
        icon: icon || ''
      })
    });

    if (!response.ok) throw new Error('创建空间失败');

    const { space } = await response.json();
    console.log(' 空间创建成功:', space);

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
      console.log(' 文件上传成功:', result);

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

    console.log(' 文档删除成功');

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

    console.log(' 空间删除成功');

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
    console.log(` 切换到${scenario}模式:`, params);
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

// ==================== ChatFlow 核心逻辑 ====================

const CHATFLOW_PATCH_MODE_STORAGE_KEY = 'rai_chatflow_patch_apply_mode';
const CHATFLOW_MOBILE_PANEL_MIN = 30;
const CHATFLOW_MOBILE_PANEL_MAX = 70;
const CHATFLOW_MOBILE_PANEL_DEFAULT = 50;
const CHATFLOW_ALLOWED_PATCH_OPS = new Set([
  'add_node',
  'update_node',
  'delete_node',
  'add_edge',
  'update_edge',
  'delete_edge',
  'auto_layout'
]);

// ChatFlow 状态
const chatFlowState = {
  currentFlowId: null,
  sessionId: null,
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
  selectedModel: normalizeSelectedModelId(appState.selectedModel || 'auto') || 'auto',
  thinkingMode: false,
  internetMode: true,
  isStreaming: false,
  currentRequestId: null,
  patchApplyMode: localStorage.getItem(CHATFLOW_PATCH_MODE_STORAGE_KEY) === 'direct' ? 'direct' : 'review',
  pendingCanvasPatch: null,
  canvasHistory: [],
  lastPatchNotice: null,
  activityNotice: null,
  mobilePanelHeight: CHATFLOW_MOBILE_PANEL_DEFAULT
};

function getChatFlowDefaultCanvasState() {
  return {
    nodes: [],
    edges: [],
    viewport: {
      x: 0,
      y: 0,
      zoom: 1
    }
  };
}

function normalizeChatFlowViewport(viewport = {}) {
  const x = Number(viewport?.x);
  const y = Number(viewport?.y);
  const zoom = Number(viewport?.zoom);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  };
}

function normalizeChatFlowCanvasState(rawCanvasState) {
  const canvasState = rawCanvasState && typeof rawCanvasState === 'object'
    ? rawCanvasState
    : getChatFlowDefaultCanvasState();

  return {
    nodes: Array.isArray(canvasState.nodes) ? canvasState.nodes.map(node => ({ ...node })) : [],
    edges: Array.isArray(canvasState.edges) ? canvasState.edges.map(edge => ({ ...edge })) : [],
    viewport: normalizeChatFlowViewport(canvasState.viewport || {})
  };
}

function getChatFlowMessageId(message) {
  const numericId = Number(message?.id);
  return Number.isFinite(numericId) ? numericId : null;
}

function getChatFlowNodeSourceMessageId(node) {
  const numericId = Number(node?.sourceMessageId);
  return Number.isFinite(numericId) ? numericId : null;
}

function getChatFlowNodeSourceIndex(node) {
  const numericIndex = Number(node?.sourceIndex);
  return Number.isFinite(numericIndex) ? numericIndex : null;
}

function isChatFlowMobileViewport() {
  return window.innerWidth <= 768;
}

function getChatFlowPatchModeLabel(mode = chatFlowState.patchApplyMode) {
  if (isChineseLanguage(appState.language)) {
    return mode === 'direct' ? '直接应用' : '审核后应用';
  }
  return mode === 'direct' ? 'Apply Directly' : 'Review First';
}

function updateChatFlowPatchModeButton() {
  const button = document.getElementById('chatflowPatchModeBtn');
  if (button) {
    button.textContent = getChatFlowPatchModeLabel();
  }
}

function updateChatFlowHeaderMeta() {
  const meta = document.getElementById('chatflowHeaderMeta');
  if (!meta) return;
  const modeText = chatFlowState.patchApplyMode === 'direct'
    ? (isChineseLanguage(appState.language) ? 'AI改图: 直接应用' : 'AI edits: direct')
    : (isChineseLanguage(appState.language) ? 'AI改图: 审核后应用' : 'AI edits: review');
  meta.textContent = chatFlowState.sessionId
    ? `${modeText} · Session ${chatFlowState.sessionId.slice(-6)}`
    : modeText;
}

function persistChatFlowPatchMode() {
  localStorage.setItem(CHATFLOW_PATCH_MODE_STORAGE_KEY, chatFlowState.patchApplyMode);
  updateChatFlowPatchModeButton();
  updateChatFlowHeaderMeta();
}

function applyChatFlowMobilePanelHeight() {
  const workspace = document.getElementById('chatFlowWorkspace');
  const panel = document.getElementById('chatflowLLMPanel');
  if (!workspace || !panel) return;

  const clampedHeight = Math.max(
    CHATFLOW_MOBILE_PANEL_MIN,
    Math.min(CHATFLOW_MOBILE_PANEL_MAX, Number(chatFlowState.mobilePanelHeight) || CHATFLOW_MOBILE_PANEL_DEFAULT)
  );
  chatFlowState.mobilePanelHeight = clampedHeight;
  workspace.style.setProperty('--chatflow-mobile-panel-height', `${clampedHeight}vh`);
  panel.style.height = isChatFlowMobileViewport() ? `${clampedHeight}vh` : '';
}

function initChatFlowMobileSheet() {
  if (window._chatFlowMobileSheetInitialized) return;

  const grabber = document.getElementById('chatflowSheetGrabber');
  if (!grabber) return;

  window._chatFlowMobileSheetInitialized = true;
  let isDragging = false;
  let startY = 0;
  let startHeight = CHATFLOW_MOBILE_PANEL_DEFAULT;

  const stopDragging = () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.style.userSelect = '';
    grabber.classList.remove('dragging');
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', stopDragging);
    window.removeEventListener('pointercancel', stopDragging);
  };

  const handlePointerMove = (event) => {
    if (!isDragging || !isChatFlowMobileViewport()) return;
    const deltaY = startY - event.clientY;
    const deltaVh = (deltaY / Math.max(window.innerHeight || 1, 1)) * 100;
    chatFlowState.mobilePanelHeight = Math.max(
      CHATFLOW_MOBILE_PANEL_MIN,
      Math.min(CHATFLOW_MOBILE_PANEL_MAX, startHeight + deltaVh)
    );
    applyChatFlowMobilePanelHeight();
  };

  grabber.addEventListener('pointerdown', (event) => {
    if (!isChatFlowMobileViewport()) return;
    isDragging = true;
    startY = event.clientY;
    startHeight = Number(chatFlowState.mobilePanelHeight) || CHATFLOW_MOBILE_PANEL_DEFAULT;
    document.body.style.userSelect = 'none';
    grabber.classList.add('dragging');
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
    event.preventDefault();
  });

  window.addEventListener('resize', applyChatFlowMobilePanelHeight);
  window.addEventListener('orientationchange', applyChatFlowMobilePanelHeight);
}

function findChatFlowMessageElement({ messageId = null, sourceIndex = null } = {}) {
  const hasMessageId = messageId !== null && messageId !== undefined && String(messageId).trim() !== '';
  const normalizedMessageId = hasMessageId ? Number(messageId) : NaN;
  if (Number.isFinite(normalizedMessageId)) {
    const byId = document.querySelector(`.chatflow-message[data-msg-id="${normalizedMessageId}"]`);
    if (byId) return byId;
  }

  const normalizedIndex = Number(sourceIndex);
  if (Number.isFinite(normalizedIndex)) {
    return document.querySelector(`.chatflow-message[data-msg-index="${normalizedIndex}"]`);
  }

  return null;
}

function snapshotChatFlowCanvas() {
  return JSON.parse(JSON.stringify({
    nodes: chatFlowState.nodes,
    edges: chatFlowState.edges,
    canvas: chatFlowState.canvas
  }));
}

function pushChatFlowCanvasHistory() {
  chatFlowState.canvasHistory.push(snapshotChatFlowCanvas());
  if (chatFlowState.canvasHistory.length > 10) {
    chatFlowState.canvasHistory.shift();
  }
}

function summarizeCanvasPatch(patch) {
  const operations = Array.isArray(patch?.operations) ? patch.operations : [];
  if (!operations.length) {
    return isChineseLanguage(appState.language) ? '没有可应用的画布变更。' : 'No canvas changes to apply.';
  }

  const counts = operations.reduce((acc, operation) => {
    const key = String(operation?.type || '').trim();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const labels = {
    add_node: isChineseLanguage(appState.language) ? '新增节点' : 'Add node',
    update_node: isChineseLanguage(appState.language) ? '修改节点' : 'Update node',
    delete_node: isChineseLanguage(appState.language) ? '删除节点' : 'Delete node',
    add_edge: isChineseLanguage(appState.language) ? '新增连线' : 'Add edge',
    update_edge: isChineseLanguage(appState.language) ? '修改连线' : 'Update edge',
    delete_edge: isChineseLanguage(appState.language) ? '删除连线' : 'Delete edge',
    auto_layout: isChineseLanguage(appState.language) ? '自动布局' : 'Auto layout'
  };

  return Object.entries(counts)
    .map(([type, count]) => `${labels[type] || type} x${count}`)
    .join(' · ');
}

function setChatFlowActivityNotice(title, summary) {
  chatFlowState.activityNotice = {
    title: String(title || ''),
    summary: String(summary || '')
  };
  renderChatFlowPatchBanner();
}

function clearChatFlowActivityNotice() {
  chatFlowState.activityNotice = null;
  renderChatFlowPatchBanner();
}

function getChatFlowWorkingSummary() {
  const parts = [];
  if (chatFlowState.internetMode) {
    parts.push(isChineseLanguage(appState.language) ? '正在准备联网搜索' : 'Preparing web search');
  }
  parts.push(isChineseLanguage(appState.language) ? '正在读取当前画布上下文' : 'Reading canvas context');
  parts.push(isChineseLanguage(appState.language) ? '正在生成回复和画布建议' : 'Generating reply and canvas suggestions');
  return parts.join(' · ');
}

function renderChatFlowPatchBanner() {
  const banner = document.getElementById('chatflowPatchBanner');
  const titleEl = document.getElementById('chatflowPatchBannerTitle');
  const summaryEl = document.getElementById('chatflowPatchSummary');
  const applyBtn = document.getElementById('chatflowPatchApplyBtn');
  const dismissBtn = document.getElementById('chatflowPatchDismissBtn');
  const undoBtn = document.getElementById('chatflowPatchUndoBtn');

  if (!banner || !titleEl || !summaryEl || !applyBtn || !dismissBtn || !undoBtn) return;

  banner.classList.remove('is-working');

  if (chatFlowState.pendingCanvasPatch) {
    banner.style.display = 'block';
    titleEl.textContent = isChineseLanguage(appState.language) ? 'AI 画布建议已准备' : 'AI canvas patch ready';
    summaryEl.textContent = `${summarizeCanvasPatch(chatFlowState.pendingCanvasPatch.patch)}${chatFlowState.pendingCanvasPatch.error ? `\n${chatFlowState.pendingCanvasPatch.error}` : ''}`;
    applyBtn.style.display = chatFlowState.pendingCanvasPatch.valid ? 'inline-flex' : 'none';
    dismissBtn.style.display = 'inline-flex';
    undoBtn.style.display = 'none';
    return;
  }

  if (chatFlowState.activityNotice) {
    banner.style.display = 'block';
    banner.classList.add('is-working');
    titleEl.textContent = chatFlowState.activityNotice.title;
    summaryEl.textContent = chatFlowState.activityNotice.summary;
    applyBtn.style.display = 'none';
    dismissBtn.style.display = 'none';
    undoBtn.style.display = 'none';
    return;
  }

  if (chatFlowState.lastPatchNotice) {
    banner.style.display = 'block';
    titleEl.textContent = chatFlowState.lastPatchNotice.title;
    summaryEl.textContent = chatFlowState.lastPatchNotice.summary;
    applyBtn.style.display = 'none';
    dismissBtn.style.display = 'none';
    undoBtn.style.display = chatFlowState.canvasHistory.length > 0 ? 'inline-flex' : 'none';
    return;
  }

  banner.style.display = 'none';
}

function setChatFlowAppliedPatchNotice(summary) {
  chatFlowState.lastPatchNotice = {
    title: isChineseLanguage(appState.language) ? 'AI 已修改画布' : 'AI patch applied',
    summary
  };
  renderChatFlowPatchBanner();
}

function dismissPendingCanvasPatch() {
  chatFlowState.pendingCanvasPatch = null;
  chatFlowState.lastPatchNotice = null;
  renderChatFlowPatchBanner();
}

function normalizeIncomingCanvasPatch(rawPatch) {
  const rawOperations = Array.isArray(rawPatch?.operations)
    ? rawPatch.operations
    : (Array.isArray(rawPatch?.ops) ? rawPatch.ops : []);

  const operations = rawOperations
    .map((operation) => {
      const type = String(operation?.type || '').trim();
      if (!CHATFLOW_ALLOWED_PATCH_OPS.has(type)) return null;
      return { ...operation, type };
    })
    .filter(Boolean);

  return operations.length > 0 ? { operations } : null;
}

function validateCanvasPatch(rawPatch) {
  const patch = normalizeIncomingCanvasPatch(rawPatch);
  if (!patch) {
    return {
      valid: false,
      patch: null,
      error: isChineseLanguage(appState.language) ? 'AI 返回的画布变更不可解析。' : 'The AI canvas patch could not be parsed.'
    };
  }

  const nodeMap = new Map(chatFlowState.nodes.map(node => [String(node.id), node]));
  for (const operation of patch.operations) {
    if ((operation.type === 'update_node' || operation.type === 'delete_node') && !nodeMap.has(String(operation.id || operation.nodeId))) {
      return {
        valid: false,
        patch,
        error: isChineseLanguage(appState.language) ? `目标节点不存在: ${operation.id || operation.nodeId}` : `Unknown node: ${operation.id || operation.nodeId}`
      };
    }

    if ((operation.type === 'add_edge' || operation.type === 'update_edge') && operation.from && !nodeMap.has(String(operation.from))) {
      return {
        valid: false,
        patch,
        error: isChineseLanguage(appState.language) ? `连线起点不存在: ${operation.from}` : `Unknown edge source: ${operation.from}`
      };
    }

    if ((operation.type === 'add_edge' || operation.type === 'update_edge') && operation.to && !nodeMap.has(String(operation.to))) {
      return {
        valid: false,
        patch,
        error: isChineseLanguage(appState.language) ? `连线终点不存在: ${operation.to}` : `Unknown edge target: ${operation.to}`
      };
    }
  }

  return {
    valid: true,
    patch,
    error: null
  };
}

function reconcileChatFlowNodeMessageRefs() {
  let changed = false;
  chatFlowState.nodes = chatFlowState.nodes.map(node => {
    if (getChatFlowNodeSourceMessageId(node)) return node;
    const sourceIndex = getChatFlowNodeSourceIndex(node);
    if (sourceIndex === null) return node;
    const mappedMessageId = getChatFlowMessageId(chatFlowState.messages[sourceIndex]);
    if (!mappedMessageId) return node;
    changed = true;
    return {
      ...node,
      sourceMessageId: mappedMessageId
    };
  });

  if (changed) {
    saveFlowState();
  }
}

async function reloadChatFlowMessages() {
  if (!chatFlowState.sessionId) return;

  try {
    const response = await fetch(`${API_BASE}/sessions/${chatFlowState.sessionId}/messages`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    chatFlowState.messages = await response.json();
    renderChatFlowMessages();
    reconcileChatFlowNodeMessageRefs();
  } catch (error) {
    console.error(' 刷新 ChatFlow 消息失败:', error);
  }
}

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
    console.error(' 加载 ChatFlow 列表失败:', error);
  }
}

function getFlowLastMessagePreview(flow) {
  const fallback = isChineseLanguage(appState.language) ? '暂无对话总结' : 'No conversation summary yet';
  const text = stripTrailingTitleMarker(flow?.last_message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > 50 ? `${text.slice(0, 50)}...` : text;
}

// 渲染 Flow 列表
function renderFlowsList(flows) {
  const container = document.getElementById('flowsList');
  if (!container) return;

  if (flows.length === 0) {
    const emptyHint = isChineseLanguage(appState.language) ? '暂无 ChatFlow' : 'No ChatFlow';
    container.innerHTML = `<div class="flow-empty-hint">${emptyHint}</div>`;
    return;
  }

  container.innerHTML = flows.map(flow => `
        <div class="flow-item ${chatFlowState.currentFlowId === flow.id ? 'active' : ''}" 
             onclick="openFlow('${flow.id}')" data-flow-id="${flow.id}">
          ${getSvgIcon('rai_logo_colored', 'flow-item-icon rai-flow-logo', 18)}
          <div class="flow-item-main">
            <div class="flow-item-title">${escapeHtml(flow.title)}</div>
            <div class="flow-item-preview">${escapeHtml(getFlowLastMessagePreview(flow))}</div>
          </div>
          <button class="flow-item-delete" onclick="event.stopPropagation(); deleteFlow('${flow.id}')" title="${isChineseLanguage(appState.language) ? '删除' : 'Delete'}">
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
    const defaultTitle = isChineseLanguage(appState.language) ? '新 ChatFlow' : 'New ChatFlow';
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
    console.log(' 创建 ChatFlow 成功:', flow.id);

    await loadFlowsList();
    await openFlow(flow.id);
  } catch (error) {
    console.error(' 创建 ChatFlow 失败:', error);
    alert(isChineseLanguage(appState.language) ? '创建 ChatFlow 失败，请重试' : 'Failed to create ChatFlow, please retry');
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
    const normalizedCanvasState = normalizeChatFlowCanvasState(flow.canvas_state);

    chatFlowState.currentFlowId = flowId;
    chatFlowState.sessionId = flow.session_id || null;
    chatFlowState.messages = Array.isArray(flow.messages)
      ? flow.messages
      : (Array.isArray(flow.chat_history) ? flow.chat_history : []);
    chatFlowState.nodes = normalizedCanvasState.nodes;
    chatFlowState.edges = normalizedCanvasState.edges;
    chatFlowState.canvas = {
      ...chatFlowState.canvas,
      ...normalizedCanvasState.viewport
    };
    chatFlowState.currentRequestId = null;
    chatFlowState.pendingCanvasPatch = null;
    chatFlowState.lastPatchNotice = null;
    chatFlowState.activityNotice = null;
    chatFlowState.canvasHistory = [];
    const layoutWasNormalized = normalizeChatFlowCanvasLayoutIfNeeded();

    // 更新 UI
    document.getElementById('chatflowTitle').textContent = flow.title;
    document.getElementById('chatFlowWorkspace').style.display = 'flex';
    updateChatFlowHeaderMeta();
    updateChatFlowPatchModeButton();
    applyChatFlowMobilePanelHeight();
    renderChatFlowPatchBanner();

    // 初始化画布
    if (!chatFlowState.isInitialized) {
      initChatFlowCanvas();
      initChatFlowDivider();
      initChatFlowMobileSheet();
      chatFlowState.isInitialized = true;
    }

    // 渲染消息和节点
    renderChatFlowMessages();
    renderCanvasNodes();
    renderEdges(); // 修复: 确保重新打开时渲染连线
    updateCanvasTransform();
    if (layoutWasNormalized) {
      fitChatFlowCanvasToNodes();
      saveFlowState();
    }

    // 更新列表选中状态
    renderFlowsList(chatFlowState.flows);
    reconcileChatFlowNodeMessageRefs();
    updateChatFlowControlStates();


    console.log(' 打开 ChatFlow:', flowId);
  } catch (error) {
    console.error(' 打开 ChatFlow 失败:', error);
    alert(isChineseLanguage(appState.language) ? '打开 ChatFlow 失败，请重试' : 'Failed to open ChatFlow, please retry');
  }
}

// 关闭 ChatFlow
function closeChatFlow() {
  document.getElementById('chatFlowWorkspace').style.display = 'none';
  chatFlowState.currentFlowId = null;
  chatFlowState.sessionId = null;
  chatFlowState.currentRequestId = null;
  chatFlowState.pendingCanvasPatch = null;
  chatFlowState.lastPatchNotice = null;
  chatFlowState.canvasHistory = [];
  renderFlowsList(chatFlowState.flows);
}

// 删除 Flow
async function deleteFlow(flowId) {
  const confirmMsg = isChineseLanguage(appState.language) ? '确定要删除这个 ChatFlow 吗？' : 'Are you sure you want to delete this ChatFlow?';
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
    console.log(' 删除 ChatFlow 成功:', flowId);
  } catch (error) {
    console.error(' 删除 ChatFlow 失败:', error);
    alert(isChineseLanguage(appState.language) ? '删除 ChatFlow 失败，请重试' : 'Failed to delete ChatFlow, please retry');
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
    console.error(' 保存 ChatFlow 状态失败:', error);
  }
}

function createChatFlowDragHandle() {
  const handle = document.createElement('div');
  handle.className = 'chatflow-message-drag-handle';
  handle.title = isChineseLanguage(appState.language) ? '拖拽到画布' : 'Drag to canvas';
  handle.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="16" height="16" fill="currentColor">
      <path d="M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z"/>
    </svg>
  `;
  return handle;
}

function createChatFlowMessageElement(message, index) {
  const role = message?.role === 'user' ? 'user' : 'assistant';
  const div = document.createElement('div');
  div.className = `chatflow-message message ${role}`;
  div.draggable = true;
  div.dataset.msgIndex = String(index);
  div.dataset.msgId = getChatFlowMessageId(message) || '';

  div.appendChild(createChatFlowDragHandle());

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  if (role === 'user') {
    applyUserAvatarToElement(avatar);
  } else {
    avatar.innerHTML = getSvgIcon('rai_logo_colored', 'material-symbols-outlined ai-avatar', 24);
  }
  div.appendChild(avatar);

  const content = document.createElement('div');
  content.className = 'message-content';

  const textDiv = document.createElement('div');
  textDiv.className = 'message-text';
  const cleanContent = stripTrailingTitleMarker(message?.content || '');
  const askUserResult = role === 'assistant'
    ? extractAskUserBlocks(cleanContent)
    : { text: cleanContent, prompts: [] };
  let renderedContent = renderMarkdownWithMath(askUserResult.text);

  let sources = message?.sources;
  if (typeof sources === 'string' && sources.trim()) {
    try {
      sources = JSON.parse(sources);
    } catch (error) {
      sources = null;
    }
  }
  if (role === 'assistant' && Array.isArray(sources) && sources.length > 0) {
    renderedContent = renderCitations(renderedContent, sources);
  }

  textDiv.innerHTML = sanitizeRenderedHtml(renderedContent);
  if (textDiv.innerHTML.trim()) {
    content.appendChild(textDiv);
  }

  if (role === 'assistant' && askUserResult.prompts.length > 0) {
    askUserResult.prompts.forEach((prompt) => {
      content.appendChild(createAskUserCard(prompt));
    });
  }

  if (role === 'assistant' && Array.isArray(sources) && sources.length > 0) {
    const sourcesDiv = document.createElement('div');
    sourcesDiv.innerHTML = sanitizeRenderedHtml(renderSourcesList(sources, appState.language));
    content.appendChild(sourcesDiv);
  }

  div.appendChild(content);
  return div;
}

// 渲染 ChatFlow 消息
function renderChatFlowMessages() {
  const container = document.getElementById('chatflowMessages');
  if (!container) return;

  if (chatFlowState.messages.length === 0) {
    const emptyMsg = isChineseLanguage(appState.language) ? '开始对话，然后拖拽消息到画布' : 'Start chatting, then drag messages to canvas';
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

  container.innerHTML = '';
  chatFlowState.messages.forEach((msg, i) => {
    container.appendChild(createChatFlowMessageElement(msg, i));
  });

  setTimeout(() => renderMermaidCharts(), 100);
  setTimeout(() => processCodeBlocks(container), 50);

  // 添加 hover 事件实现双向高亮
  container.querySelectorAll('.chatflow-message').forEach(msgEl => {
    msgEl.addEventListener('mouseenter', () => {
      const msgIndex = parseInt(msgEl.dataset.msgIndex);
      const rawMsgId = msgEl.dataset.msgId;
      const msgId = rawMsgId ? Number(rawMsgId) : NaN;
      // 找到画布上对应的节点并高亮
      chatFlowState.nodes.forEach(node => {
        if ((Number.isFinite(msgId) && getChatFlowNodeSourceMessageId(node) === msgId) ||
          getChatFlowNodeSourceIndex(node) === msgIndex) {
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

// 初始化 ChatFlow 画布
function initChatFlowCanvas() {
  const svg = document.getElementById('infiniteCanvas');
  if (!svg || window._chatFlowCanvasCoreInitialized) return;

  window._chatFlowCanvasCoreInitialized = true;
  let activePanPointerId = null;

  const stopPanning = (event = null) => {
    if (!chatFlowState.canvas.isPanning) return;
    if (event && activePanPointerId !== null && event.pointerId !== activePanPointerId) return;
    chatFlowState.canvas.isPanning = false;
    activePanPointerId = null;
    svg.style.cursor = chatFlowState.currentTool === 'connect' ? 'crosshair' : 'grab';
  };

  svg.addEventListener('pointerdown', (event) => {
    const isCanvasSurface = event.target === svg || event.target.classList.contains('canvas-bg');
    if (!isCanvasSurface) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    chatFlowState.canvas.isPanning = true;
    chatFlowState.canvas.startX = event.clientX - chatFlowState.canvas.translateX;
    chatFlowState.canvas.startY = event.clientY - chatFlowState.canvas.translateY;
    activePanPointerId = event.pointerId;
    svg.style.cursor = 'grabbing';
    svg.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  svg.addEventListener('pointermove', (event) => {
    if (!chatFlowState.canvas.isPanning || event.pointerId !== activePanPointerId) return;
    chatFlowState.canvas.translateX = event.clientX - chatFlowState.canvas.startX;
    chatFlowState.canvas.translateY = event.clientY - chatFlowState.canvas.startY;
    updateCanvasTransform();
  });

  svg.addEventListener('pointerup', stopPanning);
  svg.addEventListener('pointercancel', stopPanning);
  svg.addEventListener('lostpointercapture', stopPanning);

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
      text: isChineseLanguage(appState.language) ? '新建便签' : 'New Sticky Note',
      action: () => addStickyNoteAt(canvasX, canvasY)
    },
    {
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor"><path d="M440-280h80v-160h160v-80H520v-160h-80v160H280v80h160v160ZM200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Z"/></svg>',
      text: isChineseLanguage(appState.language) ? '新建文本节点' : 'New Text Node',
      action: () => addTextNodeAt(canvasX, canvasY)
    },
    { type: 'divider' },
    {
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor"><path d="M212-140v-80h136v-120H200q-33 0-56.5-23.5T120-420v-320q0-33 23.5-56.5T200-820h560q33 0 56.5 23.5T840-740v320q0 33-23.5 56.5T760-340H612v120h136v80H212Z"/></svg>',
      text: isChineseLanguage(appState.language) ? '粘贴剪贴板内容' : 'Paste from Clipboard',
      action: () => pasteClipboardAsNode(canvasX, canvasY)
    },
    { type: 'divider' },
    {
      icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="18" height="18" fill="currentColor"><path d="M480-320q75 0 127.5-52.5T660-500q0-75-52.5-127.5T480-680q-75 0-127.5 52.5T300-500q0 75 52.5 127.5T480-320Zm0-72q-45 0-76.5-31.5T372-500q0-45 31.5-76.5T480-608q45 0 76.5 31.5T588-500q0 45-31.5 76.5T480-392Zm0 192q-146 0-266-81.5T40-500q54-137 174-218.5T480-800q146 0 266 81.5T920-500q-54 137-174 218.5T480-200Z"/></svg>',
      text: isChineseLanguage(appState.language) ? '重置视图' : 'Reset View',
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
    content: isChineseLanguage(appState.language) ? '双击编辑便签...' : 'Double click to edit...',
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
  console.log(' 在位置创建便签:', x, y);
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
  console.log(' 在位置创建文本节点:', x, y);

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
      showToast(isChineseLanguage(appState.language) ? '剪贴板为空' : 'Clipboard is empty');
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
    showToast(isChineseLanguage(appState.language) ? '已粘贴到画布' : 'Pasted to canvas');
    console.log(' 从剪贴板粘贴节点:', x, y);
  } catch (err) {
    console.error('读取剪贴板失败:', err);
    showToast(isChineseLanguage(appState.language) ? '无法读取剪贴板' : 'Cannot read clipboard');
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

// ==================== ChatFlow UI 控制函数 ====================

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
  if (isModelDisabledByAdmin(modelId)) {
    chatFlowState.selectedModel = 'auto';
    updateChatFlowControlStates();
    toggleChatFlowModelMenu();
    return;
  }
  if (isMembershipLockedModel(modelId)) {
    console.warn(' 该模型仅 MAX 会员可用');
    return;
  }
  chatFlowState.selectedModel = modelId;
  const display = document.getElementById('chatflowSelectedModel');
  if (display) {
    display.textContent = modelName || getChatFlowModelLabel(modelId);
  }
  toggleChatFlowModelMenu();
}

function getChatFlowModelLabel(modelId = chatFlowState.selectedModel) {
  const normalizedModelId = normalizeSelectedModelId(modelId || 'auto') || 'auto';
  const model = MODELS[normalizedModelId];
  if (model?.displayName?.[appState.language]) return model.displayName[appState.language];
  return model?.name || normalizedModelId;
}

function updateChatFlowControlStates() {
  const internetToggle = document.getElementById('chatflowInternetToggle');
  if (internetToggle) {
    internetToggle.classList.toggle('active', !!chatFlowState.internetMode);
  }

  const thinkingToggle = document.getElementById('chatflowThinkingToggle');
  if (thinkingToggle) {
    thinkingToggle.classList.toggle('active', !!chatFlowState.thinkingMode);
  }

  const modelLabel = document.getElementById('chatflowSelectedModel');
  if (modelLabel) {
    const label = getChatFlowModelLabel(chatFlowState.selectedModel);
    modelLabel.textContent = isMembershipLockedModel(chatFlowState.selectedModel)
      ? `${label} (MAX)`
      : label;
  }
}

function toggleChatFlowPatchMode() {
  chatFlowState.patchApplyMode = chatFlowState.patchApplyMode === 'review' ? 'direct' : 'review';
  persistChatFlowPatchMode();
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

// ChatFlow 输入处理
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

function buildChatFlowCanvasContext() {
  return {
    nodes: chatFlowState.nodes,
    edges: chatFlowState.edges,
    viewport: {
      x: chatFlowState.canvas.translateX,
      y: chatFlowState.canvas.translateY,
      zoom: chatFlowState.canvas.scale
    },
    selectedNodeIds: Array.from(document.querySelectorAll('.canvas-node.selected')).map(node => node.dataset.nodeId).filter(Boolean),
    flowTitle: document.getElementById('chatflowTitle')?.textContent || ''
  };
}

function buildChatFlowSystemPrompt() {
  const mobileCompactHint = isChatFlowMobileViewport()
    ? (isChineseLanguage(appState.language)
      ? '\n5. 当前是移动端画布浮窗，请尽量简短回答，除非用户明确要长文。'
      : '\n5. This is the mobile canvas sheet. Keep answers concise unless the user asks for depth.')
    : '';

  if (isChineseLanguage(appState.language)) {
    return `你是 RAI 的 ChatFlow 画布助手，职责是帮助用户梳理问题、改写节点、补充结构、整理连线。

注意事项：
1. 正常回答要清晰、可执行、便于用户继续操作画布。
2. 如果需要修改画布，请在正常回答之外，额外输出一个隐藏区块，格式必须严格为：
[CANVAS_OPS]{"operations":[...] }[/CANVAS_OPS]
3. 画布操作只允许使用：add_node、update_node、delete_node、add_edge、update_edge、delete_edge、auto_layout。
4. 每个 add_node 必须提供非空 content。可以附带 fullContent，但不要只写 title、label 或 name。
5. 回复结尾仍然要输出标题，格式必须严格为：[TITLE]标题[/TITLE]。标题不超过15个字。${mobileCompactHint}`;
  }

  return `You are RAI's ChatFlow canvas assistant. Help the user structure ideas, update nodes, and improve graph relationships.

Rules:
1. Keep the visible answer clear and actionable.
2. If the canvas should change, append a hidden block exactly in this format:
[CANVAS_OPS]{"operations":[...]}[/CANVAS_OPS]
3. Allowed operations: add_node, update_node, delete_node, add_edge, update_edge, delete_edge, auto_layout.
4. Every add_node operation must include non-empty content. fullContent is optional, but do not rely only on title, label, or name.
5. End the response with a title marker exactly in this format: [TITLE]Short title[/TITLE].${mobileCompactHint}`;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = typeof value === 'string' ? value : String(value);
    if (text.trim()) return text.trim();
  }
  return '';
}

function getCanvasNodeTextPayload(payload = {}) {
  const content = firstNonEmptyString(
    payload.content,
    payload.text,
    payload.label,
    payload.title,
    payload.name,
    payload.summary,
    payload.description,
    payload.body
  );
  const detail = firstNonEmptyString(
    payload.fullContent,
    payload.markdown,
    payload.details,
    payload.detail,
    payload.notes,
    payload.description,
    payload.body
  );
  const fullContent = detail && detail !== content
    ? firstNonEmptyString(`${content}\n\n${detail}`, detail, content)
    : firstNonEmptyString(detail, content);
  return { content, fullContent };
}

function getCanvasNodeDisplayText(node = {}) {
  return firstNonEmptyString(
    node.content,
    node.text,
    node.label,
    node.title,
    node.name,
    node.summary,
    node.description,
    node.fullContent
  );
}

function normalizeChatFlowNodeType(type) {
  const normalizedType = String(type || '').trim().toLowerCase();
  return ['user', 'assistant', 'text', 'sticky'].includes(normalizedType)
    ? normalizedType
    : 'text';
}

function getAutoCanvasNodePosition(index) {
  const cols = 3;
  return {
    x: 120 + (index % cols) * 320,
    y: 120 + Math.floor(index / cols) * 190
  };
}

function layoutChatFlowNodesGrid() {
  if (!chatFlowState.nodes.length) return;
  const cols = Math.ceil(Math.sqrt(chatFlowState.nodes.length));
  const gapX = 320;
  const gapY = 190;
  chatFlowState.nodes.forEach((node, index) => {
    node.x = 120 + (index % cols) * gapX;
    node.y = 120 + Math.floor(index / cols) * gapY;
    node.width = Math.max(180, Number(node.width) || 260);
    node.height = Math.max(96, Number(node.height) || 126);
    node.type = normalizeChatFlowNodeType(node.type);
  });
}

function normalizeChatFlowCanvasLayoutIfNeeded() {
  if (chatFlowState.nodes.length < 2) return false;
  const buckets = new Map();
  let invalidPositionCount = 0;

  chatFlowState.nodes.forEach((node) => {
    const x = Number(node.x);
    const y = Number(node.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      invalidPositionCount += 1;
      return;
    }
    const key = `${Math.round(x / 24)}:${Math.round(y / 24)}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  });

  const maxOverlap = buckets.size ? Math.max(...buckets.values()) : 0;
  if (invalidPositionCount === 0 && maxOverlap < 2) return false;

  layoutChatFlowNodesGrid();
  return true;
}

function fitChatFlowCanvasToNodes() {
  if (!chatFlowState.nodes.length) return;
  const container = document.getElementById('chatflowCanvasContainer');
  if (!container) return;

  const minX = Math.min(...chatFlowState.nodes.map(node => Number(node.x) || 0));
  const minY = Math.min(...chatFlowState.nodes.map(node => Number(node.y) || 0));
  const maxX = Math.max(...chatFlowState.nodes.map(node => (Number(node.x) || 0) + (Number(node.width) || 220)));
  const maxY = Math.max(...chatFlowState.nodes.map(node => (Number(node.y) || 0) + (Number(node.height) || 120)));
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const padding = 96;
  const availableWidth = Math.max(1, container.clientWidth - padding * 2);
  const availableHeight = Math.max(1, container.clientHeight - padding * 2);
  const nextScale = Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight);

  chatFlowState.canvas.scale = Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1;
  chatFlowState.canvas.translateX = (container.clientWidth - contentWidth * chatFlowState.canvas.scale) / 2 - minX * chatFlowState.canvas.scale;
  chatFlowState.canvas.translateY = (container.clientHeight - contentHeight * chatFlowState.canvas.scale) / 2 - minY * chatFlowState.canvas.scale;
  updateCanvasTransform();
  updateZoomDisplay();
}

function applyValidatedCanvasPatch(patch) {
  let addedNodeCount = 0;
  let shouldFitCanvas = false;

  for (const operation of patch.operations) {
    switch (operation.type) {
      case 'add_node': {
        const baseNode = operation.node && typeof operation.node === 'object' ? operation.node : operation;
        const textPayload = getCanvasNodeTextPayload(baseNode);
        const fallbackContent = isChineseLanguage(appState.language) ? '未命名节点' : 'Untitled node';
        const autoPosition = getAutoCanvasNodePosition(chatFlowState.nodes.length + addedNodeCount);
        const x = Number(baseNode.x);
        const y = Number(baseNode.y);
        const hasX = Number.isFinite(x);
        const hasY = Number.isFinite(y);
        const nextNode = {
          id: String(baseNode.id || `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          type: normalizeChatFlowNodeType(baseNode.type),
          content: String(textPayload.content || fallbackContent).slice(0, 240),
          fullContent: String(textPayload.fullContent || textPayload.content || fallbackContent),
          x: hasX ? x : autoPosition.x,
          y: hasY ? y : autoPosition.y,
          width: Math.max(180, Number(baseNode.width) || 260),
          height: Math.max(96, Number(baseNode.height) || 126),
          color: baseNode.color,
          attachedTo: baseNode.attachedTo,
          sourceMessageId: baseNode.sourceMessageId
        };
        chatFlowState.nodes.push(nextNode);
        addedNodeCount += 1;
        shouldFitCanvas = shouldFitCanvas || !hasX || !hasY;
        break;
      }
      case 'update_node': {
        const nodeId = String(operation.id || operation.nodeId || '');
        const node = chatFlowState.nodes.find(item => String(item.id) === nodeId);
        if (!node) break;
        const payload = operation.node && typeof operation.node === 'object' ? operation.node : operation;
        if (payload.type !== undefined) node.type = normalizeChatFlowNodeType(payload.type);
        const hasTextPayload = ['content', 'text', 'label', 'title', 'name', 'summary', 'description', 'body', 'fullContent'].some(key => payload[key] !== undefined);
        if (hasTextPayload) {
          const textPayload = getCanvasNodeTextPayload(payload);
          if (textPayload.content) node.content = String(textPayload.content).slice(0, 240);
          if (textPayload.fullContent) node.fullContent = String(textPayload.fullContent);
        }
        if (payload.x !== undefined && Number.isFinite(Number(payload.x))) node.x = Number(payload.x);
        if (payload.y !== undefined && Number.isFinite(Number(payload.y))) node.y = Number(payload.y);
        if (payload.width !== undefined && Number.isFinite(Number(payload.width))) node.width = Math.max(80, Number(payload.width));
        if (payload.height !== undefined && Number.isFinite(Number(payload.height))) node.height = Math.max(50, Number(payload.height));
        if (payload.color !== undefined) node.color = payload.color;
        if (payload.attachedTo !== undefined) node.attachedTo = payload.attachedTo;
        if (payload.sourceMessageId !== undefined) node.sourceMessageId = payload.sourceMessageId;
        break;
      }
      case 'delete_node': {
        const nodeId = String(operation.id || operation.nodeId || '');
        chatFlowState.nodes = chatFlowState.nodes.filter(node => String(node.id) !== nodeId);
        chatFlowState.edges = chatFlowState.edges.filter(edge => String(edge.from) !== nodeId && String(edge.to) !== nodeId);
        break;
      }
      case 'add_edge': {
        chatFlowState.edges.push({
          id: String(operation.id || `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          from: String(operation.from),
          to: String(operation.to),
          label: String(operation.label || '')
        });
        break;
      }
      case 'update_edge': {
        const edgeId = String(operation.id || operation.edgeId || '');
        const edge = chatFlowState.edges.find(item => String(item.id) === edgeId);
        if (!edge) break;
        if (operation.from !== undefined) edge.from = String(operation.from);
        if (operation.to !== undefined) edge.to = String(operation.to);
        if (operation.label !== undefined) edge.label = String(operation.label || '');
        break;
      }
      case 'delete_edge': {
        const edgeId = String(operation.id || operation.edgeId || '');
        chatFlowState.edges = chatFlowState.edges.filter(edge => String(edge.id) !== edgeId);
        break;
      }
      case 'auto_layout': {
        autoLayoutNodes();
        shouldFitCanvas = true;
        break;
      }
      default:
        break;
    }
  }

  if (normalizeChatFlowCanvasLayoutIfNeeded()) {
    shouldFitCanvas = true;
  }

  renderCanvasNodes();
  renderEdges();
  if (addedNodeCount > 0 || shouldFitCanvas) {
    fitChatFlowCanvasToNodes();
  }
  saveFlowState();
}

function applyPendingCanvasPatch() {
  if (!chatFlowState.pendingCanvasPatch?.valid || !chatFlowState.pendingCanvasPatch.patch) return;
  pushChatFlowCanvasHistory();
  applyValidatedCanvasPatch(chatFlowState.pendingCanvasPatch.patch);
  setChatFlowAppliedPatchNotice(summarizeCanvasPatch(chatFlowState.pendingCanvasPatch.patch));
  chatFlowState.pendingCanvasPatch = null;
  renderChatFlowPatchBanner();
}

function undoLastCanvasPatch() {
  const previousSnapshot = chatFlowState.canvasHistory.pop();
  if (!previousSnapshot) return;
  chatFlowState.nodes = previousSnapshot.nodes || [];
  chatFlowState.edges = previousSnapshot.edges || [];
  chatFlowState.canvas = {
    ...chatFlowState.canvas,
    ...(previousSnapshot.canvas || {})
  };
  renderCanvasNodes();
  renderEdges();
  updateCanvasTransform();
  updateZoomDisplay();
  saveFlowState();
  chatFlowState.lastPatchNotice = null;
  renderChatFlowPatchBanner();
}

function handleIncomingCanvasPatchEvent(eventPayload) {
  const validation = validateCanvasPatch(eventPayload?.patch);
  const patchSummary = validation.patch ? summarizeCanvasPatch(validation.patch) : '';
  if (!validation.valid) {
    chatFlowState.pendingCanvasPatch = {
      patch: validation.patch,
      valid: false,
      error: eventPayload?.error || validation.error
    };
    renderChatFlowPatchBanner();
    return;
  }

  if (chatFlowState.patchApplyMode === 'direct') {
    pushChatFlowCanvasHistory();
    applyValidatedCanvasPatch(validation.patch);
    setChatFlowAppliedPatchNotice(patchSummary);
    return;
  }

  chatFlowState.pendingCanvasPatch = {
    patch: validation.patch,
    valid: true,
    error: null
  };
  chatFlowState.lastPatchNotice = null;
  renderChatFlowPatchBanner();
}

function updateChatFlowTitleLocal(title) {
  const trimmedTitle = String(title || '').trim();
  if (!trimmedTitle) return;

  const titleEl = document.getElementById('chatflowTitle');
  if (titleEl) {
    titleEl.textContent = trimmedTitle;
  }

  const flow = chatFlowState.flows.find(item => item.id === chatFlowState.currentFlowId);
  if (flow) {
    flow.title = trimmedTitle;
    renderFlowsList(chatFlowState.flows);
  }
}

// ==================== ChatFlow LLM 调用 ====================

// 发送 ChatFlow 消息
async function sendChatFlowMessage() {
  const input = document.getElementById('chatflowMessageInput');
  if (!input || !chatFlowState.currentFlowId || chatFlowState.isStreaming) return;

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
  chatFlowState.pendingCanvasPatch = null;
  setChatFlowActivityNotice(
    isChineseLanguage(appState.language) ? 'RAI 正在处理' : 'RAI is working',
    getChatFlowWorkingSummary()
  );

  let aiMessage = null;
  let streamErrorMessage = '';
  let streamWasCancelled = false;
  let currentSources = [];

  try {
    const messages = chatFlowState.messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${appState.token}`
      },
      body: JSON.stringify({
        flowId: chatFlowState.currentFlowId,
        sessionId: chatFlowState.sessionId,
        messages,
        model: normalizeSelectedModelId(chatFlowState.selectedModel || 'auto'),
        thinkingMode: chatFlowState.thinkingMode || false,
        reasoningProfile: normalizeReasoningProfile(appState.reasoningProfile),
        internetMode: chatFlowState.internetMode || false,
        stream: true,
        promptTimeContext: getUserTimeContext(),
        systemPrompt: buildChatFlowSystemPrompt(),
        canvasContext: buildChatFlowCanvasContext(),
        canvasApplyMode: chatFlowState.patchApplyMode,
        uiSurface: isChatFlowMobileViewport() ? 'chatflow-mobile' : 'chatflow-desktop'
      })
    });

    if (!response.ok) {
      throw new Error('API 请求失败');
    }
    chatFlowState.currentRequestId = response.headers.get('X-Request-ID') || null;

    aiMessage = { role: 'assistant', content: '', timestamp: Date.now() };
    chatFlowState.messages.push(aiMessage);
    renderChatFlowMessages();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
	          if (parsed.type === 'points_info') {
	            handlePointsInfoEvent(parsed);
	            continue;
	          }

	          if (parsed.type === 'quota_info') {
	            applyQuotaInfoEvent(parsed);
	            continue;
	          }

          if (parsed.type === 'search_status') {
            if (parsed.status === 'searching') {
              const queryText = parsed.query ? `: ${parsed.query}` : '';
              setChatFlowActivityNotice(
                isChineseLanguage(appState.language) ? 'RAI 正在联网搜索' : 'RAI is searching the web',
                isChineseLanguage(appState.language) ? `正在搜索${queryText}` : `Searching${queryText}`
              );
            } else if (parsed.status === 'done') {
              const count = Number(parsed.count || parsed.resultCount || 0);
              setChatFlowActivityNotice(
                isChineseLanguage(appState.language) ? '联网搜索已完成' : 'Web search complete',
                isChineseLanguage(appState.language) ? `已找到 ${count} 条来源，正在整理回答和画布建议` : `${count} sources found. Preparing reply and canvas suggestions.`
              );
            } else if (parsed.status === 'analyzing') {
              setChatFlowActivityNotice(
                isChineseLanguage(appState.language) ? 'RAI 正在分析问题' : 'RAI is analyzing',
                getChatFlowWorkingSummary()
              );
            } else if (parsed.status === 'no_search') {
              setChatFlowActivityNotice(
                isChineseLanguage(appState.language) ? 'RAI 正在处理画布' : 'RAI is working on the canvas',
                isChineseLanguage(appState.language) ? '无需联网，正在生成回复和画布建议' : 'No web search needed. Generating reply and canvas suggestions.'
              );
            }
            continue;
          }

          if (parsed.type === 'sources' && Array.isArray(parsed.sources)) {
            currentSources = mergeAndReindexSources(currentSources, parsed.sources);
            if (aiMessage) aiMessage.sources = currentSources;
            setChatFlowActivityNotice(
              isChineseLanguage(appState.language) ? '来源已更新' : 'Sources updated',
              isChineseLanguage(appState.language) ? `收到 ${currentSources.length} 条来源，正在继续生成` : `${currentSources.length} sources received. Continuing generation.`
            );
            continue;
          }

          if (parsed.type === 'content' && parsed.content) {
            aiMessage.content += parsed.content;
            const msgContainer = document.getElementById('chatflowMessages');
            const lastMsg = msgContainer?.querySelector('.chatflow-message:last-child .message-text');
            if (lastMsg) {
              lastMsg.innerHTML = renderMarkdownWithMath(aiMessage.content);
            }
            continue;
          }

          if (parsed.type === 'title' && parsed.title) {
            updateChatFlowTitleLocal(parsed.title);
            continue;
          }

          if (parsed.type === 'canvas_patch') {
            setChatFlowActivityNotice(
              isChineseLanguage(appState.language) ? 'RAI 正在整理画布' : 'RAI is updating the canvas',
              isChineseLanguage(appState.language) ? '已收到画布修改建议，正在校验并渲染' : 'Canvas changes received. Validating and rendering.'
            );
            handleIncomingCanvasPatchEvent(parsed);
            continue;
          }

          if (parsed.type === 'cancelled') {
            streamWasCancelled = true;
            if (aiMessage && !aiMessage.content) {
              aiMessage.content = isChineseLanguage(appState.language) ? '(已停止生成)' : '(Generation stopped)';
            }
            continue;
          }

          if (parsed.type === 'error' && parsed.error) {
            streamErrorMessage = parsed.error;
          }
        } catch (e) {
          console.warn(' ChatFlow SSE 解析失败:', e);
        }
      }
    }

    if (streamErrorMessage) {
      throw new Error(streamErrorMessage);
    }

    if (streamWasCancelled) {
      renderChatFlowMessages();
    }
    renderChatFlowMessages();
    await reloadChatFlowMessages();
    await loadFlowsList();
  } catch (error) {
    console.error(' ChatFlow LLM 调用失败:', error);
    if (aiMessage) {
      aiMessage.content = `抱歉，发生了错误: ${error.message}`;
    } else {
      chatFlowState.messages.push({
        role: 'assistant',
        content: `抱歉，发生了错误: ${error.message}`,
        timestamp: Date.now()
      });
    }
    renderChatFlowMessages();
  } finally {
    // 恢复按钮状态
    document.getElementById('chatflowSendBtn').style.display = 'flex';
    document.getElementById('chatflowStopBtn').style.display = 'none';
    chatFlowState.isStreaming = false;
    clearChatFlowActivityNotice();

    // 保存状态
    chatFlowState.currentRequestId = null;
    saveFlowState();
  }
}

// 停止生成
async function stopChatFlowGeneration() {
  if (!chatFlowState.currentRequestId) return;

  try {
    await fetch(`${API_BASE}/chat/stop`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requestId: chatFlowState.currentRequestId
      })
    });
  } catch (error) {
    console.error(' 停止 ChatFlow 生成失败:', error);
  }
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
function createCanvasNode(message, x, y, sourceReference = null) {
  const nodeId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const sourceIndex = typeof sourceReference === 'object' && sourceReference !== null
    ? Number(sourceReference.sourceIndex ?? sourceReference.index)
    : Number(sourceReference);
  const messageIdFromMessage = getChatFlowMessageId(message);
  const sourceMessageId = typeof sourceReference === 'object' && sourceReference !== null
    ? Number(sourceReference.sourceMessageId ?? sourceReference.messageId ?? messageIdFromMessage)
    : messageIdFromMessage;
  const normalizedSourceIndex = Number.isFinite(sourceIndex) ? sourceIndex : null;
  const normalizedSourceMessageId = Number.isFinite(sourceMessageId) ? sourceMessageId : null;

  // 清理 Markdown 标记
  const messageContent = typeof message?.content === 'string' ? message.content : String(message?.content || '');
  const cleanContent = messageContent
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
    fullContent: messageContent,
    sourceIndex: normalizedSourceIndex,
    sourceMessageId: normalizedSourceMessageId,
    x: x,
    y: y,
    width: 200,
    height: 100
  };

  chatFlowState.nodes.push(node);
  renderCanvasNodes();
  renderEdges();
  saveFlowState();

  console.log(' 创建节点:', nodeId);
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

  console.log(' 从选中文本创建节点:', nodeId);
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
    const sourceIndex = getChatFlowNodeSourceIndex(node);
    const sourceMessageId = getChatFlowNodeSourceMessageId(node);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'canvas-node');
    g.setAttribute('data-node-id', node.id);
    g.setAttribute('data-source-index', sourceIndex === null ? '' : String(sourceIndex));
    g.setAttribute('data-source-message-id', sourceMessageId === null ? '' : String(sourceMessageId));
    g.setAttribute('data-node-type', node.type || 'text');
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
      roleText.textContent = typeLabels[normalizeChatFlowNodeType(node.type)] || 'TEXT';
      g.appendChild(roleText);
    }

    // 内容文本（使用 foreignObject 支持换行）
    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', '8');
    fo.setAttribute('y', node.type === 'sticky' ? '8' : '24');
    fo.setAttribute('width', node.width - 16);
    fo.setAttribute('height', node.height - (node.type === 'sticky' ? 16 : 32));

    const div = document.createElement('div');
    const rootStyle = getComputedStyle(document.body || document.documentElement);
    const textColor = node.type === 'sticky'
      ? '#333333'
      : (rootStyle.getPropertyValue('--text-primary').trim() || '#ECECEC');
    div.style.cssText = `height: 100%; font-size: 12px; line-height: 1.38; color: ${textColor}; overflow: hidden; white-space: pre-wrap; word-break: break-word;`;
    div.textContent = getCanvasNodeDisplayText(node) || (isChineseLanguage(appState.language) ? '双击编辑节点' : 'Double click to edit');
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
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();

      const resizeStartX = event.clientX;
      const resizeStartY = event.clientY;
      const resizeStartWidth = node.width;
      const resizeStartHeight = node.height;
      const pointerId = event.pointerId;

      const handleResizeMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const dx = (moveEvent.clientX - resizeStartX) / chatFlowState.canvas.scale;
        const dy = (moveEvent.clientY - resizeStartY) / chatFlowState.canvas.scale;
        const newWidth = Math.max(80, resizeStartWidth + dx);
        const newHeight = Math.max(50, resizeStartHeight + dy);

        node.width = newWidth;
        node.height = newHeight;

        rect.setAttribute('width', newWidth);
        rect.setAttribute('height', newHeight);
        fo.setAttribute('width', newWidth - 16);
        fo.setAttribute('height', newHeight - (node.type === 'sticky' ? 16 : 32));
        resizeHandle.setAttribute('x', newWidth - 12);
        resizeHandle.setAttribute('y', newHeight - 12);

        const ports = g.querySelectorAll('.canvas-node-port');
        ports.forEach(p => {
          const portId = p.getAttribute('data-port');
          if (portId === 'top') p.setAttribute('cx', newWidth / 2);
          if (portId === 'bottom') {
            p.setAttribute('cx', newWidth / 2);
            p.setAttribute('cy', newHeight);
          }
          if (portId === 'left') p.setAttribute('cy', newHeight / 2);
          if (portId === 'right') {
            p.setAttribute('cx', newWidth);
            p.setAttribute('cy', newHeight / 2);
          }
        });

        renderEdges();
      };

      const stopResize = (endEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', handleResizeMove);
        window.removeEventListener('pointerup', stopResize);
        window.removeEventListener('pointercancel', stopResize);
        saveFlowState();
      };

      resizeHandle.setPointerCapture?.(pointerId);
      window.addEventListener('pointermove', handleResizeMove);
      window.addEventListener('pointerup', stopResize);
      window.addEventListener('pointercancel', stopResize);
    });

    // 添加拖拽功能
    g.addEventListener('pointerdown', (event) => {
      if (event.target.classList.contains('canvas-node-port')) return;
      if (event.target.classList.contains('canvas-node-resize')) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      document.querySelectorAll('.canvas-node.selected').forEach(el => el.classList.remove('selected'));
      g.classList.add('selected');

      if (chatFlowState.currentTool !== 'select') {
        event.stopPropagation();
        return;
      }

      const startX = event.clientX;
      const startY = event.clientY;
      const startNodeX = node.x;
      const startNodeY = node.y;
      const pointerId = event.pointerId;

      const handleDragMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const dx = (moveEvent.clientX - startX) / chatFlowState.canvas.scale;
        const dy = (moveEvent.clientY - startY) / chatFlowState.canvas.scale;
        node.x = startNodeX + dx;
        node.y = startNodeY + dy;
        g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
        renderEdges();
      };

      const stopDragging = (endEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        window.removeEventListener('pointermove', handleDragMove);
        window.removeEventListener('pointerup', stopDragging);
        window.removeEventListener('pointercancel', stopDragging);
        saveFlowState();
      };

      g.setPointerCapture?.(pointerId);
      window.addEventListener('pointermove', handleDragMove);
      window.addEventListener('pointerup', stopDragging);
      window.addEventListener('pointercancel', stopDragging);
      event.stopPropagation();
      event.preventDefault();
    });

    // 单击高亮对应消息
    g.addEventListener('click', (e) => {
      if (e.target.classList.contains('canvas-node-port')) return;
      highlightMessage({
        messageId: getChatFlowNodeSourceMessageId(node),
        sourceIndex: getChatFlowNodeSourceIndex(node)
      });
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

// 在登录后加载 ChatFlow 列表
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

// 初始化 ChatFlow 拖拽功能
function initChatFlowDragDrop() {
  if (window._chatFlowDragDropInitialized) return;

  const messagesContainer = document.getElementById('chatflowMessages');
  const container = document.getElementById('chatflowCanvasContainer');
  if (!messagesContainer || !container) return;

  window._chatFlowDragDropInitialized = true;
  console.log(' 初始化 ChatFlow 拖拽支持');

  messagesContainer.addEventListener('dragstart', (event) => {
    const msgElement = event.target.closest('.chatflow-message');
    if (!msgElement) return;

    const messageIndex = Number(msgElement.dataset.msgIndex);
    const rawMessageId = msgElement.dataset.msgId;
    const messageId = rawMessageId ? Number(rawMessageId) : NaN;
    const message = chatFlowState.messages[messageIndex];
    if (!message) return;

    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', JSON.stringify({
      type: 'message',
      index: messageIndex,
      messageId: Number.isFinite(messageId) ? messageId : null
    }));
    msgElement.classList.add('dragging');
  });

  messagesContainer.addEventListener('dragend', (event) => {
    const msgElement = event.target.closest('.chatflow-message');
    msgElement?.classList.remove('dragging');
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    container.classList.add('drag-over');
  });

  container.addEventListener('dragleave', () => {
    container.classList.remove('drag-over');
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.classList.remove('drag-over');

    try {
      const rect = container.getBoundingClientRect();
      const x = (e.clientX - rect.left - chatFlowState.canvas.translateX) / chatFlowState.canvas.scale;
      const y = (e.clientY - rect.top - chatFlowState.canvas.translateY) / chatFlowState.canvas.scale;
      const dataStr = e.dataTransfer.getData('text/plain');
      let handled = false;

      if (dataStr) {
        try {
          const data = JSON.parse(dataStr);
          if (data?.type === 'message') {
            const messageIndex = Number(data.index);
            const message = chatFlowState.messages[messageIndex];
            if (message) {
              createCanvasNode(message, x, y, {
                sourceIndex: messageIndex,
                messageId: data.messageId
              });
              handled = true;
            }
          } else if (data?.type === 'selected-text' && data.text) {
            createTextNode(data.text, x, y);
            handled = true;
          }
        } catch (parseError) {
          // 非结构化 JSON，继续按普通文本处理
        }
      }

      if (!handled) {
        const plainText = dataStr || e.dataTransfer.getData('text');
        if (plainText && plainText.trim()) {
          createTextNode(plainText.trim(), x, y);
        }
      }
    } catch (err) {
      console.error(' 处理拖拽数据失败:', err);
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
  canvasContainer.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
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
  canvasContainer.addEventListener('pointermove', (e) => {
    if (!chatFlowState.connectingFrom) return;

    const previewLine = document.getElementById('edgePreviewLine');
    if (previewLine) {
      const point = getCanvasPoint(e.clientX, e.clientY);
      previewLine.setAttribute('x2', point.x);
      previewLine.setAttribute('y2', point.y);
    }
  });

  canvasContainer.addEventListener('pointerup', (e) => {
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
  });

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
  });
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
  console.log(' 创建连线:', edgeId);
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
      const labelText = String(edge.label || '');
      const labelWidth = Math.max(44, Math.min(180, labelText.length * 13 + 20));

      const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      labelBg.setAttribute('class', 'canvas-edge-label-bg');
      labelBg.setAttribute('x', labelX - labelWidth / 2);
      labelBg.setAttribute('y', labelY - 10);
      labelBg.setAttribute('width', String(labelWidth));
      labelBg.setAttribute('height', '20');
      labelBg.setAttribute('rx', '4');
      g.appendChild(labelBg);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('class', 'canvas-edge-label');
      text.setAttribute('x', labelX);
      text.setAttribute('y', labelY + 4);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '11');
      text.textContent = labelText;
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
  deleteItem.textContent = isChineseLanguage(appState.language) ? '删除连线' : 'Delete Connection';
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
    content: isChineseLanguage(appState.language) ? '双击编辑便签...' : 'Double click to edit...',
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
    alert(isChineseLanguage(appState.language) ? '请先选择要删除的节点' : 'Please select nodes to delete');
    return;
  }

  const confirmMsg = isChineseLanguage(appState.language)
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
    alert(isChineseLanguage(appState.language) ? '请先选择一个节点进行拆解' : 'Please select a node to decompose');
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
        model: 'kimi-k2.5',
        reasoningProfile: normalizeReasoningProfile(appState.reasoningProfile),
        promptTimeContext: getUserTimeContext(),
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
    alert(isChineseLanguage(appState.language) ? 'AI 拆解失败，请重试' : 'AI decomposition failed, please retry');
  }
}

// ==================== 自动布局 ====================

function autoLayoutNodes() {
  if (chatFlowState.nodes.length === 0) return;

  layoutChatFlowNodesGrid();

  renderCanvasNodes();
  renderEdges();
  saveFlowState();
  fitChatFlowCanvasToNodes();
}

// ==================== 双向高亮 ====================

function highlightMessage(reference = {}) {
  // 清除所有高亮
  document.querySelectorAll('.chatflow-message.highlighted').forEach(el => {
    el.classList.remove('highlighted');
  });

  // 高亮对应消息
  const normalizedReference = typeof reference === 'object' && reference !== null
    ? reference
    : { sourceIndex: reference };
  const msgEl = findChatFlowMessageElement(normalizedReference);
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
    showToast(isChineseLanguage(appState.language) ? 'Mermaid 代码已复制到剪贴板' : 'Mermaid code copied to clipboard');
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
    title.textContent = isChineseLanguage(appState.language) ? '编辑便签' : 'Edit Sticky Note';
  } else {
    title.textContent = isChineseLanguage(appState.language) ? '编辑节点' : 'Edit Node';
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
    ? (isChineseLanguage(appState.language) ? '输入便签内容...' : 'Enter note content...')
    : (isChineseLanguage(appState.language) ? '输入节点内容...' : 'Enter node content...');
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
  cancelBtn.textContent = isChineseLanguage(appState.language) ? '取消' : 'Cancel';
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
    { text: isChineseLanguage(appState.language) ? '编辑内容' : 'Edit Content', action: () => editNodeContent(nodeId) },
    { text: isChineseLanguage(appState.language) ? '添加注释' : 'Add Annotation', action: () => addAnnotationToNode(nodeId) },
    { text: isChineseLanguage(appState.language) ? '删除节点' : 'Delete Node', action: () => deleteNode(nodeId) }
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

  const promptMsg = isChineseLanguage(appState.language) ? '输入注释内容:' : 'Enter annotation:';
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
  const confirmMsg = isChineseLanguage(appState.language) ? '确定删除此节点？' : 'Delete this node?';
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

  const presetLabels = isChineseLanguage(appState.language)
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
      const customLabel = isChineseLanguage(appState.language) ? '自定义...' : 'Custom...';
      const promptMsg = isChineseLanguage(appState.language) ? '输入连线标签:' : 'Enter edge label:';

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
      console.log(' 自动保存完成');
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

  let context = '\n\n---\n **当前思维画布内容：**\n\n';

  // 1. 输出所有节点
  if (chatFlowState.nodes.length > 0) {
    context += '**节点列表：**\n';
    chatFlowState.nodes.forEach((node, index) => {
      const typeLabel = {
        'user': ' 用户',
        'assistant': ' AI',
        'sticky': ' 便签',
        'text': ' 文本'
      }[node.type] || ' 节点';

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
  let shouldFocusAfterRender = false;

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

    console.log(` 加载了 ${data.sessions.length} 个会话，总计 ${appState.sessions.length}，还有更多: ${data.hasMore}`);
    if (appState.messages.length === 0) {
      shouldFocusAfterRender = true;
    }

  } catch (error) {
    console.error(' 加载会话失败:', error);
    if (reset) {
      appState.sessions = [];
    }
  } finally {
    appState.sessionsPagination.isLoading = false;
    renderSessions();
    if (shouldFocusAfterRender) {
      focusMessageInputForNewChat(appState.pendingMobileComposerFocus);
    }
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

  setScrollFollowMode('following');

  // 隐藏对话索引导航器
  const navigator = document.getElementById('chatIndexNavigator');
  if (navigator) {
    navigator.classList.remove('visible');
    navigator.classList.add('hidden');
  }

  maybeAutoFocusMobileHomeInput();
  focusMessageInputForNewChat(appState.pendingMobileComposerFocus);
}

// 别名，确保兼容性
const renderWelcomeScreen = showWelcome;

function cancelPendingAutoScroll() {
  if (appState.pendingScrollTimer) {
    clearTimeout(appState.pendingScrollTimer);
    appState.pendingScrollTimer = null;
  }
}

function setScrollFollowMode(mode = 'following') {
  appState.scrollFollowMode = mode;
  appState.userScrolledUp = mode === 'pausedByUser';
  updateScrollResumeButton();
}

function getScrollResumeButtonText() {
  return isChineseLanguage(appState.language) ? '回到底部' : 'Jump to latest';
}

function ensureScrollResumeButton() {
  let button = document.getElementById('scrollResumeBtn');
  const host = document.querySelector('.input-wrapper') || document.querySelector('.main-content');
  if (!host) return null;

  if (button) {
    if (button.parentElement !== host) {
      host.appendChild(button);
    }
    return button;
  }

  button = document.createElement('button');
  button.id = 'scrollResumeBtn';
  button.type = 'button';
  button.className = 'scroll-resume-btn hidden';
  button.innerHTML = getSvgIcon('south', 'scroll-resume-icon', 20);
  button.addEventListener('click', () => {
    resumeAutoScroll();
  });
  host.appendChild(button);
  return button;
}

function updateScrollResumeButton() {
  const button = ensureScrollResumeButton();
  const container = getChatScrollElement();
  const messagesList = document.getElementById('messagesList');
  if (!button || !container) return;

  const buttonLabel = getScrollResumeButtonText();
  button.setAttribute('aria-label', buttonLabel);
  button.title = buttonLabel;
  const shouldShow = (
    window.innerWidth > 768 &&
    appState.scrollFollowMode === 'pausedByUser' &&
    !!messagesList &&
    messagesList.style.display !== 'none' &&
    container.scrollHeight > container.clientHeight + 24
  );

  button.classList.toggle('hidden', !shouldShow);
  button.classList.toggle('visible', shouldShow);
}

function isNearBottom(threshold = null) {
  const container = getChatScrollElement();
  if (!container) return true;
  const resolvedThreshold = threshold || Math.max(appState.scrollBottomThreshold, Math.round(container.clientHeight * 0.2));
  return (container.scrollHeight - container.scrollTop - container.clientHeight) <= resolvedThreshold;
}

function performScrollToBottom() {
  const container = getChatScrollElement();
  if (!container) return;

  appState.isProgrammaticScroll = true;
  container.scrollTop = container.scrollHeight;
  appState.lastScrollTop = container.scrollTop;
  window.setTimeout(() => {
    appState.isProgrammaticScroll = false;
  }, 80);
}

function scrollToBottom(force = false) {
  const container = getChatScrollElement();
  if (!container) return;
  if (appState.scrollFollowMode === 'pausedByUser' && !force) return;

  cancelPendingAutoScroll();
  appState.pendingScrollTimer = window.setTimeout(() => {
    performScrollToBottom();
    if (force || isNearBottom()) {
      setScrollFollowMode('following');
    }
    appState.pendingScrollTimer = null;
  }, 16);
}

function resumeAutoScroll() {
  setScrollFollowMode('following');
  scrollToBottom(true);
}

let chatScrollListenerInitialized = false;

function initChatScrollListener() {
  if (chatScrollListenerInitialized) return;

  chatScrollListenerInitialized = true;
  ensureScrollResumeButton();

  document.addEventListener('scroll', (event) => {
    if (!isPrimaryChatScrollTarget(event.target)) return;

    const container = getChatScrollElement();
    if (!container) return;
    if (appState.isProgrammaticScroll) return;

    const currentScrollTop = container.scrollTop;
    const nearBottom = isNearBottom();
    const scrolledUp = currentScrollTop < (appState.lastScrollTop - 6);

    if (scrolledUp && !nearBottom) {
      cancelPendingAutoScroll();
      setScrollFollowMode('pausedByUser');
    } else if (nearBottom) {
      setScrollFollowMode('following');
    }

    appState.lastScrollTop = currentScrollTop;
  }, { passive: true, capture: true });

  updateScrollResumeButton();
  console.log(' 智能滚动监听器已初始化');
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

async function createNewSession(options = {}) {
  try {
    const shouldFocus = options.focus !== false;
    appState.pendingMobileComposerFocus = shouldFocus && window.innerWidth <= 768;
    const response = await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appState.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: isChineseLanguage(appState.language) ? '新对话' : 'New Chat',
        model: appState.selectedModel || 'auto'  // 默认为auto或当前选择的模型
      })
    });

    const data = await response.json();

    if (data.success) {
      await loadSessions();
      await loadSession(data.sessionId);
      if (shouldFocus) {
        focusMessageInputForNewChat(true);
      }

      // 移除移动端自动弹出侧边栏
      // if (window.innerWidth <= 768) {
      //   toggleSidebar();
      // }
      return true;
    }
    return false;
  } catch (error) {
    console.error(' 创建会话失败:', error);
    alert(isChineseLanguage(appState.language) ? '创建对话失败' : 'Failed to create chat');
    return false;
  }
}

async function loadSession(sessionId) {
  try {
    console.log(' 加载会话:', sessionId);

    const response = await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
      headers: { 'Authorization': `Bearer ${appState.token}` }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const messages = await response.json();

    appState.currentSession = appState.sessions.find(s => s.id === sessionId);
    appState.messages = Array.isArray(messages) ? messages : [];

    console.log(` 加载到 ${messages.length} 条消息`);

    renderMessages();
    renderSessions();
    if (appState.messages.length === 0) {
      focusMessageInputForNewChat(appState.pendingMobileComposerFocus);
    }

    // 移除移动端自动弹出侧边栏
    // if (window.innerWidth <= 768) {
    //   toggleSidebar();
    // }

  } catch (error) {
    console.error(' 加载消息失败:', error);
    alert(isChineseLanguage(appState.language) ? '加载对话失败' : 'Failed to load chat');
  }
}

// ==================== 侧边栏滑动手势 ====================
function initSwipeGestures() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('mobileOverlay');
  const mainContent = document.querySelector('.main-content');
  const mobileHeader = document.getElementById('mobileHeader');

  if (!mainContent || !sidebar || !overlay) return;

  const gestureLockDistance = 12;
  const gestureCommitDistance = 20;
  const horizontalDominanceRatio = 1.2;

  const isMobileViewport = () => window.matchMedia('(max-width: 768px)').matches;
  const getSidebarWidth = () => sidebar.getBoundingClientRect().width || sidebar.offsetWidth || window.innerWidth * 0.85;
  const isGestureBlockedTarget = (target) => Boolean(target?.closest(
    '.input-area, textarea, input, select, [contenteditable=\"true\"], .model-dropdown-menu, .more-menu, .thinking-budget-modal, .settings-modal, .settings-content, .header-controls, .hamburger-btn, .control-btn, .mobile-model-selector'
  ));

  const setOverlayProgress = (progress, dragging = false) => {
    const normalized = Math.max(0, Math.min(progress, 1));
    overlay.classList.toggle('dragging', dragging);

    if (normalized <= 0) {
      overlay.classList.remove('active');
      overlay.style.opacity = '';
      return;
    }

    overlay.classList.add('active');
    overlay.style.opacity = normalized.toFixed(3);
  };

  const setSidebarProgress = (progress, dragging = false) => {
    const width = getSidebarWidth();
    const normalized = Math.max(0, Math.min(progress, 1));
    const translateX = (normalized - 1) * width;

    sidebar.classList.toggle('dragging', dragging);
    sidebar.style.transform = `translateX(${Math.round(translateX)}px)`;
    setOverlayProgress(normalized, dragging);
  };

  const resetSwipeState = () => {
    appState.touchStartX = 0;
    appState.touchStartY = 0;
    appState.touchMoveX = 0;
    appState.isSwiping = false;
    appState.sidebarGestureMode = null;
    appState.sidebarGestureLocked = false;
    sidebar.classList.remove('dragging');
    overlay.classList.remove('dragging');
  };

  const handleTouchStart = (e) => {
    if (!isMobileViewport() || !e.touches?.length) return;

    const touch = e.touches[0];
    const target = e.target;
    const onSidebar = !!target.closest('#sidebar');
    const onOverlay = !!target.closest('#mobileOverlay');
    const onHeader = !!target.closest('#mobileHeader');
    const onMain = !!target.closest('.main-content');

    const canOpen = !appState.sidebarOpen && (onMain || onHeader) && !isGestureBlockedTarget(target);
    const canClose = appState.sidebarOpen && (onSidebar || onOverlay);

    if (!canOpen && !canClose) return;

    appState.touchStartX = touch.clientX;
    appState.touchStartY = touch.clientY;
    appState.touchMoveX = touch.clientX;
    appState.isSwiping = false;
    appState.sidebarGestureMode = canOpen ? 'opening' : 'closing';
    appState.sidebarGestureLocked = false;

    if (canClose) {
      overlay.classList.add('active');
    }
  };

  const handleTouchMove = (e) => {
    if (!appState.sidebarGestureMode || !e.touches?.length) return;

    const touch = e.touches[0];
    const deltaX = touch.clientX - appState.touchStartX;
    const deltaY = Math.abs(touch.clientY - appState.touchStartY);
    appState.touchMoveX = touch.clientX;

    if (!appState.sidebarGestureLocked) {
      if (Math.abs(deltaX) < gestureLockDistance && deltaY < gestureLockDistance) {
        return;
      }

      if (deltaY > Math.abs(deltaX) * horizontalDominanceRatio) {
        resetSwipeState();
        return;
      }

      const movingWrongWay = appState.sidebarGestureMode === 'opening' ? deltaX <= 0 : deltaX >= 0;
      if (movingWrongWay) {
        if (Math.abs(deltaX) > gestureCommitDistance && Math.abs(deltaX) > deltaY * horizontalDominanceRatio) {
          resetSwipeState();
        }
        return;
      }

      if (Math.abs(deltaX) < gestureCommitDistance || Math.abs(deltaX) < deltaY * horizontalDominanceRatio) {
        return;
      }

      appState.sidebarGestureLocked = true;
    }

    appState.isSwiping = true;

    const width = getSidebarWidth();
    const rawProgress = appState.sidebarGestureMode === 'opening'
      ? Math.max(0, deltaX) / width
      : 1 + (Math.min(0, deltaX) / width);

    setSidebarProgress(rawProgress, true);
    e.preventDefault();
  };

  const handleTouchEnd = () => {
    if (!appState.sidebarGestureMode) return;

    if (!appState.isSwiping) {
      resetSwipeState();
      return;
    }

    const width = getSidebarWidth();
    const deltaX = appState.touchMoveX - appState.touchStartX;
    const finalProgress = appState.sidebarGestureMode === 'opening'
      ? Math.max(0, deltaX) / width
      : 1 + (Math.min(0, deltaX) / width);
    const shouldOpen = appState.sidebarGestureMode === 'opening'
      ? finalProgress > 0.24
      : finalProgress > 0.5;

    resetSwipeState();

    if (shouldOpen) {
      openSidebar();
    } else {
      closeSidebar();
    }
  };

  [mainContent, mobileHeader, sidebar, overlay].forEach((element) => {
    if (!element) return;
    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('touchmove', handleTouchMove, { passive: false });
    element.addEventListener('touchend', handleTouchEnd, { passive: true });
    element.addEventListener('touchcancel', handleTouchEnd, { passive: true });
  });
}

function selectModel(value, displayName) {
  appState.selectedModel = normalizeSelectedModelId(value);
  updateSelectedModelText(appState.selectedModel);

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
  persistDefaultModelPreference(appState.selectedModel);
}

// 修复：添加null检查和安全的DOM操作
function toggleThinkingContent(id) {
  if (!id) return;

  const content = document.getElementById(id);
  const icon = document.getElementById(`${id}-icon`);

  if (!content || !icon) {
    console.warn(` 找不到元素: ${id}`);
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
      console.log(' 从本地存储加载设置成功');
    } catch (e) {
      console.warn(' 解析本地设置失败:', e);
    }
  }
}

// 初始化完毕后调用
if (document.readyState !== 'loading') {
  updateModelControls();
} else {
  document.addEventListener('DOMContentLoaded', updateModelControls);
}

// ==================== 移动端键盘处理器 (iOS/Android IME 稳定版) ====================
class MobileKeyboardHandler {
  constructor(options = {}) {
    this.options = {
      scrollThreshold: options.scrollThreshold || 0.85,
      debug: options.debug || false,
      ...options
    };

    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    this.isAndroid = /Android/i.test(navigator.userAgent);
    this.isMobile = this.isIOS || this.isAndroid;

    this.root = document.documentElement;
    this.body = document.body;
    this.activeInput = null;
    this.keyboardOpen = false;
    this.visualViewport = window.visualViewport || null;
    this.inputContainer = document.getElementById('inputContainer');
    this.inputArea = document.querySelector('.input-area');
    this.chatContainer = document.getElementById('chatContainer');
    this.rafId = null;
    this.composerObserver = null;

    this.handleViewportChange = this.handleViewportChange.bind(this);
    this.handleFocusIn = this.handleFocusIn.bind(this);
    this.handleFocusOut = this.handleFocusOut.bind(this);
    this.handleControlPointerDown = this.handleControlPointerDown.bind(this);
    this.syncComposerMetrics = this.syncComposerMetrics.bind(this);

    if (this.isMobile) {
      this.init();
    }
  }

  log(...args) {
    if (this.options.debug) console.log('[MobileKeyboard]', ...args);
  }

  init() {
    this.root.classList.add('mobile-viewport-managed');
    this.body.classList.add('mobile-viewport-managed');

    this.updateViewportVars();
    this.syncComposerMetrics();
    this.setupViewportListeners();
    this.setupFocusListeners();
    this.setupControlFocusGuard();
    this.setupComposerObserver();

    if (this.isAndroid) this.applyAndroidFixes();
    if (this.isIOS) this.applyIOSFixes();

    this.log('MobileKeyboardHandler initialized', {
      isIOS: this.isIOS,
      isAndroid: this.isAndroid
    });
  }

  setupViewportListeners() {
    if (this.visualViewport && !this.isIOS) {
      // iOS 使用原生键盘布局，避免在键盘动画期间反复改写高度变量
      this.visualViewport.addEventListener('resize', this.handleViewportChange);
    }
    if (!this.isIOS) {
      window.addEventListener('resize', this.handleViewportChange);
    }
    window.addEventListener('orientationchange', this.handleViewportChange);
  }

  setupFocusListeners() {
    document.addEventListener('focusin', this.handleFocusIn);
    document.addEventListener('focusout', this.handleFocusOut);
  }

  setupControlFocusGuard() {
    document.addEventListener('pointerdown', this.handleControlPointerDown, true);
  }

  setupComposerObserver() {
    if (!this.inputArea || typeof ResizeObserver === 'undefined') return;

    this.composerObserver = new ResizeObserver(() => {
      this.syncComposerMetrics();
    });
    this.composerObserver.observe(this.inputArea);
  }

  updateViewportVars() {
    if (this.isIOS) {
      this.keyboardOpen = Boolean(this.activeInput);
      this.root.style.setProperty('--app-height', '100dvh');
      this.root.style.setProperty('--viewport-offset-top', '0px');
      this.root.style.setProperty('--keyboard-offset', '0px');
      this.body.classList.toggle('keyboard-open', this.keyboardOpen);
      return;
    }

    const viewportHeight = this.visualViewport ? Math.round(this.visualViewport.height) : window.innerHeight;
    const viewportTop = this.visualViewport ? Math.max(0, Math.round(this.visualViewport.offsetTop || 0)) : 0;
    const appHeight = Math.max(320, viewportHeight);
    const keyboardHeight = Math.max(0, window.innerHeight - viewportHeight - viewportTop);
    const keyboardThreshold = this.isIOS ? 120 : 150;

    this.keyboardOpen = keyboardHeight > keyboardThreshold;
    this.root.style.setProperty('--app-height', `${appHeight}px`);
    this.root.style.setProperty('--viewport-offset-top', `${viewportTop}px`);
    this.root.style.setProperty('--keyboard-offset', `${keyboardHeight}px`);
    this.body.classList.toggle('keyboard-open', this.keyboardOpen);

    this.log('Viewport sync', {
      appHeight,
      viewportHeight,
      viewportTop,
      keyboardHeight,
      keyboardOpen: this.keyboardOpen
    });
  }

  syncComposerMetrics() {
    if (!this.inputArea) return;

    const measurementTarget = this.inputArea.querySelector('.input-container, .input-wrapper') || this.inputArea;
    const composerHeight = Math.ceil(measurementTarget.getBoundingClientRect().height || 0);
    if (composerHeight > 0) {
      this.root.style.setProperty('--composer-height', `${composerHeight}px`);
    }
  }

  handleViewportChange() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }

    this.rafId = requestAnimationFrame(() => {
      this.updateViewportVars();
      this.syncComposerMetrics();

      if (this.isAndroid && this.keyboardOpen) {
        this.keepChatAnchored();
      }
    });
  }

  handleFocusIn(event) {
    const target = event.target;
    if (!this.isInputElement(target)) return;

    this.activeInput = target;

    if (window.expandInput && !window.appState?.inputExpanded) {
      window.expandInput();
    }

    if (this.isIOS) {
      this.updateViewportVars();
      return;
    }

    this.updateViewportVars();
    this.syncComposerMetrics();

    // interactive-widget=resizes-content + dvh 已处理键盘布局
    // 不再在 focus 阶段强推二次/三次重算，避免键盘动画期间抖动
  }

  handleFocusOut(event) {
    if (event.target !== this.activeInput) return;

    this.activeInput = null;

    if (this.isIOS) {
      this.updateViewportVars();
      return;
    }

    window.setTimeout(() => {
      if (!document.querySelector('textarea:focus, input:focus')) {
        this.updateViewportVars();
      }
    }, 120);
  }

  handleControlPointerDown(event) {
    if (!this.isMobile) return;

    const target = event.target;
    const input = document.getElementById('messageInput');
    if (!input || document.activeElement !== input) return;
    if (!this.shouldPreserveInputFocus(target)) return;

    event.preventDefault();
  }

  shouldPreserveInputFocus(target) {
    if (!target || !(target instanceof Element)) return false;
    if (target.closest('textarea, input[type="text"], input[type="email"], input[type="password"], select')) return false;
    if (target.closest('input[type="range"], .reasoning-profile-slider, .research-mode-slider, .thinking-budget-slider')) return false;

    return Boolean(
      target.closest('.send-btn, .stop-btn')
    );
  }

  keepChatAnchored(force = false) {
    const scrollElement = getChatScrollElement();
    if (!scrollElement) return;
    if (appState?.userScrolledUp && !force) return;

    scrollElement.scrollTop = scrollElement.scrollHeight;
  }

  restoreInputFocus() {
    if (!this.isMobile) return;

    const input = document.getElementById('messageInput');
    if (!input || input.disabled) return;
    if (!this.keyboardOpen && document.activeElement !== input) return;

    const selectionStart = typeof input.selectionStart === 'number' ? input.selectionStart : input.value.length;
    const selectionEnd = typeof input.selectionEnd === 'number' ? input.selectionEnd : input.value.length;

    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      if (typeof input.setSelectionRange === 'function') {
        try {
          input.setSelectionRange(selectionStart, selectionEnd);
        } catch (error) {
          this.log('Selection restore skipped', error);
        }
      }
    });
  }

  applyAndroidFixes() {
    const container = document.getElementById('inputContainer');
    if (container) {
      container.addEventListener('click', (e) => {
        const input = document.getElementById('messageInput');
        if (input && e.target !== input && !e.target.closest('button')) {
          setTimeout(() => input.focus({ preventScroll: true }), 10);
        }
      });
    }
  }

  applyIOSFixes() {
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) e.preventDefault();
    }, { passive: false });

    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
      messageInput.addEventListener('touchmove', (e) => {
        e.stopPropagation();
      }, { passive: false });
    }

    if (this.inputContainer) {
      this.inputContainer.addEventListener('touchmove', (e) => {
        e.stopPropagation();
      }, { passive: false });
    }
  }

  isInputElement(element) {
    return element.tagName === 'TEXTAREA'
      || (element.tagName === 'INPUT' && ['text', 'email', 'password'].includes(element.type));
  }
}

// ==================== 文件上传处理 (多模态支持) ====================
let currentAttachment = null;
const MAX_INPUT_CHARS = 100000; // 约等于 25000 tokens，用于自动转换

let appVersionMonitorTimer = null;
let appUpdatePromptVisible = false;

function compareVersionStrings(current, latest) {
  const currentParts = String(current || '').split('.').map((part) => parseInt(part, 10) || 0);
  const latestParts = String(latest || '').split('.').map((part) => parseInt(part, 10) || 0);
  const length = Math.max(currentParts.length, latestParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = currentParts[index] || 0;
    const right = latestParts[index] || 0;
    if (right > left) return 1;
    if (right < left) return -1;
  }

  return 0;
}

function showAppUpdatePrompt(latestVersion) {
  if (appUpdatePromptVisible) return;
  appUpdatePromptVisible = true;

  let prompt = document.getElementById('appUpdatePrompt');
  if (!prompt) {
    prompt = document.createElement('div');
    prompt.id = 'appUpdatePrompt';
    prompt.className = 'app-update-prompt';
    document.body.appendChild(prompt);
  }

  prompt.innerHTML = '';

  const text = document.createElement('div');
  text.className = 'app-update-text';

  const title = document.createElement('div');
  title.className = 'app-update-title';
  title.textContent = i18nText('app-update-title', isChineseLanguage(appState.language) ? 'RAI 已更新' : 'RAI has been updated');

  const desc = document.createElement('div');
  desc.className = 'app-update-desc';
  desc.textContent = i18nText('app-update-desc', isChineseLanguage(appState.language) ? '当前网页仍是旧版本，刷新后即可使用最新版。' : 'This page is still running an older version. Refresh to use the latest release.');

  text.append(title, desc);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'app-update-btn';
  button.textContent = i18nText('app-update-button', isChineseLanguage(appState.language) ? '刷新更新' : 'Refresh');
  button.addEventListener('click', () => refreshToLatestAppVersion(latestVersion));

  prompt.append(text, button);
  requestAnimationFrame(() => prompt.classList.add('show'));
}

async function refreshToLatestAppVersion(latestVersion) {
  try {
    if (window.caches?.keys) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((key) => window.caches.delete(key)));
    }
  } catch (error) {
    console.warn('清理缓存失败，将继续刷新:', error);
  }

  const url = new URL(window.location.href);
  url.searchParams.set('rai_refresh', String(Date.now()));
  if (latestVersion) {
    url.searchParams.set('rai_version', String(latestVersion));
  }
  window.location.replace(url.toString());
}

async function checkForAppUpdate() {
  try {
    const response = await fetch(`${API_BASE}/version?current=${encodeURIComponent(RAI_APP_VERSION)}&build=${encodeURIComponent(RAI_BUILD_ID)}&t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!response.ok) return;

    const data = await response.json();
    const latestVersion = String(data?.version || '').trim();
    if (latestVersion && compareVersionStrings(RAI_APP_VERSION, latestVersion) > 0) {
      showAppUpdatePrompt(latestVersion);
    }
  } catch (error) {
    console.warn('检查 RAI 版本失败:', error.message);
  }
}

function startAppVersionMonitor() {
  if (appVersionMonitorTimer) return;

  window.setTimeout(checkForAppUpdate, 8000);
  appVersionMonitorTimer = window.setInterval(checkForAppUpdate, 3 * 60 * 1000);
  window.addEventListener('focus', checkForAppUpdate);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkForAppUpdate();
    }
  });
}

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
      input.value = isChineseLanguage(appState.language)
        ? '请分析这个文档'
        : 'Please analyze this document';
      autoResizeInput();

      // 显示提示
      showToast(isChineseLanguage(appState.language)
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
    alert(isChineseLanguage(appState.language) ? '文件大小不能超过50MB' : 'File size cannot exceed 50MB');
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
      console.log(` ${attachmentType}文件已选择: ${file.name}`);
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
      console.log(' 文档上传成功');
      updateAttachmentUI();
    } catch (error) {
      console.error(' 文档上传失败:', error);
      alert(isChineseLanguage(appState.language) ? '文档上传失败' : 'Document upload failed');
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
      typeLabel = isChineseLanguage(appState.language) ? '图片' : 'Image';
      break;
    case 'audio':
      iconSvg = getSvgIcon('headphones', 'attachment-icon', 20);
      typeLabel = isChineseLanguage(appState.language) ? '音频' : 'Audio';
      break;
    case 'video':
      iconSvg = getSvgIcon('video_camera_front', 'attachment-icon', 20);
      typeLabel = isChineseLanguage(appState.language) ? '视频' : 'Video';
      break;
    case 'text':
      iconSvg = getSvgIcon('article', 'attachment-icon', 20);
      typeLabel = isChineseLanguage(appState.language) ? '文本' : 'Text';
      break;
    case 'code':
      iconSvg = getSvgIcon('code', 'attachment-icon', 20);
      typeLabel = isChineseLanguage(appState.language) ? '代码' : 'Code';
      break;
    default:
      iconSvg = getSvgIcon('description', 'attachment-icon', 20);
      typeLabel = isChineseLanguage(appState.language) ? '文档' : 'Document';
  }

  attachmentPreview.innerHTML = `
        <div class="attachment-info">
          ${iconSvg}
          <span class="attachment-type">${typeLabel}</span>
          <span class="attachment-name">${currentAttachment.fileName}</span>
        </div>
        <button class="attachment-remove" onclick="removeAttachment()" title="${isChineseLanguage(appState.language) ? '移除' : 'Remove'}">
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
            <span>${isChineseLanguage(appState.language) ? '释放以上传文件' : 'Drop to upload file'}</span>
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
      console.log(' 拖拽上传文件:', files[0].name);
    }
  });

  console.log(' 拖拽上传功能已初始化');
}

// ==================== 对话索引导航器 ====================

// 获取所有消息（包括用户和AI）
function getChatScrollElement() {
  const messagesList = document.getElementById('messagesList');
  if (messagesList && messagesList.style.display !== 'none') {
    return messagesList;
  }

  return document.getElementById('chatContainer');
}

function isPrimaryChatScrollTarget(target) {
  return Boolean(
    target &&
    target instanceof Element &&
    (target.id === 'messagesList' || target.id === 'chatContainer')
  );
}

function getChatViewportAnchorOffset(scrollElement = getChatScrollElement()) {
  if (!scrollElement) return 120;

  return Math.min(
    Math.max(scrollElement.clientHeight * 0.36, 120),
    Math.max(scrollElement.clientHeight - 120, 120)
  );
}

function getDisplayedChatIndex() {
  const timeline = document.getElementById('chatIndexTimeline');
  const activeLine = timeline?.querySelector('.chat-index-line.active');
  const activeIndex = activeLine ? parseInt(activeLine.dataset.index, 10) : NaN;

  if (!Number.isNaN(activeIndex)) {
    return activeIndex;
  }

  if (Number.isInteger(chatIndexLastActiveIndex) && chatIndexLastActiveIndex >= 0) {
    return chatIndexLastActiveIndex;
  }

  return getCurrentChatIndex();
}

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
      const label = isChineseLanguage(appState.language) ? 'RAI回复：' : 'RAI Response:';
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
      setActiveIndexLine(idx, { timelineBehavior: 'smooth' });
      // 滚动到消息
      scrollToMessage(item.messageIndex);
    });

    timeline.appendChild(line);
  });

  // 更新当前高亮
  updateChatIndexHighlight({ forceTimelineSync: true });
}

// 立即设置指定索引为active
let chatIndexLastActiveIndex = -1;
let chatIndexHighlightRafId = null;
let chatIndexListenerInitialized = false;

function syncChatIndexTimelineToActive(activeIdx, behavior = 'auto') {
  const timeline = document.getElementById('chatIndexTimeline');
  if (!timeline) return;

  const activeLine = timeline.querySelector(`.chat-index-line[data-index="${activeIdx}"]`);
  if (!activeLine) return;

  const lineCenter = activeLine.offsetTop + (activeLine.offsetHeight / 2);
  const targetScrollTop = Math.max(0, lineCenter - (timeline.clientHeight / 2));
  const distance = Math.abs(timeline.scrollTop - targetScrollTop);

  if (distance < 2) return;

  if (typeof timeline.scrollTo === 'function') {
    timeline.scrollTo({
      top: targetScrollTop,
      behavior
    });
  } else {
    timeline.scrollTop = targetScrollTop;
  }
}

function setActiveIndexLine(activeIdx, { timelineBehavior = 'auto', forceTimelineSync = false } = {}) {
  const timeline = document.getElementById('chatIndexTimeline');
  if (!timeline) return;

  const lines = timeline.querySelectorAll('.chat-index-line');
  let hasActiveLine = false;

  lines.forEach((line, idx) => {
    if (idx === activeIdx) {
      line.classList.add('active');
      hasActiveLine = true;
    } else {
      line.classList.remove('active');
    }
  });

  if (!hasActiveLine) {
    chatIndexLastActiveIndex = -1;
    return;
  }

  if (forceTimelineSync || chatIndexLastActiveIndex !== activeIdx) {
    syncChatIndexTimelineToActive(activeIdx, timelineBehavior);
  }

  chatIndexLastActiveIndex = activeIdx;
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
    ? (isChineseLanguage(appState.language) ? '上一个响应' : 'Previous response')
    : (isChineseLanguage(appState.language) ? '下一个响应' : 'Next response');

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

  const currentIndex = getDisplayedChatIndex();
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
    setActiveIndexLine(targetIndex, { timelineBehavior: 'smooth' });
    scrollToMessage(items[targetIndex].messageIndex);
  }
}

// 显示已到顶/底提示
window.showNavTooltip = showNavTooltip;
window.hideNavTooltip = hideNavTooltip;
window.navigateToResponse = navigateToResponse;

function showBoundaryTooltip(position) {
  const tooltip = document.getElementById('chatIndexNavTooltip');
  if (!tooltip) return;

  const text = position === 'top'
    ? (isChineseLanguage(appState.language) ? '已经到顶了' : 'Already at top')
    : (isChineseLanguage(appState.language) ? '已经到底了' : 'Already at bottom');

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
  const scrollElement = getChatScrollElement();
  if (!container || !scrollElement) return;

  const messages = container.querySelectorAll('.message');
  const targetMessage = messages[messageIndex];

  if (targetMessage) {
    appState.isProgrammaticScroll = true;
    const scrollRect = scrollElement.getBoundingClientRect();
    const messageRect = targetMessage.getBoundingClientRect();
    const anchorOffset = getChatViewportAnchorOffset(scrollElement);
    const targetScrollTop = scrollElement.scrollTop + (messageRect.top - scrollRect.top) - anchorOffset;
    const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, Math.round(targetScrollTop)));

    if (typeof scrollElement.scrollTo === 'function') {
      scrollElement.scrollTo({
        top: clampedScrollTop,
        behavior: 'smooth'
      });
    } else {
      scrollElement.scrollTop = clampedScrollTop;
    }

    appState.lastScrollTop = clampedScrollTop;
    window.setTimeout(() => {
      appState.isProgrammaticScroll = false;
      updateChatIndexHighlight({ forceTimelineSync: true });
    }, 240);

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
  const scrollElement = getChatScrollElement();
  if (!container || !scrollElement) return 0;

  const messages = container.querySelectorAll('.message');
  const containerRect = scrollElement.getBoundingClientRect();
  const viewportTop = containerRect.top;
  const viewportBottom = containerRect.bottom;
  const anchorY = viewportTop + getChatViewportAnchorOffset(scrollElement);

  let closestIndex = 0;
  let bestScore = -Infinity;

  items.forEach((item, idx) => {
    const message = messages[item.messageIndex];
    if (message) {
      const messageRect = message.getBoundingClientRect();
      const visibleTop = Math.max(messageRect.top, viewportTop);
      const visibleBottom = Math.min(messageRect.bottom, viewportBottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const containsAnchor = messageRect.top <= anchorY && messageRect.bottom >= anchorY;
      const distanceToAnchor = containsAnchor
        ? 0
        : Math.min(Math.abs(messageRect.top - anchorY), Math.abs(messageRect.bottom - anchorY));

      // 优先当前可视焦点线命中的消息，其次选择可见面积更大的消息。
      const score = (containsAnchor ? 100000 : 0) + (visibleHeight * 10) - distanceToAnchor;

      const candidateScore = (containsAnchor ? 100000 : 0) + (visibleHeight * 10) - distanceToAnchor;

      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        closestIndex = idx;
      }
    }
  });

  return closestIndex;
}

// 更新当前高亮
function updateChatIndexHighlight({ forceTimelineSync = false, timelineBehavior = 'auto' } = {}) {
  const timeline = document.getElementById('chatIndexTimeline');
  if (!timeline) return;

  const currentIndex = getCurrentChatIndex();
  setActiveIndexLine(currentIndex, { timelineBehavior, forceTimelineSync });

  // 更新按钮状态
  updateChatIndexNavButtons(currentIndex);
}

// 更新导航按钮状态
function updateChatIndexNavButtons(currentIndex = getCurrentChatIndex()) {
  const items = getChatIndexItems();

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
  if (chatIndexListenerInitialized) return;

  const chatContainer = document.getElementById('chatContainer');
  const messagesList = document.getElementById('messagesList');
  if (!chatContainer && !messagesList) return;

  chatIndexListenerInitialized = true;
  const handleIndexScroll = (event) => {
    if (event && !isPrimaryChatScrollTarget(event.target)) return;
    // 节流处理
    if (chatIndexHighlightRafId) return;
    chatIndexHighlightRafId = requestAnimationFrame(() => {
      chatIndexHighlightRafId = null;
      updateChatIndexHighlight();
    });
  };

  // 初始化移动端滑动操作
  document.addEventListener('scroll', handleIndexScroll, { passive: true, capture: true });

  initMobileTouchNavigation();
  updateChatIndexHighlight({ forceTimelineSync: true });

  console.log(' 对话索引导航器滚动监听器已初始化');
}

window.addEventListener('resize', repositionComposerMenus);
window.addEventListener('orientationchange', repositionComposerMenus);
window.visualViewport?.addEventListener('resize', repositionComposerMenus);
window.addEventListener('resize', syncSettingsResponsiveLayout);
window.addEventListener('orientationchange', syncSettingsResponsiveLayout);

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
      const label = isChineseLanguage(appState.language) ? 'RAI回复：' : 'RAI Response:';
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
        setActiveIndexLine(idx, { timelineBehavior: 'smooth' });
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
  membershipEnd: null,
  points: 0,
  purchasedPoints: 0,
  totalPoints: 0,
  canCheckin: true,
  createdAt: null,
  poeDailyLimit: 3,
  poeUsedToday: 0,
  poeRemaining: 3,
  poeResetAt: null,
  gpt55DailyLimit: 10,
  gpt55UsedToday: 0,
  gpt55Remaining: 10,
  gpt55ResetAt: null,
  tasks: {
    pwaInstall: { completed: false, rewardPoints: PWA_INSTALL_REWARD_POINTS },
    inviteUser: { completed: false, rewardPoints: INVITE_REWARD_POINTS, completedCount: 0, totalRewardPoints: 0 }
  }
};

const MEMBERSHIP_DAILY_CHECKIN_POINTS = 20;
const MEMBERSHIP_MONTH_CHECKIN_DAYS = 28;

const MEMBERSHIP_REDEEM_OPTIONS = {
  Pro: { pointsCost: MEMBERSHIP_DAILY_CHECKIN_POINTS * MEMBERSHIP_MONTH_CHECKIN_DAYS, durationDays: 30, earnDays: MEMBERSHIP_MONTH_CHECKIN_DAYS },
  MAX: { pointsCost: 6000, durationDays: 30 }
};

let membershipRedeemPendingTier = null;

let membershipModelPolicyInitialized = false;

function normalizeMembershipTasks(tasks = {}) {
  return {
    pwaInstall: {
      completed: Boolean(tasks?.pwaInstall?.completed),
      rewardPoints: Number(tasks?.pwaInstall?.rewardPoints || PWA_INSTALL_REWARD_POINTS),
      completedAt: tasks?.pwaInstall?.completedAt || null
    },
    inviteUser: {
      completed: Boolean(tasks?.inviteUser?.completed),
      rewardPoints: Number(tasks?.inviteUser?.rewardPoints || INVITE_REWARD_POINTS),
      completedAt: tasks?.inviteUser?.completedAt || null,
      completedCount: Number(tasks?.inviteUser?.completedCount || 0),
      totalRewardPoints: Number(tasks?.inviteUser?.totalRewardPoints || 0)
    }
  };
}

function applyUserMembershipData(data = {}) {
  userMembershipState = {
    membership: data.membership || 'free',
    membershipEnd: data.membershipEnd,
    points: data.points || 0,
    purchasedPoints: data.purchasedPoints || 0,
    totalPoints: data.totalPoints || 0,
    canCheckin: data.canCheckin,
    createdAt: data.createdAt,
    poeDailyLimit: Number(data.poeDailyLimit || 3),
    poeUsedToday: Number(data.poeUsedToday || 0),
    poeRemaining: Number(data.poeRemaining || 0),
    poeResetAt: data.poeResetAt || null,
    gpt55DailyLimit: Number(data.gpt55DailyLimit || 10),
    gpt55UsedToday: Number(data.gpt55UsedToday || 0),
    gpt55Remaining: Number(data.gpt55Remaining || 0),
    gpt55ResetAt: data.gpt55ResetAt || null,
    tasks: normalizeMembershipTasks(data.tasks)
  };
  return userMembershipState;
}

function applyMembershipModelPolicy({ initial = false, previousMembership = null } = {}) {
  const currentMembership = String(userMembershipState?.membership || 'free');
  const prev = previousMembership ? String(previousMembership) : null;

  // free 用户：默认智能模型（仅首次或从非 free 降级时强制）
  if (currentMembership === 'free') {
    if (initial || (prev && prev !== 'free') || !membershipModelPolicyInitialized) {
      appState.selectedModel = 'auto';
      updateSelectedModelText('auto');
      updateModelControls();
      updateMenuSelection();
    }
    membershipModelPolicyInitialized = true;
    return;
  }

  // Pro/MAX：记住上次模型（首次加载或刚从free升级时应用）
  if (initial || prev === 'free' || !membershipModelPolicyInitialized) {
    const remembered = normalizeSelectedModelId(appState.profileDefaultModel || appState.selectedModel || 'kimi-k2.5');
    const targetModel = MODELS[remembered] && !isModelDisabledByAdmin(remembered) ? remembered : 'auto';
    appState.selectedModel = targetModel;
    updateSelectedModelText(targetModel);
    updateModelControls();
    updateMenuSelection();
  }
  membershipModelPolicyInitialized = true;
}

// 获取用户会员状态
async function fetchUserMembership({ applyPolicy = false, initial = false } = {}) {
  try {
    const token = appState.token;
    if (!token) return;

    const previousMembership = userMembershipState?.membership || 'free';

    const res = await fetch('/api/user/membership', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      applyUserMembershipData(data);
      console.log(' 会员状态更新:', userMembershipState);
      if (isMembershipLockedModel(appState.selectedModel) || isModelDisabledByAdmin(appState.selectedModel)) {
        appState.selectedModel = 'auto';
        updateSelectedModelText('auto');
        updateModelControls();
      }
      if (isMembershipLockedModel(chatFlowState?.selectedModel) || isModelDisabledByAdmin(chatFlowState?.selectedModel)) {
        chatFlowState.selectedModel = 'auto';
        updateChatFlowControlStates();
      }
      if (applyPolicy) {
        applyMembershipModelPolicy({ initial, previousMembership });
      }
      updatePoeQuotaHint();
      updateMenuSelection();
      updateToolbarUI();
      updateUserAreaWithMembership();
      updateSettingsMembership();
      maybeShowPwaRewardPrompt();
    }
  } catch (e) {
    console.log('获取会员状态失败');
  }
}

// 用户签到 (设置面板用)
async function userCheckin() {
  console.log(' userCheckin() 被调用');
  try {
    const token = appState.token;
    console.log(' Token:', token ? '存在' : '不存在');
    if (!token) {
      console.error(' 无token，取消签到');
      return;
    }

    console.log(' 发送签到请求...');
    const res = await fetch('/api/user/checkin', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log(' 响应状态:', res.status);
    const data = await res.json();
    console.log(' 响应数据:', data);

    if (res.ok) {
      const successTpl = i18nText('checkin-success', '签到成功！获得 {points} 点数 ');
      alert(successTpl.replace('{points}', data.pointsGained));
      await fetchUserMembership();
      updateSettingsMembership();
      updateUserAreaWithMembership();
      refreshMembershipPlansModal();
    } else {
      alert(data.error || '签到失败');
    }
  } catch (e) {
    console.error(' 签到错误:', e);
    alert(`${i18nText('network-error', '网络错误')}: ${e.message}`);
  }
}

function formatMembershipPoints(points) {
  return Number(points || 0).toLocaleString(getCurrentLocale());
}

function isMembershipTierActive(tier) {
  const currentTier = String(userMembershipState.membership || 'free');
  if (currentTier !== tier) return false;

  if (!userMembershipState.membershipEnd) {
    return currentTier !== 'free';
  }

  const endDate = new Date(userMembershipState.membershipEnd);
  return !Number.isNaN(endDate.getTime()) && endDate > new Date();
}

function getMembershipExpiryText() {
  if (!userMembershipState.membershipEnd) return '';

  const endDate = new Date(userMembershipState.membershipEnd);
  if (Number.isNaN(endDate.getTime())) return '';

  const locale = getCurrentLocale();
  const prefix = isChineseLanguage(appState.language) ? '当前到期' : 'Current expiry';
  return `${prefix}: ${endDate.toLocaleDateString(locale)}`;
}

function getMembershipPlanFeatures(tier) {
  const isZh = isChineseLanguage(appState.language);
  if (tier === 'Pro') {
    return isZh
      ? ['更高的模型使用额度', '支持续期或升级 MAX', '适合日常高频使用']
      : ['Higher model usage quota', 'Can renew or upgrade to MAX', 'For frequent everyday use'];
  }

  return isZh
    ? ['更高档位会员权益', '适合重度使用场景', '支持直接续期']
    : ['Higher-tier membership access', 'For heavy usage scenarios', 'Supports direct renewal'];
}

function getMembershipActionState(tier) {
  const isZh = isChineseLanguage(appState.language);
  const option = MEMBERSHIP_REDEEM_OPTIONS[tier];
  const currentTier = String(userMembershipState.membership || 'free');
  const activeCurrentTier = currentTier !== 'free' && isMembershipTierActive(currentTier);
  const hasEnoughPoints = Number(userMembershipState.totalPoints || 0) >= option.pointsCost;
  const insufficientLabel = isZh ? '点数不足' : 'Not enough points';

  if (currentTier === 'MAX' && tier === 'Pro' && activeCurrentTier) {
    return {
      disabled: true,
      label: isZh ? '当前为更高档位' : 'Higher tier active'
    };
  }

  if (currentTier === tier && activeCurrentTier) {
    return {
      disabled: !hasEnoughPoints,
      label: hasEnoughPoints
        ? (isZh ? `续期 ${option.durationDays} 天` : `Renew ${option.durationDays} days`)
        : insufficientLabel
    };
  }

  if (currentTier === 'Pro' && tier === 'MAX' && activeCurrentTier) {
    return {
      disabled: !hasEnoughPoints,
      label: hasEnoughPoints
        ? (isZh ? `升级并延长 ${option.durationDays} 天` : `Upgrade + ${option.durationDays} days`)
        : insufficientLabel
    };
  }

  return {
    disabled: !hasEnoughPoints,
    label: hasEnoughPoints
      ? (isZh ? `${formatMembershipPoints(option.pointsCost)} 点兑换` : `Redeem for ${formatMembershipPoints(option.pointsCost)} points`)
      : insufficientLabel
  };
}

function renderMembershipPlanCard(tier) {
  const option = MEMBERSHIP_REDEEM_OPTIONS[tier];
  const action = getMembershipActionState(tier);
  const features = getMembershipPlanFeatures(tier);
  const isCurrent = isMembershipTierActive(tier);
  const isPending = membershipRedeemPendingTier === tier;
  const isZh = isChineseLanguage(appState.language);
  const subline = option.earnDays
    ? (isZh
      ? `${formatMembershipPoints(option.pointsCost)} 点 / ${option.durationDays} 天，约 ${option.earnDays} 天签到可兑换`
      : `${formatMembershipPoints(option.pointsCost)} points / ${option.durationDays} days, about ${option.earnDays} check-ins`)
    : (isZh
      ? `${formatMembershipPoints(option.pointsCost)} 点 / ${option.durationDays} 天`
      : `${formatMembershipPoints(option.pointsCost)} points / ${option.durationDays} days`);

  return `
    <div class="membership-plan-card ${tier.toLowerCase()} ${isCurrent ? 'current' : ''}">
      <div class="membership-plan-topline">
        <div class="membership-plan-name">${tier}</div>
        ${isCurrent ? `<span class="membership-current-pill">${isZh ? '当前套餐' : 'Current'}</span>` : ''}
      </div>
      <div class="membership-plan-price membership-plan-price-points">
        <span>${formatMembershipPoints(option.pointsCost)}</span>
        <small>${isZh ? '点数' : 'points'}</small>
      </div>
      <div class="membership-plan-points">${subline}</div>
      <button
        class="membership-plan-action"
        onclick="redeemMembership('${tier}')"
        ${action.disabled || isPending ? 'disabled' : ''}
      >
        ${isPending
          ? (isZh ? '处理中...' : 'Processing...')
          : action.label}
      </button>
      <div class="membership-plan-features">
        ${features.map((feature) => `
          <div class="membership-plan-feature">
            <span class="membership-feature-icon" aria-hidden="true">+</span>
            <span>${feature}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function startPwaInstallTask() {
  pwaRewardPromptDismissedThisSession = false;
  handlePwaRewardInstallAction();
}

function claimPwaInstallTask() {
  pwaRewardPromptDismissedThisSession = false;
  claimAlreadyInstalledPwaReward();
}

async function copyInviteLink() {
  const link = getInviteLink();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link);
    } else {
      const input = document.createElement('input');
      input.value = link;
      input.setAttribute('readonly', 'readonly');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    showToast(isChineseLanguage(appState.language) ? '邀请链接已复制' : 'Invite link copied');
  } catch (error) {
    window.prompt(isChineseLanguage(appState.language) ? '复制邀请链接' : 'Copy invite link', link);
  }
}

function renderMembershipTasksSection({ compact = false } = {}) {
  const isZh = isChineseLanguage(appState.language);
  const tasks = normalizeMembershipTasks(userMembershipState.tasks);
  const inviteCount = Number(tasks.inviteUser.completedCount || 0);
  const taskClass = compact ? 'settings-task-section' : 'membership-task-section';
  const pwaDone = Boolean(tasks.pwaInstall.completed);
  const inviteDone = inviteCount > 0;
  const inviteLink = getInviteLink();

  return `
    <div class="${taskClass}">
      <div class="membership-task-heading">
        <h3>${isZh ? '任务' : 'Tasks'}</h3>
        <span>${isZh ? '完成任务增加积分' : 'Earn points by completing tasks'}</span>
      </div>
      <div class="membership-task-list">
        <div class="membership-task-item ${pwaDone ? 'completed' : ''}">
          <div class="membership-task-main">
            <strong>${isZh ? '把 RAI 放到桌面' : 'Add RAI to desktop'}</strong>
            <span>${isZh ? `积分 +${tasks.pwaInstall.rewardPoints}` : `+${tasks.pwaInstall.rewardPoints} points`}</span>
          </div>
          <div class="membership-task-actions">
            <button type="button" class="membership-task-action" onclick="startPwaInstallTask()" ${pwaDone ? 'disabled' : ''}>
              ${pwaDone ? (isZh ? '已完成' : 'Done') : (isZh ? '去添加' : 'Add')}
            </button>
            ${pwaDone ? '' : `<button type="button" class="membership-task-action secondary" onclick="claimPwaInstallTask()">${isZh ? '已添加，领取' : 'Already added'}</button>`}
          </div>
        </div>
        <div class="membership-task-item ${inviteDone ? 'completed' : ''}">
          <div class="membership-task-main">
            <strong>${isZh ? '邀请一位用户' : 'Invite one user'}</strong>
            <span>${isZh ? `积分 +${tasks.inviteUser.rewardPoints}${inviteCount ? ` · 已邀请 ${inviteCount} 位` : ''}` : `+${tasks.inviteUser.rewardPoints} points${inviteCount ? ` · ${inviteCount} invited` : ''}`}</span>
            <small>${escapeHtml(inviteLink)}</small>
          </div>
          <div class="membership-task-actions">
            <button type="button" class="membership-task-action" onclick="copyInviteLink()">
              ${isZh ? '复制链接' : 'Copy link'}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderMembershipPlansModalContent() {
  const isZh = isChineseLanguage(appState.language);
  const currentPointsLabel = isZh ? '当前点数' : 'Current points';
  const currentTierLabel = isZh ? '当前会员' : 'Current tier';
  const expiryText = getMembershipExpiryText();

  return `
    <div class="membership-plans-box">
      <div class="membership-plans-header">
        <h2>${isZh ? '点数兑换会员' : 'Redeem Membership with Points'}</h2>
        <button class="admin-close-btn" onclick="closeMembershipPlans()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="membership-plans-content">
        <div class="membership-plans-summary">
          <div>
            <span>${currentPointsLabel}</span>
            <strong>${formatMembershipPoints(userMembershipState.totalPoints)}</strong>
          </div>
          <div>
            <span>${currentTierLabel}</span>
            <strong>${String(userMembershipState.membership || 'free')}</strong>
          </div>
          ${expiryText ? `<p>${expiryText}</p>` : ''}
        </div>
        <div class="membership-plans-grid">
          <div class="membership-plan-card free ${String(userMembershipState.membership || 'free') === 'free' ? 'current' : ''}">
            <div class="membership-plan-topline">
              <div class="membership-plan-name">free</div>
              ${String(userMembershipState.membership || 'free') === 'free' ? `<span class="membership-current-pill">${isZh ? '当前套餐' : 'Current'}</span>` : ''}
            </div>
            <div class="membership-plan-price">${isZh ? '每日签到' : 'Daily check-in'}</div>
            <div class="membership-plan-points">${isZh ? `每日签到 +${MEMBERSHIP_DAILY_CHECKIN_POINTS} 点数` : `Daily check-in +${MEMBERSHIP_DAILY_CHECKIN_POINTS} points`}</div>
            <button class="membership-plan-action" disabled>${isZh ? '基础套餐' : 'Base plan'}</button>
            <div class="membership-plan-features">
              ${isZh
                ? '<div class="membership-plan-feature"><span class="membership-feature-icon">+</span><span>点数长期累积</span></div><div class="membership-plan-feature"><span class="membership-feature-icon">+</span><span>可兑换 Pro 或 MAX</span></div>'
                : '<div class="membership-plan-feature"><span class="membership-feature-icon">+</span><span>Points accumulate over time</span></div><div class="membership-plan-feature"><span class="membership-feature-icon">+</span><span>Can redeem Pro or MAX</span></div>'}
            </div>
          </div>
          ${renderMembershipPlanCard('Pro')}
          ${renderMembershipPlanCard('MAX')}
        </div>

        ${renderMembershipTasksSection()}

        <div class="membership-contact">
          <p>${isZh ? '点数 / 会员问题联系邮箱：' : 'For points / membership help:'} <a href="mailto:rick080402+raisupport@gmail.com">rick080402+raisupport@gmail.com</a></p>
          <p class="membership-status-note">${isZh ? '如遇点数、签到或会员状态问题，可通过邮箱联系。' : 'If you run into points, check-in, or membership issues, contact us by email.'}</p>
        </div>
      </div>
    </div>
  `;
}

function refreshMembershipPlansModal() {
  const modal = document.getElementById('membershipPlansModal');
  if (!modal) return;
  modal.innerHTML = renderMembershipPlansModalContent();
}

async function redeemMembership(tier) {
  if (membershipRedeemPendingTier) return;

  const token = appState.token;
  if (!token) {
    showToast(isChineseLanguage(appState.language) ? '请先登录' : 'Please log in first');
    return;
  }

  const option = MEMBERSHIP_REDEEM_OPTIONS[tier];
  if (!option) return;

  const wasActiveTier = isMembershipTierActive(tier);
  membershipRedeemPendingTier = tier;
  refreshMembershipPlansModal();

  try {
    const res = await fetch('/api/user/membership/redeem', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ tier })
    });

    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || (isChineseLanguage(appState.language) ? '兑换失败' : 'Redeem failed'));
      return;
    }

    await fetchUserMembership({ applyPolicy: true });
    updateUserAreaWithMembership();
    updateSettingsMembership();
    refreshMembershipPlansModal();

    const successMessage = wasActiveTier
      ? (isChineseLanguage(appState.language)
        ? `已续期 ${tier} ${option.durationDays} 天`
        : `${tier} renewed for ${option.durationDays} days`)
      : (isChineseLanguage(appState.language)
        ? `兑换成功，已开通 ${tier}`
        : `${tier} activated successfully`);
    showToast(successMessage);
  } catch (error) {
    showToast(isChineseLanguage(appState.language) ? '网络错误' : 'Network error');
  } finally {
    membershipRedeemPendingTier = null;
    refreshMembershipPlansModal();
  }
}

// 打开会员计划弹窗
function openMembershipPlans() {
  createMembershipPlansModal();
  refreshMembershipPlansModal();
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
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeMembershipPlans();
  });

  refreshMembershipPlansModal();
}

// 更新侧边栏用户区域 - 简化版，只显示签到按钮
function updateUserAreaWithMembership() {
  const checkinContainer = document.getElementById('sidebarCheckinContainer');
  if (!checkinContainer) return;

  const m = userMembershipState;

  // 任何用户只要当天还没签到，都显示签到按钮
  if (m.canCheckin) {
    checkinContainer.style.display = 'block';
    checkinContainer.innerHTML = `
          <button type="button" class="sidebar-checkin-btn" onclick="sidebarCheckin()">
            ${i18nText('checkin-bonus', '签到 +20 ')}
          </button>
        `;
  } else {
    // 隐藏签到容器（当天已签到）
    checkinContainer.style.display = 'none';
    checkinContainer.innerHTML = '';
  }
}

// 侧边栏签到函数 - 签到成功后隐藏按钮
async function sidebarCheckin() {
  console.log(' sidebarCheckin() 被调用');
  try {
    const token = appState.token;
    console.log(' Token:', token ? '存在' : '不存在');
    if (!token) {
      console.error(' 无token，取消签到');
      return;
    }

    console.log(' 发送签到请求...');
    const res = await fetch('/api/user/checkin', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    console.log(' 响应状态:', res.status);
    const data = await res.json();
    console.log(' 响应数据:', data);

    if (res.ok) {
      await fetchUserMembership();
      updateUserAreaWithMembership();
      updateSettingsMembership();
      refreshMembershipPlansModal();

      // 显示成功提示
      const successTpl = i18nText('checkin-success', '签到成功！获得 {points} 点数 ');
      showToast(successTpl.replace('{points}', data.pointsGained));
    } else {
      showToast(data.error || '签到失败', 'error');
    }
  } catch (e) {
    showToast(i18nText('network-error', '网络错误'), 'error');
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
    if (!m.canCheckin) {
      checkinBtn.style.display = 'inline-block';
      checkinBtn.disabled = true;
      checkinBtn.textContent = i18nText('checkin-done', '今日已签到 ✓');
    } else {
      checkinBtn.disabled = false;
      checkinBtn.style.display = 'inline-block';
      checkinBtn.textContent = i18nText('checkin-bonus', '签到 +20 ');
    }
  }

  // 更新创建时间
	  const created = document.getElementById('settingsCreatedAt');
	  if (created && m.createdAt) {
	    const date = new Date(m.createdAt);
	    const locale = getCurrentLocale();
	    created.textContent = `${i18nText('created-at-prefix', '创建于')}: ${date.toLocaleDateString(locale)}`;
	  }

	  const taskSection = document.getElementById('settingsTaskSection');
	  if (taskSection) {
	    taskSection.innerHTML = renderMembershipTasksSection({ compact: true });
	  }

	  // 升级/续期入口始终可见，方便续期和升级
  const upgradeLink = document.querySelector('#settingsMembershipSection .settings-upgrade-link');
  if (upgradeLink) {
    upgradeLink.style.display = 'inline';
  }

  refreshMembershipPlansModal();
}

// 每60秒刷新一次会员状态
setInterval(() => {
  const token = localStorage.getItem(RAI_TOKEN_KEY);
  if (token) {
    fetchUserMembership({ applyPolicy: true }).then(() => {
      updateUserAreaWithMembership();
      updateSettingsMembership();
    });
  }
}, 60000);

setInterval(() => {
  fetchModelAvailability();
}, 60000);

// 页面加载后获取会员状态
setTimeout(() => {
  fetchUserMembership({ applyPolicy: true }).then(() => {
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
            <button class="admin-tab" data-tab="feedback" onclick="switchAdminTab('feedback')">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 8h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2c0-1.1-.9-2-2-2zM1 9h4v12H1z"/></svg>
              <span>用户反馈</span>
            </button>
            <button class="admin-tab" data-tab="models" onclick="switchAdminTab('models')">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 2 7l10 5 10-5-10-5Zm0 7.8L6.47 7 12 4.2 17.53 7 12 9.8ZM4 10.27l8 4 8-4V13l-8 4-8-4v-2.73Zm0 5 8 4 8-4V18l-8 4-8-4v-2.73Z"/></svg>
              <span>模型开关</span>
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

            <div id="adminFeedbackTab" class="admin-tab-content">
              <div class="admin-search-bar admin-feedback-filters">
                <select id="adminFeedbackRating" onchange="loadAdminFeedback()">
                  <option value="">全部反馈</option>
                  <option value="up">点赞</option>
                  <option value="down">倒赞</option>
                </select>
                <input type="text" id="adminFeedbackSearch" placeholder="搜索反馈/回复/用户..." onkeyup="if(event.key==='Enter')loadAdminFeedback()">
                <button onclick="loadAdminFeedback()">搜索</button>
              </div>
              <div id="adminFeedbackTable" class="admin-table-container"></div>
            </div>

            <div id="adminModelsTab" class="admin-tab-content">
              <div id="adminModelsPanel" class="admin-table-container"></div>
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
  else if (tab === 'feedback') loadAdminFeedback();
  else if (tab === 'models') loadAdminModels();
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
            <span class="admin-model-name">${escapeHtml(model.model || '未知')}</span>
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
            <span class="admin-top-user-name">${escapeHtml(user.username || user.email || 'User ' + user.id)}</span>
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
              <td>${escapeHtml(user.email || '-')}</td>
              <td>${escapeHtml(user.username || '-')}</td>
              <td>${membershipBadge}</td>
              <td>${totalPoints} </td>
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
              <td>${msg.role === 'user' ? ' 用户' : ' AI'}</td>
              <td class="admin-msg-content">${escapeHtml(content)}</td>
              <td>${escapeHtml(msg.model || '-')}</td>
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
              <td>${escapeHtml(msg.username || msg.email || '-')}</td>
              <td>${msg.role === 'user' ? '' : ''}</td>
              <td class="admin-msg-content">${escapeHtml(content)}</td>
              <td>${escapeHtml(msg.model || '-')}</td>
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
async function loadAdminFeedback() {
  const rating = document.getElementById('adminFeedbackRating')?.value || '';
  const search = document.getElementById('adminFeedbackSearch')?.value || '';
  const table = document.getElementById('adminFeedbackTable');
  if (!table) return;

  try {
    table.innerHTML = '<div class="admin-loading">加载反馈中...</div>';
    const params = new URLSearchParams();
    if (rating) params.set('rating', rating);
    if (search) params.set('search', search);
    const res = await fetch(`/api/admin/feedback?${params.toString()}`, {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const rows = data.feedback || [];
    if (!rows.length) {
      table.innerHTML = '<div class="admin-empty-state">暂无用户反馈</div>';
      return;
    }

    let html = `
      <table class="admin-table admin-feedback-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>类型</th>
            <th>用户</th>
            <th>反馈</th>
            <th>AI回复</th>
            <th>会话</th>
            <th>模型</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
    `;

    rows.forEach((item) => {
      const isPositive = item.rating === 'up';
      const comment = item.comment || '-';
      const messageContent = item.message_content || '';
      const messagePreview = messageContent.substring(0, 180) + (messageContent.length > 180 ? '...' : '');
      html += `
        <tr>
          <td>${item.id}</td>
          <td><span class="feedback-rating-badge ${isPositive ? 'positive' : 'negative'}">${isPositive ? '点赞' : '倒赞'}</span></td>
          <td>${escapeHtml(item.username || item.user_email || `#${item.user_id}`)}</td>
          <td class="admin-feedback-comment">${escapeHtml(comment)}</td>
          <td class="admin-msg-content">${escapeHtml(messagePreview)}</td>
          <td class="admin-session-id" title="${escapeHtml(item.session_id || '')}">${escapeHtml(item.session_title || item.session_id || '-')}</td>
          <td>${escapeHtml(item.message_model || '-')}</td>
          <td>${formatDate(item.updated_at || item.created_at)}</td>
        </tr>
      `;
    });

    html += '</tbody></table>';
    table.innerHTML = html;
  } catch (err) {
    console.error('加载用户反馈失败:', err);
    table.innerHTML = `<div class="admin-error">加载反馈失败：${escapeHtml(err.message || 'unknown')}</div>`;
  }
}

async function loadAdminModels() {
  const container = document.getElementById('adminModelsPanel');
  if (!container) return;
  container.innerHTML = '<div class="admin-loading">加载模型开关中...</div>';

  try {
    const res = await fetch('/api/admin/models', {
      headers: { 'X-Admin-Token': adminState.token }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载失败');

    const models = data.models || [];
    container.innerHTML = `
      <div class="admin-model-switch-list">
        <div class="admin-model-switch-note">关闭后普通用户的模型列表会隐藏该模型；如果用户当前已选中该模型，前端会自动切回智能模型。</div>
        ${models.map((model) => `
          <div class="admin-model-switch-item">
            <div>
              <div class="admin-model-switch-name">${escapeHtml(model.name || model.id)}</div>
              <div class="admin-model-switch-meta">${escapeHtml(model.id)} · ${escapeHtml(model.group || '模型')}</div>
            </div>
            <label class="admin-switch">
              <input type="checkbox" ${model.enabled ? 'checked' : ''} onchange="toggleAdminModel('${escapeHtml(model.id)}', this.checked, this)">
              <span></span>
            </label>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="admin-error">加载模型开关失败：${escapeHtml(err.message || 'unknown')}</div>`;
  }
}

async function toggleAdminModel(modelId, enabled, inputEl) {
  if (inputEl) inputEl.disabled = true;
  try {
    const res = await fetch(`/api/admin/models/${encodeURIComponent(modelId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminState.token
      },
      body: JSON.stringify({ enabled })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '更新失败');
    await fetchModelAvailability();
    loadAdminModels();
  } catch (err) {
    if (inputEl) {
      inputEl.checked = !enabled;
      inputEl.disabled = false;
    }
    alert('更新模型开关失败: ' + (err.message || '未知错误'));
  }
}

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
              <td>${escapeHtml(session.username || session.email || '-')}</td>
              <td>${escapeHtml(session.title || '新对话')}</td>
              <td>${escapeHtml(session.model || '-')}</td>
              <td>${session.messageCount || 0}</td>
              <td>${formatDate(session.updated_at)}</td>
              <td><button class="admin-action-btn delete" onclick="deleteAdminSession('${session.id}')">删除</button></td>
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
async function deleteAdminSession(sessionId) {
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
  const locale = getCurrentLocale();
  return d.toLocaleDateString(locale) + ' ' + d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

// 键盘快捷键: Windows/Linux Ctrl+Shift+A；macOS Control+Option+A 打开管理员入口
document.addEventListener('keydown', (e) => {
  const key = String(e.key || '').toLowerCase();
  const adminShortcutPressed = key === 'a' && (
    (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) ||
    (e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey)
  );
  if (adminShortcutPressed) {
    e.preventDefault();
    console.log(' 管理员快捷键触发');
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
        <h2> 用户详情</h2>
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
    console.error(' 获取用户详情失败:', err);
    modal.querySelector('.user-detail-body').innerHTML = `
      <div class="user-detail-error"> ${escapeHtml(err.message || '')}</div>
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
        <h3> 基本信息</h3>
        <div class="user-info-grid">
          <div class="user-info-item">
            <span class="label">用户ID</span>
            <span class="value">${user.id}</span>
          </div>
          <div class="user-info-item">
            <span class="label">邮箱</span>
            <span class="value">${escapeHtml(user.email || '-')}</span>
          </div>
          <div class="user-info-item">
            <span class="label">用户名</span>
            <span class="value">${escapeHtml(user.username || '未设置')}</span>
          </div>
          <div class="user-info-item">
            <span class="label">会员等级</span>
            <span class="value">${membershipBadge}</span>
          </div>
          <div class="user-info-item">
            <span class="label">当前点数</span>
            <span class="value">${totalPoints} </span>
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
          <h3> 对话列表 (${sessions.length})</h3>
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
    console.error(' 获取会话消息失败:', err);
    messagesArea.innerHTML = `<div class="ud-messages-error"> ${escapeHtml(err.message || '')}</div>`;
  }
}

function formatAdminPromptTimeDetails(processTrace) {
  if (!processTrace || processTrace === 'null') return '';

  let parsedTrace = processTrace;
  if (typeof parsedTrace === 'string') {
    try {
      parsedTrace = JSON.parse(parsedTrace);
    } catch (error) {
      return '';
    }
  }

  const promptContext = parsedTrace?.prompt_context || parsedTrace?.promptContext || null;
  const requestTimeContext = promptContext?.requestTimeContext || null;
  if (!requestTimeContext?.datetime) return '';

  const detailLines = [
    `datetime: ${requestTimeContext.datetime}`,
    `timezone: ${requestTimeContext.timezone || 'unknown'}`,
    `timeOfDay: ${requestTimeContext.timeOfDay || 'unknown'}`,
    `locale: ${requestTimeContext.locale || 'unknown'}`
  ];

  if (promptContext?.injectedAt) {
    detailLines.push(`injectedAt: ${promptContext.injectedAt}`);
  }

  return `
    <details class="ud-message-reasoning">
      <summary>Prompt 时间注入</summary>
      <pre>${escapeHtml(detailLines.join('\n'))}</pre>
    </details>
  `;
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
    const roleLabel = isUser ? ' 用户' : ' AI';
    const roleClass = isUser ? 'user-msg' : 'ai-msg';

    // 完整显示消息内容，不截断
    const content = msg.content || '(空消息)';

    html += `
      <div class="ud-message-item ${roleClass}">
        <div class="ud-message-header">
          <span class="ud-message-role">${roleLabel}</span>
          <span class="ud-message-time">${formatDate(msg.created_at)}</span>
          ${msg.model ? `<span class="ud-message-model">${escapeHtml(msg.model)}</span>` : ''}
        </div>
        <div class="ud-message-content" onclick="this.classList.toggle('expanded')">
          <pre>${escapeHtml(content)}</pre>
        </div>
        ${msg.reasoning_content ? `
          <details class="ud-message-reasoning">
            <summary> 思考过程 (点击展开)</summary>
            <pre>${escapeHtml(msg.reasoning_content)}</pre>
          </details>
        ` : ''}
        ${formatAdminPromptTimeDetails(msg.process_trace)}
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
