const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Readable,Transform}=require('node:stream');const {pipeline}=require('node:stream/promises');
const {verifyManifest}=require('./update-signature.cjs');
const REPOSITORY='telecom888/ScrollBridge--EasyCLIProxyAPI';
const API=`https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const LATEST=`https://github.com/${REPOSITORY}/releases/latest/download/scrollbridge-update.json`;
const TYPES=['zip','installer','portable'];
const SOURCES=['github','mirror'];
function sourceUrl(value,source){
 if(!SOURCES.includes(source))throw Error('更新来源无效');
 const url=new URL(value);
 const allowed=url.href===API || url.href===LATEST || (url.hostname==='github.com' && url.pathname.startsWith('/'+REPOSITORY+'/releases/download/'));
 if(!allowed || url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.port)throw Error('更新地址无效');
 return source==='mirror'?'https://gh-proxy.com/'+url.href:url.href;
}
function versionParts(value){const m=/^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);if(!m)throw Error('发布版本号无效');return m.slice(1).map(Number);}
function isNewer(next,current){const a=versionParts(next),b=versionParts(current);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
function distribution({portableFile,executable}){return portableFile?'portable':fs.existsSync(path.join(path.dirname(executable),'Uninstall 卷桥.exe'))?'installer':'zip';}
function releaseUrl(value){
 const url=new URL(value);
 if(url.protocol!=='https:' || url.hostname!=='github.com' || !url.pathname.startsWith('/'+REPOSITORY+'/releases/download/') || url.username || url.password || url.search)throw Error('更新文件地址无效');
 return url.href;
}
function selectAsset(release,manifest,kind){
 const version=release.tag_name.replace(/^v/,'');versionParts(version);
 if(manifest.schemaVersion!==1 || manifest.version!==version || !TYPES.includes(kind))throw Error('更新清单版本不匹配');
 const names={zip:`ScrollBridge-${version}-win-x64.zip`,installer:`ScrollBridge-Setup-${version}-win-x64.exe`,portable:`ScrollBridge-${version}-win-x64.exe`};
 const data=manifest.assets?.[kind],asset=release.assets?.find(a=>a.name===names[kind]);
 if(!data || data.name!==names[kind] || !/^[a-f0-9]{64}$/i.test(data.sha256) || !Number.isSafeInteger(data.size) || data.size<=0 || data.size>2*1024**3 || !asset || asset.size!==data.size)throw Error('发布包或校验信息不完整');
 const url=releaseUrl(asset.browser_download_url);
 if(decodeURIComponent(new URL(url).pathname.split('/').at(-1))!==data.name)throw Error('更新文件名不匹配');
 return {...data,url,version};
}
async function githubFetch(url,options={},fetcher=(...args)=>fetch(...args)){
 const hosts=new Set(['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com']);
 const mirror=new URL(url).hostname==='gh-proxy.com';
 if(mirror){const outer=new URL(url);if(sourceUrl(outer.pathname.slice(1),'mirror')!==url)throw Error('镜像更新地址无效');}
 for(let i=0;i<6;i++){
  const parsed=new URL(url);if(parsed.protocol!=='https:' || !(mirror?parsed.hostname==='gh-proxy.com':hosts.has(parsed.hostname)) || parsed.port || parsed.username || parsed.password)throw Error('更新下载地址不受信任');
  if(mirror && sourceUrl(parsed.pathname.slice(1),'mirror')!==url)throw Error('镜像更新地址无效');
  // Only public update requests. Never forward caller cookies or credentials.
  const response=await fetcher(url,{signal:options.signal,redirect:'manual',headers:{'User-Agent':'ScrollBridge-Updater','Accept':options.headers?.Accept || 'application/vnd.github+json'}});
  if([301,302,303,307,308].includes(response.status)){await response.body?.cancel();url=new URL(response.headers.get('location'),url).href;continue;}
  return response;
 }
 throw Error('更新地址重定向过多');
}
async function readJson(response){
 if(!response.ok)throw Error(response.status===403 || response.status===429?'GitHub 请求受限，请稍后重试':'无法获取更新信息（HTTP '+response.status+'）');
 let total=0;const chunks=[];for await(const chunk of response.body){total+=chunk.length;if(total>1024*1024)throw Error('更新信息过大');chunks.push(chunk);}
 try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data || typeof data!=='object' || Array.isArray(data))throw Error();return data;}catch{throw Error('该来源返回了无效更新信息，请切换来源后重试');}
}
function createUpdater({getVersion,getSource=()=> 'mirror',kind,directory,enabled=true,onChange=()=>{},install,fetcher=githubFetch,publicKey}){
 let state={phase:'idle',message:'尚未检测更新',progress:0,downloadedBytes:0,totalBytes:0,bytesPerSecond:0,releaseNotes:'',publishedAt:''},candidate=null,payload=null,installing=false;
 const active=()=>['checking','downloading','installing','ready'].includes(state.phase);
 const snapshot=()=>({...state,source:getSource(),currentVersion:getVersion(),supported:enabled});
 const change=next=>{state={...state,...next};onChange(snapshot());};
 const fail=error=>change({phase:'error',message:error.message || '更新失败，请重试'});
 function resetSource(){if(active())throw Error('请等待当前更新操作完成');candidate=null;payload=null;change({phase:'idle',message:'来源已切换，请检测更新',progress:0,detectedVersion:null,availableVersion:null,canDownload:false,releaseNotes:'',publishedAt:'',releaseUrl:''});}
 const notes=(release,manifest)=>({releaseNotes:typeof (manifest?.notes ?? release.body)==='string'?(manifest?.notes ?? release.body).slice(0,65536):'',publishedAt:typeof (manifest?.publishedAt ?? release.published_at)==='string'?(manifest?.publishedAt ?? release.published_at):'',releaseUrl:`https://github.com/${REPOSITORY}/releases/tag/v${release.tag_name.replace(/^v/,'')}`});
 async function check(){
  if(!enabled)throw Error('请使用已打包的主线版本检测更新');
  if(active())return snapshot();
  const source=getSource(),request=(url,options)=>fetcher(sourceUrl(url,source),options);
  candidate=null;payload=null;change({phase:'checking',message:'正在检测更新',progress:0,availableVersion:null,detectedVersion:null,canDownload:false,releaseNotes:'',publishedAt:'',releaseUrl:''});
  try{
   const response=await request(API,{signal:AbortSignal.timeout(20000)});
   if(response.status===404){change({phase:'latest',message:'仓库尚未发布更新'});return snapshot();}
   let release,manifest;
   if([403,429].includes(response.status)){
    await response.body?.cancel();
    // Public release downloads have a separate path from the anonymous API
    // quota. Our workflow enforces v<version> tags for all release assets.
    const direct=await request(LATEST,{signal:AbortSignal.timeout(20000)});
    if(direct.status===404){change({phase:'latest',message:'仓库尚未发布更新'});return snapshot();}
    manifest=await readJson(direct);verifyManifest(manifest,publicKey);versionParts(manifest.version);
    release={tag_name:'v'+manifest.version,assets:TYPES.map(type=>manifest.assets?.[type]).filter(Boolean).map(a=>({name:a.name,size:a.size,browser_download_url:`https://github.com/${REPOSITORY}/releases/download/v${manifest.version}/${encodeURIComponent(a.name)}`}))};
   }else release=await readJson(response);
   if(release.draft || release.prerelease){change({phase:'latest',message:'当前已是最新版本'});return snapshot();}
   const newer=isNewer(release.tag_name,getVersion());
   change({detectedVersion:release.tag_name.replace(/^v/,''),...notes(release,manifest)});
   if(!newer){change({phase:'latest',message:'当前已是最新版本'});return snapshot();}
   if(!manifest){
    const item=release.assets?.find(a=>a.name==='scrollbridge-update.json');if(!item)throw Error('该版本缺少更新清单');
    manifest=await readJson(await request(releaseUrl(item.browser_download_url),{signal:AbortSignal.timeout(20000)}));
   }
   verifyManifest(manifest,publicKey);
   candidate=selectAsset(release,manifest,kind);
   candidate.source=source;
   change({phase:'available',message:'发现新版本',availableVersion:candidate.version,canDownload:true,...notes(release,manifest)});
  }catch(error){fail(error);}
  return snapshot();
 }
 async function apply(){
  if(!payload || installing)return snapshot();installing=true;change({phase:'installing',message:'正在安装更新并重启',canDownload:false});
  try{const started=await install(payload);if(started===false)change({phase:'ready',message:'下载已完成，请先保存修改，再点击立即更新',canDownload:true});}
  catch(error){change({phase:'ready',message:error.message || '安装失败，请重试',canDownload:true});}
  finally{installing=false;}
  return snapshot();
 }
 async function download(){
  if(!candidate || ['checking','downloading','installing'].includes(state.phase))return snapshot();
  const selected={...candidate},id=crypto.randomUUID(),jobDirectory=path.join(directory,id),filename=path.join(jobDirectory,selected.name),partial=filename+'.part';
  change({phase:'downloading',message:'正在下载更新',progress:0,downloadedBytes:0,totalBytes:selected.size,bytesPerSecond:0,canDownload:false});
  try{
   fs.mkdirSync(jobDirectory,{recursive:true});
   const response=await fetcher(sourceUrl(selected.url,selected.source),{signal:AbortSignal.timeout(30*60*1000),headers:{Accept:'application/octet-stream'}});
   if(!response.ok || !response.body)throw Error('下载失败（HTTP '+response.status+'）');
   const hash=crypto.createHash('sha256');let bytes=0,lastAt=performance.now(),lastBytes=0;
   const meter=new Transform({transform(chunk,_,callback){bytes+=chunk.length;if(bytes>selected.size){callback(Error('更新文件大小不匹配'));return;}hash.update(chunk);const now=performance.now();if(now-lastAt>=250 || bytes===selected.size){change({progress:Math.floor(bytes/selected.size*100),downloadedBytes:bytes,bytesPerSecond:Math.round((bytes-lastBytes)*1000/Math.max(1,now-lastAt))});lastAt=now;lastBytes=bytes;}callback(null,chunk);}});
   await pipeline(Readable.fromWeb(response.body),meter,fs.createWriteStream(partial,{flags:'wx',mode:0o600}));
   if(bytes!==selected.size || hash.digest('hex').toLowerCase()!==selected.sha256.toLowerCase())throw Error('更新文件校验失败，请重新下载');
   fs.renameSync(partial,filename);payload={...selected,id,directory:jobDirectory,filename,kind};
   change({phase:'ready',message:'下载完成',progress:100,canDownload:true});await apply();
  }catch(error){try{fs.unlinkSync(partial);}catch{}fail(error);change({canDownload:!!candidate});}
  return snapshot();
 }
 return{snapshot,check,download,apply,resetSource,isActive:active};
}
module.exports={createUpdater,distribution,isNewer,selectAsset,releaseUrl,sourceUrl,githubFetch,REPOSITORY};
