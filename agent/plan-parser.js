function stripCodeFence(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenceMatch ? fenceMatch[1].trim() : raw;
}

function extractFirstJsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return raw.slice(start);
}

function removeTrailingCommas(text) {
  return String(text || '').replace(/,\s*([}\]])/g, '$1');
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function normalizeRole(role) {
  const raw = String(role || '').toLowerCase().trim();
  if (!raw) return 'custom';
  if (['planner', 'researcher', 'synthesizer', 'verifier'].includes(raw)) return raw;
  return 'custom';
}

function normalizeComplexity(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (raw === 'simple' || raw === 'medium' || raw === 'complex') return raw;
  return 'medium';
}

function normalizeTask(task, index) {
  const fallbackTask = 'Analyze the user question from your role and return actionable points.';
  const fallbackHint = 'Return 3-5 concise bullets with rationale.';
  return {
    agent_id: Number(task.agent_id) || index + 1,
    role: normalizeRole(task.role),
    task: String(task.task || fallbackTask).trim().slice(0, 160) || fallbackTask,
    output_hint: String(task.output_hint || fallbackHint).trim().slice(0, 160) || fallbackHint
  };
}

function buildDefaultPlan(userMessage, maxSubAgents = 4) {
  const tasks = [
    {
      agent_id: 1,
      role: 'planner',
      task: 'Decompose user intent into concrete execution steps and constraints.',
      output_hint: 'Return structured plan with priorities and risks.'
    },
    {
      agent_id: 2,
      role: 'researcher',
      task: 'Extract key facts, constraints, and verifiable points from the request.',
      output_hint: 'Return 3-5 key facts or assumptions.'
    },
    {
      agent_id: 3,
      role: 'synthesizer',
      task: 'Produce a structured solution with practical next steps.',
      output_hint: 'Return step-by-step actions and major risks.'
    },
    {
      agent_id: 4,
      role: 'verifier',
      task: `Challenge assumptions and identify contradictions for: ${String(userMessage || '').slice(0, 90)}`,
      output_hint: 'Return uncertainty points and confidence notes.'
    }
  ].slice(0, Math.max(1, Math.min(maxSubAgents, 4)));

  return {
    complexity: 'medium',
    user_intent: String(userMessage || '').slice(0, 120) || 'User needs a practical answer.',
    direct_answer: null,
    tasks
  };
}

function parsePlanOutput(rawOutput, options = {}) {
  const { maxSubAgents = 4, userMessage = '' } = options;
  const maxAgents = Math.max(1, Math.min(maxSubAgents, 4));

  const step1 = stripCodeFence(rawOutput);
  const step2 = extractFirstJsonObject(step1);
  const step3 = removeTrailingCommas(step2 || step1);
  const parsed = safeJsonParse(step3);
  if (!parsed || typeof parsed !== 'object') {
    return buildDefaultPlan(userMessage, maxAgents);
  }

  const complexity = normalizeComplexity(parsed.complexity);
  const userIntent = String(parsed.user_intent || '').trim() || String(userMessage || '').slice(0, 120);
  const directAnswer = parsed.direct_answer == null ? null : String(parsed.direct_answer).trim();

  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  let tasks = rawTasks.slice(0, maxAgents).map((t, idx) => normalizeTask(t, idx));

  if (complexity === 'simple') {
    tasks = [];
  } else if (tasks.length === 0) {
    tasks = buildDefaultPlan(userMessage, maxAgents).tasks;
  }

  return {
    complexity,
    user_intent: userIntent,
    direct_answer: complexity === 'simple' ? (directAnswer || null) : null,
    tasks
  };
}

module.exports = {
  parsePlanOutput,
  buildDefaultPlan
};
