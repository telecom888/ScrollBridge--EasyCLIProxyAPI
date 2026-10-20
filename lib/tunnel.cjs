const { spawn } = require('node:child_process');
const fs = require('node:fs');
function startTunnel({ executable, token, protocol, onState, onLog }) {
  if (!fs.existsSync(executable)) throw new Error('未找到 cloudflared，请重新安装完整应用');
  if (!/^[A-Za-z0-9_+/=-]{50,8192}$/.test(token || '')) throw new Error('隧道令牌格式不正确，请只粘贴 eyJ 开头的令牌');
  // Token is scoped to the child's environment, never command line or plaintext disk.
  const child = spawn(executable, ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--protocol', protocol, 'run'], { windowsHide: true, env: {...process.env, TUNNEL_TOKEN: token}, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false; let registered = false; const connections = new Set();
  const buffers = { stdout: '', stderr: '' };
  const consume = (stream, chunk) => {
    buffers[stream] += chunk.toString(); const lines = buffers[stream].split(/\r?\n/); buffers[stream] = lines.pop().slice(-8192);
    for (let line of lines) {
      line = line.replaceAll(token, '[redacted]').replace(/eyJ[A-Za-z0-9_+/=-]{40,}/g, '[redacted]').slice(0, 1000);
      if (line.includes('Registered tunnel connection')) { registered = true; connections.add(line.match(/connIndex=(\d+)/)?.[1] || '0'); onState('connected'); }
      if (/Unregistered tunnel connection|Connection terminated|failed to serve tunnel connection/i.test(line)) { connections.delete(line.match(/connIndex=(\d+)/)?.[1] || '0'); if (!connections.size && registered) onState('reconnecting'); }
      onLog(line);
    }
  };
  child.stdout.on('data', x => consume('stdout', x)); child.stderr.on('data', x => consume('stderr', x));
  child.on('error', () => { if (!stopped) onState('error', '无法启动隧道进程'); });
  child.on('exit', code => { if (!stopped) onState('error', `隧道已退出 (${code})，请检查令牌和网络`); });
  return { stop: async () => { stopped = true; if (child.exitCode !== null || child.signalCode !== null) return; child.kill(); let timer; await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => {timer=setTimeout(resolve,3000);})]); clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } };
}
module.exports = { startTunnel };
