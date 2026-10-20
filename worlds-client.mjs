import {readFileSync,writeFileSync} from 'node:fs';
import {sign} from 'node:crypto';
import {WebSocket} from './vendor/ws/wrapper.mjs';
import {accountClient} from './account-client.mjs';
import {b64,sha,proofBytes,privateKey,fail} from './identity.mjs';

export async function worldsClient({profile,out,action='worlds',code}){
 if(!['worlds','discord-invite','party-join'].includes(action))fail('bad_lobby_action');
 if(action==='party-join'&&!/^[A-HJKMNP-Z2-9]{6}$/.test(code))fail('bad_party_code');
 await accountClient('login',{profile});
 const p=JSON.parse(readFileSync(profile,'utf8'));
 const result=await new Promise((resolve,reject)=>{
  const ws=new WebSocket(p.hub.replace(/^http/,'ws')+'/lobby',{maxPayload:1048576,handshakeTimeout:8000});let done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);ws.terminate();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(new Error('world_list_timeout')),10000);
  ws.on('error',()=>finish(new Error('world_list_unavailable')));
  ws.on('close',()=>{if(!done)finish(new Error('world_list_unavailable'));});
  ws.on('open',()=>ws.send(JSON.stringify({t:'lobby.hello',pt:2,token:p.token,build:'private-launcher-world-list'})));
  let phase='challenge';
  ws.on('message',(data,binary)=>{
   try{
    if(binary)fail('bad_world_list');const m=JSON.parse(data);
    if(m.t==='err')fail(m.code??'world_list_failed');
    if(m.t==='challenge'&&phase==='challenge'){
     const token=JSON.parse(Buffer.from(p.token,'base64').toString());
     const sig=sign(null,proofBytes('PT2-LOBBY',b64(m.nonce,32,32),sha(b64(token.bytes,58,58))),privateKey(b64(p.seed,32,32))).toString('base64');
     phase='ready';ws.send(JSON.stringify({t:'auth',sig}));
    }else if(m.t==='lobby.ready'&&phase==='ready'){
     phase='worlds';ws.send(JSON.stringify(action==='worlds'?{t:'private.worlds.list'}:action==='discord-invite'?{t:'private.discord.invite'}:{t:'party.join',code}));
    }
    else if(action==='discord-invite'&&m.t==='private.discord.invite'&&phase==='worlds')finish(null,{invite:m.invite});
    else if(action==='party-join'&&m.t==='party'&&m.party?.code===code&&phase==='worlds')finish(null,{party:m.party.id});
    else if(m.t==='private.worlds'&&phase==='worlds'){
     if(!Array.isArray(m.worlds)||m.worlds.length>100)fail('bad_world_list');
     finish(null,{server:p.hub,worlds:m.worlds});
    }
   }catch(error){finish(error);}
  });
 });
 if(out)writeFileSync(out,JSON.stringify(result),{flag:'wx',mode:0o600});return result;
}
