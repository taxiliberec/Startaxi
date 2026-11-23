// Included by build.mjs in the Startaxi Worker.
const customerSessionSeconds=30*86400;
const customerCookie=(secret,age)=>'startaxi_customer='+secret+'; Max-Age='+age+'; Path=/api/customer/; Secure; HttpOnly; SameSite=Strict';
const customerSessionHash=secret=>hash('startaxi/customer/session/v1/'+secret);
const customerSecret=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const customerProfile=({firstName,lastName,username,phone,email})=>({firstName,lastName,username,phone,email});
const customerText=(value,max,required=false)=>{
  if(value==null&&!required) return '';
  if(typeof value!=='string'||value.length>max||(required&&!value.trim())) throw Error('Zkontrolujte povinné údaje a jejich délku.');
  return value.trim();
};
function customerContact(input){
  const phone=customerText(input.phone,32,true),email=customerText(input.email,254,true);
  if(!/^\+?[\d ()-]+$/.test(phone)||phone.replace(/\D/g,'').length<7||
      phone.replace(/\D/g,'').length>15) throw Error('Zadejte platné telefonní číslo.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('Zadejte platný e-mail.');
  return {phone,email};
}
function customerSettings(input){
  const fareMode=input.fareMode??'manual';
  if(!['manual','automatic','fixed'].includes(fareMode)) throw Error('Vyberte způsob účtování.');
  const fixedFare=Number(input.fixedFare);
  if(fareMode==='fixed'&&(!Number.isInteger(fixedFare)||fixedFare<1||fixedFare>10000)){
    throw Error('Zadejte pevnou cenu v celých korunách od 1 do 10 000 Kč.');
  }
  return {
    fareMode,
    ...(input.loyalty?{loyalty:customerLoyaltySettings(input.loyalty)}:{}),
    ...(fareMode==='fixed'?{fixedFare}:{}),
    phone:customerText(input.phone,32),
    email:customerText(input.email,254),
    hours:customerText(input.hours,200),
    offers:customerText(input.offers,2000).split('\n').map(line=>line.trim()).filter(Boolean)
  };
}
function customerLoyaltySettings(input){
  const pointsPerRide=Number(input.pointsPerRide);
  const enabled=input.enabled===true;
  if(!Array.isArray(input.rewards)||input.rewards.length>10||
     !Number.isInteger(pointsPerRide)||pointsPerRide<1||pointsPerRide>1000||
     (enabled&&!input.rewards.length)) throw Error('Nastavte body za jízdu a nejméně jednu odměnu.');
  const rewards=input.rewards.map(({name,unit,threshold,discount})=>{
    name=customerText(name,60,true);
    threshold=Number(threshold);
    discount=Number(discount);
    if(!['points','rides'].includes(unit)||!Number.isInteger(threshold)||threshold<1||threshold>10000||
       !Number.isInteger(discount)||discount<1||discount>10000) throw Error('Zadejte platnou hranici a slevu pro každou odměnu.');
    return {key:[unit,threshold,discount].join(':'),name,unit,threshold,discount};
  });
  if(new Set(rewards.map(reward=>reward.key)).size!==rewards.length) throw Error('Každá odměna musí mít jinou hranici nebo slevu.');
  return {enabled,pointsPerRide,rewards};
}
function customerLoyalty(state,customerId){
  const policy=state.customerSettings?.loyalty;
  if(!policy?.enabled) return null;
  const jobs=state.jobs.filter(job=>job.customerId===customerId);
  const used=new Map();
  for(const job of jobs){
    if(job.status==='cancelled') continue;
    for(const {id,points} of job.rewardCredits??[]) used.set(id,(used.get(id)??0)+points);
  }
  const credits=jobs.flatMap(job=>{
    if(job.status!=='done'||!job.loyaltyPoints) return [];
    const points=job.loyaltyPoints-(used.get(job.id)??0);
    return points>0?[{id:job.id,points,whole:points===job.loyaltyPoints}]:[];
  }).sort((a,b)=>a.id-b.id);
  const points=credits.reduce((total,credit)=>total+credit.points,0);
  const rides=credits.filter(credit=>credit.whole).length;
  const rewards=policy.rewards.map(reward=>({...reward,available:(reward.unit==='points'?points:rides)>=reward.threshold}));
  return {points,rides,pointsPerRide:policy.pointsPerRide,rewards,credits};
}
function customerReward(loyalty,key,cents){
  if(cents===null) return null;
  const reward=loyalty?.rewards.find(reward=>reward.key===key&&reward.available);
  if(!reward) return null;
  const discountCents=Math.min(cents,reward.discount*100);
  if(discountCents<=0) return null;
  let remaining=reward.threshold;
  const credits=[];
  for(const credit of loyalty.credits){
    if(!remaining) break;
    if(reward.unit==='rides'&&!credit.whole) continue;
    const points=reward.unit==='rides'?credit.points:Math.min(remaining,credit.points);
    credits.push({id:credit.id,points});
    remaining-=reward.unit==='rides'?1:points;
  }
  return {discountCents,credits,name:reward.name};
}
function customerUsername(value){
  const username=normalizeUsername(value);
  if(!/^[a-z0-9._-]{3,40}$/.test(username)) throw Error('Přihlašovací jméno musí mít 3 až 40 znaků bez diakritiky a mezer.');
  return username;
}
function customerUnique(state,username,id){
  if(Object.values(state.customerAccounts||{}).some(account=>account.username===username&&account.id!==id)){
    throw Error('Toto přihlašovací jméno už existuje.');
  }
}
function addCustomerSession(state,digest,id){
  const now=Date.now();
  const sessions=(state.customerSessions??={});
  for(const key of Object.keys(sessions)) if(sessions[key].expires<=now) delete sessions[key];
  sessions[digest]={id,expires:now+customerSessionSeconds*1000};
}
async function customerThrottle(db,category,key,max){
  const bucket=await hash(category+':'+key);
  const {state}=await updateState(db,s=>{
    const now=Date.now();
    const attempts=(s.customerAttempts??={});
    for(const id of Object.keys(attempts)) if(attempts[id].until<=now) delete attempts[id];
    if(attempts[bucket]?.count>=max+1) return false;
    const entry=(attempts[bucket]??={count:0,until:now+15*60*1000});
    entry.count++;
  });
  if(state.customerAttempts[bucket].count>max) return json({error:'Příliš mnoho pokusů. Zkuste to později.'},429);
}
const pragueTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Prague',dateStyle:'short',timeStyle:'short'});
function customerRideInput(input){
  const pickup=customerText(input.pickup,200,true),dropoff=customerText(input.dropoff,200,true);
  const scheduled=customerText(input.scheduled,16);
  if(scheduled){
    const parsed=new Date(scheduled+'Z');
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduled)||!Number.isFinite(+parsed)||
       parsed.toISOString().slice(0,16)!==scheduled||
       ![1,2].some(offset=>pragueTime.format(+parsed-offset*3600000).replace(' ','T')===scheduled)||
       scheduled<=pragueTime.format(Date.now()).replace(' ','T')) throw Error('Zvolte platný budoucí čas v Česku.');
  }
  const {payment,requestId,pickupPoint,target}=input;
  if(!['cash','card'].includes(payment)||typeof requestId!=='string'||!/^[a-f0-9-]{36}$/.test(requestId)) throw Error('Zkontrolujte způsob platby.');
  if([pickupPoint,target].some(point=>point!=null&&!validPoint(point))) throw Error('Neplatná poloha na mapě.');
  const point=value=>value==null?undefined:{lat:value.lat,lng:value.lng};
  return {pickup,dropoff,scheduled,payment,requestId,pickupPoint:point(pickupPoint),target:point(target)};
}
async function customerCityRoute(ride){
  // Resolve pricing addresses on the server so request coordinates cannot change the fare.
  const lookup=async address=>{
    const matches=await liberecAddresses(address);
    return matches.find(match=>foldStreet(match.address)===foldStreet(address))?.point;
  };
  try{
    const [pickup,target]=await Promise.all([lookup(ride.pickup),lookup(ride.dropoff)]);
    if(pickup&&target) return {pickup,target};
  }catch{/* When an address cannot be verified, the dispatcher sets the fare. */}
  return null;
}
function customerFare(state,ride,route,now=Date.now()){
  const settings=state.customerSettings;
  if(!route||!settings) return null;
  if(settings.fareMode==='fixed'&&Number.isInteger(settings.fixedFare)) return settings.fixedFare*100;
  if(settings.fareMode!=='automatic') return null;

  const distance=meters(route.pickup,route.target);
  const base=distance<=2000?90:distance<=5000?120:150;
  if(ride.scheduled) return base*100;

  const until=pragueTime.format(now+30*60*1000).replace(' ','T');
  const waiting=state.jobs.filter(job=>job.status==='waiting'&&(!job.scheduled||job.scheduled<=until)).length;
  const available=fleet(state).filter(({id})=>activePosition(state,id,now)&&
    allows(permissionsFor(state,id),'driverRide')&&!state.occupied?.[id]&&!busy(state,id)).length;
  const adjustment=waiting===0&&available>0?-30:Math.min(150,Math.max(0,waiting-available)*30);
  return (base+adjustment)*100;
}
const customerRide=({id,pickup,dropoff,scheduled,payment,created,done,status,confirmedAt,cents,priceSet,rewardDiscountCents,rewardName})=>({
  id,pickup,dropoff,scheduled,payment,created,done,
  status:status==='waiting'&&confirmedAt?'confirmed':status,cents:status==='done'||priceSet?cents:null,
  ...(rewardDiscountCents?{rewardDiscountCents,rewardName}:{})
});
async function customerApi(request,env,action){
  const db=env.DB,method=request.method;
  const post=method==='POST';
  const token=request.headers.get('Cookie')?.match(/(?:^|;\s*)startaxi_customer=([a-f0-9]{64})(?:;|$)/)?.[1];
  if(post&&['register','login'].includes(action)){
    const input=await decode(request);
    const username=customerUsername(input.username);
    const source=request.headers.get('X-Startaxi-Client')||request.headers.get('CF-Connecting-IP')||'local';
    const limited=await customerThrottle(db,action+'-source',source,action==='register'?8:35);
    if(limited) return limited;
    const secret=customerSecret(),digest=await customerSessionHash(secret);
    let account;
    if(action==='register'){
      const credentials=await newPassword(input.password);
      const firstName=customerText(input.firstName,60,true),lastName=customerText(input.lastName,60,true);
      account={id:crypto.randomUUID(),firstName,lastName,username,...customerContact(input),...credentials};
      await updateState(db,state=>{
        customerUnique(state,username);
        (state.customerAccounts??={})[account.id]=account;
        addCustomerSession(state,digest,account.id);
      });
    }else{
      const limited=await customerThrottle(db,'login-user',username,7);
      if(limited) return limited;
      const loginBucket=await hash('login-user:'+username);
      const {state}=await read(db);
      account=Object.values(state.customerAccounts||{}).find(value=>value.username===username);
      const password=input.password;
      if(typeof password!=='string'||password.length>128) throw Error('Neplatné přihlašovací údaje.');
      const verified=await passwordHash(password,account?.salt||'startaxi-customer-unknown-account');
      if(!account||verified!==account.digest) return json({error:'Nesprávné přihlašovací jméno nebo heslo.'},401);
      await updateState(db,s=>{
        const current=s.customerAccounts?.[account.id];
        if(current?.digest!==verified||current.username!==username) throw Error('Přihlaste se znovu.');
        delete s.customerAttempts[loginBucket];
        addCustomerSession(s,digest,account.id);
      });
    }
    return json(customerProfile(account),action==='register'?201:200,{'Set-Cookie':customerCookie(secret,customerSessionSeconds)});
  }
  if(!token){
    if(post&&action==='logout') return json({ok:true},200,{'Set-Cookie':customerCookie('',0)});
    return json({error:'Přihlaste se.'},401);
  }
  const digest=await customerSessionHash(token);
  const {state}=await read(db);
  const active=state.customerSessions?.[digest];
  const account=active?.expires>Date.now()?state.customerAccounts?.[active.id]:null;
  const check=s=>{
    const entry=s.customerSessions?.[digest];
    if(!entry||entry.expires<=Date.now()||entry.id!==account.id) throw Error('Přihlaste se znovu.');
    return s.customerAccounts[account.id];
  };
  if(post&&action==='logout'){
    if(active) await updateState(db,s=>{delete s.customerSessions[digest];});
    return json({ok:true},200,{'Set-Cookie':customerCookie('',0)});
  }
  if(!account) return json({error:'Přihlaste se.'},401);
  if(method==='GET'&&action==='profile') return json(customerProfile(account));
  if(method==='GET'&&action==='info'){
    const {loyalty:policy,...settings}=state.customerSettings||{};
    const loyalty=customerLoyalty(state,account.id);
    if(!loyalty) return json(settings);
    const {credits,...progress}=loyalty;
    return json({...settings,loyalty:progress});
  }
  if(method==='GET'&&action==='rides') return json(state.jobs.filter(job=>job.customerId===account.id).map(customerRide));
  if(post&&['geocode','reverse-geocode'].includes(action)){
    const limited=await customerThrottle(db,'geocode',account.id,180);
    return limited||geocode(request,action);
  }
  if(post&&action==='profile'){
    const input=await decode(request);
    const limited=await customerThrottle(db,'profile',account.id,10);
    if(limited) return limited;
    if(!validPassword(input.currentPassword)||await passwordHash(input.currentPassword,account.salt)!==account.digest){
      throw Error('Stávající heslo nesouhlasí.');
    }
    const fields={username:customerUsername(input.username),...customerContact(input)};
    const credentials=input.newPassword?await newPassword(input.newPassword):{};
    const {state:updated}=await updateState(db,s=>{
      const current=check(s);
      if(current.digest!==account.digest) throw Error('Přihlaste se znovu.');
      customerUnique(s,fields.username,account.id);
      Object.assign(current,fields,credentials);
      if(credentials.digest){
        for(const [key,entry] of Object.entries(s.customerSessions)) if(key!==digest&&entry.id===account.id) delete s.customerSessions[key];
      }
    });
    return json(customerProfile(updated.customerAccounts[account.id]));
  }
  if(post&&action==='fare'){
    const input=await decode(request);
    const ride=customerRideInput(input);
    if(!['fixed','automatic'].includes(state.customerSettings?.fareMode)) return json({cents:null});
    const limited=await customerThrottle(db,'fare',account.id,60);
    if(limited) return limited;
    const cents=customerFare(state,ride,await customerCityRoute(ride));
    const loyalty=customerLoyalty(state,account.id);
    const reward=customerReward(loyalty,input.rewardKey,cents);
    const rewards=cents>0?(loyalty?.rewards.filter(item=>item.available)??[]):[];
    return json({cents:reward?cents-reward.discountCents:cents,rewards,discountCents:reward?.discountCents??0});
  }
  if(post&&action==='rides'){
    const input=await decode(request);
    const previous=state.jobs.find(job=>job.customerId===account.id&&job.requestId===input.requestId);
    if(previous) return json(customerRide(previous),201);
    const ride=customerRideInput(input);
    const route=['fixed','automatic'].includes(state.customerSettings?.fareMode)?await customerCityRoute(ride):null;

    const {state:updated}=await updateState(db,s=>{
      const current=check(s);
      if(s.jobs.some(job=>job.customerId===current.id&&job.requestId===input.requestId)) return false;
      const pending=s.jobs.filter(job=>job.customerId===current.id&&['waiting','assigned','accepted','onboard'].includes(job.status));
      if(pending.length>=5) throw Error('Máte příliš mnoho otevřených objednávek.');
      const now=Date.now();
      const fare=customerFare(s,ride,route,now);
      const reward=input.rewardKey?customerReward(customerLoyalty(s,current.id),input.rewardKey,fare):null;
      if(input.rewardKey&&!reward) throw Error('Tuto odměnu teď nelze použít. Zvolte jinou nebo objednejte bez odměny.');
      const loyalty=s.customerSettings?.loyalty;
      s.jobs.unshift({
        ...ride,id:++s.seq,customerId:current.id,name:current.firstName+' '+current.lastName,
        phone:current.phone,note:'Zákaznická objednávka',
        created:now,status:'waiting',cents:(fare??0)-(reward?.discountCents??0),priceSet:fare!==null,
        ...(loyalty?.enabled?{loyaltyPoints:loyalty.pointsPerRide}:{}),
        ...(reward?{rewardCredits:reward.credits,rewardDiscountCents:reward.discountCents,rewardName:reward.name}:{})
      });
      record(s,'customer','create',s.seq);
    });
    return json(customerRide(updated.jobs.find(job=>job.customerId===account.id&&job.requestId===input.requestId)),201);
  }
  return json({error:'Stránka neexistuje.'},404);
}
