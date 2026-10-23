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

const {startTunnel,networkFingerprint}=require('../lib/tunnel.cjs');
function recoveryFixture(t,{killWait=false,protocol='http2'}={}){
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const children=[],states=[],logs=[];let network='direct';
 t.mock.method(require('node:child_process'),'spawn',()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;child.pid=children.length+100;
  child.kills=[];child.kill=signal=>{child.kills.push(signal||'SIGTERM');if(!killWait||signal==='SIGKILL')queueMicrotask(()=>{child.signalCode=signal||'SIGTERM';child.emit('exit',null);});return true;};children.push(child);return child;
 });
 const tunnel=startTunnel({executable:process.execPath,token:'eyJ'+'z'.repeat(100),protocol,onState:(state,detail)=>states.push([state,detail]),onLog:line=>logs.push(line)},{fingerprint:()=>network});
 t.after(()=>tunnel.stop());
 return{tunnel,children,states,logs,setNetwork:value=>network=value,line:(line,index=children.length-1)=>children[index].stderr.write(line+'\n'),async tick(ms){t.mock.timers.tick(ms);for(let i=0;i<12;i++)await Promise.resolve();}};
}
test('a healthy HA connection survives peer failure; all connections stalled triggers one fresh process',async t=>{
 const f=recoveryFixture(t);f.line('Registered tunnel connection connIndex=0');f.line('Registered tunnel connection connIndex=1');
 f.line('Serve tunnel error connIndex=0');await f.tick(31000);assert.equal(f.children.length,1);assert.equal(f.states.at(-1)[0],'connected');
 f.line('Connection terminated connIndex=1');await f.tick(20000);f.line('Unable to establish connection with Cloudflare edge connIndex=1');await f.tick(10000);await f.tick(1000);
 assert.equal(f.children.length,2);assert.deepEqual(f.children[0].kills,['SIGTERM']);assert.equal(f.states.at(-1)[0],'reconnecting');
 const count=f.states.length;f.line('Registered tunnel connection connIndex=0',0);assert.equal(f.states.length,count);
 f.line('Registered tunnel connection connIndex=0');assert.equal(f.states.at(-1)[0],'connected');
});
test('self recovery cancels watchdog; origin errors do not restart a connected tunnel',async t=>{
 const f=recoveryFixture(t);f.line('Registered tunnel connection connIndex=0');f.line('Unregistered tunnel connection connIndex=0');await f.tick(20000);
 f.line('Registered tunnel connection connIndex=0');f.line('ERR Unable to reach the origin service');await f.tick(90000);assert.equal(f.children.length,1);assert.equal(f.states.at(-1)[0],'connected');
});
test('adapter changes debounce, replace the child and allow new edge addresses',async t=>{
 const f=recoveryFixture(t);f.line('Registered tunnel connection connIndex=0 ip=198.18.0.1');
 f.setNetwork('tun');await f.tick(3000);f.setNetwork('direct-again');await f.tick(3000);await f.tick(3999);assert.equal(f.children.length,1);await f.tick(1);await f.tick(0);
 assert.equal(f.children.length,2);f.line('Registered tunnel connection connIndex=0 ip=198.41.192.1');assert.equal(f.states.at(-1)[0],'connected');
});
test('unexpected exits back off; late output cannot cancel a queued restart',async t=>{
 const f=recoveryFixture(t);f.children[0].emit('exit',1);f.line('Registered tunnel connection connIndex=0',0);await f.tick(1000);assert.equal(f.children.length,2);
 f.children[1].emit('exit',1);await f.tick(2999);assert.equal(f.children.length,2);await f.tick(1);assert.equal(f.children.length,3);
 f.line('Registered tunnel connection connIndex=0');await f.tick(60000);f.children[2].emit('exit',1);await f.tick(1000);assert.equal(f.children.length,4);
});
test('stop during a pending kill cancels relaunch and forces termination only after grace',async t=>{
 const f=recoveryFixture(t,{killWait:true});f.setNetwork('tun');await f.tick(3000);await f.tick(4000);await f.tick(0);
 assert.equal(f.children.length,1);assert.deepEqual(f.children[0].kills,['SIGTERM']);const stopped=f.tunnel.stop();await f.tick(3000);await stopped;
 assert.deepEqual(f.children[0].kills,['SIGTERM','SIGKILL']);await f.tick(120000);assert.equal(f.children.length,1);
});
test('startup stall recovers and invalid token stops retries',async t=>{
 const f=recoveryFixture(t);await f.tick(60000);await f.tick(1000);assert.equal(f.children.length,2);
 f.line('Provided Tunnel token is not valid.');await f.tick(120000);assert.equal(f.children.length,2);assert.equal(f.states.at(-1)[0],'error');
});
test('an executable launch failure is terminal rather than a restart loop',async t=>{
 const f=recoveryFixture(t);f.children[0].pid=undefined;f.children[0].emit('error',Error('ENOENT'));await f.tick(120000);
 assert.equal(f.states.at(-1)[0],'error');assert.equal(f.children.length,1);
});
test('auto protocol has time for its own fallback before a startup watchdog restart',async t=>{
 const f=recoveryFixture(t,{protocol:'auto'});await f.tick(120000);assert.equal(f.children.length,1);
 f.line('Switching to fallback protocol http2 connIndex=0');f.line('Registered tunnel connection connIndex=0 protocol=http2');await f.tick(120000);assert.equal(f.children.length,1);assert.equal(f.states.at(-1)[0],'connected');
});
test('fingerprints ignore interface enumeration order and loopback addresses',()=>{
 const a={internal:false,family:'IPv4',address:'192.0.2.1',cidr:'192.0.2.1/24'},b={...a,address:'198.18.0.1'};
 assert.equal(networkFingerprint({eth:[a],tun:[b]},['1.1.1.1','8.8.8.8']),networkFingerprint({tun:[b],lo:[{internal:true,address:'127.0.0.1'}],eth:[a]},['8.8.8.8','1.1.1.1']));
 assert.notEqual(networkFingerprint({eth:[a]},[]),networkFingerprint({eth:[a],tun:[b]},[]));
});
