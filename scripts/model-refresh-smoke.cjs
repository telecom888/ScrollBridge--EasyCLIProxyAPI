const {_electron:electron}=require('playwright');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {once}=require('node:events');
const assert=require('node:assert/strict');
(async()=>{
  let models=['model-one','model-two'],status=200,requests=0,app;
  const server=http.createServer((req,res)=>{requests++;res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({data:models.map(id=>({id}))}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const profile=path.resolve(`.test-output/model-refresh-${Date.now()}`);fs.mkdirSync(profile,{recursive:true});
  const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  const launch=async()=>{
    app=await electron.launch({executablePath:process.argv[2] || require('electron'),args:process.argv[2] ? [] : ['.'],env});
    const page=await app.firstWindow();await page.waitForFunction(()=>!!window.bridge && !!snapshot);return page;
  };
  const invoke=(page,action,payload)=>page.evaluate(([a,p])=>window.bridge.invoke(a,p),[action,payload]);
  try{
    let page=await launch();
    // The initial discovery is harmless and may still be finishing on a slow host.
    await page.waitForFunction(()=>snapshot.logs.some(row=>row.text.includes('自动刷新模型失败')) || !!snapshot.config.modelsUpdatedAt);
    await invoke(page,'save',{config:{upstream:`http://127.0.0.1:${server.address().port}`,refreshModelsOnStartup:true}});
    let current=await invoke(page,'refreshModels');const rule=current.config.modelRules.find(row=>row.actual==='model-one');
    await invoke(page,'saveAliases',{id:rule.id,aliases:[{name:'friendly'}],keepOriginal:true});
    await app.close();app=null;models=['model-two'];const before=requests;
    page=await launch();await page.waitForFunction(()=>snapshot.config.disabledModels.includes('model-one'));
    assert.equal(requests,before+1,'startup makes one discovery request');
    await page.click('[data-page=catalog]');
    let row=page.locator('.catalog-row').filter({has:page.locator('[data-modelid="model-one"]')});
    assert.match(await row.innerText(),/已下架，全局已关闭/);assert.match(await row.innerText(),/friendly/);
    assert.equal(await row.locator('[role=switch]').isDisabled(),true);
    await assert.rejects(invoke(page,'setModelAccess',{model:'model-one',enabled:true}),/当前代理未提供/);
    // A returning model remains closed until the user explicitly enables it.
    models=['model-one','model-two'];await invoke(page,'refreshModels');
    await page.waitForFunction(()=>!document.querySelector('[data-modelid="model-one"]').disabled);
    assert.equal(await row.locator('[role=switch]').getAttribute('aria-checked'),'false');
    assert.equal(await row.locator('[data-delete-model]').count(),0);
    models=['model-two'];const count=requests;await invoke(page,'testLocal');
    assert.equal(requests,count+1,'process detection reuses its model response');
    await page.waitForFunction(()=>!!document.querySelector('[data-delete-model]'));
    await page.screenshot({path:path.join(profile,'catalog-light.png'),fullPage:true});
    await invoke(page,'save',{config:{theme:'dark'}});
    await page.screenshot({path:path.join(profile,'catalog-dark.png'),fullPage:true});
    await invoke(page,'save',{config:{theme:'light'}});
    await row.locator('[data-delete-model]').click();await page.click('#confirm-model-delete');
    await page.waitForFunction(()=>!pending && !snapshot.config.modelRules.some(r=>r.actual==='model-one'));
    // A failed response never masquerades as an empty catalog.
    status=401;await assert.rejects(invoke(page,'refreshModels'),/HTTP 401/);
    current=await invoke(page,'snapshot');assert.deepEqual(current.config.knownModels,['model-two']);
    await page.click('[data-page=settings]');await page.uncheck('#refreshModelsOnStartup');
    await page.waitForFunction(()=>!pending && !snapshot.config.refreshModelsOnStartup);
    await page.selectOption('#model-refresh-mode','interval');await page.fill('#modelRefreshMinutes','17');
    await page.locator('#model-refresh-form button').click();await page.waitForFunction(()=>!pending && snapshot.config.modelRefreshMinutes===17);
    await page.screenshot({path:path.join(profile,'settings-light.png'),fullPage:true});
    await page.selectOption('#model-refresh-mode','off');await page.waitForFunction(()=>!pending && snapshot.config.modelRefreshMinutes===0);
    await app.close();app=null;const saved=requests;
    page=await launch();current=await invoke(page,'snapshot');assert.equal(current.config.refreshModelsOnStartup,false);
    assert.equal(current.config.modelRefreshMinutes,0);assert.equal(requests,saved);
    assert.equal(current.config.modelRules.some(r=>r.actual==='model-one'),false);
    console.log('Model refresh: startup, process response reuse, failure preservation, removal UI, reappearance and persistent settings passed');
  }finally{if(app)await app.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
