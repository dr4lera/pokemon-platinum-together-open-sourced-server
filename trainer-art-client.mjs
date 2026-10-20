import {readFileSync,statSync,writeFileSync,renameSync} from 'node:fs';
import {sign} from 'node:crypto';
import {b64,sha,privateKey,proofBytes,fail} from './identity.mjs';
import {MAX_TRAINER_ART_PACK_BYTES,validateNativeTrainerPack,normalizeTrainerArt} from './trainer-art.mjs';

// Uses only the private account's locally stored key. No launcher or official
// gallery credentials are requested, transmitted, or logged.
export async function trainerArtClient({profile,action,file,metadata,art,select=true,out}){
  const p=JSON.parse(readFileSync(profile,'utf8')),url=new URL(p.hub);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('bad_trainer_art_server');
  if(!['list','import','clear','select'].includes(action))fail('bad_trainer_art_action');
  const data={action};let pack;
  if(action==='import'){
    if(!file||statSync(file).size>MAX_TRAINER_ART_PACK_BYTES)fail('bad_trainer_art_pack');
    const bytes=validateNativeTrainerPack(readFileSync(file));pack=bytes.toString('base64');Object.assign(data,{metadata,select,bytes:bytes.length,hash:sha(bytes).toString('hex')});
  }
  if(action==='select')data.art=normalizeTrainerArt(art);
  const get=async path=>{const r=await fetch(new URL(path,url),{signal:AbortSignal.timeout(10000)}),v=await r.json();if(!r.ok)fail(v.error??'trainer_art_failed');return v;};
  const info=await get('/private/server-info');if(info.hub_key!==p.hub_key)fail('server_identity_changed');
  const challenge=await get('/private/trainer-art/challenge'),raw=Buffer.from(JSON.stringify(data));
  if(raw.length>8192)fail('bad_trainer_art_request');
  const request={player:p.player_id,nonce:challenge.nonce,data:raw.toString('base64'),...(pack?{pack}:{}),sig:sign(null,proofBytes('PT-PRIVATE-TRAINER-ART',b64(challenge.nonce,32,32),sha(raw)),privateKey(b64(p.seed,32,32))).toString('base64')};
  const response=await fetch(new URL('/private/trainer-art',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(10000)}),result=await response.json();
  if(!response.ok)fail(result.error??'trainer_art_failed');
  if(out){writeFileSync(out+'.tmp',JSON.stringify(result),{mode:0o600});renameSync(out+'.tmp',out);}return result;
}
