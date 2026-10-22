const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {electronFetch}=require('../lib/electron-fetch.cjs');
function fixture(run){let request;return{net:{request(options){request=new EventEmitter();request.options=options;request.headers={};request.setHeader=(k,v)=>request.headers[k]=v;request.abort=()=>{request.aborted=true;request.emit('error',Error('Redirect was cancelled'));request.emit('close');};request.end=()=>queueMicrotask(()=>run(request));return request;}},get request(){return request;}};}
test('Electron manual redirects expose status and location without rejecting on abort',async()=>{
 const f=fixture(r=>r.emit('redirect',302,'GET','https://release-assets.githubusercontent.com/package',{'location':['https://release-assets.githubusercontent.com/package']}));
 const response=await electronFetch(f.net,'https://github.com/package',{headers:{Accept:'application/octet-stream'}});
 assert.equal(response.status,302);assert.match(response.headers.get('location'),/release-assets/);assert.equal(f.request.aborted,true);assert.equal(f.request.options.redirect,'manual');assert.equal(f.request.options.useSessionCookies,false);
});
test('Electron response streams incrementally and cancellation stops the request',async()=>{
 const incoming=new PassThrough();incoming.statusCode=200;incoming.headers={'content-type':['application/octet-stream']};
 const f=fixture(r=>r.emit('response',incoming));const controller=new AbortController();
 const response=await electronFetch(f.net,'https://github.com/package',{signal:controller.signal});const reader=response.body.getReader();
 incoming.write('first');assert.equal(Buffer.from((await reader.read()).value).toString(),'first');
 controller.abort(Error('download timeout'));await assert.rejects(reader.read(),/download timeout/);assert.equal(f.request.aborted,true);
});
test('Electron network errors and pre-aborted requests reject without creating downloads',async()=>{
 const f=fixture(r=>r.emit('error',Error('offline')));await assert.rejects(electronFetch(f.net,'https://github.com/package'),/offline/);
 const c=new AbortController();c.abort(Error('cancelled'));let called=false;
 await assert.rejects(electronFetch({request(){called=true;}},'https://github.com/package',{signal:c.signal}),/cancelled/);assert.equal(called,false);
});
