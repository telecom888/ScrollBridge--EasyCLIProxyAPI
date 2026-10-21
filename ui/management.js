let editingKeyId=null, editingRuleId=null, pendingConfirmation=null, permissionSelection=new Set();
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
  const rows=snapshot.keys.map(key=>`<div class="managed-key" data-key-id="${escapeHTML(key.id)}"><div class="key-description"><strong>${escapeHTML(key.name)}</strong><code>${escapeHTML(key.masked)}</code><p>${key.mode==='all'?'全部模型':'指定模型'}，当前可用 ${availableEntries(key.id).length} 个</p></div><div class="key-actions"><button class="model-switch" role="switch" aria-label="${escapeHTML(key.name)} 启用状态" aria-checked="${key.enabled}" data-key-toggle="${key.id}"><span></span></button><button class="secondary" data-key-copy="${key.id}">复制</button><button class="secondary" data-key-edit="${key.id}">编辑</button><button class="text-button" data-key-reset="${key.id}">重置</button><button class="text-button danger-text" data-key-delete="${key.id}">删除</button></div></div>`).join('');
  reconcileRows($('key-list'),rows || '<div class="empty">暂无密钥，点击「新建密钥」开始。</div>',row=>row.dataset.keyId || 'empty',(row,next)=>{
    const old=row.querySelector('.key-description'),incoming=next.querySelector('.key-description');
    if(old && old.innerHTML!==incoming.innerHTML)old.innerHTML=incoming.innerHTML;
    const control=row.querySelector('[data-key-toggle]');if(control){control.setAttribute('aria-checked',next.querySelector('[data-key-toggle]').getAttribute('aria-checked'));control.setAttribute('aria-label',next.querySelector('[data-key-toggle]').getAttribute('aria-label'));}
  });
  for(const button of $('key-list').querySelectorAll('[data-key-copy]'))button.onclick=()=>task(button,async()=>{await call('copyKey',{id:button.dataset.keyCopy});toast('已复制密钥');});
  for(const button of $('key-list').querySelectorAll('[data-key-edit]'))button.onclick=()=>openKeyEditor(button.dataset.keyEdit);
  for(const button of $('key-list').querySelectorAll('[data-key-toggle]'))button.onclick=()=>task(button,async()=>{
    const key=snapshot.keys.find(row=>row.id===button.dataset.keyToggle);
    render(await call('saveKey',{id:key.id,name:key.name,enabled:!key.enabled}));
  });
  for(const button of $('key-list').querySelectorAll('[data-key-reset]'))button.onclick=()=>confirmKey('rotateKey',button.dataset.keyReset);
  for(const button of $('key-list').querySelectorAll('[data-key-delete]'))button.onclick=()=>confirmKey('deleteKey',button.dataset.keyDelete);
  const choices=availableEntries($('access-key').value).map(row=>row.name);
  const selected=$('example-model').value;
  replaceContent($('example-model'),'<option value="">选择模型</option>'+choices.map(name=>`<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join(''));
  $('example-model').value=choices.includes(selected)?selected:'';
  showModels(choices);
}
function openKeyEditor(id=null) {
  const key=snapshot.keys.find(row=>row.id===id);editingKeyId=id;
  $('key-dialog-title').textContent=key?'编辑密钥':'新建密钥';
  $('key-name').value=key?.name || '';$('key-enabled').checked=key?.enabled ?? true;$('key-all').checked=!key || key.mode==='all';
  permissionSelection=new Set(key?.mode==='selected'?key.allowed:(snapshot.modelEntries || []).map(row=>row.id));
  $('permission-search').value='';renderPermissionChoices();$('key-dialog').showModal();
}
function renderPermissionChoices() {
  const query=$('permission-search').value.trim().toLowerCase(),all=$('key-all').checked;
  const groups=new Map();
  for(const entry of snapshot.modelEntries || []) {
    if(!`${entry.name} ${entry.actual}`.toLowerCase().includes(query))continue;
    if(!groups.has(entry.actual))groups.set(entry.actual,[]);groups.get(entry.actual).push(entry);
  }
  $('key-permissions').innerHTML=[...groups].map(([actual,rows])=>`<div class="permission-group"><strong>${escapeHTML(actual)}</strong>${rows.map(row=>`<label class="permission-choice"><input type="checkbox" data-permission="${row.id}" ${all || permissionSelection.has(row.id)?'checked':''} ${!row.globalEnabled || !row.available?'disabled':''}><span><code>${escapeHTML(row.name)}</code><small>${!row.available?'代理当前未提供':!row.globalEnabled?'全局已关闭':''}</small></span></label>`).join('')}</div>`).join('') || '<p class="note">没有匹配的模型。</p>';
  for(const input of $('key-permissions').querySelectorAll('[data-permission]'))input.onchange=()=>{
    if($('key-all').checked){permissionSelection=new Set((snapshot.modelEntries || []).map(row=>row.id));$('key-all').checked=false;}
    if(input.checked)permissionSelection.add(input.dataset.permission);else permissionSelection.delete(input.dataset.permission);
  };
}
function addAliasRow(alias={id:'',name:''}) {
  const row=document.createElement('div');row.className='alias-row';row.dataset.aliasId=alias.id;
  const input=document.createElement('input');input.value=alias.name;input.required=true;input.maxLength=128;input.placeholder='例如：chat-fast';input.setAttribute('aria-label','模型别名');
  const remove=document.createElement('button');remove.type='button';remove.className='text-button danger-text';remove.textContent='删除';remove.onclick=()=>row.remove();
  row.append(input,remove);$('alias-rows').append(row);
}
function openAliasEditor(id) {
  const rule=snapshot.config.modelRules.find(row=>row.id===id);editingRuleId=id;
  $('alias-actual').textContent=rule.actual;$('alias-keep').checked=rule.keepOriginal;$('alias-rows').replaceChildren();rule.aliases.forEach(addAliasRow);$('alias-dialog').showModal();
}
function confirmKey(action,id) {
  const key=snapshot.keys.find(row=>row.id===id);pendingConfirmation={action,id};
  $('key-confirm-title').textContent=action==='deleteKey'?'删除密钥？':'重置密钥？';
  $('key-confirm-message').textContent=action==='deleteKey'?`删除“${key.name}”后，使用它的客户端将无法访问。`:`“${key.name}”的旧密钥会立即失效，需要更新客户端。`;
  $('key-confirm-dialog').showModal();
}
function initManagement() {
  const accessLabel=document.createElement('label');accessLabel.className='access-key-picker';accessLabel.innerHTML='访问密钥<select id="access-key" aria-label="调用示例密钥"></select>';
  document.querySelector('.key-row').before(accessLabel);
  const diagnosticLabel=document.createElement('label');diagnosticLabel.className='diagnostic-key-picker';diagnosticLabel.innerHTML='检测密钥<select id="diagnostic-key" aria-label="检测密钥"></select>';
  document.querySelector('.diagnostic-model-picker').prepend(diagnosticLabel);
  const old=$('example-model'),select=document.createElement('select');select.id=old.id;select.setAttribute('aria-label','调用模型');old.replaceWith(select);select.onchange=renderExample;
  $('access-key').onchange=()=>{renderManagement();renderExample();};
  $('diagnostic-key').onchange=()=>task($('diagnostic-key'),async()=>{try{render(await call('save',{config:{diagnosticKeyId:$('diagnostic-key').value,diagnosticModel:''}}));}finally{render(await call('snapshot'));}});
  $('new-key').onclick=()=>openKeyEditor();
  $('key-all').onchange=()=>{if($('key-all').checked)permissionSelection=new Set((snapshot.modelEntries || []).map(row=>row.id));renderPermissionChoices();};
  $('permission-search').oninput=renderPermissionChoices;
  $('key-form').onsubmit=event=>{event.preventDefault();task(event.submitter,async()=>{
    render(await call('saveKey',{id:editingKeyId,name:$('key-name').value,enabled:$('key-enabled').checked,mode:$('key-all').checked?'all':'selected',allowed:[...permissionSelection]}));
    $('key-dialog').close();toast('密钥已保存');
  });};
  $('add-alias').onclick=()=>addAliasRow();
  $('alias-form').onsubmit=event=>{event.preventDefault();task(event.submitter,async()=>{
    const aliases=[...$('alias-rows').children].map(row=>({id:row.dataset.aliasId || undefined,name:row.querySelector('input').value}));
    render(await call('saveAliases',{id:editingRuleId,keepOriginal:$('alias-keep').checked,aliases}));$('alias-dialog').close();toast('模型 ID 已保存');
  });};
  $('key-confirm').onclick=()=>task($('key-confirm'),async()=>{const {action,id}=pendingConfirmation;render(await call(action,{id}));$('key-confirm-dialog').close();toast(action==='deleteKey'?'密钥已删除':'密钥已重置');});
  document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
}
