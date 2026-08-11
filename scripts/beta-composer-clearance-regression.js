#!/usr/bin/env node

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { extractNamedFunction } = require('./beta-static-security-contracts');

const ROOT = path.resolve(__dirname, '..');
const APP_PATH = path.join(ROOT, 'public', 'app.js');
const STYLES_PATH = path.join(ROOT, 'public', 'styles.css');

function loadClearanceCalculator(appSource) {
    const context = vm.createContext({});
    vm.runInContext([
        extractNamedFunction(appSource, 'calculateComposerClearancePx'),
        'globalThis.__calculateComposerClearancePx = calculateComposerClearancePx;'
    ].join('\n\n'), context, { filename: APP_PATH });
    return context.__calculateComposerClearancePx;
}

function testClearanceCalculation(appSource) {
    const calculate = loadClearanceCalculator(appSource);

    assert.equal(calculate(276, 900), 276, 'desktop multiline composer must keep its full measured height');
    assert.equal(calculate(276, 844), 276, 'phone-width viewport must keep the full measured height before the keyboard opens');
    assert.equal(calculate(276, 320), 272, 'short keyboard viewport must retain a small visible chat area');
    assert.equal(calculate(1000, 900), 480, 'corrupt or extreme measurements must use the hard safety cap');
    assert.equal(calculate(45.2, 900), 46, 'ordinary compact composers must not be expanded to an artificial minimum');
    assert.equal(calculate(0, 900), 0, 'hidden composer measurements must not create phantom clearance');
    assert.equal(calculate('invalid', 900), 0, 'invalid measurements must fail closed');
}

function testMeasurementAndCssContracts(appSource, stylesSource) {
    assert.match(
        appSource,
        /const\s+composerHeight\s*=\s*Math\.ceil\(this\.inputArea\.getBoundingClientRect\(\)\.height\s*\|\|\s*0\)/,
        'composer metrics must include the full input-area overlay and its outer padding'
    );
    assert.match(
        appSource,
        /setProperty\(\s*['"]--composer-clearance['"]\s*,\s*`\$\{composerClearance\}px`\s*\)/,
        'measured clearance must be published to CSS'
    );
    assert.match(
        appSource,
        /const\s+shouldKeepChatAnchored\s*=\s*appState\.scrollFollowMode\s*!==\s*['"]pausedByUser['"]\s*&&\s*isNearBottom\(\)[\s\S]*this\.syncComposerMetrics\(\)[\s\S]*requestAnimationFrame\(\(\)\s*=>\s*this\.keepChatAnchored\(true\)\)/,
        'composer growth must keep a followed conversation at the new bottom without overriding a deliberate scroll pause'
    );

    const chatRuleBodies = Array.from(
        stylesSource.matchAll(/(?:^|\n)\s*(?:body\.mobile-viewport-managed\s+)?\.chat-container\s*\{([^}]*)\}/g),
        (match) => match[1]
    );
    assert.equal(chatRuleBodies.length, 4, 'base, managed-mobile, narrow, and desktop chat rules must remain covered');
    for (const body of chatRuleBodies) {
        assert.match(
            body,
            /padding-bottom:\s*calc\(var\(--composer-clearance,\s*160px\)/,
            'every chat layout branch must reserve the measured composer clearance'
        );
    }

    assert.match(
        stylesSource,
        /\.messages-list\s*\{[^}]*scroll-margin-bottom:\s*calc\(var\(--composer-clearance,\s*160px\)/s,
        'message-list scroll anchoring must follow measured composer clearance'
    );
    assert.match(
        stylesSource,
        /\.message\s*\{[^}]*scroll-margin-bottom:\s*calc\(var\(--composer-clearance,\s*160px\)/s,
        'individual message scroll anchoring must follow measured composer clearance'
    );
    assert.doesNotMatch(
        stylesSource,
        /min\(var\(--composer-height,[^)]*\),\s*72px\)/,
        'legacy 72px composer-height caps must not return'
    );
}

function main() {
    assert.ok(ROOT.endsWith(`${path.sep}beta版本`), `refusing unexpected project root: ${ROOT}`);
    const appSource = fs.readFileSync(APP_PATH, 'utf8');
    const stylesSource = fs.readFileSync(STYLES_PATH, 'utf8');

    testClearanceCalculation(appSource);
    testMeasurementAndCssContracts(appSource, stylesSource);
    console.log('beta-composer-clearance-regression ok (2/2)');
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`beta-composer-clearance-regression failed: ${error.stack || error.message}`);
        process.exitCode = 1;
    }
}
