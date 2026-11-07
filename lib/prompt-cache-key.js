'use strict';
const crypto = require('node:crypto');

function promptCacheKey({ userId, sessionId } = {}) {
    if (!userId || !sessionId) return undefined;
    return 'rai-v1-' + crypto.createHash('sha256').update(JSON.stringify([String(userId), String(sessionId)])).digest('hex');
}

module.exports = { promptCacheKey };
