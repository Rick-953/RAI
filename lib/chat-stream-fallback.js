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
module.exports = { DEFAULT_INCOMPLETE_ANSWER, writeIncompleteAnswer };
