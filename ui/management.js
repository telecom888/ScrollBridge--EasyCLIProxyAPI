let editingKeyId=null, editingRuleId=null, pendingConfirmation=null, permissionSelection=new Set();
let keyEditorInitialized=false,keyEditorVisible=false,keyCreating=false,keyDirty=false,keySaving=false,editorFingerprint='',entryFingerprint='',draftTransition=null,menuKeyId=null,menuTrigger=null;
function availableEntries(keyId, includeBlocked=false) {
  const key=snapshot.config.accessKeys.find(row=>row.id===keyId);
  return (snapshot.modelEntries || []).filter(row=>includeBlocked || key?.enabled && row.available && row.globalEnabled && (key.mode==='all' || key.allowed.includes(row.id)));
}
function fillKeySelect(select,selected) {
  const html=snapshot.keys.map(key=>`<option value="${escapeHTML(key.id)}">${escapeHTML(key.name)}${key.enabled?'':'（已停用）'}</option>`).join('');
  replaceContent(select,html || '<option value="">暂无密钥</option>');
  select.value=snapshot.keys.some(key=>key.id===selected)?selected:(snapshot.keys.find(key=>key.enabled)?.id || snapshot.keys[0]?.id || '');
}
function renderManagement() {
  fillKeySelect($('access-key'),$('access-key').value);
  fillKeySelect($('diagnostic-key'),snapshot.config.diagnosticKeyId);
  // A removed/disabled diagnostic selection must not silently become a different key.
  if(!snapshot.config.diagnosticKeyId)$('diagnostic-key').value='';
  if(!keyEditorInitialized || !keyCreating && editingKeyId && !snapshot.keys.some(key=>key.id===editingKeyId))populateKeyEditor(snapshot.keys[0]?.id || null);
  const active=snapshot.keys.find(key=>key.id===editingKeyId),signature=JSON.stringify([active?.id,active?.name,active?.enabled,active?.mode,active?.allowed,active?.concurrent,active?.requestLimit,active?.requestWindowSeconds]);
  const modelsSignature=JSON.stringify(snapshot.modelEntries);
  if(keyEditorVisible && !keyCreating && !keyDirty && editorFingerprint!==signature)populateKeyEditor(editingKeyId);
  else if(keyEditorVisible && entryFingerprint!==modelsSignature){entryFingerprint=modelsSignature;renderPermissionChoices();}
  const query=$('key-search').value.trim().toLowerCase();
  const visible=snapshot.keys.filter(key=>key.name.toLowerCase().includes(query));
  const rows=visible.map(key=>`<div class="managed-key" data-key-id="${escapeHTML(key.id)}" role="listitem"><button type="button" class="key-select" data-key-edit="${key.id}" aria-pressed="${keyEditorVisible && editingKeyId===key.id}" aria-label="编辑 ${escapeHTML(key.name)}"><span class="key-description"><strong>${escapeHTML(key.name)}</strong><code>${escapeHTML(key.masked)}</code><span class="key-permission-summary">${key.mode==='all'?'全部模型':'指定模型'}，${availableEntries(key.id).length} 个可用</span></span><span class="key-state ${key.enabled?'enabled':''}"><span></span>${key.enabled?'已启用':'已停用'}</span></button><div class="key-actions"><button type="button" class="icon-button quiet" data-key-copy="${key.id}" aria-label="复制 ${escapeHTML(key.name)} 密钥" title="复制密钥">${icon('copy')}</button><button type="button" class="icon-button quiet" data-key-more="${key.id}" aria-haspopup="menu" aria-expanded="false" aria-controls="key-menu" aria-label="${escapeHTML(key.name)} 更多操作" title="更多操作">${icon('more')}</button></div></div>`).join('');
  reconcileRows($('key-list'),rows || `<div class="empty">${query?'没有匹配的密钥':'暂无密钥，点击「新建密钥」开始。'}</div>`,row=>row.dataset.keyId || `empty:${row.textContent}`,(row,next)=>{
    const old=row.querySelector('.key-description'),incoming=next.querySelector('.key-description');
    if(old && old.innerHTML!==incoming.innerHTML)old.innerHTML=incoming.innerHTML;
    for(const field of ['aria-pressed','aria-label'])row.querySelector('.key-select')?.setAttribute(field,next.querySelector('.key-select').getAttribute(field));
    for(const selector of ['[data-key-copy]','[data-key-more]'])row.querySelector(selector)?.setAttribute('aria-label',next.querySelector(selector).getAttribute('aria-label'));
    const status=row.querySelector('.key-state');if(status){status.className=next.querySelector('.key-state').className;status.innerHTML=next.querySelector('.key-state').innerHTML;}
  });
  for(const row of $('key-list').querySelectorAll('.managed-key'))row.classList.toggle('selected',keyEditorVisible && row.dataset.keyId===editingKeyId);
  for(const button of $('key-list').querySelectorAll('[data-key-copy]'))button.onclick=()=>task(button,async()=>{await call('copyKey',{id:button.dataset.keyCopy});toast('已复制密钥');});
  for(const button of $('key-list').querySelectorAll('[data-key-edit]'))button.onclick=()=>openKeyEditor(button.dataset.keyEdit);
  for(const button of $('key-list').querySelectorAll('[data-key-more]'))button.onclick=()=>showKeyMenu(button.dataset.keyMore,button);
  for(const button of $('key-list').querySelectorAll('button'))button.disabled=keySaving;
  if(menuKeyId && !snapshot.keys.some(key=>key.id===menuKeyId))$('key-menu').hidePopover();
  updateKeyEditorControls();
  const choices=availableEntries($('access-key').value).map(row=>row.name);
  const selected=$('example-model').value;
  replaceContent($('example-model'),'<option value="">选择模型</option>'+choices.map(name=>`<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join(''));
  $('example-model').value=choices.includes(selected)?selected:'';
  showModels(choices);
}
function openKeyEditor(id=null) {
  if(keySaving || keyEditorVisible && (id ? editingKeyId===id && !keyCreating : keyCreating))return;
  requestKeyTransition(()=>{populateKeyEditor(id,!id);renderManagement();reveal(document.querySelector('.key-detail'));$('key-name').focus();});
}
function populateKeyEditor(id,creating=false) {
  const key=snapshot.keys.find(row=>row.id===id);editingKeyId=key?.id || null;keyCreating=creating;keyDirty=false;keyEditorInitialized=true;keyEditorVisible=creating || !!key;
  $('key-editor-title').textContent=creating?'新建密钥':'编辑密钥';
  $('key-name').value=key?.name || '';$('key-enabled').checked=key?.enabled ?? true;$('key-all').checked=!key || key.mode==='all';
  $('key-concurrent-enabled').checked=!!key?.concurrent;$('key-concurrent').value=key?.concurrent || 10;
  $('key-rate-enabled').checked=!!key?.requestLimit;$('key-request-limit').value=key?.requestLimit || 100;
  const seconds=key?.requestWindowSeconds || 3600,unit=seconds%3600===0?3600:60;
  $('key-window-unit').value=String(unit);$('key-window-value').value=seconds/unit;renderKeyLimitFields();
  permissionSelection=new Set(key?.mode==='selected'?key.allowed:(snapshot.modelEntries || []).map(row=>row.id));
  editorFingerprint=JSON.stringify([key?.id,key?.name,key?.enabled,key?.mode,key?.allowed,key?.concurrent,key?.requestLimit,key?.requestWindowSeconds]);entryFingerprint=JSON.stringify(snapshot.modelEntries);
  $('permission-search').value='';renderPermissionChoices();$('key-permissions').scrollTop=0;document.querySelector('.key-editor-body').scrollTop=0;updateKeyEditorControls();
}
function updateKeyEditorControls() {
  $('key-form').hidden=!keyEditorVisible;$('key-editor-empty').hidden=keyEditorVisible;
  document.querySelector('.key-workspace').classList.toggle('editor-closed',!keyEditorVisible);
  $('key-draft-status').hidden=!keyDirty;
  $('key-form').querySelector('[type=submit]').disabled=keySaving || !keyCreating && !keyDirty;
  for(const id of ['key-name','key-enabled','key-all','permission-search','cancel-key-edit','close-key-editor','new-key','key-concurrent-enabled','key-concurrent','key-rate-enabled','key-request-limit','key-window-value','key-window-unit'])$(id).disabled=keySaving;
  renderKeyLimitFields();
  $('key-form').setAttribute('aria-busy',String(keySaving));
  for(const input of $('key-permissions').querySelectorAll('input'))input.disabled=keySaving || input.dataset.blocked==='true';
  for(const id of ['permission-select-all','permission-clear'])$(id).disabled=keySaving;
  updatePermissionCount();
}
function updatePermissionCount(){
  const entries=snapshot.modelEntries || [],usable=entries.filter(row=>row.available && row.globalEnabled);
  $('permission-count').textContent=`已选择 ${usable.filter(row=>$('key-all').checked || permissionSelection.has(row.id)).length} / ${entries.length}`;
}
function renderKeyLimitFields() {
  const available=!!snapshot.features?.keyLimits,concurrent=available && $('key-concurrent-enabled').checked,rate=available && $('key-rate-enabled').checked;
  $('key-limits').hidden=!available;
  $('key-concurrent-field').hidden=!concurrent;
  $('key-concurrent').required=concurrent;$('key-concurrent').disabled=keySaving || !concurrent;
  $('key-rate-fields').hidden=!rate;
  for(const id of ['key-request-limit','key-window-value']){$(id).required=rate;$(id).disabled=keySaving || !rate;}
  $('key-window-unit').disabled=keySaving || !rate;
  $('key-window-value').max=31536000/Number($('key-window-unit').value);
}
function markKeyDirty(){keyDirty=true;updateKeyEditorControls();}
function requestKeyTransition(action) {
  if(keyDirty){draftTransition=action;openDialog($('key-draft-dialog'));}else action();
}
function showKeyMenu(id,trigger) {
  if(pending || keySaving)return;
  const menu=$('key-menu');menuTrigger?.setAttribute('aria-expanded','false');if(menu.matches(':popover-open'))menu.hidePopover();
  menuKeyId=id;menuTrigger=trigger;trigger.setAttribute('aria-expanded','true');
  const rect=trigger.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(rect.right-184,innerWidth-192))}px`;menu.style.top=`${rect.bottom+108>innerHeight?Math.max(8,rect.top-108):rect.bottom+6}px`;
  menu.showPopover();positionPopoverOrigin(menu,rect);menu.querySelector('button').focus();
}
function renderPermissionChoices() {
  const query=$('permission-search').value.trim().toLowerCase(),all=$('key-all').checked;
  const groups=new Map();
  for(const entry of snapshot.modelEntries || []) {
    if(!`${entry.name} ${entry.actual}`.toLowerCase().includes(query))continue;
    if(!groups.has(entry.actual))groups.set(entry.actual,[]);groups.get(entry.actual).push(entry);
  }
  $('key-permissions').innerHTML=[...groups].map(([actual,rows])=>`<div class="permission-group"><strong>${escapeHTML(actual)}</strong>${rows.map(row=>`<label class="permission-choice ${!row.globalEnabled || !row.available?'blocked':''}"><input type="checkbox" data-permission="${row.id}" data-blocked="${!row.globalEnabled || !row.available}" ${all || permissionSelection.has(row.id)?'checked':''} ${!row.globalEnabled || !row.available?'disabled':''}><span><code>${escapeHTML(row.name)}</code><small>${!row.available?'代理当前未提供':!row.globalEnabled?'全局已关闭':''}</small></span></label>`).join('')}</div>`).join('') || `<p class="note">${query?'没有匹配的模型。':'请先在「模型」页从代理获取模型。'}</p>`;
  for(const input of $('key-permissions').querySelectorAll('[data-permission]'))input.onchange=()=>{
    if($('key-all').checked){permissionSelection=new Set((snapshot.modelEntries || []).map(row=>row.id));$('key-all').checked=false;}
    if(input.checked)permissionSelection.add(input.dataset.permission);else permissionSelection.delete(input.dataset.permission);
    markKeyDirty();
  };
  updatePermissionCount();
}

// Layout preferences are local UI state and never enter the credential config.
function initKeyLayout(){
  const workspace=$('key-workspace'),storageKey='scrollbridge.key-columns',defaults=[.23,.35,.42],minimum=[220,300,320];
  let ratios=[...defaults];
  try{const saved=JSON.parse(localStorage.getItem(storageKey));if(Array.isArray(saved) && saved.length===3 && saved.every(n=>Number.isFinite(n) && n>0)){const sum=saved.reduce((a,b)=>a+b,0);ratios=saved.map(n=>n/sum);}}catch{}
  const dividers=[...workspace.querySelectorAll('[data-divider]')];
  const widths=()=>{
    const total=workspace.clientWidth-20;
    let result=ratios.map(n=>n*total),remaining=total,flex=[0,1,2];
    while(flex.length){const sum=flex.reduce((n,i)=>n+ratios[i],0),small=flex.filter(i=>remaining*ratios[i]/sum<minimum[i]);if(!small.length){for(const i of flex)result[i]=remaining*ratios[i]/sum;break;}for(const i of small){result[i]=minimum[i];remaining-=minimum[i];}flex=flex.filter(i=>!small.includes(i));}
    return result;
  };
  const apply=()=>{
    if(!workspace.clientWidth)return;
    const values=widths();workspace.style.gridTemplateColumns=`${values[0]}px 10px ${values[1]}px 10px ${values[2]}px`;
    dividers.forEach((divider,i)=>{const pair=values[i]+values[i+1];divider.setAttribute('aria-valuemin',Math.round(minimum[i]/pair*100));divider.setAttribute('aria-valuemax',Math.round((pair-minimum[i+1])/pair*100));divider.setAttribute('aria-valuenow',Math.round(values[i]/pair*100));});
  };
  const persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify(ratios));}catch{}};
  const resize=(index,base,delta)=>{
    const pair=base[index]+base[index+1],left=Math.max(minimum[index],Math.min(pair-minimum[index+1],base[index]+delta));
    const next=[...base];next[index]=left;next[index+1]=pair-left;const total=next.reduce((a,b)=>a+b,0);ratios=next.map(n=>n/total);apply();
  };
  for(const divider of dividers){
    const index=Number(divider.dataset.divider);
    divider.onpointerdown=event=>{
      if(event.button!==0)return;event.preventDefault();divider.focus();divider.setPointerCapture(event.pointerId);
      const base=widths(),start=event.clientX;workspace.classList.add('resizing');
      divider.onpointermove=e=>resize(index,base,e.clientX-start);
      const finish=()=>{divider.onpointermove=null;workspace.classList.remove('resizing');persist();};
      divider.onpointerup=()=>{divider.releasePointerCapture(event.pointerId);finish();};divider.onlostpointercapture=finish;divider.onpointercancel=finish;
    };
    divider.onkeydown=event=>{if(!['ArrowLeft','ArrowRight','Home'].includes(event.key))return;event.preventDefault();if(event.key==='Home')reset();else{resize(index,widths(),(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?40:12));persist();}};
    divider.ondblclick=()=>reset();
  }
  const reset=()=>{ratios=[...defaults];try{localStorage.removeItem(storageKey);}catch{}apply();};
  const button=document.createElement('button');button.id='reset-key-layout';button.className='secondary';button.hidden=true;button.textContent='恢复默认布局';button.onclick=reset;document.querySelector('.header-actions').prepend(button);
  new ResizeObserver(apply).observe(workspace);apply();
}
function addAliasRow(alias={id:'',name:''}) {
  const row=document.createElement('div');row.className='alias-row';row.dataset.aliasId=alias.id;
  const input=document.createElement('input');input.value=alias.name;input.required=true;input.maxLength=128;input.placeholder='例如：chat-fast';input.setAttribute('aria-label','模型别名');
  const remove=document.createElement('button');remove.type='button';remove.className='text-button danger-text';remove.textContent='删除';remove.onclick=()=>row.remove();
  row.append(input,remove);$('alias-rows').append(row);
}
function openAliasEditor(id) {
  const rule=snapshot.config.modelRules.find(row=>row.id===id);editingRuleId=id;
  $('alias-actual').textContent=rule.actual;$('alias-keep').checked=rule.keepOriginal;$('alias-rows').replaceChildren();rule.aliases.forEach(addAliasRow);openDialog($('alias-dialog'));
}
function confirmKey(action,id) {
  const key=snapshot.keys.find(row=>row.id===id);pendingConfirmation={action,id};
  $('key-confirm-title').textContent=action==='deleteKey'?'删除密钥？':'重置密钥？';
  $('key-confirm-message').textContent=action==='deleteKey'?`删除“${key.name}”后，使用它的客户端将无法访问。`:`“${key.name}”的旧密钥会立即失效，需要更新客户端。`;
  openDialog($('key-confirm-dialog'));
}
function initManagement() {
  initKeyLayout();
  const title=$('page-title'),heading=document.createElement('div');heading.className='page-heading';title.before(heading);heading.append(title);
  const create=document.createElement('button');create.id='new-key';create.className='primary';create.hidden=true;create.innerHTML=icon('plus')+'新建密钥';document.querySelector('.header-actions').prepend(create);
  const accessLabel=document.createElement('label');accessLabel.className='access-key-picker';accessLabel.innerHTML='访问密钥<select id="access-key" aria-label="调用示例密钥"></select>';
  document.querySelector('.key-row').before(accessLabel);
  const diagnosticLabel=document.createElement('label');diagnosticLabel.className='diagnostic-key-picker';diagnosticLabel.innerHTML='检测密钥<select id="diagnostic-key" aria-label="检测密钥"></select>';
  document.querySelector('.diagnostic-model-picker').prepend(diagnosticLabel);
  const old=$('example-model'),select=document.createElement('select');select.id=old.id;select.setAttribute('aria-label','调用模型');old.replaceWith(select);select.onchange=renderExample;
  $('access-key').onchange=()=>{renderManagement();renderExample();};
  $('diagnostic-key').onchange=()=>task($('diagnostic-key'),async()=>{try{render(await call('save',{config:{diagnosticKeyId:$('diagnostic-key').value,diagnosticModel:''}}));}finally{render(await call('snapshot'));}});
  $('new-key').onclick=()=>openKeyEditor();
  $('new-key-empty').onclick=()=>openKeyEditor();$('key-name').oninput=markKeyDirty;$('key-enabled').onchange=markKeyDirty;
  for(const id of ['key-concurrent-enabled','key-rate-enabled'])$(id).onchange=()=>{renderKeyLimitFields();markKeyDirty();};
  for(const id of ['key-concurrent','key-request-limit','key-window-value','key-window-unit'])$(id).oninput=()=>{renderKeyLimitFields();markKeyDirty();};
  $('key-search').oninput=()=>{$('key-menu').hidePopover();renderManagement();};
  $('close-key-editor').onclick=()=>requestKeyTransition(()=>{keyEditorVisible=false;keyDirty=false;renderManagement();});
  $('cancel-key-edit').onclick=()=>{populateKeyEditor(keyCreating?snapshot.keys[0]?.id:editingKeyId);renderManagement();};
  $('keep-key-draft').onclick=()=>{draftTransition=null;closeDialog($('key-draft-dialog'));};
  $('discard-key-draft').onclick=async()=>{const action=draftTransition;draftTransition=null;keyDirty=false;if(await closeDialog($('key-draft-dialog')))action?.();};
  $('key-draft-dialog').addEventListener('cancel',()=>{draftTransition=null;});
  $('key-menu').addEventListener('toggle',event=>{if(event.newState==='closed')menuTrigger?.setAttribute('aria-expanded','false');});
  $('key-menu').onkeydown=event=>{
    const items=[...$('key-menu').querySelectorAll('button')],index=items.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length].focus();}
    if(event.key==='Escape'){event.preventDefault();$('key-menu').hidePopover();menuTrigger?.focus();}
    if(event.key==='Tab')$('key-menu').hidePopover();
  };
  $('menu-reset-key').onclick=()=>{$('key-menu').hidePopover();confirmKey('rotateKey',menuKeyId);};
  $('menu-delete-key').onclick=()=>{$('key-menu').hidePopover();confirmKey('deleteKey',menuKeyId);};
  $('key-all').onchange=()=>{if($('key-all').checked)permissionSelection=new Set((snapshot.modelEntries || []).map(row=>row.id));renderPermissionChoices();markKeyDirty();};
  $('permission-search').oninput=renderPermissionChoices;
  $('permission-select-all').onclick=()=>{ $('key-all').checked=false;permissionSelection=new Set((snapshot.modelEntries || []).filter(row=>row.available && row.globalEnabled).map(row=>row.id));renderPermissionChoices();markKeyDirty();};
  $('permission-clear').onclick=()=>{ $('key-all').checked=false;permissionSelection.clear();renderPermissionChoices();markKeyDirty();};
  $('key-form').onsubmit=event=>{event.preventDefault();task(event.submitter,async()=>{
    const previous=new Set(snapshot.keys.map(key=>key.id)),target=editingKeyId;
    const valid=new Set(snapshot.config.modelRules.flatMap(rule=>[rule.originalId,...rule.aliases.map(alias=>alias.id)]));
    const payload={id:target,name:$('key-name').value,enabled:$('key-enabled').checked,mode:$('key-all').checked?'all':'selected',allowed:[...permissionSelection].filter(id=>valid.has(id))};
    if(snapshot.features?.keyLimits)Object.assign(payload,{
      concurrent:$('key-concurrent-enabled').checked?Number($('key-concurrent').value):0,
      requestLimit:$('key-rate-enabled').checked?Number($('key-request-limit').value):0,
      requestWindowSeconds:$('key-rate-enabled').checked?Number($('key-window-value').value)*Number($('key-window-unit').value):(snapshot.keys.find(key=>key.id===target)?.requestWindowSeconds || 3600)
    });
    keySaving=true;updateKeyEditorControls();
    try{
      const state=await call('saveKey',payload);snapshot=state;keyDirty=false;
      const selected=target || state.keys.find(key=>!previous.has(key.id))?.id;
      $('key-search').value='';populateKeyEditor(selected);render(state);toast('密钥已保存');
    }finally{keySaving=false;updateKeyEditorControls();}
  });};
  $('add-alias').onclick=()=>addAliasRow();
  $('alias-form').onsubmit=event=>{event.preventDefault();task(event.submitter,async()=>{
    const aliases=[...$('alias-rows').children].map(row=>({id:row.dataset.aliasId || undefined,name:row.querySelector('input').value}));
    render(await call('saveAliases',{id:editingRuleId,keepOriginal:$('alias-keep').checked,aliases}));closeDialog($('alias-dialog'));toast('模型 ID 已保存');
  });};
  $('key-confirm').onclick=()=>task($('key-confirm'),async()=>{const {action,id}=pendingConfirmation;render(await call(action,{id}));closeDialog($('key-confirm-dialog'));toast(action==='deleteKey'?'密钥已删除':'密钥已重置');});
  document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>closeDialog($(button.dataset.close)));
}
