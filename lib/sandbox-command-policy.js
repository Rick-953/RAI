'use strict';

/**
 * Sandbox command policy — hard-block rules and an extension interface.
 *
 * auditSandboxScript() runs BEFORE any sandbox process is spawned. Blocked
 * scripts are rejected with a readable reason list so the model can correct
 * itself. Built-in rules can never be removed; additional rules can be
 * registered at runtime via registerSandboxCommandRule() — this is the
 * intended extension point for future policy layers.
 *
 * Privacy: the audit result carries only rule ids and reasons, never the
 * script content. Logging layers must not record script text.
 */

const BUILTIN_BLOCKED_RULES = Object.freeze([
    Object.freeze({
        id: 'system_destroy_root',
        reason: 'destructive root filesystem command',
        pattern: /(^|[\s;|&(])rm\s+(-{0,2}[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|\/\*)(\s|$|\*)/i
    }),
    Object.freeze({
        id: 'system_destroy_system_dir',
        reason: 'destructive system-directory removal',
        pattern: /(^|[\s;|&(])rm\s+(-{0,2}[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/etc|\/usr|\/bin|\/boot|\/var|\/srv|\/lib)(\/|\s|$|\*)/i
    }),
    Object.freeze({
        id: 'disk_format',
        reason: 'disk/partition format tool',
        pattern: /\b(mkfs|mkfs\.[a-z0-9]+|mkswap|fdisk|sfdisk|parted|gparted|badblocks|wipefs)\b/i
    }),
    Object.freeze({
        id: 'block_device_write',
        reason: 'direct block-device write',
        pattern: /\bdd\b[^|;&\n]*\bof=\/dev\/(sd|nvme|vd|hd|mapper|loop|disk)[a-z0-9]*/i
    }),
    Object.freeze({
        id: 'device_redirect',
        reason: 'shell redirection to device node',
        pattern: /(^|[;&|(])\s*(echo|cat|printf|:|tee)\s+[^|;&\n]*>\s*\/dev\/(sd|nvme|vd|hd|mapper|loop|disk)[a-z0-9]*/i
    }),
    Object.freeze({
        id: 'privilege_escape',
        reason: 'privilege-escalation attempt',
        pattern: /\b(sudo|su\s+-|setuid|setgid|nsenter|unshare|chroot|capsh|pkexec|setcap)\b/i
    }),
    Object.freeze({
        id: 'nested_sandbox',
        reason: 'nested sandbox/supervisor launch',
        pattern: /\b(bwrap|systemd-run|docker|podman|proot|singularity)\b/i
    }),
    Object.freeze({
        id: 'kernel_module',
        reason: 'kernel module or sysctl mutation',
        pattern: /\b(modprobe|insmod|rmmod|kexec)\b|\bsysctl\s+-[a-z]*w\b/i
    }),
    Object.freeze({
        id: 'mount_operation',
        reason: 'mount operation',
        pattern: /\b(mount|umount|swapon|swapoff)\b/i
    }),
    Object.freeze({
        id: 'proc_sys_write',
        reason: 'write into /proc or /sys',
        pattern: /[>]\s*\/proc\/|\s\/sys\//i
    }),
    Object.freeze({
        id: 'network_scanner',
        reason: 'network scanner or attack tool',
        pattern: /\b(nmap|masscan|hping3?|mdk3|aircrack-ng|hydra|sqlmap|medusa|wpscan)\b/i
    }),
    Object.freeze({
        id: 'reverse_shell',
        reason: 'reverse-shell or outbound controllable connection',
        pattern: /(\/dev\/tcp\/|\/dev\/udp\/|\bbash\s+-i\b|\bnc\s+-[a-z]*e\b|\bnetcat\s+-[a-z]*e\b|\bsocat\b[^|;&\n]*(exec|system))/i
    }),
    Object.freeze({
        id: 'remote_transfer',
        reason: 'remote shell tunnel or credential transfer',
        pattern: /\b(ssh\s+-[a-zA-Z]*[LRTD]|sshpass|scp\s+|sftp\s+)/i
    }),
    Object.freeze({
        id: 'crypto_miner',
        reason: 'cryptocurrency miner binary',
        pattern: /\b(xmrig|minerd|cpuminer|ethminer|kawpowminer|ccminer|t-rex)\b/i
    }),
    Object.freeze({
        id: 'fork_bomb',
        reason: 'fork-bomb pattern',
        pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|/i
    }),
    Object.freeze({
        id: 'system_file_overwrite',
        reason: 'overwrite system file',
        pattern: /(>\s*\/etc\/|:\s*>\s*\/etc\/|\bcat\s+\/dev\/(zero|urandom)\s*>\s*\/)/i
    }),
    Object.freeze({
        id: 'shutdown_reboot',
        reason: 'shutdown/reboot/halt',
        pattern: /\b(shutdown|reboot|halt|poweroff|init\s+[06])\b/i
    }),
    Object.freeze({
        id: 'kill_critical',
        reason: 'kill PID 1 or broad process kill',
        pattern: /\bkill\s+-9\s+1\b|\bpkill\s+-9\s+-f\b/i
    })
]);

let customRules = [];

function normalizeRule(rule) {
    if (!rule || typeof rule !== 'object') throw new Error('sandbox_rule_invalid');
    const id = String(rule.id || '').trim();
    if (!id || !/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error('sandbox_rule_id_invalid');
    const reason = String(rule.reason || 'blocked by custom sandbox rule').slice(0, 200);
    if (typeof rule.test === 'function') {
        return Object.freeze({ id, reason, test: rule.test });
    }
    if (rule.pattern instanceof RegExp) {
        return Object.freeze({ id, reason, pattern: rule.pattern });
    }
    throw new Error('sandbox_rule_test_required');
}

function ruleHits(rule, scriptText) {
    if (typeof rule.test === 'function') {
        const hit = rule.test(scriptText);
        return hit ? String(hit).slice(0, 200) : null;
    }
    return rule.pattern.test(scriptText) ? rule.reason : null;
}

/**
 * Audit a sandbox script before execution.
 * @param {string} scriptText
 * @returns {{allowed: boolean, blocked: Array<{id: string, reason: string}>}}
 */
function auditSandboxScript(scriptText) {
    const text = String(scriptText || '');
    const blocked = [];
    for (const rule of BUILTIN_BLOCKED_RULES) {
        if (ruleHits(rule, text)) {
            blocked.push({ id: rule.id, reason: rule.reason });
        }
    }
    for (const rule of customRules) {
        if (ruleHits(rule, text)) {
            blocked.push({ id: rule.id, reason: rule.reason });
        }
    }
    return { allowed: blocked.length === 0, blocked };
}

function registerSandboxCommandRule(rule) {
    const normalized = normalizeRule(rule);
    const existing = customRules.findIndex((entry) => entry.id === normalized.id);
    if (existing >= 0) customRules[existing] = normalized;
    else customRules.push(normalized);
    return normalized.id;
}

function unregisterSandboxCommandRule(id) {
    const normalizedId = String(id || '').trim();
    const index = customRules.findIndex((entry) => entry.id === normalizedId);
    if (index >= 0) {
        customRules.splice(index, 1);
        return true;
    }
    return false;
}

function listSandboxCommandRules() {
    return [
        ...BUILTIN_BLOCKED_RULES.map((rule) => ({ id: rule.id, reason: rule.reason, builtin: true })),
        ...customRules.map((rule) => ({ id: rule.id, reason: rule.reason, builtin: false }))
    ];
}

module.exports = Object.freeze({
    auditSandboxScript,
    listSandboxCommandRules,
    registerSandboxCommandRule,
    unregisterSandboxCommandRule
});