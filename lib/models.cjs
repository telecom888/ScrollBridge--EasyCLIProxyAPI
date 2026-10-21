function modelName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value.trim().replace(/^models\//i, '');
}
function modelKey(value) { return modelName(value)?.toLowerCase() || ''; }
function parseModelJSON(text) {
  const value=JSON.parse(text), stack=[];
  // Different upstream JSON parsers may select the first or last duplicate key.
  // Reject duplicate model selectors, including escaped property names.
  for(const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]/g)) {
    if(token==='{')stack.push({key:true,model:false});
    else if(token==='[')stack.push(null);
    else if(token==='}' || token===']')stack.pop();
    else if(token===','){if(stack.at(-1))stack.at(-1).key=true;}
    else if(token[0]==='"' && stack.at(-1)?.key){
      const object=stack.at(-1);object.key=false;
      if(JSON.parse(token)==='model'){if(object.model)throw new Error('Duplicate model selector');object.model=true;}
    }
  }
  return value;
}
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
module.exports = { modelName, modelKey, modelAllowed, modelFromPath, fetchModels, parseModelJSON };
