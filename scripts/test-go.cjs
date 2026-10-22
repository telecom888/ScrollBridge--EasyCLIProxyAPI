const {execFileSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),options={cwd:root,stdio:'inherit',windowsHide:true};
execFileSync('go',['test','./...'],{...options,cwd:path.join(root,'beta','go-gateway')});
execFileSync(process.execPath,['scripts/build-desktop.cjs','core'],options);
execFileSync(process.execPath,['--test','tests/multi-key.test.cjs'],{...options,env:{...process.env,SCROLLBRIDGE_TEST_ENGINE:'go'}});
