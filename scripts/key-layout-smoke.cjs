const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');

(async()=>{
  const profile=path.resolve(`.test-output/key-layout-${Date.now()}`);fs.mkdirSync(profile,{recursive:true});
  const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  const launch=()=>electron.launch({executablePath:process.argv[2] || require('electron'),args:process.argv[2]?[]:['.'],env});
  let app;const errors=[];
  try{
    app=await launch();let page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>typeof snapshot!=='undefined' && !!snapshot);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,900));
    await page.click('[data-page=keys]');
    const widths=()=>page.evaluate(()=>['.key-master','.key-detail','.key-model-panel'].map(s=>document.querySelector(s).getBoundingClientRect().width));
    await page.waitForFunction(()=>document.querySelector('.key-detail').getBoundingClientRect().width>=300);
    const initial=await widths();assert.ok(initial[1]>initial[0]);
    const divider=page.locator('[data-divider="1"]'),box=await divider.boundingBox();
    await page.mouse.move(box.x+5,box.y+100);await page.mouse.down();await page.mouse.move(box.x+85,box.y+100,{steps:8});await page.mouse.up();
    const moved=await widths();assert.ok(moved[1]>initial[1]+50);assert.ok(moved[2]<initial[2]-50);
    const saved=await page.evaluate(()=>localStorage.getItem('scrollbridge.key-columns'));assert.ok(saved);
    await page.fill('#key-name','保留草稿');await page.click('#reset-key-layout');
    const reset=await widths();reset.forEach((n,i)=>assert.ok(Math.abs(n-initial[i])<2));assert.equal(await page.inputValue('#key-name'),'保留草稿');
    await divider.focus();await page.keyboard.press('ArrowLeft');assert.ok((await widths())[1]<reset[1]-5);
    const persisted=await page.evaluate(()=>localStorage.getItem('scrollbridge.key-columns'));
    await page.keyboard.press('End');
    await page.click('#cancel-key-edit');await page.click('#permission-clear');assert.equal(await page.locator('#key-all').isChecked(),false);
    await page.locator('#key-form button[type=submit]').click();await page.waitForFunction(()=>!pending && snapshot.keys[0].mode==='selected');
    await page.click('[data-page=settings]');assert.equal(await page.locator('#billing-form').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.querySelector('#billing-form').previousElementSibling.querySelector('h2').textContent),'接口');
    await page.click('[data-page=keys]');await page.click('#close-key-editor');assert.equal(await page.locator('#key-editor-empty').isVisible(),true);
    await page.click('#new-key-empty');assert.equal(await page.locator('.key-model-panel').isVisible(),true);await page.fill('#key-name','新密钥');await page.locator('#key-form button[type=submit]').click();await page.waitForFunction(()=>!pending && snapshot.keys.length===2);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(960,700));
    await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok((await widths())[1]>=299);assert.ok((await widths())[2]>=319);
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1440,900));
    await page.waitForTimeout(100);await page.screenshot({path:path.join(profile,'keys-light.png')});
    await page.click('#theme-toggle');await page.waitForFunction(()=>!pending);await page.screenshot({path:path.join(profile,'keys-dark.png')});
    await app.close();app=await launch();page=await app.firstWindow();await page.waitForFunction(()=>typeof snapshot!=='undefined' && !!snapshot);
    assert.equal(await page.evaluate(()=>localStorage.getItem('scrollbridge.key-columns')),persisted);
    await page.click('[data-page=keys]');await page.click('#reset-key-layout');assert.equal(await page.evaluate(()=>localStorage.getItem('scrollbridge.key-columns')),null);
    assert.deepEqual(errors,[]);console.log('Key layout passed: pointer/keyboard resize, reset, draft retention, restart persistence, narrow window, save/create and hidden billing UI');
  }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
