const { modelName } = require('./models.cjs');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const command = promisify(execFile);

const PROTOCOLS = ['openai', 'anthropic', 'google', 'vertex'];
const DEFAULT_URLS = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  vertex: 'https://aiplatform.googleapis.com'
};
function safeBase(protocol, raw) {
  if (!PROTOCOLS.includes(protocol)) throw Error('不支持的托管协议');
  let u;
  try { u = new URL(raw || DEFAULT_URLS[protocol]); } catch { throw Error('API 地址格式错误'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port ||
      (u.pathname !== '/' && u.pathname !== '/v1' && u.pathname !== '/v1/')) throw Error('托管服务仅支持官方 HTTPS API 地址');
  const allowed = {
    openai: host => host === 'api.openai.com',
    anthropic: host => host === 'api.anthropic.com',
    google: host => host === 'generativelanguage.googleapis.com',
    vertex: host => host === 'aiplatform.googleapis.com' || /^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(host)
  }[protocol];
  if (!allowed(u.hostname)) throw Error('托管服务地址不属于所选供应商');
  return u.origin;
}
function publicModelId(providerId, modelId) {
  const sanitized = modelId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const prefix = 'host-' + providerId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) + '.';
  if (sanitized.length + prefix.length <= 128) return prefix + sanitized;
  return prefix + sanitized.slice(0, 110) + '-' + createHash('sha256').update(modelId).digest('hex').slice(0, 8);
}
function routeKey(id){return sharedModelId(id).toLowerCase();}
function orderByRoutes(items, orders){
  const groups = new Map();
  for (const item of items){const name=routeKey(item.actual);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(item);}
  return [...groups].flatMap(([name,rows])=>{
    const wanted=orders?.[name]||[];
    const score=row=>{const index=wanted.indexOf(row.modelId||row.id);return index<0?100000:index;};
    return rows.slice().sort((a,b)=>score(a)-score(b));
  });
}
function validateHosting(config) {
  if (typeof config.showModelSources !== 'boolean' || typeof config.unifiedModelRouting !== 'boolean') throw Error('托管设置无效');
  if (!Array.isArray(config.hostingProviders) || !Array.isArray(config.hostingModels) || config.hostingProviders.length > 64 || config.hostingModels.length > 5000) throw Error('托管配置数量无效');
  const ids = new Set(), knownProviders = new Map(), pairs = new Set();
  for (const p of config.hostingProviders) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || ids.has(p.id) ||
        typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 || /[\x00-\x1f\x7f]/.test(p.name) ||
        typeof p.enabled !== 'boolean') throw Error('托管账号配置无效');
    p.baseUrl = safeBase(p.protocol, p.baseUrl);
    if (p.protocol === 'vertex' && (!/^[a-zA-Z0-9_-]{3,120}$/.test(p.projectId || '') ||
        !/^[a-z0-9-]{2,64}$/.test(p.location || ''))) throw Error('Vertex AI 项目或区域无效');
    ids.add(p.id); knownProviders.set(p.id,p);
  }
  for (const m of config.hostingModels) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(m.id) || ids.has(m.id) ||
        typeof m.providerId !== 'string' || !knownProviders.has(m.providerId) || typeof m.enabled !== 'boolean' ||
        typeof m.modelId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,127}$/.test(m.modelId) ||
        pairs.has(m.providerId+'\0'+m.modelId.toLowerCase())) throw Error('托管模型配置无效或重复');
    ids.add(m.id); pairs.add(m.providerId+'\0'+m.modelId.toLowerCase());
  }
  const orders=config.hostingRouteOrders;
  if(!orders||typeof orders!=='object'||Array.isArray(orders)||Object.keys(orders).length>5000)throw Error('模型路由优先级配置无效');
  const available=new Map();
  for(const m of config.hostingModels)available.set(m.id,routeKey(m.modelId));
  for(const m of config.modelRules)available.set(m.id,routeKey(m.actual));
  for(const [name,order] of Object.entries(orders)){
    if(name!==routeKey(name)||!Array.isArray(order)||order.length>65 || new Set(order).size!==order.length || order.some(id=>available.get(id)!==name))throw Error('模型路由优先级无效：'+name);
  }
}
function sharedModelId(id) { return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ? id : id.replace(/[^a-zA-Z0-9._-]/g,'-').slice(0,120); }
function hostingEntries(config) {
  const providers = new Map(config.hostingProviders.map(p => [p.id,p]));
  const rows=config.hostingModels.map(model => {
    const p = providers.get(model.providerId);
    return {
      id: model.id, modelId: model.id, name: config.unifiedModelRouting ? sharedModelId(model.modelId) : publicModelId(p.id, model.modelId),
      actual: model.modelId, source: p.name, providerId: p.id, protocol: p.protocol, hosted: true,
      available: p.enabled, globalEnabled: model.enabled && p.enabled
    };
  });
  return orderByRoutes(rows,config.hostingRouteOrders);
}
async function fetchHostingModels(provider, key, options = {}) {
  const fetcher = options.fetcher || fetch;
  const pages = [];
  let cursor = '';
  for (let count = 0; count < 15; count++) {
    let path, headers = {Accept:'application/json'};
    if (provider.protocol === 'openai') {
      path='/v1/models'; headers.Authorization='Bearer '+key;
    } else if (provider.protocol === 'anthropic') {
      path='/v1/models?limit=100'+(cursor?'&after_id='+encodeURIComponent(cursor):'');
      headers['x-api-key']=key; headers['anthropic-version']='2023-06-01';
    } else if (provider.protocol === 'google') {
      path='/v1beta/models?pageSize=1000'+(cursor?'&pageToken='+encodeURIComponent(cursor):'');
      headers['x-goog-api-key']=key;
    } else {
      // Google Model Garden list requires a principal-bearing OAuth token. The API key is used for generation.
      let token=options.oauthToken;
      if (!token) {
        try { ({stdout:token}=await command('gcloud',['auth','application-default','print-access-token'],{timeout:12000,windowsHide:true})); }
        catch { throw Error('Vertex 模型列表需要 Google Cloud ADC，请先运行 gcloud auth application-default login；也可手动添加模型'); }
      }
      headers.Authorization='Bearer '+token.trim();
      path='/v1beta1/publishers/google/models?pageSize=100'+(cursor?'&pageToken='+encodeURIComponent(cursor):'');
    }
    const response = await fetcher(provider.baseUrl+path,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw Error('获取模型失败：HTTP '+response.status);
    const body = await response.json();
    let items;
    if (provider.protocol === 'openai' || provider.protocol === 'anthropic') items=body.data;
    else if (provider.protocol === 'google') items=body.models;
    else items=body.publisherModels;
    if (!Array.isArray(items)) throw Error('供应商返回了无效的模型列表');
    for (const row of items) {
      const full=provider.protocol==='google' || provider.protocol==='vertex'?row.name:row.id;
      let id=typeof full==='string'?full.replace(/^models\//,'').replace(/^publishers\/google\/models\//,''):'';
      if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,127}$/.test(id)) continue;
      if (provider.protocol==='vertex' && !/^gemini[-.]/i.test(id)) continue;
      if (provider.protocol==='google' && Array.isArray(row.supportedGenerationMethods) &&
          !row.supportedGenerationMethods.includes('generateContent')) continue;
      pages.push(id);
    }
    cursor = provider.protocol==='anthropic' ? (body.has_more ? body.last_id : '') : body.nextPageToken || '';
    if (!cursor || provider.protocol==='openai') break;
  }
  return [...new Set(pages)].sort((a,b)=>a.localeCompare(b));
}
module.exports={PROTOCOLS,DEFAULT_URLS,safeBase,validateHosting,hostingEntries,publicModelId,sharedModelId,routeKey,orderByRoutes,fetchHostingModels};
