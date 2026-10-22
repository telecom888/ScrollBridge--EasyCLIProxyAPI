const path=require('node:path');
// Keep Electron's existing default registration name. Tests use their own name.
function createStartup({app,executable,platform=process.platform,name}){
 const options={path:executable,args:[],...(name?{name}:{})};
 let state={supported:platform==='win32',enabled:null,registered:null,disabledBySystem:false,error:''};
 function read(){
  if(!state.supported)throw Error('当前系统不支持开机启动');
  const settings=app.getLoginItemSettings({path:executable,args:[]});
  const samePath=value=>path.win32.resolve(value).toLowerCase()===path.win32.resolve(executable).toLowerCase();
  const items=(settings.launchItems || []).filter(item=>item.scope==='user' && (!name || item.name===name) && samePath(item.path) && item.args.length===0);
  const registered=items.length>0,enabled=items.some(item=>item.enabled);
  return {supported:true,enabled,registered,disabledBySystem:registered && !enabled,error:''};
 }
 const snapshot=()=>({...state});
 function refresh(){try{state=read();}catch{state={...state,enabled:null,registered:null,disabledBySystem:false,error:state.supported?'无法读取 Windows 启动项，请检查系统权限':'当前系统不支持开机启动'};}return snapshot();}
 function write(registered,enabled){app.setLoginItemSettings({...options,openAtLogin:registered,enabled});}
 function change(enabled,persist){
  if(typeof enabled!=='boolean')throw Error('开机启动设置无效');
  let previous;
  try{previous=read();}catch{refresh();throw Error(state.error);}
  try{
   write(enabled,enabled);state=read();
   if(state.enabled!==enabled || state.registered!==enabled)throw Error('Windows 未应用开机启动设置');
   persist();
  }catch(error){
   let restored=true;
   try{write(previous.registered,previous.enabled);state=read();restored=state.enabled===previous.enabled && state.registered===previous.registered;}catch{refresh();restored=false;}
   throw Error('开机启动设置未保存：'+error.message+(restored?'':'；启动项恢复失败，请检查 Windows 启动设置'));
  }
  return snapshot();
 }
 return {snapshot,refresh,change};
}
module.exports={createStartup};
