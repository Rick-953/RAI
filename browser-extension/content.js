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

  // The side panel uses this page as the authenticated RAI chat surface. The
  // access token stays inside the page; only the bounded message snapshot and
  // send/stream status cross the extension bridge.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'rai.chat.request') return false;
    const requestId = String(message.requestId || '');
    if (!requestId) return false;
    postToPage({
      type: 'chat.request',
      requestId,
      operation: message.operation,
      payload: message.payload || {}
    });
    sendResponse({ ok: true, queued: true });
    return false;
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== 'rai-web' || message.type !== 'connect.chat.response') return;
    chrome.runtime.sendMessage({ type: 'rai.chat.response', ...message }).catch(() => undefined);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'rai.approval.pending') {
      postToPage({ type: 'approval.pending', request: message.request });
    }
  });
}
