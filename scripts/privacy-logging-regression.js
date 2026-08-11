'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const agentEngine = fs.readFileSync(path.join(root, 'agent', 'engine.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
const vendorManifest = fs.readFileSync(path.join(root, 'public', 'lib', 'vendor-manifest.json'), 'utf8');
const parser = fs.readFileSync(path.join(root, 'lib', 'document-parser.js'), 'utf8');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const privacyLogSource = fs.readFileSync(path.join(root, 'lib', 'privacy-log.js'), 'utf8');
const {
  createPrivacyLog
} = require('../lib/privacy-log');
const { createRuntimeReportWriter } = require('../lib/runtime-report-writer');

const forbiddenServerPatterns = [
  /console\.error\(['"]原始响应:['"],\s*data\)/,
  /console\.log\(`[^`]*\$\{userContent\.substring/,
  /args=\$\{JSON\.stringify\(memoryDeleteToolArgs\)\}/,
  /attachments\.map\([^\n]*fileName/,
  /无法解析工具参数\(JSON\)[^\n]*argumentText\s*\)/,
  /会话标题[^\n]*"\$\{(?:directTitle|fallbackTitle|trimmedTitle)\}"/,
  /finance_quote[^\n]*symbol=\$\{(?:args\.symbol|rawSymbol|result\?\.resolvedSymbol)/,
  /Username:['"\s,]+profile\.username/,
  /console\.(?:warn|error|log)\([^\n]*\$\{(?:tierErr|pointsErr|fallbackErr|updateErr|error)\.message\}/
];

for (const pattern of forbiddenServerPatterns) {
  assert.ok(!pattern.test(server), `privacy-sensitive stdout pattern returned: ${pattern}`);
}

for (const pattern of [
  /chatFlowCanvasContext\.substring\(/,
  /selection\.substring\(/,
  /KaTeX render error for:/,
  /会话标题已更新:\s*"\$\{parsed\.title\}"/,
  /currentSources\.map\(s => s\.title\)/,
  /console\.(?:log|debug|info|warn|error)\([^\n]*file\.name/,
  /console\.(?:log|debug|info|warn|error)\([^\n]*currentAttachment\.fileName/,
  /显示邮箱:['"\s,]+realEmail/,
  /检测到新标题:[^\n]*\$\{newTitle\}/,
  /\bpreview\s*[,}]/,
  /console\.log\([^\n]*(?:message\.id|foundMsg\.id|msgWithId\.id|flow\.id|flowId|nodeId|edgeId|sessionId|userMembershipState)/,
  /console\.log\([^\n]*\{[^\n]*(?:messageId|spaceId)\s*:/
]) {
  assert.ok(!pattern.test(app), `privacy-sensitive browser console pattern returned: ${pattern}`);
}

assert.match(
  app,
  /console\.log\('\s*消息包含附件',[\s\S]{0,180}filenameLength:[\s\S]{0,100}bytes:/,
  'attachment diagnostics must retain only bounded aggregate metadata'
);
assert.match(
  app,
  /console\.log\('\s*文件已上传',[\s\S]{0,160}filenameLength:[\s\S]{0,100}bytes:/,
  'upload diagnostics must retain only bounded aggregate metadata'
);

assert.match(server, /require\('\.\/lib\/privacy-log'\)/);
assert.match(server, /formatPrivateLogFingerprint\(userContent, 'content'\)/);
assert.match(server, /formatPrivateLogFingerprint\(data, 'body'\)/);
assert.match(server, /formatPrivateLogFingerprint\(profile\.username, 'username'\)/);
assert.equal((server.match(/formatPrivateLogFingerprint\(queryText, 'query'\)/g) || []).length, 2);
assert.match(server, /formatPrivateLogFingerprint\(err\.field \|\| '', 'field'\)/);
assert.match(server, /formatPrivateLogFingerprint\(normalizedCurrentEmail\.split\('@'\)\[1\] \|\| '', 'currentDomain'\)/);
assert.doesNotMatch(server, /crypto\.createHash\('sha256'\)\.update\(queryText\)/);
assert.doesNotMatch(server, /crypto\.createHash\('sha256'\)\.update\(String\(row\.email\)\)/);
assert.doesNotMatch(server, /群发失败:\s*['"]?\s*\+\s*error\.message/);
assert.doesNotMatch(server, /failures\.push\([^\n]*error:\s*String\(error\.message/);
assert.doesNotMatch(server, /选词解释(?:请求)?失败:',\s*error\)/);
assert.doesNotMatch(server, /currentDomain=\$\{normalizedCurrentEmail/);
assert.doesNotMatch(server, /pendingDomain=\$\{normalizedEmail/);
assert.doesNotMatch(server, /previousError\?\.message/);
assert.doesNotMatch(server, /canvasPatchParseError:\s*error\.message/);
assert.doesNotMatch(server, /API响应状态:[^\n]*statusText/);
assert.doesNotMatch(server, /流式事件错误[^\n]*\$\{errMessage\}/);
assert.doesNotMatch(server, /解析响应行错误:',\s*e\.message/);
assert.doesNotMatch(server, /记忆提取 JSON 解析失败:',\s*error\.message/);
assert.doesNotMatch(server, /error:\s*error\.code \|\| 'ztx6d_create_rt_failed'/);
assert.doesNotMatch(server, /detail:\s*result\.reason\.message/);
assert.doesNotMatch(agentEngine, /(?:error|reason)\.message/);
assert.doesNotMatch(server, /console\.warn\(` 无效的(?:temperature|top_p|max_tokens)值:/);
assert.doesNotMatch(server, /parse(?:Float|Int)\((?:temperature|top_p|max_tokens)/);
assert.match(server, /function parseStrictBoundedNumber\(/);
assert.match(server, /summarizePrivateValue\(entry\.message \|\| '', 'message'\)/);
assert.match(server, /createRuntimeReportWriter\(RAI_RUNTIME_REPORT_PATH\)/);
assert.match(server, /const JWT_SECRET = requireSecretEnv\('JWT_SECRET', 32\);[\s\S]{0,240}createPrivacyLog\(\{ secret: JWT_SECRET \}\)/);
assert.doesNotMatch(server, /function maskReportString\(/);
assert.match(privacyLogSource, /crypto\.createHmac\('sha256', hmacKey\)/);
assert.match(privacyLogSource, /crypto\.hkdfSync\(/);
assert.doesNotMatch(privacyLogSource, /crypto\.createHash\(/);

const diagnostics = createPrivacyLog({ secret: 'fixed-regression-secret-material-00000000000000000001' });
const sameDiagnostics = createPrivacyLog({ secret: 'fixed-regression-secret-material-00000000000000000001' });
const otherDiagnostics = createPrivacyLog({ secret: 'different-regression-secret-material-000000000000000002' });

const privateExamples = {
  subject: 'private broadcast subject',
  error: 'upstream echoed user@example.test',
  nested: { note: 'private prompt fragment' },
  sourceUrl: 'https://example.test/image?signature=private',
  list: ['private list item'],
  provider: 'siliconflow',
  code: 'ETIMEDOUT',
  apiKey: 'sk-private-secret'
};
const sanitizedExamples = diagnostics.sanitizeReportContext(privateExamples);
const serializedExamples = JSON.stringify(sanitizedExamples);
for (const privateText of [
  privateExamples.subject,
  privateExamples.error,
  privateExamples.nested.note,
  privateExamples.sourceUrl,
  privateExamples.list[0],
  privateExamples.apiKey
]) {
  assert.ok(!serializedExamples.includes(privateText), `runtime report retained private text: ${privateText}`);
}
assert.ok(!serializedExamples.includes('siliconflow'));
assert.ok(!serializedExamples.includes('ETIMEDOUT'));
assert.ok(serializedExamples.includes('[redacted]'));
assert.ok(!serializedExamples.includes('apiKey'), 'secret field names must not be retained');
assert.ok(!serializedExamples.includes('subject'), 'unknown field names must be replaced');

const nestedAttack = diagnostics.sanitizeReportContext({
  payload: {
    PrivatePromptFragment: 'SENTINEL_PRIVATE_VALUE',
    'sk-private-key-name': 'SENTINEL_SECRET_VALUE'
  }
});
const nestedAttackText = JSON.stringify(nestedAttack);
for (const sentinel of ['PrivatePromptFragment', 'sk-private-key-name', 'SENTINEL_PRIVATE_VALUE', 'SENTINEL_SECRET_VALUE']) {
  assert.ok(!nestedAttackText.includes(sentinel), `untrusted key/value escaped report sanitizer: ${sentinel}`);
}

const globallyAllowedKeyAttack = {};
for (const key of [
  'cause', 'code', 'errorCode', 'errorName', 'method', 'mode', 'model', 'modelId',
  'provider', 'purpose', 'stage', 'status', 'tool', 'toolName', 'type'
]) {
  globallyAllowedKeyAttack[key] = `SENTINEL_${key}_PRIVATE_VALUE`;
}
const globallyAllowedKeyAttackText = JSON.stringify(diagnostics.sanitizeReportContext({
  args: globallyAllowedKeyAttack,
  payload: globallyAllowedKeyAttack
}));
for (const value of Object.values(globallyAllowedKeyAttack)) {
  assert.ok(!globallyAllowedKeyAttackText.includes(value), `known key leaked an untrusted string: ${value}`);
}

const cyclic = { note: 'SENTINEL_CYCLIC_VALUE' };
cyclic.self = cyclic;
Object.defineProperty(cyclic, 'dangerousGetter', {
  enumerable: true,
  get() { throw new Error('SENTINEL_GETTER_VALUE'); }
});
const cyclicText = JSON.stringify(diagnostics.sanitizeReportContext(cyclic));
assert.ok(!cyclicText.includes('SENTINEL_CYCLIC_VALUE'));
assert.ok(!cyclicText.includes('SENTINEL_GETTER_VALUE'));
assert.ok(cyclicText.includes('[circular]'));
assert.ok(cyclicText.includes('[accessor]'));

const privateError = new Error('SENTINEL_ERROR_MESSAGE https://example.test/?token=private');
privateError.partialContent = 'SENTINEL_PARTIAL_MODEL_ANSWER';
privateError.code = 'UPSTREAM_TIMEOUT';
const privateErrorText = JSON.stringify(diagnostics.sanitizeReportContext(privateError));
assert.ok(!privateErrorText.includes('SENTINEL_ERROR_MESSAGE'));
assert.ok(!privateErrorText.includes('SENTINEL_PARTIAL_MODEL_ANSWER'));
assert.ok(!privateErrorText.includes('example.test'));
assert.ok(!privateErrorText.includes('stack'));
assert.ok(!privateErrorText.includes('UPSTREAM_TIMEOUT'));

const messageSummary = diagnostics.summarizePrivateValue('short private message', 'message');
assert.equal(messageSummary.length, 21);
assert.equal(messageSummary.bytes, 21);
assert.match(messageSummary.hmacSha256, /^[a-f0-9]{32}$/);
const unicodeSummary = diagnostics.summarizePrivateValue('隐私🙂', 'message');
assert.equal(unicodeSummary.length, 3);
assert.equal(unicodeSummary.bytes, Buffer.byteLength('隐私🙂'));

const firstFingerprint = diagnostics.buildPrivateLogFingerprint('AAPL', 'symbol');
const secondFingerprint = sameDiagnostics.buildPrivateLogFingerprint('AAPL', 'symbol');
const otherKeyFingerprint = otherDiagnostics.buildPrivateLogFingerprint('AAPL', 'symbol');
const otherLabelFingerprint = diagnostics.buildPrivateLogFingerprint('AAPL', 'query');
assert.deepStrictEqual(firstFingerprint, secondFingerprint, 'derived log HMAC must remain deterministic for one secret and label');
assert.notEqual(firstFingerprint.hmacSha256, otherKeyFingerprint.hmacSha256, 'different secrets must unlink fingerprints');
assert.notEqual(firstFingerprint.hmacSha256, otherLabelFingerprint.hmacSha256, 'HMAC labels must be domain separated');
assert.notEqual(
  firstFingerprint.hmacSha256,
  crypto.createHash('sha256').update('AAPL').digest('hex').slice(0, 32),
  'private stdout must not use an unkeyed enumerable digest'
);
assert.match(server, /DOCUMENT_PARSER_FORCE_DISABLED[\s\S]{0,260}DOCUMENT_PARSER_ENABLED/);
assert.match(server, /resolveDocumentSandboxEnabled\(\{[\s\S]{0,240}sandboxAvailable:\s*isProductionDocumentSandboxAvailable\(\)/);
assert.match(server, /production_requires_totp_encryption_key_file/);
assert.match(server, /production_requires_refresh_token_pepper_file/);
assert.match(parser, /NODE_ENV \|\| ''\)\.toLowerCase\(\) === 'production'[\s\S]{0,120}productionSandboxCommand\(kind\)/);
assert.match(parser, /document_parser_sandbox_unavailable/);
assert.ok(!/ALLOWED_KINDS[^\n]*pdf/.test(parser), 'PDF must remain blocked until it has an OS sandbox without native addon bypass');
assert.match(envExample, /^RAI_DOCUMENT_PARSER_ENABLED=true$/m);
assert.match(envExample, /^RAI_DOCUMENT_PARSER_FORCE_DISABLED=false$/m);
assert.doesNotMatch(app, /searchParams\.get\(['"](?:rai_token|token)['"]\)/, 'access tokens must never be accepted from URL query parameters');
assert.match(app, /getSafeResponsePath\(response\)/);
assert.match(app, /bodyLength:\s*text\.length/);
assert.match(app, /searchParams\.has\('rai_token'\)[\s\S]{0,300}searchParams\.delete\('rai_token'\)/);
assert.doesNotMatch(index, /accept=[^>]*(?:\.pdf|\.doc(?!x)|\.xls(?!x)|\.ppt(?!x))/i, 'blocked legacy document formats must not be advertised by the file picker');
assert.doesNotMatch(app, /input\.accept[\s\S]{0,1200}(?:\.pdf|\.doc(?!x)|\.xls(?!x)|\.ppt(?!x))/i, 'blocked legacy document formats must not be advertised by the dynamic file picker');
assert.doesNotMatch(server, /读 PDF/);
assert.match(app, /const MERMAID_RENDERING_ENABLED = false;/, 'Mermaid execution must remain fail closed');
for (const [label, source] of [['index', index], ['service worker', serviceWorker], ['vendor manifest', vendorManifest]]) {
  assert.doesNotMatch(source, /lib\/mermaid\/mermaid\.min\.js/i, `${label} must not reference the removed Mermaid bundle`);
}
assert.ok(!fs.existsSync(path.join(root, 'public', 'lib', 'mermaid', 'mermaid.min.js')));

const staticAssetsMatch = serviceWorker.match(/const RAI_STATIC_ASSETS = \[([\s\S]*?)\](?:\.map\(appPath\))?;/);
assert.ok(staticAssetsMatch, 'service worker static asset manifest must be parseable');
const staticAssetUrls = [...staticAssetsMatch[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
for (const assetUrl of staticAssetUrls) {
  const pathname = assetUrl.split('?', 1)[0];
  const localPath = pathname === '' || pathname === '/'
    ? path.join(root, 'public', 'index.html')
    : path.join(root, 'public', pathname.replace(/^\/+/, ''));
  assert.ok(fs.existsSync(localPath), `service worker precache target is missing: ${assetUrl}`);
}

const downloadsDir = path.join(root, 'public', 'downloads');
const publicDmgs = fs.existsSync(downloadsDir)
  ? fs.readdirSync(downloadsDir).filter((name) => /\.dmg$/i.test(name))
  : [];
assert.deepStrictEqual(publicDmgs, [], 'obsolete unsigned DMG files must not remain publicly served');

async function testRuntimeReportWriter() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rai-private-report-test-'));
  try {
    const reportPath = path.join(tempRoot, 'runtime-report.md');
    const writer = createRuntimeReportWriter(reportPath, { maxBytes: 1024 });
    await writer('A'.repeat(700));
    assert.equal(fs.statSync(reportPath).mode & 0o777, 0o600, 'runtime report must be mode 0600');
    await writer('B'.repeat(700));
    assert.equal(fs.readFileSync(reportPath, 'utf8'), 'B'.repeat(700), 'runtime report must truncate at its size bound');

    const targetPath = path.join(tempRoot, 'target.md');
    fs.writeFileSync(targetPath, 'target', { mode: 0o600 });
    const symlinkPath = path.join(tempRoot, 'symlink-report.md');
    fs.symlinkSync(targetPath, symlinkPath);
    await assert.rejects(
      createRuntimeReportWriter(symlinkPath)('blocked'),
      /runtime_report_target_not_single_regular_file|ELOOP/
    );

    const hardlinkPath = path.join(tempRoot, 'hardlink-report.md');
    fs.linkSync(targetPath, hardlinkPath);
    await assert.rejects(
      createRuntimeReportWriter(hardlinkPath)('blocked'),
      /runtime_report_target_not_single_regular_file/
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

testRuntimeReportWriter()
  .then(() => {
    console.log(`privacy-logging-regression ok (forbidden=${forbiddenServerPatterns.length}, publicDmgs=${publicDmgs.length})`);
  })
  .catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
