const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Store,SETTINGS_FILE}=require('../lib/store.cjs');

(async()=>{
 const scratch=path.resolve(`.test-output/portable-secrets-${Date.now()}`),source=path.join(scratch,'source');
 const store=new Store(source),data=store.load();
 data.config.refreshModelsOnStartup=false;data.config.launchAtLogin=false;
 data.secrets.upstreamKey='synthetic-upstream';data.secrets.tunnelToken='synthetic-tunnel';store.save(data.config,data.secrets);
 const original=fs.readFileSync(path.join(source,SETTINGS_FILE)),digest=crypto.createHash('sha256').update(JSON.stringify(data.secrets)).digest('hex');
 const base={...process.env};delete base.ELECTRON_RUN_AS_NODE;
 for(const name of ['first-profile','fresh-profile']){
  const profile=path.join(scratch,name);fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,SETTINGS_FILE),original);
  assert.equal(fs.existsSync(path.join(profile,'Local State')),false);
  const app=await electron.launch({executablePath:process.argv[2] || require('electron'),args:process.argv[2]?[]:['.'],env:{...base,SCROLLBRIDGE_TEST_DATA:profile}});
  try{
   const page=await app.firstWindow();await page.waitForFunction(()=>typeof snapshot!=='undefined' && !!snapshot);
   const state=await page.evaluate(()=>({keys:snapshot.keys.length,upstream:snapshot.hasUpstreamKey,tunnel:snapshot.hasTunnelToken}));assert.deepEqual(state,{keys:1,upstream:true,tunnel:true});
   const actual=await app.evaluate(({app})=>{
    const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
    const {Store}=require(app.getAppPath()+'/lib/store.cjs');
    return require('node:crypto').createHash('sha256').update(JSON.stringify(new Store(app.getPath('userData')).load().secrets)).digest('hex');
   });assert.equal(actual,digest);assert.deepEqual(fs.readFileSync(path.join(profile,SETTINGS_FILE)),original);
  }finally{await app.close();}
 }
 console.log('Portable AES desktop passed: identical credentials and ciphertext across two fresh Electron profiles without copying Local State');
})().catch(e=>{console.error(e);process.exitCode=1;});
