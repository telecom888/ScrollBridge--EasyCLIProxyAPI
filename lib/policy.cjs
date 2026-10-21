const crypto = require('node:crypto');
const { modelName, modelKey } = require('./models.cjs');
const uid = () => crypto.randomUUID();
function newKey(name = '默认密钥') {
  return { id: uid(), name, enabled: true, mode: 'all', allowed: [], createdAt: new Date().toISOString() };
}
function syncModels(config, knownModels) {
  const rules = structuredClone(config.modelRules || []);
  for (const actual of knownModels) if (!rules.some(row => modelKey(row.actual) === modelKey(actual))) {
    rules.push({ id: uid(), actual, originalId: uid(), keepOriginal: false, aliases: [] });
  }
  return { ...config, knownModels, modelRules: rules };
}
function entries(config) {
  const available = new Set(config.knownModels.map(modelKey));
  const disabled = new Set(config.disabledModels.map(modelKey));
  return config.modelRules.flatMap(rule => {
    const base = { actual: rule.actual, modelId: rule.id, available: available.has(modelKey(rule.actual)), globalEnabled: !disabled.has(modelKey(rule.actual)) };
    return [ ...(!rule.aliases.length || rule.keepOriginal ? [{ id: rule.originalId, name: rule.actual }] : []), ...rule.aliases ].map(row => ({ ...base, ...row }));
  });
}
function keyAllows(key, entry) { return key?.enabled && entry.available && entry.globalEnabled && (key.mode === 'all' || key.allowed.includes(entry.id)); }
function resolveModel(config, key, name) {
  const entry = entries(config).find(row => modelKey(row.name) === modelKey(name));
  if (!entry || !entry.available) throw Object.assign(new Error('Model not found'), { status: 404 });
  if (!keyAllows(key, entry)) throw Object.assign(new Error('Model is not available for this API key'), { status: 403 });
  return entry;
}
function authenticate(req, url, config, secrets) {
  const candidate = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || req.headers['x-goog-api-key'] || url.searchParams.get('key') || '';
  if (typeof candidate !== 'string') return null;
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const hash = digest(candidate);
  let matched = null;
  for (const key of config.accessKeys) {
    const value = secrets.keyValues[key.id];
    if (typeof value === 'string' && crypto.timingSafeEqual(hash, digest(value)) && key.enabled) matched = key;
  }
  return matched;
}
function validatePolicy(config) {
  if (!Array.isArray(config.modelRules) || !Array.isArray(config.accessKeys) || config.modelRules.length > 10000 || config.accessKeys.length > 1000) throw new Error('密钥或模型配置无效');
  const ids = new Set(), names = new Map();
  const validId = id => {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ids.has(id)) throw new Error('配置内部 ID 无效或重复');
    ids.add(id);
  };
  for (const rule of config.modelRules) {
    validId(rule.id); validId(rule.originalId);
    if (!modelName(rule.actual) || typeof rule.keepOriginal !== 'boolean' || !Array.isArray(rule.aliases) || rule.aliases.length>1000) throw new Error('模型配置无效');
    const name = modelKey(rule.actual);
    if (names.has(name)) throw new Error('模型 ID 重复');
    names.set(name, rule.id);
  }
  for (const rule of config.modelRules) for (const alias of rule.aliases) {
    validId(alias.id);
    if (typeof alias.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(alias.name)) throw new Error('别名仅支持字母、数字、点、下划线和短横线，最多 128 位');
    const name = modelKey(alias.name);
    if (names.has(name)) throw new Error(`模型 ID 已存在：${alias.name}`);
    names.set(name, rule.id);
  }
  const exposures = new Set(config.modelRules.flatMap(rule => [rule.originalId, ...rule.aliases.map(row => row.id)]));
  for (const key of config.accessKeys) {
    validId(key.id);
    if (typeof key.name !== 'string' || !key.name.trim() || key.name.length > 80 || /[\x00-\x1f\x7f]/.test(key.name) || typeof key.enabled !== 'boolean' || !['all','selected'].includes(key.mode) || !Array.isArray(key.allowed) || key.allowed.some(id => !exposures.has(id)) || !Number.isFinite(Date.parse(key.createdAt))) throw new Error('密钥配置无效');
    if (new Set(key.allowed).size !== key.allowed.length) throw new Error('密钥模型权限重复');
  }
  if (typeof config.diagnosticKeyId !== 'string' || config.diagnosticKeyId && !config.accessKeys.some(key => key.id === config.diagnosticKeyId)) throw new Error('检测密钥无效');
}
module.exports = { uid, newKey, syncModels, entries, keyAllows, resolveModel, authenticate, validatePolicy };
