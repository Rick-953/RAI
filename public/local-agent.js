(() => {
  'use strict';

  const state = {
    extensionAvailable: false,
    extensionVersion: '',
    serverEnabled: false,
    devices: [],
    activeDeviceId: localStorage.getItem('rai_local_agent_device_id') || '',
    agentSession: null,
    pending: new Map(),
    sequence: 0,
    activitiesConversationId: '',
    initialized: false
  };

  const text = (zh, en) => {
    const context = getContext();
    return String(context.language || '').toLowerCase().startsWith('en') ? en : zh;
  };

  const errorMessages = {
    local_agent_unavailable: ['本地 Agent 服务尚未启用', 'The local Agent service is not enabled'],
    pending_not_found: ['本地任务已过期，请重新发送', 'The local task expired. Send it again.'],
    agent_session_expired: ['本地连接已过期，请重新连接当前对话', 'The local connection expired. Reconnect this conversation.'],
    agent_session_conversation_mismatch: ['本地连接属于另一个对话', 'The local connection belongs to another conversation.'],
    request_origin_not_allowed: ['当前页面不能调用本地 Agent', 'This page cannot access the local Agent'],
    controlled_tab_unavailable: ['请先打开一个要操作的网页标签页', 'Open a web page tab to control first'],
    user_rejected_local_action: ['你已拒绝这次本地操作', 'You rejected this local action']
  };

  function localizedError(value) {
    const code = String(value || 'local_agent_failed').split(':')[0];
    const message = errorMessages[code];
    return message ? text(message[0], message[1]) : String(value || text('本地 Agent 暂不可用', 'Local Agent is unavailable'));
  }

  function connectedHere() {
    const conversationId = getContext().conversationId;
    return !!state.agentSession && !!conversationId && state.agentSession.conversationId === conversationId;
  }

  function getContext() {
    return typeof window.getRaiLocalAgentContext === 'function'
      ? (window.getRaiLocalAgentContext() || {})
      : {};
  }

  function authHeaders() {
    const token = getContext().token;
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  function rpc(operation, payload = {}, timeoutMs = 15000) {
    const id = `web_${Date.now()}_${++state.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error('RAI Connect response timeout'));
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: 'rai-web', type: 'native.request', id, operation, payload }, window.location.origin);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== 'rai-connect-extension') return;
    if (message.type === 'presence') {
      state.extensionAvailable = true;
      state.extensionVersion = String(message.version || '');
      render();
      return;
    }
    if (message.type === 'approval.pending') {
      setMenuStatus('attention');
      if (typeof window.showToast === 'function') {
        window.showToast(text('请在 RAI Connect 侧边栏确认本地操作', 'Confirm the local action in the RAI Connect side panel'));
      }
      return;
    }
    if (message.type !== 'native.response') return;
    const pending = state.pending.get(String(message.id || ''));
    if (!pending) return;
    clearTimeout(pending.timer);
    state.pending.delete(String(message.id));
    if (message.ok) pending.resolve(message.result || {});
    else pending.reject(new Error(message.error || 'RAI Connect request failed'));
  });

  async function api(path, options = {}) {
    const response = await fetch(`${window.RAI_API_BASE || '/api'}${path}`, {
      cache: 'no-store',
      ...options,
      headers: { ...authHeaders(), ...(options.headers || {}) }
    });
    let data = {};
    try { data = await response.json(); } catch (_) { /* handled below */ }
    if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  async function refreshStatus() {
    try {
      const response = await fetch(`${window.RAI_API_BASE || '/api'}/agent/status`, { cache: 'no-store' });
      const data = await response.json();
      state.serverEnabled = !!data.enabled;
    } catch (_) {
      state.serverEnabled = false;
    }
    if (getContext().token) {
      try {
        const data = await api('/agent/devices');
        state.devices = Array.isArray(data.devices) ? data.devices : [];
        if (!state.devices.some((device) => device.id === state.activeDeviceId && !device.revokedAt)) {
          state.activeDeviceId = state.devices.find((device) => !device.revokedAt)?.id || '';
          if (state.activeDeviceId) localStorage.setItem('rai_local_agent_device_id', state.activeDeviceId);
        }
      } catch (_) {
        state.devices = [];
      }
    }
    render();
  }

  async function pair() {
    if (!state.extensionAvailable) throw new Error(text('请先安装 RAI Connect 浏览器扩展', 'Install the RAI Connect browser extension first'));
    const device = await rpc('device.info');
    const pairing = await api('/agent/pairings/start', {
      method: 'POST',
      body: JSON.stringify({
        publicKey: device.publicKey,
        name: device.name,
        platform: device.platform,
        agentVersion: device.agentVersion,
        protocolVersion: device.protocolVersion,
        capabilities: device.capabilities
      })
    });
    const proof = await rpc('pair.sign', { challenge: pairing.challenge });
    const completed = await api(`/agent/pairings/${encodeURIComponent(pairing.pairingId)}/complete`, {
      method: 'POST',
      body: JSON.stringify(proof)
    });
    await rpc('server.trust', {
      confirmed: true,
      issuer: completed.issuer,
      keyId: completed.keyId,
      publicKeyPem: completed.serverPublicKeyPem
    });
    state.activeDeviceId = completed.deviceId;
    localStorage.setItem('rai_local_agent_device_id', completed.deviceId);
    await refreshStatus();
    return completed;
  }

  async function enable() {
    const context = getContext();
    if (!context.token) throw new Error(text('请先登录 RAI', 'Sign in to RAI first'));
    if (!context.conversationId) throw new Error(text('请先创建或打开一个对话', 'Create or open a conversation first'));
    if (!state.activeDeviceId) await pair();
    const pending = await api('/agent/sessions', {
      method: 'POST',
      body: JSON.stringify({ deviceId: state.activeDeviceId, conversationId: context.conversationId })
    });
    const proof = await rpc('session.sign', { challenge: pending.challenge });
    await api(`/agent/sessions/${encodeURIComponent(pending.sessionId)}/accept`, {
      method: 'POST', body: JSON.stringify(proof)
    });
    state.agentSession = {
      id: pending.sessionId,
      conversationId: context.conversationId,
      deviceId: state.activeDeviceId
    };
    setMenuStatus('active');
    render();
    return state.agentSession;
  }

  async function disable() {
    const session = state.agentSession;
    state.agentSession = null;
    if (session && getContext().token) {
      await api(`/agent/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    setMenuStatus('idle');
    render();
  }

  async function toggle() {
    try {
      if (connectedHere()) await disable();
      else await enable();
    } catch (error) {
      if (typeof window.showToast === 'function') window.showToast(localizedError(error.message));
      renderError(localizedError(error.message));
    }
  }

  function getChatCapability() {
    const context = getContext();
    if (!state.agentSession || state.agentSession.conversationId !== context.conversationId) return null;
    return { protocolVersion: 1, sessionId: state.agentSession.id, capabilities: ['filesystem', 'process', 'browser'] };
  }

  async function handleToolCall(envelope) {
    if (!envelope || envelope.agentSessionId !== state.agentSession?.id) throw new Error('local_agent_session_mismatch');
    setMenuStatus('running');
    try {
      const completed = await rpc('tool.execute', { envelope }, 5 * 60 * 1000);
      if (!completed.receipt || !completed.result) throw new Error('local_agent_result_incomplete');
      await api('/agent/tool-results', {
        method: 'POST',
        body: JSON.stringify({ runId: envelope.runId, receipt: completed.receipt, result: completed.result })
      });
      await refreshActivities(envelope.conversationId);
      return true;
    } finally {
      setMenuStatus(connectedHere() ? 'active' : 'idle');
    }
  }

  async function refreshActivities(conversationId = getContext().conversationId) {
    const container = document.getElementById('localAgentActivity');
    if (!container || !conversationId || !getContext().token) {
      if (container) container.hidden = true;
      state.activitiesConversationId = conversationId || '';
      return;
    }
    try {
      const data = await api(`/agent/tool-runs?conversationId=${encodeURIComponent(conversationId)}&limit=20`);
      const runs = Array.isArray(data.runs) ? data.runs : [];
      container.replaceChildren(...runs.map(renderActivity));
      container.hidden = runs.length === 0;
      state.activitiesConversationId = conversationId;
    } catch (_) {
      container.hidden = true;
    }
  }

  function renderActivity(run) {
    const details = document.createElement('details');
    details.className = `local-agent-card ${run.status || 'pending'}`;
    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.className = 'local-agent-card-title';
    title.textContent = run.tool || text('本地操作', 'Local action');
    const status = document.createElement('span');
    status.className = 'local-agent-card-status';
    const statusLabels = {
      pending: text('等待执行', 'Pending'),
      complete: text('已完成', 'Complete'),
      failed: text('失败', 'Failed')
    };
    status.textContent = statusLabels[run.status] || run.status || statusLabels.pending;
    summary.append(title, status);
    const input = document.createElement('pre');
    input.textContent = run.inputSummary || '';
    const output = document.createElement('pre');
    output.textContent = run.outputPreview || '';
    if (run.truncated) {
      const notice = document.createElement('p');
      notice.className = 'local-agent-card-notice';
      notice.textContent = text('云端仅显示截断输出；完整内容保留在执行设备。', 'Cloud output is truncated; the complete output remains on the executing device.');
      details.append(summary, input, output, notice);
    } else {
      details.append(summary, input, output);
    }
    return details;
  }

  function render() {
    const card = document.getElementById('settingsLocalAgentCard');
    if (!card) return;
    card.replaceChildren();
    const header = document.createElement('div');
    header.className = 'local-agent-settings-header';
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'RAI Local Agent';
    const description = document.createElement('p');
    const isConnectedHere = connectedHere();
    description.textContent = isConnectedHere
      ? text('当前对话已连接本地终端和浏览器', 'Local terminal and browser are connected to this conversation')
      : state.extensionAvailable
        ? text('扩展已安装；绑定设备后可使用本地能力', 'The extension is installed; pair this device to use local tools')
        : text('安装 RAI Connect 扩展和本地 Agent 后启用', 'Install RAI Connect and the local Agent to enable local tools');
    copy.append(title, description);
    const badge = document.createElement('span');
    badge.className = `local-agent-settings-badge ${isConnectedHere ? 'active' : ''}`;
    badge.textContent = isConnectedHere ? text('已连接', 'Connected') : text('未连接', 'Disconnected');
    header.append(copy, badge);
    const actions = document.createElement('div');
    actions.className = 'local-agent-settings-actions';
    const primary = document.createElement('button');
    primary.type = 'button';
    primary.textContent = state.activeDeviceId
      ? (isConnectedHere ? text('断开当前对话', 'Disconnect') : text('连接当前对话', 'Connect conversation'))
      : text('绑定此设备', 'Pair this device');
    primary.addEventListener('click', () => (state.activeDeviceId ? toggle() : pair()).catch((error) => renderError(localizedError(error.message))));
    actions.append(primary);
    for (const device of state.devices.filter((item) => !item.revokedAt)) {
      const row = document.createElement('div');
      row.className = 'local-agent-device-row';
      const label = document.createElement('span');
      label.textContent = `${device.name} · ${device.platform} · ${device.agentVersion}`;
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = text('撤销', 'Revoke');
      revoke.addEventListener('click', () => revokeDevice(device.id));
      row.append(label, revoke);
      actions.append(row);
    }
    card.append(header, actions);
  }

  async function revokeDevice(deviceId) {
    await api(`/agent/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    if (state.activeDeviceId === deviceId) {
      state.activeDeviceId = '';
      state.agentSession = null;
      localStorage.removeItem('rai_local_agent_device_id');
    }
    await refreshStatus();
  }

  function renderError(message) {
    const card = document.getElementById('settingsLocalAgentCard');
    if (!card) return;
    let error = card.querySelector('.local-agent-settings-error');
    if (!error) {
      error = document.createElement('p');
      error.className = 'local-agent-settings-error';
      card.append(error);
    }
    error.textContent = String(message || 'Local Agent unavailable');
  }

  function setMenuStatus(status) {
    const item = document.getElementById('localAgentMenuItem');
    const toggle = document.getElementById('localAgentToggle');
    if (item) item.dataset.status = status;
    if (toggle) toggle.classList.toggle('active', ['active', 'running'].includes(status));
  }

  function initialize() {
    if (state.initialized) return;
    state.initialized = true;
    document.getElementById('localAgentMenuItem')?.addEventListener('click', (event) => {
      event.stopPropagation();
      toggle();
    });
    refreshStatus();
    setInterval(() => {
      const conversationId = getContext().conversationId;
      if (conversationId !== state.activitiesConversationId) {
        refreshActivities(conversationId);
        setMenuStatus(connectedHere() ? 'active' : 'idle');
        render();
      }
    }, 2500);
    new MutationObserver(() => render()).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  window.RaiLocalAgent = Object.freeze({
    disable,
    enable,
    getChatCapability,
    handleToolCall,
    initialize,
    refreshActivities,
    refreshStatus,
    toggle
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
})();
