import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import worker from '../dist/server/index.js';
import {initial,change,fleet} from '../Public/model.js';

test('Older and repeated GPS fixes preserve the current position, including legacy records',()=>{
  const state=initial(), now=Date.now();
  const previous={lat:50,lng:15,time:now};
  state.positions['01']=previous;
  for(const measured of [now-1000,now]){
    change(state,'01',{type:'gps',lat:51,lng:15,accuracy:5,measured},now);
    assert.equal(state.positions['01'],previous);
  }
});

test('A registered employee with a profile counts once for fare calculation',()=>{
  const driver={id:'new-driver',role:'driver',firstName:'Test',lastName:'Driver'};
  assert.equal(fleet({employees:{[driver.id]:driver},profiles:{[driver.id]:driver}}).filter(d=>d.id===driver.id).length,1);
});

test('Concurrent dispatch, retries, exclusive assignment and Web Push',async t=>{
  let state=initial(),revision=0;
  const env={TAXI_OWNER_PASSWORD:'local-test-only-secret',DB:{
    async readState(){return {state:structuredClone(state),revision};},
    async saveState(next,expected){
      await delay(1);
      if(expected!==revision) return false;
      state=structuredClone(next);
      revision++;
      return true;
    }
  }};
  let cookie='';
  function post(path,data){
    return worker.fetch(new Request('https://local.test/api/'+path,{method:'POST',
      headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)}),env);
  }
  const login=await post('login',{username:'owner',password:env.TAXI_OWNER_PASSWORD});
  assert.equal(login.status,200);
  cookie=login.headers.get('set-cookie').split(';')[0];
  const point={lat:50.77,lng:15.05};
  const order={type:'create',name:'Test',pickup:'A',dropoff:'B',pickupPoint:point,target:point,cents:12345};
  const orders=Array.from({length:32},()=>({...order,requestId:crypto.randomUUID()}));
  const responses=await Promise.all([...orders,...orders].map(data=>post('action',data)));
  assert.ok(responses.every(r=>r.status===200));
  assert.equal(state.jobs.length,32);
  assert.equal(new Set(state.jobs.map(j=>j.id)).size,32);
  const now=Date.now();
  state.sessions.driver={actor:'01',expires:now+60000};
  state.positions['01']={...point,time:now,sessionId:'driver'};
  state.pushEndpoints={driver:'https://fcm.googleapis.com/test'};
  env.TAXI_PUSH_CONTACT='mailto:test@example.com';
  env.TAXI_PUSH_VAPID_JWK=JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'}));
  const push=t.mock.method(globalThis,'fetch',async()=>{await delay(10);return new Response(null,{status:410});});
  const assignments=await Promise.all(state.jobs.map(job=>post('action',{type:'assign',driver:'01',id:job.id})));
  assert.equal(assignments.filter(r=>r.ok).length,1);
  assert.equal(state.jobs.filter(j=>j.status==='assigned').length,1);
  assert.equal(push.mock.callCount(),1);
  assert.equal(state.pushEndpoints.driver,undefined);
});

test('Customer quotes and parallel reservations against SQLite',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const sqlite=new DatabaseSync(':memory:');
  t.after(()=>sqlite.close());
  const settings={fareMode:'fixed',fixedFare:100};
  const data={...initial(),customerSettings:settings};
  sqlite.exec('CREATE TABLE dispatch(id INTEGER PRIMARY KEY, revision INTEGER, data TEXT)');
  sqlite.prepare('INSERT INTO dispatch VALUES(1,0,?)').run(JSON.stringify(data));
  const env={DB:{prepare(sql){
    const stmt=sqlite.prepare(sql);
    return {first:()=>stmt.get(),bind:(...args)=>({run:()=>({meta:stmt.run(...args)})})};
  }}};
  let cookie='';
  const post=(path,body)=>worker.fetch(new Request('https://local.test/api/customer/'+path,{
    method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)
  }),env);
  const register=await post('register',{username:'customer',password:'local-test-only-secret',firstName:'A',lastName:'B',email:'test@example.com',phone:'123456789'});
  assert.equal(register.status,201);
  cookie=register.headers.get('set-cookie').split(';')[0];
  const ride={pickup:'1. máje 103/12, Liberec',dropoff:'1. máje 108/48, Liberec',
    pickupPoint:{lat:0,lng:0},payment:'cash',requestId:crypto.randomUUID()};
  const quote=await (await post('fare',ride)).json();
  assert.equal(quote.cents,10000);
  assert.equal((await post('rides',{...ride,expectedCents:9999})).status,409);
  const orders=Array.from({length:10},()=>({...ride,expectedCents:quote.cents,requestId:crypto.randomUUID()}));
  const responses=await Promise.all(orders.map(order=>post('rides',order)));
  assert.equal(responses.filter(r=>r.status===201).length,5);
  assert.equal(responses.filter(r=>r.status===400).length,5);
  const accepted=responses.findIndex(r=>r.status===201);
  const result=await (await post('rides',orders[accepted])).json();
  assert.equal(result.id,(await responses[accepted].json()).id);
  const saved=JSON.parse(sqlite.prepare('SELECT data FROM dispatch').get().data);
  assert.equal(saved.jobs.length,5);
  assert.deepEqual(saved.jobs[0].pickupPoint,{lat:50.76651,lng:15.053372});
});

test('Discount, payment and shift closing agree to the haléř',()=>{
  const state=initial(), now=Date.UTC(2026,10,27,12);
  const point={lat:50.77,lng:15.05};
  const ride={name:'Test',pickup:'A',dropoff:'B',pickupPoint:point,target:point,cents:12345};
  change(state,'owner',{type:'create',...ride},now);
  const job=state.jobs[0], id=job.id;
  Object.assign(job,{customerId:'customer',promoRule:{kind:'amount',discount:30}});
  change(state,'owner',{type:'editJob',id,...ride},now);
  assert.equal(job.baseCents,12345);
  assert.equal(job.cents,9345);
  change(state,'owner',{type:'assign',id,driver:'01'},now);
  for(const type of ['accept','pickup','complete']) change(state,'01',{type,id},now);
  const close={type:'close',date:'2026-11-27',cents:9345};
  assert.throws(()=>change(state,'01',{...close,cents:9344},now));
  change(state,'01',close,now);
  assert.equal(state.shifts[0].cents,job.cents);
  assert.equal(state.shifts[0].id,job.shift);
  assert.throws(()=>change(state,'01',close,now));
  assert.equal(state.shifts.length,1);
});
