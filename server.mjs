import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from './dist/server/index.js';

function sqliteStore(){
  const sqlite=new DatabaseSync(process.env.TAXI_DB_PATH||'taxi.sqlite');
  sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  if(!sqlite.prepare("SELECT name FROM sqlite_master WHERE name='dispatch'").get()){
    try{
      sqlite.exec(readFileSync(new URL('./migrations/0000_dispatch.sql',import.meta.url),'utf8'));
    }catch(error){
      if(error.code!=='ENOENT') throw error;
      sqlite.exec('CREATE TABLE IF NOT EXISTS dispatch (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL, data TEXT NOT NULL)');
      sqlite.prepare('INSERT OR IGNORE INTO dispatch (id, revision, data) VALUES (1, 0, ?)').run(JSON.stringify({jobs:[],positions:{},shifts:[],seq:1000}));
    }
  }
  return {
    prepare(sql){
      const statement=sqlite.prepare(sql);
      return {first:()=>statement.get(),run:()=>({meta:statement.run()}),bind:(...values)=>({run:()=>({meta:statement.run(...values)})})};
    }
  };
}

async function postgresStore(connectionString){
  const {default:pg}=await import('pg');
  const config={connectionString,connectionTimeoutMillis:5000,max:5};
  const ca=process.env.TAXI_DATABASE_CA?.trim();
  if(ca){
    const url=new URL(connectionString);
    // node-postgres gives URL TLS parameters precedence over the ssl object.
    for(const key of ['ssl','sslmode','sslrootcert','sslcert','sslkey']){
      url.searchParams.delete(key);
    }
    config.connectionString=url.toString();
    config.ssl={ca,rejectUnauthorized:true};
  }
  const pool=new pg.Pool(config);
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

if(process.env.RENDER==='true'&&!process.env.DATABASE_URL){
  throw Error('Pro nasazení je potřeba nastavit DATABASE_URL.');
}
const DB=process.env.DATABASE_URL?await postgresStore(process.env.DATABASE_URL):sqliteStore();
const port=Number(process.env.PORT||3000);
createServer(async (req,res)=>{
  try{
    if(req.method==='GET'&&req.url==='/healthz'){
      if(DB.readState) await DB.readState();
      res.writeHead(200,{'Cache-Control':'no-store'}).end('OK');
      return;
    }
    if(process.env.TAXI_CUSTOMER_HOMEPAGE==='1'&&(req.method==='GET'||req.method==='HEAD')&&req.url?.split('?')[0]==='/'){
      const query=req.url.slice(1);
      res.writeHead(302,{'Location':'/customer/'+query,'Cache-Control':'no-store'}).end();
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
    const headers=new Headers(req.headers);
    const client=req.socket.remoteAddress||'local';
    // Render appends the address observed at its edge to X-Forwarded-For.
    headers.set('X-Startaxi-Client',process.env.RENDER==='true'?(headers.get('X-Forwarded-For')?.split(',').at(-1)?.trim()||client):client);
    headers.delete('CF-Connecting-IP');
    const response=await worker.fetch(new Request(url,{method:req.method,headers,body:length?Buffer.concat(chunks):undefined}),{DB,TAXI_ACCESS_KEYS:process.env.TAXI_ACCESS_KEYS,TAXI_OWNER_KEY:process.env.TAXI_OWNER_KEY,TAXI_OWNER_PASSWORD:process.env.TAXI_OWNER_PASSWORD,TAXI_PUSH_VAPID_JWK:process.env.TAXI_PUSH_VAPID_JWK,TAXI_PUSH_CONTACT:process.env.TAXI_PUSH_CONTACT});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch{
    res.writeHead(500).end('Chyba serveru');
  }
}).listen(port,process.env.TAXI_BIND||(process.env.RENDER==='true'?'0.0.0.0':'127.0.0.1'),()=>console.log('Taxi Liberec naslouchá na portu '+port));
