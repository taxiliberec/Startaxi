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
  return {
    phone:customerText(input.phone,32),
    email:customerText(input.email,254),
    hours:customerText(input.hours,200),
    offers:customerText(input.offers,2000).split('\n').map(line=>line.trim()).filter(Boolean)
  };
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
const customerRide=({id,pickup,dropoff,scheduled,payment,created,done,status,confirmedAt,cents})=>({
  id,pickup,dropoff,scheduled,payment,created,done,
  status:status==='waiting'&&confirmedAt?'confirmed':status,cents:status==='done'?cents:null
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
  if(method==='GET'&&action==='info') return json(state.customerSettings||{});
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
  if(post&&action==='rides'){
    const input=await decode(request);
    const {state:updated}=await updateState(db,s=>{
      const current=check(s);
      if(s.jobs.some(job=>job.customerId===current.id&&job.requestId===input.requestId)) return false;
      const ride=customerRideInput(input);
      const pending=s.jobs.filter(job=>job.customerId===current.id&&['waiting','assigned','accepted','onboard'].includes(job.status));
      if(pending.length>=5) throw Error('Máte příliš mnoho otevřených objednávek.');
      const now=Date.now();
      s.jobs.unshift({
        ...ride,id:++s.seq,customerId:current.id,name:current.firstName+' '+current.lastName,
        phone:current.phone,note:'Zákaznická objednávka',
        created:now,status:'waiting',cents:0,priceSet:false
      });
      record(s,'customer','create',s.seq);
    });
    return json(customerRide(updated.jobs.find(job=>job.customerId===account.id&&job.requestId===input.requestId)),201);
  }
  return json({error:'Stránka neexistuje.'},404);
}
