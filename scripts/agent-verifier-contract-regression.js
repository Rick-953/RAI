'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const engineSource = fs.readFileSync(path.join(ROOT, 'agent', 'engine.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const readmeEnglish = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const readmeChinese = fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8');
const { runAgentPipeline } = require('../agent/engine');

assert.match(
  serverSource,
  /reviewKind:\s*'heuristic_quality_review',[\s\S]{0,100}independentFactVerification:\s*false/,
  'the server quality gate must identify itself as heuristic and non-independent'
);
assert.doesNotMatch(
  serverSource,
  /independentFactVerification:\s*true/,
  'no server agent-quality event may claim independent fact verification'
);
assert.match(
  engineSource,
  /detail:\s*'Running heuristic quality review \(not independent fact verification\)'/,
  'the managed pipeline must disclose its verification boundary before review'
);
assert.match(
  engineSource,
  /reviewKind:\s*'heuristic_quality_review',[\s\S]{0,100}independentFactVerification:\s*false/,
  'the managed pipeline event contract must fail closed to heuristic review'
);
assert.match(
  appSource,
  /verifier:\s*'启发式质量复核'/,
  'the Chinese UI must not label the heuristic reviewer as a fact verifier'
);
assert.match(
  appSource,
  /verifier:\s*'Heuristic Quality Review'/,
  'the English UI must not label the heuristic reviewer as a fact verifier'
);
assert.match(
  appSource,
  /启发式质量复核通过（不代表事实已被独立证实）/,
  'the Chinese quality result must preserve the non-independent disclaimer'
);
assert.match(
  appSource,
  /Heuristic quality review passed \(not independent fact verification\)/,
  'the English quality result must preserve the non-independent disclaimer'
);
assert.match(
  appSource,
  /模型共识复核，不构成独立事实验证/,
  'the Chinese model-consensus UI must disclose that it is not independent verification'
);
assert.match(
  appSource,
  /model consensus review, not independent fact verification/,
  'the English model-consensus UI must disclose that it is not independent verification'
);
assert.match(
  readmeEnglish,
  /heuristic quality review\. That review is not independent fact verification\./,
  'the English product documentation must state the verifier boundary'
);
assert.match(
  readmeChinese,
  /启发式质量复核；该复核不构成独立事实验证。/,
  'the Chinese product documentation must state the verifier boundary'
);

async function exerciseManagedPipelineContract() {
  const events = [];
  await runAgentPipeline({
    userMessage: 'Check one claim.',
    maxSubAgents: 1,
    forceSubAgentCount: 1,
    emitEvent: (event) => events.push(event),
    onContent: () => {},
    onReasoning: () => {},
    callPlanner: async () => ({
      content: JSON.stringify({
        complexity: 'medium',
        user_intent: 'Check one claim.',
        direct_answer: null,
        tasks: [{ agent_id: 1, role: 'verifier', task: 'Review the claim.', output_hint: 'Return risks.' }]
      }),
      usage: {}
    }),
    callSubAgent: async () => ({ content: 'A heuristic critique.', sources: [], usage: {} }),
    streamSynthesis: async () => ({ content: 'A candidate answer.', reasoningContent: '', sources: [], usage: {} }),
    // Simulate an overclaiming injected checker. The public pipeline boundary
    // must still refuse to emit an independent-verification claim.
    runVerifier: () => ({
      pass: true,
      reviewKind: 'independent_fact_verification',
      independentFactVerification: true,
      metrics: { claimCoverage: 1, contradictionCount: 0, sourceQualityScore: 1 },
      thresholds: { claimCoverage: 0.8, sourceQuality: 0.55 }
    }),
    buildConservativeFallbackNote: () => ''
  });

  const qualityEvents = events.filter((event) => event?.type === 'agent_quality');
  assert.equal(qualityEvents.length, 1, 'managed pipeline must emit one quality result');
  assert.equal(qualityEvents[0].reviewKind, 'heuristic_quality_review');
  assert.equal(qualityEvents[0].independentFactVerification, false);
  const verifierStatuses = events.filter((event) => event?.type === 'agent_status' && event?.role === 'verifier');
  assert.ok(
    verifierStatuses.some((event) => /not independent|not independently verified/i.test(String(event.detail || ''))),
    'managed pipeline status must disclose the non-independent boundary'
  );
}

exerciseManagedPipelineContract()
  .then(() => console.log('agent-verifier-contract-regression ok'))
  .catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
