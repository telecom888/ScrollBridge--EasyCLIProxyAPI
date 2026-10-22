// Real packaged application, download, Windows helper and restart. Only the
// release transport/current-version are fixtures; no personal profile is used.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {execFileSync,spawn}=require('node:child_process');const {chromium}=require('playwright');const WebSocket=require('ws');
const {Store,SETTINGS_FILE}=require('../lib/store.cjs');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version,release=path.join(root,'release');
const scratch=path.join(root,'.test-output','update-desktop-'+Date.now()),sleep=ms=>new Promise(r=>setTimeout(r,ms));
function run(file,args){return new Promise((resolve,reject)=>{const p=spawn(file,args,{windowsHide:true,stdio:'ignore'});p.once('error',reject);p.once('exit',c=>c===0?resolve():reject(Error('Process failed: '+c)));});}
function installed(){const output=execFileSync('pwsh',['-NoProfile','-Command','@(Get-ChildItem HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall | Get-ItemProperty | Where-Object { $_.DisplayName -like "卷桥*" -or $_.DisplayName -like "ScrollBridge*" } | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true}).trim();return output?JSON.parse(output):[];}
async function until(fn,timeout=120000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const v=await fn();if(v)return v;await sleep(200);}throw Error('Timed out waiting for update');}
async function launchDesktop(executable,env){
 const process=spawn(executable,['--inspect=0','--remote-debugging-port=0'],{env,windowsHide:true,stdio:['ignore','ignore','pipe']});let stderr='';process.stderr.on('data',b=>stderr+=b.toString());
 const nodeUrl=await until(()=>/Debugger listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1],30000);
 const chromeUrl=await until(()=>/DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1],30000);
 const socket=new WebSocket(nodeUrl);await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j);});let next=0;const pending=new Map();
 socket.on('message',data=>{const message=JSON.parse(data);const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(Error(message.error.message)):p.resolve(message.result);}});
 socket.on('close',()=>{for(const p of pending.values())p.reject(Error('Inspector closed'));pending.clear();});
 const evaluate=async expression=>{const id=++next;const result=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value;};
 const browser=await chromium.connectOverCDP(chromeUrl);
 return {process,evaluate,browser,detach:()=>socket.close()};
}
async function stopProfile(profile){
 const file=path.join(profile,'management.json');if(!fs.existsSync(file))return;
 const info=JSON.parse(fs.readFileSync(file));
 // Descriptor belongs solely to this scratch profile, never the user's app.
 try{process.kill(info.pid);}catch{}
 await until(()=>{try{process.kill(info.pid,0);return false;}catch{return true;}},15000);
}
(async()=>{
 fs.mkdirSync(scratch,{recursive:true});
 const metadata=JSON.parse(fs.readFileSync(path.join(release,'scrollbridge-update.json'))),requests=[];
 const assets=Object.values(metadata.assets).map(a=>({name:a.name,size:a.size,browser_download_url:`https://github.com/telecom888/ScrollBridge--EasyCLIProxyAPI/releases/download/v${version}/${a.name}`}));
 assets.push({name:'scrollbridge-update.json',browser_download_url:`https://github.com/telecom888/ScrollBridge--EasyCLIProxyAPI/releases/download/v${version}/scrollbridge-update.json`});
 const server=http.createServer((req,res)=>{
  if(req.url==='/releases/latest'){res.setHeader('content-type','application/json');res.end(JSON.stringify({tag_name:'v'+version,assets}));return;}
  const name=decodeURIComponent(req.url.slice(1));
  if(!['scrollbridge-update.json',...Object.values(metadata.assets).map(a=>a.name)].includes(name)){res.writeHead(404);res.end();return;}
  requests.push(name);const file=path.join(release,name);res.setHeader('content-length',fs.statSync(file).size);fs.createReadStream(file).pipe(res);
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const store=new Store(path.join(scratch,'fixture')),state=store.load();state.config.refreshModelsOnStartup=false;state.config.launchAtLogin=false;store.save(state.config,state.secrets);const original=fs.readFileSync(store.filename);
 const build=JSON.parse(fs.readFileSync(path.join(root,'.test-output','desktop-builds.json'))).go;
 const shortcutDirs=JSON.parse(execFileSync('pwsh',['-NoProfile','-Command','@([Environment]::GetFolderPath("Desktop"),[Environment]::GetFolderPath("Programs")) | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true}));
 const shortcuts=shortcutDirs.map(d=>{const file=path.join(d,'卷桥.lnk');return {file,data:fs.existsSync(file)?fs.readFileSync(file):null};});
 let app,profile,installDirectory;
 const results=[];
 try{
  for(const kind of process.env.UPDATE_SMOKE_KIND?[process.env.UPDATE_SMOKE_KIND]:['zip','portable','installer']){
   profile=path.join(scratch,kind+' profile');const target=path.join(scratch,kind+' app');fs.mkdirSync(target,{recursive:true});
   let executable;
   if(kind==='installer'){
    assert.deepEqual(installed(),[],'test must not replace a real installed edition');installDirectory=target;
    await run(path.join(release,metadata.assets.installer.name),['/S','/currentuser','/D='+target]);executable=path.join(target,'卷桥.exe');
   }else if(kind==='zip'){
    await run('tar',['-xf',path.join(release,metadata.assets.zip.name),'-C',target]);executable=path.join(target,'卷桥.exe');
   }else{
    // The old launcher has already been tested separately. Launch its packed
    // desktop directly with the same outer-exe environment to inspect IPC.
    executable=path.join(build,'win-unpacked','卷桥.exe');fs.copyFileSync(path.join(release,metadata.assets.portable.name),path.join(target,'renamed.exe'));
   }
   fs.copyFileSync(store.filename,path.join(target,SETTINGS_FILE));
   const env={...process.env,SCROLLBRIDGE_TEST_PROFILE:profile,SCROLLBRIDGE_SMOKE:'1'};
   for(const k of ['SCROLLBRIDGE_TEST_DATA','SCROLLBRIDGE_SMOKE_EXIT','ELECTRON_RUN_AS_NODE','PORTABLE_EXECUTABLE_FILE','PORTABLE_EXECUTABLE_DIR','PORTABLE_EXECUTABLE_APP_FILENAME'])delete env[k];
   if(kind==='portable'){env.PORTABLE_EXECUTABLE_FILE=path.join(target,'renamed.exe');env.PORTABLE_EXECUTABLE_DIR=target;}
   app=await launchDesktop(executable,env);const page=await until(()=>app.browser.contexts()[0]?.pages()[0]);await page.waitForFunction(()=>typeof snapshot!=='undefined' && !!snapshot);
   await app.evaluate(`(()=>{const {app,net}=process.getBuiltinModule('node:module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron');app.getVersion=()=> '0.0.1';const request=net.request.bind(net);net.request=options=>{const parsed=new URL(options.url);return request({...options,url:${JSON.stringify(base)}+(parsed.hostname==='api.github.com'?'/releases/latest':'/'+parsed.pathname.split('/').at(-1))});};})()`);
   await page.click('[data-page=settings]');
   assert.equal(await page.locator('#update-panel').count(),1);
   await page.click('#check-update');await page.waitForFunction(()=>snapshot.update.phase==='available');
   assert.equal(await page.locator('#download-update').isVisible(),true);
   assert.equal(await page.locator('#update-panel').evaluate(panel=>panel.previousElementSibling.querySelector('h2').textContent),'外观');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   if(kind==='zip'){
    const png=await app.evaluate(`(async()=>{const {BrowserWindow}=process.getBuiltinModule('node:module').createRequire(process.resourcesPath+'/app.asar/package.json')('electron');return (await BrowserWindow.getAllWindows()[0].capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64');})()`);
    fs.writeFileSync(path.join(scratch,'settings-update.png'),Buffer.from(png,'base64'));
   }
   const oldPid=app.process.pid;
   await page.click('#download-update');
   console.log('Download requested:',kind);
   // Node's inspector keeps shutdown pending until the observer disconnects.
   app.detach();
   const result=await until(()=>{
    const jobs=path.join(profile,'updates');if(!fs.existsSync(jobs))return false;
    for(const name of fs.readdirSync(jobs)){const file=path.join(jobs,name,'result.json');if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
    return false;
   },180000);
   assert.equal(result.status,'success',JSON.stringify({kind,result}));
   const descriptor=JSON.parse(fs.readFileSync(path.join(profile,'management.json')));
   assert.equal(descriptor.appVersion,version);assert.notEqual(descriptor.pid,oldPid);
   assert.deepEqual(fs.readFileSync(path.join(target,SETTINGS_FILE)),original,'encrypted credentials must remain byte-identical');
   assert.ok(requests.includes(metadata.assets[kind].name));
   await stopProfile(profile);app=null;
   if(kind==='installer'){
    const uninstall=fs.readdirSync(target).find(n=>/^Uninstall.*\.exe$/i.test(n));await run(path.join(target,uninstall),['/S','/currentuser']);
    await until(()=>!fs.existsSync(path.join(target,'卷桥.exe')));assert.deepEqual(installed(),[]);installDirectory=null;
   }
   results.push({kind,download:true,checksum:true,restart:true,configPreserved:true});console.log('Desktop update passed:',kind);
  }
  fs.writeFileSync(path.join(scratch,'report.json'),JSON.stringify({version,results},null,2));console.log('Report: '+scratch);
 }finally{
  if(app){app.detach();try{app.process.kill();}catch{}}if(profile)await stopProfile(profile).catch(()=>{});
  if(installDirectory){const un=fs.readdirSync(installDirectory).find(n=>/^Uninstall.*\.exe$/i.test(n));if(un)await run(path.join(installDirectory,un),['/S','/currentuser']).catch(()=>{});}
  for(const {file,data}of shortcuts){if(data)fs.writeFileSync(file,data);else if(fs.existsSync(file))fs.unlinkSync(file);}
  server.closeAllConnections();await new Promise(r=>server.close(r));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
