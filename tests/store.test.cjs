const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Store,SETTINGS_FILE,SETTINGS_VERSION}=require('../lib/store.cjs');
const {encryptSecrets,decryptSecrets}=require('../lib/secrets-crypto.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 return {dir,store:new Store(dir),file:path.join(dir,SETTINGS_FILE)};
}
test('portable credentials survive a new process and directory without an account provider',t=>{
 const f=fixture(t),data=f.store.load();data.secrets.upstreamKey='private-upstream';data.secrets.tunnelToken='private-tunnel';f.store.save(data.config,data.secrets);
 const text=fs.readFileSync(f.file,'utf8');for(const value of [...Object.values(data.secrets.keyValues),'private-upstream','private-tunnel'])assert.equal(text.includes(value),false);
 assert.equal(JSON.parse(text).version,SETTINGS_VERSION);assert.deepEqual(new Store(f.dir).load(),data);assert.deepEqual(fs.readdirSync(f.dir),[SETTINGS_FILE]);
 const other=fixture(t);fs.copyFileSync(f.file,other.file);
 const digest=crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
 const script='const {Store}=require('+JSON.stringify(require.resolve('../lib/store.cjs'))+');const data=new Store(process.argv[1]).load();process.stdout.write(require("node:crypto").createHash("sha256").update(JSON.stringify(data)).digest("hex"))';
 assert.equal(execFileSync(process.execPath,['-e',script,other.dir],{encoding:'utf8',windowsHide:true}),digest);
});
test('unchanged saves do no IO; configuration edits reuse ciphertext without rotating credentials',t=>{
 const f=fixture(t),data=f.store.load(),original=fs.readFileSync(f.file,'utf8'),store=new Store(f.dir);assert.deepEqual(store.load(),data);
 fs.mkdirSync(f.file+'.tmp');store.save(data.config,data.secrets);assert.equal(fs.readFileSync(f.file,'utf8'),original);fs.rmdirSync(f.file+'.tmp');
 store.save({...data.config,theme:'dark'},data.secrets);assert.equal(JSON.parse(fs.readFileSync(f.file)).secrets,JSON.parse(original).secrets);
 const id=data.config.accessKeys[0].id,secrets={...data.secrets,keyValues:{...data.secrets.keyValues,[id]:'sb_'+crypto.randomBytes(32).toString('hex')}};
 store.save({...data.config,theme:'dark'},secrets);assert.notEqual(JSON.parse(fs.readFileSync(f.file)).secrets,JSON.parse(original).secrets);assert.deepEqual(new Store(f.dir).load().secrets,secrets);
});
test('failed atomic save leaves previous credentials and configuration intact',t=>{
 const f=fixture(t),data=f.store.load(),before=fs.readFileSync(f.file);fs.mkdirSync(f.file+'.tmp');
 assert.throws(()=>f.store.save({...data.config,imagesEnabled:true},data.secrets));assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(new Store(f.dir).load(),data);
});
test('invalid, old and interrupted files never become fresh installations',t=>{
 const f=fixture(t);fs.writeFileSync(f.file+'.tmp','interrupted');assert.throws(()=>f.store.load(),/未生成新密钥/);assert.equal(fs.existsSync(f.file),false);fs.unlinkSync(f.file+'.tmp');
 for(const version of [1,2]){const original=JSON.stringify({version,config:{private:'do-not-log'},secrets:'do-not-log-either'});fs.writeFileSync(f.file,original);assert.throws(()=>f.store.load(),e=>{assert.equal(e.configShape.version,version);assert.equal(JSON.stringify(e.configShape).includes('do-not-log'),false);return true;});assert.equal(fs.readFileSync(f.file,'utf8'),original);}
 fs.writeFileSync(f.file,'{broken');assert.throws(()=>f.store.load(),/配置无法读取/);assert.equal(fs.readFileSync(f.file,'utf8'),'{broken');
});
test('AES uses fresh nonces and rejects damaged files without replacing credentials',t=>{
 const plain='synthetic-secret',a=encryptSecrets(plain),b=encryptSecrets(plain);assert.notEqual(a,b);assert.equal(decryptSecrets(a),plain);assert.equal(decryptSecrets(b),plain);
 for(const index of [0,4,16,32]){const bytes=Buffer.from(a,'base64');bytes[index]^=1;assert.throws(()=>decryptSecrets(bytes.toString('base64')));}
 assert.throws(()=>decryptSecrets(Buffer.from(a,'base64').subarray(0,20).toString('base64')));
 const f=fixture(t);f.store.load();const data=JSON.parse(fs.readFileSync(f.file)),blob=Buffer.from(data.secrets,'base64');blob[32]^=1;data.secrets=blob.toString('base64');fs.writeFileSync(f.file,JSON.stringify(data));const before=fs.readFileSync(f.file);
 assert.throws(()=>new Store(f.dir).load(),/解密失败/);assert.deepEqual(fs.readFileSync(f.file),before);
});
