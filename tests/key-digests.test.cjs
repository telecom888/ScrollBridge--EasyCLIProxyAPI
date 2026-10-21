const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {keyDigest}=require('../lib/key-digests.cjs');
test('credential digests are reused but rotation, in-place changes and deletion take effect immediately',()=>{
 const values={first:'original'};const first=keyDigest(values,'first');assert.equal(keyDigest(values,'first'),first);
 values.first='rotated';const rotated=keyDigest(values,'first');assert.notEqual(rotated,first);assert.equal(rotated.toString('hex'),crypto.createHash('sha256').update('rotated').digest('hex'));
 delete values.first;assert.equal(keyDigest(values,'first'),null);assert.notEqual(keyDigest({first:'original'},'first'),first);
});
