const { execFileSync } = require('node:child_process');
const fs = require('node:fs'); const path = require('node:path');
for (const dir of ['lib', 'electron', 'scripts', 'tests', 'ui']) for (const f of fs.readdirSync(dir)) if (/\.(cjs|js)$/.test(f)) execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'inherit' });
console.log('Syntax checks passed');
