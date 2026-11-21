import {isOwner,allows,availablePermissions,defaultPermissions,permissionLabels,day,busy,meters} from './model.js';
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
let vehicles=[], drivers=[], profile=null, revision=-1, sessionGeneration=0, role='', permissions=[];
const can=key=>allows(permissions,key);
const driverPage=()=>['driverRide','availability','gps'].some(can);
const canSeePage=key=>({
 dispatch:['dispatchJobs','fleetMap','create'].some(can),driver:driverPage(),
 history:can('history'),activity:isOwner(actor),settings:true
})[key]===true;
const roleLabel=value=>({owner:'Majitel firmy',dispatcher:'Dispečer',driver:'Řidič'})[value];
const fleetHistory=()=>role!=='driver';
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
 const vehicleChanged=JSON.stringify([drivers,vehicles])!==JSON.stringify([data.drivers,data.vehicles]);
 revision=data.revision; drivers=data.drivers; vehicles=data.vehicles; profile=data.profile;
 const wasLive=live;
 const jobsChanged=!wasLive||JSON.stringify(state.jobs)!==JSON.stringify(data.state.jobs);
 const otherChanged=!wasLive||JSON.stringify([state.employees,state.activity,state.shifts,state.occupied,state.owners])!==JSON.stringify([data.state.employees,data.state.activity,data.state.shifts,data.state.occupied,data.state.owners]);
 const previous=actor;
 const permissionsChanged=JSON.stringify(permissions)!==JSON.stringify(data.permissions);
 role=data.role; permissions=data.permissions;
 if(!can('gps')&&gps!==null) stopGps();
 if(permissionsChanged){
   selected='';
   for(const id of ['job-editor','shiftbox']) if($('#'+id).open) $('#'+id).close();
 }
 live=true; actor=data.actor; state=data.state;
 if(!wasLive||actor!==previous){loadMapPreferences();syncMapControls();}
 if(!wasLive||actor!==previous||!canSeePage(page)){
   page=['activity','dispatch','driver','history','settings'].find(canSeePage);
   if(page==='settings') fillProfileForm();
   selected=''; incoming=null;
 }
 const active=can('driverRide')?busy(state,actor):null;
 if(active?.status==='assigned'&&incoming!==active.id){incoming=active.id; notify('Nová zakázka č. '+active.id); navigator.vibrate?.([150,80,150]);}
 if(fleetHistory()&&can('history')&&data.state.jobs.filter(j=>j.status==='done').length>noticeCount&&wasLive) notify('Zakázka dokončena.');
 noticeCount=state.jobs.filter(j=>j.status==='done').length;
 if(jobsChanged||otherChanged||permissionsChanged||vehicleChanged||previous!==actor) render();
 else if(page==='dispatch'){stats();renderMap();}
 else if(page==='driver'){stats();renderDriverMap();}
}
function lockApp(){
 sessionGeneration++; revision=-1; drivers=[]; vehicles=[]; profile=null; state=null; live=false; stopGps();
 for(const form of [$('#booking'),$('#own-ride'),$('#profile-form'),$('#owner-form'),$('#employee-form')]) form.reset();
 for(const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
 fillDefaultPermissions();
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
 const isDispatch=fleetHistory()||page==='dispatch';
 const jobs=state.jobs.filter(j=>j.status==='done'&&day(j.done)===(page==='history'?reportDate:day())&&(isDispatch?(!filter||page!=='history'||j.driver===filter):j.driver===actor));
 const values=(isDispatch?[
   ['fleetMap','taxi','mint','Volná vozidla',drivers.filter(d=>!occupied(d.id)&&fresh(state.positions[d.id])).length],
   ['dispatchJobs','clock','amber','Čekající zakázky',state.jobs.filter(j=>j.status==='waiting').length],
   ['dispatchJobs','list','','Probíhající jízdy',state.jobs.filter(j=>busy(state,j.driver)?.id===j.id).length],
   ['history','money','violet',page==='history'?'Tržby za vybraný den':'Dnešní tržby',cash(jobs.reduce((t,j)=>t+j.cents,0))]
 ]:[
   ['gps','taxi','mint','Stav vozidla',!fresh(state.positions[actor])?'Neaktivní':occupied(actor)?'Obsazený':'Volný'],
   ['history','list','','Dokončené jízdy',jobs.length],
   ['history','money','violet','Tržby za den',cash(jobs.reduce((t,j)=>t+j.cents,0))],
   ['history','calendar','amber','Uzavřené směny',state.shifts.filter(s=>s.driver===actor&&s.date===(page==='history'?reportDate:day())).length]
 ]).filter(([permission])=>can(permission));
 $('#stats').hidden=page==='settings'||!values.length;
 $('#stats').innerHTML=values.map(([,i,c,label,v])=>'<div class="stat"><span class="sticon '+c+'">'+icon(i)+'</span><div><p>'+label+'</p><strong>'+v+'</strong></div></div>').join('');
}
function render(){
 $('#loginbox').hidden=live;
 $('.top').hidden=!live;
 $('#app').hidden=!live;
 if(!live) return;
 $('#dispatch').hidden=page!=='dispatch';
 $('#history').hidden=page!=='history';
 $('#driver').hidden=page!=='driver';
 $('#activity').hidden=page!=='activity';
 $('#settings').hidden=page!=='settings';
 if(page==='settings'){renderOwners();renderUserSettings();renderFleetSettings();}
 document.querySelectorAll('[data-permission]').forEach(el=>el.hidden=!can(el.dataset.permission));
 $('#driver-map-panel').hidden=!can('gps')&&!can('driverRide');
 $('#dispatch').setAttribute('data-panels',['create','fleetMap','dispatchJobs'].filter(can).length);
 document.querySelectorAll('[data-page]').forEach(b=>{
   b.hidden=!canSeePage(b.dataset.page);
   b.classList.toggle('active',page===b.dataset.page);
 });
 $('#login').textContent=!live?'Přihlásit se':(profile.firstName||roleLabel(role)).slice(0,1);
 $('#login').setAttribute('aria-label',live?'Odhlásit se':'Přihlásit se');
 $('#connection').textContent=roleLabel(role);
 $('#title').textContent={dispatch:'Dispečink',driver:'Přehled řidiče',history:'Denní přehled',activity:'Majitel firmy',settings:'Nastavení'}[page];
 $('#subtitle').textContent=page==='dispatch'?'Spravujte zakázky a sledujte polohu vozidel v Liberci.':page==='driver'?driverName(actor)+' · Vozidlo '+actor:page==='activity'?'Přehled změn zakázek, směn a účtů řidičů.':page==='settings'?'Profil a nastavení aplikace':'Dokončené jízdy, tržby a uzávěrky směn.';
 stats();
 if(page==='dispatch'){renderQueue();renderMap();}
 if(page==='history') renderHistory();
 if(page==='driver') renderDriver();
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
 const labels={employeeCreated:'Vytvořen účet zaměstnance',employeePermissions:'Změněna oprávnění zaměstnance',ownerCreated:'Vytvořen účet majitele',driver:'Vytvořen účet řidiče',create:'Vytvořena zakázka',createOwn:'Vytvořena vlastní zakázka',cancelJob:'Zakázka zrušena',editPickupTime:'Upraven čas vyzvednutí',editJob:'Upraveny údaje zakázky',assign:'Přiřazena zakázka',accept:'Přijata zakázka',pickup:'Vyzvednut zákazník',complete:'Dokončena jízda',close:'Uzavřena směna'};
 const formatter=new Intl.DateTimeFormat('cs-CZ',{dateStyle:'short',timeStyle:'medium',timeZone:'Europe/Prague'});
 const activity=state.activity||[];
 const view=activity.map(e=>'<tr><td>'+formatter.format(e.time)+'</td><td>'+esc(isOwner(e.actor)?(state.owners?.find(owner=>owner.id===e.actor)?.firstName||'Majitel'):(state.employees?.find(employee=>employee.id===e.actor)?.firstName||driverName(e.actor)||(e.actor==='dispatch'?'Dispečer':e.actor)))+'</td><td>'+esc(labels[e.type])+'</td><td>'+esc(e.detail)+'</td></tr>').join('');
 $('#activity').innerHTML=renderRevenue()+'<div class="panel detail"><h2>Historie provozu</h2>'+(view?'<div class="scroll"><table><thead><tr><th>Čas</th><th>Uživatel</th><th>Událost</th><th>ID nebo datum směny</th></tr></thead><tbody>'+view+'</tbody></table></div>':'<p class="empty">Nové události se zobrazí zde.</p>')+'</div>';
}
function jobRoute(j){
 return '<div class="route"><span>'+icon('pin')+esc(j.pickup)+'</span><span>'+icon('flag')+esc(j.dropoff)+'</span></div>';
}
function renderQueue(){
 if(!can('dispatchJobs')) return;
 const waiting=state.jobs.filter(j=>j.status==='waiting');
 const active=state.jobs.filter(j=>['assigned','accepted','onboard'].includes(j.status));
 const jobs=queue==='waiting'?waiting:active;
 if(selected&&(occupied(selected)||!fresh(state.positions[selected]))) selected='';
 $('#queuecount').textContent=jobs.length;
 $('#maphint').hidden=!can('assign');
 document.querySelectorAll('[data-queue]').forEach(b=>b.classList.toggle('active',b.dataset.queue===queue));
 $('#maphint').textContent=selected?driverName(selected)+' · vyberte zakázku':'Vyberte volné vozidlo';
 $('#queue').innerHTML=jobs.map(j=>'<div class="job-card"><details class="job-menu"><summary aria-label="Možnosti zakázky '+j.id+'">⋯</summary><div><button type="button" data-job-edit="cancelJob" data-id="'+j.id+'">Zrušit zakázku</button><button type="button" data-job-edit="editPickupTime" data-id="'+j.id+'">Upravit čas vyzvednutí</button><button type="button" data-job-edit="editJob" data-id="'+j.id+'">Upravit údaje zakázky</button></div></details><button class="job" data-job="'+j.id+'" '+(j.status!=='waiting'||!can('assign')?'disabled':'')+'><div class="jobtop"><b>'+esc(j.name)+'</b><span class="badge">'+statusText[j.status]+'</span></div>'+jobRoute(j)+'<div class="jobfoot"><span>'+esc([j.driver?driverName(j.driver):'',j.scheduled?j.scheduled.replace('T',' · '):''].filter(Boolean).join(' · ')||'Co nejdříve')+'</span><strong>'+cash(j.cents)+'</strong></div></button></div>').join('')||'<p class="empty">Žádné zakázky</p>';
 $('#queue').querySelectorAll('.job-menu').forEach(menu=>{
   menu.hidden=!can('edit')&&!can('cancel');
   menu.querySelectorAll('[data-job-edit]').forEach(button=>button.hidden=!can(button.dataset.jobEdit==='cancelJob'?'cancel':'edit'));
 });
}
function rideTable(jobs){
 if(!jobs.length) return '<p class="empty">V tomto dni nejsou dokončené jízdy.</p>';
 return '<div class="scroll"><table><thead><tr><th>Zakázka</th><th>Zákazník</th><th>Trasa</th>'+(fleetHistory()?'<th>Řidič</th>':'')+'<th>Dokončeno</th><th>Cena</th></tr></thead><tbody>'+jobs.map(j=>'<tr><td>#'+j.id+'</td><td>'+esc(j.name)+'</td><td>'+esc(j.pickup)+' / '+esc(j.dropoff)+'</td>'+(fleetHistory()?'<td>'+esc(driverName(j.driver))+'</td>':'')+'<td>'+time(j.done)+'</td><td><b>'+cash(j.cents)+'</b></td></tr>').join('')+'</tbody></table></div>';
}
function renderHistory(){
 const options=drivers.map(d=>'<option value="'+d.id+'" '+(d.id===filter?'selected':'')+'>'+esc(d.name)+'</option>').join('');
 const visible=id=>fleetHistory()?!filter||filter===id:actor===id;
 const jobs=state.jobs.filter(j=>j.status==='done'&&day(j.done)===reportDate&&visible(j.driver)).sort((a,b)=>b.done-a.done);
 const shifts=state.shifts.filter(s=>s.date===reportDate&&visible(s.driver));
 const canClose=can('closeShift')&&jobs.some(j=>!j.shift)&&!busy(state,actor);
 $('#history').innerHTML='<div class="panel"><div class="panelhead"><span class="headicon">'+icon('chart')+'</span><div><h2>Dokončené jízdy</h2><p>'+fmtDate(reportDate)+'</p></div></div><div class="filters"><label>Datum<input type="date" id="reportDate" value="'+esc(reportDate)+'"></label>'+(fleetHistory()?'<label>Řidič<select id="filter"><option value="">Všichni řidiči</option>'+options+'</select></label>':'')+(canClose?'<button data-shift>Uzavřít směnu</button>':'')+'</div>'+rideTable(jobs)+'</div><div class="panel" style="margin-top:16px"><div class="panelhead"><span class="headicon">'+icon('calendar')+'</span><div><h2>Uzavřené směny</h2></div></div>'+ (shifts.map(s=>'<details class="shift"><summary>'+fmtDate(s.date)+' · '+esc(driverName(s.driver))+' · '+s.count+' jízd · '+cash(s.cents)+'</summary>'+rideTable(jobs.filter(j=>j.shift===s.id))+'</details>').join('')||'<p class="empty">Pro vybraný den nejsou uzavřené směny.</p>')+'</div>';
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
 const summary=$('#driver-summary');
 summary.querySelector('section').hidden=!can('driverRide');
 for(const [selector,permission] of [['[data-availability]','availability'],['[data-gps]','gps'],['[data-page="history"]','history']]){
   summary.querySelector(selector).closest('section').hidden=!can(permission);
 }
 renderDriverMap();
}
function fresh(p){return Boolean(p&&(p.demo||Date.now()-p.time<45000));}
const center={lat:50.7695,lng:15.0514};
let zoom=13, offset={x:0,y:0};
function project(p,level=zoom){
 const size=256*2**level, sine=Math.sin(Math.max(-85,Math.min(85,p.lat))*Math.PI/180);
 return {x:(p.lng+180)/360*size,y:(.5-Math.log((1+sine)/(1-sine))/(4*Math.PI))*size};
}
const osmCredit='<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>';
const cartoCredit=osmCredit+' · <a href="https://carto.com/attributions" target="_blank" rel="noopener">© CARTO</a>';
const cartoTiles=(style,z,x,y)=>'https://basemaps.cartocdn.com/'+style+'/'+z+'/'+x+'/'+y+'.png';
const mapStyles={
 classic:{label:'Klasická',credit:osmCredit,tile:(z,x,y)=>'https://tile.openstreetmap.org/'+z+'/'+x+'/'+y+'.png'},
 light:{label:'Světlá',credit:cartoCredit,tile:(...coords)=>cartoTiles('light_all',...coords)},
 dark:{label:'Tmavá',credit:cartoCredit,tile:(...coords)=>cartoTiles('dark_all',...coords)},
 voyager:{label:'Barevná',credit:cartoCredit,tile:(...coords)=>cartoTiles('rastertiles/voyager',...coords)},
 aerial:{
   label:'Letecká (ČR)',
   credit:'<a href="https://ags.cuzk.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer" target="_blank" rel="noopener">© ČÚZK</a>',
   tile:(z,x,y)=>'https://ags.cuzk.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/'+z+'/'+y+'/'+x
 },
 terrain:{
   label:'Turistická / topografická',
   credit:osmCredit+' · <a href="https://opentopomap.org/about" target="_blank" rel="noopener">© OpenTopoMap (CC BY-SA)</a> · SRTM',
   tile:(z,x,y)=>'https://a.tile.opentopomap.org/'+z+'/'+x+'/'+y+'.png'
 }
};
const mapPreferenceKey=(kind,id=actor)=>'startaxi.map.'+id+'.'+kind;
const mapPreferences={fleet:'classic',driver:'classic'};
function loadMapPreferences(){
 for(const kind of ['fleet','driver']){
   let value;
   try{value=localStorage.getItem(mapPreferenceKey(kind));}catch{}
   mapPreferences[kind]=Object.hasOwn(mapStyles,value)?value:'classic';
 }
}
function syncMapControls(){
 for(const kind of ['fleet','driver']) $('#'+kind+'-map-style').value=mapPreferences[kind];
}
for(const kind of ['fleet','driver']){
 const select=$('#'+kind+'-map-style');
 select.replaceChildren(...Object.entries(mapStyles).map(([key,style])=>new Option(style.label,key)));
 select.addEventListener('change',()=>{
   if(!Object.hasOwn(mapStyles,select.value)) return;
   mapPreferences[kind]=select.value;
   try{localStorage.setItem(mapPreferenceKey(kind),select.value);}catch{}
   renderMap();
   renderDriverMap();
 });
}
function renderTiles(layer,kind,level,x,y,w,h){
 const style=mapPreferences[kind];
 const {tile,credit}=mapStyles[style];
 const key=[style,level,x,y,w,h].join();
 if(layer.dataset.view===key) return;
 layer.dataset.view=key;
 layer.parentElement.querySelector('.mapcredit').innerHTML=credit;
 const count=2**level;
 let tiles='';
 for(let tx=Math.floor(x/256);tx<=Math.floor((x+w)/256);tx++) for(let ty=Math.floor(y/256);ty<=Math.floor((y+h)/256);ty++){
   if(ty<0||ty>=count) continue;
   const wrap=((tx%count)+count)%count;
   tiles+='<img alt="" draggable="false" style="left:'+(tx*256-x)+'px;top:'+(ty*256-y)+'px" src="'+tile(level,wrap,ty)+'">';
 }
 layer.innerHTML='<div class="mapfallback"><small>Mapový podklad se načítá</small></div>'+tiles;
 layer.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{
   img.style.display='none';
   layer.querySelector('.mapfallback small').textContent='Mapový podklad je nedostupný';
 }));
}
function renderDriverMap(){
 const map=$('#driver-map'), w=map.clientWidth, h=map.clientHeight;
 if(!live||page!=='driver'||(!can('driverRide')&&!can('gps'))||!w||!h) return;
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
 renderTiles(map.querySelector('.map-tiles'),'driver',level,x,y,w,h);
 map.querySelector('.map-markers').innerHTML=stops.map(([,symbol,color,label],index)=>{
   const point=points[index];
   return '<span class="marker stop-marker '+color+'" style="left:'+(point.x-x)+'px;top:'+(point.y-y)+'px" role="img" aria-label="'+label+'">'+icon(symbol)+'<small>'+label+'</small></span>';
 }).join('');
}
let lastMarkerMarkup, lastStatusMarkup;
function renderMap(){
 const map=$('#map'), w=map.clientWidth,h=map.clientHeight;
 if(!live||page!=='dispatch'||!can('fleetMap')||!w||!h) return;
 const c=project(center), x=c.x-w/2-offset.x,y=c.y-h/2-offset.y;
 renderTiles($('#tiles'),'fleet',zoom,x,y,w,h);
 const markers=drivers.map(d=>{
   const p=state.positions[d.id];
   if(!fresh(p)) return '';
   const j=busy(state,d.id), point=project(p);
   if(point.x-x<0||point.x-x>w||point.y-y<0||point.y-y>h) return '';
   const distance=j?.status==='onboard'&&j.target&&fresh(p)?meters(p,j.target):null;
   const color=distance!==null&&distance<=2000?'orange':occupied(d.id)?'red':'green';
     const label=d.name+' · '+(j?statusText[j.status]:occupied(d.id)?'obsazený':'volný')+(p.accuracy!=null?' · ±'+Math.round(p.accuracy)+' m':'');
   const markerPosition='left:'+(point.x-x)+'px;top:'+(point.y-y)+'px';
   const vehicle=vehicleById(d.vehicleId);
   const marker='<button type="button" '+(can('assign')?'':'disabled ')+'class="marker '+color+(selected===d.id?' selected':'')+'" style="'+markerPosition+'" data-car="'+d.id+'" title="'+esc(label)+'" aria-label="'+esc(label)+'">'+icon('taxi')+'</button>';
   return marker+'<div class="map-driver-label" style="'+markerPosition+'"><strong>'+esc(d.lastName||d.name)+'</strong>'+vehicleLink(vehicle)+'</div>';
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
 if(lastMarkerMarkup!==markers){$('#markers').innerHTML=markers;lastMarkerMarkup=markers;}
 const status=drivers.filter(d=>fresh(state.positions[d.id]));
 const statusMarkup=status.map(d=>'<span><strong>'+esc(d.lastName||d.name)+'</strong> · '+(occupied(d.id)?'obsazený':'volný')+vehicleLink(vehicleById(d.vehicleId))+'</span>').join('');
 if(lastStatusMarkup!==statusMarkup){$('#vehicle-status').innerHTML=statusMarkup;lastStatusMarkup=statusMarkup;}
}
let drag;
$('#map').addEventListener('pointerdown',e=>{
 if(e.target.closest('button,select,label')) return;
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
   if(!canSeePage(d.page)) return;
   page=d.page;
   if(page==='settings') fillProfileForm();
   render();
   return;
 }
 if(d.close!==undefined){b.closest('dialog').close();return;}
 if(d.vehicleProfile){showVehicle(d.vehicleProfile);return;}
 if(d.zoom!==undefined){
   if(Number(d.zoom)===0){zoom=13;offset={x:0,y:0};}
   else {const next=Math.max(11,Math.min(17,zoom+Number(d.zoom)));offset={x:offset.x*2**(next-zoom),y:offset.y*2**(next-zoom)};zoom=next;}
   renderMap();return;
 }
 if(d.queue){queue=d.queue;renderQueue();return;}
 if(d.car&&can('assign')){
   if(occupied(d.car)){notify('Toto vozidlo je obsazené.');return;}
   if(live&&!fresh(state.positions[d.car])){notify('Řidič nesdílí aktuální polohu.');return;}
   selected=selected===d.car?'':d.car;queue='waiting';render();
   if(selected) notify(driverName(selected)+' · vyberte zakázku');
   return;
 }
 if(d.jobEdit&&can(d.jobEdit==='cancelJob'?'cancel':'edit')){
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
 if(d.job&&can('assign')){
   if(!selected){notify('Nejdříve vyberte volné vozidlo na mapě.');return;}
   const name=driverName(selected);
   if(await perform({type:'assign',id:Number(d.job),driver:selected})) notify('Zakázka přiřazena · '+name);
   return;
 }
 if(d.drive&&can('driverRide')){
   if(await perform({type:d.drive,id:Number(d.id)})) notify({accept:'Zakázka přijata.',pickup:'Vyzvednutí potvrzeno.',complete:'Jízda dokončena.'}[d.drive]);
   return;
 }
 if(d.availability!==undefined&&can('availability')){
   await perform({type:'availability',occupied:!state.occupied?.[actor]});
   return;
 }
 if(d.gps!==undefined&&can('gps')){toggleGps();return;}
 if(d.shift!==undefined&&can('closeShift')){
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
const employeeForm=$('#employee-form');
const permissionForm=$('#permissions-form');
function renderPermissionChoices(container,role,chosen){
 container.innerHTML=availablePermissions(role).map(key=>
   '<label><input type="checkbox" name="permissions" value="'+key+'" '+(chosen.includes(key)?'checked':'')+'>'+permissionLabels[key]+'</label>'
 ).join('');
}
function fillDefaultPermissions(){
 const role=employeeForm.elements.role.value;
 renderPermissionChoices($('#new-permissions'),role,defaultPermissions(role));
}
fillDefaultPermissions();
employeeForm.elements.role.addEventListener('change',fillDefaultPermissions);
const vehicleById=id=>vehicles.find(vehicle=>vehicle.id===id);
const vehicleName=vehicle=>[vehicle.make,vehicle.model].filter(Boolean).join(' ')||'Vozidlo '+vehicle.id.slice(0,6);
const makeLogos=new Map([
 ['skoda','skoda'],['volkswagen','volkswagen'],['vw','volkswagen'],['toyota','toyota'],
 ['hyundai','hyundai'],['kia','kia'],['ford','ford'],['dacia','dacia'],['renault','renault'],
 ['peugeot','peugeot'],['citroen','citroen'],['mercedes','mercedesbenz'],['mercedes benz','mercedesbenz'],
 ['mercedes-benz','mercedesbenz'],['bmw','bmw'],['audi','audi'],['seat','seat'],
 ['opel','opel'],['fiat','fiat'],['nissan','nissan'],['mazda','mazda'],['tesla','tesla'],
 ['volvo','volvo'],['honda','honda'],['suzuki','suzuki'],['mitsubishi','mitsubishi'],
 ['lexus','lexus'],['subaru','subaru'],['cupra','cupra']
]);
function vehicleLogo(vehicle){
 const make=vehicle?.make.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
 const slug=makeLogos.get(make);
 return '<span class="vehicle-logo">'+icon('taxi')+(slug?'<img src="https://cdn.simpleicons.org/'+slug+'" alt="" width="20" height="20">':'')+'</span>';
}
document.addEventListener('error',event=>{
 if(event.target.matches?.('.vehicle-logo img')) event.target.remove();
},true);
function vehicleLink(vehicle){
 return vehicle?'<button type="button" class="vehicle-link" data-vehicle-profile="'+esc(vehicle.id)+'">'+esc(vehicleName(vehicle))+'</button>':'';
}
function showVehicle(id){
 const vehicle=vehicleById(id);
 if(!vehicle) return;
 $('#vehicle-profile-name').textContent=vehicleName(vehicle);
 $('#vehicle-profile-logo').innerHTML=vehicleLogo(vehicle);
 const photo=$('#vehicle-photo');
 photo.hidden=!vehicle.hasPhoto;
 if(vehicle.hasPhoto) photo.src='/api/vehicle-photo/'+encodeURIComponent(id)+'?v='+revision;
 else photo.removeAttribute('src');
 $('#vehicle-profile').showModal();
}
const vehicleForm=$('#vehicle-form'), driverVehicleForm=$('#driver-vehicle-form');
function renderFleetSettings(){
 const vehicle=vehicleById(drivers.find(driver=>driver.id===actor)?.vehicleId);
 const own=$('#profile-vehicle');
 own.hidden=role!=='driver';
 own.innerHTML=vehicle?'Přiřazené vozidlo '+vehicleLink(vehicle):'Vozidlo nepřiřazeno';
 $('#fleet-settings').hidden=!isOwner(actor);
 if(!isOwner(actor)) return;
 $('#fleet-list').innerHTML=vehicles.map(vehicle=>{
   const driver=state.employees.find(employee=>employee.vehicleId===vehicle.id);
   const assignee=driver?[driver.firstName,driver.lastName].filter(Boolean).join(' ')||driver.username:'Nepřiřazeno';
   return '<div class="employee"><div><div class="vehicle-heading">'+vehicleLogo(vehicle)+vehicleLink(vehicle)+'</div><p>'+esc(assignee)+'</p></div>'+
     '<button type="button" data-edit-vehicle="'+esc(vehicle.id)+'">Upravit</button></div>';
 }).join('')||'<p>Zatím nejsou přidaná žádná vozidla.</p>';
}
function editVehicle(vehicle){
 vehicleForm.reset();
 vehicleForm.dataset.id=vehicle?.id??'';
 vehicleForm.elements.make.value=vehicle?.make??'';
 vehicleForm.elements.model.value=vehicle?.model??'';
 $('#vehicle-editor-title').textContent=vehicle?'Upravit vozidlo':'Přidat vozidlo';
 $('#remove-vehicle-photo').hidden=!vehicle?.hasPhoto;
 $('#vehicle-editor').showModal();
}
$('#add-vehicle').addEventListener('click',()=>editVehicle());
$('#fleet-list').addEventListener('click',event=>{
 const id=event.target.closest('[data-edit-vehicle]')?.dataset.editVehicle;
 if(id) editVehicle(vehicleById(id));
});
function selectVehicle(id){
 driverVehicleForm.dataset.vehicleId=id;
 const vehicle=vehicleById(id);
 $('#vehicle-selection').innerHTML=vehicle?vehicleLogo(vehicle)+esc(vehicleName(vehicle)):'Bez vozidla';
 $('#vehicle-picker').open=false;
}
function assignVehicle(employee){
 driverVehicleForm.dataset.id=employee.id;
 $('#vehicle-driver-name').textContent=[employee.firstName,employee.lastName].filter(Boolean).join(' ')||employee.username;
 const occupied=new Set(state.employees.filter(driver=>driver.id!==employee.id).map(driver=>driver.vehicleId));
 $('#vehicle-options').innerHTML='<button type="button" data-vehicle-option="">Bez vozidla</button>'+vehicles.map(vehicle=>
   '<button type="button" data-vehicle-option="'+esc(vehicle.id)+'" '+(occupied.has(vehicle.id)?'disabled':'')+'>'+
    vehicleLogo(vehicle)+esc(vehicleName(vehicle))+(occupied.has(vehicle.id)?' · přiřazeno':'')+'</button>'
 ).join('');
 selectVehicle(employee.vehicleId??'');
 $('#driver-vehicle-editor').showModal();
}
$('#vehicle-options').addEventListener('click',event=>{
 const option=event.target.closest('[data-vehicle-option]');
 if(option&&!option.disabled){selectVehicle(option.dataset.vehicleOption);$('#vehicle-selection').focus();}
});
async function prepareVehiclePhoto(file){
 if(file.size>15000000) throw Error('Vyberte obrázek do 15 MB.');
 const bitmap=await createImageBitmap(file);
 try{
   const scale=Math.min(1,640/Math.max(bitmap.width,bitmap.height));
   const canvas=document.createElement('canvas');
   canvas.width=Math.max(1,Math.round(bitmap.width*scale));
   canvas.height=Math.max(1,Math.round(bitmap.height*scale));
   const context=canvas.getContext('2d',{alpha:false});
   context.fillStyle='#fff';
   context.fillRect(0,0,canvas.width,canvas.height);
   context.drawImage(bitmap,0,0,canvas.width,canvas.height);
   for(const quality of [.82,.65,.5,.35,.2]){
     const photo=canvas.toDataURL('image/jpeg',quality);
     if(photo.length<=112000) return photo;
   }
   throw Error('Obrázek je příliš velký.');
 }finally{bitmap.close();}
}
for(const [form,path,dialog,message] of [
 [vehicleForm,'vehicles','#vehicle-editor','Vozidlo bylo uloženo.'],
 [driverVehicleForm,'vehicle-assignment','#driver-vehicle-editor','Přiřazení bylo uloženo.']
]){
 form.addEventListener('submit',async event=>{
   event.preventDefault();
   const submit=form.querySelector('[type="submit"]');
   const generation=sessionGeneration;
   submit.disabled=true;
   try{
     const payload={id:form.dataset.id};
     if(form===vehicleForm){
       const {make,model,photo,removePhoto}=form.elements;
       Object.assign(payload,{make:make.value,model:model.value});
       if(photo.files.length) payload.photo=await prepareVehiclePhoto(photo.files[0]);
       else if(removePhoto.checked) payload.photo='';
     }else payload.vehicleId=form.dataset.vehicleId;
     if(!live||generation!==sessionGeneration) return;
     const data=await api(path,payload);
     if(!live||generation!==sessionGeneration) return;
     receive(data);
     $(dialog).close();
     notify(message);
   }catch(error){
     if(generation!==sessionGeneration) return;
     if(error.status===401) lockApp();
     notify(error.message);
   }finally{submit.disabled=false;}
 });
}
function renderUserSettings(){
 $('#user-settings').hidden=!isOwner(actor);
 if(!isOwner(actor)) return;
 $('#employee-list').innerHTML=(state.employees||[]).map(employee=>
   '<div class="employee"><div><strong>'+esc([employee.firstName,employee.lastName].filter(Boolean).join(' ')||employee.username)+'</strong><p>'+roleLabel(employee.role)+' · '+esc(employee.username)+'</p>'+
   (employee.role==='driver'?(vehicleLink(vehicleById(employee.vehicleId))||'<p>Vozidlo nepřiřazeno</p>'):'')+'</div><div class="employee-actions">'+
   '<button type="button" data-employee="'+esc(employee.id)+'">Upravit oprávnění</button>'+
   (employee.role==='driver'?'<button type="button" data-assign-vehicle="'+esc(employee.id)+'">Vybrat vozidlo</button>':'')+'</div></div>'
 ).join('')||'<p class="empty">Zatím nejsou vytvořené žádné účty.</p>';
}
$('#employee-list').addEventListener('click',event=>{
 const assignment=event.target.closest('[data-assign-vehicle]');
 const id=assignment?.dataset.assignVehicle??event.target.closest('[data-employee]')?.dataset.employee;
 const employee=state.employees.find(entry=>entry.id===id);
 if(!employee) return;
 if(assignment){assignVehicle(employee);return;}
 permissionForm.dataset.id=employee.id;
 $('#permission-employee').textContent=[employee.firstName,employee.lastName].filter(Boolean).join(' ')||employee.username;
 renderPermissionChoices($('#edit-permissions'),employee.role,employee.permissions);
 $('#permission-editor').showModal();
});
for(const [form,path,message] of [
 [employeeForm,'employees','Účet zaměstnance byl vytvořen.'],
 [permissionForm,'employee-permissions','Oprávnění byla uložena.']
]){
 form.addEventListener('submit',async event=>{
   event.preventDefault();
   const fields=new FormData(form);
   const payload={...Object.fromEntries(fields),permissions:fields.getAll('permissions')};
   if(form===permissionForm) payload.id=form.dataset.id;
   const submit=form.querySelector('[type="submit"], .primary');
   const generation=sessionGeneration;
   submit.disabled=true;
   try{
     const data=await api(path,payload);
     if(!live||generation!==sessionGeneration) return;
     receive(data);
     if(form===permissionForm) $('#permission-editor').close();
     else {form.reset();fillDefaultPermissions();}
     notify(message);
   }catch(error){
     if(generation!==sessionGeneration) return;
     if(error.status===401) lockApp();
     notify(error.message);
   }finally{submit.disabled=false;}
 });
}
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
