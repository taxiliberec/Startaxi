import {change,drivers,fleet,managesFleet} from './public/model.js';
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
  return Object.entries(configured).filter(([id,key])=>(managesFleet(id)||drivers.some(d=>d.id===id))&&typeof key==='string'&&key.length>=24);
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
function view(state,actor,revision){
  const directory=fleet(state);
  const {jobs,shifts,occupied={}}=state;
  const now=Date.now();
  const positions=Object.fromEntries(Object.keys(state.positions).flatMap(id=>{
    const active=activePosition(state,id,now);
    if(!active) return [];
    const {sessionId,...position}=active;
    return [[id,position]];
  }));
  const permitted=managesFleet(actor)
    ? {jobs,positions,shifts,occupied,...(actor==='owner'?{activity:state.activity||[]}:{}),
      employees:Object.values(state.employees||{}).map(({id,firstName,lastName,username})=>({id,firstName,lastName,username}))}
    : {jobs:jobs.filter(j=>j.driver===actor),positions:{[actor]:positions[actor]},occupied:{[actor]:Boolean(occupied[actor])},shifts:shifts.filter(s=>s.driver===actor)};
  return {actor,revision,state:permitted,drivers:managesFleet(actor)?directory:directory.filter(d=>d.id===actor)};
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
function record(state,actor,type,detail){
  (state.activity??=[]).unshift({actor,type,detail,time:Date.now()});
}
async function handleApi(request,env,path){
  const origin=request.headers.get('Origin');
  if(request.method==='POST'&&origin&&origin!==new URL(request.url).origin) return json({error:'Přístup zamítnut.'},403);
  const users=accounts(env);
  const token=request.headers.get('Cookie')?.match(/(?:^|;\s*)taxi_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  const legacy=token?(await Promise.all(users.map(async ([id,key])=>[id,await session(key)]))).find(([,value])=>value===token)?.[0]:null;
  if(path==='login'&&request.method==='POST'){
    const {key,username,password}=await decode(request);
    const current=await read(env.DB);
    const employee=typeof username==='string'&&Object.values(current.state.employees||{}).find(e=>e.username===username.trim().toLowerCase());
    let actor;
    if(typeof username==='string'&&username&&typeof password==='string'&&password.length<=128){
      actor=users.find(([id,value])=>id===username.trim().toLowerCase()&&value===password)?.[0];
      if(!actor){
        const digest=await passwordHash(password,employee?.salt||'taxi-liberec-invalid-user');
        if(employee&&digest===employee.digest) actor=employee.id;
      }
    }
    if(!username) actor=users.find(([,value])=>value===key)?.[0];
    if(!actor) return json({error:'Přihlašovací údaje nejsou platné.'},401);
    const secret=hex(crypto.getRandomValues(new Uint8Array(32)));
    const digest=await session(secret);
    const expires=Date.now()+43200000;
    const {state,revision}=await updateState(env.DB,s=>{
      s.sessions=Object.fromEntries(Object.entries(s.sessions||{}).filter(([,entry])=>entry.expires>Date.now()));
      s.sessions[digest]={actor,expires};
    });
    return json(view(state,actor,revision),200,{'Set-Cookie':cookie(secret,43200)});
  }
  const current=token?await read(env.DB):null;
  const digest=token?await session(token):null;
  const active=current?.state.sessions?.[digest];
  const actor=legacy||((active?.expires>Date.now())?active.actor:null);
  if(path==='logout'&&request.method==='POST'){
    if(active||legacy) await updateState(env.DB,state=>{
      if(active) delete state.sessions[digest];
      const driver=active?.actor||legacy;
      if(state.positions[driver]?.sessionId===(legacy?'legacy':digest)) delete state.positions[driver];
    });
    return json({ok:true},200,{'Set-Cookie':cookie('',0)});
  }
  if(!actor) return json({error:'Přihlaste se.'},401);
  if(path==='state'&&request.method==='GET') return json(view(current.state,actor,current.revision));
  if(path==='drivers'&&request.method==='POST'&&managesFleet(actor)){
    const input=await decode(request);
    const firstName=typeof input.firstName==='string'?input.firstName.trim():'';
    const lastName=typeof input.lastName==='string'?input.lastName.trim():'';
    const username=typeof input.username==='string'?input.username.trim().toLowerCase():'';
    const password=input.password;
    if(!firstName||!lastName||firstName.length>80||lastName.length>80||!/^[a-z0-9._-]{3,40}$/.test(username)||
       typeof password!=='string'||password.length<12||password.length>128||['owner','dispatch'].includes(username)){
      return json({error:'Zkontrolujte jméno, přihlašovací jméno a heslo (12 až 128 znaků).'},400);
    }
    const salt=hex(crypto.getRandomValues(new Uint8Array(16)));
    const digest=await passwordHash(password,salt);
    const {state,revision}=await updateState(env.DB,s=>{
      const employees=s.employees??={};
      if(Object.values(employees).some(e=>e.username===username)) throw Error('Přihlašovací jméno už existuje.');
      let number=s.driverSeq??6;
      const id=String(++number).padStart(2,'0');
      s.driverSeq=number;
      employees[id]={id,firstName,lastName,username,salt,digest};
      record(s,actor,'driver',id);
    });
    return json(view(state,actor,revision),201);
  }
  if(path==='geocode'&&request.method==='POST'){
    const {address}=await decode(request);
    if(typeof address!=='string'||address.trim().length<3||address.length>200) return json({suggestions:[]});
    const endpoint=new URL('https://photon.komoot.io/api/');
    endpoint.search=new URLSearchParams({q:address,lat:'50.7695',lon:'15.0514',limit:'8',layer:'house'});
    const r=await fetch(endpoint,{signal:AbortSignal.timeout(2500)});
    if(!r.ok) return json({suggestions:[]});
    const result=await r.json();
    const suggestions=(result.features??[]).flatMap(({properties:p,geometry})=>{
      const [lng,lat]=geometry?.coordinates??[];
      if(!Number.isFinite(lat)||!Number.isFinite(lng)||!p?.housenumber||p.countrycode?.toUpperCase()!=='CZ') return [];
      const street=[p.street||p.name,p.housenumber].filter(Boolean).join(' ');
      return [{address:[street,p.city||p.town||p.village||p.county].filter(Boolean).join(', '),point:{lat,lng}}];
    });
    return json({suggestions});
  }
  if(path==='action'&&request.method==='POST'){
    const action=await decode(request);
    const {state,revision}=await updateState(env.DB,s=>{
      const sessionId=legacy?'legacy':digest;
      if(!legacy&&!(s.sessions?.[digest]?.expires>Date.now())) throw Error('Přihlaste se.');
      if(action.type==='gpsStop'){
        if(s.positions[actor]?.sessionId!==sessionId) return false;
        delete s.positions[actor];
        return;
      }
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
    return json(view(state,actor,revision));
  }
  return json({error:'Stránka neexistuje.'},404);
}
export default {
  async fetch(request,env){
    const path=new URL(request.url).pathname;
    if(path.startsWith('/api/')){
      try{return await handleApi(request,env,path.slice(5));}
      catch(error){return json({error:error instanceof SyntaxError?'Neplatný požadavek.':error.message},400);}
    }
    const asset=assets[path==='/'?'/index.html':path];
    if(!Array.isArray(asset)) return new Response('Nenalezeno',{status:404});
    return new Response(asset[2]?Uint8Array.from(atob(asset[1]),char=>char.charCodeAt(0)):asset[1],{headers:{'Content-Type':asset[0],'X-Content-Type-Options':'nosniff'}});
  }
};
