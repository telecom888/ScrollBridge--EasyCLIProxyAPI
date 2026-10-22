const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {toGoConfig}=require('../lib/go-gateway.cjs');const {validateConfig,createAccessKey}=require('../lib/config.cjs');const {newKey,syncModels}=require('../lib/policy.cjs');
test('Go bridge sends digests and independent grants without changing policy for appearance',()=>{
 const key=newKey('测试');let c=syncModels(validateConfig({accessKeys:[key]}),['vendor/model:latest']);c.modelRules[0].aliases=[{id:'exposure-chat',name:'chat'}];c.modelRules[0].keepOriginal=true;c.accessKeys[0].mode='selected';c.accessKeys[0].allowed=['exposure-chat'];c=validateConfig(c);
 const secret=createAccessKey(),secrets={keyValues:{[key.id]:secret},upstreamKey:'DO_NOT_SERIALIZE_SUPPLY_KEY',tunnelToken:'DO_NOT_SERIALIZE_TUNNEL_TOKEN'};const out=toGoConfig(c,secrets,1);assert.ok(!JSON.stringify(out).includes(secret));assert.ok(!JSON.stringify(out).includes(secrets.upstreamKey));assert.ok(!JSON.stringify(out).includes(secrets.tunnelToken));assert.equal(out.keys[0].sha256,crypto.createHash('sha256').update(secret).digest('hex'));assert.deepEqual(out.keys[0].allowed,['exposure-chat']);assert.equal(out.models[0].exposureIds.chat,'exposure-chat');assert.equal(out.models[0].exposureIds['vendor/model:latest'],c.modelRules[0].originalId);
 assert.deepEqual(toGoConfig({...c,theme:'dark',diagnosticModel:'chat',hostname:'fixture.invalid'},secrets,1),out);
 const blocked=toGoConfig({...c,disabledModels:['vendor/model:latest']},secrets,2);assert.equal(blocked.models[0].enabled,false);assert.equal(toGoConfig({...c,knownModels:[]},secrets,2).models[0].available,false);
});
test('fees validate decimal rates and preserve the usage-price switch',()=>{let c=validateConfig({});c.billing={...c.billing,enabled:true,readUsagePrice:true,rates:{inputPerMillion:'2',outputPerMillion:'8',cachedInputPerMillion:'0.5'}};assert.equal(validateConfig(c).billing.readUsagePrice,true);for(const invalid of ['-1','NaN','1.1234567890','1e6'])assert.throws(()=>validateConfig({...c,billing:{...c.billing,rates:{...c.billing.rates,inputPerMillion:invalid}}}),/费用设置无效/);});
test('optional key limits validate, default off and reach the Go core unchanged',()=>{
 const key=newKey('手机'),config=validateConfig({accessKeys:[key]}),secrets={keyValues:{[key.id]:createAccessKey()}};
 assert.equal(config.accessKeys[0].concurrent,0);assert.equal(config.accessKeys[0].requestLimit,0);
 Object.assign(key,{concurrent:9000,requestLimit:123,requestWindowSeconds:1800});
 const out=toGoConfig(validateConfig(config),secrets);
 assert.equal(out.keys[0].concurrent,9000);assert.equal(out.keys[0].requestLimit,123);assert.equal(out.keys[0].requestWindowSeconds,1800);
 for(const [field,value]of [['concurrent',-1],['concurrent',1.5],['requestLimit',-1],['requestLimit',NaN],['requestWindowSeconds',59],['requestWindowSeconds',Infinity]]){
   const invalid=structuredClone(config);invalid.accessKeys[0][field]=value;assert.throws(()=>validateConfig(invalid),/密钥限制无效/);
 }
});
