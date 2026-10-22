const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{once}=require('node:events');
const {validateConfig,createAccessKey}=require('../lib/config.cjs');
const {isSpeechRequest}=require('../lib/models.cjs');
const {newKey,syncModels}=require('../lib/policy.cjs');
const {toGoConfig}=require('../lib/go-gateway.cjs');
const {startGateway}=require('../lib/gateway.cjs');

test('speech gate defaults off, validates strictly and reaches the Go policy',()=>{
 assert.equal(validateConfig({}).speechEnabled,false);
 for(const value of ['true',1,null])assert.throws(()=>validateConfig({speechEnabled:value}),/语音接口/);
 assert.equal(toGoConfig(validateConfig({speechEnabled:true}),{keyValues:{}}).speech,true);
});
test('speech recognition uses family keywords and audio output fields, not complete model IDs',()=>{
 for(const name of ['vendor/MiMo-Future-TTS','vendor/Gemini-Future-TTS','MiniMax/speech-next','seed-tts-future','qwen-next-tts'])assert.equal(isSpeechRequest(name),true);
 for(const body of [{audio:{voice:'v'}},{generationConfig:{responseModalities:['AUDIO']}},{generation_config:{response_modalities:['audio']}},{response:{modalities:['audio']}},{response_format:{type:'audio'}}])assert.equal(isSpeechRequest('unbranded',body),true);
 assert.equal(isSpeechRequest('text-model',{messages:[{content:[{type:'input_audio'}]}]}),false);
});
test('legacy Node gateway preserves standard binary speech and shares the live gate and aliases',async t=>{
 let calls=0;
 const up=http.createServer(async(req,res)=>{calls++;const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));assert.equal(body.model,'custom-tts');assert.equal(req.headers.authorization,'Bearer synthetic-upstream');res.writeHead(200,{'content-type':'audio/mpeg'});res.end(Buffer.from([0,1,2,3,255]));});
 up.listen(0,'127.0.0.1');await once(up,'listening');t.after(()=>{up.closeAllConnections();return new Promise(r=>up.close(r));});
 const listener=http.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const key=newKey(),value=createAccessKey(),secrets={keyValues:{[key.id]:value},upstreamKey:'synthetic-upstream',tunnelToken:''};
 let config=syncModels(validateConfig({upstream:`http://127.0.0.1:${up.address().port}`,port,accessKeys:[key]}),['custom-tts']);config.modelRules[0].aliases=[{id:'speech-exposed',name:'voice-alias'}];config=validateConfig(config);
 const gateway=await startGateway(config,secrets,()=>{},{getConfig:()=>config});t.after(()=>gateway.close());
 const request=()=>fetch(`http://127.0.0.1:${port}/v1/audio/speech`,{method:'POST',headers:{authorization:'Bearer '+value,'content-type':'application/json'},body:JSON.stringify({model:'voice-alias',input:'hello',voice:'v'})});
 assert.equal((await request()).status,404);assert.equal(calls,0);
 config=validateConfig({...config,speechEnabled:true});const response=await request();assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from([0,1,2,3,255]));
 config=validateConfig({...config,speechEnabled:false});assert.equal((await request()).status,404);assert.equal(calls,1);
});
