const {test}=require('node:test'),assert=require('node:assert/strict');
const {createStartup}=require('../lib/startup.cjs'),{validateConfig}=require('../lib/config.cjs');
function fixture(initial){
 let item=initial,failRead=false,mode='',calls=[],saved=0;
 const app={getLoginItemSettings(){if(failRead)throw Error('read denied');return{launchItems:item?[{name:'test',path:'C:\\Apps\\卷桥.exe',args:[],scope:'user',enabled:item.enabled}]:[]};},setLoginItemSettings(options){calls.push(options);if(mode==='throw')throw Error('registration failed');if(mode==='silent')return;item=options.openAtLogin?{enabled:options.enabled}:null;}};
 const startup=createStartup({app,executable:'C:\\Apps\\卷桥.exe',platform:'win32',name:'test'});
 return {startup,calls,get saved(){return saved;},persist(){saved++;},set mode(v){mode=v;},set failRead(v){failRead=v;},set item(v){item=v;}};
}
test('startup accepts only booleans in both config and direct updates',()=>{
 for(const value of ['false',1,0,null,{},[]]){assert.throws(()=>validateConfig({launchAtLogin:value}),/开机启动/);assert.throws(()=>fixture().startup.change(value,()=>{}),/开机启动/);}
 for(const value of [true,false])assert.equal(validateConfig({launchAtLogin:value}).launchAtLogin,value);
});
test('startup inspection respects external disable and deletion without registry writes',()=>{
 const f=fixture({enabled:false});assert.equal(f.startup.refresh().disabledBySystem,true);f.item=null;assert.equal(f.startup.refresh().registered,false);assert.equal(f.calls.length,0);
 f.failRead=true;assert.equal(f.startup.refresh().enabled,null);assert.match(f.startup.snapshot().error,/无法读取/);assert.throws(()=>f.startup.change(true,f.persist),/无法读取/);assert.equal(f.calls.length,0);
});
test('only confirmed enable and disable are persisted, and explicit enable repairs a disabled entry',()=>{
 const f=fixture({enabled:false});f.startup.change(true,f.persist);assert.equal(f.saved,1);assert.equal(f.startup.snapshot().enabled,true);assert.equal(f.calls[0].path,'C:\\Apps\\卷桥.exe');assert.deepEqual(f.calls[0].args,[]);
 f.startup.change(false,f.persist);assert.equal(f.saved,2);assert.equal(f.startup.snapshot().registered,false);
});
test('thrown or silently rejected registration never persists the requested setting',()=>{
 for(const mode of ['throw','silent']){const f=fixture();f.mode=mode;assert.throws(()=>f.startup.change(true,f.persist),/未保存/);assert.equal(f.saved,0);assert.equal(f.startup.snapshot().enabled,false);}
});
test('disk save failure restores enabled, disabled and absent system states',()=>{
 for(const initial of [undefined,{enabled:false},{enabled:true}]){const f=fixture(initial);assert.throws(()=>f.startup.change(!initial?.enabled,()=>{throw Error('disk full');}),/disk full/);assert.equal(f.startup.snapshot().registered,!!initial);assert.equal(f.startup.snapshot().enabled,!!initial?.enabled);}
});
test('inspection matches current executable, user scope, exact args and test registration name',()=>{
 const app={getLoginItemSettings:()=>({launchItems:[{name:'other',path:'C:\\app.exe',scope:'user',args:[],enabled:true},{name:'test',path:'C:\\other.exe',scope:'user',args:[],enabled:true},{name:'test',path:'C:\\app.exe',scope:'machine',args:[],enabled:true},{name:'test',path:'C:\\app.exe',scope:'user',args:['--other'],enabled:true}]})};
 assert.equal(createStartup({app,executable:'C:\\app.exe',platform:'win32',name:'test'}).refresh().enabled,false);
});
