const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateConfig}=require('../lib/config.cjs');
const {syncModels,deleteUnavailableModel,newKey,entries}=require('../lib/policy.cjs');
const {createModelRefresh}=require('../lib/model-refresh.cjs');
const {localCheck}=require('../lib/diagnostics.cjs');

test('removed models retain aliases and grants but close globally, including after reappearance',()=>{
  let c=syncModels(validateConfig({}),['one','two']);
  const rule=c.modelRules[0];rule.aliases=[{id:'alias-entry',name:'friendly'}];
  c.accessKeys=[{...newKey(),mode:'selected',allowed:['alias-entry']}];
  c.diagnosticModel='friendly';c.modelRates[rule.id]={inputPerMillion:'1',outputPerMillion:'2',cachedInputPerMillion:'0'};
  c=validateConfig(syncModels(c,['two']));
  assert.deepEqual(c.disabledModels,['one']);assert.equal(c.modelRules[0].aliases[0].name,'friendly');
  assert.equal(entries(c)[0].globalEnabled,false);assert.equal(entries(c)[0].available,false);
  const returned=syncModels(c,['one','two']);assert.equal(entries(returned)[0].globalEnabled,false);
  const deleted=validateConfig(deleteUnavailableModel(c,rule.id));
  assert.equal(deleted.modelRules.length,1);assert.deepEqual(deleted.accessKeys[0].allowed,[]);
  assert.equal(deleted.diagnosticModel,'');assert.deepEqual(deleted.modelRates,{});
  assert.throws(()=>deleteUnavailableModel(returned,rule.id),/只能删除/);
  const rediscovered=syncModels(deleted,['one','two']);
  assert.notEqual(rediscovered.modelRules.find(r=>r.actual==='one').id,rule.id);
});
test('a successful empty catalog closes all models; repeated refresh does not reopen them',()=>{
  const c=syncModels(validateConfig({}),['one']);
  const next=syncModels(c,[]);assert.deepEqual(next.disabledModels,['one']);
  assert.deepEqual(syncModels(next,[]).modelRules,c.modelRules);
});
test('local detection returns complete normalized models even when process inspection fails',async()=>{
  const data=Array.from({length:120},(_,i)=>({id:`models/model-${i}`}));
  const result=await localCheck({}, {},{scanner:async()=>{throw Error('unavailable');},fetcher:async()=>Response.json({data})});
  assert.equal(result.ok,false);assert.equal(result.modelsFetched,true);assert.equal(result.models.length,120);
  assert.ok(result.models.includes('model-119'));
  const failed=await localCheck({}, {},{scanner:async()=>({}),fetcher:async()=>Response.json({}, {status:401})});
  assert.equal(failed.modelsFetched,false);
});
test('refresh scheduling respects startup switch, custom interval, errors and disabling',async()=>{
  let c={refreshModelsOnStartup:false,modelRefreshMinutes:3},calls=0,errors=0,timer,cleared=0;
  const scheduler=createModelRefresh({getConfig:()=>c,run:async()=>{calls++;throw Error('offline');},onError:()=>errors++,
    setTimer:(callback,delay)=>{timer={callback,delay};return timer;},clearTimer:()=>cleared++});
  await scheduler.start();assert.equal(calls,0);assert.equal(timer.delay,180000);
  await timer.callback();assert.equal(calls,1);assert.equal(errors,1);assert.equal(timer.delay,180000);
  c.modelRefreshMinutes=0;scheduler.reschedule();assert.equal(cleared,1);
  scheduler.stop();
  c={refreshModelsOnStartup:true,modelRefreshMinutes:0};
  await createModelRefresh({getConfig:()=>c,run:async()=>calls++,onError:()=>{}}).start();assert.equal(calls,2);
  for(const minutes of [-1,0.5,10081,'30'])assert.throws(()=>validateConfig({modelRefreshMinutes:minutes}),/刷新间隔/);
});
test('refresh waits for completion and stopping during an in-flight request prevents rescheduling',async()=>{
  let callback,scheduled=0,finish;
  const scheduler=createModelRefresh({getConfig:()=>({modelRefreshMinutes:1,refreshModelsOnStartup:false}),run:()=>new Promise(resolve=>{finish=resolve;}),onError:()=>{},setTimer:fn=>{callback=fn;scheduled++;return scheduled;},clearTimer:()=>{}});
  await scheduler.start();const running=callback();assert.equal(scheduled,1);
  scheduler.stop();finish();await running;assert.equal(scheduled,1);
});
