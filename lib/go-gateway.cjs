const {spawn}=require('node:child_process');
const {keyDigest}=require('./key-digests.cjs');
const fs=require('node:fs');
const path=require('node:path');
const {StringDecoder}=require('node:string_decoder');
function toGoConfig(c,secrets,version=1){
 const known=new Set(c.knownModels.map(id=>id.toLowerCase()));const disabled=new Set(c.disabledModels);
 return{version,listen:`127.0.0.1:${c.port}`,limits:{requestSeconds:1800,memoryBytes:1073741824},images:c.imagesEnabled,speech:c.speechEnabled,recordRequestIP:c.recordRequestIP,ipBlacklist:c.ipBlacklist,geminiImageCompatibility:c.geminiImageCompatibility,billing:c.billing,
  keys:c.accessKeys.map(k=>({id:k.id,sha256:keyDigest(secrets.keyValues,k.id).toString('hex'),enabled:k.enabled,mode:k.mode,allowed:k.allowed,concurrent:k.concurrent||0,requestLimit:k.requestLimit||0,requestWindowSeconds:k.requestWindowSeconds||3600,outputTokens:k.outputTokens||0,maxOutputTokens:k.maxOutputTokens||0})),
  models:c.modelRules.map(m=>({id:m.id,actual:m.actual,aliases:m.aliases.map(a=>a.name),exposureIds:Object.fromEntries([[m.actual,m.originalId],...m.aliases.map(a=>[a.name,a.id])]),keepOriginal:m.keepOriginal,available:known.has(m.actual.toLowerCase()),enabled:!disabled.has(m.actual.toLowerCase()),...(c.modelRates?.[m.id]?{rates:c.modelRates[m.id]}:{})})),
  upstreams:[{id:'local-proxy',url:c.upstream.replace('://localhost:', '://127.0.0.1:'),auth:'bearer',keyEnv:secrets.upstreamKey?'SCROLLBRIDGE_GO_UPSTREAM_KEY':''}]};
}
async function startGateway(config,secrets,onRecord,options={}){
 const executable=options.executable||path.join(__dirname,'..','vendor','scrollbridge-gateway.exe');
 if(!fs.existsSync(executable))throw new Error('网关文件缺失，请重新安装程序');
 const env={...process.env};delete env.SCROLLBRIDGE_GO_UPSTREAM_KEY;if(secrets.upstreamKey)env.SCROLLBRIDGE_GO_UPSTREAM_KEY=secrets.upstreamKey;
 const child=spawn(executable,['-desktop','-state',options.stateDir||path.join(__dirname,'..','.test-output','go-desktop-state')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let sequence=0,version=0,buffer='',closing=false,exited=false;const pending=new Map();
 function rejectAll(){for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(new Error('网关已退出'))}pending.clear()}
 child.on('error',rejectAll);child.on('exit',()=>{exited=true;rejectAll();if(!closing)options.onExit?.()});child.stdin.on('error',()=>{});
 child.stderr.resume();
 let namedConfig,keyNames;
 const decoder=new StringDecoder('utf8');child.stdout.on('data',b=>{buffer+=decoder.write(b);if(buffer.length>4*1024*1024){child.kill();return};let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);let msg;try{msg=JSON.parse(line)}catch{continue}
  if(msg.event==='record'){const c=options.getConfig?.()||config;if(c!==namedConfig){namedConfig=c;keyNames=new Map(c.accessKeys.map(k=>[k.id,k.name]));}onRecord({...msg.record,keyName:keyNames.get(msg.record.keyId)||''});}
  if(msg.id&&pending.has(msg.id)){const wait=pending.get(msg.id);pending.delete(msg.id);clearTimeout(wait.timer);msg.error?wait.reject(new Error(msg.error)):wait.resolve(msg)}
 }});
 const send=(action,c)=>new Promise((resolve,reject)=>{if(exited){reject(new Error('网关未运行'));return};const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('网关响应超时'))},15000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,action,...(c?{config:c}:{})})+'\n')});
 let lastSignature='';const signature=c=>JSON.stringify({...c,version:0});const initial=toGoConfig(config,secrets,++version);
 try{await send('init',initial);lastSignature=signature(initial)}catch(e){closing=true;child.kill();throw e}
 return{backend:'go',pid:child.pid,refreshPolicy:async()=>{const c=toGoConfig(options.getConfig?.()||config,options.getSecrets?.()||secrets,version+1);const next=signature(c);if(next===lastSignature)return;await send('reload',c);version=c.version;lastSignature=next;},metrics:()=>send('metrics'),close:async()=>{if(exited)return;closing=true;try{await send('stop')}catch{};child.stdin.end();await new Promise(resolve=>{if(exited){resolve();return};const timer=setTimeout(()=>{child.kill();resolve()},3000);child.once('exit',()=>{clearTimeout(timer);resolve()})})}};
}
module.exports={toGoConfig,startGateway};
