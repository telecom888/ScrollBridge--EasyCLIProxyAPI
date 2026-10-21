const crypto = require('node:crypto');
const cache = new WeakMap();
function keyDigest(values,id) {
  const value=values[id];if(typeof value!=='string')return null;
  let entries=cache.get(values);if(!entries){entries=new Map();cache.set(values,entries);}
  let entry=entries.get(id);
  if(!entry||entry.value!==value){entry={value,digest:crypto.createHash('sha256').update(value).digest()};entries.set(id,entry);}
  return entry.digest;
}
module.exports = {keyDigest};
