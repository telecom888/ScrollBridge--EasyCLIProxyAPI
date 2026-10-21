const {_electron:electron}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
(async()=>{for(const engine of ['node','go']){
  const builds=process.argv[2]&&process.argv[3]?{node:process.argv[2],go:process.argv[3]}:JSON.parse(fs.readFileSync('.test-output/desktop-builds.json','utf8'));
  const profile=path.resolve(`.test-output/management-packaged-${engine}-${Date.now()}`),env={...process.env,SCROLLBRIDGE_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.SCROLLBRIDGE_GATEWAY_ENGINE;
  let app;
  try{
    app=await electron.launch({executablePath:path.join(builds[engine],'win-unpacked','卷桥.exe'),args:[],env});
    const page=await app.firstWindow();await page.waitForFunction(()=>!!snapshot && (snapshot.config.modelsUpdatedAt || snapshot.logs.some(row=>row.text.includes('自动刷新模型失败'))));
    const filename=path.join(profile,'management.json'),discovery=JSON.parse(fs.readFileSync(filename,'utf8'));
    const response=await fetch(discovery.baseUrl+'/api/v1/schema',{headers:{authorization:`Bearer ${discovery.token}`}});
    const schema=await response.json();assert.equal(schema.ok,true);assert.match(schema.data.appVersion,new RegExp('^'+require('../package.json').version));
    const runClient=async(args,input)=>{
      const child=spawn(process.execPath,['scripts/control.cjs',...args],{env:{...process.env,SCROLLBRIDGE_DISCOVERY:filename},stdio:['pipe','pipe','pipe'],windowsHide:true});
      let out='';child.stdout.on('data',chunk=>out+=chunk);child.stdin.end(input || '');
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});return {code,value:JSON.parse(out)};
    };
    assert.equal((await runClient(['GET','/status'])).code,0);
    assert.equal((await runClient(['PATCH','/config','--stdin'],JSON.stringify({config:{theme:'dark',refreshModelsOnStartup:false}}))).code,0);
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
    assert.equal((await runClient(['GET','/bad-route'])).code,1);
    assert.equal((await runClient(['bad'])).code,2);
    await app.close();app=null;assert.equal(fs.existsSync(filename),false);
    console.log('Packaged management API and CLI client passed:',engine,schema.data.appVersion);
  }finally{if(app)await app.close();}
}})().catch(error=>{console.error(error);process.exitCode=1;});
