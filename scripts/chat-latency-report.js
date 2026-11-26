'use strict';

// journalctl -u rai --since '7 days ago' -o cat -g '"event":"chat_latency"' | node scripts/chat-latency-report.js
const readline = require('node:readline');
const { model } = require('../lib/diagnostic-trace');
const { PROVIDERS, CALL_PHASES } = require('../lib/chat-latency');

function distribution(samples) {
    samples.sort((a, b) => a - b);
    const percentile = p => samples[Math.ceil(samples.length * p) - 1] ?? null;
    return { n: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}

function add(samples, ms) {
    if (Number.isFinite(ms) && ms >= 0) samples.push(ms);
}

async function report(lines) {
    const requests = new Map(), attempts = new Map();
    for await (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.event !== 'chat_latency' || !row.stages || !Array.isArray(row.attempts)) continue;
        const key = model(row.model);
        if (!requests.has(key)) requests.set(key, { requests: 0, firstContent: [], beforeFirstUpstream: [], toolWait: [], withoutContent: 0 });
        const group = requests.get(key);
        group.requests++;
        const first = row.stages.first_content_write;
        const firstAttempt = row.attempts.find(a => Number.isFinite(a?.started));
        if (firstAttempt) add(group.beforeFirstUpstream, firstAttempt.started);
        if (Number.isFinite(first)) {
            add(group.firstContent, first);
            add(group.toolWait, row.toolWaitBeforeContentMs);
        } else group.withoutContent++;
        for (const a of row.attempts) {
            if (!a || !Number.isFinite(a.started) || (Number.isFinite(first) && a.started > first)) continue;
            const phase = CALL_PHASES.has(a.phase) ? a.phase : 'unclassified';
            const provider = PROVIDERS.has(a.provider) ? a.provider : 'other';
            const id = [key, model(a.model), provider, phase, a.fallback ? 'fallback' : 'initial'].join('/');
            if (!attempts.has(id)) attempts.set(id, { count: 0, http5xx: 0, cancelled: 0, firstContent: [], firstTool: [] });
            const bucket = attempts.get(id);
            bucket.count++;
            if (a.status >= 500 && a.status < 600) bucket.http5xx++;
            if (Number.isFinite(a.cancelled)) bucket.cancelled++;
            add(bucket.firstContent, a.first_content - a.started);
            add(bucket.firstTool, a.first_tool - a.started);
        }
    }
    function summarize(groups) {
        return Object.fromEntries([...groups].map(([key, values]) => [key, Object.fromEntries(
            Object.entries(values).map(([name, value]) => [name, Array.isArray(value) ? distribution(value) : value])
        )]));
    }
    return { byRequestedModel: summarize(requests), upstreamAttemptsStartingBeforeFirstContent: summarize(attempts) };
}

if (require.main === module) {
    report(readline.createInterface({ input: process.stdin, crlfDelay: Infinity }))
        .then(summary => console.log(JSON.stringify(summary, null, 2)))
        .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { report };
