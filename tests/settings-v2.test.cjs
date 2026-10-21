const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store.cjs');
const {createAccessKey}=require('../lib/config.cjs');
const {convert}=require('../scripts/convert-settings.cjs');
test('legacy startup migration preserves keys and settings, leaves the old file untouched and resists old writers',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-v2-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const accessKey=createAccessKey();
  const original={version:1,config:{hostname:'api.example.com',knownModels:['open','blocked'],disabledModels:['blocked'],imagesEnabled:true,geminiImageCompatibility:true,diagnosticModel:'open'}};
  const store=new Store(dir,{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()});
  const legacy={...original,secrets:Buffer.from(JSON.stringify({accessKey,upstreamKey:'private-upstream',tunnelToken:'private-token'})).toString('base64')};
  const legacyBytes=JSON.stringify(legacy);fs.writeFileSync(path.join(dir,'settings.json'),legacyBytes);
  const migrated=store.load();assert.equal(migrated.secrets.keyValues[migrated.config.accessKeys[0].id],accessKey);
  assert.equal(migrated.secrets.upstreamKey,'private-upstream');assert.equal(migrated.secrets.tunnelToken,'private-token');
  assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),legacyBytes);
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({...legacy,secrets:Buffer.from(JSON.stringify({accessKey:createAccessKey(),upstreamKey:'',tunnelToken:''})).toString('base64')}));
  assert.deepEqual(store.load(),migrated);
  const result=convert(original,{accessKey,upstreamKey:'private-upstream',tunnelToken:'private-token'});
  assert.equal(result.secrets.keyValues[result.config.accessKeys[0].id],accessKey);assert.deepEqual(result.config.disabledModels,['blocked']);assert.equal(result.config.imagesEnabled,true);assert.equal(result.config.geminiImageCompatibility,true);assert.equal(result.config.hostname,'api.example.com');
  assert.equal(result.config.modelRules.length,2);assert.equal(result.config.accessKeys[0].mode,'all');
  store.save(result.config,result.secrets);assert.deepEqual(store.load(),result);
  assert.throws(()=>store.save(result.config,{...result.secrets,keyValues:{}}));assert.deepEqual(store.load(),result);
});

test('existing v2 imports every credential and permission without regenerating key identities',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-import-v2-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const enc={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
 const first=new Store(dir,enc).load();fs.renameSync(path.join(dir,'settings.v2.json'),path.join(dir,'settings.json'));
 assert.deepEqual(new Store(dir,enc).load(),first);
 assert.equal(fs.existsSync(path.join(dir,'settings.json')),true);
 fs.unlinkSync(path.join(dir,'settings.v2.json'));
 fs.writeFileSync(path.join(dir,'settings.v2.json.bak'),'encrypted-backup');
 assert.throws(()=>new Store(dir,enc).load(),/未生成新密钥/);
});
test('failed disk save leaves the previous settings file intact',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-save-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir,{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()});
  const initial=store.load();store.save(initial.config,initial.secrets);
  fs.mkdirSync(path.join(dir,'settings.v2.json.tmp'));
  assert.throws(()=>store.save({...initial.config,imagesEnabled:true},initial.secrets));assert.equal(store.load().config.imagesEnabled,false);
});
