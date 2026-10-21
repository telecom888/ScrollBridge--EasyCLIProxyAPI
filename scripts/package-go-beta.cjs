const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),src=path.join(root,'beta','go-gateway'),stage=path.join(root,'.test-output','go-beta-package');
fs.mkdirSync(stage,{recursive:true});
const name='ScrollBridge-Go-Beta-0.1.0-win-x64';
fs.copyFileSync(path.join(root,'release',name+'.exe'),path.join(stage,name+'.exe'));
for(const file of['config.example.json','README.md','QUICKSTART.zh-CN.md','REPORT.md','THIRD_PARTY_NOTICES.md'])fs.copyFileSync(path.join(src,file),path.join(stage,file));
fs.copyFileSync(path.join(root,'LICENSE'),path.join(stage,'LICENSE'));
fs.mkdirSync(path.join(stage,'benchmarks'),{recursive:true});
for(const file of['results.json','security-scan.txt'])fs.copyFileSync(path.join(src,'benchmarks',file),path.join(stage,'benchmarks',file));
const zip=path.join(root,'release',name+'.zip');
// Explicit filenames only; never package a user's runtime settings or ledger.
execFileSync('tar.exe',['-a','-cf',zip,'-C',stage,name+'.exe','config.example.json','README.md','QUICKSTART.zh-CN.md','REPORT.md','THIRD_PARTY_NOTICES.md','LICENSE','benchmarks'],{windowsHide:true,stdio:'inherit'});
const hashes=[name+'.exe',name+'.zip'].map(n=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'release',n))).digest('hex')+'  '+n).join('\n')+'\n';
fs.writeFileSync(path.join(root,'release','SHA256SUMS-go-beta-0.1.0.txt'),hashes);
console.log(JSON.stringify({package:zip,bytes:fs.statSync(zip).size}));
