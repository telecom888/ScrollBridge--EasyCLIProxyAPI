const {spawn}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
  const exe=path.resolve(process.argv[2]||`release/ScrollBridge-${require('../package.json').version}-win-x64.exe`);const data=path.resolve(`.test-output/portable-${Date.now()}`);fs.mkdirSync(data,{recursive:true});
  const env={...process.env,SCROLLBRIDGE_SMOKE:'1',SCROLLBRIDGE_SMOKE_EXIT:'1',SCROLLBRIDGE_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(exe,[],{env,windowsHide:true,stdio:'ignore'});let failure;child.on('error',e=>failure=e);
  const marker=path.join(data,'runtime-ready.json');const deadline=Date.now()+45000;
  while(!fs.existsSync(marker)&&Date.now()<deadline&&!failure)await new Promise(r=>setTimeout(r,500));
  if(failure)throw failure;if(!fs.existsSync(marker))throw new Error('Portable EXE did not finish startup in 45 seconds');
  const result=JSON.parse(fs.readFileSync(marker,'utf8'));assert.deepEqual(result,{packaged:true,portable:true,encrypted:true,ready:true});
  fs.writeFileSync('.test-output/portable-report.json',JSON.stringify({ok:true,...result},null,2));console.log('Portable EXE extracted, loaded the application, and initialized Windows encryption');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
