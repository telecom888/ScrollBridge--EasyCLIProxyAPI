const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateConfig}=require('../lib/config.cjs');
const {fetchHostingModels,hostingEntries,publicModelId,orderByRoutes}=require('../lib/hosting.cjs');
const {toGoConfig}=require('../lib/go-gateway.cjs');
const {build,normalize,convertResponse}=require('../lib/hosted-bridge.cjs');
const p=id=>({id,name:id,protocol:'google',baseUrl:'https://generativelanguage.googleapis.com',enabled:true});
test('hosted bridge preserves repeated stream deltas and rejects ambiguous failures',async()=>{
 const {startHostedBridge}=require('../lib/hosted-bridge.cjs');
 let mode='repeat';const bridge=await startHostedBridge({getConfig:()=>({hostingProviders:[p('key')]}),getSecrets:()=>({hostingKeys:{key:'private'}}),token:'bridge-token',fetcher:async()=>{
  if(mode==='network')throw Error('socket failed');
  const values=mode==='repeat'?[{candidates:[{content:{parts:[{text:'ha'}]}}]},{candidates:[{content:{parts:[{text:'ha'}]},finishReason:'STOP'}]}]:[{error:{message:'upstream error'}}];
  return new Response(values.map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 }});
 const request=()=>fetch(bridge.url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer bridge-token','x-scrollbridge-hosting-provider':'key','content-type':'application/json'},body:JSON.stringify({model:'gemini-test',messages:[{role:'user',content:'hi'}],stream:true})});
 try{
  const reply=await request(),text=await reply.text();assert.equal((text.match(/"content":"ha"/g)||[]).length,2);assert.match(text,/\[DONE\]/);
  mode='network';await assert.rejects(request());
  mode='error';await assert.rejects(async()=>{const r=await request();await r.text();});
 }finally{await bridge.close();}
});
const m=(id,providerId,modelId='gemini-test')=>({id,providerId,modelId,enabled:true});
function data(){
  return validateConfig({hostingProviders:[p('aaa'),p('bbb')],hostingModels:[m('model-a','aaa'),m('model-b','bbb')]});
}
test('hosting IDs remain distinct until unified routing, without duplicate actual model conflicts',()=>{
 const c=data();
 const separate=hostingEntries(c);
 assert.equal(new Set(separate.map(x=>x.name)).size,2);
 assert.equal(separate[0].source,'aaa');
 const unified=validateConfig({...c,unifiedModelRouting:true});
 assert.deepEqual(hostingEntries(unified).map(x=>x.name),['gemini-test','gemini-test']);
 const go=toGoConfig(unified,{keyValues:{},upstreamKey:'',hostingKeys:{aaa:'key-a',bbb:'key-b'}},1,'http://127.0.0.1:12345');
 assert.equal(go.models.filter(x=>x.actual==='gemini-test').length,2);
 assert.deepEqual(go.models.filter(x=>x.actual==='gemini-test').map(x=>x.upstreamId),['aaa','bbb']);
 assert.equal(go.upstreams[1].keyEnv,'SCROLLBRIDGE_HOSTING_BRIDGE_TOKEN');
 assert.equal(JSON.stringify(go).includes('key-a'),false);
});
test('routing order can place second key ahead of first while preserving source identity',()=>{
 const base=data();
 const c=validateConfig({...base,unifiedModelRouting:true,hostingRouteOrders:{'gemini-test':['model-b','model-a']}});
 assert.deepEqual(hostingEntries(c).map(x=>x.id),['model-b','model-a']);
 assert.deepEqual(toGoConfig(c,{keyValues:{},upstreamKey:''}).models.filter(x=>x.actual==='gemini-test').map(x=>x.id),['model-b','model-a']);
 assert.throws(()=>validateConfig({...base,hostingRouteOrders:{'gemini-test':['model-a','model-a']}}),/路由/);
 assert.throws(()=>validateConfig({...base,hostingRouteOrders:{'gemini-test':['model-other']}}),/路由/);
});
test('official HTTPS upstreams only, duplicated model per same account blocked',()=>{
 const base=data();
 assert.throws(()=>validateConfig({...base,hostingProviders:[{...p('aaa'),baseUrl:'http://localhost:8080'}]}),/HTTPS/);
 assert.throws(()=>validateConfig({...base,hostingProviders:[{...p('aaa'),baseUrl:'https://evil.example.com'}]}),/供应商/);
 assert.throws(()=>validateConfig({...base,hostingModels:[m('a','aaa'),m('b','aaa')]}),/重复/);
 assert.ok(publicModelId('aaa','gemini-test').startsWith('host-'));
});
test('model fetching decodes four provider catalogs with pagination and credentials',async()=>{
 const fixture=(data,probe)=>async(url,opts)=>{probe.push({url,headers:opts.headers});return {ok:true,json:async()=>data};};
 const seen=[];
 const providers=[
  [{...p('open'),protocol:'openai',baseUrl:'https://api.openai.com'}, {data:[{id:'gpt-test'}]}, 'gpt-test'],
  [{...p('anth'),protocol:'anthropic',baseUrl:'https://api.anthropic.com'}, {data:[{id:'claude-test'}]}, 'claude-test'],
  [p('google'),{models:[{name:'models/gemini-test',supportedGenerationMethods:['generateContent']}]},'gemini-test'],
  [{...p('vertex'),protocol:'vertex',baseUrl:'https://aiplatform.googleapis.com',projectId:'demo-project',location:'global'}, {publisherModels:[{name:'publishers/google/models/gemini-test'}]},'gemini-test']
 ];
 for(const [provider,payload,expected] of providers){
   const opts={fetcher:fixture(payload,seen),oauthToken:'test-oauth'};
   assert.deepEqual(await fetchHostingModels(provider,'test-api-key',opts),[expected]);
 }
 assert.match(seen[0].headers.Authorization,/test-api-key/);
 assert.equal(seen[1].headers['x-api-key'],'test-api-key');
 assert.equal(seen[2].headers['x-goog-api-key'],'test-api-key');
 assert.equal(seen[3].headers.Authorization,'Bearer test-oauth');
});
test('message conversions preserve roles, output tokens and known protocol envelopes',()=>{
 const open={messages:[{role:'system',content:'polite'},{role:'user',content:'hello'}],max_tokens:20};
 const v=build({...p('v'),protocol:'vertex',projectId:'test-project',location:'global'},'gemini-test','openai',open,false);
 assert.match(v.url.pathname,/projects\/test-project\/locations\/global/);
 assert.equal(v.payload.generationConfig.maxOutputTokens,20);
 assert.equal(v.payload.systemInstruction.parts[0].text,'polite');
 assert.equal(v.payload.contents[0].parts[0].text,'hello');
 const result=convertResponse({candidates:[{content:{parts:[{text:'answer'}]}}]},'google','openai','gemini-test');
 assert.equal(result.choices[0].message.content,'answer');
 assert.throws(()=>normalize({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:'}}]}]},'openai'),/文本/);
});

test('loopback hosting bridge blocks unauthorized access and forwards converted requests to the correct key',async()=>{
 const {startHostedBridge}=require('../lib/hosted-bridge.cjs');
 const provider=p('key1');
 const calls=[];
 const bridge=await startHostedBridge({
  getConfig:()=>({hostingProviders:[provider]}),
  getSecrets:()=>({hostingKeys:{key1:'private-gemini-key'}}),
  token:'random-bridge-test-secret',
  fetcher:async(url,opts)=>{
   calls.push({url,headers:opts.headers,body:JSON.parse(opts.body)});
   return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'from Gemini'}]}}],usageMetadata:{promptTokenCount:4,candidatesTokenCount:2}}),{status:200,headers:{'content-type':'application/json'}});
  }
 });
 try{
  const unauthorized=await fetch(bridge.url+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json','x-scrollbridge-hosting-provider':'key1'},body:'{}'});
  assert.equal(unauthorized.status,401);
  const reply=await fetch(bridge.url+'/v1/chat/completions',{
    method:'POST',headers:{'content-type':'application/json','authorization':'Bearer random-bridge-test-secret','x-scrollbridge-hosting-provider':'key1'},
    body:JSON.stringify({model:'gemini-test',messages:[{role:'user',content:'hello'}],max_tokens:20})
  });
  assert.equal(reply.status,200);
  const result=await reply.json();
  assert.equal(result.choices[0].message.content,'from Gemini');
  assert.equal(calls[0].headers['x-goog-api-key'],'private-gemini-key');
  assert.match(calls[0].url,/\/v1beta\/models\/gemini-test:generateContent/);
  assert.equal(calls[0].body.contents[0].parts[0].text,'hello');
 }finally{await bridge.close();}
});
