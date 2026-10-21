const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const profile = path.resolve(`.test-output/settings-lock-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, SCROLLBRIDGE_TEST_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: process.argv[2] || require('electron'), args: process.argv[2] ? [] : ['.'], env });
  try {
    // Exercise settings persistence without changing Windows startup registration.
    await app.evaluate(({ app }) => { app.setLoginItemSettings = () => {}; });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.bridge);
    const initial = await page.evaluate(() => window.bridge.invoke('snapshot'));
    const connected = { ...initial, status: 'connected', gatewayRunning: true };
    await page.evaluate(state => render(state), connected);
    for (const id of ['upstream', 'port', 'hostname', 'upstreamKey', 'tunnelToken', 'import']) {
      assert.ok(await page.locator(`#${id}`).isDisabled());
      await page.locator(`[data-locked-for="${id}"]`).click();
      assert.equal(await page.locator('#toast').innerText(), '请先停止连接再修改配置');
    }
    await page.click('[data-page="settings"]');
    for (const id of ['transport', 'launchAtLogin']) {
      assert.ok(await page.locator(`#${id}`).isDisabled());
      const box = await page.locator(`#${id}`).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await page.locator('#toast').innerText(), '请先停止连接再修改配置');
      await page.locator('#toast').evaluate(el => { el.hidden = true; });
      await page.locator(`[data-locked-for="${id}"]`).focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#toast').innerText(), '请先停止连接再修改配置');
    }
    assert.deepEqual((await page.evaluate(() => window.bridge.invoke('snapshot'))).config, initial.config);
    await page.evaluate(state => render(state), initial);
    await page.selectOption('#transport', 'http2');
    await page.waitForFunction(() => !pending && snapshot.config.protocol === 'http2');
    await page.check('#launchAtLogin');
    await page.waitForFunction(() => !pending && snapshot.config.launchAtLogin);
    const saved = await page.evaluate(() => window.bridge.invoke('snapshot'));
    assert.equal(saved.config.protocol, 'http2');
    assert.equal(saved.config.launchAtLogin, true);
    assert.ok(await page.locator('[data-locked-for="transport"]').isHidden());
    console.log('Running controls show reminders for pointer and keyboard; stopped controls remain editable and persist');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
