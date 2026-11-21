import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import worker from './dist/server/index.js';

function sqliteStore(){
  const sqlite=new DatabaseSync(process.env.TAXI_DB_PATH||'taxi.sqlite');
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  if(!sqlite.prepare("SELECT name FROM sqlite_master WHERE name='dispatch'").get()){
    sqlite.exec(readFileSync(new URL('./migrations/0000_dispatch.sql',import.meta.url),'utf8'));
  }
  return {
    prepare(sql){
      const statement=sqlite.prepare(sql);
      return {first:()=>statement.get(),run:()=>({meta:statement.run()}),bind:(...values)=>({run:()=>({meta:statement.run(...values)})})};
    }
  };
}

function postgresStore(connectionString){
  const pool=new pg.Pool({connectionString,connectionTimeoutMillis:5000,max:5});
  pool.on('error',()=>console.error('Připojení k databázi bylo přerušeno.'));
  async function query(text,values){
    try{
      return await pool.query(text,values);
    }catch(error){
      console.error('Chyba databáze',error.code);
      throw Error('Provozní databáze je nedostupná.');
    }
  }
  return {
    async readState(){
      const {rows}=await query('SELECT revision, data FROM public.dispatch WHERE id=1');
      if(!Array.isArray(rows[0]?.data?.jobs)||!Array.isArray(rows[0].data.shifts)||!rows[0].data.positions) throw Error('Provozní data nejsou dostupná.');
      return {revision:rows[0].revision,state:rows[0].data};
    },
    async saveState(state,revision){
      const result=await query('UPDATE public.dispatch SET revision=revision+1,data=$1 WHERE id=1 AND revision=$2',[state,revision]);
      return result.rowCount===1;
    }
  };
}

if(process.env.RENDER==='true'&&(!process.env.DATABASE_URL||(process.env.TAXI_OWNER_KEY||'').length<24)){
  throw Error('Pro nasazení je potřeba nastavit DATABASE_URL a klíč majitele o délce alespoň 24 znaků.');
}
const DB=process.env.DATABASE_URL?postgresStore(process.env.DATABASE_URL):sqliteStore();
const port=Number(process.env.PORT||3000);
createServer(async (req,res)=>{
  try{
    if(req.method==='GET'&&req.url==='/healthz'){
      if(DB.readState) await DB.readState();
      res.writeHead(200,{'Cache-Control':'no-store'}).end('OK');
      return;
    }
    const bodyLimit=req.method==='POST'&&req.url==='/api/vehicles'?120000:16000;
    const chunks=[];
    let length=0;
    for await(const chunk of req){
      length+=chunk.length;
      if(length>bodyLimit){res.writeHead(413).end();return;}
      chunks.push(chunk);
    }
    const scheme=process.env.TAXI_PROXY_HTTPS==='1'?'https':'http';
    const url=new URL(req.url,scheme+'://'+req.headers.host);
    const response=await worker.fetch(new Request(url,{method:req.method,headers:req.headers,body:length?Buffer.concat(chunks):undefined}),{DB,TAXI_ACCESS_KEYS:process.env.TAXI_ACCESS_KEYS,TAXI_OWNER_KEY:process.env.TAXI_OWNER_KEY});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch{
    res.writeHead(500).end('Chyba serveru');
  }
}).listen(port,process.env.TAXI_BIND||(process.env.RENDER==='true'?'0.0.0.0':'127.0.0.1'),()=>console.log('Taxi Liberec naslouchá na portu '+port));
