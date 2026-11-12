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
 const switchTab=name=>{for(const button of document.querySelectorAll('[data-hosting-tab]'))button.classList.toggle('active',button.dataset.hostingTab===name);$('hosting-keys-view').hidden=name!=='keys';$('hosting-routes-panel').hidden=name!=='routes';};
 for(const button of document.querySelectorAll('[data-hosting-tab]'))button.onclick=()=>{switchTab(button.dataset.hostingTab);reveal(button.dataset.hostingTab==='keys'?$('hosting-keys-view'):$('hosting-routes-panel'));};
 $('hosting-add').onclick=()=>{switchTab('keys');hostingSelection=null;resetHostingForm(null);renderHosting();$('hosting-name').focus();};
 $('hosting-protocol').onchange=()=>{$('hosting-vertex-fields').hidden=$('hosting-protocol').value!=='vertex';$('hosting-url').value=hostingDefaults[$('hosting-protocol').value];};
 $('hosting-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{
   const payload={id:hostingSelection,name:$('hosting-name').value,protocol:$('hosting-protocol').value,baseUrl:$('hosting-url').value,
     projectId:$('hosting-project').value,location:$('hosting-location').value,enabled:$('hosting-enabled').checked,key:$('hosting-key').value};
   const result=await call('saveHostingProvider',payload);hostingSelection=result.providerId;resetHostingForm({...payload,id:result.providerId});render(await call('snapshot'));toast('密钥已保存');
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

function hostingGroups(){
  if(!snapshot)return [];
  const groups=new Map();
  const add=(id,modelId,source,enabled)=>{
    const key=modelId.trim().replace(/^models\//i,'').toLowerCase();
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({id,modelId,source,enabled});
  };
  for(const rule of snapshot.config.modelRules)add(rule.id,rule.actual,'本地代理',snapshot.config.knownModels.some(id=>id.toLowerCase()===rule.actual.toLowerCase())&&!snapshot.config.disabledModels.includes(rule.actual.toLowerCase()));
  const p=new Map(snapshot.config.hostingProviders.map(row=>[row.id,row]));
  for(const row of snapshot.config.hostingModels){const account=p.get(row.providerId);if(account)add(row.id,row.modelId,account.name,row.enabled&&account.enabled);}
  return [...groups].filter(([,list])=>list.length>1).map(([name,list])=>{
    const preferred=snapshot.config.hostingRouteOrders?.[name]||[];
    const order=list.slice().sort((a,b)=>{
      const ai=preferred.indexOf(a.id),bi=preferred.indexOf(b.id);
      if(ai<0&&bi<0)return 0;
      return (ai<0?100000:ai)-(bi<0?100000:bi);
    });
    return {name,order};
  });
}
function renderHostingRoutes(){
  const host=$('hosting-route-groups');if(!host||!snapshot)return;
  host.replaceChildren();
  const groups=hostingGroups();
  if(!groups.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='暂无相同模型的多个来源';host.append(empty);return;}
  for(const group of groups){
    const details=document.createElement('details');details.className='hosting-route-group';details.open=true;
    const summary=document.createElement('summary');summary.textContent=group.name;details.append(summary);
    group.order.forEach((source,index)=>{
      const row=document.createElement('div');row.className='hosting-route-row';
      const num=document.createElement('span');num.className='hosting-route-rank';num.textContent=String(index+1);
      const name=document.createElement('strong');name.textContent=source.source;
      if(!source.enabled){name.classList.add('unavailable-model');name.title='该模型来源当前已停用';}
      const controls=document.createElement('div');controls.className='hosting-route-actions';
      for(const [direction,symbol] of [[-1,'上移'],[1,'下移']]){
        const button=document.createElement('button');button.type='button';button.className='secondary';
        button.textContent=symbol;button.disabled=index+direction<0||index+direction>=group.order.length;
        button.setAttribute('aria-label',symbol+source.source);
        button.onclick=()=>task(button,async()=>{
          const order=group.order.map(item=>item.id),next=index+direction;
          [order[index],order[next]]=[order[next],order[index]];
          render(await call('setHostingRouteOrder',{modelId:group.name,order}));
          toast('路由优先级已保存');
        });
        controls.append(button);
      }
      row.append(num,name,controls);details.append(row);
    });
    host.append(details);
  }
}
function renderHostedCatalog(){
  const host=$('hosted-catalog-list');if(!host||!snapshot)return;
  host.replaceChildren();
  const query=$('model-search').value.trim().toLowerCase();
  const entries=snapshot.modelEntries.filter(row=>row.hosted&&row.actual.toLowerCase().includes(query));
  for(const entry of entries){
    const row=document.createElement('div');row.className='catalog-row';
    const left=document.createElement('div'),id=document.createElement('code');
    id.textContent=entry.actual;left.append(id);
    if(snapshot.config.showModelSources){const source=document.createElement('p');source.className='alias-summary';source.textContent=entry.source;left.append(source);}
    const publicId=document.createElement('p');publicId.className='alias-summary';publicId.textContent='对外 ID：'+entry.name;left.append(publicId);
    const actions=document.createElement('div');actions.className='catalog-actions';
    const toggle=document.createElement('button');toggle.type='button';toggle.className='model-switch';toggle.setAttribute('role','switch');
    toggle.setAttribute('aria-checked',String(entry.globalEnabled));toggle.setAttribute('aria-label',entry.source+' '+entry.actual+' 外部访问');
    toggle.dataset.hostedModel=entry.id;toggle.disabled=!entry.available||pending;
    const knob=document.createElement('span');toggle.append(knob);
    toggle.onclick=()=>task(toggle,async()=>{render(await call('setHostingModelAccess',{id:entry.id,enabled:toggle.getAttribute('aria-checked')!=='true'}));toast('模型访问设置已保存');});
    actions.append(toggle);row.append(left,actions);host.append(row);
  }
}
