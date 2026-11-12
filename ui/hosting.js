let hostingSelection=null, hostingCandidates=[], hostingChosen=new Set(), hostingEditing=false;
const hostingDefaults={openai:'https://api.openai.com',anthropic:'https://api.anthropic.com',google:'https://generativelanguage.googleapis.com',vertex:'https://aiplatform.googleapis.com'};
function hostingCurrent(){return snapshot?.config.hostingProviders.find(p=>p.id===hostingSelection);}
function resetHostingForm(p){
  hostingEditing=!!p;
  $('hosting-title').textContent=p?'编辑密钥':'添加密钥';
  $('hosting-name').value=p?.name||'';
  $('hosting-protocol').value=p?.protocol||'openai';
  $('hosting-url').value=p?.baseUrl||hostingDefaults[$('hosting-protocol').value];
  $('hosting-project').value=p?.projectId||'';
  $('hosting-location').value=p?.location||'global';
  $('hosting-key').value='';$('hosting-key').type='password';
  $('hosting-key').placeholder=p?'已保存，留空则不更换':'输入上游 API Key';
  $('hosting-enabled').checked=p?.enabled??true;
  $('hosting-vertex-fields').hidden=$('hosting-protocol').value!=='vertex';
  $('hosting-model-area').hidden=!p;
  $('hosting-delete').hidden=!p;
  $('hosting-reveal').hidden=!p;
  $('hosting-copy').hidden=!p;
  hostingCandidates=[]; hostingChosen.clear();
  renderHostingCandidates();
}
function renderHosting(){
  if(!snapshot)return;
  const list=$('hosting-list'), current=hostingCurrent();
  list.replaceChildren();
  if(!snapshot.config.hostingProviders.length){
    const empty=document.createElement('div');empty.className='empty';empty.textContent='尚未添加托管密钥';list.append(empty);
  }
  for(const p of snapshot.config.hostingProviders){
    const b=document.createElement('button');b.className='hosting-account'+(p.id===hostingSelection?' active':'');
    const img=document.createElement('img');img.alt='';img.src='brands/'+(p.protocol==='vertex'?'google':p.protocol)+'.svg';
    const box=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');
    name.textContent=p.name;detail.textContent=p.protocol==='vertex'?'Vertex AI':p.protocol==='google'?'Google':p.protocol==='openai'?'OpenAI':'Anthropic';
    box.append(name,detail);b.append(img,box);if(p.enabled){const mark=document.createElement('span');mark.className='account-state';mark.textContent='已启用';b.append(mark);}
    b.onclick=()=>{hostingSelection=p.id;resetHostingForm(p);renderHosting();};list.append(b);
  }
  if(hostingSelection && !current){hostingSelection=null;resetHostingForm(null);}
  if(!hostingEditing && !hostingSelection && snapshot.config.hostingProviders.length)$('hosting-model-area').hidden=true;
  if(current){
    const added=$('hosting-added-models');added.replaceChildren();
    for(const m of snapshot.config.hostingModels.filter(m=>m.providerId===current.id)){
      const row=document.createElement('div');row.className='hosting-added-row';
      const name=document.createElement('code');name.textContent=m.modelId;const remove=document.createElement('button');remove.className='secondary';remove.textContent='移除';
      remove.onclick=()=>task(remove,async()=>{render(await call('removeHostingModel',{id:m.id}));});
      row.append(name,remove);added.append(row);
    }
  }
}
function renderHostingCandidates(){
 const el=$('hosting-model-candidates');el.replaceChildren();
 const search=$('hosting-model-search').value.trim().toLowerCase();
 for(const name of hostingCandidates.filter(m=>m.toLowerCase().includes(search))){
   const l=document.createElement('label');l.className='hosting-model-option';
   const c=document.createElement('input');c.type='checkbox';c.value=name;c.checked=hostingChosen.has(name);
   c.onchange=()=>{if(c.checked)hostingChosen.add(name);else hostingChosen.delete(name);$('hosting-add-selected').hidden=!hostingChosen.size;};
   const text=document.createElement('span');text.textContent=name;l.append(c,text);el.append(l);
 }
 $('hosting-add-selected').hidden=!hostingChosen.size;
}
function initHosting(){
 $('hosting-add').onclick=()=>{hostingSelection=null;resetHostingForm(null);renderHosting();$('hosting-name').focus();};
 $('hosting-protocol').onchange=()=>{$('hosting-vertex-fields').hidden=$('hosting-protocol').value!=='vertex';$('hosting-url').value=hostingDefaults[$('hosting-protocol').value];};
 $('hosting-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{
   const payload={id:hostingSelection,name:$('hosting-name').value,protocol:$('hosting-protocol').value,baseUrl:$('hosting-url').value,
     projectId:$('hosting-project').value,location:$('hosting-location').value,enabled:$('hosting-enabled').checked,key:$('hosting-key').value};
   const result=await call('saveHostingProvider',payload);hostingSelection=result.providerId;resetHostingForm({id:result.providerId,...payload});render(await call('snapshot'));toast('密钥已保存');
 });};
 $('hosting-delete').onclick=()=>task($('hosting-delete'),async()=>{
   if(!await confirmDialog({title:'删除托管密钥？',message:'将同时移除该密钥关联的模型。',accept:'确认删除'}))return;
   await call('deleteHostingProvider',{id:hostingSelection});hostingSelection=null;resetHostingForm(null);render(await call('snapshot'));
 });
 $('hosting-reveal').onclick=()=>task($('hosting-reveal'),async()=>{const v=await call('revealHostingKey',{id:hostingSelection});$('hosting-key').value=v.value;$('hosting-key').type='text';});
 $('hosting-copy').onclick=()=>task($('hosting-copy'),async()=>{await call('copyHostingKey',{id:hostingSelection});toast('密钥已复制');});
 $('hosting-refresh').onclick=()=>task($('hosting-refresh'),async()=>{
   hostingCandidates=await call('fetchHostingModels',{id:hostingSelection});hostingChosen.clear();renderHostingCandidates();toast('模型列表已更新');
 });
 $('hosting-model-search').oninput=renderHostingCandidates;
 $('hosting-add-selected').onclick=()=>task($('hosting-add-selected'),async()=>{
   await call('addHostingModels',{providerId:hostingSelection,models:[...hostingChosen]});hostingChosen.clear();renderHostingCandidates();render(await call('snapshot'));toast('模型已添加');
 });
 $('hosting-manual-add').onclick=()=>task($('hosting-manual-add'),async()=>{
   await call('addHostingModels',{providerId:hostingSelection,models:[$('hosting-manual-id').value.trim()]});$('hosting-manual-id').value='';render(await call('snapshot'));toast('模型已添加');
 });
 resetHostingForm(null);
}
