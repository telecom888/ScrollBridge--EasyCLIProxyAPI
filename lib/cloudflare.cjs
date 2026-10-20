const crypto = require('node:crypto');
function client(token, fetcher = fetch) {
  return async (path, method = 'GET', body) => {
    const r = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' });
    const data = await r.json();
    if (!r.ok || !data.success) throw new Error(`Cloudflare 请求失败 (${r.status})：${(data.errors || []).map(e => String(e.message).slice(0, 200)).join('；') || '请检查 API 令牌权限'}`);
    return data.result;
  };
}
async function provision({ apiToken, accountId, zoneId, hostname, port }, fetcher) {
  if (!apiToken || !/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error('请填写 API 令牌、32 位账户 ID 和区域 ID');
  const { validateConfig } = require('./config.cjs');
  const config = validateConfig({ hostname, port }); if (!config.hostname) throw new Error('请先填写域名');
  const api = client(apiToken, fetcher);
  const zone = await api(`/zones/${zoneId}`);
  if (config.hostname !== zone.name && !config.hostname.endsWith('.' + zone.name)) throw new Error('域名不属于所填区域');
  const existing = await api(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(config.hostname)}`);
  if (existing.length) throw new Error('该域名已有 DNS 记录。为避免覆盖，请改用空闲子域名，或使用已有隧道方式');
  let tunnel; let record;
  try {
    tunnel = await api(`/accounts/${accountId}/cfd_tunnel`, 'POST', { name: `scrollbridge-${config.hostname}-${Date.now()}`, config_src: 'cloudflare', tunnel_secret: crypto.randomBytes(32).toString('base64') });
    await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, 'PUT', { config: { ingress: [{ hostname: config.hostname, service: `http://127.0.0.1:${config.port}`, originRequest: { connectTimeout: 30 } }, { service: 'http_status:404' }] } });
    const token = await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
    record = await api(`/zones/${zoneId}/dns_records`, 'POST', { type: 'CNAME', name: config.hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1 });
    return { tunnelToken: token, tunnelId: tunnel.id, hostname: config.hostname };
  } catch (e) {
    const cleanupErrors = [];
    if (record) await api(`/zones/${zoneId}/dns_records/${record.id}`, 'DELETE').catch(() => cleanupErrors.push('DNS 记录'));
    if (tunnel) await api(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}`, 'DELETE').catch(() => cleanupErrors.push('隧道'));
    if (cleanupErrors.length) throw new Error(`${e.message}；请在 Cloudflare 删除本次未完成的${cleanupErrors.join('、')}`);
    throw e;
  }
}
module.exports = { client, provision };
