const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const env={...process.env,SCROLLBRIDGE_TEST_DATA:path.resolve(`.test-output/motion-${Date.now()}`)};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({executablePath:require('electron'),args:['.'],env});
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(()=>!!snapshot);
    await page.evaluate(() => {
      window.fixture = { version:'test',status:'stopped', config:{theme:'light',upstream:'http://127.0.0.1:8317',port:18443,hostname:'',protocol:'auto',knownModels:['gemini-test','claude-test'],disabledModels:[],modelsUpdatedAt:new Date().toISOString()},records:[],logs:[] };
      render(window.fixture);
    });
    await page.click('[data-page=catalog]');
    assert.equal(await page.locator('#page-catalog').isVisible(),true);
    await page.evaluate(() => {
      window.savedSwitch=document.querySelector('[data-modelid="gemini-test"]');
      render({...window.fixture,config:{...window.fixture.config,disabledModels:['gemini-test']}});
    });
    assert.equal(await page.evaluate(() => window.savedSwitch===document.querySelector('[data-modelid="gemini-test"]')),true);
    assert.equal(await page.locator('[data-modelid="gemini-test"]').getAttribute('aria-checked'),'false');
    await page.click('[data-page=records]');
    await page.evaluate(() => {
      window.fixture.records=[{time:Date.now(),method:'POST',model:'gemini-test',path:'/v1/chat/completions',status:200,ms:100}];
      render(window.fixture);window.savedRow=document.querySelector('tbody tr');render(window.fixture);
    });
    assert.equal(await page.evaluate(() => window.savedRow===document.querySelector('tbody tr')),true);
    await page.click('[data-page=access]');await page.click('[data-tab=google]');
    assert.match(await page.locator('#example-code').innerText(),/streamGenerateContent/i);
    await page.click('[data-page=settings]');
    assert.equal(await page.locator('#imagesEnabled').evaluate(el=>getComputedStyle(el).appearance),'none');
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.click('[data-page=connection]');
    assert.equal(await page.evaluate(()=>document.getAnimations().length),0);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await page.click('[data-page=settings]');
    await page.waitForTimeout(250);
    await page.screenshot({path:path.resolve('.test-output/motion-settings.png'),fullPage:true});
    console.log('Motion smoke passed: navigation, tabs, stable switches/records, reduced motion');
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
