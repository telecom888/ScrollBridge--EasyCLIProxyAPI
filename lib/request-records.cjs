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
 constructor(limit=200){this.sequence=0;this.limit=limit;this.clear();}
 clear(){this.slots=new Array(this.limit);this.rows=new Map();this.next=0;}
 add(record){
  const id=record.id || randomUUID(),old=this.rows.get(id);
  const row={...record,id,sequence:old?.sequence || ++this.sequence};
  if(!old){const removed=this.slots[this.next];if(removed)this.rows.delete(removed);this.slots[this.next]=id;this.next=(this.next+1)%this.limit;}
  this.rows.set(id,row);return row;
 }
 all(includeIP=true){return [...this.rows.values()].sort((a,b)=>b.sequence-a.sequence).map(row=>{if(includeIP)return row;const {requestIP:_,...safe}=row;return safe;});}
 resize(limit){if(!Number.isInteger(limit)||limit<100||limit>10000)throw Error('记录数量须为 100–10000');if(limit===this.limit)return;const keep=this.all().slice(0,limit).reverse();this.limit=limit;this.clear();for(const row of keep)this.add(row);}
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
