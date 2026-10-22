const crypto=require('node:crypto');

// A portable obfuscation key, shared by every installation. This is deliberately
// independent of Windows accounts and must stay stable across future releases.
// Anyone with the application can extract it; it is not a user security boundary.
const KEY=Buffer.from('83151ea04ec798c1f625738f5ae123c949d419acbb7ba59a2409b1178d890ce6','hex');
const HEADER=Buffer.from('SBA1');
const AAD=Buffer.from('ScrollBridge/secrets/aes-256-gcm/v1');
function encryptSecrets(text){
  const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',KEY,nonce);
  cipher.setAAD(AAD);
  const ciphertext=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return Buffer.concat([HEADER,nonce,cipher.getAuthTag(),ciphertext]).toString('base64');
}
function decryptSecrets(value){
  const blob=Buffer.from(value,'base64');
  if(blob.length<33 || !blob.subarray(0,4).equals(HEADER))throw Error('密钥密文格式无效');
  const decipher=crypto.createDecipheriv('aes-256-gcm',KEY,blob.subarray(4,16));
  decipher.setAAD(AAD);decipher.setAuthTag(blob.subarray(16,32));
  return Buffer.concat([decipher.update(blob.subarray(32)),decipher.final()]).toString('utf8');
}
module.exports={encryptSecrets,decryptSecrets};
