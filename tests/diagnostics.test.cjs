const {test}=require('node:test');const assert=require('node:assert/strict');const {localCheck,publicCheck}=require('../lib/diagnostics.cjs');
const {newKey}=require('../lib/policy.cjs');const key=newKey();
const cfg={hostname:'api.example.com',accessKeys:[key],diagnosticKeyId:key.id};const secrets={keyValues:{[key.id]:'test-key'},upstreamKey:'local-key'};
test('automatic public test uses actual model names when aliases hide image capability',async()=>{
  const {syncModels}=require('../lib/policy.cjs');const {validateConfig}=require('../lib/config.cjs');
  const config=syncModels(validateConfig(cfg),['gemini-flash-image','text-real']);
  config.modelRules[0].aliases=[{id:'draw',name:'flash-fast'}];config.modelRules[1].aliases=[{id:'chat',name:'chat'}];
  const calls=[];await publicCheck(config,secrets,{fetcher:async(url,options)=>{
    if(url.endsWith('/healthz'))return response({service:'scrollbridge'});
    if(url.endsWith('/v1/models'))return response({data:[{id:'flash-fast'},{id:'chat'}]});
    calls.push(JSON.parse(options.body));return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  assert.equal(calls[0].model,'chat');
});
const scanner=async()=>({available:true,coreRunning:true,guiRunning:true,listening:true,ownedByCore:true,pid:123});
const response=(data,status=200,headers={'content-type':'application/json'})=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers});
test('local connectivity requires running core, owned port and model API',async()=>{const good=await localCheck(cfg,secrets,{scanner,fetcher:async()=>response({data:[{id:'model'}]})});assert.equal(good.ok,true);assert.equal(good.process.pid,123);assert.equal(good.steps.length,3);const bad=await localCheck(cfg,secrets,{scanner:async()=>({...await scanner(),ownedByCore:false}),fetcher:async()=>response({data:[]})});assert.equal(bad.ok,false);assert.match(bad.message,/其他进程/);});
test('missing core is distinguished from local authentication failure',async()=>{const r=await localCheck(cfg,secrets,{scanner:async()=>({available:true,coreRunning:false,listening:false,ownedByCore:false}),fetcher:async()=>response({},401)});assert.equal(r.ok,false);assert.match(r.message,/未启动/);assert.match(r.message,/密钥不正确/);});
function publicMock(stream='data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n') {const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});if(url.endsWith('/healthz'))return response({service:'scrollbridge'});if(url.endsWith('/v1/models'))return response({data:[{id:'gemini-flash'}]});return response(stream,200,{'content-type':'text/event-stream'});};return{calls,fetcher};}
test('public connectivity checks valid HTTPS health then sends real model stream request',async()=>{const m=publicMock();const r=await publicCheck(cfg,secrets,{fetcher:m.fetcher});assert.equal(r.ok,true);assert.equal(r.steps.length,3);assert.ok(m.calls.every(c=>c.url.startsWith('https://api.example.com/')));assert.equal(m.calls[2].options.method,'POST');assert.equal(JSON.parse(m.calls[2].options.body).stream,true);assert.equal(m.calls[2].options.redirect,'error');});
test('HTTP 200 alone is not sufficient for a healthy public model request',async()=>{for(const body of ['data: {"error":{"message":"quota"}}\n\ndata: [DONE]\n\n','data: {"choices":[{"delta":{"content":"OK"}}]}\n\n']){const r=await publicCheck(cfg,secrets,{fetcher:publicMock(body).fetcher});assert.equal(r.ok,false);assert.match(r.message,/不完整或包含错误/);}});
test('wrong public destination fails before model request',async()=>{const r=await publicCheck(cfg,secrets,{fetcher:async()=>response({service:'other'})});assert.equal(r.ok,false);assert.match(r.message,/未指向/);});
test('public check uses the explicitly selected model without silently falling back',async()=>{
  const m=publicMock();const original=m.fetcher;
  m.fetcher=async(url,options)=>url.endsWith('/v1/models')?response({data:[{id:'gemini-flash'},{id:'selected-text-model'}]}):original(url,options);
  const r=await publicCheck(cfg,secrets,{fetcher:m.fetcher,model:'selected-text-model'});
  assert.equal(r.ok,true);assert.equal(JSON.parse(m.calls.at(-1).options.body).model,'selected-text-model');
  assert.deepEqual(r.steps.at(-1).facts,[['模型','selected-text-model'],['响应','流式传输完成']]);
  const missing=publicMock();const failure=await publicCheck(cfg,secrets,{fetcher:missing.fetcher,model:'not-open'});
  assert.equal(failure.ok,false);assert.match(failure.message,/所选模型.*未在外部模型列表中开放/);assert.equal(missing.calls.length,2);
});
test('public DNS and certificate failures are distinguished',async()=>{for(const[code,text]of[['ENOTFOUND','DNS'],['CERT_HAS_EXPIRED','TLS']]){const e=new Error('fetch failed');e.cause={code};const r=await publicCheck(cfg,secrets,{fetcher:async()=>{throw e;}});assert.equal(r.ok,false);assert.match(r.message,new RegExp(text));}});
