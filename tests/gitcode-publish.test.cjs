const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {publishGitcode}=require('../scripts/publish-gitcode.cjs');
const {signManifest}=require('../lib/update-signature.cjs');
test('GitCode publication verifies all public artifacts before promoting the release, without pushing source',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sb-gitcode-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const keys=crypto.generateKeyPairSync('ed25519'),version='0.3.20',assets={},remote=new Map(),calls=[];
 for(const [kind,name]of Object.entries({zip:`ScrollBridge-${version}-win-x64.zip`,installer:`ScrollBridge-Setup-${version}-win-x64.exe`,portable:`ScrollBridge-${version}-win-x64.exe`})){
  const data=Buffer.from(kind);fs.writeFileSync(path.join(directory,name),data);assets[kind]={name,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};
 }
 fs.writeFileSync(path.join(directory,`SHA256SUMS-${version}.txt`),'fixture');fs.writeFileSync(path.join(directory,'scrollbridge-update.json'),JSON.stringify(signManifest({schemaVersion:1,version,assets},keys.privateKey)));
 const fetcher=async(address,options)=>{
  const url=new URL(address);calls.push({path:url.pathname,method:options.method,body:options.method==='PATCH'?JSON.parse(options.body):null});
  if(url.hostname==='file.gitcode.com'){assert.equal(options.redirect,'error');remote.set(url.pathname.slice(1),Buffer.from(await new Response(options.body).arrayBuffer()));return new Response('');}
  assert.equal(url.hostname,'api.gitcode.com');assert.equal(url.searchParams.get('access_token'),'test-only-token');
  if(url.pathname.includes('/tags/'))return Response.json({error_message:'未找到 release'},{status:400});
  if(url.pathname.endsWith('/upload_url'))return Response.json({url:'https://file.gitcode.com/'+url.searchParams.get('file_name'),headers:{'Content-Type':'application/octet-stream'}});
  return Response.json({assets:[]});
 };
 let downloads=0;
 await publishGitcode({directory,token:'test-only-token',publicKey:keys.publicKey,fetcher,log:()=>{},download:async address=>{downloads++;assert.equal(new URL(address).search,'');const name=address.split('/').at(-2);return new Response(remote.get(name));}});
 assert.equal(downloads,5);assert.equal(remote.size,5);assert.equal(calls.at(-1).body.release_status,'latest');assert.equal(calls.filter(c=>c.method==='POST').length,1);
 let promoted=false;
 await assert.rejects(publishGitcode({directory,token:'test-only-token',publicKey:keys.publicKey,log:()=>{},fetcher:async(u,o)=>{if(o.method==='PATCH')promoted=true;return fetcher(u,o);},download:async()=>new Response('corrupt')}),/大小|校验/);
 assert.equal(promoted,false);
});
