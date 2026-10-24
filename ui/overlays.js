// Keep native dialog focus trapping and top-layer semantics; animate before close.
const overlayStates=new WeakMap();
function overlayState(dialog){
 let state=overlayStates.get(dialog);if(state)return state;
 const content=document.createElement('div');content.className='overlay-content';content.append(...dialog.childNodes);dialog.append(content);
 state={phase:'closed',generation:0,animations:[],content,height:0};overlayStates.set(dialog,state);
 dialog.addEventListener('cancel',event=>{if(event.defaultPrevented)return;event.preventDefault();closeDialog(dialog);});
 for(const type of ['click','submit','keydown'])dialog.addEventListener(type,event=>{if(state.phase==='closing'){event.preventDefault();event.stopImmediatePropagation();}},true);
 state.observer=new ResizeObserver(()=>{
  if(!dialog.open||state.phase==='closing'||state.phase==='closed')return;
  const from=state.resize?dialog.getBoundingClientRect().height:state.height;
  state.resize?.cancel();state.resize=null;
  const to=dialog.getBoundingClientRect().height;state.height=to;
  if(!from||Math.abs(from-to)<1||motionPreference.matches)return;
  const resize=dialog.animate([{height:from+'px'},{height:to+'px'}],{duration:220,easing:'cubic-bezier(.2,.8,.2,1)'});state.resize=resize;
  resize.finished.then(()=>{if(state.resize===resize)state.resize=null;}).catch(()=>{});
 });
 return state;
}
function overlaySample(dialog){
 const style=getComputedStyle(dialog);
 return{opacity:style.opacity,transform:style.transform==='none'?'translateY(0px) scale(1)':style.transform,shade:getComputedStyle(dialog).getPropertyValue('--overlay-shade').trim()||'1'};
}
function cancelOverlay(state){for(const animation of state.animations)animation.cancel();state.animations=[];}
function overlayAnimations(dialog,state,frames,shade,duration){
 const animations=[dialog.animate(frames,{duration,fill:'both'}),dialog.animate([{'--overlay-shade':shade[0]},{'--overlay-shade':shade[1]}],{duration:Math.min(duration,180),easing:'cubic-bezier(.2,.7,.2,1)',fill:'both'})];
 state.animations=animations;return Promise.all(animations.map(animation=>animation.finished.catch(()=>{})));
}
function openDialog(dialog){
 const state=overlayState(dialog);
 if(dialog.open&&state.phase!=='closing')return;
 const reopening=dialog.open,from=reopening?overlaySample(dialog):null;
 ++state.generation;cancelOverlay(state);
 if(!reopening){dialog.returnValue='';dialog.style.setProperty('--overlay-shade','0');dialog.showModal();}
 state.phase='opening';dialog.dataset.overlayPhase='opening';state.height=dialog.getBoundingClientRect().height;state.observer.observe(state.content);
 const generation=state.generation,large=dialog.classList.contains('management-dialog')||dialog.id==='request-body-dialog';
 const done=()=>{if(generation!==state.generation)return;state.phase='open';dialog.dataset.overlayPhase='open';dialog.style.setProperty('--overlay-shade','1');cancelOverlay(state);};
 if(motionPreference.matches){done();return;}
 const frames=[
  {...(from?{opacity:from.opacity,transform:from.transform}:{opacity:0,transform:`translateY(${large?14:8}px) scale(1)`}),offset:0,easing:'cubic-bezier(.16,1,.3,1)'},
  {opacity:1,transform:'translateY(0px) scale(1)',offset:.74,easing:'cubic-bezier(.4,0,.2,1)'},
  {opacity:1,transform:'translateY(0px) scale(1)',offset:1}
 ];
 void overlayAnimations(dialog,state,frames,[from?.shade||'0','1'],large?280:190).then(done);
}
function closeDialog(dialog,value){
 const state=overlayStates.get(dialog);
 if(!state||!dialog.open){if(dialog.open)dialog.close(value);return Promise.resolve(true);}
 if(state.phase==='closing')return state.closing;
 const from=overlaySample(dialog),generation=++state.generation;
 cancelOverlay(state);state.resize?.cancel();state.resize=null;state.observer.disconnect();
 state.phase='closing';dialog.dataset.overlayPhase='closing';
 const done=()=>{
  if(generation!==state.generation)return false;
  dialog.close(value);state.phase='closed';delete dialog.dataset.overlayPhase;cancelOverlay(state);dialog.style.removeProperty('--overlay-shade');return true;
 };
 if(motionPreference.matches)return Promise.resolve(done());
 const matrix=new DOMMatrix(from.transform.startsWith('matrix')?from.transform:undefined);
 // A mid-opening close continues down and contracts from the visible size.
 const to=matrix.translate(0,6).scale(.98).toString();
 state.closing=overlayAnimations(dialog,state,[{opacity:from.opacity,transform:from.transform,easing:'cubic-bezier(.4,0,1,1)'},{opacity:0,transform:to}],[from.shade,'0'],dialog.classList.contains('management-dialog')||dialog.id==='request-body-dialog'?180:140).then(done);
 return state.closing;
}
function positionPopoverOrigin(menu,rect){
 const left=parseFloat(menu.style.left)||0,top=parseFloat(menu.style.top)||0;
 menu.style.transformOrigin=`${Math.max(12,Math.min((rect.left+rect.right)/2-left,menu.offsetWidth-12))}px ${top>=rect.bottom?'top':'bottom'}`;
}
function confirmDialog({title,message,accept='确认'}){
 const dialog=document.getElementById('confirm-action-dialog');if(dialog.open)return Promise.resolve(false);
 document.getElementById('confirm-action-title').textContent=title;document.getElementById('confirm-action-message').textContent=message;document.getElementById('confirm-action-accept').textContent=accept;
 document.getElementById('confirm-action-cancel').onclick=()=>closeDialog(dialog,'cancel');document.getElementById('confirm-action-accept').onclick=()=>closeDialog(dialog,'confirm');
 const result=new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}));openDialog(dialog);return result;
}
