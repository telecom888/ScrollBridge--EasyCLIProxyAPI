const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),profile=path.join(root,'.test-output','format-error-'+Date.now());
fs.mkdirSync(profile,{recursive:true});
const original=JSON.stringify({version:1,config:{},secrets:'private-test-value'});
fs.writeFileSync(path.join(profile,'settings.v2.json'),original);
const bootstrap=path.join(profile,'bootstrap.cjs');
// Resolve the Electron API from the application's runtime, not its npm launcher.
fs.writeFileSync(bootstrap,`
const {app,dialog}=require('electron');
const fs=require('node:fs');
app.getAppPath=()=>${JSON.stringify(root)};
app.getVersion=()=>${JSON.stringify(require('../package.json').version)};
dialog.showErrorBox=(title,message)=>fs.writeFileSync(${JSON.stringify(path.join(profile,'dialog.txt'))},message);
require(${JSON.stringify(path.join(root,'electron','main.cjs'))});
`);
const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(require('electron'),[bootstrap],{env,windowsHide:true,timeout:20000,encoding:'utf8'});
if(result.error)throw result.error;assert.equal(result.status,0,result.stderr);
const report=fs.readFileSync(path.join(profile,'startup-error.json'),'utf8');
assert.equal(JSON.parse(report).configShape.version,1);
assert.equal(JSON.parse(report).expectedFormat,2);
assert.equal(report.includes('private-test-value'),false);
assert.equal(fs.readFileSync(path.join(profile,'settings.v2.json'),'utf8'),original);
assert.match(fs.readFileSync(path.join(profile,'dialog.txt'),'utf8'),/startup-error\.json/);
console.log('Actual Electron startup records format failure without exposing credentials or overwriting settings');
