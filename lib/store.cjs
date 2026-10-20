const fs = require('node:fs');
const path = require('node:path');
const { DEFAULTS, validateConfig, createAccessKey } = require('./config.cjs');
class Store {
  constructor(directory, encryption) { this.directory = directory; this.encryption = encryption; }
  load() {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(path.join(this.directory, 'settings.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('配置无法读取，请检查 settings.json'); }
    const config = validateConfig({ ...DEFAULTS, ...data.config });
    let secrets = {};
    if (data.secrets) {
      if (!this.encryption.isEncryptionAvailable()) throw new Error('系统密钥加密不可用');
      try { secrets = JSON.parse(this.encryption.decryptString(Buffer.from(data.secrets, 'base64'))); } catch { throw new Error('无法解密密钥，请使用原 Windows 账户打开应用'); }
    }
    return { config, secrets: { accessKey: createAccessKey(), upstreamKey: '', tunnelToken: '', ...secrets } };
  }
  save(config, secrets) {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows 密钥加密不可用，未保存任何密钥');
    fs.mkdirSync(this.directory, { recursive: true });
    const data = JSON.stringify({ version: 1, config: validateConfig(config), secrets: this.encryption.encryptString(JSON.stringify(secrets)).toString('base64') }, null, 2);
    const temporary = path.join(this.directory, 'settings.json.tmp');
    fs.writeFileSync(temporary, data, { mode: 0o600 }); fs.renameSync(temporary, path.join(this.directory, 'settings.json'));
  }
}
module.exports = { Store };
