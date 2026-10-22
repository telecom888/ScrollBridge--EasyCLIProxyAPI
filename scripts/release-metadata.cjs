const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function writeUpdateMetadata(directory,version){
 const assets={};
 for(const [kind,name]of Object.entries({zip:`ScrollBridge-${version}-win-x64.zip`,installer:`ScrollBridge-Setup-${version}-win-x64.exe`,portable:`ScrollBridge-${version}-win-x64.exe`})){
  const file=path.join(directory,name);assets[kind]={name,size:fs.statSync(file).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
 }
 const notesFile=path.join(__dirname,'..','docs',version+'.md');
 if(!fs.existsSync(notesFile))throw Error('Missing release notes: '+version);
 const privateKey=process.env.SCROLLBRIDGE_UPDATE_SIGNING_KEY || fs.readFileSync(path.join(process.env.LOCALAPPDATA || '', 'ScrollBridge-Release','update-signing-private.pem'),'utf8');
 const {signManifest,verifyManifest}=require('../lib/update-signature.cjs');
 const manifest=signManifest({schemaVersion:1,version,assets,notes:fs.readFileSync(notesFile,'utf8'),publishedAt:new Date().toISOString()},privateKey);
 verifyManifest(manifest);
 fs.writeFileSync(path.join(directory,'scrollbridge-update.json'),JSON.stringify(manifest,null,2));return manifest;
}
module.exports={writeUpdateMetadata};
