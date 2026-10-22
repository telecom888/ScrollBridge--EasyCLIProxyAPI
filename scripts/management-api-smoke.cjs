const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..');
async function run(engine){
  const scratch=path.join(root,'.test-output',`management-${engine}-${Date.now()}`),profile=path.join(scratch,'profile');fs.mkdirSync(scratch,{recursive:true});
  let delayRefresh=false,releaseRefresh,requests=0;
  const upstream=http.createServer((req,res)=>{requests++;const respond=()=>{res.setHeader('content-type','application/json');res.end('{"data":[{"id":"text-real"}]}');};if(delayRefresh)releaseRefresh=respond;else respond();});upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const bootstrap=`const {app}=require('electron');app.getAppPath=()=>${JSON.stringify(root)};app.setLoginItemSettings=()=>{};require(${JSON.stringify(path.join(root,'lib','tunnel.cjs'))}).startTunnel=options=>{queueMicrotask(()=>options.onState('connected'));return{stop:async()=>{}}};require(${JSON.stringify(path.join(root,'electron','main.cjs'))});`;
  fs.writeFileSync(path.join(scratch,'package.json'),JSON.stringify({name:'scrollbridge-management-test',version:'0.3.7',main:'bootstrap.cjs'}));fs.writeFileSync(path.join(scratch,'bootstrap.cjs'),bootstrap);
  const env={...process.env,SCROLLBRIDGE_TEST_DATA:profile,SCROLLBRIDGE_GATEWAY_ENGINE:engine};delete env.ELECTRON_RUN_AS_NODE;
  let app,descriptor,page;
  const launch=async()=>{
    app=await electron.launch({executablePath:require('electron'),args:[scratch],env});page=await app.firstWindow();await page.waitForFunction(()=>!!snapshot);
    await page.waitForFunction(()=>snapshot.config.modelsUpdatedAt || snapshot.logs.some(row=>row.text.includes('自动刷新模型失败')) || !snapshot.config.refreshModelsOnStartup);
    const filename=path.join(profile,'management.json');descriptor=JSON.parse(fs.readFileSync(filename,'utf8'));
  };
  const call=async(route,method='GET',body)=>{
    const response=await fetch(descriptor.baseUrl+'/api/v1'+route,{method,headers:{authorization:`Bearer ${descriptor.token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()};
  };
  try{
    await launch();let r=await call('/config','PATCH',{config:{theme:'dark',refreshModelsOnStartup:false,upstream:`http://127.0.0.1:${upstream.address().port}`}});assert.equal(r.ok,true);
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
    await call('/models/refresh','POST');await page.waitForFunction(()=>snapshot.config.knownModels.includes('text-real'));
    r=await call('/models');const rule=r.data.rules[0];await call('/models/aliases','PUT',{id:rule.id,aliases:[{name:'chat'}],keepOriginal:false});
    r=await call('/keys','POST',{name:'模型代理',mode:'selected',allowed:[(await call('/models')).data.entries[0].id]});assert.equal(r.ok,true);
    const key=r.data.key;assert.equal('value' in key,false);await page.waitForFunction(()=>snapshot.keys.some(key=>key.name==='模型代理'));
    const credential=(await call(`/keys/${key.id}/reveal`,'POST')).data.value;assert.ok(credential.startsWith('sb_'));
    assert.ok(!JSON.stringify(await call('/config')).includes(credential));assert.ok(!JSON.stringify(await call('/keys')).includes(credential));
    await call(`/keys/${key.id}/rotate`,'POST');assert.notEqual((await call(`/keys/${key.id}/reveal`,'POST')).data.value,credential);
    await call(`/keys/${key.id}`,'PUT',{name:'更新名称',mode:'all',enabled:false,allowed:[]});await page.waitForFunction(()=>snapshot.keys.some(key=>key.name==='更新名称'&&!key.enabled));
    // API and desktop mutations share one lock while reads remain available.
    delayRefresh=true;const pending=call('/models/refresh','POST');while(!releaseRefresh)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal((await call('/config','PATCH',{config:{theme:'light'}})).status,409);
    assert.equal((await call('/status')).status,200);
    await assert.rejects(page.evaluate(()=>window.bridge.invoke('save',{config:{theme:'light'}})),/请等待/);
    releaseRefresh();releaseRefresh=undefined;await pending;delayRefresh=false;
    const reserve=http.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
    await call('/config','PATCH',{config:{port,hostname:'api.example.com'},tunnelToken:'eyJ'+'a'.repeat(60)});
    assert.equal((await call('/connection/start','POST')).status,202);await page.waitForFunction(()=>snapshot.status==='connected');
    const locked=await call('/config','PATCH',{config:{port:port+1}});assert.equal(locked.ok,false);assert.match(locked.error.message,/请先停止连接/);
    const value=(await call(`/keys/${key.id}/reveal`,'POST')).data.value;
    // Re-enable the consumer via API, then verify the actual running gateway.
    await call(`/keys/${key.id}`,'PUT',{name:'更新名称',enabled:true,mode:'all',allowed:[]});
    const list=await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{authorization:`Bearer ${value}`}});assert.equal(list.status,200);assert.deepEqual((await list.json()).data.map(row=>row.id),['chat']);
    await call('/models/access','PUT',{model:'text-real',enabled:false});assert.equal((await(await fetch(`http://127.0.0.1:${port}/v1/models`,{headers:{authorization:`Bearer ${value}`}})).json()).data.length,0);
    assert.equal((await call('/logs?kind=requests')).ok,true);assert.equal((await call('/logs?kind=tunnel')).ok,true);
    await call('/connection/stop','POST');await page.waitForFunction(()=>snapshot.status==='stopped');
    await call(`/keys/${key.id}`,'DELETE');await page.waitForFunction(()=>!snapshot.keys.some(key=>key.name==='更新名称'));
    const oldToken=descriptor.token;await app.close();app=null;assert.equal(fs.existsSync(path.join(profile,'management.json')),false);
    await launch();assert.notEqual(descriptor.token,oldToken);assert.equal((await call('/config')).data.config.theme,'dark');
    console.log('Desktop management API passed:',engine,'UI synchronization, shared lock, keys/aliases, real gateway policy, lifecycle and persistence');
  }finally{if(app)await app.close();if(releaseRefresh)releaseRefresh();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
}
(async()=>{for(const engine of process.argv[2]==='--both'?['node','go']:[process.argv[2] || 'go'])await run(engine);})().catch(error=>{console.error(error);process.exitCode=1;});
