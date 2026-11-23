const $=selector=>document.querySelector(selector);
const panel=$('#panel');
const menu=$('#menu');
const rideForm=$('#ride');
const profileForm=$('#profile-form');
const bookingPoints={};
const titles={booking:'Objednat jízdu',history:'Moje historie jízd',offers:'Moje akce',contacts:'Kontakty',profile:'Nastavení účtu'};
const statuses={waiting:'Čeká na potvrzení',confirmed:'Potvrzeno',assigned:'Přiděleno řidiči',accepted:'Řidič jede k vám',onboard:'Probíhá',done:'Dokončeno',cancelled:'Zrušeno'};
const dateTime=new Intl.DateTimeFormat('cs-CZ',{dateStyle:'medium',timeStyle:'short',timeZone:'Europe/Prague'});
const currency=new Intl.NumberFormat('cs-CZ',{style:'currency',currency:'CZK'});
let account, map, positionDot, pickupPin, mapPicking=false, page, requestId, fareLookup;
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
    throw Object.assign(Error(data.error||'Spojení se Startaxi selhalo.'),{status:response.status});
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
function resetRide(){
  rideForm.reset();
  rideForm.elements.timing.dispatchEvent(new Event('change'));
  for(const field of ['pickup','dropoff']){
    delete bookingPoints[field];
    $('#'+field+'-suggestions').replaceChildren();
  }
  pickupPin?.remove();
  pickupPin=null;
  requestId=null;
  void refreshFare();
}
function signOut(){
  account=null;
  menu.close();
  panel.close();
  resetRide();
  positionDot?.remove();
  positionDot=null;
  mapPicking=false;
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
  map.on('click',async event=>{
    if(!mapPicking||!account) return;
    const current=account;
    mapPicking=false;
    const point={lat:event.latlng.lat,lng:event.latlng.lng};
    $('#book').textContent='Objednat jízdu';
    mapMessage('');
    await openPage('booking');
    if(account!==current) return;
    setPoint('pickup',point,'Bod na mapě '+point.lat.toFixed(5)+', '+point.lng.toFixed(5));
    const fallback=rideForm.elements.pickup.value;
    try{
      const {address}=await api('reverse-geocode',{point});
      if(account===current&&bookingPoints.pickup===point&&rideForm.elements.pickup.value===fallback&&address){
        setPoint('pickup',point,address);
      }
    }catch{}
  });
}
function locate(useForPickup=false){
  const report=useForPickup?message:mapMessage;
  if(!navigator.geolocation){
    report('Tento prohlížeč polohu neposkytuje. Adresu můžete zadat ručně.');
    return;
  }
  const current=account;
  const value=rideForm.elements.pickup.value;
  report('Hledám vaši polohu…');
  navigator.geolocation.getCurrentPosition(async ({coords})=>{
    if(account!==current) return;
    const point={lat:coords.latitude,lng:coords.longitude};
    if(map){
      const latlng=[point.lat,point.lng];
      positionDot?.remove();
      positionDot=window.L.circleMarker(latlng,{radius:9,color:'#fff',weight:3,fillColor:'#1765a5',fillOpacity:1}).bindTooltip('Moje poloha').addTo(map);
      map.setView(latlng,16);
    }
    if(!useForPickup){
      report(mapPicking?'Klepněte na místo vyzvednutí.':'');
      return;
    }
    if(!panel.open||page!=='booking'||rideForm.elements.pickup.value!==value) return;
    const fallback='Moje poloha '+point.lat.toFixed(5)+', '+point.lng.toFixed(5);
    setPoint('pickup',point,fallback);
    report('');
    try{
      const {address}=await api('reverse-geocode',{point});
      if(account===current&&bookingPoints.pickup===point&&address) setPoint('pickup',point,address);
    }catch{}
  },({code})=>{
    if(account!==current) return;
    if(code===1) report('Povolte přístup k poloze v nastavení prohlížeče nebo zadejte adresu ručně.');
    else report('Polohu se nepodařilo získat. Zkuste to znovu nebo zadejte adresu ručně.');
  },{enableHighAccuracy:false,timeout:15000,maximumAge:30000});
}
function setPoint(field,point,address){
  bookingPoints[field]=point;
  rideForm.elements[field].value=address;
  $('#'+field+'-suggestions').replaceChildren();
  if(field==='pickup'&&map){
    pickupPin?.remove();
    const icon=window.L.divIcon({className:'map-pin',iconSize:[19,19]});
    pickupPin=window.L.marker([point.lat,point.lng],{icon,alt:'Místo vyzvednutí'}).addTo(map);
  }
  void refreshFare();
}
async function refreshFare(){
  fareLookup?.abort();
  const output=$('#fare-preview');
  output.hidden=true;
  if(!account||!panel.open||page!=='booking'||!bookingPoints.pickup||!bookingPoints.dropoff||!rideForm.checkValidity()) return;
  const lookup=fareLookup=new AbortController();
  requestId??=crypto.randomUUID();
  try{
    const {cents}=await api('fare',{...Object.fromEntries(new FormData(rideForm)),requestId},lookup.signal);
    if(lookup.signal.aborted||!panel.open||page!=='booking'||cents===null) return;
    output.textContent='Odhad ceny '+currency.format(cents/100);
    output.hidden=false;
  }catch{/* Booking remains available if the price cannot be previewed. */}
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
    card.append(time,element('p',ride.pickup+' → '+ride.dropoff,'ride-route'));
    if(reservation) card.append(reservation);
    card.append(element('strong',statuses[ride.status]||ride.status));
    if(ride.cents!==null) card.append(element('p',currency.format(ride.cents/100),'details'));
    list.append(card);
  }
}
async function refreshRides(){
  const current=account;
  const rides=await api('rides');
  if(account!==current) return;
  const latest=rides.find(ride=>!['done','cancelled'].includes(ride.status));
  const lastRide=$('#last-ride');
  lastRide.hidden=!latest;
  if(latest) lastRide.textContent='Jízda č. '+latest.id+' · '+statuses[latest.status];
  if(page==='history'&&panel.open) renderRides(rides);
}
function renderInfo(info,target){
  target.replaceChildren();
  if(target.id==='offer-list'){
    if(!info.offers?.length){
      target.append(element('p','Momentálně nemáte žádné akce.'));
      return;
    }
    const list=element('ul','');
    for(const offer of info.offers) list.append(element('li',offer));
    target.append(list);
    return;
  }
  if(!info.phone&&!info.email&&!info.hours) target.append(element('p','Kontakty zatím nejsou vyplněné.'));
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
  if(info.hours) target.append(element('p','Provozní doba '+info.hours));
}
async function openPage(name){
  if(!account) return;
  page=name;
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
  mapPicking=false;
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
for(const field of ['pickup','dropoff']){
  const input=rideForm.elements[field];
  const list=$('#'+field+'-suggestions');
  let timer, controller;
  input.addEventListener('input',()=>{
    delete bookingPoints[field];
    void refreshFare();
    list.replaceChildren();
    if(field==='pickup'){pickupPin?.remove();pickupPin=null;}
    clearTimeout(timer);
    controller?.abort();
    const address=input.value.trim();
    if(address.length<3) return;
    timer=setTimeout(async()=>{
      const lookup=controller=new AbortController();
      const isCurrent=()=>!lookup.signal.aborted&&input.value.trim()===address&&!bookingPoints[field]&&page==='booking'&&panel.open;
      try{
        const {suggestions}=await api('geocode',{address},lookup.signal);
        if(!isCurrent()) return;
        for(const suggestion of suggestions.slice(0,8)){
          const option=element('button',suggestion.address);
          option.type='button';
          option.addEventListener('click',()=>{setPoint(field,suggestion.point,suggestion.address);input.focus();});
          list.append(option);
        }
        if(!suggestions.length) list.append(element('p','Bez shody. Můžete doplnit číslo domu nebo obec.'));
      }catch(error){
        if(isCurrent()) list.append(element('p',error.message));
      }
    },350);
  });
}
$('#pick-on-map').addEventListener('click',()=>{
  if(!map){message('Mapa není dostupná. Adresu můžete zadat ručně.');return;}
  mapPicking=true;
  panel.close();
  mapMessage('Klepněte na místo vyzvednutí.');
  $('#book').textContent='Zpět k objednávce';
});
bindForm(rideForm,async data=>{
  requestId??=crypto.randomUUID();
  await api('rides',{...data,requestId,pickupPoint:bookingPoints.pickup,target:bookingPoints.dropoff});
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
