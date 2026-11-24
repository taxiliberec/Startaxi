import {change,busy,drivers,fleet,isOwner,employeeRole,permissionsFor,availablePermissions,allows,actionPermissions,validPoint,meters,day} from './public/model.js';
import assets from './assets.generated.js';

const json=(payload,status=200,headers={})=>Response.json(payload,{status,headers:{'Cache-Control':'no-store',...headers}});
const decode=async (request,limit=6000)=>{
  if(!request.headers.get('content-type')?.startsWith('application/json')) throw Error('Neplatný formát.');
  const raw=await request.text();
  if(raw.length>limit) throw Error('Požadavek je příliš dlouhý.');
  return JSON.parse(raw);
};
async function hash(value){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
function accounts(env){
  const configured=JSON.parse(env.TAXI_ACCESS_KEYS||'{}');
  if(env.TAXI_OWNER_KEY) configured.owner=env.TAXI_OWNER_KEY;
  return Object.entries(configured).filter(([id,key])=>(['owner','dispatch'].includes(id)||drivers.some(d=>d.id===id))&&typeof key==='string'&&key.length>=24);
}
async function session(key){return hash('taxi-liberec/session/v1/'+key);}
const sessionSeconds=400*24*60*60;
const loginCooldown=15*60*1000;
const cookie=(token,maxAge)=>'taxi_session='+token+'; Max-Age='+maxAge+'; Path=/; Secure; HttpOnly; SameSite=Strict';
async function read(db){
  if(db.readState) return db.readState();
  const query='SELECT revision, data FROM dispatch WHERE id=1';
  let row;
  try {row=await db.prepare(query).first();}
  catch(error){
    if(!String(error.message).includes('no such table')) throw error;
    await db.prepare('CREATE TABLE IF NOT EXISTS dispatch (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, data TEXT NOT NULL)').run();
  }
  if(!row){
    await db.prepare('INSERT OR IGNORE INTO dispatch (id, revision, data) VALUES (1, 0, ?)').bind(JSON.stringify({jobs:[],positions:{},shifts:[],seq:1000})).run();
    row=await db.prepare(query).first();
  }
  return {revision:row.revision,state:JSON.parse(row.data)};
}
function activePosition(state,id,now){
  const position=state.positions[id];
  if(!position||position.time<=now-45000) return null;
  const active=state.sessions?.[position.sessionId];
  return active?.actor===id&&active.expires>now?position:null;
}
function recordDriverActivity(state,driver,position,now){
  const start=position?.activityAt;
  const end=Math.min(now,(position?.time??0)+45000);
  if(!Number.isFinite(start)||end<=start) return;
  const totals=(state.driverActivity??={})[driver]??={};
  const firstDay=day(start), lastDay=day(end-1);
  if(firstDay===lastDay){
    totals[firstDay]=(totals[firstDay]??0)+end-start;
    return;
  }
  let low=start, high=end-1;
  while(high-low>1){
    const middle=Math.floor((low+high)/2);
    if(day(middle)===firstDay) low=middle;
    else high=middle;
  }
  totals[firstDay]=(totals[firstDay]??0)+high-start;
  totals[lastDay]=(totals[lastDay]??0)+end-high;
}
const storedAccount=(state,id)=>state.employees?.[id]??state.profiles?.[id];
const registeredAccounts=state=>[...Object.values(state.employees||{}),...Object.values(state.profiles||{})];
const publicProfile=({id,firstName,lastName,username})=>({id,firstName,lastName,username});
const displayName=({firstName,lastName,username})=>[firstName,lastName].filter(Boolean).join(' ')||username;
const normalizeUsername=value=>typeof value==='string'?value.trim().toLowerCase():'';
const cleanName=value=>typeof value==='string'?value.trim():'';
const validPassword=value=>typeof value==='string'&&value.length>=12&&value.length<=128;
function profileInput(input){
  const firstName=cleanName(input.firstName), lastName=cleanName(input.lastName);
  const username=normalizeUsername(input.username);
  if(!firstName||!lastName||firstName.length>80||lastName.length>80||!/^[a-z0-9._-]{2,40}$/.test(username)){
    throw Error('Vyplňte jméno, příjmení a platné přihlašovací jméno.');
  }
  return {firstName,lastName,username};
}
function checkUsername(state,users,username,actor){
  if(registeredAccounts(state).some(account=>account.id!==actor&&account.username===username)||
     ['owner','dispatch',...drivers.map(driver=>driver.id)].some(id=>id!==actor&&id===username)||
     users.some(([id])=>id!==actor&&id===username)){
    throw Error('Přihlašovací jméno už existuje nebo je vyhrazené.');
  }
}
async function newPassword(password){
  if(!validPassword(password)) throw Error('Heslo musí mít 12 až 128 znaků.');
  const salt=hex(crypto.getRandomValues(new Uint8Array(16)));
  return {salt,digest:await passwordHash(password,salt)};
}
function employeeDirectory(state,users){
  const ids=new Set([
    ...Object.keys(state.employees||{}),...Object.keys(state.profiles||{}),
    ...users.map(([id])=>id)
  ]);
  return [...ids].filter(id=>!isOwner(id)&&!state.removedUsers?.[id]).map(id=>{
    const account=storedAccount(state,id);
    const fallback=drivers.find(driver=>driver.id===id)?.name;
    const [firstName='',lastName='']=(fallback||'').split(' ');
    return {...publicProfile(account??{id,firstName,lastName,username:id,...state.userNames?.[id]}),
      configured:Boolean(account),role:employeeRole(state,id),permissions:permissionsFor(state,id),vehicleId:assignedVehicle(state,id)?.id};
  }).sort((a,b)=>a.lastName.localeCompare(b.lastName,'cs')||a.firstName.localeCompare(b.firstName,'cs')||a.username.localeCompare(b.username));
}
const publicVehicle=({id,make,model,photo,mapIcon})=>({id,make,model,mapIcon:mapIcon??'sedan',hasPhoto:Boolean(photo)});
const assignedVehicle=(state,id)=>state.vehicles?.[state.vehicleAssignments?.[id]];
function ownerDirectory(state,users){
  const ids=new Set([...Object.keys(state.profiles||{}),...users.map(([id])=>id)]);
  return [...ids].filter(id=>isOwner(id)&&!state.removedUsers?.[id]).map(id=>
    publicProfile(storedAccount(state,id)??{id,username:id,...state.userNames?.[id]}));
}
function vehicleFields(input){
  const make=cleanName(input.make), model=cleanName(input.model);
  if(make.length>80||model.length>80) throw Error('Značka a model mohou mít nejvýše 80 znaků.');
  if(input.mapIcon!==undefined&&!['sedan','estate','suv','van','hatch'].includes(input.mapIcon)) throw Error('Neplatná ikona vozidla.');
  return {make,model,...(input.mapIcon?{mapIcon:input.mapIcon}:{})};
}
function vehiclePhoto(photo){
  if(typeof photo!=='string'||photo.length>112000||!/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(photo)){
    throw Error('Fotografii vozidla se nepodařilo uložit.');
  }
  return photo;
}
function view(state,actor,revision,users){
  const permissions=permissionsFor(state,actor);
  const role=isOwner(actor)?'owner':employeeRole(state,actor);
  const can=key=>allows(permissions,key);
  const allHistory=role!=='driver';
  const now=Date.now();
  const positions=Object.fromEntries(Object.keys(state.positions).flatMap(id=>{
    if(!can('fleetMap')&&(id!==actor||!can('gps'))) return [];
    const last=state.positions[id];
    const active=state.sessions?.[last.sessionId];
    if(active?.actor!==id||active.expires<=now) return [];
    const {sessionId,activityAt,...position}=last;
    return [[id,position]];
  }));
  const permitted={
    jobs:state.jobs.filter(job=>job.status==='done'
      ? can('history')&&(allHistory||job.driver===actor)
      : ['waiting','assigned','accepted','onboard'].includes(job.status)&&can('dispatchJobs')
        || job.status!=='cancelled'&&can('driverRide')&&job.driver===actor)
      .map(({requestId,createdBy,customerId,rewardCredits,loyaltyPoints,...job})=>({...job,customerOrder:Boolean(customerId)})),
    shiftOpen:can('gps')&&Boolean(state.openShifts?.[actor]??state.jobs.some(job=>job.driver===actor&&
      (['assigned','accepted','onboard'].includes(job.status)||job.status==='done'&&!job.shift))),
    positions,
    shifts:can('history')?state.shifts.filter(shift=>allHistory||shift.driver===actor):[],
    occupied:Object.fromEntries(Object.entries(state.occupied||{}).filter(([id])=>can('fleetMap')||
      (id===actor&&(can('availability')||can('gps')))))
  };
  if(can('fleetMap')){
    for(const driver of fleet(state)){
      if(busy(state,driver.id)||!allows(permissionsFor(state,driver.id),'driverRide')) permitted.occupied[driver.id]=true;
    }
  }
  const historyDrivers=new Set([...permitted.jobs.map(job=>job.driver),...permitted.shifts.map(shift=>shift.driver)]);
  permitted.removedDriverNames=Object.fromEntries([...historyDrivers]
    .filter(id=>id&&state.removedUsers?.[id]).map(id=>[id,state.removedUsers[id]]));
  if(isOwner(actor)){
    permitted.customerSettings=state.customerSettings||{};
    permitted.activity=state.activity||[];
    permitted.driverActivity=state.driverActivity||{};
    permitted.owners=ownerDirectory(state,users);
    permitted.employees=employeeDirectory(state,users);
  }
  const account=storedAccount(state,actor);
  const profile=account?{...publicProfile(account),configured:true}:{id:actor,username:actor,firstName:'',lastName:'',...state.userNames?.[actor],configured:false};
  const showFleet=can('fleetMap')||can('dispatchJobs')||(can('history')&&allHistory);
  const visibleDrivers=fleet(state).filter(d=>showFleet||d.id===actor).map(driver=>({
    ...driver,vehicleId:(can('fleetMap')||driver.id===actor)?assignedVehicle(state,driver.id)?.id:undefined
  }));
  const vehicles=isOwner(actor)?Object.values(state.vehicles||{}):[...new Set(visibleDrivers.map(driver=>driver.vehicleId))]
    .flatMap(id=>state.vehicles?.[id]?[state.vehicles[id]]:[]);
  return {actor,revision,profile,role,permissions,state:permitted,drivers:visibleDrivers,vehicles:vehicles.map(publicVehicle)};
}
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
async function passwordHash(password,salt){
  const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  return hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256));
}
async function updateState(db,apply){
  for(let attempt=0;attempt<8;attempt++){
    const {state,revision}=await read(db);
    if(apply(state)===false) return {state,revision};
    const saved=db.saveState
      ? await db.saveState(state,revision)
      : (await db.prepare('UPDATE dispatch SET revision=revision+1,data=? WHERE id=1 AND revision=?').bind(JSON.stringify(state),revision).run()).meta.changes===1;
    if(saved) return {state,revision:revision+1};
  }
  throw Error('Probíhá více změn najednou. Zkuste akci znovu.');
}
function validatePermissions(permissions,role){
  const keys=availablePermissions(role);
  if(!Array.isArray(permissions)||permissions.some(key=>!keys.includes(key))) throw Error('Neplatná oprávnění.');
  return keys.filter(key=>permissions.includes(key));
}
class AccessDenied extends Error {}
function record(state,actor,type,detail){
  (state.activity??=[]).unshift({actor,type,detail,time:Date.now()});
}
function houseAddress({properties:p,geometry}){
  if(p?.countrycode?.toUpperCase()!=='CZ'||!p.housenumber||
     geometry?.type!=='Point'||!Array.isArray(geometry.coordinates)) return null;
  const city=p.city||p.town||p.village||p.municipality||p.county;
  if(!city) return null;
  const [lng,lat]=geometry.coordinates;
  const point={lat,lng};
  if(!validPoint(point)) return null;
  const street=p.street||(p.name!==p.housenumber?p.name:'');
  const location=[p.postcode,city].filter(Boolean).join(' ');
  const address=[street?[street,p.housenumber].join(' '):p.housenumber,location].join(', ');
  return address.length<=200?{address,point}:null;
}

const ruianBase='https://ags.cuzk.cz/arcgis/rest/services/RUIAN/MapServer/';
const liberecCode=563889;
const foldStreet=value=>value.normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('cs').replace(/\s+/g,' ').trim();

async function ruianQuery(layer,params){
  const endpoint=new URL(layer+'/query',ruianBase);
  endpoint.search=new URLSearchParams({f:'json',...params});
  const response=await fetch(endpoint,{signal:AbortSignal.timeout(3500)});
  if(!response.ok) throw Error('RÚIAN lookup failed');
  const {features}=await response.json();
  if(!Array.isArray(features)) throw Error('Invalid RÚIAN response');
  return features;
}
const streetsByKey=new Map();
for(const [street,house,orientation,zip,lat,lng] of addressRows){
  const key=foldStreet(street);
  if(!streetsByKey.has(key)) streetsByKey.set(key,[]);
  streetsByKey.get(key).push({street,house,orientation,zip,lat,lng});
}
function liberecAddresses(address){
  const [line,city]=foldStreet(address).split(',').map(part=>part.trim());
  if(city&&!/^(?:\d{3}\s?\d{2}\s+)?liberec\b/.test(city)) return [];
  const query=line.replace(/\s+liberec$/,'').replace(/\s*\/\s*/g,'/');
  const parts=query.match(/^(.+?)\s+((?:ev\.\s*)?\d+[a-z]?)(?:\/(\d*[a-z]?))?$/);
  const street=parts?.[1]??query;
  const number=parts?.[2], orientation=parts?.[3];
  const hits=[];
  for(const [key,rows] of streetsByKey){
    if(!key.startsWith(street)) continue;
    for(const row of rows){
      let rank=0;
      if(number){
        if(orientation!==undefined){
          if(row.house===number&&row.orientation===orientation) rank=0;
          else if(row.house===number&&row.orientation.startsWith(orientation)) rank=1;
          else if(orientation&&row.orientation===orientation) rank=2;
          else continue;
        }else if(row.house!==number&&row.orientation!==number){
          if(!row.house.startsWith(number)&&!row.orientation.startsWith(number)) continue;
          rank=1;
        }
      }
      hits.push({row,rank});
    }
  }
  hits.sort((a,b)=>a.rank-b.rank||a.row.street.localeCompare(b.row.street,'cs')||parseInt(a.row.house)-parseInt(b.row.house));
  return hits.map(({row:r,rank})=>({
    address:r.street+' '+r.house+(r.orientation?'/'+r.orientation:'')+', '+r.zip.slice(0,3)+' '+r.zip.slice(3)+' Liberec',
    point:{lat:r.lat,lng:r.lng},...(rank===2?{approximate:true}:{})
  }));
}

const base64url=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function pushConfig(env){
  if(!env.TAXI_PUSH_VAPID_JWK||!env.TAXI_PUSH_CONTACT) return null;
  let jwk;
  try{jwk=JSON.parse(env.TAXI_PUSH_VAPID_JWK);}
  catch{return null;}
  const {x,y,d}=jwk??{};
  if(![x,y,d].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value))) return null;
  const decodeKey=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
  const publicKey=base64url([4,...decodeKey(x),...decodeKey(y)]);
  return {key:{kty:'EC',crv:'P-256',x,y,d},publicKey,contact:env.TAXI_PUSH_CONTACT};
}
function pushEndpoint(value){
  if(typeof value!=='string'||value.length>2048) return null;
  try{
    const url=new URL(value);
    const host=url.hostname;
    if(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&!url.hash&&
       (['fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com'].includes(host)||host.endsWith('.push.apple.com'))) return url;
  }catch{}
  return null;
}
async function sendRidePush(env,state,driver){
  const config=pushConfig(env);
  if(!config) return;
  const now=Date.now(), encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('jwk',config.key,{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const header=base64url(encoder.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const expired=[];
  const outcomes=await Promise.allSettled(Object.entries(state.pushEndpoints??{}).map(async ([id,value])=>{
    const session=state.sessions?.[id], url=pushEndpoint(value);
    if(session?.actor!==driver||session.expires<=now||!url) return;
    const payload=base64url(encoder.encode(JSON.stringify({aud:url.origin,exp:Math.floor(now/1000)+3600,sub:config.contact})));
    const unsigned=header+'.'+payload;
    const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key,encoder.encode(unsigned));
    const response=await fetch(url,{method:'POST',headers:{
      Authorization:'vapid t='+unsigned+'.'+base64url(new Uint8Array(signature))+', k='+config.publicKey,
      TTL:'60',Urgency:'high'
    },redirect:'error',signal:AbortSignal.timeout(5000)});
    if(response.status===404||response.status===410) expired.push([id,value]);
    else if(!response.ok) throw Error('Push služba odmítla oznámení.');
  }));
  if(outcomes.some(result=>result.status==='rejected')) console.error('Některá oznámení o zakázce se nepodařilo odeslat.');
  if(expired.length) await updateState(env.DB,s=>{
    for(const [id,value] of expired) if(s.pushEndpoints?.[id]===value) delete s.pushEndpoints[id];
  });
}
async function geocode(request,path){
  const body=await decode(request);
  if(path==='reverse-geocode'){
    const {point}=body;
    if(!validPoint(point)) return json({error:'Neplatné souřadnice adresy.'},400);
    const endpoint=new URL('https://photon.komoot.io/reverse');
    endpoint.search=new URLSearchParams({
      lat:String(point.lat), lon:String(point.lng), radius:'0.1', layer:'house', limit:'10'
    });
    try{
      const response=await fetch(endpoint,{signal:AbortSignal.timeout(6000)});
      if(!response.ok) throw Error('Photon lookup failed');
      const {features}=await response.json();
      let closest=null, distance=100;
      for(const feature of features){
        const match=houseAddress(feature);
        if(!match) continue;
        const gap=meters(point,match.point);
        if(gap>distance) continue;
        closest=match;
        distance=gap;
      }
      return json({address:closest?.address??null});
    }catch{
      return json({error:'Vyhledávání adres je dočasně nedostupné.'},503);
    }
  }
  const {address}=body;
  if(typeof address!=='string'||address.trim().length<3||address.length>200) return json({suggestions:[]});
  try{
    const suggestions=await liberecAddresses(address.trim());
    if(suggestions.length) return json({suggestions});
  }catch{/* Photon remains available when RÚIAN cannot be reached. */}
  const endpoint=new URL('https://photon.komoot.io/api/');
  endpoint.search=new URLSearchParams({
    q:address.trim(), lat:'50.7695', lon:'15.0514', countrycode:'CZ', limit:'15'
  });
  endpoint.searchParams.append('layer','house');
  try{
    const response=await fetch(endpoint,{signal:AbortSignal.timeout(6000)});
    if(!response.ok) throw Error('Photon lookup failed');
    const result=await response.json();
    const houses=new Map();
    for(const feature of result.features){
      const match=houseAddress(feature);
      if(match&&!houses.has(match.address)) houses.set(match.address,match);
    }
    return json({suggestions:[...houses.values()]});
  }catch{
    return json({error:'Vyhledávání adres je dočasně nedostupné.'},503);
  }
}
async function handleApi(request,env,path){
  const origin=request.headers.get('Origin');
  if(request.method==='POST'&&origin&&origin!==new URL(request.url).origin) return json({error:'Přístup zamítnut.'},403);
  if(path.startsWith('customer/')) return customerApi(request,env,path.slice(9));
  const users=accounts(env);
  const token=request.headers.get('Cookie')?.match(/(?:^|;\s*)taxi_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(path==='login'&&request.method==='POST'){
    const {username,password}=await decode(request);
    const login=normalizeUsername(username);
    if(!/^[a-z0-9._-]{2,40}$/.test(login)||typeof password!=='string'||!password||password.length>128){
      return json({error:'Zadejte přihlašovací jméno a heslo.'},400);
    }
    const bucket=await hash(login);
    let retry=0;
    const {state:current}=await updateState(env.DB,state=>{
      retry=0;
      const now=Date.now();
      const attempts=(state.loginAttempts??={});
      for(const [id,entry] of Object.entries(attempts)) if(entry.until<=now) delete attempts[id];
      const previous=attempts[bucket];
      if(previous?.count>=6){
        retry=Math.ceil((previous.until-now)/1000);
        return false;
      }
      attempts[bucket]={count:(previous?.count??0)+1,until:previous?.until??now+loginCooldown};
    });
    if(retry) return json({error:'Po šesti pokusech je přihlášení dočasně zablokované. Zkuste to za '+Math.ceil(retry/60)+' min.'},429,{'Retry-After':String(retry)});
    const account=registeredAccounts(current).find(entry=>!current.removedUsers?.[entry.id]&&entry.username===login);
    const bootstrap=login==='owner'&&!storedAccount(current,'owner')&&!current.removedUsers?.owner&&validPassword(env.TAXI_OWNER_PASSWORD);
    const candidate=await passwordHash(password,account?.salt??'taximetr-invalid-login');
    const actor=account&&candidate===account.digest?account.id:bootstrap&&password===env.TAXI_OWNER_PASSWORD?'owner':null;
    if(!actor) return json({error:'Přihlašovací údaje nejsou platné.'},401);
    const initial=bootstrap&&actor==='owner'&&!account?await newPassword(password):null;
    const secret=hex(crypto.getRandomValues(new Uint8Array(32)));
    const digest=await session(secret);
    const expires=Date.now()+sessionSeconds*1000;
    const {state,revision}=await updateState(env.DB,s=>{
      const latest=storedAccount(s,actor);
      if(s.removedUsers?.[actor]||latest?.digest!==account?.digest||latest?.username!==account?.username) throw Error('Přihlašovací údaje se změnily. Přihlaste se znovu.');
      if(initial) (s.profiles??={}).owner={id:'owner',username:'owner',firstName:'',lastName:'',...initial};
      if(s.loginAttempts) delete s.loginAttempts[bucket];
      s.sessions=Object.fromEntries(Object.entries(s.sessions||{}).filter(([,entry])=>entry.expires>Date.now()));
      s.sessions[digest]={actor,expires};
    });
    return json(view(state,actor,revision,users),200,{'Set-Cookie':cookie(secret,sessionSeconds)});
  }
  const current=token?await read(env.DB):null;
  const digest=token?await session(token):null;
  const active=current?.state.sessions?.[digest];
  const actor=active?.expires>Date.now()&&!current.state.removedUsers?.[active.actor]&&storedAccount(current.state,active.actor)?active.actor:null;
  const checkSession=state=>{
    const entry=state.sessions?.[digest];
    if(!state.removedUsers?.[actor]&&storedAccount(state,actor)&&entry?.actor===actor&&entry.expires>Date.now()) return;
    throw Error('Přihlaste se znovu.');
  };
  if(path==='logout'&&request.method==='POST'){
    if(active) await updateState(env.DB,state=>{
      delete state.sessions[digest];
      if(state.pushEndpoints) delete state.pushEndpoints[digest];
      const driver=active.actor;
      const position=state.positions[driver];
      if(position?.sessionId===digest){
        recordDriverActivity(state,driver,position,Date.now());
        delete state.positions[driver];
      }
    });
    return json({ok:true},200,{'Set-Cookie':cookie('',0)});
  }
  if(!actor) return json({error:'Přihlaste se.'},401);
  if(path==='push'&&allows(permissionsFor(current.state,actor),'driverRide')){
    const config=pushConfig(env);
    if(!config) return json({error:'Oznámení zatím nejsou nastavená na serveru.'},503);
    if(request.method==='GET') return json({publicKey:config.publicKey});
    if(request.method==='POST'){
      const {endpoint}=await decode(request);
      const url=pushEndpoint(endpoint);
      if(!url) return json({error:'Tato služba oznámení není podporovaná.'},400);
      await updateState(env.DB,s=>{
        checkSession(s);
        if(!allows(permissionsFor(s,actor),'driverRide')) throw new AccessDenied('Přístup zamítnut.');
        const endpoints=(s.pushEndpoints??={});
        let changed=endpoints[digest]!==url.href;
        for(const id of Object.keys(endpoints)){
          if((id!==digest&&endpoints[id]===url.href)||!s.sessions[id]||s.sessions[id].expires<=Date.now()){
            delete endpoints[id];
            changed=true;
          }
        }
        if(!changed) return false;
        endpoints[digest]=url.href;
      });
      return json({ok:true});
    }
  }
  if(path==='customer-directory'&&request.method==='GET'){
    if(!isOwner(actor)) throw new AccessDenied('Přístup zamítnut.');
    const compare=new Intl.Collator('cs');
    const customers=Object.values(current.state.customerAccounts??{})
      .map(({firstName,lastName})=>({firstName,lastName}))
      .sort((a,b)=>compare.compare(a.lastName,b.lastName)||compare.compare(a.firstName,b.firstName));
    return json(customers);
  }
  if(path==='customer-settings'&&request.method==='POST'){
    if(!isOwner(actor)) throw new AccessDenied('Přístup zamítnut.');
    const input=await decode(request);
    const {state,revision}=await updateState(env.DB,s=>{
      checkSession(s);
      const {phone,email,hours,offers,fareMode,fixedFare,loyalty}=s.customerSettings||{};
      s.customerSettings=customerSettings({phone,email,hours,offers:(offers??[]).join('\n'),fareMode,fixedFare,loyalty,...input});
    });
    return json(view(state,actor,revision,users));
  }
  if(path==='state'&&request.method==='GET'){
    if(active.expires<Date.now()+(sessionSeconds-7*86400)*1000){
      const {state,revision}=await updateState(env.DB,s=>{
        checkSession(s);
        s.sessions[digest].expires=Date.now()+sessionSeconds*1000;
      });
      return json(view(state,actor,revision,users),200,{'Set-Cookie':cookie(token,sessionSeconds)});
    }
    const tag='"'+actor+':'+current.revision+'"';
    const headers={'Cache-Control':'no-store','ETag':tag};
    if(request.headers.get('If-None-Match')===tag) return new Response(null,{status:304,headers});
    return json(view(current.state,actor,current.revision,users),200,headers);
  }
  if(path==='profile'&&request.method==='POST'){
    const input=await decode(request);
    const fields=profileInput(input);
    const account=storedAccount(current.state,actor);
    const password=input.newPassword;
    const changePassword=Boolean(password);
    if(changePassword||fields.username!==account.username){
      const currentPassword=input.currentPassword;
      if(typeof currentPassword!=='string'||currentPassword.length>128||
         await passwordHash(currentPassword,account.salt)!==account.digest){
        return json({error:'Stávající heslo není správné.'},400);
      }
    }
    const credentials=changePassword?await newPassword(password):{salt:account.salt,digest:account.digest};
    const {state,revision}=await updateState(env.DB,s=>{
      checkSession(s);
      const latest=storedAccount(s,actor);
      if(latest?.digest!==account?.digest||latest?.username!==account?.username) throw Error('Profil se mezitím změnil. Zkuste to znovu.');
      checkUsername(s,users,fields.username,actor);
      const entry={...latest,id:actor,...fields,...credentials};
      if(s.employees?.[actor]) s.employees[actor]=entry;
      else (s.profiles??={})[actor]=entry;
      if(s.userNames) delete s.userNames[actor];
      if(changePassword||fields.username!==account.username){
        for(const [id,session] of Object.entries(s.sessions||{})){
          if(session.actor===actor&&id!==digest) delete s.sessions[id];
        }
      }
    });
    return json(view(state,actor,revision,users));
  }
  if(path.startsWith('vehicle-photo/')&&request.method==='GET'){
    const id=path.slice('vehicle-photo/'.length);
    const vehicle=Object.hasOwn(current.state.vehicles||{},id)?current.state.vehicles[id]:null;
    const authorized=isOwner(actor)||assignedVehicle(current.state,actor)?.id===id||
      (allows(permissionsFor(current.state,actor),'fleetMap')&&Object.values(current.state.vehicleAssignments||{}).includes(id));
    if(!authorized||!vehicle?.photo) return json({error:'Fotografie není dostupná.'},404);
    return new Response(Uint8Array.from(atob(vehicle.photo.split(',')[1]),character=>character.charCodeAt(0)),{
      headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
    });
  }
  if(['user-name','user-remove','vehicle-remove'].includes(path)&&request.method==='POST'){
    if(!isOwner(actor)) return json({error:'Přístup zamítnut.'},403);
    const input=await decode(request);
    const {id}=input;
    const enrollment=path==='user-name'&&input.password?{fields:profileInput(input),credentials:await newPassword(input.password)}:null;
    if(typeof id!=='string'||!id) return json({error:'Neplatný identifikátor.'},400);
    const {state,revision}=await updateState(env.DB,s=>{
      checkSession(s);
      if(path==='vehicle-remove'){
        if(!Object.hasOwn(s.vehicles||{},id)) throw Error('Vozidlo nebylo nalezeno.');
        const {make,model}=s.vehicles[id];
        delete s.vehicles[id];
        for(const [driverId,vehicleId] of Object.entries(s.vehicleAssignments||{})){
          if(vehicleId===id) delete s.vehicleAssignments[driverId];
        }
        record(s,actor,'vehicleRemoved',[make,model].filter(Boolean).join(' '));
        return;
      }
      const user=(isOwner(id)?ownerDirectory(s,users):employeeDirectory(s,users)).find(entry=>entry.id===id);
      if(!user) throw Error('Uživatel nebyl nalezen.');
      if(path==='user-name'){
        const firstName=cleanName(input.firstName), lastName=cleanName(input.lastName);
        if(!firstName||!lastName||firstName.length>80||lastName.length>80) throw Error('Vyplňte jméno a příjmení.');
        const account=storedAccount(s,id);
        if(enrollment){
          if(account) throw Error('Tento účet už má nastavené heslo.');
          checkUsername(s,users,enrollment.fields.username,id);
          (s.profiles??={})[id]={id,...enrollment.fields,...enrollment.credentials};
          if(s.userNames) delete s.userNames[id];
          for(const [sessionId,entry] of Object.entries(s.sessions??{})) if(entry.actor===id) delete s.sessions[sessionId];
        }else if(account) Object.assign(account,{firstName,lastName});
        else (s.userNames??={})[id]={firstName,lastName};
        record(s,actor,'userRenamed',firstName+' '+lastName);
        return;
      }
      if(id===actor) throw Error('Vlastní účet nelze odstranit.');
      if(busy(s,id)) throw Error('Účet lze odstranit po dokončení nebo zrušení aktivní zakázky.');
      (s.removedUsers??={})[id]=displayName(user);
      const directory=s.employees?.[id]?s.employees:s.profiles;
      if(directory) delete directory[id];
      recordDriverActivity(s,id,s.positions[id],Date.now());
      for(const records of [s.userNames,s.vehicleAssignments,s.employeePermissions,s.positions,s.occupied]){
        if(records) delete records[id];
      }
      for(const [sessionId,entry] of Object.entries(s.sessions||{})){
        if(entry.actor===id) delete s.sessions[sessionId];
      }
      record(s,actor,'userRemoved',displayName(user));
    });
    return json(view(state,actor,revision,users));
  }
  if(['vehicles','vehicle-assignment'].includes(path)&&request.method==='POST'){
    if(!isOwner(actor)) return json({error:'Přístup zamítnut.'},403);
    const input=await decode(request,path==='vehicles'?119000:6000);
    const id=path==='vehicles'&&input.id===''?crypto.randomUUID():input.id;
    const fields=path==='vehicles'?vehicleFields(input):null;
    const photo=input.photo===undefined||input.photo===''?input.photo:vehiclePhoto(input.photo);
    const {state,revision}=await updateState(env.DB,s=>{
      checkSession(s);
      if(path==='vehicles'){
        const records=(s.vehicles??={});
        if(input.id!==''&&!Object.hasOwn(records,id)) throw Error('Vozidlo nebylo nalezeno.');
        records[id]={id,mapIcon:records[id]?.mapIcon??'sedan',...fields,photo:photo??records[id]?.photo};
        return;
      }
      const employee=employeeDirectory(s,users).find(entry=>entry.id===id&&entry.role==='driver');
      if(!employee) throw Error('Řidič nebyl nalezen.');
      const assignments=(s.vehicleAssignments??={});
      if(input.vehicleId===''){
        delete assignments[id];
        return;
      }
      if(!Object.hasOwn(s.vehicles||{},input.vehicleId)) throw Error('Vozidlo nebylo nalezeno.');
      if(Object.entries(assignments).some(([driverId,vehicleId])=>driverId!==id&&vehicleId===input.vehicleId)){
        throw Error('Vozidlo je už přiřazené jinému řidiči.');
      }
      assignments[id]=input.vehicleId;
    });
    return json(view(state,actor,revision,users));
  }
  if(['drivers','employees','owners','employee-permissions'].includes(path)&&request.method==='POST'){
    if(!isOwner(actor)) return json({error:'Přístup zamítnut.'},403);
    const input=await decode(request);
    if(path==='employee-permissions'){
      const {id,permissions}=input;
      const {state,revision}=await updateState(env.DB,s=>{
        checkSession(s);
        const employee=employeeDirectory(s,users).find(entry=>entry.id===id);
        if(!employee) throw Error('Účet zaměstnance nebyl nalezen.');
        (s.employeePermissions??={})[id]=validatePermissions(permissions,employee.role);
        if(!permissions.includes('gps')){
          recordDriverActivity(s,id,s.positions[id],Date.now());
          delete s.positions[id];
        }
        record(s,actor,'employeePermissions',employee.username);
      });
      return json(view(state,actor,revision,users));
    }
    const creatingOwner=path==='owners';
    const role=path==='drivers'?'driver':input.role;
    if(!creatingOwner&&!['driver','dispatcher'].includes(role)) throw Error('Vyberte pracovní pozici.');
    const fields=profileInput(input);
    if(fields.username.length<3) throw Error('Přihlašovací jméno musí mít alespoň 3 znaky.');
    const permissions=!creatingOwner&&input.permissions!==undefined?validatePermissions(input.permissions,role):null;
    const credentials=await newPassword(input.password);
    const accountId=creatingOwner?'owner-'+crypto.randomUUID():role==='dispatcher'?'dispatcher-'+crypto.randomUUID():null;
    const {state,revision}=await updateState(env.DB,s=>{
      checkSession(s);
      checkUsername(s,users,fields.username);
      const id=accountId??String(s.driverSeq=(s.driverSeq??6)+1).padStart(2,'0');
      const directory=creatingOwner?(s.profiles??={}):(s.employees??={});
      directory[id]={id,...fields,...credentials,...(creatingOwner?{}:{role})};
      if(permissions) (s.employeePermissions??={})[id]=permissions;
      record(s,actor,creatingOwner?'ownerCreated':'employeeCreated',fields.username);
    });
    return json(view(state,actor,revision,users),201);
  }
  if(['geocode','reverse-geocode'].includes(path)&&request.method==='POST'){
    const permissions=permissionsFor(current.state,actor);
    if(!['create','edit','ownRide'].some(key=>allows(permissions,key))) return json({error:'Přístup zamítnut.'},403);
    return geocode(request,path);
  }
  if(path==='action'&&request.method==='POST'){
    const action=await decode(request);
    const {state,revision}=await updateState(env.DB,s=>{
      const sessionId=digest;
      checkSession(s);
      const now=Date.now();
      if(action.type==='shiftStart'){
        if(!allows(permissionsFor(s,actor),'gps')) throw new AccessDenied('Přístup zamítnut.');
        if(s.openShifts?.[actor]) return false;
        (s.openShifts??={})[actor]=true;
        return;
      }
      if(action.type==='gpsStop'){
        if(s.positions[actor]?.sessionId!==sessionId) return false;
        recordDriverActivity(s,actor,s.positions[actor],now);
        delete s.positions[actor];
        return;
      }
      if(Object.hasOwn(actionPermissions,action.type)&&!allows(permissionsFor(s,actor),actionPermissions[action.type])) throw new AccessDenied('Přístup zamítnut.');
      if(action.type==='gps'&&s.openShifts?.[actor]===false) throw Error('Nejdříve zahajte směnu.');
      if(['confirmCustomerRide','rejectCustomerRide'].includes(action.type)){
        const reject=action.type==='rejectCustomerRide';
        if(!allows(permissionsFor(s,actor),reject?'cancel':'edit')) throw new AccessDenied('Přístup zamítnut.');
        const ride=s.jobs.find(job=>job.id===action.id&&job.customerId);
        if((reject&&ride?.rejectedAt)||(!reject&&ride?.confirmedAt&&ride.status==='waiting')) return false;
        if(ride?.status!=='waiting'||ride.confirmedAt) throw Error('O objednávce už bylo rozhodnuto.');
        if(reject) Object.assign(ride,{status:'cancelled',cancelled:now,rejectedAt:now});
        else ride.confirmedAt=now;
        record(s,actor,action.type,ride.id);
        return;
      }
      if(action.type==='assign'&&!activePosition(s,action.driver,Date.now())) throw Error('Řidič nesdílí aktuální polohu.');
      const previous=s.positions[actor];
      if(change(s,actor,action,now)===false) return false;
      if(action.type==='createOwn'&&allows(permissionsFor(s,actor),'gps')) (s.openShifts??={})[actor]=true;
      if(action.type==='assign'&&allows(permissionsFor(s,action.driver),'gps')) (s.openShifts??={})[action.driver]=true;
      if(action.type==='close'||action.type==='shiftEnd'){
        if(action.type==='close'&&s.jobs.some(job=>job.driver===actor&&job.status==='done'&&!job.shift)){
          record(s,actor,action.type,action.date);
          return;
        }
        (s.openShifts??={})[actor]=false;
        recordDriverActivity(s,actor,previous,now);
        delete s.positions[actor];
      }
      if(action.type==='gps'){
        if(previous===s.positions[actor]) return false;
        const expiry=s.sessions?.[previous?.sessionId]?.expires;
        if(expiry) recordDriverActivity(s,actor,previous,Math.min(now,expiry));
        s.positions[actor].sessionId=sessionId;
        if(s.positions[actor].time>now-45000) s.positions[actor].activityAt=now;
        return;
      }
      if(action.type==='availability') return;
      record(s,actor,action.type,['create','createOwn'].includes(action.type)?s.seq:action.id??action.date);
    });
    if(action.type==='assign') void sendRidePush(env,state,action.driver).catch(()=>console.error('Oznámení o nové zakázce se nepodařilo odeslat.'));
    return json(view(state,actor,revision,users));
  }
  return json({error:'Stránka neexistuje.'},404);
}
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(path.startsWith('/api/')){
      try{return await handleApi(request,env,path.slice(5));}
      catch(error){return json({error:error instanceof SyntaxError?'Neplatný požadavek.':error.message},error instanceof AccessDenied?403:400);}
    }
    if(path==='/customer') return Response.redirect(new URL('/customer/',request.url),308);
    const asset=assets[path==='/'?'/index.html':path==='/customer/'?'/customer/index.html':path];
    if(!Array.isArray(asset)) return new Response('Nenalezeno',{status:404});
    return new Response(asset[2]?Uint8Array.from(atob(asset[1]),char=>char.charCodeAt(0)):asset[1],{headers:{'Content-Type':asset[0],'X-Content-Type-Options':'nosniff'}});
  }
};
