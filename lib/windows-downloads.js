'use strict';

const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/Master-Tea/CX-RAI/releases/latest';
const GITHUB_DOWNLOAD_PATH_PREFIX = '/Master-Tea/CX-RAI/releases/download/';
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const FALLBACK_RELEASE = Object.freeze({
    source: 'fallback',
    tag: 'v1.6.5.2',
    setup: Object.freeze({
        name: 'CX.RAI_1.6.5.2_Setup.exe',
        url: 'https://github.com/Master-Tea/CX-RAI/releases/download/v1.6.5.2/CX.RAI_1.6.5.2_Setup.exe'
    }),
    package: Object.freeze({
        name: 'CX.RAI_1.6.5.2_x86_x64.appxbundle',
        url: 'https://github.com/Master-Tea/CX-RAI/releases/download/v1.6.5.2/CX.RAI_1.6.5.2_x86_x64.appxbundle'
    }),
    arm: Object.freeze({
        package: Object.freeze({
            name: 'CX.RAI_1.6.5.2_arm.appxbundle',
            url: 'https://github.com/Master-Tea/CX-RAI/releases/download/v1.6.5.2/CX.RAI_1.6.5.2_arm.appxbundle'
        })
    })
});

const PACKAGE_SUFFIX_PRIORITY = Object.freeze([
    '.appxbundle',
    '.msixbundle',
    '.appx',
    '.msix'
]);

function normalizeReleaseAsset(asset) {
    const name = String(asset?.name || '').trim();
    const rawUrl = String(asset?.browser_download_url || '').trim();
    if (!name || name.length > 180 || !rawUrl) return null;

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch (_) {
        return null;
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.hostname !== 'github.com'
        || parsed.username
        || parsed.password
        || !parsed.pathname.startsWith(GITHUB_DOWNLOAD_PATH_PREFIX)
    ) {
        return null;
    }
    return { name, url: parsed.toString() };
}

function choosePackage(assets) {
    // 分包场景：优先 X86 主包（*_x86_x64.appxbundle），其次 *_x86*，最后回退旧单包逻辑
    const x86Bundle = assets.find((asset) => {
        const n = asset.name.toLowerCase();
        return (n.endsWith('.appxbundle') || n.endsWith('.msixbundle')) && n.includes('_x86');
    });
    if (x86Bundle) return x86Bundle;
    for (const suffix of PACKAGE_SUFFIX_PRIORITY) {
        const match = assets.find((asset) => asset.name.toLowerCase().endsWith(suffix));
        if (match) return match;
    }
    return null;
}

function chooseSetup(assets) {
    // 一键安装程序：v1.6.4 起上游改发 Setup.exe（自动安装证书与依赖）
    const exe = assets.find((asset) => asset.name.toLowerCase().endsWith('.exe'));
    return exe || null;
}

function chooseArmPackage(assets) {
    // Lumia 设备：仅提供 Arm 包（依赖由用户到 GitHub 下载页自取）
    const arm = assets.find((asset) => {
        const n = asset.name.toLowerCase();
        return (n.endsWith('.appxbundle') || n.endsWith('.msixbundle')) && n.includes('_arm');
    });
    if (!arm) return null;
    return { package: arm };
}

function parseLatestRelease(payload) {
    if (!payload || typeof payload !== 'object' || payload.draft === true) {
        throw new Error('github_release_invalid');
    }
    const tag = String(payload.tag_name || '').trim().slice(0, 80);
    const assets = Array.isArray(payload.assets)
        ? payload.assets.slice(0, 200).map(normalizeReleaseAsset).filter(Boolean)
        : [];
    const packageAsset = choosePackage(assets);
    const setupAsset = chooseSetup(assets);
    // v1.6.4 起 Setup.exe 内置证书，上游不再单独发 .cer；
    // 但旧版本仍可能只有 .cer 包，故保留可选解析。
    const certificate = assets.find((asset) => asset.name.toLowerCase().endsWith('.cer')) || null;
    if (!tag || (!setupAsset && !packageAsset)) {
        throw new Error('github_release_assets_missing');
    }
    return {
        source: 'github',
        tag,
        setup: setupAsset,
        package: packageAsset,
        certificate,
        arm: chooseArmPackage(assets)
    };
}

function createWindowsDownloadsResolver({
    fetchImpl = globalThis.fetch,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    timeoutMs = 8000,
    now = () => Date.now()
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch_required');
    let cached = null;

    return async function resolveWindowsDownloads() {
        const currentTime = Number(now()) || Date.now();
        if (cached && currentTime - cached.fetchedAt < cacheTtlMs) return cached.value;

        try {
            const response = await fetchImpl(GITHUB_LATEST_RELEASE_URL, {
                method: 'GET',
                headers: {
                    Accept: 'application/vnd.github+json',
                    'User-Agent': 'RAI-Windows-Release-Resolver/1.0',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
            });
            if (!response?.ok) throw new Error(`github_release_http_${Number(response?.status || 0)}`);
            const value = parseLatestRelease(await response.json());
            cached = { fetchedAt: currentTime, value };
            return value;
        } catch (error) {
            if (cached?.value) {
                return { ...cached.value, source: 'github-stale', stale: true };
            }
            return { ...FALLBACK_RELEASE, upstreamError: String(error?.message || 'github_release_unavailable').slice(0, 120) };
        }
    };
}

module.exports = Object.freeze({
    DEFAULT_CACHE_TTL_MS,
    FALLBACK_RELEASE,
    GITHUB_LATEST_RELEASE_URL,
    createWindowsDownloadsResolver,
    chooseArmPackage,
    chooseSetup,
    normalizeReleaseAsset,
    parseLatestRelease
});
