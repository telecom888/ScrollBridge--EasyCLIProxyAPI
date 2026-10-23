const {_electron:electron}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),http=require('node:http'),{once}=require('node:events');
const root=path.resolve(__dirname,'..');
(async()=>{
 const scratch=path.join(root,'.test-output','request-records-'+Date.now()),profile=path.join(scratch,'profile');fs.mkdirSync(scratch,{recursive:true});
 const up=http.createServer((req,res)=>{req.resume();res.setHeader('content-type','application/json');res.end('{"data":[{"id":"text"}]}');});up.listen(0,'127.0.0.1');await once(up,'listening');
 const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const bootstrap=`const {app,dialog,clipboard}=require('electron');app.getAppPath=()=>${JSON.stringify(root)};global.exports=[];dialog.showMessageBox=async()=>({response:1});dialog.showSaveDialog=async()=>{const file=${JSON.stringify(scratch)}+'/export-'+global.exports.length+'.'+(global.exportJSON?'json':'csv');global.exports.push(file);return {canceled:!!global.cancelExport,filePath:file};};require(${JSON.stringify(path.join(root,'lib','tunnel.cjs'))}).startTunnel=o=>{queueMicrotask(()=>o.onState('connected'));return {stop:async()=>{}}};require(${JSON.stringify(path.join(root,'electron','main.cjs'))});`;
 fs.writeFileSync(path.join(scratch,'package.json'),JSON.stringify({name:'records-test',version:require('../package.json').version,main:'bootstrap.cjs'}));fs.writeFileSync(path.join(scratch,'bootstrap.cjs'),bootstrap);
 const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile,SCROLLBRIDGE_GATEWAY_ENGINE:'go'};delete env.ELECTRON_RUN_AS_NODE;
 let app;
 try{
  const launch=()=>electron.launch({executablePath:require('electron'),args:[scratch],env});app=await launch();let page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>!!snapshot);
  await page.evaluate(async values=>{render(await call('save',{config:{upstream:values.upstream,port:values.port,hostname:'fixture.invalid',recordRequestIP:true},tunnelToken:'disposable-fixture-token'}));render(await call('start'));},{upstream:'http://127.0.0.1:'+up.address().port,port});
  const send=async(ip='2001:db8::1')=>{const r=await fetch(`http://127.0.0.1:${port}/robots.txt`,{headers:{'CF-Connecting-IP':ip}});await r.text();return r.status;};
  assert.equal(await send(),401);await page.waitForFunction(()=>snapshot.records.some(r=>r.requestIP==='2001:db8::1'));
  await page.click('[data-page=records]');assert.match(await page.locator('#requests-table').innerText(),/请求IP/);
  await page.locator('[data-request-ip]').first().click({button:'right'});await page.click('#block-request-ip');await page.waitForFunction(()=>snapshot.config.ipBlacklist.includes('2001:db8::1'));assert.equal(await send(),403);await page.waitForFunction(()=>snapshot.records.some(r=>r.reason==='IP 已屏蔽'));
  await page.click('[data-page=settings]');await page.click('#recordRequestIP');await page.waitForFunction(()=>!pending&&!snapshot.config.recordRequestIP);assert.equal(await send(),403);
  await page.click('#manage-blacklist');await page.locator('[data-remove-ip]').click();await page.waitForFunction(()=>!pending&&snapshot.config.ipBlacklist.length===0);await page.click('#close-blacklist');assert.equal(await send(),401);
  assert.equal(await send('2001:db8::99'),401);
  // A hidden column must not discard IPs: snapshots hide them while the main
  // process keeps the original rows for the next display toggle.
  assert.ok(await page.evaluate(()=>snapshot.records.every(r=>!Object.hasOwn(r,'requestIP'))));
  await page.click('#recordRequestIP');await page.waitForFunction(()=>!pending&&snapshot.config.recordRequestIP);
  await page.waitForFunction(()=>snapshot.records.some(r=>r.requestIP==='2001:db8::99'&&r.status===401));
  await page.click('[data-page=records]');await page.selectOption('#record-limit','1000');await page.waitForFunction(()=>snapshot.config.requestRecordLimit===1000&&!pending);
  assert.ok((await page.locator('#requests-table').innerText()).includes('2001:db8::99'));
  await Promise.all(Array.from({length:205},()=>send('192.0.2.2')));await page.waitForFunction(()=>snapshot.records.length>=209);assert.equal(await page.locator('#requests-table tbody tr').count(),100);await page.click('#record-next');assert.equal(await page.locator('#requests-table tbody tr').count(),100);
  await page.click('#export-records');await page.locator('#export-records-form button[type=submit]').click();await page.waitForFunction(()=>!pending);const exported=await app.evaluate(()=>global.exports.at(-1));const csv=fs.readFileSync(exported,'utf8');assert.ok(csv.includes('192.0.2.2'));assert.ok(csv.split('\r\n').length>200);
  const fixture=await page.evaluate(()=>({recordCount:snapshot.records.length,keys:snapshot.keys}));
  await page.evaluate(async()=>{await call('save',{config:{recordRequestIP:false}});render(await call('snapshot'));});
  await app.evaluate(()=>global.exportJSON=true);await page.click('#export-records');await page.selectOption('#export-format','json');await page.locator('#export-records-form button[type=submit]').click();await page.waitForFunction(()=>!pending);const json=JSON.parse(fs.readFileSync(await app.evaluate(()=>global.exports.at(-1)),'utf8'));assert.equal(json.length,fixture.recordCount);assert.ok(json.every(r=>!Object.hasOwn(r,'requestIP')));
  const key=await page.evaluate(()=>call('revealKey',{id:snapshot.keys[0].id}));const named=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{authorization:'Bearer '+key.value,'CF-Connecting-IP':'192.0.2.3'}});await named.text();assert.equal(named.status,200);await page.waitForFunction(id=>snapshot.records.some(r=>r.keyId===id),key.id);
  await page.selectOption('#record-filter-mode','single');await page.selectOption('#record-key-single',key.id);await page.click('#export-records');await page.locator('#export-records-form button[type=submit]').click();await page.waitForFunction(()=>!pending);assert.equal(JSON.parse(fs.readFileSync(await app.evaluate(()=>global.exports.at(-1)),'utf8')).length,1);
  await page.click('#export-records');await page.selectOption('#export-scope','all');await page.locator('#export-records-form button[type=submit]').click();await page.waitForFunction(()=>!pending);assert.ok(JSON.parse(fs.readFileSync(await app.evaluate(()=>global.exports.at(-1)),'utf8')).length>200);
  await app.evaluate(()=>global.cancelExport=true);await page.click('#export-records');await page.locator('#export-records-form button[type=submit]').click();await page.waitForFunction(()=>!pending);assert.equal(fs.existsSync(await app.evaluate(()=>global.exports.at(-1))),false);await page.click('#cancel-export');await app.evaluate(()=>global.cancelExport=false);await page.selectOption('#record-filter-mode','all');
  await page.selectOption('#record-limit','custom');await page.fill('#record-limit-custom','100');await page.locator('#record-limit-form button').click();await page.waitForFunction(()=>!pending&&snapshot.config.requestRecordLimit===100);assert.equal(await page.evaluate(()=>snapshot.records.length),100);
  await page.evaluate(async()=>{render(await call('save',{config:{recordRequestIP:true}}));});
  await page.click('[data-page=settings]');await page.waitForTimeout(250);await page.locator('#page-settings .panel').filter({has:page.getByRole('heading',{name:'连接',exact:true})}).screenshot({path:path.join(scratch,'settings-light.png')});await page.click('[data-page=records]');await page.waitForTimeout(250);await page.screenshot({path:path.join(scratch,'records-light.png')});await page.click('#theme-toggle');await page.waitForFunction(()=>!pending);await page.waitForTimeout(250);await page.screenshot({path:path.join(scratch,'records-dark.png')});
  assert.deepEqual(errors,[]);await app.close();app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>!!snapshot);assert.equal(await page.evaluate(()=>snapshot.records.length),0);assert.equal(await page.evaluate(()=>snapshot.config.requestRecordLimit),100);assert.equal(await page.evaluate(()=>snapshot.config.updateSource),'mirror');
  console.log('Always-record IP, display toggle, blacklist, pagination, export, retention and restart passed:',scratch);
 }finally{if(app)await app.close();up.closeAllConnections();await new Promise(r=>up.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
