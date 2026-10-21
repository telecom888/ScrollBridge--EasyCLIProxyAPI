const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, validateConfig, createAccessKey } = require('./config.cjs');
class Store {
  constructor(directory, encryption) { this.directory = directory; this.encryption = encryption; this.filename=path.join(directory,'settings.v2.json'); }
  load() {
    let data, importing=false;
    const read=filename=>{try{return JSON.parse(fs.readFileSync(filename,'utf8'));}catch(e){if(e.code!=='ENOENT')throw new Error('配置无法读取，请检查 '+path.basename(filename));}};
    data=read(this.filename);
    if(data===undefined){
      if(fs.existsSync(this.directory)&&fs.readdirSync(this.directory).some(name=>name.startsWith('settings.v2.json.')))throw new Error('新版配置文件缺失，发现备份或临时文件，请恢复原配置；未生成新密钥');
      data=read(path.join(this.directory,'settings.json'));importing=data!==undefined;
    }
    if (data === undefined) {
      // A missing primary file in an existing installation is not a new install.
      // Never replace an existing identity with freshly generated credentials.
      if (fs.existsSync(this.directory) && fs.readdirSync(this.directory).some(name => name.startsWith('settings.json.'))) throw new Error('配置文件缺失，发现配置备份或未完成的保存文件，请恢复原配置后启动；未生成新密钥');
      const key = require('./policy.cjs').newKey();
      const initial = { config: validateConfig({accessKeys:[key],diagnosticKeyId:key.id}), secrets: {keyValues:{[key.id]:createAccessKey()},upstreamKey:'',tunnelToken:''} };
      this.save(initial.config, initial.secrets);
      return initial;
    }
    if (!data || !(data.version===2 || importing && data.version===1) || !data.config || !data.secrets) {
      const error = new Error('配置格式不受支持，请先将配置转换为新版格式');
      // Only structural metadata is safe to retain in startup diagnostics.
      error.configShape = {
        version: typeof data?.version === 'number' ? data.version : null,
        versionType: typeof data?.version,
        configType: typeof data?.config,
        secretsType: typeof data?.secrets,
        hasConfig: !!data?.config,
        hasSecrets: !!data?.secrets
      };
      throw error;
    }
    let secrets = {};
    if (data.secrets) {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('系统密钥加密不可用');
      try { secrets = JSON.parse(this.encryption.decryptString(Buffer.from(data.secrets, 'base64'))); } catch { throw new Error('无法解密密钥，请使用原 Windows 账户打开应用'); }
    }
    const result=data.version===1?require('./migrate-settings.cjs').convert(data,secrets):{config:validateConfig({...DEFAULTS,...data.config}),secrets};
    validateSecrets(result.config,result.secrets);
    if(importing){
      // Preserve settings.json verbatim. Older executables cannot overwrite
      // the separate canonical file used by both current desktop editions.
      this.save(result.config,result.secrets);
      const verified=this.load();
      if(JSON.stringify(verified.secrets)!==JSON.stringify(result.secrets))throw new Error('配置转换后密钥校验失败，请保留原配置');
      return verified;
    }
    return result;
  }
  save(config, secrets) {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows 密钥加密不可用，未保存任何密钥');
    fs.mkdirSync(this.directory, { recursive: true });
    config=validateConfig(config); validateSecrets(config,secrets);
    const filename = this.filename;
    let previous;
    try { previous = fs.readFileSync(filename); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const data = JSON.stringify({ version: 2, config, secrets: this.encryption.encryptString(JSON.stringify(secrets)).toString('base64') }, null, 2);
    const temporary = filename+'.tmp';
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (previous) {
      const backup = filename+'.bak';
      fs.writeFileSync(backup + '.tmp', previous, {mode:0o600});
      fs.renameSync(backup + '.tmp', backup);
    }
    fs.renameSync(temporary, filename);
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
