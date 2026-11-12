const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{once}=require('node:events');
const {validateConfig,createAccessKey}=require('../lib/config.cjs'),{newKey}=require('../lib/policy.cjs');
const {startHostedBridge}=require('../lib/hosted-bridge.cjs'),{startGateway}=require('../lib/go-gateway.cjs');
(async()=>{
 const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const consumer=newKey('fixture'),value=createAccessKey();
 const protocols=['openai','anthropic','google','vertex'],urls=['https://api.openai.com','https://api.anthropic.com','https://generativelanguage.googleapis.com','https://aiplatform.googleapis.com'];
 let config=validateConfig({port,accessKeys:[consumer],hostingProviders:protocols.map((protocol,i)=>({id:'source-'+i,name:protocol,protocol,baseUrl:urls[i],enabled:true,...(protocol==='vertex'?{projectId:'fixture-project',location:'global'}:{})})),hostingModels:protocols.map((_,i)=>({id:'model-'+i,providerId:'source-'+i,modelId:'fixture-'+i,enabled:true}))});
 const secrets={keyValues:{[consumer.id]:value},upstreamKey:'',hostingKeys:Object.fromEntries(protocols.map((_,i)=>['source-'+i,'fixture-private']))};
 const seen=[];const bridge=await startHostedBridge({getConfig:()=>config,getSecrets:()=>secrets,token:'fixture-bridge',fetcher:async(url)=>{seen.push(url);return Response.json(url.includes('openai')?{choices:[{message:{content:'OK'}}]}:url.includes('anthropic')?{content:[{type:'text',text:'OK'}]}:{candidates:[{content:{parts:[{text:'OK'}]}}]});}});
 const directory=path.resolve('.test-output','hosted-gateway-'+Date.now());fs.mkdirSync(directory,{recursive:true});let gateway;
 try{
  gateway=await startGateway(config,secrets,()=>{},{stateDir:directory,getConfig:()=>config,getSecrets:()=>secrets,hostingUrl:bridge.url,hostingToken:'fixture-bridge'});
  const headers={authorization:'Bearer '+value,'content-type':'application/json'};
  const list=await fetch('http://127.0.0.1:'+port+'/v1/models',{headers});const models=(await list.json()).data;assert.equal(models.length,4);
  for(const model of models){const r=await fetch('http://127.0.0.1:'+port+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:model.id,messages:[{role:'user',content:'test'}]})});assert.equal(r.status,200);assert.equal((await r.json()).choices[0].message.content,'OK');}
  assert.equal(seen.length,4);assert.ok(seen.some(url=>url.includes('/projects/fixture-project/locations/global/')));
  config=validateConfig({...config,showModelSources:true});await gateway.refreshPolicy();
  console.log('Four hosted provider configurations: real Go init, catalog, bridge generation and reload passed');
 }finally{if(gateway)await gateway.close();await bridge.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
