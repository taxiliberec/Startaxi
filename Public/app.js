import {isOwner,managesFleet,day,busy,meters} from './model.js';
const $=sel=>document.querySelector(sel);
const icons={
 person:'<circle cx="12" cy="5" r="2"/><path d="M5 10h14m-7 0v5m0 0-4 6m4-6 4 6"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 taxi:'<path d="M5 17v2m14-2v2M3 12l2-2 2-5h10l2 5 2 2v5H3zm2-2h14M7 14h1m8 0h1M10 5V3h4v2"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 chart:'<path d="M4 4v16h16M8 16v-4m4 4V8m4 8v-6m4 6V5"/>', calendar:'<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M8 3v4m8-4v4"/>',
 plus:'<path d="M12 5v14M5 12h14"/>', pin:'<path d="M20 10c0 5-8 11-8 11s-8-6-8-11a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
 flag:'<path d="M5 21V4c5-3 9 3 14 0v10c-5 3-9-3-14 0"/>', map:'<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zm6-3v15m6-12v15"/>',
 list:'<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>', clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 money:'<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01m12 0h.01"/>'
};
const icon=n=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+icons[n]+'</svg>';
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cash=c=>new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK',maximumFractionDigits:c%100?2:0}).format(c/100);
const fmtDate=d=>new Intl.DateTimeFormat('cs-CZ',{dateStyle:'long',timeZone:'Europe/Prague'}).format(new Date(d+'T12:00:00Z'));
const time=t=>new Intl.DateTimeFormat('cs-CZ',{timeStyle:'short',timeZone:'Europe/Prague'}).format(t);
let drivers=[], profile=null, revision=-1, sessionGeneration=0;
const driverName=id=>drivers.find(d=>d.id===id)?.name??'';
const statusText={waiting:'Čeká',assigned:'Čeká na přijetí',accepted:'K vyzvednutí',onboard:'Se zákazníkem',done:'Dokončeno'};
let state=null, actor='dispatch', live=false, page='dispatch', queue='waiting', selected='', filter='', reportDate=day(), gps=null, gpsHeartbeat=null, gpsText='', lastGps=0, pending=false, incoming=null, noticeCount=0;
function notify(msg){
 const t=$('#toast'); t.textContent=msg; t.className='visible';
 clearTimeout(notify.timer); notify.timer=setTimeout(()=>t.className='',4200);
}
async function api(path,body){
 const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body&&JSON.stringify(body),cache:'no-store'});
 const data=await r.json();
 if(!r.ok) throw Object.assign(Error(data.error||'Chyba spojení.'),{status:r.status});
 return data;
}
function receive(data){
 if(live&&data.actor===actor&&data.revision<revision) return;
 revision=data.revision; drivers=data.drivers; profile=data.profile;
 const wasLive=live;
 const jobsChanged=!wasLive||JSON.stringify(state.jobs)!==JSON.stringify(data.state.jobs);
 const otherChanged=!wasLive||JSON.stringify([state.employees,state.activity,state.shifts,state.occupied,state.owners])!==JSON.stringify([data.state.employees,data.state.activity,data.state.shifts,data.state.occupied,data.state.owners]);
 const previous=actor;
 live=true; actor=data.actor; state=data.state;
 if(!wasLive||actor!==previous){page=isOwner(actor)?'activity':managesFleet(actor)?'dispatch':'driver'; selected=''; incoming=null;}
 const active=managesFleet(actor)?null:busy(state,actor);
 if(active?.status==='assigned'&&incoming!==active.id){incoming=active.id; notify('Nová zakázka č. '+active.id); navigator.vibrate?.([150,80,150]);}
 if(managesFleet(actor)&&data.state.jobs.filter(j=>j.status==='done').length>noticeCount&&wasLive) notify('Zakázka dokončena.');
 noticeCount=state.jobs.filter(j=>j.status==='done').length;
 if(jobsChanged||otherChanged||previous!==actor) render();
 else if(page==='dispatch'){stats();renderMap();}
 else if(page==='driver'){stats();renderDriverMap();}
}
function lockApp(){
 sessionGeneration++; revision=-1; drivers=[]; profile=null; state=null; live=false; stopGps();
 for(const form of [$('#booking'),$('#own-ride'),$('#profile-form'),$('#owner-form')]) form.reset();
 for(const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
 render();
}
async function perform(action,quiet=false){
 if(!live||(pending&&!quiet)) return false;
 if(!quiet) pending=true;
 const generation=sessionGeneration;
 try{
   const result=await api('action',action);
   if(generation!==sessionGeneration||!live) return false;
   receive(result);
   return true;
 }catch(e){
   if(generation===sessionGeneration&&e.status===401) lockApp();
   if(!quiet) notify(e.message);
   return false;
 }finally{if(!quiet) pending=false;}
}
const occupied=id=>Boolean(busy(state,id)||state.occupied?.[id]);
function stats(){
 const isDispatch=managesFleet(actor);
 const jobs=state.jobs.filter(j=>j.status==='done'&&day(j.done)===(page==='history'?reportDate:day())&&(isDispatch?(!filter||page!=='history'||j.driver===filter):j.driver===actor));
 const values=isDispatch?[
   ['taxi','mint','Volná vozidla',drivers.filter(d=>!occupied(d.id)&&fresh(state.positions[d.id])).length],
   ['clock','amber','Čekající zakázky',state.jobs.filter(j=>j.status==='waiting').length],
   ['list','','Probíhající jízdy',state.jobs.filter(j=>busy(state,j.driver)?.id===j.id).length],
   ['money','violet',page==='history'?'Tržby za vybraný den':'Dnešní tržby',cash(jobs.reduce((t,j)=>t+j.cents,0))]
 ]:[
   ['taxi','mint','Stav vozidla',!fresh(state.positions[actor])?'Neaktivní':occupied(actor)?'Obsazený':'Volný'],
   ['list','','Dokončené jízdy',jobs.length],
   ['money','violet','Tržby za den',cash(jobs.reduce((t,j)=>t+j.cents,0))],
   ['calendar','amber','Uzavřené směny',state.shifts.filter(s=>s.driver===actor&&s.date===(page==='history'?reportDate:day())).length]
 ];
 $('#stats').innerHTML=values.map(([i,c,label,v])=>'<div class="stat"><span class="sticon '+c+'">'+icon(i)+'</span><div><p>'+label+'</p><strong>'+v+'</strong></div></div>').join('');
}
function render(){
 $('#loginbox').hidden=live;
 $('.top').hidden=!live;
 $('#app').hidden=!live;
 if(!live) return;
 $('#dispatch').hidden=page!=='dispatch';
 $('#history').hidden=page!=='history';
 $('#driver').hidden=page!=='driver';
 $('#employees').hidden=page!=='employees';
 $('#activity').hidden=page!=='activity';
 $('#settings').hidden=page!=='settings';
 $('#stats').hidden=page==='settings';
 if(page==='settings') renderOwners();
 document.querySelectorAll('[data-page]').forEach(b=>{
   b.hidden=(b.dataset.page==='employees'&&(!live||!managesFleet(actor)))||(b.dataset.page==='activity'&&!isOwner(actor))||(b.dataset.page==='dispatch'&&!managesFleet(actor))||(b.dataset.page==='driver'&&managesFleet(actor));
   b.classList.toggle('active',page===b.dataset.page);
 });
 $('#login').textContent=!live?'Přihlásit se':isOwner(actor)?'M':managesFleet(actor)?'D':driverName(actor).slice(0,1);
 $('#login').setAttribute('aria-label',live?'Odhlásit se':'Přihlásit se');
 $('#connection').textContent=live?(isOwner(actor)?'Majitel firmy':managesFleet(actor)?'Dispečer':'Řidič'):'Ukázková data';
 $('#mapmode').textContent=live?'ŽIVĚ':'UKÁZKA';
 $('#title').textContent={dispatch:'Dispečink',driver:'Přehled řidiče',history:'Denní přehled',employees:'Řidiči',activity:'Majitel firmy',settings:'Nastavení'}[page];
 $('#subtitle').textContent=page==='dispatch'?'Spravujte zakázky a sledujte polohu vozidel v Liberci.':page==='driver'?driverName(actor)+' · Vozidlo '+actor:page==='employees'?'Založte zaměstnancům přístup do aplikace.':page==='activity'?'Přehled změn zakázek, směn a účtů řidičů.':page==='settings'?'Profil a přihlašovací údaje':'Dokončené jízdy, tržby a uzávěrky směn.';
 stats();
 if(page==='dispatch'){renderQueue();renderMap();}
 if(page==='history') renderHistory();
 if(page==='driver') renderDriver();
 if(page==='employees') $('#employee-list').innerHTML=(state.employees||[]).map(e=>'<p class="employee"><strong>'+esc(e.firstName+' '+e.lastName)+'</strong><span>'+esc(e.username)+' · Taxi '+esc(e.id)+'</span></p>').join('')||'<p class="empty">Zatím nejsou vytvořené žádné účty.</p>';
 if(page==='activity') renderActivity();
}
const offsetDate=(date,days)=>new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
let revenueEnd=day();
let revenueStart=offsetDate(revenueEnd,-6);
let revenueDriver='';
function renderRevenue(){
 const count=(Date.parse(revenueEnd)-Date.parse(revenueStart))/86400000+1;
 const previousStart=offsetDate(revenueStart,-count);
 const previousEnd=offsetDate(revenueStart,-1);
 const totals=new Map();
 for(const job of state.jobs){
   if(job.status!=='done'||(revenueDriver&&job.driver!==revenueDriver)) continue;
   const date=day(job.done);
   if(date<previousStart||date>revenueEnd) continue;
   const entry=totals.get(date)||{cents:0,count:0};
   entry.cents+=job.cents;
   entry.count++;
   totals.set(date,entry);
 }
 const rows=Array.from({length:count},(_,index)=>{
   const date=offsetDate(revenueStart,index);
   const previousDate=offsetDate(previousStart,index);
   return {date,previousDate,cents:totals.get(date)?.cents||0,previous:totals.get(previousDate)?.cents||0,count:totals.get(date)?.count||0};
 });
 const total=rows.reduce((sum,row)=>sum+row.cents,0);
 const previous=rows.reduce((sum,row)=>sum+row.previous,0);
 const rides=rows.reduce((sum,row)=>sum+row.count,0);
 const maximum=Math.max(1,...rows.flatMap(row=>[row.cents,row.previous]));
 const options=drivers.map(d=>'<option value="'+esc(d.id)+'" '+(d.id===revenueDriver?'selected':'')+'>'+esc(d.name)+'</option>').join('');
 const chart=rows.map(row=>'<tr><th scope="row">'+fmtDate(row.date)+'</th><td><span class="revenue-value">'+cash(row.cents)+'</span><progress max="'+maximum+'" value="'+row.cents+'" aria-label="Tržby '+fmtDate(row.date)+'"></progress></td><td><span class="revenue-value">'+cash(row.previous)+'</span><progress class="previous" max="'+maximum+'" value="'+row.previous+'" aria-label="Tržby '+fmtDate(row.previousDate)+'"></progress></td></tr>').join('');
 return '<section class="panel detail revenue"><h2>Tržby z dokončených jízd</h2><div class="filters"><label>Od<input id="revenueStart" type="date" value="'+revenueStart+'"></label><label>Do<input id="revenueEnd" type="date" value="'+revenueEnd+'"></label><label>Řidič<select id="revenueDriver"><option value="">Všichni řidiči</option>'+options+'</select></label></div>'+
   '<div class="revenue-totals"><div>Vybrané období<strong>'+cash(total)+'</strong></div><div>Předchozí období<strong>'+cash(previous)+'</strong></div><div>Rozdíl<strong>'+(total>previous?'+':'')+cash(total-previous)+'</strong></div><div>Dokončené jízdy<strong>'+rides+'</strong></div></div>'+
   '<p>Srovnání s obdobím '+fmtDate(previousStart)+' až '+fmtDate(previousEnd)+'.</p><div class="scroll"><table><thead><tr><th>Datum</th><th>Vybrané období</th><th>Předchozí období</th></tr></thead><tbody>'+chart+'</tbody></table></div></section>';
}
function renderActivity(){
 const labels={ownerCreated:'Vytvořen účet majitele',driver:'Vytvořen účet řidiče',create:'Vytvořena zakázka',createOwn:'Vytvořena vlastní zakázka',cancelJob:'Zakázka zrušena',editPickupTime:'Upraven čas vyzvednutí',editJob:'Upraveny údaje zakázky',assign:'Přiřazena zakázka',accept:'Přijata zakázka',pickup:'Vyzvednut zákazník',complete:'Dokončena jízda',close:'Uzavřena směna'};
 const formatter=new Intl.DateTimeFormat('cs-CZ',{dateStyle:'short',timeStyle:'medium',timeZone:'Europe/Prague'});
 const activity=state.activity||[];
 const view=activity.map(e=>'<tr><td>'+formatter.format(e.time)+'</td><td>'+esc(isOwner(e.actor)?(state.owners?.find(owner=>owner.id===e.actor)?.firstName||'Majitel'):e.actor==='dispatch'?'Dispečer':driverName(e.actor))+'</td><td>'+esc(labels[e.type])+'</td><td>'+esc(e.detail)+'</td></tr>').join('');
 $('#activity').innerHTML=renderRevenue()+'<div class="panel detail"><h2>Historie provozu</h2>'+(view?'<div class="scroll"><table><thead><tr><th>Čas</th><th>Uživatel</th><th>Událost</th><th>ID nebo datum směny</th></tr></thead><tbody>'+view+'</tbody></table></div>':'<p class="empty">Nové události se zobrazí zde.</p>')+'</div>';
}
function jobRoute(j){
 return '<div class="route"><span>'+icon('pin')+esc(j.pickup)+'</span><span>'+icon('flag')+esc(j.dropoff)+'</span></div>';
}
function renderQueue(){
 const waiting=state.jobs.filter(j=>j.status==='waiting');
 const active=state.jobs.filter(j=>['assigned','accepted','onboard'].includes(j.status));
 const jobs=queue==='waiting'?waiting:active;
 if(selected&&(occupied(selected)||!fresh(state.positions[selected]))) selected='';
 $('#queuecount').textContent=jobs.length;
 document.querySelectorAll('[data-queue]').forEach(b=>b.classList.toggle('active',b.dataset.queue===queue));
 $('#maphint').textContent=selected?driverName(selected)+' · vyberte zakázku':'Vyberte volné vozidlo';
 $('#queue').innerHTML=jobs.map(j=>'<div class="job-card"><details class="job-menu"><summary aria-label="Možnosti zakázky '+j.id+'">⋯</summary><div><button type="button" data-job-edit="cancelJob" data-id="'+j.id+'">Zrušit zakázku</button><button type="button" data-job-edit="editPickupTime" data-id="'+j.id+'">Upravit čas vyzvednutí</button><button type="button" data-job-edit="editJob" data-id="'+j.id+'">Upravit údaje zakázky</button></div></details><button class="job" data-job="'+j.id+'" '+(j.status!=='waiting'?'disabled':'')+'><div class="jobtop"><b>'+esc(j.name)+'</b><span class="badge">'+statusText[j.status]+'</span></div>'+jobRoute(j)+'<div class="jobfoot"><span>'+esc([j.driver?driverName(j.driver):'',j.scheduled?j.scheduled.replace('T',' · '):''].filter(Boolean).join(' · ')||'Co nejdříve')+'</span><strong>'+cash(j.cents)+'</strong></div></button></div>').join('')||'<p class="empty">Žádné zakázky</p>';
}
function rideTable(jobs){
 if(!jobs.length) return '<p class="empty">V tomto dni nejsou dokončené jízdy.</p>';
 return '<div class="scroll"><table><thead><tr><th>Zakázka</th><th>Zákazník</th><th>Trasa</th>'+(managesFleet(actor)?'<th>Řidič</th>':'')+'<th>Dokončeno</th><th>Cena</th></tr></thead><tbody>'+jobs.map(j=>'<tr><td>#'+j.id+'</td><td>'+esc(j.name)+'</td><td>'+esc(j.pickup)+' / '+esc(j.dropoff)+'</td>'+(managesFleet(actor)?'<td>'+esc(driverName(j.driver))+'</td>':'')+'<td>'+time(j.done)+'</td><td><b>'+cash(j.cents)+'</b></td></tr>').join('')+'</tbody></table></div>';
}
function renderHistory(){
 const options=drivers.map(d=>'<option value="'+d.id+'" '+(d.id===filter?'selected':'')+'>'+esc(d.name)+'</option>').join('');
 const visible=id=>managesFleet(actor)?!filter||filter===id:actor===id;
 const jobs=state.jobs.filter(j=>j.status==='done'&&day(j.done)===reportDate&&visible(j.driver)).sort((a,b)=>b.done-a.done);
 const shifts=state.shifts.filter(s=>s.date===reportDate&&visible(s.driver));
 const canClose=!managesFleet(actor)&&jobs.some(j=>!j.shift)&&!busy(state,actor);
 $('#history').innerHTML='<div class="panel"><div class="panelhead"><span class="headicon">'+icon('chart')+'</span><div><h2>Dokončené jízdy</h2><p>'+fmtDate(reportDate)+'</p></div></div><div class="filters"><label>Datum<input type="date" id="reportDate" value="'+esc(reportDate)+'"></label>'+(managesFleet(actor)?'<label>Řidič<select id="filter"><option value="">Všichni řidiči</option>'+options+'</select></label>':'')+(canClose?'<button data-shift>Uzavřít směnu</button>':'')+'</div>'+rideTable(jobs)+'</div><div class="panel" style="margin-top:16px"><div class="panelhead"><span class="headicon">'+icon('calendar')+'</span><div><h2>Uzavřené směny</h2></div></div>'+ (shifts.map(s=>'<details class="shift"><summary>'+fmtDate(s.date)+' · '+esc(driverName(s.driver))+' · '+s.count+' jízd · '+cash(s.cents)+'</summary>'+rideTable(jobs.filter(j=>j.shift===s.id))+'</details>').join('')||'<p class="empty">Pro vybraný den nejsou uzavřené směny.</p>')+'</div>';
}
function navigate(address){
 return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate&destination='+encodeURIComponent(address);
}
function driverNavigation(job){
 const toDropoff=job.status==='onboard';
 const point=toDropoff?job.target:job.pickupPoint;
 const address=point?point.lat+','+point.lng:toDropoff?job.dropoff:job.pickup;
 const label=toDropoff?'Navigovat na místo doručení':'Navigovat k zákazníkovi';
 return '<a target="_blank" rel="noopener" href="'+esc(navigate(address))+'">'+label+'</a>';
}
function renderDriver(){
 const j=busy(state,actor);
 const action=j&&({assigned:['accept','Přijmout zakázku'],accepted:['pickup','Zákazník vyzvednut'],onboard:['complete','Doručeno']}[j.status]);
 const pos=state.positions[actor];
 const gpsStatus=gpsText||(fresh(pos)?'GPS přesnost ±'+Math.round(pos.accuracy)+' m':'Poloha se nesdílí.');
 $('#own-ride fieldset').disabled=Boolean(j);
 $('#own-ride-status').hidden=!j;
 $('#driver-summary').innerHTML='<div class="drivergrid"><div><section class="panel detail"><h2>Aktuální zakázka</h2>'+(j?'<p><b>#'+j.id+' · '+esc(j.name)+' · '+cash(j.cents)+'</b></p><p>'+statusText[j.status]+(j.scheduled?' · '+esc(j.scheduled.replace('T',' ')):'')+'</p>'+jobRoute(j)+(j.note?'<p>'+esc(j.note)+'</p>':'')+'<div class="actions">'+(j.status!=='assigned'?driverNavigation(j):'')+'<button class="primary" data-drive="'+action[0]+'" data-id="'+j.id+'">'+action[1]+'</button></div>':'<p>Čekáte na novou zakázku od dispečera.</p>')+'</section></div><div><section class="panel detail"><h2>Dostupnost</h2><div class="actions"><button data-availability aria-pressed="'+Boolean(state.occupied?.[actor])+'" '+(j?'disabled':'')+'>'+(state.occupied?.[actor]?'Nastavit jako volný':'Nastavit jako obsazený')+'</button></div></section><section class="panel detail"><h2>Sdílení polohy</h2><p>'+esc(gpsStatus)+'</p><div class="actions"><button data-gps>'+ (gps===null?'Zapnout GPS':'Zastavit GPS')+'</button></div></section><section class="panel detail"><h2>Dnešní jízdy</h2><div class="actions"><button data-page="history">Otevřít denní přehled</button></div></section></div></div>';
 renderDriverMap();
}
function fresh(p){return Boolean(p&&(p.demo||Date.now()-p.time<45000));}
const center={lat:50.7695,lng:15.0514};
let zoom=13, offset={x:0,y:0};
function project(p,level=zoom){
 const size=256*2**level, sine=Math.sin(Math.max(-85,Math.min(85,p.lat))*Math.PI/180);
 return {x:(p.lng+180)/360*size,y:(.5-Math.log((1+sine)/(1-sine))/(4*Math.PI))*size};
}
function renderTiles(layer,level,x,y,w,h){
 const key=[level,x,y,w,h].join();
 if(layer.dataset.view===key) return;
 layer.dataset.view=key;
 const count=2**level;
 let tiles='';
 for(let tx=Math.floor(x/256);tx<=Math.floor((x+w)/256);tx++) for(let ty=Math.floor(y/256);ty<=Math.floor((y+h)/256);ty++){
   if(ty<0||ty>=count) continue;
   const wrap=((tx%count)+count)%count;
   tiles+='<img alt="" draggable="false" style="left:'+(tx*256-x)+'px;top:'+(ty*256-y)+'px" src="https://tile.openstreetmap.org/'+level+'/'+wrap+'/'+ty+'.png">';
 }
 layer.innerHTML='<div class="mapfallback"><small>Mapový podklad se načítá</small></div>'+tiles;
 layer.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{
   img.style.display='none';
   layer.querySelector('.mapfallback small').textContent='Mapový podklad je nedostupný';
 }));
}
function renderDriverMap(){
 const map=$('#driver-map'), w=map.clientWidth, h=map.clientHeight;
 if(!live||page!=='driver'||!w||!h) return;
 const j=busy(state,actor);
 const position=state.positions[actor];
 const stops=[
   [fresh(position)?position:null,'taxi','green','Vaše poloha'],
   [j?.status==='onboard'?null:j?.pickupPoint,'person','pickup-marker','Vyzvednutí'],
   [j?.target,'flag','gray','Doručení']
 ].filter(([point])=>point);
 const messages=stops.map(([, , ,label])=>label);
 if(!fresh(position)) messages.push('GPS poloha není dostupná');
 if(j&&(!j.target||(j.status!=='onboard'&&!j.pickupPoint))) messages.push('U některé adresy chybí bod na mapě');
 $('#driver-map-status').textContent=messages.join(' · ');

 let level=stops.length?16:13, points, bounds;
 do {
   points=stops.map(([point])=>project(point,level));
   const xs=points.map(point=>point.x), ys=points.map(point=>point.y);
   bounds=points.length?[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)]:null;
   if(!bounds||level===0||(bounds[1]-bounds[0]<=w-80&&bounds[3]-bounds[2]<=h-100)) break;
   level--;
 } while(true);
 const middle=bounds?{x:(bounds[0]+bounds[1])/2,y:(bounds[2]+bounds[3])/2}:project(center,level);
 const x=Math.round(middle.x-w/2), y=Math.round(middle.y-h/2);
 renderTiles(map.querySelector('.map-tiles'),level,x,y,w,h);
 map.querySelector('.map-markers').innerHTML=stops.map(([,symbol,color,label],index)=>{
   const point=points[index];
   return '<span class="marker stop-marker '+color+'" style="left:'+(point.x-x)+'px;top:'+(point.y-y)+'px" role="img" aria-label="'+label+'">'+icon(symbol)+'<small>'+label+'</small></span>';
 }).join('');
}
function renderMap(){
 const map=$('#map'), w=map.clientWidth,h=map.clientHeight;
 if(!live||!w||!h) return;
 const c=project(center), x=c.x-w/2-offset.x,y=c.y-h/2-offset.y;
 renderTiles($('#tiles'),zoom,x,y,w,h);
 $('#markers').innerHTML=drivers.map(d=>{
   const p=state.positions[d.id];
   if(!fresh(p)) return '';
   const j=busy(state,d.id), point=project(p);
   if(point.x-x<0||point.x-x>w||point.y-y<0||point.y-y>h) return '';
   const distance=j?.status==='onboard'&&j.target&&fresh(p)?meters(p,j.target):null;
   const color=distance!==null&&distance<=2000?'orange':occupied(d.id)?'red':'green';
     const label=d.name+' · '+(j?statusText[j.status]:occupied(d.id)?'obsazený':'volný')+(p.accuracy!=null?' · ±'+Math.round(p.accuracy)+' m':'');
   return '<button type="button" class="marker '+color+(selected===d.id?' selected':'')+'" style="'+'left:'+(point.x-x)+'px;top:'+(point.y-y)+'px" data-car="'+d.id+'" title="'+esc(label)+'" aria-label="'+esc(label)+'">'+icon('taxi')+'<small>Taxi '+d.id+'</small></button>';
 }).join('')+state.jobs.flatMap(j=>{
   if(j.status==='cancelled') return [];
   const done=j.status==='done';
   if(done&&Date.now()-j.done>=5000) return [];
   return [
     ...(j.status!=='onboard'&&!done&&j.pickupPoint?[[j.pickupPoint,'person','pickup-marker','Vyzvednutí · '+j.pickup]]:[]),
     ...(j.target?[[j.target,'check',done?'green':'gray','Doručení · '+j.dropoff]]:[])
   ].map(([position,symbol,color,label])=>{
     const point=project(position), left=point.x-x, top=point.y-y;
     if(left<0||left>w||top<0||top>h) return '';
     return '<span class="marker stop-marker '+color+'" style="left:'+left+'px;top:'+top+'px" role="img" aria-label="'+esc(label)+'" title="'+esc(label)+'">'+icon(symbol)+'</span>';
   });
 }).join('');
 $('#vehicle-status').textContent=drivers.filter(d=>fresh(state.positions[d.id])).map(d=>d.name+' · '+(occupied(d.id)?'obsazený':'volný')).join(' / ');
}
let drag;
$('#map').addEventListener('pointerdown',e=>{
 if(e.target.closest('button')) return;
 drag={x:e.clientX,y:e.clientY,...{ox:offset.x,oy:offset.y}};
 e.currentTarget.setPointerCapture(e.pointerId);
});
$('#map').addEventListener('pointermove',e=>{
 if(!drag) return;
 offset={x:drag.ox+e.clientX-drag.x,y:drag.oy+e.clientY-drag.y};
 renderMap();
});
for(const event of ['pointerup','pointercancel']) $('#map').addEventListener(event,()=>drag=null);
new ResizeObserver(renderMap).observe($('#map'));
new ResizeObserver(renderDriverMap).observe($('#driver-map'));
$('#today').textContent=new Intl.DateTimeFormat('cs-CZ',{dateStyle:'full',timeZone:'Europe/Prague'}).format(new Date());
const selectedAddresses=new WeakMap();
for(const form of [$('#booking'),$('#own-ride'),$('#job-edit-form')]){
 const fields=['pickup','dropoff'].map(name=>form.elements[name]);
 for(const input of fields){
   const list=document.createElement('div');
   list.className='address-suggestions';
   list.hidden=true;
   const status=document.createElement('p');
   status.className='address-status';
   status.setAttribute('role','status');
   status.hidden=true;
   input.autocomplete='off';
   input.closest('label').after(status,list);
   const showStatus=message=>{
     status.textContent=message;
     status.hidden=!message;
   };
   let timer, sequence=0;
   const clear=()=>{
     sequence++;
     clearTimeout(timer);
     list.replaceChildren();
     list.hidden=true;
     showStatus('');
   };
   form.addEventListener('reset',()=>{clear();selectedAddresses.delete(input);});
   input.addEventListener('input',()=>{
     clear();
     selectedAddresses.delete(input);
     const address=input.value.trim();
     if(!live||address.length<3) return;
     const request=sequence, generation=sessionGeneration;
     timer=setTimeout(async()=>{
       showStatus('Hledám adresy…');
       try{
         const {suggestions}=await api('geocode',{address});
         if(request!==sequence||generation!==sessionGeneration) return;
         showStatus(suggestions.length?'':'Žádná shoda. Zkuste doplnit číslo domu nebo obec.');
         for(const result of suggestions){
           const choice=document.createElement('button');
           choice.type='button';
           choice.textContent=result.point?result.address:result.address+' · doplňte číslo domu';
           choice.addEventListener('click',()=>{
             if(result.point){
               input.value=result.address;
               selectedAddresses.set(input,{address:result.address,point:result.point});
             }else{
               const separator=result.address.lastIndexOf(', ');
               input.value=result.address.slice(0,separator)+' '+result.address.slice(separator);
             }
             clear();
             input.focus();
             if(!result.point){
               const numberPosition=input.value.lastIndexOf(', ');
               input.setSelectionRange(numberPosition,numberPosition);
               showStatus('Doplňte číslo domu.');
             }
           });
           list.append(choice);
         }
         list.hidden=!list.childElementCount;
       }catch{
         if(request===sequence&&generation===sessionGeneration){
           showStatus('Našeptávání je nedostupné. Adresu můžete zadat ručně.');
         }
       }
     },350);
   });
   input.addEventListener('keydown',event=>{
     if(event.key==='Escape') clear();
     if(event.key==='ArrowDown'&&!list.hidden){
       event.preventDefault();
       list.querySelector('button')?.focus();
     }
   });
   list.addEventListener('keydown',event=>{
     if(event.key==='Escape'){clear();input.focus();}
   });
   form.addEventListener('focusout',event=>{
     if((event.target===input||list.contains(event.target))&&event.relatedTarget!==input&&!list.contains(event.relatedTarget)) clear();
   });
 }
 form.addEventListener('submit',async event=>{
   event.preventDefault();
   const f=Object.fromEntries(new FormData(form));
   const generation=sessionGeneration;
   const submit=form.querySelector('[type=submit]');
   const ownRide=form.id==='own-ride';
   const editing=form.id==='job-edit-form';
   const type=editing?form.dataset.action:ownRide?'createOwn':'create';
   const id=editing?Number(form.dataset.id):undefined;
   submit.disabled=true;
   try{
     if(editing&&type!=='editJob'){
       if(await perform({type,id,scheduled:f.scheduled})){
         $('#job-editor').close();
         notify(type==='cancelJob'?'Zakázka zrušena.':'Čas vyzvednutí uložen.');
       }
       return;
     }
     const points=await Promise.all(fields.map(async input=>{
       if(!f[input.name]) return undefined;
       const selected=selectedAddresses.get(input);
       if(selected?.address===f[input.name]) return selected.point;
       const original=editing?state.jobs.find(job=>job.id===id):null;
       const originalPoint=input.name==='pickup'?original?.pickupPoint:original?.target;
       if(originalPoint&&original[input.name]===f[input.name].trim()) return originalPoint;
       try{
         const {suggestions}=await api('geocode',{address:f[input.name]});
         const typed=f[input.name].trim();
         const matches=suggestions.filter(({address,point})=>point&&
           [address,address.replace(/, \d{3} ?\d{2} /,', ')].some(label=>label.localeCompare(typed,'cs',{sensitivity:'base'})===0));
         return matches.length===1?matches[0].point:undefined;
       }catch{ return undefined; }
     }));
     if(generation!==sessionGeneration) return;
     const [pickupPoint,target]=points;
     const ok=await perform({type,id,...f,cents:Math.round(Number(f.price)*100),pickupPoint,target});
     if(ok){
       form.reset();
       if(editing){
         $('#job-editor').close();
         notify(pickupPoint&&target?'Údaje zakázky uloženy.':'Údaje zakázky uloženy. U některé adresy chybí GPS souřadnice.');
         return;
       }
       if(!ownRide){queue='waiting';render();}
       notify(pickupPoint&&target?'Zakázka vytvořena.':'Zakázka vytvořena. U některé adresy chybí GPS souřadnice.');
     }
   }finally{submit.disabled=false;}
 });
}
function stopGps(){
 if(gps!==null) navigator.geolocation.clearWatch(gps);
 clearInterval(gpsHeartbeat); gpsHeartbeat=null; gps=null; gpsText=''; lastGps=0;
}
function toggleGps(){
 if(gps!==null){stopGps();render();void perform({type:'gpsStop'},true);return;}
 if(!navigator.geolocation){notify('GPS není v tomto prohlížeči k dispozici.');return;}
 gpsText='Získávám polohu…';
 const options={enableHighAccuracy:true,maximumAge:0,timeout:15000};
 let sending=false, queuedFix=null;
 const update=async fix=>{
   if(gps===null) return;
   if(!queuedFix||fix.timestamp>=queuedFix.timestamp) queuedFix=fix;
   if(sending) return;
   sending=true;
   try {
     while(queuedFix&&gps!==null){
       const {coords,timestamp}=queuedFix;
       queuedFix=null;
       lastGps=Date.now();
       const ok=await perform({type:'gps',lat:coords.latitude,lng:coords.longitude,accuracy:coords.accuracy,measured:timestamp},true);
       if(gps===null) return;
       gpsText=ok?'Sdílíte polohu · GPS přesnost ±'+Math.round(coords.accuracy)+' m':'Polohu se nepodařilo odeslat.';
       if(page==='driver') renderDriver();
     }
   } finally {sending=false;}
 };
 const failed=e=>{
   if(gps===null) return;
   if(e.code===1) stopGps();
   gpsText=e.code===1?'Prohlížeč zamítl přístup k poloze.':'Čekám na dostupnou GPS polohu…';
   if(page==='driver') renderDriver();
 };
 gps=navigator.geolocation.watchPosition(update,failed,options);
 gpsHeartbeat=setInterval(()=>{
   if(Date.now()-lastGps>=8000) navigator.geolocation.getCurrentPosition(update,failed,options);
 },8000);
 renderDriver();
}
document.addEventListener('click',async e=>{
 const b=e.target.closest('button');
 if(!b||!live) return;
 const d=b.dataset;
 if(d.page){
   page=d.page==='dispatch'&&!managesFleet(actor)?'driver':d.page;
   if(page==='settings') fillProfileForm();
   render();
   return;
 }
 if(d.close!==undefined){b.closest('dialog').close();return;}
 if(d.zoom!==undefined){
   if(Number(d.zoom)===0){zoom=13;offset={x:0,y:0};}
   else {const next=Math.max(11,Math.min(17,zoom+Number(d.zoom)));offset={x:offset.x*2**(next-zoom),y:offset.y*2**(next-zoom)};zoom=next;}
   renderMap();return;
 }
 if(d.queue){queue=d.queue;renderQueue();return;}
 if(d.car){
   if(occupied(d.car)){notify('Toto vozidlo je obsazené.');return;}
   if(live&&!fresh(state.positions[d.car])){notify('Řidič nesdílí aktuální polohu.');return;}
   selected=selected===d.car?'':d.car;queue='waiting';render();
   if(selected) notify(driverName(selected)+' · vyberte zakázku');
   return;
 }
 if(d.jobEdit&&managesFleet(actor)){
   const job=state.jobs.find(j=>j.id===Number(d.id));
   if(!job) return;
   b.closest('details').open=false;
   const form=$('#job-edit-form');
   form.reset();
   form.dataset.action=d.jobEdit;
   form.dataset.id=job.id;
   const editing=d.jobEdit==='editJob', timing=d.jobEdit==='editPickupTime';
   $('#job-details').hidden=$('#job-details').disabled=!editing;
   $('#job-time').hidden=$('#job-time').disabled=!timing;
   $('#job-cancel-text').hidden=editing||timing;
   $('#job-edit-title').textContent={cancelJob:'Zrušit zakázku',editPickupTime:'Upravit čas vyzvednutí',editJob:'Upravit údaje zakázky'}[d.jobEdit]+' č. '+job.id;
   $('#job-edit-submit').textContent=editing||timing?'Uložit':'Zrušit zakázku';
   for(const field of ['name','pickup','dropoff','note','scheduled']) form.elements[field].value=job[field]??'';
   form.elements.price.value=(job.cents/100).toFixed(2);
   $('#job-editor').showModal();
   return;
 }
 if(d.job){
   if(!selected){notify('Nejdříve vyberte volné vozidlo na mapě.');return;}
   const name=driverName(selected);
   if(await perform({type:'assign',id:Number(d.job),driver:selected})) notify('Zakázka přiřazena · '+name);
   return;
 }
 if(d.drive){
   if(await perform({type:d.drive,id:Number(d.id)})) notify({accept:'Zakázka přijata.',pickup:'Vyzvednutí potvrzeno.',complete:'Jízda dokončena.'}[d.drive]);
   return;
 }
 if(d.availability!==undefined){
   await perform({type:'availability',occupied:!state.occupied?.[actor]});
   return;
 }
 if(d.gps!==undefined){toggleGps();return;}
 if(d.shift!==undefined){
   const sum=state.jobs.filter(j=>j.driver===actor&&j.status==='done'&&day(j.done)===reportDate&&!j.shift).reduce((t,j)=>t+j.cents,0);
   $('#shifttext').textContent=fmtDate(reportDate)+' · celkem '+cash(sum);
   $('#shiftform').elements.total.value=(sum/100).toFixed(2);
   $('#shiftbox').showModal();return;
 }
 if(b.id==='login'){
   try {await api('logout',{});lockApp();}
   catch(e){notify(e.message);}
 }
});
document.addEventListener('change',e=>{
 if(isOwner(actor)&&['revenueStart','revenueEnd'].includes(e.target.id)){
   const start=e.target.id==='revenueStart'?e.target.value:revenueStart;
   const end=e.target.id==='revenueEnd'?e.target.value:revenueEnd;
   const span=(Date.parse(end)-Date.parse(start))/86400000;
   if(!(span>=0&&span<366)){
     notify('Vyberte platné období nejvýše 366 dní.');
     e.target.value=e.target.id==='revenueStart'?revenueStart:revenueEnd;
     return;
   }
   revenueStart=start;
   revenueEnd=end;
   renderActivity();
 }
 if(isOwner(actor)&&e.target.id==='revenueDriver'){revenueDriver=e.target.value;renderActivity();}
 if(e.target.id==='filter'){filter=e.target.value;render();}
 if(e.target.id==='reportDate'&&e.target.value){reportDate=e.target.value;render();}
});
$('#shiftform').addEventListener('submit',async e=>{
 e.preventDefault();
 if(await perform({type:'close',date:reportDate,cents:Math.round(Number(e.currentTarget.elements.total.value)*100)})){
   $('#shiftbox').close();notify('Směna uzavřena.');
 }
});
$('#loginform').addEventListener('submit',async e=>{
 e.preventDefault();
 const f=e.currentTarget;
 const submit=f.querySelector('button');
 submit.disabled=true;
 try{
   const {username,password}=Object.fromEntries(new FormData(f));
   const payload=username.trim()?{username,password}:{key:password};
   const data=await api('login',payload);
   sessionGeneration++;
   receive(data);f.reset();}
 catch(e){notify(e.message);}
 finally{submit.disabled=false;}
});
$('#employee-form').addEventListener('submit',async e=>{
 e.preventDefault();
 const form=e.currentTarget;
 const submit=form.querySelector('button');
 submit.disabled=true;
 try{
   receive(await api('drivers',Object.fromEntries(new FormData(form))));
   form.reset();
   notify('Účet řidiče byl vytvořen.');
 }catch(error){notify(error.message);}
 finally{submit.disabled=false;}
});
function fillProfileForm(){
 const form=$('#profile-form');
 form.reset();
 for(const name of ['firstName','lastName','username']) form.elements[name].value=profile[name];
 form.elements.currentPassword.required=!profile.configured;
 form.elements.newPassword.required=!profile.configured;
 form.elements.confirmPassword.required=!profile.configured;
 $('#profile-password-hint').textContent=profile.configured
   ?'Při změně přihlašovacího jména nebo hesla zadejte stávající heslo. Nové heslo musí mít alespoň 12 znaků.'
   :'Pro nastavení profilu zadejte stávající přístupový klíč a nové heslo s alespoň 12 znaky.';
}
function renderOwners(){
 $('#owner-settings').hidden=!isOwner(actor);
 if(!isOwner(actor)) return;
 const owners=state.owners??[];
 $('#owner-list').innerHTML=owners.length?'<ul>'+owners.map(owner=>
   '<li>'+esc(owner.firstName+' '+owner.lastName)+' · '+esc(owner.username)+(owner.id===actor?' (vy)':'')+'</li>'
 ).join('')+'</ul>':'';
}
for(const [selector,path,message] of [
 ['#profile-form','profile','Profil byl uložen.'],
 ['#owner-form','owners','Účet majitele byl vytvořen.']
]){
 $(selector).addEventListener('submit',async event=>{
   event.preventDefault();
   const form=event.currentTarget;
   const {confirmPassword,...fields}=Object.fromEntries(new FormData(form));
   if(path==='profile'&&confirmPassword!==fields.newPassword){
     notify('Nová hesla se neshodují.');
     return;
   }
   const submit=form.querySelector('button');
   const generation=sessionGeneration;
   submit.disabled=true;
   try{
     const data=await api(path,fields);
     if(!live||generation!==sessionGeneration) return;
     receive(data);
     if(path==='profile') fillProfileForm();
     else form.reset();
     notify(message);
   }catch(error){
     if(generation!==sessionGeneration) return;
     if(error.status===401) lockApp();
     notify(error.message);
   }finally{submit.disabled=false;}
 });
}
let polling=false;
async function poll(){
 if(polling||pending||!live) return;
 polling=true;
 const generation=sessionGeneration;
 try{
   const data=await api('state');
   if(live&&generation===sessionGeneration&&data.revision>revision) receive(data);
 }catch(error){if(generation===sessionGeneration&&error.status===401) lockApp();}
 finally{polling=false;}
}
render();
api('state').then(data=>{if(!sessionGeneration) receive(data);}).catch(()=>{});
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(console.error);
setInterval(poll,1000);
setInterval(()=>{if(live&&page==='dispatch'){stats();renderMap();}},1000);
setInterval(renderDriverMap,8000);
