// Exercise the two packaged editions with ONE persisted Windows-encrypted identity.
const {_electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
(async()=>{
 const builds=JSON.parse(fs.readFileSync(process.argv[2]||'.test-output/desktop-builds.json'));
 const profile=path.resolve(`.test-output/shared-profile-${Date.now()}`);
 const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile};
 delete env.ELECTRON_RUN_AS_NODE;delete env.SCROLLBRIDGE_GATEWAY_ENGINE;
 let reference;
 for(const engine of ['node','go','node','go']){
  const app=await _electron.launch({executablePath:path.join(builds[engine],'win-unpacked','卷桥.exe'),env});
  try{
   const page=await app.firstWindow();await page.waitForFunction(()=>!!snapshot);
   const file=path.join(profile,'settings.json');
   if(!reference){reference=fs.readFileSync(file);fs.writeFileSync(path.join(profile,'reference.encrypted'),reference);}
   assert.deepEqual(fs.readFileSync(file),reference,'startup must not rewrite encrypted settings');
   const preserved=await app.evaluate(({app,safeStorage})=>{
    const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');
    const fs=require('node:fs'),path=require('node:path');
    const {Store}=require(path.join(app.getAppPath(),'lib','store.cjs'));
    const current=new Store(app.getPath('userData'),safeStorage).load();
    const original=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'reference.encrypted')));
    return JSON.stringify(current.secrets)===safeStorage.decryptString(Buffer.from(original.secrets,'base64')) &&
     JSON.stringify(current.config.accessKeys)===JSON.stringify(original.config.accessKeys);
   });
   assert.equal(preserved,true,'all credential values and key identities must survive edition switches');
   const second=spawn(path.join(builds[engine],'win-unpacked','卷桥.exe'),[],{env,windowsHide:true,stdio:'ignore'});
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{second.kill();reject(new Error('second instance did not exit'))},10000);
    second.once('error',e=>{clearTimeout(timer);reject(e)});
    second.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('second instance failed'))});
   });
   assert.deepEqual(fs.readFileSync(file),reference,'second instance must not rewrite credentials');
  }finally{await app.close()}
 }
 console.log('Shared encrypted profile survives four packaged launches, edition switches and duplicate instances without changing any key');
})().catch(e=>{console.error(e.message);process.exitCode=1});
