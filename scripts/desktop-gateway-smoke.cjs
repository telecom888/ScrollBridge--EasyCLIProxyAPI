const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..');
async function port(){const s=http.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function run(engine){
 const scratch=path.join(root,'.test-output',`desktop-${engine}-${Date.now()}`),profile=path.join(scratch,'profile');fs.mkdirSync(scratch,{recursive:true});
 const upstream=http.createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);res.setHeader('content-type','application/json');if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'text-real'},{id:'gemini-3.1-flash-image'}]}));return};const m=JSON.parse(Buffer.concat(chunks));res.end(JSON.stringify({model:m.model,choices:[{message:{content:'OK'}}],usage:{prompt_tokens:1000,completion_tokens:100,prompt_tokens_details:{cached_tokens:200},cost:'99'}}));});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const gatewayPort=await port();
 const bootstrap=`const {app,clipboard}=require('electron');app.getAppPath=()=>${JSON.stringify(root)};app.setLoginItemSettings=()=>{};let copied='';clipboard.writeText=t=>copied=t;clipboard.readText=()=>copied;global.testGoChildren=[];const cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=function(file,...args){const child=spawn.call(this,file,...args);if(String(file).endsWith('scrollbridge-gateway.exe'))global.testGoChildren.push(child);return child;};require(${JSON.stringify(path.join(root,'lib','tunnel.cjs'))}).startTunnel=options=>{queueMicrotask(()=>options.onState('connected'));return{stop:async()=>{}}};require(${JSON.stringify(path.join(root,'electron','main.cjs'))});`;
 fs.writeFileSync(path.join(scratch,'package.json'),JSON.stringify({name:'scrollbridge-isolated-smoke',version:require('../package.json').version,main:'bootstrap.cjs'}));fs.writeFileSync(path.join(scratch,'bootstrap.cjs'),bootstrap);
 const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile,SCROLLBRIDGE_GATEWAY_ENGINE:engine};delete env.ELECTRON_RUN_AS_NODE;
 let app;const launch=()=>electron.launch({executablePath:require('electron'),args:[scratch],env});
 try{
  app=await launch();let page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!snapshot);
  await page.evaluate(async cfg=>{await window.bridge.invoke('save',{config:cfg,upstreamKey:'disposable-upstream-key',tunnelToken:'disposable-token-not-used'});await window.bridge.invoke('refreshModels');render(await window.bridge.invoke('snapshot'));},{upstream:`http://127.0.0.1:${upstream.address().port}`,port:gatewayPort,hostname:'fixture.invalid'});
  for(const name of ['access','keys','catalog','records','settings','connection']){
   const animation=await page.evaluate(name=>{page(name);const a=document.querySelector('.page-heading').getAnimations().find(a=>a.playState==='running');return{frames:a?.effect.getKeyframes().map(k=>({opacity:k.opacity,transform:k.transform})),duration:a?.effect.getTiming().duration,subtitle:document.body.textContent.includes('管理客户端的访问权限')}},name);
   assert.equal(animation.duration,200);assert.equal(animation.frames[0].transform,'translateY(6px)');assert.equal(animation.subtitle,false);
  }
  await page.click('[data-page=keys]');await page.locator('[data-key-copy]').first().click();await page.waitForFunction(()=>!pending);const secret=await app.evaluate(({clipboard})=>clipboard.readText());
  await page.evaluate(async()=>{await window.bridge.invoke('start');render(await window.bridge.invoke('snapshot'))});await page.waitForFunction(()=>snapshot.status==='connected'&&snapshot.gatewayRunning);
  assert.equal(await app.evaluate(()=>global.testGoChildren.length),engine==='go'?1:0);
  await page.waitForTimeout(150); // Drain the initial tunnel log batch before counting request events.
  await page.evaluate(()=>{globalThis.recordEvents=0;globalThis.fullEvents=0;globalThis.managementRenders=0;window.bridge.onRecords(data=>{if(Object.keys(data).some(k=>!['records','logs'].includes(k)))throw Error('Unexpected log payload');recordEvents++;});window.bridge.onUpdate(()=>fullEvents++);const original=renderManagement;renderManagement=function(){managementRenders++;return original();};});
  const call=async(model='text-real')=>{const r=await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'PRIVATE_PROMPT_MUST_NOT_BE_PERSISTED'}]})});const body=await r.json();return{status:r.status,body}};
  assert.equal((await call()).status,200);await page.waitForFunction(()=>snapshot.records.some(r=>r.model==='text-real'));
  assert.deepEqual(await page.evaluate(()=>({logs:recordEvents>0,full:fullEvents,management:managementRenders})),{logs:true,full:0,management:0});
  await page.click('[data-page=records]');assert.match(await page.locator('#requests-table').innerText(),/text-real/);
  await page.click('[data-page=connection]');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].hide());
  assert.equal((await call()).status,200);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>snapshot.records.length),1,'hidden desktop must not process request events');
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();});
  await page.waitForFunction(()=>snapshot.records.length===2);
  const identity=await page.evaluate(()=>snapshot.keys[0]);
  await page.evaluate(key=>window.bridge.invoke('saveKey',{id:key.id,name:'重命名后'}),identity);
  assert.equal((await call()).status,200);await page.waitForFunction(()=>snapshot.records[0].keyName==='重命名后');
  const ruleID=await page.evaluate(()=>snapshot.config.modelRules.find(r=>r.actual==='text-real').id);
  await page.evaluate(async id=>{await window.bridge.invoke('saveAliases',{id,aliases:[{name:'chat'}],keepOriginal:false});render(await window.bridge.invoke('snapshot'));},ruleID);
  assert.equal((await call('chat')).body.model,'chat');assert.equal((await call('text-real')).status,404);
  await page.evaluate(async()=>{await window.bridge.invoke('setModelAccess',{model:'text-real',enabled:false});render(await window.bridge.invoke('snapshot'))});assert.equal((await call('chat')).status,403);
  assert.ok(!fs.readFileSync(path.join(profile,'scrollbridge.json'),'utf8').includes(secret));assert.ok(!JSON.stringify(await page.evaluate(()=>snapshot)).includes(secret));
  if(engine==='go'){const pid=await app.evaluate(()=>global.testGoChildren.at(-1).pid);await app.evaluate((_,pid)=>process.kill(pid),pid);await page.waitForFunction(()=>snapshot.status==='error'&&!snapshot.gatewayRunning)}else await page.evaluate(()=>window.bridge.invoke('stop'));
  assert.deepEqual(errors,[]);await page.click('[data-page=keys]');await page.waitForTimeout(250);await page.screenshot({path:path.join(scratch,'keys-light.png')});await page.click('#theme-toggle');await page.waitForFunction(()=>!pending);await page.screenshot({path:path.join(scratch,'keys-dark.png')});
  await app.close();app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>!!snapshot);assert.equal(await page.evaluate(()=>snapshot.config.modelRules.find(r=>r.actual==='text-real').aliases[0].name),'chat');assert.equal(await page.locator('#version').innerText(),'v'+require('../package.json').version)
  fs.writeFileSync(path.join(scratch,'report.json'),JSON.stringify({ok:true,engine,errors,checks:['consistent heading animation','removed subtitle','real gateway process and requests','live aliases and global ACL','encrypted persistence','unexpected Go exit','light/dark UI','restart persistence']},null,2));console.log('Desktop gateway contract passed:',engine,scratch);
 }finally{if(app)await app.close();upstream.closeAllConnections();await new Promise(r=>upstream.close(r))}
}
(async()=>{for(const engine of process.argv[2]==='--both'?['node','go']:[process.argv[2] || 'go'])await run(engine)})().catch(e=>{console.error(e);process.exitCode=1});
