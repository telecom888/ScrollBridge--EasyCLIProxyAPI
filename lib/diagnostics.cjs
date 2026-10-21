const {execFile}=require('node:child_process');const {promisify}=require('node:util');const exec=promisify(execFile);
const {validateConfig}=require('./config.cjs');
async function inspectProcesses(port) {
  if(process.platform!=='win32')return{available:false,coreRunning:false,guiRunning:false,listening:false,ownedByCore:false,pid:null};
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('端口无效');
  // Fixed process names and validated integer port; never query command lines or secrets.
  const script = `$ErrorActionPreference='Stop'; $core=@(Get-CimInstance Win32_Process -Filter "Name='cli-proxy-api.exe'" | Select-Object -ExpandProperty ProcessId); $gui=@(Get-CimInstance Win32_Process -Filter "Name='EasyCLIProxyAPI.exe'" | Select-Object -ExpandProperty ProcessId); $listeners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); @{corePids=$core;guiRunning=($gui.Count -gt 0);listenerPids=$listeners} | ConvertTo-Json -Compress`;
  const args=['-NoLogo','-NoProfile','-NonInteractive','-Command',script];const options={windowsHide:true,timeout:12000,maxBuffer:65536,encoding:'utf8'};
  const{stdout}=await exec('pwsh.exe',args,options).catch(e=>{if(e.code==='ENOENT')return exec('powershell.exe',args,options);throw e;});
  const data=JSON.parse(stdout.replace(/^\uFEFF/,''));const core=Array.isArray(data.corePids)?data.corePids:[];const listeners=Array.isArray(data.listenerPids)?data.listenerPids:[];const pid=listeners.find(p=>core.includes(p));
  return{available:true,coreRunning:core.length>0,guiRunning:!!data.guiRunning,listening:listeners.length>0,ownedByCore:!!pid,pid:pid||core[0]||null};
}
function failure(error) {
  if(error.name==='TimeoutError'||error.name==='AbortError')return'请求超时';
  const code=error.cause?.code||error.code||'';
  if(/CERT|TLS|SSL/.test(code))return'TLS 证书校验失败';
  if(/ENOTFOUND|EAI_AGAIN/.test(code))return'DNS 解析失败';
  if(/ECONNREFUSED/.test(code))return'连接被拒绝';
  return'网络连接失败';
}
async function localCheck(config,secrets,{fetcher=fetch,scanner=inspectProcesses}={}) {
  const c=validateConfig(config);const u=new URL(c.upstream);const port=Number(u.port||(u.protocol==='https:'?443:80));const checkedAt=new Date().toISOString();
  let processInfo;try{processInfo=await scanner(port);}catch{processInfo={available:false,coreRunning:false,guiRunning:false,listening:false,ownedByCore:false,pid:null};}
  let httpStatus=0;let apiOK=false;let models=[];let detail='';
  try{const r=await fetcher(`${c.upstream}/v1/models`,{headers:{authorization:`Bearer ${secrets.upstreamKey||''}`},signal:AbortSignal.timeout(12000),redirect:'error'});httpStatus=r.status;if(r.ok){const data=await r.json();apiOK=Array.isArray(data.data);models=apiOK?data.data.map(m=>m.id).filter(m=>typeof m==='string').slice(0,80):[];if(!apiOK)detail='接口没有返回有效模型列表';}else detail=r.status===401?'本地代理密钥不正确':`模型接口 HTTP ${r.status}`;}catch(e){detail=failure(e);}
  const ok=processInfo.available&&processInfo.coreRunning&&processInfo.ownedByCore&&apiOK;
  const steps=[{name:'核心进程',ok:processInfo.available&&processInfo.coreRunning,detail:processInfo.available?(processInfo.coreRunning?`PID ${processInfo.pid}`:'未启动'):'无法读取进程状态'},{name:'服务端口',ok:processInfo.ownedByCore,detail:processInfo.ownedByCore?`${port} 由核心进程监听`:processInfo.listening?`${port} 由其他进程占用`:`${port} 未监听`},{name:'模型接口',ok:apiOK,detail:apiOK?`HTTP ${httpStatus}，共 ${models.length} 个模型`:detail}];
  steps[0].facts=processInfo.available&&processInfo.coreRunning?[['进程 ID',processInfo.pid]]:undefined;
  steps[1].facts=[['端口',port],['状态',processInfo.ownedByCore?'核心进程监听':processInfo.listening?'由其他进程占用':'未监听']];
  if(apiOK)steps[2].facts=[['响应',`HTTP ${httpStatus}`],['模型',`${models.length} 个`]];
  return{ok,checkedAt,process:processInfo,httpStatus,models,steps,message:ok?`代理运行正常，提供 ${models.length} 个模型。`:steps.filter(s=>!s.ok).map(s=>`${s.name}：${s.detail}`).join('；')};
}
async function publicCheck(config,secrets,{fetcher=fetch,model,keyId=config.diagnosticKeyId}={}) {
  const c=validateConfig(config);if(!c.hostname)throw new Error('请先设置域名');const base=`https://${c.hostname}`;const checkedAt=new Date().toISOString();const steps=[];const started=Date.now();
  const key=c.accessKeys.find(row=>row.id===keyId && row.enabled);if(!key || !secrets.keyValues?.[key.id])throw new Error('请选择可用的检测密钥');
  const signal=AbortSignal.timeout(60000);const request=(url,options={})=>fetcher(url,{...options,headers:{authorization:`Bearer ${secrets.keyValues[key.id]}`,...options.headers},signal,redirect:'error'});
  try{
    const health=await request(`${base}/healthz`);
    if(!health.ok){steps.push({name:'HTTPS 与鉴权',ok:false,detail:`HTTP ${health.status}${health.status===401?'，访问密钥不正确':''}`});return result(false);}
    const info=await health.json();if(info.service!=='scrollbridge'){steps.push({name:'HTTPS 与鉴权',ok:false,detail:'域名未指向卷桥网关'});return result(false);}steps.push({name:'HTTPS 与鉴权',ok:true,detail:'证书有效，网关已响应',facts:[['证书','有效'],['网关','已响应']]});
    const list=await request(`${base}/v1/models`);if(!list.ok){steps.push({name:'公开模型接口',ok:false,detail:`HTTP ${list.status}`});return result(false);}
    const data=await list.json();const models=Array.isArray(data.data)?data.data.filter(m=>typeof m.id==='string'):[];
    const actualNames=new Map(require('./policy.cjs').entries(c).map(row=>[row.name,row.actual]));
    const hint=item=>actualNames.get(item.id) || item.id;
    const selected=model?models.find(m=>m.id===model):models.find(m=>/flash/i.test(hint(m))&&!/(image|thinking)/i.test(hint(m)))||models.find(m=>!/(image|embedding|audio|thinking)/i.test(hint(m)));
    if(!selected){steps.push({name:'公开模型接口',ok:false,detail:model?`所选模型 ${model} 未在外部模型列表中开放`:'未找到可检测的文本模型'});return result(false);}steps.push({name:'公开模型接口',ok:true,detail:`HTTP ${list.status}`});
    const r=await request(`${base}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:selected.id,messages:[{role:'user',content:'Reply OK.'}],max_tokens:64,stream:true})});
    if(!r.ok){await r.body?.cancel();steps.push({name:'模型流式请求',ok:false,detail:`HTTP ${r.status}`});return result(false);}
    if(!r.headers.get('content-type')?.includes('text/event-stream')){await r.body?.cancel();steps.push({name:'模型流式请求',ok:false,detail:'未返回 SSE 响应'});return result(false);}
    const reader=r.body.getReader();const decoder=new TextDecoder();let buffer='',bytes=0,sawChoice=false,sawDone=false,sawError=false;
    try{while(true){const{value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1024*1024)throw new Error('检测响应过大');buffer+=decoder.decode(value,{stream:true});const lines=buffer.split(/\r?\n/);buffer=lines.pop();for(const line of lines){if(!line.startsWith('data:'))continue;const text=line.slice(5).trim();if(text==='[DONE]'){sawDone=true;continue;}try{const event=JSON.parse(text);if(event.error)sawError=true;if(Array.isArray(event.choices)&&event.choices.some(c=>c.delta?.content||c.delta?.reasoning_content||c.finish_reason))sawChoice=true;}catch{}}}}finally{await reader.cancel().catch(()=>{});}
    const ok=sawChoice&&sawDone&&!sawError;steps.push({name:'模型流式请求',ok,detail:ok?`${selected.id} 已完成流式响应`:'流式响应不完整或包含错误',facts:ok?[['模型',selected.id],['响应','流式传输完成']]:undefined});return result(ok);
  }catch(e){steps.push({name:steps.length?'公开请求':'HTTPS 连接',ok:false,detail:failure(e)});return result(false);}
  function result(ok){return{ok,checkedAt,steps,ms:Date.now()-started,message:ok?'公网 HTTPS 与模型请求正常':steps.filter(s=>!s.ok).map(s=>`${s.name}：${s.detail}`).join('；')};}
}
module.exports={inspectProcesses,localCheck,publicCheck};
