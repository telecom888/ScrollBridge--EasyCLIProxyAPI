const fs = require('node:fs');
const path = require('node:path');
const { encryptSecrets, decryptSecrets } = require('./secrets-crypto.cjs');

const RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
const ALLOWED_RANGES = new Set(['3h', '6h', '24h', 'today', '7d', '30d']);
function countable(record) {
  return record && record.actualModel && record.model && record.method === 'POST';
}
function rangeBounds(range, now) {
  const end = new Date(now);
  if (!Number.isFinite(end.getTime()) || !ALLOWED_RANGES.has(range)) throw Error('无效的图表时间范围');
  const day = new Date(end); day.setHours(0, 0, 0, 0);
  if (range === 'today') return {start: day.getTime(), step: 3600000, count: 24, end: end.getTime()};
  if (range === '7d' || range === '30d') {
    const count = range === '7d' ? 7 : 30;
    const start = new Date(day); start.setDate(start.getDate() - count + 1);
    return {start: start.getTime(), step: 86400000, count, end: end.getTime(), calendar: true};
  }
  const duration = range === '3h' ? 3 * 3600000 : range === '6h' ? 6 * 3600000 : 24 * 3600000;
  const step = range === '3h' ? 900000 : range === '6h' ? 1800000 : 3600000;
  return {start: Math.floor((end.getTime() - duration) / step) * step, step, count: Math.ceil(duration / step) + 1, end: end.getTime()};
}
function buildChart(points, range, now = Date.now()) {
  const bounds = rangeBounds(range, now), grouped = new Map();
  for (const [timestamp, count] of points) {
    if (timestamp >= bounds.start && timestamp <= bounds.end) {
      const day = bounds.calendar ? new Date(timestamp) : null;
      if (day) day.setHours(0, 0, 0, 0);
      const slot = bounds.calendar ? day.getTime() : Math.floor((timestamp - bounds.start) / bounds.step);
      grouped.set(slot, (grouped.get(slot) || 0) + count);
    }
  }
  const result = [];
  for (let i = 0; i < bounds.count; i++) {
    const stamp = bounds.calendar ? new Date(new Date(bounds.start).setDate(new Date(bounds.start).getDate() + i)).getTime() : bounds.start + i * bounds.step;
    if (stamp > bounds.end) break;
    const value = grouped.get(bounds.calendar ? stamp : i) || 0;
    const date = new Date(stamp);
    const label = bounds.calendar
      ? `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`
      : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    result.push({timestamp: stamp, label, count: value});
  }
  return {range, total: result.reduce((sum, point) => sum + point.count, 0), bars: result};
}
class CallStats {
  constructor(directory, options = {}) {
    this.filename = path.join(directory, 'call-stats.json');
    this.now = options.now || Date.now;
    this.points = new Map();
    this.timer = null;
    this.dirty = false;
    const text = (() => { try { return fs.readFileSync(this.filename, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } })();
    if (text) {
      let parsed;
      try {
        const envelope = JSON.parse(text);
        if (envelope.version !== 1 || typeof envelope.encrypted !== 'string') throw Error('格式无效');
        parsed = JSON.parse(decryptSecrets(envelope.encrypted));
        if (!Array.isArray(parsed.points)) throw Error('统计数据无效');
      } catch { throw Error('调用统计文件损坏或无法解密，请先备份 call-stats.json'); }
      for (const row of parsed.points) {
        if (!Array.isArray(row) || row.length !== 2 || !Number.isFinite(row[0]) ||
            !Number.isSafeInteger(row[1]) || row[1] < 0) throw Error('调用统计文件包含无效记录');
        this.points.set(row[0], row[1]);
      }
    }
    this.prune();
    this.pruneTimer=setInterval(()=>this.prune(),3600000);
    this.pruneTimer.unref?.();
  }
  prune() {
    const cutoff = this.now() - RETENTION_MS;
    let changed = false;
    for (const time of this.points.keys()) if (time < cutoff || time > this.now() + 3600000) { this.points.delete(time); changed = true; }
    if (changed) this.schedule();
  }
  record(event) {
    if (!countable(event)) return;
    const when = Date.parse(event.time);
    if (!Number.isFinite(when) || when < this.now() - RETENTION_MS || when > this.now() + 60000) return;
    const bucket = Math.floor(when / 60000) * 60000;
    this.points.set(bucket, (this.points.get(bucket) || 0) + 1);
    this.prune();
    this.schedule();
  }
  chart(range) { this.prune(); return buildChart(this.points, range, this.now()); }
  schedule() {
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; try { this.flush(); } catch (error) { process.emitWarning('调用统计保存失败：' + error.message); } }, 1000);
      this.timer.unref?.();
    }
  }
  flush() {
    if (!this.dirty) return;
    const text = JSON.stringify({version: 1, encrypted: encryptSecrets(JSON.stringify({points: [...this.points].sort((a,b)=>a[0]-b[0])}))});
    fs.mkdirSync(path.dirname(this.filename), {recursive: true});
    const temp = this.filename + '.tmp';
    fs.writeFileSync(temp, text, {mode: 0o600});
    fs.renameSync(temp, this.filename);
    this.dirty = false;
  }
  close() { if (this.timer) clearTimeout(this.timer); if(this.pruneTimer)clearInterval(this.pruneTimer); this.timer = null; this.prune(); if(this.timer)clearTimeout(this.timer);this.timer=null;this.flush(); }
}
module.exports = { CallStats, buildChart, rangeBounds, countable, RETENTION_MS };
