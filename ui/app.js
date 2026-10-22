const $ = id => document.getElementById(id);
const icons = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',refresh:'<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',plus:'<path d="M12 5v14M5 12h14"/>',
  plug:'<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v4"/>',
  code:'<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h6"/>',
  settings:'<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3 3-1 1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  models:'<path d="m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  moon:'<path d="M20 15A8.5 8.5 0 0 1 9 4a8.5 8.5 0 1 0 11 11Z"/>', sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  play:'<path d="m8 4 12 8-12 8Z"/>', stop:'<rect x="6" y="6" width="12" height="12" rx="1"/>',
  monitor:'<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>', lock:'<rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6h14M5 18h14"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>', arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>', external:'<path d="M14 3h7v7m0-7L10 14m0-10H4v16h16v-6"/>', folder:'<path d="M3 5h7l2 3h9v12H3Z"/>'
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.file}</svg>`; }
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
document.querySelectorAll('[data-protocol]').forEach(el => { const mark=el.querySelector('.protocol-mark'); const img=document.createElement('img');img.className='brand-logo';img.alt='';img.src=`brands/${el.dataset.protocol}.svg`;mark.replaceWith(img); });
let snapshot, dirty = false, currentPage = 'connection', currentProtocol = 'openai', pending = false;
let toastTimer;
function toast(message, error = false) { $('toast').textContent = message; $('toast').className = error ? 'error' : ''; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 8000 : 3500); }
const lockedControls = ['upstream','port','hostname','upstreamKey','tunnelToken','import','transport','launchAtLogin'];
const lockHints = new Map();
for (const id of lockedControls) {
  const control = $(id), wrapper = document.createElement('span'), hint = document.createElement('button');
  wrapper.className = 'config-lock-wrap';
  control.before(wrapper); wrapper.append(control);
  hint.type = 'button'; hint.className = 'config-lock-hint'; hint.hidden = true; hint.dataset.lockedFor = id;
  hint.setAttribute('aria-label', '请先停止连接再修改配置'); hint.title = '请先停止连接再修改配置';
  hint.onclick = event => { event.preventDefault(); event.stopPropagation(); toast('请先停止连接再修改配置'); };
  wrapper.append(hint); lockHints.set(id, hint);
  const label = control.closest('label');
  if (label) label.addEventListener('click', event => { if (!hint.hidden) { event.preventDefault(); toast('请先停止连接再修改配置'); } });
}
async function call(action, payload) { try { return await window.bridge.invoke(action, payload); } catch (e) { const message = e.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); toast(message, true); throw e; } }
async function task(button, fn) { if (pending) return; pending = true; if (button) button.disabled = true; try { await fn(); } catch {} finally { pending = false; if (button) button.disabled = false; if (snapshot) {renderModelCatalog();renderManagement();} } }
function page(name) {
  if (name === currentPage) return;
  currentPage = name;
  document.body.dataset.page=name;$('new-key').hidden=name!=='keys';$('reset-key-layout').hidden=name!=='keys';$('key-menu').hidePopover();
  document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `page-${name}`);
  const selected = document.querySelector(`.nav[data-page="${name}"]`);
  moveSelection(selected.parentElement, selected);
  $('page-title').textContent = {connection:'连接',access:'接入',keys:'密钥',catalog:'模型',records:'记录',settings:'设置'}[name];
  if(name==='records')renderRecords();
  reveal($(`page-${name}`)); reveal(document.querySelector('.page-heading'));
}
document.querySelectorAll('[data-page]').forEach(el => el.onclick = () => page(el.dataset.page));
function applyTheme(theme) { const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme; document.documentElement.dataset.theme = resolved; $('theme-toggle').innerHTML = icon(resolved === 'dark' ? 'sun' : 'moon'); document.querySelectorAll('[data-theme]').forEach(el => el.classList.toggle('active', el.dataset.theme === theme)); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (snapshot?.config.theme === 'system') applyTheme('system'); });
function fillForm(s) { for (const k of ['upstream','port','hostname']) $(k).value = s.config[k]; $('upstreamKey').placeholder = s.hasUpstreamKey ? '已保存，留空则保持不变' : '本地代理的客户端 API Key'; $('tunnelToken').placeholder = s.hasTunnelToken ? '已保存，留空则保持不变' : '粘贴 eyJ 开头的令牌'; $('transport').value = s.config.protocol;  }
function render(s) {
  snapshot = s; applyTheme(s.config.theme); if (!dirty) fillForm(s);
  const titles = { stopped:'未连接', starting:'正在连接', connected:'隧道已连接', reconnecting:'正在重连', error:'连接异常' };
  $('status-title').textContent = titles[s.status]; $('status-message').textContent = s.message || ({stopped:'配置域名与隧道后启动连接',starting:'正在建立加密隧道',connected:'可检测域名 HTTPS 和外部访问',reconnecting:'正在恢复与 Cloudflare 的连接',error:'请检查配置和隧道记录'}[s.status]);
  $('status-dot').className = `status-dot ${s.status}`;
  const running = ['starting','connected','reconnecting'].includes(s.status) || s.gatewayRunning;
  $('connect-label').textContent = running ? '停止连接' : (s.status === 'error' ? '停止并重置' : '启动连接'); $('connect').querySelector('[data-icon]').innerHTML = icon(running || s.status === 'error' ? 'stop' : 'play');
  for (const id of lockedControls) { $(id).disabled = running; lockHints.get(id).hidden = !running; }
  $('launchAtLogin').checked=s.startup?.enabled===true;
  if(s.startup?.error || s.startup?.supported===false)$('launchAtLogin').disabled=true;
  $('startup-status').textContent=s.startup?.error || (s.startup?.disabledBySystem?'已在 Windows 中禁用，开启后重新启用':s.startup?.registered===false && s.config.launchAtLogin?'启动项不存在，请重新开启':'登录 Windows 后打开应用，连接需手动启动');
  $('route-upstream').textContent = s.config.upstream.replace(/^https?:\/\//,''); $('route-host').textContent = s.config.hostname || '尚未配置'; $('public-base').textContent = s.config.hostname ? `https://${s.config.hostname}` : '请先配置域名'; $('origin-service').textContent = `http://127.0.0.1:${s.config.port}`;
  $('imagesEnabled').checked = s.config.imagesEnabled;
  $('geminiImageCompatibility').checked = s.config.geminiImageCompatibility;
  renderModelRefreshSettings();renderManagement();renderDiagnosticModels();renderUpdates();
  $('version').textContent = `v${s.version.replace(/-beta(?:\.\d+)?$/,' beta')}`; renderExample(); renderRecords(); renderDiagnostics(); renderModelCatalog();
}
for (const id of ['upstream','port','hostname','upstreamKey','tunnelToken']) $(id).addEventListener('input', () => { dirty = true; });
async function saveForm() { const s = await call('save', { config: {upstream:$('upstream').value,port:Number($('port').value),hostname:$('hostname').value}, upstreamKey:$('upstreamKey').value,tunnelToken:$('tunnelToken').value }); dirty = false; $('upstreamKey').value = ''; $('tunnelToken').value = ''; render(s); }
$('connection-form').onsubmit = e => { e.preventDefault(); task(e.submitter, async () => { await saveForm(); toast('配置已保存'); }); };
$('connect').onclick = () => task($('connect'), async () => { if (snapshot.status !== 'stopped') { render(await call('stop')); return; } if (dirty) await saveForm(); render(await call('start')); });
async function checkLocal(button) {await task(button,async()=>{if(dirty)await saveForm();$('local-diagnostic-summary').textContent='正在检查进程、监听端口和模型接口…';const result=await call('testLocal');toast(result.message,!result.ok);});}
async function checkPublic(button) {await task(button,async()=>{if(dirty)await saveForm();$('public-diagnostic-summary').textContent='正在通过公网 HTTPS 检查网关与模型响应…';try{const result=await call('testPublic');toast(result.message,!result.ok);}catch(e){$('public-diagnostic-summary').textContent='检测未完成，请检查域名配置';throw e;}});}
$('test-local').onclick=()=>checkLocal($('test-local'));$('check-process').onclick=()=>checkLocal($('check-process'));
$('test-public').onclick=()=>checkPublic($('test-public'));$('check-external').onclick=()=>checkPublic($('check-external'));
$('import').onclick = () => task($('import'), async () => { const r = await call('import'); if (r) { dirty = false; render(await call('snapshot')); toast(r.message); } });
$('open-binding').onclick = () => page('settings'); $('show-access').onclick = () => page('access');
document.querySelectorAll('[data-protocol]').forEach(el => el.onclick = () => { selectProtocol(el.dataset.protocol); page('access'); });
function selectProtocol(protocol) { if (currentProtocol === protocol) return; currentProtocol = protocol; moveSelection($('protocol-tabs'), document.querySelector(`[data-tab="${protocol}"]`)); renderExample(); reveal($('example-code')); }
document.querySelectorAll('[data-tab]').forEach(el => el.onclick = () => selectProtocol(el.dataset.tab));
function renderExample() {
  if (!snapshot) return; const host = snapshot.config.hostname || 'api.example.com'; const model = $('example-model').value || 'MODEL_ID';
  const base = `https://${host}`; const quote = value => JSON.stringify(value);
  const specs = {
    openai: { url: `${base}/v1/chat/completions`, headers: ['Authorization: Bearer YOUR_ACCESS_KEY'], body: {model, messages:[{role:'user',content:'你好'}], stream:true} },
    anthropic: { url:`${base}/v1/messages`, headers:['x-api-key: YOUR_ACCESS_KEY','anthropic-version: 2023-06-01'], body:{model,max_tokens:1024,messages:[{role:'user',content:'你好'}],stream:true} },
    google: { url:`${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, headers:['x-goog-api-key: YOUR_ACCESS_KEY'], body:{contents:[{parts:[{text:'你好'}]}]} }
  };
  const s = specs[currentProtocol];
  $('example-code').textContent = `curl.exe -N ${quote(s.url)}\n` + s.headers.map(h => `  -H ${quote(h)}\n`).join('') + `  -H "Content-Type: application/json"\n  -d '${JSON.stringify(s.body)}'`;
  // A single line works in PowerShell without fragile shell-specific continuations.
  $('example-code').textContent = $('example-code').textContent.replace(/\n/g, ' ');
}
$('example-model').oninput = renderExample;
function showModels(models) { $('models').replaceChildren(); for (const model of models || []) { const b = document.createElement('button'); b.textContent = model; b.onclick = () => { $('example-model').value = model; renderExample(); }; $('models').appendChild(b); } }
async function copy(text) { await call('copy', text); toast('已复制'); }
$('copy-example').onclick = () => task(null, () => copy($('example-code').textContent));
$('copy-base').onclick = () => task(null, async () => { if (!snapshot.config.hostname) { toast('请先设置域名', true); return; } await copy(`https://${snapshot.config.hostname}`); });
$('copy-origin').onclick = () => task(null, () => copy($('origin-service').textContent));
$('copy-key').onclick = () => task(null, async () => { await call('copyKey',{id:$('access-key').value}); toast('访问密钥已复制'); });
$('rotate-key').textContent='管理密钥';$('rotate-key').onclick = () => page('keys');
async function changeSetting(patch) { const s = await call('save', {config:patch}); render(s); toast('设置已保存'); }
$('theme-toggle').onclick = () => task(null, () => changeSetting({theme:document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'}));
document.querySelectorAll('[data-theme]').forEach(el => el.onclick = () => task(el, () => changeSetting({theme:el.dataset.theme})));
$('transport').onchange = () => task(null, () => changeSetting({protocol:$('transport').value})); $('launchAtLogin').onchange = () => task(null, async () => { try { await changeSetting({launchAtLogin:$('launchAtLogin').checked}); } finally { render(await call('snapshot')); } });
$('imagesEnabled').onchange = () => task($('imagesEnabled'), async () => { try { await changeSetting({imagesEnabled:$('imagesEnabled').checked}); } finally { render(await call('snapshot')); } });
$('geminiImageCompatibility').onchange = () => task($('geminiImageCompatibility'), async () => { try { await changeSetting({geminiImageCompatibility:$('geminiImageCompatibility').checked}); } finally { render(await call('snapshot')); } });
$('diagnostic-model').onchange = () => task($('diagnostic-model'), async () => { try { await changeSetting({diagnosticModel:$('diagnostic-model').value}); } finally { render(await call('snapshot')); } });
$('refresh-diagnostic-models').onclick = () => task($('refresh-diagnostic-models'), async () => { if(dirty) await saveForm(); render(await call('refreshModels')); toast('模型列表已更新'); });
function renderDiagnosticModels() {
  const select=$('diagnostic-model'), selected=snapshot.config.diagnosticModel || '';
  const available=availableEntries(snapshot.config.diagnosticKeyId).map(row=>row.name).sort();
  select.replaceChildren(new Option('自动选择', ''));
  for(const id of available) select.add(new Option(id,id));
  if(selected&&!available.includes(selected)) select.add(new Option(`当前不可用：${selected}`,selected));
  select.value=selected;
}
document.querySelectorAll('[data-bind-tab]').forEach(el => el.onclick = () => { if(el.classList.contains('active')) return; moveSelection(el.parentElement, el); $('manual-binding').hidden = el.dataset.bindTab !== 'manual'; $('automatic-binding').hidden = el.dataset.bindTab !== 'automatic'; reveal(el.dataset.bindTab === 'manual' ? $('manual-binding') : $('automatic-binding')); });
$('automatic-binding').onsubmit = e => { e.preventDefault(); task(e.submitter, async () => { if (dirty) { toast('请先返回连接页保存域名', true); return; } try { const r = await call('bind', {apiToken:$('cf-token').value,accountId:$('cf-account').value.trim(),zoneId:$('cf-zone').value.trim()}); render(await call('snapshot')); toast(r.message); } finally { $('cf-token').value = ''; } }); };
for (const [id, action] of [['cloudflare','openCloudflare'],['guide','openGuide'],['open-data','openData'],['github-project','openRepository']]) $(id).onclick = () => task(null, () => call(action));
document.querySelectorAll('[data-record-tab]').forEach(el => el.onclick = () => { if(el.classList.contains('active')) return; moveSelection(el.parentElement, el); $('requests-table').hidden = el.dataset.recordTab !== 'requests'; $('record-key-filters').hidden=el.dataset.recordTab !== 'requests'; $('tunnel-logs').hidden = el.dataset.recordTab !== 'tunnel'; reveal(el.dataset.recordTab === 'requests' ? $('requests-table') : $('tunnel-logs')); });
const recordKeySelection=new Set();
$('record-filter-mode').onchange=renderRecords;
$('record-key-single').onchange=renderRecords;
function filteredRecords() {
  // Retain IDs from recent records so a renamed/deleted key can still be queried.
  const choices=new Map(snapshot.keys.map(key=>[key.id,key.name]));
  for(const record of snapshot.records)if(record.keyId && !choices.has(record.keyId))choices.set(record.keyId,record.keyName || '已删除的密钥');
  const single=$('record-key-single'),selected=single.value;
  replaceContent(single,[...choices].map(([id,name])=>`<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join('') || '<option value="">暂无密钥</option>');
  if(choices.has(selected))single.value=selected;
  const mode=$('record-filter-mode').value;
  $('record-single-field').hidden=mode!=='single';$('record-multiple-field').hidden=mode!=='multiple';
  replaceContent($('record-key-choices'),[...choices].map(([id,name])=>`<label><input type="checkbox" value="${escapeHTML(id)}" ${recordKeySelection.has(id)?'checked':''}><span>${escapeHTML(name)}</span></label>`).join('') || '<p class="note">暂无密钥</p>');
  for(const input of $('record-key-choices').querySelectorAll('input'))input.onchange=()=>{if(input.checked)recordKeySelection.add(input.value);else recordKeySelection.delete(input.value);renderRecords();};
  $('record-selection-summary').textContent=`已选择 ${[...recordKeySelection].filter(id=>choices.has(id)).length} 个密钥`;
  const records=snapshot.records.filter(row=>mode==='all' || (mode==='single'?!!single.value && row.keyId===single.value:recordKeySelection.has(row.keyId)));
  $('record-filter-count').textContent=`${records.length} 条请求`;
  return records;
}
const escapeHTML = value => String(value).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const clock = new Intl.DateTimeFormat('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const time = value => clock.format(new Date(value));
function descriptionRows(items) { return `<dl class="information-list">${items.map(([label,value])=>`<div><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(String(value))}</dd></div>`).join('')}</dl>`; }
function renderDiagnostics() {
  for (const [name,data] of [['local',snapshot.localDiagnostic],['public',snapshot.publicDiagnostic]]) {
    const summary=$(`${name}-diagnostic-summary`),steps=$(`${name}-diagnostic-steps`);
    summary.className='diagnostic-summary';
    if (!data) { summary.textContent=name==='local'?'尚未检测':'通过公网域名发送一条短模型请求'; steps.replaceChildren(); continue; }
    const metadata=[['检测时间',time(data.checkedAt)]];
    if (data.ms!==undefined) metadata.push(['耗时',`${(data.ms/1000).toLocaleString('zh-CN',{maximumFractionDigits:2})} 秒`]);
    if(replaceContent(summary,`<strong class="${data.ok?'diagnostic-ok':'diagnostic-error'}">${data.ok?'检测通过':'检测未通过'}</strong>${descriptionRows(metadata)}`)) reveal(summary);
    if(replaceContent(steps,data.steps.map(s=>`<div class="diagnostic-step"><span class="${s.ok?'diagnostic-ok':'diagnostic-error'}">${s.ok?'✓':'×'}</span><span>${escapeHTML(s.name)}</span><div>${s.facts?descriptionRows(s.facts):`<p>${escapeHTML(s.detail)}</p>`}</div></div>`).join(''))) [...steps.children].forEach((row,index)=>reveal(row,Math.min(index,5)*24));
  }
}
function renderRecords() {
  const requests=$('requests-table'),records=filteredRecords();
  if (!records.length) replaceContent(requests,`<div class="empty">${icon('file')}${$('record-filter-mode').value==='all'?'暂无请求':'所选密钥暂无请求'}</div>`);
  else {
    if(!requests.querySelector('tbody')) requests.innerHTML='<table><thead><tr><th>时间</th><th>密钥</th><th>方法</th><th>模型</th><th>路径</th><th>状态</th><th>耗时</th></tr></thead><tbody></tbody></table>';
    const occurrences=new Map();
    const rows=records.map(r=>{
      const signature=JSON.stringify([r.time,r.keyId,r.method,r.model,r.actualModel,r.path,r.status,r.ms]);
      const count=occurrences.get(signature)||0; occurrences.set(signature,count+1);
      return `<tr data-row-key="${escapeHTML(`${signature}:${count}`)}"><td>${time(r.time)}</td><td>${escapeHTML(r.keyName || '—')}</td><td>${escapeHTML(r.method)}</td><td class="record-model"><span>${escapeHTML(r.model || '—')}</span>${r.actualModel && r.actualModel!==r.model?`<small>实际模型：${escapeHTML(r.actualModel)}</small>`:''}</td><td class="path">${escapeHTML(r.path)}</td><td><span class="status-pill ${r.status >= 400 ? 'bad' : ''}">${r.status}</span></td><td>${r.ms} ms</td></tr>`;
    }).join('');
    reconcileRows(requests.querySelector('tbody'),rows,row=>row.dataset.rowKey);
  }
  const logs=$('tunnel-logs'), occurrences=new Map();
  if(!snapshot.logs.length) replaceContent(logs,`<div class="empty">${icon('plug')}暂无隧道记录</div>`);
  else reconcileRows(logs,snapshot.logs.map(l=>{
    const signature=JSON.stringify([l.time,l.text]), count=occurrences.get(signature)||0; occurrences.set(signature,count+1);
    return `<div class="log-line" data-row-key="${escapeHTML(`${signature}:${count}`)}"><time>${time(l.time)}</time><span>${escapeHTML(l.text)}</span></div>`;
  }).join(''),row=>row.dataset.rowKey);
}
function canonicalModel(id) { return id.trim().replace(/^models\//i,'').toLowerCase(); }
function renderModelCatalog() {
  const known = snapshot.config.knownModels || [], disabled = new Set(snapshot.config.disabledModels || []);
  const available=new Set(known.map(canonicalModel)),exposures=new Map();
  for(const entry of snapshot.modelEntries || []){if(!exposures.has(entry.modelId))exposures.set(entry.modelId,[]);exposures.get(entry.modelId).push(entry.name);}
  const rows = new Map((snapshot.config.modelRules || []).map(rule=>[canonicalModel(rule.actual),{id:rule.actual,rule,available:available.has(canonicalModel(rule.actual))}]));
  for (const id of disabled) if (!rows.has(id)) rows.set(id, { id, available:false });
  const query = $('model-search').value.trim().toLowerCase();
  const visible = [...rows.values()].filter(row => row.id.toLowerCase().includes(query));
  const open = known.filter(id => !disabled.has(canonicalModel(id))).length;
  if(replaceContent($('catalog-summary'),snapshot.config.modelsUpdatedAt ? descriptionRows([['模型总数',known.length],['对外开放',open],['更新时间',new Date(snapshot.config.modelsUpdatedAt).toLocaleString('zh-CN',{hour12:false})]]) : '从本地代理获取可用模型')) reveal($('catalog-summary'));
  const catalogHTML = visible.length ? visible.map(row => { const enabled = row.available && !disabled.has(canonicalModel(row.id)),rule=row.rule; return `<div class="catalog-row"><div><code>${escapeHTML(row.id)}</code><p class="${row.available ? '' : 'unavailable-model'}">${row.available ? (enabled ? '全局开放' : '全局已关闭') : '已下架，全局已关闭'}</p><p class="alias-summary">对外 ID：${escapeHTML((exposures.get(rule?.id) || []).join('、') || row.id)}</p></div><div class="catalog-actions">${rule?`<button class="secondary" data-edit-alias="${rule.id}">编辑对外 ID</button>`:''}${!row.available && rule ? `<button class="secondary danger-text" data-delete-model="${rule.id}">删除</button>` : ''}<button type="button" class="model-switch" role="switch" aria-checked="${enabled}" aria-label="${escapeHTML(row.id)} 外部访问" data-modelid="${escapeHTML(row.id)}" ${pending || !row.available ? 'disabled' : ''}><span></span></button></div></div>`; }).join('') : `<div class="empty">${query ? '没有匹配的模型' : '点击「从代理获取」加载模型'}</div>`;
  reconcileRows($('catalog-list'),catalogHTML,row=>row.querySelector('[data-modelid]')?.dataset.modelid || `empty:${row.textContent}`,(row,next)=>{
    const control=row.querySelector('[data-modelid]'), incoming=next.querySelector('[data-modelid]');
    if(!control) return;
    control.setAttribute('aria-checked',incoming.getAttribute('aria-checked')); control.disabled=incoming.disabled;
    const detail=row.querySelector('p'), text=next.querySelector('p').textContent;
    detail.className=next.querySelector('p').className;if(detail.textContent!==text) {detail.textContent=text;reveal(detail);}
    if(!!row.querySelector('[data-delete-model]')!==!!next.querySelector('[data-delete-model]'))row.querySelector('.catalog-actions').replaceWith(next.querySelector('.catalog-actions'));
    const summary=row.querySelector('.alias-summary');if(summary)summary.textContent=next.querySelector('.alias-summary').textContent;
  });
  $('catalog-list').querySelectorAll('[data-delete-model]').forEach(button=>button.onclick=()=>{deleteModelId=button.dataset.deleteModel;const rule=snapshot.config.modelRules.find(row=>row.id===deleteModelId);$('model-delete-message').textContent=`将删除 ${rule.actual} 的别名和密钥权限设置。`;$('model-delete-dialog').showModal();});
  $('catalog-list').querySelectorAll('[data-edit-alias]').forEach(button=>button.onclick=()=>openAliasEditor(button.dataset.editAlias));
  $('catalog-list').querySelectorAll('[data-modelid]').forEach(button => button.onclick = async () => {
    await task(button, async () => { render(await call('setModelAccess', { model:button.dataset.modelid, enabled:button.getAttribute('aria-checked') !== 'true' })); toast('模型访问设置已保存'); });
    renderModelCatalog();
  });
}
let deleteModelId;
$('cancel-model-delete').onclick=()=>$('model-delete-dialog').close();
$('confirm-model-delete').onclick=()=>task($('confirm-model-delete'),async()=>{render(await call('deleteModel',{id:deleteModelId}));$('model-delete-dialog').close();toast('模型已删除');});
let refreshIntervalDirty=false;
function renderModelRefreshSettings(){
  $('refreshModelsOnStartup').checked=snapshot.config.refreshModelsOnStartup;
  if(refreshIntervalDirty)return;
  const minutes=snapshot.config.modelRefreshMinutes;
  $('model-refresh-mode').value=minutes?'interval':'off';
  $('model-refresh-form').hidden=!minutes;
  $('modelRefreshMinutes').value=minutes || 30;
}
$('refreshModelsOnStartup').onchange=()=>task($('refreshModelsOnStartup'),async()=>{try{await changeSetting({refreshModelsOnStartup:$('refreshModelsOnStartup').checked});}finally{render(await call('snapshot'));}});
$('model-refresh-mode').onchange=()=>{
  const enabled=$('model-refresh-mode').value==='interval';
  if(enabled){refreshIntervalDirty=true;$('model-refresh-form').hidden=false;$('modelRefreshMinutes').focus();}
  else task($('model-refresh-mode'),async()=>{try{await changeSetting({modelRefreshMinutes:0});}finally{refreshIntervalDirty=false;render(await call('snapshot'));}});
};
$('modelRefreshMinutes').oninput=()=>{refreshIntervalDirty=true;};
$('model-refresh-form').onsubmit=e=>{e.preventDefault();task(e.submitter,async()=>{await changeSetting({modelRefreshMinutes:Number($('modelRefreshMinutes').value)});refreshIntervalDirty=false;renderModelRefreshSettings();});};
$('model-search').oninput = renderModelCatalog;
$('refresh-models').onclick = async () => { await task($('refresh-models'), async () => { if (dirty) await saveForm(); render(await call('refreshModels')); toast('模型列表已更新'); }); renderModelCatalog(); };
$('clear-records').onclick = () => task(null, () => call('clearLogs'));
let displayedRelease='',expandedRelease='';
function renderReleaseNotes(text){
 const body=$('update-notes-body');body.replaceChildren();let list=null;
 for(const line of (text || '该版本未提供更新日志。').split(/\r?\n/)){
  const bullet=/^\s*([-*]|\d+\.)\s+(.+)$/.exec(line),heading=/^#{1,6}\s+(.+)$/.exec(line);
  if(heading && [snapshot.update?.detectedVersion,'v'+snapshot.update?.detectedVersion].includes(heading[1]))continue;
  if(bullet){const tag=bullet[1].endsWith('.')?'ol':'ul';if(!list || list.tagName.toLowerCase()!==tag){list=document.createElement(tag);body.append(list);}const item=document.createElement('li');item.textContent=bullet[2];list.append(item);}
  else {list=null;if(!line.trim())continue;const node=document.createElement(heading?'h3':'p');node.textContent=heading?heading[1]:line;body.append(node);}
 }
}
function renderUpdates(){
 const u=snapshot.update || {},active=['checking','downloading','installing'].includes(u.phase);
 const detected=u.detectedVersion || u.availableVersion;
 $('update-current').textContent=detected?snapshot.version+' → '+detected:'当前版本 '+snapshot.version;
 $('update-message').textContent=u.supported===false?'请使用发行版检测更新':u.message || '尚未检测更新';
 $('check-update').disabled=active || u.supported===false;
 $('check-update').textContent=u.phase==='checking'?'正在检测':'检测更新';
 $('download-update').hidden=!u.canDownload;
 $('download-update').disabled=active;
 $('download-update').textContent=u.phase==='ready'?'立即更新':'下载并更新';
 if(u.phase==='downloading'){$('download-update').hidden=false;$('download-update').textContent='正在下载';}
 $('update-source').value=u.source || snapshot.config.updateSource || 'github';
 $('update-source').disabled=active || u.phase==='ready';
 const release=detected?`${u.source}:${detected}`:'';
 $('update-notes').hidden=!release;
 if(release!==displayedRelease){$('update-notes').open=!!u.availableVersion;displayedRelease=release;}
 if(u.availableVersion && release!==expandedRelease){$('update-notes').open=true;expandedRelease=release;}
 // A later verified manifest may add notes after the version is first known.
 if($('update-notes-body').dataset.notes!==(u.releaseNotes || '') || !$('update-notes-body').childElementCount){renderReleaseNotes(u.releaseNotes);$('update-notes-body').dataset.notes=u.releaseNotes || '';}
 $('update-notes-version').textContent=detected || '';
 const published=new Date(u.publishedAt);
 $('update-published').hidden=!u.publishedAt || !Number.isFinite(published.getTime());
 $('update-published').textContent=$('update-published').hidden?'':'发布时间：'+published.toLocaleString('zh-CN',{year:'numeric',month:'long',day:'numeric'});
 $('update-progress-row').hidden=u.phase!=='downloading';
 $('update-progress').value=u.progress || 0;$('update-percent').textContent=(u.progress || 0)+'%';
 const mb=value=>((value || 0)/1024/1024).toFixed(1)+' MB';
 $('update-bytes').textContent='已下载 '+mb(u.downloadedBytes)+' / '+mb(u.totalBytes);
 $('update-speed').textContent='下载速度 '+mb(u.bytesPerSecond)+'/s';
}
$('update-source').onchange=()=>task($('update-source'),async()=>{try{await call('setUpdateSource',{source:$('update-source').value});}finally{render(await call('snapshot'));}});
$('check-update').onclick=()=>task($('check-update'),async()=>{await call('checkUpdates');});
$('download-update').onclick=()=>task($('download-update'),async()=>{if(dirty || keyDirty || refreshIntervalDirty){toast('请先保存未完成的修改',true);return;}await call(snapshot.update?.phase==='ready'?'installUpdate':'downloadUpdate');});
function receiveRecords(data){
  if(!snapshot)return;
  snapshot.records=data.records;snapshot.logs=data.logs;
  if(currentPage==='records')renderRecords();
}
initManagement();
if (window.bridge) { window.bridge.onUpdate(render);window.bridge.onRecords(receiveRecords); call('snapshot').then(render).catch(() => {}); }
else { $('status-message').textContent = '请使用桌面应用启动'; }
