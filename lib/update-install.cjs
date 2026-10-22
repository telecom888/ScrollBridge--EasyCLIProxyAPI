const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
function safeFiles(files){
 if(!Array.isArray(files) || !files.length || files.length>10000)throw Error('安装文件清单无效');
 const seen=new Set();return files.map(value=>{
  if(typeof value!=='string' || !value || /[:\\]/.test(value) || value.startsWith('/') || value.split('/').some(p=>!p || p==='.' || p==='..') || value.toLowerCase()==='scrollbridge.json' || seen.has(value.toLowerCase()))throw Error('安装文件路径无效');
  seen.add(value.toLowerCase());return value;
 });
}
function createInstallJob(payload,{executable,configDirectory,profileDirectory,resumeConnection,pid=process.pid}){
 const targetDirectory=path.dirname(executable),oldFiles=payload.kind==='portable'?[path.basename(executable)]:safeFiles(JSON.parse(fs.readFileSync(path.join(targetDirectory,'resources','update-files.json'))).files);
 if(payload.kind==='installer')for(const file of fs.readdirSync(targetDirectory).filter(n=>/^Uninstall .*\.exe$/i.test(n)))oldFiles.push(file);
 const job={schemaVersion:1,id:payload.id,kind:payload.kind,version:payload.version,filename:payload.filename,sha256:payload.sha256,size:payload.size,parentPid:pid,targetDirectory,executable,configFile:path.join(configDirectory,'scrollbridge.json'),profileDirectory,resumeConnection,oldFiles};
 const filename=path.join(payload.directory,'job.json'),helper=path.join(payload.directory,'install.ps1'),launcher=path.join(payload.directory,'launch.ps1');
 fs.copyFileSync(path.join(__dirname,'update-worker.ps1'),helper);fs.writeFileSync(filename,JSON.stringify(job),{mode:0o600});
 // Start-Process gives Windows PowerShell its own hidden console. Merely
 // detaching with libuv can make PowerShell exit without executing its file.
 fs.writeFileSync(launcher,'param($JobFile)\n$ErrorActionPreference="Stop"\n$directory=Split-Path -Parent $JobFile\n$arguments=\'-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\'+(Join-Path $directory "install.ps1")+\'" -JobFile "\'+$JobFile+\'"\'\nStart-Process -FilePath "$env:WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardOutput (Join-Path $directory "worker.log") -RedirectStandardError (Join-Path $directory "worker-error.log")\n');
 return {filename,helper,launcher,job};
}
async function launchInstallJob(plan){
 const log=fs.openSync(path.join(path.dirname(plan.filename),'launcher.log'),'a');let child;
 try{
  child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',plan.launcher,'-JobFile',plan.filename],{windowsHide:true,stdio:['ignore',log,log]});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 }finally{fs.closeSync(log);}
 const deadline=Date.now()+15000,ready=path.join(path.dirname(plan.filename),'worker-ready.json');
 while(!fs.existsSync(ready)){
  if((child.exitCode!==null && child.exitCode!==0) || Date.now()>deadline){child.kill();throw Error('更新助手未能启动，当前程序保持运行，请查看更新任务中的 worker-error.log');}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 child.unref();
}
module.exports={safeFiles,createInstallJob,launchInstallJob};
