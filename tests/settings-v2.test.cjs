const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Store}=require('../lib/store.cjs');
const {createAccessKey}=require('../lib/config.cjs');
const {convert}=require('../scripts/convert-settings.cjs');
test('manual conversion preserves key and settings; normal startup rejects v1',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-v2-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const accessKey=createAccessKey();
  const original={version:1,config:{hostname:'api.example.com',knownModels:['open','blocked'],disabledModels:['blocked'],imagesEnabled:true,geminiImageCompatibility:true,diagnosticModel:'open'}};
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify(original));
  const store=new Store(dir,{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()});
  assert.throws(()=>store.load(),/不受支持/);
  fs.writeFileSync(path.join(dir,'settings.json'),'null');assert.throws(()=>store.load(),/不受支持/);assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),'null');
  const result=convert(original,{accessKey,upstreamKey:'private-upstream',tunnelToken:'private-token'});
  assert.equal(result.secrets.keyValues[result.config.accessKeys[0].id],accessKey);assert.deepEqual(result.config.disabledModels,['blocked']);assert.equal(result.config.imagesEnabled,true);assert.equal(result.config.geminiImageCompatibility,true);assert.equal(result.config.hostname,'api.example.com');
  assert.equal(result.config.modelRules.length,2);assert.equal(result.config.accessKeys[0].mode,'all');
  store.save(result.config,result.secrets);assert.deepEqual(store.load(),result);
  assert.throws(()=>store.save(result.config,{...result.secrets,keyValues:{}}));assert.deepEqual(store.load(),result);
});
test('failed disk save leaves the previous settings file intact',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-save-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir,{isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()});
  const initial=store.load();store.save(initial.config,initial.secrets);
  fs.mkdirSync(path.join(dir,'settings.json.tmp'));
  assert.throws(()=>store.save({...initial.config,imagesEnabled:true},initial.secrets));assert.equal(store.load().config.imagesEnabled,false);
});
