const http=require('node:http');
const crypto=require('node:crypto');
const {once}=require('node:events');
const MAX_BYTES=4<<20;
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||!b)return false;return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(),crypto.createHash('sha256').update(b).digest());}
function textParts(input){
 if(typeof input==='string')return input;
 if(!Array.isArray(input))throw Error('仅支持文本消息');
 return input.map(p=>{if(typeof p==='string')return p;if(p&&typeof p.text==='string'&&(!p.type||p.type==='text'))return p.text;throw Error('该托管适配器暂不支持非文本内容');}).join('');
}
function normalize(body,format){
 if(body.tools||body.tool_choice||body.functions||body.function_call)throw Error('跨协议工具调用暂不支持');
 const messages=[],sys=[];
 if(format==='openai'){
   if(!Array.isArray(body.messages))throw Error('缺少 messages');
   for(const m of body.messages){if(m.tool_calls||m.tool_call_id)throw Error('工具消息暂不支持');const value=textParts(m.content);if(['system','developer'].includes(m.role))sys.push(value);else if(['user','assistant'].includes(m.role))messages.push({role:m.role,text:value});else throw Error('不支持的消息角色');}
 }else if(format==='anthropic'){
   if(body.system)sys.push(textParts(body.system));if(!Array.isArray(body.messages))throw Error('缺少 messages');
   for(const m of body.messages){if(!['user','assistant'].includes(m.role))throw Error('不支持的消息角色');messages.push({role:m.role,text:textParts(m.content)});}
 }else{
   if(body.systemInstruction?.parts)sys.push(textParts(body.systemInstruction.parts));
   if(!Array.isArray(body.contents))throw Error('缺少 contents');
   for(const m of body.contents){if(!['user','model'].includes(m.role))throw Error('不支持的消息角色');messages.push({role:m.role==='model'?'assistant':'user',text:textParts(m.parts)});}
 }
 if(!messages.length)throw Error('消息不能为空');
 return {messages,system:sys.filter(Boolean).join('\n')};
}
function build(provider,model,incoming,body,stream){
 const proto=provider.protocol, dest=proto==='vertex'?'google':proto;
 const same=dest===incoming;
 let payload=body;
 if(!same){
   const n=normalize(body,incoming),max=body.max_tokens??body.max_completion_tokens??body.generationConfig?.maxOutputTokens,
     temperature=body.temperature??body.generationConfig?.temperature;
   if(dest==='openai'){
     payload={model,messages:[...(n.system?[{role:'system',content:n.system}]:[]),...n.messages.map(m=>({role:m.role,content:m.text}))],stream};
     if(max!==undefined)payload.max_tokens=max;if(temperature!==undefined)payload.temperature=temperature;
   }else if(dest==='anthropic'){
     payload={model,max_tokens:max??1024,messages:n.messages.map(m=>({role:m.role,content:m.text})),stream};
     if(n.system)payload.system=n.system;if(temperature!==undefined)payload.temperature=temperature;
   }else{
     payload={contents:n.messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.text}]}))};
     if(n.system)payload.systemInstruction={parts:[{text:n.system}]};
     if(max!==undefined||temperature!==undefined){payload.generationConfig={};if(max!==undefined)payload.generationConfig.maxOutputTokens=max;if(temperature!==undefined)payload.generationConfig.temperature=temperature;}
   }
 }else if(incoming==='openai'||incoming==='anthropic'){payload={...body,model};}
 const url=new URL(provider.baseUrl);
 if(proto==='openai')url.pathname='/v1/chat/completions';
 else if(proto==='anthropic')url.pathname='/v1/messages';
 else{
   url.pathname=proto==='vertex'?'/v1/projects/'+encodeURIComponent(provider.projectId)+'/locations/'+encodeURIComponent(provider.location)+'/publishers/google/models/'+encodeURIComponent(model)+':'+(stream?'streamGenerateContent':'generateContent')
     :'/v1beta/models/'+encodeURIComponent(model)+':'+(stream?'streamGenerateContent':'generateContent');
   if(stream)url.searchParams.set('alt','sse');
 }
 return {url,payload,same,dest};
}
function contentOf(v,proto){
 if(proto==='openai')return v?.choices?.[0]?.message?.content||'';
 if(proto==='anthropic')return (v?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
 return (v?.candidates?.[0]?.content?.parts||[]).filter(x=>typeof x.text==='string').map(x=>x.text).join('');
}
function convertResponse(v,from,to,model){
 if(from===to)return v;
 const text=contentOf(v,from);
 const usage=from==='openai'?{input:v?.usage?.prompt_tokens||0,output:v?.usage?.completion_tokens||0}:from==='anthropic'?{input:v?.usage?.input_tokens||0,output:v?.usage?.output_tokens||0}:{input:v?.usageMetadata?.promptTokenCount||0,output:v?.usageMetadata?.candidatesTokenCount||0};
 if(to==='openai')return {id:'chatcmpl-scrollbridge',object:'chat.completion',created:Math.floor(Date.now()/1000),model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:usage.input,completion_tokens:usage.output,total_tokens:usage.input+usage.output}};
 if(to==='anthropic')return {id:'msg_scrollbridge',type:'message',role:'assistant',model,content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:usage.input,output_tokens:usage.output}};
 return {candidates:[{content:{role:'model',parts:[{text}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:usage.input,candidatesTokenCount:usage.output,totalTokenCount:usage.input+usage.output}};
}
function frame(to,model,text,kind){
 if(to==='openai'){
   if(kind==='end')return 'data: [DONE]\n\n';
   return 'data: '+JSON.stringify({id:'chatcmpl-scrollbridge',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model,choices:[{index:0,delta:kind==='start'?{role:'assistant'}:{content:text},finish_reason:null}]})+'\n\n';
 }
 if(to==='anthropic'){
   if(kind==='start')return 'event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{type:'message',role:'assistant',model,id:'msg_scrollbridge',content:[],usage:{input_tokens:0,output_tokens:0}}})+'\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
   if(kind==='end')return 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
   return 'event: content_block_delta\ndata: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text}})+'\n\n';
 }
 if(kind!=='data')return '';
 return 'data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text}]}}]})+'\n\n';
}
function sseDelta(v,from){
 if(from==='openai')return v?.choices?.[0]?.delta?.content||'';
 if(from==='anthropic')return v?.type==='content_block_delta'&&v?.delta?.type==='text_delta'?v.delta.text||'':'';
 return (v?.candidates?.[0]?.content?.parts||[]).filter(p=>typeof p.text==='string').map(p=>p.text).join('');
}
async function transferStream(response,res,from,to,model){
 res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'});
 if(from!==to)res.write(frame(to,model,'','start'));
 const decoder=new TextDecoder();let pending='',lastText='';
 for await(const chunk of response.body){
   pending+=decoder.decode(chunk,{stream:true});
   if(pending.length>1024*1024)throw Error('上游事件过大');
   while(true){
     const unix=pending.indexOf('\n\n'),dos=pending.indexOf('\r\n\r\n');
     if(unix<0&&dos<0)break;
     const pos=unix<0?dos:dos<0?unix:Math.min(unix,dos),len=pos===dos?4:2;
     const chunk=pending.slice(0,pos);pending=pending.slice(pos+len);
     if(from===to){if(!res.write(chunk+'\n\n'))await once(res,'drain');continue;}
     const txt=chunk.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
     if(!txt||txt==='[DONE]')continue;
     let v;try{v=JSON.parse(txt);}catch{continue;}
     let delta=sseDelta(v,from);
     if(from==='google'){
       // Gemini streaming chunks generally contain deltas; avoid assuming a cumulative format.
       if(delta===lastText)continue;
       lastText=delta;
     }
     if(delta&&!res.write(frame(to,model,delta,'data')))await once(res,'drain');
   }
 }
 res.end(from===to?'':frame(to,model,'','end'));
}
async function startHostedBridge({getConfig,getSecrets,token,fetcher=fetch}){
 if(!token)throw Error('本地托管桥接凭证缺失');
 const server=http.createServer(async(req,res)=>{
   res.setHeader('Cache-Control','no-store');
   const id=typeof req.headers['x-scrollbridge-hosting-provider']==='string'?req.headers['x-scrollbridge-hosting-provider']:'';
   const provider=getConfig().hostingProviders.find(p=>p.id===id);
   const bearer=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
   if(!provider||!provider.enabled||!equal(bearer,token)){res.writeHead(401);res.end();return;}
   try{
     if(req.method!=='POST'){res.writeHead(405);res.end();return;}
     const chunks=[];let n=0;
     for await(const chunk of req){n+=chunk.length;if(n>MAX_BYTES)throw Error('请求体过大');chunks.push(chunk);}
     const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     const route=new URL(req.url,'http://127.0.0.1').pathname;
     let incoming,stream;
     if(route==='/v1/chat/completions'){incoming='openai';stream=body.stream===true;}
     else if(route==='/v1/messages'){incoming='anthropic';stream=body.stream===true;}
     else if(/^\/v1beta\/models\/[^/]+:(generateContent|streamGenerateContent)$/.test(route)){incoming='google';stream=route.endsWith(':streamGenerateContent');}
     else{res.writeHead(501,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'该托管接口尚不支持'}}));return;}
     const model=typeof body.model==='string'?body.model:decodeURIComponent(route.match(/^\/v1beta\/models\/([^:]+):/)?.[1]||'');
     if(!/^[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,127}$/.test(model))throw Error('模型 ID 无效');
     const plan=build(provider,model,incoming,body,stream);
     const key=getSecrets().hostingKeys?.[id];
     if(!key){res.writeHead(503);res.end();return;}
     const headers={'content-type':'application/json','accept':stream?'text/event-stream':'application/json'};
     if(provider.protocol==='openai')headers.authorization='Bearer '+key;
     if(provider.protocol==='anthropic'){headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';}
     if(['google','vertex'].includes(provider.protocol))headers['x-goog-api-key']=key;
     const abort=new AbortController();
     res.on('close',()=>{if(!res.writableEnded)abort.abort();});
     const upstream=await fetcher(plan.url.toString(),{method:'POST',headers,body:JSON.stringify(plan.payload),redirect:'error',signal:abort.signal});
     if(!upstream.ok){res.writeHead(upstream.status,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'上游请求失败：HTTP '+upstream.status}}));return;}
     if(stream)await transferStream(upstream,res,plan.dest,incoming,model);
     else {
       const data=await upstream.json();
       res.writeHead(200,{'content-type':'application/json'});
       res.end(JSON.stringify(convertResponse(data,plan.dest,incoming,model)));
     }
   }catch(err){
     if(res.headersSent){res.destroy();return;}
     const known=/不支持|仅支持|无效|缺少|不能为空|过大|消息/.test(err.message||'');
     res.writeHead(known?400:502,{'content-type':'application/json'});
     res.end(JSON.stringify({error:{message:known?err.message:'托管上游请求失败'}}));
   }
 });
 server.maxConnections=256;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
module.exports={startHostedBridge,build,normalize,convertResponse};