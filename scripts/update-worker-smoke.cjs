const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {createInstallJob,launchInstallJob}=require('../lib/update-install.cjs');
const root=path.resolve(__dirname,'..'),scratch=path.join(root,'.test-output','update-worker-'+Date.now());fs.mkdirSync(scratch,{recursive:true});
const compile=path.join(scratch,'compile.ps1');
fs.writeFileSync(compile,'param($Source,$Output)\n$ErrorActionPreference="Stop"\nAdd-Type -TypeDefinition (Get-Content -LiteralPath $Source -Raw -Encoding UTF8) -OutputAssembly $Output -OutputType WindowsApplication\n');
function binary(name,body){
 const source=path.join(scratch,name+'.cs'),output=path.join(scratch,name+'.exe');
 fs.writeFileSync(source,'using System;using System.IO;using System.Threading;public class Program{[STAThread]public static void Main(){'+body+'}}');
 execFileSync('powershell.exe',['-NoProfile','-File',compile,source,output],{windowsHide:true,stdio:'pipe'});return output;
}
const old=binary('old','File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"old-started"),"1");');
const good=binary('new','var id=Environment.GetEnvironmentVariable("SCROLLBRIDGE_UPDATE_ID");var profile=Environment.GetEnvironmentVariable("SCROLLBRIDGE_TEST_PROFILE");if(id!=null){File.WriteAllText(Path.Combine(profile,"updates",id,"ready.json"),"{\\\"id\\\":\\\""+id+"\\\",\\\"version\\\":\\\"0.3.14\\\"}");}Thread.Sleep(1000);');
const bad=binary('bad','Environment.Exit(9);');
const zipScript=path.join(scratch,'zip.ps1');fs.writeFileSync(zipScript,'param($Source,$Output,$Bad)\n$ErrorActionPreference="Stop"\nAdd-Type -AssemblyName System.IO.Compression\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\nif($Bad -eq "yes"){$z=[IO.Compression.ZipFile]::Open($Output,[IO.Compression.ZipArchiveMode]::Create);$e=$z.CreateEntry("../escaped");$z.Dispose()}else{[IO.Compression.ZipFile]::CreateFromDirectory($Source,$Output)}\n');
(async()=>{for(const name of ['portable','zip','failed-start','failed-installer','unsafe-zip']){
 const base=path.join(scratch,name+' space'),target=path.join(base,'app'),profile=path.join(base,'profile'),id=crypto.randomUUID(),directory=path.join(profile,'updates',id);
 fs.mkdirSync(path.join(target,'resources'),{recursive:true});fs.mkdirSync(directory,{recursive:true});
 const executable=path.join(target,'app.exe');fs.copyFileSync(old,executable);fs.writeFileSync(path.join(target,'resources','app.asar'),'old-asar');fs.writeFileSync(path.join(target,'resources','update-files.json'),JSON.stringify({files:['app.exe','resources/app.asar','resources/update-files.json']}));
 const config=Buffer.from('synthetic configuration to preserve');fs.writeFileSync(path.join(target,'scrollbridge.json'),config);
 const kind=name.includes('zip')?'zip':name==='failed-installer'?'installer':'portable';let filename;
 if(kind==='zip'){
  const content=path.join(base,'content');fs.mkdirSync(path.join(content,'resources'),{recursive:true});fs.copyFileSync(good,path.join(content,'app.exe'));fs.writeFileSync(path.join(content,'resources','app.asar'),'new-asar');
  filename=path.join(directory,'update.zip');execFileSync('powershell.exe',['-NoProfile','-File',zipScript,content,filename,name==='unsafe-zip'?'yes':'no'],{windowsHide:true});
 }else{filename=path.join(directory,'update.exe');fs.copyFileSync(name==='portable'?good:bad,filename);}
 const bytes=fs.readFileSync(filename),payload={id,directory,filename,kind,version:'0.3.14',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
 const plan=createInstallJob(payload,{executable,configDirectory:target,profileDirectory:profile,resumeConnection:false,pid:999999});
 let result;
 if(name==='portable'){
  await launchInstallJob(plan);const deadline=Date.now()+90000;
  while(!fs.existsSync(path.join(directory,'result.json')) && Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  result={status:0,stderr:''};
 }else result=require('node:child_process').spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',plan.helper,'-JobFile',plan.filename],{windowsHide:true,encoding:'utf8',timeout:90000});
 if(result.error)throw result.error;
 const report=JSON.parse(fs.readFileSync(path.join(directory,'result.json'),'utf8').replace(/^\uFEFF/,''));
 const success=['portable','zip'].includes(name);
 assert.equal(report.status,success?'success':'rolled-back',JSON.stringify({name,report,stderr:result.stderr}));
 assert.equal(result.status,success?0:1);
 assert.deepEqual(fs.readFileSync(path.join(target,'scrollbridge.json')),config);
 assert.deepEqual(fs.readFileSync(executable),fs.readFileSync(success?good:old));
 if(name==='unsafe-zip')assert.equal(fs.existsSync(path.join(base,'escaped')),false);
 console.log('Update worker passed:',name);
}
})().catch(error=>{console.error(error);process.exitCode=1;});
