const HOST_NAME = 'com.rai.agent';
let nativePort = null;
let nativeSequence = 0;
let controlledTabId = null;
const nativePending = new Map();
const approvalPending = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

function connectNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener((message) => {
    const pending = nativePending.get(String(message?.id || ''));
    if (!pending) return;
    nativePending.delete(String(message.id));
    if (message.ok) pending.resolve(message.result || {});
    else pending.reject(new Error(message.error || 'native_agent_failed'));
  });
  nativePort.onDisconnect.addListener(() => {
    const error = new Error(chrome.runtime.lastError?.message || 'RAI Agent disconnected');
    nativePort = null;
    for (const pending of nativePending.values()) pending.reject(error);
    nativePending.clear();
  });
  return nativePort;
}

function nativeRequest(type, payload = {}) {
  const id = `native_${Date.now()}_${++nativeSequence}`;
  return new Promise((resolve, reject) => {
    nativePending.set(id, { resolve, reject });
    try {
      connectNative().postMessage({ id, type, payload });
    } catch (error) {
      nativePending.delete(id);
      reject(error);
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'rai.request') {
    handleRaiRequest(message, sender)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'rai.approval.reply') {
    const pending = approvalPending.get(String(message.requestId || ''));
    if (!pending) {
      sendResponse({ ok: false, error: 'approval_request_not_found' });
      return false;
    }
    approvalPending.delete(String(message.requestId));
    pending.resolve(message.decision || 'reject');
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'rai.approval.list') {
    sendResponse({ ok: true, requests: [...approvalPending.entries()].map(([id, item]) => ({ id, ...item.view })) });
    return false;
  }
  return false;
});

async function handleRaiRequest(message, sender) {
  if (!sender.tab || !isRaiOrigin(sender.tab.url)) throw new Error('request_origin_not_allowed');
  if (message.operation !== 'tool.execute') return nativeRequest(message.operation, message.payload || {});

  const first = await nativeRequest('tool.execute', message.payload || {});
  let authorized = first;
  if (first.status === 'approval_required') {
    const decision = await requestApproval(message.id, first, sender.tab.id);
    if (decision === 'reject') {
      return nativeRequest('tool.reject', {
        envelope: message.payload?.envelope,
        reason: 'user_rejected_local_action'
      });
    }
    authorized = await nativeRequest('tool.execute', {
      ...(message.payload || {}),
      approval: decision,
      grantRoot: first.path || undefined
    });
  }
  if (authorized.status !== 'browser_authorized') return authorized;
  const browserResult = await executeBrowserAction(authorized.tool, authorized.parameters || {});
  return nativeRequest('browser.complete', {
    authorizationToken: authorized.authorizationToken,
    result: browserResult
  });
}

function requestApproval(requestId, view, tabId) {
  return new Promise((resolve) => {
    approvalPending.set(String(requestId), { resolve, view });
    chrome.action.setBadgeText({ text: '!' }).catch(() => undefined);
    chrome.action.setBadgeBackgroundColor({ color: '#C5532D' }).catch(() => undefined);
    chrome.tabs.sendMessage(tabId, { type: 'rai.approval.pending', request: { id: requestId, ...view } }).catch(() => undefined);
    chrome.runtime.sendMessage({ type: 'rai.approval.changed' }).catch(() => undefined);
  }).finally(() => {
    if (approvalPending.size === 0) chrome.action.setBadgeText({ text: '' }).catch(() => undefined);
  });
}

async function findControlledTab({ createForNavigation = false } = {}) {
  if (controlledTabId) {
    const existing = await chrome.tabs.get(controlledTabId).catch(() => null);
    if (existing && !isRaiOrigin(existing.url)) return existing;
    controlledTabId = null;
  }
  const stored = await chrome.storage.session.get('controlledTabId').catch(() => ({}));
  if (stored.controlledTabId) {
    const existing = await chrome.tabs.get(stored.controlledTabId).catch(() => null);
    if (existing && !isRaiOrigin(existing.url)) {
      controlledTabId = existing.id;
      return existing;
    }
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const active = tabs.find((tab) => tab.id && !isRaiOrigin(tab.url));
  if (active) {
    controlledTabId = active.id;
    await chrome.storage.session.set({ controlledTabId });
    return active;
  }
  if (!createForNavigation) return null;
  const created = await chrome.tabs.create({ active: true, url: 'about:blank' });
  controlledTabId = created.id;
  await chrome.storage.session.set({ controlledTabId });
  return created;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== controlledTabId) return;
  controlledTabId = null;
  chrome.storage.session.remove('controlledTabId').catch(() => undefined);
});

async function executeBrowserAction(tool, parameters) {
  const tab = await findControlledTab({ createForNavigation: tool === 'browser.navigate' });
  const tabId = tab?.id;
  const started = Date.now();
  if (!tabId) return { success: false, error: 'controlled_tab_unavailable' };
  if (tool === 'browser.navigate') {
    const url = String(parameters.url || '');
    if (!/^https?:\/\//i.test(url)) return { success: false, error: 'invalid_navigation_url' };
    await chrome.tabs.update(tabId, { url });
    await chrome.tabs.update(tabId, { active: true });
    return { success: true, output: `Navigating to ${url}`, duration_ms: Date.now() - started };
  }
  if (tool === 'browser.read') {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 120000) })
    });
    return { success: true, output: JSON.stringify(result?.result || {}), duration_ms: Date.now() - started };
  }
  if (tool === 'browser.scroll') {
    const y = Number(parameters.y || 0);
    await chrome.scripting.executeScript({ target: { tabId }, func: (amount) => window.scrollBy({ top: amount, behavior: 'smooth' }), args: [y] });
    return { success: true, output: `Scrolled ${y}px`, duration_ms: Date.now() - started };
  }
  if (tool === 'browser.click' || tool === 'browser.type' || tool === 'browser.submit') {
    const selector = String(parameters.selector || '');
    if (!selector || selector.length > 500) return { success: false, error: 'invalid_selector' };
    const text = String(parameters.text || '');
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (operation, targetSelector, value) => {
        const element = document.querySelector(targetSelector);
        if (!element) return { success: false, error: 'element_not_found' };
        if (operation === 'browser.click') element.click();
        if (operation === 'browser.submit') {
          const form = element instanceof HTMLFormElement ? element : element.closest('form');
          if (!form) return { success: false, error: 'form_not_found' };
          form.requestSubmit();
        }
        if (operation === 'browser.type') {
          if (!('value' in element)) return { success: false, error: 'element_not_editable' };
          element.focus();
          element.value = value;
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { success: true, tag: element.tagName };
      },
      args: [tool, selector, text]
    });
    const value = result?.result || { success: false, error: 'browser_action_failed' };
    return { ...value, output: JSON.stringify(value), duration_ms: Date.now() - started };
  }
  if (tool === 'browser.screenshot') return { success: false, error: 'screenshot_requires_explicit_cloud_upload' };
  return { success: false, error: `unsupported_browser_tool:${tool}` };
}

function isRaiOrigin(url) {
  try {
    return ['https://rai.rick.sarl', 'https://rai.000339.xyz', 'https://rai.rick.quest'].includes(new URL(url).origin);
  } catch (_) {
    return false;
  }
}
