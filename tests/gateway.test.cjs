const { test } = require('node:test'); const assert = require('node:assert/strict');
const http = require('node:http'); const zlib = require('node:zlib');
const { WebSocketServer, WebSocket } = require('ws');
const { once } = require('node:events');
const { startGateway, MAX_BODY } = require('../lib/gateway.cjs');
const { validateConfig, createAccessKey } = require('../lib/config.cjs');
const KEY = createAccessKey(); const UPSTREAM_KEY = 'local-private-key';
async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const records = [];
  const g = await startGateway({upstream:`http://127.0.0.1:${upstream.address().port}`,port}, {accessKey:KEY,upstreamKey:UPSTREAM_KEY}, r => records.push(r), options);
  t.after(async () => { await g.close(); upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); });
  return {upstream,base:`http://127.0.0.1:${port}`,records};
}
const auth = {authorization:`Bearer ${KEY}`};
test('image endpoints require authentication and explicit opt-in, with live changes', async t => {
  let enabled = false, calls = 0;
  const {base,records} = await fixture(t, (req,res) => { calls++; req.resume(); res.end('{"data":[]}'); }, {getImagesEnabled:()=>enabled});
  for (const path of ['/v1/images/generations','/v1/images/edits']) {
    const send = headers => fetch(base+path,{method:'POST',headers,body:'{"model":"image-test"}'});
    assert.equal((await send({})).status,401);
    const disabled = await send(auth); assert.equal(disabled.status,404); assert.match(await disabled.text(),/disabled/);
    enabled = true; const open = await send(auth); assert.equal(open.status,200); await open.text();
    assert.equal(records.at(-1).model,'image-test');
    enabled = false;
  }
  assert.equal(calls,2);
});
test('image JSON bodies preserve bytes and enforce model permissions and required model', async t => {
  let calls = 0;
  const payload = '{ "model": "image-test", "prompt": "PRIVATE_IMAGE_PROMPT", "size":"1024x1024" }';
  const zipped = zlib.gzipSync(payload);
  const {base,records} = await fixture(t, (req,res) => {
    calls++; const chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>{
      assert.deepEqual(Buffer.concat(chunks),zipped); assert.equal(req.headers['content-encoding'],'gzip');
      assert.equal(req.headers.authorization,`Bearer ${UPSTREAM_KEY}`);res.end('{}');
    });
  }, {getImagesEnabled:()=>true,getDisabledModels:()=>['blocked']});
  for (const path of ['/v1/images/generations','/v1/images/edits']) {
    const r=await fetch(base+path,{method:'POST',headers:{...auth,'content-type':'application/json','content-encoding':'gzip'},body:zipped});
    assert.equal(r.status,200);await r.text();
    for (const [body,status] of [['{"model":"blocked"}',403],['{"prompt":"test"}',400],['invalid',400]]) {
      const bad=await fetch(base+path,{method:'POST',headers:auth,body});assert.equal(bad.status,status);await bad.text();
    }
  }
  assert.equal(calls,2);assert.ok(!JSON.stringify(records).includes('PRIVATE_IMAGE_PROMPT'));
});
test('multipart image edits preserve binary uploads, log model and reject ambiguous models', async t => {
  let calls=0, expected;
  const {base,records}=await fixture(t,(req,res)=>{
    calls++;const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{assert.deepEqual(Buffer.concat(chunks),expected);res.end('{}');});
  },{getImagesEnabled:()=>true,getDisabledModels:()=>['blocked']});
  function form(models=['image-test'],fileModel=false) {
    const parts=models.map(model=>Buffer.from(`--test-boundary\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`));
    parts.push(Buffer.from(`--test-boundary\r\nContent-Disposition: form-data; name="${fileModel?'model':'image'}"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),Buffer.from([0,255,128,1,13,10]),Buffer.from('\r\n--test-boundary--\r\n'));
    return Buffer.concat(parts);
  }
  const send=body=>fetch(base+'/v1/images/edits',{method:'POST',headers:{...auth,'content-type':'multipart/form-data; boundary=test-boundary'},body});
  expected=form();let r=await send(expected);assert.equal(r.status,200);await r.text();assert.equal(records.at(-1).model,'image-test');
  for(const [body,status] of [[form(['blocked']),403],[form([]),400],[form(['image-test','blocked']),400],[form(['blocked','image-test']),400],[form(['image-test'],true),400],[Buffer.from('broken'),400]]) {
    r=await send(body);assert.equal(r.status,status);await r.text();
  }
  assert.equal(calls,1);
});
test('image switch defaults off and rejects non-boolean settings',()=>{
  assert.equal(validateConfig({}).imagesEnabled,false);
  assert.equal(validateConfig({imagesEnabled:true}).imagesEnabled,true);
  assert.throws(()=>validateConfig({imagesEnabled:'true'}));
});
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
    const r = await fetch(base+path,{method,headers:{...headers,cookie:'secret=1','x-forwarded-host':'malicious.com'},body:method==='POST'?' {"model":"test"} ':undefined});
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
test('SSE reaches client before upstream completes without response buffering', async t => {
  let end;
  const {base} = await fixture(t, (req,res) => { req.resume(); res.writeHead(200,{'content-type':'text/event-stream'}); res.write('event: message\ndata: {"text":"first"}\n\n'); end = () => res.end('data: [DONE]\n\n'); });
  const response = await fetch(base+'/v1/messages',{method:'POST',headers:auth,body:'{"model":"test","stream":true}'});
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
  const controller=new AbortController();const r=await fetch(base+'/v1/responses',{method:'POST',headers:auth,body:'{"model":"test"}',signal:controller.signal});await r.body.getReader().read();controller.abort();
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Upstream not cancelled')),2000))]);
});
test('Responses websocket authenticates both hops and relays frames', async t => {
  const {base,upstream}=await fixture(t,(_,res)=>res.end()); const wss=new WebSocketServer({server:upstream});
  let remoteHeaders; wss.on('connection',(ws,req)=>{remoteHeaders=req.headers;ws.on('message',(data,binary)=>ws.send(data,{binary}));}); t.after(()=>{for(const c of wss.clients)c.terminate();wss.close();});
  const ws=new WebSocket(base.replace('http:','ws:')+'/v1/responses',{headers:auth}); ws.on('error',()=>{});await once(ws,'open');const message=JSON.stringify({type:'response.create',model:'test',input:'hello'});ws.send(message);const [data]=await once(ws,'message');assert.equal(data.toString(),message);assert.equal(remoteHeaders.authorization,`Bearer ${UPSTREAM_KEY}`);ws.close();await once(ws,'close');
});
test('logs model names for all three protocols without logging prompts', async t => {
  const {base,records}=await fixture(t, (req,res)=>{req.resume();res.end('{}');});
  for (const path of ['/v1/chat/completions','/v1/responses','/v1/messages','/v1beta/models/gemini-test:generateContent']) {
    const body=JSON.stringify({model:path.includes('v1beta')?'gemini-test':'chat-test',messages:[{role:'user',content:'PRIVATE_PROMPT'}]});
    const r=await fetch(base+path,{method:'POST',headers:auth,body});await r.text();assert.equal(r.status,200);
  }
  assert.deepEqual(records.map(r=>r.model),['chat-test','chat-test','chat-test','gemini-test']);
  assert.ok(!JSON.stringify(records).includes('PRIVATE_PROMPT'));
});
test('disabled models are denied before reaching upstream across protocols and compressed bodies',async t=>{
  let calls=0;const {base,records}=await fixture(t,(_,res)=>{calls++;res.end('{}');},{getDisabledModels:()=>['blocked']});
  for(const path of ['/v1/chat/completions','/v1/responses','/v1/responses/compact','/v1/completions','/v1/embeddings','/v1/messages','/v1/messages/count_tokens','/v1beta/interactions','/v1beta/models/blocked:generateContent','/v1beta/models/blocked:streamGenerateContent','/v1beta/models/blocked:countTokens']) {
    const r=await fetch(base+path,{method:'POST',headers:auth,body:JSON.stringify({model:'models/BLOCKED'})});assert.equal(r.status,403,path);await r.text();
  }
  const zipped=zlib.gzipSync('{"model":"blocked"}');const r=await fetch(base+'/v1/messages',{method:'POST',headers:{...auth,'content-encoding':'gzip'},body:zipped});assert.equal(r.status,403);await r.text();assert.equal(calls,0);assert.equal(records.at(-1).model,'blocked');
  assert.equal((await fetch(base+'/v1/models/blocked',{headers:auth})).status,403);
  const missing=await fetch(base+'/v1/responses',{method:'POST',headers:auth,body:'{}'});assert.equal(missing.status,400);
});
test('model lists hide disabled entries and live policy changes take effect without restart',async t=>{
  let disabled=['blocked'];
  const {base}=await fixture(t,(req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST'){req.resume();return res.end('{}');}const json=req.url.startsWith('/v1beta')?{models:[{name:'models/blocked'},{name:'models/open'}],nextPageToken:'next'}:{data:[{id:'blocked'},{id:'open'}]};const bytes=zlib.gzipSync(JSON.stringify(json));res.writeHead(200,{'content-encoding':'gzip','content-length':bytes.length,etag:'old-etag'});res.end(bytes);},{getDisabledModels:()=>disabled});
  const openai=await fetch(base+'/v1/models',{headers:auth});assert.equal(openai.headers.get('content-encoding'),null);assert.equal(openai.headers.get('etag'),null);assert.deepEqual((await openai.json()).data.map(m=>m.id),['open']);
  const google=await(await fetch(base+'/v1beta/models',{headers:auth})).json();assert.deepEqual(google.models.map(m=>m.name),['models/open']);assert.equal(google.nextPageToken,'next');
  disabled=[];const r=await fetch(base+'/v1/messages',{method:'POST',headers:auth,body:'{"model":"blocked"}'});assert.equal(r.status,200);await r.text();
  disabled=['open'];const denied=await fetch(base+'/v1/messages',{method:'POST',headers:auth,body:'{"model":"open"}'});assert.equal(denied.status,403);
});
test('websocket blocks disabled models and inherited models after a live policy change',async t=>{
  let disabled=['blocked'],forwards=0;const {base,upstream,records}=await fixture(t,(_,res)=>res.end(),{getDisabledModels:()=>disabled});const wss=new WebSocketServer({server:upstream});wss.on('connection',ws=>ws.on('message',data=>{forwards++;ws.send(data);}));t.after(()=>{for(const c of wss.clients)c.terminate();wss.close();});
  const ws=new WebSocket(base.replace('http:','ws:')+'/v1/responses',{headers:auth});ws.on('error',()=>{});await once(ws,'open');
  ws.send('{"type":"response.create","model":"blocked"}');assert.equal(JSON.parse((await once(ws,'message'))[0]).status,403);assert.equal(forwards,0);
  ws.send('{"type":"response.create","model":"open","input":"hello"}');await once(ws,'message');assert.equal(forwards,1);
  ws.send('{"type":"response.create","previous_response_id":"opaque-id","input":"continue"}');assert.equal(JSON.parse((await once(ws,'message'))[0]).model,'open');assert.equal(forwards,2);
  disabled=['open'];ws.send('{"type":"response.create","input":"continue"}');assert.equal(JSON.parse((await once(ws,'message'))[0]).status,403);assert.equal(forwards,2);assert.equal(records.at(-1).model,'open');
  ws.close();await once(ws,'close');
});
