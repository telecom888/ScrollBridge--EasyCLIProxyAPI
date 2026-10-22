const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),cp=require('node:child_process');
const {_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..'),scratch=path.join(root,'.test-output','startup-smoke-'+Date.now());
fs.mkdirSync(scratch,{recursive:true});
async function launch(directory,bootstrap){
 fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'scrollbridge-startup-test',version:require('../package.json').version,main:'bootstrap.cjs'}));fs.writeFileSync(path.join(directory,'bootstrap.cjs'),bootstrap);
 cp.execFileSync(process.execPath,['--check',path.join(directory,'bootstrap.cjs')]);
 const env={...process.env,SCROLLBRIDGE_TEST_DATA:path.join(directory,'profile'),SCROLLBRIDGE_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
 return electron.launch({executablePath:require('electron'),args:[directory],env});
}
async function nativeRegistration(){
 const name='ScrollBridge.StartupTest.'+crypto.randomUUID();
 const app=await launch(path.join(scratch,'native'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:false});w.loadURL('data:text/html,<title>Startup registration test</title>');});`);
 try{
  await app.firstWindow();
  const result=await app.evaluate(({app},{modulePath,name})=>{
   const require=process.getBuiltinModule('node:module').createRequire(modulePath);const {createStartup}=require(modulePath);
   const manager=createStartup({app,executable:process.execPath,name});const initial=manager.refresh();
   if(initial.registered)throw Error('Test registration unexpectedly exists');
   try{
    manager.change(true,()=>{});if(!manager.snapshot().enabled)throw Error('Actual enable failed');
    try{manager.change(false,()=>{throw Error('simulated disk error');});}catch(e){if(!e.message.includes('simulated disk error'))throw e;}
    if(!manager.snapshot().enabled)throw Error('Rollback did not restore actual registration');
    app.setLoginItemSettings({name,path:process.execPath,args:[],openAtLogin:true,enabled:false});
    const disabled=manager.refresh();if(!disabled.disabledBySystem || disabled.enabled)throw Error('System disabled entry not detected');
    manager.refresh();if(manager.snapshot().enabled)throw Error('Inspection unexpectedly enabled registration');
    manager.change(true,()=>{});manager.change(false,()=>{});
    if(manager.snapshot().registered)throw Error('Actual disable failed');return true;
   }finally{app.setLoginItemSettings({name,path:process.execPath,args:[],openAtLogin:false});}
  },{modulePath:path.join(root,'lib/startup.cjs'),name});assert.equal(result,true);
  console.log('Windows registration passed: enable, disable, externally disabled state and disk-failure rollback.');
 }finally{
  // Only the uniquely named entries created above; never a production entry.
  for(const key of ['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run']){
   cp.spawnSync('reg.exe',['delete',key,'/v',name,'/f'],{windowsHide:true,stdio:'ignore'});
   assert.notEqual(cp.spawnSync('reg.exe',['query',key,'/v',name],{windowsHide:true,stdio:'ignore'}).status,0);
  }
  await app.close();
 }
}
async function desktopFailures(){
 const directory=path.join(scratch,'desktop');
 const app=await launch(directory,`const {app}=require('electron');app.getAppPath=()=>${JSON.stringify(root)};global.startupMode='read-error';global.startupItem=null;global.startupWrites=0;app.getLoginItemSettings=()=>{if(global.startupMode==='read-error')throw Error('read denied');return{launchItems:global.startupItem?[global.startupItem]:[]};};app.setLoginItemSettings=options=>{global.startupWrites++;if(global.startupMode==='silent')return;global.startupItem=options.openAtLogin?{path:options.path,args:[],name:'mock',scope:'user',enabled:options.enabled}:null;};const {Store}=require(${JSON.stringify(path.join(root,'lib/store.cjs'))}),load=Store.prototype.load;Store.prototype.load=function(){const s=load.call(this);s.config.refreshModelsOnStartup=false;return s;};require(${JSON.stringify(path.join(root,'electron/main.cjs'))});`);
 try{
  const page=await app.firstWindow();await page.waitForFunction(()=>typeof snapshot!=='undefined' && !!snapshot);await page.click('[data-page=settings]');assert.match(await page.locator('#startup-status').innerText(),/无法读取/);assert.equal(await app.evaluate(()=>global.startupWrites),0);
  await app.evaluate(()=>{global.startupMode='silent';});await page.evaluate(async()=>render(await call('snapshot')));
  await page.evaluate(()=>{dirty=true;});
  await page.click('#launchAtLogin');await page.waitForFunction(()=>!pending);assert.equal(await page.locator('#launchAtLogin').isChecked(),false);assert.equal(await page.evaluate(()=>snapshot.config.launchAtLogin),false);assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'profile','scrollbridge.json'))).config.launchAtLogin,false);
  await app.evaluate(()=>{global.startupMode='normal';});await page.check('#launchAtLogin');await page.waitForFunction(()=>!pending && snapshot.startup.enabled===true);assert.equal(await page.evaluate(()=>snapshot.config.launchAtLogin),true);
  const writes=await app.evaluate(()=>{global.startupItem.enabled=false;return global.startupWrites;});await page.evaluate(async()=>render(await call('snapshot')));assert.equal(await page.locator('#launchAtLogin').isChecked(),false);assert.match(await page.locator('#startup-status').innerText(),/Windows 中禁用/);assert.equal(await app.evaluate(()=>global.startupWrites),writes);
  console.log('Desktop passed: registry read error does not block window, failed setting restores checkbox/config, actual disabled state is displayed.');
 }finally{await app.close();}
}
(async()=>{if(process.platform!=='win32'){console.log('Windows startup smoke skipped on this platform');return;}await nativeRegistration();await desktopFailures();})().catch(e=>{console.error(e);process.exitCode=1;});
