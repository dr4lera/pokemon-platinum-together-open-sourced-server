import {createServer} from 'node:http';
import {readFileSync,writeFileSync,renameSync,existsSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';

async function boundedResponse(response,max){
 if(!response.ok)throw new Error('gallery_unavailable');
 const chunks=[];let size=0;
 for await(const chunk of response.body){size+=chunk.length;if(size>max)throw new Error('gallery_too_large');chunks.push(chunk);}
 return Buffer.concat(chunks);
}

// The native gallery override intentionally accepts a loopback service only.
// This adapter forwards two content-only routes to the selected pinned server;
// private credentials and arbitrary destinations never enter the native URLs.
export async function startGalleryProxy({origin,pin,player}){
 const remote=new URL(origin);
 if(!['http:','https:'].includes(remote.protocol)||remote.username||remote.password||remote.pathname!=='/'||remote.search||remote.hash||typeof pin!=='string'||Buffer.from(pin,'base64').length!==32||!/^[1-9][0-9]{0,19}$/.test(player))throw new Error('bad_gallery_profile');
 const identity=async()=>{
  const response=await fetch(remote.origin+'/private/server-info',{redirect:'error',signal:AbortSignal.timeout(8000)});
  const info=JSON.parse((await boundedResponse(response,16384)).toString('utf8'));
  if(info.hub_key!==pin)throw new Error('server_identity_changed');
 };
 await identity();
 const server=createServer(async(req,res)=>{
  const send=(code,body,type='application/json')=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(body);};
  const path=req.url;
  const collection='/api/creators/v1/game/players/'+player+'/trainers';
  const pack=typeof path==='string'?/^\/api\/creators\/v1\/packs\/([a-f0-9]{64})\.pttrainer$/.exec(path):null;
  if(req.method!=='GET'||path!==collection&&!pack){send(404,'{"error":"not_found"}');return;}
  try{
   await identity();
   const response=await fetch(remote.origin+path,{redirect:'error',signal:AbortSignal.timeout(10000)});
   const bytes=await boundedResponse(response,pack?2097152:16384);
   if(pack){if(createHash('sha256').update(bytes).digest('hex')!==pack[1])throw new Error('gallery_hash_mismatch');}
   else {const data=JSON.parse(bytes.toString('utf8'));if(data.t!=='collection'||!Array.isArray(data.items)||data.items.length>40)throw new Error('bad_gallery_collection');}
   send(200,bytes,pack?'application/octet-stream':'application/json');
  }catch{send(502,'{"error":"gallery_unavailable"}');}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}

export async function galleryProxyCommand({profile,out}){
 const p=JSON.parse(readFileSync(profile,'utf8'));
 const proxy=await startGalleryProxy({origin:p.hub,pin:p.hub_key,player:String(p.player_id)});
 const stage=out+'.tmp';
 try{if(existsSync(out))throw new Error('gallery_ready_exists');writeFileSync(stage,JSON.stringify({pid:process.pid,url:proxy.url}),{flag:'wx',mode:0o600});renameSync(stage,out);}
 catch(error){await proxy.close();throw error;}
 finally{if(existsSync(stage))unlinkSync(stage);}
 let gamePid,input='',closing=false;
 const finish=()=>{if(closing)return;closing=true;proxy.close().then(()=>process.exit());};
 const noGame=setTimeout(()=>{if(!gamePid)finish();},30000);noGame.unref();
 process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
  if(gamePid)return;input+=chunk;if(input.length>128){finish();return;}if(!input.includes('\n'))return;
  try{const value=JSON.parse(input.trim());if(!Number.isInteger(value.game_pid)||value.game_pid<1)throw new Error();gamePid=value.game_pid;clearTimeout(noGame);}catch{finish();}
 });
 const watch=setInterval(()=>{if(!gamePid)return;try{process.kill(gamePid,0);}catch(error){if(error.code==='ESRCH')finish();}},2000);watch.unref();
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,finish);
 return proxy;
}
