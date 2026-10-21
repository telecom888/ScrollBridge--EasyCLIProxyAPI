const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {dataDirectory}=require('../lib/data-path.cjs');
test('portable editions and renamed/newer exes resolve beside the outer executable, never the temporary extraction',()=>{
 const root=path.resolve('release');for(const name of ['ScrollBridge-0.3.4-win-x64.exe','ScrollBridge-0.3.4-beta-win-x64.exe','renamed.exe'])assert.equal(dataDirectory({portableFile:path.join(root,name),packaged:true,executable:path.resolve('temp','卷桥.exe')}),root);
 assert.equal(dataDirectory({packaged:true,executable:path.join(root,'卷桥.exe')}),root);
 assert.equal(dataDirectory({packaged:false,appPath:root}),root);
 assert.equal(dataDirectory({testDirectory:root,portableFile:path.resolve('elsewhere.exe')}),root);
});
