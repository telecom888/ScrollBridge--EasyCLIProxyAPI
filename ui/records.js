let requestPage=0,selectedRequestIP='',selectedBodyId='';
function renderRequestRecords(){
 if(selectedBodyId&&!snapshot.records.some(row=>row.id===selectedBodyId))$('request-body-dialog').close();
 const all=filteredRecords(),showIP=snapshot.config.recordRequestIP,showBody=snapshot.config.showRequestBody,table=$('requests-table');
 const isRequest=$('tunnel-logs').hidden;$('export-records').hidden=!isRequest;
 const pages=Math.max(1,Math.ceil(all.length/100));requestPage=Math.min(requestPage,pages-1);
 $('record-page-label').textContent=`第 ${requestPage+1} 页，共 ${pages} 页`;
 $('record-prev').disabled=requestPage===0;$('record-next').disabled=requestPage===pages-1;
 $('record-pagination').hidden=!isRequest || all.length<=100;
 $('record-note').textContent=isRequest?`仅保留本次运行的最近 ${snapshot.config.requestRecordLimit.toLocaleString('zh-CN')} 条请求，不记录请求头或查询参数；请求体仅保留有限预览。`:'仅保留本次运行的最近 100 条隧道记录。';
 const limit=snapshot.config.requestRecordLimit;$('record-limit').querySelector('[value=custom]').textContent=[200,1000,5000,10000].includes(limit)?'自定义':`自定义（${limit.toLocaleString('zh-CN')} 条）`;
 if($('record-limit-form').hidden)$('record-limit').value=[200,1000,5000,10000].includes(limit)?String(limit):'custom';
 if(!all.length){replaceContent(table,`<div class="empty">${icon('file')}${$('record-filter-mode').value==='all'?'暂无请求':'所选密钥暂无请求'}</div>`);return;}
 if(!table.querySelector('tbody') || table.dataset.ip!==String(showIP) || table.dataset.body!==String(showBody)){
  table.dataset.ip=String(showIP);table.dataset.body=String(showBody);table.innerHTML=`<table><thead><tr><th>时间</th>${showIP?'<th>请求IP</th>':''}<th>密钥</th><th>方法</th><th>模型</th><th>路径</th><th>状态</th><th>耗时</th>${showBody?'<th>请求体</th>':''}</tr></thead><tbody></tbody></table>`;
 }
 const rows=all.slice(requestPage*100,(requestPage+1)*100).map(r=>`<tr data-row-key="${escapeHTML(r.id)}"><td>${time(r.time)}</td>${showIP?`<td>${r.requestIP?`<button class="request-ip" data-request-ip="${escapeHTML(r.requestIP)}" title="复制 IP 或加入黑名单">${escapeHTML(r.requestIP)}</button>`:'未记录'}</td>`:''}<td>${escapeHTML(r.keyName || '—')}</td><td>${escapeHTML(r.method)}</td><td class="record-model"><span>${escapeHTML(r.model || '—')}</span>${r.actualModel && r.actualModel!==r.model?`<small>实际模型：${escapeHTML(r.actualModel)}</small>`:''}</td><td class="path">${escapeHTML(r.path)}</td><td><span class="status-pill ${r.status>=400?'bad':''}">${r.status}</span>${r.reason?`<small class="record-reason">${escapeHTML(r.reason)}</small>`:''}</td><td>${r.ms} ms</td>${showBody?`<td><button class="text-button" data-view-body="${escapeHTML(r.id)}">查看</button></td>`:''}</tr>`).join('');
 reconcileRows(table.querySelector('tbody'),rows,row=>row.dataset.rowKey);
}
function renderRecordSettings(){
 $('recordRequestIP').checked=snapshot.config.recordRequestIP;
 $('showRequestBody').checked=snapshot.config.showRequestBody;
 if(!snapshot.config.showRequestBody || (selectedBodyId&&!snapshot.records.some(row=>row.id===selectedBodyId))){$('request-body-dialog').close();$('request-body-content').textContent='';}
 $('ip-blacklist-summary').textContent=`已屏蔽 ${snapshot.config.ipBlacklist.length} 个 IP`;
 const search=$('blacklist-search').value.trim().toLowerCase();
 replaceContent($('blacklist-list'),snapshot.config.ipBlacklist.filter(ip=>ip.toLowerCase().includes(search)).map(ip=>`<div class="blacklist-item"><code>${escapeHTML(ip)}</code><button type="button" class="text-button" data-remove-ip="${escapeHTML(ip)}">移除</button></div>`).join('') || '<p class="note">'+(search?'没有匹配的 IP':'暂无黑名单')+'</p>');
}
function openIPMenu(event){
 const button=event.target.closest('[data-request-ip]');if(!button)return;
 event.preventDefault();selectedRequestIP=button.dataset.requestIp;
 const menu=$('request-ip-menu');menu.style.left=Math.max(8,Math.min(event.clientX || button.getBoundingClientRect().left,innerWidth-190))+'px';menu.style.top=Math.max(8,Math.min(event.clientY || button.getBoundingClientRect().bottom,innerHeight-110))+'px';
 menu.showPopover();
}
function initRecordsUI(){
 for(const button of document.querySelectorAll('[data-record-tab]'))button.addEventListener('click',()=>renderRecords());
 for(const id of ['record-filter-mode','record-key-single'])$(id).addEventListener('change',()=>{requestPage=0;renderRecords();});
 $('record-key-choices').addEventListener('change',()=>{requestPage=0;renderRecords();});
 $('record-prev').onclick=()=>{requestPage=Math.max(0,requestPage-1);renderRecords();};$('record-next').onclick=()=>{requestPage++;renderRecords();};
 $('recordRequestIP').onchange=()=>task($('recordRequestIP'),async()=>{try{await changeSetting({recordRequestIP:$('recordRequestIP').checked});}finally{render(await call('snapshot'));}});
 $('showRequestBody').onchange=()=>task($('showRequestBody'),async()=>{await changeSetting({showRequestBody:$('showRequestBody').checked});render(await call('snapshot'));});
 $('close-request-body').onclick=()=>$('request-body-dialog').close();
 $('request-body-dialog').addEventListener('close',()=>{selectedBodyId='';$('request-body-content').textContent='';$('request-body-meta').textContent='';});
 $('requests-table').addEventListener('click',e=>{const button=e.target.closest('[data-view-body]');if(!button)return;task(button,async()=>{
  const body=await call('getRequestBody',{id:button.dataset.viewBody});if(!snapshot.config.showRequestBody)return;
  const states={empty:'此请求没有请求体',binary:'二进制或文件上传内容不提供文本预览',encoded:'该编码无法预览',unavailable:'未能采集请求体，可能未收到正文或已达到内存上限',evicted:'预览已因内存上限被淘汰'};
  let preview=body.preview||states[body.state]||'没有可用的预览';
  if(body.state==='text'&&!body.truncated)try{preview=JSON.stringify(JSON.parse(preview),null,2);}catch{}
  $('request-body-meta').textContent=[body.contentType||'未指定内容类型',body.encoding&&body.encoding!=='identity'?'编码 '+body.encoding:'',body.truncated?'预览已截断或正文未完整收到':''].filter(Boolean).join('，');
  selectedBodyId=button.dataset.viewBody;$('request-body-content').textContent=preview;$('request-body-dialog').showModal();
 });});
 const setLimit=limit=>task(null,async()=>{const state=await call('setRecordLimit',{limit});$('record-limit-form').hidden=true;render(state);});
 $('record-limit').onchange=()=>{const custom=$('record-limit').value==='custom';$('record-limit-form').hidden=!custom;if(custom){$('record-limit-custom').value=snapshot.config.requestRecordLimit;$('record-limit-custom').focus();}else setLimit(Number($('record-limit').value));};
 $('record-limit-form').onsubmit=e=>{e.preventDefault();setLimit(Number($('record-limit-custom').value));};
 $('manage-blacklist').onclick=()=>{$('ip-blacklist-dialog').showModal();renderRecordSettings();};
 $('close-blacklist').onclick=()=>$('ip-blacklist-dialog').close();$('blacklist-search').oninput=renderRecordSettings;
 $('blacklist-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{render(await call('blockIP',{ip:$('blacklist-ip').value.trim()}));$('blacklist-ip').value='';});};
 $('blacklist-list').onclick=e=>{const button=e.target.closest('[data-remove-ip]');if(button)task(button,async()=>{await changeSetting({ipBlacklist:snapshot.config.ipBlacklist.filter(ip=>ip!==button.dataset.removeIp)});render(await call('snapshot'));});};
 $('requests-table').addEventListener('contextmenu',openIPMenu);$('requests-table').addEventListener('click',openIPMenu);
 $('copy-request-ip').onclick=()=>{const ip=selectedRequestIP;$('request-ip-menu').hidePopover();task(null,async()=>{await call('copyRequestIP',{ip});toast('IP 已复制');});};
 $('block-request-ip').onclick=()=>{const ip=selectedRequestIP;$('request-ip-menu').hidePopover();task(null,async()=>render(await call('blockIP',{ip})));};
 $('export-records').onclick=()=>$('export-records-dialog').showModal();$('cancel-export').onclick=()=>$('export-records-dialog').close();
 $('export-records-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{
  const mode=$('record-filter-mode').value,keyIds=mode==='all'?undefined:mode==='single'?[$('record-key-single').value]:[...recordKeySelection];
  const result=await call('exportRecords',{format:$('export-format').value,scope:$('export-scope').value,keyIds});
  if(!result.canceled){$('export-records-dialog').close();toast(`已导出 ${result.count} 条请求`);}
 });};
}
