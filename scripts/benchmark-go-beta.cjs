// Reproducible loopback comparison. All credentials and upstreams are disposable.
const http=require('node:http');
const {spawn,fork}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

if(process.argv[2]==='--upstream'){
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const b=JSON.parse(raw||'{}');
  res.setHeader('Content-Type',b.stream?'text/event-stream':'application/json');
  if(!b.stream){res.end(JSON.stringify({model:b.model,choices:[{message:{content:'hello'}}],usage:{prompt_tokens:20,completion_tokens:5}}));return;}
  let stopped=false;res.on('close',()=>{stopped=true});
  const began=performance.now();
  for(let i=0;i<24&&!stopped;i++){
   while(!stopped&&performance.now()<began+i*10)await sleep(Math.min(5,began+i*10-performance.now()));
   if(!res.write(`data: ${JSON.stringify({model:b.model,choices:[{delta:{content:'x'.repeat(256)}}]})}\n\n`))await Promise.race([once(res,'drain'),once(res,'close')]);
  }
  if(!stopped)res.end('data: {"usage":{"prompt_tokens":20,"completion_tokens":100}}\n\ndata: [DONE]\n\n');
 });server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
}else if(process.argv[2]==='--node'){
 process.on('message',async message=>{
  if(message.start){const {startGateway}=require('../lib/gateway.cjs');let config=message.config;const secrets=message.secrets;await startGateway(config,secrets,()=>{},{getConfig:()=>config,getSecrets:()=>secrets});process.send({ready:true});}
 });
}else if(require.main===module){main().catch(e=>{console.error(e);process.exitCode=1})}

async function unusedPort(){const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
function child(mode){return fork(__filename,[mode],{silent:true,windowsHide:true})}
async function message(c){return (await once(c,'message'))[0]}
async function readyGo(c){let tail='';const timeout=setTimeout(()=>c.kill(),10000);for await(const b of c.stderr){tail+=b.toString();if(tail.includes('Go gateway beta ready')){clearTimeout(timeout);return};if(tail.length>100000)throw new Error('Go startup did not become ready')};clearTimeout(timeout);throw new Error('Go beta startup failed')}
function fixture(upstream,port,key,nKeys,nModels){
 const {newKey,syncModels}=require('../lib/policy.cjs');const {DEFAULTS}=require('../lib/config.cjs');
 let config={...DEFAULTS,upstream,port,accessKeys:[],knownModels:[],modelRules:[],disabledModels:[],diagnosticKeyId:''};
 const secrets={keyValues:{},upstreamKey:'',tunnelToken:''};
 for(let i=0;i<nKeys;i++){const k=newKey('Test '+i);config.accessKeys.push(k);secrets.keyValues[k.id]=i===nKeys-1?key:crypto.randomBytes(32).toString('base64url')}
 config=syncModels(config,Array.from({length:nModels},(_,i)=>`model-${i}`));
 config.modelRules.forEach((r,i)=>{r.aliases=[{id:crypto.randomUUID(),name:`alias-${i}`}];r.keepOriginal=true});
 const go={version:1,listen:`127.0.0.1:${port}`,keys:config.accessKeys.map(k=>({id:k.id,sha256:crypto.createHash('sha256').update(secrets.keyValues[k.id]).digest('hex'),enabled:true,mode:'all'})),models:config.modelRules.map(r=>({id:r.id,actual:r.actual,aliases:r.aliases.map(a=>a.name),keepOriginal:true,enabled:true})),upstreams:[{id:'mock',url:upstream}]};
 return{config,secrets,go,model:`alias-${nModels-1}`};
}
async function sampleRSS(pids){
 // Native Windows working set for both runtimes, sampled by the same observer.
 const cmd=`while($true){Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { [Console]::WriteLine(($_.Id.ToString()+","+$_.WorkingSet64.ToString())) }; Start-Sleep -Milliseconds 200}`;
 const c=spawn('pwsh',['-NoLogo','-NoProfile','-Command',cmd],{windowsHide:true,stdio:['ignore','pipe','ignore']});let text='';const rows=[];c.stdout.on('data',b=>{text+=b;let i;while((i=text.indexOf('\n'))>=0){const line=text.slice(0,i).trim();text=text.slice(i+1);const[p,r]=line.split(',').map(Number);if(p&&r)rows.push({at:Date.now(),pid:p,rss:r})}});return{rows,stop:()=>c.kill()};
}
const percentile=(a,p)=>a.length?[...a].sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*p))]:null;
async function workload(url,key,model,{count,concurrency,stream},agent){
 const results=[];let next=0;const began=performance.now();
 async function request(){const started=performance.now();const body=JSON.stringify({model,stream,messages:[{role:'user',content:'test only'}]});return new Promise(resolve=>{
  let first=null,bytes=0;const req=http.request(url+'/v1/chat/completions',{method:'POST',agent,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{res.on('data',b=>{if(first===null)first=performance.now()-started;bytes+=b.length});res.on('end',()=>resolve({status:res.statusCode,ms:performance.now()-started,ttft:first,bytes}));res.on('error',()=>resolve({status:0,ms:performance.now()-started,ttft:first,bytes}))});req.setTimeout(15000,()=>req.destroy());req.on('error',()=>resolve({status:0,ms:performance.now()-started,ttft:first,bytes}));req.end(body);
 })}
 await Promise.all(Array.from({length:concurrency},async()=>{while(next++<count)results.push(await request())}));const seconds=(performance.now()-began)/1000;const successes=results.filter(r=>r.status===200);const statuses={};for(const r of results)statuses[r.status]=(statuses[r.status]||0)+1;
 return{count,concurrency,stream,seconds,statuses,successRPS:successes.length/seconds,p50:percentile(successes.map(r=>r.ms),.5),p95:percentile(successes.map(r=>r.ms),.95),p99:percentile(successes.map(r=>r.ms),.99),ttftP50:percentile(successes.map(r=>r.ttft),.5),ttftP99:percentile(successes.map(r=>r.ttft),.99),bytes:successes.reduce((n,r)=>n+r.bytes,0)};
}
async function metrics(url,key){return new Promise((resolve,reject)=>{http.get(url+'/metrics',{headers:{Authorization:'Bearer '+key}},res=>{let s='';res.on('data',b=>s+=b);res.on('end',()=>{try{resolve(JSON.parse(s))}catch(e){reject(e)}})}).on('error',reject)})}
async function main(){
 const output=path.join(root,'.test-output','go-beta-benchmark');await fs.mkdir(output,{recursive:true});const exe=path.join(root,'release','ScrollBridge-Go-Beta-0.1.0-win-x64.exe');await fs.access(exe);
 const up=child('--upstream');const children=[up];const report={at:new Date().toISOString(),exeSHA256:crypto.createHash('sha256').update(await fs.readFile(exe)).digest('hex'),node:process.version,platform:process.platform,arch:process.arch,cpu:require('node:os').cpus()[0].model,scenarios:[],notes:['Loopback mock; no provider calls or Cloudflare.','RSS is Windows working set sampled every 200 ms; warm-up included.','HTTP 200 throughput excludes 429 and failures; success latency only.','Billing disabled in both runtimes; no fsync cost is included.','SSE mock emits 24 events against an absolute 10 ms schedule; OS timer overshoot remains possible.']};
 let sampler;
 try{
  const upstream='http://127.0.0.1:'+(await message(up)).port;
  for(const profile of[{name:'desktop',keys:1,models:8},{name:'large-policy',keys:200,models:100}]){
   const nodePort=await unusedPort(),goPort=await unusedPort(),adminPort=await unusedPort();const key='sb_'+crypto.randomBytes(32).toString('base64url');const adminKey=crypto.randomBytes(32).toString('hex');const f=fixture(upstream,nodePort,key,profile.keys,profile.models);f.go.listen=`127.0.0.1:${goPort}`;const configFile=path.join(output,profile.name+'.json');await fs.writeFile(configFile,JSON.stringify(f.go));
   const nc=child('--node');children.push(nc);const np=message(nc);nc.send({start:true,config:f.config,secrets:f.secrets});await np;
   const gc=spawn(exe,['-config',configFile,'-state',path.join(output,profile.name+'-state'),'-admin',`127.0.0.1:${adminPort}`],{windowsHide:true,env:{...process.env,SCROLLBRIDGE_ADMIN_KEY:adminKey},stdio:['ignore','ignore','pipe']});children.push(gc);await readyGo(gc);gc.stderr.resume();sampler=await sampleRSS([nc.pid,gc.pid]);
   const agents={node:new http.Agent({keepAlive:true,maxSockets:128}),go:new http.Agent({keepAlive:true,maxSockets:128})};const urls={node:`http://127.0.0.1:${nodePort}`,go:`http://127.0.0.1:${goPort}`};
   for(const impl of['node','go'])await workload(urls[impl],key,f.model,{count:100,concurrency:8,stream:false},agents[impl]);
   const cases=profile.name==='desktop'?[{name:'json',count:1200,concurrency:16,stream:false},{name:'sse-16',count:192,concurrency:16,stream:true},{name:'sse-64',count:256,concurrency:64,stream:true},{name:'overload-128',count:512,concurrency:128,stream:true}]:[{name:'json',count:1200,concurrency:16,stream:false}];
   for(const scenario of cases){for(let round=0;round<3;round++){for(const impl of round%2?['go','node']:['node','go']){const start=Date.now();const row=await workload(urls[impl],key,f.model,scenario,agents[impl]);await sleep(250);const samples=sampler.rows.filter(r=>r.pid===(impl==='go'?gc.pid:nc.pid)&&r.at>=start);row.rssPeak=samples.length?Math.max(...samples.map(r=>r.rss)):null;row.rssLast=samples.at(-1)?.rss??null;report.scenarios.push({profile:profile.name,name:scenario.name,round,impl,...row});console.log(profile.name,scenario.name,round,impl,JSON.stringify(row));}}}
   // Repeated streams with the same concurrency; look for failure and post-idle cleanup.
   if(profile.name==='desktop')for(const impl of['node','go']){const row=await workload(urls[impl],key,f.model,{count:1024,concurrency:32,stream:true},agents[impl]);report.scenarios.push({profile:profile.name,name:'soak-1024',impl,...row})}
   await sleep(500);report.scenarios.push({profile:profile.name,name:'go-idle-metrics',...(await metrics(`http://127.0.0.1:${adminPort}`,adminKey))});for(const a of Object.values(agents))a.destroy();sampler.stop();sampler=null;nc.kill();gc.kill();await sleep(500);
  }
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2));console.log('Results:',path.join(output,'results.json'));
 }finally{sampler?.stop();for(const c of children)c.kill()}
}
