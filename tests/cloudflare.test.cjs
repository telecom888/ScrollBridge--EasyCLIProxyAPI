const {test}=require('node:test');const assert=require('node:assert/strict');
const {provision}=require('../lib/cloudflare.cjs');
const payload={apiToken:'private-api-token',accountId:'a'.repeat(32),zoneId:'b'.repeat(32),hostname:'api.example.com',port:18443};
function mock(conflict=false,failDNS=false){const calls=[];const fetcher=async(url,opt)=>{const body=opt.body?JSON.parse(opt.body):null;calls.push({url,method:opt.method,body});let result;let success=true;
  if(url.endsWith('/zones/'+payload.zoneId))result={name:'example.com'};
  else if(url.includes('dns_records?'))result=conflict?[{id:'old'}]:[];
  else if(opt.method==='POST'&&url.endsWith('/cfd_tunnel'))result={id:'new-tunnel'};
  else if(url.endsWith('/token'))result='eyJ-test-token';
  else if(opt.method==='POST'&&url.endsWith('/dns_records')){result={id:'new-dns'};success=!failDNS;}
  else result={};return{ok:success,status:success?200:403,json:async()=>({success,result,errors:success?[]:[{message:'DNS permission denied'}]})};};return{calls,fetcher};}
test('domain binding creates managed tunnel ingress and DNS without persisting API token',async()=>{const m=mock();const r=await provision(payload,m.fetcher);assert.equal(r.tunnelToken,'eyJ-test-token');const ingress=m.calls.find(c=>c.url.endsWith('/configurations')).body.config.ingress;assert.equal(ingress[0].service,'http://127.0.0.1:18443');assert.equal(ingress[1].service,'http_status:404');assert.ok(m.calls.some(c=>c.body?.content==='new-tunnel.cfargotunnel.com'));assert.ok(!JSON.stringify(r).includes(payload.apiToken));});
test('existing DNS is never overwritten',async()=>{const m=mock(true);await assert.rejects(provision(payload,m.fetcher),/已有 DNS/);assert.ok(!m.calls.some(c=>c.method!=='GET'));});
test('failed DNS creation rolls back new tunnel',async()=>{const m=mock(false,true);await assert.rejects(provision(payload,m.fetcher),/DNS permission/);assert.ok(m.calls.some(c=>c.method==='DELETE'&&c.url.endsWith('/new-tunnel')));});
test('zone mismatch creates no resources',async()=>{const m=mock();await assert.rejects(provision({...payload,hostname:'api.other.com'},m.fetcher),/不属于/);assert.ok(!m.calls.some(c=>c.method!=='GET'));});
