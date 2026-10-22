const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function writeUpdateMetadata(directory,version){
 const assets={};
 for(const [kind,name]of Object.entries({zip:`ScrollBridge-${version}-win-x64.zip`,installer:`ScrollBridge-Setup-${version}-win-x64.exe`,portable:`ScrollBridge-${version}-win-x64.exe`})){
  const file=path.join(directory,name);assets[kind]={name,size:fs.statSync(file).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
 }
 const manifest={schemaVersion:1,version,assets};fs.writeFileSync(path.join(directory,'scrollbridge-update.json'),JSON.stringify(manifest,null,2));return manifest;
}
module.exports={writeUpdateMetadata};
