// GitCode is an artifact host only. Never push branches, source trees or GitHub tags.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {GITCODE_API,githubFetch}=require('../lib/updates.cjs');
const {verifyManifest}=require('../lib/update-signature.cjs');
async function publishGitcode({directory,token,notes='',fetcher=fetch,download=githubFetch,log=console.log,publicKey}){
 if(!token)throw Error('请配置 GitHub Actions secret GITCODE_TOKEN');
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,'scrollbridge-update.json'),'utf8'));
 verifyManifest(manifest,publicKey);
 const version=manifest.version;if(!/^\d+\.\d+\.\d+$/.test(version))throw Error('Invalid release version');
 const tag='v'+version,files=['zip','installer','portable'].map(type=>manifest.assets?.[type]);
 const names=[`ScrollBridge-${version}-win-x64.zip`,`ScrollBridge-Setup-${version}-win-x64.exe`,`ScrollBridge-${version}-win-x64.exe`];
 for(let i=0;i<files.length;i++){
  const a=files[i];if(!a || a.name!==names[i])throw Error('Missing release package');
  let size=0;const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(path.join(directory,a.name))){size+=chunk.length;hash.update(chunk);}
  if(size!==a.size || hash.digest('hex')!==a.sha256)throw Error('Release package verification failed');
 }
 const payload={name:`卷桥 ${version}`,body:notes || manifest.notes || '',release_status:'pre'};
 async function api(route,{method='GET',body,missing=false,query={}}={}){
  const url=new URL(GITCODE_API+route);url.searchParams.set('access_token',token);for(const [k,v]of Object.entries(query))url.searchParams.set(k,v);
  let r;try{r=await fetcher(url.href,{method,redirect:'error',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});}catch{throw Error('GitCode API 网络请求失败');}
  if(missing && [400,404].includes(r.status)){const e=await r.json().catch(()=>({}));if(r.status===404 || e.error_message==='未找到 release')return null;}
  if(!r.ok)throw Error(`GitCode API 请求失败（HTTP ${r.status}）`);
  if(r.status===204)return null;return r.json();
 }
 let release=await api('/tags/'+tag,{missing:true});
 if(release && !release.prerelease && release.release_status!=='pre')throw Error('GitCode 已有正式版本，请勿覆盖；如需重试，请先将该发行版设为预发布');
 if(!release)release=await api('',{method:'POST',body:{...payload,tag_name:tag}});
 else await api('/'+tag,{method:'PATCH',body:payload});
 const uploadNames=[...names,`SHA256SUMS-${version}.txt`,'scrollbridge-update.json'];
 for(const name of uploadNames){
  const filename=path.join(directory,name),size=fs.statSync(filename).size;
  const old=release.assets?.find(a=>a.name===name);if(old){if(!Number.isSafeInteger(old.id))throw Error('GitCode 附件缺少 ID');await api(`/${tag}/attach_files/${old.id}`,{method:'DELETE'});}
  const signed=await api(`/${tag}/upload_url`,{query:{file_name:name}});
  const url=new URL(signed.url);if(url.protocol!=='https:' || url.username || url.password || url.port || !(url.hostname==='file.gitcode.com' || /^[a-z0-9-]+\.obs\.[a-z0-9-]+\.myhuaweicloud\.com$/.test(url.hostname)))throw Error('GitCode 上传主机尚未验证：'+url.hostname);
  let result;try{result=await fetcher(url.href,{method:'PUT',redirect:'error',headers:{...signed.headers,'Content-Length':String(size)},body:Readable.toWeb(fs.createReadStream(filename)),duplex:'half',signal:AbortSignal.timeout(30*60*1000)});}catch{throw Error('GitCode 附件上传失败');}
  if(!result.ok)throw Error(`GitCode 附件上传失败（HTTP ${result.status}）`);await result.body?.cancel();
  // Anonymous round trip: verify the actual public bytes before making the release latest.
  const response=await download(`${GITCODE_API}/${tag}/attach_files/${name}/download`,{signal:AbortSignal.timeout(30*60*1000)});
  if(!response.ok || !response.body)throw Error(`GitCode 附件公开访问失败（HTTP ${response.status}）`);
  const hash=crypto.createHash('sha256'),local=crypto.createHash('sha256');let count=0;
  for await(const chunk of response.body){count+=chunk.length;if(count>size)throw Error('GitCode 附件大小错误');hash.update(chunk);}
  for await(const chunk of fs.createReadStream(filename))local.update(chunk);
  if(count!==size || hash.digest('hex')!==local.digest('hex'))throw Error('GitCode 附件校验失败');
  log(`GitCode 附件已验证：${name}`);
 }
 await api('/'+tag,{method:'PATCH',body:{...payload,release_status:'latest'}});
 log(`GitCode ${tag} 已发布，仅包含发行附件`);
}
if(require.main===module){const root=path.resolve(__dirname,'..');publishGitcode({directory:path.resolve(process.argv[2] || path.join(root,'release')),token:process.env.GITCODE_TOKEN}).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={publishGitcode};
