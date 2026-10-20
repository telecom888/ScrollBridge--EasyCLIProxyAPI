const $ = id => document.getElementById(id);
const icons = {
  plug:'<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v4"/>',
  code:'<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8m-8 4h6"/>',
  settings:'<path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3 3-1 1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-2Z"/><circle cx="12" cy="12" r="3"/>',
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
async function task(button, fn) { if (pending) return; pending = true; if (button) button.disabled = true; try { await fn(); } catch {} finally { pending = false; if (button) button.disabled = false; } }
function page(name) { currentPage = name; document.querySelectorAll('.page').forEach(el => el.hidden = el.id !== `page-${name}`); document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', el.dataset.page === name)); $('page-title').textContent = {connection:'连接',access:'接入',records:'记录',settings:'设置'}[name]; }
document.querySelectorAll('[data-page]').forEach(el => el.onclick = () => page(el.dataset.page));
function applyTheme(theme) { const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme; document.documentElement.dataset.theme = resolved; $('theme-toggle').innerHTML = icon(resolved === 'dark' ? 'sun' : 'moon'); document.querySelectorAll('[data-theme]').forEach(el => el.classList.toggle('active', el.dataset.theme === theme)); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (snapshot?.config.theme === 'system') applyTheme('system'); });
function fillForm(s) { for (const k of ['upstream','port','hostname']) $(k).value = s.config[k]; $('upstreamKey').placeholder = s.hasUpstreamKey ? '已加密保存 · 留空保持不变' : '本地代理的客户端 API Key'; $('tunnelToken').placeholder = s.hasTunnelToken ? '已加密保存 · 留空保持不变' : '粘贴 eyJ 开头的令牌'; $('transport').value = s.config.protocol; $('launchAtLogin').checked = s.config.launchAtLogin; }
function render(s) {
  snapshot = s; applyTheme(s.config.theme); if (!dirty) fillForm(s);
  const titles = { stopped:'未连接', starting:'正在连接', connected:'隧道已连接', reconnecting:'正在重连', error:'连接异常' };
  $('status-title').textContent = titles[s.status]; $('status-message').textContent = s.message || ({stopped:'配置域名与隧道后启动连接',starting:'正在建立加密隧道',connected:'可检测域名 HTTPS 和外部访问',reconnecting:'正在恢复与 Cloudflare 的连接',error:'请检查配置和隧道记录'}[s.status]);
  $('status-dot').className = `status-dot ${s.status}`;
  const running = ['starting','connected','reconnecting'].includes(s.status) || s.gatewayRunning;
  $('connect-label').textContent = running ? '停止连接' : (s.status === 'error' ? '停止并重置' : '启动连接'); $('connect').querySelector('[data-icon]').innerHTML = icon(running || s.status === 'error' ? 'stop' : 'play');
  for (const id of lockedControls) { $(id).disabled = running; lockHints.get(id).hidden = !running; }
  $('route-upstream').textContent = s.config.upstream.replace(/^https?:\/\//,''); $('route-host').textContent = s.config.hostname || '尚未配置'; $('public-base').textContent = s.config.hostname ? `https://${s.config.hostname}` : '请先配置域名'; $('origin-service').textContent = `http://127.0.0.1:${s.config.port}`;
  $('version').textContent = `v${s.version}`; $('saved-indicator').textContent = dirty ? '尚未保存' : '配置已保存'; renderExample(); renderRecords(); renderDiagnostics();
}
for (const id of ['upstream','port','hostname','upstreamKey','tunnelToken']) $(id).addEventListener('input', () => { dirty = true; $('saved-indicator').textContent = '尚未保存'; });
async function saveForm() { const s = await call('save', { config: {upstream:$('upstream').value,port:Number($('port').value),hostname:$('hostname').value}, upstreamKey:$('upstreamKey').value,tunnelToken:$('tunnelToken').value }); dirty = false; $('upstreamKey').value = ''; $('tunnelToken').value = ''; render(s); }
$('connection-form').onsubmit = e => { e.preventDefault(); task(e.submitter, async () => { await saveForm(); toast('配置已保存'); }); };
$('connect').onclick = () => task($('connect'), async () => { if (snapshot.status !== 'stopped') { render(await call('stop')); return; } if (dirty) await saveForm(); render(await call('start')); });
async function checkLocal(button) {await task(button,async()=>{if(dirty)await saveForm();$('local-diagnostic-summary').textContent='正在检查进程、监听端口和模型接口…';const result=await call('testLocal');toast(result.message,!result.ok);showModels(result.models);});}
async function checkPublic(button) {await task(button,async()=>{if(dirty)await saveForm();$('public-diagnostic-summary').textContent='正在通过公网 HTTPS 检查网关与模型响应…';try{const result=await call('testPublic');toast(result.message,!result.ok);}catch(e){$('public-diagnostic-summary').textContent='检测未完成，请检查域名配置';throw e;}});}
$('test-local').onclick=()=>checkLocal($('test-local'));$('check-process').onclick=()=>checkLocal($('check-process'));
$('test-public').onclick=()=>checkPublic($('test-public'));$('check-external').onclick=()=>checkPublic($('check-external'));
$('import').onclick = () => task($('import'), async () => { const r = await call('import'); if (r) { dirty = false; render(await call('snapshot')); toast(r.message); } });
$('open-binding').onclick = () => page('settings'); $('show-access').onclick = () => page('access');
document.querySelectorAll('[data-protocol]').forEach(el => el.onclick = () => { selectProtocol(el.dataset.protocol); page('access'); });
function selectProtocol(protocol) { currentProtocol = protocol; document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === protocol)); renderExample(); }
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
$('copy-key').onclick = () => task(null, async () => { await call('copyKey'); toast('访问密钥已复制'); });
$('rotate-key').onclick = () => $('confirm-dialog').showModal(); $('cancel-rotate').onclick = () => $('confirm-dialog').close();
$('confirm-rotate').onclick = () => task($('confirm-rotate'), async () => { await call('rotateKey'); $('confirm-dialog').close(); toast('密钥已更换，请更新外部客户端'); });
async function changeSetting(patch) { const s = await call('save', {config:patch}); render(s); toast('设置已保存'); }
$('theme-toggle').onclick = () => task(null, () => changeSetting({theme:document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'}));
document.querySelectorAll('[data-theme]').forEach(el => el.onclick = () => task(el, () => changeSetting({theme:el.dataset.theme})));
$('transport').onchange = () => task(null, () => changeSetting({protocol:$('transport').value})); $('launchAtLogin').onchange = () => task(null, () => changeSetting({launchAtLogin:$('launchAtLogin').checked}));
document.querySelectorAll('[data-bind-tab]').forEach(el => el.onclick = () => { document.querySelectorAll('[data-bind-tab]').forEach(b => b.classList.toggle('active', b === el)); $('manual-binding').hidden = el.dataset.bindTab !== 'manual'; $('automatic-binding').hidden = el.dataset.bindTab !== 'automatic'; });
$('automatic-binding').onsubmit = e => { e.preventDefault(); task(e.submitter, async () => { if (dirty) { toast('请先返回连接页保存域名', true); return; } try { const r = await call('bind', {apiToken:$('cf-token').value,accountId:$('cf-account').value.trim(),zoneId:$('cf-zone').value.trim()}); render(await call('snapshot')); toast(r.message); } finally { $('cf-token').value = ''; } }); };
for (const [id, action] of [['cloudflare','openCloudflare'],['guide','openGuide'],['open-data','openData']]) $(id).onclick = () => task(null, () => call(action));
document.querySelectorAll('[data-record-tab]').forEach(el => el.onclick = () => { document.querySelectorAll('[data-record-tab]').forEach(b => b.classList.toggle('active', b === el)); $('requests-table').hidden = el.dataset.recordTab !== 'requests'; $('tunnel-logs').hidden = el.dataset.recordTab !== 'tunnel'; });
const escapeHTML = value => String(value).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const time = value => new Date(value).toLocaleTimeString('zh-CN', {hour12:false});
function renderDiagnostics(){for(const[name,data]of[['local',snapshot.localDiagnostic],['public',snapshot.publicDiagnostic]]){const summary=$(`${name}-diagnostic-summary`),steps=$(`${name}-diagnostic-steps`);summary.textContent=data?`${data.ok?'正常':'异常'} · ${time(data.checkedAt)}${data.ms!==undefined?' · '+data.ms+' ms':''}`:(name==='local'?'尚未检测':'通过公网域名发送一条短模型请求');summary.className=data?(data.ok?'diagnostic-ok':'diagnostic-error'):'';steps.innerHTML=data?data.steps.map(s=>`<div class="diagnostic-step"><span class="${s.ok?'diagnostic-ok':'diagnostic-error'}">${s.ok?'✓':'×'}</span><span>${escapeHTML(s.name)}</span><span>${escapeHTML(s.detail)}</span></div>`).join(''):'';}}
function renderRecords() {
  $('requests-table').innerHTML = !snapshot.records.length ? `<div class="empty">${icon('file')}暂无请求</div>` : `<table><thead><tr><th>时间</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th></tr></thead><tbody>${snapshot.records.map(r => `<tr><td>${time(r.time)}</td><td>${escapeHTML(r.method)}</td><td class="path">${escapeHTML(r.path)}</td><td><span class="status-pill ${r.status >= 400 ? 'bad' : ''}">${r.status}</span></td><td>${r.ms} ms</td></tr>`).join('')}</tbody></table>`;
  $('tunnel-logs').innerHTML = !snapshot.logs.length ? `<div class="empty">${icon('plug')}暂无隧道记录</div>` : snapshot.logs.map(l => `<div class="log-line"><time>${time(l.time)}</time><span>${escapeHTML(l.text)}</span></div>`).join('');
}
$('clear-records').onclick = () => task(null, () => call('clearLogs'));
if (window.bridge) { window.bridge.onUpdate(render); call('snapshot').then(render).catch(() => {}); }
else { $('status-message').textContent = '请使用桌面应用启动'; }
