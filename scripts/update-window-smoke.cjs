const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Store}=require('../lib/store.cjs');
(async()=>{
 const profile=path.resolve('.test-output/update-window-'+Date.now()),store=new Store(profile),data=store.load();
 data.config.refreshModelsOnStartup=false;store.save(data.config,data.secrets);const original=fs.readFileSync(store.filename);
 const executable=process.argv[2]||require('electron'),id=crypto.randomUUID(),directory=path.join(profile,'updates',id),version=require('../package.json').version;
 fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'job.json'),JSON.stringify({id,version,executable,profileDirectory:profile,resumeConnection:false}));
 const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile,SCROLLBRIDGE_TEST_PROFILE:profile,SCROLLBRIDGE_UPDATE_ID:id,SCROLLBRIDGE_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
 // SMOKE deliberately creates a hidden window, reproducing the old restart state.
 const app=await electron.launch({executablePath:executable,args:process.argv[2]?[]:['.'],env});
 try{
  await app.firstWindow();
  const deadline=Date.now()+15000;
  while(!fs.existsSync(path.join(directory,'ready.json'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  assert.equal(fs.existsSync(path.join(directory,'ready.json')),true,'acknowledgement requires a visible ready desktop');
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return {visible:w.isVisible(),minimized:w.isMinimized()};}),{visible:true,minimized:false});
  assert.deepEqual(fs.readFileSync(store.filename),original);
  console.log('Update restart passed: initially hidden desktop becomes visible before acknowledgement; configuration unchanged');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
