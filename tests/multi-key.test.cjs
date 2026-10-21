const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const zlib=require('node:zlib');
const {once}=require('node:events');
const {WebSocketServer,WebSocket}=require('ws');
const {validateConfig,createAccessKey}=require('../lib/config.cjs');
const {newKey,syncModels,entries,resolveModel}=require('../lib/policy.cjs');
const {startGateway}=require(process.env.SCROLLBRIDGE_TEST_ENGINE==='go'?'../lib/go-gateway.cjs':'../lib/gateway.cjs');
const {parseImageMultipart}=require('../lib/gemini-images.cjs');
async function fixture(t,handler) {
  const seen=[];
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const event={path:req.url,headers:req.headers,bytes:Buffer.concat(chunks)};seen.push(event);
    if(handler)return handler(req,res,event);
    res.setHeader('content-type','application/json');
    if(req.method==='GET') {
      if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'gemini-real',object:'model'},{id:'other-real'},{id:'unregistered'}]}));
      if(req.url==='/v1beta/models')return res.end(JSON.stringify({models:[{name:'models/gemini-real',supportedGenerationMethods:['generateContent']},{name:'models/other-real'}]}));
      return res.end(JSON.stringify({id:'gemini-real',name:'models/gemini-real',displayName:'gemini-real'}));
    }
    event.body=JSON.parse(event.bytes);
    res.end(JSON.stringify({model:event.body.model || 'gemini-real',response:{model:'gemini-real'},message:{model:'gemini-real',content:'gemini-real'},modelVersion:'gemini-real'}));
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const all=newKey('全部'),limited=newKey('手机');
  let config=syncModels(validateConfig({upstream:`http://127.0.0.1:${upstream.address().port}`,port,imagesEnabled:true,accessKeys:[all,limited]}),['gemini-real','other-real','gemini-3.1-flash-image']);
  config.modelRules[0].aliases=[{id:'alias-a',name:'chat-fast'},{id:'alias-b',name:'assistant'}];
  limited.mode='selected';limited.allowed=['alias-a'];config=validateConfig(config);
  let secrets={upstreamKey:'private-upstream',tunnelToken:'',keyValues:{[all.id]:createAccessKey(),[limited.id]:createAccessKey()}};
  const records=[],gateway=await startGateway(config,secrets,row=>records.push(row),{stateDir:require('node:path').resolve('.test-output','go-contract-'+require('node:crypto').randomUUID()),getConfig:()=>config,getSecrets:()=>secrets});
  t.after(async()=>{await gateway.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));});
  return {base:`http://127.0.0.1:${port}`,server:gateway.server,gateway,upstream,seen,records,all,limited,get config(){return config;},get secrets(){return secrets;},auth:(key=all)=>({authorization:`Bearer ${secrets.keyValues[key.id]}`}),update:async fn=>{const next=structuredClone(config);fn(next);config=validateConfig(next);await gateway.refreshPolicy();},rotate:async key=>{secrets={...secrets,keyValues:{...secrets.keyValues,[key.id]:createAccessKey()}};await gateway.refreshPolicy();}};
}
test('per-key lists, aliases, raw ID switch and global policy agree across authentication forms',async t=>{
  const f=await fixture(t);
  const list=async(key,path='/v1/models')=>(await(await fetch(f.base+path,{headers:f.auth(key)})).json());
  assert.deepEqual((await list(f.all)).data.map(row=>row.id),['chat-fast','assistant','other-real']);
  assert.deepEqual((await list(f.limited)).data.map(row=>row.id),['chat-fast']);
  assert.deepEqual((await list(f.limited,'/v1beta/models')).models.map(row=>row.name),['models/chat-fast']);
  const send=(model,key=f.all,extra={})=>fetch(f.base+'/v1/messages',{method:'POST',headers:{...f.auth(key),...extra},body:JSON.stringify({model})});
  assert.equal((await send('gemini-real')).status,404);
  assert.equal((await send('assistant',f.limited)).status,403);
  assert.equal((await send('not-known')).status,404);
  for(const headers of [{'x-api-key':f.secrets.keyValues[f.limited.id]},{'x-goog-api-key':f.secrets.keyValues[f.limited.id]}]){
    const r=await fetch(f.base+'/v1/chat/completions',{method:'POST',headers,body:'{"model":"chat-fast"}'});assert.equal(r.status,200);assert.equal((await r.json()).model,'chat-fast');
  }
  await f.update(c=>{c.modelRules[0].keepOriginal=true;});
  assert.ok((await list(f.all)).data.some(row=>row.id==='gemini-real'));
  assert.equal((await send('gemini-real',f.limited)).status,403);
  await f.update(c=>{c.accessKeys.find(k=>k.id===f.limited.id).allowed.push(c.modelRules[0].originalId);});
  assert.equal((await send('gemini-real',f.limited)).status,200);
  await f.update(c=>{c.disabledModels=['gemini-real'];});
  assert.equal((await send('chat-fast')).status,403);assert.equal((await send('gemini-real',f.limited)).status,403);
  assert.deepEqual((await list(f.limited)).data,[]);
  assert.ok(!JSON.stringify(f.records).includes(f.secrets.keyValues[f.all.id]));
});
test('JSON, Google path, single model and compressed response translate only protocol fields',async t=>{
  const f=await fixture(t);
  for(const path of ['/v1/chat/completions','/v1/responses','/v1/messages','/v1/embeddings','/v1beta/interactions','/v1beta/models/chat-fast:generateContent']){
    const raw=Buffer.from('{"model":"chat-fast","messages":[{"content":"gemini-real"}]}');
    const r=await fetch(f.base+path,{method:'POST',headers:{...f.auth(),'content-encoding':'gzip','content-type':'application/json'},body:zlib.gzipSync(raw)});
    assert.equal(r.status,200);const json=await r.json();assert.equal(json.model,'chat-fast');assert.equal(json.response.model,'chat-fast');assert.equal(json.message.content,'gemini-real');
    assert.equal(f.seen.at(-1).body.model,'gemini-real');assert.equal(f.seen.at(-1).headers['content-encoding'],undefined);
  }
  assert.equal(f.seen.at(-1).path,'/v1beta/models/gemini-real:generateContent');
  const conflict=await fetch(f.base+'/v1beta/models/chat-fast:generateContent',{method:'POST',headers:f.auth(),body:'{"model":"assistant"}'});assert.equal(conflict.status,400);
  for(const path of ['/v1/models/chat-fast','/v1beta/models/chat-fast']){
    const r=await fetch(f.base+path,{headers:f.auth()});assert.equal(r.status,200);const body=await r.json();assert.equal(body.id,'chat-fast');assert.equal(body.name,'models/chat-fast');
  }
  assert.equal(f.records.at(-1).keyName,'全部');assert.equal(f.records.at(-1).actualModel,'gemini-real');
});
test('aliased multipart edits preserve reference image bytes and filename',async t=>{
  let parsed;
  const f=await fixture(t,async(req,res,event)=>{parsed=await parseImageMultipart(event.bytes,req.headers['content-type']);res.setHeader('content-type','application/json');res.end('{"data":[{"b64_json":"aW1hZ2U="}]}');});
  const bytes=Buffer.from([0,255,13,10,128,1]);const form=new FormData();form.set('model','chat-fast');form.set('prompt','private-prompt');form.append('image',new Blob([bytes],{type:'image/png'}),'reference.png');
  const r=await fetch(f.base+'/v1/images/edits',{method:'POST',headers:f.auth(),body:form});assert.equal(r.status,200);await r.json();
  assert.equal(parsed.body.model,'gemini-real');assert.deepEqual(parsed.files[0].data,bytes);assert.equal(parsed.files[0].filename,'reference.png');assert.ok(!JSON.stringify(f.records).includes('private-prompt'));
});
test('Gemini image compatibility uses the actual model behind a neutral alias',async t=>{
  const f=await fixture(t,(req,res)=>{res.setHeader('content-type','application/json');res.end('{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"aW1hZ2U="}}]}}]}');});
  await f.update(c=>{c.geminiImageCompatibility=true;c.modelRules.find(row=>row.actual==='gemini-3.1-flash-image').aliases=[{id:'draw-alias',name:'draw'}];});
  const send=key=>fetch(f.base+'/v1/images/generations',{method:'POST',headers:f.auth(key),body:'{"model":"draw","prompt":"test"}'});
  const r=await send(f.all);assert.equal(r.status,200);assert.equal((await r.json()).data[0].b64_json,'aW1hZ2U=');assert.equal(f.seen[0].path,'/v1beta/models/gemini-3.1-flash-image:generateContent');
  assert.equal((await send(f.limited)).status,403);
  await f.update(c=>{c.disabledModels=['gemini-3.1-flash-image'];});assert.equal((await send(f.all)).status,403);
});
test('aliased JSON response decompresses and removes obsolete integrity headers',async t=>{
  const f=await fixture(t,(req,res)=>{const bytes=zlib.brotliCompressSync(Buffer.from('{"model":"gemini-real-v2","message":{"model":"gemini-real","content":"gemini-real"}}'));res.writeHead(200,{'content-type':'application/json','content-encoding':'br','content-length':bytes.length,'etag':'old','digest':'old'});res.end(bytes);});
  const r=await fetch(f.base+'/v1/messages',{method:'POST',headers:f.auth(),body:'{"model":"chat-fast"}'});
  assert.equal(r.status,200);assert.equal(r.headers.get('content-encoding'),null);assert.equal(r.headers.get('etag'),null);assert.equal(r.headers.get('digest'),null);
  const result=await r.json();assert.equal(result.model,'chat-fast');assert.equal(result.message.model,'chat-fast');assert.equal(result.message.content,'gemini-real');
});
test('aliased gzip SSE stays incremental and handles split UTF-8 and multiline data',async t=>{
  let finish;
  const f=await fixture(t,(req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream','content-encoding':'gzip','etag':'stale'});const gzip=zlib.createGzip();gzip.pipe(res);
    const frame=Buffer.from('event: message\r\ndata: {"model":"gemini-real",\r\ndata: "choices":[{"delta":{"content":"中文 gemini-real"}}]}\r\n\r\n');
    gzip.write(frame.subarray(0,frame.length-8));gzip.write(frame.subarray(frame.length-8));gzip.flush(zlib.constants.Z_SYNC_FLUSH);
    finish=()=>gzip.end('data: [DONE]\n\n');
  });
  const r=await fetch(f.base+'/v1/chat/completions',{method:'POST',headers:f.auth(),body:'{"model":"chat-fast","stream":true}'});
  assert.equal(r.headers.get('content-encoding'),null);assert.equal(r.headers.get('etag'),null);
  const reader=r.body.getReader();const first=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('SSE buffered')),1500))]);
  const text=Buffer.from(first.value).toString();assert.match(text,/"model":"chat-fast"/);assert.match(text,/中文 gemini-real/);finish();
  let rest='';while(true){const{value,done}=await reader.read();if(done)break;rest+=Buffer.from(value).toString();}assert.match(rest,/DONE/);
});
test('key disable, rotation and removal are live and independent',async t=>{
  const f=await fixture(t);const old=f.auth(f.all);
  await f.rotate(f.all);assert.equal((await fetch(f.base+'/healthz',{headers:old})).status,401);assert.equal((await fetch(f.base+'/healthz',{headers:f.auth(f.all)})).status,200);
  await f.update(c=>{c.accessKeys.find(k=>k.id===f.all.id).enabled=false;});
  assert.equal((await fetch(f.base+'/healthz',{headers:f.auth(f.all)})).status,401);assert.equal((await fetch(f.base+'/healthz',{headers:f.auth(f.limited)})).status,200);
  await f.update(c=>{c.accessKeys=c.accessKeys.filter(k=>k.id!==f.all.id);});assert.equal((await fetch(f.base+'/healthz',{headers:f.auth(f.all)})).status,401);
});
test('WebSocket aliases, nested conflicts, inheritance and live revocation',async t=>{
  const f=await fixture(t);const wss=new WebSocketServer({server:f.upstream});const upstreamBodies=[];
  wss.on('connection',ws=>ws.on('message',bytes=>{const body=JSON.parse(bytes);upstreamBodies.push(body);ws.send(JSON.stringify({type:'response.created',response:{id:`r${upstreamBodies.length}`,model:body.model}}));}));
  t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();});
  const ws=new WebSocket(f.base.replace('http:','ws:')+'/v1/responses',{headers:f.auth(f.limited)});await once(ws,'open');
  ws.send('{"type":"response.create","model":"chat-fast"}');assert.equal(JSON.parse((await once(ws,'message'))[0]).response.model,'chat-fast');assert.equal(upstreamBodies[0].model,'gemini-real');
  ws.send('{"type":"response.create","previous_response_id":"r1"}');assert.equal(JSON.parse((await once(ws,'message'))[0]).response.model,'chat-fast');assert.equal(upstreamBodies[1].model,'gemini-real');
  ws.send('{"type":"response.create","model":"chat-fast","response":{"model":"assistant"}}');assert.equal(JSON.parse((await once(ws,'message'))[0]).status,403);assert.equal(upstreamBodies.length,2);
  const closed=once(ws,'close');await f.rotate(f.limited);assert.equal((await closed)[0],1008);
});
test('a key revoked while uploading cannot start an upstream request',async t=>{
  const f=await fixture(t),body='{"model":"chat-fast"}';
  const received=f.server?once(f.server,'request'):(async()=>{for(let i=0;i<100;i++){if((await f.gateway.metrics()).metrics.active>0)return;await new Promise(r=>setTimeout(r,10));}throw Error('Upload not received')})();
  let request;
  const result=new Promise((resolve,reject)=>{
    request=http.request(f.base+'/v1/chat/completions',{method:'POST',headers:{...f.auth(),'content-length':Buffer.byteLength(body)}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);
  });
  request.write(body.slice(0,10));await received;
  await f.update(c=>{c.accessKeys.find(key=>key.id===f.all.id).enabled=false;});request.end(body.slice(10));
  assert.equal(await result,401);assert.equal(f.seen.length,0);
});
test('duplicate and escaped JSON model selectors cannot bypass key restrictions',async t=>{
  const f=await fixture(t);
  for(const body of ['{"model":"assistant","model":"chat-fast"}','{"mo\\u0064el":"assistant","model":"chat-fast"}','{"model":"chat-fast","response":{"model":"assistant","model":"chat-fast"}}']) {
    const r=await fetch(f.base+'/v1/responses',{method:'POST',headers:f.auth(f.limited),body});assert.equal(r.status,400);await r.text();
  }
  assert.equal(f.seen.length,0);
});
test('policy validation rejects collisions; renamed entries keep grants and future models obey mode',()=>{
  const key=newKey(),config=syncModels(validateConfig({accessKeys:[key]}),['real']);
  config.modelRules[0].aliases=[{id:'alias-1',name:'first'}];key.mode='selected';key.allowed=['alias-1'];
  const valid=validateConfig(config);assert.equal(resolveModel(valid,key,'first').actual,'real');
  valid.modelRules[0].aliases[0].name='renamed';assert.equal(resolveModel(valid,key,'renamed').id,'alias-1');
  const next=syncModels(valid,['real','new-real']);assert.throws(()=>resolveModel(next,key,'new-real'),{status:403});
  assert.equal(resolveModel(next,{...key,mode:'all'},'new-real').actual,'new-real');
  next.modelRules[0].aliases.push({id:'alias-2',name:'REAL'});assert.throws(()=>validateConfig(next),/已存在/);
  assert.throws(()=>validateConfig({...valid,accessKeys:[{...key,allowed:['missing']}]}),/无效/);
  assert.equal(entries(valid).some(row=>row.name==='real'),false);
});
