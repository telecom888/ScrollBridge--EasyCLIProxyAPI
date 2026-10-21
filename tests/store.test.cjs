const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {Store}=require('../lib/store.cjs');
test('secrets persist through encryption adapter and are never plaintext on disk',t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scrollbridge-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const key=crypto.randomBytes(32);const enc={isEncryptionAvailable:()=>true,encryptString:s=>{const iv=crypto.randomBytes(16);const c=crypto.createCipheriv('aes-256-cbc',key,iv);return Buffer.concat([iv,c.update(s),c.final()]);},decryptString:b=>{const c=crypto.createDecipheriv('aes-256-cbc',key,b.subarray(0,16));return Buffer.concat([c.update(b.subarray(16)),c.final()]).toString();}};const store=new Store(dir,enc);const data=store.load();data.secrets.upstreamKey='private-upstream';data.secrets.tunnelToken='private-tunnel';store.save(data.config,data.secrets);const text=fs.readFileSync(path.join(dir,'settings.json'),'utf8');assert.ok(!text.includes('private-upstream'));assert.ok(!text.includes(data.secrets.accessKey));assert.deepEqual(store.load(),data);});
test('no plaintext fallback when OS encryption unavailable',()=>{const store=new Store('unused',{isEncryptionAvailable:()=>false});assert.throws(()=>store.save({},{}),/未保存/);});

const fakeEncryption={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()};
test('first installation persists identity once and restarts never rewrite settings or rotate keys',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-identity-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const first=new Store(dir,fakeEncryption).load();const original=fs.readFileSync(path.join(dir,'settings.json'));
 for(let i=0;i<3;i++)assert.deepEqual(new Store(dir,fakeEncryption).load(),first);
 assert.deepEqual(fs.readFileSync(path.join(dir,'settings.json')),original);
 const next={...first.config,theme:'dark'};new Store(dir,fakeEncryption).save(next,first.secrets);
 assert.deepEqual(fs.readFileSync(path.join(dir,'settings.json.bak')),original);
 assert.deepEqual(new Store(dir,fakeEncryption).load().secrets,first.secrets);
});
test('missing or corrupt settings in an existing profile never create replacement keys',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-missing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir,fakeEncryption);const initial=store.load();store.save(initial.config,initial.secrets);
 fs.unlinkSync(path.join(dir,'settings.json'));assert.throws(()=>store.load(),/未生成新密钥/);
 assert.equal(fs.existsSync(path.join(dir,'settings.json')),false);
 fs.writeFileSync(path.join(dir,'settings.json'),'{broken');assert.throws(()=>store.load(),/配置无法读取/);
 assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),'{broken');
});
test('unsupported format diagnostic contains structure only and preserves the source bytes',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-format-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const original=JSON.stringify({version:1,config:{private:'do-not-log'},secrets:'do-not-log-either'});
 fs.writeFileSync(path.join(dir,'settings.json'),original);
 assert.throws(()=>new Store(dir,fakeEncryption).load(),e=>{
  assert.deepEqual(e.configShape,{version:1,versionType:'number',configType:'object',secretsType:'string',hasConfig:true,hasSecrets:true});
  assert.equal(JSON.stringify(e.configShape).includes('do-not-log'),false);return true;
 });
 assert.equal(fs.readFileSync(path.join(dir,'settings.json'),'utf8'),original);
});
