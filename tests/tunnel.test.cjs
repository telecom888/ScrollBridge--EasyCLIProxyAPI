const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
test('tunnel passes secret only in child environment, redacts logs and stops child',async t=>{
  const cp=require('node:child_process');const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;child.kill=()=>{child.signalCode='SIGTERM';queueMicrotask(()=>child.emit('exit',null));};
  let spawned;t.mock.method(cp,'spawn',(exe,args,opt)=>{spawned={exe,args,opt};return child;});
  const {startTunnel}=require('../lib/tunnel.cjs');const token='eyJ'+'a'.repeat(120);const states=[];const logs=[];
  const tunnel=startTunnel({executable:process.execPath,token,protocol:'http2',onState:s=>states.push(s),onLog:s=>logs.push(s)});
  assert.ok(!spawned.args.includes(token));assert.equal(spawned.opt.env.TUNNEL_TOKEN,token);assert.equal(spawned.opt.windowsHide,true);
  child.stderr.write(`Registered tunnel connection connIndex=0 token=${token}\n`);assert.ok(states.includes('connected'));assert.ok(!JSON.stringify(logs).includes(token));
  child.stderr.write('Unregistered tunnel connection connIndex=0\n');assert.ok(states.includes('reconnecting'));
  await tunnel.stop();assert.equal(child.signalCode,'SIGTERM');
});
