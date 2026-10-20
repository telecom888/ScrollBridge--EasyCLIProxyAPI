const { test } = require('node:test'); const assert = require('node:assert/strict');
const http = require('node:http'); const zlib = require('node:zlib');
const { WebSocketServer, WebSocket } = require('ws');
const { once } = require('node:events');
const { startGateway, MAX_BODY } = require('../lib/gateway.cjs');
const { validateConfig, createAccessKey } = require('../lib/config.cjs');
const KEY = createAccessKey(); const UPSTREAM_KEY = 'local-private-key';
async function fixture(t, handler) {
  const upstream = http.createServer(handler); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const records = [];
  const g = await startGateway({upstream:`http://127.0.0.1:${upstream.address().port}`,port}, {accessKey:KEY,upstreamKey:UPSTREAM_KEY}, r => records.push(r));
  t.after(async () => { await g.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); });
  return {upstream,base:`http://127.0.0.1:${port}`,records};
}
const auth = {authorization:`Bearer ${KEY}`};
test('configuration only allows loopback origin and non-recursive gateway', () => {
  for (const upstream of ['http://example.com','file:///etc/passwd','http://127.0.0.1/path','http://u:p@localhost','http://127.0.0.1?key=x']) assert.throws(() => validateConfig({upstream}));
  assert.throws(() => validateConfig({hostname:'test.com/path'})); assert.throws(() => validateConfig({port:8317}));
  assert.equal(validateConfig({hostname:'https://API.Example.com/'}).hostname,'api.example.com');
});
test('all three credentials are exchanged for upstream bearer, query secrets stripped', async t => {
  let seen; const {base,records} = await fixture(t, (req,res) => { seen = {url:req.url,headers:req.headers}; res.setHeader('content-type','application/json'); res.end('{"ok":true}'); });
  for (const [path,headers,method] of [
    ['/v1/models',auth,'GET'], ['/v1/chat/completions',auth,'POST'], ['/v1/responses',auth,'POST'],
    ['/v1/messages',{'x-api-key':KEY,'anthropic-version':'2023-06-01'},'POST'],
    ['/v1beta/models/test:generateContent',{'x-goog-api-key':KEY},'POST'],
    [`/v1beta/models/test:streamGenerateContent?alt=sse&key=${KEY}`,{},'POST']]) {
    const r = await fetch(base+path,{method,headers:{...headers,cookie:'secret=1','x-forwarded-host':'malicious.com'},body:method==='POST'?'{}':undefined});
    assert.equal(r.status,200); await r.text(); assert.equal(seen.headers.authorization,`Bearer ${UPSTREAM_KEY}`);
    assert.equal(seen.headers['x-api-key'],undefined); assert.equal(seen.headers['x-goog-api-key'],undefined); assert.equal(seen.headers.cookie,undefined); assert.equal(seen.headers['x-forwarded-host'],undefined);
    assert.ok(!seen.url.includes(KEY));
  }
  assert.ok(!JSON.stringify(records).includes(KEY)); assert.ok(!JSON.stringify(records).includes('?'));
});
test('denies missing/wrong key and administrative/OAuth routes', async t => {
  let calls=0; const {base} = await fixture(t, (_,res) => {calls++;res.end();});
  for (const headers of [{},{authorization:'Bearer wrong'},{'x-api-key':'wrong'}]) assert.equal((await fetch(base+'/v1/models',{headers})).status,401);
  for (const path of ['/management.html','/v0/management/config','/oauth/callback','/v1/../../management','/v1/models/%2e%2e%2fconfig']) assert.equal((await fetch(base+path,{headers:auth})).status,404);
  assert.equal((await fetch(base+'/v1/models',{method:'DELETE',headers:auth})).status,404); assert.equal(calls,0);
  assert.equal((await fetch(base+'/healthz',{headers:auth})).status,200);
});
test('SSE reaches client before upstream completes without body buffering', async t => {
  let end;
  const {base} = await fixture(t, (req,res) => { req.resume(); res.writeHead(200,{'content-type':'text/event-stream'}); res.write('event: message\ndata: {"text":"first"}\n\n'); end = () => res.end('data: [DONE]\n\n'); });
  const response = await fetch(base+'/v1/messages',{method:'POST',headers:auth,body:'{"stream":true}'});
  const reader = response.body.getReader(); const first = await reader.read(); assert.match(Buffer.from(first.value).toString(),/first/); assert.equal(response.headers.get('x-accel-buffering'),'no');
  end(); const last = await reader.read(); assert.match(Buffer.from(last.value).toString(),/DONE/);
});
test('forwards compressed responses byte-for-byte with matching headers', async t => {
  const bytes = zlib.gzipSync('{"data":[1,2,3]}');
  const {base} = await fixture(t, (_,res) => {res.writeHead(200,{'content-type':'application/json','content-encoding':'gzip','content-length':bytes.length,'set-cookie':'private=yes'});res.end(bytes);});
  const got = await new Promise((resolve,reject) => {http.get(base+'/v1/models',{headers:auth},res => {const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({res,bytes:Buffer.concat(chunks)}));}).on('error',reject);});
  assert.deepEqual(got.bytes,bytes);assert.equal(got.res.headers['content-encoding'],'gzip');assert.equal(got.res.headers['set-cookie'],undefined);
});
test('upstream failure returns 502 without disclosing local credentials', async t => {
  const {base,upstream} = await fixture(t,()=>{}); await new Promise(r=>upstream.close(r)); const r=await fetch(base+'/v1/models',{headers:auth});assert.equal(r.status,502);assert.ok(!(await r.text()).includes(UPSTREAM_KEY));
});
test('oversized content length is rejected before forwarding', async t => {
  let calls=0; const {base}=await fixture(t,(_,res)=>{calls++;res.end();});
  const result=await new Promise(resolve=>{const req=http.request(base+'/v1/messages',{method:'POST',headers:{...auth,'content-length':MAX_BODY+1}},res=>{res.resume();resolve(res.statusCode);});req.on('error',()=>{});req.end();});
  assert.equal(result,413);assert.equal(calls,0);
});
test('client cancellation closes upstream stream', async t => {
  let resolveClosed;const closed=new Promise(r=>resolveClosed=r);
  const {base}=await fixture(t,(_,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');res.on('close',resolveClosed);});
  const controller=new AbortController();const r=await fetch(base+'/v1/responses',{method:'POST',headers:auth,body:'{}',signal:controller.signal});await r.body.getReader().read();controller.abort();
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Upstream not cancelled')),2000))]);
});
test('Responses websocket authenticates both hops and relays frames', async t => {
  const {base,upstream}=await fixture(t,(_,res)=>res.end()); const wss=new WebSocketServer({server:upstream});
  let remoteHeaders; wss.on('connection',(ws,req)=>{remoteHeaders=req.headers;ws.on('message',(data,binary)=>ws.send(data,{binary}));}); t.after(()=>{for(const c of wss.clients)c.terminate();wss.close();});
  const ws=new WebSocket(base.replace('http:','ws:')+'/v1/responses',{headers:auth}); ws.on('error',()=>{});await once(ws,'open');ws.send('hello');const [data]=await once(ws,'message');assert.equal(data.toString(),'hello');assert.equal(remoteHeaders.authorization,`Bearer ${UPSTREAM_KEY}`);ws.close();await once(ws,'close');
});
