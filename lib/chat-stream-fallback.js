"use strict";

// The provider may stop after reasoning without generating any answer. Emit a
// visible, non-credential-bearing outcome before done for both persisted and
// temporary conversations. Never replay a tool call to manufacture an answer.
const DEFAULT_INCOMPLETE_ANSWER = '上游连接中断，正文尚未生成。请点击重新生成。';
function writeIncompleteAnswer(res, { degraded, visibleContent, persistedContent } = {}) {
  if (!degraded || String(visibleContent || '').trim()) return false;
  const content = String(persistedContent || '').trim() || DEFAULT_INCOMPLETE_ANSWER;
  res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
  return true;
}
function partialStreamWarning(error, hasVisibleContent) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    const reason = status === 402 ? '（额度或计费不可用）' : '';
    const primary = error?.code === 'gpt_primary_temporarily_unavailable' ? '原模型线路暂时不可用，备用线路返回' : '上游模型服务返回';
    return { type: 'stream_warning', code: 'provider_continuation_http_failed', status,
      message: `${primary} HTTP ${status}${reason}，任务未完成。已保存已有内容和工具结果；不会自动重放已执行的操作。` };
  }
  return { type: 'stream_warning', code: 'partial_stream_saved', message: hasVisibleContent
    ? '上游连接中断，已保存已生成的回答。'
    : '上游连接中断，已保存思考记录；请重新生成以获得完整回答。' };
}
module.exports = { DEFAULT_INCOMPLETE_ANSWER, writeIncompleteAnswer, partialStreamWarning };
