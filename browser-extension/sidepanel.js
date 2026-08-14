const list = document.getElementById('approvalList');
const empty = document.getElementById('emptyState');
const status = document.getElementById('statusText');

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: 'rai.approval.list' }).catch((error) => ({ ok: false, error: error.message }));
  const requests = response?.requests || [];
  list.replaceChildren(...requests.map(renderRequest));
  empty.hidden = requests.length > 0;
  status.textContent = response?.ok ? `${requests.length} 个待确认操作` : '本地 Agent 未连接';
}

function renderRequest(request) {
  const card = document.createElement('section');
  card.className = 'approval';
  const heading = document.createElement('h2');
  heading.textContent = request.tool || '本地操作';
  const meta = document.createElement('p');
  meta.className = 'approval-meta';
  meta.textContent = `${request.risk || 'unknown'} · ${request.reason || ''}`;
  const details = document.createElement('pre');
  details.textContent = JSON.stringify(request.parameters || {}, null, 2);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(button('允许一次', 'once', 'allow'), button('始终允许', 'always', 'always'), button('拒绝', 'reject', 'reject'));
  card.append(heading, meta, details, actions);
  return card;

  function button(label, decision, className) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = label;
    element.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'rai.approval.reply', requestId: request.id, decision });
      refresh();
    });
    return element;
  }
}

document.getElementById('refreshBtn').addEventListener('click', refresh);
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'rai.approval.changed') refresh();
});
refresh();
