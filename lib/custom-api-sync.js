'use strict';
const crypto = require('node:crypto');
const fields = ['cx_context', 'cx_interrupted', 'is_context_summary', 'tool_calls', 'tool_call_id', 'client_order'];
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function messageHash(row) {
    return crypto.createHash('sha256').update(JSON.stringify([
        row.role, row.content, row.reasoning_content || '', row.model || '', row.process_trace || null, row.client_metadata || '{}'
    ])).digest('hex');
}
function clientMessageFields(row) {
    if (!String(row.request_id || '').startsWith('client:')) return {};
    const metadata = JSON.parse(row.client_metadata || '{}');
    return { ...metadata, client_message_id: row.request_id.slice(7), sync_hash: messageHash(row) };
}
function normalizeMessages(messages) {
    if (!Array.isArray(messages) || !messages.length || messages.length > 500) fail(400, 'invalid_client_messages');
    const seen = new Set();
    return messages.map(message => {
        const id = String(message?.client_message_id || '');
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(id) || seen.has(id)) fail(400, 'invalid_client_message_id');
        seen.add(id);
        if (!['user', 'assistant', 'tool', 'system'].includes(message.role)
            || typeof message.content !== 'string' || message.content.length > 2 * 1024 * 1024
            || (message.reasoning_content != null && typeof message.reasoning_content !== 'string')) fail(400, 'invalid_client_message');
        if (message.client_order != null && (!Number.isSafeInteger(message.client_order) || message.client_order < 0)) fail(400, 'invalid_client_order');
        const metadata = {};
        for (const field of fields) if (message[field] != null) metadata[field] = message[field];
        return { ...message, client_metadata: JSON.stringify(metadata) };
    });
}
function installCustomApiSyncRoutes(app, { authenticateToken, apiLimiter, ensureSessionKindColumn, withMainDbTransaction, scheduleConversationIntegritySeal }) {
    app.put('/api/sessions/:id/client-messages', apiLimiter, authenticateToken, async (req, res) => {
        try {
            const id = String(req.params.id || '');
            const model = String(req.body?.model || '');
            if (!/^(?:session_|local-custom-)[a-zA-Z0-9_-]{1,120}$/.test(id)
                || !/^(?:custom:|byok:)[a-zA-Z0-9_.:/-]{1,160}$/.test(model)) fail(400, 'invalid_custom_session');
            const messages = normalizeMessages(req.body.messages);
            await ensureSessionKindColumn();
            const result = await withMainDbTransaction(async tx => {
                let session = await tx.get('SELECT user_id, model FROM sessions WHERE id = ?', [id]);
                if (session && session.user_id !== req.user.userId) fail(404, 'session_not_found');
                if (session && !/^(?:custom:|byok:)/.test(session.model)) fail(409, 'not_custom_session');
                if (!session) {
                    if (!/^(?:session_client_|local-custom-)/.test(id)) fail(404, 'session_not_found');
                    const title = String(req.body.title || messages.find(message => message.role === 'user')?.content || '自定义 API 对话').trim().slice(0, 200);
                    await tx.run('INSERT INTO sessions (id,user_id,title,model,session_kind) VALUES (?,?,?,?,?)', [id, req.user.userId, title, model, 'chat']);
                }
                const saved = [];
                for (const message of messages) {
                    const requestId = 'client:' + message.client_message_id;
                    const current = await tx.get('SELECT * FROM messages WHERE session_id = ? AND request_id = ?', [id, requestId]);
                    const row = { role: message.role, content: message.content, reasoning_content: message.reasoning_content || '',
                        model: message.model || model, process_trace: message.process_trace == null ? null : typeof message.process_trace === 'string' ? message.process_trace : JSON.stringify(message.process_trace),
                        client_metadata: message.client_metadata };
                    if (current && current.role !== row.role) fail(409, 'client_message_conflict');
                    const hash = messageHash(row);
                    if (current && messageHash(current) !== hash && message.sync_hash !== messageHash(current)) fail(409, 'client_message_conflict');
                    if (!current) {
                        await tx.run(`INSERT INTO messages (session_id,request_id,role,content,reasoning_content,model,process_trace,client_metadata)
                            VALUES (?,?,?,?,?,?,?,?)`, [id, requestId, row.role, row.content, row.reasoning_content, row.model, row.process_trace, row.client_metadata]);
                    } else if (messageHash(current) !== hash) {
                        await tx.run('UPDATE messages SET content=?,reasoning_content=?,model=?,process_trace=?,client_metadata=? WHERE id=?',
                            [row.content, row.reasoning_content, row.model, row.process_trace, row.client_metadata, current.id]);
                    }
                    const stored = await tx.get('SELECT id FROM messages WHERE session_id=? AND request_id=?', [id, requestId]);
                    saved.push({ client_message_id: message.client_message_id, id: stored.id, sync_hash: hash });
                }
                await tx.run('UPDATE sessions SET updated_at=CURRENT_TIMESTAMP,model=? WHERE id=? AND user_id=?', [model, id, req.user.userId]);
                return saved;
            });
            scheduleConversationIntegritySeal(id, req.user.userId);
            res.json({ success: true, messages: result });
        } catch (error) {
            res.status(error.status || 500).json({ error: error.status ? error.message : 'custom_sync_failed' });
        }
    });
}
module.exports = { installCustomApiSyncRoutes, clientMessageFields, messageHash };
