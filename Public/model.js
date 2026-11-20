export const drivers = [
  {id:'01',name:'Petr Novák',lat:50.7751,lng:15.0430},
  {id:'02',name:'Martin Dvořák',lat:50.7656,lng:15.0462},
  {id:'03',name:'Tomáš Černý',lat:50.7716,lng:15.0635},
  {id:'04',name:'Jan Procházka',lat:50.7575,lng:15.0537},
  {id:'05',name:'Lukáš Veselý',lat:50.7647,lng:15.0271},
  {id:'06',name:'Ondřej Svoboda',lat:50.7789,lng:15.0249}
];
export const managesFleet = actor => actor === 'dispatch' || actor === 'owner';
export const fleet = state => [...drivers, ...Object.values(state.employees||{}).map(({id,firstName,lastName})=>({id,name:firstName+' '+lastName}))];
const dayFormat = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Prague'});
export const day = (t=Date.now()) => dayFormat.format(t);
export const initial = () => ({jobs:[],positions:{},shifts:[],seq:1000});
export const busy = (s,id) => s.jobs.find(j=>j.driver===id && ['assigned','accepted','onboard'].includes(j.status));
export function demoState(){
  const s=initial();
  const rows=[
    ['Jana Novotná','Fügnerova, Liberec','Forum Liberec',240,'waiting'],
    ['Martin Svoboda','Náměstí Dr. E. Beneše','ZOO Liberec',320,'waiting'],
    ['Eva Procházková','Nádraží Liberec','OC Nisa',280,'waiting'],
    ['David Král','Šaldovo náměstí','Lidové sady',300,'accepted','02'],
    ['Lucie Hájková','Babylon Liberec','Vesec, Liberec',360,'onboard','03'],
    ['Anna Bílá','Liberec centrum','Rochlice, Liberec',350,'done','01'],
    ['Adam Svoboda','Liberec centrum','Nádraží Liberec',280,'done','01'],
    ['Jiří Král','OC Nisa','Liberec centrum',420,'done','04'],
    ['Tereza Černá','Fügnerova','Harcov, Liberec',390,'done','05']
  ];
  s.jobs=rows.map(([name,pickup,dropoff,price,status,driver])=>({id:++s.seq,name,pickup,dropoff,cents:price*100,status,driver,note:'',scheduled:'',created:Date.now(),done:status==='done'?Date.now():undefined, target:status==='onboard'?{lat:50.772,lng:15.066}:undefined}));
  for(const {id,lat,lng} of drivers) s.positions[id]={lat,lng,accuracy:12,demo:true};
  return s;
}
function requireThat(ok,message){ if(!ok) throw Error(message); }
export function change(s,actor,a,now=Date.now()){
  const job=s.jobs.find(j=>j.id===a.id);
  const own=job && job.driver===actor;
  switch(a.type){
    case 'create': {
      requireThat(managesFleet(actor),'Přístup zamítnut.');
      const {name,pickup,dropoff,note='',scheduled='',cents,target}=a;
      for(const [v,max] of [[name,120],[pickup,200],[dropoff,200]]) requireThat(typeof v==='string'&&v.trim()&&v.length<=max,'Vyplňte povinné údaje.');
      requireThat(typeof note==='string'&&note.length<=1000&&typeof scheduled==='string'&&(!scheduled||/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(scheduled))&&Number.isInteger(cents)&&cents>=0&&cents<=10000000,'Zkontrolujte čas, poznámku a cenu.');
      requireThat(!target || validPoint(target),'Neplatný cíl.');
      s.jobs.unshift({id:++s.seq,name:name.trim(),pickup:pickup.trim(),dropoff:dropoff.trim(),note,scheduled,cents,target,created:now,status:'waiting'});
      break;
    }
    case 'assign':
      requireThat(managesFleet(actor)&&job?.status==='waiting'&&fleet(s).some(d=>d.id===a.driver)&&!busy(s,a.driver),'Řidič nebo zakázka už nejsou k dispozici.');
      Object.assign(job,{driver:a.driver,status:'assigned'});
      break;
    case 'accept':
      requireThat(own&&job.status==='assigned','Zakázku nelze přijmout.');
      job.status='accepted';
      break;
    case 'pickup':
      requireThat(own&&job.status==='accepted','Zakázku nelze označit jako vyzvednutou.');
      job.status='onboard';
      break;
    case 'complete':
      requireThat(own&&job.status==='onboard','Zakázku nelze dokončit.');
      Object.assign(job,{status:'done',done:now});
      break;
    case 'gps':
      requireThat(fleet(s).some(d=>d.id===actor)&&validPoint(a)&&Number.isFinite(a.accuracy)&&a.accuracy>=0,'Neplatná GPS poloha.');
      const measured=Number.isFinite(a.measured)?a.measured:now;
      requireThat(measured>=now-30000&&measured<=now+10000,'GPS měření je zastaralé.');
      if(measured>=(s.positions[actor]?.measured??0)){
        s.positions[actor]={lat:a.lat,lng:a.lng,accuracy:a.accuracy,time:Math.min(measured,now),measured};
      }
      break;
    case 'close': {
      const date=a.date;
      requireThat(fleet(s).some(d=>d.id===actor)&&!busy(s,actor),'Nejdříve dokončete probíhající jízdu.');
      const jobs=s.jobs.filter(j=>j.driver===actor&&j.status==='done'&&day(j.done)===date&&!j.shift);
      requireThat(jobs.length&&jobs.reduce((sum,j)=>sum+j.cents,0)===a.cents,'Částka musí odpovídat součtu dokončených jízd.');
      const id=String(now)+'-'+actor;
      jobs.forEach(j=>j.shift=id);
      s.shifts.unshift({id,driver:actor,date,cents:a.cents,count:jobs.length,closed:now});
      break;
    }
    default: throw Error('Neznámá akce.');
  }
  return s;
}
export const validPoint = p => Number.isFinite(p.lat)&&Math.abs(p.lat)<=90&&Number.isFinite(p.lng)&&Math.abs(p.lng)<=180;
export function meters(a,b){
  const rad=Math.PI/180;
  const lat=(a.lat+b.lat)*rad/2;
  return 6371000*Math.hypot((a.lat-b.lat)*rad,(a.lng-b.lng)*rad*Math.cos(lat));
}
