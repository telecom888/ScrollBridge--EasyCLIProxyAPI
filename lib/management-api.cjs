const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const PREFIX='/api/v1';
const DISCOVERY_FILE='management.json';
const configFields=['upstream','port','hostname','theme','protocol','launchAtLogin','refreshModelsOnStartup','modelRefreshMinutes','imagesEnabled','geminiImageCompatibility','diagnosticModel','diagnosticKeyId','billing','modelRates'];
const operations=[
  ['GET','/schema','读取接口说明'],['GET','/status','读取连接状态及诊断结果'],
  ['GET','/config','读取配置，不含完整密钥'],['PATCH','/config','保存配置',{config:'配置字段',upstreamKey:'可选，本地代理密钥',tunnelToken:'可选，隧道令牌',clearUpstreamKey:'可选，清除本地代理密钥'}],
  ['GET','/logs','读取日志；query: kind=requests|tunnel，limit=1..200；重复 keyId 参数选择单个或多个密钥，省略则全部'],['DELETE','/logs','清空本次运行日志'],
  ['POST','/connection/start','启动连接；返回 202 后轮询 status，直至 connected 或 error'],['POST','/connection/stop','停止连接'],
  ['POST','/diagnostics/local','检测本地进程与模型接口，成功获取模型时同步列表'],['POST','/diagnostics/public','检测公网 HTTPS、鉴权和模型流；会发送一次短模型请求'],
  ['GET','/models','读取实际模型、对外 ID 和全局权限'],['POST','/models/refresh','从本地代理刷新模型列表'],
  ['PUT','/models/access','修改实际模型全局权限',{model:'实际模型 ID',enabled:'boolean'}],
  ['PUT','/models/aliases','编辑模型别名',{id:'模型规则 ID',aliases:'[{id?: 已有别名 ID, name: 对外 ID}]',keepOriginal:'boolean'}],
  ['DELETE','/models/{id}','删除代理未提供的模型及其别名和授权'],
  ['GET','/keys','读取密钥元数据和掩码'],['POST','/keys','创建密钥；返回元数据，通过 reveal 显式获取完整值',{name:'名称',enabled:'可选 boolean',mode:'all 或 selected',allowed:'可选，对外 ID 的内部条目 ID 数组',concurrent:'可选，非负整数，0 不限',requestLimit:'可选，周期内请求数，0 不限',requestWindowSeconds:'可选，周期秒数，60..31536000，默认 3600'}],
  ['PUT','/keys/{id}','编辑密钥名称、权限和限额；省略字段保留已有值',{name:'名称',enabled:'可选 boolean',mode:'可选 all 或 selected',allowed:'可选，对外 ID 的内部条目 ID 数组',concurrent:'可选，非负整数，0 不限',requestLimit:'可选，周期内请求数，0 不限',requestWindowSeconds:'可选，周期秒数，60..31536000'}],
  ['DELETE','/keys/{id}','删除密钥，立即失效'],['POST','/keys/{id}/rotate','重置密钥，旧值立即失效'],
  ['POST','/keys/{id}/reveal','显式读取一个密钥的完整值；不得写入日志或提交 Git']
];
function apiError(status,code,message){return Object.assign(new Error(message),{status,code});}
function object(value,fields){
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!fields.includes(key)))throw apiError(400,'INVALID_ARGUMENT','请求字段无效，请参阅 /api/v1/schema');
  return value;
}
async function readBody(req){
  if(req.headers['content-encoding'])throw apiError(415,'UNSUPPORTED_MEDIA_TYPE','管理请求不支持压缩正文');
  if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw apiError(415,'UNSUPPORTED_MEDIA_TYPE','请使用 application/json');
  if(Number(req.headers['content-length'])>1024*1024)throw apiError(413,'BODY_TOO_LARGE','管理请求上限为 1 MiB');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw apiError(413,'BODY_TOO_LARGE','管理请求上限为 1 MiB');chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw apiError(400,'INVALID_JSON','JSON 格式无效');}
}
function resultState(state){return {status:state.status,message:state.message,gatewayRunning:state.gatewayRunning,version:state.version,localDiagnostic:state.localDiagnostic,publicDiagnostic:state.publicDiagnostic};}
async function route(req,url,{invoke,version}){
  const pathname=url.pathname,method=req.method;
  const body=async(fields)=>object(await readBody(req),fields);
  const call=async(action,payload)=>{try{return await invoke(action,payload);}catch(e){if(e.status)throw e;throw apiError(400,'OPERATION_FAILED',e.message);}};
  if(method==='GET' && pathname===PREFIX+'/schema')return {apiVersion:1,appVersion:version,basePath:PREFIX,authentication:'Authorization: Bearer <management.json 中的 token>',response:{success:'{ok:true,data:...}',failure:'{ok:false,error:{code,message}}'},configFields,operations:operations.map(([method,path,description,body])=>({method,path:PREFIX+path,description,...(body?{body}:{} )}))};
  if(method==='GET' && pathname===PREFIX+'/status')return resultState(await call('snapshot'));
  if(method==='GET' && pathname===PREFIX+'/config'){
    const s=await call('snapshot');return {config:s.config,hasUpstreamKey:s.hasUpstreamKey,hasTunnelToken:s.hasTunnelToken};
  }
  if(method==='PATCH' && pathname===PREFIX+'/config'){
    const payload=await body(['config','upstreamKey','tunnelToken','clearUpstreamKey']);
    if(payload.config!==undefined)object(payload.config,configFields);
    if(payload.clearUpstreamKey!==undefined && typeof payload.clearUpstreamKey!=='boolean')throw apiError(400,'INVALID_ARGUMENT','clearUpstreamKey 须为 boolean');
    return resultState(await call('save',payload));
  }
  if(method==='GET' && pathname===PREFIX+'/logs'){
    const kind=url.searchParams.get('kind') || 'requests',limit=Number(url.searchParams.get('limit') || 100);
    if(!['requests','tunnel'].includes(kind)||!Number.isInteger(limit)||limit<1||limit>200)throw apiError(400,'INVALID_ARGUMENT','kind 须为 requests 或 tunnel，limit 须为 1–200');
    const keyIds=url.searchParams.getAll('keyId');
    if(keyIds.some(id=>!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) || (kind==='tunnel' && keyIds.length))throw apiError(400,'INVALID_ARGUMENT','keyId 须为密钥内部 ID，仅用于请求日志');
    const selected=new Set(keyIds),s=await call('snapshot');
    return {kind,items:(kind==='tunnel'?s.logs:s.records).filter(row=>!selected.size || selected.has(row.keyId)).slice(0,limit)};
  }
  if(method==='DELETE' && pathname===PREFIX+'/logs')return {cleared:await call('clearLogs')};
  const controls={'/connection/start':'start','/connection/stop':'stop','/diagnostics/local':'testLocal','/diagnostics/public':'testPublic','/models/refresh':'refreshModels'};
  if(method==='POST' && Object.hasOwn(controls,pathname.slice(PREFIX.length))){
    const action=controls[pathname.slice(PREFIX.length)],value=await call(action);
    return ['testLocal','testPublic'].includes(action)?value:resultState(value);
  }
  if(method==='GET' && pathname===PREFIX+'/models'){
    const s=await call('snapshot');return {knownModels:s.config.knownModels,disabledModels:s.config.disabledModels,rules:s.config.modelRules,entries:s.modelEntries,updatedAt:s.config.modelsUpdatedAt};
  }
  if(method==='PUT' && pathname===PREFIX+'/models/access')return resultState(await call('setModelAccess',await body(['model','enabled'])));
  if(method==='PUT' && pathname===PREFIX+'/models/aliases'){
    const payload=await body(['id','aliases','keepOriginal']);
    if(!Array.isArray(payload.aliases))throw apiError(400,'INVALID_ARGUMENT','aliases 须为数组');
    for(const alias of payload.aliases)object(alias,['id','name']);
    return resultState(await call('saveAliases',payload));
  }
  const modelMatch=/^\/api\/v1\/models\/([^/]+)$/.exec(pathname);
  if(method==='DELETE' && modelMatch)return resultState(await call('deleteModel',{id:decodeURIComponent(modelMatch[1])}));
  if(method==='GET' && pathname===PREFIX+'/keys')return {keys:(await call('snapshot')).keys};
  if(method==='POST' && pathname===PREFIX+'/keys'){
    const payload=await body(['name','enabled','mode','allowed','concurrent','requestLimit','requestWindowSeconds']),s=await call('saveKey',payload);
    return {key:s.keys.at(-1)};
  }
  const keyMatch=/^\/api\/v1\/keys\/([^/]+)(?:\/(rotate|reveal))?$/.exec(pathname);
  if(keyMatch){
    const id=decodeURIComponent(keyMatch[1]),operation=keyMatch[2];
    if(method==='PUT'&&!operation){const s=await call('saveKey',{...await body(['name','enabled','mode','allowed','concurrent','requestLimit','requestWindowSeconds']),id});return {key:s.keys.find(key=>key.id===id)};}
    if(method==='DELETE'&&!operation){await call('deleteKey',{id});return {deleted:true};}
    if(method==='POST'&&operation==='rotate'){const s=await call('rotateKey',{id});return {key:s.keys.find(key=>key.id===id)};}
    if(method==='POST'&&operation==='reveal')return call('revealKey',{id});
  }
  throw apiError(404,'NOT_FOUND','管理接口不存在，请参阅 /api/v1/schema');
}
async function startManagementAPI({directory,invoke,version}){
  const token=crypto.randomBytes(32).toString('base64url'),digest=crypto.createHash('sha256').update(token).digest();
  const filename=path.join(directory,DISCOVERY_FILE);let baseUrl,closed=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    const reply=(status,value)=>{res.writeHead(status);res.end(JSON.stringify(value));};
    try{
      if(req.headers.origin || req.headers.host!==`127.0.0.1:${server.address().port}`)throw apiError(403,'FORBIDDEN_ORIGIN','仅允许本机程序直接调用');
      const header=req.headers.authorization || '',candidate=header.startsWith('Bearer ')?header.slice(7):'';
      if(!crypto.timingSafeEqual(digest,crypto.createHash('sha256').update(candidate).digest()))throw apiError(401,'UNAUTHORIZED','本机管理令牌无效');
      const url=new URL(req.url,baseUrl);
      if(!url.pathname.startsWith(PREFIX+'/'))throw apiError(404,'NOT_FOUND','管理接口不存在');
      const data=await route(req,url,{invoke,version});
      reply(req.method==='POST'&&url.pathname===PREFIX+'/connection/start'?202:200,{ok:true,data});
    }catch(e){reply(e.status || 500,{ok:false,error:{code:e.code || 'INTERNAL_ERROR',message:e.status?e.message:'管理请求处理失败'}});}
    finally{if(!req.complete)req.resume();}
  });
  server.requestTimeout=75000;server.headersTimeout=10000;server.maxHeadersCount=40;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  baseUrl=`http://127.0.0.1:${server.address().port}`;
  const discovery={apiVersion:1,baseUrl,token,pid:process.pid,appVersion:version};
  try{
    fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(filename,JSON.stringify(discovery,null,2),{mode:0o600});
  }catch(e){server.close();throw e;}
  return {baseUrl,filename,close(){if(closed)return;closed=true;server.close();server.closeAllConnections();
    try{if(JSON.parse(fs.readFileSync(filename,'utf8')).token===token)fs.unlinkSync(filename);}catch{/* A stale file cannot authenticate after the server closes. */}
  }};
}
module.exports={startManagementAPI,DISCOVERY_FILE};
