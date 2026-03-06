const {
  buildPlannerPrompt,
  buildSubAgentPrompt,
  buildSynthesisPrompt,
  summarizeDraft
} = require('./prompts');
const { parsePlanOutput } = require('./plan-parser');

function nowMs() {
  return Date.now();
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || 0),
    total_tokens: Number(
      usage.total_tokens ||
      (Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0))
    )
  };
}

function mergeUsage(total, current) {
  const normalized = normalizeUsage(current);
  total.prompt_tokens += normalized.prompt_tokens;
  total.completion_tokens += normalized.completion_tokens;
  total.total_tokens += normalized.total_tokens;
}

function normalizeHistory(messages = [], max = 6) {
  return (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-max)
    .map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')
    }));
}

function buildRoleSummary(tasks = []) {
  const set = new Set(tasks.map((t) => t.role));
  set.add('planner');
  set.add('synthesizer');
  set.add('verifier');
  return Array.from(set);
}

function buildFallbackTasks(userMessage) {
  return [
    {
      agent_id: 1,
      role: 'planner',
      task: 'Decompose the question into a concrete execution structure and key decision criteria.',
      output_hint: 'Return structured plan, constraints, and evaluation dimensions.'
    },
    {
      agent_id: 2,
      role: 'researcher',
      task: 'Collect latest factual points and source-backed evidence relevant to the question.',
      output_hint: 'List key facts with concise evidence notes.'
    },
    {
      agent_id: 3,
      role: 'synthesizer',
      task: 'Build a coherent candidate answer from plan + evidence with practical next steps.',
      output_hint: 'Return concise structured draft with conclusions first.'
    },
    {
      agent_id: 4,
      role: 'verifier',
      task: `Challenge the candidate answer for risks, contradictions, and uncertainty around: ${String(userMessage || '').slice(0, 90)}`,
      output_hint: 'Return risk list, contradiction checks, and confidence notes.'
    }
  ];
}

function ensureTaskCount(tasks = [], requiredCount = 4, userMessage = '') {
  const safeRequired = Math.max(1, Math.min(Number(requiredCount || 0), 4));
  const normalized = Array.isArray(tasks) ? tasks.slice(0, safeRequired) : [];
  const usedIds = new Set(normalized.map((t, idx) => Number(t.agent_id || idx + 1)));
  const template = buildFallbackTasks(userMessage);

  let ptr = 0;
  while (normalized.length < safeRequired && ptr < template.length) {
    const candidate = { ...template[ptr] };
    ptr += 1;
    if (usedIds.has(candidate.agent_id)) continue;
    usedIds.add(candidate.agent_id);
    normalized.push(candidate);
  }

  while (normalized.length < safeRequired) {
    const agentId = normalized.length + 1;
    normalized.push({
      agent_id: agentId,
      role: 'custom',
      task: `Analyze from a complementary angle #${agentId}.`,
      output_hint: 'Return concise findings and implications.'
    });
  }
  return normalized;
}

async function runAgentPipeline(options) {
  const {
    userMessage,
    historyMessages = [],
    internetMode = false,
    thinkingMode = false,
    qualityProfile = 'high',
    maxSubAgents = 4,
    maxRetries = 2,
    forceSubAgentCount = 0,
    traceLevel = 'full',
    emitEvent,
    onContent,
    onReasoning,
    callPlanner,
    callSubAgent,
    streamSynthesis,
    runVerifier,
    buildConservativeFallbackNote
  } = options;

  const stageDurations = {};
  const subAgentDurations = {};
  const tokenUsageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const history = normalizeHistory(historyMessages, 6);
  let retriesUsed = 0;

  emitEvent({
    type: 'agent_status',
    role: 'master',
    scope: 'stage',
    stepId: 'master',
    status: 'start',
    detail: 'Starting multi-agent pipeline'
  });

  // Stage A: planner
  const plannerStart = nowMs();
  emitEvent({
    type: 'agent_status',
    role: 'planner',
    scope: 'stage',
    stepId: 'planner',
    status: 'running',
    detail: 'Planning task decomposition'
  });

  let plannerPlan;
  try {
    const plannerPrompt = buildPlannerPrompt(maxSubAgents);
    const plannerResult = await callPlanner({
      plannerPrompt,
      userMessage,
      historyMessages: history,
      thinkingMode
    });
    mergeUsage(tokenUsageTotal, plannerResult.usage);
    plannerPlan = parsePlanOutput(plannerResult.content, { maxSubAgents, userMessage });
  } catch (error) {
    emitEvent({
      type: 'agent_status',
      role: 'planner',
      scope: 'stage',
      stepId: 'planner',
      status: 'failed',
      detail: `Planner failed, using default plan: ${error.message}`
    });
    plannerPlan = parsePlanOutput('', { maxSubAgents, userMessage });
  }

  stageDurations.planner = nowMs() - plannerStart;
  emitEvent({
    type: 'agent_status',
    role: 'planner',
    scope: 'stage',
    stepId: 'planner',
    status: 'done',
    durationMs: stageDurations.planner,
    detail: `Planner done (complexity=${plannerPlan.complexity})`
  });

  const desiredSubAgentCount = forceSubAgentCount > 0
    ? Math.max(1, Math.min(forceSubAgentCount, maxSubAgents))
    : 0;
  const tasks = desiredSubAgentCount > 0
    ? ensureTaskCount(plannerPlan.tasks, desiredSubAgentCount, userMessage)
    : (Array.isArray(plannerPlan.tasks) ? plannerPlan.tasks.slice(0, maxSubAgents) : []);
  emitEvent({
    type: 'agent_plan',
    policy: 'dynamic-1-4',
    qualityProfile,
    maxRetries,
    fingerprint: {
      complexity: plannerPlan.complexity,
      freshnessNeed: internetMode,
      uncertainty: plannerPlan.complexity === 'complex' ? 0.6 : plannerPlan.complexity === 'medium' ? 0.35 : 0.1
    },
    selectedAgents: buildRoleSummary(tasks),
    plan: {
      summary: plannerPlan.user_intent,
      goals: tasks.map((t) => t.task).slice(0, 4),
      selectedAgents: buildRoleSummary(tasks)
    },
    tasks
  });

  if (desiredSubAgentCount === 0 && plannerPlan.complexity === 'simple' && plannerPlan.direct_answer) {
    const simpleAnswer = plannerPlan.direct_answer;
    onContent(simpleAnswer);
    emitEvent({
      type: 'agent_metrics',
      stageDurations: {
        planner: stageDurations.planner,
        sub_agents: 0,
        synthesis: 0,
        quality: 0
      },
      subAgentDurations: {},
      tokenUsageTotal
    });
    emitEvent({
      type: 'agent_status',
      role: 'master',
      scope: 'stage',
      stepId: 'master',
      status: 'done',
      detail: 'Direct answer path completed'
    });
    return {
      content: simpleAnswer,
      reasoningContent: '',
      sources: [],
      retriesUsed,
      stageDurations,
      subAgentDurations,
      tokenUsageTotal
    };
  }

  // Stage B: parallel sub-agents
  const subStart = nowMs();
  emitEvent({
    type: 'agent_status',
    role: 'researcher',
    scope: 'stage',
    stepId: 'sub_agents',
    status: 'running',
    detail: `Running ${tasks.length} sub-agents in parallel`
  });

  const taskPromises = tasks.map(async (task, idx) => {
    const taskId = task.agent_id || idx + 1;
    const stepId = `task-${taskId}`;
    const taskStarted = nowMs();

    emitEvent({
      type: 'agent_status',
      role: task.role,
      scope: 'task',
      stepId,
      taskId,
      status: 'start',
      detail: task.task
    });

    const subPrompt = buildSubAgentPrompt(task, userMessage);
    const subResult = await callSubAgent({
      task,
      subPrompt,
      userMessage,
      historyMessages: history,
      internetMode,
      thinkingMode
    });

    const durationMs = nowMs() - taskStarted;
    subAgentDurations[stepId] = durationMs;
    mergeUsage(tokenUsageTotal, subResult.usage);
    const summary = summarizeDraft(subResult.content, 80);

    emitEvent({
      type: 'agent_status',
      role: task.role,
      scope: 'task',
      stepId,
      taskId,
      status: 'done',
      durationMs,
      detail: `Completed (search=${subResult.searchCount || 0})`
    });

    emitEvent({
      type: 'agent_draft',
      stepId,
      taskId,
      role: task.role,
      task: task.task,
      summary,
      content: traceLevel === 'full' ? subResult.content : '',
      usage: normalizeUsage(subResult.usage),
      searchCount: Number(subResult.searchCount || 0)
    });

    return {
      stepId,
      taskId,
      role: task.role,
      task: task.task,
      output_hint: task.output_hint,
      summary,
      content: subResult.content,
      usage: normalizeUsage(subResult.usage),
      searchCount: Number(subResult.searchCount || 0),
      sources: Array.isArray(subResult.sources) ? subResult.sources : []
    };
  });

  const settled = await Promise.allSettled(taskPromises);
  const drafts = [];
  const subSources = [];
  settled.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
      drafts.push(result.value);
      if (Array.isArray(result.value.sources)) subSources.push(...result.value.sources);
    } else {
      const task = tasks[idx];
      emitEvent({
        type: 'agent_status',
        role: task.role || 'custom',
        scope: 'task',
        stepId: `task-${task.agent_id || idx + 1}`,
        taskId: task.agent_id || idx + 1,
        status: 'failed',
        detail: result.reason.message || 'Sub-agent failed'
      });
    }
  });

  stageDurations.sub_agents = nowMs() - subStart;
  emitEvent({
    type: 'agent_status',
    role: 'researcher',
    scope: 'stage',
    stepId: 'sub_agents',
    status: drafts.length > 0 ? 'done' : 'failed',
    durationMs: stageDurations.sub_agents,
    detail: `Sub-agents done ${drafts.length}/${tasks.length}`
  });

  if (drafts.length === 0) {
    throw new Error('ALL_SUBAGENTS_FAILED');
  }

  // Stage C: synthesis stream
  const synthStart = nowMs();
  emitEvent({
    type: 'agent_status',
    role: 'synthesizer',
    scope: 'stage',
    stepId: 'synthesis',
    status: 'running',
    detail: 'Synthesizing drafts with streaming output'
  });

  const synthPrompt = buildSynthesisPrompt({
    userMessage,
    userIntent: plannerPlan.user_intent,
    drafts
  });

  const synthResult = await streamSynthesis({
    synthPrompt,
    userMessage,
    drafts,
    historyMessages: history,
    onContent,
    onReasoning,
    internetMode,
    thinkingMode
  });
  mergeUsage(tokenUsageTotal, synthResult.usage);

  stageDurations.synthesis = nowMs() - synthStart;
  emitEvent({
    type: 'agent_status',
    role: 'synthesizer',
    scope: 'stage',
    stepId: 'synthesis',
    status: 'done',
    durationMs: stageDurations.synthesis,
    detail: 'Synthesis completed'
  });

  // Stage D: quality gate
  const qualityStart = nowMs();
  emitEvent({
    type: 'agent_status',
    role: 'verifier',
    scope: 'stage',
    stepId: 'quality',
    status: 'running',
    detail: 'Running quality gate'
  });

  const mergedSources = [...subSources, ...(synthResult.sources || [])];
  const quality = runVerifier({
    qualityProfile,
    content: synthResult.content,
    sources: mergedSources,
    fingerprint: {
      freshnessNeed: internetMode,
      complexityScore: plannerPlan.complexity === 'complex' ? 0.8 : plannerPlan.complexity === 'medium' ? 0.5 : 0.2
    }
  });

  emitEvent({
    type: 'agent_quality',
    pass: quality.pass,
    profile: qualityProfile,
    metrics: quality.metrics,
    thresholds: quality.thresholds,
    round: retriesUsed
  });

  let finalContent = synthResult.content;
  if (!quality.pass) {
    retriesUsed = Math.min(maxRetries, 1);
    emitEvent({
      type: 'agent_retry',
      round: retriesUsed,
      reason: `coverage=${quality.metrics.claimCoverage}, contradictions=${quality.metrics.contradictionCount}, sourceQuality=${quality.metrics.sourceQualityScore}`,
      action: 'degrade_to_conservative'
    });
    const note = buildConservativeFallbackNote({ freshnessNeed: internetMode }) || '';
    if (note) {
      onContent(note);
      finalContent += note;
    }
  }

  stageDurations.quality = nowMs() - qualityStart;
  emitEvent({
    type: 'agent_status',
    role: 'verifier',
    scope: 'stage',
    stepId: 'quality',
    status: 'done',
    durationMs: stageDurations.quality,
    detail: quality.pass ? 'Quality gate passed' : 'Quality gate failed, conservative degradation applied'
  });

  emitEvent({
    type: 'agent_metrics',
    stageDurations,
    subAgentDurations,
    tokenUsageTotal
  });

  emitEvent({
    type: 'agent_status',
    role: 'master',
    scope: 'stage',
    stepId: 'master',
    status: 'done',
    detail: `Agent pipeline completed (retries=${retriesUsed})`
  });

  return {
    content: finalContent,
    reasoningContent: synthResult.reasoningContent || '',
    sources: mergedSources,
    retriesUsed,
    stageDurations,
    subAgentDurations,
    tokenUsageTotal
  };
}

module.exports = {
  runAgentPipeline,
  normalizeUsage
};
