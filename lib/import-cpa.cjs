const YAML = require('yaml');
const {validateConfig} = require('./config.cjs');
function parseCPA(text) {
  const doc = YAML.parse(text, {maxAliasCount:20});
  if (!doc || typeof doc !== 'object') throw new Error('不是有效的 CLIProxyAPI 配置');
  // v8 moved listener settings under server and client keys under access.
  const server = doc.server || doc;
  const keys = doc.access?.['api-keys'] ?? doc['api-keys'] ?? [];
  const upstreamKey = Array.isArray(keys) && typeof keys[0] === 'string' ? keys[0] : '';
  const port = Number(server.port || 8317);
  const upstream = validateConfig({upstream:`${server.tls?.enable ? 'https' : 'http'}://127.0.0.1:${port}`,port:port === 18443 ? 18444 : 18443}).upstream;
  return {upstream,upstreamKey};
}
module.exports = {parseCPA};
