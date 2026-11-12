let displayedChartRange = '3h';
async function renderCallChart() {
  const root = document.getElementById('call-chart-view');
  if (!root || root.hidden) return;
  const range = document.getElementById('chart-range').value;
  displayedChartRange = range;
  let result;
  try { result = await call('getCallChart', {range}); } catch { return; }
  if (range !== displayedChartRange || root.hidden) return;
  document.getElementById('chart-total').textContent = '调用次数 ' + result.total.toLocaleString('zh-CN');
  const host = document.getElementById('chart-bars');
  host.replaceChildren();
  const max = Math.max(1, ...result.bars.map(bar => bar.count));
  const fragment = document.createDocumentFragment();
  for (const bar of result.bars) {
    const cell = document.createElement('div'); cell.className = 'chart-cell';
    cell.title = bar.label + '，' + bar.count + ' 次';
    cell.setAttribute('aria-label', cell.title);
    const num = document.createElement('span'); num.className = 'chart-number'; num.textContent = String(bar.count);
    const wrap = document.createElement('div'); wrap.className = 'chart-column-wrap';
    const column = document.createElement('span'); column.className = 'chart-column';
    column.dataset.height = String(bar.count ? Math.max(3, Math.round(bar.count / max * 194)) : 0);
    wrap.append(column);
    const label = document.createElement('span'); label.className = 'chart-label'; label.textContent = bar.label;
    cell.append(num, wrap, label); fragment.append(cell);
  }
  host.append(fragment);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const column of host.querySelectorAll('.chart-column')) column.style.height = column.dataset.height + 'px';
  }));
}
document.getElementById('chart-range').onchange = () => { void renderCallChart(); };
