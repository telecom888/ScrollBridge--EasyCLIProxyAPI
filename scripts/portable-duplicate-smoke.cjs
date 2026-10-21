const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {fileURLToPath}=require('node:url');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitExit(child){const end=Date.now()+15000;while(child.exitCode===null&&child.signalCode===null&&Date.now()<end)await pause(100);assert.equal(child.exitCode,0,'portable launcher must exit normally');}
(async()=>{for(const suffix of ['', '-beta']){
 const version=require('../package.json').version,root=path.resolve('.test-output',`portable-duplicate-${suffix||'normal'}-${Date.now()}`);
 fs.mkdirSync(root,{recursive:true});const exe=path.join(root,'duplicate.exe');fs.copyFileSync(path.resolve(`release/ScrollBridge-${version}${suffix}-win-x64.exe`),exe);
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const env={...process.env,SCROLLBRIDGE_TEST_DATA:path.join(root,'profile'),SCROLLBRIDGE_SMOKE:'1'};
 for(const name of ['ELECTRON_RUN_AS_NODE','SCROLLBRIDGE_SMOKE_EXIT','SCROLLBRIDGE_TEST_PROFILE','SCROLLBRIDGE_GATEWAY_ENGINE'])delete env[name];
 const first=spawn(exe,[`--remote-debugging-port=${port}`],{env,windowsHide:true,stdio:'ignore'});let failure;first.on('error',e=>failure=e);let browser;
 try{
  const deadline=Date.now()+30000;
  while(!browser&&Date.now()<deadline&&!failure){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000})}catch{await pause(200)}}
  if(failure)throw failure;assert.ok(browser,'first portable must expose its actual renderer');
  const page=browser.contexts()[0].pages()[0];await page.waitForFunction(()=>!!snapshot);
  const resources=path.dirname(path.dirname(path.dirname(fileURLToPath(page.url()))));
  const files=['cloudflared.exe',...(suffix?['scrollbridge-gateway.exe']:[])].map(f=>path.join(resources,'vendor',f));
  for(const file of files)assert.equal(fs.existsSync(file),true,'bundled resource must initially exist');
  const second=spawn(exe,[],{env,windowsHide:true,stdio:'ignore'});second.on('error',e=>failure=e);await waitExit(second);if(failure)throw failure;
  assert.equal(first.exitCode,null,'duplicate launch must leave the original process running');
  for(const file of files)assert.equal(fs.existsSync(file),true,'duplicate launcher must not delete resources of the running instance');
  assert.equal(await page.evaluate(()=>!!snapshot),true);
  await page.close();await waitExit(first);
  console.log('Duplicate portable launch preserves running resources:',suffix||'normal');
 }finally{
  if(browser){for(const context of browser.contexts())for(const page of context.pages())await page.close().catch(()=>{});await browser.close().catch(()=>{});}
  if(first.exitCode===null&&first.signalCode===null)first.kill();
 }
}})().catch(e=>{console.error(e.message);process.exitCode=1});
