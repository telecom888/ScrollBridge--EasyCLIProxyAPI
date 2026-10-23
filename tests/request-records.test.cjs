const {test}=require('node:test'),assert=require('node:assert/strict');
const {RequestRecords,normalizeIP,requestIP,exportRecords}=require('../lib/request-records.cjs');
const {validateConfig}=require('../lib/config.cjs');
const {toGoConfig}=require('../lib/go-gateway.cjs');
test('IP display preference stays in the desktop and hiding a snapshot preserves stored IPs',()=>{
 const config=validateConfig({}),secrets={keyValues:{},upstreamKey:''};
 assert.deepEqual(toGoConfig({...config,recordRequestIP:false},secrets),toGoConfig({...config,recordRequestIP:true},secrets));
 const records=new RequestRecords();records.add({status:401,requestIP:'2001:db8::99'});
 assert.equal(Object.hasOwn(records.all(false)[0],'requestIP'),false);
 assert.equal(records.all(true)[0].requestIP,'2001:db8::99');
});
test('IP settings are strict, normalize aliases and migrate only the removed update source',()=>{
 const defaults=validateConfig({});assert.equal(defaults.recordRequestIP,false);assert.equal(defaults.requestRecordLimit,200);assert.equal(defaults.updateSource,'mirror');
 assert.equal(validateConfig({updateSource:'gitcode'}).updateSource,'mirror');assert.equal(validateConfig({updateSource:'github'}).updateSource,'github');
 assert.deepEqual(validateConfig({ipBlacklist:['::ffff:192.0.2.1','192.0.2.1','2001:0DB8:0:0::1']}).ipBlacklist,['192.0.2.1','2001:db8::1']);
 for(const config of [{recordRequestIP:1},{requestRecordLimit:99},{requestRecordLimit:10001},{requestRecordLimit:200.5},{ipBlacklist:['192.0.2.0/24']},{ipBlacklist:['fe80::1%eth0']}])assert.throws(()=>validateConfig(config));
});
test('visitor IP uses only loopback Cloudflare reports and ignores arbitrary forwarded chains',()=>{
 const req=(peer,headers={})=>({socket:{remoteAddress:peer},headers});
 assert.equal(requestIP(req('::ffff:127.0.0.1',{'cf-connecting-ip':'2001:0db8::1','x-forwarded-for':'198.51.100.1'})),'2001:db8::1');
 assert.equal(requestIP(req('127.0.0.1',{'x-forwarded-for':'198.51.100.1'})),'127.0.0.1');
 assert.equal(requestIP(req('192.0.2.1',{'cf-connecting-ip':'198.51.100.1'})),'192.0.2.1');
 assert.equal(requestIP(req('127.0.0.1',{'cf-connecting-ip':'240.1.2.3','cf-connecting-ipv6':'2001:db8::2'})),'2001:db8::2');
 assert.equal(requestIP(req('127.0.0.1',{'cf-connecting-ip':'192.0.2.1, 198.51.100.1'})),'127.0.0.1');
 assert.equal(normalizeIP('::ffff:c000:201'),'192.0.2.1');
});
test('bounded ring updates existing records, evicts oldest, resizes and clears without resetting order',()=>{
 const buffer=new RequestRecords(200);for(let i=0;i<12000;i++)buffer.add({id:String(i),requestIP:'192.0.2.1',status:401});
 assert.equal(buffer.size,200);assert.equal(buffer.all()[0].id,'11999');assert.equal(buffer.all().at(-1).id,'11800');
 const seq=buffer.all()[0].sequence;buffer.add({id:'11999',status:403});assert.equal(buffer.size,200);assert.equal(buffer.all()[0].sequence,seq);
 buffer.resize(100);assert.equal(buffer.size,100);assert.equal(buffer.all().at(-1).id,'11900');assert.equal('requestIP' in buffer.all(false)[1],false);
 buffer.resize(10000);for(let i=0;i<11000;i++)buffer.add({status:200});assert.equal(buffer.size,10000);buffer.clear();assert.equal(buffer.size,0);assert.ok(buffer.add({status:200}).sequence>seq);
});
test('export uses an explicit field list, honors IP opt-out and makes CSV safe for Excel',()=>{
 const rows=[{time:'2026-10-23T01:02:03Z',requestIP:'2001:db8::1',keyName:'=HYPERLINK("bad")',model:'x,"\nnext',status:401,secret:'PRIVATE',body:'PRIVATE',path:'/v1/models'}];
 const csv=exportRecords(rows,{format:'csv',includeIP:true});assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('x,""\nnext'));assert.ok(csv.includes('2001:db8::1'));assert.ok(!csv.includes('PRIVATE'));
 const json=JSON.parse(exportRecords(rows,{format:'json',includeIP:false}));assert.equal(json[0].time,rows[0].time);assert.equal('requestIP' in json[0],false);assert.equal('secret' in json[0],false);
});
test('request bodies stay out of snapshots and exports; memory budget, resize and clear release previews',()=>{
 const records=new RequestRecords(200,12);
 records.add({id:'a',requestBody:{state:'text',preview:'first-body'}});
 assert.equal(records.all()[0].requestBody,undefined);
 assert.equal(records.all(true,true)[0].requestBody.preview,undefined);
 assert.equal(records.body('a').preview,'first-body');
 records.add({id:'b',requestBody:{state:'text',preview:'next-body'}});
 assert.equal(records.body('a').state,'evicted');assert.equal(records.body('b').preview,'next-body');assert.ok(records.bodyBytes<=12);
 records.resize(100);assert.equal(records.body('b').preview,'next-body');
 assert.ok(!exportRecords(records.all(true,true),{format:'json',includeIP:true}).includes('next-body'));
 records.clear();assert.equal(records.bodyBytes,0);assert.throws(()=>records.body('b'));
 assert.throws(()=>validateConfig({showRequestBody:1}));
});
