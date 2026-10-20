const fs = require('node:fs');const crypto = require('node:crypto');
(async()=>{
  const commit='8a1b2821bb768c484fe8da20c5e1838b6bf551a9';const base=`https://raw.githubusercontent.com/lobehub/lobe-icons/${commit}`;
  fs.mkdirSync('ui/brands',{recursive:true});fs.mkdirSync('licenses',{recursive:true});const manifest={repository:'https://github.com/lobehub/lobe-icons',commit,icons:[]};
  for(const name of ['openai','anthropic','google']){
    const source=`${base}/packages/static-svg/icons/${name}.svg`;const r=await fetch(source,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`${name}: HTTP ${r.status}`);
    const svg=await r.text();if(!svg.includes('<svg')||/<script|\bon\w+\s*=|<foreignObject|(?:href|src)\s*=\s*["']https?:/i.test(svg))throw new Error('Unexpected SVG content');
    fs.writeFileSync(`ui/brands/${name}.svg`,svg);manifest.icons.push({name,source,sha256:crypto.createHash('sha256').update(svg).digest('hex')});
  }
  const r=await fetch(`${base}/LICENSE`,{signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('License unavailable');fs.writeFileSync('licenses/Lobe-Icons-LICENSE.txt',await r.text());
  fs.writeFileSync('ui/brands/sources.json',JSON.stringify(manifest,null,2));console.log('Downloaded and inspected OpenAI, Anthropic and Google logos');
})().catch(e=>{console.error(e);process.exitCode=1;});
