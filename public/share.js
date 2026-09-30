(() => {
  'use strict';
  const key = location.hash.slice(1);
  const status = document.getElementById('shareStatus');
  const title = document.getElementById('shareTitle');
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) { title.textContent = '无效的分享链接'; return; }
  const root = location.pathname.replace(/\/share\.html$/, '');
  fetch(`${root}/api/shares/read`, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    .then(async response => { if (!response.ok) throw new Error('分享已过期、已撤销或不存在'); return response.json(); })
    .then(data => {
      title.textContent = data.title;
      for (const message of data.messages) {
        const article = document.createElement('article'); article.className = `rai-share-message ${message.role === 'user' ? 'user' : 'assistant'}`;
        const label = document.createElement('h2'); label.textContent = message.role === 'user' ? '用户' : 'RAI';
        const content = document.createElement('p'); content.textContent = message.content;
        article.append(label, content); document.getElementById('sharedMessages').append(article);
      }
      const link = document.getElementById('openCxRai');
      link.href = `cxrai://conversation?key=${encodeURIComponent(key)}&origin=${encodeURIComponent(location.origin + root)}`; link.hidden = false;
      status.textContent = '正在尝试打开 CX RAI；若浏览器阻止，请点击上方按钮，或直接在此阅读。';
      // Browsers may require a user gesture; no installation detection, loops or timed navigation away from the page.
      try { location.href = link.href; } catch (_) { /* The explicit link and web view remain available. */ }
    }).catch(error => { title.textContent = '无法打开分享'; status.textContent = error.message; });
})();
