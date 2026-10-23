const cp=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const dns=require('node:dns');
const {StringDecoder}=require('node:string_decoder');

function networkFingerprint(interfaces=os.networkInterfaces(),servers=dns.getServers()){
 const addresses=Object.entries(interfaces).flatMap(([name,rows])=>(rows||[]).filter(row=>!row.internal).map(row=>[name,row.family,row.address,row.scopeid||0,row.cidr||''].join('|'))).sort();
 return JSON.stringify([addresses,[...servers].sort()]);
}
function startTunnel({executable,token,protocol,onState,onLog},{fingerprint=networkFingerprint}={}){
 if(!fs.existsSync(executable))throw Error('未找到 cloudflared，请重新安装完整应用');
 if(!/^[A-Za-z0-9_+/=-]{50,8192}$/.test(token||''))throw Error('隧道令牌格式不正确，请只粘贴 eyJ 开头的令牌');
 let current,stopped=false,fatal=false,recovering,restartTimer,healthTimer,stableTimer,networkTimer,changeTimer,stopPromise;
 let attempts=0,lastNetwork,lastState,lastDetail;try{lastNetwork=fingerprint();}catch{}
 // Auto mode needs time to exhaust QUIC retries and fall back to HTTP/2.
 const startupTimeout=protocol==='auto'?180000:60000;
 const report=(state,detail='')=>{if(state===lastState&&detail===lastDetail)return;lastState=state;lastDetail=detail;onState(state,detail);};
 const clearHealth=()=>{clearTimeout(healthTimer);clearTimeout(stableTimer);healthTimer=stableTimer=undefined;};
 const clearTimers=()=>{clearHealth();clearTimeout(restartTimer);clearTimeout(changeTimer);clearInterval(networkTimer);restartTimer=changeTimer=networkTimer=undefined;};
 const active=entry=>!stopped&&!fatal&&current===entry&&!entry.retiring&&!entry.exited;
 const waitExit=(entry,ms)=>new Promise(resolve=>{
  if(entry.exited)return resolve(true);
  let timer;const done=()=>{clearTimeout(timer);entry.child.off('exit',done);resolve(true);};
  timer=setTimeout(()=>{entry.child.off('exit',done);resolve(false);},ms);entry.child.once('exit',done);
 });
 function terminate(entry){
  if(!entry||entry.exited)return Promise.resolve();
  if(entry.termination)return entry.termination;
  entry.retiring=true;
  entry.termination=(async()=>{
   entry.child.kill();
   if(await waitExit(entry,3000))return;
   entry.child.kill('SIGKILL');
   if(!await waitExit(entry,1000))throw Error('旧隧道进程未退出，已暂停自动重建');
  })();
  return entry.termination;
 }
 function fail(message){fatal=true;clearTimers();report('error',message);}
 function scheduleRecovery(reason,immediate=false){
  if(stopped||fatal||recovering)return;
  if(restartTimer){if(!immediate)return;clearTimeout(restartTimer);}
  clearHealth();report('reconnecting',reason);
  const delay=immediate?0:[1000,3000,10000,30000,60000][Math.min(attempts++,4)];
  restartTimer=setTimeout(()=>{
   restartTimer=undefined;
   recovering=(async()=>{
    onLog('正在重建隧道：'+reason);
    await terminate(current);
    if(stopped||fatal)return;
    current=undefined;launch();
   })().catch(error=>{if(!stopped)fail(error.message);}).finally(()=>{recovering=undefined;});
  },delay);
 }
 function armHealth(entry,ms){
  if(healthTimer)return;
  healthTimer=setTimeout(()=>{healthTimer=undefined;if(active(entry)&&!entry.connections.size)scheduleRecovery('隧道连接长时间未恢复');},ms);
 }
 function handleLine(entry,line){
  if(!active(entry))return;
  line=line.replaceAll(token,'[redacted]').replace(/eyJ[A-Za-z0-9_+/=-]{40,}/g,'[redacted]').slice(0,1000);
  onLog(line);
  if(/Provided Tunnel token is not valid|invalid tunnel (?:token|secret)|failed to (?:parse|decode) (?:tunnel )?token/i.test(line)){
   fail('隧道令牌无效，请检查配置');void terminate(entry).catch(()=>{});return;
  }
  const index=line.match(/connIndex=(\d+)/)?.[1];
  if(/\bRegistered tunnel connection\b/i.test(line)){
   const wasDisconnected=!entry.connections.size;entry.connections.add(index||'0');
   clearTimeout(healthTimer);healthTimer=undefined;clearTimeout(restartTimer);restartTimer=undefined;
   if(wasDisconnected){
    stableTimer=setTimeout(()=>{stableTimer=undefined;if(active(entry)&&entry.connections.size)attempts=0;},60000);
    report('connected');
   }
  }else if(/Unregistered tunnel connection|Connection terminated|failed to serve tunnel connection|Serve tunnel error|Unable to establish connection with Cloudflare edge/i.test(line)){
   const wasConnected=entry.connections.size>0;
   if(index!==undefined)entry.connections.delete(index);
   if(!entry.connections.size){
    clearTimeout(stableTimer);stableTimer=undefined;report('reconnecting','正在恢复隧道连接');
    if(wasConnected){clearTimeout(healthTimer);healthTimer=undefined;armHealth(entry,30000);}
    else armHealth(entry,startupTimeout);
   }
  }
 }
 function launch(){
  // Fresh process: resolve edge addresses again and recreate transports.
  // Token stays in the child environment, never command line or plaintext disk.
  const child=cp.spawn(executable,['tunnel','--no-autoupdate','--loglevel','info','--protocol',protocol,'run'],{windowsHide:true,env:{...process.env,TUNNEL_TOKEN:token},stdio:['ignore','pipe','pipe']});
  const entry={child,connections:new Set(),retiring:false,exited:false};current=entry;
  const consume=()=>{
   const decoder=new StringDecoder('utf8');let buffer='';
   return chunk=>{buffer+=decoder.write(chunk);const lines=buffer.split(/\r?\n/);buffer=lines.pop().slice(-16384);for(const line of lines)handleLine(entry,line);};
  };
  child.stdout.on('data',consume());child.stderr.on('data',consume());
  child.on('error',()=>{const wasActive=active(entry);if(!child.pid)entry.exited=true;if(wasActive)fail('无法启动隧道进程');});
  child.on('exit',code=>{
   const wasActive=active(entry);
   entry.exited=true;
   if(wasActive){entry.connections.clear();scheduleRecovery(`隧道进程已退出 (${code})，正在重新连接`);}
  });
  armHealth(entry,startupTimeout);
 }
 launch();
 networkTimer=setInterval(()=>{
  if(stopped||fatal)return;
  let next;try{next=fingerprint();}catch{return;}
  if(next===lastNetwork)return;lastNetwork=next;clearTimeout(changeTimer);
  changeTimer=setTimeout(()=>{changeTimer=undefined;scheduleRecovery('检测到网络配置变化',true);},4000);
 },3000);networkTimer.unref();
 return{stop:()=>{
  if(stopPromise)return stopPromise;
  stopped=true;clearTimers();
  stopPromise=(async()=>{await recovering;await terminate(current);current=undefined;})();
  return stopPromise;
 }};
}
module.exports={startTunnel,networkFingerprint};
