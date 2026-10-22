const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createUpdater,isNewer,selectAsset,releaseUrl,githubFetch,REPOSITORY}=require('../lib/updates.cjs');
const {safeFiles}=require('../lib/update-install.cjs');
const {readUpdateTicket,acknowledgeUpdate}=require('../lib/update-ticket.cjs');
function fixture(t,options={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sb-updates-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const version='0.3.14',bytes=Buffer.from('verified-update-fixture'),name=`ScrollBridge-${version}-win-x64.zip`,url=`https://github.com/${REPOSITORY}/releases/download/v${version}/`;
 const manifest={schemaVersion:1,version,assets:{zip:{name,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}}};
 const release={tag_name:'v'+version,assets:[{name,size:bytes.length,browser_download_url:url+name},{name:'scrollbridge-update.json',browser_download_url:url+'scrollbridge-update.json'}]};
 const calls=[],installs=[],changes=[];
 const fetcher=async(address,opts)=>{calls.push({address,opts});if(address.includes('/releases/latest'))return Response.json(release);if(address.endsWith('/scrollbridge-update.json'))return Response.json(manifest);return new Response(options.body || bytes);};
 const updater=createUpdater({getVersion:()=>options.currentVersion || '0.3.13',kind:'zip',directory,onChange:s=>changes.push(s),install:async payload=>{installs.push(payload);assert.deepEqual(fs.readFileSync(payload.filename),bytes);return options.deferInstall?false:true;},fetcher:options.fetcher || fetcher});
 return{directory,bytes,manifest,release,calls,installs,changes,updater};
}
test('update versions compare numerically and require stable release identifiers',()=>{
 assert.equal(isNewer('v0.3.14','0.3.13'),true);assert.equal(isNewer('0.10.0','0.9.99'),true);assert.equal(isNewer('0.3.13','0.3.13'),false);assert.equal(isNewer('0.3.12','0.3.13'),false);
 for(const value of ['main','0.3.14-beta','1.2','1.2.3/../../x'])assert.throws(()=>isNewer(value,'0.3.13'));
});
test('each distribution selects only its matching release asset and complete checksum metadata',t=>{
 const f=fixture(t);assert.equal(selectAsset(f.release,f.manifest,'zip').name,f.manifest.assets.zip.name);
 for(const kind of ['installer','portable']){
  const name=kind==='installer'?'ScrollBridge-Setup-0.3.14-win-x64.exe':'ScrollBridge-0.3.14-win-x64.exe';
  const asset={...f.manifest.assets.zip,name};const release={...f.release,assets:[{name,size:asset.size,browser_download_url:`https://github.com/${REPOSITORY}/releases/download/v0.3.14/${name}`} ]};
  assert.equal(selectAsset(release,{...f.manifest,assets:{[kind]:asset}},kind).name,name);
 }
 assert.throws(()=>selectAsset(f.release,{...f.manifest,version:'0.3.99'},'zip'));
 assert.throws(()=>selectAsset(f.release,{...f.manifest,assets:{zip:{...f.manifest.assets.zip,sha256:'bad'}}},'zip'));
 assert.throws(()=>selectAsset({...f.release,assets:[]},f.manifest,'zip'));
});
test('release URLs and redirects cannot escape GitHub HTTPS download hosts',async()=>{
 for(const url of ['http://github.com/x','https://evil.example/x',`https://github.com/other/repo/releases/download/v1/a`,`https://github.com/${REPOSITORY}/releases/download/v1/a?token=x`])assert.throws(()=>releaseUrl(url));
 let calls=0;await assert.rejects(githubFetch('https://api.github.com/x',{},async(_,options)=>{calls++;assert.equal(options.headers.authorization,undefined);return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}});}),/不受信任/);assert.equal(calls,1);
});
test('checking is explicit and a verified complete download starts installation once',async t=>{
 const f=fixture(t);assert.equal(f.calls.length,0);await f.updater.check();assert.equal(f.updater.snapshot().phase,'available');await f.updater.download();assert.equal(f.installs.length,1);assert.equal(f.changes.some(s=>s.progress===100),true);assert.equal(f.updater.snapshot().phase,'installing');
 await f.updater.download();assert.equal(f.installs.length,1);
});
test('no release, current version, missing manifest and network failure do not offer unsafe downloads',async t=>{
 const current=fixture(t,{currentVersion:'0.3.14'});await current.updater.check();assert.equal(current.updater.snapshot().phase,'latest');assert.equal(current.calls.length,1);
 for(const fetcher of [async()=>new Response(null,{status:404}),async()=>{throw Error('offline');},async()=>Response.json({tag_name:'v0.3.14',assets:[]})]){
  const f=fixture(t,{fetcher});await f.updater.check();assert.equal(f.updater.snapshot().canDownload,false);assert.equal(f.installs.length,0);
 }
});
test('damaged and truncated downloads never install, retain retry and remove partial files',async t=>{
 for(const body of [Buffer.from('short'),Buffer.from('x'.repeat(23))]){const f=fixture(t,{body});await f.updater.check();await f.updater.download();assert.equal(f.installs.length,0);assert.equal(f.updater.snapshot().phase,'error');assert.equal(f.updater.snapshot().canDownload,true);for(const dir of fs.readdirSync(f.directory))assert.equal(fs.readdirSync(path.join(f.directory,dir)).some(n=>n.endsWith('.part')),false);}
});
test('unsaved changes can defer installation without discarding the downloaded update',async t=>{
 const f=fixture(t,{deferInstall:true});await f.updater.check();await f.updater.download();assert.equal(f.updater.snapshot().phase,'ready');assert.equal(f.installs.length,1);await f.updater.apply();assert.equal(f.installs.length,2);assert.equal(f.calls.length,3);
});
test('application file lists reject path traversal, credential overwrite and duplicate aliases',()=>{
 assert.deepEqual(safeFiles(['卷桥.exe','resources/app.asar']),['卷桥.exe','resources/app.asar']);
 for(const files of [['../x'],['/absolute'],['C:/x'],['a/../../b'],['scrollbridge.json'],['a.exe','A.exe'],['a\\b']])assert.throws(()=>safeFiles(files));
});
test('restart acknowledgement belongs to the exact profile, executable and release',t=>{
 const f=fixture(t),id=crypto.randomUUID(),directory=path.join(f.directory,'updates',id),executable=path.join(f.directory,'app.exe');fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,'job.json'),JSON.stringify({id,version:'0.3.14',executable,profileDirectory:f.directory,resumeConnection:true}));
 const args={id,profileDirectory:f.directory,version:'0.3.14',executable},ticket=readUpdateTicket(args);acknowledgeUpdate(ticket,'0.3.14');assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'ready.json'))).id,id);
 assert.throws(()=>readUpdateTicket({...args,version:'0.3.13'}));assert.throws(()=>readUpdateTicket({...args,id:'../escape'}));
});
test('anonymous API quota falls back to the public latest release file without credentials',async t=>{
 const f=fixture(t);let calls=0;
 const updater=createUpdater({getVersion:()=> '0.3.13',kind:'zip',directory:f.directory,install:async()=>{},fetcher:async(url,options)=>{
  assert.equal(options.headers?.authorization,undefined);calls++;
  if(url.includes('api.github.com'))return new Response(null,{status:403});
  assert.match(url,/\/releases\/latest\/download\/scrollbridge-update.json$/);return Response.json(f.manifest);
 }});
 await updater.check();assert.equal(calls,2);assert.equal(updater.snapshot().phase,'available');assert.equal(updater.snapshot().availableVersion,'0.3.14');
});
