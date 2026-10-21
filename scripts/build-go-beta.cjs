const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),cwd=path.join(root,'beta','go-gateway');
const exe=path.join(root,'release','ScrollBridge-Go-Beta-0.1.0-win-x64.exe');
fs.mkdirSync(path.dirname(exe),{recursive:true});
execFileSync('go',['build','-trimpath','-ldflags=-s -w','-o',exe,'.'],{cwd,stdio:'inherit',windowsHide:true});
const used=new Set(execFileSync('go',['list','-deps','-test','-f','{{if .Module}}{{.Module.Path}}{{end}}','./...'],{cwd,encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/));
const modules=execFileSync('go',['list','-m','-f','{{.Path}}|{{.Version}}|{{.Dir}}','all'],{cwd,encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/).map(line=>line.split('|')).filter(row=>row[1]);
let notices='# Go beta dependency licenses\n\nGenerated from pinned go.mod/go.sum. Includes test dependencies; not all modules are linked into the executable. ScrollBridge source is covered by the repository MIT LICENSE.\n';
for(const[name,version,dir]of modules){if(!used.has(name))continue;const files=fs.readdirSync(dir).filter(n=>/^(LICENSE|COPYING)(\.|$)/i.test(n)&&fs.statSync(path.join(dir,n)).isFile());if(!files.length)throw Error('Review missing license: '+name);notices+=`\n## ${name} ${version}\n`;for(const file of files)notices+=`\n${file}\n\n\x60\x60\x60text\n${fs.readFileSync(path.join(dir,file),'utf8').trim()}\n\x60\x60\x60\n`;}
fs.writeFileSync(path.join(cwd,'THIRD_PARTY_NOTICES.md'),notices);
const sha=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
fs.writeFileSync(path.join(root,'release','SHA256SUMS-go-beta-0.1.0.txt'),sha+'  '+path.basename(exe)+'\n');
console.log(JSON.stringify({exe,bytes:fs.statSync(exe).size,sha256:sha}));
