'use strict';
// Preserve the immutable prompt/history prefix; dynamic trusted instructions stay at the turn tail.
function buildCacheStableMessages(messages, baseline, fullSystem) {
  const history = messages.map(message => ({ ...message }));
  if (!baseline) return fullSystem ? [{ role: 'system', content: fullSystem }, ...history] : history;
  if (!String(fullSystem || '').startsWith(baseline)) throw new Error('canonical_prompt_prefix_changed');
  const runtime = String(fullSystem).slice(baseline.length).trim();
  if (runtime) {
    let lastUser = -1;
    for (let index = history.length - 1; index >= 0; index--) if (history[index].role === 'user') { lastUser = index; break; }
    history.splice(lastUser < 0 ? history.length : lastUser, 0, { role: 'system', content: runtime });
  }
  return [{ role: 'system', content: baseline }, ...history];
}
module.exports = { buildCacheStableMessages };
