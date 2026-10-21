const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, validateConfig, createAccessKey } = require('./config.cjs');
class Store {
  constructor(directory, encryption) { this.directory = directory; this.encryption = encryption; }
  load() {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(this.directory, 'settings.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('配置无法读取，请检查 settings.json'); }
    if (data === undefined) {
      const key = require('./policy.cjs').newKey();
      return { config: validateConfig({accessKeys:[key],diagnosticKeyId:key.id}), secrets: {keyValues:{[key.id]:createAccessKey()},upstreamKey:'',tunnelToken:''} };
    }
    if (!data || data.version !== 2 || !data.config || !data.secrets) throw new Error('配置格式不受支持，请先将配置转换为新版格式');
    const config = validateConfig({ ...DEFAULTS, ...data.config });
    let secrets = {};
    if (data.secrets) {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('系统密钥加密不可用');
      try { secrets = JSON.parse(this.encryption.decryptString(Buffer.from(data.secrets, 'base64'))); } catch { throw new Error('无法解密密钥，请使用原 Windows 账户打开应用'); }
    }
    validateSecrets(config,secrets);
    return { config, secrets };
  }
  save(config, secrets) {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows 密钥加密不可用，未保存任何密钥');
    fs.mkdirSync(this.directory, { recursive: true });
    config=validateConfig(config); validateSecrets(config,secrets);
    const data = JSON.stringify({ version: 2, config, secrets: this.encryption.encryptString(JSON.stringify(secrets)).toString('base64') }, null, 2);
    const temporary = path.join(this.directory, 'settings.json.tmp');
    fs.writeFileSync(temporary, data, { mode: 0o600 }); fs.renameSync(temporary, path.join(this.directory, 'settings.json'));
  }
}
function validateSecrets(config,secrets) {
  const {validateAccessKey}=require('./config.cjs');
  if(!secrets || !secrets.keyValues || typeof secrets.keyValues!=='object' || Array.isArray(secrets.keyValues) || typeof secrets.upstreamKey!=='string' || typeof secrets.tunnelToken!=='string') throw new Error('密钥存储格式无效');
  const values=new Set();
  for(const key of config.accessKeys) {const value=validateAccessKey(secrets.keyValues[key.id]);if(values.has(value))throw new Error('密钥值重复');values.add(value);}
  if(Object.keys(secrets.keyValues).some(id=>!config.accessKeys.some(key=>key.id===id)))throw new Error('密钥存储包含未知条目');
}
module.exports = { Store, validateSecrets };
