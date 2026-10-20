const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, clipboard, nativeImage, Tray, Menu, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { parseCPA } = require('../lib/import-cpa.cjs');
const { Store } = require('../lib/store.cjs');
const { validateConfig, validateAccessKey, createAccessKey } = require('../lib/config.cjs');
const { startGateway } = require('../lib/gateway.cjs');
const { startTunnel } = require('../lib/tunnel.cjs');
const { provision } = require('../lib/cloudflare.cjs');
const {localCheck,publicCheck}=require('../lib/diagnostics.cjs');
app.setName('ScrollBridge');
if (process.env.SCROLLBRIDGE_TEST_DATA) { fs.mkdirSync(process.env.SCROLLBRIDGE_TEST_DATA, {recursive:true}); app.setPath('userData', process.env.SCROLLBRIDGE_TEST_DATA); }
if (!app.requestSingleInstanceLock()) app.quit();
let window, tray, store, config, secrets, gateway, tunnel, closing = false, busy = false;
let status = 'stopped', message = '', records = [], logs = [], localDiagnostic = null, publicDiagnostic = null;
const view = () => ({ config, hasUpstreamKey: !!secrets.upstreamKey, hasTunnelToken: !!secrets.tunnelToken, gatewayRunning: !!gateway, status, message, records, logs, localDiagnostic, publicDiagnostic, version: app.getVersion() });
function publish() { if (window && !window.isDestroyed()) window.webContents.send('update', view()); }
function state(next, detail = '') { status = next; message = detail; publish(); }
function log(line) { logs.unshift({ time: new Date().toISOString(), text: line }); logs = logs.slice(0, 100); publish(); }
async function stop() { if (tunnel) { const t = tunnel; tunnel = null; await t.stop(); } if (gateway) { const g = gateway; gateway = null; await g.close(); } state('stopped'); }
async function probe(url, key, isPublic = false) {
  if (isPublic && !config.hostname) throw new Error('请先设置域名');
  const r = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!r.ok) throw new Error(`HTTP ${r.status}：${r.status === 401 ? '密钥不正确' : '请检查本地代理、域名和隧道设置'}`);
  const data = await r.json();
  if (isPublic && data.service !== 'scrollbridge') throw new Error('域名未指向卷桥网关');
  if (!isPublic && !Array.isArray(data.data)) throw new Error('本地服务没有返回 OpenAI 模型列表');
  return isPublic ? { ok: true, message: '域名 HTTPS 和网关鉴权正常' } : { ok: true, message: `本地服务正常 · ${data.data.length} 个模型`, models: data.data.map(m => m.id).slice(0, 80) };
}
function save(payload = {}) {
  const next = validateConfig({ ...config, ...payload.config });
  if ((gateway || tunnel) && (payload.clearUpstreamKey || ['upstream', 'port', 'hostname', 'protocol'].some(k => next[k] !== config[k]) || ['upstreamKey', 'tunnelToken', 'accessKey'].some(k => payload[k]))) throw new Error('请先停止连接再保存连接配置');
  const nextSecrets = { ...secrets };
  if (payload.clearUpstreamKey) nextSecrets.upstreamKey = '';
  for (const key of ['upstreamKey', 'tunnelToken', 'accessKey']) if (payload[key] !== undefined && payload[key] !== '') {
    if (typeof payload[key] !== 'string' || payload[key].length > 8192 || /[\r\n]/.test(payload[key])) throw new Error('密钥格式不正确');
    nextSecrets[key] = payload[key].trim();
  }
  validateAccessKey(nextSecrets.accessKey);
  store.save(next, nextSecrets); config = next; secrets = nextSecrets;
  if (payload.config?.hostname !== undefined || payload.tunnelToken || payload.clearUpstreamKey || payload.upstreamKey || payload.config?.upstream !== undefined) {localDiagnostic=null;publicDiagnostic=null;}
  app.setLoginItemSettings({ openAtLogin: !!config.launchAtLogin, path: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe') });
  publish(); return view();
}
const actions = {
  snapshot: () => view(),
  save,
  copyKey: () => { clipboard.writeText(secrets.accessKey); return true; },
  rotateKey: () => { if (gateway) throw new Error('请先停止连接'); secrets.accessKey = createAccessKey(); store.save(config, secrets); return true; },
  copy: text => { if (typeof text !== 'string' || text.length > 50000) throw new Error('复制内容无效'); clipboard.writeText(text); return true; },
  testLocal: async () => {localDiagnostic=await localCheck(config,secrets);publish();return localDiagnostic;},
  testPublic: async () => {publicDiagnostic=await publicCheck(config,secrets);publish();return publicDiagnostic;},
  start: async () => {
    if (gateway || tunnel) throw new Error('连接已启动');
    if (!config.hostname || !secrets.tunnelToken) throw new Error('请先填写域名和隧道令牌');
    state('starting');
    try {
      await probe(`${config.upstream}/v1/models`, secrets.upstreamKey);
      gateway = await startGateway(config, secrets, record => { records.unshift(record); records = records.slice(0, 200); publish(); });
      const executable = app.isPackaged ? path.join(process.resourcesPath, 'vendor', 'cloudflared.exe') : path.join(app.getAppPath(), 'vendor', 'cloudflared.exe');
      tunnel = startTunnel({ executable, token: secrets.tunnelToken, protocol: config.protocol, runtimeDir: path.join(app.getPath('userData'), 'runtime'), onState: state, onLog: log });
      log('网关已启动，等待隧道连接');
      return view();
    } catch (e) { await stop(); state('error', e.message); throw e; }
  },
  stop: async () => { await stop(); return view(); },
  import: async () => {
    if (gateway) throw new Error('请先停止连接');
    const result = await dialog.showOpenDialog(window, { title: '选择 CLIProxyAPI 配置', defaultPath: path.join(app.getAppPath(), '..', '代理工具'), filters: [{ name: 'CLIProxyAPI', extensions: ['yaml', 'yml'] }], properties: ['openFile'] });
    if (result.canceled) return null;
    const filename = result.filePaths[0]; if (fs.statSync(filename).size > 2 * 1024 * 1024) throw new Error('配置文件过大');
    const { upstream, upstreamKey } = parseCPA(fs.readFileSync(filename, 'utf8'));
    save({ config: { upstream }, upstreamKey, clearUpstreamKey: !upstreamKey });
    return { ok: true, message: '已导入服务地址和首个客户端密钥' };
  },
  bind: async payload => {
    if (gateway) throw new Error('请先停止连接');
    if (!config.hostname) throw new Error('请先保存域名');
    const result = await provision({ ...payload, hostname: config.hostname, port: config.port });
    secrets.tunnelToken = result.tunnelToken;
    try { store.save(config, secrets); } catch { throw new Error(`域名已绑定，但本地保存失败。请在 Cloudflare 隧道 ${result.tunnelId} 中重新获取令牌`); }
    log(`已绑定 ${config.hostname}`); publish(); return { ok: true, message: '域名与隧道已创建，令牌已加密保存' };
  },
  openCloudflare: () => shell.openExternal('https://dash.cloudflare.com/'),
  openGuide: () => shell.openExternal('https://developers.cloudflare.com/tunnel/get-started/'),
  clearLogs: () => { records = []; logs = []; publish(); return true; },
  openData: () => shell.openPath(app.getPath('userData'))
};
async function createWindow() {
  window = new BrowserWindow({ title: '卷桥', show: process.env.SCROLLBRIDGE_SMOKE !== '1', width: 1160, height: 850, minWidth: 960, minHeight: 700, backgroundColor: '#f7f4ed', autoHideMenuBar: true, icon: path.join(app.getAppPath(), 'ui', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  await window.loadFile(path.join(app.getAppPath(), 'ui', 'index.html'));
  window.on('close', e => { if (!closing && gateway) { e.preventDefault(); window.hide(); tray.displayBalloon({ title: '卷桥', content: '连接仍在运行，可从托盘退出。' }); } });
}
app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_, __, cb) => cb(false));
  store = new Store(app.getPath('userData'), safeStorage);
  try { ({ config, secrets } = store.load()); store.save(config, secrets); } catch (e) { dialog.showErrorBox('卷桥', e.message); closing = true; app.quit(); return; }
  // Delete a token file left by an interrupted previous process.
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'runtime', 'tunnel-token')); } catch {}
  ipcMain.handle('bridge', async (event, action, payload) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !Object.hasOwn(actions, action)) throw new Error('请求无效');
    const mutation = ['save', 'start', 'stop', 'import', 'bind', 'rotateKey'].includes(action);
    if (mutation && busy) throw new Error('请等待当前操作完成');
    if (mutation) busy = true;
    try { return await actions[action](payload); } catch (e) { throw new Error(e.message); } finally { if (mutation) busy = false; }
  });
  await createWindow();
  tray = new Tray(nativeImage.createFromPath(path.join(app.getAppPath(), 'ui', 'icon.png')));
  tray.setToolTip('卷桥 · 模型服务连接'); tray.on('double-click', () => window.show());
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开卷桥', click: () => { window.show(); window.focus(); } }, { label: '停止连接', click: stop }, { type: 'separator' }, { label: '退出', click: () => { closing = true; app.quit(); } }]));
  if (process.env.SCROLLBRIDGE_SMOKE === '1') {
    await window.webContents.executeJavaScript("document.documentElement.dataset.smoke = 'ready'");
    fs.writeFileSync(path.join(app.getPath('userData'),'runtime-ready.json'),JSON.stringify({packaged:app.isPackaged,portable:!!process.env.PORTABLE_EXECUTABLE_FILE,encrypted:safeStorage.isEncryptionAvailable(),ready:true}));
    console.log('SCROLLBRIDGE_READY');
    if(process.env.SCROLLBRIDGE_SMOKE_EXIT==='1')setTimeout(()=>{closing=true;app.quit();},500);
  }
});
app.on('window-all-closed', () => { if (!gateway) { closing = true; app.quit(); } });
app.on('before-quit', e => { if (gateway || tunnel) { e.preventDefault(); closing = true; stop().finally(() => app.quit()); } });
