const { Transform } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');
function rewriteModelFields(value, actual, requested) {
  if(typeof actual!=='string' || typeof requested!=='string')return value;
  if(Array.isArray(value))return value.map(item=>rewriteModelFields(item,actual,requested));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const rename = object => {
    if (!object || typeof object !== 'object') return;
    for (const field of ['model','modelVersion']) if (typeof object[field] === 'string') object[field] = requested;
  };
  rename(value); rename(value.response); rename(value.message);
  return value;
}
function cleanEntityHeaders(headers) {
  for (const key of ['content-encoding','content-length','etag','content-md5','digest']) delete headers[key];
  return headers;
}
class ModelEvents extends Transform {
  constructor(actual,requested) { super();this.actual=actual;this.requested=requested;this.decoder=new StringDecoder('utf8');this.pending=''; }
  frame(frame) {
    const lines=frame.split(/\r\n|\r|\n/), data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,''));
    if(!data.length || data.join('\n').trim()==='[DONE]')return frame;
    let value;try{value=JSON.parse(data.join('\n'));}catch{return frame;}
    const encoded=JSON.stringify(rewriteModelFields(value,this.actual,this.requested));
    let inserted=false;
    return lines.flatMap(line=>!line.startsWith('data:')?[line]:inserted?[]:(inserted=true,[`data: ${encoded}`])).join('\n');
  }
  consume(flush=false) {
    let boundary;
    while((boundary=/\r\n\r\n|\n\n|\r\r/.exec(this.pending))) {
      if(boundary.index>32*1024*1024)throw new Error('SSE event too large');
      this.push(this.frame(this.pending.slice(0,boundary.index))+boundary[0]);
      this.pending=this.pending.slice(boundary.index+boundary[0].length);
    }
    if(this.pending.length>32*1024*1024)throw new Error('SSE event too large');
    if(flush&&this.pending){this.push(this.frame(this.pending));this.pending='';}
  }
  _transform(chunk,encoding,callback){try{this.pending+=this.decoder.write(chunk);this.consume();callback();}catch(error){callback(error);}}
  _flush(callback){try{this.pending+=this.decoder.end();this.consume(true);callback();}catch(error){callback(error);}}
}
function multipartBody(body,files) {
  const boundary=`scrollbridge-${require('node:crypto').randomBytes(18).toString('hex')}`;
  const parts=[], quote=value=>String(value).replace(/[\r\n"\\]/g,'_');
  for(const [name,value] of Object.entries(body))parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`));
  for(const file of files)parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(file.name)}"; filename="${quote(file.filename || 'image')}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`),file.data,Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return{bytes:Buffer.concat(parts),contentType:`multipart/form-data; boundary=${boundary}`};
}
module.exports={rewriteModelFields,cleanEntityHeaders,ModelEvents,multipartBody};
