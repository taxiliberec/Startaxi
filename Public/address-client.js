import {addressBucket,createAddressIndex} from '/address-search.js';
const buckets=new Map();
async function loadBucket(key){
  const response=await fetch('/addresses/'+key+'.json');
  if(response.status===404) return ()=>null;
  if(!response.ok) throw Error('Index adres není dostupný.');
  const {rows,centres}=await response.json();
  return createAddressIndex(rows,centres);
}
export async function localAddresses(address){
  const key=addressBucket(address);
  if(!buckets.has(key)) buckets.set(key,loadBucket(key).catch(error=>{buckets.delete(key);throw error;}));
  return (await buckets.get(key))(address);
}
