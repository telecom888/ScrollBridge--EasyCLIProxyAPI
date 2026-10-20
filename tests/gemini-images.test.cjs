const {test}=require('node:test');const assert=require('node:assert/strict');
const {isGeminiImage,imagePlan,generateImages}=require('../lib/gemini-images.cjs');
const {validateConfig}=require('../lib/config.cjs');
test('Gemini compatibility defaults off and targets only Gemini image IDs',()=>{
  assert.equal(validateConfig({}).geminiImageCompatibility,false);
  assert.throws(()=>validateConfig({geminiImageCompatibility:'true'}));
  for(const model of ['gemini-3.1-flash-image','gemini-2.5-flash-image','gemini-3-pro-image-preview'])assert.ok(isGeminiImage(model));
  for(const model of ['gpt-image-2','gemini-3-flash','other/gemini-image','gemini-image/../../private'])assert.ok(!isGeminiImage(model));
});
test('image plan maps sizes and validates unsupported or ambiguous options',()=>{
  const plan=body=>imagePlan('gemini-3.1-flash-image',{prompt:'test',...body});
  assert.deepEqual(plan({size:'1536x1024'}).payload.generationConfig.imageConfig,{aspectRatio:'3:2',imageSize:'1K'});
  assert.deepEqual(plan({size:'2048x2048'}).payload.generationConfig.imageConfig,{aspectRatio:'1:1',imageSize:'2K'});
  for(const body of [{n:5},{n:0},{n:1.5},{response_format:'url'},{size:'bad'},{quality:'high'},{stream:true},{image:'https://example.com/image.png'}])assert.throws(()=>plan(body));
  assert.throws(()=>imagePlan('gemini-image',{prompt:'test'},[],true));
});
test('multiple images issue exactly n serial upstream requests and reject text-only results',async()=>{
  let calls=0;const signal=new AbortController().signal;
  const plan=imagePlan('gemini-3.1-flash-image',{prompt:'test',n:2});
  const result=await generateImages(plan,'http://127.0.0.1:8317','',signal,async()=>{calls++;return new Response('{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"aW1hZ2U="}}]}}]}');});
  assert.equal(calls,2);assert.equal(result.data.length,2);
  await assert.rejects(generateImages({...plan,count:1},'http://127.0.0.1:8317','',signal,async()=>new Response('{"candidates":[{"content":{"parts":[{"text":"No image"}]}}]}')),/no supported final image/);
});
