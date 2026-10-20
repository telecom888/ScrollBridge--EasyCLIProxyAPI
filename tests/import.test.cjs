const {test}=require('node:test');const assert=require('node:assert/strict');const {parseCPA}=require('../lib/import-cpa.cjs');
test('imports current v8 listener and access credentials',()=>{assert.deepEqual(parseCPA('config-version: 8\nserver:\n  port: 8317\naccess:\n  api-keys: [client-secret]\n'),{upstream:'http://127.0.0.1:8317',upstreamKey:'client-secret'});});
test('imports legacy flat configs',()=>{assert.deepEqual(parseCPA('port: 9000\napi-keys: [old-secret]\ntls:\n  enable: true\n'),{upstream:'https://127.0.0.1:9000',upstreamKey:'old-secret'});});
test('explicit empty v8 access overrides legacy credentials',()=>{assert.equal(parseCPA('port: 8317\napi-keys: [old-secret]\naccess:\n  api-keys: []\n').upstreamKey,'');});
