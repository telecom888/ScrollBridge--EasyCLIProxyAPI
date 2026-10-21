const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const http=require('node:http');
const {startManagementAPI}=require('../lib/management-api.cjs');
async function fixture(t,invoke=async()=>({status:'stopped',config:{hostname:''},keys:[],logs:[],records:[]})){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sb-management-'));
  const api=await startManagementAPI({directory,invoke,version:'test'});
  const discovery=JSON.parse(fs.readFileSync(api.filename,'utf8'));
  t.after(()=>{api.close();assert.equal(fs.existsSync(api.filename),false);fs.rmSync(directory,{recursive:true});});
  return {...api,discovery,request:(route,options={})=>fetch(api.baseUrl+'/api/v1'+route,{...options,headers:{authorization:`Bearer ${discovery.token}`,...options.headers}})};
}
test('management API is separate, loopback only and requires its own token; browser origins and rebound hosts are rejected',async t=>{
  const f=await fixture(t);assert.match(f.baseUrl,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(f.baseUrl+'/api/v1/status')).status,401);
  assert.equal((await f.request('/status',{headers:{authorization:'Bearer sb_consumer_credential'}})).status,401);
  assert.equal((await f.request('/status',{headers:{origin:'https://attacker.invalid'}})).status,403);
  const rebound=await new Promise((resolve,reject)=>{const req=http.get(f.baseUrl+'/api/v1/status',{headers:{host:'attacker.invalid',authorization:`Bearer ${f.discovery.token}`}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(rebound,403);
  const r=await f.request('/schema');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'),null);
  const data=await r.json();assert.ok(data.data.operations.some(row=>row.path.endsWith('/keys/{id}/reveal')));
  assert.ok(!JSON.stringify(data).includes(f.discovery.token));
});
test('invalid bodies and private UI actions cannot reach desktop operations',async t=>{
  const seen=[];const f=await fixture(t,async(...args)=>{seen.push(args);return {status:'stopped'};});
  for(const [route,method,payload,status]of [
    ['/config','PATCH',{config:{accessKeys:[]}},400],['/config','PATCH',null,400],
    ['/config','PATCH',{config:{knownModels:[]}},400],['/config','PATCH',{clearUpstreamKey:'yes'},400],
    ['/models/aliases','PUT',{id:'test',aliases:[null]},400],['/keys','POST',{id:'overwrite',name:'key'},400]
  ])assert.equal((await f.request(route,{method,headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).status,status);
  assert.equal((await f.request('/config',{method:'PATCH',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await f.request('/config',{method:'PATCH',headers:{'content-type':'application/json'},body:'{broken'})).status,400);
  assert.equal((await f.request('/config',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({config:{theme:'a'.repeat(1024*1024)}})})).status,413);
  for(const route of ['/bind','/openData','/copyKey','/snapshot','/../status'])assert.equal((await f.request(route,{method:'POST'})).status,404);
  assert.equal((await f.request('/logs?limit=999')).status,400);assert.deepEqual(seen,[]);
});
test('transport preserves busy/error codes and never returns full state or secrets from normal queries',async t=>{
  const f=await fixture(t,async(action)=>{
    if(action==='stop')throw Object.assign(Error('wait'),{status:409,code:'BUSY'});
    if(action==='save')throw Error('请先停止连接再保存连接配置');
    return {status:'connected',gatewayRunning:true,secrets:{key:'must-not-return'},config:{hostname:'api.example.com'},keys:[{id:'one',masked:'sb_…abcd'}],logs:[],records:[]};
  });
  const status=await(await f.request('/status')).json();assert.equal(status.data.status,'connected');assert.ok(!JSON.stringify(status).includes('must-not-return'));
  const stopped=await f.request('/connection/stop',{method:'POST'});assert.equal(stopped.status,409);assert.equal((await stopped.json()).error.code,'BUSY');
  const failed=await f.request('/config',{method:'PATCH',headers:{'content-type':'application/json'},body:'{}'});assert.equal(failed.status,400);
  assert.equal((await f.request('/connection/start',{method:'POST'})).status,202);
});
test('discovery credentials change on restart and close does not remove another instance descriptor',async t=>{
  const f=await fixture(t);const oldToken=f.discovery.token;
  fs.writeFileSync(f.filename,JSON.stringify({token:'new-owner'}));f.close();assert.equal(fs.existsSync(f.filename),true);
  const replacement=await startManagementAPI({directory:path.dirname(f.filename),invoke:async()=>({}),version:'test'});
  assert.notEqual(JSON.parse(fs.readFileSync(f.filename)).token,oldToken);replacement.close();
});
