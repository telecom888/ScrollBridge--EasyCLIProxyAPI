const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream');
const { authenticate, resolveModel, entries, keyAllows } = require('./policy.cjs');
const { validateSecrets } = require('./store.cjs');
const { rewriteModelFields, cleanEntityHeaders, ModelEvents, multipartBody } = require('./model-response.cjs');
const { isGeminiImage, parseImageMultipart, imagePlan, generateImages } = require('./gemini-images.cjs');
const { WebSocketServer, WebSocket } = require('ws');
const { validateConfig } = require('./config.cjs');
const { modelName, modelKey, modelFromPath, parseModelJSON } = require('./models.cjs');
const MAX_BODY = 32 * 1024 * 1024;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const IMAGE_ROUTES = ['/v1/images/generations', '/v1/images/edits'];
function allowed(method, path, imagesEnabled = false) {
  if (method === 'GET') return ['/healthz', '/v1/models', '/v1beta/models'].includes(path) || /^\/v1(?:beta)?\/models\/[A-Za-z0-9_.-]+$/.test(path);
  if (method !== 'POST') return false;
  if (IMAGE_ROUTES.includes(path)) return imagesEnabled;
  return ['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/responses/compact', '/v1/messages', '/v1/messages/count_tokens', '/v1/embeddings', '/v1beta/interactions'].includes(path) || /^\/v1beta\/models\/[A-Za-z0-9_.-]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(path);
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
function json(res, status, message) { if (res.destroyed) return; if (res.headersSent) return res.destroy(); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); res.end(JSON.stringify({ error: { message, type: 'gateway_error' } })); }
function decode(bytes, encoding, maximum = MAX_BODY) {
  const options = { maxOutputLength: maximum };
  switch (String(encoding || 'identity').toLowerCase()) {
    case 'identity': return bytes;
    case 'gzip': return zlib.gunzipSync(bytes, options);
    case 'deflate': return zlib.inflateSync(bytes, options);
    case 'br': return zlib.brotliDecompressSync(bytes, options);
    default: throw Object.assign(new Error('Unsupported content encoding'), { status: 415 });
  }
}
function readBody(stream, maximum, timeoutMs=60000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const timer = setTimeout(() => fail(Object.assign(new Error('Body timeout'), { status: 408 })), timeoutMs); timer.unref();
    function cleanup() { clearTimeout(timer); stream.off('data', data); stream.off('end', end); stream.off('error', fail); stream.off('aborted', aborted); }
    function fail(error) { cleanup(); stream.pause(); reject(error); }
    function aborted() { fail(new Error('Client disconnected')); }
    function data(chunk) { size += chunk.length; if (size > maximum) fail(Object.assign(new Error('Request too large'), { status: 413 })); else chunks.push(chunk); }
    function end() { cleanup(); resolve(Buffer.concat(chunks)); }
    stream.on('data', data); stream.once('end', end); stream.once('error', fail); stream.once('aborted', aborted);
  });
}
async function startGateway(input, secrets, onRecord = () => {}, options = {}) {
  const c = validateConfig(input); validateSecrets(c,secrets);
  const getConfig = options.getConfig || (() => c);
  const getSecrets = options.getSecrets || (() => secrets);
  const upstream = new URL(c.upstream);
  const upstreamKey = secrets.upstreamKey || '';
  const imagesEnabled = () => getConfig().imagesEnabled;
  const geminiImageCompatibility = () => getConfig().geminiImageCompatibility;
  const sockets = new Set(); let active = 0;
  const server = http.createServer({ maxHeaderSize: 16384 }, (req, res) => { handle(req, res).catch(() => json(res, 502, 'Local model service unavailable')); });
  async function handle(req, res) {
    const start = Date.now(); let path = '/', model = null, actualModel = null, identity = null; let recorded = false;
    const record = () => { if (recorded) return; recorded = true; onRecord({ time: new Date().toISOString(), path, model, actualModel, keyId:identity?.id || null,keyName:identity?.name || null, method: req.method, status: res.writableFinished ? res.statusCode : 499, ms: Date.now() - start }); };
    res.on('finish', record); res.on('close', record);
    let url;
    try { url = new URL(req.url, 'http://localhost'); path = url.pathname; } catch { return json(res, 400, 'Invalid URL'); }
    let policy=getConfig(); identity=authenticate(req,url,policy,getSecrets());
    if (!identity) return json(res, 401, 'Invalid API key');
    // Compare the raw path as well: never normalize dot segments into an allowed route.
    const rawPath = req.url.split('?')[0];
    if (rawPath !== path) return json(res, 404, 'Route not exposed');
    if (req.method === 'POST' && IMAGE_ROUTES.includes(path) && !imagesEnabled()) return json(res, 404, 'Image endpoints are disabled. Enable them in ScrollBridge settings.');
    if (!allowed(req.method, path, imagesEnabled())) return json(res, 404, 'Route not exposed');
    if (path === '/healthz') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"service":"scrollbridge","ok":true}'); }
    if (active >= 64) return json(res, 429, 'Too many concurrent requests');
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) return json(res, 413, 'Request too large');
    active++;
    let released = false, out, deadline, imageAbort;
    const cleanup = () => { if (released) return; released = true; active--; clearTimeout(deadline); out?.destroy(); imageAbort?.abort(); };
    req.on('aborted', cleanup); req.on('error', cleanup); res.on('close', cleanup); res.on('finish', cleanup);
    model = modelFromPath(path);
    let bytes = null, body, files = [], multipart=false, outgoingType;
    if (req.method === 'POST') {
      try {
        bytes = await readBody(req, MAX_BODY);
        const decoded = decode(bytes, req.headers['content-encoding']);
        if (path === '/v1/images/edits' && /^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '')) { multipart=true; ({body,files} = await parseImageMultipart(decoded, req.headers['content-type'])); }
        else body = parseModelJSON(decoded.toString('utf8'));
      }
      catch (error) { return json(res, error.status || 400, error.status === 413 ? 'Request too large' : error.status === 408 ? 'Request body timeout' : 'Invalid request body or content encoding'); }
      if (!body || Array.isArray(body) || typeof body !== 'object') return json(res, 400, 'Expected a JSON object');
      if (body.model !== undefined && !modelName(body.model)) return json(res, 400, 'Invalid model');
      model = model || modelName(body.model);
      if (!model) return json(res, 400, 'A model is required');
    }
    let resolved;
    policy=getConfig();identity=authenticate(req,url,policy,getSecrets());
    if(!identity)return json(res,401,'Invalid API key');
    if(IMAGE_ROUTES.includes(path) && !imagesEnabled())return json(res,404,'Image endpoints are disabled');
    if(model) {
      try {
        resolved=resolveModel(policy,identity,model); actualModel=resolved.actual;
        if(body?.model!==undefined) {
          const explicit=resolveModel(policy,identity,body.model);
          if(explicit.id!==resolved.id)return json(res,400,'Conflicting model selections');
        }
        if(body?.response?.model!==undefined){
          if(!modelName(body.response.model))return json(res,400,'Invalid model');
          if(resolveModel(policy,identity,body.response.model).id!==resolved.id)return json(res,400,'Conflicting model selections');
        }
      } catch(error) {return json(res,error.status || 400,error.message);}
    }
    if (res.destroyed || released) return;
    if (req.method === 'POST' && IMAGE_ROUTES.includes(path) && geminiImageCompatibility() && isGeminiImage(actualModel)) {
      imageAbort = new AbortController();
      deadline = setTimeout(() => imageAbort.abort(), 30 * 60000); deadline.unref();
      try {
        const plan = imagePlan(actualModel, body, files, path === '/v1/images/edits');
        const result = await generateImages(plan, upstream, upstreamKey, imageAbort.signal);
        if (!res.destroyed) { res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(result)); }
      } catch (error) {
        json(res, error.status || (error.name === 'TimeoutError' || imageAbort.signal.aborted ? 504 : 502), error.status ? error.message : 'Gemini image service unavailable or timed out');
      }
      return;
    }
    url.searchParams.delete('key'); url.searchParams.delete('api_key'); url.searchParams.delete('access_token');
    let targetPath=path;
    const changed=resolved && actualModel!==model;
    if(resolved && modelFromPath(path)) targetPath=path.replace(/(\/models\/)[^/]+?(?=:(?:generateContent|streamGenerateContent|countTokens)$|$)/,`$1${encodeURIComponent(actualModel)}`);
    if(body && body.model!==undefined && body.model!==actualModel) {
      body.model=actualModel;
      if(body.response?.model!==undefined)body.response.model=actualModel;
      if(multipart) {const encoded=multipartBody(body,files);bytes=encoded.bytes;outgoingType=encoded.contentType;}
      else bytes=Buffer.from(JSON.stringify(body));
      outgoingType ||= 'application/json';
    }
    const target = new URL(targetPath + url.search, upstream);
    const transport = target.protocol === 'https:' ? https : http;
    const requestHeaders=upstreamHeaders(req,upstream,upstreamKey);
    if(outgoingType){for(const field of ['content-encoding','transfer-encoding','content-md5','digest'])delete requestHeaders[field];requestHeaders['content-length']=bytes.length;requestHeaders['content-type']=outgoingType;}
    out = transport.request(target, { method: req.method, headers: requestHeaders }, reply => {
      const headers = responseHeaders(reply.headers);
      headers['cache-control'] = 'no-store';
      if (req.method === 'GET' && ['/v1/models', '/v1beta/models'].includes(path) && reply.statusCode === 200) {
        readBody(reply, 4 * 1024 * 1024).then(raw => {
          const listing = JSON.parse(decode(raw, reply.headers['content-encoding'], 4 * 1024 * 1024).toString('utf8'));
          const field = path === '/v1/models' ? 'data' : 'models';
          if (!Array.isArray(listing[field])) throw new Error('Invalid model list');
          const visible=new Map();for(const entry of entries(policy).filter(entry=>keyAllows(identity,entry))){const key=modelKey(entry.actual);if(!visible.has(key))visible.set(key,[]);visible.get(key).push(entry);}
          listing[field] = listing[field].flatMap(item => (visible.get(modelKey(item?.id || item?.name)) || []).map(entry=>field==='data'?{...item,id:entry.name,...(item.root?{root:entry.name}:{}),...(item.parent?{parent:entry.name}:{})}:{...item,name:`models/${entry.name}`,baseModelId:entry.name,displayName:entry.name}));
          for (const key of ['content-encoding', 'content-length', 'etag', 'content-md5', 'digest']) delete headers[key];
          headers['content-type'] = 'application/json';
          if (!res.destroyed) { res.writeHead(200, headers); res.end(JSON.stringify(listing)); }
        }).catch(() => json(res, 502, 'Invalid upstream model list'));
        return;
      }
      if(changed && reply.statusCode>=200 && reply.statusCode<300 && req.method==='GET' && resolved) {
        readBody(reply,4*1024*1024).then(raw=>{
          const data=JSON.parse(decode(raw,reply.headers['content-encoding'],4*1024*1024));
          rewriteModelFields(data,actualModel,model);
          if(path.startsWith('/v1beta/') || path.startsWith('/v1/models/')) {if(data.id!==undefined)data.id=model;if(data.name!==undefined)data.name=`models/${model}`;if(data.baseModelId!==undefined)data.baseModelId=model;if(data.displayName!==undefined)data.displayName=model;}
          cleanEntityHeaders(headers);headers['content-type']='application/json';if(!res.destroyed){res.writeHead(reply.statusCode,headers);res.end(JSON.stringify(data));}
        }).catch(()=>json(res,502,'Invalid upstream model response'));return;
      }
      if(changed && String(headers['content-type']).includes('text/event-stream')) {
        cleanEntityHeaders(headers);headers['x-accel-buffering']='no';res.writeHead(reply.statusCode,headers);res.flushHeaders();
        let inflater;const encoding=String(reply.headers['content-encoding']||'identity');
        if(encoding==='gzip')inflater=zlib.createGunzip();else if(encoding==='deflate')inflater=zlib.createInflate();else if(encoding==='br')inflater=zlib.createBrotliDecompress();else if(encoding!=='identity'){reply.destroy();return res.destroy();}
        pipeline(...[reply,inflater,new ModelEvents(actualModel,model),res].filter(Boolean),error=>{if(error)res.destroy();});return;
      }
      if(changed && String(headers['content-type']).includes('application/json')) {
        readBody(reply,64*1024*1024,600000).then(raw=>{
          const data=rewriteModelFields(JSON.parse(decode(raw,reply.headers['content-encoding'],64*1024*1024)),actualModel,model);
          cleanEntityHeaders(headers);if(!res.destroyed){res.writeHead(reply.statusCode,headers);res.end(JSON.stringify(data));}
        }).catch(()=>json(res,502,'Invalid upstream JSON response'));return;
      }
      if (String(headers['content-type']).includes('text/event-stream')) { headers['x-accel-buffering'] = 'no'; delete headers['content-length']; }
      res.writeHead(reply.statusCode, headers); res.flushHeaders();
      reply.on('error', () => res.destroy()); reply.pipe(res);
    });
    out.setTimeout(600000, () => out.destroy(new Error('Upstream timeout')));
    deadline = setTimeout(() => out.destroy(new Error('Request deadline')), 30 * 60000); deadline.unref();
    out.on('error', () => { if (!res.headersSent && !res.destroyed) json(res, 502, 'Local model service unavailable'); else if (!res.destroyed) res.destroy(); });
    out.end(bytes);
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });
  const connections=new Set();
  const fingerprint=keyId=>{
    const policy=getConfig(),key=policy.accessKeys.find(row=>row.id===keyId);
    return JSON.stringify([key,getSecrets().keyValues[keyId],key?entries(policy).filter(row=>keyAllows(key,row)).map(row=>[row.id,row.name,row.actual]):[]]);
  };
  server.on('upgrade', (req, socket, head) => {
    let url; try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const reject = code => { socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); };
    const identity=authenticate(req,url,getConfig(),getSecrets());
    if (!identity) return reject('401 Unauthorized');
    if (req.url.split('?')[0] !== '/v1/responses' || active >= 64) return reject('404 Not Found');
    let currentModel = modelName(url.searchParams.get('model'));
    let currentEntry;
    try{if(currentModel)currentEntry=resolveModel(getConfig(),identity,currentModel);}catch(error){return reject(error.status===404?'404 Not Found':'403 Forbidden');}
    if(currentEntry)url.searchParams.set('model',currentEntry.actual);
    url.searchParams.delete('key'); url.searchParams.delete('api_key'); url.searchParams.delete('access_token');
    const target = new URL('/v1/responses' + url.search, upstream); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers = upstreamHeaders(req, upstream, upstreamKey);
    for (const k of Object.keys(headers)) if (k.startsWith('sec-websocket-')) delete headers[k];
    const remote = new WebSocket(target, { headers, maxPayload: MAX_BODY, handshakeTimeout: 15000 });
    active++; let local; let done = false;
    const connection={keyId:identity.id,signature:fingerprint(identity.id),close:()=>finish()};connections.add(connection);
    const responseModels=new Map(), pendingModels=[];
    const finish = () => { if (done) return; done = true; connections.delete(connection); active--; if (local && local.readyState < 2) {local.close(1008, 'Configuration changed or connection closed');const timer=setTimeout(()=>local.terminate(),1000);timer.unref();} if (!local) socket.destroy(); remote.terminate(); };
    socket.on('close', finish); remote.on('error', finish); remote.on('unexpected-response', finish); remote.on('close', finish);
    remote.on('open', () => {
      if (done || socket.destroyed) { remote.terminate(); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        local = ws;
        ws.on('message', (data, binary) => {
          if(connection.signature!==fingerprint(identity.id))return finish();
          if (remote.bufferedAmount > MAX_BODY) return finish();
          let body, outbound = data;
          try { if (binary) throw new Error(); body = parseModelJSON(data.toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
          catch { ws.send(JSON.stringify({ type: 'error', status: 400, error: { message: 'Expected a JSON request', type: 'invalid_request_error' } })); return; }
          if (body.type !== 'response.cancel') {
            const requested = modelName(body.model || body.response?.model) || currentModel;
            const explicit = [body.model, body.response?.model].filter(value => value !== undefined);
            let code = 200;
            if (!requested || explicit.some(value => !modelName(value))) code = 400;
            let selected;
            if(code===200)try{
              const policy=getConfig(),key=policy.accessKeys.find(row=>row.id===identity.id);
              selected=resolveModel(policy,key,requested);
              if(explicit.some(value=>resolveModel(policy,key,value).id!==selected.id))code=400;
              const previous=body.previous_response_id || body.response?.previous_response_id;
              if(previous && responseModels.has(previous) && responseModels.get(previous).id!==selected.id)code=400;
            }catch(error){code=error.status || 400;}
            if (code !== 200) {
              ws.send(JSON.stringify({ type: 'error', status: code, error: { message: code === 403 ? 'Model is not available for this API key' : code===404?'Model not found':'Invalid or conflicting model selection', type: 'invalid_request_error' } }));
              onRecord({ time: new Date().toISOString(), method: 'WS', path: '/v1/responses', model: requested, keyId:identity.id,keyName:identity.name,status: code, ms: 0 });
              return;
            }
            currentModel = requested;
            currentEntry = selected;
            // Bind inherited or nested model selections explicitly so an opaque
            // previous_response_id cannot select a different upstream model.
            body.model=selected.actual;
            if(body.response?.model!==undefined)body.response.model=selected.actual;
            outbound=JSON.stringify(body);
            pendingModels.push({...selected,requested});
            if(pendingModels.length>200)return finish();
            onRecord({ time: new Date().toISOString(), method: 'WS', path: '/v1/responses', model: currentModel, actualModel:selected.actual,keyId:identity.id,keyName:identity.name,status: 200, ms: 0 });
          }
          if (remote.readyState === WebSocket.OPEN) remote.send(outbound, { binary: false });
        });
        remote.on('message', (data, binary) => {
          if (ws.bufferedAmount > MAX_BODY) return finish();
          let outbound=data;
          if(!binary)try{
            const event=JSON.parse(data.toString()),responseId=event.response?.id || event.response_id;
            if(event.type==='response.created' && responseId){responseModels.set(responseId,pendingModels.shift() || {...currentEntry,requested:currentModel});if(responseModels.size>200)responseModels.delete(responseModels.keys().next().value);}
            if(event.type==='error')pendingModels.shift();
            const selected=responseModels.get(responseId) || pendingModels[0] || {...currentEntry,requested:currentModel};
            outbound=JSON.stringify(rewriteModelFields(event,selected.actual,selected.requested));
          }catch{}
          if (ws.readyState === WebSocket.OPEN) ws.send(outbound, { binary });
        });
        ws.on('close', finish); ws.on('error', finish); remote.on('close', finish);
      });
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.requestTimeout = 600000; server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.port, '127.0.0.1', resolve); });
  return { server, refreshPolicy:()=>{for(const connection of connections)if(connection.signature!==fingerprint(connection.keyId))connection.close();},close: () => new Promise(resolve => { for (const client of wss.clients) client.terminate(); wss.close(); for (const s of sockets) s.destroy(); server.close(resolve); }) };
}
module.exports = { startGateway, allowed, MAX_BODY };
