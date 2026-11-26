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
  const fareMode=input.fareMode??'automatic';
  if(!['manual','automatic','fixed'].includes(fareMode)) throw Error('Vyberte způsob účtování.');
  const fixedFare=Number(input.fixedFare);
  if(fareMode==='fixed'&&(!Number.isInteger(fixedFare)||fixedFare<1||fixedFare>10000)){
    throw Error('Zadejte pevnou cenu v celých korunách od 1 do 10 000 Kč.');
  }
  return {
    fareMode,
    ...(input.weeklyHours?{weeklyHours:weeklyHours(input.weeklyHours)}:{}),
    ...(input.loyalty?{loyalty:customerLoyaltySettings(input.loyalty)}:{}),
    ...(Number.isInteger(fixedFare)&&fixedFare>0&&fixedFare<=10000?{fixedFare}:{}),
    phone:customerText(input.phone,32),
    email:customerText(input.email,254),
    hours:customerText(input.hours,200),
    offers:customerText(input.offers,2000).split('\n').map(line=>line.trim()).filter(Boolean)
  };
}
function weeklyHours(value){
  if(!Array.isArray(value)||value.length!==7) throw Error('Vyplňte provozní dobu od pondělí do neděle.');
  return value.map(text=>customerText(text,100));
}
function promoDates(input){
  const dates={};
  for(const key of ['starts','ends']){
    const date=customerText(input[key],10);
    if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)) throw Error('Zadejte platné datum.');
    dates[key]=date;
  }
  if(dates.ends&&dates.starts&&dates.ends<dates.starts) throw Error('Konec platnosti musí být po začátku.');
  return dates;
}
function inPromoPeriod(rule,date){
  return (!rule.starts||rule.starts<=date)&&(!rule.ends||rule.ends>=date);
}
function promoInteger(value,max,label){
  const n=Number(value);
  if(!Number.isInteger(n)||n<1||n>max) throw Error('Zkontrolujte hodnotu pole '+label+'.');
  return n;
}
function promoCampaign(input){
  const id=value=>{
    if(typeof value!=='string'||!/^[a-f0-9-]{36}$/.test(value)) throw Error('Neplatný identifikátor akce.');
    return value;
  };
  if(!Array.isArray(input.levels)||!input.levels.length) throw Error('Přidejte alespoň jednu úroveň.');
  if(!['points','rides'].includes(input.unit)) throw Error('Vyberte typ hranice.');
  const levels=input.levels.map(level=>{
    if(!['free','percent','amount'].includes(level.kind)) throw Error('Vyberte druh odměny.');
    return {id:id(level.id),kind:level.kind,threshold:promoInteger(level.threshold,100000,'hranice'),
      discount:level.kind==='free'?100:promoInteger(level.discount,level.kind==='percent'?100:10000,'sleva'),
      uses:promoInteger(level.uses,1000,'počet zvýhodněných jízd')};
  }).sort((a,b)=>a.threshold-b.threshold);
  if(new Set(levels.map(l=>l.id)).size!==levels.length||new Set(levels.map(l=>l.threshold)).size!==levels.length) throw Error('Každá úroveň potřebuje vlastní hranici.');
  const dates=promoDates(input);
  if(!dates.starts) throw Error('Zadejte začátek promoakce.');
  return {id:id(input.id),name:customerText(input.name,60,true),...dates,unit:input.unit,levels};
}
function customerLoyaltySettings(input){
  const pointsPerRide=Number(input.pointsPerRide);
  const enabled=input.enabled===true;
  if(!Array.isArray(input.rewards)||input.rewards.length>10||
     !Number.isInteger(pointsPerRide)||pointsPerRide<1||pointsPerRide>1000) throw Error('Nastavte body za jízdu a nejméně jednu odměnu.');
  const rewards=input.rewards.map(({name,unit,threshold,discount})=>{
    name=customerText(name,60,true);
    threshold=Number(threshold);
    discount=Number(discount);
    if(!['points','rides'].includes(unit)||!Number.isInteger(threshold)||threshold<1||threshold>10000||
       !Number.isInteger(discount)||discount<1||discount>10000) throw Error('Zadejte platnou hranici a slevu pro každou odměnu.');
    return {key:[unit,threshold,discount].join(':'),name,unit,threshold,discount};
  });
  if(new Set(rewards.map(reward=>reward.key)).size!==rewards.length) throw Error('Každá odměna musí mít jinou hranici nebo slevu.');
  return {enabled,pointsPerRide,rewards,...promoDates(input)};
}
function customerLoyalty(state,customerId){
  const policy=state.customerSettings?.loyalty;
  const today=day();
  if(!policy?.enabled||!inPromoPeriod(policy,today)) return null;
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
  for(const campaign of state.customerSettings.campaigns||[]){
    if(!inPromoPeriod(campaign,today)) continue;
    const earned=jobs.filter(job=>job.status==='done'&&job.promoEarned?.includes(campaign.id));
    const progress=campaign.unit==='rides'?earned.length:earned.reduce((sum,job)=>sum+(job.loyaltyPoints||0),0);
    for(const [index,level] of campaign.levels.entries()){
      const key=campaign.id+':'+level.id;
      const remaining=level.uses-jobs.filter(job=>job.status!=='cancelled'&&job.promoRewardKey===key).length;
      rewards.push({...level,key,unit:campaign.unit,name:campaign.name+' · úroveň '+(index+1),
        progress,remaining:Math.max(remaining,0),available:progress>=level.threshold&&remaining>0});
    }
  }
  return {points,rides,pointsPerRide:policy.pointsPerRide,rewards,credits};
}
function customerReward(loyalty,key,cents){
  const reward=loyalty?.rewards.find(reward=>reward.key===key&&reward.available);
  if(!reward||(!reward.kind&&cents===null)) return null;
  const discountCents=cents===null?null:promotionDiscount(cents,reward);
  if(discountCents!==null&&discountCents<=0) return null;
  if(reward.kind) return {discountCents,credits:[],name:reward.name,promoRewardKey:key,promoRule:{kind:reward.kind,discount:reward.discount}};
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
  if(input.stops!==undefined&&!Array.isArray(input.stops)) throw Error('Neplatné mezizastávky.');
  const stops=(input.stops??[]).map(address=>customerText(address,200,true));
  return {pickup,dropoff,stops,scheduled,payment,requestId,pickupPoint:point(pickupPoint),target:point(target)};
}
async function customerCityRoute(ride){
  // Resolve pricing addresses on the server so request coordinates cannot change the fare.
  const lookup=async (address,point)=>{
    const street=foldStreet(address).split(',')[0];
    const exact=(liberecAddresses(address)||[]).find(match=>foldStreet(match.address).split(',')[0]===street);
    if(exact&&(!point||(point.lat===exact.point.lat&&point.lng===exact.point.lng))) return exact.point;
    if(point){
      const city=await ruianQuery(12,{
        where:'kod='+liberecCode,geometry:point.lng+','+point.lat,geometryType:'esriGeometryPoint',
        inSR:'4326',spatialRel:'esriSpatialRelIntersects',outFields:'kod',returnGeometry:'false'
      });
      return city.some(feature=>feature.attributes?.kod===liberecCode)?point:null;
    }
    return null;
  };
  try{
    const [pickup,target]=await Promise.all([lookup(ride.pickup,ride.pickupPoint),lookup(ride.dropoff,ride.target)]);
    if(!pickup||!target) return null;
    const stops=await Promise.all(ride.stops.map(address=>lookup(address)));
    if(stops.every(Boolean)) return {pickup,target,stops};
  }catch{/* When an address cannot be verified, the dispatcher sets the fare. */}
  return null;
}
const customerFareMode=state=>state.customerSettings?.fareMode??'automatic';
function customerFare(state,ride,route,now=Date.now()){
  if(!route) return null;
  const mode=customerFareMode(state);
  const fixedFare=state.customerSettings?.fixedFare;
  if(mode==='fixed'&&Number.isInteger(fixedFare)) return fixedFare*100*(1+ride.stops.length);
  if(mode!=='automatic') return null;

  const points=[route.pickup,...(route.stops||[]),route.target];
  const distance=points.slice(1).reduce((total,point,index)=>total+meters(points[index],point),0);
  const base=distance<=2000?90:distance<=5000?120:150;
  if(ride.scheduled&&!ride.stops.length) return base*100;

  const until=pragueTime.format(now+30*60*1000).replace(' ','T');
  const waiting=state.jobs.filter(job=>job.status==='waiting'&&(!job.scheduled||job.scheduled<=until)).length;
  const available=fleet(state).filter(({id})=>activePosition(state,id,now)&&
    allows(permissionsFor(state,id),'driverRide')&&!state.occupied?.[id]&&!busy(state,id)).length;
  const adjustment=waiting===0&&available>0?-30:Math.min(150,Math.max(0,waiting-available)*30);
  const regularFare=ride.scheduled?base:base+adjustment;
  const excessJobs=Math.max(0,waiting-available);
  const stopPercent=60+Math.min(5,excessJobs)*8;
  return regularFare*(100+ride.stops.length*stopPercent);
}
const customerRide=({id,pickup,dropoff,stops=[],scheduled,payment,created,done,status,confirmedAt,rejectedAt,cents,priceSet,rewardDiscountCents,rewardName})=>({
  id,pickup,dropoff,stops,scheduled,payment,created,done,
  status:rejectedAt?'rejected':status==='waiting'&&confirmedAt?'confirmed':status,cents:status==='done'||priceSet?cents:null,
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
    const {loyalty:policy,campaigns,...settings}=state.customerSettings||{};
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

    const limited=await customerThrottle(db,'fare',account.id,60);
    if(limited) return limited;
    const cents=customerFareMode(state)==='manual'?null:customerFare(state,ride,await customerCityRoute(ride));
    const loyalty=customerLoyalty(state,account.id);
    const reward=customerReward(loyalty,input.rewardKey,cents);
    const rewards=loyalty?.rewards.filter(item=>item.available&&(cents>0||(cents===null&&item.kind)))??[];
    return json({cents:cents===null?(reward?.promoRule?.kind==='free'?0:null):cents-(reward?.discountCents??0),rewards,discountCents:reward?.discountCents??0});
  }
  if(post&&action==='rides'){
    const input=await decode(request);
    const previous=state.jobs.find(job=>job.customerId===account.id&&job.requestId===input.requestId);
    if(previous) return json(customerRide(previous),201);
    const ride=customerRideInput(input);
    const route=customerFareMode(state)==='manual'?null:await customerCityRoute(ride);

    let priceChanged;
    const {state:updated}=await updateState(db,s=>{
      priceChanged=false;
      const current=check(s);
      if(s.jobs.some(job=>job.customerId===current.id&&job.requestId===input.requestId)) return false;
      const pending=s.jobs.filter(job=>job.customerId===current.id&&['waiting','assigned','accepted','onboard'].includes(job.status));
      if(pending.length>=5) throw Error('Máte příliš mnoho otevřených objednávek.');
      const now=Date.now();
      const fare=customerFare(s,ride,route,now);
      const reward=input.rewardKey?customerReward(customerLoyalty(s,current.id),input.rewardKey,fare):null;
      if(input.rewardKey&&!reward) throw Error('Tuto odměnu teď nelze použít. Zvolte jinou nebo objednejte bez odměny.');
      const total=fare===null?(reward?.promoRule?.kind==='free'?0:null):fare-(reward?.discountCents??0);
      if(total!==(input.expectedCents??null)){
        priceChanged=true;
        return false;
      }
      s.jobs.unshift({
        ...ride,pickupPoint:route?.pickup??ride.pickupPoint,target:route?.target??ride.target,
        id:++s.seq,customerId:current.id,name:current.firstName+' '+current.lastName,
        phone:current.phone,note:'Zákaznická objednávka',
        created:now,status:'waiting',cents:total??0,priceSet:total!==null,
        ...(reward?.promoRewardKey?{promoRewardKey:reward.promoRewardKey,promoRule:reward.promoRule,baseCents:fare}:{}),
        ...(reward?{rewardCredits:reward.credits,rewardDiscountCents:reward.discountCents,rewardName:reward.name}:{})
      });
      record(s,'customer','create',s.seq);
    });
    if(priceChanged) return json({error:'Cena se změnila. Před odesláním zkontrolujte novou částku.',code:'fare_changed'},409);
    return json(customerRide(updated.jobs.find(job=>job.customerId===account.id&&job.requestId===input.requestId)),201);
  }
  return json({error:'Stránka neexistuje.'},404);
}
