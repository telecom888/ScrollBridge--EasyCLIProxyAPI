const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),profile=path.join(root,'.test-output','legacy-migration-'+Date.now());
fs.mkdirSync(profile,{recursive:true});
const bootstrap=path.join(profile,'bootstrap.cjs');
fs.writeFileSync(bootstrap,`
const {app,safeStorage}=require('electron');const fs=require('node:fs'),path=require('node:path');
const root=${JSON.stringify(root)},profile=${JSON.stringify(profile)};
app.setPath('userData',profile);app.getAppPath=()=>root;app.getVersion=()=>require(path.join(root,'package.json')).version;
app.whenReady().then(()=>{
 const key=require(path.join(root,'lib','config.cjs')).createAccessKey();
 const secrets={accessKey:key,upstreamKey:'test-upstream',tunnelToken:'test-tunnel'};
 const old={version:1,config:{knownModels:['open','blocked'],disabledModels:['blocked'],hostname:'api.example.com'},secrets:safeStorage.encryptString(JSON.stringify(secrets)).toString('base64')};
 const bytes=JSON.stringify(old);fs.writeFileSync(path.join(profile,'settings.json'),bytes);
 app.once('will-quit',()=>{
  const {Store}=require(path.join(root,'lib','store.cjs'));const store=new Store(profile,safeStorage);
  const current=store.load();const id=current.config.accessKeys[0].id;
  fs.writeFileSync(path.join(profile,'result.json'),JSON.stringify({keyPreserved:current.secrets.keyValues[id]===key,upstreamPreserved:current.secrets.upstreamKey===secrets.upstreamKey,tunnelPreserved:current.secrets.tunnelToken===secrets.tunnelToken,oldFilePreserved:fs.readFileSync(path.join(profile,'settings.json'),'utf8')===bytes,blockedPreserved:current.config.disabledModels.includes('blocked')}));
 });
 require(path.join(root,'electron','main.cjs'));
});
`);
const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile,SCROLLBRIDGE_SMOKE:'1',SCROLLBRIDGE_SMOKE_EXIT:'1'};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(require('electron'),[bootstrap],{env,windowsHide:true,timeout:25000,encoding:'utf8'});
if(result.error)throw result.error;assert.equal(result.status,0,result.stderr);
const report=JSON.parse(fs.readFileSync(path.join(profile,'result.json')));
assert.deepEqual(report,{keyPreserved:true,upstreamPreserved:true,tunnelPreserved:true,oldFilePreserved:true,blockedPreserved:true});
console.log('Actual Windows-encrypted v1 startup migration preserves every credential, blocked models and original file');
