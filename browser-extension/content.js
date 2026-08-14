const RAI_ORIGINS = new Set([
  'https://rai.rick.sarl',
  'https://rai.000339.xyz',
  'https://rai.rick.quest'
]);

function postToPage(message) {
  window.postMessage({ source: 'rai-connect-extension', ...message }, window.location.origin);
}

if (RAI_ORIGINS.has(window.location.origin)) {
  postToPage({ type: 'presence', version: chrome.runtime.getManifest().version });

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== 'rai-web' || message.type !== 'native.request') return;
    const id = String(message.id || '');
    if (!id) return;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'rai.request',
        id,
        operation: message.operation,
        payload: message.payload || {}
      });
      postToPage({ type: 'native.response', id, ...(result || { ok: false, error: 'empty_extension_response' }) });
    } catch (error) {
      postToPage({ type: 'native.response', id, ok: false, error: String(error?.message || error) });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'rai.approval.pending') {
      postToPage({ type: 'approval.pending', request: message.request });
    }
  });
}
