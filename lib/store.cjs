const fs = require('node:fs');
const path = require('node:path');
const {validateConfig, createAccessKey, validateAccessKey} = require('./config.cjs');
const SETTINGS_FILE = 'scrollbridge.json';
class Store {
  constructor(directory, encryption) {
    this.directory = directory; this.encryption = encryption;
    this.filename = path.join(directory, SETTINGS_FILE);
    this.encryptedSecrets = null; this.serializedSecrets = null; this.persistedText = null;
  }
  load() {
    let text;
    try { text = fs.readFileSync(this.filename, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('配置无法读取，请检查 ' + SETTINGS_FILE); }
    if (text === undefined) {
      if (fs.existsSync(this.filename + '.tmp')) throw new Error('发现未完成的配置保存，请恢复原配置；未生成新密钥');
      const key = require('./policy.cjs').newKey();
      const initial = {config:validateConfig({accessKeys:[key],diagnosticKeyId:key.id}), secrets:{keyValues:{[key.id]:createAccessKey()},upstreamKey:'',tunnelToken:''}};
      this.save(initial.config, initial.secrets);
      return initial;
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('配置无法读取，请检查 ' + SETTINGS_FILE); }
    if (!data || data.version !== 2 || !data.config || typeof data.config !== 'object' || Array.isArray(data.config) || typeof data.secrets !== 'string' || !data.secrets) {
      const error = new Error('配置格式无效，请使用当前版本的配置文件');
      error.configShape = {version:typeof data?.version === 'number' ? data.version : null,versionType:typeof data?.version,configType:typeof data?.config,secretsType:typeof data?.secrets,hasConfig:!!data?.config,hasSecrets:!!data?.secrets};
      throw error;
    }
    if (!this.encryption.isEncryptionAvailable()) throw new Error('系统密钥加密不可用');
    let secrets;
    try { secrets = JSON.parse(this.encryption.decryptString(Buffer.from(data.secrets,'base64'))); }
    catch { throw new Error('无法解密密钥，请使用原 Windows 账户打开应用'); }
    const config = validateConfig(data.config);
    validateSecrets(config,secrets);
    this.encryptedSecrets = data.secrets; this.serializedSecrets = JSON.stringify(secrets); this.persistedText = text;
    return {config,secrets};
  }
  save(config,secrets) {
    config = validateConfig(config); validateSecrets(config,secrets);
    const serialized = JSON.stringify(secrets);
    let encrypted = this.encryptedSecrets;
    if (!encrypted || serialized !== this.serializedSecrets) {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows 密钥加密不可用，未保存任何密钥');
      encrypted = this.encryption.encryptString(serialized).toString('base64');
    }
    const text = JSON.stringify({version:2,config,secrets:encrypted},null,2);
    if (text === this.persistedText) return;
    fs.mkdirSync(this.directory,{recursive:true});
    const temporary = this.filename + '.tmp', fd = fs.openSync(temporary,'w',0o600);
    try { fs.writeFileSync(fd,text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary,this.filename);
    this.encryptedSecrets = encrypted; this.serializedSecrets = serialized; this.persistedText = text;
  }
}
function validateSecrets(config,secrets) {
  if (!secrets || !secrets.keyValues || typeof secrets.keyValues !== 'object' || Array.isArray(secrets.keyValues) || typeof secrets.upstreamKey !== 'string' || typeof secrets.tunnelToken !== 'string') throw new Error('密钥存储格式无效');
  const values = new Set(), ids = new Set(config.accessKeys.map(key=>key.id));
  for (const key of config.accessKeys) { const value=validateAccessKey(secrets.keyValues[key.id]); if(values.has(value))throw new Error('密钥值重复'); values.add(value); }
  if (Object.keys(secrets.keyValues).some(id=>!ids.has(id))) throw new Error('密钥存储包含未知条目');
}
module.exports = {Store,validateSecrets,SETTINGS_FILE};
