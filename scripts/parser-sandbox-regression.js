'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const parser = fs.readFileSync(path.join(root, 'lib', 'document-parser.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'workers', 'document-parser-worker.js'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'scripts', 'rai-document-parser-sandbox.sh'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert.match(parser, /MAX_INPUT_BYTES = 20 \* 1024 \* 1024/);
assert.match(parser, /MAX_STDOUT_BYTES = 512 \* 1024/);
assert.match(parser, /DEFAULT_TIMEOUT_MS = 12000/);
assert.match(parser, /DEFAULT_CONCURRENCY = 1/);
assert.match(parser, /DEFAULT_QUEUE_LIMIT = 4/);
assert.match(parser, /command: SANDBOX_LAUNCHER_PATH/);
assert.match(parser, /args: \[profile, kind\]/);
assert.match(parser, /input\.pipe\(child\.stdin\)/);
assert.doesNotMatch(parser, /args[^\n]*filePath/);

for (const limit of ['--as=2147483648', '--cpu=10', '--nproc=64', '--nofile=64', '--fsize=1048576', '--core=0']) {
    assert.ok(launcher.includes(limit), `missing prlimit boundary ${limit}`);
}

for (const argument of [
    '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', '--dir /proc', '--dev /dev', '--tmpfs /tmp', '--cap-drop ALL'
]) {
    assert.ok(launcher.includes(argument), `missing sandbox argument ${argument}`);
}
assert.doesNotMatch(launcher, /--proc\s+\/proc/);

assert.match(launcher, /case "\$profile" in[\s\S]*beta\)[\s\S]*formal\)/);
assert.match(launcher, /case "\$kind" in[\s\S]*docx\|xlsx\|pptx\|csv\)/);
assert.doesNotMatch(launcher, /\beval\b|\bsh\s+-c\b|\bbash\s+-c\b/);
assert.doesNotMatch(launcher, /\/root|\/home|\/rick|uploads/);

assert.match(worker, /ALLOWED_KINDS = new Set\(\['docx', 'xlsx', 'pptx', 'csv'\]\)/);
assert.doesNotMatch(worker, /ALLOWED_KINDS[^\n]*pdf/);
assert.match(worker, /archive_encrypted_entry_blocked/);
assert.match(worker, /archive_duplicate_entry/);
assert.match(worker, /archive_compression_ratio_limit/);
assert.match(worker, /archive_special_file_blocked/);

assert.match(server, /userCanAccessUploadedFile\(fileId, userId\)/);
assert.match(server, /文档解析被拒绝或失败: kind=\$\{kind\}, code=\$\{err\.code \|\| 'parse_failed'\}/);
assert.doesNotMatch(server, /文档解析被拒绝或失败[^\n]*fileName|文档解析被拒绝或失败[^\n]*content/);
assert.match(server, /sandbox_exec/);
assert.match(server, /禁止网络、宿主机访问、提权和绕过资源限制/);

console.log('parser-sandbox-regression ok');
