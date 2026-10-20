const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { WebSocketServer, WebSocket } = require('ws');
const { validateConfig, validateAccessKey } = require('./config.cjs');
const MAX_BODY = 32 * 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function allowed(method, path) {
  if (method === 'GET') return ['/healthz', '/v1/models', '/v1beta/models'].includes(path) || /^\/v1(?:beta)?\/models\/[A-Za-z0-9_.-]+$/.test(path);
  if (method !== 'POST') return false;
  return ['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/responses/compact', '/v1/messages', '/v1/messages/count_tokens', '/v1/embeddings', '/v1beta/interactions'].includes(path) || /^\/v1beta\/models\/[A-Za-z0-9_.-]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(path);
}
function digest(key) { return crypto.createHash('sha256').update(key).digest(); }
function authorized(req, url, key) {
  const candidate = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || url.searchParams.get('key') || '';
  return typeof candidate === 'string' && crypto.timingSafeEqual(digest(candidate), digest(key));
}
function upstreamHeaders(req, upstream, key) {
  const result = {};
  const connection = String(req.headers.connection || '').toLowerCase().split(',').map(x => x.trim());
  const drop = new Set([...HOP, ...connection, 'host', 'authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'forwarded', 'origin', 'referer']);
  for (const [k, v] of Object.entries(req.headers)) if (!drop.has(k) && !k.startsWith('cf-') && !k.startsWith('x-forwarded-') && v !== undefined) result[k] = v;
  result.host = upstream.host;
  if (key) result.authorization = `Bearer ${key}`;
  return result;
}
function responseHeaders(headers) {
  const connection = String(headers.connection || '').toLowerCase().split(',').map(x => x.trim());
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k) && !connection.includes(k) && k !== 'set-cookie' && !k.startsWith('access-control-')));
}
function json(res, status, message) { if (res.destroyed) return; if (res.headersSent) return res.destroy(); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { message, type: 'gateway_error' } })); }
async function startGateway(input, secrets, onRecord = () => {}) {
  const c = validateConfig(input); validateAccessKey(secrets.accessKey);
  const upstream = new URL(c.upstream);
  const upstreamKey = secrets.upstreamKey || '';
  const sockets = new Set(); let active = 0;
  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => {
    const start = Date.now(); let path = '/'; let recorded = false;
    const record = () => { if (recorded) return; recorded = true; onRecord({ time: new Date().toISOString(), path, method: req.method, status: res.writableFinished ? res.statusCode : 499, ms: Date.now() - start }); };
    res.on('finish', record); res.on('close', record);
    let url;
    try { url = new URL(req.url, 'http://localhost'); path = url.pathname; } catch { return json(res, 400, 'Invalid URL'); }
    if (!authorized(req, url, secrets.accessKey)) return json(res, 401, 'Invalid API key');
    // Compare the raw path as well: never normalize dot segments into an allowed route.
    const rawPath = req.url.split('?')[0];
    if (rawPath !== path || !allowed(req.method, path)) return json(res, 404, 'Route not exposed');
    if (path === '/healthz') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"service":"scrollbridge","ok":true}'); }
    if (active >= 64) return json(res, 429, 'Too many concurrent requests');
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return json(res, 413, 'Request too large');
    url.searchParams.delete('key'); url.searchParams.delete('api_key'); url.searchParams.delete('access_token');
    const target = new URL(path + url.search, upstream);
    const transport = target.protocol === 'https:' ? https : http;
    active++;
    let released = false;
    const release = () => { if (!released) { active--; released = true; } };
    const out = transport.request(target, { method: req.method, headers: upstreamHeaders(req, upstream, upstreamKey) }, reply => {
      const headers = responseHeaders(reply.headers);
      headers['cache-control'] = 'no-store';
      if (String(headers['content-type']).includes('text/event-stream')) { headers['x-accel-buffering'] = 'no'; delete headers['content-length']; }
      res.writeHead(reply.statusCode, headers); res.flushHeaders();
      reply.on('error', () => res.destroy()); reply.pipe(res);
    });
    out.setTimeout(600000, () => out.destroy(new Error('Upstream timeout')));
    const deadline = setTimeout(() => out.destroy(new Error('Request deadline')), 30 * 60000); deadline.unref();
    let size = 0;
    const limiter = new Transform({ transform(chunk, enc, cb) { size += chunk.length; if (size > MAX_BODY) { json(res, 413, 'Request too large'); cb(new Error('Request too large')); } else cb(null, chunk); } });
    limiter.on('error', () => out.destroy());
    out.on('error', () => { if (!res.headersSent && !res.destroyed) json(res, 502, 'Local model service unavailable'); else if (!res.destroyed) res.destroy(); });
    const cleanup = () => { clearTimeout(deadline); out.destroy(); release(); };
    req.on('aborted', cleanup); req.on('error', cleanup); res.on('close', cleanup); res.on('finish', cleanup);
    req.pipe(limiter).pipe(out);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
  server.on('upgrade', (req, socket, head) => {
    let url; try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const reject = code => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); };
    if (!authorized(req, url, secrets.accessKey)) return reject('401 Unauthorized');
    if (req.url.split('?')[0] !== '/v1/responses' || active >= 64) return reject('404 Not Found');
    url.searchParams.delete('key'); url.searchParams.delete('api_key'); url.searchParams.delete('access_token');
    const target = new URL('/v1/responses' + url.search, upstream); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers = upstreamHeaders(req, upstream, upstreamKey);
    for (const k of Object.keys(headers)) if (k.startsWith('sec-websocket-')) delete headers[k];
    const remote = new WebSocket(target, { headers, maxPayload: MAX_BODY, handshakeTimeout: 15000 });
    active++; let local; let done = false;
    const finish = () => { if (done) return; done = true; active--; if (local && local.readyState < 2) local.close(1011, 'Connection closed'); if (!local) socket.destroy(); remote.terminate(); };
    socket.on('close', finish); remote.on('error', finish); remote.on('unexpected-response', finish); remote.on('close', finish);
    remote.on('open', () => {
      if (done || socket.destroyed) { remote.terminate(); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        local = ws;
        ws.on('message', (data, binary) => { if (remote.bufferedAmount > MAX_BODY) return finish(); if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary }); });
        remote.on('message', (data, binary) => { if (ws.bufferedAmount > MAX_BODY) return finish(); if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary }); });
        ws.on('close', finish); ws.on('error', finish); remote.on('close', finish);
        onRecord({ time: new Date().toISOString(), method: 'WS', path: '/v1/responses', status: 101, ms: 0 });
      });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.requestTimeout = 600000; server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.port, '127.0.0.1', resolve); });
  return { server, close: () => new Promise(resolve => { for (const client of wss.clients) client.terminate(); wss.close(); for (const s of sockets) s.destroy(); server.close(resolve); }) };
}
module.exports = { startGateway, allowed, authorized, MAX_BODY };
