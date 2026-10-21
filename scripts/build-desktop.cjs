const {execFileSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),mode=process.argv[2]||'both';if(!['node','go','both','core'].includes(mode))throw Error('Unknown desktop build');
const cwd=path.join(root,'beta','go-gateway'),vendor=path.join(root,'vendor');fs.mkdirSync(vendor,{recursive:true});
if(mode!=='node'){
 execFileSync('go',['build','-trimpath','-buildvcs=false','-ldflags=-s -w','-o',path.join(vendor,'scrollbridge-gateway.exe'),'.'],{cwd,stdio:'inherit',windowsHide:true});
 const used=new Set(execFileSync('go',['list','-deps','-f','{{if .Module}}{{.Module.Path}}{{end}}','./...'],{cwd,encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/));const mods=execFileSync('go',['list','-m','-f','{{.Path}}|{{.Version}}|{{.Dir}}','all'],{cwd,encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).map(s=>s.split('|'));let notices='Go gateway runtime dependency licenses\n';for(const[n,v,d]of mods){if(!v||!used.has(n))continue;const names=fs.readdirSync(d).filter(f=>/^(LICENSE|COPYING)(\.|$)/i.test(f)&&fs.statSync(path.join(d,f)).isFile());if(!names.length)throw Error('Missing license: '+n);for(const name of names)notices+='\n'+n+' '+v+'\n\n'+fs.readFileSync(path.join(d,name),'utf8').trim()+'\n'}fs.writeFileSync(path.join(root,'licenses','go-gateway.txt'),notices);
}
if(mode==='core'){console.log('Go desktop core built');process.exit(0)}
const builder=require('electron-builder');
(async()=>{
 const builds={};
 for(const engine of mode==='both'?['node','go']:[mode]){
  const version=require('../package.json').version+(engine==='go'?'-beta':'');
  const buildDir=path.join(root,'.test-output','desktop-'+engine+'-'+Date.now());builds[engine]=buildDir;
  // An explicit complete config avoids electron-builder concatenating the
  // package.json and override resource arrays and copying the same exe twice.
  const config={...JSON.parse(JSON.stringify(require('../package.json').build)),directories:{output:buildDir},extraMetadata:{gatewayEngine:engine,version},extraResources:[{from:'vendor',to:'vendor',filter:engine==='go'?['cloudflared.exe','scrollbridge-gateway.exe']:['cloudflared.exe']}],portable:{artifactName:`ScrollBridge-${version}-win-x64.exe`}};
  const configFile=buildDir+'.json';fs.writeFileSync(configFile,JSON.stringify(config,null,2));
  await builder.build({projectDir:root,targets:builder.Platform.WINDOWS.createTarget(['portable'],builder.Arch.x64),config:configFile});
  const name=`ScrollBridge-${version}-win-x64.exe`;fs.copyFileSync(path.join(buildDir,name),path.join(root,'release',name));
 }
 const manifestPath=path.join(root,'.test-output','desktop-builds.json');let previous={};try{previous=JSON.parse(fs.readFileSync(manifestPath,'utf8'))}catch{};fs.writeFileSync(manifestPath,JSON.stringify({...previous,...builds},null,2));
 const version=require('../package.json').version;
 const names=[`ScrollBridge-${version}-win-x64.exe`,`ScrollBridge-${version}-beta-win-x64.exe`].filter(n=>fs.existsSync(path.join(root,'release',n)));
 fs.writeFileSync(path.join(root,'release',`SHA256SUMS-${version}.txt`),names.map(n=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'release',n))).digest('hex')+'  '+n).join('\n')+'\n');
})().catch(e=>{console.error(e);process.exit(1)});
