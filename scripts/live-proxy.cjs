const fs=require('node:fs');const path=require('node:path');const {parseCPA}=require('../lib/import-cpa.cjs');const {startGateway}=require('../lib/gateway.cjs');const {createAccessKey}=require('../lib/config.cjs');
(async()=>{
  const imported=parseCPA(fs.readFileSync('../代理工具/EasyCLIProxyAPI-v0.3.44-Windows-amd64/cpa-core/config.yaml','utf8'));
  const {validateConfig}=require('../lib/config.cjs');const {newKey,syncModels}=require('../lib/policy.cjs');const {fetchModels}=require('../lib/models.cjs');
  const key=createAccessKey(),identity=newKey();const secrets={keyValues:{[identity.id]:key},upstreamKey:imported.upstreamKey,tunnelToken:''};
  const config=syncModels(validateConfig({upstream:imported.upstream,port:18449,accessKeys:[identity]}),await fetchModels(imported,secrets));const records=[];
  const g=await startGateway(config,secrets,r=>records.push(r));
  try{
    const base='http://127.0.0.1:18449';const modelResponse=await fetch(base+'/v1/models',{headers:{authorization:`Bearer ${key}`}});const models=(await modelResponse.json()).data;
    const model=models.find(m=>/flash/i.test(m.id)&&!/(image|preview|thinking)/i.test(m.id))||models.find(m=>!/(image|thinking)/i.test(m.id));if(!model)throw new Error('No text model available');
    const results=[];
    const cases=[
      {name:'OpenAI',path:'/v1/chat/completions',headers:{authorization:`Bearer ${key}`},body:{model:model.id,messages:[{role:'user',content:'Reply OK.'}],max_tokens:16,stream:true}},
      {name:'Anthropic',path:'/v1/messages',headers:{'x-api-key':key,'anthropic-version':'2023-06-01'},body:{model:model.id,messages:[{role:'user',content:'Reply OK.'}],max_tokens:16,stream:true}},
      {name:'Google',path:`/v1beta/models/${encodeURIComponent(model.id)}:streamGenerateContent?alt=sse`,headers:{'x-goog-api-key':key},body:{contents:[{role:'user',parts:[{text:'Reply OK.'}]}],generationConfig:{maxOutputTokens:16}}}
    ];
    for(const c of cases){const start=Date.now();const r=await fetch(base+c.path,{method:'POST',headers:{...c.headers,'content-type':'application/json'},body:JSON.stringify(c.body),signal:AbortSignal.timeout(60000)});const text=await r.text();const result={protocol:c.name,status:r.status,sse:r.headers.get('content-type')?.includes('text/event-stream')||false,hasData:/data:/.test(text),durationMs:Date.now()-start};results.push(result);console.log(JSON.stringify(result));}
    fs.mkdirSync('.test-output',{recursive:true});fs.writeFileSync(path.join('.test-output','live-proxy-report.json'),JSON.stringify({results,allPassed:results.every(r=>r.status===200&&r.sse&&r.hasData)},null,2));
    if(!results.every(r=>r.status===200&&r.sse&&r.hasData))process.exitCode=1;
  }finally{await g.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
