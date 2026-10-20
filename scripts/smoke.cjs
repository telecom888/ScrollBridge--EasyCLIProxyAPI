const { _electron: electron } = require('playwright');
const fs = require('node:fs'); const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
  const out = path.resolve('.test-output'); fs.mkdirSync(out,{recursive:true});
  const profile=path.join(out,`profile-${Date.now()}`);
  const env = {...process.env,SCROLLBRIDGE_SMOKE:'1',SCROLLBRIDGE_TEST_DATA:profile}; delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.argv[2] || require('electron');
  const args = process.argv[2] ? [] : ['.'];
  const app = await electron.launch({executablePath,args,env,timeout:30000});let testKey='';
  try {
    const window = await app.firstWindow(); await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show()); await window.waitForSelector('#status-title');
    const errors=[]; window.on('pageerror',e=>errors.push(e.message));
    await window.waitForFunction(()=>!!window.bridge && document.querySelector('#version').textContent === 'v0.1.0');
    assert.equal(await window.locator('#status-title').innerText(),'未连接');
    await window.click('[data-page=settings]'); await window.click('[data-theme=light]'); await window.click('[data-page=connection]'); await window.locator('#toast').waitFor({state:'hidden'}); await window.waitForTimeout(300);
    await window.screenshot({path:path.join(out,'connection-light.png'),fullPage:true});
    await window.click('#theme-toggle');await window.waitForFunction(()=>document.documentElement.dataset.theme==='dark'); await window.locator('#toast').waitFor({state:'hidden'}); await window.waitForTimeout(300);
    await window.screenshot({path:path.join(out,'connection-dark.png'),fullPage:true});
    await window.click('[data-page=settings]');await window.click('[data-theme=light]');
    await window.click('[data-bind-tab=automatic]'); assert.ok(await window.locator('#automatic-binding').isVisible());
    await window.screenshot({path:path.join(out,'settings.png'),fullPage:true});
    await window.click('[data-page=access]');await window.click('[data-tab=anthropic]');assert.match(await window.locator('#example-code').innerText(),/anthropic-version/);
    await window.click('[data-tab=google]');assert.match(await window.locator('#example-code').innerText(),/streamGenerateContent/);
    await window.click('#copy-key');await window.waitForTimeout(200);const key = await app.evaluate(({clipboard})=>clipboard.readText());testKey=key;assert.match(key,/^sb_/);
    const state=await window.evaluate(()=>window.bridge.invoke('snapshot'));assert.ok(!JSON.stringify(state).includes(key));
    const disk=fs.readFileSync(path.join(profile,'settings.json'),'utf8');assert.ok(!disk.includes(key));
    await window.click('#rotate-key');await window.click('#cancel-rotate');
    await window.click('[data-page=records]');assert.match(await window.locator('#requests-table').innerText(),/暂无请求/);
    await window.click('[data-page=connection]');
    // Import only the user-authorized proxy's service address/client key; never log them.
    await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:['D:\\work-09\\代理工具\\EasyCLIProxyAPI-v0.3.44-Windows-amd64\\cpa-core\\config.yaml']});});
    await window.click('#import');await window.waitForFunction(async()=> (await window.bridge.invoke('snapshot')).hasUpstreamKey);await window.waitForFunction(()=>!document.querySelector('#import').disabled);
    await window.click('#check-process');await window.waitForFunction(()=>document.querySelector('#local-diagnostic-summary').textContent.startsWith('正常'));
    const local = await window.evaluate(async()=> (await window.bridge.invoke('snapshot')).localDiagnostic);
    assert.ok(local.ok);assert.equal(local.steps.length,3);assert.ok(local.process.ownedByCore);assert.match(await window.locator('#local-diagnostic-summary').innerText(),/正常/); console.log(`Local CPA verified: ${local.models.length} models, core process and listener healthy (names/credentials omitted)`);
    await window.screenshot({path:path.join(out,'diagnostics.png'),fullPage:true});
    assert.equal(errors.length,0,JSON.stringify(errors));
    fs.writeFileSync(path.join(out,'smoke-report.json'),JSON.stringify({ok:true,localProxy:true,modelCount:local.models.length,rendererErrors:errors,executable:process.argv[2]?'packaged':'development',checks:['navigation','light theme','dark theme','binding form','protocol examples','clipboard','DPAPI encryption','key excluded from renderer snapshot','local proxy import and connectivity','core process exists','port owned by core','diagnostic UI results']},null,2));
    console.log('Electron smoke tests passed');
  } finally {if(testKey)await app.evaluate(({clipboard},key)=>{if(clipboard.readText()===key)clipboard.clear();},testKey).catch(()=>{});await app.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
