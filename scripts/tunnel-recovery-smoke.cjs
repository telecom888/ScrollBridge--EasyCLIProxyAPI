const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {Store}=require('../lib/store.cjs'),{validateConfig,createAccessKey}=require('../lib/config.cjs'),{newKey,syncModels}=require('../lib/policy.cjs');
const root=path.resolve(__dirname,'..');
(async()=>{
 const scratch=path.join(root,'.test-output','tunnel-recovery-'+Date.now()),profile=path.join(scratch,'profile'),networkFile=path.join(scratch,'network.txt');fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(networkFile,'direct');
 const upstream=http.createServer((req,res)=>{req.resume();res.setHeader('content-type','application/json');res.end('{"data":[{"id":"text"}]}');});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const key=newKey('fixture'),value=createAccessKey();
 new Store(profile).save(syncModels(validateConfig({upstream:'http://127.0.0.1:'+upstream.address().port,port,hostname:'fixture.invalid',refreshModelsOnStartup:false,accessKeys:[key]}),['text']),{keyValues:{[key.id]:value},upstreamKey:'disposable-fixture-key',tunnelToken:'eyJ'+'fixture'.repeat(20)});
 const originalConfig=fs.readFileSync(path.join(profile,'scrollbridge.json'),'utf8');
 const fake=path.join(scratch,'fake-tunnel.cjs');fs.writeFileSync(fake,'console.log("Registered tunnel connection connIndex=0");console.log("Registered tunnel connection connIndex=1");setInterval(()=>{},1000);');
 const bootstrap=`const {app}=require('electron');app.getAppPath=()=>${JSON.stringify(root)};const fs=require('node:fs'),cp=require('node:child_process'),spawn=cp.spawn;global.tunnelChildren=[];global.goChildren=[];global.tunnelStates=[];cp.spawn=function(file,args,options){let child;if(String(file).endsWith('cloudflared.exe')){child=spawn(process.execPath,[${JSON.stringify(fake)}],{...options,env:{...options.env,ELECTRON_RUN_AS_NODE:'1'}});global.tunnelChildren.push(child);}else{child=spawn(file,args,options);if(String(file).endsWith('scrollbridge-gateway.exe'))global.goChildren.push(child);}return child;};const mod=require(${JSON.stringify(path.join(root,'lib','tunnel.cjs'))}),original=mod.startTunnel;mod.startTunnel=options=>original({...options,onState:(state,detail)=>{global.tunnelStates.push(state);options.onState(state,detail);}},{fingerprint:()=>fs.readFileSync(${JSON.stringify(networkFile)},'utf8')});require(${JSON.stringify(path.join(root,'electron','main.cjs'))});`;
 fs.writeFileSync(path.join(scratch,'bootstrap.cjs'),bootstrap);fs.writeFileSync(path.join(scratch,'package.json'),JSON.stringify({name:'isolated-recovery-test',version:require('../package.json').version,main:'bootstrap.cjs'}));
 const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile,SCROLLBRIDGE_GATEWAY_ENGINE:'go'};delete env.ELECTRON_RUN_AS_NODE;
 let app;
 try{
  app=await electron.launch({executablePath:require('electron'),args:[scratch],env});const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.waitForFunction(()=>typeof snapshot!=='undefined'&&!!snapshot);
  await page.evaluate(()=>window.bridge.invoke('start'));await page.waitForFunction(()=>snapshot.status==='connected');
  const send=async()=>{const response=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{authorization:'Bearer '+value}});await response.text();assert.equal(response.status,200);};await send();await page.waitForFunction(()=>snapshot.records.length>0);
  const gatewayPid=await app.evaluate(()=>global.goChildren[0].pid),recordId=await page.evaluate(()=>snapshot.records[0].id);
  const waitChildren=async count=>{for(let i=0;i<100;i++){if(await app.evaluate((_,count)=>global.tunnelChildren.length>=count,count))return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('No replacement tunnel child');};
  for(const [network,count]of [['tun',2],['direct',3]]){
   fs.writeFileSync(networkFile,network);await waitChildren(count);await page.waitForFunction(()=>snapshot.status==='connected');
   assert.equal(await app.evaluate(()=>global.goChildren.length),1);assert.equal(await app.evaluate(()=>global.goChildren[0].pid),gatewayPid);
   assert.ok(await page.evaluate(id=>snapshot.records.some(row=>row.id===id),recordId));await send();
  }
  assert.ok(await app.evaluate(()=>global.tunnelStates.includes('reconnecting')));
  assert.ok(await app.evaluate(()=>global.tunnelChildren.slice(0,-1).every(child=>child.exitCode!==null||child.signalCode!==null)));
  assert.equal(fs.readFileSync(path.join(profile,'scrollbridge.json'),'utf8'),originalConfig);
  fs.writeFileSync(networkFile,'pending');await new Promise(resolve=>setTimeout(resolve,3200));await page.evaluate(()=>window.bridge.invoke('stop'));await new Promise(resolve=>setTimeout(resolve,4500));
  assert.equal(await app.evaluate(()=>global.tunnelChildren.length),3);assert.equal(await page.evaluate(()=>snapshot.status),'stopped');assert.deepEqual(errors,[]);
  console.log('Network changes recover with a fresh tunnel; gateway, keys and request history survive; stop cancels retries:',scratch);
 }finally{if(app)await app.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
