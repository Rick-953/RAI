(() => {
  'use strict';

  const state = {
    extensionAvailable: false,
    extensionVersion: '',
    serverEnabled: null,
    devices: [],
    activeDeviceId: localStorage.getItem('rai_local_agent_device_id') || '',
    agentSession: null,
    pending: new Map(),
    sequence: 0,
    activitiesConversationId: '',
    initialized: false
  };

  const installCommands = Object.freeze({
    unix: "curl --fail --location --proto '=https' --tlsv1.2 https://github.com/Rick-953/RAI/releases/latest/download/install.sh | sh",
    windows: 'irm https://github.com/Rick-953/RAI/releases/latest/download/install.ps1 | iex'
  });

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
    if (!context.conversationId) {
      throw new Error(text(
        '当前是尚未保存的新对话。请先发送第一条消息创建对话，再开启本地 Agent；授权只对这个对话生效。',
        'This is an unsaved new conversation. Send the first message to create it, then enable Local Agent. Authorization applies only to that conversation.'
      ));
    }
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
    if (!state.extensionAvailable) {
      openInstallGuide();
      if (typeof window.showToast === 'function') {
        window.showToast(text('已打开 RAI Connect 与本地 Agent 安装步骤', 'RAI Connect and Local Agent installation steps are open'));
      }
      return;
    }
    try {
      if (connectedHere()) await disable();
      else await enable();
    } catch (error) {
      if (typeof window.showToast === 'function') window.showToast(localizedError(error.message));
      renderError(localizedError(error.message));
    }
  }

  function openInstallGuide() {
    if (typeof window.openSettings === 'function') window.openSettings();
    window.requestAnimationFrame(() => {
      if (typeof window.switchSettingsSection === 'function') window.switchSettingsSection('about');
      window.requestAnimationFrame(() => {
        document.getElementById('settingsRaiConnectInstall')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  async function copyInstallCommand(key) {
    const command = installCommands[key];
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
    } catch (_) {
      const input = document.createElement('textarea');
      input.value = command;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    if (typeof window.showToast === 'function') {
      window.showToast(text('安装命令已复制', 'Installation command copied'));
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
    const context = getContext();
    let status = 'checking';
    let statusLabel = text('检测中', 'Checking');
    let descriptionText = text('正在检查网页、扩展与本地 Agent 的连接状态。', 'Checking the web app, extension, and Local Agent connection.');
    let primaryLabel = text('正在检测', 'Checking');
    let primaryAction = null;

    if (state.serverEnabled === false) {
      status = 'unavailable';
      statusLabel = text('服务不可用', 'Unavailable');
      descriptionText = text('RAI 服务器暂未开放本地 Agent，请稍后重新检测。', 'The RAI server is not currently accepting Local Agent connections. Try again later.');
      primaryLabel = text('重新检测', 'Check again');
      primaryAction = refreshStatus;
    } else if (!state.extensionAvailable) {
      status = 'install';
      statusLabel = text('需要安装', 'Install required');
      descriptionText = text('尚未检测到 RAI Connect。请先按“关于”页的步骤安装本地 Agent，再由浏览器加载扩展。', 'RAI Connect was not detected. Follow the About-page steps to install Local Agent, then load the extension in your browser.');
      primaryLabel = text('查看安装步骤', 'View installation steps');
      primaryAction = openInstallGuide;
    } else if (!state.activeDeviceId) {
      status = 'pair';
      statusLabel = text('待绑定', 'Pair device');
      descriptionText = text('已检测到扩展和本地 Agent。绑定此设备后，每个对话仍会单独授权。', 'The extension and Local Agent were detected. Pair this device; each conversation is still authorized separately.');
      primaryLabel = text('绑定此设备', 'Pair this device');
      primaryAction = pair;
    } else if (!context.conversationId) {
      status = 'conversation';
      statusLabel = text('等待创建对话', 'Create conversation');
      descriptionText = text('设备已绑定。当前是尚未保存的新对话；发送第一条消息创建对话后即可连接。', 'This device is paired. The current conversation is not saved yet; send the first message to create it before connecting.');
      primaryLabel = text('发送首条消息后连接', 'Connect after first message');
    } else if (isConnectedHere) {
      status = 'connected';
      statusLabel = text('当前对话已连接', 'Connected here');
      descriptionText = text('本地终端和浏览器已连接到当前对话；高风险操作仍需你确认。', 'Local terminal and browser access is connected to this conversation; high-risk actions still require your approval.');
      primaryLabel = text('断开当前对话', 'Disconnect conversation');
      primaryAction = disable;
    } else {
      status = 'ready';
      statusLabel = text('可连接', 'Ready');
      descriptionText = text('设备已绑定。连接只对当前对话生效，切换对话后需要重新确认。', 'This device is paired. Connection applies only to the current conversation and must be confirmed again after switching conversations.');
      primaryLabel = text('连接当前对话', 'Connect conversation');
      primaryAction = enable;
    }

    description.textContent = descriptionText;
    copy.append(title, description);
    const badge = document.createElement('span');
    badge.className = `local-agent-settings-badge ${status}`;
    badge.textContent = statusLabel;
    header.append(copy, badge);
    const actions = document.createElement('div');
    actions.className = 'local-agent-settings-actions';
    const primary = document.createElement('button');
    primary.type = 'button';
    primary.textContent = primaryLabel;
    primary.disabled = !primaryAction;
    if (primaryAction) {
      primary.addEventListener('click', () => Promise.resolve(primaryAction()).catch((error) => renderError(localizedError(error.message))));
    }
    actions.append(primary);
    if (state.extensionAvailable) {
      const instructions = document.createElement('button');
      instructions.type = 'button';
      instructions.className = 'local-agent-settings-help';
      instructions.textContent = text('安装与使用说明', 'Installation and usage guide');
      instructions.addEventListener('click', openInstallGuide);
      actions.append(instructions);
    }
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
    document.querySelectorAll('[data-local-agent-copy]').forEach((button) => {
      button.addEventListener('click', () => copyInstallCommand(button.dataset.localAgentCopy));
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
