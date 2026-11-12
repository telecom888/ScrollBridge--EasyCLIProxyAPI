const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeImage, Tray, Menu, session, net } = require('electron');
const {RequestRecords,normalizeIP,exportRecords}=require('../lib/request-records.cjs');
const {CallStats}=require('../lib/call-stats.cjs');
const {startHostedBridge}=require('../lib/hosted-bridge.cjs');
const {randomBytes}=require('node:crypto');
const requestRecords=new RequestRecords();
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
const {fetchHostingModels,safeBase}=require('../lib/hosting.cjs');
const {uid,newKey,syncModels,deleteUnavailableModel,entries}=require('../lib/policy.cjs');
const {createModelRefresh}=require('../lib/model-refresh.cjs');
const {startManagementAPI}=require('../lib/management-api.cjs');
const {createUpdater,distribution,githubFetch,REPOSITORY}=require('../lib/updates.cjs');
const {electronFetch}=require('../lib/electron-fetch.cjs');
const {createInstallJob,launchInstallJob}=require('../lib/update-install.cjs');
const {readUpdateTicket,acknowledgeUpdate}=require('../lib/update-ticket.cjs');
const {createStartup}=require('../lib/startup.cjs');
app.setName('ScrollBridge');
const configDirectory = dataDirectory({testDirectory:process.env.SCROLLBRIDGE_TEST_DATA,portableFile:process.env.PORTABLE_EXECUTABLE_FILE,packaged:app.isPackaged,executable:app.getPath('exe'),appPath:app.getAppPath()});
// Both desktop editions and every portable filename share the same identity.
const profileDirectory = process.env.SCROLLBRIDGE_TEST_PROFILE || process.env.SCROLLBRIDGE_TEST_DATA || path.join(app.getPath('appData'), 'ScrollBridge');
fs.mkdirSync(profileDirectory, {recursive:true});
const callStats = new CallStats(profileDirectory);
app.setPath('userData', profileDirectory);
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
let window, tray, store, config, secrets, gateway, tunnel, hostedBridge, closing = false, busy = false;
let modelRefresh, managementAPI, updater, startup;
let status = 'stopped', message = '', logs = [], localDiagnostic = null, publicDiagnostic = null;
const view = () => ({ config, keys:config.accessKeys.map(key=>({...key,masked:`${secrets.keyValues[key.id].slice(0,6)}…${secrets.keyValues[key.id].slice(-4)}`})), modelEntries:entries(config),hasUpstreamKey: !!secrets.upstreamKey, hasTunnelToken: !!secrets.tunnelToken, gatewayRunning: !!gateway, status, message, records:requestRecords.all(config.recordRequestIP,config.showRequestBody), logs, localDiagnostic, publicDiagnostic, update:updater?.snapshot(),startup:startup?.snapshot(),version: app.getVersion(),features:{billing:gatewayEngine==='go',keyLimits:gatewayEngine==='go'} });
async function synchronizeGateway(){try{await gateway?.refreshPolicy();}catch{await stop();state('error','配置已保存，网关更新失败，连接已停止');throw new Error('配置已保存，网关更新失败，请重新连接');}}
async function commit(next,nextSecrets=secrets) {
  next=validateConfig(next);store.save(next,nextSecrets);config=next;secrets=nextSecrets;
  publicDiagnostic=null;await synchronizeGateway();publish();return view();
}
function findKey(id) {const key=config.accessKeys.find(row=>row.id===id);if(!key)throw new Error('密钥不存在');return key;}
const recordChanges=new Map();
let recordPublishTimer, recordsCatchUp=false, stateCatchUp=false;
function windowVisible(){return window&&!window.isDestroyed()&&window.isVisible()&&!window.isMinimized();}
function publish() {
  recordChanges.clear();
  if(!windowVisible() || recordsCatchUp){recordsCatchUp=true;stateCatchUp=true;return;}
  window.webContents.send('update', view());
}
function publishRecords() {
  if(recordPublishTimer || !windowVisible())return;
  recordPublishTimer=setTimeout(()=>{
    recordPublishTimer=null;
    if(!windowVisible())return;
    if(recordsCatchUp){
      recordsCatchUp=false;
      if(stateCatchUp){stateCatchUp=false;window.webContents.send('update',{...view(),recordsCatchUp:true});}
      else window.webContents.send('records',{records:requestRecords.all(config.recordRequestIP,config.showRequestBody),logs,catchUp:true});
    }else window.webContents.send('records',{records:[...recordChanges.values()].sort((a,b)=>b.sequence-a.sequence).map(row=>{const safe={...row};if(!config.recordRequestIP)delete safe.requestIP;if(!config.showRequestBody)delete safe.requestBody;return safe;}),logs,incremental:true,limit:config.requestRecordLimit});
    recordChanges.clear();
  },100);
}
function state(next, detail = '') { status = next; message = detail; publish(); }
function log(line) { logs.unshift({ time: new Date().toISOString(), text: line }); if(logs.length>100)logs.length=100;publishRecords(); }
async function stop() { if (tunnel) { const t = tunnel; tunnel = null; await t.stop(); } if (gateway) { const g = gateway; gateway = null; await g.close(); } if(hostedBridge){const h=hostedBridge;hostedBridge=null;await h.close();} state('stopped'); }
async function save(payload = {}) {
  if(payload.config?.updateSource!==undefined)throw new Error('请通过更新来源选项修改');
  if(['accessKeys','modelRules'].some(field=>payload.config?.[field]!==undefined) || payload.accessKey!==undefined)throw new Error('请通过密钥或模型页面编辑');
  const next = validateConfig({ ...config, ...payload.config });
  if ((gateway || tunnel) && (payload.clearUpstreamKey || ['upstream', 'port', 'hostname', 'protocol'].some(k => next[k] !== config[k]) || ['upstreamKey', 'tunnelToken'].some(k => payload[k]))) throw new Error('请先停止连接再保存连接配置');
  const nextSecrets = { ...secrets };
  if (payload.clearUpstreamKey) nextSecrets.upstreamKey = '';
  for (const key of ['upstreamKey', 'tunnelToken']) if (payload[key] !== undefined && payload[key] !== '') {
    if (typeof payload[key] !== 'string' || payload[key].length > 8192 || /[\r\n]/.test(payload[key])) throw new Error('密钥格式不正确');
    nextSecrets[key] = payload[key].trim();
  }
  const loginRequested=Object.hasOwn(payload.config || {},'launchAtLogin');
  const refreshChanged=next.modelRefreshMinutes!==config.modelRefreshMinutes;
  try{
    if(loginRequested)startup.change(next.launchAtLogin,()=>store.save(next,nextSecrets));
    else store.save(next,nextSecrets);
  }catch(error){publish();throw error;}
  config = next; secrets = nextSecrets;requestRecords.resize(config.requestRecordLimit);
  if (payload.config?.diagnosticModel !== undefined || payload.config?.diagnosticKeyId !== undefined) publicDiagnostic = null;
  if (payload.config?.hostname !== undefined || payload.tunnelToken || payload.clearUpstreamKey || payload.upstreamKey || payload.config?.upstream !== undefined) {localDiagnostic=null;publicDiagnostic=null;}
  if(refreshChanged)modelRefresh?.reschedule();
  await synchronizeGateway();publish(); return view();
}
const actions = {
  setUpdateSource: payload => {
    const next=validateConfig({...config,updateSource:payload?.source});
    if(updater.isActive())throw Error('请等待当前更新操作完成');
    store.save(next,secrets);config=next;updater.resetSource();return updater.snapshot();
  },
  checkUpdates: () => updater.check(),
  downloadUpdate: () => {void updater.download().catch(e=>log(e.message));return updater.snapshot();},
  installUpdate: () => {void updater.apply().catch(e=>log(e.message));return updater.snapshot();},
  snapshot: () => {startup?.refresh();return view();},
  getCallChart: payload => callStats.chart(payload?.range || '3h'),
  revealHostingKey: payload => {const p=config.hostingProviders.find(p=>p.id===payload?.id);if(!p)throw Error('托管密钥不存在');return {value:secrets.hostingKeys?.[p.id]||''};},
  copyHostingKey: payload => {const p=config.hostingProviders.find(p=>p.id===payload?.id);if(!p)throw Error('托管密钥不存在');clipboard.writeText(secrets.hostingKeys?.[p.id]||'');return true;},
  saveHostingProvider: payload => {
    if(!payload || typeof payload.name!=='string' || typeof payload.protocol!=='string' || typeof payload.enabled!=='boolean')throw Error('托管账号配置无效');
    const old=payload.id?config.hostingProviders.find(p=>p.id===payload.id):null;
    if(payload.id&&!old)throw Error('托管账号不存在');
    if(!old && (!payload.key || typeof payload.key!=='string'))throw Error('请输入 API Key');
    if(payload.key!==undefined && (typeof payload.key!=='string' || payload.key.length>8192 || /[\\r\\n]/.test(payload.key)))throw Error('API Key 无效');
    const p={id:old?.id||uid(),name:payload.name.trim(),protocol:payload.protocol,baseUrl:safeBase(payload.protocol,payload.baseUrl),enabled:payload.enabled};
    if(p.protocol==='vertex'){p.projectId=payload.projectId?.trim()||'';p.location=payload.location?.trim()||'global';}
    // Reject protocol or project changes while old models are attached to avoid silent route changes.
    if(old && config.hostingModels.some(m=>m.providerId===old.id) && (old.protocol!==p.protocol || old.projectId!==p.projectId || old.location!==p.location))throw Error('请先移除该账号的模型再修改协议或 Vertex 项目');
    const providers=old?config.hostingProviders.map(x=>x.id===p.id?p:x):[...config.hostingProviders,p];
    const nextSecrets={...secrets,hostingKeys:{...secrets.hostingKeys,...(payload.key?{[p.id]:payload.key}:{})}};
    return commit({...config,hostingProviders:providers},nextSecrets).then(()=>({providerId:p.id}));
  },
  setHostingRouteOrder: payload => {
    if(!payload||typeof payload.modelId!=='string'||!Array.isArray(payload.order))throw Error('路由配置无效');
    const {routeKey}=require('../lib/hosting.cjs');
    const group=routeKey(payload.modelId);
    const members=[...config.modelRules.filter(m=>routeKey(m.actual)===group).map(m=>m.id),...config.hostingModels.filter(m=>routeKey(m.modelId)===group).map(m=>m.id)];
    if(members.length<2||members.length!==payload.order.length||new Set(payload.order).size!==members.length||payload.order.some(id=>!members.includes(id)))throw Error('路由来源必须完整且不能重复');
    return commit({...config,hostingRouteOrders:{...config.hostingRouteOrders,[group]:payload.order}});
  },
  deleteHostingProvider: payload => {
    const p=config.hostingProviders.find(p=>p.id===payload?.id);if(!p)throw Error('托管账号不存在');
    const deleted=new Set(config.hostingModels.filter(m=>m.providerId===p.id).map(m=>m.id));
    const hostingKeys={...secrets.hostingKeys};delete hostingKeys[p.id];
    const orders=Object.fromEntries(Object.entries(config.hostingRouteOrders).map(([k,order])=>[k,order.filter(id=>!deleted.has(id))]).filter(([,order])=>order.length>1));
    return commit({...config,hostingProviders:config.hostingProviders.filter(x=>x.id!==p.id),hostingModels:config.hostingModels.filter(m=>m.providerId!==p.id),hostingRouteOrders:orders,accessKeys:config.accessKeys.map(k=>({...k,allowed:k.allowed.filter(id=>!deleted.has(id))}))},{...secrets,hostingKeys});
  },
  fetchHostingModels: async payload => {
    const p=config.hostingProviders.find(p=>p.id===payload?.id);if(!p)throw Error('托管账号不存在');
    const key=secrets.hostingKeys?.[p.id];if(!key)throw Error('托管密钥尚未配置');
    return fetchHostingModels(p,key);
  },
  addHostingModels: payload => {
    const p=config.hostingProviders.find(p=>p.id===payload?.providerId);if(!p)throw Error('托管账号不存在');
    if(!Array.isArray(payload.models) || payload.models.length<1 || payload.models.length>500 || payload.models.some(id=>typeof id!=='string'))throw Error('模型列表无效');
    const existing=new Set(config.hostingModels.filter(m=>m.providerId===p.id).map(m=>m.modelId.toLowerCase()));
    const added=[];
    for(const raw of payload.models){const modelId=raw.trim();if(!/^[a-zA-Z0-9][a-zA-Z0-9._:\\/-]{0,127}$/.test(modelId))throw Error('无效的模型 ID');if(!existing.has(modelId.toLowerCase())){added.push({id:uid(),providerId:p.id,modelId,enabled:true});existing.add(modelId.toLowerCase());}}
    return commit({...config,hostingModels:[...config.hostingModels,...added]});
  },
  removeHostingModel: payload => {
    const old=config.hostingModels.find(m=>m.id===payload?.id);if(!old)throw Error('托管模型不存在');
    const orders=Object.fromEntries(Object.entries(config.hostingRouteOrders).map(([k,order])=>[k,order.filter(id=>id!==old.id)]).filter(([,order])=>order.length>1));
    return commit({...config,hostingModels:config.hostingModels.filter(m=>m.id!==old.id),hostingRouteOrders:orders,accessKeys:config.accessKeys.map(k=>({...k,allowed:k.allowed.filter(id=>id!==old.id)}))});
  },
  setHostingModelAccess: payload => {
    const old=config.hostingModels.find(m=>m.id===payload?.id);if(!old || typeof payload.enabled!=='boolean')throw Error('托管模型配置无效');
    return commit({...config,hostingModels:config.hostingModels.map(m=>m.id===old.id?{...m,enabled:payload.enabled}:m)});
  },
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
      try { await fetchModels(config,secrets); }
      catch(error){
        const hasHosted=config.hostingModels.some(m=>m.enabled&&config.hostingProviders.some(p=>p.id===m.providerId&&p.enabled));
        if(!hasHosted)throw error;
        log('本地代理暂时不可用，将使用已启用的托管模型');
      }
      const hostingToken=randomBytes(32).toString('base64url');
      hostedBridge=await startHostedBridge({getConfig:()=>config,getSecrets:()=>secrets,token:hostingToken});
      gateway = await startGateway(config, secrets, record => { requestRecords.resize(config.requestRecordLimit);callStats.record(record);const row=requestRecords.add(record);if(windowVisible()&&!recordsCatchUp)recordChanges.set(row.id,row);if(recordChanges.size>config.requestRecordLimit)recordChanges.delete(recordChanges.keys().next().value);publishRecords(); }, { executable:app.isPackaged?path.join(process.resourcesPath,'vendor','scrollbridge-gateway.exe'):path.join(app.getAppPath(),'vendor','scrollbridge-gateway.exe'),stateDir:path.join(app.getPath('userData'),'gateway-go'),onExit:()=>{void stop().then(()=>state('error','网关意外退出，请重新连接'));},getConfig:()=>config,getSecrets:()=>secrets,hostingUrl:hostedBridge.url,hostingToken });
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
  openRepository: () => shell.openExternal('https://github.com/'+REPOSITORY),
  openGuide: () => shell.openExternal('https://developers.cloudflare.com/tunnel/get-started/'),
  clearLogs: () => { requestRecords.clear();logs=[];publish();return true; },
  setRecordLimit: async payload=>{
    const limit=Number(payload?.limit);if(!Number.isInteger(limit)||limit<100||limit>10000)throw Error('记录数量须为 100–10000');
    if(requestRecords.size>limit&&payload.confirmed!==true){const answer=await dialog.showMessageBox(window,{type:'question',message:'减少保留数量？',detail:'将删除最旧的 '+(requestRecords.size-limit)+' 条请求记录。',buttons:['取消','确认'],defaultId:0,cancelId:0});if(answer.response!==1)return view();}
    return save({config:{requestRecordLimit:limit}});
  },
  blockIP: async payload=>{
    const ip=normalizeIP(payload?.ip);if(config.ipBlacklist.includes(ip))return view();
    if(payload.confirmed!==true){const answer=await dialog.showMessageBox(window,{type:'question',message:'屏蔽 '+ip+'？',detail:'该 IP 的后续请求将被拒绝，可在设置中移除。',buttons:['取消','加入黑名单'],defaultId:0,cancelId:0});if(answer.response!==1)return view();}
    return save({config:{ipBlacklist:[...config.ipBlacklist,ip]}});
  },
  copyRequestIP: payload=>{clipboard.writeText(normalizeIP(payload?.ip));return true;},
  getRequestBody: payload=>{
    if(!config.showRequestBody)throw Error('请先开启显示请求体');
    if(typeof payload?.id!=='string'||payload.id.length>100)throw Error('请求记录无效');
    const body=requestRecords.body(payload.id);
    if(typeof body.preview!=='string')return body;
    let preview=body.preview;for(const value of [secrets.upstreamKey,secrets.tunnelToken,...Object.values(secrets.keyValues),...Object.values(secrets.hostingKeys||{})])if(value)preview=preview.split(value).join('[已隐藏密钥]');
    return {...body,preview};
  },
  exportRecords: async payload=>{
    if(!payload || !['csv','json'].includes(payload.format) || !['all','filtered'].includes(payload.scope))throw Error('导出选项无效');
    const ids=payload.keyIds;if(ids!==undefined && (!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||id.length>80)))throw Error('密钥筛选无效');
    const rows=requestRecords.all(config.recordRequestIP,config.showRequestBody).filter(row=>payload.scope==='all'||ids===undefined||ids.includes(row.keyId));
    if(!rows.length)throw Error('暂无可导出的请求记录');
    const content=exportRecords(rows,{format:payload.format,includeIP:config.recordRequestIP});
    const result=await dialog.showSaveDialog(window,{defaultPath:'ScrollBridge-requests-'+new Date().toISOString().replace(/[:.]/g,'-')+'.'+payload.format,filters:[{name:payload.format.toUpperCase(),extensions:[payload.format]}]});
    if(result.canceled || !result.filePath)return {canceled:true};
    await fs.promises.writeFile(result.filePath,content,'utf8');return {count:rows.length};
  },
  openData: () => shell.openPath(configDirectory)
};
function updateModels(knownModels) {
  return commit({...syncModels(config,knownModels),modelsUpdatedAt:new Date().toISOString()});
}
async function invokeAction(action,payload) {
  if(!Object.hasOwn(actions,action))throw Object.assign(new Error('请求无效'),{status:404,code:'NOT_FOUND'});
  const mutation=!['snapshot','getCallChart','fetchHostingModels','revealHostingKey','copyHostingKey','getRequestBody','copyRequestIP','exportRecords','copy','copyKey','revealKey','openCloudflare','openGuide','openData','openRepository','checkUpdates','downloadUpdate','installUpdate'].includes(action);
  if(closing)throw Object.assign(new Error('程序正在退出'),{status:503,code:'SHUTTING_DOWN'});
  if(mutation && busy)throw Object.assign(new Error('请等待当前操作完成'),{status:409,code:'BUSY'});
  if(mutation)busy=true;
  try{return await actions[action](payload);}finally{if(mutation)busy=false;}
}
async function createWindow() {
  window = new BrowserWindow({ title: '卷桥', show: process.env.SCROLLBRIDGE_SMOKE !== '1', width: 1160, height: 850, minWidth: 960, minHeight: 700, backgroundColor: '#f7f4ed', autoHideMenuBar: true, icon: path.join(app.getAppPath(), 'ui', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', e => e.preventDefault());
  const pauseRecords=()=>{recordsCatchUp=true;clearTimeout(recordPublishTimer);recordPublishTimer=null;recordChanges.clear();};
  window.on('minimize',pauseRecords);
  window.on('hide',pauseRecords);
  window.on('restore',publishRecords);
  window.on('show',()=>{if(recordsCatchUp)publishRecords();});
  window.on('focus',()=>{
    const before=JSON.stringify(startup?.snapshot());
    startup?.refresh();
    if(before!==JSON.stringify(startup?.snapshot()))publish();
    if(recordsCatchUp)publishRecords();
  });
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
  const executable=process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  startup=createStartup({app,executable});startup.refresh();
  updater=createUpdater({getSource:()=>config.updateSource,getVersion:()=>app.getVersion().replace(/-node$/,''),kind:distribution({portableFile:process.env.PORTABLE_EXECUTABLE_FILE,executable}),directory:path.join(profileDirectory,'updates'),enabled:app.isPackaged && gatewayEngine==='go',fetcher:(url,options)=>githubFetch(url,options,(...args)=>electronFetch(net,...args)),onChange:publish,install:async payload=>{
    if(busy || closing)return false;
    const unsaved=await window.webContents.executeJavaScript('Boolean(dirty || keyDirty || refreshIntervalDirty)');
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
    if(ready){
      if(window.isMinimized())window.restore();
      window.show();window.focus();
      if(window.isVisible() && !window.isMinimized())acknowledgeUpdate(ticket,app.getVersion());
    }
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
app.on('before-quit', e => { callStats.close(); modelRefresh?.stop();managementAPI?.close();if (gateway || tunnel) { e.preventDefault(); closing = true; stop().finally(() => app.quit()); } });
