'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function check(condition, message) {
  if (!condition) failures.push(message);
}

function countMatches(source, pattern) {
  return Array.from(source.matchAll(pattern)).length;
}

function parseCsp(value) {
  const directives = new Map();
  for (const rawDirective of String(value || '').split(';')) {
    const tokens = rawDirective.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) directives.set(tokens[0].toLowerCase(), tokens.slice(1));
  }
  return directives;
}

const indexHtml = read('public/index.html');
const appJs = read('public/app.js');
const selectionJs = read('public/selection-explainer.js');
const bindingsJs = read('public/event-bindings.js');
const runtimeBrandJs = read('public/runtime-brand.js');
const serviceWorkerJs = read('public/sw.js');
const tauriConfig = JSON.parse(read('src-tauri/tauri.conf.json'));

const firstPartyJavascript = new Map([
  ['public/app.js', appJs],
  ['public/selection-explainer.js', selectionJs],
  ['public/event-bindings.js', bindingsJs],
  ['public/runtime-brand.js', runtimeBrandJs],
  ['public/sw.js', serviceWorkerJs]
]);

// HTML must contain external scripts only. Event-handler attributes are blocked explicitly,
// but they are also removed so behavior cannot silently depend on a browser CSP violation.
check(!/<script\b(?![^>]*\bsrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/i.test(indexHtml), 'index.html contains an inline script block');
check(!/\son[a-z][a-z0-9_-]*\s*=/i.test(indexHtml), 'index.html contains an inline event-handler attribute');
check(!/(?:href|src)\s*=\s*["']\s*javascript:/i.test(indexHtml), 'index.html contains a javascript: URL');

for (const [relativePath, source] of firstPartyJavascript) {
  check(!/\bon[a-z][a-z0-9_-]*\s*=/.test(source), `${relativePath} emits an inline event-handler attribute`);
  check(!/\.on[a-z][a-z0-9_-]*\s*=/.test(source), `${relativePath} assigns an event-handler property instead of using addEventListener`);
  check(!/\b(?:eval|Function)\s*\(/.test(source), `${relativePath} contains a dynamic JavaScript compiler`);
  check(!/\bnew\s+Function\s*\(/.test(source), `${relativePath} constructs JavaScript from text`);
  check(!/\bset(?:Timeout|Interval)\s*\(\s*["']/.test(source), `${relativePath} uses a string timer`);
  check(!/(?:href|src)\s*=\\?["'][^"']*javascript:/i.test(source), `${relativePath} emits a javascript: URL`);
}

check(/ALLOW_DATA_ATTR:\s*false/.test(appJs), 'untrusted Markdown may retain arbitrary data-* action attributes');
check(!/ALLOWED_ATTR:\s*\[[^\]]*data-rai-(?:click|input|change|keydown|keyup|submit|compositionstart|compositionend|mouseenter|mouseleave|binding-token)/s.test(appJs), 'untrusted Markdown explicitly allows data-rai-* action attributes');
check(/ADD_URI_SAFE_ATTR:\s*\[[^\]]*data-mermaid-code[^\]]*data-src[^\]]*\]/s.test(appJs), 'trusted Markdown data attributes are not explicitly exempted from URI filtering');
check(/ADD_URI_SAFE_ATTR:\s*\[[^\]]*data-rai-latex[^\]]*data-rai-math-display[^\]]*\]/s.test(appJs), 'trusted math metadata is not preserved safely');
const dynamicBindingCount = countMatches(appJs, /data-rai-(?:click|input|change|keydown|keyup|submit|compositionstart|compositionend|mouseenter|mouseleave)=/g);
const dynamicTokenCount = countMatches(appJs, /data-rai-binding-token="\$\{RAI_EVENT_BINDING_TOKEN\}"/g);
check(dynamicBindingCount === dynamicTokenCount, `dynamic actions are not all capability-bound (${dynamicBindingCount} actions, ${dynamicTokenCount} tokens)`);
check(/removeAttribute\('data-rai-binding-token'\)/.test(bindingsJs), 'dynamic action capability tokens remain exposed in the DOM');

const scriptSources = Array.from(indexHtml.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi))
  .map((match) => match[1].replace(/[?#].*$/, ''));
const localScriptSources = scriptSources.filter((source) => !/^\/?runtime-config\.js$/.test(source));
for (const source of localScriptSources) {
  const relativePath = path.posix.join('public', source.replace(/^\//, ''));
  const absolutePath = path.join(root, relativePath);
  check(fs.existsSync(absolutePath), `script source is missing: ${relativePath}`);
  if (!fs.existsSync(absolutePath)) continue;
  const script = fs.readFileSync(absolutePath, 'utf8');
  check(!/\b(?:eval|Function)\s*\(/.test(script), `${relativePath} requires unsafe dynamic compilation`);
  check(!/\bnew\s+Function\s*\(/.test(script), `${relativePath} constructs JavaScript from text`);
  check(!/\bset(?:Timeout|Interval)\s*\(\s*["']/.test(script), `${relativePath} uses a string timer`);
}

const bindingsPosition = scriptSources.findIndex((source) => source.includes('event-bindings.js'));
const appPosition = scriptSources.findIndex((source) => source.includes('app.js'));
check(bindingsPosition >= 0, 'event-bindings.js is not loaded');
check(appPosition >= 0, 'app.js is not loaded');
check(bindingsPosition >= 0 && appPosition >= 0 && bindingsPosition < appPosition, 'event-bindings.js must load before app.js');

const eventNames = new Set([
  'click', 'input', 'change', 'keydown', 'keyup', 'submit',
  'compositionstart', 'compositionend', 'mouseenter', 'mouseleave'
]);
const bindingPattern = /data-rai-([a-z]+)=\\?"([^"]*)"/g;
const allowedActionBlock = /const ALLOWED_ACTIONS = new Set\(\[([\s\S]*?)\]\);/.exec(bindingsJs);
check(Boolean(allowedActionBlock), 'event action allowlist is missing');
const allowedActions = new Set(
  allowedActionBlock
    ? Array.from(allowedActionBlock[1].matchAll(/'([A-Za-z_$][\w$]*)'/g), (match) => match[1])
    : []
);

function verifyDeclarativeBindings(relativePath, source, minimumExpected) {
  let count = 0;
  for (const match of source.matchAll(bindingPattern)) {
    if (!eventNames.has(match[1])) continue;
    count += 1;
    const expression = match[2].trim();
    check(Boolean(expression), `${relativePath} has an empty data-rai-${match[1]} binding`);
    for (const rawStatement of expression.split(';')) {
      let statement = rawStatement.trim();
      if (!statement) continue;
      if (statement === 'event.stopPropagation()' || /^this\.classList\.toggle\((?:'expanded'|"expanded")\)$/.test(statement)) continue;
      statement = statement.replace(/^if\s*\([^)]*\)\s*/, '');
      const actionMatch = /^([A-Za-z_$][\w$]*)\s*\(/.exec(statement);
      check(Boolean(actionMatch), `${relativePath} has an unsupported declarative binding: ${expression}`);
      if (actionMatch) check(allowedActions.has(actionMatch[1]), `${relativePath} calls a non-allowlisted action: ${actionMatch[1]}`);
    }
  }
  check(count >= minimumExpected, `${relativePath} unexpectedly has only ${count} declarative bindings`);
  return count;
}

// ChatFlow now reuses the normal conversation composer, removing its duplicated
// declarative controls while keeping the unified canvas actions in the shared UI.
const staticIndexBindingCount = verifyDeclarativeBindings('public/index.html', indexHtml, 171);
check(staticIndexBindingCount === 171, `public/index.html binding baseline changed unexpectedly (${staticIndexBindingCount} != 171)`);
verifyDeclarativeBindings('public/app.js', appJs, 70);

// Exercise the production parser itself in a DOM-free VM. App template expressions are
// materialized with inert representative IDs before compilation, so the test covers the
// compound calls, event/element placeholders, key guards, and object literal options that
// are emitted at runtime.
const parserContext = {
  console: { error() {}, warn() {}, log() {} },
  Element: class Element {},
  HTMLImageElement: class HTMLImageElement {},
  Node: { ELEMENT_NODE: 1 },
  MutationObserver: class MutationObserver { observe() {} },
  document: {
    body: null,
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return {}; }
  }
};
parserContext.globalThis = parserContext;
const instrumentedBindings = bindingsJs.replace(
  '  bindSubtree(document);',
  '  globalThis.__compileRaiBindingForTest = compileBinding;\n  bindSubtree(document);'
);
vm.runInNewContext(instrumentedBindings, parserContext, { filename: 'public/event-bindings.js' });
check(typeof parserContext.__compileRaiBindingForTest === 'function', 'could not instrument the production event parser');

function materializeTemplateBinding(expression) {
  return expression.replace(/\$\{[^}]*\}/g, (placeholder, offset, source) => {
    const before = source[offset - 1];
    const after = source[offset + placeholder.length];
    return before === '\'' && after === '\'' ? 'fixture' : '1';
  });
}

if (typeof parserContext.__compileRaiBindingForTest === 'function') {
  for (const [relativePath, source] of [['public/index.html', indexHtml], ['public/app.js', appJs]]) {
    for (const match of source.matchAll(bindingPattern)) {
      if (!eventNames.has(match[1])) continue;
      const expression = materializeTemplateBinding(match[2]);
      try {
        parserContext.__compileRaiBindingForTest(expression);
      } catch (error) {
        failures.push(`${relativePath} binding cannot be compiled safely: ${expression} (${error.message})`);
      }
    }
  }
}

const tauriCsp = tauriConfig?.app?.security?.csp;
const directives = parseCsp(tauriCsp);
const scriptSrc = directives.get('script-src') || [];
const scriptSrcAttr = directives.get('script-src-attr') || [];
const connectSrc = directives.get('connect-src') || [];
const workerSrc = directives.get('worker-src') || [];

check(scriptSrc.includes("'self'"), "Tauri script-src must allow only packaged same-origin scripts");
check(!scriptSrc.includes("'unsafe-inline'"), "Tauri script-src still allows inline JavaScript");
check(!scriptSrc.includes("'unsafe-eval'"), "Tauri script-src still allows dynamic JavaScript compilation");
check(!scriptSrc.includes('blob:') && !scriptSrc.includes('data:'), 'Tauri script-src allows executable blob/data URLs');
check(scriptSrcAttr.length === 1 && scriptSrcAttr[0] === "'none'", "Tauri must set script-src-attr 'none'");
check(!connectSrc.includes('https:'), 'Tauri connect-src still allows every HTTPS origin');
check(!workerSrc.includes('blob:') && !workerSrc.includes('data:'), 'Tauri worker-src allows blob/data workers');

for (const [directive, values] of directives) {
  if (directive !== 'style-src') {
    check(!values.includes("'unsafe-inline'"), `${directive} unexpectedly contains unsafe-inline`);
  }
  check(!values.includes("'unsafe-eval'"), `${directive} unexpectedly contains unsafe-eval`);
}

if (failures.length > 0) {
  console.error(`csp-static-regression failed (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`csp-static-regression ok (scripts=${localScriptSources.length}, static-bindings=${countMatches(indexHtml, /data-rai-(?:click|input|change|keydown|keyup|submit|compositionstart|compositionend|mouseenter|mouseleave)=/g)})`);
console.log("csp-style-note: style-src retains unsafe-inline temporarily for legacy CSSOM/SVG compatibility; script-src is strict");
