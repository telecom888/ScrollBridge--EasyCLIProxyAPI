const {randomUUID}=require('node:crypto');
const {isIP}=require('node:net');
function normalizeIP(value){
 if(typeof value!=='string' || value!==value.trim() || value.includes('%') || !isIP(value))throw Error('请输入有效的 IPv4 或 IPv6 地址');
 if(isIP(value)===4)return value;
 const host=new URL('http://['+value+']/').hostname.slice(1,-1).toLowerCase();
 if(host.startsWith('::ffff:')){const parts=host.slice(7).split(':');if(parts.length===2){const n=parseInt(parts[0],16)*65536+parseInt(parts[1],16);return [n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.');}}
 return host;
}
function requestIP(req){
 let peer;try{peer=normalizeIP(req.socket.remoteAddress);}catch{return '';}
 // This desktop gateway accepts only loopback peers. Cloudflare supplies the
 // visitor address through cloudflared; never take the first arbitrary XFF entry.
 if(peer==='127.0.0.1' || peer==='::1'){
  let forwarded;try{forwarded=normalizeIP(req.headers['cf-connecting-ip']);}catch{return peer;}
  if(/^2[4-9]\d\./.test(forwarded) && req.headers['cf-connecting-ipv6']){try{const ipv6=normalizeIP(req.headers['cf-connecting-ipv6']);if(isIP(ipv6)===6)return ipv6;}catch{}}
  return forwarded;
 }
 return peer;
}
class RequestRecords{
 constructor(limit=200,bodyBudget=8*1024*1024){this.sequence=0;this.limit=limit;this.bodyBudget=bodyBudget;this.clear();}
 clear(){this.slots=new Array(this.limit);this.rows=new Map();this.bodies=new Map();this.bodyBytes=0;this.next=0;}
 dropBody(id){const body=this.bodies.get(id);if(body){this.bodyBytes-=Buffer.byteLength(body.preview);this.bodies.delete(id);}}
 add(record){
  const id=record.id || randomUUID(),old=this.rows.get(id);
  const row={...record,id,sequence:old?.sequence || ++this.sequence};
  if(!old){const removed=this.slots[this.next];if(removed){this.rows.delete(removed);this.dropBody(removed);}this.slots[this.next]=id;this.next=(this.next+1)%this.limit;}
  if(record.requestBody){
   this.dropBody(id);const {preview,...meta}=record.requestBody;row.requestBody=meta;
   if(typeof preview==='string'){
    const bytes=Buffer.from(preview);let end=Math.min(bytes.length,16*1024);while(end>0&&end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    const text=bytes.subarray(0,end).toString('utf8'),size=Buffer.byteLength(text);if(end<bytes.length)meta.truncated=true;
    while(this.bodyBytes+size>this.bodyBudget&&this.bodies.size){const oldest=this.bodies.keys().next().value;this.dropBody(oldest);const evicted=this.rows.get(oldest);if(evicted)evicted.requestBody={...evicted.requestBody,state:'evicted'};}
    if(size<=this.bodyBudget){this.bodies.set(id,{...meta,preview:text});this.bodyBytes+=size;}else row.requestBody={...meta,state:'evicted'};
   }
  }
  this.rows.set(id,row);return row;
 }
 all(includeIP=true,includeBody=false){return [...this.rows.values()].sort((a,b)=>b.sequence-a.sequence).map(row=>{const safe={...row};if(!includeIP)delete safe.requestIP;if(!includeBody)delete safe.requestBody;return safe;});}
 body(id){const row=this.rows.get(id);if(!row)throw Error('记录已清空或淘汰');return this.bodies.get(id)||row.requestBody||{state:row.method==='GET'?'empty':'unavailable'};}
 resize(limit){if(!Number.isInteger(limit)||limit<100||limit>10000)throw Error('记录数量须为 100–10000');if(limit===this.limit)return;const keep=[...this.rows.values()].sort((a,b)=>b.sequence-a.sequence).slice(0,limit).reverse().map(row=>({...row,...(row.requestBody?{requestBody:this.body(row.id)}:{})}));this.limit=limit;this.clear();for(const row of keep)this.add(row);}
 get size(){return this.rows.size;}
}
const fields=[['time','时间'],['requestIP','请求IP'],['keyName','密钥'],['method','方法'],['model','模型'],['actualModel','实际模型'],['path','路径'],['status','状态'],['ms','耗时（毫秒）'],['reason','说明']];
function exportRecords(records,{format,includeIP}){
 if(!['csv','json'].includes(format))throw Error('导出格式无效');
 const columns=fields.filter(([key])=>includeIP || key!=='requestIP');
 const rows=records.map(row=>Object.fromEntries(columns.map(([key])=>[key,row[key] ?? ''])));
 if(format==='json')return JSON.stringify(rows,null,2)+'\n';
 const cell=value=>{let s=String(value);if(/^[\s\uFEFF]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
 return '\uFEFF'+[columns.map(([,label])=>cell(label)).join(','),...rows.map(row=>columns.map(([key])=>cell(row[key])).join(','))].join('\r\n')+'\r\n';
}
module.exports={RequestRecords,normalizeIP,requestIP,exportRecords};
