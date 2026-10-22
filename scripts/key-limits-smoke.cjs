const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..');
(async()=>{
 const scratch=path.join(root,'.test-output','key-limits-'+Date.now()),profile=path.join(scratch,'profile');fs.mkdirSync(scratch,{recursive:true});
 let hold=false,release,entered;
 const upstream=http.createServer(async(req,res)=>{
  for await(const chunk of req){};
  res.setHeader('content-type','application/json');
  if(req.method==='GET'){res.end('{"data":[{"id":"text-real"}]}');return;}
  if(hold){entered?.();await new Promise(resolve=>release=resolve);}
  res.end('{"model":"text-real","choices":[]}');
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const bootstrap=`const {app}=require('electron');app.getAppPath=()=>${JSON.stringify(root)};app.setLoginItemSettings=()=>{};const {Store}=require(${JSON.stringify(path.join(root,'lib/store.cjs'))}),load=Store.prototype.load;Store.prototype.load=function(){const s=load.call(this);s.config.refreshModelsOnStartup=false;return s;};require(${JSON.stringify(path.join(root,'lib/tunnel.cjs'))}).startTunnel=o=>{queueMicrotask(()=>o.onState('connected'));return{stop:async()=>{}}};require(${JSON.stringify(path.join(root,'electron/main.cjs'))});`;
 fs.writeFileSync(path.join(scratch,'package.json'),JSON.stringify({name:'scrollbridge-limits-test',version:'0.3.8',main:'bootstrap.cjs'}));fs.writeFileSync(path.join(scratch,'bootstrap.cjs'),bootstrap);
 const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile,SCROLLBRIDGE_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;delete env.SCROLLBRIDGE_GATEWAY_ENGINE;
 let app;
 try{
  app=await electron.launch({executablePath:require('electron'),args:[scratch],env});const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>typeof snapshot!=='undefined' && !!snapshot);
  assert.equal(await page.evaluate(()=>snapshot.features.keyLimits),true);
  await page.evaluate(async cfg=>{await window.bridge.invoke('save',{config:cfg,tunnelToken:'fake-test-token'});await window.bridge.invoke('refreshModels');render(await window.bridge.invoke('snapshot'));},{upstream:`http://127.0.0.1:${upstream.address().port}`,port,hostname:'fixture.invalid'});
  await page.click('[data-page=keys]');await page.click('#new-key');await page.fill('#key-name','手机');await page.check('#key-concurrent-enabled');await page.fill('#key-concurrent','1');await page.check('#key-rate-enabled');await page.fill('#key-window-value','30');await page.selectOption('#key-window-unit','60');await page.fill('#key-request-limit','1');await page.locator('#key-form button[type=submit]').click();await page.waitForFunction(()=>!pending && snapshot.keys.length===2);
  const key=await page.evaluate(()=>snapshot.keys.find(k=>k.name==='手机'));assert.equal(key.concurrent,1);assert.equal(key.requestLimit,1);assert.equal(key.requestWindowSeconds,1800);
  await page.evaluate(async()=>{await window.bridge.invoke('saveKey',{name:'电脑'});render(await window.bridge.invoke('snapshot'));});
  const other=await page.evaluate(()=>snapshot.keys.find(k=>k.name==='电脑'));
  const reveal=id=>page.evaluate(id=>window.bridge.invoke('revealKey',{id}),id);
  const phone=(await reveal(key.id)).value,desktop=(await reveal(other.id)).value;
  await page.evaluate(()=>window.bridge.invoke('start'));await page.waitForFunction(()=>snapshot.status==='connected');
  const send=value=>fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer '+value,'content-type':'application/json'},body:'{"model":"text-real"}'});
  hold=true;const waiting=new Promise(resolve=>entered=resolve),first=send(phone);await waiting;
  assert.equal((await send(phone)).status,429);hold=false;assert.equal((await send(desktop)).status,200);release();assert.equal((await first).status,200);assert.equal((await send(phone)).status,429);
  await page.waitForFunction(()=>snapshot.records.length===4);
  await page.click('[data-page=records]');await page.selectOption('#record-filter-mode','single');await page.selectOption('#record-key-single',key.id);assert.equal(await page.locator('#requests-table tbody tr').count(),3);
  await page.selectOption('#record-filter-mode','multiple');assert.match(await page.locator('#requests-table').innerText(),/暂无请求/);await page.click('#record-selection-summary');await page.check(`#record-key-choices input[value="${key.id}"]`);await page.check(`#record-key-choices input[value="${other.id}"]`);assert.equal(await page.locator('#requests-table tbody tr').count(),4);
  await page.selectOption('#record-filter-mode','all');assert.equal(await page.locator('#requests-table tbody tr').count(),4);
  const discovery=JSON.parse(fs.readFileSync(path.join(profile,'management.json'),'utf8'));
  const response=await fetch(discovery.baseUrl+`/api/v1/logs?keyId=${key.id}`,{headers:{authorization:'Bearer '+discovery.token}});assert.equal((await response.json()).data.items.length,3);
  await page.evaluate(()=>window.bridge.invoke('stop'));
  await page.click('[data-page=keys]');await page.locator(`[data-key-edit="${key.id}"]`).click();assert.equal(await page.inputValue('#key-window-value'),'30');assert.equal(await page.inputValue('#key-window-unit'),'60');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,700));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const capture=async name=>{
   await page.evaluate(()=>document.getAnimations().forEach(a=>a.finish()));
   const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));
   fs.writeFileSync(path.join(scratch,name),Buffer.from(png,'base64'));
  };
  await capture('keys-light.png');await page.evaluate(async()=>{await window.bridge.invoke('save',{config:{theme:'dark'}});render(await window.bridge.invoke('snapshot'));});await capture('keys-dark.png');
  await page.click('[data-page=records]');await page.selectOption('#record-filter-mode','multiple');await capture('records-dark.png');
  assert.deepEqual(errors,[]);
  await app.close();app=null;
  app=await electron.launch({executablePath:require('electron'),args:[scratch],env});const restored=await app.firstWindow();await restored.waitForFunction(()=>typeof snapshot!=='undefined' && !!snapshot);
  assert.deepEqual(await restored.evaluate(id=>{const k=snapshot.keys.find(k=>k.id===id);return[k.concurrent,k.requestLimit,k.requestWindowSeconds];},key.id),[1,1,1800]);
  assert.equal((await restored.evaluate(id=>window.bridge.invoke('revealKey',{id}),key.id)).value,phone);
  console.log('Go mainline UI/API, key concurrency and period limits, single/multi/all log filters, persistence passed. Screenshots:',scratch);
 }finally{hold=false;release?.();if(app)await app.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
