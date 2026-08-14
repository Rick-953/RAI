const status = document.getElementById('statusText');
const notice = document.getElementById('connectionNotice');
const title = document.getElementById('conversationTitle');
const messages = document.getElementById('messages');
const empty = document.getElementById('emptyState');
const streamState = document.getElementById('streamState');
const input = document.getElementById('messageInput');
const sendButton = document.getElementById('sendBtn');
const approvalList = document.getElementById('approvalList');
const approvalEmpty = document.getElementById('approvalEmpty');
const approvalCount = document.getElementById('approvalCount');
let refreshTimer = null;

function showMessage(message) {
  const element = document.createElement('article');
  element.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = message.role === 'user' ? '你' : 'RAI';
  const body = document.createElement('div');
  body.textContent = String(message.content || '');
  element.append(meta, body);
  return element;
}

async function refreshChat() {
  const response = await chrome.runtime.sendMessage({ type: 'rai.chat.request', operation: 'chat.state' })
    .catch((error) => ({ ok: false, error: error.message }));
  if (!response?.ok) {
    status.textContent = '未连接 RAI 网页';
    title.textContent = '未连接';
    notice.hidden = false;
    notice.textContent = '请在浏览器标签页打开并登录 RAI 网页。侧栏不会保存登录令牌。';
    messages.replaceChildren();
    empty.hidden = false;
    streamState.hidden = true;
    return;
  }
  const state = response.result || {};
  status.textContent = state.authenticated ? '已连接当前 RAI 网页' : 'RAI 网页需要登录';
  title.textContent = state.title || '当前对话';
  notice.hidden = !!state.authenticated;
  if (!state.authenticated) notice.textContent = '请先在 RAI 网页完成登录，再从这里发送消息。';
  const rows = Array.isArray(state.messages) ? state.messages : [];
  messages.replaceChildren(...rows.map(showMessage));
  empty.hidden = rows.length > 0;
  streamState.hidden = !state.isStreaming;
  messages.scrollTop = messages.scrollHeight;
}

async function refreshApprovals() {
  const response = await chrome.runtime.sendMessage({ type: 'rai.approval.list' }).catch(() => ({ requests: [] }));
  const requests = response?.requests || [];
  approvalCount.textContent = String(requests.length);
  approvalEmpty.hidden = requests.length > 0;
  approvalList.replaceChildren(...requests.map(renderApproval));
}

function renderApproval(request) {
  const card = document.createElement('article');
  card.className = 'approval';
  const heading = document.createElement('h3');
  heading.textContent = request.tool || '本地操作';
  const meta = document.createElement('p');
  meta.className = 'approval-meta';
  meta.textContent = `${request.risk || 'unknown'} · ${request.reason || ''}`;
  const details = document.createElement('pre');
  details.textContent = JSON.stringify(request.parameters || {}, null, 2);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(
    actionButton('允许一次', 'once', 'allow'),
    actionButton('始终允许', 'always', 'always'),
    actionButton('拒绝', 'reject', 'reject')
  );
  card.append(heading, meta, details, actions);
  return card;

  function actionButton(label, decision, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'rai.approval.reply', requestId: request.id, decision });
      await refreshApprovals();
    });
    return button;
  }
}

async function refresh() {
  await Promise.all([refreshChat(), refreshApprovals()]);
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
document.getElementById('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content || sendButton.disabled) return;
  sendButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'rai.chat.request', operation: 'chat.send', payload: { content }
    });
    if (!response?.ok) throw new Error(response?.error || '发送失败');
    input.value = '';
    await refreshChat();
  } catch (error) {
    notice.hidden = false;
    notice.textContent = error.message || '发送失败，请检查 RAI 网页连接';
  } finally {
    sendButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'rai.approval.changed') refreshApprovals();
});

refresh();
refreshTimer = setInterval(refreshChat, 1200);
window.addEventListener('unload', () => clearInterval(refreshTimer));
