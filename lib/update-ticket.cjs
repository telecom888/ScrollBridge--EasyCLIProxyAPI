const fs=require('node:fs'),path=require('node:path');
function readUpdateTicket({id,profileDirectory,version,executable}){
 if(!id)return null;
 if(!/^[a-f0-9-]{36}$/.test(id))throw Error('更新标识无效');
 const directory=path.join(profileDirectory,'updates',id),job=JSON.parse(fs.readFileSync(path.join(directory,'job.json'),'utf8'));
 if(job.id!==id || job.version!==version || path.resolve(job.executable).toLowerCase()!==path.resolve(executable).toLowerCase() || path.resolve(job.profileDirectory).toLowerCase()!==path.resolve(profileDirectory).toLowerCase())throw Error('更新启动信息不匹配');
 return{job,directory};
}
function acknowledgeUpdate(ticket,version){
 const file=path.join(ticket.directory,'ready.json'),temporary=file+'.tmp';
 fs.writeFileSync(temporary,JSON.stringify({id:ticket.job.id,version,pid:process.pid}));fs.renameSync(temporary,file);
}
module.exports={readUpdateTicket,acknowledgeUpdate};
