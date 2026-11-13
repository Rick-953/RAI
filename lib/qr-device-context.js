'use strict';
const ipaddr = require('ipaddr.js');
let regionDatabase;
function normalizeIp(raw) {
  if (typeof raw !== 'string' || raw.length > 64 || raw.includes('%')) return '';
  try { return ipaddr.process(raw).toString(); } catch (_) { return ''; }
}
function lookupRegion(ip) {
  // Pinned, server-local IPv4/IPv6 database. Never disclose login IPs to a geo API.
  if (!regionDatabase) { const IP2Region = require('ip2region').default; regionDatabase = new IP2Region(); }
  return regionDatabase.search(ip);
}
function loginDeviceContext(req, lookup = lookupRegion) {
  // Express has already applied the configured explicit trusted proxy CIDRs.
  // Do not accept caller-controlled body fields or CF/Vercel geo headers here.
  const ip = normalizeIp(req.ip || req.socket?.remoteAddress || '');
  if (!ip) return { ip: '', location: '无法确定位置', locationApproximate: true };
  const type = ipaddr.parse(ip).range();
  if (type !== 'unicast') return { ip, location: '局域网或保留地址', locationApproximate: true };
  let location = '';
  try {
    const region = lookup(ip) || {};
    const labels = [region.country, region.province, region.city].map(value =>
      typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '')
      .filter(value => value && value !== '0' && value !== '未知');
    location = [...new Set(labels)].join(' · ');
  } catch (_) { /* Offline database failure must not break authentication. */ }
  return { ip, location: location || '无法确定位置', locationApproximate: true };
}
module.exports = { normalizeIp, loginDeviceContext };
