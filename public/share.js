(() => {
  'use strict';
  const key = location.hash.slice(1);
  const status = document.getElementById('shareStatus');
  const title = document.getElementById('shareTitle');
  const text = window.RAIEntryI18n.text;
  const state = { titleKey: 'shareLoading', statusKey: '', userLabels: [] };
  function renderState() {
    if (state.titleKey) title.textContent = text(state.titleKey);
    status.textContent = state.statusKey ? text(state.statusKey) : '';
    state.userLabels.forEach(label => { label.textContent = text('user'); });
  }
  if (window.RAILocale) window.RAILocale.subscribe(renderState);
  renderState();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) { state.titleKey = 'shareInvalid'; renderState(); return; }
  const root = location.pathname.replace(/\/share\.html$/, '');
  fetch(`${root}/api/shares/read`, { method: 'POST', cache: 'no-store', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    .then(async response => { if (!response.ok) throw new Error('shareExpired'); return response.json(); })
    .then(data => {
      state.titleKey = '';
      title.textContent = data.title;
      for (const message of data.messages) {
        const article = document.createElement('article'); article.className = `rai-share-message ${message.role === 'user' ? 'user' : 'assistant'}`;
        const label = document.createElement('h2'); label.textContent = message.role === 'user' ? text('user') : 'RAI';
        if (message.role === 'user') state.userLabels.push(label);
        const content = document.createElement('p'); content.textContent = message.content;
        article.append(label, content); document.getElementById('sharedMessages').append(article);
      }
      const link = document.getElementById('openCxRai');
      link.href = `cxrai://conversation?key=${encodeURIComponent(key)}&origin=${encodeURIComponent(location.origin + root)}`; link.hidden = false;
      state.statusKey = 'shareHandoff';
      renderState();
      // Browsers may require a user gesture; no installation detection, loops or timed navigation away from the page.
      try { location.href = link.href; } catch (_) { /* The explicit link and web view remain available. */ }
    }).catch(error => { state.titleKey = 'shareFailed'; state.statusKey = error.message === 'shareExpired' ? 'shareExpired' : 'shareNetwork'; renderState(); });
})();
