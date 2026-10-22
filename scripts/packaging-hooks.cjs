const fs=require('node:fs'),path=require('node:path');
module.exports=async({appOutDir})=>{
 const list=[];
 function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);if(entry.isDirectory())walk(full);else list.push(path.relative(appOutDir,full).split(path.sep).join('/'));}}
 walk(appOutDir);const name='resources/update-files.json';
 fs.writeFileSync(path.join(appOutDir,name),JSON.stringify({schemaVersion:1,files:[...new Set([...list,name])].sort()},null,2));
};
