'use strict';

function appendIncrementalText(accumulated = '', incoming = '') {
    const current = String(accumulated || '');
    const next = String(incoming || '');
    if (!next) return current;
    if (!current) return next;
    if (next === current || current.endsWith(next)) return current;
    if (next.startsWith(current)) return next;

    const maxOverlap = Math.min(current.length, next.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
        if (current.slice(-length) === next.slice(0, length)) {
            return current + next.slice(length);
        }
    }
    return current + next;
}

function stripStandaloneMarkers(text = '') {
    return String(text || '')
        .replace(/<\|[^|]+\|>/g, '')
        .replace(/functions\.\w+:\d+/g, '');
}

function createToolProtocolFilter({ toolNames = [] } = {}) {
    const safeNames = [...new Set(toolNames.map((name) => String(name || '').trim()).filter(Boolean))];
    const protocolStarts = [
        '<|tool_calls_section_begin|>',
        '<|tool_call_begin|>',
        '<function_calls',
        '<invoke',
        ...safeNames.map((name) => `functions.${name}`)
    ];
    let carry = '';
    let captured = '';
    let suppressProtocol = false;
    let deferJsonCandidate = false;
    let emittedVisibleContent = false;

    const reset = () => {
        carry = '';
        captured = '';
        suppressProtocol = false;
        deferJsonCandidate = false;
        emittedVisibleContent = false;
    };

    const findPartialMarkerStart = (text) => {
        let earliest = text.length;
        for (const marker of protocolStarts) {
            const maxLength = Math.min(text.length, marker.length - 1);
            for (let length = maxLength; length > 0; length -= 1) {
                if (text.endsWith(marker.slice(0, length))) {
                    earliest = Math.min(earliest, text.length - length);
                    break;
                }
            }
        }
        return earliest;
    };

    const push = (chunk = '') => {
        const incoming = String(chunk || '');
        if (!incoming) return '';
        captured = appendIncrementalText(captured, incoming);
        if (suppressProtocol || deferJsonCandidate) return '';

        let text = carry + incoming;
        carry = '';
        if (!emittedVisibleContent && /^[\[{]/.test(text.trimStart())) {
            deferJsonCandidate = true;
            return '';
        }

        let markerIndex = -1;
        for (const marker of protocolStarts) {
            const index = text.indexOf(marker);
            if (index !== -1 && (markerIndex === -1 || index < markerIndex)) markerIndex = index;
        }
        if (markerIndex !== -1) {
            const visiblePrefix = stripStandaloneMarkers(text.slice(0, markerIndex));
            suppressProtocol = true;
            if (visiblePrefix) emittedVisibleContent = true;
            return visiblePrefix;
        }

        const partialStart = findPartialMarkerStart(text);
        if (partialStart < text.length) {
            carry = text.slice(partialStart);
            text = text.slice(0, partialStart);
        }
        const visible = stripStandaloneMarkers(text);
        if (visible) emittedVisibleContent = true;
        return visible;
    };

    const flush = ({ fallbackDetected = false } = {}) => {
        if (suppressProtocol || fallbackDetected) {
            reset();
            return '';
        }
        const looksLikeToolJson = safeNames.some((name) => new RegExp(`"(?:name|function)"\\s*:\\s*"${name}"`).test(captured));
        const visible = deferJsonCandidate && (looksLikeToolJson || fallbackDetected)
            ? ''
            : (deferJsonCandidate ? captured : stripStandaloneMarkers(carry));
        reset();
        return visible;
    };

    return Object.freeze({ push, flush, reset });
}

module.exports = Object.freeze({ appendIncrementalText, createToolProtocolFilter });
