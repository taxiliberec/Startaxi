import {change,busy,drivers,fleet,isOwner,employeeRole,permissionsFor,availablePermissions,allows,actionPermissions} from './public/model.js';
import assets from './assets.generated.js';

const json=(payload,status=200,headers={})=>Response.json(payload,{status,headers:{'Cache-Control':'no-store',...headers}});
const decode=async request=>{
  if(!request.headers.get('content-type')?.startsWith('application/json')) throw Error('Neplatný formát.');
  const raw=await request.text();
  if(raw.length>6000) throw Error('Požadavek je příliš dlouhý.');
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
  return position.sessionId==='legacy'||(active?.actor===id&&active.expires>now)?position:null;
}
const storedAccount=(state,id)=>state.employees?.[id]??state.profiles?.[id];
const registeredAccounts=state=>[...Object.values(state.employees||{}),...Object.values(state.profiles||{})];
const publicProfile=({id,firstName,lastName,username})=>({id,firstName,lastName,username});
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
  return [...ids].filter(id=>!isOwner(id)).map(id=>{
    const account=storedAccount(state,id);
    const fallback=drivers.find(driver=>driver.id===id)?.name;
    const [firstName='',lastName='']=(fallback||'').split(' ');
    return {...publicProfile(account??{id,firstName,lastName,username:id}),
      role:employeeRole(state,id),permissions:permissionsFor(state,id)};
  }).sort((a,b)=>a.lastName.localeCompare(b.lastName,'cs')||a.firstName.localeCompare(b.firstName,'cs')||a.username.localeCompare(b.username));
}
function view(state,actor,revision,users){
  const permissions=permissionsFor(state,actor);
  const role=isOwner(actor)?'owner':employeeRole(state,actor);
  const can=key=>allows(permissions,key);
  const allHistory=role!=='driver';
  const now=Date.now();
  const positions=Object.fromEntries(Object.keys(state.positions).flatMap(id=>{
    if(!can('fleetMap')&&(id!==actor||!can('gps'))) return [];
    const active=activePosition(state,id,now);
    if(!active) return [];
    const {sessionId,...position}=active;
    return [[id,position]];
  }));
  const permitted={
    jobs:state.jobs.filter(job=>job.status==='done'
      ? can('history')&&(allHistory||job.driver===actor)
      : ['waiting','assigned','accepted','onboard'].includes(job.status)&&can('dispatchJobs')
        || job.status!=='cancelled'&&can('driverRide')&&job.driver===actor),
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
  if(isOwner(actor)){
    permitted.activity=state.activity||[];
    permitted.owners=Object.values(state.profiles||{}).filter(profile=>isOwner(profile.id)).map(publicProfile);
    permitted.employees=employeeDirectory(state,users);
  }
  const account=storedAccount(state,actor);
  const profile=account?{...publicProfile(account),configured:true}:{id:actor,username:actor,firstName:'',lastName:'',configured:false};
  const showFleet=can('fleetMap')||can('dispatchJobs')||(can('history')&&allHistory);
  return {actor,revision,profile,role,permissions,state:permitted,drivers:fleet(state).filter(d=>showFleet||d.id===actor)};
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
async function handleApi(request,env,path){
  const origin=request.headers.get('Origin');
  if(request.method==='POST'&&origin&&origin!==new URL(request.url).origin) return json({error:'Přístup zamítnut.'},403);
  const users=accounts(env);
  const token=request.headers.get('Cookie')?.match(/(?:^|;\s*)taxi_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(path==='login'&&request.method==='POST'){
    const {key,username,password}=await decode(request);
    const current=await read(env.DB);
    const login=normalizeUsername(username);
    const account=login?registeredAccounts(current.state).find(entry=>entry.username===login):null;
    let actor;
    if(login&&typeof password==='string'&&password.length<=128){
      if(account){
        if(await passwordHash(password,account.salt)===account.digest) actor=account.id;
      }else{
        actor=users.find(([id,value])=>id===login&&!storedAccount(current.state,id)&&value===password)?.[0];
        if(!actor) await passwordHash(password,'taxi-liberec-invalid-user');
      }
    }
    if(!login) actor=users.find(([id,value])=>!storedAccount(current.state,id)&&value===key)?.[0];
    if(!actor) return json({error:'Přihlašovací údaje nejsou platné.'},401);
    const secret=hex(crypto.getRandomValues(new Uint8Array(32)));
    const digest=await session(secret);
    const expires=Date.now()+43200000;
    const {state,revision}=await updateState(env.DB,s=>{
      const latest=storedAccount(s,actor);
      if(latest?.digest!==account?.digest||latest?.username!==account?.username) throw Error('Přihlašovací údaje se změnily. Přihlaste se znovu.');
      s.sessions=Object.fromEntries(Object.entries(s.sessions||{}).filter(([,entry])=>entry.expires>Date.now()));
      s.sessions[digest]={actor,expires};
    });
    return json(view(state,actor,revision,users),200,{'Set-Cookie':cookie(secret,43200)});
  }
  const current=token?await read(env.DB):null;
  const legacy=token?(await Promise.all(users.filter(([id])=>!storedAccount(current.state,id)).map(async ([id,key])=>[id,await session(key)]))).find(([,value])=>value===token)?.[0]:null;
  const digest=token?await session(token):null;
  const active=current?.state.sessions?.[digest];
  const actor=legacy||((active?.expires>Date.now())?active.actor:null);
  const checkSession=state=>{
    const entry=state.sessions?.[digest];
    if(legacy?!storedAccount(state,actor):entry?.actor===actor&&entry.expires>Date.now()) return;
    throw Error('Přihlaste se znovu.');
  };
  if(path==='logout'&&request.method==='POST'){
    if(active||legacy) await updateState(env.DB,state=>{
      if(active) delete state.sessions[digest];
      const driver=active?.actor||legacy;
      if(state.positions[driver]?.sessionId===(legacy?'legacy':digest)) delete state.positions[driver];
    });
    return json({ok:true},200,{'Set-Cookie':cookie('',0)});
  }
  if(!actor) return json({error:'Přihlaste se.'},401);
  if(path==='state'&&request.method==='GET') return json(view(current.state,actor,current.revision,users));
  if(path==='profile'&&request.method==='POST'){
    const input=await decode(request);
    const fields=profileInput(input);
    const account=storedAccount(current.state,actor);
    const password=input.newPassword;
    const changePassword=Boolean(password)||!account;
    if(changePassword||fields.username!==account.username){
      const currentPassword=input.currentPassword;
      const valid=typeof currentPassword==='string'&&(
        account?currentPassword.length<=128&&await passwordHash(currentPassword,account.salt)===account.digest
          :users.some(([id,key])=>id===actor&&currentPassword===key)
      );
      if(!valid) return json({error:'Stávající heslo nebo přístupový klíč není správný.'},400);
    }
    const credentials=changePassword?await newPassword(password):{salt:account.salt,digest:account.digest};
    const secret=legacy?hex(crypto.getRandomValues(new Uint8Array(32))):null;
    const retainedSession=secret?await session(secret):digest;
    const {state,revision}=await updateState(env.DB,s=>{
      checkSession(s);
      const latest=storedAccount(s,actor);
      if(latest?.digest!==account?.digest||latest?.username!==account?.username) throw Error('Profil se mezitím změnil. Zkuste to znovu.');
      checkUsername(s,users,fields.username,actor);
      const entry={...latest,id:actor,...fields,...credentials};
      if(s.employees?.[actor]) s.employees[actor]=entry;
      else (s.profiles??={})[actor]=entry;
      if(secret){
        (s.sessions??={})[retainedSession]={actor,expires:Date.now()+43200000};
        if(s.positions[actor]?.sessionId==='legacy') s.positions[actor].sessionId=retainedSession;
      }
      if(changePassword||fields.username!==account.username){
        for(const [id,session] of Object.entries(s.sessions||{})){
          if(session.actor===actor&&id!==retainedSession) delete s.sessions[id];
        }
      }
    });
    return json(view(state,actor,revision,users),200,secret?{'Set-Cookie':cookie(secret,43200)}:{});
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
        if(!permissions.includes('gps')) delete s.positions[id];
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
  if(path==='geocode'&&request.method==='POST'){
    const permissions=permissionsFor(current.state,actor);
    if(!['create','edit','ownRide'].some(key=>allows(permissions,key))) return json({error:'Přístup zamítnut.'},403);
    const {address}=await decode(request);
    if(typeof address!=='string'||address.trim().length<3||address.length>200) return json({suggestions:[]});
    const endpoint=new URL('https://photon.komoot.io/api/');
    endpoint.search=new URLSearchParams({
      q:address.trim(), lat:'50.7695', lon:'15.0514', countrycode:'CZ', limit:'12'
    });
    endpoint.searchParams.append('layer','house');
    endpoint.searchParams.append('layer','street');
    try{
      const response=await fetch(endpoint,{signal:AbortSignal.timeout(6000)});
      if(!response.ok) throw Error('Photon lookup failed');
      const result=await response.json();
      const houses=new Map(), streets=new Map();
      for(const {properties:p,geometry} of result.features){
        if(p?.countrycode?.toUpperCase()!=='CZ') continue;
        const city=p.city||p.town||p.village||p.municipality||p.county;
        if(!city) continue;
        if(!p.housenumber){
          if(p.type==='street'&&p.name){
            const address=[p.name,city].join(', ');
            if(address.length<=200) streets.set(address,{address});
          }
          continue;
        }
        if(geometry?.type!=='Point') continue;
        const [lng,lat]=geometry.coordinates??[];
        if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180) continue;
        const street=p.street||(p.name!==p.housenumber?p.name:'');
        const location=[p.postcode,city].filter(Boolean).join(' ');
        const address=[street?[street,p.housenumber].join(' '):p.housenumber,location].join(', ');
        if(address.length<=200&&!houses.has(address)) houses.set(address,{address,point:{lat,lng}});
      }
      return json({suggestions:[...houses.values(),...streets.values()].slice(0,8)});
    }catch{
      return json({error:'Vyhledávání adres je dočasně nedostupné.'},503);
    }
  }
  if(path==='action'&&request.method==='POST'){
    const action=await decode(request);
    const {state,revision}=await updateState(env.DB,s=>{
      const sessionId=legacy?'legacy':digest;
      checkSession(s);
      if(action.type==='gpsStop'){
        if(s.positions[actor]?.sessionId!==sessionId) return false;
        delete s.positions[actor];
        return;
      }
      if(Object.hasOwn(actionPermissions,action.type)&&!allows(permissionsFor(s,actor),actionPermissions[action.type])) throw new AccessDenied('Přístup zamítnut.');
      if(action.type==='assign'&&!activePosition(s,action.driver,Date.now())) throw Error('Řidič nesdílí aktuální polohu.');
      const previous=s.positions[actor];
      change(s,actor,action);
      if(action.type==='gps'){
        if(previous===s.positions[actor]) return false;
        s.positions[actor].sessionId=sessionId;
        return;
      }
      if(action.type==='availability') return;
      record(s,actor,action.type,['create','createOwn'].includes(action.type)?s.seq:action.id??action.date);
    });
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
    const asset=assets[path==='/'?'/index.html':path];
    if(!Array.isArray(asset)) return new Response('Nenalezeno',{status:404});
    return new Response(asset[2]?Uint8Array.from(atob(asset[1]),char=>char.charCodeAt(0)):asset[1],{headers:{'Content-Type':asset[0],'X-Content-Type-Options':'nosniff'}});
  }
};
