const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve('.test-output',`portable-location-${Date.now()}`),folder=path.join(root,'程序'),profile=path.join(root,'cache');
 fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(profile,{recursive:true});
 const version=require('../package.json').version;let original;
 for(const suffix of ['', '-renamed']){
  const exe=path.join(folder,`卷桥${suffix}.exe`);fs.copyFileSync(path.resolve(`release/ScrollBridge-${version}-win-x64.exe`),exe);
  const env={...process.env,SCROLLBRIDGE_TEST_PROFILE:profile,SCROLLBRIDGE_SMOKE:'1',SCROLLBRIDGE_SMOKE_EXIT:'1'};
  delete env.SCROLLBRIDGE_TEST_DATA;delete env.ELECTRON_RUN_AS_NODE;delete env.SCROLLBRIDGE_GATEWAY_ENGINE;
  const marker=path.join(profile,'runtime-ready.json');if(fs.existsSync(marker))fs.unlinkSync(marker);
  const child=spawn(exe,[],{env,windowsHide:true,stdio:'ignore'});
  const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
  const deadline=Date.now()+45000;
  while(!fs.existsSync(marker)&&child.exitCode===null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,300));
  if(!fs.existsSync(marker)){child.kill();throw Error('Actual portable startup failed');}
  let timer;try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('Portable did not exit'))},10000)})])}finally{clearTimeout(timer)};
  const file=path.join(folder,'scrollbridge.json');assert.equal(fs.existsSync(file),true,'configuration belongs beside the outer EXE');
  assert.equal(fs.existsSync(path.join(profile,'scrollbridge.json')),false,'configuration must not land in the Electron profile');
  const text=fs.readFileSync(file,'utf8');assert.equal(JSON.parse(text).version,2);
  if(original)assert.equal(text,original,'renamed executable must preserve the exact identity and ciphertext');else original=text;
 }
 console.log('Actual renamed portable EXEs share one unchanged encrypted configuration beside the EXEs, outside the Electron profile');
})().catch(e=>{console.error(e.message);process.exitCode=1});
