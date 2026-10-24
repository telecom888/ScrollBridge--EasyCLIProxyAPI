const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
(async()=>{
 const scratch=path.join(root,'.test-output','overlays-'+Date.now());fs.mkdirSync(scratch,{recursive:true});
 fs.writeFileSync(path.join(scratch,'package.json'),JSON.stringify({name:'isolated-overlay-test',main:'bootstrap.cjs'}));
 fs.writeFileSync(path.join(scratch,'bootstrap.cjs'),`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(scratch,'profile'))});app.whenReady().then(()=>{const window=new BrowserWindow({width:1160,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});window.loadFile(${JSON.stringify(path.join(root,'ui','index.html'))});});`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;let app;
 try{
  app=await electron.launch({executablePath:require('electron'),args:[scratch],env});const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'no-preference'});
  await page.waitForFunction(()=>typeof openDialog==='function'&&typeof initRecordsUI==='function');
  await page.evaluate(()=>{const trigger=document.createElement('button');trigger.id='overlay-trigger';trigger.textContent='测试入口';document.body.append(trigger);trigger.focus();$('key-confirm-title').textContent='删除密钥？';$('key-confirm-message').textContent='删除后，该密钥将无法继续访问模型。';openDialog($('key-confirm-dialog'));});
  await page.waitForFunction(()=>$('key-confirm-dialog').dataset.overlayPhase==='opening');
  await page.waitForFunction(()=>Number(getComputedStyle($('key-confirm-dialog')).opacity)>0);
  const during=await page.evaluate(()=>{const d=$('key-confirm-dialog'),s=getComputedStyle(d);return{open:d.open,opacity:Number(s.opacity),transform:s.transform,shade:s.getPropertyValue('--overlay-shade'),backdrop:getComputedStyle(d,'::backdrop').backgroundColor};});
  assert.equal(during.open,true);assert.ok(during.opacity>0&&during.opacity<=1);assert.notEqual(during.transform,'none');
  assert.equal(await page.evaluate(()=>new DOMMatrix(getComputedStyle($('key-confirm-dialog')).transform).a),1);
  await page.waitForFunction(()=>$('key-confirm-dialog').dataset.overlayPhase==='open');
  await page.click('[data-close=key-confirm-dialog]');assert.equal(await page.evaluate(()=>$('key-confirm-dialog').open),true);
  await page.waitForFunction(()=>!$('key-confirm-dialog').open);assert.equal(await page.evaluate(()=>document.activeElement.id),'overlay-trigger');
  // Close a partially-open dialog, then reopen during exit; an old completion
  // must not close the new generation or leave an inert backdrop behind.
  await page.evaluate(()=>openDialog($('alias-dialog')));await page.waitForTimeout(50);
  await page.evaluate(()=>{closeDialog($('alias-dialog'));openDialog($('alias-dialog'));});await page.waitForFunction(()=>$('alias-dialog').dataset.overlayPhase==='open');await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>$('alias-dialog').open),true);
  const before=await page.locator('#alias-dialog').boundingBox();
  await page.evaluate(()=>{const box=document.createElement('div');box.id='overlay-height-fixture';box.style.height='100px';$('alias-rows').append(box);});
  await page.waitForTimeout(60);const between=await page.locator('#alias-dialog').boundingBox();await page.waitForTimeout(220);const after=await page.locator('#alias-dialog').boundingBox();
  assert.ok(after.height>before.height+90);assert.ok(between.height>=before.height&&between.height<=after.height+1);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!$('alias-dialog').open);
  await page.evaluate(()=>{$('request-body-content').textContent='模型请求内容预览\n{ "model": "text", "input": "你好" }';openDialog($('request-body-dialog'));});await page.waitForFunction(()=>$('request-body-dialog').dataset.overlayPhase==='open');await page.screenshot({path:path.join(scratch,'overlay-light.png')});
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:path.join(scratch,'overlay-dark.png')});await page.click('#close-request-body');await page.waitForFunction(()=>!$('request-body-dialog').open&&$('request-body-content').textContent==='');
  await page.evaluate(()=>{const menu=$('request-ip-menu');menu.style.left='300px';menu.style.top='100px';menu.showPopover();positionPopoverOrigin(menu,{left:300,right:330,top:60,bottom:90});});await page.waitForTimeout(40);
  assert.ok(await page.evaluate(()=>$('request-ip-menu').getAnimations().length>0));await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!$('request-ip-menu').matches(':popover-open'));await page.waitForTimeout(160);assert.equal(await page.locator('#request-ip-menu').isVisible(),false);
  // A nested confirmation returns focus to its parent; reusing it must not
  // retain the previous confirmation result when Escape cancels the next one.
  await page.evaluate(()=>{openDialog($('ip-blacklist-dialog'));window.confirmResult=null;void confirmDialog({title:'屏蔽 IP？',message:'测试确认'}).then(result=>window.confirmResult=result);});
  await page.click('#confirm-action-accept');await page.waitForFunction(()=>window.confirmResult===true);
  assert.equal(await page.evaluate(()=>$('ip-blacklist-dialog').open),true);
  await page.evaluate(()=>{window.confirmResult=null;void confirmDialog({title:'再次确认？',message:'测试取消'}).then(result=>window.confirmResult=result);});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>window.confirmResult===false);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!$('ip-blacklist-dialog').open);
  assert.deepEqual(errors,[]);console.log('Overlay opening, interrupt/reopen, focus, Escape, content resize, themes and popover dismissal passed:',scratch);console.log('Backdrop sample:',during.backdrop);
 }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
