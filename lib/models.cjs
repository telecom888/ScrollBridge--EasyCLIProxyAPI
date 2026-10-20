function modelName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value.trim().replace(/^models\//i, '');
}
function modelKey(value) { return modelName(value)?.toLowerCase() || ''; }
function modelAllowed(value, disabled = []) { const key = modelKey(value); return !!key && !disabled.some(id => modelKey(id) === key); }
function modelFromPath(path) {
  const match = /^\/v1(?:beta)?\/models\/(.+)$/.exec(path);
  if (!match) return null;
  try { return modelName(decodeURIComponent(match[1].replace(/:(generateContent|streamGenerateContent|countTokens)$/, ''))); } catch { return null; }
}
async function fetchModels(config, secrets, fetcher = fetch) {
  const response = await fetcher(`${config.upstream}/v1/models`, { headers: { authorization: `Bearer ${secrets.upstreamKey || ''}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`获取模型失败：HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data.data)) throw new Error('本地代理未返回有效模型列表');
  return [...new Set(data.data.map(item => modelName(item?.id)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
module.exports = { modelName, modelKey, modelAllowed, modelFromPath, fetchModels };
