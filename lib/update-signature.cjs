const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const PUBLIC_KEY=fs.readFileSync(path.join(__dirname,'update-public-key.pem'),'utf8');
function signManifest(manifest,privateKey){
 const {signature:_,...payload}=manifest;
 return {...payload,signature:crypto.sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString('base64')};
}
function verifyManifest(manifest,publicKey=PUBLIC_KEY){
 const {signature,...payload}=manifest;
 if(typeof signature!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature) || !crypto.verify(null,Buffer.from(JSON.stringify(payload)),publicKey,Buffer.from(signature,'base64')))throw Error('更新清单签名无效，请切换来源后重新检测');
 return payload;
}
module.exports={signManifest,verifyManifest};
