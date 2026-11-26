import {access,readFile,writeFile,mkdir,rm} from 'node:fs/promises';

const files={
  'address-search.js':'text/javascript','address-client.js':'text/javascript',
  'customer/index.html':'text/html','customer/style.css':'text/css','customer/app.js':'text/javascript',
  'customer/icon-192.png':'image/png','customer/icon-512.png':'image/png',
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
for(const [name,type] of [['leaflet.css','text/css'],['leaflet.js','text/javascript']]){
  assets['/customer/'+name]=[type+'; charset=utf-8',await readFile('node_modules/leaflet/dist/'+name,'utf8'),false];
}
for(const [name,path,type] of [
  ['maplibre-gl.js','maplibre-gl/dist/maplibre-gl.js','text/javascript'],
  ['maplibre-gl.css','maplibre-gl/dist/maplibre-gl.css','text/css'],
  ['leaflet-maplibre-gl.js','@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js','text/javascript']
]){
  assets['/customer/'+name]=[type+'; charset=utf-8',await readFile('node_modules/'+path,'utf8'),false];
}
const addressRows=await readFile('data/liberec.json','utf8');
const centres=JSON.parse(await readFile('data/street-centres.json','utf8'));
const searchSource=assets['/address-search.js'][1];
const {addressBucket}=await import('data:text/javascript;base64,'+Buffer.from(searchSource).toString('base64'));
const buckets=new Map();
function bucket(name){
  const key=addressBucket(name);
  if(!buckets.has(key)) buckets.set(key,{rows:[],centres:{}});
  return buckets.get(key);
}
for(const row of JSON.parse(addressRows)) bucket(row[0]).rows.push(row);
for(const [name,point] of Object.entries(centres)) bucket(name).centres[name]=point;
for(const [key,data] of buckets) assets['/addresses/'+key+'.json']=['application/json',JSON.stringify(data),false];
const model=assets['/model.js'][1].replace(/^export /gm,'');
const customer=await readFile('customer-api.js','utf8');
const worker=(await readFile('worker.js','utf8')).replace(/^import .*;\n/gm,'');
await rm('dist/server',{recursive:true,force:true});
await mkdir('dist/server',{recursive:true});
await writeFile('dist/server/index.js','const addressRows = '+addressRows+';\nconst streetCentres='+JSON.stringify(centres)+';\n'+searchSource.replace(/^export /gm,'')+'\nconst assets = '+JSON.stringify(assets)+';\n'+model+'\n'+customer+'\n'+worker);
