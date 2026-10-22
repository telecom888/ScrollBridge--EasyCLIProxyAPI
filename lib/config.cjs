const crypto = require('node:crypto');
const DEFAULTS = Object.freeze({ upstream: 'http://127.0.0.1:8317', port: 18443, hostname: '', theme: 'light', updateSource: 'github', protocol: 'auto', launchAtLogin: false, refreshModelsOnStartup: true, modelRefreshMinutes: 0, imagesEnabled: false, geminiImageCompatibility: false, diagnosticModel: '', diagnosticKeyId: '', accessKeys: [], modelRules: [], knownModels: [], disabledModels: [], modelsUpdatedAt: '',billing:{enabled:false,currency:'USD',readUsagePrice:false,usageCostPointer:'/usage/cost',rates:{inputPerMillion:'0',outputPerMillion:'0',cachedInputPerMillion:'0'}},modelRates:{} });
function validateConfig(input) {
  const c = { ...structuredClone(DEFAULTS), ...input };
  let u;
  try { u = new URL(c.upstream); } catch { throw new Error('本地服务地址格式不正确'); }
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('本地服务必须是本机 HTTP/HTTPS 地址，不能包含路径或凭据');
  c.upstream = u.origin;
  c.port = Number(c.port);
  if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535 || c.port === Number(u.port || (u.protocol === 'https:' ? 443 : 80))) throw new Error('网关端口须为 1024–65535，且不能与本地服务相同');
  c.hostname = String(c.hostname || '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (c.hostname && (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.hostname))) throw new Error('请输入有效域名，例如 api.example.com');
  if (!['auto', 'quic', 'http2'].includes(c.protocol)) throw new Error('隧道协议无效');
  if (!['light', 'dark', 'system'].includes(c.theme)) throw new Error('主题无效');
  if (!['github','mirror'].includes(c.updateSource)) throw new Error('更新来源无效');
  if (typeof c.imagesEnabled !== 'boolean') throw new Error('图像接口开关无效');
  if (typeof c.geminiImageCompatibility !== 'boolean') throw new Error('Gemini 图像生成兼容开关无效');
  if (typeof c.refreshModelsOnStartup !== 'boolean') throw new Error('启动刷新设置无效');
  if (!Number.isInteger(c.modelRefreshMinutes) || c.modelRefreshMinutes < 0 || c.modelRefreshMinutes > 10080) throw new Error('刷新间隔须为 1–10080 分钟，0 表示不刷新');
  const { modelName, modelKey } = require('./models.cjs');
  if (typeof c.diagnosticModel !== 'string' || (c.diagnosticModel && !modelName(c.diagnosticModel))) throw new Error('检测模型无效');
  for (const field of ['knownModels', 'disabledModels']) {
    if (!Array.isArray(c[field]) || c[field].length > 10000 || c[field].some(id => !modelName(id))) throw new Error('模型配置无效');
    c[field] = [...new Set(c[field].map(field === 'disabledModels' ? modelKey : modelName))];
  }
  if (typeof c.modelsUpdatedAt !== 'string' || (c.modelsUpdatedAt && !Number.isFinite(Date.parse(c.modelsUpdatedAt)))) throw new Error('模型更新时间无效');
  require('./policy.cjs').validatePolicy(c);
  const validateRates=r=>r&&typeof r==='object'&&!Array.isArray(r)&&['inputPerMillion','outputPerMillion','cachedInputPerMillion'].every(k=>typeof r[k]==='string'&&/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,9})?$/.test(r[k]));
  const b=c.billing;if(!b||typeof b.enabled!=='boolean'||typeof b.readUsagePrice!=='boolean'||!['string'].includes(typeof b.currency)||!/^[A-Z]{3,8}$/.test(b.currency)||typeof b.usageCostPointer!=='string'||!b.usageCostPointer.startsWith('/')||b.usageCostPointer.length>200||!validateRates(b.rates))throw new Error('费用设置无效，请使用非负数字，最多保留 9 位小数');
  if(!c.modelRates||typeof c.modelRates!=='object'||Array.isArray(c.modelRates)||Object.entries(c.modelRates).some(([id,r])=>!c.modelRules.some(m=>m.id===id)||!validateRates(r)))throw new Error('模型费用设置无效');
  return Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, c[k]]));
}
function createAccessKey() { return 'sb_' + crypto.randomBytes(32).toString('base64url'); }
function validateAccessKey(key) { if (typeof key !== 'string' || key.length < 32 || key.length > 256 || /\s/.test(key)) throw new Error('访问密钥至少 32 位，且不能含空格'); return key; }
module.exports = { DEFAULTS, validateConfig, createAccessKey, validateAccessKey };
