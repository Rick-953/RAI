(function () {
  'use strict';
  const panel = document.querySelector('[data-third-party-notices]');
  if (!panel) return;
  const list = panel.querySelector('[data-third-party-list]');
  const search = panel.querySelector('[data-third-party-search]');
  const status = panel.querySelector('[data-third-party-status]');
  let manifest;
  let loading;
  const translations = {
    en: {
      title: 'Open source software and licenses',
      description: 'Projects used by RAI Web, its desktop shell and Local Agent. Expand a project to read the included copyright notices and complete license texts.',
      search: 'Search projects or licenses', source: 'Official source', sourceArchive: 'Exact source archive', loading: 'Loading licenses…',
      error: 'Licenses could not be loaded. Expand this section again to retry.',
      count: (shown, total) => `${shown} / ${total} component records`,
      server: 'Server', browser: 'Browser', font: 'Font', 'desktop-agent': 'Desktop / Local Agent lockfile',
      scope: 'Includes production npm dependencies and all locked Rust dependencies, including build and platform crates. Development-only npm tools are excluded. Brand names and logos belong to their respective owners.',
      full: 'Open the complete license viewer', licenseError: 'This notice could not be loaded. Close and reopen this project to retry.'
    },
    'zh-CN': {
      title: '开源软件与许可',
      description: 'RAI Web、桌面外壳和本地 Agent 使用的项目。展开项目可查看保留的版权声明及完整许可原文。',
      search: '搜索项目或许可证', source: '官方来源', sourceArchive: '此版本源码归档', loading: '正在读取许可…',
      error: '许可未能加载，请重新展开此区域重试。',
      count: (shown, total) => `${shown} / ${total} 项组件记录`,
      server: '服务端', browser: '浏览器', font: '字体', 'desktop-agent': '桌面 / 本地 Agent 锁定依赖',
      scope: '包含生产 npm 依赖及 Rust 锁文件中的构建、各平台依赖。仅开发使用的 npm 工具不计入。品牌名称与标志归各自权利人所有。',
      full: '打开完整许可查看器', licenseError: '此声明未能加载，请收起后重新展开该项目重试。'
    },
    'zh-TW': {
      title: '開源軟體與授權',
      description: 'RAI Web、桌面外殼和本機 Agent 使用的專案。展開專案可查看保留的版權聲明及完整授權原文。',
      search: '搜尋專案或授權', source: '官方來源', sourceArchive: '此版本原始碼封存', loading: '正在讀取授權…',
      error: '授權未能載入，請重新展開此區域重試。',
      count: (shown, total) => `${shown} / ${total} 項元件記錄`,
      server: '伺服器端', browser: '瀏覽器', font: '字型', 'desktop-agent': '桌面 / 本機 Agent 鎖定依賴',
      scope: '包含正式 npm 依賴及 Rust 鎖定檔中的建置、各平台依賴。僅開發使用的 npm 工具不計入。品牌名稱與標誌歸各自權利人所有。',
      full: '開啟完整授權檢視器', licenseError: '此聲明未能載入，請收起後重新展開該專案重試。'
    }
  };
  const language = () => translations[window.RAILocale?.getLanguage() || document.documentElement.lang] || translations.en;
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function applyLanguage() {
    const text = language();
    panel.querySelectorAll('[data-third-party-text]').forEach(node => {
      node.textContent = text[node.dataset.thirdPartyText] || '';
    });
    search.placeholder = text.search;
    search.setAttribute('aria-label', text.search);
    if (manifest) render();
  }
  async function loadProject(project, body) {
    if (body.dataset.loaded === 'true' || body.dataset.loading === 'true') return;
    body.dataset.loading = 'true';
    body.replaceChildren(element('p', '', language().loading));
    try {
      const content = document.createDocumentFragment();
      const source = new URL(project.source);
      if (source.protocol !== 'https:' || source.username || source.password) throw new Error('Invalid source');
      const link = element('a', 'third-party-source', language().source);
      link.href = source.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      content.appendChild(link);
      if (project.sourceArchive) {
        const archive = new URL(project.sourceArchive);
        if (archive.protocol !== 'https:' || archive.username || archive.password) throw new Error('Invalid source archive');
        const archiveLink = element('a', 'third-party-source third-party-source-archive', language().sourceArchive);
        archiveLink.href = archive.href;
        archiveLink.target = '_blank';
        archiveLink.rel = 'noopener noreferrer';
        content.appendChild(archiveLink);
      }
      if (project.usedBy?.length) content.appendChild(element('p', 'third-party-meta', project.usedBy.join(' · ')));
      for (const notice of project.notices) {
        if (!/^texts\/[a-f0-9]{64}\.txt$/.test(notice.path)) throw new Error('Invalid notice path');
        const response = await fetch(`licenses/${notice.path}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Notice unavailable');
        const value = await response.text();
        const block = element('details', 'third-party-license');
        block.appendChild(element('summary', '', notice.name));
        block.appendChild(element('pre', '', value));
        content.appendChild(block);
      }
      body.replaceChildren(content);
      body.dataset.loaded = 'true';
    } catch (_) {
      body.replaceChildren(element('p', '', language().licenseError));
    } finally {
      delete body.dataset.loading;
    }
  }
  function render() {
    const query = search.value.trim().toLocaleLowerCase();
    const entries = manifest.components.filter(project =>
      [project.name, project.version, project.license, project.scope].join(' ').toLocaleLowerCase().includes(query));
    const fragment = document.createDocumentFragment();
    for (const project of entries) {
      const row = element('details', 'third-party-project');
      row.id = project.id;
      const summary = element('summary', '');
      summary.appendChild(element('span', 'third-party-name', `${project.name} ${project.version}`));
      summary.appendChild(element('span', 'third-party-meta', `${project.license} · ${language()[project.scope] || project.scope}`));
      row.appendChild(summary);
      const body = element('div', 'third-party-project-body');
      row.appendChild(body);
      row.addEventListener('toggle', () => { if (row.open) loadProject(project, body); });
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
    status.textContent = language().count(entries.length, manifest.components.length);
  }
  async function load() {
    if (manifest || loading) return loading;
    status.textContent = language().loading;
    loading = (async () => {
      try {
        const response = await fetch('licenses/manifest.json', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Manifest unavailable');
        const value = await response.json();
        if (value.schemaVersion !== 1 || !Array.isArray(value.components)) throw new Error('Invalid manifest');
        manifest = value;
        render();
      } catch (_) {
        status.textContent = language().error;
      } finally { loading = null; }
    })();
    return loading;
  }
  search.addEventListener('input', () => { if (manifest) render(); });
  panel.addEventListener('toggle', () => { if (panel.open) load(); });
  window.RAILocale?.subscribe(applyLanguage);
  applyLanguage();
  if (panel.open || panel.dataset.thirdPartyNotices === 'standalone') load();
})();
