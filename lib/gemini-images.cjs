const Busboy = require('busboy');
const MAX_UPLOAD = 32 * 1024 * 1024;
const MAX_RESULT = 64 * 1024 * 1024;
const isGeminiImage = model => /^gemini-[a-z0-9.-]*image[a-z0-9.-]*$/i.test(model);
function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }

function parseImageMultipart(bytes, contentType) {
  return new Promise((resolve, reject) => {
    const body = Object.create(null), files = []; let bad = false;
    const parser = Busboy({ headers: { 'content-type': contentType }, limits: { fieldSize: MAX_UPLOAD, fields: 128, files: 32, parts: 160 } });
    parser.on('field', (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated || Object.hasOwn(body, name)) bad = true;
      body[name] = value;
    });
    parser.on('file', (name, file, info) => {
      if (name === 'model') bad = true;
      const chunks = [];
      file.on('data', chunk => chunks.push(chunk)); file.on('error', reject);
      file.on('end', () => files.push({ name, mimeType: info.mimeType, data: Buffer.concat(chunks) }));
    });
    for (const event of ['partsLimit', 'filesLimit', 'fieldsLimit']) parser.on(event, () => { bad = true; });
    parser.on('error', reject);
    parser.on('close', () => bad ? reject(invalid('Invalid or duplicate multipart fields')) : resolve({ body, files }));
    parser.end(bytes);
  });
}
function inlineImage(value) {
  if (typeof value !== 'string') throw invalid('Reference images must be base64 data URLs');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw invalid('Reference images must be PNG, JPEG or WebP base64 data URLs; remote URLs are not supported');
  return { inlineData: { mimeType: match[1], data: match[2] } };
}
function imageConfig(size) {
  if (!size || String(size).toLowerCase() === 'auto') return {};
  if (/^(?:1K|2K|4K|512)$/i.test(size)) return { imageSize: String(size).toUpperCase() };
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(size);
  if (!match) throw invalid('Use auto, 1K, 2K, 4K or WIDTHxHEIGHT for Gemini image size');
  const width = Number(match[1]), height = Number(match[2]);
  if (Math.min(width, height) < 256 || Math.max(width, height) > 8192) throw invalid('Image dimensions are outside the supported range');
  const ratios = ['1:1','1:4','1:8','2:3','3:2','3:4','4:1','4:3','4:5','5:4','8:1','9:16','16:9','21:9'];
  const aspectRatio = ratios.find(ratio => { const [a,b]=ratio.split(':').map(Number); return Math.abs(width/height-a/b)/(a/b)<0.025; });
  if (!aspectRatio) throw invalid('This aspect ratio is not supported by Gemini images');
  const scale = Math.sqrt(width * height);
  return { aspectRatio, imageSize: scale > 3000 ? '4K' : scale > 1500 ? '2K' : '1K' };
}
function imagePlan(model, body, files = [], editing = false) {
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw invalid('A prompt is required');
  const count = body.n === undefined ? 1 : Number(body.n);
  if (!Number.isInteger(count) || count < 1 || count > 4) throw invalid('Gemini image compatibility supports 1 to 4 images per request');
  if (body.response_format && body.response_format !== 'b64_json') throw invalid('Gemini image compatibility returns b64_json; remove response_format or set it to b64_json');
  if (body.stream === true || body.stream === 'true') throw invalid('Streaming is not supported by Gemini image compatibility');
  for (const key of ['mask','quality','background','output_format','output_compression','input_fidelity','partial_images']) {
    if (body[key] !== undefined && body[key] !== 'auto') throw invalid(`Gemini image compatibility does not support ${key}`);
  }
  const parts = [{ text: body.prompt }];
  for (const file of files) {
    if (!['image','image[]'].includes(file.name)) throw invalid('Only reference image uploads are supported; masks are not supported');
    if (!['image/png','image/jpeg','image/webp'].includes(file.mimeType) || !file.data.length) throw invalid('Reference images must be nonempty PNG, JPEG or WebP files');
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data.toString('base64') } });
  }
  if (body.image !== undefined) for (const value of Array.isArray(body.image) ? body.image : [body.image]) parts.push(inlineImage(value));
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) throw invalid('images must be an array');
    for (const image of body.images) parts.push(inlineImage(typeof image === 'string' ? image : image?.image_url));
  }
  if (editing && parts.length === 1) throw invalid('At least one reference image is required for image edits');
  if (parts.length > 15) throw invalid('At most 14 reference images are supported');
  const config = imageConfig(body.size);
  if (/^gemini-2\.5-/i.test(model)) delete config.imageSize;
  return { model, count, payload: { contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT','IMAGE'], ...(Object.keys(config).length ? { imageConfig: config } : {}) } } };
}
async function boundedJSON(response) {
  if (!response.body) throw invalid('Empty upstream image response', 502);
  const reader=response.body.getReader(), chunks=[]; let size=0;
  try {
    while (true) { const { value,done }=await reader.read(); if (done) break; size+=value.byteLength; if(size>MAX_RESULT) throw invalid('Upstream image response exceeds 64 MiB',502); chunks.push(Buffer.from(value)); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid('Invalid upstream image response',502); }
  } finally { await reader.cancel().catch(()=>{}); }
}
async function generateImages(plan, upstream, upstreamKey, signal, fetcher = fetch) {
  const data=[]; let total=0;
  for(let index=0;index<plan.count;index++) {
    if (signal.aborted) throw invalid('Image request cancelled',499);
    const response=await fetcher(new URL(`/v1beta/models/${encodeURIComponent(plan.model)}:generateContent`,upstream),{
      method:'POST',redirect:'error',headers:{'content-type':'application/json',...(upstreamKey?{authorization:`Bearer ${upstreamKey}`}:{})},
      body:JSON.stringify(plan.payload),signal:AbortSignal.any([signal,AbortSignal.timeout(600000)])
    });
    const result=await boundedJSON(response);
    if (!response.ok) throw invalid(typeof result.error?.message==='string'?result.error.message:`Upstream image service returned HTTP ${response.status}`,response.status);
    const parts=(result.candidates || []).flatMap(candidate=>candidate.content?.parts || []);
    // Thought images are intermediate artifacts, not final generated output.
    const image=parts.find(part=>!part.thought&&(part.inlineData || part.inline_data)?.data);
    const inline=image?.inlineData || image?.inline_data;
    const mime=inline?.mimeType || inline?.mime_type;
    if(!inline || !['image/png','image/jpeg','image/webp'].includes(mime) || !/^[A-Za-z0-9+/]+={0,2}$/.test(inline.data)) throw invalid('Gemini returned no supported final image; the request may have been blocked',502);
    total+=inline.data.length;
    if(total>MAX_RESULT)throw invalid('Combined image result exceeds 64 MiB; request fewer images',502);
    data.push({b64_json:inline.data,output_format:mime.split('/')[1]});
  }
  return {created:Math.floor(Date.now()/1000),data};
}
module.exports={isGeminiImage,parseImageMultipart,imagePlan,generateImages};
