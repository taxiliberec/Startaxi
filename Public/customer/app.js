import {localAddresses} from '/address-client.js';
import {foldStreet} from '/address-search.js';
const $=selector=>document.querySelector(selector);
const panel=$('#panel');
const menu=$('#menu');
const rideForm=$('#ride');
const profileForm=$('#profile-form');
const bookingPoints={};
const titles={booking:'Objednat jízdu',history:'Moje historie jízd',offers:'Moje akce',contacts:'Kontakty',profile:'Nastavení účtu'};
const statuses={waiting:'Čeká na potvrzení',confirmed:'Potvrzeno',assigned:'Přiděleno řidiči',accepted:'Řidič jede k vám',onboard:'Probíhá',done:'Dokončeno',cancelled:'Zrušeno',rejected:'Odmítnuto dispečinkem'};
const dateTime=new Intl.DateTimeFormat('cs-CZ',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Prague'});
const currency=new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK'});
let account, map, positionDot, accuracyCircle, mapPicking, page, requestId, fareLookup, expectedCents, stopLocation;
const bookingPins={};
const liberec=[50.7695,15.0514];
function element(tag,value,className){
  const node=document.createElement(tag);
  node.textContent=value;
  if(className) node.className=className;
  return node;
}
async function api(path,body,signal){
  const response=await fetch('/api/customer/'+path,{
    method:body?'POST':'GET',cache:'no-store',
    headers:body?{'Content-Type':'application/json'}:{},
    body:body&&JSON.stringify(body),signal:signal?(AbortSignal.any?.([signal,AbortSignal.timeout(15000)])??signal):AbortSignal.timeout(15000)
  });
  const data=await response.json();
  if(!response.ok){
    if(response.status===401&&account) signOut();
    throw Object.assign(Error(data.error||'Spojení se Startaxi selhalo.'),{status:response.status,code:data.code});
  }
  return data;
}
function message(text='',success=false){
  const node=$('#panel-message');
  node.textContent=text;
  node.toggleAttribute('data-success',success);
}
function mapMessage(text){
  $('#map-message').hidden=!text;
  $('#map-message').textContent=text;
}
let bookingStep=0;
const stopAddresses=()=>Array.from($('#stop-list').querySelectorAll('input'),input=>input.value.trim());
function summarizeRoute(){
  const route=[rideForm.elements.pickup.value,...stopAddresses().filter(Boolean),rideForm.elements.dropoff.value];
  $('#route-summary').replaceChildren(...route.map(address=>element('li',address)));
}
function showStep(step){
  bookingStep=step;
  for(const [i,label] of Array.from(document.querySelectorAll('#booking-progress li')).entries()){
    if(i===step) label.setAttribute('aria-current','step');
    else label.removeAttribute('aria-current');
    label.classList.toggle('complete',i<step);
  }
  for(const section of rideForm.querySelectorAll('[data-step]')) section.hidden=Number(section.dataset.step)!==step;
  if(step<2) rideForm.elements[step===0?'pickup':'dropoff'].focus();
  else summarizeRoute();
  void refreshFare();
}
async function advance(){
  const step=bookingStep;
  const input=rideForm.elements[bookingStep===0?'pickup':'dropoff'];
  if(!input.value.trim()) input.value='';
  if(!input.reportValidity()) return;
  const address=input.value.trim();
  if(!bookingPoints[input.name]){
    const matches=await localAddresses(address).catch(()=>null);
    if(bookingStep!==step||input.value.trim()!==address||!panel.open||page!=='booking') return;
    const exact=matches?.find(match=>foldStreet(match.address.split(',')[0])===foldStreet(address.split(',')[0]));
    if(exact) setPoint(input.name,exact.point,exact.address);
  }
  showStep(step+1);
}
rideForm.addEventListener('keydown',event=>{
  if(event.key==='Enter'&&bookingStep<2&&event.target.tagName==='INPUT'){
    event.preventDefault();
    advance();
  }
});
for(const button of rideForm.querySelectorAll('[data-next]')) button.addEventListener('click',advance);
for(const button of rideForm.querySelectorAll('[data-back]')) button.addEventListener('click',()=>showStep(Number(button.dataset.back)));
let stopTimer;
function stopsChanged(){
  summarizeRoute();
  expectedCents=undefined;
  fareLookup?.abort();
  $('#fare-preview').hidden=true;
  clearTimeout(stopTimer);
  stopTimer=setTimeout(refreshFare,350);
}
$('#add-stop').addEventListener('click',()=>{
  const row=document.createElement('div');
  const label=element('label','Adresa mezizastávky');
  const input=document.createElement('input');
  input.required=true;
  input.maxLength=200;
  const list=element('div','','suggestions');
  list.setAttribute('aria-live','polite');
  bindSuggestions(input,list,suggestion=>{input.value=suggestion.address;stopsChanged();},stopsChanged);
  label.append(input);
  const remove=element('button','Odebrat mezizastávku');
  remove.type='button';
  remove.addEventListener('click',()=>{row.remove();stopsChanged();});
  row.append(label,list,remove);
  $('#stop-list').append(row);
  input.focus();
  stopsChanged();
});
function resetRide(){
  $('#stop-list').replaceChildren();
  showStep(0);
  rideForm.reset();
  rideForm.elements.rewardKey.value='';
  rideForm.elements.timing.dispatchEvent(new Event('change'));
  for(const field of ['pickup','dropoff']){
    delete bookingPoints[field];
    $('#'+field+'-suggestions').replaceChildren();
  }
  for(const field of Object.keys(bookingPins)) clearPin(field);
  requestId=null;
  void refreshFare();
}
function signOut(){
  account=null;
  menu.close();
  panel.close();
  resetRide();
  stopLocation?.();
  positionDot?.remove();
  accuracyCircle?.remove();
  positionDot=null;
  accuracyCircle=null;
  showMapPicker(null);
  $('#app').hidden=true;
  $('#auth').hidden=false;
  $('#auth-error').textContent='';
  $('#last-ride').hidden=true;
  $('#book').textContent='Objednat jízdu';
  mapMessage('');
}
function signIn(profile){
  account=profile;
  $('#customer-name').textContent=profile.firstName+' '+profile.lastName;
  $('#auth').hidden=true;
  $('#app').hidden=false;
  startMap();
  map?.setView(liberec,14);
  requestAnimationFrame(()=>map?.invalidateSize());
  void refreshRides().catch(()=>{});
  navigator.permissions?.query({name:'geolocation'}).then(permission=>{
    if(permission.state==='granted'&&account===profile) locate();
  }).catch(()=>{});
}
function startMap(){
  if(map||!window.L){
    if(!map) mapMessage('Mapu se nepodařilo načíst. Adresy můžete zadat ručně.');
    return;
  }
  map=window.L.map('map',{zoomControl:false}).setView(liberec,14);
  window.L.control.zoom({position:'bottomright'}).addTo(map);
  const tiles=window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  tiles.on('tileerror',()=>{
    if(!$('#map-message').textContent) mapMessage('Mapové podklady jsou dočasně nedostupné.');
  });
  tiles.on('tileload',()=>{
    if($('#map-message').textContent==='Mapové podklady jsou dočasně nedostupné.') mapMessage('');
  });
  map.on('click',event=>{
    if(mapPicking) map.panTo(event.latlng,{animate:false});
  });
  void loadVectorMap(tiles);
}
async function loadVectorMap(raster){
  const loadScript=src=>new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src=src;
    script.onload=resolve;
    script.onerror=reject;
    document.head.append(script);
  });
  // Keep the raster map visible until the vector style has rendered successfully.
  let vector,timer;
  const fallback=()=>{
    clearTimeout(timer);
    if(vector&&map.hasLayer(vector)) map.removeLayer(vector);
    if(!map.hasLayer(raster)) raster.addTo(map);
  };
  try{
    if(!window.WebGL2RenderingContext) return;
    await loadScript('./maplibre-gl.js');
    const stylesheet=document.createElement('link');
    stylesheet.rel='stylesheet';
    stylesheet.href='./maplibre-gl.css';
    document.head.append(stylesheet);
    await loadScript('./leaflet-maplibre-gl.js');
    vector=window.L.maplibreGL({
      style:'https://tiles.openfreemap.org/styles/liberty',
      attribution:'<a href="https://openfreemap.org/">OpenFreeMap</a> · © <a href="https://openmaptiles.org/">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      interactive:false,
      padding:0.1
    }).addTo(map);
    const gl=vector.getMaplibreMap();
    timer=setTimeout(fallback,9000);
    gl.once('load',()=>{
      clearTimeout(timer);
      if(map.hasLayer(vector)) map.removeLayer(raster);
    });
    gl.getCanvas().addEventListener('webglcontextlost',fallback,{once:true});
  }catch{fallback();}
}
function showMapPicker(field){
  mapPicking=field;
  $('#map-crosshair').hidden=!field;
  $('#map-pick-controls').hidden=!field;
  $('.map-actions:not(#map-pick-controls)').hidden=Boolean(field);
  if(field){
    $('#confirm-map-point').textContent=field==='pickup'?'Potvrdit vyzvednutí':'Potvrdit cíl';
    mapMessage('Posuňte mapu pod špendlík a potvrďte přesné místo.');
  }else mapMessage('');
}
async function addressForPoint(field,point,label,profile=account){
  const fallback=label+' '+point.lat.toFixed(5)+', '+point.lng.toFixed(5);
  setPoint(field,point,fallback);
  try{
    const {address}=await api('reverse-geocode',{point});
    if(account===profile&&bookingPoints[field]===point&&address) setPoint(field,point,address);
  }catch{}
}
function locate(useForPickup=false){
  const report=useForPickup?message:mapMessage;
  stopLocation?.();
  if(!navigator.geolocation){
    report('Tento prohlížeč polohu neposkytuje. Adresu můžete zadat ručně.');
    return;
  }
  const current=account;
  const value=rideForm.elements.pickup.value;
  let watch,timer,best,first=true;
  const stop=()=>{
    clearTimeout(timer);
    if(watch!==undefined) navigator.geolocation.clearWatch(watch);
    if(stopLocation===stop) stopLocation=null;
  };
  stopLocation=stop;
  const finish=(errorCode)=>{
    if(stopLocation!==stop) return;
    stop();
    if(account!==current) return;
    if(best){
      const {point,accuracy}=best;
      if(useForPickup&&panel.open&&page==='booking'&&rideForm.elements.pickup.value===value){
        void addressForPoint('pickup',point,'Moje poloha',current);
      }
      report('Přesnost polohy přibližně '+Math.round(accuracy)+' m.'+
        (accuracy>40?' Podle potřeby upřesněte místo na mapě.':''));
    }else if(errorCode===1) report('Povolte přístup k poloze v prohlížeči nebo zadejte adresu ručně.');
    else report('Polohu se nepodařilo získat. Zkuste to znovu nebo zadejte adresu ručně.');
  };
  report('Hledám přesnou polohu…');
  timer=setTimeout(()=>finish(),14000);
  watch=navigator.geolocation.watchPosition(({coords})=>{
    if(account!==current||stopLocation!==stop) return;
    const accuracy=coords.accuracy;
    if(!Number.isFinite(accuracy)||accuracy<0||(best&&accuracy>=best.accuracy)) return;
    const point={lat:coords.latitude,lng:coords.longitude};
    best={point,accuracy};
    if(map){
      const latlng=[point.lat,point.lng];
      if(!positionDot){
        positionDot=window.L.circleMarker(latlng,{radius:8,color:'#fff',weight:3,fillColor:'#1765a5',fillOpacity:1}).addTo(map);
        accuracyCircle=window.L.circle(latlng,{radius:accuracy,color:'#1765a5',weight:1,fillOpacity:.12,interactive:false}).addTo(map);
      }else{
        positionDot.setLatLng(latlng);
        accuracyCircle.setLatLng(latlng).setRadius(accuracy);
      }
      if(first||mapPicking) map.setView(latlng,Math.max(map.getZoom(),17),{animate:false});
    }
    first=false;
    if(accuracy<=25) finish();
  },({code})=>{if(code===1) finish(code);},{
    enableHighAccuracy:true,timeout:12000,maximumAge:5000
  });
}
function clearPin(field){
  bookingPins[field]?.remove();
  delete bookingPins[field];
}
function setPoint(field,point,address){
  bookingPoints[field]=point;
  rideForm.elements[field].value=address;
  $('#'+field+'-suggestions').replaceChildren();
  if(map){
    clearPin(field);
    const icon=window.L.divIcon({className:'map-pin map-pin--'+field,iconSize:[19,19]});
    bookingPins[field]=window.L.marker([point.lat,point.lng],{icon,alt:field==='pickup'?'Vyzvednutí':'Cíl'}).addTo(map);
  }
  void refreshFare();
}
async function refreshFare(){
  fareLookup?.abort();
  const output=$('#fare-preview');
  const selector=rideForm.elements.rewardKey;
  const selected=selector.value;
  output.hidden=true;
  expectedCents=undefined;
  if(bookingStep!==2||!account||!panel.open||page!=='booking'||!rideForm.checkValidity()){
    selector.replaceChildren();
    selector.disabled=true;
    $('#booking-reward').hidden=true;
    return;
  }
  const lookup=fareLookup=new AbortController();
  output.textContent='Počítám cenu…';
  output.hidden=false;
  requestId??=crypto.randomUUID();
  try{
    const payload={...Object.fromEntries(new FormData(rideForm)),requestId,stops:stopAddresses(),pickupPoint:bookingPoints.pickup,target:bookingPoints.dropoff};
    const {cents,rewards=[],discountCents=0}=await api('fare',payload,lookup.signal);
    if(lookup.signal.aborted||!panel.open||page!=='booking') return;
    selector.replaceChildren(new Option('Bez odměny',''));
    for(const reward of rewards) selector.append(new Option(reward.name+' · '+rewardDescription(reward),reward.key));
    if(rewards.some(reward=>reward.key===selected)) selector.value=selected;
    selector.disabled=!rewards.length;
    $('#booking-reward').hidden=!rewards.length;
    expectedCents=cents;
    output.textContent=cents===null?'Cenu sdělí dispečink.'
      :'Cena před odesláním '+currency.format(cents/100)+(discountCents?' po slevě '+currency.format(discountCents/100):'');
  }catch{
    if(!lookup.signal.aborted) output.textContent='Cenu se nepodařilo ověřit. Zkuste to znovu.';
  }
}
function renderRides(rides){
  const list=$('#rides');
  list.replaceChildren();
  if(!rides.length) list.append(element('p','Zatím tu nejsou žádné jízdy.'));
  for(const ride of rides){
    const card=element('article','','ride-card');
    const time=element('time',dateTime.format(ride.done??ride.created));
    time.dateTime=new Date(ride.done??ride.created).toISOString();
    const reservation=ride.scheduled?element('p','Vyzvednutí '+ride.scheduled.slice(0,10).split('-').reverse().join('.')+' v '+ride.scheduled.slice(11),'details'):null;
    card.append(time,element('p',[ride.pickup,...(ride.stops||[]),ride.dropoff].join(' → '),'ride-route'));
    if(reservation) card.append(reservation);
    const badge=element('strong',statuses[ride.status]||ride.status);
    badge.dataset.rideStatus=ride.status;
    card.append(badge);
    if(ride.cents!==null) card.append(element('p',currency.format(ride.cents/100),'details'));
    if(ride.rewardDiscountCents) card.append(element('p',ride.rewardName+' · sleva '+currency.format(ride.rewardDiscountCents/100),'details'));
    list.append(card);
  }
}
let ridesRevision=0;
async function refreshRides(){
  const revision=++ridesRevision;
  const current=account;
  const rides=await api('rides');
  if(account!==current||revision!==ridesRevision) return;
  const latest=rides.find(ride=>!['done','cancelled','rejected'].includes(ride.status));
  const lastRide=$('#last-ride');
  lastRide.hidden=!latest;
  if(latest) lastRide.textContent='Jízda č. '+latest.id+' · '+statuses[latest.status];
  if(page==='history'&&panel.open) renderRides(rides);
}
function rewardDescription(reward){
  const value=reward.kind==='free'?'Jízda zdarma':reward.kind==='percent'?'Sleva '+reward.discount+' %':'Sleva '+currency.format(reward.discount);
  return value+(reward.kind?' · zbývá jízd: '+reward.remaining:'');
}
function renderInfo(info,target){
  target.replaceChildren();
  if(target.id==='offer-list'){
    if(info.loyalty){
      const {points,rides,pointsPerRide,rewards}=info.loyalty;
      target.append(element('h3','Věrnostní program'));
      target.append(element('p','Body k využití: '+points+' · Jízdy k využití: '+rides));
      target.append(element('p','Za každou dokončenou jízdu získáte '+pointsPerRide+' bodů.'));
      const list=element('ul','');
      for(const reward of rewards){
        const threshold=reward.threshold+(reward.unit==='points'?' bodů':' jízd');
        list.append(element('li',reward.name+' · '+rewardDescription(reward)+' · '+(reward.available?'Dostupná':reward.kind?reward.progress+' / '+threshold:threshold)));
      }
      target.append(list);
      if(rewards.some(r=>!r.kind)) target.append(element('p','Při využití bodů se použité jízdy odečítají také z odměn za celé jízdy.'));
    }
    if(info.offers?.length){
      const list=element('ul','');
      for(const offer of info.offers) list.append(element('li',offer));
      target.append(list);
    }else if(!info.loyalty) target.append(element('p','Momentálně nemáte žádné akce.'));
    return;
  }
  if(!info.phone&&!info.email&&!info.hours&&!info.weeklyHours?.some(Boolean)) target.append(element('p','Kontakty zatím nejsou vyplněné.'));
  if(info.phone){
    const link=element('a',info.phone);
    link.href='tel:'+info.phone.replace(/[^+0-9]/g,'');
    const line=element('p','Dispečink ');
    line.append(link);
    target.append(line);
  }
  if(info.email){
    const link=element('a',info.email);
    link.href='mailto:'+encodeURIComponent(info.email).replace('%40','@');
    const line=element('p','E-mail ');
    line.append(link);
    target.append(line);
  }
  if(info.weeklyHours?.some(Boolean)){
    target.append(element('h3','Provozní doba'));
    const days=['Pondělí','Úterý','Středa','Čtvrtek','Pátek','Sobota','Neděle'];
    info.weeklyHours.forEach((hours,i)=>target.append(element('p',days[i]+' · '+(hours||'Neuvedeno'))));
  }else if(info.hours) target.append(element('p','Provozní doba '+info.hours));
}
async function openPage(name){
  if(!account) return;
  page=name;
  panel.classList.toggle('booking-panel',name==='booking');
  if(mapPicking) showMapPicker(null);
  menu.close();
  for(const id of Object.keys(titles)) $('#'+id).hidden=id!==name;
  $('#panel-title').textContent=titles[name];
  message();
  if(!panel.open) panel.showModal();
  if(name==='booking') void refreshFare();
  try{
    if(name==='profile'){
      profileForm.reset();
      for(const field of ['username','email','phone']) profileForm.elements[field].value=account[field];
    }else if(name==='history'){
      $('#rides').replaceChildren(element('p','Načítám jízdy…'));
      await refreshRides();
    }else if(name==='contacts'||name==='offers'){
      const target=$(name==='contacts'?'#contact-list':'#offer-list');
      target.replaceChildren(element('p','Načítám…'));
      const info=await api('info');
      if(page===name&&panel.open) renderInfo(info,target);
    }
  }catch(error){
    if(page===name&&panel.open) message(error.message);
  }
}
function bindForm(form,submit,showError){
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const button=form.querySelector('button[type=submit]');
    if(button.disabled) return;
    button.disabled=true;
    showError('');
    try{await submit(Object.fromEntries(new FormData(form)));}
    catch(error){showError(error.message);}
    finally{button.disabled=false;}
  });
}
for(const mode of ['login','register']){
  const form=$('#'+mode);
  bindForm(form,async data=>{
    signIn(await api(mode,data));
    form.reset();
  },text=>{$('#auth-error').textContent=text;});
}
$('#switch-auth').addEventListener('click',event=>{
  const register=$('#register').hidden;
  $('#register').hidden=!register;
  $('#login').hidden=register;
  $('#auth-title').textContent=register?'Vytvořit účet':'Přihlášení';
  $('#auth-error').textContent='';
  event.currentTarget.textContent=register?'Zpět k přihlášení':'Vytvořit účet';
  $(register?'#register input':'#login input').focus();
});
$('#open-menu').addEventListener('click',()=>{
  $('#menu-error').textContent='';
  menu.showModal();
});
for(const button of document.querySelectorAll('[data-close]')){
  button.addEventListener('click',()=>button.closest('dialog').close());
}
for(const button of document.querySelectorAll('[data-page]')){
  button.addEventListener('click',()=>openPage(button.dataset.page));
}
$('#locate').addEventListener('click',()=>locate());
$('#use-location').addEventListener('click',()=>locate(true));
$('#book').addEventListener('click',()=>{
  showMapPicker(null);
  $('#book').textContent='Objednat jízdu';
  if(map) mapMessage('');
  void openPage('booking');
});
$('#last-ride').addEventListener('click',()=>openPage('history'));
$('#logout').addEventListener('click',async event=>{
  const button=event.currentTarget;
  button.disabled=true;
  try{await api('logout',{});signOut();}
  catch(error){$('#menu-error').textContent=error.message;}
  finally{button.disabled=false;}
});
rideForm.elements.timing.addEventListener('change',()=>{
  const later=rideForm.elements.timing.value==='later';
  $('#scheduled-label').hidden=!later;
  rideForm.elements.scheduled.disabled=!later;
  rideForm.elements.scheduled.required=later;
  void refreshFare();
});
rideForm.elements.scheduled.addEventListener('change',()=>refreshFare());
rideForm.elements.rewardKey.addEventListener('change',()=>refreshFare());
function bindSuggestions(input,list,onSelect,onEdit){
  let controller,timer;
  input.addEventListener('input',()=>{
    controller?.abort();
    clearTimeout(timer);
    list.replaceChildren();
    onEdit();
    const address=input.value.trim();
    if(address.length<2) return;
    const lookup=controller=new AbortController();
    const current=()=>!lookup.signal.aborted&&input.isConnected&&input.value.trim()===address&&panel.open&&page==='booking'&&input.getClientRects().length;
    const render=suggestions=>{
      if(!current()) return;
      for(const suggestion of suggestions){
        const option=element('button',suggestion.address);
        if(suggestion.street) option.append(element('small','Střed ulice'));
        option.type='button';
        option.addEventListener('click',()=>{onSelect(suggestion);list.replaceChildren();input.focus();});
        list.append(option);
      }
      if(!suggestions.length) list.append(element('p','Bez shody. Ověřte adresu nebo vyberte bod na mapě.'));
    };
    void localAddresses(address).catch(()=>null).then(matches=>{
      if(!current()) return;
      if(matches!==null){render(matches);return;}
      if(address.length<3) return;
      timer=setTimeout(async()=>{
        try{render((await api('geocode',{address},lookup.signal)).suggestions);}
        catch(error){if(current()) list.append(element('p',error.message));}
      },180);
    });
  });
}
for(const field of ['pickup','dropoff']){
  bindSuggestions(rideForm.elements[field],$('#'+field+'-suggestions'),suggestion=>setPoint(field,suggestion.point,suggestion.address),()=>{
    delete bookingPoints[field];
    clearPin(field);
    fareLookup?.abort();
    expectedCents=undefined;
    $('#fare-preview').hidden=true;
  });
}
for(const button of document.querySelectorAll('[data-pick-on-map]')){
  button.addEventListener('click',()=>{
    if(!map){message('Mapa není dostupná. Adresu můžete zadat ručně.');return;}
    const field=button.dataset.pickOnMap;
    const point=bookingPoints[field]??bookingPoints.pickup;
    if(point) map.setView([point.lat,point.lng],Math.max(17,map.getZoom()),{animate:false});
    else if(map.getZoom()<16) map.setZoom(16);
    panel.close();
    showMapPicker(field);
  });
}
$('#cancel-map-point').addEventListener('click',()=>{
  showMapPicker(null);
  void openPage('booking');
});
$('#confirm-map-point').addEventListener('click',async()=>{
  const field=mapPicking;
  if(!field||!map) return;
  const current=account;
  const {lat,lng}=map.getCenter();
  showMapPicker(null);
  await openPage('booking');
  if(account===current) void addressForPoint(field,{lat,lng},field==='pickup'?'Vyzvednutí na mapě':'Cíl na mapě');
});
bindForm(rideForm,async data=>{
  if(bookingStep<2){advance();return;}
  requestId??=crypto.randomUUID();
  if(expectedCents===undefined){
    await refreshFare();
    throw Error('Před odesláním zkontrolujte cenu.');
  }
  try{
    await api('rides',{...data,requestId,expectedCents,stops:stopAddresses(),pickupPoint:bookingPoints.pickup,target:bookingPoints.dropoff});
  }catch(error){
    if(error.code==='fare_changed') await refreshFare();
    throw error;
  }
  resetRide();
  await openPage('history');
  message('Objednávka byla odeslána dispečinku.',true);
},message);
bindForm(profileForm,async data=>{
  account=await api('profile',data);
  profileForm.elements.currentPassword.value='';
  profileForm.elements.newPassword.value='';
  message('Změny byly uloženy.',true);
},message);

try{signIn(await api('profile'));}
catch(error){if(error.status!==401) $('#auth-error').textContent='Připojení ke Startaxi se nepodařilo ověřit.';}
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
setInterval(()=>{
  if(account&&!document.hidden) void refreshRides().catch(()=>{});
},12000);
