"use strict";
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MODELS = new Set(['auto','fast','thinking','research','custom','deepseek-flash','gpt-6.1-sol','gpt-6-luna','claude-sonnet-5','gemini-3.6-flash-low','gemini-3-flash','gemma','qwen3.6-35b-a3b','kimi-k2.6','chatgpt-gpt-oss-120b','nemotron-3-ultra','kolors-free','gpt-image-2']);
const METHODS = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
const ENDPOINTS = new Set(['auth','chat','files','sessions','user','shares','models','model-availability','skills','local-agent','admin']);
function id(value) { return typeof value === 'string' && ID.test(value) ? value.toLowerCase() : undefined; }
function model(value) { return MODELS.has(value) ? value : 'other'; }
function trace(req, fields = {}) {
  if (!req || typeof req !== 'object') return {};
  const route = typeof req.route?.path === 'string' ? req.route.path : '';
  const endpoint = route.startsWith('/api/') ? route.slice(5).split('/')[0] : '';
  return { serverRequestId: id(req.diagnosticRequestId), clientRequestId: id(req.headers?.['x-rai-client-request-id']),
    chatRequestId: typeof req.diagnosticChatRequestId === 'string' && /^req_[0-9]{13}_[a-f0-9]{16}$/.test(req.diagnosticChatRequestId) ? req.diagnosticChatRequestId : undefined,
    method: METHODS.has(req.method) ? req.method : 'other', endpoint: ENDPOINTS.has(endpoint) ? endpoint : 'other',
    model: model(fields.model), mode: ['chat','thinking','research'].includes(fields.mode) ? fields.mode : undefined };
}
module.exports = { id, model, trace };
