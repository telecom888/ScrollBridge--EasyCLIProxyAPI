const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
(async () => {
  // Pinned to the digest published on GitHub's official release asset page.
  const release = { tag_name: '2026.10.3' };
  const asset = { browser_download_url: `https://github.com/cloudflare/cloudflared/releases/download/${release.tag_name}/cloudflared-windows-amd64.exe`, digest: 'sha256:76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2' };
  const r = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) }); if (!r.ok) throw new Error(`Download ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer()); const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (`sha256:${sha256}` !== asset.digest) throw new Error('cloudflared checksum mismatch');
  fs.mkdirSync('vendor', { recursive: true }); fs.writeFileSync(path.join('vendor', 'cloudflared.exe'), bytes);
  fs.writeFileSync(path.join('vendor', 'manifest.json'), JSON.stringify({ version: release.tag_name, source: asset.browser_download_url, sha256, license: 'Apache-2.0' }, null, 2));
  const license = await fetch(`https://raw.githubusercontent.com/cloudflare/cloudflared/${release.tag_name}/LICENSE`, { signal: AbortSignal.timeout(30000) }); if (!license.ok) throw new Error('License download failed');
  fs.writeFileSync('vendor/LICENSE-cloudflared.txt', await license.text()); console.log(`cloudflared ${release.tag_name} verified: ${sha256}`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
