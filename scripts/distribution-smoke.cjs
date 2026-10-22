const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const {Store,SETTINGS_FILE}=require('../lib/store.cjs');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const scratch=path.join(root,'.test-output','distributions-'+Date.now());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function run(file,args,env=process.env){return new Promise((resolve,reject)=>{
 const child=spawn(file,args,{env,windowsHide:true,stdio:'ignore'});
 const timer=setTimeout(()=>{child.kill();reject(Error('Process timeout: '+path.basename(file)));},120000);
 child.once('error',e=>{clearTimeout(timer);reject(e);});
 child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(path.basename(file)+' exited '+code));});
});}
function installerLocations(){
 const command='@(Get-ChildItem HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall | Get-ItemProperty | Where-Object { $_.DisplayName -like "卷桥*" -or $_.DisplayName -like "ScrollBridge*" } | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress';
 const text=execFileSync('pwsh',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true}).trim();
 return text?JSON.parse(text):[];
}
async function launch(file,profile,portable=false){
 const env={...process.env,SCROLLBRIDGE_TEST_PROFILE:profile,SCROLLBRIDGE_SMOKE:'1',SCROLLBRIDGE_SMOKE_EXIT:'1'};
 for(const key of ['SCROLLBRIDGE_TEST_DATA','ELECTRON_RUN_AS_NODE','SCROLLBRIDGE_GATEWAY_ENGINE'])delete env[key];
 const pending=run(file,[],env);let completed=false;pending.then(()=>{completed=true;},()=>{completed=true;});
 const marker=path.join(profile,'runtime-ready.json'),deadline=Date.now()+60000;
 while(!fs.existsSync(marker)&&!completed&&Date.now()<deadline)await sleep(100);
 await pending;assert.equal(fs.existsSync(marker),true,'application must load the desktop');
 assert.deepEqual(JSON.parse(fs.readFileSync(marker)),{packaged:true,portable,encrypted:true,ready:true});
 assert.equal(fs.existsSync(path.join(profile,SETTINGS_FILE)),false,'settings must stay beside the executable');
}
(async()=>{
 fs.mkdirSync(scratch,{recursive:true});
 const release=path.join(root,'release'),zip=path.join(release,`ScrollBridge-${version}-win-x64.zip`),setup=path.join(release,`ScrollBridge-Setup-${version}-win-x64.exe`),portable=path.join(release,`ScrollBridge-${version}-win-x64.exe`);
 const entries=execFileSync('tar',['-tf',zip],{encoding:'utf8',windowsHide:true}).split(/\r?\n/);
 assert.equal(entries.some(e=>e.endsWith('/'+SETTINGS_FILE) || e===SETTINGS_FILE),false,'personal settings must not ship');
 const folder=path.join(scratch,'zip');fs.mkdirSync(folder);await run('tar',['-xf',zip,'-C',folder]);
 const source=new Store(path.join(scratch,'fixture')),fixture=source.load();fixture.config.refreshModelsOnStartup=false;fixture.config.launchAtLogin=false;source.save(fixture.config,fixture.secrets);
 const original=fs.readFileSync(source.filename);
 fs.copyFileSync(source.filename,path.join(folder,SETTINGS_FILE));
 await launch(path.join(folder,'卷桥.exe'),path.join(scratch,'zip-profile'));
 assert.deepEqual(fs.readFileSync(path.join(folder,SETTINGS_FILE)),original);
 const portableFolder=path.join(scratch,'portable');fs.mkdirSync(portableFolder);const copied=path.join(portableFolder,'卷桥.exe');fs.copyFileSync(portable,copied);fs.copyFileSync(source.filename,path.join(portableFolder,SETTINGS_FILE));
 await launch(copied,path.join(scratch,'portable-profile'),true);
 assert.deepEqual(fs.readFileSync(path.join(portableFolder,SETTINGS_FILE)),original);
 assert.deepEqual(installerLocations(),[],'existing installed edition must not be replaced by a test');
 const command='@([Environment]::GetFolderPath("Desktop"),[Environment]::GetFolderPath("Programs")) | ConvertTo-Json -Compress';
 const shortcuts=JSON.parse(execFileSync('pwsh',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true})).map(dir=>path.join(dir,'卷桥.lnk'));
 const backups=shortcuts.map(file=>({file,data:fs.existsSync(file)?fs.readFileSync(file):null}));
 const install=path.join(scratch,'installed');let uninstaller;
 try{
  console.log('Testing first installation');await run(setup,['/S','/currentuser','/D='+install]);
  assert.equal(fs.existsSync(path.join(install,'卷桥.exe')),true);
  uninstaller=path.join(install,fs.readdirSync(install).find(name=>/^Uninstall.*\.exe$/i.test(name)) || 'missing-uninstaller');
  assert.equal(fs.existsSync(uninstaller),true);
  fs.copyFileSync(source.filename,path.join(install,SETTINGS_FILE));
  await launch(path.join(install,'卷桥.exe'),path.join(scratch,'installed-profile'));
  assert.deepEqual(fs.readFileSync(path.join(install,SETTINGS_FILE)),original);
  console.log('Testing reinstall after application exit');await run(setup,['/S','/currentuser','/D='+install]);
  assert.deepEqual(fs.readFileSync(path.join(install,SETTINGS_FILE)),original,'reinstall must preserve credentials byte for byte');
  console.log('Testing uninstall and configuration retention');await run(uninstaller,['/S','/currentuser']);
  const deadline=Date.now()+30000;
  while((fs.existsSync(path.join(install,'卷桥.exe')) || !fs.existsSync(path.join(install,SETTINGS_FILE))) && Date.now()<deadline)await sleep(200);
  assert.equal(fs.existsSync(path.join(install,'卷桥.exe')),false);
  assert.deepEqual(fs.readFileSync(path.join(install,SETTINGS_FILE)),original,'uninstall must preserve the existing configuration');
  assert.deepEqual(installerLocations(),[]);
 }finally{
  for(const {file,data} of backups){if(data)fs.writeFileSync(file,data);else if(fs.existsSync(file))fs.unlinkSync(file);}
 }
 fs.writeFileSync(path.join(scratch,'report.json'),JSON.stringify({ok:true,version,zip:true,portable:true,installer:true,reinstallPreservesConfig:true,uninstallPreservesConfig:true},null,2));
 console.log('Three distributions passed: ZIP, portable, installer, same-directory settings, reinstall/uninstall credential preservation. Report: '+scratch);
})().catch(e=>{console.error(e);process.exitCode=1;});
