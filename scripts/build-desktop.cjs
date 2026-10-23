const {execFileSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..'),mode=process.argv[2]||'go';if(!['node','go','both','core'].includes(mode))throw Error('Unknown desktop build');
// dist runs test:go first, which builds and exercises this exact core. Standalone
// desktop builds retain their usual compilation step.
const reuseCore=process.argv.includes('--skip-core-build');
if(reuseCore && !['go','both'].includes(mode))throw Error('--skip-core-build requires go or both');
const cwd=path.join(root,'beta','go-gateway'),vendor=path.join(root,'vendor');fs.mkdirSync(vendor,{recursive:true});
if(reuseCore){
 for(const file of [path.join(vendor,'scrollbridge-gateway.exe'),path.join(root,'licenses','go-gateway.txt')])if(!fs.existsSync(file))throw Error('Missing Go build output; run npm run test:go first: '+file);
 console.log('Reusing Go core and licenses from the preceding test:go build');
}
if(mode!=='node' && !reuseCore){
 execFileSync('go',['build','-trimpath','-buildvcs=false','-ldflags=-s -w','-o',path.join(vendor,'scrollbridge-gateway.exe'),'.'],{cwd,stdio:'inherit',windowsHide:true});
 const used=new Set(execFileSync('go',['list','-deps','-f','{{if .Module}}{{.Module.Path}}{{end}}','./...'],{cwd,encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/));const mods=execFileSync('go',['list','-m','-f','{{.Path}}|{{.Version}}|{{.Dir}}','all'],{cwd,encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).map(s=>s.split('|'));let notices='Go gateway runtime dependency licenses\n';for(const[n,v,d]of mods){if(!v||!used.has(n))continue;const names=fs.readdirSync(d).filter(f=>/^(LICENSE|COPYING)(\.|$)/i.test(f)&&fs.statSync(path.join(d,f)).isFile());if(!names.length)throw Error('Missing license: '+n);for(const name of names)notices+='\n'+n+' '+v+'\n\n'+fs.readFileSync(path.join(d,name),'utf8').trim()+'\n'}fs.writeFileSync(path.join(root,'licenses','go-gateway.txt'),notices);
}
if(mode==='core'){console.log('Go desktop core built');process.exit(0)}
fs.mkdirSync(path.join(root,'release'),{recursive:true});
const builder=require('electron-builder');
(async()=>{
 const builds={};
 for(const engine of mode==='both'?['node','go']:[mode]){
  const version=require('../package.json').version+(engine==='node'?'-node':'');
  const buildDir=path.join(root,'.test-output','desktop-'+engine+'-'+Date.now());builds[engine]=buildDir;
  // An explicit complete config avoids electron-builder concatenating the
  // package.json and override resource arrays and copying the same exe twice.
  // In the installed builder, true omits UNPACK_DIR_NAME and uses NSIS's
  // per-launch $PLUGINSDIR. false follows the shared build-ID branch despite
  // the type documentation claiming otherwise. See portable-duplicate-smoke.
  const config={...JSON.parse(JSON.stringify(require('../package.json').build)),directories:{output:buildDir},afterPack:'scripts/packaging-hooks.cjs',extraMetadata:{gatewayEngine:engine,version},extraResources:[{from:'vendor',to:'vendor',filter:engine==='go'?['cloudflared.exe','scrollbridge-gateway.exe']:['cloudflared.exe']}],artifactName:`ScrollBridge-${version}-win-x64.zip`,portable:{artifactName:`ScrollBridge-${version}-win-x64.exe`,unpackDirName:true},nsis:{oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,runAfterFinish:false,deleteAppDataOnUninstall:false,include:'design/installer.nsh',artifactName:`ScrollBridge-Setup-${version}-win-x64.exe`}};
  if(engine==='go')config.files.push('!lib/gateway.cjs','!lib/gemini-images.cjs','!lib/model-response.cjs','!node_modules/busboy/**/*','!node_modules/streamsearch/**/*','!node_modules/ws/**/*');
  const configFile=buildDir+'.json';fs.writeFileSync(configFile,JSON.stringify(config,null,2));
  // Publishing is owned by the release workflow after all packages and the
  // signed update manifest exist. Never let a CI tag enable builder's publisher.
  await builder.build({projectDir:root,targets:builder.Platform.WINDOWS.createTarget(['portable','nsis','zip'],builder.Arch.x64),config:configFile,publish:'never'});
  for(const name of [`ScrollBridge-${version}-win-x64.exe`,`ScrollBridge-Setup-${version}-win-x64.exe`,`ScrollBridge-${version}-win-x64.zip`])fs.copyFileSync(path.join(buildDir,name),path.join(root,'release',name));
 }
 const manifestPath=path.join(root,'.test-output','desktop-builds.json');let previous={};try{previous=JSON.parse(fs.readFileSync(manifestPath,'utf8'))}catch{};fs.writeFileSync(manifestPath,JSON.stringify({...previous,...builds},null,2));
 const version=require('../package.json').version;
 if(mode!=='node')require('./release-metadata.cjs').writeUpdateMetadata(path.join(root,'release'),version);
})().catch(e=>{console.error(e);process.exit(1)});
