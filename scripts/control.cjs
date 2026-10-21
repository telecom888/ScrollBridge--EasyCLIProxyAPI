// Local client for model agents. Credentials are read from the current user's
// runtime descriptor and never accepted as command-line arguments.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
async function main(){
  const [method,route,bodyFlag]=process.argv.slice(2);
  if(!method || !route || !['GET','POST','PUT','PATCH','DELETE'].includes(method) || !route.startsWith('/') || route.startsWith('//') || (bodyFlag && bodyFlag!=='--stdin')){
    console.log(JSON.stringify({ok:false,error:{code:'USAGE',message:'node scripts/control.cjs GET /schema | POST /connection/start | PATCH /config --stdin（JSON 从标准输入读取）'}}));process.exitCode=2;return;
  }
  const filename=process.env.SCROLLBRIDGE_DISCOVERY || path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'ScrollBridge','management.json');
  let discovery;
  try{discovery=JSON.parse(fs.readFileSync(filename,'utf8'));}catch{throw Error('未找到本机管理入口，请先启动支持管理 API 的卷桥桌面程序');}
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(discovery.baseUrl) || typeof discovery.token!=='string')throw Error('本机管理入口格式无效');
  let body;
  if(bodyFlag){const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw Error('JSON 输入上限为 1 MiB');chunks.push(chunk);}body=Buffer.concat(chunks).toString('utf8');JSON.parse(body);}
  const url=new URL('/api/v1'+route,discovery.baseUrl);
  if(url.origin!==discovery.baseUrl || !url.pathname.startsWith('/api/v1/'))throw Error('接口路径无效');
  const response=await fetch(url,{method,headers:{authorization:`Bearer ${discovery.token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body}:{}),signal:AbortSignal.timeout(75000),redirect:'error'});
  const result=await response.json();console.log(JSON.stringify(result));if(!response.ok)process.exitCode=1;
}
main().catch(()=>{console.log(JSON.stringify({ok:false,error:{code:'CLIENT_ERROR',message:'调用失败，请确认卷桥已启动、路径及 JSON 输入正确，并通过 /schema 查询接口说明'}}));process.exitCode=1;});
