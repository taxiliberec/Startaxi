import {access,readFile,writeFile,mkdir,rm} from 'node:fs/promises';

const files={
  'customer/index.html':'text/html','customer/style.css':'text/css','customer/app.js':'text/javascript',
  'customer/manifest.webmanifest':'application/manifest+json','customer/sw.js':'text/javascript',
  'index.html':'text/html','style.css':'text/css','app.js':'text/javascript','model.js':'text/javascript',
  'manifest.webmanifest':'application/manifest+json','sw.js':'text/javascript',
  'taximetr.svg':'image/svg+xml','taximetr-192.png':'image/png','taximetr-512.png':'image/png'
};
const publicDir=await access('Public').then(()=> 'Public',()=> 'public');
const assets=Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name,type])=>{
  const binary=type==='image/png';
  const content=await readFile(publicDir+'/'+name,binary?undefined:'utf8');
  return ['/'+name,[binary?type:type+'; charset=utf-8',binary?content.toString('base64'):content,binary]];
})));
const model=assets['/model.js'][1].replace(/^export /gm,'');
const customer=await readFile('customer-api.js','utf8');
const worker=(await readFile('worker.js','utf8')).replace(/^import .*;\n/gm,'');
await rm('dist/server',{recursive:true,force:true});
await mkdir('dist/server',{recursive:true});
await writeFile('dist/server/index.js','const assets = '+JSON.stringify(assets)+';\n'+model+'\n'+customer+'\n'+worker);
