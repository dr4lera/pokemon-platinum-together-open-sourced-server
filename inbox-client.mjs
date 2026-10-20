import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {sign} from 'node:crypto';
import {b64,sha,privateKey,proofBytes,fail} from './identity.mjs';
export async function inboxClient({profile,action,id,client,out}){
  const p=JSON.parse(readFileSync(profile,'utf8')),url=new URL(p.hub);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)fail('bad_inbox_server');
  const info=await fetch(new URL('/private/server-info',url),{signal:AbortSignal.timeout(10000)}).then(r=>r.json());if(info.hub_key!==p.hub_key)fail('server_identity_changed');
  const challenge=await fetch(new URL('/private/inbox/challenge',url),{signal:AbortSignal.timeout(10000)}).then(r=>r.json());
  const data=Buffer.from(JSON.stringify({action,...(id?{id,client}:{})}));const request={player:p.player_id,nonce:challenge.nonce,data:data.toString('base64'),sig:sign(null,proofBytes('PT-PRIVATE-INBOX',b64(challenge.nonce,32,32),sha(data)),privateKey(b64(p.seed,32,32))).toString('base64')};
  const response=await fetch(new URL('/private/inbox',url),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(10000)}),result=await response.json();if(!response.ok)fail(result.error??'inbox_failed');if(out){writeFileSync(out+'.tmp',JSON.stringify(result),{mode:0o600});renameSync(out+'.tmp',out);}return result;
}
