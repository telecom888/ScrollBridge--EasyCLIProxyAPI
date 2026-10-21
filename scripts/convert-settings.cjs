// One-time operator tool. Never imported by the desktop startup path.
const fs=require('node:fs');
const path=require('node:path');
const {validateConfig}=require('../lib/config.cjs');
const {syncModels}=require('../lib/policy.cjs');
const {convert}=require('../lib/migrate-settings.cjs');
if(require.main===module || process.versions.electron && process.type==='browser'){
  const {app,safeStorage}=require('electron');
  const {Store}=require('../lib/store.cjs');
  const source=process.argv[2];
  if(!source){console.error('用法：electron scripts/convert-settings.cjs 配置目录 [--check]');app.exit(1);}
  else {
    const directory=path.resolve(source),filename=path.join(directory,'settings.json');
    const scratch=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'scrollbridge-convert-'));
    const localState=path.join(directory,'Local State');if(fs.existsSync(localState))fs.copyFileSync(localState,path.join(scratch,'Local State'));
    app.setPath('userData',scratch);
    app.whenReady().then(async()=>{
      if(!safeStorage.isEncryptionAvailable())throw new Error('Windows 密钥加密不可用');
      const original=fs.readFileSync(filename),data=JSON.parse(original.toString('utf8'));
      const converted=convert(data,JSON.parse(safeStorage.decryptString(Buffer.from(data.secrets,'base64'))));
      if(process.argv.includes('--refresh-models')) {
        const knownModels=await require('../lib/models.cjs').fetchModels(converted.config,converted.secrets);
        converted.config=validateConfig({...syncModels(converted.config,knownModels),modelsUpdatedAt:new Date().toISOString()});
      }
      if(!process.argv.includes('--check')) {
        const backup=`${filename}.before-v2-${Date.now()}.bak`;
        fs.writeFileSync(backup,original,{flag:'wx',mode:0o600});
        new Store(directory,safeStorage).save(converted.config,converted.secrets);
        const restored=new Store(directory,safeStorage).load();
        if(restored.secrets.keyValues[converted.config.accessKeys[0].id]!==converted.secrets.keyValues[converted.config.accessKeys[0].id])throw new Error('转换后密钥校验失败');
      }
      console.log(JSON.stringify({ok:true,checkOnly:process.argv.includes('--check'),version:2,modelCount:converted.config.knownModels.length,keyCount:1,preservedExistingKey:true}));app.quit();
    }).catch(error=>{console.error(error.message);app.exit(1);});
  }
}
module.exports={convert};
