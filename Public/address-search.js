export const foldStreet=value=>value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\s+/g,' ').trim();
export function addressBucket(address){
  return Array.from(foldStreet(address).slice(0,2),char=>char.codePointAt(0).toString(16)).join('-');
}
export function createAddressIndex(rows,centres){
  const streets=new Map();
  function entry(name){
    const key=foldStreet(name);
    if(!streets.has(key)) streets.set(key,{name,key,houses:[],centre:centres[name]});
    return streets.get(key);
  }
  for(const name of Object.keys(centres)) entry(name);
  for(const row of rows) entry(row[0]).houses.push(row);
  const ordered=Array.from(streets.values()).sort((a,b)=>a.key.localeCompare(b.key,'cs'));
  return address=>{
    const [line,city]=foldStreet(address).split(',').map(part=>part.trim());
    if(city&&!/^(?:\d{3}\s?\d{2}\s+)?liberec\b/.test(city)) return null;
    const query=line.replace(/\s+liberec$/,'').replace(/\s*\/\s*/g,'/');
    if(query.length<2) return null;
    const parts=query.match(/^(.+?)\s+((?:ev\.\s*)?\d+[a-z]?)(?:\/(\d*[a-z]?))?$/);
    const key=parts?.[1]??query;
    const number=parts?.[2],orientation=parts?.[3];
    const exact=streets.get(key);
    const candidates=exact?[exact]:ordered.filter(street=>street.key.startsWith(key));
    if(!candidates.length) return null;
    const suggestions=[];
    for(const street of candidates){
      if(!number&&street.centre){
        const [lat,lng]=street.centre;
        suggestions.push({address:street.name+', Liberec',point:{lat,lng},street:true});
      }
      if(exact||number||!street.centre){
        let houses=street.houses;
        if(number){
          houses=houses.filter(([,house,orient])=>orientation===undefined?house.startsWith(number):house===number&&Boolean(orient)&&orient.toLowerCase().startsWith(orientation));
          const rank=([,house,orient])=>Number(house!==number)*2+Number(orientation!==undefined&&orient!==orientation);
          houses.sort((a,b)=>rank(a)-rank(b));
        }
        for(const [,house,orient,zip,lat,lng] of houses.slice(0,Math.min(4,5-suggestions.length))){
          suggestions.push({address:street.name+' '+house+(orient?'/'+orient:'')+', '+zip.slice(0,3)+' '+zip.slice(3)+' Liberec',point:{lat,lng}});
        }
      }
      if(suggestions.length>=4) break;
    }
    return suggestions;
  };
}
