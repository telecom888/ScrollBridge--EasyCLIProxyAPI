const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Store,SETTINGS_FILE}=require('../lib/store.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const key=crypto.randomBytes(32),counts={encrypt:0,decrypt:0};
 const encryption={isEncryptionAvailable:()=>true,encryptString:s=>{counts.encrypt++;const iv=crypto.randomBytes(16),c=crypto.createCipheriv('aes-256-cbc',key,iv);return Buffer.concat([iv,c.update(s),c.final()]);},decryptString:b=>{counts.decrypt++;const c=crypto.createDecipheriv('aes-256-cbc',key,b.subarray(0,16));return Buffer.concat([c.update(b.subarray(16)),c.final()]).toString();}};
 return {dir,counts,encryption,store:new Store(dir,encryption),file:path.join(dir,SETTINGS_FILE)};
}
test('one encrypted portable file persists every credential and creates no backup',t=>{
 const f=fixture(t),data=f.store.load();data.secrets.upstreamKey='private-upstream';data.secrets.tunnelToken='private-tunnel';f.store.save(data.config,data.secrets);
 const text=fs.readFileSync(f.file,'utf8');for(const value of [...Object.values(data.secrets.keyValues),'private-upstream','private-tunnel'])assert.equal(text.includes(value),false);
 assert.deepEqual(new Store(f.dir,f.encryption).load(),data);assert.deepEqual(fs.readdirSync(f.dir),[SETTINGS_FILE]);
});
test('restarts preserve keys; unchanged saves do no encryption or IO; appearance changes reuse ciphertext',t=>{
 const f=fixture(t),data=f.store.load();assert.deepEqual(f.counts,{encrypt:1,decrypt:0});
 const original=fs.readFileSync(f.file,'utf8');const store=new Store(f.dir,f.encryption);assert.deepEqual(store.load(),data);
 assert.deepEqual(f.counts,{encrypt:1,decrypt:1});
 fs.mkdirSync(f.file+'.tmp');store.save(data.config,data.secrets);assert.equal(fs.readFileSync(f.file,'utf8'),original);fs.rmdirSync(f.file+'.tmp');
 store.save({...data.config,theme:'dark'},data.secrets);assert.deepEqual(f.counts,{encrypt:1,decrypt:1});
 assert.equal(JSON.parse(fs.readFileSync(f.file)).secrets,JSON.parse(original).secrets);
 const id=data.config.accessKeys[0].id;const secrets={...data.secrets,keyValues:{...data.secrets.keyValues,[id]:'sb_'+crypto.randomBytes(32).toString('hex')}};
 store.save({...data.config,theme:'dark'},secrets);assert.equal(f.counts.encrypt,2);assert.deepEqual(new Store(f.dir,f.encryption).load().secrets,secrets);
});
test('failed atomic save leaves the previous identity and configuration intact',t=>{
 const f=fixture(t),data=f.store.load(),before=fs.readFileSync(f.file);fs.mkdirSync(f.file+'.tmp');
 assert.throws(()=>f.store.save({...data.config,imagesEnabled:true},data.secrets));assert.deepEqual(fs.readFileSync(f.file),before);
 assert.deepEqual(new Store(f.dir,f.encryption).load(),data);
});
test('invalid and interrupted files never become fresh installations; no old-format fallback',t=>{
 const f=fixture(t);fs.writeFileSync(f.file+'.tmp','interrupted');assert.throws(()=>f.store.load(),/未生成新密钥/);assert.equal(fs.existsSync(f.file),false);fs.unlinkSync(f.file+'.tmp');
 const original=JSON.stringify({version:1,config:{private:'do-not-log'},secrets:'do-not-log-either'});fs.writeFileSync(f.file,original);
 assert.throws(()=>f.store.load(),e=>{assert.equal(e.configShape.version,1);assert.equal(JSON.stringify(e.configShape).includes('do-not-log'),false);return true;});
 assert.equal(fs.readFileSync(f.file,'utf8'),original);fs.writeFileSync(f.file,'{broken');assert.throws(()=>f.store.load(),/配置无法读取/);assert.equal(fs.readFileSync(f.file,'utf8'),'{broken');
});
test('unavailable encryption and wrong account never save plaintext or replace existing credentials',t=>{
 const f=fixture(t),data=f.store.load(),before=fs.readFileSync(f.file);
 const unavailable=new Store(f.dir,{isEncryptionAvailable:()=>false});assert.throws(()=>unavailable.load(),/加密不可用/);assert.throws(()=>unavailable.save(data.config,data.secrets),/未保存/);
 const wrong=new Store(f.dir,{isEncryptionAvailable:()=>true,decryptString:()=>{throw Error('wrong account')}});assert.throws(()=>wrong.load(),/原 Windows 账户/);assert.deepEqual(fs.readFileSync(f.file),before);
});
