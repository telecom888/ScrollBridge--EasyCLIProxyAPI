const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Tray, Menu, session, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { parseCPA } = require('../lib/import-cpa.cjs');
const { Store, SETTINGS_VERSION } = require('../lib/store.cjs');
const {dataDirectory} = require('../lib/data-path.cjs');
const { validateConfig, createAccessKey } = require('../lib/config.cjs');
const gatewayEngine=process.env.SCROLLBRIDGE_GATEWAY_ENGINE || require('../package.json').gatewayEngine || 'go';
const { startGateway } = require(gatewayEngine==='go'?'../lib/go-gateway.cjs':'../lib/gateway.cjs');
const { startTunnel } = require('../lib/tunnel.cjs');
const { provision } = require('../lib/cloudflare.cjs');
const {localCheck,publicCheck}=require('../lib/diagnostics.cjs');
const {fetchModels,modelKey,modelName}=require('../lib/models.cjs');
const {uid,newKey,syncModels,deleteUnavailableModel,entries}=require('../lib/policy.cjs');
const {createModelRefresh}=require('../lib/model-refresh.cjs');
const {startManagementAPI}=require('../lib/management-api.cjs');
const {createUpdater,distribution,githubFetch}=require('../lib/updates.cjs');
const {createInstallJob,launchInstallJob}=require('../lib/update-install.cjs');
const {readUpdateTicket,acknowledgeUpdate}=require('../lib/update-ticket.cjs');
app.setName('ScrollBridge');
const configDirectory = dataDirectory({testDirectory:process.env.SCROLLBRIDGE_TEST_DATA,portableFile:process.env.PORTABLE_EXECUTABLE_FILE,packaged:app.isPackaged,executable:app.getPath('exe'),appPath:app.getAppPath()});
// Both desktop editions and every portable filename share the same identity.
const profileDirectory = process.env.SCROLLBRIDGE_TEST_PROFILE || process.env.SCROLLBRIDGE_TEST_DATA || path.join(app.getPath('appData'), 'ScrollBridge');
fs.mkdirSync(profileDirectory, {recursive:true});
app.setPath('userData', profileDirectory);
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
let window, tray, store, config, secrets, gateway, tunnel, closing = false, busy = false;
let modelRefresh, managementAPI, updater;
let status = 'stopped', message = '', records = [], logs = [], localDiagnostic = null, publicDiagnostic = null;
const view = () => ({ config, keys:config.accessKeys.map(key=>({...key,masked:`${secrets.keyValues[key.id].slice(0,6)}…${secrets.keyValues[key.id].slice(-4)}`})), modelEntries:entries(config),hasUpstreamKey: !!secrets.upstreamKey, hasTunnelToken: !!secrets.tunnelToken, gatewayRunning: !!gateway, status, message, records, logs, localDiagnostic, publicDiagnostic, update:updater?.snapshot(),version: app.getVersion(),features:{billing:gatewayEngine==='go',keyLimits:gatewayEngine==='go'} });
async function synchronizeGateway(){try{await gateway?.refreshPolicy();}catch{await stop();state('error','配置已保存，网关更新失败，连接已停止');throw new Error('配置已保存，网关更新失败，请重新连接');}}
async function commit(next,nextSecrets=secrets) {
  next=validateConfig(next);store.save(next,nextSecrets);config=next;secrets=nextSecrets;
  publicDiagnostic=null;await synchronizeGateway();publish();return view();
}
function findKey(id) {const key=config.accessKeys.find(row=>row.id===id);if(!key)throw new Error('密钥不存在');return key;}
function publish() { if (window && !window.isDestroyed()) window.webContents.send('update', view()); }
let recordPublishTimer;
function publishRecords() {
  if(recordPublishTimer)return;
  recordPublishTimer=setTimeout(()=>{recordPublishTimer=null;publish();},100);
}
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
  return isPublic ? { ok: true, message: '域名 HTTPS 和网关鉴权正常' } : { ok: true, message: `本地服务正常，提供 ${data.data.length} 个模型`, models: data.data.map(m => m.id).slice(0, 80) };
}
async function save(payload = {}) {
  if(['accessKeys','modelRules'].some(field=>payload.config?.[field]!==undefined) || payload.accessKey!==undefined)throw new Error('请通过密钥或模型页面编辑');
  const next = validateConfig({ ...config, ...payload.config });
  if ((gateway || tunnel) && (payload.clearUpstreamKey || ['upstream', 'port', 'hostname', 'protocol'].some(k => next[k] !== config[k]) || ['upstreamKey', 'tunnelToken'].some(k => payload[k]))) throw new Error('请先停止连接再保存连接配置');
  const nextSecrets = { ...secrets };
  if (payload.clearUpstreamKey) nextSecrets.upstreamKey = '';
  for (const key of ['upstreamKey', 'tunnelToken']) if (payload[key] !== undefined && payload[key] !== '') {
    if (typeof payload[key] !== 'string' || payload[key].length > 8192 || /[\r\n]/.test(payload[key])) throw new Error('密钥格式不正确');
    nextSecrets[key] = payload[key].trim();
  }
  const loginChanged=next.launchAtLogin!==config.launchAtLogin;
  const refreshChanged=next.modelRefreshMinutes!==config.modelRefreshMinutes;
  store.save(next, nextSecrets); config = next; secrets = nextSecrets;
  if (payload.config?.diagnosticModel !== undefined || payload.config?.diagnosticKeyId !== undefined) publicDiagnostic = null;
  if (payload.config?.hostname !== undefined || payload.tunnelToken || payload.clearUpstreamKey || payload.upstreamKey || payload.config?.upstream !== undefined) {localDiagnostic=null;publicDiagnostic=null;}
  if(loginChanged)app.setLoginItemSettings({ openAtLogin:!!config.launchAtLogin,path:process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe') });
  if(refreshChanged)modelRefresh?.reschedule();
  await synchronizeGateway();publish(); return view();
}
const actions = {
  checkUpdates: () => updater.check(),
  downloadUpdate: () => {void updater.download().catch(e=>log(e.message));return updater.snapshot();},
  installUpdate: () => {void updater.apply().catch(e=>log(e.message));return updater.snapshot();},
  snapshot: () => view(),
  revealKey: payload => {const key=findKey(payload?.id);return {id:key.id,value:secrets.keyValues[key.id]};},
  save,
  copyKey: payload => { const key=findKey(payload?.id);clipboard.writeText(secrets.keyValues[key.id]); return true; },
  rotateKey: payload => {const key=findKey(payload?.id);return commit(config,{...secrets,keyValues:{...secrets.keyValues,[key.id]:createAccessKey()}});},
  saveKey: payload => {
    if(!payload || typeof payload.name!=='string')throw new Error('请输入密钥名称');
    const existing=payload.id?findKey(payload.id):null,key=existing?{...existing}:newKey();
    key.name=payload.name.trim();
    if(payload.enabled!==undefined)key.enabled=payload.enabled;
    if(payload.mode!==undefined)key.mode=payload.mode;
    if(payload.allowed!==undefined)key.allowed=payload.allowed;
    for(const field of ['concurrent','requestLimit','requestWindowSeconds'])if(payload[field]!==undefined)key[field]=payload[field];
    const accessKeys=existing?config.accessKeys.map(row=>row.id===key.id?key:row):[...config.accessKeys,key];
    const nextSecrets=existing?secrets:{...secrets,keyValues:{...secrets.keyValues,[key.id]:createAccessKey()}};
    return commit({...config,accessKeys,diagnosticKeyId:config.diagnosticKeyId || key.id},nextSecrets);
  },
  deleteKey: payload => {
    const key=findKey(payload?.id),keyValues={...secrets.keyValues};delete keyValues[key.id];
    return commit({...config,accessKeys:config.accessKeys.filter(row=>row.id!==key.id),diagnosticKeyId:config.diagnosticKeyId===key.id?'':config.diagnosticKeyId},{...secrets,keyValues});
  },
  saveAliases: payload => {
    const rule=config.modelRules.find(row=>row.id===payload?.id);
    if(!rule || !Array.isArray(payload.aliases) || typeof payload.keepOriginal!=='boolean')throw new Error('模型别名设置无效');
    const aliases=payload.aliases.map(row=>{
      if(typeof row.name!=='string' || row.id && !rule.aliases.some(alias=>alias.id===row.id))throw new Error('别名条目无效');
      return{id:row.id || uid(),name:row.name.trim()};
    });
    const modelRules=config.modelRules.map(row=>row.id===rule.id?{...row,aliases,keepOriginal:payload.keepOriginal}:row);
    const valid=new Set(modelRules.flatMap(row=>[row.originalId,...row.aliases.map(alias=>alias.id)]));
    const next={...config,modelRules,accessKeys:config.accessKeys.map(key=>({...key,allowed:key.allowed.filter(id=>valid.has(id))}))};
    const selected=entries(config).find(row=>row.name===config.diagnosticModel),renamed=entries(next).find(row=>row.id===selected?.id);
    if(renamed)next.diagnosticModel=renamed.name;
    return commit(next);
  },
  copy: text => { if (typeof text !== 'string' || text.length > 50000) throw new Error('复制内容无效'); clipboard.writeText(text); return true; },
  testLocal: async () => {
    localDiagnostic=await localCheck(config,secrets);
    if(localDiagnostic.modelsFetched)await updateModels(localDiagnostic.models);
    publish();return localDiagnostic;
  },
  testPublic: async () => {const key=findKey(config.diagnosticKeyId);if(!key.enabled)throw new Error('所选检测密钥已停用');publicDiagnostic=await publicCheck(config,secrets,{model:config.diagnosticModel,keyId:key.id});publish();return publicDiagnostic;},
  refreshModels: async () => {
    return updateModels(await fetchModels(config, secrets));
  },
  deleteModel: payload => commit(deleteUnavailableModel(config,payload?.id)),
  setModelAccess: payload => {
    if (!payload || !modelName(payload.model) || typeof payload.enabled !== 'boolean') throw new Error('模型设置无效');
    const key = modelKey(payload.model);
    if(payload.enabled && !config.knownModels.some(id=>modelKey(id)===key))throw new Error('当前代理未提供该模型，无法开放');
    if (!config.knownModels.some(id => modelKey(id) === key) && !config.disabledModels.includes(key)) throw new Error('请先从本地代理获取该模型');
    const disabled = new Set(config.disabledModels);
    if (payload.enabled) disabled.delete(key); else disabled.add(key);
    const next = validateConfig({ ...config, disabledModels: [...disabled] });
    return commit(next);
  },
  start: async () => {
    if (gateway || tunnel) throw new Error('连接已启动');
    if (!config.hostname || !secrets.tunnelToken) throw new Error('请先填写域名和隧道令牌');
    state('starting');
    try {
      await probe(`${config.upstream}/v1/models`, secrets.upstreamKey);
      gateway = await startGateway(config, secrets, record => { const index=record.id?records.findIndex(row=>row.id===record.id):-1;if(index>=0)records[index]=record;else records.unshift(record);records=records.slice(0,200);publishRecords(); }, { executable:app.isPackaged?path.join(process.resourcesPath,'vendor','scrollbridge-gateway.exe'):path.join(app.getAppPath(),'vendor','scrollbridge-gateway.exe'),stateDir:path.join(app.getPath('userData'),'gateway-go'),onExit:()=>{void stop().then(()=>state('error','网关意外退出，请重新连接'));},getConfig:()=>config,getSecrets:()=>secrets });
      const executable = app.isPackaged ? path.join(process.resourcesPath, 'vendor', 'cloudflared.exe') : path.join(app.getAppPath(), 'vendor', 'cloudflared.exe');
      tunnel = startTunnel({ executable, token: secrets.tunnelToken, protocol: config.protocol, onState: state, onLog: log });
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
    await save({ config: { upstream }, upstreamKey, clearUpstreamKey: !upstreamKey });
    return { ok: true, message: '已导入服务地址和首个客户端密钥' };
  },
  bind: async payload => {
    if (gateway) throw new Error('请先停止连接');
    if (!config.hostname) throw new Error('请先保存域名');
    const result = await provision({ ...payload, hostname: config.hostname, port: config.port });
    const nextSecrets={...secrets,tunnelToken:result.tunnelToken};
    try { store.save(config,nextSecrets); } catch { throw new Error(`域名已绑定，但本地保存失败。请在 Cloudflare 隧道 ${result.tunnelId} 中重新获取令牌`); }
    secrets=nextSecrets;
    log(`已绑定 ${config.hostname}`); publish(); return { ok: true, message: '域名与隧道已创建，令牌已加密保存' };
  },
  openCloudflare: () => shell.openExternal('https://dash.cloudflare.com/'),
  openGuide: () => shell.openExternal('https://developers.cloudflare.com/tunnel/get-started/'),
  clearLogs: () => { records = []; logs = []; publish(); return true; },
  openData: () => shell.openPath(configDirectory)
};
function updateModels(knownModels) {
  return commit({...syncModels(config,knownModels),modelsUpdatedAt:new Date().toISOString()});
}
async function invokeAction(action,payload) {
  if(!Object.hasOwn(actions,action))throw Object.assign(new Error('请求无效'),{status:404,code:'NOT_FOUND'});
  const mutation=!['snapshot','copy','copyKey','revealKey','openCloudflare','openGuide','openData','checkUpdates','downloadUpdate','installUpdate'].includes(action);
  if(closing)throw Object.assign(new Error('程序正在退出'),{status:503,code:'SHUTTING_DOWN'});
  if(mutation && busy)throw Object.assign(new Error('请等待当前操作完成'),{status:409,code:'BUSY'});
  if(mutation)busy=true;
  try{return await actions[action](payload);}finally{if(mutation)busy=false;}
}
async function createWindow() {
  window = new BrowserWindow({ title: '卷桥', show: process.env.SCROLLBRIDGE_SMOKE !== '1', width: 1160, height: 850, minWidth: 960, minHeight: 700, backgroundColor: '#f7f4ed', autoHideMenuBar: true, icon: path.join(app.getAppPath(), 'ui', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  await window.loadFile(path.join(app.getAppPath(), 'ui', 'index.html'));
  window.on('close', e => { if (!closing && gateway) { e.preventDefault(); window.hide(); tray.displayBalloon({ title: '卷桥', content: '连接仍在运行，可从托盘退出。' }); } });
}
app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
app.whenReady().then(async () => {
  if (!ownsProfile) return;
  session.defaultSession.setPermissionRequestHandler((_, __, cb) => cb(false));
  store = new Store(configDirectory);
  try { ({ config, secrets } = store.load()); } catch (e) {
    const reportPath = path.join(configDirectory, 'startup-error.json');
    let reportSaved = false;
    try {
      fs.writeFileSync(reportPath, JSON.stringify({
        time: new Date().toISOString(), appVersion: app.getVersion(),
        executable: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
        configPath: store.filename,
        expectedFormat: SETTINGS_VERSION, configShape: e.configShape || null
      }, null, 2), {mode:0o600});
      reportSaved = true;
    } catch {}
    dialog.showErrorBox('卷桥', `${e.message}\n\n程序版本：${app.getVersion()}\n配置位置：${store.filename}${reportSaved ? '\n错误记录：' + reportPath : ''}\n已有配置未被覆盖。`);
    closing = true; app.quit(); return;
  }
  if(config.launchAtLogin)app.setLoginItemSettings({openAtLogin:true,path:process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe')});
  const executable=process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  updater=createUpdater({getVersion:()=>app.getVersion().replace(/-node$/,''),kind:distribution({portableFile:process.env.PORTABLE_EXECUTABLE_FILE,executable}),directory:path.join(profileDirectory,'updates'),enabled:app.isPackaged && gatewayEngine==='go',fetcher:(url,options)=>githubFetch(url,options,(...args)=>net.fetch(...args)),onChange:publish,install:async payload=>{
    if(busy || closing)return false;
    const unsaved=await window.webContents.executeJavaScript('Boolean(dirty || keyDirty || billingDirty || refreshIntervalDirty)');
    if(unsaved)return false;
    busy=true;
    try{
      const plan=createInstallJob(payload,{executable,configDirectory,profileDirectory,resumeConnection:!!gateway});
      await launchInstallJob(plan);closing=true;modelRefresh?.stop();await stop();app.quit();return true;
    }finally{if(!closing)busy=false;}
  }});
  ipcMain.handle('bridge', async (event, action, payload) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !Object.hasOwn(actions, action)) throw new Error('请求无效');
    try { return await invokeAction(action,payload); } catch (e) { throw new Error(e.message); }
  });
  await createWindow();
  tray = new Tray(nativeImage.createFromPath(path.join(app.getAppPath(), 'ui', 'icon.png')));
  tray.setToolTip('卷桥模型服务连接'); tray.on('double-click', () => window.show());
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开卷桥', click: () => { window.show(); window.focus(); } }, { label: '停止连接', click: stop }, { type: 'separator' }, { label: '退出', click: () => { closing = true; app.quit(); } }]));
  try{managementAPI=await startManagementAPI({directory:profileDirectory,invoke:invokeAction,version:app.getVersion()});}
  catch{log('本机管理 API 启动失败，请检查运行目录的写入权限');}
  modelRefresh=createModelRefresh({getConfig:()=>config,run:async()=>{
    if(busy || closing)return;
    busy=true;
    try{await actions.refreshModels();}finally{busy=false;}
  },onError:()=>log('自动刷新模型失败，已保留现有列表；请检查本地代理服务')});
  let ticket;
  try{ticket=readUpdateTicket({id:process.env.SCROLLBRIDGE_UPDATE_ID,profileDirectory,version:app.getVersion(),executable});}catch(e){log(e.message);}
  delete process.env.SCROLLBRIDGE_UPDATE_ID;
  if(ticket){
    let ready=false;
    for(let i=0;i<100;i++){ready=await window.webContents.executeJavaScript('typeof snapshot!=="undefined" && !!snapshot');if(ready)break;await new Promise(r=>setTimeout(r,100));}
    if(ready)acknowledgeUpdate(ticket,app.getVersion());
  }
  void modelRefresh.start().finally(()=>{if(ticket?.job.resumeConnection)void invokeAction('start').catch(e=>log('更新后连接恢复失败：'+e.message));});
  if (process.env.SCROLLBRIDGE_SMOKE === '1') {
    await window.webContents.executeJavaScript("document.documentElement.dataset.smoke = 'ready'");
    fs.writeFileSync(path.join(app.getPath('userData'),'runtime-ready.json'),JSON.stringify({packaged:app.isPackaged,portable:!!process.env.PORTABLE_EXECUTABLE_FILE,encrypted:true,ready:true}));
    console.log('SCROLLBRIDGE_READY');
    if(process.env.SCROLLBRIDGE_SMOKE_EXIT==='1')setTimeout(()=>{closing=true;app.quit();},500);
  }
});
app.on('window-all-closed', () => { if (!gateway) { closing = true; app.quit(); } });
app.on('before-quit', e => { modelRefresh?.stop();managementAPI?.close();if (gateway || tunnel) { e.preventDefault(); closing = true; stop().finally(() => app.quit()); } });
