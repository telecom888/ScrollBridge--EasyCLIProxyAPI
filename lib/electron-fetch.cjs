const {Readable}=require('node:stream');
// Electron net.fetch rejects redirect:'manual'. Use net.request so the updater
// can validate every redirect host while retaining Chromium's system proxy.
function electronFetch(net,url,options={}){
 return new Promise((resolve,reject)=>{
  if(options.signal?.aborted){reject(options.signal.reason);return;}
  const request=net.request({url,method:'GET',redirect:'manual',useSessionCookies:false});
  let response,settled=false;
  const abort=()=>{const error=options.signal.reason || Error('Request aborted');response?.destroy(error);request.abort();if(!settled)reject(error);};
  const cleanup=()=>options.signal?.removeEventListener('abort',abort);
  options.signal?.addEventListener('abort',abort,{once:true});
  request.once('close',cleanup);
  request.on('error',error=>{if(!settled){settled=true;cleanup();reject(error);}});
  const headers=values=>{const result=new Headers();for(const [name,value]of Object.entries(values))for(const item of Array.isArray(value)?value:[value])result.append(name,String(item));return result;};
  request.once('redirect',(status,_method,_url,values)=>{
   settled=true;cleanup();resolve(new Response(null,{status,headers:headers(values)}));request.abort();
  });
  request.once('response',incoming=>{
   response=incoming;settled=true;
   incoming.once('end',cleanup);incoming.once('error',cleanup);
   incoming.once('close',()=>request.abort());
   const empty=[204,205,304].includes(incoming.statusCode);
   if(empty)incoming.resume();
   resolve(new Response(empty?null:Readable.toWeb(incoming),{status:incoming.statusCode,headers:headers(incoming.headers)}));
  });
  for(const [name,value]of new Headers(options.headers))request.setHeader(name,value);
  request.end();
 });
}
module.exports={electronFetch};
