function buildPlannerPrompt(maxSubAgents = 4) {
  return `You are a multi-agent planner.

Goal:
Return a strict JSON execution plan for a user request.

Complexity:
- simple: still output managed task plan
- medium: output managed task plan
- complex: output managed task plan

Rules:
- you MUST always output exactly ${maxSubAgents} tasks
- task agent_id MUST be 1..${maxSubAgents} (one each, no duplicates)
- assign one task to each role: planner, researcher, synthesizer, verifier
- tasks must be complementary, not duplicates
- each task must be a decomposed sub-problem, not the original question
- keep each task concrete and actionable
- direct_answer should be null in normal cases (managed pipeline)

Output JSON only:
{
  "complexity": "simple|medium|complex",
  "user_intent": "one-sentence intent",
  "direct_answer": "string|null",
  "tasks": [
    {
      "agent_id": 1,
      "role": "planner|researcher|synthesizer|verifier|custom",
      "task": "specific sub task",
      "output_hint": "expected output format"
    }
  ]
}`;
}

function buildSubAgentPrompt(task, userQuestion) {
  return `You are a focused sub-agent.

Role: ${task.role || 'custom'}
Assigned task: ${task.task || 'Analyze from your role and produce useful output.'}
Output hint: ${task.output_hint || 'Return concise bullet points with rationale.'}

User original question (context only):
${userQuestion}

Hard rules:
1. Complete only your assigned sub task.
2. Do not answer the whole problem end-to-end.
3. Output directly, no greetings or filler.`;
}

function buildSynthesisPrompt({ userMessage, userIntent, drafts }) {
  const draftText = drafts
    .map((d, idx) => {
      const usageText = d.usage && d.usage.total_tokens != null
        ? ` (tokens: ${d.usage.total_tokens})`
        : '';
      return `[Draft ${idx + 1} | task-${d.taskId} | ${d.role}]${usageText}
Task: ${d.task}
Summary: ${d.summary}
Content:
${d.content}`;
    })
    .join('\n\n');

  return `You are the orchestrator synthesizer.
Merge sub-agent drafts into one high-quality final answer.

User intent: ${userIntent || 'N/A'}
User question: ${userMessage}

Requirements:
1. Fuse insights, do not concatenate drafts mechanically.
2. If drafts conflict, prefer better-supported claims and mention uncertainty.
3. Give conclusion first, then key evidence and actionable steps.
4. Keep structure clear and concise.

Draft inputs:
${draftText}`;
}

function summarizeDraft(content, maxLen = 80) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

module.exports = {
  buildPlannerPrompt,
  buildSubAgentPrompt,
  buildSynthesisPrompt,
  summarizeDraft
};
